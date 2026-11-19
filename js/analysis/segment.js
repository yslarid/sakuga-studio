// Character masks for "text behind the character": an anime segmentation model (skytnt/anime-seg,
// ISNet, Apache-2.0) runs on your Mac's GPU through onnxruntime-web. The model downloads once
// (~176 MB) and is cached. Coarse masks (10 a second) decide where a word can go; then every
// frame of those moments gets its own mask, and the renderer maps it through every zoom,
// shake and tilt.

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const MODEL = 'https://huggingface.co/skytnt/anime-seg/resolve/493cb60893f47441b26ec4fb9a306bce9e342982/isnetis.onnx';
const S = 1024; // model input (padded square)
const MW = 512; // stored mask width
export const MASK_RATE = 10;

let segPromise = null;
// one model run at a time, across every model (FX boost, the phasing text and the face
// detector can all be asking; the GPU backend fails with "Session mismatch" if runs interleave)
let chain = Promise.resolve();
export const exclusive = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

async function modelBytes(onStatus) {
  let res = null, cache = null;
  try { cache = await caches.open('sakuga-models'); res = await cache.match(MODEL); } catch (e) { cache = null; }
  if (!res) {
    onStatus && onStatus('Downloading the character model (first time ~176 MB, then cached)…');
    res = await fetch(MODEL);
    if (!res.ok) throw new Error('Could not download the character model');
    if (cache) { try { await cache.put(MODEL, res.clone()); } catch (e) { /* storage full: still works this time */ } }
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  // The model's pooling layers round their output size up ("ceil_mode"), which the GPU backend
  // doesn't support. With a 1024 px input every size divides evenly, so rounding down gives the
  // exact same result: flip the flag in the model bytes before loading it.
  const key = [...'ceil_mode'].map((c) => c.charCodeAt(0));
  for (let i = 0; i < buf.length - 16; i++) {
    let hit = true;
    for (let k = 0; k < 9 && hit; k++) hit = buf[i + k] === key[k];
    if (!hit) continue;
    for (let j = i + 9; j < i + 14; j++) if (buf[j] === 0x18 && buf[j + 1] === 0x01) { buf[j + 1] = 0x00; break; }
  }
  return buf;
}

export function loadSegmenter(onStatus) {
  if (!segPromise) {
    segPromise = (async () => {
      const ort = await import(ORT + 'ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = ORT;
      const bytes = await modelBytes(onStatus);
      onStatus && onStatus('Loading the character model…');
      let sess;
      try { sess = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] }); }
      catch (e) { sess = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }); }
      return { ort, sess };
    })().catch((e) => { segPromise = null; throw e; });
  }
  return segPromise;
}

// ---------- turning the model's soft output into a clean matte ----------
function boxMean(src, w, h, r) {
  const W1 = w + 1, ii = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += src[y * w + x]; ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1] + row; } }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (ii[y1 * W1 + x1] - ii[y0 * W1 + x1] - ii[y1 * W1 + x0] + ii[y0 * W1 + x0]) / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

// Guided filter (He et al.): smooths the matte while following the edges of the guide image,
// so the outline snaps to the anime's own line art instead of the model's blurry boundary.
function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h, Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { a[i] = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps); b[i] = mp[i] - a[i] * mI[i]; }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
  return q;
}

// Remove blobs smaller than minArea (specks) and fill holes smaller than it that don't touch the edge.
function cleanIslands(bin, w, h, minArea) {
  const n = w * h, label = new Int32Array(n), stack = new Int32Array(n);
  for (const val of [1, 0]) {
    label.fill(0);
    let id = 0;
    const sizes = [0], border = [false];
    for (let s = 0; s < n; s++) {
      if (label[s] || bin[s] !== val) continue;
      id++;
      let top = 0, cnt = 0, edge = false;
      stack[top++] = s; label[s] = id;
      while (top) {
        const i = stack[--top], x = i % w, y = (i / w) | 0;
        cnt++;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        if (x > 0 && !label[i - 1] && bin[i - 1] === val) { label[i - 1] = id; stack[top++] = i - 1; }
        if (x < w - 1 && !label[i + 1] && bin[i + 1] === val) { label[i + 1] = id; stack[top++] = i + 1; }
        if (y > 0 && !label[i - w] && bin[i - w] === val) { label[i - w] = id; stack[top++] = i - w; }
        if (y < h - 1 && !label[i + w] && bin[i + w] === val) { label[i + w] = id; stack[top++] = i + w; }
      }
      sizes.push(cnt); border.push(edge);
    }
    for (let i = 0; i < n; i++) { const l = label[i]; if (l && sizes[l] < minArea && (val === 1 || !border[l])) bin[i] = 1 - val; }
  }
}

function labelComps(bin, w, h) {
  const n = w * h, label = new Int32Array(n), stack = new Int32Array(n), sizes = [0];
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] || !bin[s]) continue;
    id++;
    let top = 0, cnt = 0;
    stack[top++] = s; label[s] = id;
    while (top) {
      const i = stack[--top], x = i % w;
      cnt++;
      if (x > 0 && !label[i - 1] && bin[i - 1]) { label[i - 1] = id; stack[top++] = i - 1; }
      if (x < w - 1 && !label[i + 1] && bin[i + 1]) { label[i + 1] = id; stack[top++] = i + 1; }
      if (i >= w && !label[i - w] && bin[i - w]) { label[i - w] = id; stack[top++] = i - w; }
      if (i < n - w && !label[i + w] && bin[i + w]) { label[i + w] = id; stack[top++] = i + w; }
    }
    sizes.push(cnt);
  }
  return { label, sizes };
}

// Keep only shapes that stay with the shot. Each outlined shape is followed from frame to frame
// (linked when it overlaps a shape in the previous frame); a real character is there all shot
// long, while something the model only sometimes calls a character (a rock edge, a glow) pops
// in and out — that is what makes a word blink between hidden and visible, so it is dropped.
function stabilize(bins, w, h) {
  const F = bins.length;
  if (F < 3) return;
  // the model sometimes misses a frame entirely: hold the neighbour's outline instead of flashing
  const cov = bins.map((b) => { let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return s; });
  for (let f = 0; f < F; f++) {
    const a = f > 0 ? cov[f - 1] : cov[f + 1], b = f < F - 1 ? cov[f + 1] : cov[f - 1];
    if (cov[f] < 0.3 * Math.min(a, b)) { bins[f] = new Uint8Array(bins[f > 0 ? f - 1 : f + 1]); cov[f] = f > 0 ? cov[f - 1] : cov[f + 1]; }
  }
  // a flash frame: for a frame or two the model calls most of the white-out picture "character"
  for (let f = 0; f < F; f++) {
    const a = f > 0 ? cov[f - 1] : cov[f + 1], b = f < F - 1 ? cov[f + 1] : cov[f - 1];
    if (cov[f] > 0.7 * (bins[f].length / 4) && cov[f] > 1.6 * Math.max(a, b)) { bins[f] = new Uint8Array(bins[f > 0 ? f - 1 : f + 1]); cov[f] = f > 0 ? cov[f - 1] : cov[f + 1]; }
  }
  const labs = bins.map((b) => labelComps(b, w, h));
  const parent = new Map(), key = (f, c) => f * 100000 + c;
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  labs.forEach((L, f) => { for (let c = 1; c < L.sizes.length; c++) parent.set(key(f, c), key(f, c)); });
  // link each shape to overlapping shapes one and two frames back (bridging a short gap)
  for (let f = 1; f < F; f++) for (const back of [1, 2]) {
    if (f - back < 0) continue;
    const A = labs[f - back], B = labs[f], ov = new Map();
    for (let i = 0; i < A.label.length; i++) { const a = A.label[i], b = B.label[i]; if (a && b) { const k = a * 100000 + b; ov.set(k, (ov.get(k) || 0) + 1); } }
    for (const [k, cnt] of ov) {
      const a = Math.floor(k / 100000), b = k % 100000;
      if (cnt >= 0.3 * Math.min(A.sizes[a], B.sizes[b])) { const ra = find(key(f - back, a)), rb = find(key(f, b)); if (ra !== rb) parent.set(ra, rb); }
    }
  }
  const span = new Map(); // track → frames it appears in
  labs.forEach((L, f) => { for (let c = 1; c < L.sizes.length; c++) { const r = find(key(f, c)); if (!span.has(r)) span.set(r, new Set()); span.get(r).add(f); } });
  labs.forEach((L, f) => {
    const drop = new Uint8Array(L.sizes.length);
    // a real character stays for a long stretch (most of the shot, or at least half a second —
    // they can walk out of frame); a shape the model only sometimes calls a character flickers
    for (let c = 1; c < L.sizes.length; c++) { const n = span.get(find(key(f, c))).size; drop[c] = n < 0.6 * F && n < 15 ? 1 : 0; }
    const b = bins[f];
    for (let i = 0; i < b.length; i++) if (b[i] && drop[L.label[i]]) b[i] = 0;
  });
}

// The model's soft output → a clean matte: every pixel decided (unsure ones keep the previous
// frame's answer, so nothing flickers between see-through and solid), specks and pinholes
// removed, edges snapped to the line art. Returns the matte and the yes/no map for the next frame.
function decideMask(raw, w, h, prevBin) {
  const n = w * h, bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const v = raw[i]; bin[i] = v > 160 ? 1 : v < 95 ? 0 : prevBin ? prevBin[i] : v >= 128 ? 1 : 0; }
  cleanIslands(bin, w, h, Math.round(n * 0.004));
  return bin;
}
function snapEdges(bin, guide, w, h) {
  const q = guidedFilter(guide, bin, w, h, 3, 2e-3), out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(q[i] * 255);
  return out;
}
function refineMask(raw, guide, w, h, prevBin) {
  const bin = decideMask(raw, w, h, prevBin);
  return { mask: snapEdges(bin, guide, w, h), bin };
}

// A reusable reader: seeks a hidden <video>, draws the picture band into the model's padded
// square, runs the model and returns the mask band (Uint8Array) plus a tiny brightness
// signature of the frame (for spotting cuts).
async function frameReader(media) {
  const box = (media.analysis && media.analysis.box) || { top: 0, bottom: 1 };
  if (!media.masks) {
    const ph = (box.bottom - box.top) * media.h;
    media.masks = { w: MW, h: Math.max(8, Math.round((MW * ph) / media.w)), top: box.top, bottom: box.bottom, frames: new Map(), fine: new Map(), cuts: new Set(), fps: media.fps || 30 };
  }
  const M = media.masks;
  M.fine = M.fine || new Map(); M.cuts = M.cuts || new Set(); M.fps = M.fps || media.fps || 30;
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = media.url;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Could not read the video for masks')); });
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  const sy = box.top * v.videoHeight, sh = (box.bottom - box.top) * v.videoHeight;
  const dh = Math.round((S * sh) / v.videoWidth), dy = Math.round((S - dh) / 2);
  const input = new Float32Array(3 * S * S);
  return {
    M,
    async read(t, sess, ort) {
      v.currentTime = Math.min(media.duration - 0.02, Math.max(0, t));
      await new Promise((res) => { v.onseeked = res; });
      g.fillStyle = '#000';
      g.fillRect(0, 0, S, S);
      g.drawImage(v, 0, sy, v.videoWidth, sh, 0, dy, S, dh);
      const d = g.getImageData(0, 0, S, S).data;
      const sig = new Float32Array(48), hist = new Float32Array(16); // 8×6 block brightness + brightness spread
      for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) {
          const px = Math.floor(((x + (xx + 0.5) / 4) * S) / 8), py = dy + Math.floor(((y + (yy + 0.5) / 4) * dh) / 6);
          const q = (py * S + px) * 4;
          const l = d[q] * 0.2126 + d[q + 1] * 0.7152 + d[q + 2] * 0.0722;
          sum += l;
          hist[Math.min(15, l >> 4)] += 1 / 768;
        }
        sig[y * 8 + x] = sum / 16;
      }
      if (!sess) return { sig, hist };
      for (let i = 0, p = 0; i < S * S; i++, p += 4) { input[i] = d[p] / 255; input[S * S + i] = d[p + 1] / 255; input[2 * S * S + i] = d[p + 2] / 255; }
      const out = (await exclusive(() => sess.run({ img: new ort.Tensor('float32', input, [1, 3, S, S]) }))).mask.data;
      const m = new Uint8Array(M.w * M.h), guide = new Float32Array(M.w * M.h);
      for (let y = 0; y < M.h; y++) {
        const row = (dy + Math.min(dh - 1, Math.floor(((y + 0.5) * dh) / M.h))) * S;
        for (let x = 0; x < M.w; x++) {
          const i = row + Math.floor(((x + 0.5) * S) / M.w);
          m[y * M.w + x] = Math.round(255 * Math.min(1, Math.max(0, out[i])));
          guide[y * M.w + x] = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
        }
      }
      return { mask: m, guide, sig, hist };
    },
    close() { v.removeAttribute('src'); v.load(); },
  };
}

// Coarse masks (10 a second) at the given source times, for deciding where words can go.
export async function segmentTimes(media, times, onProgress, onStatus) {
  const want = [...new Set(times.map((t) => Math.round(t * MASK_RATE)))].filter((k) => k >= 0 && k / MASK_RATE < media.duration);
  const { ort, sess } = await loadSegmenter(onStatus);
  const R = await frameReader(media);
  const todo = want.filter((k) => !R.M.frames.has(k)).sort((a, b) => a - b);
  for (let n = 0; n < todo.length; n++) {
    const r = await R.read(todo[n] / MASK_RATE, sess, ort);
    R.M.frames.set(todo[n], refineMask(r.mask, r.guide, R.M.w, R.M.h, null).mask);
    onProgress && onProgress((n + 1) / todo.length);
  }
  R.close();
  return R.M;
}

// A mask for every frame of the source between t0 and t1, so the character outline matches
// the picture exactly (no blending between samples, which ghosts across cuts). Stops at the
// first real cut (a jump in the frame's block brightness that doesn't come back: flashes and
// impact frames inside a shot do) and returns { cut, start }: where the shot ends, and where it
// really starts if a cut sits right at the beginning (the scan's cut times can be a frame or three
// early), or null. Each frame is turned into a clean matte that remembers the previous frame's
// decisions (refineMask).
export async function segmentFrames(media, t0, t1, onProgress, onStatus) {
  const { ort, sess } = await loadSegmenter(onStatus);
  const R = await frameReader(media), M = R.M, fps = M.fps;
  const n0 = Math.max(0, Math.floor(t0 * fps)), n1 = Math.min(Math.floor((media.duration - 0.03) * fps), Math.ceil(t1 * fps));
  // a stretch traced before (this session, or an earlier one through the analysis cache): its
  // outlines are already in M.fine and its cut is known, so there's nothing to read again
  M.traced = M.traced || new Map();
  const done = M.traced.get(`${n0}:${n1}`);
  if (done) { R.close(); return { cut: done.cut != null ? done.cut / fps : null, start: done.start != null ? done.start / fps : null }; }
  const sigDist = (a, b) => { let d = 0; for (let k = 0; k < 48; k++) d += Math.abs(a[k] - b[k]); return d / (48 * 255); };
  const histDist = (a, b) => { let d = 0; for (let k = 0; k < 16; k++) d += Math.abs(a[k] - b[k]); return d / 2; };
  let diffs = [], hdiffs = [], shot = [], prev = null, prevH = null, cut = null, prevBin = null, start = null, pending = null;
  for (let n = n0; n <= n1; n++) {
    const r = await R.read((n + 0.5) / fps, M.fine.has(n) ? null : sess, ort);
    if (prev) {
      const d = sigDist(r.sig, prev), hd = histDist(r.hist, prevH);
      const med = [...diffs.slice(-8)].sort((a, b) => a - b)[Math.min(diffs.length, 8) >> 1] || 0;
      const medH = [...hdiffs.slice(-8)].sort((a, b) => a - b)[Math.min(hdiffs.length, 8) >> 1] || 0;
      diffs.push(d); hdiffs.push(hd);
      if (pending) {
        // a flash or impact frame comes back to the picture it interrupted within a few frames;
        // a real cut doesn't
        if (sigDist(r.sig, pending.sig) < Math.max(0.06, pending.med * 3) && histDist(r.hist, pending.hist) < 0.3) pending = null;
        else if (n - pending.n >= 8 || n === n1) {
          if (pending.n - (start ?? n0) <= 5 && start == null) {
            // the shot really starts here (the scan placed the cut a frame or three early)
            start = pending.n; shot = shot.filter((x) => x.n >= start); M.cuts.add(start); diffs = []; hdiffs = []; pending = null;
          } else { cut = pending.n; M.cuts.add(cut); shot = shot.filter((x) => x.n < cut); break; }
        }
      } else if (d > Math.max(0.08, med * 4) || (hd > Math.max(0.3, medH * 4) && d > Math.max(0.04, med * 2))) {
        // a cut candidate: the block layout jumps, or the whole brightness spread changes at once
        pending = { n, sig: prev, hist: prevH, med };
      }
    }
    // the reference for flash checks stays on the last frame before a candidate
    if (!pending) { prev = r.sig; prevH = r.hist; }
    if (r.mask) { prevBin = decideMask(r.mask, M.w, M.h, prevBin); shot.push({ n, bin: prevBin, guide: r.guide }); } else prevBin = null;
    onProgress && onProgress((n - n0 + 1) / (n1 - n0 + 1));
  }
  R.close();
  // keep only shapes that stay with the shot, then snap the edges to the line art
  stabilize(shot.map((x) => x.bin), M.w, M.h);
  for (const x of shot) M.fine.set(x.n, snapEdges(x.bin, x.guide, M.w, M.h));
  M.traced.set(`${n0}:${n1}`, { cut, start });
  return { cut: cut != null ? cut / fps : null, start: start != null ? start / fps : null };
}

// The character mask for the frame shown at source time t: exactly that frame's outline, or
// the nearest one a frame or two away within the same shot; otherwise the nearest coarse mask
// (10 a second, used by the FX boost) that isn't across a cut. Null when there is none.
export function maskAt(media, t) {
  const M = media && media.masks;
  if (!M) return null;
  const fps = M.fps || 30, n = Math.floor(t * fps + 1e-3);
  if (M.fine && M.fine.size) {
    const crosses = (a, b) => { for (let c = Math.min(a, b) + 1; c <= Math.max(a, b); c++) if (M.cuts.has(c)) return true; return false; };
    for (const k of [n, n - 1, n + 1, n - 2, n + 2]) {
      const d = M.fine.get(k);
      if (d && !crosses(n, k)) return { data: d, w: M.w, h: M.h, top: M.top, bottom: M.bottom, key: `${media.id}:f${k}` };
    }
  }
  if (M.frames && M.frames.size) {
    // never borrow an outline from the other side of a cut (exact cuts found frame by frame, plus scan cuts)
    const cuts = [...((media.analysis && media.analysis.scenes) || []).map((s) => s.start), ...[...(M.cuts || [])].map((c) => c / fps)];
    // (the nearest traced outline, then its neighbours: a shot's first outline is traced about a tenth of a second in, and with
    // only the nearest one tried, every effect that leans on the outline (a darkened background, a clone, the background's
    // softening) was missing for a shot's first three frames and then switched on at once: a visible step [10 Nov 2026])
    const k0 = Math.round(t * MASK_RATE);
    for (const k of [k0, k0 + 1, k0 - 1, k0 + 2]) {
      const kt = k / MASK_RATE, d = M.frames.get(k);
      if (d && !cuts.some((c) => c > Math.min(t, kt) + 1e-3 && c <= Math.max(t, kt) + 1e-3)) return { data: d, w: M.w, h: M.h, top: M.top, bottom: M.bottom, key: `${media.id}:c${k}` };
    }
  }
  return null;
}

// The stored mask nearest a source time (its own data, safe to keep; maskAt reuses one buffer).
export function maskNear(media, t) {
  const M = media && media.masks;
  if (!M) return null;
  const k = Math.round(t * MASK_RATE);
  const d = M.frames.get(k);
  return d ? { data: d, w: M.w, h: M.h, top: M.top, bottom: M.bottom, key: `${media.id}:${k}` } : null;
}

// How much of the picture the characters fill, and where: { coverage, cx, top, bottom } (0..1).
export function maskStats(m) {
  if (!m) return null;
  let n = 0, sx = 0, top = 1, bot = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (m.data[y * m.w + x] > 127) { n++; sx += x; const fy = y / m.h; if (fy < top) top = fy; if (fy > bot) bot = fy; }
  }
  return n ? { coverage: n / (m.w * m.h), cx: sx / n / m.w, top, bottom: bot } : { coverage: 0, cx: 0.5, top: 0.5, bottom: 0.5 };
}

// A full-resolution character matte for one picture (a cover image): the model at its full
// 1024 input, mapped back to the picture's own pixels and snapped to its line art. Returns a
// Float32Array (0..1, one per pixel) and how much of the picture is character.
export async function segmentImage(canvas) {
  const { ort, sess } = await loadSegmenter();
  const W = canvas.width, H = canvas.height, sc = S / Math.max(W, H);
  const dw = Math.round(W * sc), dh = Math.round(H * sc), dx = (S - dw) >> 1, dy = (S - dh) >> 1;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.drawImage(canvas, dx, dy, dw, dh);
  const d = g.getImageData(0, 0, S, S).data, input = new Float32Array(3 * S * S);
  for (let i = 0, p = 0; i < S * S; i++, p += 4) { input[i] = d[p] / 255; input[S * S + i] = d[p + 1] / 255; input[2 * S * S + i] = d[p + 2] / 255; }
  const out = (await exclusive(() => sess.run({ img: new ort.Tensor('float32', input, [1, 3, S, S]) }))).mask.data;
  const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const a = new Float32Array(W * H), lum = new Float32Array(W * H);
  let cover = 0;
  for (let y = 0; y < H; y++) {
    const v = Math.min(S - 1.001, Math.max(0, dy + (y + 0.5) * sc - 0.5)), y0 = v | 0, fy = v - y0;
    for (let x = 0; x < W; x++) {
      const u = Math.min(S - 1.001, Math.max(0, dx + (x + 0.5) * sc - 0.5)), x0 = u | 0, fx = u - x0, i = y0 * S + x0;
      const val = (out[i] * (1 - fx) + out[i + 1] * fx) * (1 - fy) + (out[i + S] * (1 - fx) + out[i + S + 1] * fx) * fy;
      const j = y * W + x;
      a[j] = Math.min(1, Math.max(0, val));
      lum[j] = (src[j * 4] * 0.2126 + src[j * 4 + 1] * 0.7152 + src[j * 4 + 2] * 0.0722) / 255;
      cover += a[j] > 0.5;
    }
  }
  return { alpha: guidedFilter(lum, a, W, H, 4, 1e-3), coverage: cover / (W * H) };
}
