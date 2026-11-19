// A song clip (a sound saved from an app, re-encoded on the way and cut off around 16-18 kHz)
// swapped for the same stretch of a full, higher-quality download of the song. Where the clip sits
// in the full track is found by matching the two: onsets first to find the place, then the samples
// themselves to the quarter millisecond. The full file's samples then play and export in the clip's
// place, level-matched, so the beats, the lyrics' timing and the cuts all stay where they are.

const RATE = 8000; // matching rate (Hz)
const HOP = 40; // onset frames: 5 ms

async function mono(buffer, rate = RATE) {
  const oac = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * rate)), rate);
  const src = oac.createBufferSource();
  src.buffer = buffer;
  src.connect(oac.destination);
  src.start();
  return (await oac.startRendering()).getChannelData(0);
}

// rises in loudness, 200 a second: what lines a song up whatever its encoding
function onsets(x) {
  const n = Math.floor(x.length / HOP), d = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * HOP; j < (i + 1) * HOP; j++) s += x[j] * x[j];
    const e = Math.log(1e-6 + Math.sqrt(s / HOP));
    d[i] = Math.max(0, e - prev);
    prev = e;
  }
  return d;
}

// normalised correlation of a against b shifted by each lag in [l0, l1], the best as [lag, score]
function bestLag(a, b, l0, l1) {
  let best = [l0, -Infinity], ma = 0, aa = 0;
  for (const v of a) ma += v;
  ma /= a.length;
  for (const v of a) aa += (v - ma) * (v - ma);
  for (let lag = l0; lag <= l1; lag++) {
    const i0 = Math.max(0, -lag), i1 = Math.min(a.length, b.length - lag);
    if (i1 - i0 < a.length * 0.4) continue;
    let sb = 0;
    for (let i = i0; i < i1; i++) sb += b[i + lag];
    const mb = sb / (i1 - i0);
    let ab = 0, bb = 0;
    for (let i = i0; i < i1; i++) { const v = b[i + lag] - mb; ab += (a[i] - ma) * v; bb += v * v; }
    const sc = ab / Math.sqrt(aa * bb + 1e-12);
    if (sc > best[1]) best = [lag, sc];
  }
  return best;
}

function decimate(d, k) {
  const out = new Float32Array(Math.floor(d.length / k));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += d[i * k + j]; out[i] = s; }
  return out;
}

// Where the clip starts in the full song (seconds; negative if the clip starts before it), how well
// the two match (0..1: 0.8 and up is the same recording, under 0.5 a different version, a sped-up
// or slowed sound, or another song) and the gain that brings the full file to the clip's level.
export async function matchFullSong(clip, full) {
  const a = await mono(clip), b = await mono(full);
  const da = onsets(a), db = onsets(b);
  // the place: onsets at 25 a second over the whole song, then at 200 a second round it
  const K = 8, ca = decimate(da, K), cb = decimate(db, K);
  const [cl] = bestLag(ca, cb, -Math.floor(ca.length * 0.2), cb.length - Math.floor(ca.length * 0.6));
  const [fl] = bestLag(da, db, cl * K - 2 * K, cl * K + 2 * K);
  // to the sample at 8 kHz, on the samples themselves (a 6 s stretch from the clip's loud middle)
  const s0 = Math.max(0, Math.floor(a.length / 2 - 3 * RATE)), seg = a.subarray(s0, Math.min(a.length, s0 + 6 * RATE));
  const base = fl * HOP;
  const [sl] = bestLag(seg, b, base + s0 - HOP * 2, base + s0 + HOP * 2);
  const lag = sl - s0, offset = lag / RATE;
  // the match over the whole clip, and the levels
  let ab = 0, aa = 0, bb = 0, ea = 0, eb = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    const j = i + lag;
    if (j < 0 || j >= b.length) continue;
    ab += a[i] * b[j]; aa += a[i] * a[i]; bb += b[j] * b[j]; n++;
  }
  ea = Math.sqrt(aa / Math.max(1, n)); eb = Math.sqrt(bb / Math.max(1, n));
  const score = ab / Math.sqrt(aa * bb + 1e-12);
  return { offset, score, gain: eb > 1e-6 ? ea / eb : 1, covered: n / a.length };
}

// The full song's samples for the clip's span, at the full file's own rate and channels, scaled to
// the clip's level, with 5 ms fades at the ends (a cut in the middle of a waveform clicks)
export function alignedSlice(full, offset, duration, gain = 1) {
  const sr = full.sampleRate, len = Math.max(1, Math.round(duration * sr)), at = Math.round(offset * sr);
  const out = new AudioBuffer({ numberOfChannels: full.numberOfChannels, length: len, sampleRate: sr });
  const fade = Math.round(0.005 * sr);
  for (let c = 0; c < full.numberOfChannels; c++) {
    const src = full.getChannelData(c), dst = out.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const j = at + i;
      if (j < 0 || j >= src.length) continue;
      const k = i < fade ? i / fade : i > len - fade ? (len - i) / fade : 1;
      dst[i] = src[j] * gain * k;
    }
  }
  return out;
}

// How high the sound reaches (Hz): where the spectrum falls 40 dB under the mids. A file saved from
// an app stops around 16-18 kHz; a proper download reaches 19-20 kHz.
export async function bandwidth(buffer) {
  const sr = buffer.sampleRate, N = 4096, x = buffer.getChannelData(0);
  const bins = new Float64Array(N / 2);
  let frames = 0;
  for (let s = Math.floor(x.length * 0.2); s + N < x.length * 0.8 && frames < 60; s += Math.floor(x.length * 0.6 / 60)) {
    // (a plain DFT of the band edges would do, but a small FFT keeps it quick)
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) bins[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (!frames) return null;
  const hz = (k) => (k * sr) / N, db = (k) => 10 * Math.log10(bins[k] / frames + 1e-20);
  let mids = 0, nm = 0;
  for (let k = 0; k < N / 2; k++) if (hz(k) > 1000 && hz(k) < 4000) { mids += db(k); nm++; }
  mids /= nm;
  for (let k = N / 2 - 1; k > 0; k--) {
    let m = 0, c = 0;
    for (let j = Math.max(0, k - 8); j <= k; j++) { m += db(j); c++; }
    if (m / c > mids - 40) return Math.round(hz(k));
  }
  return null;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j], br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
