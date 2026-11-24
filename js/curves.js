// Shared Bezier curve and keyframe math (backward compatible with legacy [u, val] tuples).
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);

export const CURVE_PRESETS = {
  // Normalized 0..1 shaping curves
  linear: [
    { u: 0, v: 0, ease: 'linear' },
    { u: 1, v: 1, ease: 'linear' },
  ],
  easeOut: [
    { u: 0, v: 0, ease: 'cubic', c1: [0.16, 1], c2: [0.3, 1] },
    { u: 1, v: 1, ease: 'linear' },
  ],
  easeIn: [
    { u: 0, v: 0, ease: 'cubic', c1: [0.7, 0], c2: [0.84, 0] },
    { u: 1, v: 1, ease: 'linear' },
  ],
  easeInOut: [
    { u: 0, v: 0, ease: 'cubic', c1: [0.42, 0], c2: [0.58, 1] },
    { u: 1, v: 1, ease: 'linear' },
  ],
  whipOut: [
    { u: 0, v: 0, ease: 'cubic', c1: [0.08, 0.96], c2: [0.22, 1] },
    { u: 1, v: 1, ease: 'linear' },
  ],
  twoStage: [
    { u: 0, v: 0, ease: 'cubic', c1: [0.06, 0.92], c2: [0.18, 0.85] },
    { u: 0.18, v: 0.85, ease: 'linear' },
    { u: 1, v: 1, ease: 'linear' },
  ],
  overshoot: [
    { u: 0, v: 0, ease: 'cubic', c1: [0.22, 1.28], c2: [0.45, 1.04] },
    { u: 1, v: 1, ease: 'linear' },
  ],
  hold: [
    { u: 0, v: 0, ease: 'hold' },
    { u: 1, v: 1, ease: 'hold' },
  ],

  // Velocity speed curves (multipliers)
  twixtor: [
    { u: 0, v: 2.0, ease: 'cubic', c1: [0.12, 0.9], c2: [0.35, 1] },
    { u: 0.25, v: 0.45, ease: 'cubic', c1: [0.3, 0], c2: [0.7, 1] },
    { u: 0.72, v: 0.45, ease: 'cubic', c1: [0.65, 0], c2: [0.88, 0.9] },
    { u: 1, v: 2.2, ease: 'linear' },
  ],
  swell: [
    { u: 0, v: 1.5, ease: 'smooth' },
    { u: 0.42, v: 1.0, ease: 'smooth' },
    { u: 0.6, v: 1.0, ease: 'smooth' },
    { u: 1, v: 1.6, ease: 'smooth' },
  ],
  bullet: [
    { u: 0, v: 1.6, ease: 'smooth' },
    { u: 0.38, v: 1.0, ease: 'smooth' },
    { u: 0.62, v: 1.0, ease: 'smooth' },
    { u: 1, v: 1.7, ease: 'smooth' },
  ],
  heroSlow: [
    { u: 0, v: 0.45, ease: 'linear' },
    { u: 1, v: 0.45, ease: 'linear' },
  ],
  hitStop: [
    { u: 0, v: 1.0, ease: 'hold' },
    { u: 0.4, v: 0.05, ease: 'hold' },
    { u: 0.58, v: 1.4, ease: 'smooth' },
    { u: 1, v: 1.0, ease: 'linear' },
  ],
};

const keyU = (k) => (Array.isArray(k) ? k[0] : k.u);
const keyV = (k) => (Array.isArray(k) ? k[1] : k.v);

function bezierSample(t, p1, p2) {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function bezierSlope(t, p1, p2) {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

// Solves cubic Bezier x(t) = targetX for t in [0, 1] with Newton-Raphson + bisection fallback.
export function solveBezierX(x, x1, x2) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx1 = clamp(x1, 0.001, 0.999);
  const cx2 = clamp(x2, 0.001, 0.999);
  let t = x;
  for (let i = 0; i < 6; i++) {
    const err = bezierSample(t, cx1, cx2) - x;
    if (Math.abs(err) < 1e-6) return t;
    const d = bezierSlope(t, cx1, cx2);
    if (Math.abs(d) < 1e-5) break;
    t = clamp(t - err / d, 0, 1);
  }
  let lo = 0, hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = 0.5 * (lo + hi);
    const xv = bezierSample(mid, cx1, cx2);
    if (Math.abs(xv - x) < 1e-5) return mid;
    if (xv < x) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export function evalCurve(keys, u, fallback = 1) {
  if (!keys || !keys.length) return fallback;
  if (u <= keyU(keys[0])) return keyV(keys[0]);
  for (let i = 1; i < keys.length; i++) {
    const k0 = keys[i - 1], k1 = keys[i];
    const u0 = keyU(k0), u1 = keyU(k1);
    if (u <= u1) {
      const v0 = keyV(k0), v1 = keyV(k1);
      const f = u1 > u0 ? (u - u0) / (u1 - u0) : 1;
      const ease = Array.isArray(k0) ? 'smooth' : (k0.ease || 'smooth');
      if (ease === 'hold') return v0;
      if (ease === 'linear') return v0 + (v1 - v0) * f;
      if (ease === 'cubic') {
        const c1 = k0.c1 || [0.35, 0];
        const c2 = k0.c2 || [0.65, 1];
        const bt = solveBezierX(f, c1[0], c2[0]);
        const py = bezierSample(bt, c1[1], c2[1]);
        return v0 + (v1 - v0) * py;
      }
      return v0 + (v1 - v0) * smooth(f);
    }
  }
  return keyV(keys[keys.length - 1]);
}

export function normalizeKeys(keys, fallback = 1) {
  if (!keys || !keys.length) {
    return [
      { u: 0, v: fallback, ease: 'smooth', c1: [0.35, 0], c2: [0.65, 1] },
      { u: 1, v: fallback, ease: 'smooth', c1: [0.35, 0], c2: [0.65, 1] },
    ];
  }
  return [...keys]
    .map((k) => {
      if (Array.isArray(k)) {
        return { u: clamp(+k[0] || 0, 0, 1), v: +k[1], ease: 'smooth', c1: [0.35, 0], c2: [0.65, 1] };
      }
      return {
        u: clamp(+k.u || 0, 0, 1),
        v: Number.isFinite(+k.v) ? +k.v : fallback,
        ease: k.ease || 'smooth',
        c1: Array.isArray(k.c1) ? [+k.c1[0], +k.c1[1]] : [0.35, 0],
        c2: Array.isArray(k.c2) ? [+k.c2[0], +k.c2[1]] : [0.65, 1],
      };
    })
    .sort((a, b) => a.u - b.u);
}
