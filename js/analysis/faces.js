// Anime face and head detection (deepghs anime_face_detection / anime_head_detection, YOLOv8n,
// MIT), used to aim push-ins and the punch-in ladder at a character's face, including the
// heavily tinted or backlit shots the character-outline model can't see. Each model is ~12 MB,
// downloads once and is cached. Heads stand in where no face shows (a character turned away).

import { exclusive } from './segment.js';

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const MODELS = {
  face: { url: 'https://huggingface.co/deepghs/anime_face_detection/resolve/784dc4c0bb692351ddcdbe6131a050b17d3025d5/face_detect_v1.4_n/model.onnx', thr: 0.28 },
  head: { url: 'https://huggingface.co/deepghs/anime_head_detection/resolve/06604feee81983792a57c21081e539c0ae229833/head_detect_v2.0_n/model.onnx', thr: 0.37 },
};
const S = 640; // model input
export const FACE_RATE = 10;

const sessions = {};

async function modelBytes(url) {
  let res = null, cache = null;
  try { cache = await caches.open('sakuga-models'); res = await cache.match(url); } catch (e) { cache = null; }
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error('Could not download the face model');
    if (cache) { try { await cache.put(url, res.clone()); } catch (e) { /* storage full: still works this time */ } }
  }
  return new Uint8Array(await res.arrayBuffer());
}

export function loadDetector(kind) {
  if (!sessions[kind]) {
    sessions[kind] = (async () => {
      const ort = await import(ORT + 'ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = ORT;
      const bytes = await modelBytes(MODELS[kind].url);
      let sess;
      try { sess = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] }); }
      catch (e) { sess = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }); }
      return { ort, sess };
    })().catch((e) => { sessions[kind] = null; throw e; });
  }
  return sessions[kind];
}

// YOLOv8 output [1, 5, 8400] (cx, cy, w, h, score in 640-px units) → boxes [x0, y0, x1, y1, score]
// in 0..1 of the input, after a score threshold and non-maximum suppression.
function decode(out, thr) {
  const n = out.length / 5, cand = [];
  for (let i = 0; i < n; i++) {
    const sc = out[4 * n + i];
    if (sc < thr) continue;
    const cx = out[i], cy = out[n + i], w = out[2 * n + i], h = out[3 * n + i];
    cand.push([(cx - w / 2) / S, (cy - h / 2) / S, (cx + w / 2) / S, (cy + h / 2) / S, sc]);
  }
  cand.sort((a, b) => b[4] - a[4]);
  const keep = [];
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const I = ix * iy;
    return I / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - I + 1e-9);
  };
  for (const c of cand) if (keep.every((k) => iou(k, c) < 0.7)) keep.push(c.map((v, j) => (j < 4 ? Math.min(1, Math.max(0, v)) : v)));
  return keep.slice(0, 6);
}

// Faces (or, where none shows, heads) at the given source times, cached on the media as
// media.faces: 10ths of a second → { kind: 'face' | 'head', boxes } with boxes in source
// picture coordinates (0..1 of the frame).
export async function detectFaces(media, times) {
  media.faces = media.faces || new Map();
  const want = [...new Set(times.map((t) => Math.round(t * FACE_RATE)))].filter((k) => k >= 0 && k / FACE_RATE < media.duration && !media.faces.has(k)).sort((a, b) => a - b);
  if (!want.length) return media.faces;
  const F = await loadDetector('face');
  let H = null;
  try { H = await loadDetector('head'); } catch (e) { /* faces only */ }
  const box = (media.analysis && media.analysis.box) || { top: 0, bottom: 1 };
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = media.url;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Could not read the video for faces')); });
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  const sy = box.top * v.videoHeight, sh = (box.bottom - box.top) * v.videoHeight;
  const input = new Float32Array(3 * S * S);
  const run = async (D) => {
    const res = await exclusive(() => D.sess.run({ [D.sess.inputNames[0]]: new D.ort.Tensor('float32', input, [1, 3, S, S]) }));
    return res[D.sess.outputNames[0]].data;
  };
  for (const k of want) {
    v.currentTime = Math.min(media.duration - 0.02, k / FACE_RATE);
    await new Promise((res) => { v.onseeked = res; });
    // the picture band (inside any black bars) stretched to the model's square, like its training
    g.drawImage(v, 0, sy, v.videoWidth, sh, 0, 0, S, S);
    const d = g.getImageData(0, 0, S, S).data;
    for (let i = 0, p = 0; i < S * S; i++, p += 4) { input[i] = d[p] / 255; input[S * S + i] = d[p + 1] / 255; input[2 * S * S + i] = d[p + 2] / 255; }
    let kind = 'face', boxes = decode(await run(F), MODELS.face.thr);
    if (!boxes.length && H) { kind = 'head'; boxes = decode(await run(H), MODELS.head.thr); }
    const toSrc = (b) => [b[0], box.top + b[1] * (box.bottom - box.top), b[2], box.top + b[3] * (box.bottom - box.top), b[4]];
    media.faces.set(k, { kind, boxes: boxes.map(toSrc) });
  }
  v.removeAttribute('src'); v.load();
  return media.faces;
}

// The faces found nearest source time t (within a tenth of a second), or null.
export function facesAt(media, t) {
  const M = media && media.faces;
  return (M && M.get(Math.round(t * FACE_RATE))) || null;
}

// The biggest face at source time t, moving smoothly between the samples either side of it (they
// come ten a second); null if neither has a face.
const biggest = (r) => (r && r.kind === 'face' && r.boxes.length ? r.boxes.reduce((x, y) => ((y[2] - y[0]) * (y[3] - y[1]) > (x[2] - x[0]) * (x[3] - x[1]) ? y : x)) : null);
export function faceBoxAt(media, t) {
  const M = media && media.faces;
  if (!M) return null;
  const u = t * FACE_RATE, k = Math.floor(u), f = u - k;
  const a = biggest(M.get(k)), b = biggest(M.get(k + 1));
  if (a && b) {
    // the same face in both (they overlap): in between; two different faces: the nearer one
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy, uni = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    if (uni > 0 && inter / uni > 0.3) return a.slice(0, 4).map((v, i) => v + (b[i] - v) * f);
    return f < 0.5 ? a : b;
  }
  // a face on one side only (a sample missing, or the face just turned away): the one there is,
  // at most a tenth of a second off
  return a || b;
}
