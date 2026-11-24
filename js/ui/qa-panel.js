import { clamp, getMedia, clipSpan, relayout, timelineMusic, clipIndexAt } from '../state.js';
import { gridMean } from '../analysis/video.js';
import { autoColorMatch } from '../engine/autoedit.js';

const DEPTH_FX = new Set(['parallax', 'dof', 'clone']);

/**
 * Runs an instant client-side quality audit of the current timeline, returning a composite
 * 0..100 score and actionable issues with optional 1-click auto-fix handlers.
 */
export function analyzeProjectQA(project) {
  const issues = [];
  const p = project || { clips: [], effects: [], texts: [], media: [] };
  const clips = p.clips || [];
  const tm = p.music ? timelineMusic(p) : null;
  const beats = tm && tm.beats ? tm.beats : [];

  if (!clips.length) {
    issues.push({
      id: 'empty', severity: 'info', time: 0,
      title: 'Timeline is empty',
      detail: 'Import footage or open the example to run timeline QA checks.',
    });
  }

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const m = getMedia(p, c.mediaId);
    if (c.dur < 0.14 && c.role !== 'flurry') {
      issues.push({
        id: `short-${c.id}`, severity: 'err', time: c.start,
        title: `Sliver clip #${i + 1} (${c.dur.toFixed(2)}s)`,
        detail: 'Sub-0.14s clips read as accidental flashes unless inside a drop flurry.',
        fixLabel: 'Extend to 0.25s',
        fixFn: (app) => {
          const maxD = m ? Math.max(0.25, (m.duration - c.srcIn) * 0.9) : 0.25;
          c.dur = clamp(0.25, c.dur, maxD);
          relayout(p.clips);
          app.changed();
        },
      });
    } else if (c.dur > 4.5 && !c.hero) {
      issues.push({
        id: `long-${c.id}`, severity: 'warn', time: c.start,
        title: `Long hold on clip #${i + 1} (${c.dur.toFixed(1)}s)`,
        detail: 'Holds longer than 4.5s without hero slow-mo can stall edit momentum.',
        fixLabel: 'Split in half',
        fixFn: (app) => {
          const half = c.dur * 0.5;
          const b = { ...structuredClone(c), id: `${c.id}_s`, start: c.start + half, dur: c.dur - half, srcIn: c.srcIn + clipSpan(c) * 0.5 };
          c.dur = half;
          p.clips.splice(i + 1, 0, b);
          relayout(p.clips);
          app.changed();
        },
      });
    }

    if (i > 0) {
      const prev = clips[i - 1];
      if (prev.mediaId === c.mediaId && Math.abs(prev.srcIn - c.srcIn) < 0.2) {
        issues.push({
          id: `dup-${c.id}`, severity: 'warn', time: c.start,
          title: `Near-duplicate consecutive cut #${i} → #${i + 1}`,
          detail: 'Adjacent clips start at nearly the same source frame.',
          fixLabel: Array.isArray(c.alts) && c.alts.length ? 'Swap alt shot' : 'Nudge +1.0s',
          fixFn: (app) => {
            if (Array.isArray(c.alts) && c.alts.length) {
              const alt = c.alts.find((a) => a.mediaId !== c.mediaId || Math.abs(a.srcIn - c.srcIn) >= 0.4) || c.alts[0];
              c.mediaId = alt.mediaId;
              c.srcIn = alt.srcIn;
            } else if (m) {
              c.srcIn = clamp(c.srcIn + 1.0, 0, Math.max(0, m.duration - clipSpan(c)));
            }
            app.changed();
          },
        });
      }

      if (beats.length && c.role !== 'flurry') {
        let nearB = beats[0], minD = Math.abs(beats[0] - c.start);
        for (const b of beats) {
          const d = Math.abs(b - c.start);
          if (d < minD) { minD = d; nearB = b; }
        }
        if (minD > 0.075 && c.dur > 0.3) {
          issues.push({
            id: `beat-${c.id}`, severity: 'warn', time: c.start,
            title: `Off-beat cut #${i + 1} (${Math.round(minD * 1000)}ms off)`,
            detail: `Cut lands at ${c.start.toFixed(2)}s; nearest beat is ${nearB.toFixed(2)}s.`,
            fixLabel: 'Snap to beat',
            fixFn: (app) => {
              const delta = nearB - c.start;
              if (prev.dur + delta >= 0.18 && c.dur - delta >= 0.18) {
                prev.dur += delta;
                c.dur -= delta;
                relayout(p.clips);
                app.changed();
              }
            },
          });
        }
      }

      const pm = getMedia(p, prev.mediaId);
      const pg = pm && pm.analysis && pm.analysis.grid;
      const cg = m && m.analysis && m.analysis.grid;
      if (pg && pg.pl && cg && cg.pl && !(c.grade && Math.abs(c.grade.exposure || 0) > 0.01)) {
        const l0 = gridMean(pg, 'pl', prev.srcIn, prev.srcIn + Math.max(0.1, clipSpan(prev)));
        const l1 = gridMean(cg, 'pl', c.srcIn, c.srcIn + Math.max(0.1, clipSpan(c)));
        if (Math.abs(l0 - l1) > 0.28) {
          issues.push({
            id: `luma-${c.id}`, severity: 'warn', time: c.start,
            title: `Brightness jump at cut #${i + 1} (${Math.round(Math.abs(l0 - l1) * 100)}%)`,
            detail: 'Sudden exposure jump across adjacent cut without per-clip color balance.',
            fixLabel: 'Auto Color-Match',
            fixFn: (app) => { autoColorMatch(p); app.changed(); },
          });
        }
      }
    }
  }

  const matteChecks = [];
  for (const fx of p.effects || []) {
    if (DEPTH_FX.has(fx.type)) matteChecks.push({ t: fx.start + 0.02, what: fx.type });
  }
  for (const tx of p.texts || []) {
    if (tx.behind) matteChecks.push({ t: tx.start + 0.02, what: `text "${tx.text.slice(0, 14)}"` });
  }
  const warnedClips = new Set();
  for (const mc of matteChecks) {
    const ci = clipIndexAt(clips, mc.t);
    if (ci < 0) continue;
    const c = clips[ci], m = getMedia(p, c.mediaId);
    if (!m || warnedClips.has(m.id)) continue;
    if (!(m.masks && m.masks.frames && m.masks.frames.size)) {
      warnedClips.add(m.id);
      issues.push({
        id: `matte-${c.id}`, severity: 'warn', time: c.start,
        title: `Missing subject matte for ${mc.what}`,
        detail: `${m.name} has no cached subject mask yet; depth compositing will render flat until segmented.`,
      });
    }
  }

  for (const tx of p.texts || []) {
    if (tx.dur < 0.25 && tx.style !== 'countdown' && tx.style !== 'lockword') {
      issues.push({
        id: `txdur-${tx.id}`, severity: 'warn', time: tx.start,
        title: `Short text "${tx.text.slice(0, 14)}" (${tx.dur.toFixed(2)}s)`,
        detail: 'Viewers need at least ~0.25s to read standalone overlays.',
        fixLabel: 'Set to 0.5s',
        fixFn: (app) => { tx.dur = 0.5; app.changed(); },
      });
    }
  }

  if (clips.length && !p.music) {
    issues.push({
      id: 'nomusic', severity: 'info', time: 0,
      title: 'No soundtrack selected',
      detail: 'Add a song or choose a built-in beat track for beat-sync checks.',
    });
  }

  let penalty = 0, errCount = 0;
  for (const q of issues) {
    if (q.severity === 'err') { penalty += 16; errCount++; }
    else if (q.severity === 'warn') penalty += 7;
    else penalty += 3;
  }
  const score = clamp(Math.round(100 - penalty), 0, 100);
  const pass = score >= 75 && errCount === 0;
  return { score, pass, issues };
}

/** Updates topbar #btnQA badge and timeline ruler pins without switching tabs. */
export function updateQABadge(app) {
  const res = analyzeProjectQA(app.project);
  app.qaIssues = res.issues;
  const btn = document.getElementById('btnQA');
  if (btn) {
    const n = res.issues.filter((i) => i.severity !== 'info').length;
    btn.textContent = n ? `QA ${res.score} (${n})` : `✓ QA ${res.score}`;
    btn.classList.remove('ok', 'busy');
    btn.classList.add(res.pass && !n ? 'ok' : 'busy');
    btn.style.borderColor = res.score < 70 ? '#f8717188' : '';
  }
  if (app.timeline) app.timeline.drawCanvases();
  return res;
}

/** Renders interactive Pre-Flight QA & 1-Click Auto-Fix panel into `container`. */
export function renderQAPanel(app, container) {
  if (!container) return;
  const res = updateQABadge(app);
  const cls = res.score >= 85 ? 'ok' : res.score >= 65 ? 'warn' : 'err';
  const fixable = res.issues.filter((q) => typeof q.fixFn === 'function');
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  container.innerHTML = `
    <div class="qa-head">
      <div>
        <div class="section-title" style="margin:0">Edit Pre-Flight QA</div>
        <div class="sub" style="font-size:11px;color:var(--muted)">${res.issues.length} note${res.issues.length === 1 ? '' : 's'} found</div>
      </div>
      <div class="qa-score ${cls}">${res.score}<span style="font-size:11px;font-weight:600">/100</span></div>
    </div>
    <div class="ai-actions" style="margin-bottom:10px">
      <button class="btn small" id="qaRescan">↻ Re-Scan</button>
      ${fixable.length ? `<button class="btn small primary" id="qaFixAll">⚡ Auto-Fix (${fixable.length})</button>` : ''}
    </div>
    <div class="qa-list">
      ${res.issues.length ? res.issues.map((q, idx) => `
        <div class="qa-card ${q.severity}">
          <div class="qa-card-top">
            <span>${q.severity === 'err' ? '⛔' : q.severity === 'warn' ? '⚠' : 'ℹ'} ${esc(q.title)}</span>
            <button class="link-btn" data-qjump="${idx}">${Number.isFinite(q.time) ? q.time.toFixed(2) + 's' : ''}</button>
          </div>
          <div style="color:var(--muted);line-height:1.45">${esc(q.detail)}</div>
          ${q.fixLabel && q.fixFn ? `<div class="qa-card-acts"><button class="btn xs primary" data-qfix="${idx}">⚡ ${esc(q.fixLabel)}</button></div>` : ''}
        </div>`).join('') : '<div class="empty-note">All automated checks passed — cuts, pacing, levels, and mattes look clean.</div>'}
    </div>`;

  const rescan = container.querySelector('#qaRescan');
  if (rescan) rescan.onclick = () => renderQAPanel(app, container);

  const fixAll = container.querySelector('#qaFixAll');
  if (fixAll) {
    fixAll.onclick = async () => {
      fixAll.disabled = true;
      app.history.push();
      for (const q of fixable) {
        try { await q.fixFn(app); } catch (e) { console.warn('[qa fix]', e); }
      }
      renderQAPanel(app, container);
    };
  }

  container.querySelectorAll('[data-qjump]').forEach((b) => {
    b.onclick = () => {
      const q = res.issues[+b.dataset.qjump];
      if (q && Number.isFinite(q.time)) app.player.seek(q.time);
    };
  });

  container.querySelectorAll('[data-qfix]').forEach((b) => {
    b.onclick = async () => {
      const q = res.issues[+b.dataset.qfix];
      if (!q || !q.fixFn) return;
      b.disabled = true;
      b.textContent = 'Fixing…';
      app.history.push();
      try { await q.fixFn(app); } catch (e) { console.warn('[qa fix]', e); }
      renderQAPanel(app, container);
    };
  });
}
