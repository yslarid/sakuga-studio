import { clamp, timelineDuration } from '../state.js';
import { CURVE_PRESETS, evalCurve, normalizeKeys } from '../curves.js';

const CHANNELS = {
  clip: {
    speed: { label: 'Speed', min: 0.1, max: 4.0, def: 1.0, fmt: (v) => `${v.toFixed(2)}×` },
    zoom: { label: 'Zoom', min: 0.5, max: 3.0, def: 1.0, fmt: (v) => `${v.toFixed(2)}×` },
    panX: { label: 'Pan X', min: 0, max: 1, def: 0.5, fmt: (v) => `${Math.round(v * 100)}%` },
    panY: { label: 'Pan Y', min: 0, max: 1, def: 0.5, fmt: (v) => `${Math.round(v * 100)}%` },
    rot: { label: 'Rotation', min: -Math.PI, max: Math.PI, def: 0, fmt: (v) => `${Math.round((v * 180) / Math.PI)}°` },
    exposure: { label: 'Exposure', min: -2, max: 2, def: 0, fmt: (v) => v.toFixed(2) },
  },
  fx: {
    intensity: { label: 'Intensity', min: 0, max: 2, def: 1, fmt: (v) => `${Math.round(v * 100)}%` },
  },
};

const SHAPING_PRESETS = ['linear', 'easeOut', 'easeInOut', 'whipOut', 'twoStage', 'overshoot'];
const SPEED_PRESETS = ['linear', 'twixtor', 'swell', 'bullet', 'heroSlow', 'hitStop'];

function bezierSample(t, p1, p2) {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/** Interactive Bezier curve & velocity graph drawer mounted above the timeline. */
export class GraphEditor {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.target = null; // { type: 'clip'|'fx', id, prop }
    this.selIdx = 0;
    this.drag = null;
    this.canvas = null;
    this.ctx = null;
    this.pad = { l: 44, r: 16, t: 12, b: 22 };
    this._build();
  }

  isOpen() {
    return this.el && !this.el.classList.contains('hidden');
  }

  open(target = null) {
    if (!this.el) return;
    if (target) this.setTarget(target, { open: false });
    else if (!this._resolveItem()) this.autoSelectTarget();
    this.el.classList.remove('hidden');
    this.syncToolbarBtn();
    this.render();
  }

  close() {
    if (!this.el) return;
    this.el.classList.add('hidden');
    this.syncToolbarBtn();
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }

  syncToolbarBtn() {
    const btn = document.getElementById('btnCurves');
    if (btn) btn.classList.toggle('active', this.isOpen());
  }

  autoSelectTarget() {
    const sel = this.app.sel;
    if (sel && sel.kind === 'clip') {
      this.target = { type: 'clip', id: sel.id, prop: 'speed' };
    } else if (sel && sel.kind === 'fx') {
      this.target = { type: 'fx', id: sel.id, prop: 'intensity' };
    } else if (this.app.project.clips.length) {
      const t = this.app.player.t;
      const c = this.app.project.clips.find((x) => t >= x.start && t < x.start + x.dur) || this.app.project.clips[0];
      this.target = { type: 'clip', id: c.id, prop: 'speed' };
    } else {
      this.target = null;
    }
    this.selIdx = 0;
  }

  setTarget(target, { open = false } = {}) {
    if (!target) return;
    const chMap = CHANNELS[target.type];
    if (!chMap) return;
    const prop = chMap[target.prop] ? target.prop : Object.keys(chMap)[0];
    this.target = { type: target.type, id: target.id, prop };
    this.selIdx = 0;
    if (open) this.open(this.target);
    else if (this.isOpen()) this.render();
  }

  _resolveItem() {
    const t = this.target;
    if (!t) return null;
    const p = this.app.project;
    if (t.type === 'clip') return p.clips.find((c) => c.id === t.id) || null;
    if (t.type === 'fx') return p.effects.find((e) => e.id === t.id) || null;
    return null;
  }

  _spec() {
    const t = this.target;
    return t && CHANNELS[t.type] ? CHANNELS[t.type][t.prop] : null;
  }

  _fallback(item) {
    const spec = this._spec();
    if (!spec || !item || !this.target) return 1;
    const prop = this.target.prop;
    if (this.target.type === 'clip') {
      if (prop === 'zoom') return item.zoom || 1;
      if (prop === 'panY') return item.panY ?? 0.5;
      if (prop === 'rot') return item.rot || 0;
      if (prop === 'exposure') return (item.grade && item.grade.exposure) || 0;
    } else if (this.target.type === 'fx') {
      return (item.params && item.params[prop]) ?? spec.def;
    }
    return spec.def;
  }

  _getKeys(item, rawOnly = false) {
    if (!item || !this.target) return [];
    const prop = this.target.prop;
    let raw = null;
    if (this.target.type === 'clip') {
      raw = prop === 'speed' ? item.speedKeys : (item.kf && item.kf[prop]);
    } else {
      raw = item.kf && item.kf[prop];
    }
    if (rawOnly) return raw || null;
    return normalizeKeys(raw, this._fallback(item));
  }

  _setKeys(item, keys, { pushUndo = false } = {}) {
    if (!item || !this.target) return;
    if (pushUndo && this.app.history) this.app.history.push();
    const norm = keys ? normalizeKeys(keys, this._fallback(item)) : null;
    const prop = this.target.prop;
    if (this.target.type === 'clip') {
      if (prop === 'speed') {
        if (norm) item.speedKeys = norm;
        else delete item.speedKeys;
      } else {
        item.kf = item.kf || {};
        if (norm) item.kf[prop] = norm;
        else delete item.kf[prop];
        if (!Object.keys(item.kf).length) delete item.kf;
      }
    } else {
      item.kf = item.kf || {};
      if (norm) item.kf[prop] = norm;
      else delete item.kf[prop];
      if (!Object.keys(item.kf).length) delete item.kf;
    }
    this.app.player.invalidate();
    this.app.timeline.render();
    if (this.app.gizmo) this.app.gizmo.render();
  }

  _build() {
    if (!this.el) return;
    this.el.innerHTML = `
      <div class="ge-head">
        <span class="ge-title" id="geTitle">Curve Editor</span>
        <div class="ge-channels" id="geChannels"></div>
        <div class="ge-presets" id="gePresets"></div>
        <span class="grow"></span>
        <button class="btn small" id="geAddKey" title="Add keyframe at playhead">+ Key</button>
        <button class="btn small" id="geReset" title="Clear curve on this channel">Reset</button>
        <button class="btn small" id="geClose" title="Close curve editor">✕</button>
      </div>
      <div class="ge-body"><canvas class="ge-canvas" id="geCanvas"></canvas></div>`;
    this.canvas = this.el.querySelector('#geCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.el.querySelector('#geClose').onclick = () => this.close();
    this.el.querySelector('#geReset').onclick = () => {
      const item = this._resolveItem();
      if (!item) return;
      this._setKeys(item, null, { pushUndo: true });
      this.selIdx = 0;
      this.render();
    };
    this.el.querySelector('#geAddKey').onclick = () => {
      const item = this._resolveItem();
      const spec = this._spec();
      if (!item || !spec) return;
      const u = clamp((this.app.player.t - item.start) / Math.max(1e-4, item.dur), 0.01, 0.99);
      const keys = this._getKeys(item);
      const v = clamp(evalCurve(keys, u, this._fallback(item)), spec.min, spec.max);
      keys.push({ u, v, ease: 'smooth', c1: [0.35, 0], c2: [0.65, 1] });
      const next = normalizeKeys(keys, spec.def);
      this.selIdx = Math.max(0, next.findIndex((k) => Math.abs(k.u - u) < 1e-4));
      this._setKeys(item, next, { pushUndo: true });
      this.render();
    };

    this._bindPointer();
    if (window.ResizeObserver) {
      new ResizeObserver(() => { if (this.isOpen()) this.render(); }).observe(this.canvas.parentElement);
    }
  }

  _coords() {
    const w = this.canvas.clientWidth || 400;
    const h = this.canvas.clientHeight || 130;
    const { l, r, t, b } = this.pad;
    return { w, h, gx0: l, gx1: Math.max(l + 10, w - r), gy0: t, gy1: Math.max(t + 10, h - b) };
  }

  _toPx(u, v, spec, box) {
    const x = box.gx0 + u * (box.gx1 - box.gx0);
    const nv = (v - spec.min) / Math.max(1e-6, spec.max - spec.min);
    const y = box.gy1 - nv * (box.gy1 - box.gy0);
    return [x, y];
  }

  _fromPx(x, y, spec, box) {
    const u = clamp((x - box.gx0) / Math.max(1, box.gx1 - box.gx0), 0, 1);
    const nv = clamp((box.gy1 - y) / Math.max(1, box.gy1 - box.gy0), 0, 1);
    const v = spec.min + nv * (spec.max - spec.min);
    return [u, v];
  }

  _applyPreset(name) {
    const item = this._resolveItem();
    const spec = this._spec();
    const raw = CURVE_PRESETS[name];
    if (!item || !spec || !raw) return;
    let out;
    if (this.target.prop === 'speed' && SPEED_PRESETS.includes(name)) {
      out = raw.map((k) => ({ ...k, v: clamp(k.v, spec.min, spec.max) }));
    } else if (this.target.prop === 'speed') {
      out = raw.map((k) => ({ ...k, v: clamp(1 + (k.v - 0.5) * 1.4, spec.min, spec.max) }));
    } else {
      const cur = this._getKeys(item);
      let v0 = cur.length ? cur[0].v : this._fallback(item);
      let v1 = cur.length > 1 ? cur[cur.length - 1].v : v0;
      if (Math.abs(v1 - v0) < (spec.max - spec.min) * 0.05) {
        const span = (spec.max - spec.min) * 0.25;
        v1 = clamp(v0 + (v0 + span > spec.max ? -span : span), spec.min, spec.max);
      }
      out = raw.map((k) => ({ ...k, v: clamp(v0 + (v1 - v0) * k.v, spec.min, spec.max) }));
    }
    this.selIdx = 0;
    this._setKeys(item, out, { pushUndo: true });
    this.render();
  }

  _bindPointer() {
    const c = this.canvas;
    const hitHandle = (mx, my, keys, spec, box) => {
      // Check Bezier handles of currently selected segment first
      if (this.selIdx >= 0 && this.selIdx < keys.length - 1) {
        const k0 = keys[this.selIdx], k1 = keys[this.selIdx + 1];
        const vSpan = Math.abs(k1.v - k0.v) > 1e-4 ? (k1.v - k0.v) : 0.25 * (spec.max - spec.min);
        const [x0, y0] = this._toPx(k0.u, k0.v, spec, box);
        const c1 = k0.c1 || [0.35, 0], c2 = k0.c2 || [0.65, 1];
        const [hx1, hy1] = this._toPx(k0.u + c1[0] * (k1.u - k0.u), k0.v + c1[1] * vSpan, spec, box);
        const [hx2, hy2] = this._toPx(k0.u + c2[0] * (k1.u - k0.u), k0.v + c2[1] * vSpan, spec, box);
        if (Math.hypot(mx - hx1, my - hy1) <= 9) return { kind: 'c1', idx: this.selIdx, vSpan, x0, y0 };
        if (Math.hypot(mx - hx2, my - hy2) <= 9) return { kind: 'c2', idx: this.selIdx, vSpan, x0, y0 };
      }
      for (let i = 0; i < keys.length; i++) {
        const [kx, ky] = this._toPx(keys[i].u, keys[i].v, spec, box);
        if (Math.hypot(mx - kx, my - ky) <= 10) return { kind: 'key', idx: i };
      }
      return null;
    };

    c.addEventListener('pointerdown', (ev) => {
      const item = this._resolveItem();
      const spec = this._spec();
      if (!item || !spec) return;
      const rect = c.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const box = this._coords();
      // Top strip scrubs playhead inside item
      if (my < box.gy0 + 8 && Math.hypot(mx - clamp(mx, box.gx0, box.gx1)) < 2) {
        const [u] = this._fromPx(mx, my, spec, box);
        this.drag = { kind: 'scrub', item };
        this.app.player.seek(clamp(item.start + u * item.dur, 0, timelineDuration(this.app.project)));
        c.setPointerCapture(ev.pointerId);
        return;
      }
      const keys = this._getKeys(item);
      const hit = hitHandle(mx, my, keys, spec, box);
      if (hit) {
        if (this.app.history) this.app.history.push();
        if (hit.kind === 'key') this.selIdx = hit.idx;
        this.drag = { ...hit, item, keys, box, spec };
        c.setPointerCapture(ev.pointerId);
        this.render();
        return;
      }
      // Click on curve area adds a keyframe
      if (mx >= box.gx0 && mx <= box.gx1 && my >= box.gy0 && my <= box.gy1) {
        const [u, v] = this._fromPx(mx, my, spec, box);
        if (this.app.history) this.app.history.push();
        const next = normalizeKeys([...keys, { u: clamp(u, 0.01, 0.99), v, ease: 'smooth', c1: [0.35, 0], c2: [0.65, 1] }], spec.def);
        this.selIdx = Math.max(0, next.findIndex((k) => Math.abs(k.u - clamp(u, 0.01, 0.99)) < 1e-4));
        this._setKeys(item, next);
        this.drag = { kind: 'key', idx: this.selIdx, item, keys: next, box, spec };
        c.setPointerCapture(ev.pointerId);
        this.render();
      }
    });

    c.addEventListener('pointermove', (ev) => {
      if (!this.drag) return;
      const rect = c.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const d = this.drag;
      if (d.kind === 'scrub') {
        const box = this._coords();
        const u = clamp((mx - box.gx0) / Math.max(1, box.gx1 - box.gx0), 0, 1);
        this.app.player.seek(clamp(d.item.start + u * d.item.dur, 0, timelineDuration(this.app.project)));
        return;
      }
      const { keys, box, spec, idx } = d;
      const [u, v] = this._fromPx(mx, my, spec, box);
      if (d.kind === 'key') {
        const k = keys[idx];
        k.v = clamp(v, spec.min, spec.max);
        if (idx === 0) k.u = 0;
        else if (idx === keys.length - 1) k.u = 1;
        else k.u = clamp(u, keys[idx - 1].u + 0.01, keys[idx + 1].u - 0.01);
        this._setKeys(d.item, keys);
        this.render();
      } else if (d.kind === 'c1' || d.kind === 'c2') {
        const k0 = keys[idx], k1 = keys[idx + 1];
        if (!k0 || !k1) return;
        k0.ease = 'cubic';
        const du = Math.max(1e-4, k1.u - k0.u);
        const cx = clamp((u - k0.u) / du, 0.02, 0.98);
        const cy = clamp((v - k0.v) / d.vSpan, -0.6, 1.6);
        if (d.kind === 'c1') k0.c1 = [cx, cy];
        else k0.c2 = [cx, cy];
        this._setKeys(d.item, keys);
        this.render();
      }
    });

    const endDrag = () => { this.drag = null; };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);

    c.addEventListener('dblclick', (ev) => {
      const item = this._resolveItem(), spec = this._spec();
      if (!item || !spec) return;
      const rect = c.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const keys = this._getKeys(item), box = this._coords();
      for (let i = 1; i < keys.length - 1; i++) {
        const [kx, ky] = this._toPx(keys[i].u, keys[i].v, spec, box);
        if (Math.hypot(mx - kx, my - ky) <= 10) {
          keys.splice(i, 1);
          this.selIdx = Math.max(0, i - 1);
          this._setKeys(item, keys, { pushUndo: true });
          this.render();
          return;
        }
      }
    });
  }

  render() {
    if (!this.isOpen() || !this.el) return;
    const item = this._resolveItem();
    const spec = this._spec();
    const titleEl = this.el.querySelector('#geTitle');
    const chEl = this.el.querySelector('#geChannels');
    const preEl = this.el.querySelector('#gePresets');
    if (!item || !spec) {
      titleEl.textContent = 'Select a Clip or FX to edit curves';
      chEl.innerHTML = '';
      preEl.innerHTML = '';
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = this.canvas.clientWidth || 400, ch = this.canvas.clientHeight || 130;
      this.canvas.width = cw * dpr; this.canvas.height = ch * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.clearRect(0, 0, cw, ch);
      return;
    }

    const name = this.target.type === 'clip'
      ? `Clip ${this.app.project.clips.indexOf(item) + 1}`
      : (item.type || 'FX');
    titleEl.textContent = `${name} · ${spec.label}`;

    const chMap = CHANNELS[this.target.type];
    chEl.innerHTML = Object.entries(chMap).map(([k, s]) => {
      const hasRaw = this.target.type === 'clip'
        ? (k === 'speed' ? !!(item.speedKeys && item.speedKeys.length) : !!(item.kf && item.kf[k]))
        : !!(item.kf && item.kf[k]);
      return `<button class="ge-pill${k === this.target.prop ? ' active' : ''}${hasRaw ? ' keyed' : ''}" data-prop="${k}">${s.label}</button>`;
    }).join('');
    chEl.querySelectorAll('.ge-pill').forEach((b) => {
      b.onclick = () => this.setTarget({ ...this.target, prop: b.dataset.prop });
    });

    const plist = this.target.prop === 'speed' ? SPEED_PRESETS : SHAPING_PRESETS;
    preEl.innerHTML = plist.map((k) => `<button class="ge-pre" data-pre="${k}">${k}</button>`).join('');
    preEl.querySelectorAll('.ge-pre').forEach((b) => {
      b.onclick = () => this._applyPreset(b.dataset.pre);
    });

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = this.canvas.clientWidth || 400, ch = this.canvas.clientHeight || 130;
    this.canvas.width = cw * dpr; this.canvas.height = ch * dpr;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const box = this._coords();
    const keys = this._getKeys(item);
    this.selIdx = clamp(this.selIdx, 0, Math.max(0, keys.length - 1));

    // Grid + labels
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const f = i / 4, y = box.gy1 - f * (box.gy1 - box.gy0);
      const val = spec.min + f * (spec.max - spec.min);
      ctx.beginPath(); ctx.moveTo(box.gx0, y); ctx.lineTo(box.gx1, y); ctx.stroke();
      ctx.fillText(spec.fmt(val), box.gx0 - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const f = i / 4, x = box.gx0 + f * (box.gx1 - box.gx0);
      ctx.beginPath(); ctx.moveTo(x, box.gy0); ctx.lineTo(x, box.gy1); ctx.stroke();
      ctx.fillText(`${(item.dur * f).toFixed(2)}s`, x, box.gy1 + 5);
    }

    // Default reference line
    const [, defY] = this._toPx(0, clamp(spec.def, spec.min, spec.max), spec, box);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.moveTo(box.gx0, defY); ctx.lineTo(box.gx1, defY); ctx.stroke();
    ctx.restore();

    // Sampled curve
    ctx.strokeStyle = '#ff4d8d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const u = i / N, v = clamp(evalCurve(keys, u, this._fallback(item)), spec.min, spec.max);
      const [px, py] = this._toPx(u, v, spec, box);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Bezier tangent handles for selected segment
    if (this.selIdx >= 0 && this.selIdx < keys.length - 1) {
      const k0 = keys[this.selIdx], k1 = keys[this.selIdx + 1];
      const vSpan = Math.abs(k1.v - k0.v) > 1e-4 ? (k1.v - k0.v) : 0.25 * (spec.max - spec.min);
      const [x0, y0] = this._toPx(k0.u, k0.v, spec, box);
      const [x1, y1] = this._toPx(k1.u, k1.v, spec, box);
      const c1 = k0.c1 || [0.35, 0], c2 = k0.c2 || [0.65, 1];
      const [hx1, hy1] = this._toPx(k0.u + c1[0] * (k1.u - k0.u), k0.v + c1[1] * vSpan, spec, box);
      const [hx2, hy2] = this._toPx(k0.u + c2[0] * (k1.u - k0.u), k0.v + c2[1] * vSpan, spec, box);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(hx1, hy1); ctx.moveTo(x1, y1); ctx.lineTo(hx2, hy2); ctx.stroke();
      for (const [hx, hy] of [[hx1, hy1], [hx2, hy2]]) {
        ctx.fillStyle = '#0f172a';
        ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.stroke();
      }
    }

    // Playhead inside item
    const phT = this.app.player.t;
    if (phT >= item.start && phT <= item.start + item.dur) {
      const pu = (phT - item.start) / Math.max(1e-4, item.dur);
      const px = box.gx0 + pu * (box.gx1 - box.gx0);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, box.gy0); ctx.lineTo(px, box.gy1); ctx.stroke();
    }

    // Keyframe diamonds
    keys.forEach((k, i) => {
      const [kx, ky] = this._toPx(k.u, clamp(k.v, spec.min, spec.max), spec, box);
      ctx.save();
      ctx.translate(kx, ky);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = i === this.selIdx ? '#ffffff' : '#fbbf24';
      ctx.strokeStyle = i === this.selIdx ? '#ff4d8d' : '#111827';
      ctx.lineWidth = 1.5;
      ctx.fillRect(-4.5, -4.5, 9, 9);
      ctx.strokeRect(-4.5, -4.5, 9, 9);
      ctx.restore();
    });

    // unused import guard (curve preset helper verification if queried externally)
    void bezierSample;
  }
}
