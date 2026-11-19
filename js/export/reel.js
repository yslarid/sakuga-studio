// The vertical (1080×1920) copy for Reels and TikTok, made from the finished landscape frame:
// the whole picture, scaled down cleanly to the full width and centred, over the same frame
// enlarged, softly blurred and dimmed to fill the screen. Cropping a 16:9 edit to 9:16 instead
// would throw away two thirds of every frame and enlarge what's left 1.78×.
//
// Its own small WebGL context: the frame comes in as a texture with mipmaps, so the scale-down is
// trilinear (no shimmer on line art), the fill is a wide blur read from a small mip level, and the
// result is dithered on its way to 8 bits so the dark, smooth fill doesn't band.

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uBand;    // the picture's top and bottom in the tall frame (0 = top)
uniform vec2 uFill;    // how much of the frame the fill shows across and down
uniform float uSeed, uLod;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 q = vec2(vUv.x, 1.0 - vUv.y); // top-down
  vec3 c;
  if (q.y >= uBand.x && q.y <= uBand.y) {
    vec2 uv = vec2(q.x, (q.y - uBand.x) / (uBand.y - uBand.x));
    c = texture(uTex, vec2(uv.x, 1.0 - uv.y)).rgb;
  } else {
    // the fill: the frame enlarged to cover, blurred wide (a small mip, then a soft ring of taps)
    vec2 uv = 0.5 + (q - 0.5) * uFill;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 0.5236;
      acc += textureLod(uTex, vec2(uv.x, 1.0 - uv.y) + vec2(cos(a), sin(a)) * 0.012, uLod).rgb;
    }
    c = acc / 12.0;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, 1.15) * 0.4;
    // a soft shadow where the fill meets the picture, so the picture sits on it
    float d = min(abs(q.y - uBand.x), abs(q.y - uBand.y));
    c *= mix(0.55, 1.0, smoothstep(0.0, 0.05, d));
  }
  vec2 fc = gl_FragCoord.xy + vec2(uSeed * 5.588238, uSeed * 7.137291);
  o = vec4(clamp(c + (ign(fc) + ign(fc + vec2(47.0, 17.0)) - 1.0) / 255.0, 0.0, 1.0), 1.0);
}`;

export class ReelComposer {
  constructor(srcW, srcH, w = 1080, h = 1920) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available for the vertical copy.');
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.p = p;
    this.u = Object.fromEntries(['uTex', 'uBand', 'uFill', 'uSeed', 'uLod'].map((n) => [n, gl.getUniformLocation(p, n)]));
    this.vao = gl.createVertexArray();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    // the picture at full width, centred; the fill covers the frame from the same picture
    const ph = (w * srcH) / srcW / h;
    this.band = [(1 - ph) / 2, (1 + ph) / 2];
    const cover = Math.max(w / srcW, h / srcH) * 1.12; // a little extra so the blur never shows an edge
    this.fill = [w / (srcW * cover), h / (srcH * cover)];
    this.lod = Math.log2(srcW / 60); // about 60 texels across: a wide, smooth blur
    this.n = 0;
  }

  draw(src) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform2f(this.u.uBand, this.band[0], this.band[1]);
    gl.uniform2f(this.u.uFill, this.fill[0], this.fill[1]);
    gl.uniform1f(this.u.uSeed, (this.n++ % 64) * 1.0);
    gl.uniform1f(this.u.uLod, this.lod);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  close() { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
