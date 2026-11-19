// Real-time preview: keeps a small pool of <video> elements per source in sync
// with the timeline (including speed ramps) and drives the renderer each frame.
import { clamp, speedAt, timelineDuration, getMedia, formatSize, srcTimeAt, avgSpeed } from './state.js';
import { markLayer } from './watermark.js';
import { maskAt } from './analysis/segment.js';
import { frameParams, blendAmount } from './render/renderer.js';
import { audioContext } from './analysis/audio.js';
import { scheduleSfx } from './sfx.js';
import { isolateVoice, voiceLevel } from './analysis/voice-isolate.js';

const DUCK = 0.3; // music level while a clip's own audio (a quote / dialogue line) plays
const RELEASE = 0.5; // how long the song takes to come back up after a line (a quick snap back reads as a jump)

// Timeline ranges where clips play their own audio (the song ducks under them). A spoken line's
// clip ducks only while the line plays: the song comes back up as the line ends, never still
// ducked when the clip hands over to the drop.
export function clipAudioRanges(project) {
  const rs = [];
  for (const c of project.clips) {
    if (c.volume > 0) rs.push({ a: c.start, b: c.audioOut != null ? c.start + Math.min(c.dur, c.audioOut + 0.3) : c.start + c.dur });
    const v = voiceSpan(c);
    if (v) rs.push({ a: v.a, b: v.b + 0.15, k: c.voiceAudio.duck });
  }
  const out = [];
  for (const r of rs.sort((x, y) => x.a - y.a)) {
    const last = out[out.length - 1];
    if (last && r.a <= last.b + 0.01) { last.b = Math.max(last.b, r.b); if (r.k == null || last.k == null) last.k = null; else last.k = Math.min(last.k, r.k); }
    else out.push({ ...r });
  }
  return out;
}

// A voice line laid over the cuts (`voiceAudio` on the speaker's clip, placed from that clip's
// start): its sound runs on under the shots after it while the picture keeps cutting on the beat.
export function voiceSpan(c) {
  const v = c.voiceAudio;
  return v && v.dur > 0 ? { a: c.start + v.off, b: c.start + v.off + v.dur, src: v.srcIn, volume: v.volume ?? 1.6 } : null;
}

// The isolated voice for each voice line (see analysis/voice-isolate.js): the character's words
// without the episode's own score, levelled again to the song (`target`, set by the planner) since
// taking the score out takes level with it. Kept on the media, keyed by the line's span; a line with
// `clean: false` plays the footage's own sound (a sound effect worth keeping).
const stemKey = (v) => `${v.srcIn.toFixed(3)}:${v.dur.toFixed(3)}`;
export function voiceStem(project, c) {
  const v = c.voiceAudio, m = v && getMedia(project, v.mediaId || c.mediaId);
  return v && v.clean !== false && m && m.voiceStems ? m.voiceStems.get(stemKey(v)) || null : null;
}
export async function prepareVoiceStems(project) {
  for (const c of project.clips) {
    const v = c.voiceAudio, m = v && v.clean !== false && getMedia(project, v.mediaId || c.mediaId);
    const buf = m && m.audio && m.audio.buffer;
    if (!buf) continue;
    m.voiceStems = m.voiceStems || new Map();
    const key = stemKey(v);
    if (!m.voiceStems.has(key)) {
      // (a stem separated by Demucs before the build is far cleaner; the isolator here is the fallback)
      let st = null;
      if (v.stem) {
        try {
          const r = await fetch(v.stem);
          if (r.ok) st = { buffer: await audioContext().decodeAudioData(await r.arrayBuffer()), offset: -(v.stemPre || 0), demucs: true };
        } catch (e) { console.warn('[voices] stem', v.stem, e); }
      }
      m.voiceStems.set(key, st || isolateVoice(buf, v.srcIn, v.srcIn + v.dur));
      await new Promise((r) => setTimeout(r, 0));
    }
    const st = m.voiceStems.get(key), lv = voiceLevel(st.buffer);
    if (v.target && lv > 1e-5) v.volume = +Math.max(1, Math.min(14, v.target / lv)).toFixed(2);
  }
}

export function musicGainAt(music, dur, x, ducks = []) {
  const v = music.volume ?? 1;
  const fi = music.fadeIn || 0, fo = music.fadeOut || 0;
  let g = v;
  if (fi > 0) g *= clamp(x / fi, 0, 1);
  if (fo > 0) g *= clamp((dur - x) / fo, 0, 1);
  if (music.duck !== false) {
    // (a range can duck less: a voice line over the song with its bass pulled out keeps it near full)
    let d = 1;
    for (const r of ducks) { const q = clamp(Math.min((x - r.a + 0.15) / 0.15, (r.b + RELEASE - x) / RELEASE), 0, 1); d = Math.min(d, 1 - (1 - (r.k ?? DUCK)) * q); }
    g *= d;
  }
  return g;
}

export function scheduleMusicGain(param, music, dur, fromT, when, ducks = []) {
  const pts = [0, music.fadeIn || 0, dur - (music.fadeOut || 0), dur];
  for (const r of ducks) pts.push(r.a - 0.15, r.a, r.b, r.b + RELEASE);
  const keys = [...new Set(pts.filter((k) => k > fromT && k <= dur))].sort((a, b) => a - b);
  param.setValueAtTime(musicGainAt(music, dur, fromT, ducks), when);
  for (const k of keys) param.linearRampToValueAtTime(musicGainAt(music, dur, k, ducks), when + (k - fromT));
}

// Edits to the song itself, like the reference edits make: a muffle (low-pass) that closes in
// before a big reveal and opens on it, the bass pulled out for the last bar before a drop, and a
// split second of silence right before it slams back. Returns the filter chain the song runs through.
export function scheduleSongEdits(ctx, project, fromT, when, dur) {
  const eds = (project.effects || []).filter((e) => e.type === 'muffle' || e.type === 'bassout' || e.type === 'mute' || e.type === 'songcut');
  const lp = ctx.createBiquadFilter(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
  lp.type = 'lowpass'; lp.Q.value = 0.9; lp.frequency.value = 20000;
  hp.type = 'highpass'; hp.Q.value = 0.7; hp.frequency.value = 10;
  lp.connect(hp).connect(g);
  if (!eds.length) return { input: lp, output: g, nodes: [lp, hp, g] };
  const at = (x) => {
    let f = 20000, h = 10, gg = 1;
    for (const e of eds) {
      if (x < e.start || x >= e.start + e.dur) continue;
      const a = x - e.start, b = e.start + e.dur - x, k = e.params.intensity ?? 1;
      if (e.type === 'muffle') {
        const q = clamp(Math.min(e.params.closed ? 1 : a / 0.3, b / 0.12), 0, 1);
        f = Math.min(f, Math.exp(Math.log(20000) + (Math.log(300 + (1 - k) * 2500) - Math.log(20000)) * q));
        gg *= 1 - 0.2 * q * k;
      } else if (e.type === 'bassout') h = Math.max(h, 10 + 240 * k * clamp(Math.min(a / 0.04, b / 0.02), 0, 1)); // (250 Hz: the sub-bass about 28 dB down, as the XP2 edits pull it under a line)
      // the song only (`ramp`: a fade out over `len`, then silent to its end; `fade`: soft edges that long)
      else if (e.type === 'songcut') gg *= 1 - k * (e.params.ramp ? clamp(a / Math.max(0.01, e.params.len || e.dur), 0, 1) : e.params.fade ? clamp(Math.min(a, b) / e.params.fade, 0, 1) : clamp(Math.min(a / 0.012, b / 0.02), 0, 1));
      else gg *= 1 - k * clamp(Math.min(a / 0.01, b / 0.01), 0, 1);
    }
    return [f, h, gg];
  };
  const pts = new Set([fromT]);
  for (const e of eds) {
    for (let x = e.start - 0.02; x <= e.start + e.dur + 0.02; x += 0.02) if (x > fromT && x < dur) pts.add(Math.round(x * 1e4) / 1e4);
    // the exact edges too, so a short silence keeps its full length
    for (const x of [e.start, e.start + 0.01, e.start + e.dur - 0.01, e.start + e.dur]) if (x > fromT && x < dur) pts.add(Math.round(x * 1e4) / 1e4);
  }
  [...pts].sort((a, b) => a - b).forEach((x, i) => {
    const [f, h, gg] = at(x), t = when + (x - fromT);
    if (i === 0) { lp.frequency.setValueAtTime(f, t); hp.frequency.setValueAtTime(h, t); g.gain.setValueAtTime(gg, t); }
    else { lp.frequency.linearRampToValueAtTime(f, t); hp.frequency.linearRampToValueAtTime(h, t); g.gain.linearRampToValueAtTime(gg, t); }
  });
  return { input: lp, output: g, nodes: [lp, hp, g] };
}

// The master bus everything plays through (preview and export alike): a song is mastered close to
// full scale, so the sound effects on top of it would push the sum over and crackle. A fast limiter
// holds the peaks down and a gentle soft clip after it catches the odd sample it lets past.
export function masterBus(ctx) {
  const input = ctx.createGain();
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -3; lim.knee.value = 1; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
  // (the compressor adds its own make-up gain, about +1.5 dB here: trimmed back so anything under the
  // threshold plays at its own level; peaks then sit near -2 dB, headroom the AAC encoder needs)
  const trim = ctx.createGain();
  trim.gain.value = 0.84;
  const clip = ctx.createWaveShaper();
  const n = 2048, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); curve[i] = Math.sign(x) * (a < 0.8 ? a : 0.8 + 0.18 * Math.tanh((a - 0.8) / 0.18)); }
  clip.curve = curve; clip.oversample = '4x';
  input.connect(lim).connect(trim).connect(clip).connect(ctx.destination);
  return input;
}

// How late the master bus plays (the limiter looks ahead; 10 ms in Chrome), in samples at rate sr:
// an export renders that much early so its sound stays on the frame. Measured once with a click.
const busDelays = new Map();
export async function masterBusDelay(sr) {
  if (!busDelays.has(sr)) {
    busDelays.set(sr, (async () => {
      const n = Math.round(sr / 4), oac = new OfflineAudioContext(1, n, sr), bus = masterBus(oac), b = oac.createBuffer(1, n, sr);
      b.getChannelData(0)[100] = 0.5;
      const src = oac.createBufferSource();
      src.buffer = b; src.connect(bus); src.start(0);
      const o = (await oac.startRendering()).getChannelData(0);
      let k = 0;
      for (let i = 0; i < o.length; i++) if (Math.abs(o[i]) > Math.abs(o[k])) k = i;
      return Math.max(0, k - 100);
    })());
  }
  return busDelays.get(sr);
}

// A split second of silence before a drop silences everything (sound effects and clip audio
// too), so the slam lands out of real silence.
export function scheduleMuteGate(ctx, project, fromT, when, dur) {
  const g = ctx.createGain();
  for (const e of (project.effects || []).filter((x) => x.type === 'mute')) {
    const a = Math.max(fromT, e.start), b = Math.min(dur, e.start + e.dur);
    if (b <= a) continue;
    const k = e.params.intensity ?? 1, ta = when + (a - fromT), tb = when + (b - fromT);
    g.gain.setValueAtTime(1, Math.max(when, ta - 0.01));
    g.gain.linearRampToValueAtTime(1 - k, ta);
    g.gain.setValueAtTime(1 - k, Math.max(ta, tb - 0.006));
    g.gain.linearRampToValueAtTime(1, tb);
  }
  return g;
}

// One frame of a video as an image (the next shot's first frame for preview windows).
async function grabFrame(media, t) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = media.url;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
  await new Promise((res) => { v.onseeked = res; v.currentTime = Math.max(0, Math.min(media.duration - 0.02, t)); });
  const b = await createImageBitmap(v);
  v.removeAttribute('src'); v.load();
  return b;
}

// Schedule each clip's own audio (decoded into media.audio) from timeline time fromT.
export function scheduleClipAudio(ctx, dest, project, fromT, when) {
  const nodes = [];
  for (const c of project.clips) {
    if (!(c.volume > 0) || c.start + c.dur <= fromT) continue;
    const m = getMedia(project, c.mediaId);
    const buf = m && m.audio && m.audio.buffer;
    if (!buf) continue;
    const local = Math.max(0, fromT - c.start);
    const rate = clamp(avgSpeed(c), 0.25, 4);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = c.volume;
    // a spoken line's clip lets its sound go after the line (whatever follows in the source stays out)
    if (c.audioOut != null && c.audioOut < c.dur) {
      const t0 = when + (c.start + c.audioOut - fromT);
      if (local < c.audioOut) { g.gain.setValueAtTime(c.volume, Math.max(when, t0)); g.gain.linearRampToValueAtTime(0, Math.max(when, t0) + 0.3); }
      else g.gain.value = 0;
    }
    src.connect(g).connect(dest);
    src.start(when + Math.max(0, c.start - fromT), Math.max(0, srcTimeAt(c, local)), (c.dur - local) * rate);
    nodes.push(src);
  }
  // voice lines laid over the cuts, at normal speed whatever the shots under them do (a short tail
  // past the line's measured end so its last syllable isn't clipped, faded out)
  const TAIL = 0.2;
  for (const c of project.clips) {
    const v = voiceSpan(c);
    if (!v || v.b + TAIL <= fromT) continue;
    const m = getMedia(project, (c.voiceAudio && c.voiceAudio.mediaId) || c.mediaId), stem = voiceStem(project, c);
    // (the isolated voice when it's ready: it starts a moment before the line, `offset` seconds)
    const buf = stem ? stem.buffer : m && m.audio && m.audio.buffer;
    if (!buf) continue;
    const a = stem ? v.a + stem.offset : v.a, b = stem ? v.a + stem.offset + stem.buffer.duration : v.b + TAIL;
    if (b <= fromT) continue;
    const skip = Math.max(0, fromT - a), len = b - a - skip;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    const t0 = when + Math.max(0, a - fromT), tEnd = t0 + len;
    g.gain.setValueAtTime(v.volume, t0);
    if (!stem) { g.gain.setValueAtTime(v.volume, Math.max(t0, tEnd - TAIL)); g.gain.linearRampToValueAtTime(0, tEnd); }
    src.connect(g).connect(dest);
    src.start(t0, stem ? skip : v.src + skip, len);
    nodes.push(src);
  }
  return nodes;
}

export class Player {
  constructor(app) {
    this.app = app;
    this.t = 0;
    this.playing = false;
    this.pools = new Map();
    this.cur = null;
    this.prep = null;
    this.needs = true;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  get duration() { return timelineDuration(this.app.project); }

  pool(media) {
    let p = this.pools.get(media.id);
    if (!p) {
      p = [0, 1, 2].map(() => {
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = media.url;
        v.addEventListener('seeked', () => { this.needs = true; });
        v.addEventListener('loadeddata', () => { this.needs = true; });
        if (v.requestVideoFrameCallback) {
          const onFrame = () => { this.needs = true; v.requestVideoFrameCallback(onFrame); };
          v.requestVideoFrameCallback(onFrame);
        }
        v._clip = null;
        return v;
      });
      this.pools.set(media.id, p);
    }
    return p;
  }

  dropMedia(id) {
    const p = this.pools.get(id);
    if (p) for (const v of p) { v.pause(); v.removeAttribute('src'); v.load(); }
    this.pools.delete(id);
  }

  elFor(clip, media) {
    const pool = this.pool(media);
    let v = pool.find((e) => e._clip === clip.id);
    if (v) return v;
    v = pool.find((e) => e !== this.cur && e !== this.prep) || pool[0];
    v._clip = clip.id;
    v.pause();
    return v;
  }

  play() {
    if (!this.app.project.clips.length) return;
    if (this.t >= this.duration - 0.02) this.t = 0;
    this.playing = true;
    this.startClock();
    this.app.emit('play');
  }

  pause() {
    this.playing = false;
    this.stopAudio();
    for (const p of this.pools.values()) for (const v of p) v.pause();
    this.needs = true;
    this.app.emit('play');
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    this.t = clamp(t, 0, Math.max(0, this.duration - 1 / 60));
    if (this.playing) this.startClock();
    this.needs = true;
    this.app.emit('time');
  }

  invalidate() { this.needs = true; if (this.playing) this.startClock(); }

  startClock() {
    this.stopAudio();
    this.tStart = this.t;
    this.wallStart = performance.now();
    const p = this.app.project, m = p.music && getMedia(p, p.music.mediaId);
    const buf = m && m.audio && m.audio.buffer;
    this.ctxStart = null;
    const hasClipAudio = p.clips.some((c) => c.volume > 0 || c.voiceAudio);
    if (!buf && !hasClipAudio && !(p.sfx && p.sfx.length)) return;
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume().then(() => { if (this.playing) this.startClock(); });
    const when = ctx.currentTime + 0.05;
    const bus = masterBus(ctx);
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      const edits = scheduleSongEdits(ctx, p, this.t, when, this.duration);
      src.connect(edits.input);
      edits.output.connect(g).connect(bus);
      this.editNodes = edits.nodes;
      scheduleMusicGain(g.gain, p.loop ? { ...p.music, fadeIn: 0, fadeOut: 0 } : p.music, this.duration, this.t, when, clipAudioRanges(p));
      src.start(when, Math.max(0, p.music.offset + this.t));
      this.src = src;
    }
    const gate = scheduleMuteGate(ctx, p, this.t, when, this.duration);
    gate.connect(bus);
    this.editNodes = [...(this.editNodes || []), gate, bus];
    this.clipNodes = [...scheduleClipAudio(ctx, gate, p, this.t, when), ...scheduleSfx(ctx, gate, p, this.t, when)];
    this.ctxStart = when;
  }

  stopAudio() {
    for (const n of [this.src, ...(this.clipNodes || [])]) {
      if (!n) continue;
      try { n.stop(); } catch (e) { /* already stopped */ }
      n.disconnect();
    }
    for (const n of this.editNodes || []) n.disconnect();
    this.src = null;
    this.clipNodes = [];
    this.editNodes = [];
  }

  clock() {
    const ctx = this.ctxStart != null && audioContext();
    if (ctx && ctx.state === 'running') return this.tStart + Math.max(0, ctx.currentTime - this.ctxStart);
    return this.tStart + (performance.now() - this.wallStart) / 1000;
  }

  loop() {
    requestAnimationFrame(this.loop);
    if (this.playing) {
      let t = this.clock();
      const d = this.duration;
      if (t >= d) { t = Math.max(0, d - 1 / 60); this.t = t; this.pause(); }
      this.t = t;
      this.app.emit('time');
    }
    try { this.syncAndRender(); } catch (e) { console.error(e); }
  }

  syncAndRender() {
    const app = this.app, p = app.project, r = app.renderer;
    if (!r) return;
    const { w, h } = formatSize(p);
    const f = frameParams(p, this.t, w, h);
    let source = null;
    if (f.clip) {
      const v = this.elFor(f.clip, f.media);
      if (this.cur !== v) { this.cur = v; this.needs = true; }
      if (this.prep === v) this.prep = null;
      const local = this.t - f.clip.start;
      if (this.playing) {
        const rate = clamp(speedAt(f.clip, local), 0.0625, 16);
        if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
        const drift = v.currentTime - f.srcTime;
        if (!v.seeking && Math.abs(drift) > 0.12 + 0.03 * rate) v.currentTime = f.srcTime;
        if (v.paused && !v.seeking) v.play().catch(() => {});
      } else {
        if (!v.paused) v.pause();
        if (!v.seeking && Math.abs(v.currentTime - f.srcTime) > 0.5 / 60) v.currentTime = f.srcTime;
      }
      if (v.readyState >= 2) source = v;
      const next = p.clips[f.idx + 1];
      if (next && next.start - this.t < 1.2) {
        const m2 = getMedia(p, next.mediaId);
        if (m2) {
          const nv = this.elFor(next, m2);
          if (nv !== v) {
            this.prep = nv;
            if (!nv.paused) nv.pause();
            if (!nv.seeking && Math.abs(nv.currentTime - next.srcIn) > 0.02) nv.currentTime = next.srcIn;
          }
        }
      }
      for (const pool of this.pools.values()) for (const e of pool) if (e !== v && e !== this.prep && !e.paused) e.pause();
    }
    // paused: redraw a few times a second as a safety net for late-decoded frames
    if (!this.playing && !this.needs && performance.now() - (this.lastDraw || 0) < 250) return;
    this.needs = false;
    this.lastDraw = performance.now();
    const tc = app.textLayer.draw(p.texts, this.t, f);
    const blend = this.playing ? blendAmount(p.look, f, this.prevF, this.t - (this.prevT ?? this.t)) : 0;
    r.setMark(markLayer(p, r.w, r.h, this.t));
    r.setSubject(f.clip ? maskAt(f.media, f.srcTime) : null);
    if (f.preview) {
      this.previews = this.previews || new Map();
      const pv = f.preview, got = this.previews.get(pv.key);
      if (got && got !== 'loading') r.setNext(got, pv.key);
      else if (!got) { this.previews.set(pv.key, 'loading'); grabFrame(pv.media, pv.srcTime).then((b) => { this.previews.set(pv.key, b); this.invalidate(); }).catch(() => this.previews.delete(pv.key)); }
    }
    r.draw(f, source, tc, p.look, this.t, blend, app.textLayer.backOut);
    // loop preview: remember the opening frame so the end can blend into it (taken again whenever
    // the opening shot or the look changes, so it never blends into an old version of the edit)
    const c0 = p.clips[0], sig = c0 ? `${c0.mediaId}|${c0.srcIn.toFixed(3)}|${JSON.stringify(p.look)}` : '';
    if (r.loopSig !== sig) { r.hasLoopFrame = false; r.loopSig = sig; }
    if (p.loop && source && this.t < 0.02 && !r.hasLoopFrame) createImageBitmap(r.canvas).then((b) => r.setLoopFrame(b)).catch(() => {});
    this.prevF = f;
    this.prevT = this.t;
  }
}
