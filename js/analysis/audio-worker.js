// Music analysis worker: onset envelope, tempo, beat tracking, downbeats,
// energy curve, drops, hits and energy sections. Runs off the main thread.

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  try {
    const result = analyze(samples, sampleRate);
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};

const progress = (v) => self.postMessage({ type: 'progress', value: v });

// ---------- math helpers ----------
function fftInit(N) {
  const bits = Math.log2(N);
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / N);
    sin[i] = Math.sin((-2 * Math.PI * i) / N);
  }
  return { N, rev, cos, sin };
}

function fft(T, re, im) {
  const { N, rev, cos, sin } = T;
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step, a = i + j, b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k];
        const ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

function movingAvg(x, w) {
  const n = x.length, out = new Float32Array(n);
  const h = Math.max(1, Math.floor(w / 2));
  let s = 0, c = 0;
  for (let i = 0; i < Math.min(n, h); i++) { s += x[i]; c++; }
  for (let i = 0; i < n; i++) {
    const add = i + h, rem = i - h - 1;
    if (add < n) { s += x[add]; c++; }
    if (rem >= 0) { s -= x[rem]; c--; }
    out[i] = s / c;
  }
  return out;
}

function percentile(x, p) {
  const a = Array.from(x).sort((m, n) => m - n);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}

function normalizeBy(x, v) {
  const out = new Float32Array(x.length);
  const d = v > 1e-9 ? v : 1;
  for (let i = 0; i < x.length; i++) out[i] = Math.min(1.5, x[i] / d);
  return out;
}

function meanRange(x, a, b) {
  a = Math.max(0, Math.floor(a)); b = Math.min(x.length, Math.ceil(b));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i];
  return s / (b - a);
}

// ---------- main analysis ----------
function analyze(x, sr) {
  const N = 1024, H = 256;
  const fps = sr / H;
  const nF = Math.max(8, Math.floor((x.length - N) / H) + 1);
  const duration = x.length / sr;
  const T = fftInit(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  // log-spaced bands from 40 Hz to 10 kHz
  const NB = 40, edges = [];
  for (let b = 0; b <= NB; b++) {
    const f = 40 * Math.pow(10000 / 40, b / NB);
    let k = Math.max(1, Math.round((f / sr) * N));
    if (b > 0 && k <= edges[b - 1]) k = edges[b - 1] + 1;
    edges.push(Math.min(N / 2, k));
  }
  let lowBands = 0;
  for (let b = 0; b < NB; b++) if ((edges[b + 1] * sr) / N <= 170) lowBands = b + 1;
  lowBands = Math.max(2, lowBands);
  const bassBin = Math.max(2, Math.round((150 / sr) * N));

  const flux = new Float32Array(nF), lowFlux = new Float32Array(nF);
  const rms = new Float32Array(nF), bass = new Float32Array(nF), centroid = new Float32Array(nF);
  let prev = new Float32Array(NB), cur = new Float32Array(NB);
  const re = new Float32Array(N), im = new Float32Array(N);

  for (let f = 0; f < nF; f++) {
    const o = f * H;
    let e = 0;
    for (let i = 0; i < N; i++) {
      const v = x[o + i] || 0;
      e += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e / N);
    fft(T, re, im);
    let bs = 0, cNum = 0, cDen = 0;
    for (let k = 1; k < N / 2; k++) {
      const m2 = re[k] * re[k] + im[k] * im[k];
      if (k <= bassBin) bs += m2;
      const m = Math.sqrt(m2);
      cNum += k * m; cDen += m;
    }
    bass[f] = Math.sqrt(bs);
    centroid[f] = cDen > 0 ? ((cNum / cDen) * sr) / N : 0;
    let fl = 0, lf = 0;
    for (let b = 0; b < NB; b++) {
      let s = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) s += re[k] * re[k] + im[k] * im[k];
      cur[b] = Math.log1p(10 * Math.sqrt(s / Math.max(1, edges[b + 1] - edges[b])));
      const d = cur[b] - prev[b];
      if (d > 0) { fl += d; if (b < lowBands) lf += d; }
    }
    flux[f] = f === 0 ? 0 : fl;
    lowFlux[f] = f === 0 ? 0 : lf;
    const t = prev; prev = cur; cur = t;
    if (f % 2000 === 0) progress((f / nF) * 0.55);
  }

  const frameTime = (f) => (f * H + N / 2) / sr;

  // onset envelope, detrended
  const fluxMA = movingAvg(flux, Math.round(fps * 0.5));
  const od = new Float32Array(nF);
  for (let i = 0; i < nF; i++) od[i] = Math.max(0, flux[i] - fluxMA[i]);
  const odN = normalizeBy(od, percentile(od, 0.99));
  const lowMA = movingAvg(lowFlux, Math.round(fps * 0.5));
  const lowOd = new Float32Array(nF);
  for (let i = 0; i < nF; i++) lowOd[i] = Math.max(0, lowFlux[i] - lowMA[i]);
  const lowN = normalizeBy(lowOd, percentile(lowOd, 0.99));
  progress(0.6);

  // ---------- tempo ----------
  const minLag = Math.max(2, Math.floor((fps * 60) / 200));
  const maxLag = Math.min(nF - 2, Math.ceil((fps * 60) / 60));
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < nF; i++) s += od[i] * od[i + lag];
    ac[lag] = s / (nF - lag);
  }
  let bestLag = minLag, bestVal = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const v = ac[lag] * w;
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }
  let lagF = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
    const den = a - 2 * b + c;
    if (Math.abs(den) > 1e-12) lagF = bestLag + (0.5 * (a - c)) / den;
  }
  let bpm = (60 * fps) / lagF;
  while (bpm < 70) bpm *= 2;
  while (bpm > 190) bpm /= 2;
  const period = (60 * fps) / bpm;
  progress(0.68);

  // ---------- beat tracking (dynamic programming) ----------
  let sd = 0, mean = 0;
  for (let i = 0; i < nF; i++) mean += od[i];
  mean /= nF;
  for (let i = 0; i < nF; i++) sd += (od[i] - mean) * (od[i] - mean);
  sd = Math.sqrt(sd / nF) || 1;
  const local = new Float32Array(nF);
  const gs = Math.max(1, period / 32);
  const gw = Math.ceil(gs * 3);
  for (let i = 0; i < nF; i++) {
    let s = 0, ws = 0;
    for (let k = -gw; k <= gw; k++) {
      const j = i + k;
      if (j < 0 || j >= nF) continue;
      const w = Math.exp(-0.5 * (k / gs) * (k / gs));
      s += (od[j] / sd) * w; ws += w;
    }
    local[i] = s / ws;
  }
  const cum = new Float32Array(nF), back = new Int32Array(nF).fill(-1);
  const tight = 100;
  const lo = Math.round(period * 2), hi = Math.max(1, Math.round(period / 2));
  for (let i = 0; i < nF; i++) {
    let best = -Infinity, bi = -1;
    for (let j = Math.max(0, i - lo); j <= i - hi; j++) {
      const l = Math.log((i - j) / period);
      const s = cum[j] - tight * l * l;
      if (s > best) { best = s; bi = j; }
    }
    cum[i] = local[i] + (bi >= 0 ? best : 0);
    back[i] = bi;
  }
  let endI = nF - 1, endBest = -Infinity;
  for (let i = Math.max(0, nF - Math.round(period * 2)); i < nF; i++) {
    if (cum[i] > endBest) { endBest = cum[i]; endI = i; }
  }
  let beatFrames = [];
  for (let i = endI; i >= 0; i = back[i]) beatFrames.push(i);
  beatFrames.reverse();
  // trim weak beats at the edges
  if (beatFrames.length > 4) {
    let sq = 0;
    for (const b of beatFrames) sq += local[b] * local[b];
    const thr = 0.5 * Math.sqrt(sq / beatFrames.length);
    while (beatFrames.length > 4 && local[beatFrames[0]] < thr) beatFrames.shift();
    while (beatFrames.length > 4 && local[beatFrames[beatFrames.length - 1]] < thr) beatFrames.pop();
  }
  // extend the grid through quiet intros/outros so edits can still cut there
  const beatDur = 60 / bpm;
  let beats = beatFrames.map(frameTime);
  if (beats.length >= 2) {
    const first = [];
    for (let t = beats[0] - beatDur; t > 0.05; t -= beatDur) first.unshift(t);
    const last = [];
    for (let t = beats[beats.length - 1] + beatDur; t < duration - 0.05; t += beatDur) last.push(t);
    beats = first.concat(beats, last);
  } else {
    beats = [];
    for (let t = 0; t < duration; t += beatDur) beats.push(t);
  }
  const beatStrength = beats.map((t) => {
    const f = Math.round((t * sr - N / 2) / H);
    let m = 0;
    for (let k = -2; k <= 2; k++) m = Math.max(m, odN[f + k] || 0);
    return Math.round(m * 1000) / 1000;
  });
  progress(0.78);

  // ---------- energy ----------
  const rmsS = movingAvg(rms, Math.round(fps * 0.4));
  const bassS = movingAvg(bass, Math.round(fps * 0.4));
  const eN = normalizeBy(rmsS, percentile(rmsS, 0.95));
  const bN = normalizeBy(bassS, percentile(bassS, 0.95));
  const loud = new Float32Array(nF);
  for (let i = 0; i < nF; i++) loud[i] = Math.min(1, 0.55 * eN[i] + 0.45 * bN[i]);
  const toF = (t) => (t * sr - N / 2) / H;

  // ---------- downbeat phase ----------
  let downPhase = 0, dpBest = -1;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    for (let i = ph; i < beats.length; i += 4) {
      const f = Math.round(toF(beats[i]));
      s += (lowN[f] || 0) + 0.5 * (odN[f] || 0);
    }
    if (s > dpBest) { dpBest = s; downPhase = ph; }
  }

  // ---------- drops ----------
  const cands = [];
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i];
    if (t < 2 || t > duration - 2) continue; // need real audio on both sides of a drop
    const f = toF(t);
    const before = meanRange(loud, f - 2.5 * fps, f - 0.15 * fps);
    const after = meanRange(loud, f + 0.05 * fps, f + 2.5 * fps);
    const jump = after - before;
    if (jump < 0.12 || after < 0.45 || after < before * 1.25) continue;
    const isDown = (i - downPhase) % 4 === 0;
    const score = jump * (isDown ? 1.15 : 1) * (1 + 0.3 * (lowN[Math.round(f)] || 0));
    cands.push({ t, score, i });
  }
  cands.sort((a, b) => b.score - a.score);
  const drops = [];
  for (const c of cands) {
    if (drops.some((d) => Math.abs(d.t - c.t) < 6)) continue;
    drops.push(c);
  }
  const strongest = drops.length ? drops[0].score : 0;
  const keptDrops = drops.filter((d) => d.score >= strongest * 0.45).sort((a, b) => a.t - b.t);
  const mainDrop = drops.length ? drops[0].t : null;
  // drops almost always land on a downbeat: re-anchor the bar grid there
  if (mainDrop != null) {
    let bi = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - mainDrop) < Math.abs(beats[bi] - mainDrop)) bi = i;
    downPhase = bi % 4;
  }
  progress(0.86);

  // ---------- hits (strong onsets) ----------
  const hits = [];
  const win2 = Math.round(fps * 0.12);
  let lastHit = -1;
  for (let i = 1; i < nF - 1; i++) {
    const v = odN[i];
    if (v < 0.45) continue;
    let isMax = true;
    for (let k = -win2; k <= win2; k++) {
      if (k !== 0 && (odN[i + k] || 0) > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    const t = frameTime(i);
    if (lastHit >= 0 && t - lastHit < 0.18) continue;
    hits.push({ t: Math.round(t * 1000) / 1000, s: Math.round(Math.min(1, v) * 1000) / 1000 });
    lastHit = t;
  }

  // ---------- sections by bar ----------
  const bars = [];
  const firstDown = beats.length ? downPhase : 0;
  for (let i = firstDown; i + 4 <= beats.length; i += 4) {
    const a = beats[i], b = i + 4 < beats.length ? beats[i + 4] : Math.min(duration, a + 4 * beatDur);
    bars.push({ start: a, end: b, v: meanRange(loud, toF(a), toF(b)) });
  }
  let sections = [];
  if (bars.length) {
    const vals = bars.map((b) => b.v);
    const p10 = percentile(vals, 0.1), p90 = percentile(vals, 0.9);
    const range = p90 - p10;
    for (const b of bars) {
      let level;
      if (range < 0.15) level = b.v > 0.55 ? 'high' : b.v < 0.25 ? 'low' : 'mid';
      else {
        const rel = (b.v - p10) / range;
        level = rel > 0.62 ? 'high' : rel < 0.3 ? 'low' : 'mid';
      }
      const lastSec = sections[sections.length - 1];
      if (lastSec && lastSec.level === level) lastSec.end = b.end;
      else sections.push({ start: b.start, end: b.end, level });
    }
    // absorb sections shorter than 2 bars into their neighbour
    const minLen = beatDur * 8 - 0.05;
    let changed = true;
    while (changed && sections.length > 1) {
      changed = false;
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        if (s.end - s.start >= minLen) continue;
        const nb = i > 0 ? sections[i - 1] : sections[i + 1];
        if (i > 0) nb.end = s.end; else nb.start = s.start;
        sections.splice(i, 1);
        changed = true;
        break;
      }
      for (let i = sections.length - 1; i > 0; i--) {
        if (sections[i].level === sections[i - 1].level) {
          sections[i - 1].end = sections[i].end;
          sections.splice(i, 1);
        }
      }
    }
    sections[0].start = 0;
    sections[sections.length - 1].end = duration;
    // snap section boundaries onto nearby drops so the energy change hits exactly on the drop
    for (let i = 1; i < sections.length; i++) {
      const s = sections[i];
      const d = keptDrops.find((dd) => Math.abs(dd.t - s.start) < beatDur * 4.1);
      if (d && d.t > sections[i - 1].start + beatDur && d.t < s.end - beatDur) {
        sections[i - 1].end = d.t;
        s.start = d.t;
      }
    }
  } else {
    sections = [{ start: 0, end: duration, level: 'mid' }];
  }

  // ---------- curves downsampled to 20 Hz for UI/engine ----------
  const rate = 20;
  const nC = Math.ceil(duration * rate);
  const energy = new Array(nC), onset = new Array(nC);
  for (let k = 0; k < nC; k++) {
    const f = Math.round(toF(k / rate));
    const a = Math.max(0, f - 2), b = Math.min(nF - 1, f + 2);
    let ev = 0, ov = 0;
    for (let j = a; j <= b; j++) { ev = Math.max(ev, loud[j]); ov = Math.max(ov, odN[j]); }
    energy[k] = Math.round(ev * 1000) / 1000;
    onset[k] = Math.round(Math.min(1, ov) * 1000) / 1000;
  }

  // ---------- mood features ----------
  let cSum = 0, cCnt = 0, lSum = 0, bSum = 0, eSum = 0;
  for (let i = 0; i < nF; i++) {
    if (rms[i] > 0.01) { cSum += centroid[i]; cCnt++; }
    lSum += loud[i]; bSum += bN[i]; eSum += eN[i];
  }
  const features = {
    bpm: Math.round(bpm * 10) / 10,
    meanLoud: lSum / nF,
    dynamicRange: percentile(loud, 0.9) - percentile(loud, 0.1),
    hitRate: hits.length / Math.max(1, duration),
    brightness: cCnt ? cSum / cCnt : 0,
    bassiness: bSum / Math.max(1e-6, bSum + eSum),
  };
  progress(1);

  return {
    duration,
    bpm: features.bpm,
    beatDur,
    beats: beats.map((t) => Math.round(t * 1000) / 1000),
    beatStrength,
    downPhase,
    drops: keptDrops.map((d) => ({ t: Math.round(d.t * 1000) / 1000, score: Math.round(d.score * 1000) / 1000 })),
    mainDrop: mainDrop == null ? null : Math.round(mainDrop * 1000) / 1000,
    hits,
    sections,
    curveRate: rate,
    energy,
    onset,
    features,
  };
}
