// Effect registry, effect evaluation at a point in time, and color looks.
import { clamp } from './state.js';
import { evalCurve } from './curves.js';

const I = (def = 0.7, label = 'Intensity') => ({ min: 0, max: 1, step: 0.05, def, label });
const SEL = (label, options, def = options[0]) => ({ type: 'select', label, options, def });

export const FX = {
  flash: { label: 'Flash', icon: '✦', color: '#f5f5f5', dur: 0.35, params: { intensity: I(0.9), color: { type: 'color', def: '#ffffff', label: 'Color' } } },
  zoom: { label: 'Zoom Punch', icon: '⊕', color: '#ff7a45', dur: 0.4, params: { intensity: I(0.6) } },
  shake: { label: 'Shake', icon: '≋', color: '#ffb020', dur: 0.5, params: { intensity: I(0.6), speed: I(0.6, 'Speed'), style: SEL('Style', ['chaos', 'horizontal', 'vertical', 'rotate', 'stepped']) } },
  twitch: { label: 'Twitch', icon: 'ϟ', color: '#f472b6', dur: 0.3, params: { intensity: I(0.6) } },
  impact: { label: 'Impact Frame', icon: '◼', color: '#ef4444', dur: 0.13, params: { intensity: I(1), mode: SEL('Look', ['mono', 'invert', 'red']) } },
  rgb: { label: 'RGB Split', icon: '◐', color: '#38bdf8', dur: 0.4, params: { intensity: I(0.7) } },
  glitch: { label: 'Glitch', icon: '▤', color: '#22d3ee', dur: 0.3, params: { intensity: I(0.6) } },
  warp: { label: 'Warp', icon: '∿', color: '#2dd4bf', dur: 0.5, params: { intensity: I(0.6), mode: SEL('Shape', ['bulge', 'twirl', 'wave']) } },
  tilt: { label: '3D Tilt', icon: '⧉', color: '#a3e635', dur: 0.5, params: { intensity: I(0.6), axis: SEL('Axis', ['swing', 'tilt', 'both']) } },
  flare: { label: 'Light Burst', icon: '✸', color: '#fbbf24', dur: 0.6, params: { intensity: I(0.7) } },
  energy: { label: 'Energy Burst', icon: '⚡', color: '#f97316', dur: 0.5, params: { intensity: I(0.8) } },
  aura: { label: 'Character Aura', icon: '✺', color: '#fb923c', dur: 0.9, params: { intensity: I(0.8), color: { type: 'color', def: '#ff8a1f', label: 'Color' } } },
  smash: { label: 'Impact Smash', icon: '💢', color: '#ef4444', dur: 0.45, params: { intensity: I(0.8), x: I(0.5, 'Aim X'), y: I(0.5, 'Aim Y'), hold: { min: 0, max: 0.2, step: 0.01, def: 0, label: 'Hit-stop (s)' }, sharp: SEL('Character', ['sharp', 'blurred']), ring: SEL('Shockwave ring', ['off', 'on']) } },
  preview: { label: 'Preview Windows', icon: '▦', color: '#e879f9', dur: 0.45, params: { intensity: I(1), shape: SEL('Shape', ['rects', 'circle', 'slats']) } },
  glint: { label: 'Eye Glint', icon: '✧', color: '#fef9c3', dur: 0.6, params: { intensity: I(0.9) } },
  fgwipe: { label: 'Foreground Wipe', icon: '◧', color: '#f0abfc', dur: 0.3, params: { intensity: I(1), direction: SEL('Direction', ['left', 'right']) } },
  blackout: { label: 'Bass Blackout', icon: '■', color: '#1e1b4b', dur: 0.12, params: { intensity: I(1) } },
  songcut: { label: 'Song Cut-out', icon: '⊘', color: '#334155', dur: 0.8, params: { intensity: I(1, 'Amount') } },
  sweep: { label: 'Flash Sweep', icon: '▀', color: '#fef3c7', dur: 0.07, params: { intensity: I(0.85) } },
  expstrobe: { label: 'Exposure Strobe', icon: '◫', color: '#a5f3fc', dur: 1.2, params: { intensity: I(0.8), rate: { min: 3, max: 15, step: 1, def: 8, label: 'Flips / sec' } } },
  fadechain: { label: 'Impact Fade Chain', icon: '▣', color: '#6366f1', dur: 0.24, params: { intensity: I(1) } },
  speedlines: { label: 'Speed Lines', icon: '✳', color: '#e2e8f0', dur: 0.8, params: { intensity: I(0.6) } },
  pulse: { label: 'Exposure Pulse', icon: '☀', color: '#fcd34d', dur: 0.3, params: { intensity: I(0.6) } },
  zoomblur: { label: 'Zoom Blur', icon: '◎', color: '#a78bfa', dur: 0.45, params: { intensity: I(0.8) } },
  whip: { label: 'Whip Pan', icon: '⇆', color: '#c084fc', dur: 0.4, params: { intensity: I(0.8), direction: SEL('Direction', ['left', 'right', 'up', 'down']) } },
  spin: { label: 'Spin', icon: '↻', color: '#818cf8', dur: 0.5, params: { intensity: I(0.8), direction: SEL('Direction', ['cw', 'ccw']) } },
  echo: { label: 'Echo Dissolve', icon: '❍', color: '#fda4af', dur: 0.5, params: { intensity: I(0.8) } },
  defocus: { label: 'Blur In/Out', icon: '◌', color: '#93c5fd', dur: 0.5, params: { intensity: I(0.8), mode: SEL('Mode', ['in', 'out', 'pulse']) } },
  strobe: { label: 'Strobe', icon: '✺', color: '#fde047', dur: 1, params: { intensity: I(0.6), rate: { min: 2, max: 16, step: 1, def: 8, label: 'Flashes / sec' } } },
  invert: { label: 'Invert', icon: '◑', color: '#e5e7eb', dur: 0.15, params: { intensity: I(1) } },
  camera: { label: 'Camera Move', icon: '🎥', color: '#10b981', dur: 2, sustained: true, params: { intensity: I(0.7), mode: SEL('Style', ['follow', 'push', 'lock', 'handheld', 'ladder']), from: { min: 0, max: 0.9, step: 0.05, def: 0, label: 'Starts moving at' } } },
  vfx: { label: 'VFX Overlay', icon: '✨', color: '#f59e0b', dur: 1, params: { asset: { type: 'vfx', label: 'Effect', def: '' }, blend: SEL('Blend', ['auto', 'screen', 'add', 'normal', 'overlay', 'multiply']), intensity: I(0.9), size: { min: 0.1, max: 1.8, step: 0.05, def: 0.6, label: 'Size' }, x: I(0.5, 'Aim X'), y: I(0.5, 'Aim Y'), rot: { min: -180, max: 180, step: 5, def: 0, label: 'Rotation' }, speed: { min: 0.5, max: 2, step: 0.05, def: 1, label: 'Speed' }, tint: { type: 'color', def: '#ffffff', label: 'Tint' }, tintAmt: I(0, 'Tint amount'), behind: SEL('Layer', ['front', 'behind']), fade: { min: 0, max: 0.6, step: 0.01, def: 0.03, label: 'Fade (s)' } } },
  muffle: { label: 'Song Muffle', icon: '◖', color: '#64748b', dur: 1.2, params: { intensity: I(1, 'Amount') } },
  bassout: { label: 'Bass Cut', icon: '◗', color: '#64748b', dur: 1, params: { intensity: I(1, 'Amount') } },
  mute: { label: 'Silence', icon: '◌', color: '#334155', dur: 0.08, params: { intensity: I(1, 'Amount') } },
  slowzoom: { label: 'Camera Drift', icon: '⤢', color: '#34d399', dur: 3, sustained: true, params: { intensity: I(0.5), dir: SEL('Direction', ['in', 'out']) } },
  letterbox: { label: 'Cinema Bars', icon: '▭', color: '#64748b', dur: 4, sustained: true, params: { intensity: I(1, 'Amount') } },
  bw: { label: 'Black & White', icon: '◧', color: '#9ca3af', dur: 4, sustained: true, params: { intensity: I(1, 'Amount') } },
  fadein: { label: 'Fade In', icon: '◢', color: '#475569', dur: 0.8, params: { intensity: I(1) } },
  fadeout: { label: 'Fade Out', icon: '◣', color: '#475569', dur: 1.2, params: { intensity: I(1) } },
  // transitions measured on the reference edits (docs/refs): centred on the cut at `cut` (0..1 of the effect)
  blurdip: { label: 'Blur Dip', icon: '◍', color: '#7c83fd', dur: 0.34, params: { intensity: I(1) } },
  dipblack: { label: 'Dip to Black', icon: '◒', color: '#1f2937', dur: 0.42, params: { intensity: I(1), light: I(0, 'Light hit') } },
  whiteout: { label: 'White-out', icon: '◻', color: '#f8fafc', dur: 0.3, params: { intensity: I(1) } },
  tiles: { label: 'Mirror Tiles', icon: '▥', color: '#f472b6', dur: 0.14, params: { intensity: I(1), direction: SEL('Direction', ['left', 'right']), tint: { type: 'color', def: '#ff8fb1', label: 'Wash tint' } } },
  smear: { label: 'Smear Cut', icon: '≡', color: '#a78bfa', dur: 0.14, params: { intensity: I(1), direction: SEL('Direction', ['left', 'right', 'up', 'down']) } },
  bwflash: { label: 'White Flash Frames', icon: '◇', color: '#e5e7eb', dur: 0.09, params: { intensity: I(1) } },
  natural: { label: 'Natural Colour', icon: '◐', color: '#fbbf24', dur: 4, sustained: true, params: { intensity: I(1, 'Amount'), warm: I(0, 'Warmth') } },
  dissolve: { label: 'Cross-dissolve', icon: '◑', color: '#cbd5e1', dur: 0.42, params: { intensity: I(1) } },
  whitedissolve: { label: 'White Dissolve', icon: '○', color: '#f8fafc', dur: 0.9, params: { intensity: I(0.85) } },
  stutter: { label: 'Blue-Black Stutter', icon: '▮', color: '#1b0c7f', dur: 1.2, params: { intensity: I(1), beat: { min: 0.2, max: 1, step: 0.01, def: 0.5, label: 'Beat (s)' } } },
  // a template's look, frame by frame, as measured off a reference (docs/refs/group-I.md): `exposure`, `sat`, `defocus`... as arrays
  keys: { label: 'Keyframed Look', icon: '≈', color: '#7dd3fc', dur: 1, params: { intensity: I(1) } },
  // a white plate half the frame high, stepping across a cut in two frames (docs/refs/group-I.md)
  whitebar: { label: 'White Bar', icon: '▬', color: '#f8fafc', dur: 0.067, params: { intensity: I(1), direction: SEL('Direction', ['down', 'up']) } },
  whipcam: { label: 'Two-Stage Whip Cam', icon: '⇆', color: '#38bdf8', dur: 0.75, params: { intensity: I(1), direction: SEL('Direction', ['left', 'right', 'up', 'down']), whipAmt: { min: 0, max: 0.2, step: 0.005, def: 0.04, label: 'Whip offset' }, settlePct: { min: 0.05, max: 0.5, step: 0.01, def: 0.15, label: 'Settle share' }, creepZoom: { min: 0, max: 0.2, step: 0.005, def: 0.045, label: 'Creep zoom' }, driftX: { min: -0.05, max: 0.05, step: 0.002, def: 0.012, label: 'Drift X' }, driftY: { min: -0.05, max: 0.05, step: 0.002, def: 0, label: 'Drift Y' }, smear: I(0.85, 'Whip smear') } },
  parallax: { label: '2.5D Parallax', icon: '◫', color: '#22d3ee', dur: 1.5, params: { intensity: I(1), fgScale: { min: 0.95, max: 1.25, step: 0.01, def: 1.08, label: 'Subject zoom' }, bgScale: { min: 0.85, max: 1.15, step: 0.01, def: 1.02, label: 'BG zoom' }, bgBlur: { min: 0, max: 0.03, step: 0.001, def: 0.008, label: 'BG blur' }, bgDark: I(0.25, 'BG darken') } },
  clone: { label: 'Subject Clone', icon: '❖', color: '#f472b6', dur: 1.2, params: { intensity: I(0.35), scale: { min: 1.02, max: 1.6, step: 0.02, def: 1.22, label: 'Scale' }, blur: { min: 0, max: 0.08, step: 0.005, def: 0.025, label: 'Radial blur' }, glow: I(0.45, 'Rim glow'), color: { type: 'color', def: '#ff9a2e', label: 'Glow color' }, pivotX: I(0.5, 'Pivot X'), pivotY: I(0.75, 'Pivot Y') } },
  dof: { label: 'Subject DoF', icon: '◉', color: '#60a5fa', dur: 1.5, sustained: true, params: { intensity: I(0.7, 'Blur'), bgDark: I(0.2, 'BG darken') } },
  rim: { label: 'Rim & Edge CA', icon: '◈', color: '#c084fc', dur: 0.9, params: { intensity: I(0.85), caEdge: { min: 0, max: 0.02, step: 0.001, def: 0.006, label: 'Edge CA' }, iris: I(0.35, 'Iris bloom'), sweep: I(0.75, 'Sweep light'), color: { type: 'color', def: '#7dd3fc', label: 'Tint' } } },
  colorlut: { label: 'Dark S-Curve Grade', icon: '◐', color: '#fb7185', dur: 2, sustained: true, params: { intensity: I(0.9), crush: { min: -0.08, max: 0.2, step: 0.01, def: 0.03, label: 'Crush/Lift' }, clamp: { min: 0.65, max: 1, step: 0.01, def: 0.88, label: 'Highlight clamp' }, tint: I(0.25, 'Shadow tint'), duo: I(0.15, 'Duo blend'), color: { type: 'color', def: '#ff6b3d', label: 'Hue' }, vignette: I(0.38, 'Vignette') } },
  adjust: { label: 'Adjustment Layer', icon: '▤', color: '#34d399', dur: 2, sustained: true, params: { intensity: I(1), exposure: { min: -1, max: 1, step: 0.02, def: 0, label: 'Exposure' }, contrast: { min: 0.5, max: 1.6, step: 0.02, def: 1, label: 'Contrast' }, saturation: { min: 0, max: 2, step: 0.02, def: 1, label: 'Saturation' }, temp: { min: -0.6, max: 0.6, step: 0.02, def: 0, label: 'Temp' }, bloom: I(0, 'Bloom'), rgb: I(0, 'RGB split'), vignette: I(0, 'Vignette') } },
};

export const FX_CATEGORIES = {
  hits: { label: 'Hits', types: ['flash', 'zoom', 'shake', 'twitch', 'impact', 'rgb', 'glitch', 'smash', 'sweep', 'expstrobe', 'fadechain', 'strobe', 'invert', 'bwflash', 'blackout'] },
  transitions: { label: 'Transitions', types: ['zoomblur', 'whip', 'spin', 'echo', 'defocus', 'blurdip', 'dipblack', 'whiteout', 'tiles', 'smear', 'dissolve', 'whitedissolve', 'whitebar', 'preview', 'fgwipe', 'fadein', 'fadeout'] },
  camera: { label: 'Camera', types: ['whipcam', 'camera', 'slowzoom', 'tilt', 'warp', 'stutter'] },
  depth: { label: 'Depth & 2.5D', types: ['parallax', 'clone', 'dof', 'rim', 'aura', 'glint', 'vfx'] },
  grade: { label: 'Grade & Glow', types: ['colorlut', 'adjust', 'flare', 'energy', 'speedlines', 'pulse', 'bw', 'natural', 'letterbox', 'keys'] },
  audio: { label: 'Audio', types: ['muffle', 'bassout', 'mute', 'songcut'] },
};

export function defaultParams(type) {
  const o = {};
  for (const [k, d] of Object.entries(FX[type].params || {})) o[k] = d.def;
  return o;
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const easeInOut = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
const tri = (p) => { const q = 1 - Math.abs(2 * p - 1); return q * q * (3 - 2 * q); };
// the group I camera's speed: fast at both ends, slow in the middle (measured, per-frame scale of a
// push: 2.8 1.6 1.2 .8 .7 .7 .7 .9 1.2 2.4), so a shot arrives moving and speeds up into the next cut
const ufast = (u) => { const x = 2 * clamp(u, 0, 1) - 1; return 0.5 * (0.5 * x + 0.2 * x * x * x + 0.3 * x * x * x * x * x + 1); };

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

function hexToRgb(hex) {
  const n = parseInt((hex || '#ffffff').slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// A camera path (where to aim, 10 samples a second, smoothed) at a time into the effect.
function camPathAt(path, age) {
  if (!path || !path.xy || path.xy.length < 2) return null;
  const n = path.xy.length >> 1;
  if (n === 1) return [path.xy[0], path.xy[1]];
  const f = clamp(age * path.rate, 0, n - 1), i = Math.min(n - 2, Math.floor(f)), a = f - i;
  return [path.xy[i * 2] * (1 - a) + path.xy[i * 2 + 2] * a, path.xy[i * 2 + 1] * (1 - a) + path.xy[i * 2 + 3] * a];
}

// Sustained effects ease in and snap out quickly so color/bars return right on a drop.
function sustainEnv(e, t) {
  const a = Math.min(0.35, e.dur * 0.2), b = Math.min(0.08, e.dur * 0.1);
  const x = t - e.start;
  return clamp(Math.min(x / a, (e.dur - x) / b), 0, 1);
}

const WARP_MODES = { wave: 0, bulge: 1, twirl: 2 };
const IMPACT_MODES = { mono: 0, invert: 1, red: 2 };

export function fxState(effects, t, fps = 24) {
  const s = {
    scale: 1, tx: 0, ty: 0, rot: 0, shake: 0,
    flash: 0, flashColor: [1, 1, 1],
    rgb: 0, glitch: 0, seed: 0, zoomBlur: 0, dirBlur: [0, 0],
    invert: 0, bars: 0, bw: 0, black: 0,
    impact: 0, impactMode: 0, warp: 0, warpMode: 1, defocus: 0,
    exposure: 0, contrast: 1, sat: 0, echo: 0, speedlines: 0, tilt: [0, 0], flare: 0, energy: 0,
    smash: null, shock: null, hold: null, aura: null, cam: null, vfx: [], sweep: null, sharpSubj: 0, preview: null, glint: 0, glintAge: 0, unduo: 0, temp: 0, bloom: 0, dissolve: 0, dissolveId: null,
    tone: 0, toneColor: [1, 1, 1], vig: 0, shade: 0, shadeScale: 1, shadeX: 0, shadeY: 0, shadeColor: [0.3, 0.3, 0.4], dof: 0, clone: 0, cloneScale: 1.2, cloneBlur: 0, cloneGlow: 0, cloneColor: [1, 0.6, 0.2], clonePivot: [0.5, 0.75], bgDark: 0, lut: 0, lutCrush: 0, lutClamp: 0.85, lutTint: 0, lutColor: [1, 0.6, 0.2], lutDuo: 0, wb: [1, 1, 1], ghost: 0, ghostScale: 1, ghostFringe: 0, stack: 0, comb: 0, bar: 0, flashUnder: 0, plate: 0, crush: 0, lift: 0,
    iris: 0, irisR: 18 / 1080, irisColor: [1, 1, 1], eyeA: null, eyeB: null,
    paraOn: 0, paraF: 1, paraB: 1, paraBlur: 0, caEdge: 0, caX: 0.5, caY: 0.38, caR0: 0.2, rim: 0, rimPhase: -1, rimW: 0.08,
  };
  for (const e of effects) {
    if (t < e.start || t >= e.start + e.dur) continue;
    const p = (t - e.start) / e.dur;
    const P0 = e.params || {};
    let P = P0;
    if (e.kf) {
      const ov = {};
      for (const [key, keys] of Object.entries(e.kf)) {
        if (Array.isArray(keys) && keys.length) ov[key] = evalCurve(keys, p, P0[key] ?? (key === 'intensity' ? 1 : 0));
      }
      P = { ...P0, ...ov };
    }
    const k = P.intensity ?? 1;
    switch (e.type) {
      case 'flash': {
        // (`hold`: full white for that share of it before it decays, a flash that reads as white)
        const h = P.hold || 0, env = h ? (p < h ? 1 : Math.pow(1 - (p - h) / (1 - h), 2.2)) : p < 0.06 ? p / 0.06 : Math.pow(1 - (p - 0.06) / 0.94, 2.2);
        if (k * env > s.flash) { s.flash = k * env; s.flashColor = hexToRgb(P.color); }
        break;
      }
      case 'zoom': {
        const at = Math.min(0.5, Math.max(0.12, 0.07 / e.dur)); // ≥ 70 ms attack: snappy without a one-frame jump
        const env = p < at ? easeOut(p / at) : 1 - easeInOut((p - at) / (1 - at));
        s.scale *= 1 + k * 0.22 * env;
        break;
      }
      case 'shake': {
        if (P.style === 'stepped') {
          // the reference edits' shake "on twos": each position holds for two frames and the
          // picture jumps between them, flipping up and down, instead of gliding. Twos at 24 fps
          // is 12 positions a second (15 gave uneven 2-1-2 frame holds: a stutter, not a step);
          // other rates step at whatever near 12 divides them evenly (15 at 30, 12 at 60).
          const rate = fps / Math.max(1, Math.round(fps / 12.5));
          const amp = k * 0.04 * Math.pow(1 - p, 1.3), n = Math.floor(t * rate + 1e-6), id = e.id || 'st';
          s.tx += amp * (hash(id + n) * 2 - 1) * 0.7;
          s.ty += amp * (n % 2 ? 1 : -1) * (0.55 + 0.45 * hash(id + n + 'y'));
          s.rot += amp * (hash(id + n + 'r') - 0.5) * 0.25;
          s.shake = Math.max(s.shake, amp);
          break;
        }
        const amp = k * 0.036 * Math.pow(1 - p, 1.5);
        const f = 4 + (P.speed ?? 0.6) * 8; // ~9 Hz: well under half the frame rate, so it reads as camera shake, not jitter
        const h = hash(e.id || 'x') * 6.283;
        const nx = Math.sin(t * f * 6.283 + h) * 0.7 + Math.sin(t * f * 1.7 * 6.283 + h * 2) * 0.3;
        const ny = Math.cos(t * f * 1.3 * 6.283 + h * 3) * 0.7 + Math.sin(t * f * 2.1 * 6.283 + h) * 0.3;
        const nr = Math.sin(t * f * 0.9 * 6.283 + h * 5);
        const st = P.style || 'chaos';
        const wx = st === 'vertical' ? 0.15 : st === 'rotate' ? 0.3 : st === 'horizontal' ? 1.6 : 1;
        const wy = st === 'horizontal' ? 0.15 : st === 'rotate' ? 0.3 : st === 'vertical' ? 1.6 : 1;
        const wr = st === 'rotate' ? 3 : st === 'chaos' ? 0.9 : 0.2;
        s.tx += amp * nx * wx;
        s.ty += amp * ny * wy;
        s.rot += amp * nr * wr;
        s.shake = Math.max(s.shake, amp * Math.max(wx, wy, wr * 0.5));
        break;
      }
      case 'twitch': {
        const step = Math.floor(t * 12);
        const r1 = hash((e.id || 'tw') + step), r2 = hash((e.id || 'tw') + step + 'y'), r3 = hash((e.id || 'tw') + step + 'z');
        const env = k * (1 - p * 0.5);
        if (r3 > 0.3) {
          s.tx += (r1 - 0.5) * 0.09 * env;
          s.ty += (r2 - 0.5) * 0.09 * env;
          s.scale *= 1 + r3 * 0.12 * env;
          s.rgb += env * 0.9;
        }
        s.shake = Math.max(s.shake, 0.05 * env);
        break;
      }
      case 'impact': {
        s.impact = Math.max(s.impact, k);
        let mode = IMPACT_MODES[P.mode || 'mono'] ?? 0;
        if (mode === 0 && Math.floor((t - e.start) * 24) % 2 === 1) mode = 1; // classic B/W ↔ inverted flicker
        s.impactMode = mode;
        break;
      }
      case 'rgb':
        // (`ramp`: a prism crescendo, the split growing from nothing to extreme over the effect, into a cut)
        s.rgb += k * (P.ramp ? 2.2 * easeIn(p) : Math.pow(1 - p, 1.5));
        break;
      case 'glitch': {
        const env = k * (1 - p * 0.6);
        s.glitch = Math.max(s.glitch, env);
        s.seed = Math.floor(t * 15) + hash(e.id || 'g') * 100;
        s.rgb += env * 0.6;
        break;
      }
      case 'warp': {
        const env = k * (p < 0.15 ? easeOut(p / 0.15) : Math.pow(1 - (p - 0.15) / 0.85, 1.4));
        if (env > s.warp) { s.warp = env; s.warpMode = WARP_MODES[P.mode || 'bulge'] ?? 1; }
        s.scale *= 1 + 0.04 * env;
        break;
      }
      case 'tilt': {
        // the frame swings in 3D and settles back (direction varies per effect)
        const env = p < 0.3 ? easeOut(p / 0.3) : 1 - easeInOut((p - 0.3) / 0.7);
        const a = k * 0.42 * env * (hash(e.id || 't') > 0.5 ? 1 : -1);
        const ax = P.axis || 'swing';
        if (ax !== 'tilt') s.tilt[0] += a;
        if (ax !== 'swing') s.tilt[1] += a * (ax === 'both' ? 0.6 : 1);
        break;
      }
      case 'flare':
        s.flare = Math.max(s.flare, k * (p < 0.08 ? p / 0.08 : Math.pow(1 - (p - 0.08) / 0.92, 1.6)));
        break;
      case 'aura': {
        // a glowing rim traced around the characters (needs their outlines), flaring in and easing out
        // (`hold`: stays lit to the end, a figure standing in for a letter keeps its rim)
        const env = p < 0.1 ? easeOut(p / 0.1) : p > 0.6 && !P.hold ? 1 - easeInOut((p - 0.6) / 0.4) : 1;
        if (!s.aura || k * env > s.aura.k) s.aura = { col: hexToRgb(P.color || '#ff8a1f'), k: k * env };
        break;
      }
      case 'smash': {
        // an impact aimed where the hit lands: a sharp push toward it, a shockwave ring from it, a
        // flash of chroma and radial blur, and (for the hardest hits) a hit-stop freeze on contact
        const age = t - e.start, hold = P.hold || 0, x = P.x ?? 0.5, y = P.y ?? 0.5;
        const env = age < 0.035 ? age / 0.035 : Math.pow(Math.max(0, 1 - (age - 0.035) / Math.max(0.05, e.dur - 0.035)), 2);
        // restrained by default (the reference edits hit with a crisp push and a hold, not a
        // wobbling frame): a small push, a light radial blur, barely any colour split
        s.scale *= 1 + k * 0.08 * env;
        s.smash = [x, y];
        s.zoomBlur += k * 0.15 * env;
        // the character stays sharp while the world blurs around the hit
        if (P.sharp !== 'blurred') s.sharpSubj = Math.max(s.sharpSubj, env > 0.02 ? 1 : 0);
        s.rgb = Math.max(s.rgb, k * 0.1 * env);
        if (P.ring === 'on' && age < 0.4) s.shock = [x, y, age / 0.4, k * (1 - age / 0.4)];
        if (hold > 0 && age < hold) s.hold = e.start;
        break;
      }
      case 'energy':
        // the footage's own effects flare up (glow, bloom, vibrance), then settle
        s.energy = Math.max(s.energy, k * (p < 0.15 ? easeOut(p / 0.15) : 1 - easeInOut((p - 0.15) / 0.85)));
        break;
      case 'speedlines':
        s.speedlines = Math.max(s.speedlines, k * Math.min(1, (1 - p) * 3) * Math.min(1, p * 12 + 0.3));
        break;
      case 'pulse': {
        const env = Math.pow(1 - p, 2);
        s.exposure += k * 0.9 * env;
        s.sat += k * 0.45 * env;
        break;
      }
      case 'zoomblur': {
        if (P.cut == null) {
          // (older edits) in to the cut and back out
          const q = tri(p);
          s.zoomBlur += k * q;
          s.scale *= 1 + k * 0.28 * q;
          break;
        }
        // a zoom THROUGH the cut: it speeds up into the cut, carries on into the next shot at the
        // very same speed (no stop at the boundary, which reads as a hitch), eases to rest, then
        // settles back. The carry's size is set so the speed matches across the cut exactly.
        const age = t - e.start, tIn = P.cut * e.dur, tCarry = tIn * 0.9, tSettle = Math.max(0.05, e.dur - tIn - tCarry);
        const A = 0.2 * k, B = A * (tCarry / tIn);
        let z, b;
        if (age < tIn) { const x = age / tIn; z = A * x * x; b = x; }
        else if (age < tIn + tCarry) { const y = (age - tIn) / tCarry; z = A + B * (2 * y - y * y); b = 1 - y; }
        else { z = (A + B) * (1 - easeInOut(Math.min(1, (age - tIn - tCarry) / tSettle))); b = 0; }
        s.zoomBlur += k * b;
        s.scale *= 1 + z;
        break;
      }
      case 'whip': {
        const dir = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[P.direction || 'left'];
        const off = p < 0.5 ? -easeIn(p * 2) : 1 - easeOut(p * 2 - 1);
        const q = tri(p) * k;
        // (`travel`: how far the frame slides, as a share of its width; a quick whip on a beat cut
        // barely slides, or its mirrored edges show)
        const travel = P.travel ?? 0.45;
        s.tx += dir[0] * off * travel * k;
        s.ty += dir[1] * off * travel * k;
        s.dirBlur = [s.dirBlur[0] + dir[0] * q, s.dirBlur[1] + dir[1] * q];
        break;
      }
      case 'spin': {
        const d = P.direction === 'ccw' ? -1 : 1;
        const a = p < 0.5 ? easeIn(p * 2) : -(1 - easeOut(p * 2 - 1));
        const q = tri(p) * k;
        s.rot += d * a * Math.PI * 0.5 * k;
        s.scale *= 1 + 0.9 * q;
        s.zoomBlur += q * 0.9;
        break;
      }
      case 'echo':
        s.echo = Math.max(s.echo, k * Math.pow(1 - p, 1.2));
        break;
      case 'defocus': {
        const m = P.mode || 'in';
        const env = m === 'in' ? Math.pow(1 - p, 1.5) : m === 'out' ? Math.pow(p, 1.5) : tri(p);
        s.defocus = Math.max(s.defocus, k * env);
        break;
      }
      case 'strobe': {
        const ph = ((t - e.start) * (P.rate || 8)) % 1;
        const v = ph < 0.35 ? k * 0.85 * (1 - ph / 0.35) : 0;
        if (v > s.flash) { s.flash = v; s.flashColor = [1, 1, 1]; }
        break;
      }
      case 'invert':
        s.invert = Math.max(s.invert, k);
        break;
      case 'camera': {
        // a camera operator for the shot (like the reference edits): locked off, following the
        // character, pushing in on their face, or handheld. With "starts moving at", the shot holds
        // still and the camera eases into motion there (static, then it tracks the action).
        const age = t - e.start, mode = P.mode || 'follow', from = (P.from || 0) * e.dur;
        const go = age < from ? 0 : from > 0 ? easeInOut(Math.min(1, (age - from) / Math.min(0.45, Math.max(0.1, e.dur - from)))) : 1;
        // (`aimAt`: a fixed point of the source picture, a lock word's thing; `noAim`: none)
        const aim = P.aimAt ? P.aimAt : P.noAim ? null : camPathAt(P.path, age);
        const h = hash(e.id || 'cam') * 6.283;
        const sway = (amp) => {
          s.tx += amp * (Math.sin(t * 3.96 + h) * 0.6 + Math.sin(t * 8.6 + h * 2) * 0.3 + Math.sin(t * 18.2 + h * 3) * 0.1);
          s.ty += amp * (Math.cos(t * 3.2 + h * 4) * 0.6 + Math.sin(t * 7.3 + h * 5) * 0.3 + Math.cos(t * 16.1 + h) * 0.1);
        };
        if (mode === 'lock') s.cam = { z: 1, w: 0, lock: true };
        else if (mode === 'ladder') {
          // punch-in ladder into the drop: medium shot, then a jump to a close-up, then a frame on
          // the eyes, each a hard step like a cut, aimed at the face
          let z = 1;
          for (const [at, zz] of P.steps || []) if (age >= at) z = zz;
          s.cam = { z: 1 + (z - 1) * k, w: aim && z > 1 ? 1 : 0, x: aim?.[0], y: aim?.[1], burst: true };
        }
        else if (mode === 'path') {
          // a move written out frame by frame (Your Month: the template's measured camera, locked on the character):
          // zoom and aim at `rate` samples a second, straight lines between samples at 60 fps
          const rate = P.rate || 30, f = Math.max(0, age * rate), i = Math.floor(f + 1e-6), a = f - i;
          const at = (arr) => { const n = arr.length, v0 = arr[Math.min(n - 1, i)], v1 = arr[Math.min(n - 1, i + 1)]; return v0 + (v1 - v0) * a; };
          s.cam = { z: at(P.z), w: 1, x: at(P.x), y: at(P.y), exact: true };
          if (P.r && P.r.length) s.rot += at(P.r) * k;
        }
        else if (mode === 'glide') {
          // pro: one eased move across the whole shot (a push, a pull or a drift, with a lean), the
          // way the reference edits keyframe theirs; aimed at the character when their outline is known
          // ('settle': the whip-and-settle of the Blue Lock edits, the new shot landing zoomed in and
          // tipped and settling level over `settle` seconds, most of the way in the first quarter)
          // ('lock': a lock word's shot, docs/refs/group-G.md: the move eases out to rest exactly as
          // the letter locks (`lockAge` seconds in), then drifts on slowly (`drift`, zoom a second) so
          // the held picture never looks frozen)
          // (the lock: steady speed, then braking over the last quarter second, as the references move
          // 8-13 px a frame right up to the lock and settle in 4-8 frames)
          const lockQ = (T) => { const E = Math.min(0.25, T * 0.4), v = 1 / (T - E / 2), u = age - (T - E); return age >= T ? 1 : u <= 0 ? v * age : v * (T - E) + v * (u - (u * u) / (2 * E)); };
          const q = P.lockAge != null ? lockQ(Math.max(0.05, P.lockAge))
            : P.settle ? 1 - Math.pow(1 - Math.min(1, age / P.settle), 4) : P.ease === 'ufast' ? ufast(p) : P.ease === 'out' ? easeOut(p) : P.ease === 'in' ? easeIn(p) : easeInOut(p);
          const z0 = P.z0 ?? 1, z1 = P.z1 ?? 1.2, dz = P.lockAge != null ? Math.max(0, age - P.lockAge) * (P.drift ?? 0.012) : 0;
          // (`aimTo`: the aim travels there with the move; `exact`: the zoom and aim taken as written, for a framing set by hand)
          const ax = aim && P.aimTo ? aim[0] + (P.aimTo[0] - aim[0]) * q : aim?.[0], ay = aim && P.aimTo ? aim[1] + (P.aimTo[1] - aim[1]) * q : aim?.[1];
          s.cam = { z: 1 + (z0 + (z1 - z0) * q + dz - 1) * k, w: P.aimAt ? 1 : aim ? (P.path && P.path.guess ? 0.45 : 0.75) : 0, x: ax, y: ay, exact: !!P.exact };
          s.rot += ((P.r0 || 0) + ((P.r1 || 0) - (P.r0 || 0)) * q) * k;
          s.tx += (P.px || 0) * (q - 0.5) * k;
          if (P.exact) { /* no sway: the framing is as written */ } else sway(0.0008 * k);
          // (`slide`: the picture slides in from the side and comes to rest on the lock)
          if (P.slide) s.tx += P.slide * (1 - q) * k;
        }
        else if (mode === 'push') {
          const q = 0.35 * p + 0.65 * easeInOut(p); // moving from the first frame, gliding in
          // aimed at the face from its outline, or (a guess from the footage) more gently
          s.cam = { z: 1 + k * 0.24 * q, w: aim ? (0.35 + 0.55 * q) * (P.path.guess ? 0.6 : 1) : 0, x: aim?.[0], y: aim?.[1] };
          sway(0.001 * k);
        } else if (mode === 'handheld') {
          s.cam = { z: 1 + k * 0.05 * go, w: 0 };
          sway(0.005 * k * go);
          s.rot += 0.003 * k * go * Math.sin(t * 2.7 + h * 6);
        } else {
          s.cam = { z: 1 + k * 0.15 * go, w: aim ? 0.9 * go : 0, x: aim?.[0], y: aim?.[1], lock: go === 0 };
          sway(0.0025 * k * go);
        }
        break;
      }
      case 'vfx': {
        // an overlay from the VFX library (placed and drawn by the renderer)
        if (!P.asset || P.off) break;
        const age = t - e.start, fd = P.fade ?? 0.03;
        const env = Math.min(1, fd > 0 ? age / fd : 1, fd > 0 ? (e.dur - age) / Math.max(fd, 0.05) : 1);
        s.vfx.push({ id: P.asset, age, p, k: k * Math.max(0, env), x: P.x ?? 0.5, y: P.y ?? 0.5, size: P.size ?? 0.6, rot: ((P.rot || 0) * Math.PI) / 180, speed: P.speed || 1, tint: P.tint, tintAmt: P.tintAmt || 0, behind: P.behind === 'behind', flip: !!P.flip, blend: P.blend || 'auto' });
        break;
      }
      case 'preview':
        // the next shot shows through shapes before the cut (drawn by the renderer)
        s.preview = { shape: P.shape || 'rects', p, k, end: e.start + e.dur, id: e.id || 'pv' };
        break;
      case 'glint': {
        // a star of light catching the character's eyes (the renderer finds the eyes from face
        // detection and keeps it on them as the camera moves): flares in, then fades
        const age = t - e.start, env = age < 0.06 ? age / 0.06 : Math.pow(Math.max(0, 1 - (age - 0.06) / Math.max(0.05, e.dur - 0.06)), 1.6);
        if (k * env > s.glint) { s.glint = k * env; s.glintAge = age; }
        break;
      }
      case 'fgwipe':
        // the next shot sweeps in behind the character, who stays on top until the cut: the
        // character's own silhouette hides the seam (drawn by the renderer, like preview windows)
        s.preview = { shape: P.direction === 'right' ? 'fgright' : 'fgleft', p, k, end: e.start + e.dur, id: e.id || 'fw' };
        break;
      case 'blackout':
        // where the song's bass drops out: two indigo frames, then black until it comes back
        // (`plain`: straight to black, for an ending, where the indigo reads as a stray frame)
        if (!P.plain && t - e.start < 2 / 30) { if (k * 0.9 > s.flash) { s.flash = k * 0.9; s.flashColor = [0.08, 0.035, 0.37]; } }
        else s.black = Math.max(s.black, k);
        break;
      case 'sweep': {
        // a soft white bar sweeps the frame on the drop: low with the whole frame brightening,
        // then high and half as strong, a frame each
        s.sweep = { k, phase: t - e.start < 1 / 30 ? 0 : 1 };
        break;
      }
      case 'expstrobe': {
        // the exposure flips between blown-out glow and normal on the beat's subdivisions
        const per = 1 / (P.rate || 8), ph = ((t - e.start) % per) / per;
        if (ph < 0.5) { s.exposure += k * 1.1; if (k * 0.18 > s.flash) { s.flash = k * 0.18; s.flashColor = [0.85, 0.97, 1]; } }
        break;
      }
      case 'fadechain': {
        // after the hardest hit: inverted with an RGB split, washed white, grey and dark, two
        // indigo frames, two black ones, then the next shot
        const n = Math.floor((t - e.start) * 30 + 1e-6);
        if (n === 0) { s.invert = Math.max(s.invert, k); s.rgb += k; }
        else if (n === 1) { if (k * 0.65 > s.flash) { s.flash = k * 0.65; s.flashColor = [1, 1, 1]; } }
        else if (n === 2) { s.bw = Math.max(s.bw, k); s.black = Math.max(s.black, k * 0.4); }
        else if (n <= 4) { if (k * 0.9 > s.flash) { s.flash = k * 0.9; s.flashColor = [0.08, 0.035, 0.37]; } }
        else s.black = Math.max(s.black, k);
        break;
      }
      case 'slowzoom': {
        // already moving on the first frame: an eased start reads as a frozen shot
        const q = 0.6 * p + 0.4 * easeOut(p);
        s.scale *= 1 + k * 0.14 * (P.dir === 'out' ? 1 - q : q);
        break;
      }
      case 'letterbox':
        s.bars = Math.max(s.bars, k * 0.13 * sustainEnv(e, t));
        break;
      case 'bw':
        s.bw = Math.max(s.bw, k * sustainEnv(e, t));
        break;
      case 'fadein':
        s.black = Math.max(s.black, k * (1 - easeOut(p)));
        break;
      case 'fadeout': {
        // (`len`: the fade takes that long and then stays black to the effect's end, so an edit's
        // last frames are truly black)
        const q = P.len ? Math.min(1, (t - e.start) / P.len) : p;
        s.black = Math.max(s.black, k * easeIn(q));
        break;
      }
      case 'blurdip': {
        // the outgoing shot darkens to half and blurs into the cut; the incoming one starts dark,
        // blurred and enlarged (1.2x) and recovers (Dandadan reference: 4 frames out, 4-6 in)
        const c = P.cut ?? 0.4, age = p < c ? p / c : (p - c) / (1 - c), q = p < c ? easeIn(age) : 1 - easeOut(age);
        s.exposure -= k * 1.0 * q;
        s.defocus = Math.max(s.defocus, k * 0.85 * q);
        if (p >= c) s.scale *= 1 + k * 0.2 * (1 - easeOut(age));
        break;
      }
      case 'dipblack': {
        // fade out over 5-6 frames, a black frame on the cut, fade back in over 3-6, and with
        // `light` the fade-up overshoots into a blown, glowing light hit (One Piece reference)
        const c = P.cut ?? 0.55, hold = 0.08;
        let b;
        if (p < c - hold / 2) b = easeIn(p / (c - hold / 2));
        else if (p < c + hold / 2) b = 1;
        else { const a = (p - c - hold / 2) / (1 - c - hold / 2); b = 1 - easeOut(a); if (P.light) { s.exposure += k * P.light * 1.6 * Math.sin(Math.PI * Math.min(1, a * 1.2)); s.sat += k * P.light * 0.3 * (1 - a); } }
        s.black = Math.max(s.black, k * b);
        break;
      }
      case 'whiteout': {
        // the picture ramps up to white into the drop (Haikyuu reference: 9 frames), hard cut on it
        const v = k * Math.pow(p, 1.6);
        s.exposure += k * 1.2 * p;
        if (v > s.flash) { s.flash = v; s.flashColor = [1, 1, 1]; }
        break;
      }
      case 'tiles': {
        // mirror-tile slide (Blue Lock reference): the picture shrinks into side-by-side mirrored
        // copies sliding with motion blur and a colour fringe, one washed-out tinted frame on the cut
        const d = P.direction === 'right' ? 1 : -1, env = tri(p), off = p < 0.5 ? -easeIn(p * 2) : 1 - easeOut(p * 2 - 1);
        s.scale *= 1 / (1 + 1.3 * k * env);
        s.tx += d * off * 0.6 * k;
        s.dirBlur = [s.dirBlur[0] + d * env * k, s.dirBlur[1]];
        s.rgb += k * 0.8 * env;
        if (Math.abs(p - 0.5) < 0.18) { const tint = hexToRgb(P.tint || '#ff8fb1'); if (k * 0.45 > s.flash) { s.flash = k * 0.45; s.flashColor = tint; } s.sat -= 0.3 * k; }
        break;
      }
      case 'natural': {
        // the one-colour push eases off for a stretch (the memories keep their own warm colour), in
        // and out over a third of a second (`sharp`: on and off with the cut, where a ramp reads as a
        // colour drifting on a held shot: a hook's first frames went from red to their own colours)
        const age = t - e.start, left = e.start + e.dur - t, q = P.sharp ? 1 : Math.min(1, age / 0.33, left / 0.33);
        s.unduo = Math.max(s.unduo, k * q);
        if (P.warm) { s.exposure += 0.04 * P.warm * q; s.sat += 0.12 * P.warm * q; }
        // (`memory`: a remembered shot, warmer and softly glowing against the present day's cold grade)
        if (P.memory) { s.temp += 0.3 * P.memory * q; s.bloom += 0.12 * P.memory * q; }
        break;
      }
      case 'dissolve': {
        // a true cross-dissolve from the cut: the outgoing shot's last frame, held, fades out over the
        // incoming one (the renderer keeps that frame; no feedback, so nothing in motion ghosts)
        const v = k * (1 - easeInOut(p));
        if (v > s.dissolve) { s.dissolve = v; s.dissolveId = e.id || `d${e.start.toFixed(3)}`; }
        break;
      }
      case 'whitedissolve': {
        // a soft white dissolve (the romance edit): up to white over three frames, the cut under it,
        // held two, then easing back over about eighteen
        const age = t - e.start, up = 3 / fps, hold = 2 / fps, cut = e.dur * 0.18;
        const v = age < cut - up ? 0 : age < cut ? (age - (cut - up)) / up : age < cut + hold ? 1 : Math.pow(Math.max(0, 1 - (age - cut - hold) / Math.max(0.1, e.dur - cut - hold)), 1.6);
        if (k * v > s.flash) { s.flash = k * v; s.flashColor = [1, 0.99, 0.97]; }
        break;
      }
      case 'stutter': {
        // the Jujutsu Kaisen edit's blink: each beat the shot plays, then two frames go deep-blue
        // monochrome and two go black, then the next beat
        const beat = P.beat || 0.5, f = Math.floor((((t - e.start) % beat) + 1e-6) * fps), n = Math.round(beat * fps);
        if (f >= n - 2) s.black = Math.max(s.black, k);
        else if (f >= n - 4) { s.bw = Math.max(s.bw, k); if (k * 0.62 > s.flash) { s.flash = k * 0.62; s.flashColor = [0.11, 0.05, 0.5]; } }
        break;
      }
      case 'bwflash': {
        // the XP2 edits' cut: the incoming shot's first two frames drained of colour and pushed
        // nearly white, then straight back to colour
        const n = Math.floor((t - e.start) * fps + 1e-6);
        s.bw = Math.max(s.bw, k);
        s.exposure += k * (n === 0 ? 1.5 : 0.9);
        break;
      }
      case 'keys': {
        // a template's look frame by frame: arrays at `rate` samples a second (30), read with straight
        // lines between samples at 60 fps. `flashUnder`: flashes go under the text, which stays lit on them
        const rate = P.rate || 30, f = (t - e.start) * rate, i = Math.floor(f + 1e-6), a = P.step ? 0 : Math.max(0, f - i);
        const at = (arr) => { if (!arr || !arr.length) return 0; const n = arr.length, v0 = arr[Math.min(n - 1, i)], v1 = arr[Math.min(n - 1, i + 1)]; return v0 + (v1 - v0) * a; };
        const sn = (arr) => (arr && arr.length ? arr[Math.min(arr.length - 1, i)] : 0);
        s.exposure += at(P.exposure); s.sat += at(P.sat);
        s.crush = Math.max(s.crush, at(P.crush));
        s.lift = Math.max(s.lift, at(P.lift));
        s.defocus = Math.max(s.defocus, at(P.defocus));
        s.zoomBlur += at(P.zoomBlur);
        s.dirBlur = [s.dirBlur[0] + at(P.dirX), s.dirBlur[1] + at(P.dirY)];
        s.rgb += at(P.rgb);
        s.bw = Math.max(s.bw, at(P.bw));
        s.black = Math.max(s.black, sn(P.black));
        const im = sn(P.impact); if (im > 0) { s.impact = Math.max(s.impact, im); s.impactMode = 0; }
        // (`tone`, `toneColor`: the shot in one colour of light, dark through the colour to white, as the references' lit shots)
        // (`shade`: the character's shadow, a darker copy of the character behind and above them, cut out with the character mask:
        // amount, `shadeScale` its size against the character, `shadeX`/`shadeY` its shift as shares of the frame, `shadeColor` its tint)
        const sh = at(P.shade); if (sh > s.shade) { s.shade = sh; s.shadeScale = at(P.shadeScale) || 1.1; s.shadeX = at(P.shadeX); s.shadeY = at(P.shadeY); if (P.shadeColor) s.shadeColor = hexToRgb(P.shadeColor); }
        // (`dof`: depth of field, the background behind the character softened by this much, the character kept sharp)
        s.dof = Math.max(s.dof, at(P.dof));
        // (the canonical spec, docs/your-month-spec-v2.md: `clone` a screen-blended copy of the character behind them, `cloneScale`, `cloneBlur`
        // its zoom blur, `cloneGlow` its edge glow in `cloneColor`, growing from `clonePivotX/Y` of the frame; `bgDark` the background darkened;
        // `lut` one dark S-curve grade, `lutCrush`, `lutClamp` the highlight shoulder, `lutTint` towards `lutColor`)
        const cl = at(P.clone); if (cl > s.clone) { s.clone = cl; s.cloneScale = at(P.cloneScale) || 1.2; s.cloneBlur = at(P.cloneBlur); s.cloneGlow = at(P.cloneGlow); s.clonePivot = [P.clonePivotX ?? 0.5, P.clonePivotY ?? 0.75]; if (P.cloneColor) s.cloneColor = hexToRgb(P.cloneColor); }
        s.bgDark = Math.max(s.bgDark, at(P.bgDark));
        const lu = at(P.lut); if (lu > s.lut) { s.lut = lu; s.lutCrush = at(P.lutCrush); s.lutClamp = at(P.lutClamp) || 0.85; s.lutTint = at(P.lutTint); if (P.lutColor) s.lutColor = hexToRgb(P.lutColor); }
        // (the user's second notes, 8 Nov 2026: `lutDuo` the block's shared tint across the whole range; `wb` the shot's white balance, three gains)
        s.lutDuo = Math.max(s.lutDuo || 0, at(P.lutDuo)); if (P.wb && P.wb.length === 3) s.wb = P.wb;
        s.vig = Math.max(s.vig || 0, at(P.vig));   // (`vig`: a vignette building over a shot, added to the look's own)
        const tn = at(P.tone); if (tn > s.tone) { s.tone = tn; s.toneColor = P.toneColor ? hexToRgb(P.toneColor) : [1, 1, 1]; }
        const gh = at(P.ghost); if (gh > s.ghost) { s.ghost = gh; s.ghostScale = at(P.ghostScale) || 1.08; s.ghostFringe = at(P.ghostFringe); }
        // (the user's third notes, 8 Nov 2026: `iris` the iris and rim-light bloom's intensity, `irisR` its radius as a share of the frame's
        // height, `irisColor` the character's colour; `eyeA`/`eyeB` per sample the eyes' boxes [x0, y0, x1, y1] in the source picture)
        const ir = at(P.iris); if (ir > s.iris) { s.iris = ir; s.irisR = at(P.irisR) || 18 / 1080; if (P.irisColor) s.irisColor = hexToRgb(P.irisColor); }
        const box = (arr) => { if (!arr || !arr.length) return null; const b0 = arr[Math.min(arr.length - 1, i)], b1 = arr[Math.min(arr.length - 1, i + 1)]; if (!b0 || b0.length !== 4) return null; return b1 && b1.length === 4 ? b0.map((v, j) => v + (b1[j] - v) * a) : b0; };
        const ea = box(P.eyeA), eb = box(P.eyeB); if (ea) s.eyeA = ea; if (eb) s.eyeB = eb;
        // (the master spec, 9 Nov 2026: option A `paraOn` with `paraF`/`paraB` the character's and the plate's scale and `paraBlur` the plate's
        // blur; option C `caEdge` an edge RGB split round the face at `caX`/`caY`, radius `caR0`, and `rimPhase` 0-1 (-1 off) a sweep of `rim`)
        if (sn(P.paraOn) > 0) { s.paraOn = 1; s.paraF = at(P.paraF) || 1; s.paraB = at(P.paraB) || 1; s.paraBlur = at(P.paraBlur); }
        const ce = at(P.caEdge); if (ce > s.caEdge) { s.caEdge = ce; s.caX = P.caX ?? 0.5; s.caY = P.caY ?? 0.38; s.caR0 = P.caR0 ?? 0.2; }
        const rp0 = P.rimPhase ? sn(P.rimPhase) : -1; if (rp0 >= 0 && P.rim) { s.rimPhase = Math.max(rp0, at(P.rimPhase)); s.rim = P.rim; s.rimW = P.rimW || 0.08; }
        s.warp = Math.max(s.warp, at(P.warp)); if (P.warp) s.warpMode = 1;
        s.stack = Math.max(s.stack, sn(P.stack));
        s.comb = Math.max(s.comb, at(P.comb));
        const fl = sn(P.flash); if (fl > s.flash) { s.flash = fl; s.flashColor = P.flashColor ? hexToRgb(P.flashColor) : [0.98, 0.98, 0.98]; }
        s.plate = Math.max(s.plate, sn(P.plate));
        if (P.flashUnder) s.flashUnder = 1;
        break;
      }
      case 'whitebar': {
        // first half of the effect the plate is on one half of the frame, second half on the other,
        // the cut under it: `down` runs top then bottom, `up` the other way (1 top, 2 bottom)
        const first = p < 0.5;
        s.bar = (P.direction === 'up') === first ? 2 : 1;
        break;
      }
      case 'smear': {
        // a smear cut (Demon Slayer Inosuke reference): a frame darker just before, two frames of
        // heavy directional blur on the hit, the new shot landing 1.12x and blurred, settled in 3 frames
        const dir = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[P.direction || 'left'];
        const age = t - e.start, cutAt = e.dur * 0.45;
        const blur = Math.max(0, 1 - Math.abs(age - cutAt) / (1.6 / fps));
        s.dirBlur = [s.dirBlur[0] + dir[0] * blur * 1.3 * k, s.dirBlur[1] + dir[1] * blur * 1.3 * k];
        if (age < cutAt && age > cutAt - 1.2 / fps) s.exposure -= 0.5 * k;
        if (age >= cutAt) { const q = Math.min(1, (age - cutAt) / (3 / fps)); s.scale *= 1 + 0.12 * k * (1 - easeOut(q)); s.defocus = Math.max(s.defocus, 0.35 * k * (1 - q)); }
        break;
      }
      case 'whipcam': {
        const settle = clamp(P.settlePct ?? 0.15, 0.05, 0.5);
        const dir = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[P.direction || 'left'];
        const qSettle = p < settle ? Math.pow(1 - p / settle, 3) : 0;
        const whip = (P.whipAmt ?? 0.04) * k * qSettle;
        s.tx += dir[0] * whip + (P.driftX ?? 0.012) * (p - 0.5) * k;
        s.ty += dir[1] * whip + (P.driftY ?? 0) * (p - 0.5) * k;
        if (qSettle > 0.01) s.dirBlur = [s.dirBlur[0] + dir[0] * qSettle * (P.smear ?? 0.85) * k, s.dirBlur[1] + dir[1] * qSettle * (P.smear ?? 0.85) * k];
        s.scale *= 1 + (P.creepZoom ?? 0.045) * p * k;
        break;
      }
      case 'parallax': {
        const q = easeOut(p);
        s.paraOn = 1;
        s.paraF = 1 + ((P.fgScale ?? 1.08) - 1) * q * k;
        s.paraB = 1 + ((P.bgScale ?? 1.02) - 1) * q * k;
        s.paraBlur = Math.max(s.paraBlur, (P.bgBlur ?? 0.008) * k);
        s.bgDark = Math.max(s.bgDark, (P.bgDark ?? 0.25) * k);
        break;
      }
      case 'clone': {
        const env = Math.min(1, p / 0.15);
        if (k * env > s.clone) {
          s.clone = k * env;
          s.cloneScale = 1 + ((P.scale ?? 1.22) - 1) * easeOut(p);
          s.cloneBlur = P.blur ?? 0.025;
          s.cloneGlow = P.glow ?? 0.45;
          s.cloneColor = hexToRgb(P.color || '#ff9a2e');
          s.clonePivot = [P.pivotX ?? 0.5, P.pivotY ?? 0.75];
        }
        break;
      }
      case 'dof': {
        const env = sustainEnv(e, t);
        s.dof = Math.max(s.dof, k * env);
        s.bgDark = Math.max(s.bgDark, (P.bgDark ?? 0.2) * k * env);
        break;
      }
      case 'rim': {
        const env = p < 0.12 ? easeOut(p / 0.12) : 1 - easeInOut((p - 0.12) / 0.88);
        s.caEdge = Math.max(s.caEdge, (P.caEdge ?? 0.006) * k * env);
        s.iris = Math.max(s.iris, (P.iris ?? 0.35) * k * env);
        s.irisColor = hexToRgb(P.color || '#7dd3fc');
        const sw = P.sweep ?? 0.75;
        if (sw > 0.001) { s.rim = Math.max(s.rim, sw * k); s.rimPhase = Math.max(s.rimPhase, p); }
        break;
      }
      case 'colorlut': {
        const env = sustainEnv(e, t);
        if (k * env > s.lut) {
          s.lut = k * env;
          s.lutCrush = P.crush ?? 0.03;
          s.lutClamp = P.clamp ?? 0.88;
          s.lutTint = P.tint ?? 0.25;
          s.lutDuo = P.duo ?? 0.15;
          s.lutColor = hexToRgb(P.color || '#ff6b3d');
        }
        s.vig = Math.max(s.vig, (P.vignette ?? 0.38) * k * env);
        break;
      }
      case 'adjust': {
        const env = sustainEnv(e, t), m = k * env;
        s.exposure += (P.exposure ?? 0) * m;
        s.contrast *= 1 + ((P.contrast ?? 1) - 1) * m;
        s.sat += ((P.saturation ?? 1) - 1) * m;
        s.temp += (P.temp ?? 0) * m;
        s.bloom += (P.bloom ?? 0) * m;
        s.rgb += (P.rgb ?? 0) * m;
        s.vig = Math.max(s.vig, (P.vignette ?? 0) * m);
        break;
      }
    }
  }
  // readability budget: however many shakes overlap, the picture never moves more than 2.2% of
  // the frame, so the action stays easy to follow
  const off = Math.hypot(s.tx, s.ty), cap = 0.022 + (s.dirBlur[0] || s.dirBlur[1] ? 0.5 : 0);
  if (off > cap) { s.tx *= cap / off; s.ty *= cap / off; }
  s.shake = Math.min(s.shake, 0.03);
  // an impact frame is the hit — don't let a simultaneous white flash wash it out
  if (s.impact > 0) s.flash *= 1 - 0.85 * s.impact;
  return s;
}

// ---------- color looks ----------
export const GRADE_DEFAULT = {
  exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, fade: 0,
  shadows: [0, 0, 0], highlights: [0, 0, 0], duo: [1, 0.45, 0.1], duoAmt: 0, accent: 0,
};
export const GRADE_KEYS = Object.keys(GRADE_DEFAULT);

export const LOOKS = {
  none: { label: 'Original', sw: ['#3a3a44', '#8a8a96'] },
  vivid: { label: 'Vivid Anime', sw: ['#ff4d8d', '#4dd7ff'], contrast: 1.07, saturation: 1.12, exposure: 0.02, highlights: [0.01, 0.01, 0.02] },
  amber: { label: 'Amber Glow', sw: ['#2a0f00', '#ff9a2e'], contrast: 1.1, saturation: 1.15, temperature: 0.12, duo: [1, 0.55, 0.15], duoAmt: 0.3, highlights: [0.04, 0.02, -0.02] },
  blood: { label: 'Red Duotone', sw: ['#0a0000', '#ff1a1a'], contrast: 1.18, saturation: 1.1, exposure: 0.06, duo: [1, 0.12, 0.08], duoAmt: 0.62 },
  ice: { label: 'Ice Blue', sw: ['#020b1f', '#5cc8ff'], contrast: 1.12, saturation: 1.05, temperature: -0.15, duo: [0.25, 0.6, 1], duoAmt: 0.3 },
  pastel: { label: 'Pastel Pink', sw: ['#f9c5d5', '#c7d2fe'], contrast: 0.95, saturation: 1, fade: 0.12, exposure: 0.08, duo: [1, 0.66, 0.8], duoAmt: 0.18 },
  noir: { label: 'Noir', sw: ['#05070c', '#8aa0b8'], contrast: 1.2, saturation: 0.3, temperature: -0.1, shadows: [-0.01, 0, 0.03] },
  neon: { label: 'Neon Punch', sw: ['#00e5ff', '#ff2bd6'], contrast: 1.22, saturation: 1.3, tint: 0.05, shadows: [-0.02, 0.03, 0.08], highlights: [0.07, -0.02, 0.07] },
  crimson: { label: 'Crimson Phonk', sw: ['#1a0000', '#ff1e3c'], contrast: 1.32, saturation: 0.85, shadows: [0.05, -0.01, -0.01], highlights: [0.09, -0.03, -0.05], grain: 0.25 },
  faded: { label: 'Faded Memory', sw: ['#8ea3b8', '#d8cfc4'], contrast: 0.9, saturation: 0.72, fade: 0.28, temperature: -0.12, shadows: [0, 0.02, 0.05], grain: 0.15 },
  tealorange: { label: 'Teal & Orange', sw: ['#0f766e', '#fb923c'], contrast: 1.12, saturation: 1.1, shadows: [-0.03, 0.03, 0.06], highlights: [0.07, 0.02, -0.05] },
  dreamy: { label: 'Dreamy Glow', sw: ['#f9a8d4', '#c4b5fd'], contrast: 0.96, saturation: 1.15, fade: 0.1, exposure: 0.08, highlights: [0.05, 0, 0.06] },
  cold: { label: 'Midnight Blue', sw: ['#0b1d4d', '#7dd3fc'], temperature: -0.3, saturation: 0.9, contrast: 1.12, shadows: [-0.02, 0, 0.06] },
  sunset: { label: 'Golden Hour', sw: ['#f59e0b', '#ef4444'], temperature: 0.3, saturation: 1.15, contrast: 1.05, highlights: [0.06, 0.03, -0.02] },
  mono: { label: 'Manga Mono', sw: ['#000000', '#ffffff'], saturation: 0, contrast: 1.35 },
  // one-colour looks for pro edits (the whole edit in one palette, like the reference edits)
  violet: { label: 'Violet Duotone', sw: ['#12002b', '#b45cff'], contrast: 1.2, saturation: 1.15, exposure: 0.04, duo: [0.68, 0.32, 1], duoAmt: 0.55, highlights: [0.04, 0, 0.06] },
  jade: { label: 'Jade Night', sw: ['#001a14', '#2ee6a6'], contrast: 1.16, saturation: 1.1, duo: [0.2, 1, 0.66], duoAmt: 0.45, shadows: [-0.02, 0.02, 0.02] },
};

export function applyLookPreset(look, key) {
  const pre = LOOKS[key] || LOOKS.none;
  for (const k of GRADE_KEYS) look[k] = structuredClone(pre[k] ?? GRADE_DEFAULT[k]);
  if (pre.grain != null) look.grain = Math.max(look.grain || 0, pre.grain);
  look.preset = key;
}
