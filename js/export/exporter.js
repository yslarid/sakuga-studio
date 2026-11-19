// Offline export: render every frame with WebGL, encode H.264 + AAC with
// WebCodecs and mux to MP4 (mp4-muxer), tagged BT.709.
import { timelineDuration, getMedia, srcTimeAt, clipSpan } from '../state.js';
import { markLayer, loadMarkImage } from '../watermark.js';
import { maskAt } from '../analysis/segment.js';
import { Renderer, frameParams, blendAmount } from '../render/renderer.js';
import { TextLayer, TEXT_STYLES, fontStack, loadScriptFonts } from '../render/text.js';
import { loadCaptionStyles } from '../render/fonts.js';
import { loadMp4Muxer } from './libraries.js';
import { openFrameSource } from './frame-reader.js';
import { scheduleMusicGain, scheduleClipAudio, clipAudioRanges, scheduleSongEdits, scheduleMuteGate, masterBus, masterBusDelay } from '../player.js';
import { preloadProjectSfx, scheduleSfx } from '../sfx.js';
import { preloadProjectVfx } from '../vfx.js';
import { ReelComposer } from './reel.js';
import { withColr } from './mp4colr.js';
import { inbetween, interpSuits, frameGate, drawingStarts } from '../render/interp.js';

export function exportSupported() {
  return typeof window.VideoEncoder === 'function';
}

async function pickVideoConfig(w, h, fps, bitrate) {
  const codecs = ['avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D4033', 'avc1.4D4028', 'avc1.42E033', 'avc1.42E028'];
  for (const codec of codecs) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: fps, hardwareAcceleration: hw, avc: { format: 'avc' } };
      try {
        const s = await VideoEncoder.isConfigSupported(cfg);
        if (s.supported) return cfg;
      } catch (e) { /* try next */ }
    }
  }
  throw new Error(`This browser can't encode H.264 at ${w}×${h}. Try a lower resolution or Chrome.`);
}

async function pickAudioConfig() {
  if (typeof window.AudioEncoder !== 'function') return null;
  const opts = [
    { codec: 'mp4a.40.2', mux: 'aac' },
    { codec: 'opus', mux: 'opus' },
  ];
  for (const o of opts) {
    const cfg = { codec: o.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 };
    try {
      const s = await AudioEncoder.isConfigSupported(cfg);
      if (s.supported) return { cfg, mux: o.mux };
    } catch (e) { /* next */ }
  }
  return null;
}

// Integrated loudness (ITU-R BS.1770: K-weighted, 400 ms blocks overlapping by 75%, gated at -70
// LUFS and 10 LU under the ungated level), in LUFS, of a 48 kHz buffer.
export function loudnessOf(buf) {
  const n = buf.length, sr = buf.sampleRate, chans = [];
  if (sr !== 48000) return null;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c), y = new Float32Array(n);
    // (the standard's two filter stages at 48 kHz: a high shelf, then a high-pass)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, w1 = 0, w2 = 0;
    for (let i = 0; i < n; i++) {
      const a = 1.53512485958697 * x[i] - 2.69169618940638 * x1 + 1.19839281085285 * x2 + 1.69065929318241 * y1 - 0.73248077421585 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = a;
      const b = a - 2 * z1 + z2 + 1.99004745483398 * w1 - 0.99007225036621 * w2;
      z2 = z1; z1 = a; w2 = w1; w1 = b;
      y[i] = b;
    }
    chans.push(y);
  }
  const blk = Math.round(sr * 0.4), hop = Math.round(sr * 0.1), ms = [];
  for (let s = 0; s + blk <= n; s += hop) {
    let e = 0;
    for (const y of chans) for (let i = s; i < s + blk; i++) e += y[i] * y[i];
    ms.push(e / blk);
  }
  const lk = (z) => -0.691 + 10 * Math.log10(z + 1e-20);
  const abs = ms.filter((z) => lk(z) > -70);
  if (!abs.length) return null;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10, gated = abs.filter((z) => lk(z) > rel);
  return lk(gated.reduce((a, b) => a + b, 0) / gated.length);
}

async function renderMusic(project, dur, includeMusic = true) {
  const mm = project.music && getMedia(project, project.music.mediaId);
  // a tempo guide only stands in for the song you'll add on Instagram
  const m = includeMusic && mm && !mm.guide ? mm : null;
  const buf = m && m.audio && m.audio.buffer;
  const clipAudio = project.clips.some((c) => (c.volume > 0 || c.voiceAudio) && getMedia(project, (c.voiceAudio && c.voiceAudio.mediaId) || c.mediaId)?.audio);
  const sfx = project.sfx && project.sfx.length;
  if (sfx) await preloadProjectSfx(project);
  if (!buf && !clipAudio && !sfx) return null;
  const sr = 48000, lag = await masterBusDelay(sr), len = Math.ceil(dur * sr);
  // (rendered the bus's own delay longer, and that much trimmed off the front below)
  const oac = new OfflineAudioContext(2, len + lag, sr), bus = masterBus(oac);
  if (buf) {
    const src = oac.createBufferSource();
    src.buffer = buf;
    const g = oac.createGain();
    // a seamless loop never fades the song (the end has to run straight into the start)
    scheduleMusicGain(g.gain, project.loop ? { ...project.music, fadeIn: 0, fadeOut: 0 } : project.music, dur, 0, 0, clipAudioRanges(project));
    const edits = scheduleSongEdits(oac, project, 0, 0, dur);
    src.connect(edits.input);
    edits.output.connect(g).connect(bus);
    src.start(0, Math.max(0, project.music.offset));
  }
  const gate = scheduleMuteGate(oac, project, 0, 0, dur);
  gate.connect(bus);
  scheduleClipAudio(oac, gate, project, 0, 0);
  scheduleSfx(oac, gate, project, 0, 0);
  const full = await oac.startRendering();
  if (!lag) return full;
  const out = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: sr });
  for (let c = 0; c < 2; c++) out.copyToChannel(full.getChannelData(c).subarray(lag, lag + len), c);
  return out;
}

// One file at the edit's own size (the editor's Export button).
export async function exportVideo(app, { width, height, fps, bitrate, includeMusic = true }, onProgress, signal) {
  const out = await renderEncode(app, { width, height, fps, outputs: [{ key: 'file', frame: 'main', bitrate, music: includeMusic }] }, onProgress, signal);
  return out.file;
}

// The deliverables, from one render: the master (the edit's own size, with the song, at a high
// bitrate to keep as the original), and the vertical 1080×1920 copy for Reels/TikTok with the
// song and without it (for adding the song in the app). A portrait edit is its own vertical copy.
// (`vertical: false`: the master alone, the edit in its own screen mode)
export async function exportDeliverables(app, { width, height, fps, masterBitrate = 40e6, reelBitrate = 16e6, vertical = true }, onProgress, signal) {
  return renderEncode(app, { width, height, fps, outputs: [
    { key: 'master', frame: 'main', bitrate: masterBitrate, music: true },
    ...(vertical ? [{ key: 'withSong', frame: 'reel', bitrate: reelBitrate, music: true }, { key: 'forInstagram', frame: 'reel', bitrate: reelBitrate, music: false }] : []),
  ] }, onProgress, signal);
}

// The smooth set: the same edit at 60 fps. The editor's own motion (camera moves, punches,
// shakes, transitions, captions) is drawn at 60; the footage keeps its drawings, with in-betweens
// on the shots drawn on ones (pans and zooms in the footage included) so they glide too.
// (from the footage's own frames, not its upscaled stretches: the in-betweens at 60 fps on 1.5x frames
// take four times as long, for detail the 24 fps master already carries)
export async function exportSmooth(app, { width, height, masterBitrate = 50e6, reelBitrate = 20e6, vertical = true, hd = false }, onProgress, signal) {
  return renderEncode(app, { width, height, fps: 60, hd, outputs: [
    { key: 'master', frame: 'main', bitrate: masterBitrate, music: true },
    ...(vertical ? [{ key: 'withSong', frame: 'reel', bitrate: reelBitrate, music: true }, { key: 'forInstagram', frame: 'reel', bitrate: reelBitrate, music: false }] : []),
  ] }, onProgress, signal);
}

// Frame times on a fixed grid, for sources read by seeking (no timestamps to go by). The rate read
// from the file is rounded (23.98), which drifts off the real grid over a long episode.
function gridPair(s, fps) {
  if (!fps) return null;
  const r = [24000 / 1001, 30000 / 1001, 60000 / 1001].find((x) => Math.abs(x - fps) < 0.01) || fps, k = Math.floor(s * r + 1e-6);
  return k < 0 ? null : [k / r, (k + 1) / r];
}

// The source picture for a frame of the export. Where the export needs a moment between two real
// frames of a shot drawn on ones (slow motion, the slow end of a ramp, 60 fps), an in-between of the
// two (when it passes its checks); otherwise the real frame, as always. Footage playing at its own
// pace always shows its real frames, and a freeze or hit-stop holds a real drawing.
async function sourcePicture(project, sources, f, cache, stats, maps) {
  const src = sources.get(f.media.id);
  const frozen = f.speed < 0.05 || (f.fx && f.fx.hold != null);
  // a hero shot slowed on twos or threes goes from one drawing to the next (see drawingStarts)
  const map = f.clip && maps && maps.get(f.clip.id);
  if (project.fluid === false || frozen || !(map || interpSuits(f.clip))) return src.frameAt(f.srcTime, f.clip);
  // the real frame showing at this moment and the one after it (frame n shows from its own
  // timestamp until the next, as the reader plays it), from the file's timestamps where it has them;
  // on a drawing map, the drawing showing and the next one
  let pair = null;
  if (map) {
    let i = map.length - 1;
    while (i >= 0 && map[i] > f.srcTime + 1e-4) i--;
    if (i >= 0 && i + 1 < map.length) pair = [map[i], map[i + 1]];
  } else pair = src.around ? src.around(f.srcTime, f.clip) : gridPair(f.srcTime, f.media.fps);
  if (!pair) return src.frameAt(f.srcTime, f.clip);
  const [ta, tb] = pair, t = (f.srcTime - ta) / (tb - ta);
  // source frames per output frame: about 1 is the footage's own pace (nothing to fill in), more
  // is a fast stretch (frames get skipped anyway)
  const step = Math.abs(f.speed) / ((project.renderFps || 24) * (tb - ta));
  // the next frame has to belong to this shot (past the clip's end it can be the next scene)
  const clipEnd = srcTimeAt(f.clip, f.clip.dur);
  if (step > 0.97 || t < 0.08 || t > 0.92 || tb > clipEnd + 0.002) return src.frameAt(f.srcTime, f.clip);
  const key = `${f.media.id}|${ta.toFixed(5)}`;
  if (cache.key !== key) {
    // both real frames, copied out before the reader moves on (a seeking reader is aimed a quarter
    // frame in, so rounding can't land it on the frame before)
    const copy = (fr) => { const w = fr.displayWidth || fr.videoWidth || fr.width, h = fr.displayHeight || fr.videoHeight || fr.height, c = new OffscreenCanvas(w, h); c.getContext('2d').drawImage(fr, 0, 0, w, h); return c; };
    const q = src.around ? 0 : 0.25 * (tb - ta);
    const A = copy(await src.frameAt(ta + q, f.clip)), B = copy(await src.frameAt(tb + q, f.clip));
    // the checks on the pair are the same for every moment between them: measured once
    Object.assign(cache, { key, A, B, gate: frameGate(A, B) });
  }
  const g = cache.gate;
  // nothing moving (a held drawing inside a shot on ones), or a jump too big to bridge (a flash,
  // a pose change): the real frame is right, and it isn't counted as an in-between turned down
  if (g.change < 0.002) { stats.still++; return t < 0.5 ? cache.A : cache.B; }
  if (g.change > (map ? 0.14 : 0.09)) { stats.jumps++; return t < 0.5 ? cache.A : cache.B; }
  stats.tried++;
  try {
    // (drawings on twos move further between them than frames on ones: a little more is bridged)
    const m = await inbetween(cache.A, cache.B, t, g, map ? 0.14 : 0.09);
    if (m) { stats.used++; return m; }
  } catch (e) {
    // the model can't run here: the rest of the export uses real frames
    stats.error = String(e.message || e);
    project.fluid = false;
  }
  return t < 0.5 ? cache.A : cache.B;
}

// The MP4 clock: a whole number of ticks per frame, so frames sit exactly where they were rendered
// (24 ticks a second for 23.976 fps drifted the picture ahead of the sound by 0.1%)
const tickRate = (fps) => (Math.abs(fps - Math.round(fps)) < 1e-6 ? Math.round(fps) : Math.round(fps * 1001));

async function renderEncode(app, { width, height, fps, outputs, hd = true }, onProgress, signal) {
  // a snapshot of the edit: captions being placed, an analysis finishing or a key pressed while
  // this runs can't change the cuts or text halfway through (the sound is mixed once, up front)
  const live = app.project;
  const project = { ...live, clips: structuredClone(live.clips), effects: structuredClone(live.effects), texts: structuredClone(live.texts), sfx: structuredClone(live.sfx || []), look: structuredClone(live.look), auto: live.auto, renderFps: fps };
  const dur = timelineDuration(project);
  if (dur <= 0) throw new Error('Nothing to export yet — add some footage first.');
  const Mp4Muxer = await loadMp4Muxer();
  const nFrames = Math.max(1, Math.round(dur * fps));
  if (project.texts.length && document.fonts) {
    await loadCaptionStyles();
    const labels = project.texts.map(item => item.text || '').join(' ');
    await loadScriptFonts(labels);
    const faces = new Set(['400 40px Anton', '600 40px Poppins', '400 40px "DM Serif Display"', 'italic 400 40px "DM Serif Display"', '700 40px Inter', '800 40px Inter', '700 40px Cinzel', '400 40px Cinzel', '400 40px "Bebas Neue"']);
    for (const item of project.texts) {
      const preset = TEXT_STYLES[item.style] || TEXT_STYLES.impact;
      const face = item.face || item.font || preset.font;
      faces.add(`${item.italic ? 'italic ' : ''}${item.weight || preset.weight} 40px ${fontStack(face)}`);
    }
    await Promise.allSettled([...faces].map(face => document.fonts.load(face, labels)));
  }
  if (project.watermark) await loadMarkImage(project.watermark.src);
  // (the sign-off card draws the mark it was planned with)
  for (const t of project.texts) if (t.style === 'endcard' && t.mark) await loadMarkImage(t.mark);
  const interp = { tried: 0, used: 0, still: 0, jumps: 0, error: null }, pair = {};

  const canvas = document.createElement('canvas');
  await preloadProjectVfx(project);
  const r = new Renderer(canvas, { preserve: true });
  r.setSize(width, height);
  const text = new TextLayer();
  text.setSize(width, height);
  // the vertical copy: composed from each finished frame (a portrait edit already is one)
  const portrait = height > width;
  const wantReel = outputs.some((o) => o.frame === 'reel') && !portrait;
  // pro edits draw the vertical copy natively at 1080×1920, full frame (the crop following the
  // character, the camera's moves and the captions laid out for the tall frame), as the reference
  // edits are; the others compose it from the landscape frame (the whole picture over a blurred fill)
  const proReel = wantReel && !!(project.auto && project.auto.ctx && project.auto.ctx.pro);
  const reel = wantReel && !proReel ? new ReelComposer(width, height) : null;
  let tall = null;
  if (proReel) {
    const c2 = document.createElement('canvas'), r2 = new Renderer(c2, { preserve: true }), t2 = new TextLayer();
    r2.setSize(1080, 1920); t2.setSize(1080, 1920);
    // (captions with a placement of their own for the tall frame use it there)
    const texts = project.texts.map((x) => (x.tall ? { ...x, ...x.tall } : x));
    tall = { canvas: c2, r: r2, text: t2, prev: null, texts };
  }
  const frameOf = (o) => (o.frame === 'reel' && (reel || tall) ? 'reel' : 'main');
  const size = (k) => (k === 'reel' ? [1080, 1920] : [width, height]);

  onProgress({ stage: 'Preparing sources', p: 0 });
  const sources = new Map();
  for (const c of project.clips) {
    if (!sources.has(c.mediaId)) {
      const m = getMedia(project, c.mediaId);
      if (m) sources.set(m.id, await openFrameSource(m, { hd }));
    }
  }
  const modes = [...sources.values()].map((s) => s.kind);
  // hero shots slowed on drawings on twos or threes: where each of their drawings starts, read once
  const drawings = new Map();
  if (project.fluid !== false) {
    for (const c of project.clips) {
      if (!c.hero || (c.cadence && c.cadence.rate >= 18)) continue;
      const src = sources.get(c.mediaId);
      if (!src || !src.around) continue;
      try { drawings.set(c.id, await drawingStarts(src, c.srcIn - 0.15, c.srcIn + clipSpan(c) + 0.25)); } catch (e) { /* that shot keeps its real frames */ }
    }
  }

  // one encoder per picture and bitrate (outputs that match share its chunks), one muxer per file.
  // A portrait edit's vertical copies are its main picture, but still at their own lighter bitrate.
  const encOf = (o) => `${frameOf(o)}@${o.bitrate}`, picOf = (k) => k.split('@')[0];
  const kinds = [...new Set(outputs.map(encOf))];
  const vcfg = {};
  for (const k of kinds) vcfg[k] = await pickVideoConfig(...size(picOf(k)), fps, Number(k.split('@')[1]));
  onProgress({ stage: 'Mixing audio', p: 0 });
  const audioFor = {};
  for (const music of [...new Set(outputs.map((o) => o.music !== false))]) audioFor[music] = await renderMusic(project, dur, music);
  // every copy to the -14 LUFS the platforms play at (a louder file is only turned down there, its
  // dynamics already squashed), set by the mix with the song, so the copy without it keeps its sound
  // effects at the same level for when the song is added in the app; never pushed past -1 dB peak
  const mixed = audioFor[true];
  const L = mixed ? loudnessOf(mixed) : null;
  if (L != null) {
    let peak = 1e-6;
    for (let c = 0; c < mixed.numberOfChannels; c++) for (const v of mixed.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
    const g = Math.min(10 ** ((-14 - L) / 20), 10 ** (-1 / 20) / peak);
    for (const b of Object.values(audioFor)) if (b) for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
  }
  const acfg = Object.values(audioFor).some(Boolean) ? await pickAudioConfig() : null;

  const muxers = {};
  for (const o of outputs) {
    const [w, h] = size(frameOf(o)), a = audioFor[o.music !== false];
    muxers[o.key] = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: w, height: h, frameRate: tickRate(fps) },
      audio: a && acfg ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: 48000 } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
  }

  let failure = null;
  for (const music of Object.keys(audioFor)) {
    const audio = audioFor[music], targets = outputs.filter((o) => String(o.music !== false) === music).map((o) => muxers[o.key]);
    if (!audio || !acfg) continue;
    const aenc = new AudioEncoder({ output: (c, m) => targets.forEach((mx) => mx.addAudioChunk(c, m)), error: (e) => { failure = e; } });
    aenc.configure(acfg.cfg);
    const sr = 48000, n = audio.length, L = audio.getChannelData(0), R = audio.getChannelData(1);
    // The AAC encoder puts 2112 samples (44 ms) of priming in front of the sound, and the file
    // doesn't tell players to skip them, so the audio would play 44 ms behind the picture (cuts
    // and hits landing early). Starting the mix that much in compensates exactly. Opus signals
    // its own pre-skip, so it needs nothing.
    const P = acfg.mux === 'aac' ? 2112 : 0;
    if (project.loop) {
      // a seamless loop restarts the file: a 6 ms fade at each end of what's encoded, so the jump can't click
      const f = Math.round(sr * 0.006);
      for (let i = 0; i < f && P + i < n; i++) { const g = i / f; L[P + i] *= g; R[P + i] *= g; L[n - 1 - i] *= g; R[n - 1 - i] *= g; }
    }
    for (let i = P; i < n; i += 1024) {
      const k = Math.min(1024, n - i);
      const data = new Float32Array(k * 2);
      data.set(L.subarray(i, i + k), 0);
      data.set(R.subarray(i, i + k), k);
      aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: k, numberOfChannels: 2, timestamp: Math.round(((i - P) / sr) * 1e6), data }));
    }
    await aenc.flush();
    aenc.close();
  }

  const venc = {};
  for (const k of kinds) {
    const targets = outputs.filter((o) => encOf(o) === k).map((o) => muxers[o.key]);
    venc[k] = new VideoEncoder({ output: (c, m) => targets.forEach((mx) => mx.addVideoChunk(c, m)), error: (e) => { failure = e; } });
    venc[k].configure(vcfg[k]);
  }
  const t0 = performance.now();
  let prevF = null;
  try {
    if (project.loop) {
      // the clean first frame (no watermark, no loop blur) that the last beat blends into
      const f0 = { ...frameParams(project, 0, width, height), loop: null };
      const s0 = f0.clip && sources.has(f0.media.id) ? await sources.get(f0.media.id).frameAt(f0.srcTime, f0.clip) : null;
      r.setMark(null);
      r.setSubject(f0.clip ? maskAt(f0.media, f0.srcTime) : null);
      r.draw(f0, s0, text.draw(project.texts, 0, f0), project.look, 0, 0, text.backOut);
      r.setLoopFrame(await createImageBitmap(canvas));
      if (tall) {
        const g0 = { ...frameParams(project, 0, 1080, 1920), loop: null };
        tall.r.setMark(null);
        tall.r.setSubject(g0.clip ? maskAt(g0.media, g0.srcTime) : null);
        tall.r.draw(g0, s0, tall.text.draw(tall.texts, 0, g0), project.look, 0, 0, tall.text.backOut);
        tall.r.setLoopFrame(await createImageBitmap(tall.canvas));
      }
    }
    // preview windows: grab each next shot's first frame once, up front
    const nexts = new Map();
    for (const e of project.effects.filter((x) => x.type === 'preview' || x.type === 'fgwipe')) {
      const fp = frameParams(project, e.start + 0.001, width, height).preview;
      if (!fp || nexts.has(fp.key)) continue;
      const src = await openFrameSource(fp.media);
      try { nexts.set(fp.key, await createImageBitmap(await src.frameAt(fp.srcTime))); } finally { src.close(); }
    }
    for (let i = 0; i < nFrames; i++) {
      if (signal && signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (failure) throw failure;
      const t = i / fps;
      const f = frameParams(project, t, width, height);
      let src = null;
      if (f.clip && sources.has(f.media.id)) src = await sourcePicture(project, sources, f, pair, interp, drawings);
      const tc = text.draw(project.texts, t, f);
      r.setMark(markLayer(project, width, height, t));
      r.setSubject(f.clip ? maskAt(f.media, f.srcTime) : null);
      if (f.preview && nexts.has(f.preview.key)) r.setNext(nexts.get(f.preview.key), f.preview.key);
      r.draw(f, src, tc, project.look, t, blendAmount(project.look, f, prevF, 1 / fps), text.backOut);
      prevF = f;
      if (tall) {
        // (the same moment of the same source picture, framed for the tall frame)
        const f2 = frameParams(project, t, 1080, 1920);
        tall.r.setMark(markLayer(project, 1080, 1920, t));
        tall.r.setSubject(f2.clip ? maskAt(f2.media, f2.srcTime) : null);
        if (f2.preview && nexts.has(f2.preview.key)) tall.r.setNext(nexts.get(f2.preview.key), f2.preview.key);
        tall.r.draw(f2, src, tall.text.draw(tall.texts, t, f2), project.look, t, blendAmount(project.look, f2, tall.prev, 1 / fps), tall.text.backOut);
        tall.prev = f2;
      }
      const stamp = { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) }, key = { keyFrame: i % Math.round(fps * 2) === 0 };
      const reelPic = kinds.some((k) => picOf(k) === 'reel') ? (tall ? tall.canvas : reel.draw(canvas)) : null;
      for (const k of kinds) {
        const frame = new VideoFrame(picOf(k) === 'reel' ? reelPic : canvas, stamp);
        venc[k].encode(frame, key);
        frame.close();
      }
      // wait on the encoders' own dequeue events: timers get throttled in background tabs
      for (const k of kinds) while (venc[k].encodeQueueSize > 8) await new Promise((res) => { venc[k].addEventListener('dequeue', res, { once: true }); setTimeout(res, 50); });
      if (i % 3 === 0 || i === nFrames - 1) {
        const el = (performance.now() - t0) / 1000;
        const eta = i > 5 ? (el / (i + 1)) * (nFrames - i - 1) : null;
        onProgress({ stage: 'Rendering', p: (i + 1) / nFrames, frame: i + 1, frames: nFrames, eta, modes });
      }
    }
    for (const k of kinds) await venc[k].flush();
  } finally {
    for (const k of kinds) if (venc[k].state !== 'closed') venc[k].close();
    for (const s of sources.values()) s.close();
    r.gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (tall) tall.r.gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (reel) reel.close();
  }
  if (failure) throw failure;
  const files = {};
  for (const o of outputs) {
    muxers[o.key].finalize();
    files[o.key] = new Blob([withColr(muxers[o.key].target.buffer)], { type: 'video/mp4' });
  }
  // how many frames got an in-between, and how many the checks turned down
  Object.defineProperty(files, 'interp', { value: interp, enumerable: false });
  return files;
}
