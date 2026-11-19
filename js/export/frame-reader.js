import { loadMp4Box } from './libraries.js';
import { srcTimeAt } from '../state.js';

// Frame-accurate source frames for export.
// MP4/MOV: demux with mp4box.js and decode with WebCodecs (fast, sequential).
// Anything else (or on failure): seek a hidden <video> element per frame.

function once(el, ev, timeout = 10000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(ev + ' timeout')), timeout);
    el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
  });
}

// Frame rate of an MP4/MOV video track (null when it can't be read).
export async function probeFps(file) {
  if (!/\.(mp4|m4v|mov)$/i.test(file.name)) return null;
  try {
    const MP4Box = await loadMp4Box();
    const mp4 = MP4Box.createFile(false);
    let info = null;
    mp4.onReady = (i) => { info = i; };
    let pos = 0;
    while (!info && pos < file.size) {
      const buf = await file.slice(pos, Math.min(file.size, pos + 2 * 1024 * 1024)).arrayBuffer();
      buf.fileStart = pos;
      const next = mp4.appendBuffer(buf);
      pos = typeof next === 'number' && next > pos ? next : pos + buf.byteLength;
    }
    const t = info && info.videoTracks[0];
    if (!t || !t.nb_samples || !t.duration) return null;
    return Math.round((t.nb_samples / (t.duration / t.timescale)) * 100) / 100;
  } catch (e) { return null; }
}

// `hd`: where the footage has upscaled stretches (tools/upscale.py: the shots an edit uses, at 1.5x),
// the frames come from those instead, at the same media time; the export, the cover and the review
// stills ask for them, the analysis keeps reading the footage itself.
export async function openFrameSource(media, { hd = false } = {}) {
  if (hd && media.hd && media.hd.length) {
    const s = new HdFrameSource(media);
    await s.init();
    return s;
  }
  return openPlain(media);
}

async function openPlain(media) {
  if (window.VideoDecoder && /\.(mp4|m4v|mov)$/i.test(media.name)) {
    try {
      await loadMp4Box();
      const r = new Mp4FrameReader(media);
      await r.init();
      return r;
    } catch (e) {
      console.warn(`[export] WebCodecs reader unavailable for ${media.name}, using seek mode:`, e.message || e);
    }
  }
  const s = new SeekFrameSource(media);
  await s.init();
  return s;
}

class HdFrameSource {
  constructor(media) { this.media = media; this.kind = 'hd'; this.readers = new Map(); this.opened = new Map(); }
  async init() { this.base = await openPlain(this.media); }
  // (a shot uses the upscaled frames only when one upscaled stretch holds all of it: a shot that
  // turned sharper halfway through would show the seam)
  range(t, clip) {
    if (!clip) return this.media.hd.find((x) => t >= x.start - 1e-4 && t < x.end - 1e-4) || null;
    const a = srcTimeAt(clip, 0), b = srcTimeAt(clip, clip.dur), lo = Math.min(a, b), hi = Math.max(a, b);
    return this.media.hd.find((x) => lo >= x.start - 1e-3 && hi <= x.end + 1e-3) || null;
  }
  async reader(r) {
    if (!this.readers.has(r)) this.readers.set(r, openPlain({ name: r.file.name, file: r.file, url: r.url }).then((x) => { this.opened.set(r, x); return x; }).catch((e) => { console.warn('[hd]', r.file.name, e); return null; }));
    return this.readers.get(r);
  }
  async frameAt(t, clip) {
    const r = this.range(t, clip), rd = r && (await this.reader(r));
    return rd ? rd.frameAt(Math.max(0, t - r.start)) : this.base.frameAt(t);
  }
  around(t, clip) {
    // (the in-betweens' frame pair, on the upscaled clip's own timestamps where it has the moment)
    const r = this.range(t, clip), rd = r && this.opened.get(r);
    if (rd && rd.around) { const q = rd.around(t - r.start); return q ? [q[0] + r.start, q[1] + r.start] : null; }
    return this.base.around ? this.base.around(t) : null;
  }
  close() { this.base.close(); for (const p of this.readers.values()) p.then((x) => x && x.close()); }
}

class SeekFrameSource {
  constructor(media) { this.media = media; this.kind = 'seek'; }
  async init() {
    const v = (this.v = document.createElement('video'));
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = this.media.url;
    await once(v, 'loadeddata');
  }
  async frameAt(t) {
    const v = this.v;
    t = Math.max(0, Math.min(t, v.duration - 0.001));
    if (Math.abs(v.currentTime - t) < 0.0005 && !v.seeking && v.readyState >= 2) return v;
    const p = once(v, 'seeked');
    v.currentTime = t;
    await p;
    return v;
  }
  close() { this.v.removeAttribute('src'); this.v.load(); }
}

function description(trak) {
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return undefined;
}

class Mp4FrameReader {
  constructor(media) {
    this.media = media;
    this.file = media.file;
    this.frames = [];
    this.kind = 'webcodecs';
  }

  async init() {
    const file = this.file;
    const mp4 = MP4Box.createFile(false);
    let info = null, error = null;
    mp4.onReady = (i) => { info = i; };
    mp4.onError = (e) => { error = e; };
    let pos = 0;
    const CH = 2 * 1024 * 1024;
    while (!info && !error && pos < file.size) {
      const buf = await file.slice(pos, Math.min(file.size, pos + CH)).arrayBuffer();
      buf.fileStart = pos;
      const next = mp4.appendBuffer(buf);
      pos = typeof next === 'number' && next > pos ? next : pos + buf.byteLength;
    }
    if (error) throw new Error(String(error));
    if (!info) throw new Error('no moov box');
    const track = info.videoTracks[0];
    if (!track) throw new Error('no video track');
    const m = track.matrix;
    if (m && !(m[0] === 65536 && m[1] === 0 && m[3] === 0 && m[4] === 65536)) throw new Error('rotated video');
    const trak = mp4.getTrackById(track.id);
    const raw = trak.samples;
    if (!raw || !raw.length) throw new Error('no samples (fragmented mp4?)');
    this.samples = raw.map((s) => ({
      off: s.offset, size: s.size,
      ts: (s.cts * 1e6) / s.timescale,
      dur: (s.duration * 1e6) / s.timescale,
      key: !!s.is_sync,
    }));
    this.ptsBase = Math.min(...this.samples.map((s) => s.ts));
    this.byPts = this.samples.map((_, i) => i).sort((a, b) => this.samples[a].ts - this.samples[b].ts);
    this.config = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description: description(trak) };
    const sup = await VideoDecoder.isConfigSupported(this.config);
    if (!sup.supported) throw new Error('codec not supported: ' + track.codec);
    this.reset(0);
    const f = await this.frameAt(0);
    if (!f) throw new Error('first frame did not decode');
  }

  reset(fromIdx) {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    for (const f of this.frames) f.close();
    this.frames = [];
    this.err = null;
    this.decoder = new VideoDecoder({
      output: (f) => { this.frames.push(f); this.lastOut = f.timestamp; if (this.wake) this.wake(); },
      error: (e) => { this.err = e; if (this.wake) this.wake(); },
    });
    this.decoder.configure(this.config);
    this.next = fromIdx;
    this.flushed = false;
    this.lastOut = -Infinity;
  }

  keyBefore(i) {
    while (i > 0 && !this.samples[i].key) i--;
    return i;
  }

  async feed(n) {
    const end = Math.min(this.samples.length, this.next + n);
    for (; this.next < end; this.next++) {
      const s = this.samples[this.next];
      const data = new Uint8Array(await this.file.slice(s.off, s.off + s.size).arrayBuffer());
      this.decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, duration: s.dur, data }));
    }
  }

  waitOutput(ms = 30) {
    return new Promise((r) => { this.wake = r; setTimeout(r, ms); }).then(() => { this.wake = null; });
  }

  // The times (s) of the frame showing at t and of the one after it, from the file's own
  // timestamps (for in-betweens), or null at the last frame
  around(t) {
    const target = t * 1e6 + this.ptsBase + 1;
    let lo = 0, hi = this.byPts.length - 1, pi = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[this.byPts[mid]].ts <= target) { pi = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (pi + 1 >= this.byPts.length) return null;
    const at = (k) => (this.samples[this.byPts[k]].ts - this.ptsBase) / 1e6;
    return [at(pi), at(pi + 1)];
  }

  async frameAt(t) {
    const target = t * 1e6 + this.ptsBase + 1;
    // presentation-order lookup of the frame shown at t
    let lo = 0, hi = this.byPts.length - 1, pi = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[this.byPts[mid]].ts <= target) { pi = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const si = this.byPts[pi];
    const want = this.samples[si].ts;
    const key = this.keyBefore(si);
    const buffered = this.frames.find((f) => Math.abs(f.timestamp - want) < 1);
    if (!buffered && (this.lastOut > want + 1 || key > this.next || this.flushed)) this.reset(key);

    for (let guard = 0; guard < 100000; guard++) {
      if (this.err) throw this.err;
      const hit = this.frames.find((f) => Math.abs(f.timestamp - want) < 1);
      if (hit) { this.drop(hit); return hit; }
      const after = this.frames.find((f) => f.timestamp > want + 1);
      if (after) {
        const before = [...this.frames].reverse().find((f) => f.timestamp < want);
        const pick = before || after;
        this.drop(pick);
        return pick;
      }
      // keep the frame pool small or the decoder stalls
      while (this.frames.length > 4) this.frames.shift().close();
      if (this.next < this.samples.length) {
        await this.feed(6);
        if (this.decoder.decodeQueueSize > 8) await this.waitOutput(20);
        else await this.waitOutput(1);
      } else if (!this.flushed) {
        this.flushed = true;
        await this.decoder.flush();
      } else {
        const last = this.frames[this.frames.length - 1] || null;
        return last;
      }
    }
    return this.frames[this.frames.length - 1] || null;
  }

  drop(keep) {
    while (this.frames.length && this.frames[0] !== keep && this.frames[0].timestamp < keep.timestamp) this.frames.shift().close();
  }

  close() {
    for (const f of this.frames) f.close();
    this.frames = [];
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
  }
}
