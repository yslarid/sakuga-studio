// Cover images ("title images") for an edit: its strongest frame, graded like the edit and
// recomposed for the cover's shape around the character, with a big title set behind the
// character (the text-behind-subject thumbnail look), a vignette so the type reads, and the
// watermark. Always full-bleed portrait 9:16, the Reels and TikTok cover shape.
import { frameParams, Renderer } from '../render/renderer.js';
import { openFrameSource } from './frame-reader.js';
import { maskAt, segmentImage } from '../analysis/segment.js';
import { detectFaces, facesAt } from '../analysis/faces.js';
import { loadMarkImage } from '../watermark.js';
import { timelineDuration } from '../state.js';
import { fontStack } from '../render/text.js';

// moments that make a poor cover: flashes, blackouts, transitions and other in-between frames
const BUSY = new Set(['flash', 'sweep', 'blackout', 'fadechain', 'impact', 'strobe', 'expstrobe', 'fadein', 'fadeout', 'preview', 'invert', 'glitch', 'echo', 'zoomblur', 'whip', 'spin', 'defocus', 'smash', 'mute']);

// The line the edit leans on, as a title: a caption whose key word slips behind a character, or
// else the one with the longest key word; trimmed to the key word and its neighbours if long.
export function coverTitle(project, drop) { return coverWords(project, null, drop).text; }

// The title as words, with the one to make huge (the caption's own key word when it has one).
function coverWords(project, custom, drop) {
  if (custom && custom.trim()) {
    const ws = custom.trim().toUpperCase().split(/\s+/);
    const hero = ws.reduce((a, b, i) => (b.length > ws[a].length ? i : a), 0);
    return { words: ws, hero, text: ws.join(' ') };
  }
  const lines = (project.texts || []).filter((x) => x.words && x.words.length);
  if (!lines.length) {
    const t = coverTitleText(project);
    return { words: t.split(/\s+/), hero: 0, text: t };
  }
  const hotOf = (x) => x.words.find((w) => w.hot) || x.words[0];
  // the song's own title (from its file or tempo-guide name): a line that sings it is the hook
  const mm = project.music && project.media.find((m) => m.id === project.music.mediaId);
  const songWords = ((mm && (mm.guide ? mm.guide.title : mm.name)) || '').replace(/\.[^.]+$/, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const clean = (w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // a line sings the title when it has the title's own word (its longest, "october" not "love")
  // or most of its words: one common word in common isn't the hook
  const key = songWords.reduce((a, b) => (b.length > a.length ? b : a), '');
  const sings = (x) => {
    const ws = x.words.map(clean);
    return songWords.length > 0 && (ws.includes(key) || songWords.filter((w) => ws.includes(w)).length >= Math.max(2, Math.ceil(songWords.length * 0.6)));
  };
  // the snippet doesn't sing the title (a verse, not the chorus): the title itself, when the song's
  // name reads like one (a few plain words, not a recording's file name), beats a stray fragment
  const title = ((mm && (mm.guide ? mm.guide.title : mm.name)) || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const tw = title.split(/\s+/).filter(Boolean);
  if (!lines.some(sings) && (tw.length >= 2 || title.length >= 4) && tw.length <= 7 && /^[\p{L}' ]+$/u.test(title)) {
    const ws = tw.map((w) => w.toUpperCase());
    return { words: ws, hero: ws.reduce((a, b, i) => (b.length > ws[a].length ? i : a), 0), text: ws.join(' ') };
  }
  // the hook: a line with the song's title, else the one on screen when the drop hits, else one
  // whose key word goes behind a character
  const atDrop = (x) => (drop == null ? 0 : drop >= x.start - 0.3 && drop < x.start + x.dur ? 4 : Math.max(0, 2 - Math.abs(x.start - drop)));
  const best = lines.reduce((a, b) => {
    const sc = (x) => (sings(x) ? 6 : 0) + atDrop(x) + (x.depth ? 2 : 0) + hotOf(x).text.length * 0.25 + Math.min(x.words.length, 4) * 0.1;
    return sc(b) > sc(a) ? b : a;
  });
  // punctuation-only tokens drop out, and the key word is found among the words that stay
  const kept = best.words.filter((w) => w.text.replace(/[.,!?;:"“”()…\-]+/g, ''));
  let ws = kept.map((w) => w.text.replace(/[.,!?;:"“”()…]+/g, '').toUpperCase());
  if (!ws.length) { const t = coverTitleText(project); return { words: t.split(/\s+/), hero: 0, text: t }; }
  let hero = kept.indexOf(sings(best) ? kept.find((w) => clean(w) === key) || kept.find((w) => songWords.includes(clean(w))) : hotOf(best));
  if (ws.length > 4) { const a = Math.max(0, hero - 1); ws = ws.slice(a, hero + 2); hero -= a; }
  // a title never trails off on a little word ("THE FEELING IS"): it ends where the phrase does
  const LITTLE = /^(IS|ARE|WAS|THE|A|AN|OF|TO|AND|OR|BUT|IN|ON|AT|FOR|WITH|MY|YOUR|I|I'M|IT'S)$/;
  while (ws.length > 1 && hero < ws.length - 1 && LITTLE.test(ws[ws.length - 1])) ws.pop();
  while (ws.length > 1 && hero > 0 && LITTLE.test(ws[0]) && !/^(THE|MY|YOUR|A)$/.test(ws[0])) { ws.shift(); hero--; }
  return { words: ws, hero: Math.max(0, Math.min(ws.length - 1, hero)), text: ws.join(' ') };
}

function coverTitleText(project) {
  const lines = (project.texts || []).filter((x) => x.words && x.words.length);
  if (!lines.length) {
    const m = project.media.find((x) => x.kind === 'video');
    return (m ? m.name : 'EDIT').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').toUpperCase().slice(0, 18);
  }
  const hotOf = (x) => x.words.find((w) => w.hot) || x.words[0];
  const best = lines.reduce((a, b) => {
    const sc = (x) => (x.depth ? 3 : 0) + hotOf(x).text.length * 0.25 + Math.min(x.words.length, 4) * 0.1;
    return sc(b) > sc(a) ? b : a;
  });
  const ws = best.words.map((w) => w.text);
  let t = ws.join(' ');
  if (t.length > 22) { const hi = best.words.indexOf(hotOf(best)); t = ws.slice(Math.max(0, hi - 1), hi + 2).join(' '); }
  return t.replace(/[.,!?;:"“”()]+/g, '').trim().toUpperCase();
}

// Candidate cover moments, best first: a clear character filling a good part of the picture,
// detail and colour, sensible brightness, a crisp (not blurred, mid-flash) frame.
function moments(project) {
  const L = timelineDuration(project), out = [];
  for (let t = 0.35; t < L - 0.35; t += 0.2) {
    if (project.effects.some((e) => BUSY.has(e.type) && t > e.start - 0.12 && t < e.start + e.dur + 0.12)) continue;
    const f = frameParams(project, t, 640, 360);
    const g = f.clip && f.media.analysis && f.media.analysis.grid;
    if (!g) continue;
    const k = Math.max(0, Math.min(g.motion.length - 1, Math.round(f.srcTime * g.rate)));
    const m = maskAt(f.media, f.srcTime);
    let cov = 0;
    if (m) { let n = 0; for (let i = 0; i < m.data.length; i += 7) if (m.data[i] > 127) n++; cov = n / (m.data.length / 7); }
    let s = g.edge[k] * 1.2 + Math.min(0.6, g.sat[k]) * 0.8 - Math.abs(g.lum[k] - 0.42) * 1.4 - g.motion[k] * 0.7;
    // the title goes behind the character, so the character has to be clearly there (and big)
    s += cov >= 0.15 && cov < 0.62 ? 1.6 - Math.abs(cov - 0.35) * 2.5 : cov >= 0.62 ? 0.3 : -3;
    out.push({ t, s, cov, media: f.media, srcTime: f.srcTime, f });
  }
  return out.sort((a, b) => b.s - a.s);
}

// The cover's picture: the chosen frame graded like the edit (its look and finish, without its
// captions, effects or watermark), cropped full-bleed to the cover's portrait shape around the
// face and rendered straight at the cover's size, so the editor's own upscaling and sharpening
// keep it crisp. Footage with black bars baked in is cropped inside them.
async function coverPicture(project, t, W, H, face, fxNote = null) {
  const clean = { ...project, effects: [], texts: [], loop: null, watermark: null };
  const f = frameParams(clean, t, W, H);
  if (!f.clip) return null;
  const m = f.media, b = (m.analysis && m.analysis.box) || { top: 0, bottom: 1 };
  const bandH = b.bottom - b.top > 0.2 && b.bottom - b.top < 0.99 ? b.bottom - b.top : 1, top = bandH < 1 ? b.top : 0;
  const As = m.w / m.h, A = W / H;
  let rh = bandH, rw = (A * rh) / As;
  if (rw > 1) { rw = 1; rh = (rw * As) / A; }
  // (`x` in the cover note: the crop's centre across the source picture, a thing that isn't a face)
  const fx = Number.isFinite(fxNote) ? fxNote : face ? (face[0] + face[2]) / 2 : f.clip.focus ?? 0.5;
  const fy = face ? (face[1] + face[3]) / 2 : top + bandH * 0.45;
  const cx = Math.min(1 - rw / 2, Math.max(rw / 2, fx)), cy = Math.min(top + bandH - rh / 2, Math.max(top + rh / 2, fy));
  const fc = { ...f, center: [cx, cy], region: [rw, rh], win: [0, 0, 1, 1], aspect: A, band: null, srcBox: null, rot90: 0, bgMode: 0, vfx: [], preview: null, textXform: null, loop: null, camPrev: null, glints: null }; // a still: no camera blur (the crop differs from the shot's), no glint
  const gl = document.createElement('canvas');
  const r = new Renderer(gl, { preserve: true });
  r.setSize(W, H);
  const src = await openFrameSource(m, { hd: true });
  try { r.draw(fc, await src.frameAt(f.srcTime, f.clip), null, project.look, t, 0, null); } finally { src.close(); }
  const out = mk(W, H);
  out.getContext('2d').drawImage(gl, 0, 0);
  r.gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { canvas: out, f, toCover: (sx, sy) => [((sx - (cx - rw / 2)) / rw) * W, ((sy - (cy - rh / 2)) / rh) * H] };
}

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); return c; };
const hsl = (h, s, l) => `hsl(${h.toFixed(0)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(0)}%)`;

// The cover: full-bleed portrait.
async function compose(project, pic, W, H, title, subtitle, face) {
  const { f } = pic, portrait = H > W;
  const C = mk(W, H), c = C.getContext('2d');
  c.drawImage(pic.canvas, 0, 0);
  const panel = { sx: 0, sy: 0, sw: W, sh: H, dx: 0, dy: 0, dw: W, dh: H };
  // a vignette and a soft top shade so the title reads
  const vg = c.createRadialGradient(W / 2, H * 0.5, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.hypot(W, H) * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  c.fillStyle = vg; c.fillRect(0, 0, W, H);
  const tg = c.createLinearGradient(0, 0, 0, H * 0.45);
  tg.addColorStop(0, 'rgba(0,0,0,0.42)'); tg.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = tg; c.fillRect(0, 0, W, H * 0.45);
  // the character, cut out at the cover's own resolution (from the shaded picture, so it matches)
  const P = mk(panel.dw, panel.dh);
  P.getContext('2d').drawImage(C, panel.dx, panel.dy, panel.dw, panel.dh, 0, 0, P.width, P.height);
  let matte = null;
  try { const m = await segmentImage(P); if (m.coverage > 0.03) matte = m; } catch (e) { /* title in front */ }
  const fC = face ? [pic.toCover(face[0], face[1]), pic.toCover(face[2], face[3])] : null;
  let mTop = null;
  if (matte) for (let y = 0; y < P.height && mTop == null; y += 4) { let n = 0; for (let x = 0; x < P.width; x += 4) n += matte.alpha[y * P.width + x] > 0.5; if (n / (P.width / 4) > 0.04) mTop = panel.dy + y; }

  // the title as a lockup: the key word huge in condensed caps, the words around it small and
  // spaced above and below (like the edit's own captions)
  const { words, hero } = title;
  const above = words.slice(0, hero).join(' '), below = words.slice(hero + 1).join(' '), heroW = words[hero];
  c.font = `400 100px ${TITLE_FONT}`;
  c.letterSpacing = '1px';
  const hw = c.measureText(heroW).width;
  const full = Math.min((W * (portrait ? 0.86 : 0.7) * 100) / hw, H * (portrait ? 0.16 : 0.3));
  const prefer = fC ? fC[0][1] + (fC[1][1] - fC[0][1]) * 0.3 : mTop != null ? mTop + full * 0.3 : H * (portrait ? 0.3 : 0.35);
  // how much of the key word the character hides, and of its first and last letters
  const overlap = (cx, cy, size) => {
    const tw = (hw * size) / 100, x0 = cx - tw / 2, x1 = cx + tw / 2, y0 = cy - size * 0.38, y1 = cy + size * 0.36, fx = x0 + tw * 0.15, lx = x1 - tw * 0.15;
    let n = 0, k = 0, fn = 0, fk = 0, ln = 0, lk = 0;
    for (let y = y0; y < y1; y += 5) for (let x = x0; x < x1; x += 5) {
      const px = ((x - panel.dx) / panel.dw) * P.width, py = ((y - panel.dy) / panel.dh) * P.height;
      const on = px >= 0 && py >= 0 && px < P.width && py < P.height && matte.alpha[(py | 0) * P.width + (px | 0)] > 0.5;
      n++; k += on;
      if (x < fx) { fn++; fk += on; }
      if (x > lx) { ln++; lk += on; }
    }
    return { ov: n ? k / n : 0, first: fn ? fk / fn : 0, last: ln ? lk / ln : 0 };
  };
  // the spot (and size) where the character covers part of the key word, never most of it, both
  // ends always reading, close to the head; a little smaller if that's the only clean fit. With no
  // such spot the title sits in front, over open background rather than over the characters.
  let size = full, cx = W / 2, cy = Math.min(H * 0.62, Math.max(H * 0.18, prefer)), inFront = !matte, found = false, least = null;
  if (matte) {
    for (const k of [1, 0.82, 0.68]) {
      const sz = full * k, tw = (hw * sz) / 100, sm = Math.max(H * (portrait ? 0.021 : 0.034), sz * 0.17), gp = sz * 0.08;
      // (as high as a tenth of the way down, still inside a 4:5 grid crop: on a big close-up the
      // hair crossing the letters is the classic look)
      // room for the key word's caps (about 0.37 of the font size each side of centre) and the small
      // rows with their air, as they're actually laid out
      const lo = H * 0.1 + sz * 0.37 + (above ? gp * 1.4 + sm * 1.1 : 0), hi = H * 0.66 - sz * 0.37 - (below ? gp * 1.4 + sm * 1.1 : 0);
      const xs = portrait ? [W / 2] : [W / 2, W * 0.34, W * 0.66].filter((x) => x - tw / 2 >= W * 0.04 && x + tw / 2 <= W * 0.96);
      let bestS = Infinity;
      for (const x of xs) for (let y = lo; y <= hi; y += H * 0.01) {
        const o = overlap(x, y, sz);
        if (k === 1 && (!least || o.ov < least.ov)) least = { ov: o.ov, x, y };
        if (o.ov > 0.32 || o.first > 0.25 || o.last > 0.25) continue;
        const sc = Math.abs(o.ov - 0.2) * (o.ov < 0.08 ? 3 : 1) + (Math.abs(y - prefer) / H) * 0.6 + (Math.abs(x - W / 2) / W) * 0.3;
        if (sc < bestS) { bestS = sc; cx = x; cy = y; }
      }
      if (bestS < Infinity) { size = sz; found = true; break; }
    }
    if (!found && least) { cx = least.x; cy = least.y; inFront = true; }
  }
  if (TITLE_Y != null) { cx = W / 2; cy = TITLE_Y * H; size = full; inFront = true; }
  const small = Math.max(H * (portrait ? 0.021 : 0.034), size * 0.17), gap = size * 0.08;
  // the scene's own colour for the glow
  const gr = f.media.analysis && f.media.analysis.grid;
  let accent = '#ffd27a';
  if (gr && gr.hx) { const k = Math.max(0, Math.min(gr.hx.length - 1, Math.round(f.srcTime * gr.rate))), hx = gr.hx[k], hy = gr.hy[k]; if (Math.hypot(hx, hy) > 0.03) accent = hsl(((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360, 0.95, 0.64); }
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `400 ${size}px ${TITLE_FONT}`;
  c.letterSpacing = `${(size * 0.015).toFixed(1)}px`;
  const fill = c.createLinearGradient(0, cy - size / 2, 0, cy + size / 2);
  fill.addColorStop(0, '#ffffff'); fill.addColorStop(0.6, '#ffffff'); fill.addColorStop(1, accent);
  c.save(); c.shadowColor = 'rgba(0,0,0,0.7)'; c.shadowBlur = size * 0.2; c.shadowOffsetY = size * 0.035; c.fillStyle = '#000'; c.fillText(heroW, cx, cy); c.restore();
  c.save(); c.shadowColor = accent; c.shadowBlur = size * 0.32; c.globalAlpha = 0.5; c.fillStyle = accent; c.fillText(heroW, cx, cy); c.restore();
  c.fillStyle = fill; c.fillText(heroW, cx, cy);
  // the small words sit centred, or flush with an end of the key word if centred they'd land on
  // the character
  const smallRow = (txt, y) => {
    c.font = `700 ${small.toFixed(0)}px Inter`;
    c.letterSpacing = `${(small * 0.32).toFixed(1)}px`;
    const rw = c.measureText(txt).width, tw = (hw * size) / 100;
    const onChar = (x) => {
      if (!matte) return 0;
      let n = 0, k = 0;
      for (let yy = y - small * 0.5; yy < y + small * 0.5; yy += 3) for (let xx = x - rw / 2; xx < x + rw / 2; xx += 4) {
        const px = ((xx - panel.dx) / panel.dw) * P.width, py = ((yy - panel.dy) / panel.dh) * P.height;
        n++; k += px >= 0 && py >= 0 && px < P.width && py < P.height && matte.alpha[(py | 0) * P.width + (px | 0)] > 0.5;
      }
      return n ? k / n : 0;
    };
    const opts = [cx, cx - tw / 2 + rw / 2, cx + tw / 2 - rw / 2];
    const x = inFront ? cx : opts.reduce((a, b) => (onChar(b) < onChar(a) - 0.05 ? b : a));
    c.save(); c.shadowColor = 'rgba(0,0,0,0.75)'; c.shadowBlur = small * 0.6; c.fillStyle = 'rgba(255,255,255,0.95)'; c.fillText(txt, x, y); c.restore();
  };
  const blockH = size;
  // the character back on top of the title
  if (matte && !inFront) {
    const M = mk(P.width, P.height), mc = M.getContext('2d');
    mc.drawImage(P, 0, 0);
    const id = mc.getImageData(0, 0, M.width, M.height), d = id.data;
    for (let j = 0; j < matte.alpha.length; j++) { const a = matte.alpha[j]; d[j * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, (a - 0.3) / 0.4))); }
    mc.putImageData(id, 0, 0);
    c.drawImage(M, panel.dx, panel.dy);
  }
  // the small words stay in front of everything, crisp and readable
  // clear of the key word's actual letter tops and bottoms, with a little air
  c.font = `400 ${size}px ${TITLE_FONT}`;
  const mHero = c.measureText(heroW), capTop = cy - mHero.actualBoundingBoxAscent, capBot = cy + mHero.actualBoundingBoxDescent;
  if (above) smallRow(above, capTop - gap * 1.4 - small * 0.55);
  if (below) smallRow(below, capBot + gap * 1.4 + small * 0.55);
  // (how far the title block reaches, for the watermark to keep clear of)
  let blockTop = above ? capTop - gap * 1.4 - small * 1.1 : capTop, blockBot = below ? capBot + gap * 1.4 + small * 1.1 : capBot;
  // a small line under the title (song, anime or your tag)
  if (subtitle) {
    c.font = `700 ${Math.round(H * (portrait ? 0.017 : 0.028))}px Inter`;
    c.letterSpacing = `${Math.round(H * 0.006)}px`;
    c.fillStyle = 'rgba(255,255,255,0.92)';
    c.save(); c.shadowColor = 'rgba(0,0,0,0.7)'; c.shadowBlur = 12;
    const sy = cy + blockH / 2 + (below ? small * 2 + gap : 0) + H * (portrait ? 0.03 : 0.05);
    c.fillText(subtitle.toUpperCase(), cx, sy);
    c.restore();
    blockBot = Math.max(blockBot, sy + H * (portrait ? 0.012 : 0.02));
  }
  // the watermark, bottom right and never on the title: its usual spot (inside the area a 4:5 grid
  // crop keeps) when the title is clear of it, else just under the title, or over it when the
  // title sits too low for that
  const wm = project.watermark;
  if (wm && wm.src) {
    const im = await loadMarkImage(wm.src);
    if (im) {
      const mw = W * (portrait ? 0.2 : 0.12), mh = (mw * im.naturalHeight) / im.naturalWidth, air = H * 0.018;
      let my = H * (portrait ? 0.8 : 0.93) - mh;
      if (my < blockBot + air && my + mh > blockTop - air) my = blockBot + air + mh <= H * 0.96 ? blockBot + air : blockTop - air - mh;
      c.globalAlpha = 0.85;
      c.drawImage(im, W - mw - W * 0.05, my, mw, mh);
      c.globalAlpha = 1;
    }
  }
  return C;
}

// The cover for the edit: { portrait: Blob, title }.
// the title's face: the heavy condensed caps by default, or the edit's serif (`font: "serif"` in the
// cover notes) when the edit is set in one
let TITLE_FONT = fontStack('Anton');
let TITLE_Y = null;
export async function makeCovers(app, { title, subtitle, at, font, y, x, wide = false } = {}) {
  const project = app.project;
  TITLE_FONT = fontStack(font === 'serif' ? 'DM Serif Display' : 'Anton');
  // (`y` in the cover notes: the title's centre as a share of the height, chosen by the director, say
  // over the collar of a close-up where the search would cross the mouth)
  TITLE_Y = Number(y) > 0 && Number(y) < 1 ? Number(y) : null;
  await Promise.all([document.fonts.load(`400 120px ${TITLE_FONT}`), document.fonts.load('700 30px Inter')]);
  let cands = moments(project).slice(0, 24);
  // a moment you (or the director notes) picked: that frame, still framed on its face
  if (at != null) {
    const f = frameParams({ ...project, effects: [], texts: [] }, at, 64, 64);
    if (f.clip) cands = [{ t: at, media: f.media, srcTime: f.srcTime, s: 0 }];
  }
  if (!cands.length) throw new Error('No frame to make a cover from');
  // faces make the best covers: find them for the best few moments and prefer a clear, big one
  try {
    const byMedia = new Map();
    for (const c of cands) { if (!byMedia.has(c.media)) byMedia.set(c.media, []); byMedia.get(c.media).push(c.srcTime); }
    for (const [m, ts] of byMedia) await detectFaces(m, ts);
  } catch (e) { /* faces optional */ }
  // faces are measured against the picture itself (a letterboxed picture is only a band of the frame)
  const band = (m) => { const b = m.analysis && m.analysis.box; return b && b.bottom - b.top > 0.2 ? b.bottom - b.top : 1; };
  for (const c of cands) {
    const r = facesAt(c.media, c.srcTime);
    const b = r && r.kind === 'face' && r.boxes.length ? r.boxes.reduce((a, x) => ((x[3] - x[1]) * x[4] > (a[3] - a[1]) * a[4] ? x : a)) : null;
    // one clear, big face is the strongest cover there is
    if (b) { const h = (b[3] - b[1]) / band(c.media); c.s += 1.2 + Math.min(3, h * 10) - (r.boxes.length > 1 ? 0.5 : 0); c.face = b; c.fh = h; }
  }
  cands.sort((a, b) => b.s - a.s);
  // the title tucks behind the character, so a strong face shot the cut-out can find wins over
  // one it can't (some tinted or backlit scenes); those are used only when there's nothing else
  // checked on the actual cover crop: the first of the best few where the cut-out finds the
  // character, else the best frame with the title in front
  const order = [...cands.filter((c) => c.face && c.fh >= 0.15), ...cands.filter((c) => !(c.face && c.fh >= 0.15))];
  let pick = null, pic = null;
  for (const c of order.slice(0, 5)) {
    // (`wide`: a 16:9 cover for an edit delivered in its own screen mode only)
    const pc = await coverPicture(project, c.t, wide ? 1920 : 1080, wide ? 1080 : 1920, c.face, x != null ? Number(x) : null);
    if (!pc) continue;
    if (!pic) { pick = c; pic = pc; }
    let ok = false;
    try { ok = (await segmentImage(pc.canvas)).coverage > 0.08; } catch (e) { /* no cut-out */ }
    if (ok) { pick = c; pic = pc; break; }
  }
  if (!pic) throw new Error('Could not render the cover frame');
  const plan = app.plan, G = plan && plan.G, d0 = G && G.drops && G.drops.find((d) => d - plan.win.start > 1);
  const t = coverWords(project, title, d0 != null ? d0 - plan.win.start : null);
  const portrait = await new Promise((res, rej) => compose(project, pic, wide ? 1920 : 1080, wide ? 1080 : 1920, t, subtitle, pick.face).then((cv) => cv.toBlob(res, 'image/png'), rej));
  return { portrait, title: t.text, at: pick.t, considered: cands.slice(0, 6).map((c) => ({ t: +c.t.toFixed(2), s: +c.s.toFixed(2), face: c.fh != null ? +c.fh.toFixed(2) : null })) };
}
