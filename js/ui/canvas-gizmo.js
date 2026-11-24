import { clamp } from '../state.js';
import { facesAt } from '../analysis/faces.js';

const SNAP_MARKS = [0.3333, 0.5, 0.6667];

/** Direct manipulation gizmo canvas layered cleanly over #preview. */
export class CanvasGizmo {
  constructor(app, canvas, previewCanvas) {
    this.app = app;
    this.canvas = canvas;
    this.preview = previewCanvas;
    this.ctx = canvas.getContext('2d');
    this.drag = null;
    this.snapX = null;
    this.snapY = null;
    this.resize();
    this._bindPointer();
    if (window.ResizeObserver && previewCanvas) {
      new ResizeObserver(() => this.resize()).observe(previewCanvas);
      if (previewCanvas.parentElement) new ResizeObserver(() => this.resize()).observe(previewCanvas.parentElement);
    }
  }

  resize() {
    if (!this.canvas || !this.preview) return;
    const p = this.preview;
    const w = p.clientWidth || 2, h = p.clientHeight || 2;
    this.canvas.style.left = `${p.offsetLeft}px`;
    this.canvas.style.top = `${p.offsetTop}px`;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rw = Math.max(2, Math.round(w * dpr)), rh = Math.max(2, Math.round(h * dpr));
    if (this.canvas.width !== rw || this.canvas.height !== rh) {
      this.canvas.width = rw;
      this.canvas.height = rh;
    }
    this.render();
  }

  _activeTarget() {
    const sel = this.app.sel, p = this.app.project, t = this.app.player.t;
    if (!sel) return null;
    if (sel.kind === 'text') {
      const x = p.texts.find((item) => item.id === sel.id);
      if (!x || t < x.start || t > x.start + x.dur) return null;
      if (x.kind || x.words || x.style === 'lockword' || x.style === 'endcard' || x.style === 'countdown' || x.style === 'giant') return null;
      return { type: 'text', obj: x };
    }
    if (sel.kind === 'ovl') {
      const ov = (p.overlays || []).find((item) => item.id === sel.id);
      if (!ov || t < ov.start || t > ov.start + ov.dur) return null;
      return { type: 'ovl', obj: ov };
    }
    if (sel.kind === 'fx') {
      const fx = p.effects.find((item) => item.id === sel.id);
      if (!fx || fx.type !== 'vfx' || t < fx.start || t > fx.start + fx.dur) return null;
      return { type: 'vfx', obj: fx };
    }
    if (sel.kind === 'clip') {
      const c = p.clips.find((item) => item.id === sel.id);
      if (!c || t < c.start || t > c.start + c.dur) return null;
      return { type: 'clip', obj: c };
    }
    return null;
  }

  _boxFor(tgt, W, H) {
    const o = tgt.obj;
    if (tgt.type === 'text') {
      const cx = (o.x ?? 0.5) * W, cy = (o.y ?? 0.5) * H;
      const bw = Math.max(48, ((o.text || 'TEXT').length * 0.58 + (o.splitGap || 0) * 3) * (o.size || 0.12) * W);
      const bh = Math.max(32, (o.size || 0.12) * W * 1.25);
      return { cx, cy, hw: Math.min(W * 0.48, bw / 2), hh: Math.min(H * 0.45, bh / 2), rot: o.rot || 0 };
    }
    if (tgt.type === 'ovl') {
      const sc = o.scale ?? 1;
      const cx = (o.x ?? 0.5) * W, cy = (o.y ?? 0.5) * H;
      return { cx, cy, hw: Math.max(24, W * 0.28 * sc), hh: Math.max(24, H * 0.28 * sc), rot: o.rot || 0 };
    }
    if (tgt.type === 'vfx') {
      const P = o.params || {};
      const cx = (P.x ?? 0.5) * W, cy = (P.y ?? 0.5) * H;
      const sz = P.size ?? 0.6;
      return { cx, cy, hw: Math.max(24, sz * H * 0.35), hh: Math.max(24, sz * H * 0.35), rot: ((P.rot || 0) * Math.PI) / 180 };
    }
    return null;
  }

  _rotateLocal(dx, dy, rot) {
    const c = Math.cos(rot), s = Math.sin(rot);
    return [dx * c + dy * s, -dx * s + dy * c];
  }

  _snapVal(v) {
    for (const s of SNAP_MARKS) {
      if (Math.abs(v - s) < 0.015) return { v: s, snap: s };
    }
    return { v, snap: null };
  }

  _hitTest(tgt, mx, my, W, H) {
    if (tgt.type === 'clip') {
      const c = tgt.obj;
      const fx = (c.focus ?? 0.5) * W, fy = (c.panY ?? 0.5) * H;
      if (Math.hypot(mx - fx, my - fy) <= 14) return { kind: 'focal' };
      return null;
    }
    if (tgt.type === 'text' && Array.isArray(tgt.obj.letters)) {
      const x = tgt.obj, cx = (x.x ?? 0.5) * W, cy = (x.y ?? 0.5) * H;
      for (let i = 0; i < x.letters.length; i++) {
        const L = x.letters[i];
        if (!L || L.hidden) continue;
        const lx = cx + (L.dx || 0) * W, ly = cy + (L.dy || 0) * H;
        if (Math.hypot(mx - lx, my - ly) <= 11) return { kind: 'letter', li: i };
      }
    }
    const b = this._boxFor(tgt, W, H);
    if (!b) return null;
    const [lx, ly] = this._rotateLocal(mx - b.cx, my - b.cy, b.rot);
    if (Math.hypot(lx, ly - (-b.hh - 22)) <= 10) return { kind: 'rot', box: b };
    if (Math.hypot(lx - b.hw, ly - b.hh) <= 10) return { kind: 'scale', box: b };
    if (Math.abs(lx) <= b.hw + 8 && Math.abs(ly) <= b.hh + 8) return { kind: 'move', box: b };
    return null;
  }

  _bindPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (ev) => {
      const tgt = this._activeTarget();
      if (!tgt) return;
      const rect = c.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const W = rect.width, H = rect.height;
      const hit = this._hitTest(tgt, mx, my, W, H);
      if (!hit) return;
      ev.stopPropagation();
      if (this.app.history) this.app.history.push();
      const o = tgt.obj;
      const start = tgt.type === 'vfx'
        ? { x: o.params?.x ?? 0.5, y: o.params?.y ?? 0.5, size: o.params?.size ?? 0.6, rot: o.params?.rot || 0 }
        : tgt.type === 'clip'
          ? { focus: o.focus ?? 0.5, panY: o.panY ?? 0.5 }
          : { x: o.x ?? 0.5, y: o.y ?? 0.5, size: o.size ?? 0.12, scale: o.scale ?? 1, rot: o.rot || 0, letter: hit.li != null ? { ...o.letters[hit.li] } : null };
      this.drag = { tgt, hit, mx, my, W, H, start };
      c.setPointerCapture(ev.pointerId);
    });

    c.addEventListener('pointermove', (ev) => {
      const rect = c.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const W = rect.width, H = rect.height;
      if (!this.drag) {
        const tgt = this._activeTarget();
        const hit = tgt && this._hitTest(tgt, mx, my, W, H);
        c.style.cursor = hit ? (hit.kind === 'rot' ? 'grab' : hit.kind === 'scale' ? 'nwse-resize' : 'move') : 'default';
        return;
      }
      const { tgt, hit, start } = this.drag;
      const o = tgt.obj;
      const dxN = (mx - this.drag.mx) / W, dyN = (my - this.drag.my) / H;
      this.snapX = null; this.snapY = null;

      if (tgt.type === 'clip' && hit.kind === 'focal') {
        o.focus = clamp(start.focus + dxN, 0.05, 0.95);
        o.panY = clamp(start.panY + dyN, 0.05, 0.95);
        if (o.pan) { const mid = (o.pan[0] + o.pan[1]) / 2; const shift = o.focus - mid; o.pan = [clamp(o.pan[0] + shift, 0.05, 0.95), clamp(o.pan[1] + shift, 0.05, 0.95)]; }
      } else if (hit.kind === 'letter' && Array.isArray(o.letters)) {
        const L = o.letters[hit.li];
        L.dx = (start.letter.dx || 0) + dxN;
        L.dy = (start.letter.dy || 0) + dyN;
      } else if (hit.kind === 'move') {
        const sx = this._snapVal(clamp(start.x + dxN, 0.02, 0.98));
        const sy = this._snapVal(clamp(start.y + dyN, 0.02, 0.98));
        this.snapX = sx.snap; this.snapY = sy.snap;
        if (tgt.type === 'vfx') { o.params = o.params || {}; o.params.x = sx.v; o.params.y = sy.v; }
        else { o.x = sx.v; o.y = sy.v; }
      } else if (hit.kind === 'scale') {
        const dist0 = Math.max(16, Math.hypot(this.drag.mx - hit.box.cx, this.drag.my - hit.box.cy));
        const dist1 = Math.max(12, Math.hypot(mx - hit.box.cx, my - hit.box.cy));
        const ratio = dist1 / dist0;
        if (tgt.type === 'text') o.size = clamp(start.size * ratio, 0.03, 0.45);
        else if (tgt.type === 'ovl') o.scale = clamp(start.scale * ratio, 0.1, 4.0);
        else if (tgt.type === 'vfx') { o.params = o.params || {}; o.params.size = clamp(start.size * ratio, 0.1, 2.5); }
      } else if (hit.kind === 'rot') {
        const ang = Math.atan2(mx - hit.box.cx, -(my - hit.box.cy));
        if (tgt.type === 'vfx') { o.params = o.params || {}; o.params.rot = Math.round((ang * 180) / Math.PI); }
        else o.rot = clamp(ang, -Math.PI, Math.PI);
      }
      this.app.player.invalidate();
      this.render();
    });

    const stop = () => {
      if (!this.drag) return;
      this.drag = null;
      this.snapX = null; this.snapY = null;
      this.render();
      if (this.app.changed) this.app.changed();
    };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
  }

  render() {
    if (!this.canvas || !this.preview) return;
    const ctx = this.ctx;
    const W = this.preview.clientWidth || 2, H = this.preview.clientHeight || 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const tgt = this._activeTarget();
    this.canvas.style.pointerEvents = tgt ? 'auto' : 'none';
    if (!tgt) return;

    // Snap guides
    if (this.snapX != null) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.snapX * W, 0); ctx.lineTo(this.snapX * W, H); ctx.stroke();
    }
    if (this.snapY != null) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, this.snapY * H); ctx.lineTo(W, this.snapY * H); ctx.stroke();
    }

    if (tgt.type === 'clip') {
      const c = tgt.obj;
      const m = this.app.project.media.find((x) => x.id === c.mediaId);
      const local = this.app.player.t - c.start;
      const srcT = (c.srcIn || 0) + local;
      if (m) {
        const faces = facesAt(m, srcT);
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.55)';
        ctx.lineWidth = 1.2;
        for (const f of faces) {
          ctx.strokeRect(f[0] * W, f[1] * H, (f[2] - f[0]) * W, (f[3] - f[1]) * H);
        }
      }
      const fx = (c.focus ?? 0.5) * W, fy = (c.panY ?? 0.5) * H;
      ctx.strokeStyle = '#fbbf24';
      ctx.fillStyle = 'rgba(251, 191, 36, 0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(fx, fy, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(fx - 13, fy); ctx.lineTo(fx + 13, fy); ctx.moveTo(fx, fy - 13); ctx.lineTo(fx, fy + 13); ctx.stroke();
      return;
    }

    const b = this._boxFor(tgt, W, H);
    if (!b) return;
    ctx.save();
    ctx.translate(b.cx, b.cy);
    if (b.rot) ctx.rotate(b.rot);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(-b.hw, -b.hh, b.hw * 2, b.hh * 2);
    ctx.setLineDash([]);
    // Rotation stem + handle
    ctx.beginPath(); ctx.moveTo(0, -b.hh); ctx.lineTo(0, -b.hh - 22); ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath(); ctx.arc(0, -b.hh - 22, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Corner scale handle
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(b.hw - 5, b.hh - 5, 10, 10);
    ctx.restore();

    if (tgt.type === 'text' && Array.isArray(tgt.obj.letters)) {
      const o = tgt.obj, cx = (o.x ?? 0.5) * W, cy = (o.y ?? 0.5) * H;
      for (const L of o.letters) {
        if (!L || L.hidden) continue;
        const lx = cx + (L.dx || 0) * W, ly = cy + (L.dy || 0) * H;
        ctx.fillStyle = '#fbbf24';
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(lx, ly, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }
}
