import * as THREE from "/vendor/three.module.min.js";

/* Soft sprite textures computed pixel by pixel instead of with canvas gradients.
   Safari/WebKit dithers canvas gradients with per-channel colour noise; magnified (a glow sprite filling the
   screen) each noisy texel became a red/green/blue block – the "colourful mess" seen on iPhone/iPad. */

const lerp = (a, b, t) => a + (b - a) * t;

// stops: [[t, r, g, b, a], ...] with t in 0..1 from the centre, rgb 0..255, a 0..1 (like addColorStop)
function stopAt(stops, t) {
  if (t <= stops[0][0]) return stops[0];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (t <= b[0]) { const u = (t - a[0]) / (b[0] - a[0]); return [t, lerp(a[1], b[1], u), lerp(a[2], b[2], u), lerp(a[3], b[3], u), lerp(a[4], b[4], u)]; }
  }
  return stops[stops.length - 1];
}

function dataTexture(data, w, h, colorSpace) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = colorSpace || THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export function radialTexture(N, stops, colorSpace) {
  const d = new Uint8Array(N * N * 4), c = (N - 1) / 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const s = stopAt(stops, Math.min(1, Math.hypot(x - c, y - c) / (N / 2))), k = (y * N + x) * 4;
    d[k] = Math.round(s[1]); d[k + 1] = Math.round(s[2]); d[k + 2] = Math.round(s[3]); d[k + 3] = Math.round(s[4] * 255);
  }
  return dataTexture(d, N, N, colorSpace);
}

// a comet tail: bright narrow head at the top (v = 1), widening and fading downwards
export function tailTexture() {
  const W = 64, H = 256, d = new Uint8Array(W * H * 4);
  const stops = [[0, 220, 240, 255, 0.95], [0.15, 170, 210, 255, 0.4], [1, 120, 170, 255, 0]];
  for (let row = 0; row < H; row++) {
    const t = 1 - row / (H - 1), s = stopAt(stops, t);           // t: 0 at the head
    const half = 26 * Math.sqrt(Math.min(1, t * 1.6)) + 0.5;
    for (let x = 0; x < W; x++) {
      const e = Math.min(1, Math.max(0, half - Math.abs(x - 31.5))), k = (row * W + x) * 4;
      d[k] = Math.round(s[1]); d[k + 1] = Math.round(s[2]); d[k + 2] = Math.round(s[3]); d[k + 3] = Math.round(s[4] * e * 255);
    }
  }
  return dataTexture(d, W, H);
}

// for canvases that must be drawn with gradients (the painted galaxy): a light 3×3 box blur averages the
// dither noise away before upload
export function smoothCanvas(c) {
  const g = c.getContext("2d"), W = c.width, H = c.height, img = g.getImageData(0, 0, W, H), s = img.data, tmp = new Float32Array(s.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let ch = 0; ch < 4; ch++) {
    const k = (y * W + x) * 4 + ch, l = x > 0 ? k - 4 : k, r = x < W - 1 ? k + 4 : k;
    tmp[k] = (s[l] + s[k] + s[r]) / 3;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let ch = 0; ch < 4; ch++) {
    const k = (y * W + x) * 4 + ch, u = y > 0 ? k - W * 4 : k, dn = y < H - 1 ? k + W * 4 : k;
    s[k] = Math.round((tmp[u] + tmp[k] + tmp[dn]) / 3);
  }
  g.putImageData(img, 0, 0);
  return c;
}

// sin-free GLSL hashes: fract(sin(x)*43758.5) loses precision on mobile GPUs and turns into blocky patterns
export const HASH_GLSL = `
  float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }`;
