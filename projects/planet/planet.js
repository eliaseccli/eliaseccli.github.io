import * as THREE from "./vendor/three.module.min.js";

/* ---------- tiny helpers ---------- */
const $ = (s) => document.querySelector(s);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const elastic = (t) => t >= 1 ? 1 : 1 - Math.pow(2, -9 * t) * Math.cos(t * 9.5);
const r3 = (x) => Math.round(x * 1000) / 1000;
function tangentOf(d) {
  const t = Math.abs(d.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0);
  return t.sub(d.clone().multiplyScalar(t.dot(d))).normalize();
}
function orientTo(obj, d, yaw = 0) {
  obj.quaternion.setFromUnitVectors(UP, d);
  if (yaw) obj.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
}
const near = (d, ang) => d.clone().addScaledVector(tangentOf(d).applyAxisAngle(d, rnd(0, 6.283)), ang).normalize();
const t0 = performance.now();
const clock = () => (performance.now() - t0) / 1000;
const qs = new URLSearchParams(location.search);
let speed = clamp(+qs.get("speed") || 1, 0.1, 200);
let simT = 0;

/* ---------- terrain field on a cube-sphere grid (persisted, cumulative) ---------- */
const WATER = 1.0;
const N = 64, FACE = N * N, CELLS = 6 * FACE;
const FM = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const FU = [[0,0,-1],[0,0,1],[1,0,0],[1,0,0],[1,0,0],[-1,0,0]];
const FV = [[0,1,0],[0,1,0],[0,0,-1],[0,0,1],[0,1,0],[0,1,0]];
const cellDir = new Float32Array(CELLS * 3);
for (let f = 0; f < 6; f++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const u = i / (N - 1) * 2 - 1, v = j / (N - 1) * 2 - 1, M = FM[f], U = FU[f], W = FV[f];
  const x = M[0] + U[0] * u + W[0] * v, y = M[1] + U[1] * u + W[1] * v, z = M[2] + U[2] * u + W[2] * v, l = Math.hypot(x, y, z);
  const k = (f * FACE + j * N + i) * 3; cellDir[k] = x / l; cellDir[k + 1] = y / l; cellDir[k + 2] = z / l;
}
function sampleIdx(x, y, z, I, Wt, o) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  const f = ax >= ay && ax >= az ? (x > 0 ? 0 : 1) : ay >= az ? (y > 0 ? 2 : 3) : (z > 0 ? 4 : 5);
  const M = FM[f], U = FU[f], W = FV[f], m = x * M[0] + y * M[1] + z * M[2];
  const fu = clamp(((x * U[0] + y * U[1] + z * U[2]) / m + 1) * 0.5 * (N - 1), 0, N - 1.0001);
  const fv = clamp(((x * W[0] + y * W[1] + z * W[2]) / m + 1) * 0.5 * (N - 1), 0, N - 1.0001);
  const i = fu | 0, j = fv | 0, a = fu - i, b = fv - j, base = f * FACE + j * N + i;
  I[o] = base; I[o + 1] = base + 1; I[o + 2] = base + N; I[o + 3] = base + N + 1;
  Wt[o] = (1 - a) * (1 - b); Wt[o + 1] = a * (1 - b); Wt[o + 2] = (1 - a) * b; Wt[o + 3] = a * b;
}
const wat = new Float32Array(CELLS); // standing water depth on top of terrain (lakes, crater lakes)
const field = new Float32Array(CELLS), baseG = new Float32Array(CELLS), crat = new Float32Array(CELLS), basalt = new Float32Array(CELLS);
const waves = [];
{
  let s = 0x51a7;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 9; i++) {
    const v = V(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
    waves.push({ v, f: 1.6 + i * 0.9, a: 0.034 / (1 + i * 0.55), p: r() * 6.28 });
  }
  for (let i = 0; i < 16; i++) { // gentle fine detail
    const v = V(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
    waves.push({ v, f: 7 + i * 1.9, a: 0.0042 / (1 + i * 0.18), p: r() * 6.28 });
  }
}
function baseH(x, y, z) {
  let n = 0;
  for (const w of waves) n += Math.sin((x * w.v.x + y * w.v.y + z * w.v.z) * w.f + w.p) * w.a;
  return 1.034 + n;
}
for (let k = 0; k < CELLS; k++) baseG[k] = baseH(cellDir[k * 3], cellDir[k * 3 + 1], cellDir[k * 3 + 2]);
const _I = new Int32Array(4), _W = new Float32Array(4);
function surfaceH(d) {
  sampleIdx(d.x, d.y, d.z, _I, _W, 0);
  let h = 0; for (let k = 0; k < 4; k++) h += _W[k] * (baseG[_I[k]] + field[_I[k]]);
  return h;
}
let terrainVer = 0, terrainDirty = true, fieldDirty = false;
function markTerrain() { terrainVer++; terrainDirty = true; fieldDirty = true; }
function forCells(d, maxA, fn) {
  const c = Math.cos(maxA);
  for (let k = 0; k < CELLS; k++) {
    const dot = cellDir[k * 3] * d.x + cellDir[k * 3 + 1] * d.y + cellDir[k * 3 + 2] * d.z;
    if (dot > c) fn(k, Math.acos(Math.min(1, dot)));
  }
}
function applyCrater(d, r, depth) {
  forCells(d, r * 1.6, (k, a) => {
    const x = a / r;
    const delta = -depth * Math.max(0, 1 - x * x) + depth * 0.3 * Math.exp(-Math.pow((x - 1) * 4, 2));
    field[k] = Math.max(0.9 - baseG[k], field[k] + delta); // never punch through
    crat[k] = Math.min(1, crat[k] + smooth(1.25, 0.6, x) * Math.min(1, depth / 0.02));
  });
  markTerrain();
}
// lake tool: scoop a shallow basin and fill it to the brim; it then evaporates like any other water
function applyLake(d, r) {
  forCells(d, r, (k, a) => {
    const t = smooth(r, r * 0.45, a), dig = 0.028 * t;
    field[k] -= dig; wat[k] += dig * 0.96;
  });
  markTerrain(); waterDirty = true;
}
// land tool: lift the ground; water standing on it is pushed out to the rim (volume conserved), so the
// usual flow passes carry it away or into the nearest basin. On dry land it just builds a small hill.
function applyLand(d, r, amt = 1) {
  const ring = [], cells = [];
  forCells(d, r * 1.6, (k, a) => (a < r ? cells : ring).push([k, a]));
  let pushed = 0;
  for (const [k, a] of cells) {
    const t = smooth(r, r * 0.3, a), h = baseG[k] + field[k];
    let up = 0.005 * t * amt;
    if (wat[k] > 0) up += Math.min(wat[k], 0.01) * t * amt;
    if (h < WATER) up = Math.max(up, ((WATER - h) * 0.45 + 0.003) * t * amt); // reclaim open sea in a few taps
    up = Math.min(up, Math.max(0, 0.09 - field[k]));
    field[k] += up; crat[k] *= 1 - 0.4 * t * amt;
    const out = Math.min(wat[k], up); wat[k] -= out; pushed += out;
  }
  if (ring.length) for (const [k] of ring) wat[k] += pushed / ring.length;
  else vapor += pushed;
  markTerrain(); waterDirty = true;
}
// lava meeting water: the water flashes to steam (feeding clouds) and the lava cools into new basalt land
function coolLava(d, rad, str) {
  let n = 0;
  forCells(d, rad, (k, a) => {
    const h = baseG[k] + field[k], wet = wat[k] > 0.0004 || h < WATER + 0.002;
    if (!wet) return;
    const t = smooth(rad, rad * 0.4, a) * Math.min(1.5, str);
    const up = Math.min(0.0035 * t + (h < WATER ? (WATER - h) * 0.12 * t : 0), Math.max(0, 0.09 - field[k]));
    if (up <= 0) return;
    field[k] += up; basalt[k] = Math.min(1, basalt[k] + 0.6 * t);
    const boil = Math.min(wat[k], up); wat[k] -= boil; vapor += boil; n++;
  });
  if (n) { markTerrain(); waterDirty = true; S.newLand = (S.newLand || 0) + n; }
}
/* ---------- water cycle: flow, crater lakes, evaporation -> clouds -> rain ---------- */
const NB = new Int32Array(CELLS * 4);
{
  const I = new Int32Array(4), Wt = new Float32Array(4);
  for (let f = 0; f < 6; f++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = f * FACE + j * N + i, off = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    off.forEach(([di, dj], q) => {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && ii < N && jj >= 0 && jj < N) { NB[k * 4 + q] = f * FACE + jj * N + ii; return; }
      // across a cube seam: extrapolate the direction outward and snap to the nearest cell
      const o = f * FACE + (j - dj) * N + (i - di);
      const x = 2 * cellDir[k * 3] - cellDir[o * 3], y = 2 * cellDir[k * 3 + 1] - cellDir[o * 3 + 1], z = 2 * cellDir[k * 3 + 2] - cellDir[o * 3 + 2];
      sampleIdx(x, y, z, I, Wt, 0);
      let b = 0; for (let m = 1; m < 4; m++) if (Wt[m] > Wt[b]) b = m;
      NB[k * 4 + q] = I[b] === k ? I[(b + 1) % 4] : I[b];
    });
  }
}
let waterDirty = true, vapor = 0;
function waterDepth(d) { sampleIdx(d.x, d.y, d.z, _I, _W, 0); let w = 0; for (let k = 0; k < 4; k++) w += _W[k] * wat[_I[k]]; return w; }
function waterVolume() { let v = 0; for (let k = 0; k < CELLS; k++) v += wat[k]; return v; }
function flowPass() {
  for (let k = 0; k < CELLS; k++) {
    const w = wat[k]; if (w <= 0) continue;
    const L = baseG[k] + field[k] + w;
    let best = -1, bl = L;
    for (let q = 0; q < 4; q++) { const n = NB[k * 4 + q], ln = baseG[n] + field[n] + wat[n]; if (ln < bl) { bl = ln; best = n; } }
    if (best < 0) continue;
    const mv = Math.min(w, (L - bl) * 0.5);
    if (mv < 1e-7) continue;
    wat[k] -= mv;
    if (!(baseG[best] < WATER - 0.003 && baseG[best] + field[best] < WATER)) wat[best] += mv; // else: spilled into the sea
  }
}
const _cI = new Int32Array(4), _cW = new Float32Array(4);
function lowestNear(d, rad) { // cheap trickle: probe a few points around d and pick the lowest water level
  let best = -1, bl = 9;
  for (let i = 0; i < 9; i++) {
    const p = i === 0 ? d : near(d, rad * Math.sqrt(i / 8));
    sampleIdx(p.x, p.y, p.z, _cI, _cW, 0);
    for (let m = 0; m < 4; m++) { const k = _cI[m], l = baseG[k] + field[k] + wat[k]; if (l < bl) { bl = l; best = k; } }
  }
  return best;
}
const EVAP = 0.00016, VAP_CLOUD = 0.35, RAIN_RATE = 0.012;
function waterTick(dt) {
  for (let it = 0; it < 3; it++) flowPass();
  let any = false;
  for (let k = 0; k < CELLS; k++) {
    const w = wat[k];
    if (w > 0) {
      any = true;
      if (baseG[k] < WATER - 0.003 && baseG[k] + field[k] < WATER) { wat[k] = 0; continue; } // drained to sea
      const sun = cellDir[k * 3] * sunLocal.x + cellDir[k * 3 + 1] * sunLocal.y + cellDir[k * 3 + 2] * sunLocal.z;
      let e = sun > 0.05 ? EVAP * sun * dt : 0;
      if (w - e < 0.0012 && sun > 0.05) e = w; // puddles vanish
      if (e > 0) { wat[k] = w - e; vapor += e; }
    } else if (field[k] < 0 && crat[k] < 0.1 && basalt[k] < 0.05) {
      field[k] = Math.min(0, field[k] + 0.00006 * dt); any = true; // dry lake beds slowly fill back in
    }
  }
  // vapor tops up thirsty clouds first, then condenses into new ones
  for (const c of clouds) if (vapor > 0 && c.w < VAP_CLOUD) { const t = Math.min(vapor, VAP_CLOUD - c.w); c.w += t; vapor -= t; }
  if (vapor >= VAP_CLOUD) {
    let hi = null, hv = -1; // spawn over the steamiest sunlit water
    for (let i = 0; i < 40; i++) { const k = (Math.random() * CELLS) | 0; if (wat[k] > hv) { hv = wat[k]; hi = k; } }
    const d = hi != null && hv > 0 ? V(cellDir[hi * 3], cellDir[hi * 3 + 1], cellDir[hi * 3 + 2]) : near(sunLocal, 0.6);
    const c = makeCloud({ d: d.toArray(), anim: booted, w: VAP_CLOUD }); c.evap = true; vapor -= VAP_CLOUD;
  }
  // rain lands in the lowest spot nearby (crater lakes fill from the bottom)
  for (const c of clouds) {
    if (!c.raining || c.w <= 0) continue;
    const q = Math.min(c.w, RAIN_RATE * dt); c.w -= q;
    const k = lowestNear(c.d, 0.2);
    if (k >= 0 && !(baseG[k] < WATER - 0.003 && baseG[k] + field[k] < WATER)) wat[k] += q;
  }
  if (any) { waterDirty = true; terrainVer++; terrainDirty = true; fieldDirty = true; }
}
const VOLC_H = 0.075, VOLC_R = 0.17;
function volcCells(v) {
  if (v.cells) return;
  const ks = [], pr = [], bs = [];
  forCells(v.d, VOLC_R, (k, a) => {
    const x = a / VOLC_R;
    ks.push(k); pr.push(Math.pow(1 - x, 1.5) - 0.3 * Math.pow(Math.max(0, 1 - x / 0.14), 2)); bs.push(smooth(0.95, 0.25, x));
  });
  v.cells = ks; v.prof = pr; v.bas = bs;
}
function raiseVolcano(v, dg) {
  volcCells(v);
  for (let i = 0; i < v.cells.length; i++) {
    const k = v.cells[i]; field[k] += dg * VOLC_H * v.prof[i]; basalt[k] = Math.min(1, basalt[k] + dg * v.bas[i]);
  }
  markTerrain();
}

/* ---------- state + save (v2, migrates planet.v1) ---------- */
const STORE = "planet.v2", FSTORE = "planet.v2.field", OLD = "planet.v1";
let S = { v: 2, trees: [], critters: [], clouds: [], volcanoes: [], craters: 0, births: 0, deaths: 0, eruptions: 0 };
let firstVisit = false, migrated = false;
function toB64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
try {
  const raw = localStorage.getItem(STORE);
  if (raw) {
    S = Object.assign(S, JSON.parse(raw));
    const fr = localStorage.getItem(FSTORE);
    if (fr) {
      const F = JSON.parse(fr);
      const fi = new Int16Array(fromB64(F.f).buffer), c = fromB64(F.c), b = fromB64(F.b);
      if (fi.length === CELLS) for (let k = 0; k < CELLS; k++) { field[k] = fi[k] / 20000; crat[k] = c[k] / 255; basalt[k] = b[k] / 255; }
      if (F.w) { const w = new Uint16Array(fromB64(F.w).buffer); if (w.length === CELLS) for (let k = 0; k < CELLS; k++) wat[k] = w[k] / 200000; }
      else for (let k = 0; k < CELLS; k++) { const h = baseG[k] + field[k]; if (baseG[k] >= WATER - 0.003 && h < WATER) wat[k] = WATER - h; } // older v2: carved lakes become real water
    }
  } else {
    const old = localStorage.getItem(OLD);
    if (old) {
      const O = JSON.parse(old);
      for (const m of O.mods || []) {
        const d = V(...m.d).normalize();
        if (m.t === "c") applyCrater(d, m.r || 0.13, 0.045); else if (m.t === "w") applyLake(d, m.r || 0.17);
      }
      S.craters = O.craters || 0;
      S.trees = (O.trees || []).map((t) => ({ d: t.d, s: t.s, y: t.y, k: t.k, w: 0.7, f: t.f || 0, da: t.f ? 30 : 0 }));
      S.critters = (O.critters || []).map((c) => ({ d: c.d, h: c.h, col: c.col, a: rnd(30, 80) }));
      S.clouds = O.clouds || [];
      migrated = true; fieldDirty = true;
    } else firstVisit = true;
  }
} catch (e) { firstVisit = true; }
let saveT = 0;
function save(now = false) {
  clearTimeout(saveT);
  const go = () => {
    S.clouds = clouds.map((c) => ({ d: c.d.toArray().map(r3), ax: c.ax.toArray().map(r3), sp: c.sp, w: Math.round(c.w * 1e4) / 1e4, e: c.evap ? 1 : 0, a: Math.round(c.age), l: Math.round(c.life), z: +c.sz.toFixed(2) }));
    S.vapor = Math.round(vapor * 1e5) / 1e5;
    S.villages = villages.map((v) => ({ d: v.d.toArray().map(r3), n: v.n, r: v.ruin ? r3(simT - v.ruinT) : -1 }));
    S.critters = critters.filter((c) => !c.dying).map((c) => ({ d: c.d.toArray().map(r3), h: c.h.toArray().map(r3), col: c.col, a: r3(c.age), l: r3(c.life), hu: r3(c.hunger), cd: r3(Math.max(0, c.cd)) }));
    S.trees = trees.filter((t) => !t.gone).map((t) => ({ d: t.d.toArray().map(r3), s: r3(t.s), y: r3(t.yaw), k: t.kind, c: t.vari, w: r3(t.wet), dr: r3(t.dry), wl: r3(t.wilt), f: t.dead ? t.fa.toArray().map(r3) : 0, da: t.dead ? r3(simT - t.deadT) : 0, b: t.burnt ? 1 : 0 }));
    S.volcanoes = volcanoes.map((v) => ({ d: v.d.toArray().map(r3), g: r3(v.g) }));
    try {
      localStorage.setItem(STORE, JSON.stringify(S));
      if (fieldDirty) {
        const fi = new Int16Array(CELLS), c = new Uint8Array(CELLS), b = new Uint8Array(CELLS);
        for (let k = 0; k < CELLS; k++) { fi[k] = clamp(Math.round(field[k] * 20000), -32767, 32767); c[k] = Math.round(crat[k] * 255); b[k] = Math.round(basalt[k] * 255); }
        const w = new Uint16Array(CELLS); for (let k = 0; k < CELLS; k++) w[k] = clamp(Math.round(wat[k] * 200000), 0, 65535);
        localStorage.setItem(FSTORE, JSON.stringify({ f: toB64(new Uint8Array(fi.buffer)), c: toB64(c), b: toB64(b), w: toB64(new Uint8Array(w.buffer)) }));
        fieldDirty = false;
      }
    } catch (e) {}
  };
  if (now) go(); else saveT = setTimeout(go, 400);
}

/* ---------- renderer / scene ---------- */
const canvas = $("#c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x04040a, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.004, 120);
const world = new THREE.Group();
scene.add(world);
world.rotation.set(0.35, -0.6, 0);
let stars;
{
  const n = 1400, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const d = V(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(60, 90));
    pos.set([d.x, d.y, d.z], i * 3);
    const r = Math.random(), b = rnd(0.45, 1);
    col.set(r < 0.1 ? [0.7 * b, 0.8 * b, b] : r < 0.22 ? [b, 0.9 * b, 0.75 * b] : [b, b, b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
  scene.add(stars);
}
const hemi = new THREE.HemisphereLight(0x9fb8ff, 0x1a1530, 0.35);
scene.add(hemi);
const sunLight = new THREE.DirectionalLight(0xfff1d6, 2.4);
const moonLight = new THREE.DirectionalLight(0x8aa6ff, 0.35);
scene.add(sunLight, moonLight);
const glowTex = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d"), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.25, "rgba(255,255,255,.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const sun = new THREE.Group();
sun.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), new THREE.MeshBasicMaterial({ color: 0xffd27a })));
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffb860, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
sunGlow.scale.setScalar(2.6); sun.add(sunGlow);
const moon = new THREE.Group();
moon.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), new THREE.MeshStandardMaterial({ color: 0xd8dcea, flatShading: true, roughness: 1, emissive: 0x30344a })));
const moonGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x8fa8ff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
moonGlow.scale.setScalar(0.9); moon.add(moonGlow);
scene.add(sun, moon);
const DAY = 80; // sim seconds per day
const sunDir = V(), sunLocal = V();

/* ---------- planet mesh: indexed icosphere (detail 40, ~34k tris) ---------- */
const DETAIL = 40;
const planetGeo = new THREE.BufferGeometry();
let NV, unit, vbase, vI, vW;
{
  const src = new THREE.IcosahedronGeometry(1, DETAIL).attributes.position.array;
  const map = new Map(), u = [], idx = new Uint32Array(src.length / 3);
  for (let i = 0; i < src.length; i += 3) {
    const key = Math.round(src[i] * 1e4) + "," + Math.round(src[i + 1] * 1e4) + "," + Math.round(src[i + 2] * 1e4);
    let j = map.get(key);
    if (j === undefined) { j = u.length / 3; map.set(key, j); const l = Math.hypot(src[i], src[i + 1], src[i + 2]); u.push(src[i] / l, src[i + 1] / l, src[i + 2] / l); }
    idx[i / 3] = j;
  }
  NV = u.length / 3; unit = new Float32Array(u); vbase = new Float32Array(NV); vI = new Int32Array(NV * 4); vW = new Float32Array(NV * 4);
  for (let i = 0; i < NV; i++) { const x = unit[i * 3], y = unit[i * 3 + 1], z = unit[i * 3 + 2]; vbase[i] = baseH(x, y, z); sampleIdx(x, y, z, vI, vW, i * 4); }
  planetGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NV * 3), 3));
  planetGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(NV * 3), 3));
  planetGeo.setIndex(new THREE.BufferAttribute(idx, 1));
}
const C = {
  deep: new THREE.Color(0x3f8f9a), sand: new THREE.Color(0xe6cf94), grass: new THREE.Color(0x7cc46a),
  grass2: new THREE.Color(0x4f9a5a), rock: new THREE.Color(0x9a8f86), snow: new THREE.Color(0xf4f6ff), crater: new THREE.Color(0x7a5a46), basalt: new THREE.Color(0x3b3230)
};
function buildPlanet() {
  const p = planetGeo.attributes.position.array, c = planetGeo.attributes.color.array, col = new THREE.Color();
  for (let i = 0; i < NV; i++) {
    let f = 0, cr = 0, ba = 0;
    for (let k = 0; k < 4; k++) { const w = vW[i * 4 + k], j = vI[i * 4 + k]; f += w * field[j]; cr += w * crat[j]; ba += w * basalt[j]; }
    const h = vbase[i] + f;
    p[i * 3] = unit[i * 3] * h; p[i * 3 + 1] = unit[i * 3 + 1] * h; p[i * 3 + 2] = unit[i * 3 + 2] * h;
    if (h < WATER + 0.002) col.copy(C.deep).lerp(C.sand, 0.45);
    else if (h < WATER + 0.008) col.copy(C.sand);
    else if (h < 1.06) col.copy(C.grass).lerp(C.grass2, smooth(1.02, 1.06, h));
    else if (h < 1.078) col.copy(C.grass2).lerp(C.rock, smooth(1.06, 1.076, h));
    else col.copy(C.rock).lerp(C.snow, smooth(1.078, 1.088, h));
    if (cr > 0) col.lerp(C.crater, Math.min(1, cr) * 0.85);
    if (ba > 0) col.lerp(C.basalt, Math.min(1, ba) * 0.92);
    c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
  }
  planetGeo.attributes.position.needsUpdate = true;
  planetGeo.attributes.color.needsUpdate = true;
  planetGeo.computeBoundingSphere();
  terrainDirty = false;
}
const planet = new THREE.Mesh(planetGeo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 }));
world.add(planet);
const ocean = new THREE.Mesh(new THREE.IcosahedronGeometry(WATER, 6), new THREE.MeshStandardMaterial({ color: 0x3fa3d8, flatShading: true, roughness: 0.7, metalness: 0, transparent: true, opacity: 0.86 }));
world.add(ocean);
// lakes & crater lakes: a second skin over the terrain, raised by the standing-water depth
const waterGeo = new THREE.BufferGeometry();
waterGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NV * 3), 3));
waterGeo.setIndex(planetGeo.index);
const lakes = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({ color: 0x46a8dc, flatShading: true, roughness: 0.55, metalness: 0, transparent: true, opacity: 0.88 }));
lakes.frustumCulled = false; world.add(lakes);
function buildWater() {
  const p = waterGeo.attributes.position.array;
  for (let i = 0; i < NV; i++) {
    let f = 0, w = 0, wmax = 0;
    for (let k = 0; k < 4; k++) { const j = vI[i * 4 + k], ww = vW[i * 4 + k]; f += ww * field[j]; w += ww * wat[j]; if (wat[j] > wmax) wmax = wat[j]; }
    const h = vbase[i] + f + (wmax > 0.0008 ? Math.max(w, 0.0012) : -0.006);
    p[i * 3] = unit[i * 3] * h; p[i * 3 + 1] = unit[i * 3 + 1] * h; p[i * 3 + 2] = unit[i * 3 + 2] * h;
  }
  waterGeo.attributes.position.needsUpdate = true;
  waterDirty = false;
}
const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.13, 48, 32), new THREE.ShaderMaterial({
  side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { c: { value: new THREE.Color(0x6fb6ff) } },
  vertexShader: "varying vec3 n; varying vec3 v; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); n = normalize(normalMatrix*normal); v = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }",
  fragmentShader: "uniform vec3 c; varying vec3 n; varying vec3 v; void main(){ float r = pow(clamp(1.0 + dot(n, v) * 1.0, 0.0, 1.0), 3.0); gl_FragColor = vec4(c * r * 0.7, r * 0.6); }"
}));
scene.add(atmo);

/* ---------- instancing helpers ---------- */
function merge(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0; parts.forEach((p) => (n += p.attributes.position.count));
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
  for (const p of parts) { pos.set(p.attributes.position.array, o * 3); nor.set(p.attributes.normal.array, o * 3); o += p.attributes.position.count; }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return g;
}
class Inst {
  constructor(geo, mat, colored) { this.geo = geo; this.mat = mat; this.colored = colored; this.cap = 0; this.mesh = null; this.grow(64); }
  grow(cap) {
    const old = this.mesh, m = new THREE.InstancedMesh(this.geo, this.mat, cap);
    m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0;
    if (this.colored) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    if (old) {
      m.instanceMatrix.array.set(old.instanceMatrix.array);
      if (this.colored) m.instanceColor.array.set(old.instanceColor.array);
      world.remove(old); old.dispose();
    }
    world.add(m); this.mesh = m; this.cap = cap;
  }
  ensure(n) { if (n > this.cap) { let c = this.cap; while (c < n) c *= 2; this.grow(c); } this.mesh.count = n; }
  done(color) { this.mesh.instanceMatrix.needsUpdate = true; if (color && this.colored) this.mesh.instanceColor.needsUpdate = true; }
}
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = V(), _s = V(), _c = new THREE.Color(), _v = V(), _v2 = V();

/* ---------- particles (pooled GPU points) ---------- */
class Particles {
  constructor(cap, additive) {
    this.cap = cap; this.i = 0;
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 3); this.size = new Float32Array(cap); this.alpha = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3); this.life = new Float32Array(cap); this.max = new Float32Array(cap); this.s0 = new Float32Array(cap); this.grow = new Float32Array(cap); this.grav = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("pcol", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("psize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("palpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 400 } },
      vertexShader: "attribute vec3 pcol; attribute float psize; attribute float palpha; uniform float uScale; varying vec3 vC; varying float vA; void main(){ vC = pcol; vA = palpha; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = psize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix*mv; }",
      fragmentShader: "varying vec3 vC; varying float vA; void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, r); if (vA * a < 0.003) discard; gl_FragColor = vec4(vC, a * vA); }"
    });
    this.pts = new THREE.Points(g, this.mat); this.pts.frustumCulled = false; this.pts.renderOrder = additive ? 3 : 2;
    world.add(this.pts); this.live = 0;
  }
  emit(p, v, r, g, b, size, life, grav = 0, grow = 0) {
    const i = this.i; this.i = (this.i + 1) % this.cap;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.s0[i] = size; this.size[i] = size; this.life[i] = life; this.max[i] = life; this.grav[i] = grav; this.grow[i] = grow; this.alpha[i] = 1;
    this.live = this.cap;
  }
  update(dt) {
    if (!this.live) return;
    let any = 0;
    const P = this.pos, Vl = this.vel;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      any++;
      const k = i * 3, x = P[k], y = P[k + 1], z = P[k + 2], l = Math.hypot(x, y, z) || 1, gr = this.grav[i] * dt / l;
      Vl[k] -= x * gr; Vl[k + 1] -= y * gr; Vl[k + 2] -= z * gr;
      P[k] += Vl[k] * dt; P[k + 1] += Vl[k + 1] * dt; P[k + 2] += Vl[k + 2] * dt;
      const t = this.life[i] / this.max[i];
      this.alpha[i] = Math.min(1, t * 2.2) * (this.grow[i] ? 0.55 : 1);
      this.size[i] = this.s0[i] + this.grow[i] * (this.max[i] - this.life[i]);
    }
    if (!any) this.live = 0;
    const a = this.pts.geometry.attributes;
    a.position.needsUpdate = a.pcol.needsUpdate = a.psize.needsUpdate = a.palpha.needsUpdate = true;
  }
}
const glow = new Particles(4000, true), smoke = new Particles(1600, false);

/* ---------- trees (InstancedMesh, unlimited) ---------- */
const trunkGeo = new THREE.CylinderGeometry(0.004, 0.006, 0.025, 5).translate(0, 0.0125, 0);
const pineGeo = merge([new THREE.ConeGeometry(0.022, 0.04, 6).translate(0, 0.038, 0), new THREE.ConeGeometry(0.016, 0.032, 6).translate(0, 0.058, 0)]);
const roundGeo = new THREE.IcosahedronGeometry(0.022, 0).translate(0, 0.04, 0);
const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.9 });
const trunkI = new Inst(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x8a5a3c, flatShading: true, roughness: 1 }), false);
const pineI = new Inst(pineGeo, leafMat, true), roundI = new Inst(roundGeo, leafMat, true);
const LEAF = [[0x3f9d4f, 0x5ab55a, 0x2f8a55], [0x7cc25c, 0xe39a4a]].map((a) => a.map((c) => new THREE.Color(c)));
const DEAD = new THREE.Color(0x8f7a52), WILT = new THREE.Color(0xb09a55), BURNT = new THREE.Color(0x2a2220);
const trees = [];
function makeTree(o) {
  const kind = o.k ?? (Math.random() < 0.6 ? 0 : 1);
  const vari = o.c ?? (kind === 0 ? (Math.random() * 3) | 0 : Math.random() < 0.15 ? 1 : 0);
  const t = { d: V(...o.d).normalize(), s: o.s ?? 0.05, yaw: o.y ?? rnd(0, 6.28), kind, vari, born: o.anim ? clock() : -9,
    wet: o.w ?? 0.6, dry: o.dr ?? 0, wilt: o.wl ?? 0, dead: !!o.f, burnt: !!o.b, fa: o.f ? V(...o.f) : V(), fallT: o.f ? 1 : 0, fallStart: 0,
    deadT: simT - (o.da || 0), gone: false, goneT: 0, hh: 1, tv: -1 };
  trees.push(t);
  return t;
}
function killTree(t, burnt) {
  if (t.dead || t.gone) return;
  t.dead = true; t.burnt = !!burnt; t.deadT = simT; t.fallT = 0.0001; t.fallStart = clock() + rnd(0, 0.4);
  t.fa = tangentOf(t.d).applyAxisAngle(t.d, rnd(0, 6.28));
}
function goneTree(t) { if (!t.gone) { t.gone = true; t.goneT = clock(); } }
const standing = () => { let n = 0; for (const t of trees) if (!t.dead && !t.gone) n++; return n; };
function treeMatrix(t, now) {
  if (t.tv !== terrainVer) { t.hh = surfaceH(t.d); t.tv = terrainVer; if (t.hh < WATER + 0.004 || waterDepth(t.d) > 0.004) goneTree(t); }
  _p.copy(t.d).multiplyScalar(t.hh - 0.002);
  _q.setFromUnitVectors(UP, t.d); _q.multiply(_q2.setFromAxisAngle(UP, t.yaw));
  if (t.fallT > 0) { _v.copy(t.fa).applyQuaternion(_q2.copy(_q).invert()).normalize(); _q.multiply(_q2.setFromAxisAngle(_v, t.fallT * 1.45)); }
  let k = t.born < 0 ? 1 : elastic((now - t.born) / 0.7);
  if (t.gone) k *= Math.max(0, 1 - (now - t.goneT) / 0.6);
  _s.setScalar(Math.max(0.001, k * 2.1 * (0.55 + 0.6 * t.s)));
  return _m.compose(_p, _q, _s);
}

/* ---------- critters (InstancedMesh, unlimited, with lives) ---------- */
const critterGeo = new THREE.IcosahedronGeometry(0.014, 1).scale(1, 0.85, 1.15).translate(0, 0.012, 0);
const eyesGeo = merge([-1, 1].map((s) => new THREE.SphereGeometry(0.0032, 6, 4).translate(s * 0.0055, 0.016, 0.014)));
const earsGeo = merge([-1, 1].map((s) => new THREE.ConeGeometry(0.004, 0.009, 4).rotateZ(-s * 0.35).translate(s * 0.007, 0.026, 0.002)));
const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.8 });
const bodyI = new Inst(critterGeo, bodyMat, true), earI = new Inst(earsGeo, bodyMat, true), eyeI = new Inst(eyesGeo, new THREE.MeshBasicMaterial({ color: 0x111111 }), false);
const CRITTER_COLORS = [0xffb4a2, 0xf6d186, 0xb5e48c, 0xa0c4ff, 0xcdb4db, 0xffffff, 0xf4a261];
const critters = [];
const MATURE = 25;
function makeCritter(o) {
  const d = V(...o.d).normalize();
  const h = o.h ? V(...o.h) : tangentOf(d).applyAxisAngle(d, rnd(0, 6.28));
  h.sub(d.clone().multiplyScalar(h.dot(d))).normalize();
  const c = { d, h, col: o.col ?? pick(CRITTER_COLORS), born: o.anim ? clock() : -9, ph: rnd(0, 6.28), sp: rnd(0.05, 0.09), wait: 0, jump: 0,
    age: o.a ?? 0, life: o.l ?? rnd(150, 320), hunger: o.hu ?? rnd(0, 0.3), cd: o.cd ?? rnd(5, 20), tick: rnd(0, 0.5), goal: null, dying: 0 };
  critters.push(c);
  return c;
}
function killCritter(c) { if (c.dying) return; c.dying = clock(); S.deaths = (S.deaths || 0) + 1; }
const tmp = V(), fwd = V();
function moveCritter(c, dt) {
  if (c.jump > 0) c.jump = Math.max(0, c.jump - dt * 2.5);
  if (c.wait > 0) { c.wait -= dt; return; }
  if (c.goal) {
    tmp.copy(c.goal).addScaledVector(c.d, -c.goal.dot(c.d));
    if (tmp.lengthSq() > 1e-8) c.h.lerp(tmp.normalize(), Math.min(1, dt * 2)).normalize();
    if (c.goal.dot(c.d) > 0.9985) c.goal = null;
  }
  c.h.applyAxisAngle(c.d, Math.sin(simT * 0.7 + c.ph) * 1.3 * dt + rnd(-1, 1) * dt * 1.5);
  tmp.copy(c.d).addScaledVector(c.h, c.sp * dt * 0.9).normalize();
  if (surfaceH(tmp) < WATER + 0.006 || waterDepth(tmp) > 0.0015) { c.h.applyAxisAngle(c.d, Math.PI * rnd(0.6, 1.4)); c.wait = rnd(0.2, 0.6); c.goal = null; }
  else c.d.copy(tmp);
  c.h.addScaledVector(c.d, -c.h.dot(c.d)).normalize();
  if (!isFinite(c.h.x)) c.h = tangentOf(c.d);
  if (Math.random() < dt * 0.15) c.wait = rnd(0.6, 2.2);
}

/* ---------- spatial hash (lat/lon buckets) for neighbour queries ---------- */
const HR = 18, HC = 36, CW = Math.PI / HR;
const rowOf = (y) => clamp(Math.floor((Math.asin(clamp(y, -1, 1)) + Math.PI / 2) / CW), 0, HR - 1);
const colOf = (x, z) => ((Math.floor((Math.atan2(z, x) + Math.PI) / CW) % HC) + HC) % HC;
class Hash {
  constructor() { this.b = Array.from({ length: HR * HC }, () => []); }
  clear() { for (const a of this.b) a.length = 0; }
  add(o) { this.b[rowOf(o.d.y) * HC + colOf(o.d.x, o.d.z)].push(o); }
  query(d, rad, fn) {
    const r0 = rowOf(d.y), c0 = colOf(d.x, d.z), span = Math.ceil(rad / CW), cosR = Math.cos(rad);
    for (let r = Math.max(0, r0 - span); r <= Math.min(HR - 1, r0 + span); r++) {
      const cl = Math.cos(Math.max(Math.abs(r * CW - Math.PI / 2), Math.abs((r + 1) * CW - Math.PI / 2)));
      const cs = cl < 0.15 ? HC : Math.ceil(rad / (CW * cl)) + 1;
      const all = 2 * cs + 1 >= HC;
      for (let q = all ? 0 : c0 - cs; q <= (all ? HC - 1 : c0 + cs); q++) {
        for (const o of this.b[r * HC + ((q % HC) + HC) % HC]) if (o.d.dot(d) > cosR && fn(o) === true) return;
      }
    }
  }
}
const treeHash = new Hash(), critHash = new Hash();

/* ---------- clouds ---------- */
const clouds = [];
const rainMat = new THREE.LineBasicMaterial({ color: 0xa8d0ff, transparent: true, opacity: 0.7 });
const puffGeo = new THREE.IcosahedronGeometry(0.05, 0);
function makeCloud(o) {
  const g = new THREE.Group(), puffs = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, transparent: true, opacity: 0.95 });
  const n = 3 + ((Math.random() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(puffGeo, mat);
    m.position.set((i - (n - 1) / 2) * 0.045 + rnd(-0.01, 0.01), rnd(-0.008, 0.02), rnd(-0.02, 0.02));
    m.scale.setScalar(rnd(0.7, 1.25) * (1 - Math.abs(i - (n - 1) / 2) * 0.18));
    m.rotation.set(rnd(0, 3), rnd(0, 3), 0);
    puffs.add(m);
  }
  g.add(puffs);
  const NR = 26, rp = new Float32Array(NR * 6);
  const rg = new THREE.BufferGeometry(); rg.setAttribute("position", new THREE.BufferAttribute(rp, 3));
  const rain = new THREE.LineSegments(rg, rainMat); rain.visible = false; rain.frustumCulled = false; g.add(rain);
  const drops = Array.from({ length: NR }, () => ({ x: rnd(-0.09, 0.09), z: rnd(-0.03, 0.03), y: rnd(-0.3, 0) }));
  world.add(g);
  const d = V(...o.d).normalize();
  const ax = o.ax ? V(...o.ax).normalize() : tangentOf(d).applyAxisAngle(d, rnd(0, 6.28));
  const c = { g, puffs, mat, rain, drops, d, ax, sp: o.sp ?? rnd(0.035, 0.07) * (Math.random() < 0.5 ? -1 : 1), raining: false, next: rnd(1, 5), born: o.anim ? clock() : -9, wob: rnd(0, 6), w: o.w ?? 0.2, evap: !!o.e, fade: 0, age: o.a ?? 0, life: o.l ?? rnd(90, 240), sz: o.z ?? 1 };
  clouds.push(c);
  return c;
}
const RAIN_TOP = 1.32;
function stepCloud(c, dt) {
  c.d.applyAxisAngle(c.ax, c.sp * dt).normalize();
  c.next -= dt;
  if (c.next <= 0) { c.raining = !c.raining; c.next = c.raining ? rnd(5, 9) : rnd(6, 14); if (c.raining && speed <= 2) sfx.rain(); }
  if (c.raining) treeHash.query(c.d, 0.23, (t) => { t.wet = Math.min(1, t.wet + dt * 0.5); });
  if (c.evap && c.w <= 0.0005 && !c.raining) c.fade += dt / 4;
  c.age += dt;
  if (c.merged) { c.raining = false; c.fade += dt / 1.5; c.d.lerp(c.into.d, Math.min(1, dt * 2)).normalize(); }
  else if (c.age > c.life) { c.raining = false; c.fade += dt / 6; } // clouds dissipate after their lifetime
}
// cloud bookkeeping: merge neighbours, return the water of dissipated clouds to the air, keep a few around
const CLOUD_MIN = 3, MERGE_COS = Math.cos(0.07);
let cloudT = 0;
function cloudTick(dt) {
  cloudT += dt; if (cloudT < 1) return; cloudT = 0;
  for (let i = 0; i < clouds.length; i++) {
    const a = clouds[i]; if (a.fade > 0) continue;
    for (let j = i + 1; j < clouds.length; j++) {
      const b = clouds[j]; if (b.fade > 0 || a.d.dot(b.d) < MERGE_COS) continue;
      const [big, small] = a.w >= b.w ? [a, b] : [b, a];
      big.w += small.w; small.w = 0; small.merged = true; small.into = big; small.fade = 0.001;
      big.sz = Math.min(1.8, Math.sqrt(big.sz * big.sz + small.sz * small.sz));
      big.life = Math.max(big.life, small.life - small.age + big.age);
      if (small === a) break;
    }
  }
  let live = 0; for (const c of clouds) if (c.fade === 0) live++;
  for (; live < CLOUD_MIN; live++) {
    const d = V(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const w = Math.min(vapor, 0.2); vapor -= w; // ambient clouds only carry water the air already holds
    makeCloud({ d: d.toArray(), w, anim: true });
  }
}
function drawCloud(c, dt, t) {
  const r = RAIN_TOP + Math.sin(t * 0.6 + c.wob) * 0.008;
  c.g.position.copy(c.d).multiplyScalar(r);
  orientTo(c.g, c.d, 0);
  c.g.scale.setScalar(Math.max(0.001, (c.born < 0 ? 1 : elastic((t - c.born) / 0.8)) * (1 - Math.min(1, c.fade)) * c.sz));
  c.mat.color.setScalar(lerp(c.mat.color.r, c.raining ? 0.72 : 1, Math.min(1, dt * 2)));
  c.rain.visible = c.raining;
  if (c.raining) {
    const ground = surfaceH(c.d) - r + 0.01, p = c.rain.geometry.attributes.position.array;
    c.drops.forEach((dr, i) => { dr.y -= dt * 0.55; if (dr.y < ground) dr.y = rnd(-0.03, 0); p.set([dr.x, dr.y, dr.z, dr.x, dr.y - 0.018, dr.z], i * 6); });
    c.rain.geometry.attributes.position.needsUpdate = true;
  }
}

/* ---------- volcanoes ---------- */
const volcanoes = [];
const lavaGlowMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xff6a20, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
// eruption timing: independent per volcano, exponential (Poisson) gaps clamped to ~10 s .. several minutes,
// with occasional long quiet spells; re-randomised on every load so volcanoes never share a phase
function eruptGap() {
  let g = 10 + -Math.log(1 - Math.random()) * 55;
  if (Math.random() < 0.15) g += rnd(90, 240); // quiet period
  return Math.min(g, 360);
}
function makeVolcano(o) {
  const v = { d: V(...o.d).normalize(), g: o.g ?? 0, nx: o.nx != null && o.nx < 6 ? o.nx : eruptGap(), str: 1, dbl: false, e: 0, hit: 0, born: clock(), glow: new THREE.Sprite(lavaGlowMat.clone()) };
  v.glow.material.opacity = 0; world.add(v.glow);
  volcanoes.push(v);
  return v;
}
function volcanoDamage(v) {
  const k = 0.45 + 0.55 * v.str;
  coolLava(v.d, 0.26 * k, v.str); // small puffs barely reach past the cone, big blasts sweep wide
  ruinVillagesNear(v.d, 0.21 * k);
  critHash.query(v.d, 0.2 * k, (c) => { if (!c.dying) killCritter(c); });
  treeHash.query(v.d, 0.19 * k, (t) => {
    if (t.dead || t.gone) return;
    killTree(t, true);
    for (let i = 0; i < 6; i++) glow.emit(_v.copy(t.d).multiplyScalar(t.hh + 0.03), _v2.copy(t.d).multiplyScalar(rnd(0.03, 0.1)).add(near(t.d, 1).sub(t.d).multiplyScalar(0.05)), 1, rnd(0.35, 0.6), 0.1, rnd(0.015, 0.03), rnd(0.6, 1.3), 0.1);
  });
}
function stepVolcano(v, dt) {
  if (v.g < 1) { const dg = Math.min(1 - v.g, dt / 8); raiseVolcano(v, dg); v.g += dg; return; }
  if (v.e > 0) {
    v.e -= dt; v.hit -= dt;
    if (v.hit <= 0) { v.hit = 0.5; volcanoDamage(v); }
  } else {
    v.nx -= dt;
    if (v.nx <= 0) {
      v.str = 0.25 + 1.55 * Math.pow(Math.random(), 1.6); // 0.25 puff .. 1.8 blast, mostly small
      v.e = (1.5 + 3.5 * v.str) * rnd(0.8, 1.2); v.hit = 0; S.eruptions = (S.eruptions || 0) + 1;
      // rare double eruption: a second burst follows quickly, otherwise a fresh random gap
      if (!v.dbl && Math.random() < 0.1) { v.nx = v.e + rnd(2, 7); v.dbl = true; } else { v.nx = v.e + eruptGap(); v.dbl = false; }
      shake = Math.max(shake, 0.12 + 0.3 * v.str); if (speed <= 2 && v.str > 0.5) sfx.rumble();
      if (S.eruptions === 1) toast("Eruption! 🌋");
    }
  }
}
function drawVolcano(v, dt) {
  const top = surfaceH(v.d) + 0.004;
  v.glow.position.copy(v.d).multiplyScalar(top + 0.01);
  const want = v.e > 0 ? Math.min(1, 0.45 + 0.4 * v.str) : v.g < 1 ? 0.25 : 0.12;
  v.glow.material.opacity = lerp(v.glow.material.opacity, want, Math.min(1, dt * 4));
  v.glow.scale.setScalar(0.1 + 0.18 * v.glow.material.opacity);
  const p = _p.copy(v.d).multiplyScalar(top), tan = tangentOf(v.d);
  if (v.e > 0) {
    const n = Math.min(60, Math.ceil(dt * 160 * v.str));
    for (let i = 0; i < n; i++) {
      const side = tan.clone().applyAxisAngle(v.d, rnd(0, 6.28)).multiplyScalar(rnd(0, 0.2));
      glow.emit(p, _v.copy(v.d).multiplyScalar(rnd(0.22, 0.55) * (0.6 + 0.4 * v.str)).add(side.multiplyScalar(0.5 + 0.5 * v.str)), 1, rnd(0.35, 0.85), rnd(0.05, 0.2), rnd(0.012, 0.03), rnd(0.8, 1.6), 0.9);
    }
    if (Math.random() < dt * 40 * Math.min(1.5, v.str)) smoke.emit(p, _v.copy(v.d).multiplyScalar(rnd(0.06, 0.12)).addScaledVector(tan.applyAxisAngle(v.d, rnd(0, 6.28)), 0.02), rnd(0.25, 0.4), rnd(0.23, 0.36), rnd(0.22, 0.33), 0.05, rnd(2.5, 4), 0, 0.06);
  } else if (Math.random() < dt * (v.g < 1 ? 8 : 1.5)) {
    smoke.emit(p, _v.copy(v.d).multiplyScalar(rnd(0.03, 0.06)), 0.6, 0.6, 0.62, 0.03, rnd(2, 3.5), 0, 0.03);
  }
}

/* ---------- villages ---------- */
const villages = [];
const houseGeo = new THREE.BoxGeometry(0.014, 0.012, 0.014).translate(0, 0.006, 0);
const roofGeo = new THREE.ConeGeometry(0.012, 0.01, 4).rotateY(Math.PI / 4).translate(0, 0.017, 0);
const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2e6d0, flatShading: true, roughness: 1 });
const roofMats = [0xc8553d, 0x8d5a97, 0x3d7ea6].map((c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 1 }));
const winMat = new THREE.MeshBasicMaterial({ color: 0xffd27a });
const winGeo = new THREE.PlaneGeometry(0.005, 0.005);
const lightMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xffc46b, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
const ruinMat = new THREE.MeshStandardMaterial({ color: 0x5a524c, flatShading: true, roughness: 1, transparent: true });
const RUIN_FADE = 60, VR = 0.12;
// villages are emergent: founded where trees and critters thrive, sized by the local population, wrecked by meteors and lava
function villageRoom(d) { for (const v of villages) if (v.d.dot(d) > Math.cos(0.24)) return false; return true; }
function localLife(d) { let t = 0, c = 0; treeHash.query(d, VR, (x) => { if (!x.dead && !x.gone) t++; }); critHash.query(d, VR, (x) => { if (!x.dying) c++; }); return { t, c, pop: c + t * 0.5 }; }
function buildVillage(v) {
  while (v.g.children.length) v.g.remove(v.g.children[0]);
  const d = v.d, tan = tangentOf(d), bit = V().crossVectors(d, tan);
  for (let i = 0; i < v.n; i++) {
    const a = i * 2.4 + 0.4, rr = 0.021 * Math.sqrt(i);
    const hd = d.clone().addScaledVector(tan, Math.cos(a) * rr).addScaledVector(bit, Math.sin(a) * rr).normalize();
    const house = new THREE.Group();
    if (v.ruin) house.add(new THREE.Mesh(houseGeo, v.rmat));
    else {
      house.add(new THREE.Mesh(houseGeo, wallMat), new THREE.Mesh(roofGeo, roofMats[i % 3]));
      const w = new THREE.Mesh(winGeo, winMat); w.position.set(0, 0.006, 0.0071); house.add(w);
    }
    house.userData.d = hd; orientTo(house, hd, a); house.scale.set(1.8, v.ruin ? 0.7 : 1.8, 1.8);
    v.g.add(house);
    if (!v.ruin) { const gl = new THREE.Sprite(lightMat); gl.scale.setScalar(0.09); gl.userData.d = hd; v.g.add(gl); }
  }
  v.built = v.n; placeVillage(v);
}
function makeVillage(o) {
  const v = { d: V(...o.d).normalize(), n: o.n || 1, g: new THREE.Group(), ruin: o.r >= 0, ruinT: o.r >= 0 ? simT - o.r : 0, rmat: null, built: -1 };
  if (v.ruin) v.rmat = ruinMat.clone();
  v.g.userData.born = o.anim ? clock() : -9;
  world.add(v.g); villages.push(v); buildVillage(v);
  return v;
}
function ruinVillage(v) {
  if (v.ruin) return;
  v.ruin = true; v.ruinT = simT; v.rmat = ruinMat.clone(); buildVillage(v);
  S.ruined = (S.ruined || 0) + 1;
}
function ruinVillagesNear(d, rad) { for (const v of villages) if (v.d.dot(d) > Math.cos(rad)) ruinVillage(v); }
let villT = 0;
function villageTick() {
  for (let i = villages.length - 1; i >= 0; i--) {
    const v = villages[i];
    if (v.ruin) {
      const age = simT - v.ruinT;
      v.rmat.opacity = Math.max(0, 1 - age / RUIN_FADE);
      if (age > RUIN_FADE) { world.remove(v.g); villages.splice(i, 1); }
      continue;
    }
    if (surfaceH(v.d) < WATER + 0.004 || waterDepth(v.d) > 0.003) { ruinVillage(v); continue; } // flooded
    const L = localLife(v.d);
    const want = clamp(Math.floor(L.pop / 2.5), 0, 16);
    if (want > v.n) v.n++;
    else if (want < v.n - 1) v.n--;
    if (v.n <= 0 || (L.t === 0 && L.c === 0)) { v.n = Math.max(1, v.n); ruinVillage(v); continue; } // abandoned
    if (v.built !== v.n) buildVillage(v);
  }
  // founding: probe a few thriving spots
  const live = trees.filter((t) => !t.dead && !t.gone);
  for (let k = 0; k < 3 && live.length; k++) {
    const t = live[(Math.random() * live.length) | 0];
    const d = near(t.d, 0.03);
    if (!villageRoom(d) || surfaceH(d) < WATER + 0.008 || waterDepth(d) > 0.0005) continue;
    const L = localLife(d);
    if (L.t >= 5 && L.c >= 2) {
      makeVillage({ d: d.toArray(), n: 1, anim: booted });
      S.founded = (S.founded || 0) + 1;
      if (booted) toast(villages.filter((x) => !x.ruin).length === 1 ? "A village appeared 🏡" : "Another village 🏡");
      break;
    }
  }
}
function syncVillages() {}
function placeVillage(v) { v.g.children.forEach((h) => { const d = h.userData.d; h.position.copy(d).multiplyScalar(surfaceH(d) + (h.isSprite ? 0.012 : -0.001)); }); }
function placeVillages() { for (const v of villages) placeVillage(v); }

/* ---------- meteors (random size), debris, rings ---------- */
const meteors = [], rings = [];
const rockGeo = new THREE.DodecahedronGeometry(0.035, 0);
const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b5b53, flatShading: true, emissive: 0xff5a1f, emissiveIntensity: 0.6 });
const debrisI = new Inst(new THREE.TetrahedronGeometry(0.012, 0), new THREE.MeshStandardMaterial({ color: 0x7a5a46, flatShading: true }), false);
const DEB = 600; debrisI.ensure(DEB);
const debris = Array.from({ length: DEB }, () => ({ p: V(), v: V(), life: 0, rx: 0, ry: 0, sx: 0, sy: 0, sc: 1 })); let debI = 0;
for (let i = 0; i < DEB; i++) debrisI.mesh.setMatrixAt(i, ZERO);
const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
const meteorSize = () => 0.35 + 1.9 * Math.pow(Math.random(), 1.8);
function launchMeteor(d, size) {
  const side = tangentOf(d).applyAxisAngle(d, rnd(0, 6.28));
  const from = d.clone().multiplyScalar(3.4).addScaledVector(side, 1.6);
  const rock = new THREE.Mesh(rockGeo, rockMat); rock.scale.setScalar(0.6 + size * 0.55);
  rock.position.copy(from); world.add(rock);
  meteors.push({ d: d.clone(), from, rock, size, t: 0, dur: 0.85 + size * 0.12 });
  sfx.whoosh();
}
function impact(m) {
  world.remove(m.rock);
  const d = m.d, s = m.size;
  const wet = surfaceH(d) < WATER + 0.004;
  const r = 0.05 + 0.06 * s;
  applyCrater(d, r, 0.014 * s);
  ruinVillagesNear(d, r * 1.8);
  if (!wet) S.craters = (S.craters || 0) + 1;
  treeHash.query(d, r * 2, (t) => { if (!t.dead && !t.gone) { killTree(t, false); t.fallStart = clock() + (1 - t.d.dot(d)) * 6; t.fa = V().crossVectors(d, t.d).normalize(); if (t.fa.lengthSq() < 0.5) t.fa = tangentOf(t.d); } });
  for (const c of critters) {
    if (c.dying) continue;
    const dot = c.d.dot(d);
    if (dot > Math.cos(r * 1.5)) killCritter(c);
    else if (dot > Math.cos(r * 3.2)) { c.jump = 1; c.h.copy(c.d).sub(d).normalize(); if (!isFinite(c.h.x)) c.h = tangentOf(c.d); }
  }
  const top = d.clone().multiplyScalar(surfaceH(d) + 0.01), tan = tangentOf(d);
  for (let i = 0, n = Math.round(10 + 16 * s); i < n; i++) {
    const p = debris[debI]; debI = (debI + 1) % DEB;
    p.p.copy(top); p.v.copy(d).multiplyScalar(rnd(0.3, 0.6) * (0.7 + s * 0.4)).addScaledVector(tan.clone().applyAxisAngle(d, rnd(0, 6.28)), rnd(0.12, 0.4) * (0.7 + s * 0.3));
    p.life = 1.3; p.sx = rnd(-9, 9); p.sy = rnd(-9, 9); p.sc = rnd(0.6, 1.2) * (0.7 + s * 0.3);
  }
  for (let i = 0, n = Math.round(30 * s); i < n; i++) {
    glow.emit(top, _v.copy(d).multiplyScalar(rnd(0.1, 0.5)).addScaledVector(tan.clone().applyAxisAngle(d, rnd(0, 6.28)), rnd(0.1, 0.5) * s), wet ? 0.7 : 1, wet ? 0.9 : rnd(0.5, 0.8), wet ? 1 : 0.25, rnd(0.015, 0.035), rnd(0.4, 0.9), 0.8);
  }
  for (let i = 0; i < 6 * s; i++) smoke.emit(top, _v.copy(d).multiplyScalar(rnd(0.02, 0.07)).addScaledVector(tan.clone().applyAxisAngle(d, rnd(0, 6.28)), rnd(0.02, 0.08)), 0.45, 0.4, 0.36, 0.05 * s, rnd(1.5, 2.6), 0, 0.05);
  addRing(d, wet ? 0xbfe6ff : 0xffb070, r * 2.4);
  shake = Math.min(1.4, Math.max(shake, 0.15 + 0.32 * s)); sfx.boom(s);
  updateCount(); save();
}
function addRing(d, color, size) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  m.position.copy(d).multiplyScalar(surfaceH(d) + 0.006);
  m.quaternion.setFromUnitVectors(V(0, 0, 1), d);
  world.add(m); rings.push({ m, t: 0, size });
}

/* ---------- ecology step (fixed sim step, sped up with ?speed=) ---------- */
const STEP = 0.05;
let waterT = 0;
// wild meteors: Poisson arrivals, mean ~2.2 min, clamped to 1-4 min; timer is not saved, so it re-randomises on load
let wildT = 60 + -Math.log(1 - Math.random()) * 70;
function wildMeteor(dt) {
  wildT -= dt; if (wildT > 0) return;
  wildT = Math.min(240, 60 + -Math.log(1 - Math.random()) * 70);
  const d = V(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  if (d.lengthSq() > 0) { launchMeteor(d, meteorSize()); S.wild = (S.wild || 0) + 1; }
}
function step(dt) {
  simT += dt;
  wildMeteor(dt);
  treeHash.clear(); critHash.clear();
  for (const t of trees) if (!t.dead && !t.gone) treeHash.add(t);
  for (const c of critters) if (!c.dying) critHash.add(c);
  for (const c of clouds) stepCloud(c, dt);
  for (const v of volcanoes) stepVolcano(v, dt);
  for (let i = clouds.length - 1; i >= 0; i--) if (clouds[i].fade >= 1) { const c = clouds[i]; vapor += Math.max(0, c.w); c.w = 0; world.remove(c.g); c.mat.dispose(); clouds.splice(i, 1); }
  cloudTick(dt);
  waterT += dt; if (waterT >= 0.5) { waterTick(waterT); waterT = 0; }
  villT += dt; if (villT >= 2) { villT = 0; villageTick(); }
  // trees: grow only in sunlight AND with rain; wilt in long droughts
  for (let i = 0, n = trees.length; i < n; i++) {
    const t = trees[i];
    if (t.gone) continue;
    if (t.dead) { if (simT - t.deadT > 45) goneTree(t); continue; }
    t.wet = Math.max(0, t.wet - dt / 50);
    if (t.wet <= 0) t.dry += dt; else t.dry = 0;
    if (t.dry > 100) t.wilt = Math.min(1, t.wilt + dt / 60); else if (t.wet > 0.2) t.wilt = Math.max(0, t.wilt - dt / 40);
    if (t.wilt >= 1) { killTree(t, false); continue; }
    const sunny = t.d.dot(sunLocal) > 0.05;
    if (sunny && t.wet > 0.02 && t.wilt < 0.5) {
      t.s = Math.min(1.6, t.s + dt * 0.014);
      if (t.s > 0.9 && Math.random() < dt * 0.012) {
        const nd = near(t.d, rnd(0.03, 0.09));
        let dense = 0; treeHash.query(nd, 0.045, () => { dense++; });
        if (dense < 3 && surfaceH(nd) > WATER + 0.008 && waterDepth(nd) < 0.0008) { const s = makeTree({ d: nd.toArray(), s: 0.05, w: t.wet * 0.6, anim: true }); treeHash.add(s); }
      }
    }
  }
  // critters: wander, eat trees, age, starve, breed
  for (let i = 0, n = critters.length; i < n; i++) {
    const c = critters[i];
    if (c.dying) continue;
    moveCritter(c, dt);
    c.age += dt; c.cd -= dt; c.hunger += dt / 75; c.tick -= dt;
    if (c.tick <= 0) {
      c.tick = rnd(0.4, 0.7);
      if (surfaceH(c.d) < WATER) { killCritter(c); continue; }
      if (c.hunger > 0.25) {
        let best = null, bd = -2;
        treeHash.query(c.d, c.hunger > 0.5 ? 0.3 : 0.07, (t) => { if (!t.dead && !t.gone) { const dd = t.d.dot(c.d); if (dd > bd) { bd = dd; best = t; } } });
        if (best && bd > Math.cos(0.07)) {
          c.hunger = Math.max(0, c.hunger - 0.45); best.s -= 0.07; c.goal = null;
          if (best.s < 0.04) goneTree(best);
        } else if (best) c.goal = best.d.clone();
      }
      if (c.age > MATURE && c.cd <= 0 && c.hunger < 0.4) {
        let mate = null;
        critHash.query(c.d, 0.08, (o) => { if (o !== c && !o.dying && o.age > MATURE && o.cd <= 0 && o.hunger < 0.45) { mate = o; return true; } });
        if (mate) {
          let food = 0, crowd = 0; treeHash.query(c.d, 0.22, (t) => { if (!t.dead && !t.gone && t.s > 0.3) food++; });
          critHash.query(c.d, 0.22, (o) => { if (!o.dying) crowd++; });
          if (food && crowd <= food * 1.5 + 1) {
            const nd = c.d.clone().add(mate.d).normalize();
            const kid = makeCritter({ d: near(nd, 0.015).toArray(), col: Math.random() < 0.5 ? c.col : mate.col, a: 0, hu: 0.2, cd: 0, anim: true });
            critHash.add(kid);
            for (const p of [c, mate]) { p.cd = rnd(45, 80); p.hunger += 0.25; }
            S.births = (S.births || 0) + 1;
            if (speed <= 2 && Math.random() < 0.3) sfx.squeak();
          }
        }
      }
    }
    if (c.hunger >= 1 || c.age >= c.life) killCritter(c);
  }
}

/* ---------- tools ---------- */
let tool = "tree";
function act(d) {
  const h = surfaceH(d);
  if (tool === "tree") {
    if (h < WATER + 0.006) { toast("Trees don't swim 🌊"); sfx.bloop(); return; }
    for (let i = 0; i < 2; i++) {
      const dd = i === 0 ? d : near(d, rnd(0.02, 0.04));
      if (i === 1 && (Math.random() < 0.55 || surfaceH(dd) < WATER + 0.006)) continue;
      makeTree({ d: dd.toArray(), s: rnd(0.1, 0.3), w: 0.8, anim: true });
    }
    sfx.pop(); syncVillages();
  } else if (tool === "meteor") {
    launchMeteor(d, meteorSize());
  } else if (tool === "water") {
    applyLake(d, 0.17); addRing(d, 0x9fdcff, 0.25); sfx.bloop();
  } else if (tool === "land") {
    applyLand(d, 0.09); addRing(d, 0xd9b77a, 0.18); sfx.pop();
  } else if (tool === "cloud") {
    makeCloud({ d: d.toArray(), anim: true }); sfx.puff();
  } else if (tool === "critter") {
    if (h < WATER + 0.006) { toast("Critters can't swim 🫧"); sfx.bloop(); return; }
    makeCritter({ d: d.toArray(), a: MATURE + 1, cd: rnd(2, 8), anim: true }); sfx.squeak();
  } else if (tool === "volcano") {
    makeVolcano({ d: d.toArray() }); shake = Math.max(shake, 0.2); sfx.rumble(); addRing(d, 0xff8a4a, 0.3);
  }
  updateCount(); save();
}
const TIPS = { tree: "Tap to plant a tree", meteor: "Tap to call a meteor", water: "Tap to make a lake", cloud: "Tap to add a rain cloud", critter: "Tap to drop a critter", volcano: "Tap to raise a volcano", land: "Tap or hold to raise land and push water back" };
document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => {
  tool = b.dataset.tool;
  document.querySelectorAll("[data-tool]").forEach((x) => x.classList.toggle("on", x === b));
  toast(TIPS[tool]); sfx.tick();
}));

/* ---------- HUD ---------- */
const countEl = $("[data-count]");
const alive = () => { let n = 0; for (const c of critters) if (!c.dying) n++; return n; };
function updateCount() {
  countEl.textContent = `🌲 ${standing()} · 🐾 ${alive()} · 🕳️ ${S.craters || 0} · 🌋 ${volcanoes.length} · 🏡 ${villages.filter((v) => !v.ruin).length}\n🐣 ${S.births || 0} · 💀 ${S.deaths || 0}`;
}
let toastT = 0;
function toast(msg) {
  const el = $("[data-toast]"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2200);
}
const resetBtn = $("[data-reset]");
let resetArm = 0;
resetBtn.addEventListener("click", () => {
  if (!resetArm) { resetBtn.textContent = "Sure?"; resetArm = setTimeout(() => { resetArm = 0; resetBtn.textContent = "Reset"; }, 2500); return; }
  clearTimeout(resetArm); resetArm = 0; resetBtn.textContent = "Reset";
  trees.length = 0; critters.length = 0;
  clouds.forEach((c) => world.remove(c.g)); clouds.length = 0;
  villages.forEach((v) => world.remove(v.g)); villages.length = 0;
  volcanoes.forEach((v) => world.remove(v.glow)); volcanoes.length = 0;
  meteors.forEach((m) => world.remove(m.rock)); meteors.length = 0;
  field.fill(0); crat.fill(0); basalt.fill(0); wat.fill(0); vapor = 0; waterDirty = true; markTerrain();
  S = { v: 2, trees: [], critters: [], clouds: [], volcanoes: [], craters: 0, births: 0, deaths: 0, eruptions: 0 };
  buildPlanet(); buildWater(); seedFresh(); updateCount(); save(true); toast("A fresh little world ✨"); sfx.pop();
});

/* ---------- sound (muted by default, synthesized) ---------- */
const soundBtn = $("[data-sound]");
let ac = null, muted = true;
try { muted = localStorage.getItem("planet.sound") !== "1"; } catch (e) {}
function paintSound() { soundBtn.textContent = muted ? "🔇" : "🔊"; soundBtn.setAttribute("aria-label", muted ? "Sound off" : "Sound on"); }
paintSound();
soundBtn.addEventListener("click", () => {
  muted = !muted; paintSound();
  try { localStorage.setItem("planet.sound", muted ? "0" : "1"); } catch (e) {}
  if (!muted) sfx.pop();
});
function audio() {
  if (muted) return null;
  if (!ac) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ac = new A(); }
  if (ac.state === "suspended") ac.resume();
  return ac;
}
function tone(f0, f1, dur, type = "sine", vol = 0.08) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.05);
}
function noise(dur, freq, vol, q = 0.8, sweep) {
  const a = audio(); if (!a) return;
  const len = Math.floor(a.sampleRate * dur), b = a.createBuffer(1, len, a.sampleRate), ch = b.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), t = a.currentTime;
  s.buffer = b; f.type = "lowpass"; f.Q.value = q; f.frequency.setValueAtTime(freq, t);
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(a.destination); s.start(t);
}
const sfx = {
  pop: () => tone(420, 880, 0.14, "sine", 0.07),
  tick: () => tone(1200, 900, 0.05, "triangle", 0.025),
  bloop: () => tone(600, 180, 0.28, "sine", 0.07),
  puff: () => noise(0.45, 900, 0.05, 0.6, 300),
  squeak: () => { tone(1100, 1500, 0.07, "triangle", 0.04); setTimeout(() => tone(1300, 1800, 0.07, "triangle", 0.035), 90); },
  whoosh: () => noise(0.9, 400, 0.04, 1.2, 2400),
  boom: (s = 1) => { noise(0.6 + 0.4 * s, 300 + 250 * s, Math.min(0.2, 0.06 + 0.06 * s), 0.7, 50); tone(140 - 30 * s, 35, 0.4 + 0.25 * s, "sine", Math.min(0.2, 0.06 + 0.06 * s)); },
  rumble: () => { noise(2.2, 180, 0.12, 0.7, 50); tone(60, 30, 1.6, "sine", 0.09); },
  rain: () => noise(1.2, 3000, 0.012, 0.4, 2000)
};

/* ---------- input: drag/inertia, pinch/scroll zoom, tap ---------- */
const pointers = new Map();
// zoom = altitude above the unit sphere as a fraction of the default altitude (log-scaled, so speed ∝ distance)
const ZMIN = 0.004, ZMAX = 1.9;
const camDirL = V();
let vel = { x: 0, y: 0 }, last = 0, zoom = 1, zoomTarget = 1, pinch0 = 0, zoom0 = 1, down = null, idle = 0, shake = 0;
const qx = new THREE.Quaternion(), qy = new THREE.Quaternion();
// dragging orbits the CAMERA around a fixed planet: the sun, moon and stars stay put in space, so you can
// fly over to the night side and back to the day side (trackball around the camera's own axes)
const camQ = new THREE.Quaternion();
function spin(dx, dy) {
  qy.setFromAxisAngle(V(0, 1, 0), -dx); qx.setFromAxisAngle(V(1, 0, 0), -dy);
  camQ.multiply(qy).multiply(qx).normalize();
}
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  idle = 0;
  if (pointers.size === 1) { down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 }; vel.x = vel.y = 0; last = performance.now(); }
  else { down = null; const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = zoomTarget; }
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId); if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 1) {
    const k = 3.2 / Math.min(innerWidth, innerHeight) * clamp(zoom, 0.015, 1.9);
    spin(dx * k, dy * k);
    const now = performance.now(), dt = Math.max(1, now - last) / 1000; last = now;
    vel.x = lerp(vel.x, (dx * k) / dt, 0.5); vel.y = lerp(vel.y, (dy * k) / dt, 0.5);
    if (down && !down.held) down.moved += Math.abs(dx) + Math.abs(dy);
    if (down && down.held) { down.x = e.clientX; down.y = e.clientY; spin(-dx * k, -dy * k); vel.x = vel.y = 0; } // holding the land tool paints, not spins
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch0 > 0) zoomTarget = clamp(zoom0 * (pinch0 / dist), ZMIN, ZMAX);
  }
});
function up(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0 && down) {
    if (performance.now() - last > 80) vel.x = vel.y = 0;
    if (down.moved < 10 && !down.held && performance.now() - down.t < 450) { vel.x = vel.y = 0; tap(e.clientX, e.clientY); }
    down = null;
  }
  if (pointers.size === 1) { down = null; last = performance.now(); vel.x = vel.y = 0; }
}
canvas.addEventListener("pointerup", up);
canvas.addEventListener("pointercancel", up);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomTarget = clamp(zoomTarget * Math.exp(clamp(e.deltaY, -120, 120) * 0.0022), ZMIN, ZMAX); idle = 0; }, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault());
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
// hold-to-build for the land tool: after 300 ms without moving, keep raising land under the finger
function holdTick(now) {
  if (tool !== "land" || !down || pointers.size !== 1 || down.moved >= 10 || now - down.t < 300) return;
  if (!down.held) { down.held = true; down.lastH = 0; }
  if (now - down.lastH < 120) return; down.lastH = now;
  ndc.set((down.x / innerWidth) * 2 - 1, -(down.y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(planet, false)[0]; if (!hit) return;
  applyLand(world.worldToLocal(hit.point.clone()).normalize(), 0.09, 0.6);
  if (Math.random() < 0.3) sfx.tick();
  save();
}
function tap(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(planet, false)[0];
  if (!hit) return;
  act(world.worldToLocal(hit.point.clone()).normalize());
}

/* ---------- resize ---------- */
let fitDist = 5;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  fitDist = Math.max(1.5 / half, 1.32 / (half * camera.aspect));
  camera.updateProjectionMatrix();
  const sc = renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * half);
  glow.mat.uniforms.uScale.value = smoke.mat.uniforms.uScale.value = sc;
}
addEventListener("resize", resize); resize();

/* ---------- boot ---------- */
let booted = false;
function landSpot(tries = 400, front = true) {
  for (let i = 0; i < tries; i++) {
    const d = front ? V(rnd(-0.6, 0.6), rnd(0.1, 1), rnd(0.3, 1)).normalize() : V(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize();
    if (surfaceH(d) > WATER + 0.012) return d;
  }
  return null;
}
function seedFresh() {
  for (let i = 0; i < 14; i++) { const d = landSpot(); if (d) makeTree({ d: d.toArray(), s: rnd(0.3, 1), w: 0.9, anim: true }); }
  for (let i = 0; i < 6; i++) { const d = landSpot(); if (d) makeCritter({ d: d.toArray(), a: rnd(10, 60), anim: true }); }
  for (let i = 0; i < 2; i++) { const d = landSpot(); if (d) makeCloud({ d: d.toArray(), anim: true }); }
  syncVillages();
}
buildPlanet(); buildWater();
(S.trees || []).forEach((t) => makeTree(t));
(S.critters || []).forEach((c) => makeCritter(c));
(S.clouds || []).forEach((c) => makeCloud(c));
(S.volcanoes || []).forEach((v) => makeVolcano(v));
(S.villages || []).forEach((v) => makeVillage(v));
vapor = S.vapor || 0;
if (firstVisit) seedFresh();
if (firstVisit || migrated) save(true);
syncVillages();
updateCount();
booted = true;
setTimeout(() => toast(migrated ? "Your planet came along ✨" : "Drag to spin · tap to plant"), 600);
addEventListener("pagehide", () => save(true));
document.addEventListener("visibilitychange", () => { if (document.hidden) save(true); });
setInterval(() => save(), 8000);

/* ---------- test / debug hooks ---------- */
let fpsAvg = 60, frames = 0;
window.__planet = {
  _dbg: { world, camera, camQ, planet, sunDir, sunLocal, sunLight, sun, moon, wat, field, applyCrater, applyLake, applyLand, coolLava, waterDepth, villages, clouds, makeCloud, makeVillage, V, impact: (d, size) => impact({ d: V(...d).normalize(), size, rock: new THREE.Object3D() }), get vapor() { return vapor; }, set wildT(v) { wildT = v; }, setZoom: (v) => { zoom = zoomTarget = v; }, get zoom() { return zoom; } },
  get speed() { return speed; }, set speed(v) { speed = clamp(+v || 1, 0.1, 200); },
  stats: () => ({ trees: standing(), allTrees: trees.length, critters: alive(), births: S.births || 0, deaths: S.deaths || 0, craters: S.craters || 0, volcanoes: volcanoes.length, eruptions: S.eruptions || 0, simT: r3(simT), fps: Math.round(fpsAvg), frames, tris: planetGeo.index.count / 3, villages: villages.filter((v) => !v.ruin).length, ruins: villages.filter((v) => v.ruin).length, houses: villages.reduce((a, v) => a + (v.ruin ? 0 : v.n), 0), clouds: clouds.length, water: Math.round(waterVolume() * 1e4) / 1e4, vapor: Math.round(vapor * 1e4) / 1e4, cloudWater: Math.round(clouds.reduce((a, c) => a + c.w, 0) * 1e4) / 1e4 }),
  spawn(kind, n = 1) {
    for (let i = 0; i < n; i++) {
      const d = landSpot(400, false); if (!d) continue;
      if (kind === "tree") makeTree({ d: d.toArray(), s: rnd(0.3, 1.2), w: 1 });
      else if (kind === "critter") makeCritter({ d: d.toArray(), a: rnd(0, 80) });
      else if (kind === "cloud") makeCloud({ d: d.toArray() });
      else if (kind === "volcano") makeVolcano({ d: d.toArray(), nx: rnd(1, 5) });
      else if (kind === "meteor") launchMeteor(d, meteorSize());
    }
    syncVillages(); updateCount();
  },
  surfaceH: (x, y, z) => surfaceH(V(x, y, z).normalize()),
  save: () => save(true)
};

/* ---------- loop ---------- */
let prev = performance.now(), simAcc = 0, lastBuild = 0, lastHud = 0, lastWater = 0, colorTick = 0;
const camPos = V(), wqInv = new THREE.Quaternion();
function frame(now) {
  requestAnimationFrame(frame);
  holdTick(now);
  const rdt = (now - prev) / 1000, dt = Math.min(0.05, rdt); prev = now;
  if (rdt > 0) fpsAvg = lerp(fpsAvg, 1 / Math.max(rdt, 0.001), 0.05);
  frames++;
  const t = clock();
  if (pointers.size === 0) {
    idle += dt;
    spin(vel.x * dt, vel.y * dt);
    const damp = Math.exp(-dt * 2.6); vel.x *= damp; vel.y *= damp;
    if (idle > 4) spin(dt * 0.05 * Math.min(1, (idle - 4) / 3), 0);
  }
  zoom = Math.exp(lerp(Math.log(zoom), Math.log(zoomTarget), 1 - Math.exp(-dt * 10)));
  shake = Math.max(0, shake - dt * 1.6);
  // never dip below the ground under the camera (terrain, sea, volcano cones + a little headroom)
  camDirL.set(0, 0, 1).applyQuaternion(camQ).applyQuaternion(wqInv.copy(world.quaternion).invert());
  const ground = Math.max(surfaceH(camDirL), WATER) + 0.022;
  let camD = 1 + (fitDist - 1) * zoom;
  if (camD < ground) { camD = ground; zoom = zoomTarget = Math.max(zoomTarget, (ground - 1) / (fitDist - 1)); }
  const sh = shake * 0.04 * Math.min(1, (camD - 1) * 2);
  camPos.set(rnd(-1, 1) * sh, rnd(-1, 1) * sh, camD).applyQuaternion(camQ);
  camera.position.copy(camPos);
  camera.quaternion.copy(camQ);
  // close to the ground, pitch up toward the horizon so critters and trees are seen from the side
  camera.rotateX(smooth(0.45, 0.03, camD - 1) * 1.15);
  const ang = (simT / DAY) * Math.PI * 2 + 0.8;
  sunDir.set(Math.cos(ang), 0, Math.sin(ang)).applyAxisAngle(V(0, 0, 1), 0.35).normalize();
  sunLocal.copy(sunDir).applyQuaternion(wqInv.copy(world.quaternion).invert());
  sun.position.copy(sunDir).multiplyScalar(7.5);
  moon.position.copy(sunDir).multiplyScalar(-5.5).applyAxisAngle(V(0, 1, 0), 0.25);
  sunLight.position.copy(sunDir).multiplyScalar(10);
  moonLight.position.copy(moon.position);
  hemi.intensity = lerp(0.28, 0.5, smooth(-0.6, 0.6, sunDir.z));
  stars.rotation.y = -ang * 0.15;
  ocean.rotation.y = t * 0.02;

  // simulation (fixed steps)
  simAcc += dt * speed;
  let steps = 0;
  while (simAcc >= STEP && steps < 80) { step(STEP); simAcc -= STEP; steps++; }
  if (steps >= 80) simAcc = 0;

  if (terrainDirty && t - lastBuild > 0.1) { buildPlanet(); placeVillages(); lastBuild = t; }
  if (waterDirty && t - lastWater > 0.2) { buildWater(); lastWater = t; }

  // trees -> instances (swap-remove finished ones)
  for (let i = trees.length - 1; i >= 0; i--) {
    const tr = trees[i];
    if (tr.gone && t - tr.goneT > 0.6) { trees[i] = trees[trees.length - 1]; trees.pop(); }
    else if (tr.dead && tr.fallT < 1 && t > tr.fallStart) tr.fallT = Math.min(1, tr.fallT + dt * 2.8);
  }
  const nT = trees.length;
  trunkI.ensure(nT); pineI.ensure(nT); roundI.ensure(nT);
  const doColor = (colorTick++ % 6) === 0 || pineI.lastN !== nT;
  pineI.lastN = nT;
  for (let i = 0; i < nT; i++) {
    const tr = trees[i], m = treeMatrix(tr, t);
    trunkI.mesh.setMatrixAt(i, m);
    (tr.kind === 0 ? pineI : roundI).mesh.setMatrixAt(i, m);
    (tr.kind === 0 ? roundI : pineI).mesh.setMatrixAt(i, ZERO);
    if (doColor) {
      if (tr.dead) _c.copy(tr.burnt ? BURNT : DEAD);
      else _c.copy(LEAF[tr.kind][tr.vari] || LEAF[tr.kind][0]).lerp(WILT, tr.wilt * 0.85);
      (tr.kind === 0 ? pineI : roundI).mesh.setColorAt(i, _c);
    }
  }
  trunkI.done(); pineI.done(doColor); roundI.done(doColor);

  // critters -> instances
  for (let i = critters.length - 1; i >= 0; i--) {
    const c = critters[i];
    if (c.dying && t - c.dying > 0.6) { critters[i] = critters[critters.length - 1]; critters.pop(); }
  }
  const nC = critters.length;
  bodyI.ensure(nC); earI.ensure(nC); eyeI.ensure(nC);
  for (let i = 0; i < nC; i++) {
    const c = critters[i];
    const hop = c.wait > 0 || c.dying ? 0 : Math.abs(Math.sin(t * 11 + c.ph)) * 0.006;
    _p.copy(c.d).multiplyScalar(surfaceH(c.d) + hop + Math.sin(c.jump * Math.PI) * 0.06);
    fwd.crossVectors(c.h, c.d);
    _m.makeBasis(fwd, c.d, c.h);
    _m.multiply(_m2.makeRotationZ(c.wait > 0 || c.dying ? (c.dying ? Math.min(1.5, (t - c.dying) * 4) : 0) : Math.sin(t * 11 + c.ph) * 0.12));
    let k = c.born < 0 ? 1 : elastic((t - c.born) / 0.6);
    if (c.dying) k *= Math.max(0, 1 - (t - c.dying) / 0.6);
    const young = 0.6 + 0.4 * Math.min(1, c.age / MATURE);
    _m.scale(_s.setScalar(Math.max(0.001, k * 1.9 * young)));
    _m.setPosition(_p);
    bodyI.mesh.setMatrixAt(i, _m); earI.mesh.setMatrixAt(i, _m); eyeI.mesh.setMatrixAt(i, _m);
    _c.setHex(c.col); if (c.dying) _c.lerp(BURNT, 0.5);
    bodyI.mesh.setColorAt(i, _c); earI.mesh.setColorAt(i, _c);
  }
  bodyI.done(true); earI.done(true); eyeI.done();

  for (const c of clouds) drawCloud(c, dt, t);
  for (const v of volcanoes) drawVolcano(v, dt);

  // meteors
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    m.t += dt / m.dur;
    const k = Math.min(1, m.t);
    m.rock.position.lerpVectors(m.from, _v.copy(m.d).multiplyScalar(surfaceH(m.d)), k * k);
    m.rock.rotation.x += dt * 9; m.rock.rotation.y += dt * 7;
    for (let j = 0; j < 3; j++) glow.emit(m.rock.position, _v2.set(rnd(-0.05, 0.05), rnd(-0.05, 0.05), rnd(-0.05, 0.05)), 1, j ? 0.55 : 0.88, j ? 0.25 : 0.55, 0.04 * (0.6 + m.size * 0.5), rnd(0.25, 0.45));
    if (m.t >= 1) { meteors.splice(i, 1); impact(m); }
  }
  // debris pool
  for (let i = 0; i < DEB; i++) {
    const p = debris[i];
    if (p.life <= 0) continue;
    p.life -= dt;
    p.v.addScaledVector(_v.copy(p.p).normalize(), -dt * 1.6);
    p.p.addScaledVector(p.v, dt);
    p.rx += p.sx * dt; p.ry += p.sy * dt;
    if (p.life <= 0 || p.p.length() < surfaceH(_v.copy(p.p).normalize())) { p.life = 0; debrisI.mesh.setMatrixAt(i, ZERO); continue; }
    _q.setFromEuler(new THREE.Euler(p.rx, p.ry, 0));
    debrisI.mesh.setMatrixAt(i, _m.compose(p.p, _q, _s.setScalar(p.sc)));
  }
  debrisI.done();
  glow.update(dt); smoke.update(dt);
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.t += dt * 1.6;
    r.m.scale.setScalar(0.01 + r.t * r.size); r.m.material.opacity = 0.8 * (1 - r.t);
    if (r.t >= 1) { world.remove(r.m); r.m.material.dispose(); rings.splice(i, 1); }
  }
  // villages: lights on the night side
  for (const v of villages) {
    const night = smooth(0.05, -0.25, v.d.dot(sunLocal));
    const age = t - v.g.userData.born;
    v.g.scale.setScalar(Math.max(0.001, booted && age < 1 ? elastic(age / 0.8) : 1));
    if (!v.ruin) v.g.children.forEach((h) => { if (h.isSprite) h.visible = night > 0.02; else if (h.children[2]) h.children[2].visible = night > 0.1; });
  }
  if (t - lastHud > 0.5) { lastHud = t; updateCount(); }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
