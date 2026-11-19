// Decode a soundtrack, build waveform peaks and run the beat-analysis worker.

let ctx = null;
export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

export const PEAK_RATE = 100; // peaks per second

export async function decodeAudio(media) {
  const ab = await media.file.arrayBuffer();
  const buffer = await audioContext().decodeAudioData(ab);
  media.audio = { buffer, peaks: peaksOf(buffer), analysis: null };
  return media.audio;
}

// waveform peaks for the timeline
export function peaksOf(buffer) {
  const n = Math.ceil(buffer.duration * PEAK_RATE);
  const peaks = new Float32Array(n);
  const step = buffer.sampleRate / PEAK_RATE;
  const chans = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step), b = Math.min(buffer.length, Math.floor((i + 1) * step));
    let m = 0;
    for (const ch of chans) for (let j = a; j < b; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
    peaks[i] = m;
  }
  return peaks;
}

export async function analyzeMusic(media, onProgress) {
  const buf = media.audio.buffer;
  const sr = 22050;
  const oac = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * sr)), sr);
  const src = oac.createBufferSource();
  src.buffer = buf;
  src.connect(oac.destination);
  src.start();
  const rendered = await oac.startRendering();
  const mono = rendered.getChannelData(0).slice();
  const worker = new Worker(new URL('./audio-worker.js', import.meta.url));
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress && onProgress(m.value);
      else if (m.type === 'done') { worker.terminate(); media.audio.analysis = m.result; resolve(m.result); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Audio analysis failed')); };
    worker.postMessage({ samples: mono, sampleRate: sr }, [mono.buffer]);
  });
}
