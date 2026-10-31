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
function tangentOf(d) {
  const t = Math.abs(d.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0);
  return t.sub(d.clone().multiplyScalar(t.dot(d))).normalize();
}
function orientTo(obj, d, yaw = 0) {
  obj.quaternion.setFromUnitVectors(UP, d);
  if (yaw) obj.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
}

/* ---------- state ---------- */
const STORE = "planet.v1";
let S = { trees: [], mods: [], clouds: [], critters: [] };
let firstVisit = false;
try {
  const raw = localStorage.getItem(STORE);
  if (raw) S = Object.assign(S, JSON.parse(raw)); else firstVisit = true;
} catch (e) { firstVisit = true; }
let saveT = 0;
function save(now = false) {
  clearTimeout(saveT);
  const go = () => {
    S.clouds = clouds.map((c) => ({ d: c.d.toArray().map(r3), ax: c.ax.toArray().map(r3), sp: c.sp }));
    S.critters = critters.map((c) => ({ d: c.d.toArray().map(r3), h: c.h.toArray().map(r3), col: c.col }));
    S.trees = trees.map((t) => ({ d: t.d.toArray().map(r3), s: r3(t.s), y: r3(t.yaw), k: t.kind, f: t.fallen ? t.fa.toArray().map(r3) : 0 }));
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {}
  };
  if (now) go(); else saveT = setTimeout(go, 400);
}
const r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------- renderer / scene ---------- */
const canvas = $("#c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x04040a, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
const world = new THREE.Group();
scene.add(world);
world.rotation.set(0.35, -0.6, 0);

/* stars */
{
  const n = 1400, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const d = V(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(60, 90));
    pos.set([d.x, d.y, d.z], i * 3);
    const r = Math.random(), b = rnd(0.45, 1);
    const c = r < 0.1 ? [0.7 * b, 0.8 * b, b] : r < 0.22 ? [b, 0.9 * b, 0.75 * b] : [b, b, b];
    col.set(c, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  var stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
  scene.add(stars);
}

/* lights */
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
const DAY = 80; // seconds per full day
const orbitAxis = V(0.25, 1, 0.12).normalize();
const sunDir = V();

/* ---------- terrain ---------- */
const WATER = 1.0;
const waves = [];
{
  let s = 0x51a7;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 9; i++) {
    const v = V(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
    waves.push({ v, f: 1.6 + i * 0.9, a: 0.034 / (1 + i * 0.55), p: r() * 6.28 });
  }
}
function baseH(d) {
  let n = 0;
  for (const w of waves) n += Math.sin(d.dot(w.v) * w.f + w.p) * w.a;
  return 1.034 + n;
}
function modInfo(d) {
  let h = baseH(d), crater = 0, lake = 0;
  for (const m of S.mods) {
    const md = V(m.d[0], m.d[1], m.d[2]);
    const a = Math.acos(clamp(d.dot(md), -1, 1));
    if (m.t === "c") {
      const r = m.r, x = a / r;
      if (x < 1.6) {
        const before = h;
        h += -0.045 * Math.max(0, 1 - x * x) + 0.014 * Math.exp(-Math.pow((x - 1) * 4, 2));
        if (before > WATER + 0.004) h = Math.max(h, WATER + 0.006);
        crater = Math.max(crater, smooth(1.25, 0.6, x));
      }
    } else if (m.t === "w") {
      const k = smooth(m.r, m.r * 0.45, a);
      h = lerp(h, Math.min(h, WATER - 0.022), k);
      lake = Math.max(lake, k);
    }
  }
  return { h, crater, lake };
}
const surfaceH = (d) => modInfo(d).h;

const planetGeo = new THREE.IcosahedronGeometry(1, 7);
const unitPos = planetGeo.attributes.position.array.slice();
planetGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(unitPos.length), 3));
const C = {
  deep: new THREE.Color(0x3f8f9a), sand: new THREE.Color(0xe6cf94), grass: new THREE.Color(0x7cc46a),
  grass2: new THREE.Color(0x4f9a5a), rock: new THREE.Color(0x9a8f86), snow: new THREE.Color(0xf4f6ff), crater: new THREE.Color(0x7a5a46)
};
function buildPlanet() {
  const p = planetGeo.attributes.position.array, c = planetGeo.attributes.color.array;
  const d = V(), col = new THREE.Color();
  // per-face: use centroid height for color so facets read cleanly
  for (let i = 0; i < p.length; i += 3) {
    d.set(unitPos[i], unitPos[i + 1], unitPos[i + 2]).normalize();
    const { h } = modInfo(d);
    p[i] = d.x * h; p[i + 1] = d.y * h; p[i + 2] = d.z * h;
  }
  for (let f = 0; f < p.length; f += 9) {
    d.set(p[f] + p[f + 3] + p[f + 6], p[f + 1] + p[f + 4] + p[f + 7], p[f + 2] + p[f + 5] + p[f + 8]);
    const len = d.length() / 3; d.normalize();
    const info = modInfo(d);
    const h = len;
    if (h < WATER + 0.002) col.copy(C.deep).lerp(C.sand, 0.45);
    else if (h < WATER + 0.008) col.copy(C.sand);
    else if (h < 1.06) col.copy(C.grass).lerp(C.grass2, smooth(1.02, 1.06, h));
    else if (h < 1.078) col.copy(C.grass2).lerp(C.rock, smooth(1.06, 1.076, h));
    else col.copy(C.rock).lerp(C.snow, smooth(1.078, 1.088, h));
    if (info.crater > 0) col.lerp(C.crater, info.crater * 0.85);
    for (let k = 0; k < 3; k++) { c[f + k * 3] = col.r; c[f + k * 3 + 1] = col.g; c[f + k * 3 + 2] = col.b; }
  }
  planetGeo.attributes.position.needsUpdate = true;
  planetGeo.attributes.color.needsUpdate = true;
  planetGeo.computeVertexNormals();
  planetGeo.computeBoundingSphere();
}
buildPlanet();
const planet = new THREE.Mesh(planetGeo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 }));
world.add(planet);
const ocean = new THREE.Mesh(new THREE.IcosahedronGeometry(WATER, 5), new THREE.MeshStandardMaterial({ color: 0x3fa3d8, flatShading: true, roughness: 0.7, metalness: 0, transparent: true, opacity: 0.86 }));
world.add(ocean);
// atmosphere rim
const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.13, 48, 32), new THREE.ShaderMaterial({
  side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { c: { value: new THREE.Color(0x6fb6ff) } },
  vertexShader: "varying vec3 n; varying vec3 v; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); n = normalize(normalMatrix*normal); v = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }",
  fragmentShader: "uniform vec3 c; varying vec3 n; varying vec3 v; void main(){ float r = pow(clamp(1.0 + dot(n, v) * 1.0, 0.0, 1.0), 3.0); gl_FragColor = vec4(c * r * 0.7, r * 0.6); }"
}));
scene.add(atmo);

/* ---------- shared bits ---------- */
const trunkGeo = new THREE.CylinderGeometry(0.004, 0.006, 0.025, 5).translate(0, 0.0125, 0);
const pineGeo = [new THREE.ConeGeometry(0.022, 0.04, 6).translate(0, 0.038, 0), new THREE.ConeGeometry(0.016, 0.032, 6).translate(0, 0.058, 0)];
const roundGeo = new THREE.IcosahedronGeometry(0.022, 0).translate(0, 0.04, 0);
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a5a3c, flatShading: true, roughness: 1 });
const leafMats = [0x3f9d4f, 0x5ab55a, 0x2f8a55, 0x7cc25c, 0xe39a4a].map((c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.9 }));
const deadMat = new THREE.MeshStandardMaterial({ color: 0x8f7a52, flatShading: true, roughness: 1 });

/* ---------- trees ---------- */
const trees = [];
function makeTree(o) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(trunkGeo, trunkMat));
  const kind = o.k ?? (Math.random() < 0.6 ? 0 : 1);
  const mat = kind === 0 ? leafMats[(Math.random() * 3) | 0] : leafMats[3 + (Math.random() < 0.15 ? 1 : 0)];
  const leaves = kind === 0 ? pineGeo.map((gg) => new THREE.Mesh(gg, mat)) : [new THREE.Mesh(roundGeo, mat)];
  leaves.forEach((m) => g.add(m));
  const t = { g, d: V(...o.d).normalize(), s: o.s ?? 0, yaw: o.y ?? rnd(0, 6.28), kind, born: o.anim ? clock() : -9, fallen: !!o.f, fa: o.f ? V(...o.f) : V(), fallT: o.f ? 1 : 0, leaves, mat, gone: false };
  if (t.fallen) leaves.forEach((m) => (m.material = deadMat));
  world.add(g);
  placeTree(t);
  trees.push(t);
  return t;
}
function placeTree(t) {
  const h = surfaceH(t.d);
  t.g.position.copy(t.d).multiplyScalar(h - 0.002);
  orientTo(t.g, t.d, t.yaw);
  if (t.fallT > 0) {
    const local = t.fa.clone().applyQuaternion(t.g.quaternion.clone().invert());
    t.g.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(local.normalize(), t.fallT * 1.45));
  }
  const pop = t.born < 0 ? 1 : elastic((clock() - t.born) / 0.7);
  t.g.scale.setScalar(Math.max(0.001, pop * 2.1 * (0.55 + 0.6 * t.s)));
}
const standing = () => trees.reduce((n, t) => n + (t.fallen || t.gone ? 0 : 1), 0);

/* ---------- critters ---------- */
const critters = [];
const critterGeo = new THREE.IcosahedronGeometry(0.014, 1).scale(1, 0.85, 1.15).translate(0, 0.012, 0);
const eyeGeo = new THREE.SphereGeometry(0.0032, 6, 4);
const earGeo = new THREE.ConeGeometry(0.004, 0.009, 4);
const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
const CRITTER_COLORS = [0xffb4a2, 0xf6d186, 0xb5e48c, 0xa0c4ff, 0xcdb4db, 0xffffff, 0xf4a261];
function makeCritter(o) {
  const col = o.col ?? pick(CRITTER_COLORS);
  const g = new THREE.Group(), body = new THREE.Group();
  body.add(new THREE.Mesh(critterGeo, new THREE.MeshStandardMaterial({ color: col, flatShading: true, roughness: 0.8 })));
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat); e.position.set(s * 0.0055, 0.016, 0.014); body.add(e);
    const ear = new THREE.Mesh(earGeo, body.children[0].material); ear.position.set(s * 0.007, 0.026, 0.002); ear.rotation.z = -s * 0.35; body.add(ear);
  }
  g.add(body);
  world.add(g);
  const d = V(...o.d).normalize();
  let h = o.h ? V(...o.h) : tangentOf(d).applyAxisAngle(d, rnd(0, 6.28));
  h.sub(d.clone().multiplyScalar(h.dot(d))).normalize();
  const c = { g, body, d, h, col, born: o.anim ? clock() : -9, ph: rnd(0, 6.28), sp: rnd(0.05, 0.09), wait: 0, jump: 0 };
  critters.push(c);
  return c;
}
const fwd = V(), m4 = new THREE.Matrix4(), tmp = V();
function stepCritter(c, dt, t) {
  if (c.wait > 0) c.wait -= dt;
  else {
    c.h.applyAxisAngle(c.d, Math.sin(t * 0.7 + c.ph) * 1.3 * dt + rnd(-1, 1) * dt * 1.5);
    tmp.copy(c.d).addScaledVector(c.h, c.sp * dt * 0.9).normalize();
    if (surfaceH(tmp) < WATER + 0.006) { c.h.applyAxisAngle(c.d, Math.PI * rnd(0.6, 1.4)); c.wait = rnd(0.2, 0.6); }
    else c.d.copy(tmp);
    c.h.sub(tmp.copy(c.d).multiplyScalar(c.h.dot(c.d))).normalize();
    if (Math.random() < dt * 0.15) c.wait = rnd(0.6, 2.2);
  }
  const hop = c.wait > 0 ? 0 : Math.abs(Math.sin(t * 11 + c.ph)) * 0.006;
  c.jump = Math.max(0, c.jump - dt * 2.5);
  const jump = Math.sin(c.jump * Math.PI) * 0.06;
  c.g.position.copy(c.d).multiplyScalar(surfaceH(c.d) + hop + jump);
  fwd.crossVectors(c.h, c.d); // x axis
  m4.makeBasis(fwd, c.d, c.h);
  c.g.quaternion.setFromRotationMatrix(m4);
  const pop = c.born < 0 ? 1 : elastic((clock() - c.born) / 0.6);
  c.g.scale.setScalar(Math.max(0.001, pop * 1.9));
  c.body.rotation.z = c.wait > 0 ? 0 : Math.sin(t * 11 + c.ph) * 0.12;
}

/* ---------- clouds ---------- */
const clouds = [];
const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, transparent: true, opacity: 0.95 });
const rainMat = new THREE.LineBasicMaterial({ color: 0xa8d0ff, transparent: true, opacity: 0.7 });
const puffGeo = new THREE.IcosahedronGeometry(0.05, 0);
function makeCloud(o) {
  const g = new THREE.Group(), puffs = new THREE.Group();
  const n = 3 + ((Math.random() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(puffGeo, cloudMat.clone());
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
  const c = { g, puffs, rain, drops, d, ax, sp: o.sp ?? rnd(0.035, 0.07) * (Math.random() < 0.5 ? -1 : 1), raining: false, next: rnd(3, 8), born: o.anim ? clock() : -9, wob: rnd(0, 6) };
  clouds.push(c);
  return c;
}
const RAIN_TOP = 1.32;
function stepCloud(c, dt, t) {
  c.d.applyAxisAngle(c.ax, c.sp * dt).normalize();
  c.next -= dt;
  if (c.next <= 0) { c.raining = !c.raining; c.next = c.raining ? rnd(4, 8) : rnd(6, 14); if (c.raining) sfx.rain(); }
  const r = RAIN_TOP + Math.sin(t * 0.6 + c.wob) * 0.008;
  c.g.position.copy(c.d).multiplyScalar(r);
  orientTo(c.g, c.d, 0);
  // face along travel: rotate around up so x matches motion
  const pop = c.born < 0 ? 1 : elastic((clock() - c.born) / 0.8);
  c.g.scale.setScalar(Math.max(0.001, pop));
  const grey = c.raining ? 0.72 : 1;
  for (const m of c.puffs.children) m.material.color.setScalar(lerp(m.material.color.r, grey, dt * 2));
  c.rain.visible = c.raining;
  if (c.raining) {
    const ground = surfaceH(c.d) - r + 0.01;
    const p = c.rain.geometry.attributes.position.array;
    c.drops.forEach((dr, i) => {
      dr.y -= dt * 0.55;
      if (dr.y < ground) dr.y = rnd(-0.03, 0);
      p.set([dr.x, dr.y, dr.z, dr.x, dr.y - 0.018, dr.z], i * 6);
    });
    c.rain.geometry.attributes.position.needsUpdate = true;
    for (const tr of trees) if (!tr.fallen && tr.d.dot(c.d) > 0.975) tr.s = Math.min(1.6, tr.s + dt * 0.06);
  }
}

/* ---------- villages ---------- */
const villages = [];
const houseGeo = new THREE.BoxGeometry(0.014, 0.012, 0.014).translate(0, 0.006, 0);
const roofGeo = new THREE.ConeGeometry(0.012, 0.01, 4).rotateY(Math.PI / 4).translate(0, 0.017, 0);
const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2e6d0, flatShading: true, roughness: 1 });
const roofMats = [0xc8553d, 0x8d5a97, 0x3d7ea6].map((c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 1 }));
const winMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0 });
const winGeo = new THREE.PlaneGeometry(0.005, 0.005);
const lightMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xffc46b, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
const TREES_PER_VILLAGE = 8;
function syncVillages() {
  const live = trees.filter((t) => !t.fallen && !t.gone);
  const want = Math.min(6, Math.floor(live.length / TREES_PER_VILLAGE));
  while (villages.length > want) { const v = villages.pop(); world.remove(v.g); }
  while (villages.length < want) {
    const anchor = live[villages.length * TREES_PER_VILLAGE + 3] || live[0];
    let d = anchor.d.clone().addScaledVector(tangentOf(anchor.d).applyAxisAngle(anchor.d, villages.length * 2.1), 0.07).normalize();
    for (let k = 0; k < 8 && surfaceH(d) < WATER + 0.008; k++) d.lerp(anchor.d, 0.5).normalize();
    const g = new THREE.Group();
    const tan = tangentOf(d), bit = V().crossVectors(d, tan);
    const n = 3 + (villages.length % 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.28 + 0.4, rr = i === 0 ? 0 : 0.05;
      const hd = d.clone().addScaledVector(tan, Math.cos(a) * rr).addScaledVector(bit, Math.sin(a) * rr).normalize();
      const house = new THREE.Group();
      house.add(new THREE.Mesh(houseGeo, wallMat), new THREE.Mesh(roofGeo, roofMats[i % 3]));
      const w = new THREE.Mesh(winGeo, winMat); w.position.set(0, 0.006, 0.0071); house.add(w);
      house.position.copy(hd).multiplyScalar(surfaceH(hd) - 0.001);
      orientTo(house, hd, a); house.scale.setScalar(1.8);
      g.add(house);
      const glow = new THREE.Sprite(lightMat); glow.scale.setScalar(0.09);
      glow.position.copy(hd).multiplyScalar(surfaceH(hd) + 0.012); g.add(glow);
    }
    g.userData.d = d; g.userData.born = clock();
    world.add(g);
    villages.push({ g, d });
    if (villages.length === want && booted) toast(villages.length === 1 ? "A village appeared 🏡" : "Another village 🏡");
  }
}
function placeVillages() {
  for (const v of villages) v.g.children.forEach((h) => { if (h.isGroup || h.isSprite) { const d = h.position.clone().normalize(); h.position.copy(d).multiplyScalar(surfaceH(d) + (h.isSprite ? 0.012 : -0.001)); } });
}

/* ---------- meteors / fx ---------- */
const meteors = [], debris = [], rings = [];
const rockGeo = new THREE.DodecahedronGeometry(0.035, 0);
const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b5b53, flatShading: true, emissive: 0xff5a1f, emissiveIntensity: 0.6 });
const trailGeo = new THREE.IcosahedronGeometry(0.02, 0);
const debrisGeo = new THREE.TetrahedronGeometry(0.012, 0);
const debrisMat = new THREE.MeshStandardMaterial({ color: 0x7a5a46, flatShading: true });
const ringGeo = new THREE.RingGeometry(0.85, 1, 32);
function launchMeteor(d) {
  const side = tangentOf(d).applyAxisAngle(d, rnd(0, 6.28));
  const from = d.clone().multiplyScalar(3.4).addScaledVector(side, 1.6);
  const rock = new THREE.Mesh(rockGeo, rockMat);
  const trail = [];
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ color: i < 4 ? 0xffe08a : 0xff7a3d, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    world.add(m); trail.push(m);
  }
  rock.position.copy(from); world.add(rock);
  meteors.push({ d: d.clone(), from, rock, trail, hist: [], t: 0, dur: 0.95 });
  sfx.whoosh();
}
function impact(m) {
  world.remove(m.rock); m.trail.forEach((x) => { world.remove(x); x.material.dispose(); });
  const d = m.d;
  const wet = surfaceH(d) < WATER + 0.004;
  S.mods.push({ t: "c", d: d.toArray().map(r3), r: 0.13 });
  if (!wet) S.craters = (S.craters || 0) + 1;
  rebuild();
  for (const t of trees) {
    if (t.fallen) continue;
    const dot = t.d.dot(d);
    if (dot > Math.cos(0.32)) {
      t.fallen = true; t.fallT = 0.0001; t.fallStart = clock() + (1 - dot) * 6;
      t.fa = V().crossVectors(d, t.d).normalize();
      if (t.fa.lengthSq() < 0.5) t.fa = tangentOf(t.d);
      t.leaves.forEach((x) => (x.material = deadMat));
    }
  }
  for (const c of critters) if (c.d.dot(d) > Math.cos(0.45)) { c.jump = 1; c.h.copy(c.d).sub(d).normalize(); if (!isFinite(c.h.x)) c.h = tangentOf(c.d); }
  const top = d.clone().multiplyScalar(surfaceH(d) + 0.01);
  for (let i = 0; i < 18; i++) {
    const mm = new THREE.Mesh(debrisGeo, wet ? new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true }) : debrisMat);
    mm.position.copy(top);
    const v = d.clone().multiplyScalar(rnd(0.35, 0.7)).addScaledVector(tangentOf(d).applyAxisAngle(d, rnd(0, 6.28)), rnd(0.15, 0.45));
    world.add(mm); debris.push({ m: mm, v, life: 1.3, spin: V(rnd(-9, 9), rnd(-9, 9), 0) });
  }
  addRing(d, wet ? 0xbfe6ff : 0xffb070, 0.32);
  shake = 0.5; sfx.boom();
  updateCount(); save();
}
function addRing(d, color, size) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  m.position.copy(d).multiplyScalar(surfaceH(d) + 0.006);
  m.quaternion.setFromUnitVectors(V(0, 0, 1), d);
  world.add(m); rings.push({ m, t: 0, size });
}
function rebuild() {
  buildPlanet();
  for (const t of trees) {
    if (!t.gone && !t.fallen && surfaceH(t.d) < WATER + 0.004) { t.gone = true; t.goneT = clock(); }
    placeTree(t);
  }
  placeVillages();
}

/* ---------- tools ---------- */
let tool = "tree";
function act(d) {
  const h = surfaceH(d);
  if (tool === "tree") {
    if (h < WATER + 0.006) { toast("Trees don't swim 🌊"); sfx.bloop(); return; }
    if (trees.length > 450) { toast("The planet is full of trees 🌳"); return; }
    for (let i = 0; i < 2; i++) {
      const dd = i === 0 ? d : d.clone().addScaledVector(tangentOf(d).applyAxisAngle(d, rnd(0, 6.28)), rnd(0.02, 0.04)).normalize();
      if (i === 1 && (Math.random() < 0.55 || surfaceH(dd) < WATER + 0.006)) continue;
      makeTree({ d: dd.toArray(), s: rnd(0, 0.2), anim: true });
    }
    sfx.pop(); syncVillages();
  } else if (tool === "meteor") {
    if (meteors.length > 6) return;
    launchMeteor(d);
  } else if (tool === "water") {
    S.mods.push({ t: "w", d: d.toArray().map(r3), r: 0.17 });
    rebuild(); addRing(d, 0x9fdcff, 0.25); sfx.bloop(); syncVillages();
  } else if (tool === "cloud") {
    if (clouds.length >= 10) { const c = clouds.shift(); world.remove(c.g); }
    makeCloud({ d: d.toArray(), anim: true }); sfx.puff();
  } else if (tool === "critter") {
    if (h < WATER + 0.006) { toast("Critters can't swim 🫧"); sfx.bloop(); return; }
    if (critters.length >= 40) { toast("That's enough critters for now 🐾"); return; }
    makeCritter({ d: d.toArray(), anim: true }); sfx.squeak();
  }
  updateCount(); save();
}
document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => {
  tool = b.dataset.tool;
  document.querySelectorAll("[data-tool]").forEach((x) => x.classList.toggle("on", x === b));
  const tips = { tree: "Tap to plant a tree", meteor: "Tap to call a meteor", water: "Tap to make a lake", cloud: "Tap to add a rain cloud", critter: "Tap to drop a critter" };
  toast(tips[tool]); sfx.tick();
}));

/* ---------- HUD ---------- */
const countEl = $("[data-count]");
function updateCount() {
  countEl.textContent = `🌲 ${standing()} · 🕳️ ${S.craters || 0} · 🐾 ${critters.length}`;
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
  trees.forEach((t) => world.remove(t.g)); trees.length = 0;
  critters.forEach((c) => world.remove(c.g)); critters.length = 0;
  clouds.forEach((c) => world.remove(c.g)); clouds.length = 0;
  villages.forEach((v) => world.remove(v.g)); villages.length = 0;
  S = { trees: [], mods: [], clouds: [], critters: [], craters: 0 };
  rebuild(); seedFresh(); updateCount(); save(true); toast("A fresh little world ✨"); sfx.pop();
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
  boom: () => { noise(0.9, 500, 0.12, 0.7, 60); tone(110, 40, 0.5, "sine", 0.12); },
  rain: () => noise(1.2, 3000, 0.012, 0.4, 2000)
};

/* ---------- input: drag/inertia, pinch/scroll zoom, tap ---------- */
const pointers = new Map();
let vel = { x: 0, y: 0 }, last = 0, zoom = 1, zoomTarget = 1, pinch0 = 0, zoom0 = 1, down = null, idle = 0, shake = 0;
const qx = new THREE.Quaternion(), qy = new THREE.Quaternion();
function spin(dx, dy) {
  qy.setFromAxisAngle(V(0, 1, 0), dx); qx.setFromAxisAngle(V(1, 0, 0), dy);
  world.quaternion.premultiply(qy).premultiply(qx);
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
    const k = 3.2 / Math.min(innerWidth, innerHeight) * zoom;
    spin(dx * k, dy * k);
    const now = performance.now(), dt = Math.max(1, now - last) / 1000; last = now;
    vel.x = lerp(vel.x, (dx * k) / dt, 0.5); vel.y = lerp(vel.y, (dy * k) / dt, 0.5);
    if (down) down.moved += Math.abs(dx) + Math.abs(dy);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch0 > 0) zoomTarget = clamp(zoom0 * (pinch0 / dist), 0.55, 1.7);
  }
});
function up(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0 && down) {
    if (performance.now() - last > 80) vel.x = vel.y = 0;
    if (down.moved < 10 && performance.now() - down.t < 450) { vel.x = vel.y = 0; tap(e.clientX, e.clientY); }
    down = null;
  }
  if (pointers.size === 1) { const p = [...pointers.values()][0]; down = null; last = performance.now(); vel.x = vel.y = 0; }
}
canvas.addEventListener("pointerup", up);
canvas.addEventListener("pointercancel", up);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomTarget = clamp(zoomTarget * Math.exp(e.deltaY * 0.0015), 0.55, 1.7); idle = 0; }, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault());
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function tap(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(planet, false)[0];
  if (!hit) return;
  const d = world.worldToLocal(hit.point.clone()).normalize();
  act(d);
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
}
addEventListener("resize", resize); resize();

/* ---------- boot ---------- */
const t0 = performance.now();
function clock() { return (performance.now() - t0) / 1000; }
let booted = false;
function seedFresh() {
  const spots = [];
  for (let i = 0; spots.length < 6 && i < 400; i++) {
    const d = V(rnd(-0.5, 0.5), rnd(0.2, 1), rnd(0.3, 1)).normalize();
    if (surfaceH(d) > WATER + 0.01) spots.push(d);
  }
  spots.forEach((d, i) => (i < 5 ? makeTree({ d: d.toArray(), s: rnd(0.2, 0.8), anim: true }) : makeCritter({ d: d.toArray(), anim: true })));
  syncVillages();
}
(S.trees || []).forEach((t) => makeTree(t));
(S.critters || []).forEach((c) => makeCritter(c));
(S.clouds || []).forEach((c) => makeCloud(c));
if (firstVisit) { seedFresh(); save(); }
syncVillages();
updateCount();
booted = true;
setTimeout(() => toast("Drag to spin · tap to plant"), 600);
addEventListener("pagehide", () => save(true));
document.addEventListener("visibilitychange", () => { if (document.hidden) save(true); });
setInterval(() => save(), 8000);

/* ---------- loop ---------- */
let prev = performance.now();
const camPos = V();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
  const t = clock();
  // inertia + idle drift
  if (pointers.size === 0) {
    idle += dt;
    spin(vel.x * dt, vel.y * dt);
    const damp = Math.exp(-dt * 2.6); vel.x *= damp; vel.y *= damp;
    if (idle > 4) spin(dt * 0.05 * Math.min(1, (idle - 4) / 3), 0);
  }
  zoom = lerp(zoom, zoomTarget, 1 - Math.exp(-dt * 10));
  shake = Math.max(0, shake - dt * 1.6);
  camPos.set(rnd(-1, 1) * shake * 0.04, rnd(-1, 1) * shake * 0.04, fitDist * zoom);
  camera.position.copy(camPos);
  camera.lookAt(0, 0, 0);
  // sun and moon
  const ang = (t / DAY) * Math.PI * 2 + 0.8;
  sunDir.set(Math.cos(ang), 0, Math.sin(ang)).applyAxisAngle(V(0, 0, 1), 0.35).normalize();
  sun.position.copy(sunDir).multiplyScalar(7.5);
  moon.position.copy(sunDir).multiplyScalar(-5.5).applyAxisAngle(V(0, 1, 0), 0.25);
  sunLight.position.copy(sunDir).multiplyScalar(10);
  moonLight.position.copy(moon.position);
  const sunFacing = sunDir.z; // >0 when sun is on camera's side
  hemi.intensity = lerp(0.28, 0.5, smooth(-0.6, 0.6, sunFacing));
  stars.rotation.y = -ang * 0.15;
  ocean.rotation.y = t * 0.02;
  // trees
  for (let i = trees.length - 1; i >= 0; i--) {
    const tr = trees[i];
    if (!tr.fallen && !tr.gone) tr.s = Math.min(1.6, tr.s + dt * 0.006);
    if (tr.fallen && tr.fallT < 1 && t > (tr.fallStart || 0)) tr.fallT = Math.min(1, tr.fallT + dt * 2.8);
    if (tr.gone) {
      const k = 1 - (t - tr.goneT) / 0.6;
      if (k <= 0) { world.remove(tr.g); trees.splice(i, 1); updateCount(); continue; }
      tr.g.scale.setScalar(Math.max(0.001, k * 2.1 * (0.55 + 0.6 * tr.s)));
      continue;
    }
    if (!tr.fallen || tr.fallT < 1 || tr.born > 0 && t - tr.born < 1 || t % 1 < dt) placeTree(tr);
  }
  for (const c of critters) stepCritter(c, dt, t);
  for (const c of clouds) stepCloud(c, dt, t);
  // meteors
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    m.t += dt / m.dur;
    const k = Math.min(1, m.t), e = k * k;
    const target = m.d.clone().multiplyScalar(surfaceH(m.d));
    m.rock.position.lerpVectors(m.from, target, e);
    m.rock.rotation.x += dt * 9; m.rock.rotation.y += dt * 7;
    m.hist.unshift(m.rock.position.clone()); if (m.hist.length > 28) m.hist.pop();
    m.trail.forEach((s, j) => {
      const p = m.hist[Math.min(m.hist.length - 1, j * 2)];
      s.position.copy(p); s.scale.setScalar(1.3 - j / 14);
      s.material.opacity = (1 - j / 14) * 0.75;
    });
    if (m.t >= 1) { meteors.splice(i, 1); impact(m); }
  }
  for (let i = debris.length - 1; i >= 0; i--) {
    const p = debris[i];
    p.life -= dt;
    p.v.addScaledVector(p.m.position.clone().normalize(), -dt * 1.6);
    p.m.position.addScaledVector(p.v, dt);
    p.m.rotation.x += p.spin.x * dt; p.m.rotation.y += p.spin.y * dt;
    const dd = p.m.position.clone().normalize();
    if (p.life <= 0 || p.m.position.length() < surfaceH(dd)) { world.remove(p.m); if (p.m.material !== debrisMat) p.m.material.dispose(); debris.splice(i, 1); }
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.t += dt * 1.6;
    r.m.scale.setScalar(0.01 + r.t * r.size); r.m.material.opacity = 0.8 * (1 - r.t);
    if (r.t >= 1) { world.remove(r.m); r.m.material.dispose(); rings.splice(i, 1); }
  }
  // village lights: on when the village is on the night side
  const wq = world.quaternion;
  for (const v of villages) {
    const wd = v.d.clone().applyQuaternion(wq);
    const night = smooth(0.05, -0.25, wd.dot(sunDir));
    const age = t - v.g.userData.born;
    const pop = booted && age < 1 ? elastic(age / 0.8) : 1;
    v.g.scale.setScalar(Math.max(0.001, pop));
    v.night = night;
  }
  // shared window/glow materials: use the average of visible villages (they are small and close to each other's terminator rarely)
  if (villages.length) {
    let n = 0; for (const v of villages) n = Math.max(n, v.night);
    winMat.opacity = 1; lightMat.opacity = 0.9;
    for (const v of villages) v.g.children.forEach((h) => { if (h.isSprite) h.visible = v.night > 0.02; else h.children[2].visible = v.night > 0.1; });
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
