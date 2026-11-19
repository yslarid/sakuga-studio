// Watermark: your logo, with a plain background keyed out, drawn semi-transparent in a corner
// of the picture on every frame (preview and export). It is composited after flashes and
// fades, so it never gets washed out, and it is remembered for every new video.
import { pictureBox } from './state.js';

const KEY = 'sakuga.watermark';
export const WATERMARK_DEFAULT = { src: null, opacity: 0.65, size: 0.09, corner: 'br' };

export function savedWatermark() {
  try {
    const w = JSON.parse(localStorage.getItem(KEY) || 'null');
    return w && w.src ? { ...WATERMARK_DEFAULT, ...w } : null;
  } catch (e) { return null; }
}

export function saveWatermark(w) {
  try {
    if (w && w.src) localStorage.setItem(KEY, JSON.stringify(w)); else localStorage.removeItem(KEY);
  } catch (e) { /* storage full or blocked: it still works for this video */ }
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Turn an image file into a transparent PNG data URL: a logo already saved with transparency
// is kept as it is; otherwise the border colour is treated as background and keyed out
// (with the dark fringe removed), then the image is cropped tight to the logo.
export async function keyLogo(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 1200 / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h), d = img.data;
  let transparent = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { transparent = true; break; }
  if (!transparent) {
    const edge = [[], [], []];
    const push = (x, y) => { const i = (y * w + x) * 4; for (let k = 0; k < 3; k++) edge[k].push(d[i + k]); };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    const bg = edge.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) / 255;
      const a = smooth(0.1, 0.32, dist);
      if (a > 0) for (let k = 0; k < 3; k++) d[i + k] = Math.min(255, Math.max(0, bg[k] + (d[i + k] - bg[k]) / a));
      d[i + 3] = Math.round(a * 255);
    }
    g.putImageData(img, 0, 0);
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error('That image looks empty after removing its background');
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

const imgs = new Map();
export function loadMarkImage(src) {
  if (!src) return Promise.resolve(null);
  if (!imgs.has(src)) {
    const im = new Image();
    imgs.set(src, { im, ready: new Promise((res) => { im.onload = () => res(im); im.onerror = () => res(null); }) });
    im.src = src;
  }
  return imgs.get(src).ready;
}

// The loaded mark itself (null until it has loaded), for the end card that draws it big
export function markImage(src) {
  const e = src && imgs.get(src);
  return e && e.im.complete && e.im.naturalWidth ? e.im : null;
}

// The overlay canvas for this output size, rebuilt only when something about it changes.
let layer = { key: null, canvas: null };
export function markLayer(project, w, h, t = null) {
  const wm = project.watermark;
  if (!wm || !wm.src) return null;
  // (while the end card shows the mark big in the middle, the corner one steps aside)
  if (t != null && (project.texts || []).some((x) => x.style === 'endcard' && t >= x.start && t < x.start + x.dur)) return null;
  loadMarkImage(wm.src);
  const im = imgs.get(wm.src).im;
  if (!im.complete || !im.naturalWidth) return null;
  const box = pictureBox(project);
  const key = [w, h, wm.src.length, wm.opacity, wm.size, wm.corner, wm.blend ? 1 : 0, box.top, box.bottom].join('|');
  if (layer.key === key) return layer;
  const c = layer.canvas || document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const ph = (box.bottom - box.top) * h;
  // sized and inset against the picture, not the whole frame (bands don't count)
  const mw = Math.min(w * wm.size, ph * 0.6 * (im.naturalWidth / im.naturalHeight));
  const mh = (mw * im.naturalHeight) / im.naturalWidth, pad = Math.min(w, ph) * 0.04;
  // (a vertical frame keeps it inside the apps' safe area: clear of the caption and buttons along the
  // bottom fifth and the right edge's icons, and inside the 4:5 grid crop)
  // (a vertical frame puts it top right, inside the apps' safe area: the bottom fifth is their caption
  // and buttons, the lower middle is where the edit's own captions sit, and the top 10% holds the
  // apps' search and camera icons, so it sits 13% down)
  const tall = h > w * 1.5;
  const x = tall ? w - pad - mw - w * 0.04 : wm.corner.includes('r') ? w - pad - mw : pad;
  const y = tall ? h * 0.13 : wm.corner.includes('b') ? box.bottom * h - pad - mh : box.top * h + pad;
  // (`blend`: the renderer takes the logo's colour from the picture behind it, as SceneMark does on the Love Me edits)
  g.globalAlpha = wm.blend ? 1 : wm.opacity;
  g.imageSmoothingQuality = 'high';
  g.drawImage(im, x, y, mw, mh);
  layer = { key, canvas: c, rect: { x0: x / w, y0: y / h, x1: (x + mw) / w, y1: (y + mh) / h }, blend: wm.blend ? { opacity: wm.blendOpacity ?? 0.5, tint: wm.blendTint ?? 0.1 } : null };
  return layer;
}

// Where the watermark sits in a frame drawn at w×h (0..1), or null: the studio checks captions keep clear of it.
export function markRect(project, w, h) {
  const l = markLayer(project, w, h);
  return l && l.rect ? l.rect : null;
}
