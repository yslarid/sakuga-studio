// Optional RIFE frame interpolation using compatible, user-supplied ONNX weights.
//
// Used only where it reconstructs cleanly: shots measured as drawn on ones (which includes pans
// and zooms already in the footage), and only where the export needs a moment between two real
// frames (slow motion, the fast part of a ramp, a 60 fps export). Character animation on twos and
// threes keeps its drawings, as the reference edits do. Every in-between is checked against the
// two frames it came from, and anything that looks invented, ghosted or blurred is thrown away in
// favour of the nearest real frame.

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
// Set to '../../models/rife422lite_fp16.onnx' to use a compatible local model.
export const interpolationModelPath = null;

let sessP = null;
export function loadInterp() {
  if (!sessP) {
    sessP = (async () => {
      if (!interpolationModelPath) throw new Error('No interpolation model configured');
      const response = await fetch(new URL(interpolationModelPath, import.meta.url));
      if (!response.ok) throw new Error('Could not read the configured interpolation model');
      const ort = await import(ORT + 'ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = ORT;
      const sess = await ort.InferenceSession.create(await response.arrayBuffer(), { executionProviders: ['webgpu'] });
      return { ort, sess };
    })().catch((e) => { sessP = null; throw e; });
  }
  return sessP;
}

// A shot the in-betweens suit: drawn on ones (a new picture nearly every frame, so motion between
// frames is small and continuous). Twos and threes are drawings held on purpose.
export const interpSuits = (clip) => !!(clip && clip.cadence && clip.cadence.rate >= 18);

// Reuse the work buffers between frames (they're big at 1080p)
const bufs = new Map();
function buf(key, n) { let b = bufs.get(key); if (!b || b.length !== n) { b = new Float32Array(n); bufs.set(key, b); } return b; }

const LUMA_W = 160;

// low-resolution luma of a canvas or frame, for the checks
export function lumaOf(cv) {
  const h = Math.round((cv.height * LUMA_W) / cv.width), c = new OffscreenCanvas(LUMA_W, h), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(cv, 0, 0, LUMA_W, h);
  const d = g.getImageData(0, 0, LUMA_W, h).data, l = new Float32Array(LUMA_W * h);
  for (let i = 0; i < l.length; i++) l[i] = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
  return { l, w: LUMA_W, h };
}

// The checks an in-between has to pass (all at 160 px wide, cheap):
//  - the two frames mustn't be too different (a cut, a flash, a big pose jump: nothing to bridge);
//  - it can't hold detail neither frame had near that spot (invented structure);
//  - it can't be much softer than the frames (ghosting, smearing).
export function frameGate(A, B) {
  const a = lumaOf(A), b = lumaOf(B);
  return { a, b, change: lumaChange(a, b) };
}
export function lumaChange(a, b) {
  let d = 0;
  for (let i = 0; i < a.l.length; i++) d += Math.abs(a.l[i] - b.l[i]);
  return d / a.l.length;
}

// Where each drawing starts in a stretch of footage (seconds, in order): a frame that differs from
// the drawing before it by more than compression noise. Read once, frame by frame from a reader
// that knows its frame times. For hero shots slowed on twos or threes, whose in-betweens go from one
// drawing to the next rather than between the repeated frames of one drawing.
export async function drawingStarts(src, a, b) {
  const out = [];
  let t = Math.max(0, a), prev = null;
  for (let guard = 0; guard < 2000; guard++) {
    const pair = src.around(t);
    if (!pair) break;
    const [ta, tb] = pair;
    if (ta > b) break;
    const fr = await src.frameAt(ta);
    const L = lumaOf(fr);
    if (!prev || lumaChange(prev, L) > 0.004) { out.push(ta); prev = L; }
    t = tb + 1e-4;
  }
  return out;
}
function edgeEnergy(L) {
  let e = 0;
  for (let y = 1; y < L.h - 1; y++) for (let x = 1; x < L.w - 1; x++) { const i = y * L.w + x; e += Math.abs(L.l[i + 1] - L.l[i - 1]) + Math.abs(L.l[i + L.w] - L.l[i - L.w]); }
  return e;
}
function passes(g, M) {
  const m = lumaOf(M), { a, b } = g, W = m.w, H = m.h;
  // invented structure: every pixel of the in-between should fall within what either frame shows
  // within a couple of pixels of it (motion moves things, it doesn't make new ones)
  let bad = 0;
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    let lo = 1, hi = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const k = (y + dy) * W + x + dx; lo = Math.min(lo, a.l[k], b.l[k]); hi = Math.max(hi, a.l[k], b.l[k]); }
    const v = m.l[y * W + x];
    if (v < lo - 0.06 || v > hi + 0.06) bad++;
  }
  if (bad / ((W - 4) * (H - 4)) > 0.004) return false;
  // softness: real motion keeps its outlines; a failed in-between smears or doubles them
  const ea = edgeEnergy(a), eb = edgeEnergy(b), em = edgeEnergy(m);
  return em >= 0.8 * Math.min(ea, eb);
}

// The picture at fraction t (0..1) of the way from frame A to frame B (canvases or frames of the
// same size), or null when the in-between shouldn't be used (the caller shows the nearest frame).
// g is frameGate(A, B), when the caller has already measured the pair.
export async function inbetween(A, B, t, g = frameGate(A, B), maxChange = 0.09) {
  if (g.change > maxChange || g.change < 0.002) return null; // a jump, or nothing moving
  const { ort, sess } = await loadInterp();
  const w0 = A.width || A.displayWidth, h0 = A.height || A.displayHeight;
  const W = Math.ceil(w0 / 32) * 32, H = Math.ceil(h0 / 32) * 32, n = W * H;
  const toPlanes = (src, key) => {
    const c = new OffscreenCanvas(W, H), cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(src, 0, 0, w0, h0);
    if (H > h0) cx.drawImage(src, 0, h0 - 1, w0, 1, 0, h0, w0, H - h0); // pad by repeating the edge
    if (W > w0) cx.drawImage(c, w0 - 1, 0, 1, H, w0, 0, W - w0, H);
    const d = cx.getImageData(0, 0, W, H).data, f = buf(key, 3 * n);
    for (let i = 0; i < n; i++) { f[i] = d[i * 4] / 255; f[n + i] = d[i * 4 + 1] / 255; f[2 * n + i] = d[i * 4 + 2] / 255; }
    return new ort.Tensor('float32', f, [1, 3, H, W]);
  };
  let grid = bufs.get(`grid${W}x${H}`);
  if (!grid) {
    grid = new Float32Array(2 * n);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { grid[y * W + x] = -1 + (2 * x) / (W - 1); grid[n + y * W + x] = -1 + (2 * y) / (H - 1); }
    bufs.set(`grid${W}x${H}`, grid);
  }
  const out = await sess.run({
    img0: toPlanes(A, 'a'), img1: toPlanes(B, 'b'),
    timestep: new ort.Tensor('float32', new Float32Array([t]), [1, 1, 1, 1]),
    tenFlow_div: new ort.Tensor('float32', new Float32Array([(W - 1) / 2, (H - 1) / 2]), [2]),
    backwarp_tenGrid: new ort.Tensor('float32', grid, [1, 2, H, W]),
  });
  const r = out.frame.data, cv = new OffscreenCanvas(w0, h0), cx = cv.getContext('2d'), im = cx.createImageData(w0, h0);
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
    const i = y * W + x, o = (y * w0 + x) * 4;
    im.data[o] = r[i] * 255; im.data[o + 1] = r[n + i] * 255; im.data[o + 2] = r[2 * n + i] * 255; im.data[o + 3] = 255;
  }
  cx.putImageData(im, 0, 0);
  out.frame.dispose?.();
  return passes(g, cv) ? cv : null;
}
