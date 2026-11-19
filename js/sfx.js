// Sound-effect library (sfx/manifest.json): lazy decoding, previews, picking by
// tag, and scheduling project SFX into an (Offline)AudioContext.
import { audioContext } from './analysis/audio.js';

let manifest = null;
const buffers = new Map();
const pending = new Map();
let previewNode = null;

// The library is the Pepper pack plus the packs added later (catalog-new.json), merged.
export async function loadSfxManifest() {
  const all = { packs: [], sounds: [] };
  for (const url of ['sfx/manifest.json', 'sfx/catalog-new.json']) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const m = await r.json();
      all.packs.push(...(m.packs || []));
      all.sounds.push(...(m.sounds || []));
    } catch (e) { /* missing or unreadable: skip it */ }
  }
  all.sounds.push(...SYNTH_SOUNDS);
  manifest = all;
  return manifest;
}

// Sounds the editor makes itself (no file, nothing to license): the riser into a drop, the sub-boom
// on it, the reverse swell into a slowed hero shot, cinematic whooshes for the hidden cuts and a
// trailer-style hit. `peak` is where each is loudest (the riser and swell build to their very end,
// a whoosh rushes past two thirds of the way through, the boom and the hit land at once).
const MADE = 'Made in the editor';
// (tuned against the designed whooshes of the VideoEditingSFX and MixClap packs, measured: those
// peak about 40% of the way through and ring on for half a second after, sit dark, around 300 Hz,
// with a good share of sub, and barely pan)
const WHOOSHES = [
  // name, length, where it peaks (0..1), band sweep start → peak → end (Hz), pan direction, sub weight
  ['deep', 0.95, 0.4, 90, 620, 120, 1, 0.5],
  ['air', 0.75, 0.42, 160, 1500, 260, -1, 0.3],
  ['heavy', 1.2, 0.38, 60, 430, 80, 1, 0.7],
  ['swish', 0.6, 0.45, 300, 2600, 500, -1, 0.12],
];
const SYNTH_SOUNDS = [
  { id: 'synth/riser', name: 'Riser (made in the editor)', cat: MADE, tags: ['riser', 'synth'], dur: 2.4, peak: 2.38, attack: 0, synth: 'riser' },
  { id: 'synth/boom', name: 'Sub boom (made in the editor)', cat: MADE, tags: ['impact', 'boom', 'synth'], dur: 1.6, peak: 0.02, attack: 0.004, synth: 'boom' },
  { id: 'synth/swell', name: 'Reverse swell (made in the editor)', cat: MADE, tags: ['swell', 'reverse', 'synth'], dur: 1.1, peak: 1.08, attack: 0, synth: 'swell' },
  ...WHOOSHES.map(([name, dur, pk], i) => ({ id: `synth/whoosh-${name}`, name: `Whoosh, ${name} (made in the editor)`, cat: MADE, tags: ['whoosh', 'transition', 'synth'], dur, peak: +(dur * pk).toFixed(3), attack: 0, synth: 'whoosh', v: i })),
  { id: 'synth/hit', name: 'Cinematic hit (made in the editor)', cat: MADE, tags: ['impact', 'hit', 'synth'], dur: 2.2, peak: 0.01, attack: 0.003, synth: 'hit' },
  { id: 'synth/wind', name: 'Soft wind (made in the editor)', cat: MADE, tags: ['wind', 'ambience', 'synth'], dur: 4, peak: 2, attack: 0, synth: 'wind' },
];

// A whoosh: noise through a broad band-pass that sweeps up as the sound rushes in and falls away
// after it passes (the doppler swoop), panned across as it goes by, with a little sub weight at the
// moment it passes. A hit: a bright crack and a low body falling in pitch, a short metallic ring and
// a dark room tail. Both stereo, peak-normalised.
function synthStereo(s, ctx) {
  const sr = ctx.sampleRate, n = Math.round(sr * s.dur), b = ctx.createBuffer(2, n, sr), L = b.getChannelData(0), R = b.getChannelData(1);
  let seed = 7919 + (s.v || 0) * 104729;
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };
  if (s.synth === 'whoosh') {
    const [, dur, pk, f0, f1, f2, dir, sub] = WHOOSHES[s.v];
    let lp = 0, bp = 0, body = 0, wl = 0, wr = 0, sph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, p = t / dur;
      const env = p < pk ? Math.pow(p / pk, 2.2) : Math.exp(((pk - p) / (1 - pk)) * 3.1);
      const fc = p < pk ? f0 * Math.pow(f1 / f0, Math.pow(p / pk, 1.6)) : f1 * Math.pow(f2 / f1, Math.min(1, (p - pk) / (1 - pk)) ** 0.7);
      const f = 2 * Math.sin((Math.PI * Math.min(fc, sr / 6)) / sr), x = noise();
      lp += f * bp; const hp = x - lp - 1.05 * bp; bp += f * hp;
      body += 0.04 * (x - body);
      // (a little noise of its own in each ear, for width)
      wl += 0.3 * (noise() - wl); wr += 0.3 * (noise() - wr);
      sph += (2 * Math.PI * (52 - 14 * Math.min(1, Math.max(0, p - pk + 0.1) * 3))) / sr;
      const thump = Math.sin(sph) * sub * Math.exp(-(((p - pk) / 0.12) ** 2));
      const core = (bp * 1.3 + body * 1.6) * env;
      const pan = 0.28 * Math.max(-1, Math.min(1, dir * ((p - pk) / 0.45))), a = ((pan + 1) * Math.PI) / 4;
      L[i] = Math.tanh(core * Math.cos(a) * 1.9 + wl * 0.06 * env + thump * 0.8);
      R[i] = Math.tanh(core * Math.sin(a) * 1.9 + wr * 0.06 * env + thump * 0.8);
    }
  } else {
    let bp = 0, lp = 0, hpPrev = 0, hpIn = 0, tail = 0, bph = 0;
    const f = 2 * Math.sin((Math.PI * 2300) / sr), partials = [233, 377, 611, 989];
    for (let i = 0; i < n; i++) {
      const t = i / sr, x = noise();
      lp += f * bp; const h = x - lp - 0.5 * bp; bp += f * h;
      const crackHp = 0.9 * (hpPrev + x - hpIn); hpIn = x; hpPrev = crackHp;
      bph += (2 * Math.PI * (46 + 74 * Math.exp(-t / 0.05))) / sr;
      tail += 0.02 * (x - tail);
      const crack = bp * Math.exp(-t / 0.012) * 1.2 + crackHp * Math.exp(-t / 0.045) * 0.5;
      const bodyS = Math.sin(bph) * Math.exp(-t / 0.36);
      let ringL = 0, ringR = 0;
      partials.forEach((fr, k) => { const e = Math.exp(-t / (0.9 - k * 0.15)) * 0.05; ringL += Math.sin(2 * Math.PI * fr * t) * e; ringR += Math.sin(2 * Math.PI * fr * 1.004 * t + k) * e; });
      const room = tail * Math.exp(-t / 0.8) * 2.2;
      L[i] = Math.tanh((crack + bodyS * 1.1 + ringL + room) * 1.3);
      R[i] = Math.tanh((crack + bodyS * 1.1 + ringR + room * 0.9) * 1.3);
    }
  }
  let mx = 1e-6;
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
  for (let i = 0; i < n; i++) {
    const edge = Math.min(1, i / (sr * 0.002), (n - 1 - i) / (sr * 0.006));
    L[i] *= (0.9 / mx) * edge; R[i] *= (0.9 / mx) * edge;
  }
  return b;
}

// A soft wind for ambience under a held shot: noise through a slowly wandering low band, gusting
// gently, each ear its own, fading in and out over a second.
function synthWind(ctx) {
  const sr = ctx.sampleRate, dur = 4, n = Math.round(sr * dur), b = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let seed = 4513 + ch * 7717, lp = 0, bp = 0;
    const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };
    for (let i = 0; i < n; i++) {
      const t = i / sr, gust = 0.55 + 0.3 * Math.sin(t * 1.3 + ch) + 0.15 * Math.sin(t * 3.7 + ch * 2);
      const fc = 380 + 260 * (0.5 + 0.5 * Math.sin(t * 0.9 + ch * 1.7)), f = 2 * Math.sin((Math.PI * fc) / sr);
      lp += f * bp; const hp = noise() - lp - 1.3 * bp; bp += f * hp;
      d[i] = bp * gust * Math.min(1, t, dur - t) * 0.6;
    }
  }
  let pk = 0;
  for (let ch = 0; ch < 2; ch++) for (const v of b.getChannelData(ch)) pk = Math.max(pk, Math.abs(v));
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= 0.7 / (pk || 1); }
  return b;
}

function synthBuffer(kind, ctx, s) {
  if (kind === 'whoosh' || kind === 'hit') return synthStereo(s, ctx);
  if (kind === 'wind') return synthWind(ctx);
  const sr = ctx.sampleRate, dur = { riser: 2.4, boom: 1.6, swell: 1.1 }[kind] || 1, n = Math.round(sr * dur);
  const b = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    // (the same noise in both ears with a little of each ear's own: wide, but not hollow)
    let seed = 9301, seed2 = 4999 + ch * 7919;
    const noise = () => { seed = (seed * 16807) % 2147483647; seed2 = (seed2 * 16807) % 2147483647; return ((seed / 2147483647) * 2 - 1) * 0.85 + ((seed2 / 2147483647) * 2 - 1) * 0.15; };
    let lp = 0, bp = 0, ph1 = 0, ph2 = 0, sub = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, p = t / dur;
      let v = 0;
      if (kind === 'riser') {
        // noise through a resonant band-pass sweeping up (faster at the end) but staying dark, two
        // detuned saws rising an octave under it and a low swell for weight, building to its last
        // sample (tuned against the packs' risers: about 330 Hz rising to 600, half their energy low)
        const fc = 150 * Math.pow(2600 / 150, p * p), f = 2 * Math.sin((Math.PI * fc) / sr);
        lp += f * bp; const hp = noise() - lp - 0.4 * bp; bp += f * hp;
        const f0 = 98 * Math.pow(2, p * p);
        ph1 += f0 / sr; ph2 += (f0 * 1.006) / sr;
        const saw = ((ph1 % 1) * 2 - 1 + (ph2 % 1) * 2 - 1) * 0.5;
        sub += 0.02 * (saw - sub);
        const low = Math.sin(2 * Math.PI * 49 * t) * 0.35;
        v = Math.tanh((bp * 1.1 + sub * 1.4 + low * p) * Math.pow(p, 1.9) * 1.6) * 0.9;
      } else if (kind === 'boom') {
        // a sine falling from 95 to 34 Hz, dying away, with a short soft click on the attack
        const ph = 2 * Math.PI * (34 * t + ((95 - 34) * 0.12) * (1 - Math.exp(-t / 0.12)));
        const click = t < 0.012 ? noise() * (1 - t / 0.012) * 0.35 : 0;
        lp += 0.08 * (click - lp);
        v = Math.tanh((Math.sin(ph) * Math.exp(-t / 0.42) + lp) * 1.8) / Math.tanh(1.8) * 0.95;
      } else {
        // a reverse swell: noise opening from dark to bright (250 Hz to 3.5 kHz) with a low swell
        // under it, rising to its end and cut short (the packs' reverses run about 200 Hz to 1 kHz)
        const fc = 250 * Math.pow(3500 / 250, p * p), f = 2 * Math.sin((Math.PI * fc) / sr);
        lp += f * bp; const hp2 = noise() - lp - 0.7 * bp; bp += f * hp2;
        const low = Math.sin(2 * Math.PI * (45 + 30 * p) * t) * 0.5;
        v = Math.tanh((bp * 1.4 + low) * Math.pow(p, 2.6) * 1.5) * 0.85;
      }
      // a few milliseconds of fade at each end, so nothing clicks
      const edge = Math.min(1, i / (sr * 0.002), (n - 1 - i) / (sr * 0.004));
      d[i] = v * edge;
    }
  }
  return b;
}

export const sfxManifest = () => manifest;
export const sfxById = (id) => (manifest ? manifest.sounds.find((s) => s.id === id) : null);
export const sfxBuffer = (id) => buffers.get(id);

export function loadSfx(id) {
  if (buffers.has(id)) return Promise.resolve(buffers.get(id));
  if (pending.has(id)) return pending.get(id);
  const s = sfxById(id);
  if (!s) return Promise.reject(new Error('Unknown sound ' + id));
  if (s.synth) { const b = synthBuffer(s.synth, audioContext(), s); buffers.set(id, b); return Promise.resolve(b); }
  const p = fetch(s.file)
    .then((r) => r.arrayBuffer())
    .then((ab) => audioContext().decodeAudioData(ab))
    .then((b) => { buffers.set(id, b); pending.delete(id); return b; });
  pending.set(id, p);
  return p;
}

export function preloadProjectSfx(project) {
  return Promise.all((project.sfx || []).map((x) => loadSfx(x.sound).catch(() => null)));
}

export async function previewSfx(id) {
  const b = await loadSfx(id);
  const ctx = audioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  if (previewNode) { try { previewNode.stop(); } catch (e) { /* done */ } }
  previewNode = ctx.createBufferSource();
  previewNode.buffer = b;
  previewNode.connect(ctx.destination);
  previewNode.start();
}

// Sounds with a tag, in a stable order; `i` rotates through them for variety.
export function pickSound(tag, i, filter) {
  if (!manifest) return null;
  const pool = manifest.sounds.filter((s) => s.tags.includes(tag) && (!filter || filter(s)));
  return pool.length ? pool[((i % pool.length) + pool.length) % pool.length] : null;
}

export function scheduleSfx(ctx, dest, project, fromT, when) {
  const nodes = [];
  // (an edit fading out takes its sound effects down with the picture: a wind still blowing when the
  // file ends is cut off mid-gust)
  const fo = (project.effects || []).find((e) => e.type === 'fadeout'), f0 = fo ? fo.start : Infinity, f1 = fo ? fo.start + (fo.params.len || fo.dur) : Infinity;
  for (const x of project.sfx || []) {
    const b = buffers.get(x.sound);
    // (`from`: played from that far into the file, the last second of a long riser into its hit)
    const off = Math.max(0, Math.min(b ? b.duration - 0.05 : 0, Number(x.from) || 0));
    if (!b || x.start + b.duration - off <= fromT) continue;
    const src = ctx.createBufferSource();
    src.buffer = b;
    const g = ctx.createGain();
    const v = x.vol ?? 0.7;
    g.gain.value = v;
    // (started inside the file, it fades in over 80 ms: a waveform picked up mid-swing clicks)
    if (off > 0 && x.start >= fromT) { g.gain.setValueAtTime(0, when + (x.start - fromT)); g.gain.linearRampToValueAtTime(v, when + (x.start - fromT) + 0.08); }
    if (x.start + b.duration - off > f0) {
      const k = (t) => v * Math.max(0, Math.min(1, (f1 - t) / Math.max(0.01, f1 - f0)));
      g.gain.setValueAtTime(k(Math.max(fromT, f0)), when + Math.max(0, f0 - fromT));
      g.gain.linearRampToValueAtTime(0, when + Math.max(0, f1 - fromT));
    }
    src.connect(g).connect(dest);
    src.start(when + Math.max(0, x.start - fromT), off + Math.max(0, fromT - x.start));
    nodes.push(src);
  }
  return nodes;
}
