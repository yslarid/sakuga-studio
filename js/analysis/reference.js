// "Match a reference edit": measure an edit you like (pacing, colour, flashes,
// layout, length) and turn the measurements into a style the engine can follow.

const W = 64;

function once(el, ev, timeout = 15000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(ev + ' timeout')), timeout);
    el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('This reference video could not be decoded')); }, { once: true });
  });
}

function rgbToHue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-6) return -1;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

function hueToRgb(h) {
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  const [r, g, b] = h < 60 ? [1, x, 0] : h < 120 ? [x, 1, 0] : h < 180 ? [0, 1, x] : h < 240 ? [0, x, 1] : h < 300 ? [x, 0, 1] : [1, 0, x];
  return [r, g, b];
}

// Scan the reference by seeking (reference edits are short) and collect stats.
export async function analyzeReference(file, onProgress) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await once(v, 'loadeddata');
  const dur = v.duration;
  const H = Math.max(16, Math.round((W * v.videoHeight) / v.videoWidth));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  const step = Math.min(1 / 8, dur / 240);
  const S = [];
  let prevBlocks = null, prevLum = null;
  const hue = new Float32Array(24);
  const shadow = [0, 0, 0, 0], high = [0, 0, 0, 0];
  let edgeSum = 0, edgeN2 = 0, lumSum = 0, lum2 = 0, satSum = 0, brightSat = 0, centre = 0, centreN = 0, edgeL = 0, edgeN = 0, pix = 0;
  const rowLum = new Float32Array(H);
  for (let t = 0.02, i = 0; t < dur - 0.02; t += step, i++) {
    v.currentTime = t;
    await once(v, 'seeked');
    g.drawImage(v, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const blocks = new Float32Array(48), bn = new Float32Array(48);
    let fl = 0;
    // detail density on the same scale as the footage scanner (wide shots score high)
    const L8 = new Uint8Array(W * H);
    for (let q = 0, p2 = 0; q < W * H; q++, p2 += 4) L8[q] = (d[p2] * 54 + d[p2 + 1] * 183 + d[p2 + 2] * 19) >> 8;
    let es = 0;
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) { const q = y * W + x; es += Math.abs(L8[q + 1] - L8[q]) + Math.abs(L8[q + W] - L8[q]); }
    edgeSum += es / (W * H) / 255; edgeN2++;
    for (let y = 0, p = 0; y < H; y++) {
      for (let x = 0; x < W; x++, p += 4) {
        const r = d[p] / 255, gg = d[p + 1] / 255, b = d[p + 2] / 255;
        const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        const s = mx > 0 ? (mx - mn) / mx : 0;
        lumSum += l; lum2 += l * l; satSum += s; pix++; fl += l;
        rowLum[y] += l;
        const bi = Math.min(5, Math.floor((y * 6) / H)) * 8 + Math.min(7, Math.floor((x * 8) / W));
        blocks[bi] += l; bn[bi]++;
        const h = rgbToHue(r, gg, b);
        if (h >= 0) hue[Math.floor(h / 15) % 24] += s * mx;
        if (l < 0.3) { shadow[0] += r; shadow[1] += gg; shadow[2] += b; shadow[3]++; }
        if (l > 0.6) { high[0] += r; high[1] += gg; high[2] += b; high[3]++; if (l > 0.85) brightSat++; }
        const cxn = (x + 0.5) / W - 0.5, cyn = (y + 0.5) / H - 0.5;
        const rr = Math.sqrt(cxn * cxn + cyn * cyn);
        if (rr < 0.2) { centre += l; centreN++; } else if (rr > 0.45) { edgeL += l; edgeN++; }
      }
    }
    for (let k = 0; k < 48; k++) blocks[k] /= Math.max(1, bn[k]);
    fl /= W * H;
    let bd = 0;
    if (prevBlocks) for (let k = 0; k < 48; k++) bd += Math.abs(blocks[k] - prevBlocks[k]);
    S.push({ t, bd: (bd / 48) * 2, lum: fl, flash: prevLum != null && fl - prevLum > 0.25 });
    prevBlocks = blocks; prevLum = fl;
    onProgress && onProgress(t / dur);
  }
  v.removeAttribute('src'); v.load();
  URL.revokeObjectURL(url);

  // cuts: same block-brightness rule as the footage scanner (dense sampling)
  const cuts = [];
  for (let i = 1; i < S.length; i++) {
    const nb = [];
    for (let j = Math.max(1, i - 10); j <= Math.min(S.length - 1, i + 10); j++) if (j !== i) nb.push(S[j].bd);
    nb.sort((a, b) => a - b);
    const med = nb[nb.length >> 1] || 0;
    const mad = ([...nb].map((x) => Math.abs(x - med)).sort((a, b) => a - b)[nb.length >> 1] || 0) * 1.4826 + 1e-3;
    const peak = S[i].bd >= S[i - 1].bd && (i + 1 >= S.length || S[i].bd >= S[i + 1].bd);
    if (peak && S[i].bd > Math.max(0.15, med + 2 * mad) && (!cuts.length || S[i].t - cuts[cuts.length - 1] > 0.25)) cuts.push(S[i].t);
  }
  const bounds = [0, ...cuts, dur];
  const shots = [];
  for (let i = 1; i < bounds.length; i++) shots.push(bounds[i] - bounds[i - 1]);
  const sorted = [...shots].sort((a, b) => a - b);
  const flashes = S.filter((x) => x.flash).length;

  // black bands top/bottom → framed layout
  for (let y = 0; y < H; y++) rowLum[y] /= W * S.length;
  let top = 0, bot = 0;
  while (top < H / 2 && rowLum[top] < 0.035) top++;
  while (bot < H / 2 && rowLum[H - 1 - bot] < 0.035) bot++;
  const contentH = (H - top - bot) / H;

  const lumMean = lumSum / pix;
  const hueTotal = hue.reduce((a, b) => a + b, 0) || 1;
  let domBin = 0;
  for (let k = 1; k < 24; k++) if (hue[k] > hue[domBin]) domBin = k;
  // dominance of the strongest hue family (±1 bin)
  const dom = (hue[domBin] + hue[(domBin + 1) % 24] + hue[(domBin + 23) % 24]) / hueTotal;
  return {
    name: file.name,
    duration: dur,
    cuts,
    shotMedian: sorted[sorted.length >> 1] || dur,
    shotP25: sorted[Math.floor(sorted.length * 0.25)] || dur,
    shotP75: sorted[Math.floor(sorted.length * 0.75)] || dur,
    flashRate: flashes / dur,
    lum: lumMean,
    lumStd: Math.sqrt(Math.max(0, lum2 / pix - lumMean * lumMean)),
    sat: satSum / pix,
    hue: domBin * 15 + 7.5,
    hueDominance: dom,
    shadowTint: shadow[3] ? [shadow[0] / shadow[3], shadow[1] / shadow[3], shadow[2] / shadow[3]] : [0, 0, 0],
    highTint: high[3] ? [high[0] / high[3], high[1] / high[3], high[2] / high[3]] : [1, 1, 1],
    bright: brightSat / pix,
    edge: edgeN2 ? edgeSum / edgeN2 : 0,
    vignette: centre > 0 && edgeN ? Math.max(0, 1 - (edgeL / edgeN) / (centre / centreN)) : 0,
    framed: top + bot > H * 0.12 ? contentH : 1,
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Turn reference measurements into an engine style. `footage` gives the average
// brightness/saturation of your clips so the grade moves them toward the reference.
export function styleFromReference(R, footage) {
  const med = clamp(R.shotMedian, 0.35, 3);
  // follow the reference's own pacing closely; our song's energy only nudges it
  const shot = { low: clamp(med * 1.1, 0.4, 4), mid: med, high: clamp(med * 0.85, 0.3, 3) };
  const tint = (c) => {
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] || 1e-3;
    return c.map((x) => clamp((x / l - 1) * 0.06, -0.08, 0.08));
  };
  const fLum = footage.lum || 0.4, fSat = footage.sat || 0.35;
  // a strongly coloured scene (e.g. blue night) keeps its own hue instead of the reference's
  const hueGap = footage.hue ? Math.min(Math.abs(footage.hue.h - R.hue), 360 - Math.abs(footage.hue.h - R.hue)) : 0;
  const keepHue = !!(footage.hue && footage.hue.dom > 0.35 && hueGap > 60);
  const look = {
    preset: 'match',
    // the reference is dark or bright partly because of what it shows; move toward it gently
    exposure: clamp(Math.log2(R.lum / fLum) * 0.5, -0.35, 0.3),
    contrast: clamp(0.85 + R.lumStd * 1.4, 0.9, 1.35),
    saturation: clamp(R.sat / fSat, 0.5, 1.5),
    temperature: 0, tint: 0, fade: 0,
    shadows: tint(R.shadowTint),
    highlights: tint(R.highTint),
    duo: hueToRgb(keepHue ? footage.hue.h : R.hue),
    duoAmt: R.hueDominance > 0.45 ? clamp((R.hueDominance - 0.35) * 0.6, 0, keepHue ? 0.18 : 0.28) : 0,
  };
  const calm = R.flashRate < 0.15;
  const fast = med < 0.6;
  const rec = ['cuts', 'grade', 'finish', 'motionblur', 'reframe', 'fadeout', 'sfx'];
  rec.push(calm ? 'slowzoom' : 'drops');
  if (!calm) rec.push('burst', 'actionhits', 'fxboost');
  if (fast) rec.push('beatzoom', 'shakes');
  if (!calm && R.flashRate > 0.6) rec.push('strobe');
  if (!fast && med < 1.6) rec.push('velocity');
  // content height as a fraction of a 9:16 frame: 16:9 ≈ 0.32, 1:1 ≈ 0.56, 4:5 ≈ 0.7
  const framedKey = R.framed < 0.9 ? (R.framed > 0.63 ? 'framed-4:5' : R.framed > 0.44 ? 'framed-1:1' : 'framed-16:9') : null;
  if (framedKey) rec.push('matchlayout');
  return {
    label: `Match: ${R.name.replace(/\.[^.]+$/, '').slice(0, 22)}`,
    shot,
    buildup: fast ? 'normal' : null,
    look: null,
    matchLook: look,
    kit: calm ? 'soft' : 'full',
    finish: {
      glow: clamp(0.2 + R.bright * 6, 0.2, 0.6), glowThreshold: 0.66,
      vignette: clamp(R.vignette, 0.1, 0.6), grain: 0.04, sharpen: 0.4,
    },
    motionBlur: 0.5,
    transitions: ['zoomblur'],
    transitionEvery: 0,
    rec,
    drift: calm,
    layout: framedKey,
    length: R.duration,
    ref: R,
  };
}
