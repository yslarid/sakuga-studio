// Project model, clip time-remapping and undo history.

export const uid = (p = 'x') => p + '_' + Math.random().toString(36).slice(2, 9);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);

export const FORMATS = {
  orig: { w: 1920, h: 1080, label: 'Original · match the footage' },
  '9:16': { w: 1080, h: 1920, label: '9:16 · TikTok / Reels' },
  '4:5': { w: 1080, h: 1350, label: '4:5 · Instagram feed' },
  '1:1': { w: 1080, h: 1080, label: '1:1 · Square' },
  '16:9': { w: 1920, h: 1080, label: '16:9 · YouTube' },
};

export const LOOK_DEFAULT = {
  preset: 'none',
  exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, fade: 0,
  shadows: [0, 0, 0], highlights: [0, 0, 0], duo: [1, 0.45, 0.1], duoAmt: 0,
  glow: 0, glowThreshold: 0.62, vignette: 0, grain: 0, chroma: 0,
  sharpen: 0, motionBlur: 0, vhs: 0, leaks: 0,
  camBlur: 1, // motion blur on the editor's own camera moves (180° shutter)
  depth: 0, clarity: 0, rich: 0, // cinematic finish: darker midtones, local contrast, richer colour
  level: 0, // shot leveling: very dark or bright clips nudged toward the edit's typical shot
  vibrance: 0, fxGlow: 0, // FX boost
};

// How each clip sits in the output frame (viral edits use all four).
export const LAYOUTS = {
  fill: 'Fill (crop)',
  'framed-1:1': 'Framed 1:1',
  'framed-4:5': 'Framed 4:5',
  'framed-16:9': 'Framed 16:9',
  blur: 'Blur background',
  rotate: 'Rotate 90°',
};

export function createProject() {
  return {
    format: 'orig', // keep the footage's own shape: cropping 16:9 to 9:16 hides two thirds of every frame
    media: [],
    music: null, // { mediaId, offset, volume, fadeIn, fadeOut }
    clips: [],
    effects: [],
    texts: [],
    sfx: [], // { id, sound, start, vol, src }
    look: structuredClone(LOOK_DEFAULT),
    layout: 'fill',
    auto: { applied: [], saved: {} },
    watermark: null, // { src, opacity, size, corner }
  };
}

// Where the picture sits in the output (letterbox bands found by the footage scan).
export function pictureBox(p) {
  const c = p.clips[0], m = c && getMedia(p, c.mediaId);
  const { w, h } = formatSize(p);
  if (!m || !m.analysis || !m.analysis.box || !m.w || Math.abs(m.w / m.h - w / h) > 0.02 || (p.layout && p.layout !== 'fill')) return { top: 0, bottom: 1 };
  const { top, bottom } = m.analysis.box;
  return bottom - top > 0.2 ? { top, bottom } : { top: 0, bottom: 1 };
}

export function formatSize(p) {
  if (p.format !== 'orig') return FORMATS[p.format] || FORMATS['9:16'];
  const v = p.media.find((m) => m.kind === 'video' && m.w);
  if (!v) return { w: 1080, h: 1920, label: 'Original · match the footage' };
  const a = v.w / v.h;
  const even = (x) => Math.round(x / 2) * 2;
  const w = a >= 1 ? Math.min(2560, even(1080 * a)) : 1080, h = a >= 1 ? 1080 : Math.min(2560, even(1080 / a));
  return { w, h, label: `Original · ${w}×${h}` };
}
export const getMedia = (p, id) => p.media.find((m) => m.id === id);

// ---------- speed curves ----------
// clip.speedKeys: [[u, speed], ...] with u in 0..1 across the clip, smoothstep between keys.
const LUT_N = 96;
const lutCache = new WeakMap();

export function speedFromKeys(keys, u) {
  if (!keys || !keys.length) return 1;
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i][0]) {
      const [u0, s0] = keys[i - 1], [u1, s1] = keys[i];
      const f = u1 > u0 ? (u - u0) / (u1 - u0) : 1;
      return s0 + (s1 - s0) * smooth(f);
    }
  }
  return keys[keys.length - 1][1];
}

function lutFor(keys) {
  const arr = new Float32Array(LUT_N + 1);
  let acc = 0;
  for (let i = 1; i <= LUT_N; i++) {
    acc += speedFromKeys(keys, (i - 0.5) / LUT_N) / LUT_N;
    arr[i] = acc;
  }
  return arr;
}

function lut(clip) {
  const sig = clip.speedKeys ? JSON.stringify(clip.speedKeys) : '1';
  const c = lutCache.get(clip);
  if (c && c.sig === sig) return c.arr;
  const arr = lutFor(clip.speedKeys);
  lutCache.set(clip, { sig, arr });
  return arr;
}

export const avgSpeedOfKeys = (keys) => lutFor(keys)[LUT_N];
export const avgSpeed = (clip) => lut(clip)[LUT_N];
export const clipSpan = (clip) => clip.dur * avgSpeed(clip);
export const speedAt = (clip, local) => speedFromKeys(clip.speedKeys, clamp(local / clip.dur, 0, 1));

export function srcTimeAt(clip, local) {
  const a = lut(clip);
  const u = clamp(local / clip.dur, 0, 1) * LUT_N;
  const i = Math.min(LUT_N - 1, Math.floor(u));
  const f = u - i;
  return clip.srcIn + (a[i] + (a[i + 1] - a[i]) * f) * clip.dur;
}

// ---------- timeline helpers ----------
export function clipIndexAt(clips, t) {
  let lo = 0, hi = clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, c = clips[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.start + c.dur) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export const timelineDuration = (p) => p.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);

export function relayout(clips) {
  let t = 0;
  for (const c of clips) { c.start = t; t += c.dur; }
}

// Beats/drops/sections of the soundtrack, shifted into timeline time.
export function timelineMusic(p) {
  const m = p.music && getMedia(p, p.music.mediaId);
  const A = m && m.audio && m.audio.analysis;
  if (!A) return null;
  const off = p.music.offset, dur = timelineDuration(p) || A.duration - off;
  const inRange = (t) => t >= -0.001 && t <= dur + 0.001;
  const beats = [], downbeats = [];
  A.beats.forEach((b, i) => {
    const t = b - off;
    if (!inRange(t)) return;
    beats.push(t);
    if ((i - A.downPhase) % 4 === 0) downbeats.push(t);
  });
  return {
    A, off, dur, beats, downbeats,
    drops: A.drops.map((d) => d.t - off).filter(inRange),
    sections: A.sections
      .map((s) => ({ start: Math.max(0, s.start - off), end: Math.min(dur, s.end - off), level: s.level }))
      .filter((s) => s.end > s.start),
  };
}

// ---------- history ----------
const SNAP_KEYS = ['format', 'layout', 'music', 'clips', 'effects', 'texts', 'sfx', 'look', 'auto', 'loop', 'voice'];

export class History {
  constructor(getProject, onRestore) {
    this.get = getProject;
    this.onRestore = onRestore;
    this.undoStack = [];
    this.redoStack = [];
  }
  snap() {
    const p = this.get(), o = {};
    for (const k of SNAP_KEYS) o[k] = p[k];
    return JSON.stringify(o);
  }
  restore(s) {
    const p = this.get(), o = JSON.parse(s);
    for (const k of SNAP_KEYS) p[k] = o[k];
    this.onRestore();
  }
  push() {
    this.undoStack.push(this.snap());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snap());
    this.restore(this.undoStack.pop());
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.snap());
    this.restore(this.redoStack.pop());
    return true;
  }
}

export function fmtTime(t, frac = true) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return frac ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}
