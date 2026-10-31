/* Muse: swipe-to-taste procedural art. Each artwork is a small "genome" (family + palette + params + seed);
   like = small mutation of it, dislike = mutate from the last liked one instead. Everything renders in-browser. */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const KEY = "muse.v1";
const clamp = (x, a, b) => Math.max(a, Math.min(b, x)), lerp = (a, b, t) => a + (b - a) * t, TAU = Math.PI * 2;

/* ---------- seeded randomness + noise ---------- */
function rng(seed) { let s = seed >>> 0 || 1; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function noise2(seed) {
  const r = rng(seed), P = new Uint8Array(512), G = [];
  for (let i = 0; i < 256; i++) { P[i] = i; const a = r() * TAU; G.push([Math.cos(a), Math.sin(a)]); }
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; [P[i], P[j]] = [P[j], P[i]]; }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i];
  const f = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const n = (x, y) => { const X = Math.floor(x), Y = Math.floor(y), xf = x - X, yf = y - Y, xi = X & 255, yi = Y & 255;
    const g = (h, dx, dy) => { const v = G[h]; return v[0] * dx + v[1] * dy; };
    const aa = P[P[xi] + yi], ab = P[P[xi] + yi + 1], ba = P[P[xi + 1] + yi], bb = P[P[xi + 1] + yi + 1], u = f(xf), v = f(yf);
    return lerp(lerp(g(aa, xf, yf), g(ba, xf - 1, yf), u), lerp(g(ab, xf, yf - 1), g(bb, xf - 1, yf - 1), u), v) * 1.4; };
  n.fbm = (x, y, o = 4) => { let s = 0, a = 0.5, f2 = 1; for (let i = 0; i < o; i++) { s += a * n(x * f2, y * f2); a *= 0.5; f2 *= 2.03; } return s; };
  return n;
}

/* ---------- genome ---------- */
const FAM = ["flow", "bauhaus", "blobs", "voronoi", "contour", "circles", "landscape", "stripes", "waves", "truchet", "sunset", "orbits"];
const NP = 8; // generic params 0..1, each family reads them its own way
function randomGenome(r = Math.random) {
  return { fam: FAM[(r() * FAM.length) | 0], seed: (r() * 1e9) | 0,
    hue: r() * 360, spread: r(), sat: 0.35 + r() * 0.6, lum: r(), scheme: (r() * 5) | 0, bgDark: r() < 0.5 ? 1 : 0,
    p: Array.from({ length: NP }, () => r()), grain: r() * 0.8, gen: 0 };
}
function gauss() { return Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(TAU * Math.random()); }
function mutate(g, amt) {
  const n = JSON.parse(JSON.stringify(g)); n.gen = (g.gen || 0) + 1;
  if (Math.random() < 0.06) n.fam = FAM[(Math.random() * FAM.length) | 0]; // rare jump to another family, same colours
  if (Math.random() < 0.55) n.seed = (Math.random() * 1e9) | 0; // new layout, same style
  n.hue = (n.hue + gauss() * 22 * amt * 4 + 360) % 360;
  n.spread = clamp(n.spread + gauss() * amt, 0, 1); n.sat = clamp(n.sat + gauss() * amt * 0.6, 0.2, 1); n.lum = clamp(n.lum + gauss() * amt, 0, 1);
  if (Math.random() < amt * 0.5) n.scheme = (Math.random() * 5) | 0;
  if (Math.random() < amt * 0.25) n.bgDark = 1 - n.bgDark;
  n.p = n.p.map((v) => clamp(v + gauss() * amt, 0, 1)); n.grain = clamp(n.grain + gauss() * amt * 0.5, 0, 0.9);
  return n;
}

/* ---------- palette ---------- */
function hsl(h, s, l, a = 1) { return `hsla(${((h % 360) + 360) % 360},${clamp(s, 0, 1) * 100}%,${clamp(l, 0, 1) * 100}%,${a})`; }
function palette(g) {
  const h = g.hue, sp = 20 + g.spread * 70, s = g.sat, L = 0.42 + g.lum * 0.2;
  const off = [[0, sp * 0.5, -sp * 0.5, sp, -sp], [0, 180, 180 + sp * 0.3, sp * 0.3, 180 - sp * 0.3], [0, 120, 240, 120 + sp * 0.2, 240 + sp * 0.2],
    [0, 0, 0, sp * 0.15, -sp * 0.15], [0, 150, 210, 30, 330]][g.scheme];
  const ls = [L, L + 0.18, L - 0.14, L + 0.3, L - 0.24];
  const cols = off.map((o, i) => hsl(h + o, s * (i === 3 ? 0.7 : 1), ls[i]));
  const bg = g.bgDark ? hsl(h + 200, s * 0.35, 0.07 + g.lum * 0.06) : hsl(h + 30, s * 0.3, 0.9 - g.lum * 0.06);
  const ink = g.bgDark ? hsl(h, 0.2, 0.93) : hsl(h + 200, 0.4, 0.12);
  return { cols, bg, ink, raw: { h, s, L, off } };
}

/* ---------- families: draw(ctx, w, h, g, pal, r, nz) ---------- */
const pick = (r, a) => a[(r() * a.length) | 0];
const F = {
  flow(c, w, h, g, P, r, nz) {
    const [a, b, cc, d, e] = g.p; const sc = 0.0008 + a * 0.004, n = 900 + b * 3500, len = 30 + cc * 160, lw = (0.5 + d * 3.5) * w / 1000;
    c.lineCap = "round"; c.globalAlpha = 0.55 + e * 0.4;
    for (let i = 0; i < n; i++) { let x = r() * w, y = r() * h; c.strokeStyle = pick(r, P.cols); c.lineWidth = lw * (0.4 + r());
      c.beginPath(); c.moveTo(x, y);
      for (let k = 0; k < len; k++) { const an = nz.fbm(x * sc, y * sc, 3) * TAU * (1 + g.p[5] * 2); x += Math.cos(an) * 2.2 * w / 1000; y += Math.sin(an) * 2.2 * w / 1000; c.lineTo(x, y); }
      c.stroke(); }
  },
  bauhaus(c, w, h, g, P, r) {
    const [a, b] = g.p; const n = 3 + ((a * 6) | 0), cell = Math.max(w, h) / n;
    for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
      c.fillStyle = pick(r, [...P.cols, P.bg]); c.fillRect(x, y, cell + 1, cell + 1); c.fillStyle = pick(r, P.cols);
      const t = (r() * 5) | 0, k = r() * 4 | 0; c.save(); c.translate(x + cell / 2, y + cell / 2); c.rotate(k * Math.PI / 2); c.translate(-cell / 2, -cell / 2);
      c.beginPath();
      if (t === 0) { c.arc(0, 0, cell, 0, Math.PI / 2); c.lineTo(0, 0); }
      else if (t === 1) { c.arc(cell / 2, cell / 2, cell * (0.2 + b * 0.28), 0, TAU); }
      else if (t === 2) { c.moveTo(0, 0); c.lineTo(cell, 0); c.lineTo(0, cell); }
      else if (t === 3) { c.arc(cell / 2, cell, cell / 2, Math.PI, 0); }
      else { c.rect(0, cell * 0.35, cell, cell * 0.3); }
      c.fill(); c.restore();
    }
  },
  blobs(c, w, h, g, P, r) {
    const n = 4 + ((g.p[0] * 10) | 0); c.filter = `blur(${Math.round((20 + g.p[1] * 90) * w / 1000)}px)`;
    for (let i = 0; i < n; i++) { const x = r() * w, y = r() * h, R = (0.15 + r() * 0.45) * Math.max(w, h) * (0.5 + g.p[2]);
      const gr = c.createRadialGradient(x, y, 0, x, y, R); const col = pick(r, P.cols); gr.addColorStop(0, col); gr.addColorStop(1, "rgba(0,0,0,0)");
      c.globalAlpha = 0.6 + g.p[3] * 0.4; c.fillStyle = gr; c.fillRect(0, 0, w, h); }
    c.filter = "none";
  },
  voronoi(c, w, h, g, P, r) {
    const n = 12 + ((g.p[0] ** 2) * 220) | 0, pts = Array.from({ length: n }, () => [r() * w, r() * h, pick(r, P.cols)]);
    const lines = g.p[1] > 0.5, s = Math.max(1, w / 240), sw = Math.ceil(w / s), sh = Math.ceil(h / s);
    const off = document.createElement("canvas"); off.width = sw; off.height = sh; const oc = off.getContext("2d"), im = oc.createImageData(sw, sh), D = im.data;
    const t = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgbs = pts.map((q) => { t.fillStyle = q[2]; t.fillRect(0, 0, 1, 1); return t.getImageData(0, 0, 1, 1).data; });
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const X = x * s, Y = y * s;
      let b1 = 1e18, b2 = 1e18, bi = 0; for (let i = 0; i < n; i++) { const dx = pts[i][0] - X, dy = pts[i][1] - Y, d = dx * dx + dy * dy; if (d < b1) { b2 = b1; b1 = d; bi = i; } else if (d < b2) b2 = d; }
      const edge = Math.sqrt(b2) - Math.sqrt(b1), v = rgbs[bi], shade = lines && edge < s * 1.2 ? 0.2 : 1 - g.p[2] * 0.35 * Math.min(1, Math.sqrt(b1) / (w * 0.25));
      const o = (y * sw + x) * 4; D[o] = v[0] * shade; D[o + 1] = v[1] * shade; D[o + 2] = v[2] * shade; D[o + 3] = 255; }
    oc.putImageData(im, 0, 0); c.imageSmoothingEnabled = true; c.drawImage(off, 0, 0, sw * s, sh * s);
  },
  contour(c, w, h, g, P, r, nz) {
    const lv = 8 + ((g.p[0] * 28) | 0), sc = 0.0012 + g.p[1] * 0.003, s = Math.max(3, Math.round(w / 220)), fill = g.p[2] > 0.45;
    const gw = Math.ceil(w / s) + 1, gh = Math.ceil(h / s) + 1, V = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) V[j * gw + i] = (nz.fbm(i * s * sc, j * s * sc, 4) + 1) / 2;
    if (fill) for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) { const k = Math.floor(V[j * gw + i] * lv); c.fillStyle = P.cols[((k % 5) + 5) % 5]; c.fillRect(i * s, j * s, s + 1, s + 1); }
    c.strokeStyle = P.ink; c.lineWidth = (0.6 + g.p[3] * 2.2) * w / 1000; c.globalAlpha = 0.85; c.beginPath();
    for (let L = 1; L < lv; L++) { const t = L / lv;
      for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
        const a = V[j * gw + i], b = V[j * gw + i + 1], d = V[(j + 1) * gw + i], e = V[(j + 1) * gw + i + 1]; const pts = [];
        const ed = (v1, v2, x1, y1, x2, y2) => { if ((v1 < t) !== (v2 < t)) { const k = (t - v1) / (v2 - v1); pts.push([lerp(x1, x2, k), lerp(y1, y2, k)]); } };
        const x = i * s, y = j * s; ed(a, b, x, y, x + s, y); ed(b, e, x + s, y, x + s, y + s); ed(d, e, x, y + s, x + s, y + s); ed(a, d, x, y, x, y + s);
        if (pts.length >= 2) { c.moveTo(pts[0][0], pts[0][1]); c.lineTo(pts[1][0], pts[1][1]); }
      } }
    c.stroke();
  },
  circles(c, w, h, g, P, r) {
    const n = 20 + ((g.p[0] ** 2) * 900) | 0, maxR = Math.max(w, h) * (0.03 + g.p[1] * 0.25), placed = [];
    for (let t = 0; t < n * 30 && placed.length < n; t++) { const x = r() * w, y = r() * h; let R = maxR * (0.15 + r() * 0.85);
      for (const q of placed) { const d = Math.hypot(q[0] - x, q[1] - y) - q[2] - w * 0.004; if (d < R) R = d; }
      if (R < maxR * 0.06) continue; placed.push([x, y, R]);
      const ring = g.p[2] > 0.5 && r() < 0.6; c.beginPath(); c.arc(x, y, R, 0, TAU);
      if (ring) { c.strokeStyle = pick(r, P.cols); c.lineWidth = R * (0.1 + g.p[3] * 0.3); c.stroke(); } else { c.fillStyle = pick(r, P.cols); c.fill(); }
      if (g.p[4] > 0.6) { c.beginPath(); c.arc(x, y, R * 0.45, 0, TAU); c.fillStyle = pick(r, [P.bg, ...P.cols]); c.fill(); } }
  },
  landscape(c, w, h, g, P, r, nz) {
    const sky = c.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, P.cols[3]); sky.addColorStop(0.6, P.cols[1]); sky.addColorStop(1, P.cols[0]); c.fillStyle = sky; c.fillRect(0, 0, w, h);
    const sx = w * (0.2 + g.p[0] * 0.6), sy = h * (0.18 + g.p[1] * 0.3), sr = w * (0.06 + g.p[2] * 0.16);
    c.fillStyle = hsl(P.raw.h + 40, 0.9, 0.85, 0.95); c.beginPath(); c.arc(sx, sy, sr, 0, TAU); c.fill();
    const layers = 3 + ((g.p[3] * 5) | 0);
    for (let k = 0; k < layers; k++) { const t = k / (layers - 1 || 1), base = h * (0.45 + t * 0.45), amp = h * (0.05 + g.p[4] * 0.2) * (1 - t * 0.5), sc = 0.002 + g.p[5] * 0.006;
      c.fillStyle = hsl(P.raw.h + P.raw.off[(k % 4) + 1] * 0.4, P.raw.s * 0.8, lerp(0.55, 0.1, t) * (g.bgDark ? 0.8 : 1.1)); c.beginPath(); c.moveTo(0, h);
      for (let x = 0; x <= w; x += w / 200) c.lineTo(x, base - (nz.fbm(x * sc + k * 13.1, k * 7.3, 4) + 0.5) * amp - (g.p[6] > 0.5 ? Math.abs(nz(x * sc * 3, k)) * amp * 0.6 : 0));
      c.lineTo(w, h); c.fill(); }
  },
  stripes(c, w, h, g, P, r, nz) {
    const n = 5 + ((g.p[0] * 50) | 0), ang = (g.p[1] - 0.5) * Math.PI, D = Math.hypot(w, h), wob = g.p[2] * D * 0.08, sc = 0.001 + g.p[3] * 0.004;
    c.save(); c.translate(w / 2, h / 2); c.rotate(ang);
    for (let i = 0; i < n; i++) { const y0 = -D / 2 + (i / n) * D, y1 = y0 + D / n + 1; c.fillStyle = P.cols[i % 5]; c.beginPath();
      for (let x = -D / 2; x <= D / 2; x += D / 120) c.lineTo(x, y0 + nz(x * sc, i * 0.3) * wob);
      for (let x = D / 2; x >= -D / 2; x -= D / 120) c.lineTo(x, y1 + nz(x * sc, (i + 1) * 0.3) * wob);
      c.fill(); }
    c.restore();
  },
  waves(c, w, h, g, P, r, nz) {
    const n = 20 + ((g.p[0] * 90) | 0), amp = h * (0.01 + g.p[1] * 0.08), sc = 0.002 + g.p[2] * 0.01; c.lineWidth = (1 + g.p[3] * 5) * w / 1000;
    for (let i = 0; i < n; i++) { const y0 = h * (i + 0.5) / n; c.beginPath();
      for (let x = 0; x <= w; x += w / 300) { const env = Math.exp(-(((x / w) - 0.5 - (g.p[4] - 0.5)) ** 2) / (0.02 + g.p[5] * 0.2)); c.lineTo(x, y0 - (nz.fbm(x * sc, i * 0.15, 3) + 0.3) * amp * (0.3 + env * 3)); }
      if (g.p[6] > 0.5) { c.lineTo(w, h); c.lineTo(0, h); c.fillStyle = P.cols[i % 5]; c.globalAlpha = 0.9; c.fill(); c.globalAlpha = 1; c.strokeStyle = P.bg; } else c.strokeStyle = P.cols[i % 5];
      c.stroke(); }
  },
  truchet(c, w, h, g, P, r) {
    const n = 6 + ((g.p[0] * 24) | 0), s = w / n, lw = s * (0.08 + g.p[1] * 0.3); c.lineWidth = lw; c.lineCap = "round";
    for (let y = 0; y < h + s; y += s) for (let x = 0; x < w + s; x += s) { c.strokeStyle = g.p[2] > 0.5 ? pick(r, P.cols) : P.cols[0]; const k = r() < 0.5;
      c.beginPath(); if (g.p[3] > 0.5) { if (k) { c.arc(x, y, s / 2, 0, Math.PI / 2); c.moveTo(x + s, y + s / 2); c.arc(x + s, y + s, s / 2, -Math.PI / 2, Math.PI, true); } else { c.arc(x + s, y, s / 2, Math.PI / 2, Math.PI); c.moveTo(x + s / 2, y + s); c.arc(x, y + s, s / 2, -Math.PI / 2, 0); } }
      else { if (k) { c.moveTo(x, y); c.lineTo(x + s, y + s); } else { c.moveTo(x + s, y); c.lineTo(x, y + s); } } c.stroke(); }
  },
  sunset(c, w, h, g, P, r) {
    const cx = w / 2, cy = h * (0.35 + g.p[0] * 0.3), R = Math.min(w, h) * (0.2 + g.p[1] * 0.25), bands = 4 + ((g.p[2] * 10) | 0);
    const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, P.cols[4]); gr.addColorStop(1, P.cols[2]); c.fillStyle = gr; c.fillRect(0, 0, w, h);
    c.save(); c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.clip(); const sg = c.createLinearGradient(0, cy - R, 0, cy + R); sg.addColorStop(0, P.cols[3]); sg.addColorStop(1, P.cols[0]); c.fillStyle = sg; c.fillRect(0, 0, w, h);
    c.fillStyle = P.cols[2]; for (let i = 0; i < bands; i++) { const t = i / bands, y = cy + R * (t * 1.0), th = R * 0.04 * (i + 1) * (0.5 + g.p[3]); c.fillRect(0, y, w, th); } c.restore();
    c.fillStyle = P.bg; c.globalAlpha = 0.85; const hy = cy + R * (0.2 + g.p[4] * 0.6); c.fillRect(0, hy, w, h - hy); c.globalAlpha = 1;
    for (let i = 0; i < 30; i++) { const y = hy + (h - hy) * (i / 30) ** 1.6, ww = R * (1.4 - i / 30) * (0.3 + r() * 0.7); c.fillStyle = P.cols[3]; c.globalAlpha = 0.55 * (1 - i / 30); c.fillRect(cx - ww / 2 + (r() - 0.5) * R * 0.2, y, ww, Math.max(1, h * 0.003)); }
    c.globalAlpha = 1;
  },
  orbits(c, w, h, g, P, r) {
    const n = 3 + ((g.p[0] * 30) | 0), cx = w * (0.3 + g.p[1] * 0.4), cy = h * (0.3 + g.p[2] * 0.4), M = Math.hypot(w, h) * 0.6; c.lineWidth = (1 + g.p[3] * 6) * w / 1000;
    for (let i = 0; i < n; i++) { const R = M * ((i + 1) / n) ** (0.6 + g.p[4]), a0 = r() * TAU, a1 = a0 + (0.3 + r() * 1.7) * Math.PI;
      c.strokeStyle = P.cols[i % 5]; c.globalAlpha = 0.9; c.beginPath(); c.arc(cx, cy, R, a0, a1); c.stroke();
      if (g.p[5] > 0.3) { const pr = c.lineWidth * (2 + r() * 6) * (1 + g.p[6] * 3); c.fillStyle = P.cols[(i + 2) % 5]; c.beginPath(); c.arc(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R, pr, 0, TAU); c.fill(); } }
    c.globalAlpha = 1;
  },
};

/* ---------- render a genome to a canvas ---------- */
let grainTile = null;
function grain() { if (grainTile) return grainTile; const t = document.createElement("canvas"); t.width = t.height = 256; const x = t.getContext("2d"), im = x.createImageData(256, 256);
  for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; } x.putImageData(im, 0, 0); return (grainTile = t); }
function render(cv, g, W, H, dpr) {
  const w = Math.round(W * dpr), h = Math.round(H * dpr); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const c = cv.getContext("2d"); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.filter = "none"; c.globalCompositeOperation = "source-over";
  const P = palette(g), r = rng(g.seed), nz = noise2(g.seed ^ 0x9e3779b9);
  c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
  try { F[g.fam](c, w, h, g, P, r, nz); } catch (e) { console.error(e); }
  c.globalAlpha = 1; c.filter = "none";
  // texture: film grain + soft vignette
  if (g.grain > 0.05) { c.globalCompositeOperation = "overlay"; c.globalAlpha = g.grain * 0.35; c.fillStyle = c.createPattern(grain(), "repeat"); c.fillRect(0, 0, w, h); c.globalAlpha = 1; c.globalCompositeOperation = "source-over"; }
  if (g.p[7] > 0.4) { const v = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, `rgba(0,0,0,${(g.p[7] - 0.4) * 0.7})`); c.fillStyle = v; c.fillRect(0, 0, w, h); }
}

/* ---------- state: history of shown genomes; each entry remembers which liked genome it grew from ---------- */
// S.h = [{ g, base }], base = index of the liked entry this one was mutated from (-1 = random); S.i = current; S.liked = index of last liked
let S = { h: [], i: -1, liked: -1, likes: 0 };
function load() { try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s && Array.isArray(s.h) && s.h.length) S = s; } catch (e) {} }
function save() { try { if (S.h.length > 300) { const cut = S.h.length - 300; S.h = S.h.slice(cut); S.i -= cut; S.liked -= cut; } localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
const cur = () => S.h[S.i];
// what comes next for each verdict (precomputed so the card underneath can show it while you drag)
let nextLike = null, nextNope = null;
function plan() {
  const c = cur(); if (!c) return;
  nextLike = mutate(c.g, 0.09);
  const base = S.liked >= 0 && S.liked !== S.i ? S.h[S.liked].g : null;
  nextNope = base ? mutate(base, 0.13) : randomGenome();
  if (c.v === 1) nextNope = mutate(c.g, 0.13); // already liked: "nope" from here still grows from it
}

/* ---------- view ---------- */
const top = $("[data-top]"), cvTop = $("[data-cv]"), cvUnder = $("[data-under]"), bar = $("[data-bar]"), intro = $("[data-intro]");
const stLike = top.querySelector(".stamp.like"), stNope = top.querySelector(".stamp.nope");
const DPR = Math.min(3, window.devicePixelRatio || 1);
let W = innerWidth, H = innerHeight, underFor = 0;
const offLike = document.createElement("canvas"), offNope = document.createElement("canvas");
function paintAll() {
  W = innerWidth; H = innerHeight; const c = cur(); if (!c) return;
  render(cvTop, c.g, W, H, DPR); plan();
  // render the two candidates a frame later so the swipe stays smooth
  setTimeout(() => { render(offLike, nextLike, W, H, DPR); render(offNope, nextNope, W, H, DPR); showUnder(underFor || 1, true); }, 30);
}
function showUnder(dir, force) {
  if (dir === underFor && !force) return; underFor = dir; const src = dir > 0 ? offLike : offNope; if (!src.width) return;
  cvUnder.width = src.width; cvUnder.height = src.height; cvUnder.getContext("2d").drawImage(src, 0, 0);
}
function ui() {
  $("[data-undo]").disabled = S.i <= 0; $("[data-redo]").disabled = S.i >= S.h.length - 1;
  intro.hidden = S.h.length > 0; bar.classList.toggle("off", !S.h.length);
}
function toast(t) { const el = $("[data-toast]"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 1600); }

function start() { S = { h: [{ g: randomGenome(), base: -1, v: 0 }], i: 0, liked: -1, likes: 0 }; save(); paintAll(); ui(); top.classList.remove("enter"); void top.offsetWidth; top.classList.add("enter"); }

function verdict(v) {
  const c = cur(); if (!c || busy) return;
  c.v = v; if (v > 0) { S.liked = S.i; S.likes++; }
  const g = v > 0 ? nextLike : nextNope, canvas = v > 0 ? offLike : offNope;
  S.h = S.h.slice(0, S.i + 1); S.h.push({ g, base: v > 0 ? S.i : S.liked, v: 0, liked: S.liked }); S.i++; save();
  showUnder(v, true);
  busy = true; top.classList.remove("moving", "back"); top.classList.add("fly");
  top.style.transform = `translate(${v * W * 1.4}px, ${dragY * 0.6 + 40}px) rotate(${v * 24}deg)`;
  try { navigator.vibrate && navigator.vibrate(v > 0 ? 12 : [6, 30, 6]); } catch (e) {}
  setTimeout(() => {
    top.classList.remove("fly"); top.style.transform = ""; stLike.style.opacity = stNope.style.opacity = 0;
    cvTop.width = canvas.width; cvTop.height = canvas.height; cvTop.getContext("2d").drawImage(canvas, 0, 0);
    busy = false; dragX = dragY = 0; paintAll(); ui();
  }, 340);
}
function jump(d) {
  const j = S.i + d; if (j < 0 || j >= S.h.length || busy) return; S.i = j;
  // the "last liked" pointer travels with history
  S.liked = -1; for (let k = S.i; k >= 0; k--) if (S.h[k].v === 1) { S.liked = k; break; }
  save(); paintAll(); ui(); top.classList.remove("enter"); void top.offsetWidth; top.classList.add("enter");
}

/* ---------- swipe ---------- */
let busy = false, down = false, sx = 0, sy = 0, dragX = 0, dragY = 0, t0 = 0, moved = false;
const stage = $("[data-stage]");
stage.addEventListener("pointerdown", (e) => { if (busy) return; down = true; moved = false; sx = e.clientX; sy = e.clientY; t0 = performance.now(); stage.setPointerCapture?.(e.pointerId); top.classList.remove("back", "enter"); });
stage.addEventListener("pointermove", (e) => {
  if (!down || !S.h.length) return; dragX = e.clientX - sx; dragY = e.clientY - sy; if (Math.hypot(dragX, dragY) > 8) moved = true;
  if (!moved) return; top.classList.add("moving");
  top.style.transform = `translate(${dragX}px, ${dragY * 0.4}px) rotate(${dragX / W * 16}deg)`;
  const k = clamp(Math.abs(dragX) / (W * 0.28), 0, 1); stLike.style.opacity = dragX > 0 ? k : 0; stNope.style.opacity = dragX < 0 ? k : 0;
  if (Math.abs(dragX) > 6) showUnder(dragX > 0 ? 1 : -1);
});
const up = (e) => {
  if (!down) return; down = false;
  if (!S.h.length) { start(); return; }
  if (!moved) { bar.classList.toggle("off"); return; } // tap: hide / show the controls for a clean view
  const vx = dragX / Math.max(1, performance.now() - t0);
  if (Math.abs(dragX) > W * 0.25 || Math.abs(vx) > 0.6 && Math.abs(dragX) > 40) verdict(dragX > 0 ? 1 : -1);
  else { top.classList.add("back"); top.classList.remove("moving"); top.style.transform = ""; stLike.style.opacity = stNope.style.opacity = 0; dragX = dragY = 0; }
};
stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
$("[data-yes]").addEventListener("click", () => { dragY = 0; verdict(1); });
$("[data-no]").addEventListener("click", () => { dragY = 0; verdict(-1); });
$("[data-undo]").addEventListener("click", () => jump(-1));
$("[data-redo]").addEventListener("click", () => jump(1));
addEventListener("keydown", (e) => { if (e.key === "ArrowRight") verdict(1); else if (e.key === "ArrowLeft") verdict(-1); else if (e.key === "z" && (e.metaKey || e.ctrlKey)) jump(e.shiftKey ? 1 : -1); });

/* ---------- save to Photos: full device-resolution PNG via the share sheet ("Save Image") ---------- */
$("[data-save]").addEventListener("click", async () => {
  const c = cur(); if (!c) return;
  const sw = screen.width || W, sh = screen.height || H, port = H >= W;
  const OW = port ? Math.min(sw, sh) : Math.max(sw, sh), OH = port ? Math.max(sw, sh) : Math.min(sw, sh);
  const out = document.createElement("canvas"); render(out, c.g, OW, OH, Math.min(3, window.devicePixelRatio || 1));
  const blob = await new Promise((res) => out.toBlob(res, "image/png")); if (!blob) return;
  const name = `muse-${c.g.fam}-${c.g.seed}.png`, file = new File([blob], name, { type: "image/png" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Muse" }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000); toast("Saved. On iPhone: long-press to add to Photos");
});

let rz = 0; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(paintAll, 150); });
load(); ui(); if (S.h.length) paintAll();
window.__muse = { get S() { return S; }, mutate, randomGenome, render, FAM, verdict, jump };
})();
