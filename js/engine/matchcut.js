import { clamp } from '../state.js';
import { facesAt } from '../analysis/faces.js';
import { gridMean } from '../analysis/video.js';

function nearestIntelSample(media, t) {
  const samples = media && media.intel && media.intel.samples;
  if (!samples || !samples.length) return null;
  let best = samples[0], bestDt = Math.abs(samples[0].t - t), bestIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = Math.abs(samples[i].t - t);
    if (dt < bestDt) { best = samples[i]; bestDt = dt; bestIdx = i; }
  }
  return { sample: best, idx: bestIdx, samples };
}

function boxCenterSize(box) {
  if (!box || box.length < 4) return null;
  const cx = clamp((box[0] + box[2]) * 0.5, 0.02, 0.98);
  const cy = clamp((box[1] + box[3]) * 0.5, 0.02, 0.98);
  const h = Math.max(0.05, Math.abs(box[3] - box[1]));
  const w = Math.max(0.05, Math.abs(box[2] - box[0]));
  return { cx, cy, size: clamp(Math.max(h, w * 0.8), 0.06, 0.92) };
}

/**
 * Extracts normalized subject pose, position, scale, and motion vector at media time `t`.
 * Uses Local AI `media.intel` samples when available, falling back cleanly to browser grid/faces.
 */
export function extractPose(media, t = 0) {
  const def = {
    cx: 0.5, cy: 0.45, size: 0.34, tilt: 0,
    flowMag: 0, dirX: 0, dirY: 0,
    shotType: 'mid', headBox: null, eyeMid: null,
    tags: {}, luma: 0.5, score: 5, hasSubject: false,
  };
  if (!media) return def;

  const hit = nearestIntelSample(media, t);
  if (hit && Math.abs(hit.sample.t - t) <= 2.5) {
    const s = hit.sample;
    const hb = boxCenterSize(s.head || s.face);
    let cx = hb ? hb.cx : 0.5;
    let cy = hb ? hb.cy : 0.45;
    if (s.eyeMid && s.eyeMid.length >= 2) {
      cx = clamp(s.eyeMid[0], 0.05, 0.95);
      cy = clamp(s.eyeMid[1], 0.05, 0.95);
    }
    const size = clamp(hb ? hb.size : (s.headRatio || (s.hasFace ? 0.36 : 0.28)), 0.08, 0.9);
    let dirX = 0, dirY = 0;
    const next = hit.samples[hit.idx + 1];
    if (next && next.t > s.t && next.t - s.t <= 1.5) {
      const nb = boxCenterSize(next.head || next.face);
      const nx = next.eyeMid ? next.eyeMid[0] : (nb ? nb.cx : cx);
      const ny = next.eyeMid ? next.eyeMid[1] : (nb ? nb.cy : cy);
      dirX = clamp(nx - cx, -0.5, 0.5);
      dirY = clamp(ny - cy, -0.5, 0.5);
    }
    return {
      cx, cy, size,
      tilt: Number(s.headTilt) || 0,
      flowMag: clamp((s.flowP75 || 0) / 14, 0, 1),
      dirX, dirY,
      shotType: size >= 0.42 ? 'closeup' : size >= 0.22 ? 'mid' : 'wide',
      headBox: s.head || s.face || null,
      eyeMid: s.eyeMid || null,
      tags: s.tags || {},
      luma: s.lumaMed ?? 0.5,
      score: s.score ?? 5,
      hasSubject: !!(s.head || s.face || s.hasFace),
    };
  }

  // Fallback to browser face tracker & grid analysis
  const faces = facesAt(media, t);
  const fbox = faces && faces.length ? boxCenterSize(faces[0]) : null;
  const g = media.analysis && media.analysis.grid;
  let cx = fbox ? fbox.cx : 0.5;
  let cy = fbox ? fbox.cy : 0.45;
  let size = fbox ? fbox.size : 0.32;
  let flowMag = 0, luma = 0.5, dirX = 0;
  if (g) {
    if (!fbox && g.px) cx = clamp(gridMean(g, 'px', t, t + 0.25), 0.1, 0.9);
    if (!fbox && g.py) cy = clamp(gridMean(g, 'py', t, t + 0.25), 0.1, 0.9);
    if (g.pm) flowMag = clamp(gridMean(g, 'pm', t, t + 0.25), 0, 1);
    if (g.pl) luma = clamp(gridMean(g, 'pl', t, t + 0.25), 0, 1);
    if (g.px) {
      const cx2 = clamp(gridMean(g, 'px', t + 0.15, t + 0.45), 0.1, 0.9);
      dirX = clamp(cx2 - cx, -0.5, 0.5);
    }
  }
  return {
    ...def,
    cx, cy, size, flowMag, dirX,
    shotType: size >= 0.42 ? 'closeup' : size >= 0.22 ? 'mid' : 'wide',
    headBox: faces && faces.length ? faces[0] : null,
    luma,
    hasSubject: !!(fbox || (g && g.pf && gridMean(g, 'pf', t, t + 0.25) > 0.2)),
  };
}

function tagOverlap(a = {}, b = {}) {
  const keysA = Object.keys(a), keysB = Object.keys(b);
  if (!keysA.length || !keysB.length) return 0.4;
  let dot = 0, nA = 0, nB = 0;
  for (const k of keysA) {
    const va = +a[k] || 0;
    nA += va * va;
    if (b[k] != null) dot += va * (+b[k] || 0);
  }
  for (const k of keysB) { const vb = +b[k] || 0; nB += vb * vb; }
  return nA > 0 && nB > 0 ? clamp(dot / Math.sqrt(nA * nB), 0, 1) : 0.3;
}

function evalOrientation(outPose, inPose, mirror) {
  const inX = mirror ? 1 - inPose.cx : inPose.cx;
  const inDirX = mirror ? -inPose.dirX : inPose.dirX;
  const inTilt = mirror ? -inPose.tilt : inPose.tilt;

  const dx = inX - outPose.cx;
  const dy = inPose.cy - outPose.cy;
  const posMatch = Math.exp(-9 * (dx * dx + dy * dy));

  const logRatio = Math.abs(Math.log(Math.max(0.06, inPose.size) / Math.max(0.06, outPose.size)));
  const scaleMatch = 1 - clamp(logRatio / 1.25, 0, 1);

  const shotBonus = outPose.shotType === inPose.shotType ? 0.35 : 0.12;
  const tiltDiff = Math.abs((outPose.tilt || 0) - inTilt);
  const tiltBonus = (1 - clamp(tiltDiff / 0.7, 0, 1)) * 0.25;
  const actionMatch = clamp(shotBonus + tiltBonus + tagOverlap(outPose.tags, inPose.tags) * 0.4, 0, 1);

  const magOut = Math.hypot(outPose.dirX, outPose.dirY), magIn = Math.hypot(inDirX, inPose.dirY);
  let flowAngleMatch = 1 - clamp(Math.abs(outPose.flowMag - inPose.flowMag) * 0.85, 0, 1);
  if (magOut > 0.015 && magIn > 0.015) {
    const cos = (outPose.dirX * inDirX + outPose.dirY * inPose.dirY) / (magOut * magIn);
    flowAngleMatch = 0.5 * flowAngleMatch + 0.5 * clamp((cos + 1) * 0.5, 0, 1);
  }

  const score = 0.4 * posMatch + 0.25 * scaleMatch + 0.2 * actionMatch + 0.15 * flowAngleMatch;
  return { score, posMatch, scaleMatch, actionMatch, flowAngleMatch, dx, dy };
}

/**
 * Scores match-cut quality between an outgoing pose and an incoming pose, checking
 * both standard orientation and horizontal mirror flip.
 */
export function scorePosePair(outPose, inPose) {
  const normal = evalOrientation(outPose, inPose, false);
  const flipped = evalOrientation(outPose, inPose, true);
  const mirrorRecommended = flipped.score >= normal.score + 0.12;
  const best = mirrorRecommended ? flipped : normal;
  return {
    score: clamp(best.score, 0, 1),
    normalScore: clamp(normal.score, 0, 1),
    mirrorScore: clamp(flipped.score, 0, 1),
    mirrorRecommended,
    posMatch: best.posMatch,
    scaleMatch: best.scaleMatch,
    actionMatch: best.actionMatch,
    flowAngleMatch: best.flowAngleMatch,
    dx: best.dx,
    dy: best.dy,
    dScale: clamp(outPose.size / Math.max(0.06, inPose.size), 0.4, 2.5),
  };
}

/**
 * Computes initial crop & scale alignment so the incoming clip locks cleanly onto
 * the outgoing clip's subject center and scale at the cut.
 */
export function computeAlignTransform(outPose, inPose, mirror = false) {
  const o = outPose || { cx: 0.5, cy: 0.45, size: 0.34 };
  const i = inPose || { cx: 0.5, cy: 0.45, size: 0.34 };
  const zoom = clamp(Math.sqrt(o.size / Math.max(0.08, i.size)), 1.0, 1.75);
  // Nudge crop center toward subject while countering screen-space offset from outgoing center
  const effX = mirror ? 1 - i.cx : i.cx;
  const shiftX = clamp(effX - o.cx, -0.18, 0.18);
  const panX = clamp(i.cx + (mirror ? -shiftX : shiftX) * 0.35, 0.12, 0.88);
  const panY = clamp(i.cy + (i.cy - o.cy) * 0.35, 0.12, 0.88);
  return {
    panX: +panX.toFixed(4),
    panY: +panY.toFixed(4),
    zoom: +zoom.toFixed(3),
    mirror: !!mirror,
    settleDur: 0.14,
  };
}

/**
 * Selects a non-repeating sequence of `count` candidates maximizing pose-to-pose transitions.
 */
export function buildMatchCutSequence(candidates, count, opts = {}) {
  const pool = (candidates || []).map((c, idx) => ({
    ...c,
    _idx: idx,
    pose: c.pose || extractPose(c.media, c.srcIn || 0),
    baseScore: Number.isFinite(c.score) ? c.score : 0.5,
  }));
  if (!pool.length || count <= 0) return [];
  const minSep = opts.minSep ?? 1.5;

  // Open on the candidate with highest base composition score
  let curIdx = 0;
  for (let i = 1; i < pool.length; i++) {
    if (pool[i].baseScore > pool[curIdx].baseScore) curIdx = i;
  }

  const picked = [{ ...pool[curIdx], mirror: false, align: null, pairScore: 1 }];
  const used = [pool[curIdx]];

  while (picked.length < count) {
    const prev = picked[picked.length - 1];
    let best = null, bestTotal = -Infinity, bestPair = null;

    for (const cand of pool) {
      if (used.some((u) => u === cand || (u.mediaId === cand.mediaId && Math.abs((u.srcIn || 0) - (cand.srcIn || 0)) < minSep))) {
        continue;
      }
      const pair = scorePosePair(prev.pose, cand.pose);
      const total = pair.score * 0.62 + clamp(cand.baseScore / 10, 0, 1) * 0.38;
      if (total > bestTotal) { bestTotal = total; best = cand; bestPair = pair; }
    }
    if (!best) break;
    const mirror = !!bestPair.mirrorRecommended;
    const align = computeAlignTransform(prev.pose, best.pose, mirror);
    picked.push({ ...best, mirror, align, pairScore: +bestPair.score.toFixed(3) });
    used.push(best);
  }
  return picked;
}
