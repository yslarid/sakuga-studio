// Scan footage for scene cuts, motion intensity, brightness and the horizontal
// centre of action (used for smart 9:16 reframing). Plays the video muted at
// high speed and samples presented frames into a tiny canvas.

const SW = 64; // analysis width in pixels

function once(el, ev, timeout = 15000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(ev + ' timeout')), timeout);
    el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('Video could not be decoded')); }, { once: true });
  });
}

export function loadVideoMeta(url) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
  return once(v, 'loadedmetadata').then(() => v);
}

export async function makeThumb(v, t, w = 160) {
  v.currentTime = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.05));
  await once(v, 'seeked');
  const h = Math.round((w * v.videoHeight) / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(v, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.7);
}

// Step through every frame and find the cuts exactly: the block layout of the picture jumps, or
// its whole brightness spread changes at once, well beyond the recent frame-to-frame changes.
async function exactCuts(v, dur, fps, g, SW, SH, top, bot, onProgress) {
  const n = Math.floor(dur * fps), rows = Math.max(1, bot - top + 1);
  const cuts = [], diffs = [], hdiffs = [], frames = [];
  let prev = null, prevH = null, last = -10;
  for (let i = 0; i < n; i++) {
    v.currentTime = Math.min(dur - 0.02, (i + 0.5) / fps);
    await once(v, 'seeked');
    g.drawImage(v, 0, 0, SW, SH);
    const d = g.getImageData(0, top, SW, rows).data;
    const blocks = new Float32Array(48), bn = new Float32Array(48), hist = new Float32Array(16);
    for (let y = 0; y < rows; y++) for (let x = 0; x < SW; x++) {
      const q = (y * SW + x) * 4, l = (d[q] * 54 + d[q + 1] * 183 + d[q + 2] * 19) >> 8;
      const b = Math.min(5, Math.floor((y * 6) / rows)) * 8 + Math.min(7, Math.floor((x * 8) / SW));
      blocks[b] += l; bn[b]++; hist[l >> 4] += 1 / (rows * SW);
    }
    for (let b = 0; b < 48; b++) blocks[b] /= Math.max(1, bn[b]);
    if (prev) {
      let bd = 0, hd = 0;
      for (let b = 0; b < 48; b++) bd += Math.abs(blocks[b] - prev[b]);
      for (let k = 0; k < 16; k++) hd += Math.abs(hist[k] - prevH[k]);
      bd /= 48 * 255; hd /= 2;
      const med = [...diffs.slice(-10)].sort((a, b) => a - b)[Math.min(diffs.length, 10) >> 1] || 0;
      const medH = [...hdiffs.slice(-10)].sort((a, b) => a - b)[Math.min(hdiffs.length, 10) >> 1] || 0;
      diffs.push(bd); hdiffs.push(hd);
      if (i - last >= 3 && (bd > Math.max(0.06, med * 3.5) || (hd > Math.max(0.3, medH * 4) && bd > Math.max(0.03, med * 2)))) { cuts.push(i / fps); last = i; }
    }
    prev = blocks; prevH = hist; frames.push(blocks);
    onProgress && i % 15 === 0 && onProgress(0.99);
  }
  // a flash or impact frames make a burst of "cuts" a few frames apart: treat each burst as one
  // event — no cut at all when the same shot is on both sides (a flash), else one cut where it starts
  const diff = (a, b) => { let s = 0; for (let k = 0; k < 48; k++) s += Math.abs(a[k] - b[k]); return s / (48 * 255); };
  const out = [];
  for (let k = 0; k < cuts.length;) {
    let e = k;
    while (e + 1 < cuts.length && cuts[e + 1] - cuts[e] < 0.25) e++;
    if (e === k) out.push(cuts[k]);
    else {
      const before = frames[Math.max(0, Math.round(cuts[k] * fps) - 2)], after = frames[Math.min(frames.length - 1, Math.round(cuts[e] * fps) + 2)];
      if (diff(before, after) > 0.05) out.push(cuts[k]);
    }
    k = e + 1;
  }
  return out;
}

export async function analyzeVideo(media, onProgress) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = media.url;
  await once(v, 'loadeddata');
  const dur = v.duration;
  const SH = Math.max(12, Math.round((SW * v.videoHeight) / v.videoWidth));
  const canvas = document.createElement('canvas');
  canvas.width = SW; canvas.height = SH;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 112; thumbCanvas.height = Math.round((112 * v.videoHeight) / v.videoWidth);
  const tg = thumbCanvas.getContext('2d');

  const samples = []; // { t, diff, hist, lum, sat, cx, conf }
  const hueHist = new Float32Array(24); // saturation-weighted hue histogram over the whole clip
  const rowLum = new Float32Array(SH); // per-row brightness over the clip: finds letterbox bands
  let rowFrames = 0;
  const thumbs = [];
  let prevLum = null, prevHist = null, prevBlocks = null, prevT = -1, lastThumb = -10;
  // 8×6 grid of block brightness: catches anime cuts where both shots share a palette
  const blockOf = new Uint8Array(SW * SH), blockN = new Float32Array(48);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    const b = Math.min(5, Math.floor((y * 6) / SH)) * 8 + Math.min(7, Math.floor((x * 8) / SW));
    blockOf[y * SW + x] = b;
    blockN[b]++;
  }

  const process = (t) => {
    if (t <= prevT + 1e-4) return;
    g.drawImage(v, 0, 0, SW, SH);
    const d = g.getImageData(0, 0, SW, SH).data;
    const n = SW * SH;
    const lum = new Uint8Array(n);
    const hist = new Float32Array(48);
    let lsum = 0, ssum = 0, skin = 0, hx = 0, hy = 0, hw = 0;
    const satCol = new Float32Array(SW);
    rowFrames++;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = d[p], gg = d[p + 1], b = d[p + 2];
      const l = (r * 54 + gg * 183 + b * 19) >> 8;
      lum[i] = l; lsum += l;
      rowLum[(i / SW) | 0] += l;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const sv = mx > 0 ? (mx - mn) / mx : 0;
      ssum += sv;
      satCol[i % SW] += sv;
      // anime skin: warm hue, light, moderately saturated — a big share means a face close-up
      if (mx > 140 && sv > 0.1 && sv < 0.55 && r >= gg && gg >= b && (r - b) > 25 && (gg - b) > (r - b) * 0.35) skin++;
      if (sv > 0.25 && mx > 40) {
        const dd = mx - mn;
        let h = mx === r ? ((gg - b) / dd) % 6 : mx === gg ? (b - r) / dd + 2 : (r - gg) / dd + 4;
        hueHist[Math.floor((((h * 60) + 360) % 360) / 15) % 24] += sv * mx;
        // this frame's colour as a hue vector (saturation-weighted), averaged over time later
        const ang = (h * Math.PI) / 3;
        hx += Math.cos(ang) * sv * mx; hy += Math.sin(ang) * sv * mx;
      }
      if (mx > 40) hw += mx;
      hist[r >> 4] += 1; hist[16 + (gg >> 4)] += 1; hist[32 + (b >> 4)] += 1;
    }
    // detail (line art / texture) per column: flat walls and blurry frames score low
    const edgeCol = new Float32Array(SW);
    let esum = 0;
    for (let y = 0; y < SH - 1; y++) {
      for (let x = 0; x < SW - 1; x++) {
        const i = y * SW + x;
        const e = Math.abs(lum[i + 1] - lum[i]) + Math.abs(lum[i + SW] - lum[i]);
        edgeCol[x] += e; esum += e;
      }
    }
    for (let i = 0; i < 48; i++) hist[i] /= n;
    const blocks = new Float32Array(48);
    for (let i = 0; i < n; i++) blocks[blockOf[i]] += lum[i];
    for (let b = 0; b < 48; b++) blocks[b] /= Math.max(1, blockN[b]);
    let diff = 0, hd = 0, bd = 0, cx = 0.5, conf = 0;
    const col = new Float32Array(SW);
    if (prevLum) {
      let tot = 0;
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          const i = y * SW + x;
          const a = Math.abs(lum[i] - prevLum[i]);
          col[x] += a; tot += a;
        }
      }
      diff = tot / n / 255;
      let num = 0;
      for (let x = 0; x < SW; x++) num += col[x] * (x + 0.5) / SW;
      if (tot > 0) cx = num / tot;
      conf = Math.min(1, diff * 25);
      for (let i = 0; i < 48; i++) hd += Math.abs(hist[i] - prevHist[i]);
      hd /= 6; // 0..1 (three channels, L1 distance up to 2 each)
      for (let b = 0; b < 48; b++) bd += Math.abs(blocks[b] - prevBlocks[b]);
      bd /= 48 * 255;
    }
    // where the subject probably is: 16-bin horizontal profile of detail + motion + colour
    const sal = new Float32Array(16);
    let salTot = 0;
    for (let x = 0; x < SW; x++) {
      const v2 = edgeCol[x] / (SH * 255) * 4 + col[x] / (SH * 255) * 6 + satCol[x] / SH * 0.4;
      sal[Math.min(15, Math.floor((x * 16) / SW))] += v2;
      salTot += v2;
    }
    for (let k = 0; k < 16; k++) sal[k] = salTot > 0 ? sal[k] / salTot : 1 / 16;
    samples.push({ t, diff, hd, bd, lum: lsum / n / 255, sat: ssum / n, edge: esum / n / 255, skin: skin / n, sal, cx, conf, hx: hw ? hx / hw : 0, hy: hw ? hy / hw : 0, bk: blocks });
    if (t - lastThumb >= 1) {
      tg.drawImage(v, 0, 0, thumbCanvas.width, thumbCanvas.height);
      thumbs.push({ t, url: thumbCanvas.toDataURL('image/jpeg', 0.6) });
      lastThumb = t;
    }
    prevLum = lum; prevHist = hist; prevBlocks = blocks; prevT = t;
  };

  const scanByPlayback = () => new Promise((resolve, reject) => {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return reject(new Error('no rVFC'));
    let lastFrameAt = performance.now();
    const rate = Math.min(16, Math.max(4, dur / 30));
    const cb = (now, meta) => {
      lastFrameAt = performance.now();
      process(meta.mediaTime);
      onProgress && onProgress(Math.min(0.99, meta.mediaTime / dur));
      if (!v.ended) v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
    v.addEventListener('ended', () => { clearInterval(watch); resolve(); }, { once: true });
    const watch = setInterval(() => {
      if (v.ended) { clearInterval(watch); resolve(); return; }
      if (performance.now() - lastFrameAt > 4000) {
        clearInterval(watch);
        if (samples.length > 10 && v.currentTime > dur * 0.9) resolve();
        else reject(new Error('stalled'));
      }
    }, 500);
    v.playbackRate = rate;
    v.play().then(() => { v.playbackRate = rate; }).catch(reject);
  });

  const scanBySeeking = async () => {
    samples.length = 0; thumbs.length = 0; prevLum = null; prevBlocks = null; prevT = -1; lastThumb = -10;
    rowLum.fill(0); rowFrames = 0;
    v.pause();
    // short clips (often finished edits that cut every half second) get a finer step
    const step = Math.max(dur < 60 ? 0.1 : 0.2, dur / 900);
    for (let t = 0; t < dur; t += step) {
      v.currentTime = t;
      await once(v, 'seeked');
      process(t);
      onProgress && onProgress(t / dur);
    }
  };

  try {
    await scanByPlayback();
    // a background tab can play the video through while delivering almost no frames
    if (samples.length < Math.min(240, dur * 8)) throw new Error(`only ${samples.length} frames sampled`);
  } catch (e) { console.warn('Playback scan failed, seeking instead:', e.message); await scanBySeeking(); }
  v.pause();
  // where the picture sits: rows that stay black all clip long are bands (16:9 framed in 9:16)
  let top = 0, bot = SH - 1;
  const lit = (y) => rowLum[y] / Math.max(1, rowFrames * SW) > 9;
  while (top < SH / 2 && !lit(top)) top++;
  while (bot > SH / 2 && !lit(bot)) bot--;
  // short clips (often finished edits that cut every half second): every cut, to the exact frame
  const exact = dur <= 40 ? await exactCuts(v, dur, media.fps || 30, g, SW, SH, top, bot, onProgress) : null;
  v.removeAttribute('src'); v.load();
  const out = finalize(samples, thumbs, dur);
  if (exact) {
    const b = [0, ...exact, dur];
    out.scenes = b.slice(0, -1).map((s, i) => ({ start: s, end: b[i + 1] }));
    out.cuts = exact;
  }
  out.box = { top: top / SH, bottom: (bot + 1) / SH };
  out.sampled = samples.length;
  const tot = hueHist.reduce((a, b) => a + b, 0) || 1;
  let hb = 0;
  for (let k = 1; k < 24; k++) if (hueHist[k] > hueHist[hb]) hb = k;
  out.hue = { h: hb * 15 + 7.5, dom: (hueHist[hb] + hueHist[(hb + 1) % 24] + hueHist[(hb + 23) % 24]) / tot };
  return out;
}

function finalize(samples, thumbs, dur) {
  const n = samples.length;
  if (n < 2) {
    return { scenes: [{ start: 0, end: dur }], grid: makeGrid([], dur), thumbs, cuts: [] };
  }
  // scene cuts: a block-brightness jump that is a local peak and well above the
  // local median (robust to fast action). Tuned against ffmpeg's scene detector on
  // 2D anime and CG footage: ~97% / ~71% of cuts found.
  const cutIdx = [];
  // letterboxed footage: blocks that never change (black bands) would dilute every cut, so
  // block jumps are measured over the live part of the picture only
  const lo = new Float32Array(48).fill(255), hi = new Float32Array(48);
  for (const x of samples) if (x.bk) for (let b = 0; b < 48; b++) { lo[b] = Math.min(lo[b], x.bk[b]); hi[b] = Math.max(hi[b], x.bk[b]); }
  const live = [];
  for (let b = 0; b < 48; b++) if (hi[b] - lo[b] > 12) live.push(b);
  // where each frame changed most violently (cubed block jumps): the contact point of a hit or flash
  samples.forEach((x, i) => {
    x.ix = 0.5; x.iy = 0.5;
    if (!i || !x.bk || !samples[i - 1].bk) return;
    let sw = 0, sx = 0, sy = 0;
    for (const b of live.length >= 4 ? live : [...Array(48).keys()]) {
      const w = Math.pow(Math.abs(x.bk[b] - samples[i - 1].bk[b]) / 255, 3);
      sw += w; sx += w * ((b % 8) + 0.5) / 8; sy += w * (Math.floor(b / 8) + 0.5) / 6;
    }
    if (sw > 1e-6) { x.ix = sx / sw; x.iy = sy / sw; }
  });
  const S = samples.map((x, i) => {
    if (!i || !x.bk || !samples[i - 1].bk || live.length < 4 || live.length === 48) return (x.bd || 0) * 2;
    let d = 0;
    for (const b of live) d += Math.abs(x.bk[b] - samples[i - 1].bk[b]);
    return (d / (live.length * 255)) * 2;
  });
  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push(samples[i].t - samples[i - 1].t);
  gaps.sort((a, b) => a - b);
  // densely sampled footage (short clips) shows cuts more cleanly: loosen the gate
  const dense = (gaps[gaps.length >> 1] || 0.25) < 0.15;
  const T = dense ? 0.15 : 0.21, K = dense ? 2 : 3;
  for (let i = 1; i < n; i++) {
    const nb = [];
    for (let j = Math.max(1, i - 10); j <= Math.min(n - 1, i + 10); j++) if (j !== i) nb.push(S[j]);
    nb.sort((x, y) => x - y);
    const med = nb[nb.length >> 1] || 0;
    const dev = nb.map((x) => Math.abs(x - med)).sort((x, y) => x - y);
    const mad = (dev[dev.length >> 1] || 0) * 1.4826 + 1e-3;
    const peak = S[i] >= S[i - 1] && (i + 1 >= n || S[i] >= S[i + 1]);
    if (peak && S[i] > Math.max(T, med + K * mad) && (!cutIdx.length || samples[i].t - samples[cutIdx[cutIdx.length - 1]].t > (dense ? 0.2 : 0.35))) cutIdx.push(i);
  }
  // scenes span the samples known to be inside them
  const scenes = [];
  let startI = 0;
  for (const ci of cutIdx) {
    scenes.push({ start: startI === 0 ? 0 : samples[startI].t, end: samples[ci - 1].t });
    startI = ci;
  }
  scenes.push({ start: startI === 0 ? 0 : samples[startI].t, end: dur });
  // motion: per-sample diff normalised by spacing, ignoring the cut samples themselves
  const cutSet = new Set(cutIdx);
  const dts = [];
  for (let i = 1; i < n; i++) dts.push(samples[i].t - samples[i - 1].t);
  dts.sort((a, b) => a - b);
  const medDt = dts[dts.length >> 1] || 0.1;
  const mot = samples.map((s, i) => {
    if (i === 0) return 0;
    const dt = s.t - samples[i - 1].t;
    return s.diff / Math.sqrt(Math.max(0.2, dt / medDt));
  });
  for (const ci of cutIdx) mot[ci] = ((mot[ci - 1] || 0) + (mot[ci + 1] || mot[ci - 1] || 0)) / 2;
  mot[0] = mot[1] || 0;
  const sorted = [...mot].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const edges = samples.map((s) => s.edge || 0).sort((a, b) => a - b);
  const e10 = edges[Math.floor(edges.length * 0.1)] || 0, e90 = edges[Math.floor(edges.length * 0.9)] || 1;
  const pts = samples.map((s, i) => ({
    t: s.t,
    m: Math.min(1, mot[i] / (p95 || 1)),
    l: s.lum,
    s: s.sat,
    f: s.skin || 0,
    e: Math.max(0, Math.min(1, ((s.edge || 0) - e10) / Math.max(1e-4, e90 - e10))),
    sal: s.sal,
    hx: s.hx || 0,
    hy: s.hy || 0,
    ix: s.ix ?? 0.5,
    iy: s.iy ?? 0.5,
    // how cut- or flash-like the change into this sample is (0..1)
    k: Math.max(0, Math.min(1, (Math.max(S[i], i ? Math.abs(s.lum - samples[i - 1].lum) * 2 : 0) - 0.12) / 0.2)),
    cx: cutSet.has(i) ? 0.5 : 0.5 + (s.cx - 0.5) * s.conf,
  }));
  return { scenes, grid: makeGrid(pts, dur), thumbs, cuts: cutIdx.map((i) => samples[i].t) };
}

// Resample onto a uniform 10 Hz grid with prefix sums for fast window means.
function makeGrid(pts, dur) {
  const rate = 10;
  const n = Math.max(1, Math.ceil(dur * rate));
  const motion = new Float32Array(n), lum = new Float32Array(n), cx = new Float32Array(n);
  const edge = new Float32Array(n), sat = new Float32Array(n), sal = new Float32Array(n * 16), spike = new Float32Array(n), skin = new Float32Array(n);
  const hx = new Float32Array(n), hy = new Float32Array(n), ix = new Float32Array(n).fill(0.5), iy = new Float32Array(n).fill(0.5);
  for (const q of pts) {
    const k = Math.min(n - 1, Math.max(0, Math.floor(q.t * rate)));
    if (q.k > spike[k]) spike[k] = q.k;
  }
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = k / rate;
    if (!pts.length) { motion[k] = 0.5; lum[k] = 0.5; cx[k] = 0.5; edge[k] = 0.5; sat[k] = 0.3; sal.fill(1 / 16, k * 16, k * 16 + 16); continue; }
    while (j < pts.length - 2 && pts[j + 1].t < t) j++;
    const a = pts[j], b = pts[Math.min(pts.length - 1, j + 1)];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    motion[k] = a.m + (b.m - a.m) * f;
    lum[k] = a.l + (b.l - a.l) * f;
    cx[k] = a.cx + (b.cx - a.cx) * f;
    edge[k] = a.e + (b.e - a.e) * f;
    sat[k] = a.s + (b.s - a.s) * f;
    skin[k] = a.f + (b.f - a.f) * f;
    // colour doesn't blend across a cut: take the nearer sample
    const near = f < 0.5 ? a : b;
    hx[k] = near.hx || 0; hy[k] = near.hy || 0;
    ix[k] = near.ix ?? 0.5; iy[k] = near.iy ?? 0.5;
    const src = (f < 0.5 ? a : b).sal;
    for (let q = 0; q < 16; q++) sal[k * 16 + q] = src ? src[q] : 1 / 16;
  }
  // smooth the action centre so reframing glides instead of jittering
  const cxs = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0;
    for (let q = Math.max(0, k - 8); q <= Math.min(n - 1, k + 8); q++) { s += cx[q]; c++; }
    cxs[k] = s / c;
  }
  const prefix = (arr) => { const p = new Float64Array(arr.length + 1); for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + arr[i]; return p; };
  return { rate, motion, lum, cx: cxs, edge, sat, sal, spike, skin, pm: prefix(motion), pl: prefix(lum), pc: prefix(cxs), pe: prefix(edge), ps: prefix(sat), pk: prefix(spike), pf: prefix(skin), phx: prefix(hx), phy: prefix(hy), hx, hy, ix, iy };
}

export function gridMean(grid, key, a, b) {
  const p = grid[key];
  const n = p.length - 1;
  const i = Math.max(0, Math.min(n, Math.floor(a * grid.rate)));
  const j = Math.max(i + 1, Math.min(n, Math.ceil(b * grid.rate)));
  if (j > n) return p[n] - p[n - 1];
  return (p[j] - p[i]) / (j - i);
}

// Average 16-bin horizontal subject profile over [a, b] seconds of source.
export function salProfile(grid, a, b) {
  const out = new Float32Array(16);
  if (!grid.sal) { out.fill(1 / 16); return out; }
  const n = grid.motion.length;
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(a * grid.rate)));
  const i1 = Math.max(i0, Math.min(n - 1, Math.ceil(b * grid.rate)));
  for (let k = i0; k <= i1; k++) for (let q = 0; q < 16; q++) out[q] += grid.sal[k * 16 + q];
  const c = i1 - i0 + 1;
  for (let q = 0; q < 16; q++) out[q] /= c;
  return out;
}

// Best horizontal crop centre for a window of width w (0..1 of source width):
// the position that keeps the most subject inside, with a gentle pull to centre.
export function bestCropCenter(profile, w) {
  if (w >= 0.999) return { c: 0.5, cover: 1 };
  let best = 0.5, bestV = -1, cover = 0;
  for (let i = 0; i <= 48; i++) {
    const c = w / 2 + ((1 - w) * i) / 48;
    const lo = (c - w / 2) * 16, hi = (c + w / 2) * 16;
    let v = 0;
    for (let q = 0; q < 16; q++) v += profile[q] * Math.max(0, Math.min(q + 1, hi) - Math.max(q, lo));
    const score = v - Math.abs(c - 0.5) * 0.08;
    if (score > bestV) { bestV = score; best = c; cover = v; }
  }
  return { c: best, cover };
}
