// "Song you'll add on Instagram": a tempo guide that stands in for a song you don't have
// as a file. It is a click track at the song's BPM (quiet ticks, then a full beat from the
// big moment on) plus a beat map built straight from the numbers, so the edit is cut
// exactly to that tempo. The guide plays in the preview but is never exported: you add the
// real song on Instagram and start it so its big moment lands on the edit's drop.
import { audioContext, peaksOf } from './analysis/audio.js';

const SR = 44100;

// deterministic noise so the guide sounds the same every time
function noise(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
}

function synth(bpm, introBars, bars) {
  const bd = 60 / bpm, drop = introBars * 4 * bd, dur = bars * 4 * bd + 1.5;
  const out = new Float32Array(Math.ceil(dur * SR));
  const rnd = noise(7);
  const add = (t, len, fn) => {
    const a = Math.round(t * SR), n = Math.round(len * SR);
    for (let i = 0; i < n && a + i < out.length; i++) out[a + i] += fn(i / SR);
  };
  // bright noise bursts: first difference of white noise ≈ high-passed
  const hiss = (decay, amp) => { let prev = 0; return (x) => { const w = rnd(); const v = w - prev; prev = w; return v * amp * Math.exp(-x * decay); }; };
  const tick = (t, amp) => add(t, 0.04, hiss(120, amp));
  const hat = (t, amp) => add(t, 0.06, hiss(70, amp));
  const clap = (t, amp) => { for (const o of [0, 0.011, 0.023]) add(t + o, 0.12, hiss(o ? 60 : 30, amp * 0.8)); };
  const crash = (t, amp) => add(t, 1.6, hiss(2.6, amp));
  const kick = (t, amp) => {
    let ph = 0;
    add(t, 0.35, (x) => { ph += (2 * Math.PI * (48 + 110 * Math.exp(-x * 32))) / SR; return Math.sin(ph) * amp * Math.exp(-x * 9); });
  };

  const nBeats = bars * 4;
  for (let k = 0; k < nBeats; k++) {
    const t = k * bd, down = k % 4 === 0;
    if (t < drop - 1e-6) {
      // intro: soft ticks, louder on each bar; the last bar doubles up into the drop
      tick(t, down ? 0.5 : 0.28);
      if (t >= drop - 4 * bd - 1e-6) tick(t + bd / 2, 0.2 + (0.25 * (t - (drop - 4 * bd))) / (4 * bd));
    } else {
      // from the big moment: four-on-the-floor kick, clap on 2 and 4, off-beat hats
      kick(t, 0.9);
      if (k % 2 === 1) clap(t, 0.45);
      hat(t + bd / 2, 0.22);
      if (Math.abs(t - drop) < 1e-6) crash(t, 0.35);
    }
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.8 / peak;
  return { samples: out, dur };
}

// The beat map the engine would have measured from the real song: beats on the tempo,
// a quiet intro, the drop at the big moment, an accent on every bar after it.
function analysisFor(bpm, introBars, bars, dur, title) {
  const bd = 60 / bpm, drop = introBars * 4 * bd;
  const beats = [];
  for (let k = 0; k <= bars * 4; k++) beats.push(Math.round(k * bd * 1000) / 1000);
  const hits = [{ t: drop, s: 0.95 }];
  for (let t = drop + 4 * bd; t < dur - 0.5; t += 4 * bd) hits.push({ t: Math.round(t * 1000) / 1000, s: 0.65 });
  const rate = 20;
  const energy = new Float32Array(Math.ceil(dur * rate));
  for (let i = 0; i < energy.length; i++) {
    const t = i / rate;
    energy[i] = t >= drop ? 0.8 : t >= drop - 4 * bd ? 0.3 + (0.25 * (t - (drop - 4 * bd))) / (4 * bd) : 0.3;
  }
  return {
    duration: dur,
    bpm,
    beatDur: bd,
    beats,
    beatStrength: beats.map((_, k) => (k % 4 === 0 ? 1 : 0.6)),
    downPhase: 0,
    drops: [{ t: drop, score: 1 }],
    mainDrop: drop,
    hits,
    sections: [{ start: 0, end: drop, level: 'low' }, { start: drop, end: dur, level: 'high' }],
    curveRate: rate,
    energy,
    onset: energy,
    // a steady, driving song: the auto style picks Glow for it
    features: { bpm, meanLoud: 0.5, bassiness: 0.45, hitRate: 2, dynamicRange: 0.25, brightness: 2000 },
    guide: { title, bpm, introBars, drop },
  };
}

// { title, bpm, introBars } → an audio media item ready to be the project's music.
export function makeGuideMedia({ title, bpm, introBars = 2 }, id) {
  bpm = Math.min(220, Math.max(50, Number(bpm) || 120));
  introBars = Math.min(8, Math.max(1, Math.round(introBars)));
  // long enough for a 60 s edit after the intro
  const bars = introBars + Math.ceil(64 / ((60 / bpm) * 4));
  const { samples, dur } = synth(bpm, introBars, bars);
  const buffer = audioContext().createBuffer(1, samples.length, SR);
  buffer.copyToChannel(samples, 0);
  const name = `${title || 'Instagram song'} · tempo guide`;
  return {
    id, name, kind: 'audio', file: null, url: null, duration: buffer.duration, w: 0, h: 0, status: 'ready', analysis: null,
    audio: { buffer, peaks: peaksOf(buffer), analysis: analysisFor(bpm, introBars, bars, dur, title || 'your song') },
    builtin: 'guide',
    guide: { title: title || 'your song', bpm, introBars, drop: introBars * 4 * (60 / bpm) },
  };
}
