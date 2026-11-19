// WebGL2 compositor: layout + transform + distortion + blur + chroma + grade
// pass, bloom, then a finishing pass (speed lines, leaks, VHS, vignette, grain,
// bars, text, flash, fade, motion-blur feedback).
import { clamp, lerp, smooth, clipIndexAt, srcTimeAt, speedAt, getMedia, timelineDuration, clipSpan } from '../state.js';
import { gridMean } from '../analysis/video.js';
import { fxState } from '../effects.js';
import { vfxAsset, vfxImage, vfxMode } from '../vfx.js';
import { faceBoxAt } from '../analysis/faces.js';

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// HSV and an anime-skin detector, shared by the FX boost shaders. Skin is warm (about 7–55°),
// lightly to moderately saturated and not dark; fire and energy of the same hue are far more
// saturated, so they are not mistaken for it.
const HSV_GLSL = `
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
float skinW(vec3 hv) {
  float hw = smoothstep(0.0, 0.03, hv.x) * (1.0 - smoothstep(0.12, 0.16, hv.x));
  return hw * smoothstep(0.06, 0.14, hv.y) * (1.0 - smoothstep(0.55, 0.68, hv.y)) * smoothstep(0.2, 0.35, hv.z);
}`;

const SCENE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform float uHasSrc;
uniform vec2 uCenter, uRegion, uShift, uDirBlur, uSrcTexel, uRegionBg;
uniform vec4 uWin;
uniform float uRot, uAspect, uZoomBlur, uRgb, uGlitch, uSeed, uTime, uBgMode, uRot90;
uniform vec2 uTilt;
uniform float uWarp, uWarpMode, uDefocus, uSharpen, uVhs, uImpact, uImpactMode, uStack, uComb, uCrush, uLift;
uniform vec3 uGhost; // a larger copy of the picture laid over it: alpha, scale, colour fringe
uniform vec4 uTone; // the shot in one colour of light: colour, amount
uniform vec4 uShade; // the character's shadow: amount, scale, shift x, shift y (shares of the frame)
uniform vec3 uShadeCol;
uniform float uDof; // depth of field: the background behind the character softened
uniform vec4 uClone; // the canonical spec's clone (docs/your-month-spec-v2.md): screen-blend opacity, scale, blur length (share of the frame), highlight-bloom glow
uniform vec3 uCloneCol; // the clone's glow, the character's colour
uniform vec2 uClonePivot; // the point of the output frame the clone grows from
uniform float uBgDark; // the background plate (not the character) darkened by this share
uniform vec4 uLut; // one dark S-curve grade: amount, shadow crush, highlight shoulder, tint
uniform vec3 uLutCol; // the grade's signature hue
uniform float uLutDuo; // the block's shared tint across the whole range (the user's second notes, 8 Nov 2026)
uniform vec3 uWb; // the shot's white balance, as gains (the same notes: "Normalize white balance")
uniform float uClean; // the user's third notes (8 Nov 2026), on for the month edits: no positive overshoot anywhere (the bicubic, the sharpening, the punch's ghost) and the background blur without the character in it
uniform vec3 uIris; // the iris and rim-light bloom on the intro and shot 3 close-ups (same notes): intensity, radius as a share of the frame's height, 0
uniform vec3 uIrisCol; // its tint, the character's colour
uniform vec4 uEyeA, uEyeB; // the eyes' boxes in the source picture (x0, y0, x1, y1), all zero when the tracker found none
uniform vec4 uPara; // the master spec's option A (9 Nov 2026), 2.5D parallax on a low-motion clip: the character's scale, the plate's scale, the plate's blur (share of the frame), on
uniform vec2 uParaAnchor; // the point both layers grow from (the eye lock, 50% / 38%)
uniform vec3 uRim; // option C, a specular sweep across glowing eyes and hair on a Shot 3 climax: phase 0-1 (below 0 off), amount, band width
uniform float uExposure, uContrast, uSaturation, uTemp, uTint, uFade, uBW, uInvert, uDuoAmt, uAccent, uSoftGrade;
uniform vec3 uShadows, uHighlights, uDuo;
uniform float uVibrance;
uniform float uDepth, uRich; // cinematic finish: midtones down with true blacks; richer colour below the highlights
uniform vec4 uShock; // impact shockwave: point (output), progress, strength
uniform sampler2D uSubj; // character mask for the picture band [uSubjBox.x, uSubjBox.y] of the source
uniform vec2 uSubjBox;
uniform float uHasSubj;
uniform float uSharpSubj; // the character stays out of the zoom blur (impact smash)
uniform vec2 uBaseBand, uSrcBox; // footage with black bars baked in: its picture's resting place in the frame, and inside the source
uniform sampler2D uNext;   // preview windows: the next shot's first frame
uniform float uHasNext, uPrevShape, uPrevP, uPrevK;
uniform vec2 uNextCenter, uNextRegion, uPrevFocus, uPrevBand;
// camera motion blur: the camera half a frame earlier (180° shutter), so each point blurs along
// exactly how the editor's own move carried it (push, pan, shake), never the footage's content
uniform vec4 uCamPrevA, uCamPrevB; // centre.xy, region.xy | shift.xy, rotation, on
uniform vec2 uCamPrevTilt;

float hash(float n) { return fract(sin(n) * 43758.5453123); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hueOf(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
  if (d < 1e-4) return 0.0;
  float h = mx == c.r ? mod((c.g - c.b) / d, 6.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return h / 6.0;
}
${HSV_GLSL}

// Catmull-Rom bicubic in 9 bilinear taps: crisper line art when a crop is enlarged.
vec3 bicubic(vec2 uv) {
  vec2 size = 1.0 / uSrcTexel;
  vec2 sp = uv * size;
  vec2 t1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (t1 - 1.0) / size, t3 = (t1 + 2.0) / size, t12 = (t1 + w2 / w12) / size;
  vec3 r = texture(uSrc, vec2(t0.x, t0.y)).rgb * w0.x * w0.y
         + texture(uSrc, vec2(t12.x, t0.y)).rgb * w12.x * w0.y
         + texture(uSrc, vec2(t3.x, t0.y)).rgb * w3.x * w0.y
         + texture(uSrc, vec2(t0.x, t12.y)).rgb * w0.x * w12.y
         + texture(uSrc, vec2(t12.x, t12.y)).rgb * w12.x * w12.y
         + texture(uSrc, vec2(t3.x, t12.y)).rgb * w3.x * w12.y
         + texture(uSrc, vec2(t0.x, t3.y)).rgb * w0.x * w3.y
         + texture(uSrc, vec2(t12.x, t3.y)).rgb * w12.x * w3.y
         + texture(uSrc, vec2(t3.x, t3.y)).rgb * w3.x * w3.y;
  if (uClean > 0.5) {
    // (the user's third notes: "Clamp positive overshoot to 0": Catmull-Rom's negative lobes put a bright rim beside a black line
    // when a crop is enlarged; the result is held inside its four nearest texels, so no pixel is lighter or darker than they are)
    vec3 n00 = texture(uSrc, t1 / size).rgb, n10 = texture(uSrc, (t1 + vec2(1.0, 0.0)) / size).rgb;
    vec3 n01 = texture(uSrc, (t1 + vec2(0.0, 1.0)) / size).rgb, n11 = texture(uSrc, (t1 + vec2(1.0, 1.0)) / size).rgb;
    r = clamp(r, min(min(n00, n10), min(n01, n11)), max(max(n00, n10), max(n01, n11)));
  }
  return max(r, 0.0);
}

// Preview windows: hard-edged shapes through which the next shot shows before the cut. Each
// appears frosted white and clears over a couple of frames. Returns (inside, frost).
vec2 previewMask(vec2 p) {
  float ins = 0.0, fr = 0.0;
  // laid out on the footage's own picture (inside any black bars baked into the video)
  if (p.y < uPrevBand.x || p.y > uPrevBand.y) return vec2(0.0);
  vec2 q = vec2(p.x, (p.y - uPrevBand.x) / max(0.01, uPrevBand.y - uPrevBand.x));
  if (uPrevShape < 0.5) {
    for (int i = 0; i < 2; i++) {
      vec4 r = i == 0 ? vec4(0.14, 0.2, 0.32, 0.52) : vec4(0.62, 0.11, 0.8, 0.89);
      float at = i == 0 ? 0.0 : 0.4;
      if (uPrevP >= at && q.x > r.x && q.x < r.z && q.y > r.y && q.y < r.w) { ins = 1.0; fr = max(fr, 0.6 * (1.0 - smoothstep(0.0, 0.14, uPrevP - at))); }
    }
  } else if (uPrevShape < 1.5) {
    // measured in band heights so the circle stays round on a letterboxed picture
    float ab = uAspect / max(0.01, uPrevBand.y - uPrevBand.x);
    vec2 d = q - uPrevFocus;
    d.x *= ab;
    if (length(d) < mix(0.11, 0.26, uPrevP) * ab) { ins = 1.0; fr = 0.6 * (1.0 - smoothstep(0.0, 0.14, uPrevP)); }
  } else {
    for (int i = 0; i < 7; i++) {
      float x0 = 0.07 + float(i) * 0.105, at = float(i) / 7.0;
      if (uPrevP >= at && q.x > x0 && q.x < x0 + 0.075 && q.y > 0.07 && q.y < 0.93) { ins = 1.0; fr = max(fr, 0.6 * (1.0 - smoothstep(0.0, 0.1, uPrevP - at))); }
    }
  }
  return vec2(ins, fr);
}

vec2 toSrcWith(vec2 p, vec2 center, vec2 region, vec2 shift, float rot, vec2 tilt) {
  vec2 q = p - 0.5 - shift;
  q.x *= uAspect;
  if (dot(tilt, tilt) > 1e-6) {
    vec2 k = sin(tilt) * 0.45;
    vec2 n = q / vec2(0.5 * uAspect, 0.5);
    q = q / (1.0 + n.x * k.x + n.y * k.y) * (1.0 - abs(k.x) - abs(k.y));
  }
  float c = cos(rot), s = sin(rot);
  q = mat2(c, s, -s, c) * q;
  q.x /= uAspect;
  return center + q * region;
}

vec2 toSrc(vec2 p) {
  vec2 q = p - 0.5 - uShift;
  q.x *= uAspect;
  if (dot(uTilt, uTilt) > 1e-6) {
    // perspective swing/tilt: the picture plane turns in 3D (keystone). Measured against the
    // frame's half-size so portrait and landscape swing alike, and zoomed exactly enough that
    // the near edge never pulls in past the picture (which would show a mirrored copy)
    vec2 k = sin(uTilt) * 0.45;
    vec2 n = q / vec2(0.5 * uAspect, 0.5);
    q = q / (1.0 + n.x * k.x + n.y * k.y) * (1.0 - abs(k.x) - abs(k.y));
  }
  float c = cos(uRot), s = sin(uRot);
  q = mat2(c, s, -s, c) * q;
  q.x /= uAspect;
  return uCenter + q * uRegion;
}

// the character mask at a source point (0 outside the picture band), eased between lo and hi
float subjAt(vec2 su, float lo, float hi) {
  float my = (su.y - uSubjBox.x) / (uSubjBox.y - uSubjBox.x);
  return (my >= 0.0 && my <= 1.0 && su.x >= 0.0 && su.x <= 1.0) ? smoothstep(lo, hi, texture(uSubj, vec2(su.x, my)).r) : 0.0;
}

// the iris and rim-light bloom's key (the user's third notes, 8 Nov 2026: "keyed to high-saturation eye irises and bright rim
// highlights"): inside an eye's box (20% margin), saturated and lit colour; on the character at their outline, near-white light.
// kc returns the source colour, for the bloom's own hue
float eyeBoxW(vec2 su, vec4 b) {
  if (b.z <= b.x || b.w <= b.y) return 0.0;
  vec2 c = 0.5 * (b.xy + b.zw), h = max(0.5 * (b.zw - b.xy), vec2(1e-4));
  vec2 d = abs(su - c) / h;
  return 1.0 - smoothstep(0.85, 1.05, max(d.x, d.y));
}
float irisKey(vec2 q, out vec3 kc) {
  vec2 su = toSrc(q);
  vec3 c = texture(uSrc, su).rgb * uWb; kc = c;
  vec3 hv = rgb2hsv(clamp(c, 0.0, 1.0));
  // (the box held to the eye itself; saturated colour that isn't ink: Power's dark irises keyed only at a tenth with the first floors)
  float iris = max(eyeBoxW(su, uEyeA), eyeBoxW(su, uEyeB)) * smoothstep(0.22, 0.45, hv.y) * smoothstep(0.14, 0.38, hv.z);
  float rim = 0.0;
  float m0 = subjAt(su, 0.3, 0.7);
  if (m0 > 0.01 && luma(c) > 0.68) {
    vec2 d1 = vec2(0.012, 0.0) * uRegion, d2 = vec2(0.0, 0.012) * uRegion;
    float edge = clamp(abs(subjAt(su + d1, 0.3, 0.7) - subjAt(su - d1, 0.3, 0.7)) + abs(subjAt(su + d2, 0.3, 0.7) - subjAt(su - d2, 0.3, 0.7)), 0.0, 1.0);
    rim = m0 * edge * smoothstep(0.72, 0.92, luma(c));
  }
  return max(iris, rim);
}

vec3 grade(vec3 col) {
  // (a soft grade, for a gentle edit: the darkening eases off towards the highlights, so the mids go
  // down and the white point stays where the drawing had it instead of greying)
  col *= exp2(uExposure * (uExposure < 0.0 ? 1.0 - uSoftGrade * smoothstep(0.45, 0.95, luma(col)) : 1.0));
  col *= vec3(1.0 + uTemp * 0.18, 1.0 - uTint * 0.08, 1.0 - uTemp * 0.18);
  float l = luma(col);
  col += uShadows * (1.0 - smoothstep(0.0, 0.55, l)) + uHighlights * smoothstep(0.45, 1.0, l);
  col = (col - 0.5) * uContrast + 0.5;
  if (uDepth > 0.001) {
    // the sharp reference edits keep their midtones low and their blacks black, with bright
    // highlights: that range is most of what reads as "crisp". Lift-free gamma on the mids.
    col = pow(max(col, 0.0), vec3(1.0 + uDepth * 0.35));
    col = max(col - uDepth * 0.015, 0.0) / (1.0 - uDepth * 0.015);
  }
  l = luma(col);
  col = mix(vec3(l), col, uSaturation);
  if (uRich > 0.001) {
    // richer colour in the shadows and midtones (not the highlights, and gently on skin)
    float lr = luma(col);
    float w = (1.0 - smoothstep(0.55, 0.95, lr)) * (1.0 - 0.6 * skinW(rgb2hsv(clamp(col, 0.0, 1.0))));
    col = mix(vec3(lr), col, 1.0 + uRich * 0.45 * w);
  }
  if (uDuoAmt > 0.001) {
    // luminance-preserving tint: keeps the shot as bright and readable as the original
    float d = clamp(luma(col), 0.0, 1.0);
    vec3 tint = uDuo / max(0.08, luma(uDuo)) * d;
    tint = mix(tint, vec3(1.0), smoothstep(0.75 - 0.15 * uSoftGrade, 1.0, d) * (0.6 + 0.4 * uSoftGrade));
    // the accent: strong colour near the palette's opposite hue (orange fire and skin against a blue
    // grade) keeps most of itself, so it glows against the one colour, as in the references
    float keep = 0.0;
    float mx = max(col.r, max(col.g, col.b)), mn = min(col.r, min(col.g, col.b)), sat = mx > 1e-4 ? (mx - mn) / mx : 0.0;
    if (uAccent > 0.001) {
      float dist = abs(fract(hueOf(col) - hueOf(uDuo) + 1.0) - 0.5);
      keep = uAccent * smoothstep(0.38, 0.46, dist) * smoothstep(0.25, 0.55, sat);
    }
    // skin keeps its own colour too (warm hues, gently saturated): a face never turns blue or violet
    float hS = hueOf(col);
    float skin = smoothstep(0.0, 0.03, hS) * (1.0 - smoothstep(0.1, 0.14, hS)) * smoothstep(0.06, 0.16, sat) * (1.0 - smoothstep(0.5, 0.7, sat));
    keep = max(keep, 0.75 * skin);
    // (the soft grade keeps blush, tears' red eyes and pink flowers too: pinks and reds, 330-10 degrees)
    if (uSoftGrade > 0.001) keep = max(keep, uSoftGrade * 0.8 * max(smoothstep(0.9, 0.94, hS), 1.0 - smoothstep(0.02, 0.05, hS)) * smoothstep(0.1, 0.25, sat));
    col = mix(col, clamp(tint, 0.0, 1.0), uDuoAmt * (1.0 - keep));
  }
  col = uFade * 0.2 + col * (1.0 - uFade * 0.3);
  col = mix(col, vec3(smoothstep(0.03, 0.97, luma(col))), uBW);
  col = mix(col, 1.0 - col, uInvert);
  return col;
}

void main() {
  vec2 full = vec2(vUv.x, 1.0 - vUv.y);
  if (full.x < uWin.x || full.x > uWin.z || full.y < uWin.y || full.y > uWin.w) {
    vec3 bg = vec3(0.0);
    if (uBgMode > 0.5 && uHasSrc > 0.5) bg = grade(textureLod(uSrc, 0.5 + (full - 0.5) * uRegionBg, 6.0).rgb * 0.55);
    o = vec4(clamp(bg, 0.0, 1.0), 1.0);
    return;
  }
  // footage with black bars baked in keeps its frame still: zooms, punches and camera moves
  // happen inside the picture, the bars never grow or shrink with them
  if (full.y < uBaseBand.x || full.y > uBaseBand.y) { o = vec4(0.0); return; }
  vec2 p = (full - uWin.xy) / (uWin.zw - uWin.xy);
  if (uRot90 > 0.5) p = vec2(p.y, 1.0 - p.x);
  vec2 p0 = p;
  if (uVhs > 0.001) p.x += (hash(floor(p.y * 240.0) + floor(uTime * 30.0) * 17.0) - 0.5) * 0.004 * uVhs;
  if (uShock.w > 0.001) {
    // shockwave from the contact point: a ring that pushes the picture outward as it expands
    vec2 d = p - uShock.xy;
    d.x *= uAspect;
    float r = length(d), R = 0.05 + uShock.z * 0.6;
    float band = exp(-pow((r - R) / 0.045, 2.0));
    vec2 dir = d / max(r, 1e-4);
    dir.x /= uAspect;
    p -= dir * band * uShock.w * 0.04;
  }
  if (uWarp > 0.001) {
    vec2 d = p - 0.5;
    d.x *= uAspect;
    float r = length(d);
    if (uWarpMode < 0.5) {
      p.x += sin(p.y * 18.0 + uTime * 25.0) * 0.015 * uWarp;
      p.y += cos(p.x * 14.0 + uTime * 20.0) * 0.01 * uWarp;
    } else {
      if (uWarpMode < 1.5) d *= 1.0 - uWarp * 0.45 * smoothstep(0.75, 0.0, r);
      else { float a = uWarp * 2.5 * smoothstep(0.7, 0.0, r); float c = cos(a), s = sin(a); d = mat2(c, s, -s, c) * d; }
      d.x /= uAspect;
      p = 0.5 + d;
    }
  }
  if (uGlitch > 0.001) {
    float bands = 8.0 + floor(20.0 * hash(uSeed));
    float band = floor(p.y * bands);
    float r = hash(band * 13.7 + uSeed * 7.1);
    if (r > 1.0 - uGlitch * 0.55) p.x += (hash(band + uSeed * 3.3) - 0.5) * 0.22 * uGlitch;
  }
  // option A: the character's layer grows faster than the plate's, both from the eye lock; the character is sampled through its own scale
  vec2 pF = uPara.w > 0.5 ? uParaAnchor + (p - uParaAnchor) / max(uPara.x, 0.5) : p;
  vec2 uv = toSrc(pF);
  uv.y = clamp(uv.y, uSrcBox.x, uSrcBox.y);
  if (uBgMode > 0.5 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) {
    o = vec4(clamp(grade(textureLod(uSrc, 0.5 + (full - 0.5) * uRegionBg, 6.0).rgb * 0.55), 0.0, 1.0), 1.0);
    return;
  }
  float keep = 0.0;
  if (uSharpSubj > 0.001 && uHasSubj > 0.5 && uHasSrc > 0.5) {
    float my = (uv.y - uSubjBox.x) / (uSubjBox.y - uSubjBox.x);
    if (my >= 0.0 && my <= 1.0 && uv.x >= 0.0 && uv.x <= 1.0) keep = smoothstep(0.3, 0.7, texture(uSubj, vec2(uv.x, my)).r) * uSharpSubj;
  }
  // how far this point moved under the camera in half a frame, in source terms (capped, so a
  // hard jump like a stepped shake smears no more than a fast whip would). The previous position is
  // held inside the picture band like this one, so letterbox edges don't smear. A character the
  // smash keeps sharp stays sharp under the camera too.
  vec2 cdir = vec2(0.0);
  float camW = 0.0;
  if (uCamPrevB.w > 0.5) {
    vec2 pv = toSrcWith(p, uCamPrevA.xy, uCamPrevA.zw, uCamPrevB.xy, uCamPrevB.z, uCamPrevTilt);
    pv.y = clamp(pv.y, uSrcBox.x, uSrcBox.y);
    cdir = (uv - pv) * (1.0 - keep);
    float L = length(cdir);
    if (L > 0.015) cdir *= 0.015 / L;
    // under a pixel stays crisp, past two pixels it's all blur, and between the two they blend
    // (a hard switch drew a ring on a push, where the move grows with distance from the centre)
    camW = smoothstep(0.75, 2.0, length(cdir / uSrcTexel));
    if (camW <= 0.0) cdir = vec2(0.0);
  }
  bool other = uZoomBlur > 0.002 || dot(uDirBlur, uDirBlur) > 1e-5 || uDefocus > 0.002;
  bool blur = other || camW > 0.0;
  // (uStack: a few distinct copies, a stacked echo, instead of one smooth smear)
  // (48 for a real blur: 16 drew rings and bands in a wide one; the camera's own small smear keeps 16)
  int taps = blur ? (uStack > 0.5 ? 6 : other ? 48 : 16) : 1;
  vec2 zdir = (uv - uCenter) * uZoomBlur * 0.16 * (1.0 - keep);
  vec2 ddir = uDirBlur * 0.09 * uRegion;
  vec2 ca = (p - 0.5) * uRgb * 0.04 * uRegion + vec2(uGlitch * 0.006 + uVhs * 0.004, 0.0);
  bool chroma = uRgb > 0.0005 || uGlitch > 0.001 || uVhs > 0.001;
  // (option C's edge RGB split is drawn in the final pass: here the entry's softened plate and option A's plate were drawn over the
  // frame's edges after it, so it never showed; found 9 Nov 2026, the red-blue offset measured 0 at all four month entries)
  vec3 acc = vec3(0.0);
  // the taps start at a per-pixel offset, so a long blur reads as one smooth smear rather than
  // a few faint copies of every outline
  float jit = uStack > 0.5 ? 0.5 : fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  for (int i = 0; i < 48; i++) {
    if (i >= taps) break;
    float f = taps > 1 ? (float(i) + jit) / float(taps) - 0.5 : 0.0;
    vec2 u = uv - zdir * (f + 0.5) + ddir * f + cdir * f;
    // (uComb: a hard whip's combed lines, rows of the picture thrown sideways by different amounts)
    if (uComb > 0.0001) u.x += uComb * uRegion.x * (fract(sin(floor(p.y * 170.0) * 12.9898) * 43758.5453) - 0.5);
    if (uDefocus > 0.002) {
      float ang = float(i) * 2.39996 + jit * 6.2832;
      u += vec2(cos(ang), sin(ang)) * sqrt((float(i) + 0.5) / float(taps)) * uDefocus * 0.035 * uRegion;
    }
    if (taps == 1) acc += chroma ? vec3(bicubic(u + ca).r, bicubic(u).g, bicubic(u - ca).b) : bicubic(u);
    else acc += chroma ? vec3(texture(uSrc, u + ca).r, texture(uSrc, u).g, texture(uSrc, u - ca).b) : texture(uSrc, u).rgb;
  }
  vec3 col = acc / float(taps);
  // only the camera's move blurs here, and only a little: blend toward the crisp picture
  if (!other && camW > 0.0 && camW < 1.0) col = mix(chroma ? vec3(bicubic(uv + ca).r, bicubic(uv).g, bicubic(uv - ca).b) : bicubic(uv), col, camW);
  col *= uWb;
  // option A's plate: the picture behind the character at the plate's own scale, blurred (uPara.z of the frame), and filled where the
  // character stood (taps on the character, its edge dilated 12 px, left out; with none left, a ring four times wider)
  if (uPara.w > 0.5 && uHasSubj > 0.5 && uHasSrc > 0.5) {
    float mF = subjAt(uv, 0.3, 0.7);
    if (mF < 0.999) {
      vec2 pB = uParaAnchor + (p - uParaAnchor) / max(uPara.y, 0.5);
      float jp = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 7.0, vec2(0.06711056, 0.00583715))));
      float d12 = 12.0 / 1080.0;
      vec3 pb = vec3(0.0); float pw = 0.0;
      for (int ring = 0; ring < 2; ring++) {
        if (ring == 1 && pw > 0.5) break;
        float rad = max(uPara.z, 0.002) * (ring == 0 ? 1.0 : 4.0);
        for (int i = 0; i < 16; i++) {
          float ang = float(i) * 2.39996 + jp * 6.2832;
          vec2 off = vec2(cos(ang) / uAspect, sin(ang)) * rad * sqrt((float(i) + 0.5) / 16.0);
          vec2 tu = toSrc(pB + off);
          float mm = subjAt(tu, 0.02, 0.2);
          mm = max(mm, max(subjAt(toSrc(pB + off + vec2(d12 / uAspect, 0.0)), 0.02, 0.2), subjAt(toSrc(pB + off - vec2(d12 / uAspect, 0.0)), 0.02, 0.2)));
          mm = max(mm, max(subjAt(toSrc(pB + off + vec2(0.0, d12)), 0.02, 0.2), subjAt(toSrc(pB + off - vec2(0.0, d12)), 0.02, 0.2)));
          float w = 1.0 - mm;
          pb += texture(uSrc, tu).rgb * w; pw += w;
        }
      }
      vec3 plate = pw > 0.05 ? pb / pw * uWb : col;
      col = mix(plate, col, mF);
    }
  }
  // depth of field: the background softened behind the character (the mask keeps the character sharp), a disc of 24 taps
  if (uDof > 0.001 && uHasSubj > 0.5 && uHasSrc > 0.5) {
    float here = 0.0;
    { float my = (uv.y - uSubjBox.x) / (uSubjBox.y - uSubjBox.x); if (my >= 0.0 && my <= 1.0 && uv.x >= 0.0 && uv.x <= 1.0) here = smoothstep(0.15, 0.65, texture(uSubj, vec2(uv.x, my)).r); }
    if (here < 0.99) {
      vec3 bg = vec3(0.0); float jd = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))), bw = 0.0;
      // under option A the softened background is the plate, at the plate's own scale. Sampled at the character's scale (uv), as
      // it was, it redrew the background over option A's plate and the parallax flattened into one zoom of the whole frame
      // (found 9 Nov 2026: the character and the frame's outer ring measured the same growth on June 6 and September 6)
      vec2 bu0 = uPara.w > 0.5 ? toSrc(uParaAnchor + (p - uParaAnchor) / max(uPara.y, 0.5)) : uv;
      for (int i = 0; i < 24; i++) {
        float ang = float(i) * 2.39996 + jd * 6.2832;
        vec2 bu = bu0 + vec2(cos(ang), sin(ang)) * sqrt((float(i) + 0.5) / 24.0) * uDof * 0.012 * uRegion;
        // (the user's third notes: the blur gathered the character's own dark hair into the plate round them, a dark smudge behind the
        // head; with uClean the taps on the character are left out, so the plate only blurs into itself)
        float wgt = uClean > 0.5 ? 1.0 - subjAt(bu, 0.15, 0.65) : 1.0;
        bg += texture(uSrc, bu).rgb * wgt; bw += wgt;
      }
      bg = bw > 0.5 ? bg / bw : col / max(uWb, vec3(1e-3));
      if (uClean > 0.5) bg *= uWb;
      col = mix(bg, col, here);
    }
  }
  // the character's shadow: their own picture, bigger and shifted, darkened towards a tint, laid behind them (only where they aren't)
  if (uShade.x > 0.001 && uHasSubj > 0.5 && uHasSrc > 0.5) {
    vec2 su = uCenter + (uv - uCenter) / max(uShade.y, 0.01) - uShade.zw * uRegion;
    float sm = 0.0, here2 = 0.0;
    { float my = (su.y - uSubjBox.x) / (uSubjBox.y - uSubjBox.x); if (my >= 0.0 && my <= 1.0 && su.x >= 0.0 && su.x <= 1.0) sm = smoothstep(0.25, 0.75, texture(uSubj, vec2(su.x, my)).r); }
    { float my = (uv.y - uSubjBox.x) / (uSubjBox.y - uSubjBox.x); if (my >= 0.0 && my <= 1.0 && uv.x >= 0.0 && uv.x <= 1.0) here2 = smoothstep(0.2, 0.6, texture(uSubj, vec2(uv.x, my)).r); }
    if (sm > 0.001) {
      vec3 sc = texture(uSrc, su).rgb; float sl = dot(sc, vec3(0.2126, 0.7152, 0.0722));
      vec3 shade = mix(sc * 0.32, uShadeCol * (0.18 + 0.55 * sl), 0.5);
      col = mix(col, shade, uShade.x * sm * (1.0 - here2));
    }
  }
  // the background plate darkened where the character isn't: the spec's 35% under the clone, and the user's second notes (8 Nov
  // 2026) on bright daytime and window plates ("a background mask exposure pull (-35% luma)")
  // (the mask is coarser than the picture: sampled once, its blocky edge left a dotted rim of the undarkened plate round the character, an
  // outline the notes ban; so it is averaged over a small disc and eased later, and the edge band darkens with the plate)
  float hereC = 0.0;
  if ((uBgDark > 0.001 || uClone.x > 0.001 || uClone.w > 0.001) && uHasSubj > 0.5 && uHasSrc > 0.5) {
    float mm = 0.0;
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.785398;
      mm += subjAt(toSrc(p + vec2(cos(ang) / uAspect, sin(ang)) * 0.008), 0.0, 1.0);
    }
    hereC = smoothstep(0.55, 0.95, 0.5 * subjAt(uv, 0.0, 1.0) + 0.5 * mm / 8.0);
    col *= 1.0 - uBgDark * (1.0 - hereC);
  }
  // the clone, to the user's second notes: the character's own full-colour cut-out, bigger from the pivot, brightened, blurred about
  // 20 px along the line from the pivot (a zoom blur) and softened all round so no edge stays hard, screened on behind them at
  // 25-35%. ("Do NOT darken the clone's internal RGB fill into a black/gray silhouette, and remove the solid morphological contour
  // stroke": the first version averaged the colour along a long blur into grey and drew a glow on the mask's edge)
  vec3 cloneLate = vec3(0.0);
  if (uClone.x > 0.001 && uHasSubj > 0.5 && uHasSrc > 0.5) {
    vec2 c0 = uClonePivot + (p - uClonePivot) / max(uClone.y, 0.01);
    vec2 rd = c0 - uClonePivot; rd.x *= uAspect;
    float rl = length(rd);
    vec2 dir = rl > 1e-4 ? rd / rl : vec2(0.0, -1.0);
    dir.x /= uAspect;
    float jd = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float am = 0.0; vec3 cc = vec3(0.0);
    for (int i = 0; i < 24; i++) {
      float f = (float(i) + jd) / 24.0;
      float ang = float(i) * 2.39996 + jd * 6.2832;
      vec2 q = c0 - dir * uClone.z * f + vec2(cos(ang) / uAspect, sin(ang)) * sqrt(f) * uClone.z * 0.35;
      vec2 su = toSrc(q);
      float m = subjAt(su, 0.15, 0.7);
      am += m; cc += texture(uSrc, su).rgb * m;
    }
    cc = cc / max(am, 1e-3) * uWb; am /= 24.0;
    // (the user's third notes, 8 Nov 2026: a pure Screen, "1 - (1 - bg) * (1 - clone * 0.30)", so no part of the clone can darken the
    // plate. The clone layer is the brightened cut-out times its coverage, kept behind the character (zero where they stand); uClone.x
    // is the 0.30 ramped in over the slot's first frames. With uClean the Screen happens after the block's grade (below): screened on
    // before it, the dark S-curve and the shared tint crushed the clone's light into a dim brown copy that read as a shadow blob)
    vec3 cb = 1.0 - pow(1.0 - clamp(cc, 0.0, 1.0), vec3(2.2));
    cb = clamp(mix(vec3(luma(cb)), cb, 1.15), 0.0, 1.0);
    vec3 cloneLayer = cb * am * (1.0 - hereC);
    if (uClean > 0.5) cloneLate = cloneLayer;
    else col = 1.0 - (1.0 - col) * (1.0 - cloneLayer * uClone.x);
  }
  // its neon: a soft bloom of the character's own highlights (luma-keyed), in their colour, on them and just around them; never a line
  // along the mask's edge ("Apply colored neon glow via a soft luma-keyed rim/highlight bloom on the character")
  if (uClone.w > 0.001 && uHasSubj > 0.5 && uHasSrc > 0.5) {
    float jd2 = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 17.0, vec2(0.06711056, 0.00583715))));
    float bl = 0.0;
    for (int i = 0; i < 20; i++) {
      float ang = float(i) * 2.39996 + jd2 * 6.2832;
      float rr = sqrt((float(i) + 0.5) / 20.0) * 0.03;
      vec2 su = toSrc(p + vec2(cos(ang) / uAspect, sin(ang)) * rr);
      bl += subjAt(su, 0.2, 0.7) * smoothstep(0.42, 0.85, luma(texture(uSrc, su).rgb));
    }
    bl /= 20.0;
    col = 1.0 - (1.0 - col) * (1.0 - clamp(uCloneCol * bl * uClone.w * (1.0 - 0.8 * hereC), 0.0, 1.0));   // (mostly round them: on a bright face it washed out)
  }
  if (uGhost.x > 0.001) {
    vec2 gu = uCenter + (uv - uCenter) / max(uGhost.y, 0.01), gc = (p - 0.5) * uGhost.z * 0.03 * uRegion;
    vec3 gm = mix(col, vec3(texture(uSrc, gu + gc).r, texture(uSrc, gu).g, texture(uSrc, gu - gc).b), uGhost.x);
    // (the user's third notes: the white rings round the ink lines on the close-ups at 0:05 and 0:11 were this ghost's bright copy
    // landing beside the black lines; with uClean its positive overshoot is clamped to 0, so it can only darken, never add a light rim)
    col = uClean > 0.5 ? min(col, gm) : gm;
  }
  if (uSharpen > 0.001) {
    vec3 sl = texture(uSrc, uv - vec2(uSrcTexel.x, 0.0)).rgb, sr = texture(uSrc, uv + vec2(uSrcTexel.x, 0.0)).rgb;
    vec3 su = texture(uSrc, uv - vec2(0.0, uSrcTexel.y)).rgb, sd = texture(uSrc, uv + vec2(0.0, uSrcTexel.y)).rgb;
    vec3 sh = col + (col - 0.25 * (sl + sr + su + sd)) * uSharpen * 2.5;
    // halo-free: an edge gets steeper, but no pixel goes brighter than its brightest neighbour or
    // darker than its darkest (that overshoot is the bright/dark rim that makes sharpening look cheap)
    vec3 lo = min(min(min(sl, sr), min(su, sd)), col), hi = max(max(max(sl, sr), max(su, sd)), col);
    float slack = uClean > 0.5 ? 0.0 : 0.008;      // (the third notes: positive overshoot clamped to 0)
    col = clamp(sh, lo - slack, hi + slack);
  }
  if (uHasSrc < 0.5) col = vec3(0.0);
  col = grade(col);
  if (uTone.a > 0.001) {
    float tl = dot(clamp(col, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722));
    vec3 tg = tl < 0.55 ? uTone.rgb * (tl / 0.55) : mix(uTone.rgb, vec3(1.0), (tl - 0.55) / 0.45);
    col = mix(col, tg, uTone.a);
  }
  // the spec's grade: one dark S-curve per character block, shadows crushed, highlights clamped on a soft shoulder, the shadows
  // and mids tinted to the character's hue (the highlights keep their own colour)
  if (uLut.x > 0.001) {
    vec3 c0 = clamp(col, 0.0, 1.0);
    float cr = max(uLut.y, 0.0);
    vec3 c1 = max(c0 - cr, 0.0) / max(1.0 - cr, 0.05);
    c1 = pow(c1, vec3(1.12));
    c1 = mix(c1, c1 * c1 * (3.0 - 2.0 * c1), 0.6);
    vec3 sh = uLut.z + (1.0 - uLut.z) * (1.0 - exp(-(c1 - uLut.z) / max(1.0 - uLut.z, 1e-3)));
    c1 = mix(c1, sh, step(vec3(uLut.z), c1));
    float lt = luma(c1);
    vec3 tinted = uLutCol / max(luma(uLutCol), 0.05) * lt;
    c1 = mix(c1, tinted, uLut.w * (1.0 - smoothstep(0.35, 0.85, lt)));
    // the block's shared tint (the user's second notes: "a shared monochromatic/duotone tint LUT across all 3 shots in a character
    // block so daylight, sunset, and night clips don't clash"): the picture brought towards the block's hue at its own brightness,
    // the highlights easing to a pale version of it rather than a saturated one
    if (uLutDuo > 0.001) {
      float ld = luma(c1);
      vec3 mono = uLutCol / max(luma(uLutCol), 0.05) * ld;
      mono = mix(mono, mix(vec3(ld), mono, 0.35), smoothstep(0.55, 1.0, ld));
      // (skin keeps half its own colour: at full strength a green month turned Reze's face sickly green)
      float sk = skinW(rgb2hsv(clamp(c1, 0.0, 1.0)));
      c1 = mix(c1, clamp(mono, 0.0, 1.0), uLutDuo * (1.0 - 0.55 * sk));
    }
    // (a negative crush lifts the blacks instead, after the curve: the references keep a little in their darks, luma p5 about 9)
    if (uLut.y < 0.0) c1 = -uLut.y + c1 * (1.0 + uLut.y);
    col = mix(c0, c1, uLut.x);
  }
  // the iris and rim-light bloom (the user's third notes: "a soft, character-tinted optical bloom (radius: 18px, intensity: 25%)" on the
  // intro and shot 3 close-ups): the key gathered over a disc of the radius with a soft falloff, each tap's light in its own hue drawn
  // most of the way to the character's colour, screened on at the intensity; after the block's grade so the S-curve doesn't eat it
  // the clone, screened on here with uClean (the third notes' pure Screen, "1 - (1 - bg) * (1 - clone * 0.30)"), in full colour
  // (the clone takes the block's shared tint plus a little more, so it glows in the character's colour: left in its white-balanced
  // colour it read cold grey against a warm month in the second test)
  if (uClean > 0.5 && uClone.x > 0.001) {
    vec3 cl = clamp(cloneLate, 0.0, 1.0);
    vec3 tcl = clamp(uLutCol / max(luma(uLutCol), 0.05) * luma(cl), 0.0, 1.0);
    cl = mix(cl, tcl, clamp(uLutDuo + 0.15, 0.0, 1.0));
    col = 1.0 - (1.0 - clamp(col, 0.0, 1.0)) * (1.0 - cl * uClone.x);
  }
  if (uIris.x > 0.001 && uHasSrc > 0.5) {
    float jb = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 31.0, vec2(0.06711056, 0.00583715))));
    vec3 tc = uIrisCol / max(max(uIrisCol.r, max(uIrisCol.g, uIrisCol.b)), 0.05), ib = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 24; i++) {
      float rr = sqrt((float(i) + jb) / 24.0);
      float ang = float(i) * 2.39996 + jb * 6.2832;
      vec3 kc; float k = irisKey(pF + vec2(cos(ang) / uAspect, sin(ang)) * rr * uIris.y, kc);
      float w = exp(-2.0 * rr * rr);
      ib += k * w * mix(kc / max(max(kc.r, max(kc.g, kc.b)), 0.05), tc, 0.6); wsum += w;
    }
    // (light added, as an optical bloom is: a Screen at 25% barely showed on mid-tone irises in the first test)
    col = clamp(col, 0.0, 1.0) + ib / max(wsum, 1e-3) * uIris.x;
  }
  // option C's sweep: a soft diagonal band of light crossing the frame over the slot's first frames, landing only on glowing eyes, the
  // character's bright outline and the bright parts of their hair ("a subtle specular highlight sweep across glowing eyes/hair on Shot 3")
  if (uRim.y > 0.001 && uRim.x >= 0.0 && uHasSrc > 0.5) {
    float s0 = mix(-0.3, 1.3, uRim.x);
    float dd = (pF.x * 0.6 + pF.y * 0.8) - s0;
    float bnd = exp(-dd * dd / max(uRim.z * uRim.z, 1e-5));
    if (bnd > 0.01) {
      vec3 kc; float k = irisKey(pF, kc);
      vec2 su = toSrc(pF); float m = uHasSubj > 0.5 ? subjAt(su, 0.3, 0.7) : 0.0;
      float hair = m * smoothstep(0.55, 0.85, luma(texture(uSrc, su).rgb * uWb));
      col = clamp(col, 0.0, 1.0) + bnd * max(k, 0.6 * hair) * mix(vec3(1.0), uIrisCol, 0.35) * uRim.y;
    }
  }
  // a dip by the black point: the darks go first and the picture turns hard-edged on its way to black
  if (uCrush > 0.001) col = max(col - uCrush, 0.0) / max(1.0 - uCrush, 0.05);
  // a flash-in's brightness that keeps its shapes: the mids rise and the highlights roll off instead of clipping
  if (uLift > 0.001) col = 1.0 - pow(max(1.0 - col, 0.0), vec3(1.0 + uLift));
  if (uVibrance > 0.001) {
    // vibrance: richer colour where there is colour to enrich. Scaling chroma around grey keeps
    // every hue true (no warm cast); skin, near-neutrals and already-vivid or blown-out areas are left alone.
    vec3 cc = clamp(col, 0.0, 1.0);
    vec3 hv = rgb2hsv(cc);
    float warm = smoothstep(0.02, 0.06, hv.x) * (1.0 - smoothstep(0.15, 0.19, hv.x));
    float w = smoothstep(0.08, 0.25, hv.y) * (1.0 - smoothstep(0.7, 0.95, hv.y)) * (1.0 - skinW(hv)) * (1.0 - 0.7 * smoothstep(0.92, 1.0, hv.z)) * (1.0 - 0.8 * warm);
    col = mix(vec3(luma(cc)), col, 1.0 + uVibrance * w);
  }
  if (uImpact > 0.001) {
    float l = luma(clamp(col, 0.0, 1.0));
    float m = smoothstep(0.38, 0.46, l);
    vec3 ic = uImpactMode < 0.5 ? vec3(m) : uImpactMode < 1.5 ? vec3(1.0 - m)
      : mix(vec3(0.04, 0.0, 0.0), vec3(0.92, 0.06, 0.05), m) + vec3(smoothstep(0.78, 0.86, l) * 0.9);
    col = mix(col, ic, uImpact);
  }
  // alpha carries "a character is here", mapped through every zoom, shake and tilt with the picture
  float subj = 0.0;
  if (uHasSubj > 0.5 && uHasSrc > 0.5) {
    float my = (uv.y - uSubjBox.x) / (uSubjBox.y - uSubjBox.x);
    if (my >= 0.0 && my <= 1.0 && uv.x >= 0.0 && uv.x <= 1.0) subj = texture(uSubj, vec2(uv.x, my)).r;
  }
  if (uHasNext > 0.5) {
    if (uPrevShape > 2.5) {
      // foreground wipe: an edge sweeps across the frame and the next shot takes the background
      // behind it, while the character (this shot's outline) stays in front until the cut
      float e = mix(-0.12, 1.12, uPrevP < 0.5 ? 2.0 * uPrevP * uPrevP : 1.0 - 2.0 * (1.0 - uPrevP) * (1.0 - uPrevP));
      float x = uPrevShape < 3.5 ? p0.x : 1.0 - p0.x;
      float ins = (1.0 - smoothstep(e - 0.025, e + 0.025, x)) * (1.0 - smoothstep(0.35, 0.65, subj));
      col = mix(col, grade(texture(uNext, uNextCenter + (p0 - 0.5) * uNextRegion).rgb), ins * uPrevK);
    } else {
      vec2 m = previewMask(p0);
      if (m.x > 0.5) col = mix(col, mix(grade(texture(uNext, uNextCenter + (p0 - 0.5) * uNextRegion).rgb), vec3(1.0), m.y), uPrevK);
    }
  }
  o = vec4(clamp(col, 0.0, 1.0), subj);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThr;
void main() {
  vec3 c = 0.25 * (texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb
                 + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c * smoothstep(uThr, 1.0, l), 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.227027;
  c += (texture(uTex, vUv + uDir * 1.3846).rgb + texture(uTex, vUv - uDir * 1.3846).rgb) * 0.3162162;
  c += (texture(uTex, vUv + uDir * 3.2308).rgb + texture(uTex, vUv - uDir * 3.2308).rgb) * 0.0702703;
  o = vec4(c, 1.0);
}`;

// FX detector (quarter resolution, on the graded frame): finds the anime's own effects —
// energy, fire, lightning, sparks, glowing debris. An effect is vivid and bright AND brighter
// than its surroundings (light, not a coloured wall or sky); white-hot cores count when coloured
// light surrounds them. Skin never counts. Output: effect colour × strength, strength.
const FX_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uAspect, uCharOff;
${HSV_GLSL}
void main() {
  vec3 c = 0.25 * (texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb
                 + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  vec3 hv = rgb2hsv(clamp(c, 0.0, 1.0));
  float ringV = 0.0, ringS = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236, rad = i < 6 ? 0.02 : 0.045;
    vec3 rh = rgb2hsv(clamp(texture(uTex, vUv + vec2(cos(a) / uAspect, sin(a)) * rad).rgb, 0.0, 1.0));
    ringV += rh.z; ringS += rh.y;
  }
  ringV /= 12.0; ringS /= 12.0;
  float pop = smoothstep(0.04, 0.22, hv.z - ringV);
  float vivid = smoothstep(0.42, 0.72, hv.y) * smoothstep(0.45, 0.85, hv.z);
  float core = smoothstep(0.86, 0.98, hv.z) * smoothstep(0.3, 0.55, ringS) * pop;
  float fx = max(vivid * mix(0.12, 1.0, pop), core) * (1.0 - skinW(hv));
  // golden sunlight (yellow, ~32–58°) is light on a scene, not a fight effect — unless it is fiercely saturated
  float gold = smoothstep(0.08, 0.1, hv.x) * (1.0 - smoothstep(0.15, 0.17, hv.x));
  fx *= 1.0 - 0.8 * gold * (1.0 - smoothstep(0.85, 0.97, hv.y));
  // characters themselves (their lit clothes, coloured skin) stay natural: only what's around them counts
  float ch = 0.25 * (texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).a + texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).a
                   + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).a + texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).a);
  fx *= 1.0 - uCharOff * smoothstep(0.3, 0.7, ch);
  o = vec4(c * fx, fx);
}`;

const BLUR4_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec4 c = texture(uTex, vUv) * 0.227027;
  c += (texture(uTex, vUv + uDir * 1.3846) + texture(uTex, vUv - uDir * 1.3846)) * 0.3162162;
  c += (texture(uTex, vUv + uDir * 3.2308) + texture(uTex, vUv - uDir * 3.2308)) * 0.0702703;
  o = c;
}`;

const FINAL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uScene, uBloom, uText, uPrev, uTextBack, uFx, uFxGlow, uFxRaw, uHold;
uniform float uHoldAmt;
uniform float uHasBack, uFxAmt, uClarity;
uniform vec4 uAura; // character aura: colour, strength
uniform vec2 uShadowR;
uniform float uGlow, uVignette, uGrain, uTime, uBars, uFlash, uBlack, uHasText, uBlend, uVhs, uLeaks, uSpeed, uAspect, uFlare, uFlashUnder, uPlate, uBar;
uniform vec2 uFlarePos;
uniform vec4 uGlint[2]; // eye glints: position (top-down), size, strength
uniform float uGlintRot;
uniform vec3 uFlashColor;
uniform vec2 uSweep; // flash sweep bar: strength, phase (0 low + brighten, 1 high)
uniform vec2 uBand;  // the picture's top and bottom in the frame (inside any bars)
uniform vec2 uTxA, uTxOff, uTxShift; // where captions sit as the camera moves (see textXform)
uniform vec2 uRes;
uniform vec4 uCAE; // the master spec's option C, an edge RGB split on a hard beat drop: amount (red-blue separation at the edge, a share of the frame width), the face's centre x, y (top-down), its radius (no split inside)
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  if (uCAE.x > 1e-5) {
    // red out, blue in along the line from the face, growing past its radius ("0.6% W at frame edges only, 0% over the face"); drawn here,
    // after the scene pass's plates, and before the captions, which stay clean
    vec2 q = vec2(vUv.x, 1.0 - vUv.y);
    vec2 dc = q - uCAE.yz; dc.x *= uAspect; float rr = length(dc);
    vec2 dirc = rr > 1e-4 ? dc / rr : vec2(0.0); dirc.x /= uAspect;
    vec2 off = dirc * 0.5 * uCAE.x * smoothstep(uCAE.w, uCAE.w + 0.28, rr); off.y = -off.y;
    c = vec3(texture(uScene, vUv + off).r, c.g, texture(uScene, vUv - off).b);
  }
  if (uClarity > 0.001) {
    // clarity: local contrast against a wide blur of the frame, so line art and edges pop the way
    // they do in the sharp reference edits (fine detail is the sharpen pass's job)
    float lc = dot(c, vec3(0.2126, 0.7152, 0.0722)), lb = dot(textureLod(uScene, vUv, 3.5).rgb, vec3(0.2126, 0.7152, 0.0722));
    // gentle by a hard edge (a wide local-contrast boost brightens a band beside every dark
    // outline: a halo), and never more than a few levels either way
    // The wide blur reaches about ten pixels, so "by an edge" means within that reach too: the
    // gradient of a slightly blurred copy, measured four pixels either way, finds an outline that
    // close (the band beside it is exactly where the boost would lift a rim)
    vec2 px = 1.0 / uRes;
    float gx = dot(texture(uScene, vUv + vec2(px.x, 0.0)).rgb - texture(uScene, vUv - vec2(px.x, 0.0)).rgb, vec3(0.333));
    float gy = dot(texture(uScene, vUv + vec2(0.0, px.y)).rgb - texture(uScene, vUv - vec2(0.0, px.y)).rgb, vec3(0.333));
    float wx = dot(textureLod(uScene, vUv + vec2(4.0 * px.x, 0.0), 2.0).rgb - textureLod(uScene, vUv - vec2(4.0 * px.x, 0.0), 2.0).rgb, vec3(0.333));
    float wy = dot(textureLod(uScene, vUv + vec2(0.0, 4.0 * px.y), 2.0).rgb - textureLod(uScene, vUv - vec2(0.0, 4.0 * px.y), 2.0).rgb, vec3(0.333));
    float nearEdge = max(smoothstep(0.06, 0.22, abs(gx) + abs(gy)), smoothstep(0.05, 0.18, abs(wx) + abs(wy)));
    c += clamp(lc - lb, -0.07, 0.07) * uClarity * 0.9 * (1.0 - 0.7 * nearEdge) * (1.0 - smoothstep(0.8, 1.0, lc)) * smoothstep(0.02, 0.12, lc);
    c = max(c, 0.0);
  }
  if (uFxAmt > 0.001) {
    // FX boost, only where the detector found effects: richer colour, a hotter core heading to
    // white like real light, then a wide glow in the effect's own colour. Hues stay true.
    // targeted: real effects are localised (sparks, energy, impact rays); when much of the frame or of
    // this neighbourhood reads as "effect" it is really a lit surface (a sunlit forest, a red room)
    float area = textureLod(uFxRaw, vec2(0.5), 12.0).a, local = textureLod(uFxRaw, vUv, 4.0).a;
    // a frame lit in one strong colour (a red room) has no separate effects to bring out
    vec3 avg = textureLod(uScene, vec2(0.5), 12.0).rgb;
    float tint = smoothstep(0.45, 0.75, (max(avg.r, max(avg.g, avg.b)) - min(avg.r, min(avg.g, avg.b))) / max(max(avg.r, max(avg.g, avg.b)), 1e-3));
    float aim = (1.0 - 0.9 * smoothstep(0.05, 0.2, area)) * (1.0 - 0.75 * smoothstep(0.3, 0.6, local)) * (1.0 - 0.85 * tint);
    float m = clamp(texture(uFx, vUv).a * 2.2, 0.0, 1.0) * uFxAmt * aim;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, 1.0 + 0.7 * m);
    c *= 1.0 + 0.45 * m;
    float hot = smoothstep(0.72, 1.0, max(c.r, max(c.g, c.b)));
    c = mix(c, vec3(1.0), 0.35 * m * hot);
    vec3 fg = clamp(texture(uFxGlow, vUv).rgb * uFxAmt * 3.2 * (1.0 - 0.9 * smoothstep(0.05, 0.2, area)) * (1.0 - 0.85 * tint), 0.0, 1.0);
    c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - fg);
  }
  if (uAura.a > 0.001) {
    // the characters' rim glows (from their outline in the scene's alpha): a tight edge light and a
    // soft halo just outside, with sparkles twinkling along it, like the reference edits
    float m = texture(uScene, vUv).a, near = 0.0, far = 0.0;
    for (int i = 0; i < 12; i++) {
      vec2 d = vec2(cos(float(i) * 0.5236), sin(float(i) * 0.5236)) / uRes;
      near += texture(uScene, vUv + d * 7.0).a;
      far += texture(uScene, vUv + d * 18.0).a;
    }
    near /= 12.0; far /= 12.0;
    float rim = clamp(near - m, 0.0, 1.0) * 1.8 + clamp(far - m, 0.0, 1.0) * 0.8 + clamp(m - near, 0.0, 1.0) * 0.6;
    vec2 cell = floor(vUv * uRes / 16.0);
    float h = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    vec2 cp = (cell + 0.5) * 16.0 / uRes;
    float sp = step(0.93, h) * (0.5 + 0.5 * sin(uTime * 14.0 + h * 60.0)) * exp(-pow(length((vUv - cp) * uRes) / 2.2, 2.0)) * step(0.15, clamp(far - m, 0.0, 1.0) + clamp(near - m, 0.0, 1.0));
    c = 1.0 - (1.0 - c) * (1.0 - clamp(uAura.rgb * rim * uAura.a + vec3(sp * uAura.a * 1.2), 0.0, 1.0));
  }
  vec3 g = clamp(texture(uBloom, vUv).rgb * uGlow * 1.8, 0.0, 1.0);
  c = 1.0 - (1.0 - c) * (1.0 - g);
  vec2 d = vUv - 0.5;
  if (uSpeed > 0.001) {
    vec2 q = vec2(d.x * uAspect, d.y);
    float a = atan(q.y, q.x) + 3.14159265;
    float bin = floor(a * 60.0), w = fract(a * 60.0);
    float h = fract(sin(bin * 12.9898 + floor(uTime * 24.0) * 78.233) * 43758.5453);
    float line = step(0.8, h) * smoothstep(0.0, 0.35, w) * smoothstep(1.0, 0.65, w);
    float mask = smoothstep(0.2 + h * 0.18, 0.62, length(q));
    c = mix(c, vec3(1.0), line * mask * uSpeed * 0.85);
  }
  if (uLeaks > 0.001) {
    float t = uTime * 0.18;
    vec2 q = vec2(vUv.x * uAspect, vUv.y);
    vec2 c1 = vec2((0.5 + 0.7 * sin(t * 1.3)) * uAspect, 0.5 + 0.6 * cos(t * 0.9));
    vec2 c2 = vec2((0.5 + 0.8 * cos(t * 0.7 + 1.0)) * uAspect, 0.5 + 0.7 * sin(t * 1.1 + 2.0));
    vec3 leak = vec3(1.0, 0.45, 0.12) * smoothstep(0.85, 0.0, distance(q, c1)) + vec3(1.0, 0.25, 0.55) * smoothstep(0.75, 0.0, distance(q, c2));
    c = 1.0 - (1.0 - c) * (1.0 - clamp(leak * uLeaks * 0.65, 0.0, 1.0));
  }
  if (uFlare > 0.001) {
    // light burst from the subject: soft core, rays and an anamorphic streak
    vec2 q = vUv - vec2(uFlarePos.x, 1.0 - uFlarePos.y);
    q.x *= uAspect;
    float rr = length(q), ang = atan(q.y, q.x);
    float rays = pow(abs(sin(ang * 9.0 + uTime * 0.7) * sin(ang * 5.0 - uTime * 0.4)), 3.0);
    vec3 fl = vec3(1.0, 0.86, 0.62) * (exp(-rr * 4.0) * 0.8 + rays * exp(-rr * 2.4) * 0.9)
            + vec3(0.65, 0.82, 1.0) * exp(-abs(q.y) * 70.0) * exp(-abs(q.x) * 1.5) * 0.9;
    c = 1.0 - (1.0 - c) * (1.0 - clamp(fl * uFlare, 0.0, 1.0));
  }
  for (int i = 0; i < 2; i++) {
    // an eye glint: a four-pointed star with a soft core, turning slightly as it flares
    vec4 gl = uGlint[i];
    if (gl.w < 0.002) continue;
    vec2 q = vec2(vUv.x - gl.x, (1.0 - vUv.y) - gl.y);
    q.x *= uAspect;
    float cs = cos(uGlintRot), sn = sin(uGlintRot);
    q = mat2(cs, sn, -sn, cs) * q;
    float s = max(gl.z, 0.002);
    float star = exp(-abs(q.y) / (s * 0.035)) * exp(-abs(q.x) / s) + exp(-abs(q.x) / (s * 0.035)) * exp(-abs(q.y) / s);
    float core = exp(-dot(q, q) / (s * s * 0.02));
    c = 1.0 - (1.0 - c) * (1.0 - clamp(vec3(1.0, 0.98, 0.94) * (star * 0.9 + core) * gl.w, 0.0, 1.0));
  }
  float r = length(d) * 1.4142;
  c *= 1.0 - uVignette * 0.85 * smoothstep(0.35, 1.05, r);
  if (uGrain > 0.001) {
    vec2 fc = floor(gl_FragCoord.xy / max(1.0, uRes.y / 900.0));
    float n = fract(sin(dot(fc + fract(uTime * 7.13) * vec2(113.1, 71.7), vec2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) * uGrain * 0.2;
  }
  if (uVhs > 0.001) {
    c *= 1.0 - uVhs * 0.16 * (0.5 + 0.5 * sin(vUv.y * 3.14159 * 540.0));
    c += smoothstep(0.04, 0.0, abs(fract(vUv.y + uTime * 0.12) - 0.5)) * 0.07 * uVhs;
    c = mix(c, c * vec3(1.04, 0.97, 1.06), uVhs);
  }
  float y = 1.0 - vUv.y;
  float px = 1.0 / uRes.y;
  float bar = max(smoothstep(uBars + px, uBars - px, y), smoothstep(1.0 - uBars - px, 1.0 - uBars + px, y));
  c = mix(c, vec3(0.0), uBars > 0.0005 ? bar : 0.0);
  // flashes light the picture, not the black bars around it
  float inBand = step(uBand.x - 0.002, 1.0 - vUv.y) * step(1.0 - vUv.y, uBand.y + 0.002);
  // (uPlate: the flash itself falls off to a grey vignette, the group I end plate)
  float flashV = clamp(uFlash, 0.0, 1.0);
  vec3 flashC = uFlashColor * (1.0 - uPlate * smoothstep(0.1, 1.05, r));
  // (uFlashUnder: flashes and the white bar go under the text, which stays lit on them, glow and all)
  if (uFlashUnder > 0.5) c = mix(c, flashC, flashV * inBand);
  if (uBar > 0.5) c = mix(c, vec3(0.98), uBar < 1.5 ? step(1.0 - vUv.y, 0.5) : step(0.5, 1.0 - vUv.y));
  vec2 txUv = uTxA * (vec2(vUv.x, 1.0 - vUv.y) - 0.5 - uTxShift) + 0.5 + uTxOff;
  if (uHasBack > 0.5) {
    vec4 tb = texture(uTextBack, txUv);
    float vis = 1.0 - smoothstep(0.42, 0.58, texture(uScene, vUv).a);
    if (tb.a > 0.001) {
      // the character casts a soft shadow onto the word just behind its edge: reads as real depth
      float sh = 0.0;
      for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; sh += texture(uScene, vUv + vec2(cos(a), sin(a)) * uShadowR + vec2(-0.3, 0.4) * uShadowR).a; }
      tb.rgb *= 1.0 - 0.5 * smoothstep(0.15, 0.85, sh / 8.0);
    }
    c = c * (1.0 - tb.a * vis) + tb.rgb * vis;
  }
  if (uHasText > 0.5) {
    vec4 t = texture(uText, txUv);
    c = c * (1.0 - t.a) + t.rgb;
  }
  if (uSweep.x > 0.001) {
    // a feathered white bar, tilted about 2°, screened over the frame
    float yy = (1.0 - vUv.y - uBand.x) / max(0.01, uBand.y - uBand.x) + (vUv.x - 0.5) * 0.035;
    float inPic = step(uBand.x, 1.0 - vUv.y) * step(1.0 - vUv.y, uBand.y);
    float bar = (uSweep.y < 0.5 ? smoothstep(0.55, 0.68, yy) : 1.0 - smoothstep(0.17, 0.3, yy)) * inPic;
    if (uSweep.y < 0.5) c *= 1.0 + 0.4 * uSweep.x * inPic;
    c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - bar * uSweep.x * (uSweep.y < 0.5 ? 0.92 : 0.5));
  }
  if (uFlashUnder < 0.5) c = mix(c, flashC, flashV * inBand);
  c *= 1.0 - clamp(uBlack, 0.0, 1.0);
  if (uBlend > 0.001) c = mix(c, texture(uPrev, vUv).rgb, uBlend);
  // a cross-dissolve: the outgoing shot's last frame, held still, fading out over the new one
  if (uHoldAmt > 0.001) c = mix(c, texture(uHold, vUv).rgb, uHoldAmt);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex, uMark, uLoopTex;
uniform float uHasMark, uLoopZoom, uLoopMix, uLoopFirst, uSeed, uMarkBlend, uMarkOpacity, uMarkTint;
uniform vec4 uMarkRect;
// interleaved gradient noise: an even, pattern-free spread for dithering
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  if (uLoopZoom > 1.0005 || uLoopMix > 0.001) {
    // the loop point: a crisp dissolve between this frame and the video's first frame, both at
    // the same slight push
    vec3 a = texture(uTex, 0.5 + (vUv - 0.5) / uLoopZoom).rgb;
    vec3 b = uLoopMix > 0.001 ? texture(uLoopTex, vec2(0.5 + (vUv.x - 0.5) / uLoopFirst, 1.0 - (0.5 + (vUv.y - 0.5) / uLoopFirst))).rgb : a;
    o = vec4(mix(a, b, uLoopMix), 1.0);
  } else o = texture(uTex, vUv);
  // watermark goes on last: flashes, fades and motion blur never touch it
  // (it fades with the picture when the edit fades to black)
  if (uHasMark > 0.001 && uMarkBlend > 0.5) {
    // the logo inside the picture (SceneMark in tools/lockfx.py, the Love Me edits): it takes its light from what's
    // behind it, a wide blur of the picture round it and a mirrored copy that slides across the letters as the
    // picture moves, lifted towards white; on a bright picture it goes darker than the picture, with a soft edge
    vec2 mu = vec2(vUv.x, 1.0 - vUv.y), mc = 0.5 * (uMarkRect.xy + uMarkRect.zw);
    float mh = uMarkRect.w - uMarkRect.y, mw = uMarkRect.z - uMarkRect.x;
    if (abs(mu.x - mc.x) < mw * 0.5 + mh * 1.4 && abs(mu.y - mc.y) < mh * 0.5 + mh * 1.4) {
      vec4 m = texture(uMark, mu);
      float a = m.a, e = 0.0, gl = 0.0;
      vec3 wide = vec3(0.0), mir = vec3(0.0);
      vec2 mv = vec2(vUv.x, 2.0 * (1.0 - mc.y) - vUv.y), asp = vec2(1.0, 1.0);
      for (int i = 0; i < 12; i++) {
        float ang = float(i) * 0.5236;
        vec2 d = vec2(cos(ang), sin(ang));
        e += texture(uMark, mu + d * mh * 0.1).a;
        gl += texture(uMark, mu + d * mh * 0.34).a;
        wide += texture(uTex, vUv + d * mh * 1.1 * (0.5 + 0.5 * fract(float(i) * 0.37))).rgb;
        mir += texture(uTex, mv + d * mh * 0.2).rgb;
      }
      e /= 12.0; gl /= 12.0;
      float edge = clamp(e * 1.3 - a, 0.0, 1.0);
      vec3 col = 0.6 * wide / 12.0 + 0.4 * mir / 12.0;
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 pale = col / max(max(col.r, max(col.g, col.b)), 0.001) * 0.55 + 0.45;
      float v = lum < 0.55 ? mix(1.0, 0.96, lum / 0.55) : mix(0.96, 0.5, clamp((lum - 0.55) / 0.4, 0.0, 1.0));
      vec3 own = a > 0.004 ? m.rgb / a : vec3(1.0);
      own = own / max(max(own.r, max(own.g, own.b)), 0.001) * uMarkTint + (1.0 - uMarkTint);
      vec3 c = pale * v * own;
      o.rgb *= 1.0 - edge * (0.15 + 0.4 * lum) * uHasMark;
      o.rgb = mix(o.rgb, c, a * uMarkOpacity * uHasMark);
      o.rgb = 1.0 - (1.0 - clamp(o.rgb, 0.0, 1.0)) * (1.0 - gl * (1.0 - lum) * 0.3 * uHasMark * c);
    }
  } else if (uHasMark > 0.001) { vec4 m = texture(uMark, vec2(vUv.x, 1.0 - vUv.y)) * uHasMark; o.rgb = o.rgb * (1.0 - m.a) + m.rgb; }
  // the picture is worked out at higher precision and only rounded to 8 bits here: a touch of
  // triangular noise (±1 level, changing every frame) before rounding turns the steps a smooth
  // gradient would show (dark skies, glows, vignettes) into invisible grain instead of bands
  vec2 fc = gl_FragCoord.xy + vec2(uSeed * 5.588238, uSeed * 7.137291);
  o.rgb = clamp(o.rgb + (ign(fc) + ign(fc + vec2(47.0, 17.0)) - 1.0) / 255.0, 0.0, 1.0);
}`;

// VFX overlays: one quad per sprite (or a whole-frame overlay), placed in picture coordinates.
const OVERLAY_VS = `#version 300 es
uniform vec4 uQuad;   // centre (x, y, top-down frame coords) and half size
uniform float uQRot, uQAspect;
out vec2 vQ;          // 0..1 across the quad, top-left origin
out vec2 vScr;        // screen position (bottom-up), for the character mask
void main() {
  vec2 c = vec2(float(gl_VertexID == 1 || gl_VertexID == 4 || gl_VertexID == 5), float(gl_VertexID == 2 || gl_VertexID == 3 || gl_VertexID == 5));
  vQ = c;
  vec2 d = (c - 0.5) * 2.0 * uQuad.zw;
  d.x *= uQAspect;
  float cs = cos(uQRot), sn = sin(uQRot);
  d = mat2(cs, sn, -sn, cs) * d;
  d.x /= uQAspect;
  vec2 full = uQuad.xy + d;
  vScr = vec2(full.x, 1.0 - full.y);
  gl_Position = vec4(vScr * 2.0 - 1.0, 0.0, 1.0);
}`;

const OVERLAY_FS = `#version 300 es
precision highp float;
in vec2 vQ;
in vec2 vScr;
out vec4 o;
uniform sampler2D uAtlas, uMaskQ;
uniform vec4 uCellA, uCellB; // the two frames being shown: atlas offset and size
uniform vec2 uInset;
uniform float uMix, uK, uMode, uBehind, uTintAmt;
uniform vec3 uTint;
void main() {
  vec2 q = clamp(vQ, uInset, 1.0 - uInset);
  vec4 c = mix(texture(uAtlas, uCellA.xy + q * uCellA.zw), texture(uAtlas, uCellB.xy + q * uCellB.zw), uMix);
  if (uTintAmt > 0.001) {
    // recoloured to suit the shot, keeping its brightness; white-hot cores stay white
    float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    vec3 tc = mix(uTint * l * 1.7, vec3(l), smoothstep(0.7, 1.0, l));
    c.rgb = mix(c.rgb, clamp(tc, 0.0, 1.0), uTintAmt);
  }
  float k = uK;
  if (uBehind > 0.5) k *= 1.0 - smoothstep(0.35, 0.65, texture(uMaskQ, vScr).r);
  if (uMode < 0.5) o = vec4(c.rgb * k, 1.0);        // black-background footage: screen
  else if (uMode < 1.5) o = vec4(c.rgb, c.a * k);   // smoke, dust, blood: laid over
  else o = vec4(c.rgb * c.a * k, 1.0);              // glowing sprite: adds light
}`;

const MASKQ_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
void main() { o = vec4(texture(uTex, vUv).a, 0.0, 0.0, 1.0); }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, fs, vs = VS) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    // arrays are listed as "name[0]"; keep them under their plain name
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export class Renderer {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: preserve });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.scene = program(gl, SCENE_FS);
    this.bright = program(gl, BRIGHT_FS);
    this.blur = program(gl, BLUR_FS);
    this.fxDetect = program(gl, FX_FS);
    this.blur4 = program(gl, BLUR4_FS);
    this.final = program(gl, FINAL_FS);
    this.copy = program(gl, COPY_FS);
    this.overlay = program(gl, OVERLAY_FS, OVERLAY_VS);
    this.maskQ = program(gl, MASKQ_FS);
    this.vfxTex = new Map(); // asset id → texture in this context
    this.vao = gl.createVertexArray();
    this.srcTex = this.tex(gl.MIRRORED_REPEAT);
    this.textTex = this.tex(gl.CLAMP_TO_EDGE);
    this.markTex = this.tex(gl.CLAMP_TO_EDGE);
    this.markKey = null;
    this.backTex = this.tex(gl.CLAMP_TO_EDGE);
    this.loopTex = this.tex(gl.CLAMP_TO_EDGE);
    this.hasLoopFrame = false;
    this.subjTex = this.tex(gl.CLAMP_TO_EDGE);
    this.subj = null;
    this.nextTex = this.tex(gl.CLAMP_TO_EDGE);
    this.nextKey = null;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.srcSize = [1, 1];
    this.w = 0; this.h = 0;
    this.flip = 0;
    this.frameNo = 0;
    // half-float buffers between passes (grade, glow, vignette and blur each add to the picture;
    // at 8 bits every pass rounds again, which is what bands a dark gradient)
    this.halfFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.setSize(2, 2);
  }

  tex(wrap) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return t;
  }

  target(w, h) {
    const gl = this.gl, t = this.tex(gl.CLAMP_TO_EDGE);
    if (this.halfFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (this.halfFloat && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      // this GPU can't draw into half floats after all: 8 bits it is, for every buffer
      gl.deleteFramebuffer(fb); gl.deleteTexture(t);
      this.halfFloat = false;
      return this.target(w, h);
    }
    return { t, fb, w, h };
  }

  setSize(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    for (const r of [this.sceneRT, this.bloomA, this.bloomB, this.fxRaw, this.fxA, this.fxB, this.fxGlowRT, this.maskRT, this.holdRT, ...(this.outRT || [])]) if (r) { gl.deleteTexture(r.t); gl.deleteFramebuffer(r.fb); }
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    this.sceneRT = this.target(w, h);
    const bw = Math.max(2, Math.round(w / 4)), bh = Math.max(2, Math.round(h / 4));
    this.bloomA = this.target(bw, bh);
    this.bloomB = this.target(bw, bh);
    // FX boost: detected effects, smoothed, and their wide coloured glow (all quarter resolution)
    this.fxRaw = this.target(bw, bh);
    this.fxA = this.target(bw, bh);
    this.fxB = this.target(bw, bh);
    this.fxGlowRT = this.target(bw, bh);
    this.maskRT = this.target(bw, bh); // where the characters are, for overlays that go behind them
    this.outRT = [this.target(w, h), this.target(w, h)];
    this.holdRT = this.target(w, h); // the last frame before a cross-dissolve
    this.holdKey = null;
  }

  pass(prog, rt, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fb : null);
    gl.viewport(0, 0, rt ? rt.w : this.w, rt ? rt.h : this.h);
    gl.useProgram(prog.p);
    setup(prog.u);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  bindTex(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  // f: frameParams(); source: video element / VideoFrame / null; blend: motion-blur feedback 0..1
  // the character mask for the current frame ({ data, w, h, top, bottom, key } from maskAt, or null)
  setSubject(m) {
    if (!m) { this.subj = null; return; }
    if (this.subj && this.subj.key === m.key) return;
    this.subj = m;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.subjTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, m.w, m.h, 0, gl.RED, gl.UNSIGNED_BYTE, m.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  // the video's first frame (clean: no watermark, no loop blur), for blending the end into it
  setLoopFrame(img) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.loopTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.hasLoopFrame = true;
  }

  // preview windows: the next shot's first frame (an image), uploaded once per preview
  setNext(img, key) {
    if (!img || key === this.nextKey) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.nextTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.nextKey = key;
  }

  // the watermark overlay ({ key, canvas } from markLayer, or null); uploaded only when it changes
  setMark(layer) {
    const key = layer ? layer.key : null;
    this.markInfo = layer;
    if (key === this.markKey) return;
    this.markKey = key;
    if (!layer) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.markTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  // the atlas for an overlay asset, uploaded to this context the first time it's shown
  atlas(id) {
    let t = this.vfxTex.get(id);
    if (t) return t;
    const img = vfxImage(id);
    if (!img) return null;
    const gl = this.gl;
    const tex = this.tex(gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    t = { tex, w: img.naturalWidth, h: img.naturalHeight };
    this.vfxTex.set(id, t);
    return t;
  }

  // VFX overlays go into the scene layer (before bloom, so sparks and lightning glow), with the
  // character matte in its alpha left untouched
  drawOverlays(f) {
    const list = (f.vfx || []).filter((v) => v.k > 0.002);
    if (!list.length) return;
    const gl = this.gl;
    if (list.some((v) => v.behind)) this.pass(this.maskQ, this.maskRT, (u) => { this.bindTex(0, this.sceneRT.t, u.uTex); });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneRT.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.overlay.p);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.colorMask(true, true, true, false);
    const u = this.overlay.u;
    for (const v of list) {
      const t = this.atlas(v.id);
      if (!t) continue;
      const a = v.asset, cw = a.fw / t.w, ch = a.fh / t.h, cols = Math.max(1, a.cols || Math.round(t.w / a.fw));
      const cell = (n) => [(n % cols) * cw, Math.floor(n / cols) * ch, cw, ch];
      this.bindTex(0, t.tex, u.uAtlas);
      this.bindTex(1, this.maskRT.t, u.uMaskQ);
      gl.uniform4fv(u.uCellA, cell(v.fa));
      gl.uniform4fv(u.uCellB, cell(v.fb));
      gl.uniform2f(u.uInset, 0.5 / a.fw, 0.5 / a.fh);
      gl.uniform1f(u.uMix, v.mix);
      gl.uniform1f(u.uK, v.k);
      gl.uniform1f(u.uMode, v.mode);
      gl.uniform1f(u.uBehind, v.behind ? 1 : 0);
      gl.uniform1f(u.uTintAmt, v.tintAmt || 0);
      gl.uniform3fv(u.uTint, v.tint || [1, 1, 1]);
      gl.uniform4f(u.uQuad, v.cx, v.cy, v.hw, v.hh);
      gl.uniform1f(u.uQRot, v.rot || 0);
      gl.uniform1f(u.uQAspect, this.w / this.h);
      if (v.mode === 1) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      if (v.clip) { gl.enable(gl.SCISSOR_TEST); gl.scissor(v.clip[0], v.clip[1], v.clip[2], v.clip[3]); }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (v.clip) gl.disable(gl.SCISSOR_TEST);
    }
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
  }

  draw(f, source, textCanvas, look, time, blend = 0, backCanvas = null) {
    const gl = this.gl;
    let hasSrc = 0;
    if (source) {
      try {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        if (f.bgMode) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        this.srcSize = [source.videoWidth || source.displayWidth || source.width || 1, source.videoHeight || source.displayHeight || source.height || 1];
        hasSrc = 1;
      } catch (e) { hasSrc = 0; }
    }
    if (backCanvas) {
      gl.bindTexture(gl.TEXTURE_2D, this.backTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, backCanvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    if (textCanvas) {
      gl.bindTexture(gl.TEXTURE_2D, this.textTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    const fx = f.fx;
    const duo = look.duo || [1, 0.45, 0.1];
    this.pass(this.scene, this.sceneRT, (u) => {
      this.bindTex(0, this.srcTex, u.uSrc);
      this.bindTex(4, this.subjTex, u.uSubj);
      gl.uniform1f(u.uHasSubj, this.subj && f.clip ? 1 : 0);
      if (this.subj) gl.uniform2f(u.uSubjBox, this.subj.top, this.subj.bottom);
      gl.uniform1f(u.uHasSrc, hasSrc && f.clip ? 1 : 0);
      gl.uniform2f(u.uCenter, f.center[0], f.center[1]);
      gl.uniform2f(u.uRegion, f.region[0], f.region[1]);
      gl.uniform2f(u.uRegionBg, f.regionBg[0], f.regionBg[1]);
      gl.uniform4f(u.uWin, f.win[0], f.win[1], f.win[2], f.win[3]);
      gl.uniform1f(u.uBgMode, f.bgMode);
      gl.uniform1f(u.uRot90, f.rot90);
      gl.uniform2f(u.uShift, fx.tx, fx.ty);
      gl.uniform2f(u.uTilt, fx.tilt[0], fx.tilt[1]);
      gl.uniform2f(u.uDirBlur, fx.dirBlur[0], fx.dirBlur[1]);
      gl.uniform2f(u.uSrcTexel, 1 / this.srcSize[0], 1 / this.srcSize[1]);
      gl.uniform1f(u.uRot, fx.rot);
      gl.uniform1f(u.uAspect, f.aspect);
      gl.uniform1f(u.uZoomBlur, fx.zoomBlur);
      gl.uniform1f(u.uSharpSubj, fx.sharpSubj || 0);
      gl.uniform2f(u.uBaseBand, f.band ? f.band[0] : -1, f.band ? f.band[1] : 2);
      gl.uniform2f(u.uSrcBox, f.srcBox ? f.srcBox[0] : -10, f.srcBox ? f.srcBox[1] : 10);
      const cp = (look.camBlur ?? 1) > 0 && f.camPrev;
      gl.uniform4f(u.uCamPrevA, cp ? cp.center[0] : 0, cp ? cp.center[1] : 0, cp ? cp.region[0] : 1, cp ? cp.region[1] : 1);
      gl.uniform4f(u.uCamPrevB, cp ? cp.shift[0] : 0, cp ? cp.shift[1] : 0, cp ? cp.rot : 0, cp ? 1 : 0);
      gl.uniform2f(u.uCamPrevTilt, cp ? cp.tilt[0] : 0, cp ? cp.tilt[1] : 0);
      const pv = f.preview, hasNext = pv && this.nextKey === pv.key ? 1 : 0;
      gl.uniform1f(u.uHasNext, hasNext);
      this.bindTex(9, this.nextTex, u.uNext);
      if (hasNext) {
        gl.uniform2f(u.uNextCenter, pv.center[0], pv.center[1]);
        gl.uniform2f(u.uNextRegion, pv.region[0], pv.region[1]);
        gl.uniform1f(u.uPrevShape, pv.shape);
        gl.uniform1f(u.uPrevP, pv.p);
        gl.uniform1f(u.uPrevK, pv.k);
        gl.uniform2f(u.uPrevFocus, pv.focus[0], pv.focus[1]);
        gl.uniform2f(u.uPrevBand, pv.band ? pv.band[0] : 0, pv.band ? pv.band[1] : 1);
      }
      gl.uniform1f(u.uRgb, fx.rgb + (look.chroma || 0) * 0.35);
      gl.uniform1f(u.uGlitch, fx.glitch);
      gl.uniform1f(u.uSeed, fx.seed);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uWarp, fx.warp);
      gl.uniform1f(u.uWarpMode, fx.warpMode);
      gl.uniform1f(u.uDefocus, fx.defocus);
      gl.uniform1f(u.uStack, fx.stack || 0);
      gl.uniform1f(u.uCrush, fx.crush || 0);
      gl.uniform1f(u.uLift, fx.lift || 0);
      gl.uniform1f(u.uComb, fx.comb || 0);
      gl.uniform3f(u.uGhost, fx.ghost || 0, fx.ghostScale || 1, fx.ghostFringe || 0);
      { const tc = fx.toneColor || [1, 1, 1]; gl.uniform4f(u.uTone, tc[0], tc[1], tc[2], fx.tone || 0); }
      gl.uniform4f(u.uShade, fx.shade || 0, fx.shadeScale || 1, fx.shadeX || 0, fx.shadeY || 0);
      { const sc = fx.shadeColor || [0.3, 0.3, 0.4]; gl.uniform3f(u.uShadeCol, sc[0], sc[1], sc[2]); }
      gl.uniform1f(u.uDof, fx.dof || 0);
      gl.uniform4f(u.uClone, fx.clone || 0, fx.cloneScale || 1.2, fx.cloneBlur || 0, fx.cloneGlow || 0);
      { const c = fx.cloneColor || [1, 0.6, 0.2]; gl.uniform3f(u.uCloneCol, c[0], c[1], c[2]); }
      { const q = fx.clonePivot || [0.5, 0.75]; gl.uniform2f(u.uClonePivot, q[0], q[1]); }
      gl.uniform1f(u.uBgDark, fx.bgDark || 0);
      gl.uniform4f(u.uLut, fx.lut || 0, fx.lutCrush || 0, fx.lutClamp || 0.85, fx.lutTint || 0);
      { const c = fx.lutColor || [1, 0.6, 0.2]; gl.uniform3f(u.uLutCol, c[0], c[1], c[2]); }
      gl.uniform1f(u.uLutDuo, fx.lutDuo || 0);
      { const w = fx.wb || [1, 1, 1]; gl.uniform3f(u.uWb, w[0], w[1], w[2]); }
      gl.uniform1f(u.uClean, look.clean ? 1 : 0);
      gl.uniform3f(u.uIris, fx.iris || 0, fx.irisR || 18 / 1080, 0);
      { const c = fx.irisColor || [1, 1, 1]; gl.uniform3f(u.uIrisCol, c[0], c[1], c[2]); }
      { const a = fx.eyeA || [0, 0, 0, 0], b = fx.eyeB || [0, 0, 0, 0]; gl.uniform4f(u.uEyeA, a[0], a[1], a[2], a[3]); gl.uniform4f(u.uEyeB, b[0], b[1], b[2], b[3]); }
      // (the master spec's optional modules, 9 Nov 2026: A the parallax, C the edge RGB split and the Shot 3 sweep; B is in the camera keys)
      gl.uniform4f(u.uPara, fx.paraF || 1, fx.paraB || 1, fx.paraBlur || 0, fx.paraOn ? 1 : 0);
      gl.uniform2f(u.uParaAnchor, 0.5, 0.38);
      gl.uniform3f(u.uRim, fx.rimPhase ?? -1, fx.rim || 0, fx.rimW || 0.08);
      gl.uniform1f(u.uSharpen, look.sharpen || 0);
      gl.uniform1f(u.uVibrance, (look.vibrance || 0) + (fx.energy || 0) * 0.2);
      gl.uniform1f(u.uDepth, look.depth || 0);
      gl.uniform1f(u.uRich, look.rich || 0);
      if (f.shock) gl.uniform4f(u.uShock, f.shock[0], f.shock[1], f.shock[2], f.shock[3]); else gl.uniform4f(u.uShock, 0, 0, 0, 0);
      gl.uniform1f(u.uVhs, look.vhs || 0);
      gl.uniform1f(u.uImpact, fx.impact);
      gl.uniform1f(u.uImpactMode, fx.impactMode);
      gl.uniform1f(u.uExposure, look.exposure + fx.exposure + (f.level || 0) * (look.level || 0) + ((f.clip && f.clip.expo) || 0));
      gl.uniform1f(u.uContrast, look.contrast);
      gl.uniform1f(u.uSaturation, look.saturation * (1 + fx.sat));
      gl.uniform1f(u.uTemp, look.temperature + (fx.temp || 0));
      gl.uniform1f(u.uSoftGrade, look.softGrade || 0);
      gl.uniform1f(u.uTint, look.tint);
      gl.uniform1f(u.uFade, look.fade);
      gl.uniform1f(u.uBW, fx.bw);
      gl.uniform1f(u.uInvert, fx.invert);
      gl.uniform1f(u.uDuoAmt, (look.duoAmt || 0) * (1 - Math.min(1, fx.unduo || 0)));
      gl.uniform1f(u.uAccent, look.accent || 0);
      gl.uniform3fv(u.uDuo, duo);
      gl.uniform3fv(u.uShadows, look.shadows);
      gl.uniform3fv(u.uHighlights, look.highlights);
    });
    this.drawOverlays(f);
    const glow = (look.glow || 0) + ((f.fx && f.fx.bloom) || 0);
    // FX boost: effects found in this frame get their own treatment; punches and drops
    // (energy bursts) push only the effects, never the whole frame
    const fxAmt = Math.min(1.6, (look.fxGlow || 0) + (fx.energy || 0) * 1.1);
    if (fxAmt > 0.001 || (look.clarity || 0) > 0.001) {
      // mip levels of the frame: its average colour (FX boost) and a wide blur (clarity)
      gl.bindTexture(gl.TEXTURE_2D, this.sceneRT.t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    if (fxAmt > 0.001) {
      const B = this.fxA;
      // the frame's average colour (its top mip) tells a one-colour-lit scene apart
      gl.bindTexture(gl.TEXTURE_2D, this.sceneRT.t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.pass(this.fxDetect, this.fxRaw, (u) => { this.bindTex(0, this.sceneRT.t, u.uTex); gl.uniform2f(u.uTexel, 1 / this.w, 1 / this.h); gl.uniform1f(u.uAspect, this.w / this.h); gl.uniform1f(u.uCharOff, this.subj && f.clip ? 0.9 : 0); });
      // mip levels give how much of the frame / each neighbourhood is "effect" (see the final pass)
      gl.bindTexture(gl.TEXTURE_2D, this.fxRaw.t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.pass(this.blur4, this.fxB, (u) => { this.bindTex(0, this.fxRaw.t, u.uTex); gl.uniform2f(u.uDir, 1 / B.w, 0); });
      this.pass(this.blur4, this.fxA, (u) => { this.bindTex(0, this.fxB.t, u.uTex); gl.uniform2f(u.uDir, 0, 1 / B.h); });
      for (const s of [2.5, 6]) {
        this.pass(this.blur4, this.fxB, (u) => { this.bindTex(0, s === 2.5 ? this.fxA.t : this.fxGlowRT.t, u.uTex); gl.uniform2f(u.uDir, s / B.w, 0); });
        this.pass(this.blur4, this.fxGlowRT, (u) => { this.bindTex(0, this.fxB.t, u.uTex); gl.uniform2f(u.uDir, 0, s / B.h); });
      }
    } else if (!((look.clarity || 0) > 0.001)) {
      // no fresh mips this frame: make sure nothing samples last frame's
      gl.bindTexture(gl.TEXTURE_2D, this.sceneRT.t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    if (glow > 0.001) {
      this.pass(this.bright, this.bloomA, (u) => {
        this.bindTex(0, this.sceneRT.t, u.uTex);
        gl.uniform2f(u.uTexel, 1 / this.w, 1 / this.h);
        gl.uniform1f(u.uThr, look.glowThreshold ?? 0.62);
      });
      for (let i = 0; i < 2; i++) {
        const s = 1 + i * 1.5;
        this.pass(this.blur, this.bloomB, (u) => { this.bindTex(0, this.bloomA.t, u.uTex); gl.uniform2f(u.uDir, s / this.bloomA.w, 0); });
        this.pass(this.blur, this.bloomA, (u) => { this.bindTex(0, this.bloomB.t, u.uTex); gl.uniform2f(u.uDir, 0, s / this.bloomA.h); });
      }
    }
    const cur = this.outRT[this.flip], prev = this.outRT[1 - this.flip];
    // (a dissolve starting: keep the frame just drawn, the outgoing shot's last, for it to fade from)
    const fxd = f.fx || {};
    if (fxd.dissolve > 0.001 && fxd.dissolveId != null && this.holdKey !== fxd.dissolveId) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.holdRT.fb);
      gl.blitFramebuffer(0, 0, prev.w, prev.h, 0, 0, this.holdRT.w, this.holdRT.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      this.holdKey = fxd.dissolveId;
    }
    this.pass(this.final, cur, (u) => {
      this.bindTex(0, this.sceneRT.t, u.uScene);
      this.bindTex(1, this.bloomA.t, u.uBloom);
      this.bindTex(2, this.textTex, u.uText);
      this.bindTex(3, prev.t, u.uPrev);
      this.bindTex(9, this.holdRT.t, u.uHold);
      gl.uniform1f(u.uHoldAmt, fxd.dissolve > 0.001 && this.holdKey === fxd.dissolveId ? Math.min(1, fxd.dissolve) : 0);
      this.bindTex(5, this.backTex, u.uTextBack);
      gl.uniform1f(u.uHasBack, backCanvas ? 1 : 0);
      gl.uniform2f(u.uShadowR, 14 / this.w, 14 / this.h);
      this.bindTex(6, this.fxA.t, u.uFx);
      this.bindTex(7, this.fxGlowRT.t, u.uFxGlow);
      this.bindTex(8, this.fxRaw.t, u.uFxRaw);
      gl.uniform1f(u.uFxAmt, fxAmt);
      gl.uniform4f(u.uCAE, fx.caEdge || 0, fx.caX ?? 0.5, fx.caY ?? 0.38, fx.caR0 ?? 0.2);   // (option C, drawn in this pass since 9 Nov)
      gl.uniform1f(u.uClarity, look.clarity || 0);
      if (fx.aura && this.subj) gl.uniform4f(u.uAura, fx.aura.col[0], fx.aura.col[1], fx.aura.col[2], fx.aura.k); else gl.uniform4f(u.uAura, 0, 0, 0, 0);
      gl.uniform1f(u.uGlow, glow);
      gl.uniform1f(u.uVignette, Math.min(1, (look.vignette || 0) + ((fx && fx.vig) || 0)));
      gl.uniform1f(u.uGrain, look.grain || 0);
      gl.uniform1f(u.uVhs, look.vhs || 0);
      gl.uniform1f(u.uLeaks, look.leaks || 0);
      gl.uniform1f(u.uSpeed, fx.speedlines);
      gl.uniform1f(u.uFlare, fx.flare);
      gl.uniform2f(u.uFlarePos, f.focusOut[0], f.focusOut[1]);
      const gls = f.glints || [];
      gl.uniform4fv(u.uGlint, [0, 1].flatMap((i) => (gls[i] ? [gls[i].x, gls[i].y, gls[i].s, gls[i].k] : [0, 0, 0, 0])));
      gl.uniform1f(u.uGlintRot, 0.25 + (fx.glintAge || 0) * 0.6);
      gl.uniform1f(u.uAspect, this.w / this.h);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uBars, fx.bars);
      gl.uniform1f(u.uFlash, fx.flash);
      gl.uniform1f(u.uFlashUnder, fx.flashUnder || 0);
      gl.uniform1f(u.uPlate, fx.plate || 0);
      gl.uniform1f(u.uBar, fx.bar || 0);
      gl.uniform2f(u.uSweep, fx.sweep ? fx.sweep.k : 0, fx.sweep ? fx.sweep.phase : 0);
      gl.uniform2f(u.uBand, f.band ? f.band[0] : f.win[1], f.band ? f.band[1] : f.win[3]);
      const tx = f.textXform;
      // the ride-along never carries text out of the frame: text at P lands on screen at
      // a·(P − 0.5 − off) + 0.5 + shift, so a wide word grows only as far as the frame allows, and
      // off is nudged until the text box stays inside
      let txo = tx ? [tx.off[0], tx.off[1]] : [0, 0];
      const txa = tx ? [tx.a[0], tx.a[1]] : [1, 1];
      const tb = tx && textCanvas && textCanvas.bounds;
      if (tb) {
        const m = 0.02;
        [[tb.x0, tb.x1, 0], [tb.y0, tb.y1, 1]].forEach(([p0, p1, k]) => {
          if (p1 - p0 > 0.96) return; // a full-frame card stays put
          if (txa[k] * (p1 - p0) > 1 - 2 * m) txa[k] = Math.max(Math.min(1, txa[k]), (1 - 2 * m) / (p1 - p0));
          const a = txa[k], sh = tx.shift[k];
          const s0 = a * (p0 - 0.5 - txo[k]) + 0.5 + sh, s1 = a * (p1 - 0.5 - txo[k]) + 0.5 + sh;
          if (s0 < m) txo[k] -= (m - s0) / a;
          else if (s1 > 1 - m) txo[k] += (s1 - (1 - m)) / a;
        });
      }
      gl.uniform2f(u.uTxA, 1 / txa[0], 1 / txa[1]);
      gl.uniform2f(u.uTxOff, txo[0], txo[1]);
      gl.uniform2f(u.uTxShift, tx ? tx.shift[0] : 0, tx ? tx.shift[1] : 0);
      gl.uniform3fv(u.uFlashColor, fx.flashColor);
      gl.uniform1f(u.uBlack, fx.black);
      gl.uniform1f(u.uHasText, textCanvas ? 1 : 0);
      gl.uniform1f(u.uBlend, blend);
      gl.uniform2f(u.uRes, this.w, this.h);
    });
    this.pass(this.copy, null, (u) => {
      this.bindTex(0, cur.t, u.uTex);
      this.bindTex(1, this.markTex, u.uMark);
      gl.uniform1f(u.uHasMark, this.markKey ? 1 - Math.min(1, Math.max(0, fx.black || 0)) : 0);
      const mi = this.markInfo, mb = mi && mi.blend;
      gl.uniform1f(u.uMarkBlend, mb ? 1 : 0);
      if (mb) { gl.uniform4f(u.uMarkRect, mi.rect.x0, mi.rect.y0, mi.rect.x1, mi.rect.y1); gl.uniform1f(u.uMarkOpacity, mb.opacity); gl.uniform1f(u.uMarkTint, mb.tint); }
      this.bindTex(2, this.loopTex, u.uLoopTex);
      gl.uniform1f(u.uLoopZoom, f.loop ? f.loop.zoom : 1);
      gl.uniform1f(u.uLoopMix, f.loop && this.hasLoopFrame ? f.loop.mix : 0);
      gl.uniform1f(u.uLoopFirst, f.loop ? f.loop.first : 1);
      gl.uniform1f(u.uSeed, (this.frameNo++ % 64) * 1.0);
    });
    this.flip = 1 - this.flip;
  }
}

const WINDOWS = { 'framed-1:1': 1, 'framed-4:5': 0.8, 'framed-16:9': 16 / 9 };

// Everything needed to draw timeline time t: active clip, source time, layout, crop and effects.
// Seamless loop: the last beat blurs (zoom) into the first frame and the first beat comes out of
// the same blur, so the end of the video and the start of the replay meet in the middle.
function loopAt(project, t) {
  if (!project.loop || loopIsContinuous(project)) return null;
  const L = timelineDuration(project), T = Math.min(0.4, project.loop.dur || 0.4);
  if (L < T * 4) return null;
  // a clean dissolve: the end pushes in a touch while it dissolves into the video's own first
  // frame shown at that same push, and the start settles out of it, so the two sides meet at
  // exactly the same frame and scale (no blur smear, no jump)
  if (t >= L - T) { const k = (t - (L - T)) / T; return { zoom: 1 + LOOP_PUSH * smoothstep01(k), mix: smoothstep01(k), first: 1 + LOOP_PUSH }; }
  if (t < T) { const k = 1 - t / T; return { zoom: 1 + LOOP_PUSH * smoothstep01(k), mix: 0, first: 1 }; }
  return null;
}
const LOOP_PUSH = 0.035;

// The edit already loops as one unbroken shot: the last clip ends on the very frame before the
// first clip starts, both at normal speed, so replaying just carries on (nothing to blend).
export function loopIsContinuous(project) {
  const cs = project.clips;
  if (!cs || cs.length < 2) return false;
  const a = cs[cs.length - 1], b = cs[0];
  if (a.mediaId !== b.mediaId) return false;
  const end = srcTimeAt(a, a.dur);
  return Math.abs(end - b.srcIn) < 0.05 && Math.abs(speedAt(a, a.dur - 0.01) - 1) < 0.08 && Math.abs(speedAt(b, 0.01) - 1) < 0.08;
}
const smoothstep01 = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };

const hexRgb = (hex) => { const n = parseInt((hex || '#ffffff').slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

// The VFX overlays showing at this moment, as quads in frame coordinates: a sprite is centred on
// its aim point in the picture (and moves with every crop, zoom and shake); a whole-frame overlay
// covers the picture window. `toFull(x, y)` maps a source point into the frame.
function overlayList(fx, outW, outH, win, toFull, band) {
  const out = [];
  const Ww = (win[2] - win[0]) * outW, Wh = (win[3] - win[1]) * outH;
  for (const v of fx.vfx || []) {
    const a = vfxAsset(v.id);
    if (!a || !v.k) continue;
    const frames = Math.max(1, a.frames || 1);
    let fF = a.still ? 0 : v.age * (a.fps || 12) * (v.speed || 1), k = v.k, size = v.size;
    if (a.loop) fF %= frames;
    else if (fF > frames - 0.001) continue; // the animation has played out
    if (a.still) {
      // single-image particles come alive in code: they burst outward, spin a little and fade
      const q = Math.min(1, v.p);
      size *= 0.5 + 0.75 * (1 - Math.pow(1 - q, 3));
      k *= Math.pow(1 - q, 1.4);
    }
    const fa = Math.floor(fF), fb = a.loop ? (fa + 1) % frames : Math.min(frames - 1, fa + 1);
    // smooth overlays (light leaks, flares) cross-fade between frames; drawn effects step on twos
    const mix = a.place === 'full' ? fF - fa : 0;
    const A = a.fw / a.fh;
    let cx, cy, hw, hh, clip = null;
    if (a.place === 'full' || !toFull) {
      // covers the picture: the window, or the footage's own picture inside baked-in bars
      const b0 = band ? band[0] : win[1], b1 = band ? band[1] : win[3], Bh = (b1 - b0) * outH;
      let pw = Ww, ph = Ww / A;
      if (ph < Bh) { ph = Bh; pw = Bh * A; }
      pw *= 0.5 + size * 0.5 + 0.2; ph *= 0.5 + size * 0.5 + 0.2; // "size" 0.6 = just covering
      cx = (win[0] + win[2]) / 2; cy = (b0 + b1) / 2;
      hw = pw / 2 / outW; hh = ph / 2 / outH;
      clip = [Math.round(win[0] * outW), Math.round((1 - b1) * outH), Math.round(Ww), Math.max(1, Math.round(Bh))];
    } else {
      const p = toFull(v.x, v.y);
      cx = p[0]; cy = p[1];
      const H = size * Wh;
      hh = H / 2 / outH; hw = (H * A) / 2 / outW;
      // stays on the picture, never over black bars baked into the footage
      if (band) clip = [Math.round(win[0] * outW), Math.round((1 - band[1]) * outH), Math.round(Ww), Math.max(1, Math.round((band[1] - band[0]) * outH))];
    }
    if (v.flip) hw = -hw;
    out.push({ id: v.id, asset: a, fa, fb, mix, k, cx, cy, hw, hh, rot: v.rot + (a.still ? v.p * 0.6 : 0), mode: vfxMode(a), behind: v.behind, tint: v.tintAmt > 0 ? hexRgb(v.tint) : null, tintAmt: v.tintAmt, clip });
  }
  return out;
}

// Preview windows: the clip that comes after the cut, framed plainly, and its first frame.
const PREVIEW_SHAPES = { rects: 0, circle: 1, slats: 2, fgleft: 3, fgright: 4 };
function previewFor(project, pv, idx, Ao, band) {
  const ni = clipIndexAt(project.clips, pv.end + 0.01);
  if (ni < 0 || ni === idx) return null;
  const c = project.clips[ni], m = getMedia(project, c.mediaId);
  if (!m || !m.w) return null;
  const As = m.w / m.h;
  let rw, rh;
  if (As > Ao) { rh = 1; rw = Ao / As; } else { rw = 1; rh = As / Ao; }
  const fx0 = c.focus ?? 0.5, cx = rw < 1 ? clamp(fx0, rw / 2, 1 - rw / 2) : 0.5;
  return { key: `${pv.id}:${ni}`, media: m, srcTime: c.srcIn, center: [cx, 0.5], region: [rw, rh], shape: PREVIEW_SHAPES[pv.shape] ?? 0, p: pv.p, k: pv.k, focus: [rw < 1 ? (fx0 - (cx - rw / 2)) / rw : fx0, 0.4], band };
}

// The footage's own picture (inside any black bars baked into the video), as a top/bottom band
// of the output frame, or null when it fills the frame.
function pictureBand(media, cy, rh, win, fx) {
  const box = media.analysis && media.analysis.box;
  if (!box || (box.top < 0.01 && box.bottom > 0.99)) return null;
  const y = (s) => win[1] + ((s - (cy - rh / 2)) / rh + fx.ty) * (win[3] - win[1]);
  return [Math.max(win[1], y(box.top)), Math.min(win[3], y(box.bottom))];
}

// The camera half a frame earlier (a 180° shutter at the rate being drawn: 24 fps unless an
// export says otherwise), for camera motion blur.
const CAM_SHUTTER_24 = 1 / 48;
const MAG_HOLD = 1.35, MAG_PEAK = 1.6;
// pro edits move the camera as the reference edits do: bigger framing and moves are allowed (seen at
// phone size, after the app's compression, the extra softness doesn't show; the moves do)
const MAG_HOLD_PRO = 1.7, MAG_PEAK_PRO = 2.3;
// z unchanged up to 70% of the way to the limit c, then easing into c (never past it, never flat)
const softCap = (z, c) => { const k = 1 + (c - 1) * 0.7; return z <= k || c <= k ? z : k + (c - k) * Math.tanh((z - k) / (c - k)); };

export function frameParams(project, t, outW, outH, { noPrev = false } = {}) {
  const fx = fxState(project.effects, t, project.renderFps || 24);
  const idx = clipIndexAt(project.clips, t);
  const Aout = outW / outH;
  const layout = project.layout || 'fill';
  let win = [0, 0, 1, 1], Ao = Aout, bgMode = 0, rot90 = 0;
  if (WINDOWS[layout]) {
    const wa = WINDOWS[layout];
    let ww = 1, wh = Aout / wa;
    if (wh > 1) { wh = 1; ww = wa / Aout; }
    win = [(1 - ww) / 2, (1 - wh) / 2, (1 + ww) / 2, (1 + wh) / 2];
    Ao = wa;
  }
  const base = { t, fx, idx, clip: null, media: null, srcTime: 0, speed: 1, center: [0.5, 0.5], region: [1, 1], regionBg: [1, 1], win, aspect: Ao, bgMode, rot90, focusOut: [0.5, 0.45], loop: loopAt(project, t), vfx: overlayList(fx, outW, outH, win, null) };
  if (idx < 0) return base;
  const clip = project.clips[idx];
  const media = getMedia(project, clip.mediaId);
  if (!media || !media.w) return base;
  const As = media.w / media.h;
  if (layout === 'rotate' && (As > 1) !== (Aout > 1)) { rot90 = 1; Ao = 1 / Aout; }
  let rw, rh;
  // (a shot noted `tall: "fit"` shows whole in the vertical copy, over a blurred copy of itself: an
  // extreme close-up or a wide shot that a narrow crop would cut apart)
  if (layout === 'blur' || (clip.tallFit && Aout < 1)) {
    // fit the whole frame, fill the rest with a blurred copy
    if (As > Ao) { rw = 1; rh = As / Ao; } else { rh = 1; rw = Ao / As; }
    bgMode = 1;
  } else if (As > Ao) { rh = 1; rw = Ao / As; } else { rw = 1; rh = As / Ao; }
  const bgS = As > Aout ? [Aout / As, 1] : [1, As / Aout];
  const cam = fx.cam;
  // a crop that can already pan (portrait from landscape) needs less push-in to follow
  // (`exact`: a framing set by hand, every value as written)
  const camZ = cam ? 1 + (cam.z - 1) * ((rw < 0.85 || rh < 0.85) && !cam.exact ? 0.5 : 1) : 1;
  // Enlargement: how many output pixels each source pixel becomes. Past about 1.35× line art
  // softens visibly, so the framing a shot sits in (its zoom and the camera's push) stays within
  // that, and brief moves (punches, a zoom through a cut, the punch-in ladder) within 1.6×.
  // (A rotated picture runs its width down the output's height.) Moves ease into the limit instead
  // of stopping dead against it: a hard cap stalls a push or a zoom through a cut halfway, and the
  // eye catches the hitch. The extra size that keeps a shake or a spin from showing the picture's
  // edges isn't enlargement for its own sake, so it isn't held back.
  const winH = (win[3] - win[1]) * outH, rest = winH / ((rot90 ? media.w : media.h) * rh);
  const pro = !!(project.auto && project.auto.ctx && project.auto.ctx.pro);
  const capH = Math.max(1.08, (pro ? MAG_HOLD_PRO : MAG_HOLD) / rest), capP = Math.max(1.25, (pro ? MAG_PEAK_PRO : MAG_PEAK) / rest);
  const zRest = cam && cam.exact ? clip.zoom || 1 : softCap(clip.zoom || 1, capH);
  const zHold = cam && cam.exact ? (clip.zoom || 1) * camZ : softCap((clip.zoom || 1) * (cam && !cam.burst ? camZ : 1), capH);
  const zMove = zHold * fx.scale * (cam && cam.burst ? camZ : 1);
  const cover = Math.abs(Math.cos(fx.rot)) + Math.abs(Math.sin(fx.rot)) * Math.max(Ao, 1 / Ao);
  const zoom = cam && cam.exact ? zMove * (1 + fx.shake * 1.8) : Math.max(softCap(zMove, capP), Math.min(zMove, cover)) * (1 + fx.shake * 1.8);
  const mag = rest * zHold;
  // the shot's resting framing (no camera move, punch or shake), for text that rides along
  const rw0 = rw / zRest, rh0 = rh / zRest;
  rw /= zoom; rh /= zoom;
  const local = t - clip.start;
  let cx = 0.5, cy = 0.5;
  if (clip.pan && !rot90) cx = cam && cam.lock ? clip.focus ?? (clip.pan[0] + clip.pan[1]) / 2 : lerp(clip.pan[0], clip.pan[1], smooth(clamp(local / clip.dur, 0, 1)));
  // the camera move frames the character along its smoothed path, easing off softly near the
  // edge of the picture instead of stopping dead against it
  const tracking = cam && cam.w > 0 && cam.x != null && !rot90;
  if (tracking) {
    cx += (cam.x - cx) * cam.w; cy += (cam.y - cy) * cam.w;
    // (continuous as the room opens from nothing: switching on at a threshold snapped the frame by the
    // threshold's width, 4 px, as a settled zoom drifted past it)
    const soft = (v, r) => (r > 1e-6 ? 0.5 + r * Math.tanh((v - 0.5) / r) : 0.5);
    if (!cam.exact) { cx = soft(cx, (1 - rw) / 2); cy = soft(cy, (1 - rh) / 2); }
  }
  // zoom effects push in toward the subject (or, for an impact, the contact point), not the frame centre
  const focusX = fx.smash ? fx.smash[0] : tracking ? cx : clip.focus ?? cx, focusY = fx.smash ? fx.smash[1] : tracking ? cy : 0.45;
  const pull = clamp(1 - 1 / fx.scale, 0, 0.6) * 1.4;
  if (!rot90) { cx += (focusX - cx) * Math.min(1, pull); cy += (focusY - cy) * Math.min(1, pull); }
  if (rw < 1) cx = clamp(cx, rw / 2, 1 - rw / 2); else cx = 0.5;
  if (rh < 1) cy = clamp(cy, rh / 2, 1 - rh / 2); else cy = 0.5;
  const focusOut = [clamp((focusX - (cx - rw / 2)) / rw, 0.05, 0.95), clamp((focusY - (cy - rh / 2)) / rh, 0.05, 0.95)];
  // hit-stop: the picture holds on the contact frame for a few frames
  const held = fx.hold != null && fx.hold >= clip.start && fx.hold < clip.start + clip.dur ? fx.hold - clip.start : local;
  const srcTime = Math.min(srcTimeAt(clip, held), media.duration - 0.02);
  const shock = fx.shock && !rot90 ? [(fx.shock[0] - (cx - rw / 2)) / rw, (fx.shock[1] - (cy - rh / 2)) / rh, fx.shock[2], fx.shock[3]] : null;
  const g = media.analysis && media.analysis.grid;
  // where the footage's own picture sits at rest (before any zoom or camera move)
  const restBand = rot90 ? null : pictureBand(media, 0.5, rh0, win, { ty: 0 });
  const srcMotion = g ? g.motion[Math.max(0, Math.min(g.motion.length - 1, Math.floor(srcTime * g.rate)))] : 0;
  // eye glints: the eyes of the biggest face found in this frame (a third and two thirds across the
  // face, just above halfway down), carried through the crop, zoom and shake with the picture
  let glints = null;
  if (fx.glint > 0.01 && !rot90 && !noPrev) { // (the camera's look back only needs the framing)
    const b = faceBoxAt(media, srcTime);
    if (b) {
      const toFull = (x, y) => [win[0] + ((x - (cx - rw / 2)) / rw + fx.tx) * (win[2] - win[0]), win[1] + ((y - (cy - rh / 2)) / rh + fx.ty) * (win[3] - win[1])];
      const fw = b[2] - b[0], fh = b[3] - b[1], size = Math.min(0.09, (fh / rh) * (win[3] - win[1]) * 0.22);
      glints = [[b[0] + fw * 0.3, b[1] + fh * 0.52], [b[0] + fw * 0.7, b[1] + fh * 0.52]].map(([x, y], i) => { const [X, Y] = toFull(x, y); return { x: X, y: Y, s: size * (i ? 0.75 : 1), k: fx.glint * (i ? 0.8 : 1) }; }).filter((g) => g.x > 0.02 && g.x < 0.98 && g.y > 0.02 && g.y < 0.98);
    }
  }
  // the same shot's camera a moment before (never across a cut: that would smear two shots)
  // Only motion that flows gets blurred: a push, pan or zoom moves about as much in one half-frame
  // as the next, while a deliberate jump (a shake stepped on twos, a twitch, a ladder punch) moves
  // in one and not the other, and those stay crisp, as they're meant to.
  let camPrev = null;
  const CAM_SHUTTER = project.renderFps ? 0.5 / project.renderFps : CAM_SHUTTER_24;
  if (!noPrev && !rot90 && t >= 2 * CAM_SHUTTER && (!project.look || (project.look.camBlur ?? 1) > 0)) {
    const q = frameParams(project, t - CAM_SHUTTER, outW, outH, { noPrev: true });
    const q2 = q.clip === clip ? frameParams(project, t - 2 * CAM_SHUTTER, outW, outH, { noPrev: true }) : null;
    if (q2 && q2.clip === clip) {
      const pose = (f) => [Math.log(f.region[0]), f.center[0] + f.fx.tx, f.center[1] + f.fx.ty, f.fx.rot * 0.3];
      const a = pose(q2), b = pose(q), c = [Math.log(rw), cx + fx.tx, cy + fx.ty, fx.rot * 0.3];
      const d1 = Math.hypot(...c.map((v, i) => v - b[i])), d0 = Math.hypot(...b.map((v, i) => v - a[i]));
      if (d1 < 2.5 * d0 + 0.0015) camPrev = { center: q.center, region: q.region, shift: [q.fx.tx, q.fx.ty], rot: q.fx.rot, tilt: q.fx.tilt };
    }
  }
  const pin = rot90 ? null : (x, y) => [win[0] + ((x - (cx - rw / 2)) / rw + fx.tx) * (win[2] - win[0]), win[1] + ((y - (cy - rh / 2)) / rh + fx.ty) * (win[3] - win[1])];
  return {
    camPrev, mag, glints,
    preview: fx.preview && !rot90 ? previewFor(project, fx.preview, idx, Ao, restBand ? [(restBand[0] - win[1]) / (win[3] - win[1]), (restBand[1] - win[1]) / (win[3] - win[1])] : null) : null,
    ...base, clip, media, aspect: Ao, bgMode, rot90, srcMotion, focusOut, shock, band: restBand,
    srcBox: restBand && media.analysis && media.analysis.box ? [media.analysis.box.top + 0.002, media.analysis.box.bottom - 0.002] : null,
    // captions ride along with the camera (partly, like parallax): a push-in or pan carries the
    // words a little with the picture instead of leaving them pasted on top. (Not in a pro edit: its
    // settling zoom on every cut would make the words breathe with each cut, where the references
    // hold their text still at its anchor.)
    textXform: win[0] === 0 && win[1] === 0 && win[2] === 1 && win[3] === 1 && !rot90 && !(project.auto && project.auto.ctx && project.auto.ctx.pro) ? (() => {
      const k = 0.6, lim = (v) => clamp(v, 0.87, 1.15);
      const cx0 = clip.pan ? lerp(clip.pan[0], clip.pan[1], smooth(clamp(local / clip.dur, 0, 1))) : clip.focus ?? 0.5;
      // the picture maps p0 → 0.5 + Z·(p0 − 0.5) − O (+ shake); text follows at strength k
      const ax = lim(1 + (rw0 / rw - 1) * k), ay = lim(1 + (rh0 / rh - 1) * k);
      const ox = (cx - (rw0 < 1 ? clamp(cx0, rw0 / 2, 1 - rw0 / 2) : 0.5)) / rw, oy = (cy - 0.5) / rh;
      return { a: [ax, ay], off: [clamp((ox * k) / ax, -0.06, 0.06), clamp((oy * k) / ay, -0.06, 0.06)], shift: [fx.tx * 0.5, fx.ty * 0.5] };
    })() : null,
    // sprites stick to their spot in the picture through the crop, zoom and shake
    vfx: overlayList(fx, outW, outH, win, pin, restBand),
    // a point of the source picture (0..1) → where it is on screen now (text set into the picture)
    pin,
    // (which shot this is: a lock word carried in from the shot before stays put until its own shot)
    clipId: clip ? clip.id : null,
    srcTime,
    speed: speedAt(clip, local),
    center: [cx, cy], region: [rw, rh], regionBg: [bgS[0] * 0.85, bgS[1] * 0.85],
    level: project.look && project.look.level ? shotLevel(project, clip) : 0,
  };
}

// Shot leveling: episodes and scenes are graded differently, so a cut can jump from a dim room to a
// white sky. A clip far darker or brighter than the edit's typical shot is nudged toward it (half
// the difference beyond half a stop, at most ±0.35 stops), so it reads as part of one edit while a
// night scene still looks like night. Returns the exposure offset in stops (look.level scales it).
const levelMemo = new WeakMap();
function shotLevel(project, clip) {
  const lumOf = (c) => {
    const m = getMedia(project, c.mediaId), g = m && m.analysis && m.analysis.grid;
    if (!g || !g.pl) return null;
    const key = `${c.mediaId}|${c.srcIn.toFixed(2)}|${c.dur.toFixed(2)}`;
    if (c._lum && c._lum.key === key) return c._lum.v;
    const v = gridMean(g, 'pl', c.srcIn, c.srcIn + Math.max(0.1, clipSpan(c)));
    c._lum = { key, v };
    return v;
  };
  const own = lumOf(clip);
  if (own == null || own <= 0.01) return 0;
  const sig = project.clips.map((c) => `${c.mediaId}${c.srcIn.toFixed(1)}`).join('');
  let memo = levelMemo.get(project.clips);
  if (!memo || memo.sig !== sig) {
    const all = project.clips.map(lumOf).filter((v) => v != null && v > 0.01).sort((a, b) => a - b);
    memo = { sig, median: all.length ? all[all.length >> 1] : own };
    levelMemo.set(project.clips, memo);
  }
  const d = Math.log2(memo.median / own);
  return clamp(Math.sign(d) * Math.max(0, Math.abs(d) - 0.5) * 0.5, -0.35, 0.35);
}

// Motion-blur / echo feedback weight for this frame, given the previous frame's params.
export function blendAmount(look, f, prev, dt) {
  if (!(dt > 0 && dt < 0.1)) return 0;
  let b = 0;
  const mb = look.motionBlur || 0;
  // only the fast part of a ramp blurs; normal-speed footage stays crisp
  // blur the fast part of a ramp, plus genuinely fast action in the footage (like RSMB):
  // smooths anime's 2s/3s motion steps without ghosting calm shots
  // Only the fast peak of a speed ramp gets a light blur. Everything else stays crisp: blending
  // frames into each other on fast action or in slow-mo leaves ghost copies of the characters
  // (and the text), which is what made edits look soft next to the reference edits.
  if (mb > 0 && f.clip && prev && prev.idx === f.idx) b = mb * 0.45 * clamp((f.speed - 1.4) / 0.6, 0, 1);
  b = Math.max(b, f.fx.echo * 0.9);
  if (b <= 0.001) return 0;
  return Math.min(f.fx.echo > 0.001 ? 0.95 : 0.3, Math.pow(b, dt * 30));
}
