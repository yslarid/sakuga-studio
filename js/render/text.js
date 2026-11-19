import { loadCaptionStyles } from './fonts.js';
import { markImage } from '../watermark.js';

// Cyrillic: the caption faces with no Cyrillic letters borrow them, letter by letter, from a close
// match that has them (each loaded at the one weight that matches it), so a Russian line keeps the
// look; Inter and Noto Sans JP have their own
const CYRILLIC = { Anton: 'Oswald', 'Bebas Neue': 'Oswald', 'DM Serif Display': 'Playfair Display', Cinzel: 'Cormorant SC', 'Permanent Marker': 'Caveat', Poppins: 'Montserrat' };
export const fontStack = (fam) => `"${fam}"${CYRILLIC[fam] ? `, "${CYRILLIC[fam]}"` : ''}`;
// (a canvas draws with whatever is loaded: before rendering Cyrillic, load the borrowed faces)
export async function loadScriptFonts(text) {
  if (!/[\u0400-\u052f]/.test(String(text || ''))) return;
  await loadCaptionStyles();
  const faces = ['700 100px "Oswald"', '700 100px "Playfair Display"', 'italic 700 100px "Playfair Display"', '700 100px "Cormorant SC"', '700 100px "Caveat"', '600 100px "Montserrat"', '700 100px "Montserrat"', '800 100px "Inter"'];
  try { await Promise.all(faces.map((f) => document.fonts.load(f, 'АБВЖЯабвжя'))); } catch (e) { /* drawn with a system face */ }
}
// Text overlay layer drawn with Canvas2D and composited by the renderer.

export const TEXT_STYLES = {
  impact: { label: 'Impact', font: 'Anton', weight: 400, stroke: '#000000', strokeW: 0.09, upper: true },
  neon: { label: 'Neon', font: 'Bebas Neue', weight: 400, glow: '#ff3d7f', upper: true },
  subtitle: { label: 'Subtitle', font: 'Inter', weight: 700, box: 'rgba(0,0,0,0.55)' },
  // what a character says in a voice intro, like the Bleach reference: a rounded semibold sans in
  // warm cream with a soft shadow, sitting next to whoever speaks
  dialogue: { label: 'Dialogue', font: 'Poppins', weight: 600, shadow: true, size: 0.036, y: 0.2, color: '#f7d7a8' },
  manga: { label: 'Manga', font: 'Permanent Marker', weight: 400, stroke: '#000000', strokeW: 0.14 },
  jp: { label: '日本語', font: 'Noto Sans JP', weight: 900, stroke: '#e11d48', strokeW: 0.1 },
  minimal: { label: 'Minimal caps', font: 'Inter', weight: 600, upper: true, spacing: 0.22, shadow: true, size: 0.045 },
  outline: { label: 'Big outline', font: 'Anton', weight: 400, upper: true, hollow: true, size: 0.2 },
  serif: { label: 'Serif lyric', font: 'DM Serif Display', weight: 400, shadow: true, size: 0.07 },
  tag: { label: '@ Tag', font: 'Inter', weight: 600, alpha: 0.7, size: 0.032, y: 0.93 },
  kinetic: { label: 'Kinetic', font: 'Anton', weight: 400, upper: true, fit: true, shadow: true, size: 0.2 },
  countdown: { label: 'Countdown', font: 'Inter', weight: 700, size: 0.3 },
  // the reference lyric edits' giant word: one word at a time, filling the frame, in a big serif with
  // a printed texture through it, each in its own colour, tucked behind the character when one's there
  giant: { label: 'Giant word', font: 'DM Serif Display', weight: 400, upper: true, size: 0.3 },
};

// A paper-and-ink grain for giant words (the specks and scuffs a printed word has), made once
const GRAIN = (() => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), im = g.createImageData(256, 256);
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 256 * 256; i++) { const v = r(); im.data[i * 4 + 3] = v > 0.985 ? 230 : v > 0.93 ? 70 : v > 0.8 ? 22 : 0; }
  g.putImageData(im, 0, 0);
  // a few faint scuffs across it
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
  for (let k = 0; k < 14; k++) { g.beginPath(); const x = r() * 256, y = r() * 256, a = r() * Math.PI; g.moveTo(x, y); g.lineTo(x + Math.cos(a) * (20 + r() * 50), y + Math.sin(a) * (4 + r() * 10)); g.stroke(); }
  return c;
})();

// Per-word typography for kinetic lyric edits: font, weight, italic, colour.
export const KINETIC_FONTS = [
  { font: 'Anton', weight: 400 },
  { font: 'DM Serif Display', weight: 400 },
  { font: 'Inter', weight: 800, italic: true },
  { font: 'Bebas Neue', weight: 400 },
  { font: 'Permanent Marker', weight: 400 },
];
export const KINETIC_COLORS = ['#ffffff', '#ffd23f', '#ff4d6d', '#7bdff2', '#c8b6ff', '#b8f2a1', '#ffffff'];

export const TEXT_ANIMS = { pop: 'Pop in', fade: 'Fade', type: 'Typewriter', shake: 'Shake', slam: 'Slam', none: 'None' };

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const mixHex = (a, b, k) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, '0')).join('');
};
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

export class TextLayer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    // words that sit behind the characters (composited under the character mask)
    this.back = document.createElement('canvas');
    this.bctx = this.back.getContext('2d');
    this.backOut = null;
  }
  setSize(w, h) {
    for (const c of [this.canvas, this.back]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }
  // Returns the canvas if anything was drawn, otherwise null; `backOut` is the behind layer or null.
  // (`f`, the frame's own parameters, lets text set into the picture follow it)
  draw(texts, t, f = null) {
    this.frame = f;
    const active = texts.filter((x) => t >= x.start && t < x.start + x.dur && x.text);
    const { canvas: c, ctx: g } = this;
    g.clearRect(0, 0, c.width, c.height);
    if (this.backUsed) { this.bctx.clearRect(0, 0, c.width, c.height); this.backUsed = false; }
    this.backOut = null;
    this.box = null;
    c.bounds = null;
    if (!active.length) return null;
    // (the sign-off card goes over everything else, a lock word still running under it included)
    for (const x of active) if (x.style !== 'endcard') this.drawOne(x, t - x.start);
    for (const x of active) if (x.style === 'endcard') this.drawOne(x, t - x.start);
    if (this.backUsed) this.backOut = this.back;
    // where the text sits (0..1 of the frame): the renderer keeps it inside the frame when the
    // captions ride along with a camera move
    if (this.box) { const b = this.box; c.bounds = { x0: b[0] / c.width, y0: b[1] / c.height, x1: b[2] / c.width, y1: b[3] / c.height }; }
    return c;
  }
  // grow the drawn-text box (canvas pixels)
  grow(x0, y0, x1, y1) {
    const b = this.box;
    this.box = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
  }
  // An LED countdown timer (the long mix edits' bookend): seven-segment digits with a glow and a
  // dot-matrix texture, held, then counting down. x.from / x.to in seconds (shown m:ss:cc),
  // x.hold before it starts counting, x.color for the lit segments, x.card a backdrop colour.
  drawCountdown(x, lt) {
    const g = this.ctx, W = this.canvas.width, H = this.canvas.height;
    this.grow(0, 0, W, H);
    if (x.card) { g.fillStyle = x.card; g.fillRect(0, 0, W, H); }
    const hold = x.hold || 0, from = x.from ?? 300, to = x.to ?? 0;
    const q = lt < hold ? 0 : Math.min(1, (lt - hold) / Math.max(0.05, x.dur - hold));
    const v = Math.max(0, from + (to - from) * q);
    const m = Math.floor(v / 60), sec = Math.floor(v % 60), cs = Math.floor((v * 100) % 100);
    const str = `${m}:${String(sec).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
    const totalW = Math.min(W * 0.73, H * 1.4), cw = totalW / (str.replace(/:/g, '').length + 0.9), ch = cw * 1.75, th = cw * 0.17;
    let px = (W - totalW) / 2;
    const py = H * (x.y ?? 0.5) - ch / 2, col = x.color || '#ffffff';
    // segments: a top, b upper right, c lower right, d bottom, e lower left, f upper left, g middle
    const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
    const seg = (s, x0, y0, w) => {
      const h2 = ch / 2, r = th / 2;
      const R = { a: [x0 + th, y0, w - 2 * th, th], d: [x0 + th, y0 + ch - th, w - 2 * th, th], g: [x0 + th, y0 + h2 - r, w - 2 * th, th], f: [x0, y0 + th, th, h2 - th * 1.5], e: [x0, y0 + h2 + th * 0.5, th, h2 - th * 1.5], b: [x0 + w - th, y0 + th, th, h2 - th * 1.5], c: [x0 + w - th, y0 + h2 + th * 0.5, th, h2 - th * 1.5] }[s];
      g.beginPath(); g.roundRect(R[0], R[1], R[2], R[3], r); g.fill();
    };
    g.save();
    for (const chr of str) {
      if (chr === ':') {
        g.fillStyle = col; g.shadowColor = col; g.shadowBlur = th * 2.5;
        for (const fy of [0.33, 0.67]) { g.beginPath(); g.arc(px + cw * 0.22, py + ch * fy, th * 0.6, 0, Math.PI * 2); g.fill(); }
        px += cw * 0.45;
        continue;
      }
      const w = cw * 0.82;
      for (const s of 'abcdefg') {
        const on = SEG[chr].includes(s);
        g.globalAlpha = on ? 1 : 0.07;
        g.fillStyle = col; g.shadowColor = col; g.shadowBlur = on ? th * 2.5 : 0;
        seg(s, px, py, w);
      }
      g.globalAlpha = 1;
      px += cw;
    }
    // dot-matrix texture over the lit digits
    g.shadowBlur = 0; g.globalCompositeOperation = 'destination-out'; g.fillStyle = 'rgba(0,0,0,0.28)';
    const step = Math.max(3, Math.round(th * 0.45));
    for (let yy = Math.floor(py); yy < py + ch; yy += step) g.fillRect((W - totalW) / 2 - th, yy, totalW + th * 2, 1);
    g.restore();
  }

  // One giant word (see TEXT_STYLES.giant): fully up 0.05 s in, which is the moment it's sung, then
  // settling from 108% over a fifth of a second; gone in 0.06 s at its end, or at once when the
  // next word takes its place (`cut`). Drawn on its own canvas first so the grain only marks the
  // word, then onto the front layer, or the behind layer (under the character) when `behind` is set.
  drawGiant(x, lt) {
    const W = this.canvas.width, H = this.canvas.height;
    if (!this.tmp) { this.tmp = document.createElement('canvas'); this.tctx = this.tmp.getContext('2d'); }
    if (this.tmp.width !== W || this.tmp.height !== H) { this.tmp.width = W; this.tmp.height = H; }
    const g = this.tctx, text = x.text.toUpperCase(), fam = x.font || 'DM Serif Display';
    g.clearRect(0, 0, W, H);
    g.save();
    // (`stretch` draws it taller than its face, the XP2 background words' 1.5-2x)
    const st2 = Math.max(1, Number(x.stretch) || 1);
    let size = Math.round((H * (x.maxH ?? 0.62)) / st2);
    g.font = `400 ${size}px ${fontStack(fam)}, Georgia, serif`;
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    // (86% wide at most, so the settle from 108% stays inside the frame; a split word's halves each
    // fit the room beside the face)
    // (`body`: a character stands in for one of the letters, the S-RANK built round Jinwoo standing
    // legs apart as its A: the word is set as tall as the figure (cap top to feet), that letter left
    // out and its slot centred on the figure, the rest of the word either side on the same baseline)
    if (x.body && Number.isFinite(Number(x.body.letter))) { g.restore(); this.drawBodyWord(x, lt, g, text, fam, st2, W, H); return; }
    const halves = x.split ? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))] : null;
    const w0 = halves ? 2 * Math.max(...halves.map((h) => g.measureText(h).width)) : g.measureText(text).width, s0 = size;
    const room = halves ? Math.max(0.1, 2 * Math.min(x.split.cx - x.split.gap / 2, 1 - x.split.cx - x.split.gap / 2) * (x.fit ?? 0.86)) : (x.fit ?? 0.86);
    size = Math.max(8, Math.min(size, Math.round((size * W * room) / Math.max(1, w0))));
    g.font = `400 ${size}px ${fontStack(fam)}, Georgia, serif`;
    const tw = (w0 * size) / s0;
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    // (a backdrop word, behind the characters all shot long, grows slowly instead of settling; a
    // voice word cuts on and off still, as the XP2 edits' do)
    // (`punch`: it lands on its syllable at 112% and settles in 0.15 s, then grows on slowly)
    const sc = x.backdrop ? (x.punch ? 1 + 0.12 * (1 - easeOut(Math.min(1, lt / 0.15))) : 1) * (1 + 0.05 * Math.min(1, lt / Math.max(0.3, x.dur))) : x.still ? 1 : 1 + 0.08 * (1 - easeOut(Math.min(1, lt / 0.18)));
    const cx = (x.x ?? 0.5) * W, cy = (x.y ?? 0.5) * H, base = size * 0.36;
    g.translate(cx, cy); g.scale(sc, sc * st2);
    if (x.gradient && x.gradient.length >= 2) {
      // a vertical gradient across the letters (white → pink → red, say)
      const gr = g.createLinearGradient(0, base - size * 0.72, 0, base);
      x.gradient.forEach((c, i) => gr.addColorStop(i / (x.gradient.length - 1), c));
      g.fillStyle = gr;
    } else if (x.shimmer && x.shimmer.length >= 2) {
      // the fill flickers between two tones of the speaker's colour frame to frame, over a glow
      // (and a soft dark bed first, so it reads over a bright frame too)
      g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = size * 0.3;
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(text, 0, base);
      g.shadowColor = x.glowColor || x.shimmer[0]; g.shadowBlur = size * 0.22;
      g.fillStyle = x.shimmer[0]; g.fillText(text, 0, base);
      g.shadowBlur = 0;
      g.fillStyle = Math.floor(lt * 24) % 2 ? x.shimmer[1] : mixHex(x.shimmer[0], x.shimmer[1], 0.55);
    } else g.fillStyle = x.color || '#ffffff';
    // (`outline`: an edge round the letters, dark on a dark shot and light on a bright one, so the
    // word stands off the picture behind it; drawn first, the fill covers its inner half)
    if (x.outline && !halves) {
      const fill = g.fillStyle;
      g.save(); g.lineJoin = 'round'; g.lineWidth = Math.max(2, size * 0.045); g.strokeStyle = x.outline; g.strokeText(text, 0, base); g.restore();
      g.fillStyle = fill;
    }
    if (halves) {
      // (the halves set apart by the gap, each against its side of the face, in the word's own plane)
      g.textAlign = 'right'; g.fillText(halves[0], ((x.split.cx - x.split.gap / 2) * W - cx) / sc, base);
      g.textAlign = 'left'; g.fillText(halves[1], ((x.split.cx + x.split.gap / 2) * W - cx) / sc, base);
      g.textAlign = 'center';
    } else g.fillText(text, 0, base);
    if (GRAIN && x.grain !== false) {
      // (the ink texture shifts every three frames, as the Dandadan edit's distressed words boil, so
      // a word held over a still shot stays alive)
      const n = Math.floor((lt * 24) / 3);
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = g.createPattern(GRAIN, 'repeat');
      g.translate(((n * 37) % 97) - 48, ((n * 53) % 89) - 44);
      g.fillRect(-W - 100, -size - 100, W * 2 + 200, size * 2 + 200);
    }
    g.restore();
    const out = x.behind ? this.bctx : this.ctx;
    if (x.behind) this.backUsed = true;
    out.save();
    out.globalAlpha = Math.max(0, Math.min(1, lt / 0.05, x.cut ? 1 : (x.dur - lt) / 0.06)) * (x.alpha ?? 1);
    // a soft shadow under the word lifts it off busy footage
    // (a word laid over the picture instead, as in the vertical copy over pale hair, gets a deeper one)
    out.shadowColor = x.behind ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.62)'; out.shadowBlur = size * (x.behind ? 0.05 : 0.1);
    out.drawImage(this.tmp, 0, 0);
    out.restore();
    // (`punch`: for its first two frames a glowing outline of the word flashes in front, as the XP2
    // edits' words enter)
    if (x.punch && lt < 2 / 24 && !halves) {
      const f = this.ctx;
      f.save();
      f.translate(cx, cy); f.scale(sc, sc * st2);
      f.font = `400 ${size}px ${fontStack(fam)}, Georgia, serif`;
      if ('letterSpacing' in f) f.letterSpacing = '0px';
      f.textAlign = 'center'; f.textBaseline = 'alphabetic';
      f.lineJoin = 'round'; f.lineWidth = Math.max(1.5, size * 0.018) / sc;
      f.strokeStyle = '#ffffff'; f.shadowColor = (x.gradient && x.gradient[1]) || '#ffffff'; f.shadowBlur = size * 0.08;
      f.strokeText(text, 0, base);
      f.restore();
    }
    // (`ghost`: a word behind a character in the middle of the frame keeps reading whole: a thin
    // outline of its letters runs on in front, over the character where it hides them)
    if (x.ghost && x.behind && !halves) {
      const f = this.ctx;
      f.save();
      f.globalAlpha = Math.max(0, Math.min(1, lt / 0.05, x.cut ? 1 : (x.dur - lt) / 0.06)) * 0.55;
      f.translate(cx, cy); f.scale(sc, sc * st2);
      f.font = `400 ${size}px ${fontStack(fam)}, Georgia, serif`;
      if ('letterSpacing' in f) f.letterSpacing = '0px';
      f.textAlign = 'center'; f.textBaseline = 'alphabetic';
      f.lineJoin = 'round'; f.lineWidth = Math.max(1.2, size * 0.011) / sc;
      f.strokeStyle = (x.gradient && x.gradient[0]) || x.color || '#ffffff';
      f.shadowColor = 'rgba(0,0,0,0.35)'; f.shadowBlur = size * 0.02;
      f.strokeText(text, 0, base);
      f.restore();
    }
    const hw = (tw / 2) * sc;
    // (the letters' own height, cap top to baseline (0.72 of the size, drawn round the centre), not the
    // font's: a line set on the word's edge sits on the letters, not on the air above them)
    this.grow(cx - hw, cy - size * 0.38 * sc * st2, cx + hw, cy + size * 0.38 * sc * st2);
  }

  drawBodyWord(x, lt, g, text, fam, st2, W, H) {
    const b = x.body, li = Math.max(0, Math.min(text.length - 1, Number(b.letter)));
    // where the figure is: `keys` [source s, x, top, bottom, gap] tracked through the shot in the
    // source picture (tools/track.py), carried through the crop, zoom and shake like the picture,
    // so the letters stay set to the body while the camera moves
    const keys = Array.isArray(b.keys) && b.keys.length ? b.keys : [[0, b.x, b.top, b.bottom, b.gap || 0]];
    const f = this.frame, st = f && Number.isFinite(f.srcTime) ? f.srcTime : keys[0][0];
    let k = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (st > keys[i + 1][0]) continue;
      const u = Math.max(0, Math.min(1, (st - keys[i][0]) / Math.max(1e-6, keys[i + 1][0] - keys[i][0])));
      k = keys[i].map((v, j) => v + (keys[i + 1][j] - v) * u);
      break;
    }
    const pin = f && f.pin ? f.pin : (px, py) => [px, py];
    const [tx, ty] = pin(k[1], k[2]), [bxf, byf] = pin(k[1], k[3]), [gx] = pin(k[1] + (k[4] || 0) / 2, k[3]);
    g.font = `400 100px ${fontStack(fam)}, Impact, sans-serif`;
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    const capK = Math.max(0.5, g.measureText('H').actualBoundingBoxAscent / 100);
    // (`scale`: the letters a share of the figure's height on its baseline, the head rising above
    // them as the letter's top, so the word stays compact)
    const capH = Math.max(0.02, (byf - ty) * H * (Number(b.scale) || 1));
    const size = capH / (capK * st2);
    g.font = `400 ${size}px ${fontStack(fam)}, Impact, sans-serif`;
    const pre = text.slice(0, li), post = text.slice(li + 1);
    const slotW = k[4] > 0 ? 2 * (gx - bxf) * W : g.measureText(text[li]).width;
    const bx = bxf * W, by = byf * H;
    // (it lands at 112% round the figure and settles in 0.15 s; after that it moves only with the picture)
    const sc = x.punch ? 1 + 0.12 * (1 - easeOut(Math.min(1, lt / 0.15))) : 1;
    const set = (c) => { c.translate(bx, by - capH / 2); c.scale(sc, sc); c.translate(0, capH / 2); c.scale(1, st2); };
    // (set by their ink, not their advance: the letters either side sit a letter-space off the figure)
    const ink = (str, side) => { g.textAlign = side < 0 ? 'right' : 'left'; const m = g.measureText(str); return side < 0 ? -slotW / 2 - m.actualBoundingBoxRight : slotW / 2 + m.actualBoundingBoxLeft; };
    const sides = [[pre, 'right', -1], [post, 'left', 1]].filter((e) => e[0]).map(([str, align, side]) => [str, align, ink(str, side)]);
    g.clearRect(0, 0, W, H);
    g.save();
    set(g);
    let grad = x.color || '#ffffff';
    if (x.gradient && x.gradient.length >= 2) { grad = g.createLinearGradient(0, -size * capK, 0, 0); x.gradient.forEach((c, i) => grad.addColorStop(i / (x.gradient.length - 1), c)); }
    g.textBaseline = 'alphabetic'; g.lineJoin = 'round';
    // (letter by letter where it falls, so one can be set apart: `letterStyles` { index in the
    // word: "gold" }, the S of S-RANK in polished gold)
    const styled = x.letterStyles || {}, glyphs = [];
    for (const [str, align, ox] of sides) {
      g.textAlign = 'left';
      const w = g.measureText(str).width, x0 = align === 'right' ? ox - w : ox, off = str === pre ? 0 : li + 1;
      const run = [];
      for (let i = 0; i < str.length; i++) run.push({ ch: str[i], gx: x0 + g.measureText(str.slice(0, i)).width, idx: off + i });
      // (a styled letter's wider edge gets its own room: the run moves away from the figure by it,
      // from that letter outwards)
      const pad = size * 0.012;
      run.forEach((q, i) => {
        if (!styled[q.idx]) return;
        if (align === 'right') for (let j = 0; j <= i; j++) run[j].gx -= j === i ? pad : 2 * pad;
        else for (let j = i; j < run.length; j++) run[j].gx += j === i ? pad : 2 * pad;
      });
      glyphs.push(...run);
    }
    g.textAlign = 'left';
    for (const q of glyphs) {
      if (styled[q.idx]) continue;
      if (x.outline) { g.lineWidth = Math.max(2, size * 0.045); g.strokeStyle = x.outline; g.strokeText(q.ch, q.gx, 0); }
      g.fillStyle = grad; g.fillText(q.ch, q.gx, 0);
    }
    g.restore();
    const gold = glyphs.filter((q) => styled[q.idx] === 'gold');
    if (gold.length) {
      if (!this.tmp2) { this.tmp2 = document.createElement('canvas'); this.tctx2 = this.tmp2.getContext('2d'); }
      if (this.tmp2.width !== W || this.tmp2.height !== H) { this.tmp2.width = W; this.tmp2.height = H; }
      const c = this.tctx2;
      c.clearRect(0, 0, W, H);
      c.save();
      set(c);
      c.font = g.font;
      if ('letterSpacing' in c) c.letterSpacing = '0px';
      for (const q of gold) paintGold(c, q.ch, q.gx, size, capK, lt);
      c.restore();
    }
    const out = x.behind ? this.bctx : this.ctx;
    if (x.behind) this.backUsed = true;
    const fade = Math.max(0, Math.min(1, lt / 0.05, x.cut ? 1 : (x.dur - lt) / 0.06)) * (x.alpha ?? 1);
    out.save();
    out.globalAlpha = fade;
    out.shadowColor = 'rgba(0,0,0,0.45)'; out.shadowBlur = size * 0.05;
    out.drawImage(this.tmp, 0, 0);
    // (the gold letter glows warm, the only warm light in the shot)
    if (gold.length) { out.shadowColor = 'rgba(255,196,90,0.38)'; out.shadowBlur = size * 0.07; out.drawImage(this.tmp2, 0, 0); }
    out.restore();
    // (a glowing outline flashes in front for two frames as it lands)
    if (x.punch && lt < 2 / 24) {
      const c = this.ctx;
      c.save();
      set(c);
      c.font = `400 ${size}px ${fontStack(fam)}, Impact, sans-serif`; c.textBaseline = 'alphabetic';
      c.lineJoin = 'round'; c.lineWidth = Math.max(1.5, size * 0.018); c.strokeStyle = '#ffffff';
      c.shadowColor = (x.gradient && x.gradient[1]) || '#ffffff'; c.shadowBlur = size * 0.08;
      for (const [str, align, ox] of sides) { c.textAlign = align; c.strokeText(str, ox, 0); }
      c.restore();
    }
    const wPre = g.measureText(pre).width, wPost = g.measureText(post).width;
    this.grow(bx - slotW / 2 - wPre, by - capH, bx + slotW / 2 + wPost, by);
  }

  // A lock word (the Love Me letter trend, docs/refs/group-G.md): one word with something in the
  // picture standing in for one letter, an eye or an orb for the O, a hand or a figure for a V or an L.
  // The letters are set round the thing as it is on the lock frame (`box` [cx, cy, w, h] in the source
  // picture, or `slot` [x0, x1] / `cap` / `base` for a body whose arm is the L's foot): its height is
  // their cap height, a letter-space either side of it, and they ride with the camera like the picture.
  // They arrive one by one before the lock (`arriveAt`, seconds into the word; `arrive` fade, drop,
  // fly, write, none), each in the shot's own face and material, and hold. Carried in from the shot
  // before (`clipId` names the lock shot), they stay where they'll be while the picture cuts under them.
  drawLockWord(x, lt) {
    if (x.plane && Array.isArray(x.plane.keys) && x.plane.keys.length) { this.drawPlaneWord(x, lt); return; }
    const W = this.canvas.width, H = this.canvas.height, f = this.frame;
    const onLock = !x.clipId || !f || f.clipId == null || f.clipId === x.clipId;
    const pin = onLock && f && f.pin ? f.pin : (px, py) => [px, py];
    const [cx, cy, bw, bh] = x.box;
    const cap0 = x.cap ?? cy - bh / 2, base0 = x.base ?? cy + bh / 2;
    const s0 = x.slot ? x.slot[0] : cx - bw / 2, s1 = x.slot ? x.slot[1] : cx + bw / 2;
    const [lx, ty] = pin(s0, cap0), [rx, by] = pin(s1, base0);
    const text = String(x.text).toUpperCase(), li = Math.max(0, Math.min(text.length - 1, Number(x.letter) || 0));
    const fam = x.face || 'Bodoni Moda', style = `${x.italic ? 'italic ' : ''}${x.weight || 400}`;
    const g = x.behind ? this.bctx : this.ctx;
    if (x.behind) this.backUsed = true;
    g.save();
    g.font = `${style} 100px ${fontStack(fam)}, Georgia, serif`;
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    const capK = Math.max(0.4, g.measureText('H').actualBoundingBoxAscent / 100);
    let capH = Math.max(4, (by - ty) * H * (Number(x.scale) || 1)), size = capH / capK;
    g.font = `${style} ${size}px ${fontStack(fam)}, Georgia, serif`;
    // (the rest of the word has to fit in the frame, 4% in from its edges: the letters shrink to fit,
    // never the thing, worked out on the source picture so it doesn't change as the camera moves)
    {
      const pre0 = text.slice(0, li), post0 = text.slice(li + 1), A = W / H, k0 = (by - ty) / Math.max(1e-6, (base0 - cap0));
      const capS = (base0 - cap0) * (Number(x.scale) || 1), spS = capS * (x.space ?? 0.07);
      const wpre = pre0 ? (g.measureText(pre0).width / capH) * capS / A : 0, wpost = post0 ? (g.measureText(post0).width / capH) * capS / A : 0;
      // (10% in from the picture's edges in source terms: the lock camera pushes in about 12% over the
      // shot, which carries the outer letters outwards)
      const M = x.margin ?? 0.06;
      const kL = wpre > 0 ? (s0 - spS / A - M) / wpre : 1, kR = wpost > 0 ? (1 - M - s1 - spS / A) / wpost : 1;
      const k = Math.max(0.4, Math.min(1, kL, kR));
      if (k < 1 && k0 > 0) { capH *= k; size = capH / capK; g.font = `${style} ${size}px ${fontStack(fam)}, Georgia, serif`; }
    }
    // (`scale` under 1: the letters smaller than the thing, centred on it, an orb or an iris bigger
    // than the word; `valign: "base"` keeps them on its foot instead, a figure's feet)
    const sp = capH * (x.space ?? 0.07), L = lx * W - sp, R = rx * W + sp;
    // (letters a different height from the thing sit centred on it: smaller round an orb, taller round a
    // small ring; `valign: "base"` keeps them on its foot instead)
    const base = Math.abs(capH - (by - ty) * H) > (by - ty) * H * 0.02 && x.valign !== 'base' ? ((ty + by) / 2) * H + capH / 2 : by * H;
    // (each run set by its ink: the letters before the thing end a letter-space short of it, the
    // letters after start a letter-space past it)
    const pre = text.slice(0, li), post = text.slice(li + 1), glyphs = [];
    if (pre) {
      const m = g.measureText(pre), x0 = L - m.actualBoundingBoxRight;
      for (let i = 0; i < pre.length; i++) glyphs.push({ ch: pre[i], idx: i, gx: x0 + g.measureText(pre.slice(0, i)).width, side: -1 });
    }
    if (post) {
      const m = g.measureText(post), x0 = R + m.actualBoundingBoxLeft;
      for (let i = 0; i < post.length; i++) glyphs.push({ ch: post[i], idx: li + 1 + i, gx: x0 + g.measureText(post.slice(0, i)).width, side: 1 });
    }
    // (whole to its shot's last frame: a dissolve out fades from a held copy of that frame)
    const fadeOut = x.fadeOut || 0.012, out = Math.max(0, Math.min(1, (x.dur - lt) / fadeOut)) * (x.alpha ?? 1);
    if (x.roll) { const ox = (lx + rx) / 2 * W; g.translate(ox, base); g.rotate((x.roll * Math.PI) / 180); g.translate(-ox, -base); }
    this.paintLockGlyphs(g, x, glyphs, base, capH, size, capK, lt, out);
    g.restore();
    if (glyphs.length) this.grow(Math.min(...glyphs.map((q) => q.gx)), base - capH, Math.max(...glyphs.map((q) => q.gx + size * 0.8)), base);
  }

  // The letters of a lock word, each as it stands in its arrival, in the word's material (shared by
  // the word set round a thing and the word laid on a surface)
  paintLockGlyphs(g, x, glyphs, base, capH, size, capK, lt, out) {
    g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.lineJoin = 'round';
    const col = x.color || '#ffffff', mat = x.material || 'flat', T = lt;
    const fill = (c, gx) => {
      if (mat === 'chrome' || mat === 'ice' || mat === 'fire') {
        const gr = c.createLinearGradient(0, base - capH * 1.02, 0, base);
        const stops = mat === 'chrome' ? [[0, '#ffffff'], [0.42, '#d9dee6'], [0.5, '#59606c'], [0.58, '#a9b1bd'], [1, '#f4f6f9']]
          : mat === 'ice' ? [[0, '#ffffff'], [0.45, mixHex(col, '#ffffff', 0.55)], [1, col]]
          : [[0, '#fff3b0'], [0.35, '#ffc23a'], [0.7, '#ff6a12'], [1, '#b8120a']];
        for (const [o, s] of stops) gr.addColorStop(o, s);
        return gr;
      }
      return mat === 'neon' ? 'rgba(0,0,0,0)' : col;
    };
    for (const q of glyphs) {
      const a0 = x.arrive === 'none' || !x.arriveAt ? -1 : x.arriveAt[q.idx] ?? -1;
      const p = a0 < 0 ? 1 : Math.max(0, Math.min(1, (T - a0) / (x.arriveDur || 0.24)));
      if (p <= 0) continue;
      const e = easeOut(p), w = g.measureText(q.ch).width;
      g.save();
      g.globalAlpha = out * (x.arrive === 'write' ? 1 : e);
      const gcx = q.gx + w / 2, gcy = base - capH / 2;
      if (x.arrive === 'drop') { const k = 1.32 - 0.32 * e; g.translate(gcx, gcy); g.scale(k, k); g.translate(-gcx, -gcy); }
      else if (x.arrive === 'fly') g.translate(q.side * (1 - e) * capH * 0.7, 0);
      if (x.arrive === 'write' && p < 1) { g.beginPath(); g.rect(q.gx - size * 0.1, base - capH * 1.3, (w + size * 0.2) * Math.min(1, p * 1.25), capH * 1.6); g.clip(); }
      // the material: flat (a soft shadow keeps it off the picture), glow (its own colour as light),
      // neon (a tube: coloured edge, white core, wide glow), chrome, ice, fire (graded fills), gold
      if (mat === 'gold') { g.translate(0, base); paintGold(g, q.ch, q.gx, size, capK, T); g.restore(); continue; }
      if (mat === 'glow' || mat === 'neon' || mat === 'fire' || mat === 'ice') {
        const flick = mat === 'fire' ? 0.85 + 0.15 * Math.sin(T * 23 + q.idx * 1.7) * Math.sin(T * 9.3 + q.idx) : 1;
        // (`glowColor`: a light of its own round the letters, white letters with a cyan glow on a white eye)
        g.shadowColor = mat === 'fire' ? '#ff7a1a' : x.glowColor || col; g.shadowBlur = size * (mat === 'neon' ? 0.16 : x.glowColor ? 0.14 : 0.1) * flick;
      } else { g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = size * 0.06; }
      if (mat === 'neon' || mat === 'outline') {
        g.lineWidth = Math.max(1.5, size * 0.032); g.strokeStyle = col; g.strokeText(q.ch, q.gx, base);
        if (mat === 'neon') { g.shadowBlur = 0; g.lineWidth = Math.max(1, size * 0.011); g.strokeStyle = mixHex(col, '#ffffff', 0.8); g.strokeText(q.ch, q.gx, base); }
      } else {
        g.fillStyle = fill(g, q.gx); g.fillText(q.ch, q.gx, base);
        if (mat === 'glow' || mat === 'fire') { g.shadowBlur = 0; g.fillText(q.ch, q.gx, base); }
        if (mat === 'ice') { g.shadowBlur = 0; g.lineWidth = Math.max(1, size * 0.008); g.strokeStyle = 'rgba(255,255,255,0.85)'; g.strokeText(q.ch, q.gx, base); }
      }
      if (x.arrive === 'write' && p < 1) { g.globalAlpha = out; g.shadowBlur = 0; g.lineWidth = Math.max(1, size * 0.014); g.strokeStyle = mixHex(col, '#ffffff', 0.5); g.strokeText(q.ch, q.gx, base); }
      g.restore();
    }
  }

  // A lock word laid on a surface (`plane.keys` [source s, 8 corners] from tools/letters.py plane:
  // top-left, top-right, bottom-right, bottom-left of where the word lies, in the source picture): set
  // flat on a sheet (the thing's letter left as a gap when `letter` is given), then laid onto the
  // tracked corners in perspective, a mesh of small triangles each drawn with its own affine map.
  drawPlaneWord(x, lt) {
    const W = this.canvas.width, H = this.canvas.height, f = this.frame, keys = x.plane.keys;
    const st = f && Number.isFinite(f.srcTime) ? f.srcTime : keys[0][0];
    let k = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (st > keys[i + 1][0]) continue;
      const u = Math.max(0, Math.min(1, (st - keys[i][0]) / Math.max(1e-6, keys[i + 1][0] - keys[i][0])));
      k = keys[i].map((v, j) => v + (keys[i + 1][j] - v) * u);
      break;
    }
    const pin = f && f.pin ? f.pin : (px, py) => [px, py];
    const Q = [0, 1, 2, 3].map((i) => { const [px, py] = pin(k[1 + 2 * i], k[2 + 2 * i]); return [px * W, py * H]; });
    if (!this.flat) { this.flat = document.createElement('canvas'); this.fctx = this.flat.getContext('2d'); }
    const FW = 2048, FH = 640;
    if (this.flat.width !== FW || this.flat.height !== FH) { this.flat.width = FW; this.flat.height = FH; }
    const g = this.fctx, text = String(x.text).toUpperCase(), li = x.letter == null ? -1 : Number(x.letter);
    const fam = x.face || 'Bodoni Moda', style = `${x.italic ? 'italic ' : ''}${x.weight || 400}`;
    g.clearRect(0, 0, FW, FH);
    g.save();
    g.font = `${style} 100px ${fontStack(fam)}, Georgia, serif`;
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    const capK = Math.max(0.4, g.measureText('H').actualBoundingBoxAscent / 100);
    // (the word as wide as the sheet allows, its cap height at most 70% of it)
    const w100 = g.measureText(text).width, size = Math.min((FW * (x.fill || 0.94) * 100) / Math.max(1, w100), (FH * 0.7) / capK);
    g.font = `${style} ${size}px ${fontStack(fam)}, Georgia, serif`;
    const capH = size * capK, base = FH / 2 + capH / 2, wAll = g.measureText(text).width;
    const glyphs = [];
    for (let i = 0; i < text.length; i++) if (i !== li) glyphs.push({ ch: text[i], idx: i, gx: (FW - wAll) / 2 + g.measureText(text.slice(0, i)).width, side: i < li ? -1 : 1 });
    const fadeOut = x.fadeOut || 0.012, out = Math.max(0, Math.min(1, (x.dur - lt) / fadeOut)) * (x.alpha ?? 1);
    this.paintLockGlyphs(g, x, glyphs, base, capH, size, capK, lt, out);
    g.restore();
    const dst = x.behind ? this.bctx : this.ctx;
    if (x.behind) this.backUsed = true;
    // (a flat, square-on surface is one affine map, drawn in one go: the mesh's seams show in a glow)
    const par = Math.abs(Q[0][0] + Q[2][0] - Q[1][0] - Q[3][0]) + Math.abs(Q[0][1] + Q[2][1] - Q[1][1] - Q[3][1]);
    if (par < 1.5) {
      dst.save();
      dst.setTransform((Q[1][0] - Q[0][0]) / FW, (Q[1][1] - Q[0][1]) / FW, (Q[3][0] - Q[0][0]) / FH, (Q[3][1] - Q[0][1]) / FH, Q[0][0], Q[0][1]);
      dst.drawImage(this.flat, 0, 0);
      dst.restore();
    } else warpQuad(dst, this.flat, FW, FH, Q, 16, 6);
    this.grow(Math.min(...Q.map((q) => q[0])), Math.min(...Q.map((q) => q[1])), Math.max(...Q.map((q) => q[0])), Math.max(...Q.map((q) => q[1])));
  }

  // Fade the watermark up on black. Its right edge drops into place on the final beat.
  drawEndCard(x, lt) {
    const g = this.ctx, W = this.canvas.width, H = this.canvas.height, im = markImage(x.mark);
    this.grow(0, 0, W, H);
    g.save();
    g.globalAlpha = Math.min(1, lt / 0.12);
    g.fillStyle = '#000000'; g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    if (im) {
      const mw = W * (x.width || 0.42), mh = (mw * im.naturalHeight) / im.naturalWidth, x0 = (W - mw) / 2, y0 = (H - mh) / 2, sp = x.split || 0.862;
      const a = easeOut(Math.max(0, Math.min(1, (lt - 0.08) / 0.32))), k = 1.04 - 0.04 * a;
      g.save(); g.globalAlpha = a; g.translate(W / 2, H / 2); g.scale(k, k); g.translate(-W / 2, -H / 2);
      g.drawImage(im, 0, 0, im.naturalWidth * sp, im.naturalHeight, x0, y0, mw * sp, mh);
      g.restore();
      const L = x.lockLt || 0.62, p = Math.max(0, Math.min(1, (lt - 0.14) / Math.max(0.1, L - 0.14))), e = 1 - Math.pow(1 - p, 3);
      if (p > 0) {
        g.save();
        g.globalAlpha = Math.min(1, p * 2.5);
        const land = Math.max(0, lt - L), glow = land > 0 ? Math.exp(-land * 3) : 0;
        if (glow > 0.02) { g.shadowColor = 'rgba(255,190,80,0.9)'; g.shadowBlur = mh * 0.5 * glow; }
        g.drawImage(im, im.naturalWidth * sp, 0, im.naturalWidth * (1 - sp), im.naturalHeight, x0 + mw * sp, y0 - (1 - e) * H * 0.32, mw * (1 - sp), mh);
        g.restore();
      }
    }
    g.restore();
  }

  drawOne(x, lt) {
    const g = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const st = TEXT_STYLES[x.style] || TEXT_STYLES.impact;
    if (x.kind === 'slice') { this.drawSlice(x, lt); return; }
    if (x.kind === 'lockup') { this.drawLockup(x, lt); return; }
    if (x.kind === 'halo') { this.drawHalo(x, lt); return; }
    if (x.style === 'lockword') { this.drawLockWord(x, lt); return; }
    if (x.style === 'endcard') { this.drawEndCard(x, lt); return; }
    if (x.words && x.words.length) { this.drawBuild(x, lt, st); return; }
    if (x.style === 'countdown') { this.drawCountdown(x, lt); return; }
    if (x.style === 'giant') { this.drawGiant(x, lt); return; }
    let text = st.upper ? x.text.toUpperCase() : x.text;
    let scale = 1, alpha = 1, dx = 0, dy = 0;
    const out = Math.min(0.15, x.dur * 0.2);
    if (lt > x.dur - out) alpha = Math.max(0, (x.dur - lt) / out);
    switch (x.anim) {
      case 'pop': { const p = Math.min(1, lt / 0.22); scale = 0.55 + 0.45 * easeOutBack(p); alpha *= Math.min(1, lt / 0.05); break; }
      case 'fade': alpha *= Math.min(1, lt / 0.3); break;
      case 'type': { const n = Math.ceil(text.length * Math.min(1, lt / Math.min(x.dur * 0.6, text.length * 0.06))); text = text.slice(0, n); break; }
      case 'shake': { const a = W * 0.006; dx = Math.sin(lt * 71) * a; dy = Math.cos(lt * 53) * a; break; }
      case 'slam': { const p = Math.min(1, lt / 0.12); scale = 2.2 - 1.2 * p; alpha *= Math.min(1, lt / 0.05); break; }
    }
    if (!text) return;
    const fam = x.font || st.font, wt = x.weight || st.weight, it = x.italic ? 'italic ' : '';
    let size = Math.round((x.size || 0.12) * W);
    g.save();
    g.globalAlpha = alpha * (st.alpha ?? 1);
    g.font = `${it}${wt} ${size}px ${fontStack(fam)}, Impact, "Arial Black", sans-serif`;
    if (st.fit) {
      // kinetic words fill the frame width
      if ('letterSpacing' in g) g.letterSpacing = '0px';
      const w = g.measureText(text).width;
      size = Math.min(Math.round((size * W * 0.9) / Math.max(1, w)), Math.round(W * 0.42));
      g.font = `${it}${wt} ${size}px ${fontStack(fam)}, Impact, "Arial Black", sans-serif`;
    }
    if ('letterSpacing' in g) g.letterSpacing = st.spacing ? `${Math.round(size * st.spacing)}px` : '0px';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const align = x.align || 'center';
    g.textAlign = align;
    const lines = st.fit ? [text] : wrap(g, text, W * (align === 'center' ? 0.88 : 0.5)); // kinetic text is one full-width line
    const lh = size * 1.08;
    const cx = (x.x ?? 0.5) * W + dx, cy = (x.y ?? 0.5) * H + dy;
    g.translate(cx, cy);
    g.scale(scale, scale);
    const top = -((lines.length - 1) * lh) / 2;
    lines.forEach((line, i) => {
      const y = top + i * lh;
      {
        const lw = g.measureText(line).width * scale, ox = align === 'left' ? 0 : align === 'right' ? -lw : -lw / 2;
        this.grow(cx + ox - size * 0.2, cy + (y - lh / 2) * scale, cx + ox + lw + size * 0.2, cy + (y + lh / 2) * scale);
      }
      if (st.box) {
        const w = g.measureText(line).width + size * 0.6, bx = align === 'left' ? -size * 0.3 : align === 'right' ? -w + size * 0.3 : -w / 2;
        g.fillStyle = st.box;
        roundRect(g, bx, y - lh / 2, w, lh, size * 0.18);
        g.fill();
      }
      if (st.glow) {
        g.shadowColor = x.glowColor || st.glow;
        g.shadowBlur = size * 0.5;
        g.fillStyle = x.color || '#fff';
        g.fillText(line, 0, y);
        g.shadowBlur = size * 0.2;
      }
      if (st.hollow) {
        g.lineJoin = 'round';
        g.lineWidth = Math.max(2, size * 0.045);
        g.strokeStyle = x.color || '#ffffff';
        g.strokeText(line, 0, y);
        return;
      }
      if (st.shadow) {
        g.shadowColor = 'rgba(0,0,0,0.65)';
        g.shadowBlur = size * 0.35;
        if (x.style === 'dialogue') { g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = size * 0.25; g.shadowOffsetY = size * 0.06; }
      }
      if (st.stroke) {
        g.lineJoin = 'round';
        g.lineWidth = size * st.strokeW;
        g.strokeStyle = x.strokeColor || st.stroke;
        g.strokeText(line, 0, y);
      }
      g.fillStyle = x.color || st.color || '#ffffff';
      g.fillText(line, 0, y);
      g.shadowBlur = 0; g.shadowOffsetY = 0;
    });
    g.restore();
  }
}

// Type pairings for build-up lines: 'serif' for calm scenes (the romance edit: serif words,
// the key word big in italic serif), 'caps' for action (the Blue Lock edit: small spaced
// caps around a huge condensed key word).
const BUILD_LOOKS = {
  serif: { word: { font: 'DM Serif Display', weight: 400, scale: 1 }, hot: { font: 'DM Serif Display', weight: 400, italic: true, scale: 1.6 } },
  caps: { word: { font: 'Inter', weight: 700, upper: true, spacing: 0.16, scale: 0.75 }, hot: { font: 'Anton', weight: 400, upper: true, scale: 1.8 } },
  // the Haikyuu edit: every word a neon tube in its own colour (bright core, coloured halo)
  neon: { word: { font: 'Inter', weight: 800, upper: true, spacing: 0.06, scale: 0.95, neon: true }, hot: { font: 'Inter', weight: 800, upper: true, spacing: 0.04, scale: 1.55, neon: true } },
  // the XP2 Demon Slayer edits: every word in one heavy condensed face, big and tightly stacked,
  // white with the key word in colour, lifted off the footage by a dark extruded shadow and a soft
  // glow (usually set on a plane turned in depth, `persp`)
  stack: { word: { font: 'Anton', weight: 400, upper: true, spacing: 0.005, scale: 1.25, extrude: true }, hot: { font: 'Anton', weight: 400, upper: true, spacing: 0.005, scale: 1.25, extrude: true }, tight: true },
  // the One Piece edit's gentle captions: widely spaced light caps, each word tightening in from
  // wider spacing as it lands, the key word only a little bolder
  spaced: { word: { font: 'Inter', weight: 400, upper: true, spacing: 0.2, scale: 0.72 }, hot: { font: 'Inter', weight: 600, upper: true, spacing: 0.2, scale: 0.9 }, track: true },
  // the romance ballad edit's two-size system: small book-serif words, the key word huge in a heavy
  // high-contrast serif with a hard, unblurred dark shadow stepped down and right
  ballad: { word: { font: 'DM Serif Display', weight: 400, scale: 0.62 }, hot: { font: 'DM Serif Display', weight: 400, scale: 2.1, hard: true } },
  // the XP2 edits' sneering lines: lowercase grotesk drawn as a glowing coloured outline over a dark
  // see-through fill
  outline: { word: { font: 'Inter', weight: 700, scale: 0.95, outline: true }, hot: { font: 'Inter', weight: 800, scale: 1.15, outline: true } },
};

// neon turn-on: a couple of quick flickers before the tube holds
// the tube strikes on with one quick stutter, done by the time the word is sung (words enter 0.05 s early)
const neonFlicker = (age) => (age < 0.015 ? 0.7 : age < 0.03 ? 0.2 : 1);

// Build-up lyrics: each word appears as it's sung. With `lockup` the key word gets its own big
// row and the words around it sit small above and below. The block grows from its anchor
// (left, right or centre) so it can sit beside the character, drifts slowly while it's up,
// pulses its key word on the song's beats and blurs away at the end.
// `enter` matches the scene: 'drift' (calm: blur in and rise), 'pop' (springy scale) or
// 'slam' (hits: drops in big with a shake, the key word with an RGB split).
// The tag's logo (set by the studio before an edit with a tag, from the saved mark).
let TAG_IMAGE = null;
export function setTagImage(im) { TAG_IMAGE = im; }

// Our word style (7 Nov 2026, the user: "not be a copy of the references style I want our own style"):
// heavy condensed caps, slanted, cut across by a thin line, white above the cut and the colour below.
// The two halves slide in from opposite sides and lock; a cut gives the word a small kick.
// `at` when it starts (seconds into the card), `kicks` the times of the cuts, `out` seconds it leaves in.
const SLANT = Math.tan(6 * Math.PI / 180);
// `v2` (the user's canonical spec, 8 Nov 2026, docs/your-month-spec-v2.md, section 7: "Replace the heavy flat black outline stroke with a
// clean dark drop-shadow (blur: 12px, opacity: 65%) paired with a subtle ambient outer glow matched to the character's accent color.
// Animate each text block in over the first 6-8 frames ... (using a quick tracking pull-in letter-spacing: 0.20em -> 0.04em + slight
// vertical slide ...)"): no stroke, the shadow and the glow, and instead of the halves sliding in, the letters pulling in from wide
// tracking as the word rises a little into place over `inDur` (7 frames).
function v2finish(g, draw, px, glow) {
  const k = g.canvas.width / 1080;
  g.shadowColor = hexA(glow, 0.5); g.shadowBlur = 26 * k; g.shadowOffsetY = 0; draw();
  g.shadowColor = 'rgba(0,0,0,0.65)'; g.shadowBlur = 12 * k; g.shadowOffsetY = 2 * k; draw();
  g.shadowColor = 'rgba(0,0,0,0)'; g.shadowBlur = 0; g.shadowOffsetY = 0;
}
function hexA(h, a) { const c = (h || '#ffffff').replace('#', ''); const n = parseInt(c.length === 3 ? c.split('').map((q) => q + q).join('') : c, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
function sliceWord(g, word, xr, yb, px, color, lt, { at = 0, inDur = 0.2, kicks = [], outAt = null, out = 0.13, align = 'r', cutAngle = -0.06, top = '#ffffff', v2 = false } = {}) {
  if (lt < at) return null;
  g.save();
  g.font = `400 ${px}px "Anton", Impact, sans-serif`;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  const inU = Math.min(1, (lt - at) / inDur), inE = easeOut(inU);
  if ('letterSpacing' in g) g.letterSpacing = v2 ? `${(px * (0.20 - 0.16 * inE)).toFixed(2)}px` : `${(px * 0.012).toFixed(2)}px`;
  const tw = g.measureText(word).width, x0 = align === 'r' ? xr - tw : align === 'c' ? xr - tw / 2 : xr, capH = px * 0.86, yc = yb - capH / 2;
  const outU = outAt != null && lt > outAt ? Math.min(1, (lt - outAt) / out) : 0, outE = outU * outU;
  const slide = v2 ? 0 : (1 - inE + outE) * tw * 0.42, alpha = Math.min(1, inU * (v2 ? 2.2 : 3)) * (1 - outE);
  if (v2) g.translate(0, (1 - inE) * px * 0.2);
  if (alpha <= 0) { g.restore(); return null; }
  // the kick on a cut, and the moment of the lock, lift the word towards white for a beat
  let kick = 0;
  for (const k of kicks) { const u = (lt - k) / 0.13; if (u >= 0 && u < 1) kick = Math.max(kick, 1 - easeOut(u)); }
  const lock = inU >= 1 ? Math.max(0, 1 - (lt - at - inDur) / 0.1) : 0;
  const sc = 1 + 0.03 * kick;
  g.translate(x0 + tw / 2, yc); g.scale(sc, sc); g.translate(-(x0 + tw / 2), -yc);
  g.transform(1, 0, -SLANT, 1, yc * SLANT, 0);
  const gap = Math.max(1.5, px * 0.016);
  const half = (dir, fill) => {
    g.save();
    g.translate(dir * slide + dir * px * 0.012, 0);
    g.beginPath();
    const y0 = (X) => yc + cutAngle * (X - (x0 + tw / 2)) + (dir < 0 ? -gap / 2 : gap / 2);
    const xa = x0 - px, xb = x0 + tw + px, far = dir < 0 ? yc - px * 2 : yc + px * 2;
    g.moveTo(xa, y0(xa)); g.lineTo(xb, y0(xb)); g.lineTo(xb, far); g.lineTo(xa, far); g.closePath(); g.clip();
    g.globalAlpha = alpha;
    g.fillStyle = mixHex(fill, '#ffffff', Math.min(1, Math.max(kick * 0.6, lock * 0.7)));
    if (v2) { v2finish(g, () => g.fillText(word, x0, yb), px, color); g.fillText(word, x0, yb); g.restore(); return; }
    g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = px * 0.2; g.shadowOffsetY = px * 0.025;
    g.lineJoin = 'round'; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.lineWidth = Math.max(2, px * 0.05); g.strokeText(word, x0, yb);
    g.shadowColor = 'rgba(0,0,0,0)'; g.shadowBlur = 0; g.shadowOffsetY = 0;
    g.fillText(word, x0, yb);
    g.restore();
  };
  half(-1, top); half(1, color);
  g.restore();
  return { x0, x1: x0 + tw, top: yb - capH };
}

// A small tight line whose letters tick on from the left, with its own colours per run.
function tickRow(g, runs, xr, y, px, lt, at, { dur = 0.16, align = 'r', outAt = null, out = 0.13, v2 = false, glow = '#ffffff' } = {}) {
  if (lt < at) return;
  g.save();
  g.font = `800 ${px}px "Inter", "Helvetica Neue", Arial, sans-serif`;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  if (v2) {
    // the spec's pull-in: the whole line at once, tracking from 0.20em to 0.04em, rising a little, no stroke, the shadow and the glow
    const u = Math.min(1, (lt - at) / dur), e = easeOut(u);
    if ('letterSpacing' in g) g.letterSpacing = `${(px * (0.20 - 0.16 * e)).toFixed(2)}px`;
    const text = runs.map((r) => r.t).join(''), tw = g.measureText(text).width;
    let cx = align === 'r' ? xr - tw : align === 'c' ? xr - tw / 2 : xr;
    g.globalAlpha = Math.min(1, u * 2.2) * (outAt != null && lt > outAt ? Math.max(0, 1 - (lt - outAt) / out) : 1);
    g.translate(0, (1 - e) * px * 0.35);
    for (const r of runs) {
      const x = cx; g.fillStyle = r.color || '#ffffff';
      v2finish(g, () => g.fillText(r.t, x, y), px, glow); g.fillText(r.t, x, y);
      cx += g.measureText(r.t).width;
    }
    g.restore(); return;
  }
  if ('letterSpacing' in g) g.letterSpacing = `${(px * 0.06).toFixed(2)}px`;
  const text = runs.map((r) => r.t).join(''), tw = g.measureText(text).width;
  let cx = align === 'r' ? xr - tw : align === 'c' ? xr - tw / 2 : xr, done = 0;
  const shown = Math.ceil(text.length * Math.min(1, (lt - at) / dur));
  const alpha = outAt != null && lt > outAt ? Math.max(0, 1 - (lt - outAt) / out) : 1;
  g.globalAlpha = alpha;
  g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = px * 0.35; g.shadowOffsetY = px * 0.04;
  g.lineJoin = 'round'; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = Math.max(1.5, px * 0.11);
  for (const r of runs) {
    const n = Math.max(0, Math.min(r.t.length, shown - done));
    if (n > 0) { g.strokeText(r.t.slice(0, n), cx, y); g.fillStyle = r.color || '#ffffff'; g.fillText(r.t.slice(0, n), cx, y); }
    cx += g.measureText(r.t).width; done += r.t.length;
  }
  g.restore();
}

// A month: the word, with the character's number and name above it.
TextLayer.prototype.drawSlice = function (x, lt) {
  const g = this.ctx, W = this.canvas.width, H = this.canvas.height, px = Math.round((x.size || 0.0645) * W);
  const al = x.align || 'c', m = (x.margin ?? 0.05) * W, xr = al === 'l' ? m : al === 'c' ? W / 2 : W - m, yb = (x.y ?? 0.94) * H;
  const outAt = x.out ? x.dur - x.out : null;
  const v2 = x.style === 'v2', inDur = v2 ? (x.inDur ?? 7 / 30) : 0.2;
  const box = sliceWord(g, x.text, xr, yb, px, x.color || '#ffa43a', lt, { kicks: x.kicks || [], outAt, out: x.out || 0.13, align: al, cutAngle: x.cut ?? -0.06, v2, inDur });
  if (box && x.label) tickRow(g, x.label, xr, box.top - px * 0.12, Math.round(px * 0.36), lt, x.labelAt ?? (v2 ? 1 / 30 : 0.14), { align: al, outAt, out: x.out || 0.13, v2, glow: x.color || '#ffa43a', dur: v2 ? inDur : 0.16 });
};

// The opening: small lines ticking on, each on a beat, the anime's name landing last in the word's style.
TextLayer.prototype.drawLockup = function (x, lt) {
  const g = this.ctx, W = this.canvas.width, H = this.canvas.height, px = Math.round((x.size || 0.057) * W), small = Math.round(px * 0.42);
  const al = x.align || 'c', m = (x.margin ?? 0.05) * W, xr = al === 'l' ? m : al === 'c' ? W / 2 : W - m, yb = (x.y ?? 0.94) * H, capH = px * 0.86;
  const v2 = x.style === 'v2', inDur = v2 ? (x.inDur ?? 7 / 30) : 0.2;
  const box = sliceWord(g, x.text, xr, yb, px, x.color || '#ff8a3d', lt, { at: x.bigAt ?? 1.6, outAt: null, align: al, v2, inDur });
  (x.rows || []).forEach((r, i) => {
    const y = yb - capH - px * 0.1 - (x.rows.length - 1 - i) * small * 1.22;
    tickRow(g, r.runs, xr, y, small, lt, r.at, { align: al, v2, glow: x.color || '#ff8a3d', ...(v2 ? { dur: inDur } : {}) });
  });
  return box;
};

// The logo's flash, our own (7 Nov 2026, the user: "flash our logo in a different way so it dosent copy
// the reference style"): the halo drops from above onto the o, a burst of light where it lands, the
// letters open out from there, a shine runs across them, and they burn out into the white frame.
TextLayer.prototype.drawHalo = function (x, lt) {
  const g = this.ctx, W = this.canvas.width, H = this.canvas.height, im = TAG_IMAGE;
  if (!im) return;
  const iw = im.naturalWidth, ih = im.naturalHeight, w = (x.w ?? 0.28) * W, k = w / iw, h = ih * k, cx = (x.x ?? 0.5) * W, cy = (x.y ?? 0.7) * H, x0 = cx - w / 2, y0 = cy - h / 2, D = x.dur || 0.66;
  // the ring is the top of the last letter's column (the logo's own proportions: from 86.8% across, the top 29%)
  const rx = iw * 0.868, rh = ih * 0.29, rcx = x0 + (rx + (iw - rx) / 2) * k, rcy = y0 + (rh / 2) * k;
  const dropEnd = 0.14, t = lt, burn = Math.max(0, (t - (D - 0.13)) / 0.13);
  g.save();
  // the ring falling
  const p = Math.min(1, t / dropEnd), fall = (1 - p * p) * h * 2.4, ringSc = 1 + (1 - p) * 0.5;
  g.save();
  g.translate(rcx, rcy + (t < dropEnd ? -fall : 0)); g.scale(ringSc, ringSc); g.translate(-rcx, -rcy);
  g.globalAlpha = Math.min(1, p * 3);
  g.shadowColor = 'rgba(255,236,170,0.95)'; g.shadowBlur = h * (t < dropEnd ? 0.7 : 0.35 + burn);
  g.drawImage(im, rx, 0, iw - rx, rh, x0 + rx * k, y0, (iw - rx) * k, rh * k);
  g.restore();
  if (t >= dropEnd) {
    // the burst where it lands
    const u = (t - dropEnd) / 0.24;
    if (u < 1) {
      const R = w * (0.12 + 0.55 * easeOut(u)), gr = g.createRadialGradient(rcx, rcy, 0, rcx, rcy, R);
      gr.addColorStop(0, `rgba(255,248,220,${(0.95 * (1 - u) * (1 - u)).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,240,190,0)');
      g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.fillRect(rcx - R, rcy - R, R * 2, R * 2);
      // a thin ring of light going out
      g.globalAlpha = (1 - u) * 0.8; g.strokeStyle = '#fff6d8'; g.lineWidth = Math.max(1, h * 0.05 * (1 - u));
      g.beginPath(); g.ellipse(rcx, rcy, R * 0.8, R * 0.3, 0, 0, Math.PI * 2); g.stroke();
      g.restore();
    }
    // the letters, opening out from the ring to the left, the shine crossing them, burning out at the end
    const open = easeOut(Math.min(1, (t - dropEnd) / 0.16)), left = rcx - (rcx - x0 + h) * open;
    const c = this.haloC || (this.haloC = document.createElement('canvas')); if (c.width !== Math.ceil(w) || c.height !== Math.ceil(h)) { c.width = Math.ceil(w); c.height = Math.ceil(h); }
    const q = c.getContext('2d'); q.globalCompositeOperation = 'source-over'; q.clearRect(0, 0, c.width, c.height);
    q.drawImage(im, 0, 0, rx, ih, 0, 0, rx * k, h); q.drawImage(im, rx, rh, iw - rx, ih - rh, rx * k, rh * k, (iw - rx) * k, (ih - rh) * k);
    q.globalCompositeOperation = 'source-atop';
    const sw = (t - dropEnd - 0.1) / 0.3;
    if (sw > 0 && sw < 1) { const sx = sw * (w + w * 0.3) - w * 0.15, gs = q.createLinearGradient(sx - w * 0.14, 0, sx + w * 0.14, 0); gs.addColorStop(0, 'rgba(255,255,255,0)'); gs.addColorStop(0.5, 'rgba(255,255,255,0.95)'); gs.addColorStop(1, 'rgba(255,255,255,0)'); q.fillStyle = gs; q.fillRect(0, 0, c.width, c.height); }
    if (burn > 0) { q.fillStyle = `rgba(255,255,255,${burn.toFixed(3)})`; q.fillRect(0, 0, c.width, c.height); }
    g.save();
    g.beginPath(); g.rect(left - w, y0 - h, w * 2 + (rcx - left) + h, h * 3); g.clip();
    const sc = 1 + burn * 0.05; g.translate(cx, cy); g.scale(sc, sc); g.translate(-cx, -cy);
    g.shadowColor = burn > 0 ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.6)'; g.shadowBlur = burn > 0 ? h * (0.4 + burn * 1.6) : h * 0.16;
    g.drawImage(c, x0, y0, w, h);
    g.restore();
  }
  g.restore();
};

TextLayer.prototype.drawBuild = function (x, lt, st) {
  // a line on a plane turned in depth (`persp`, `roll`) is drawn flat into scratch layers first,
  // then laid onto the picture in perspective
  if ((x.persp || x.roll) && !this.flat) return this.drawTurned(x, lt, st);
  const g = this.flat ? this.flat.ctx : this.ctx, W = this.canvas.width, H = this.canvas.height;
  let look = BUILD_LOOKS[x.look] || {
    word: { font: x.font || st.font, weight: x.weight || st.weight, upper: st.upper, spacing: st.spacing, scale: 1 },
    hot: { font: x.font || st.font, weight: x.weight || st.weight, upper: st.upper, spacing: st.spacing, italic: true, scale: x.hotScale || 1.3 },
  };
  // (pro: the key word bigger still, the way the references set it against the small words)
  if (x.hotMul) look = { ...look, hot: { ...look.hot, scale: look.hot.scale * x.hotMul } };
  const base = (x.size || 0.08) * W, align = x.align || 'center', enter = x.enter || 'drift';
  // (stacked rows hold two words or so, like the references; a long line grows downwards instead)
  // (a line set smaller or bigger in the notes keeps its rows: `rowK` scales the row width with it)
  const maxW = (x.maxW ? W * x.maxW : W * (look.tight ? (align === 'center' ? 0.42 : 0.33) : align === 'center' ? 0.72 : 0.46)) * (x.rowK || 1);
  const setFont = (sp, px, ctx = g) => {
    ctx.font = `${sp.italic ? 'italic ' : ''}${sp.weight} ${px}px ${fontStack(sp.font)}, Georgia, serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = sp.spacing ? `${Math.round(px * sp.spacing)}px` : '0px';
  };
  const bg = this.flat ? this.flat.bctx : this.bctx;
  g.save();
  bg.save();
  // (stacked: a second key word takes the second accent; words run together without spaces where a
  // colour change marks the break, as the XP2 blocks do, and keep a narrow gap between two white words)
  const second = look.tight && x.accent2 && x.words.length >= 3 ? x.words.reduce((best, w, i) => (!w.hot && i > 0 && w.text.length >= 4 && (!best || w.text.length > best.text.length) ? w : best), null) : null;
  const words = x.words.map((w, idx) => {
    let sp = w.hot && x.accent ? look.hot : look.word;
    if (x.italicAll && !sp.italic) sp = { ...sp, italic: true };
    const px = Math.round(base * sp.scale * (w === second ? 1.2 : 1)), s = sp.upper ? w.text.toUpperCase() : w.text;
    setFont(sp, px);
    const col = w.hot && x.accent ? x.accent : w === second ? x.accent2 : null;
    return { ...w, idx, sp, px, s, col, wd: g.measureText(s).width, gap: g.measureText(' ').width + (sp.spacing ? px * sp.spacing : 0) };
  });
  if (look.tight) for (let i = 0; i < words.length - 1; i++) if (words[i].col || words[i + 1].col) words[i].gap *= 0.18; else words[i].gap *= 0.45;
  // (an italic key word after an upright one leans back over the space: give it a little more room)
  else for (let i = 1; i < words.length; i++) if (words[i].sp.italic && !words[i - 1].sp.italic) words[i - 1].gap += words[i].px * 0.05;
  const hi = words.findIndex((w) => w.hot && x.accent);
  const groups = x.lockup && !look.tight && hi >= 0 && words.length > 1 ? [words.slice(0, hi), [words[hi]], words.slice(hi + 1)].filter((r) => r.length) : [words];
  const rows = [];
  for (const grp of groups) {
    // a lone word too wide for its side shrinks to fit
    if (grp.length === 1 && grp[0].wd > maxW) { const k = maxW / grp[0].wd; grp[0].px = Math.floor(grp[0].px * k); grp[0].wd *= k; grp[0].gap *= k; }
    let cur = [], cw = 0;
    for (const w of grp) {
      if (cur.length && cw + cur[cur.length - 1].gap + w.wd > maxW) { rows.push(cur); cur = []; cw = 0; }
      cw += (cur.length ? cur[cur.length - 1].gap : 0) + w.wd;
      cur.push(w);
    }
    if (cur.length) rows.push(cur);
    // (a subtitle that wraps onto two rows splits them evenly, after a comma where one is close: a
    // lone last word on its own row reads as an afterthought)
    if (x.subtitle && rows.length >= 2 && rows[rows.length - 2].length + rows[rows.length - 1].length === grp.length && grp.length >= 3) {
      const wOf = (ws) => ws.reduce((t, w, i) => t + w.wd + (i < ws.length - 1 ? w.gap : 0), 0);
      let best = null;
      for (let i = 1; i < grp.length; i++) {
        const a2 = grp.slice(0, i), b2 = grp.slice(i), m = Math.max(wOf(a2), wOf(b2));
        if (m > maxW) continue;
        const cost = m * (/[,;:.!?”]$/.test(a2[a2.length - 1].text) ? 0.85 : 1);
        if (!best || cost < best.cost) best = { cost, a2, b2 };
      }
      if (best) rows.splice(rows.length - 2, 2, best.a2, best.b2);
    }
  }
  const widthOf = (ws) => ws.reduce((t, w, i) => t + w.wd + (i < ws.length - 1 ? w.gap : 0), 0);
  const rowH = rows.map((r) => Math.max(...r.map((w) => w.px)) * (look.tight ? 0.9 : r.some((w) => w.sp.upper && w.sp.font === 'Anton') ? 0.98 : 1.12));
  const rowGap = rows.length > 1 ? base * (look.tight ? 0.02 : 0.22) : 0; // room between the small rows and the big key word
  const blockH = rowH.reduce((a2, b2) => a2 + b2, 0) + rowGap * (rows.length - 1);
  let cy = (x.y ?? 0.5) * H;
  // (a subtitle line glides up a row when the next line comes in under it, `moveAt` seconds in)
  if (x.moveAt != null && x.moveTo != null && lt > x.moveAt) cy += (x.moveTo - (x.y ?? 0.5)) * H * easeInOut(Math.min(1, (lt - x.moveAt) / 0.22));
  // (and on up a row more, out of the block, as it fades: the line after it is rising into its place)
  if (x.exitAt != null && x.moveTo != null && lt > x.exitAt) cy += (x.moveTo - (x.y ?? 0.5)) * H * easeInOut(Math.min(1, (lt - x.exitAt) / 0.22));
  // (lifted off what's under it while a shot is on screen: a step on a hard cut, a glide inside the
  // shot where a dissolve carries the cut, so the text never moves while two pictures are mixed)
  for (const [a0, a1, d, gIn = 0, gOut = 0] of x.lifts || []) {
    if (lt < a0 || lt >= a1) continue;
    const up = gIn ? easeInOut(Math.min(1, (lt - a0) / gIn)) : 1, down = gOut ? easeInOut(Math.min(1, Math.max(0, (a1 - lt) / gOut))) : 1;
    cy -= d * H * Math.min(up, down);
  }
  {
    // keep the whole block on the picture (a subtitle within its own band; any other line within the
    // title-safe frame: a tall stacked line set near an edge would lose its top or bottom rows)
    const bx = x.box || [0.04, 0.96];
    const top = bx[0] * H + base * 0.4, bot = bx[1] * H - base * 0.4;
    cy = blockH > bot - top ? (top + bot) / 2 : Math.min(bot - blockH / 2, Math.max(top + blockH / 2, cy));
  }
  // and across: the widest row stays on the canvas (text drawn past its edge is lost for good)
  let ax = (x.x ?? 0.5) * W;
  const mX = Math.max(base * 0.4, W * 0.04);
  {
    const wMax = Math.max(...rows.map(widthOf));
    const left = align === 'left' ? ax : align === 'right' ? ax - wMax : ax - wMax / 2;
    if (left < mX) ax += mX - left;
    else if (left + wMax > W - mX) ax -= left + wMax - (W - mX);
  }
  // slow drift while the line is up, then blur away
  const life = 1 + 0.035 * Math.min(1, lt / Math.max(0.3, x.dur));
  // (the line only fades once its last word has been up a moment)
  const lastT = Math.max(0, ...words.map((w) => w.t));
  // (a subtitle goes in a plain five-frame fade: a blur on the way out smears it, and its dark edge
  // outlives the letters)
  const outT = x.subtitle ? Math.min(5 / 24, Math.max(0.05, x.dur * 0.25)) : Math.max(0.05, Math.min(0.3, x.dur * 0.25, x.dur - lastT - 0.2)), out = lt > x.dur - outT ? 1 - Math.max(0, (x.dur - lt) / outT) : 0;
  let pulse = 0;
  for (const bt of x.beats || []) { const d = lt - bt; if (d >= 0 && d < 0.2) pulse = Math.max(pulse, 1 - d / 0.2); }
  for (const ctx of [g, bg]) { ctx.translate(ax, cy); ctx.scale(life, life); ctx.translate(-ax, -cy); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; }
  // (a subtitle line sits on a soft dark bed, a feathered band no wider than the words, so it reads on
  // a bright sky as well as a night scene)
  if (x.subtitle) {
    const shownAll = words.filter((w) => lt >= w.t);
    if (shownAll.length) {
      const wMax = Math.min(W, Math.max(...rows.map((r) => widthOf(x.karaoke ? r : r.filter((w) => lt >= w.t)))) + base * 2.4), hB = blockH + base * 1.2;
      g.save();
      g.globalAlpha = 0.24 * (1 - out) * Math.min(1, lt / 0.15);
      const gr = g.createRadialGradient(ax, cy, 0, ax, cy, wMax / 2);
      gr.addColorStop(0, 'rgba(6,8,14,0.85)'); gr.addColorStop(0.65, 'rgba(6,8,14,0.55)'); gr.addColorStop(1, 'rgba(6,8,14,0)');
      g.translate(ax, cy); g.scale(1, hB / wMax); g.translate(-ax, -cy);
      g.fillStyle = gr; g.fillRect(ax - wMax / 2, cy - wMax / 2, wMax, wMax);
      g.restore();
    }
  }
  let y = cy - blockH / 2;
  rows.forEach((row, ri) => {
    const baseline = y + rowH[ri] * 0.8;
    y += rowH[ri] + rowGap;
    // (karaoke: the whole line is up from the start, each word dim until it's sung, so a viewer
    // reading a second language can read ahead while the words still land on their syllables)
    const lit = row.filter((w) => lt >= w.t);
    const shown = x.karaoke ? row : lit;
    if (!shown.length || (x.karaoke && lt < 0)) return;
    const landed = lit.length ? lt - lit[lit.length - 1].t : 1;
    const shake = enter === 'slam' && landed < 0.25 ? base * 0.035 * (1 - landed / 0.25) : 0;
    const jx = Math.sin(landed * 90) * shake, jy = Math.cos(landed * 70) * shake * 0.6;
    // the row glides as each new word lands, so it stays anchored without jumping
    // (a row's first word appears in place, its scale-in the entrance: gliding it by a width that
    // grows from nothing would push a big key word past its anchor, off the frame, for a moment)
    const k = Math.min(1, landed / 0.2);
    const wPrev = widthOf(shown.slice(0, -1)), full = widthOf(shown), lw = x.karaoke || !wPrev ? full : wPrev + (full - wPrev) * (1 - Math.pow(1 - k, 3));
    let px = align === 'left' ? ax : align === 'right' ? ax - lw : ax - lw / 2;
    px = Math.min(Math.max(px, mX), Math.max(mX, W - mX - full));
    {
      const sx = (v) => ax + (v - ax) * life, sy = (v) => cy + (v - cy) * life, rh = rowH[ri];
      this.grow(sx(px - base * 0.15), sy(baseline - rh * 0.85), sx(px + lw + base * 0.15), sy(baseline + rh * 0.3));
    }
    for (const w of shown) {
      const dim = x.karaoke && lt < w.t;
      const age = dim ? 1 : lt - w.t;
      const hot = w.hot && x.accent;
      let p, sc, blur = 0, rise = 0;
      // every word is fully up 0.05 s after it starts entering, which is the moment it's sung (it
      // enters that early); the motion of each look settles after, on a word you can already read
      p = Math.min(1, age / 0.05);
      // (stacked: the XP2 flash-in, a white hollow outline a third bigger for one frame, nothing for
      // the next, then the solid word, on the syllable since words enter 0.05 s early)
      const flashIn = look.tight && x.flashIn !== false ? (age < 1 / 30 ? 'outline' : age < 0.05 ? 'gap' : null) : null;
      if (flashIn === 'gap') { px += w.wd + w.gap; continue; }
      if (look.tight) sc = flashIn ? 1.3 : 1;
      else if (enter === 'slam') sc = 1.8 - 0.8 * easeOut(Math.min(1, age / 0.1));
      else if (enter === 'pop') sc = 0.5 + 0.5 * easeOutBack(Math.min(1, age / 0.2));
      else { const q = Math.min(1, age / 0.16); sc = hot ? 0.8 + 0.2 * easeOutBack(Math.min(1, age / 0.28)) : 1; blur = (1 - Math.min(1, age / 0.09)) * base * 0.1; rise = (1 - easeOut(q)) * base * 0.22; }
      if (hot && !look.tight) sc *= 1 + 0.06 * pulse;
      // (a word slamming in big never grows past the frame's edge)
      { const cw = px + w.wd / 2, room = (2 * Math.min(cw - mX / 2, W - mX / 2 - cw)) / Math.max(1, w.wd); if (sc > 1 && sc > room) sc = Math.max(1, room); }
      if (!x.subtitle) { blur += out * base * 0.18; rise -= out * base * 0.35; }
      // the key word of a depth line goes behind the character
      const behind = hot && x.depth && (x.depthSpans ? x.depthSpans.some(([a, b]) => lt >= a && lt < b) : lt < (x.depthUntil ?? Infinity));
      const gw = behind ? bg : g;
      if (gw === bg) this.backUsed = true;
      gw.save();
      // (`flicker`: the held key word flips between italic and upright, a touch bigger and smaller,
      // every 2-3 frames, the romance edit's held-note device)
      const flick = hot && x.flicker && age > 0.12 ? Math.floor((lt * 24) / 2.5) % 2 : 0;
      setFont(flick ? { ...w.sp, italic: !w.sp.italic } : w.sp, w.px, gw);
      if (flick) sc *= 1.12;
      // (tracking in: the letters start spread out and blurred and close up within 3 frames)
      let wdNow = w.wd;
      if (look.track && age < 0.12) {
        const q = easeOut(Math.min(1, age / 0.12)), extra = 0.45 * (1 - q);
        if ('letterSpacing' in gw) { gw.letterSpacing = `${Math.round(w.px * ((w.sp.spacing || 0) + extra))}px`; wdNow = gw.measureText(w.s).width; }
        blur += (1 - q) * base * 0.08;
      }
      // (an older subtitle line, moved up a row, steps back a little so the new one leads, still easy
      // to read again: 75%)
      const older = x.moveAt != null && lt > x.moveAt ? 1 - 0.25 * Math.min(1, (lt - x.moveAt) / 0.22) : 1;
      gw.globalAlpha = (1 - out) * p * (st.alpha ?? 1) * (dim ? 0.34 : 1) * older;
      if (blur > 0.05 && 'filter' in g) gw.filter = `blur(${blur.toFixed(1)}px)`;
      gw.translate(px + w.wd / 2 + jx, baseline + rise + jy);
      gw.scale(sc, sc);
      if (hot && enter === 'slam' && age < 0.3) {
        // chromatic split on the key word as it hits, settling in 0.3 s
        const d = base * 0.07 * (1 - age / 0.3), a0 = gw.globalAlpha;
        gw.globalAlpha = a0 * 0.7 * (1 - age / 0.3);
        gw.fillStyle = '#00e5ff'; gw.fillText(w.s, -w.wd / 2 - d, 0);
        gw.fillStyle = '#ff2d55'; gw.fillText(w.s, -w.wd / 2 + d, 0);
        gw.globalAlpha = a0;
      }
      if (w.sp.neon) {
        // neon tube: a wide halo and a tight glow in the word's colour, a pale hot core, then the tube line
        const col = (x.neon && x.neon[w.idx % x.neon.length]) || x.accent || '#ff3b30';
        gw.globalAlpha *= neonFlicker(age) * (0.94 + 0.06 * Math.sin(lt * 37 + w.wd));
        // a soft dark bed under the tube keeps it readable where the footage behind is bright
        const a1 = gw.globalAlpha;
        gw.globalAlpha = a1 * 0.5; gw.shadowColor = 'rgba(0,0,0,0.9)'; gw.shadowBlur = w.px * 0.45;
        gw.fillStyle = '#000'; gw.fillText(w.s, -w.wd / 2, 0);
        gw.globalAlpha = a1;
        gw.shadowColor = col; gw.shadowBlur = w.px * (0.7 + 0.3 * pulse);
        gw.fillStyle = col; gw.fillText(w.s, -w.wd / 2, 0);
        gw.shadowBlur = w.px * 0.25; gw.fillText(w.s, -w.wd / 2, 0);
        gw.shadowBlur = w.px * 0.08; gw.shadowColor = '#ffffff';
        gw.fillStyle = mixHex(col, '#ffffff', 0.72); gw.fillText(w.s, -w.wd / 2, 0);
        gw.shadowBlur = 0; gw.lineWidth = Math.max(1, w.px * 0.035); gw.strokeStyle = col; gw.strokeText(w.s, -w.wd / 2, 0);
      } else if (w.sp.extrude && flashIn === 'outline') {
        // the flash-in frame: a glowing white hollow outline, nudged up and outwards
        gw.translate((x.persp || 0) >= 0 ? -w.px * 0.06 : w.px * 0.06, -w.px * 0.08);
        gw.lineJoin = 'round'; gw.lineWidth = Math.max(1.5, w.px * 0.03); gw.strokeStyle = '#ffffff';
        gw.shadowColor = 'rgba(255,255,255,0.9)'; gw.shadowBlur = w.px * 0.15;
        gw.strokeText(w.s, -w.wd / 2, 0);
      } else if (w.sp.extrude) {
        // extruded: a shade of the word's own colour stepped towards the plane's far side gives it a
        // thickness (about 3% of its height), a soft glow lifts it, then the face
        const col = w.col || (hot ? x.accent : x.color || '#ffffff'), a1 = gw.globalAlpha, side = (x.persp || 0) < 0 ? -1 : 1, dpx = w.px * 0.035;
        gw.fillStyle = mixHex(col, '#000000', 0.62);
        for (let k2 = 1; k2 <= 4; k2++) gw.fillText(w.s, -w.wd / 2 + (side * dpx * k2) / 4, (dpx * 0.7 * k2) / 4);
        gw.shadowColor = 'rgba(0,0,0,0.5)'; gw.shadowBlur = w.px * 0.16; gw.shadowOffsetX = side * dpx; gw.shadowOffsetY = dpx;
        gw.fillText(w.s, -w.wd / 2 + side * dpx, dpx * 0.7);
        gw.shadowOffsetX = 0; gw.shadowOffsetY = 0;
        gw.globalAlpha = a1 * 0.5; gw.shadowColor = w.col ? x.glow && hot ? x.glow : col : 'rgba(255,255,255,0.85)'; gw.shadowBlur = w.px * 0.3;
        gw.fillStyle = col; gw.fillText(w.s, -w.wd / 2, 0);
        gw.globalAlpha = a1; gw.shadowBlur = 0;
        gw.fillStyle = col; gw.fillText(w.s, -w.wd / 2, 0);
      } else if (w.sp.outline) {
        const col = w.col || x.accent || '#ff6a3d';
        gw.fillStyle = 'rgba(10,8,14,0.42)'; gw.fillText(w.s, -wdNow / 2, 0);
        gw.lineJoin = 'round'; gw.lineWidth = Math.max(1.5, w.px * 0.05); gw.strokeStyle = col;
        gw.shadowColor = col; gw.shadowBlur = w.px * 0.25; gw.strokeText(w.s, -wdNow / 2, 0);
        gw.shadowBlur = 0; gw.strokeText(w.s, -wdNow / 2, 0);
      } else if (w.sp.hard) {
        // a hard shadow, no blur, about 7% of the word's height down and right, then the face
        const col = hot ? x.accent : x.color || '#ffffff', d = w.px * 0.07;
        gw.fillStyle = 'rgba(19,11,7,0.92)'; gw.fillText(w.s, -wdNow / 2 + d, d);
        gw.fillStyle = col; gw.fillText(w.s, -wdNow / 2, 0);
      } else {
      // a soft dark halo under every word keeps light text readable over bright footage
      gw.shadowColor = 'rgba(0,0,0,0.8)';
      gw.shadowBlur = w.px * 0.25;
      gw.shadowOffsetY = w.px * 0.03;
      gw.lineJoin = 'round';
      // (a subtitle: a tight dark outline and a short shadow, so it reads on a pale shot too without
      // a grey pad around it)
      if (x.subtitle) { gw.shadowBlur = w.px * 0.12; gw.shadowColor = 'rgba(0,0,0,0.7)'; }
      gw.lineWidth = Math.max(1.5, w.px * (st.stroke && !x.look ? st.strokeW : x.voice ? 0.09 : x.subtitle ? 0.085 : 0.06));
      gw.strokeStyle = st.stroke && !x.look ? x.strokeColor || st.stroke : x.voice ? 'rgba(4,6,16,0.85)' : x.subtitle ? 'rgba(6,8,14,0.78)' : 'rgba(12,8,4,0.45)';
      gw.strokeText(w.s, -wdNow / 2, 0);
      gw.fillStyle = hot ? x.accent : x.color || '#ffffff';
      gw.fillText(w.s, -wdNow / 2, 0);
      if (hot) { gw.shadowColor = x.glow || x.accent; gw.shadowBlur = w.px * (0.3 + 0.25 * pulse); gw.shadowOffsetY = 0; gw.fillText(w.s, -wdNow / 2, 0); }
      }
      gw.restore();
      px += w.wd + w.gap;
    }
  });
  bg.restore();
  g.restore();
};

// A line on a plane turned in depth, the way the XP2 edits set their phrases: drawn flat into
// scratch layers, then laid onto the picture column by column in perspective. `persp` (-1..1) turns
// it about its near edge: positive recedes to the right (a line on the left, its far side towards
// the middle of the frame), negative to the left; at 1 the far side stands at 76% of the near side's
// height, its top edge level (`pin`). `roll` (degrees) tips the whole plane. The key word behind a character turns with it.
TextLayer.prototype.drawTurned = function (x, lt, st) {
  const W = this.canvas.width, H = this.canvas.height;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  if (!this.flatF || this.flatF.width !== W || this.flatF.height !== H) { this.flatF = mk(); this.flatB = mk(); }
  const fctx = this.flatF.getContext('2d'), bctx = this.flatB.getContext('2d');
  fctx.clearRect(0, 0, W, H); bctx.clearRect(0, 0, W, H);
  const box0 = this.box, back0 = this.backUsed;
  this.box = null; this.backUsed = false;
  this.flat = { ctx: fctx, bctx };
  try { this.drawBuild(x, lt, st); } finally { this.flat = null; }
  const b = this.box, usedBack = this.backUsed;
  this.box = box0; this.backUsed = back0 || usedBack;
  if (!b) return;
  // (padded for the glow and the extrusion)
  const pad = Math.round((x.size || 0.08) * W * 0.5);
  const x0 = Math.max(0, Math.floor(b[0] - pad)), x1 = Math.min(W, Math.ceil(b[2] + pad)), y0 = Math.max(0, Math.floor(b[1] - pad)), y1 = Math.min(H, Math.ceil(b[3] + pad));
  const wB = x1 - x0, hB = y1 - y0;
  if (wB < 4 || hB < 4) return;
  // (measured on the XP2 blocks: the far end 0.75-0.9x the near end, one edge staying level, `pin`:
  // "top" (default), "bottom" or "center")
  const amt = Math.max(-1, Math.min(1, Number(x.persp) || 0)), right = amt >= 0, kf = 1 - 0.24 * Math.abs(amt), c = 1 / kf - 1;
  const pivot = right ? x0 : x1, cyB = x.pin === 'bottom' ? y1 : x.pin === 'center' ? (y0 + y1) / 2 : y0, k = (d) => 1 / (1 + c * d), xs = (d) => wB * d * k(d);
  const roll = ((Number(x.roll) || 0) * Math.PI) / 180;
  const lay = (src, dst) => {
    dst.save();
    dst.translate(pivot, cyB); dst.rotate(roll); dst.translate(-pivot, -cyB);
    const step = 2;
    for (let sx = x0; sx < x1; sx += step) {
      const sw = Math.min(step, x1 - sx);
      const d0 = right ? (sx - x0) / wB : (x1 - (sx + sw)) / wB, d1 = d0 + sw / wB, kk = k((d0 + d1) / 2);
      const a = xs(d0), e = xs(d1);
      const dx = right ? pivot + a : pivot - e, dw = Math.max(0.5, e - a) + 0.6;
      dst.drawImage(src, sx, y0, sw, hB, dx, cyB + (y0 - cyB) * kk, dw, hB * kk);
    }
    dst.restore();
  };
  lay(this.flatF, this.ctx);
  if (usedBack) lay(this.flatB, this.bctx);
  // where the words landed (their own box, not the glow's padding: the near edge full height, the
  // far edge shrunk, turned by the roll)
  const map = (px, py) => { const d = right ? (px - x0) / wB : (x1 - px) / wB, kk = k(d); return [right ? pivot + xs(d) : pivot - xs(d), cyB + (py - cyB) * kk]; };
  const pts = [map(b[0], b[1]), map(b[0], b[3]), map(b[2], b[1]), map(b[2], b[3])];
  const rp = pts.map(([px, py]) => [pivot + (px - pivot) * Math.cos(roll) - (py - cyB) * Math.sin(roll), cyB + (px - pivot) * Math.sin(roll) + (py - cyB) * Math.cos(roll)]);
  this.grow(Math.min(...rp.map((q) => q[0])), Math.min(...rp.map((q) => q[1])), Math.max(...rp.map((q) => q[0])), Math.max(...rp.map((q) => q[1])));
};

// One letter in gold, at (px, 0) in the context's own transform, drawn like the word's other
// letters (the same thin dark outline, a fill light at the top and deep at the foot) so the word
// stays one family, set apart by its metal: champagne to deep gold, a faint highlight just inside
// its top edge, and one soft shine passing over it once it has landed.
function paintGold(c, ch, px, size, capK, lt) {
  const top = -size * capK, w = c.measureText(ch).width;
  c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.lineJoin = 'round';
  const gr = c.createLinearGradient(0, top, 0, 0);
  [[0, '#fff6dc'], [0.3, '#f3d58a'], [0.62, '#d9a845'], [1, '#8f6219']].forEach(([o, col]) => gr.addColorStop(o, col));
  c.save();
  c.fillStyle = gr; c.fillText(ch, px, 0);
  // (inside the letter only: what's drawn from here lands on its fill)
  c.globalCompositeOperation = 'source-atop';
  c.lineWidth = size * 0.03; c.strokeStyle = 'rgba(255,250,232,0.45)'; c.strokeText(ch, px, -size * 0.012);
  const p = (lt - 0.2) / 0.5;
  if (p > 0 && p < 1) {
    const sx = px - w * 0.6 + p * w * 2.2, sh = c.createLinearGradient(sx, top, sx + w * 0.45, 0);
    sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, 'rgba(255,255,255,0.5)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = sh; c.fillRect(px - w, top - size * 0.2, w * 3, size * capK + size * 0.4);
  }
  // (and behind it, the outline every letter of the word has)
  c.globalCompositeOperation = 'destination-over';
  c.lineWidth = Math.max(2, size * 0.045); c.strokeStyle = 'rgba(0,0,0,0.7)'; c.strokeText(ch, px, 0);
  c.restore();
}

function wrap(g, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (g.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// The unit square onto a four-cornered shape in perspective (Heckbert's square-to-quad map), corners
// in the order top-left, top-right, bottom-right, bottom-left.
function squareToQuad(Q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = Q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) { const den = dx1 * dy2 - dx2 * dy1 || 1e-9; g = (dx3 * dy2 - dx2 * dy3) / den; h = (dx1 * dy3 - dx3 * dy1) / den; }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3;
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w]; };
}

// A flat sheet laid onto a quad in perspective: an nx x ny mesh of triangles, each clipped (a hair
// wide, so no seams show) and drawn through the affine map of its three corners.
function warpQuad(ctx, img, FW, FH, Q, nx, ny) {
  const P = squareToQuad(Q);
  const tri = (s0, s1, s2, d0, d1, d2) => {
    const [x0, y0] = s0, [x1, y1] = s1, [x2, y2] = s2, [u0, v0] = d0, [u1, v1] = d1, [u2, v2] = d2;
    const den = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
    if (Math.abs(den) < 1e-9) return;
    const a = (u0 * (y1 - y2) + u1 * (y2 - y0) + u2 * (y0 - y1)) / den, c = (u0 * (x2 - x1) + u1 * (x0 - x2) + u2 * (x1 - x0)) / den;
    const e = (u0 * (x1 * y2 - x2 * y1) + u1 * (x2 * y0 - x0 * y2) + u2 * (x0 * y1 - x1 * y0)) / den;
    const b = (v0 * (y1 - y2) + v1 * (y2 - y0) + v2 * (y0 - y1)) / den, d = (v0 * (x2 - x1) + v1 * (x0 - x2) + v2 * (x1 - x0)) / den;
    const f = (v0 * (x1 * y2 - x2 * y1) + v1 * (x2 * y0 - x0 * y2) + v2 * (x0 * y1 - x1 * y0)) / den;
    const mx = (u0 + u1 + u2) / 3, my = (v0 + v1 + v2) / 3, grow = (px, py) => { const l = Math.hypot(px - mx, py - my) || 1; return [px + ((px - mx) / l) * 0.7, py + ((py - my) / l) * 0.7]; };
    ctx.save();
    ctx.beginPath(); ctx.moveTo(...grow(u0, v0)); ctx.lineTo(...grow(u1, v1)); ctx.lineTo(...grow(u2, v2)); ctx.closePath(); ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const u0 = i / nx, u1 = (i + 1) / nx, v0 = j / ny, v1 = (j + 1) / ny;
    const S = [[u0 * FW, v0 * FH], [u1 * FW, v0 * FH], [u1 * FW, v1 * FH], [u0 * FW, v1 * FH]], D = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
    tri(S[0], S[1], S[2], D[0], D[1], D[2]);
    tri(S[0], S[2], S[3], D[0], D[2], D[3]);
  }
}
