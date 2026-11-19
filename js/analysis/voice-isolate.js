// Voice isolation for the voice lines woven into an edit: the character's words without the
// episode's own music under them (the song is the music now). Short-time Fourier analysis of the
// stereo footage audio around the line:
//   - centre: dialogue is mixed dead centre while a score is spread wide, so each frequency keeps
//     only as much as the two channels agree (their coherence);
//   - the score's spectrum is learned from the moments around the words where nobody speaks (the
//     quietest frames of the voice band), and taken back out of every frame (a Wiener-style gain
//     with a floor, smoothed over time so it doesn't warble);
//   - the voice's own band (90 Hz - 8 kHz) is kept, and between words the gain falls further so
//     no music bleeds through the gaps.
// Returns a mono AudioBuffer starting `pre` seconds before the line.

const N = 2048, HOP = 512;

function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export function isolateVoice(buffer, s0, s1, { pre = 0.12, post = 0.3, margin = 1.2 } = {}) {
  const sr = buffer.sampleRate, chL = buffer.getChannelData(0), chR = buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0);
  // analysed with margins either side (where the score plays alone), output only the line itself
  const a0 = Math.max(0, Math.floor((s0 - margin) * sr)), a1 = Math.min(buffer.length, Math.ceil((s1 + margin) * sr));
  const o0 = Math.max(0, Math.floor((s0 - pre) * sr)), o1 = Math.min(buffer.length, Math.ceil((s1 + post) * sr));
  const len = a1 - a0, frames = Math.max(1, Math.floor((len - N) / HOP) + 1), bins = N / 2 + 1;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const fL = [], fR = [];
  const mag = new Float32Array(frames * bins), coh = new Float32Array(frames * bins), vb = new Float32Array(frames);
  const lo = Math.floor((90 * N) / sr), hi = Math.ceil((11000 * N) / sr), v0 = Math.floor((300 * N) / sr), v1 = Math.ceil((3400 * N) / sr);
  for (let f = 0; f < frames; f++) {
    const rL = new Float32Array(N), iL = new Float32Array(N), rR = new Float32Array(N), iR = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = a0 + f * HOP + i; rL[i] = (chL[x] || 0) * win[i]; rR[i] = (chR[x] || 0) * win[i]; }
    fft(rL, iL); fft(rR, iR);
    fL.push([rL, iL]); fR.push([rR, iR]);
    let e = 0;
    for (let k = 0; k < bins; k++) {
      const mr = (rL[k] + rR[k]) / 2, mi = (iL[k] + iR[k]) / 2;
      const pl = rL[k] * rL[k] + iL[k] * iL[k], pr = rR[k] * rR[k] + iR[k] * iR[k];
      const cr = rL[k] * rR[k] + iL[k] * iR[k], ci = iL[k] * rR[k] - rL[k] * iR[k];
      const c = (2 * Math.sqrt(cr * cr + ci * ci)) / (pl + pr + 1e-12);
      // (in phase and balanced: centre; a wide or one-sided sound scores low)
      coh[f * bins + k] = Math.max(0, c * (cr >= 0 ? 1 : 0.3));
      const m = Math.sqrt(mr * mr + mi * mi);
      mag[f * bins + k] = m;
      if (k >= v0 && k <= v1) e += m * m;
    }
    vb[f] = e;
  }
  // the score alone: the quietest third of frames in the voice band, outside the words where possible
  const order = [...vb.keys()].sort((x, y) => vb[x] - vb[y]);
  const quiet = order.slice(0, Math.max(3, Math.floor(frames / 3)));
  const noise = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    const v = quiet.map((f) => mag[f * bins + k] * Math.max(0.35, coh[f * bins + k])).sort((x, y) => x - y);
    noise[k] = v[Math.floor(v.length * 0.6)] || 0;
  }
  const vq = vb[quiet[Math.floor(quiet.length / 2)]] || 1e-9, vloud = vb[order[Math.floor(frames * 0.9)]] || vq * 10;
  // held notes of the score: a voice's harmonics glide with its pitch, a score's sustained note sits
  // on the same frequency for seconds; a bin that's a clear spectral peak in most frames (speech or
  // not) is the score, and it's notched out everywhere, with its neighbours
  const tonal = new Float32Array(bins).fill(1);
  for (let k = Math.max(lo, 4); k < Math.min(hi, bins - 4); k++) {
    let peaks = 0;
    for (let f = 0; f < frames; f++) {
      const o = f * bins, m = mag[o + k];
      const side = (mag[o + k - 3] + mag[o + k - 4] + mag[o + k + 3] + mag[o + k + 4]) / 4;
      if (m > 2.5 * side && m >= mag[o + k - 1] && m >= mag[o + k + 1]) peaks++;
    }
    if (peaks / frames > 0.55) for (let d = -1; d <= 1; d++) tonal[k + d] = Math.min(tonal[k + d], d ? 0.25 : 0.06);
  }
  // gains, smoothed over time (fast to open, slower to close), lower still where nobody speaks
  const out = new Float32Array(len + N), norm = new Float32Array(len + N);
  const gPrev = new Float32Array(bins);
  let act = 0;
  for (let f = 0; f < frames; f++) {
    const speech = Math.max(0, Math.min(1, Math.log(vb[f] / vq + 1e-9) / Math.log(Math.max(4, vloud / vq))));
    act = speech > act ? speech : act * 0.8 + speech * 0.2;
    const [rL, iL] = fL[f], [rR, iR] = fR[f];
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let k = 0; k < bins; k++) {
      const m = mag[f * bins + k], c = coh[f * bins + k];
      let g = m > 1e-9 ? Math.max(0, 1 - (1.6 * noise[k]) / m) : 0;
      g *= Math.pow(Math.min(1, c * 1.15), 1.5) * tonal[k];
      if (k < lo) g *= 0.08;
      else if (k > hi) g *= 0.35; // (rolled off, not cut: a hard edge up there sounds dull)
      g = Math.max(0.03, g) * (0.12 + 0.88 * act);
      g = g > gPrev[k] ? g : gPrev[k] * 0.7 + g * 0.3;
      gPrev[k] = g;
      const mr = (rL[k] + rR[k]) / 2, mi = (iL[k] + iR[k]) / 2;
      re[k] = mr * g; im[k] = mi * g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) { out[f * HOP + i] += re[i] * win[i]; norm[f * HOP + i] += win[i] * win[i]; }
  }
  const n = o1 - o0, res = new AudioBuffer({ length: Math.max(1, n), numberOfChannels: 1, sampleRate: sr }), d = res.getChannelData(0);
  const fade = Math.floor(0.03 * sr);
  for (let i = 0; i < n; i++) {
    const x = o0 - a0 + i;
    let v = norm[x] > 1e-6 ? out[x] / norm[x] : 0;
    if (i < fade) v *= i / fade;
    if (i > n - fade * 4) v *= Math.max(0, (n - i) / (fade * 4));
    d[i] = v;
  }
  return { buffer: res, offset: (o0 / sr) - s0 };
}

// RMS of a mono buffer's louder moments (the 80th percentile of 50 ms frames)
export function voiceLevel(buf) {
  const d = buf.getChannelData(0), n = Math.max(1, Math.round(buf.sampleRate * 0.05)), out = [];
  for (let i = 0; i + n <= d.length; i += n) { let e = 0; for (let j = i; j < i + n; j++) e += d[j] * d[j]; out.push(Math.sqrt(e / n)); }
  if (!out.length) return 0;
  out.sort((x, y) => x - y);
  return out[Math.floor(out.length * 0.8)];
}
