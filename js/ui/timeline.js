// Timeline: ruler with beat markers, FX / text / video / music tracks,
// selection, move / trim with beat snapping, scrubbing and zoom.
import { clamp, timelineDuration, timelineMusic, getMedia, relayout, avgSpeed, fmtTime } from '../state.js';
import { FX } from '../effects.js';
import { PEAK_RATE } from '../analysis/audio.js';
import { sfxById } from '../sfx.js';

const LANE_H = 19;
const LEVEL_TINT = { low: '#3b82f622', mid: '#8b5cf622', high: '#ff3d7f2e' };

export class Timeline {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('timeline');
    this.scroll = document.getElementById('tlScroll');
    this.inner = document.getElementById('tlInner');
    this.ruler = document.getElementById('tlRuler');
    this.wave = document.getElementById('tlWave');
    this.tracks = {
      fx: document.getElementById('trackFx'),
      text: document.getElementById('trackText'),
      sfx: document.getElementById('trackSfx'),
      video: document.getElementById('trackVideo'),
      music: document.getElementById('trackMusic'),
    };
    this.playhead = document.getElementById('playhead');
    this.zoomRange = document.getElementById('zoomRange');
    this.pps = 60;
    this.zoom = 0;

    this.heads = this.root.querySelector('.tl-heads');
    this.scroll.addEventListener('scroll', () => { this.heads.scrollTop = this.scroll.scrollTop; this.drawCanvases(); });
    new ResizeObserver(() => { this.layout(); this.drawCanvases(); }).observe(this.scroll);
    this.zoomRange.addEventListener('input', () => this.setZoom(+this.zoomRange.value));
    this.scroll.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const x = e.clientX - this.scroll.getBoundingClientRect().left;
      const tAt = (this.scroll.scrollLeft + x) / this.pps;
      this.setZoom(clamp(this.zoom - e.deltaY * 0.25, 0, 100));
      this.scroll.scrollLeft = tAt * this.pps - x;
    }, { passive: false });

    this.ruler.addEventListener('pointerdown', (e) => this.scrub(e));
    for (const [k, el] of Object.entries(this.tracks)) {
      el.addEventListener('pointerdown', (e) => {
        if (e.target !== el && e.target !== this.wave) return;
        if (k === 'music' && app.project.music) app.select({ kind: 'music', id: app.project.music.mediaId });
        else app.select(null);
        this.scrub(e);
      });
    }
  }

  get duration() { return timelineDuration(this.app.project); }

  fitPps() {
    const w = this.scroll.clientWidth || 800;
    return Math.max(4, (w - 60) / Math.max(1, this.duration));
  }

  setZoom(z) {
    this.zoom = z;
    this.zoomRange.value = z;
    this.layout();
    this.render();
  }

  layout() {
    this.pps = this.fitPps() * Math.pow(2, (this.zoom / 100) * 5);
    const w = Math.max(this.scroll.clientWidth, this.duration * this.pps + 120);
    this.inner.style.width = w + 'px';
    this.updatePlayhead();
  }

  x(t) { return t * this.pps; }

  scrub(e) {
    const app = this.app;
    const rect = this.scroll.getBoundingClientRect();
    const at = (ev) => clamp((ev.clientX - rect.left + this.scroll.scrollLeft) / this.pps, 0, this.duration);
    const wasPlaying = app.player.playing;
    if (wasPlaying) app.player.pause();
    app.player.seek(at(e));
    const move = (ev) => app.player.seek(at(ev));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (wasPlaying) app.player.play();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  snapTargets(exclude) {
    const p = this.app.project, out = [this.app.player.t];
    const tm = timelineMusic(p);
    if (tm) out.push(...tm.beats, ...tm.drops);
    for (const c of p.clips) out.push(c.start, c.start + c.dur);
    for (const e of p.effects) if (e !== exclude) out.push(e.start, e.start + e.dur);
    return out;
  }

  snap(t, targets) {
    if (!this.app.snap) return t;
    const thr = 8 / this.pps;
    let best = t, bd = thr;
    for (const s of targets) { const d = Math.abs(s - t); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  render() {
    const p = this.app.project, sel = this.app.sel;
    this.layout();
    // effects with lanes
    const fxEl = this.tracks.fx;
    fxEl.innerHTML = '';
    const sorted = [...p.effects].sort((a, b) => a.start - b.start);
    const laneEnds = [];
    for (const e of sorted) {
      let lane = laneEnds.findIndex((end) => end <= e.start + 1e-4);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = e.start + e.dur;
      const def = FX[e.type] || { label: e.type, color: '#888', icon: '?' };
      const el = this.item('fx-item' + (e.src && e.src !== 'manual' ? ' auto' : ''), e.start, e.dur, `${def.icon} ${def.label}`, sel && sel.kind === 'fx' && sel.id === e.id);
      el.style.top = 4 + lane * LANE_H + 'px';
      el.style.background = def.color;
      el.title = `${def.label} · ${fmtTime(e.start)} · ${e.dur.toFixed(2)}s`;
      this.bindItem(el, 'fx', e);
      fxEl.appendChild(el);
    }
    this.root.style.setProperty('--fx-h', Math.max(1, laneEnds.length) * LANE_H + 8 + 'px');

    const txEl = this.tracks.text;
    txEl.innerHTML = '';
    for (const t of p.texts) {
      const el = this.item('text-item', t.start, t.dur, 'T  ' + t.text.replace(/\n/g, ' '), sel && sel.kind === 'text' && sel.id === t.id);
      this.bindItem(el, 'text', t);
      txEl.appendChild(el);
    }

    const sEl = this.tracks.sfx;
    sEl.innerHTML = '';
    for (const x of p.sfx || []) {
      const snd = sfxById(x.sound);
      const len = Math.max(0.12, Math.min(snd ? snd.dur : 0.5, this.duration - x.start));
      const el = this.item('sfx-item', x.start, len, '🔊 ' + (snd ? snd.name : x.sound), sel && sel.kind === 'sfx' && sel.id === x.id);
      el.title = `${snd ? snd.name : x.sound} · ${fmtTime(x.start)}`;
      this.bindItem(el, 'sfx', x);
      sEl.appendChild(el);
    }

    const vEl = this.tracks.video;
    vEl.innerHTML = '';
    for (const c of p.clips) {
      const m = getMedia(p, c.mediaId);
      const el = this.item('clip-item' + (c.isDrop ? ' drop' : ''), c.start, c.dur, '', sel && sel.kind === 'clip' && sel.id === c.id);
      const thumb = m && nearestThumb(m, c.srcIn);
      if (thumb) el.style.backgroundImage = `url(${thumb})`;
      if (c.dur * this.pps > 46) {
        const l = el.querySelector('.lbl');
        l.textContent = c.speedKeys ? speedLabel(c) : (m ? m.name : 'missing');
      }
      if (c.volume > 0 && c.dur * this.pps > 30) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.style.left = c.speedKeys ? '22px' : '3px';
        b.style.background = '#22d3ee';
        b.textContent = '🔊';
        el.appendChild(b);
      }
      if (c.speedKeys && c.dur * this.pps > 18) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = '⚡';
        el.appendChild(b);
      }
      el.title = `${m ? m.name : 'missing'} · src ${fmtTime(c.srcIn)} · ${c.dur.toFixed(2)}s`;
      this.bindItem(el, 'clip', c);
      vEl.appendChild(el);
    }
    this.drawCanvases();
  }

  item(cls, start, dur, label, selected) {
    const el = document.createElement('div');
    el.className = 'item ' + cls + (selected ? ' sel' : '');
    el.style.left = this.x(start) + 'px';
    el.style.width = Math.max(3, dur * this.pps - 1) + 'px';
    el.innerHTML = `<span class="h l"></span><span class="lbl"></span><span class="h r"></span>`;
    el.querySelector('.lbl').textContent = label;
    return el;
  }

  bindItem(el, kind, obj) {
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const app = this.app;
      app.select({ kind, id: obj.id });
      // sounds keep their natural length, so dragging anywhere on them moves them
      const mode = kind === 'sfx' ? 'move' : e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
      if (kind === 'clip' && mode === 'move') return;
      const startX = e.clientX;
      const orig = { start: obj.start, dur: obj.dur, srcIn: obj.srcIn };
      const targets = this.snapTargets(obj);
      let pushed = false;
      const move = (ev) => {
        const dx = (ev.clientX - startX) / this.pps;
        if (!pushed) {
          if (Math.abs(ev.clientX - startX) < 3) return;
          app.history.push();
          pushed = true;
          if (obj.src && obj.src !== 'manual') obj.src = 'manual';
          if (obj.lyric) app.captionEdits = true;
        }
        if (kind === 'clip') this.trimClip(obj, orig, mode, dx);
        else if (mode === 'move') {
          let s = this.snap(orig.start + dx, targets);
          const e2 = this.snap(orig.start + dx + orig.dur, targets);
          if (s === orig.start + dx && e2 !== orig.start + dx + orig.dur) s = e2 - orig.dur;
          obj.start = Math.max(0, s);
        } else if (mode === 'l') {
          const s = clamp(this.snap(orig.start + dx, targets), 0, orig.start + orig.dur - 0.05);
          obj.dur = orig.start + orig.dur - s;
          obj.start = s;
        } else {
          const end = this.snap(orig.start + orig.dur + dx, targets);
          obj.dur = Math.max(0.05, end - obj.start);
        }
        app.changed({ inspector: false });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (pushed) app.changed();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  trimClip(c, orig, mode, dx) {
    const p = this.app.project, m = getMedia(p, c.mediaId);
    const sp = avgSpeed(c);
    if (mode === 'r') {
      const end = this.snap(orig.start + orig.dur + dx, this.snapTargets(null));
      const maxDur = m ? (m.duration - c.srcIn) / sp : Infinity;
      c.dur = clamp(end - orig.start, 0.1, maxDur);
    } else {
      const s = this.snap(orig.start + dx, this.snapTargets(null));
      let newDur = clamp(orig.start + orig.dur - s, 0.1, orig.dur + orig.srcIn / sp);
      c.srcIn = Math.max(0, orig.srcIn + (orig.dur - newDur) * sp);
      c.dur = newDur;
    }
    relayout(p.clips);
  }

  updatePlayhead() {
    const t = this.app.player ? this.app.player.t : 0;
    const x = this.x(t);
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.app.player && this.app.player.playing) {
      const sl = this.scroll.scrollLeft, w = this.scroll.clientWidth;
      if (x > sl + w - 40 || x < sl) this.scroll.scrollLeft = x - 60;
    }
  }

  drawCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.scroll.clientWidth;
    const sl = this.scroll.scrollLeft;
    const p = this.app.project;
    const tm = timelineMusic(p);
    const dur = this.duration;

    // ruler
    const rc = this.ruler;
    rc.style.width = w + 'px';
    rc.style.left = '0px';
    rc.width = Math.round(w * dpr); rc.height = Math.round(26 * dpr);
    const g = rc.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, 26);
    const t0 = sl / this.pps, t1 = (sl + w) / this.pps;
    const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((s) => s * this.pps >= 70) || 60;
    g.font = '10px Inter, sans-serif';
    g.fillStyle = '#63636f';
    g.strokeStyle = '#33333e';
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = t * this.pps - sl;
      g.beginPath(); g.moveTo(x + 0.5, 16); g.lineTo(x + 0.5, 26); g.stroke();
      g.fillText(fmtTime(t, step < 1), x + 3, 11);
    }
    if (tm) {
      tm.beats.forEach((b) => {
        if (b < t0 - 1 || b > t1 + 1) return;
        const x = b * this.pps - sl;
        const down = tm.downbeats.includes(b);
        g.fillStyle = down ? '#22d3eecc' : '#22d3ee55';
        g.fillRect(x, down ? 17 : 21, 1.5, down ? 9 : 5);
      });
      for (const d of tm.drops) {
        const x = d * this.pps - sl;
        if (x < -40 || x > w + 40) continue;
        g.fillStyle = '#ff3d7f';
        g.fillRect(x, 0, 2, 26);
        g.beginPath(); g.moveTo(x + 2, 1); g.lineTo(x + 34, 1); g.lineTo(x + 30, 7); g.lineTo(x + 34, 13); g.lineTo(x + 2, 13); g.fill();
        g.fillStyle = '#fff';
        g.font = '700 8.5px Inter, sans-serif';
        g.fillText('DROP', x + 5, 10.5);
        g.font = '10px Inter, sans-serif';
      }
    }

    // music waveform
    const wc = this.wave;
    wc.style.width = w + 'px';
    wc.width = Math.round(w * dpr); wc.height = Math.round(58 * dpr);
    const h = 58;
    const wg = wc.getContext('2d');
    wg.setTransform(dpr, 0, 0, dpr, 0, 0);
    wg.clearRect(0, 0, w, h);
    const mm = p.music && getMedia(p, p.music.mediaId);
    if (mm && mm.audio) {
      if (tm) for (const s of tm.sections) {
        wg.fillStyle = LEVEL_TINT[s.level];
        wg.fillRect(s.start * this.pps - sl, 0, (s.end - s.start) * this.pps, h);
      }
      const peaks = mm.audio.peaks, off = p.music.offset;
      const endX = Math.min(w, dur * this.pps - sl);
      wg.fillStyle = '#22d3ee';
      for (let x = 0; x < endX; x++) {
        const a = Math.floor((off + (sl + x) / this.pps) * PEAK_RATE);
        const b = Math.max(a + 1, Math.floor((off + (sl + x + 1) / this.pps) * PEAK_RATE));
        let m = 0;
        for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
        const bh = Math.max(1, m * (h - 18));
        wg.globalAlpha = 0.75;
        wg.fillRect(x, (h + 8) / 2 - bh / 2, 1, bh);
      }
      wg.globalAlpha = 1;
      if (tm) {
        wg.fillStyle = '#ffffff14';
        for (const b of tm.downbeats) { const x = b * this.pps - sl; if (x >= 0 && x <= w) wg.fillRect(x, 12, 1, h - 12); }
      }
      wg.fillStyle = '#ececf1';
      wg.font = '600 10.5px Inter, sans-serif';
      const label = `♪ ${mm.name}` + (tm ? `  ·  ${Math.round(tm.A.bpm)} BPM` : '');
      wg.fillText(label, 6, 11);
    } else {
      wg.fillStyle = '#63636f';
      wg.font = '11px Inter, sans-serif';
      wg.fillText('No soundtrack — drop a song into Media', 8, h / 2 + 4);
    }
  }
}

function nearestThumb(m, t) {
  const th = m.analysis && m.analysis.thumbs;
  if (!th || !th.length) return m.thumb;
  let best = th[0];
  for (const x of th) { if (Math.abs(x.t - t) < Math.abs(best.t - t)) best = x; if (x.t > t + 1) break; }
  return best.url;
}

function speedLabel(c) {
  const k = c.speedKeys;
  const min = Math.min(...k.map((x) => x[1])), max = Math.max(...k.map((x) => x[1]));
  if (Math.abs(max - min) < 0.01) return `${(+min.toFixed(2))}×`;
  return `ramp ${min.toFixed(1)}–${max.toFixed(1)}×`;
}
