import * as THREE from "/vendor/three.module.min.js";
import { BODIES, BY_ID, AU, D2R, bodyAxes, primeW } from "./bodies.js?v=5";
import { LOGV, LOGF } from "./system.js?v=5";

/* ============================================================
   Standing on a world: the real sky over the landing spot (Sun,
   planets, Earth from the Moon, Saturn's rings from Saturn) at the
   current time, over a procedural landscape. Gas giants have no
   ground – you float above the clouds.
   The scene keeps world (ecliptic) orientation; only the landscape
   and the camera are turned into the local horizon frame.
   ============================================================ */

const SKY = {
  // zenith, horizon, sunset, glow around the Sun, night, haze (0 airless … 2 opaque), disc visible, grad (how fast the horizon colour gives way)
  earth:   { zen: [0.14, 0.36, 0.8], hor: [0.62, 0.78, 0.95], set: [1.0, 0.48, 0.2], glow: [1.0, 0.95, 0.85], night: [0.006, 0.012, 0.03], haze: 1, disc: 1 },
  mars:    { zen: [0.5, 0.36, 0.25], hor: [0.85, 0.66, 0.46], set: [0.34, 0.5, 0.78], glow: [0.62, 0.74, 0.95], night: [0.012, 0.008, 0.006], haze: 1, disc: 1 },
  venus:   { zen: [0.6, 0.4, 0.15], hor: [0.92, 0.7, 0.34], set: [0.75, 0.36, 0.12], glow: [1.0, 0.86, 0.5], night: [0.09, 0.035, 0.01], haze: 2, disc: 0 },
  none:    { zen: [0, 0, 0], hor: [0, 0, 0], set: [0, 0, 0], glow: [0, 0, 0], night: [0, 0, 0], haze: 0, disc: 1 },
  pluto:   { zen: [0, 0, 0], hor: [0.05, 0.09, 0.16], set: [0.05, 0.09, 0.16], glow: [0, 0, 0], night: [0, 0, 0], haze: 0.2, disc: 1 },
  jupiter: { grad: 0.26, zen: [0.1, 0.26, 0.66], hor: [0.8, 0.6, 0.36], set: [0.9, 0.55, 0.3], glow: [1.0, 0.92, 0.78], night: [0.01, 0.008, 0.007], haze: 1, disc: 1 },
  saturn:  { grad: 0.28, zen: [0.14, 0.26, 0.56], hor: [0.84, 0.66, 0.36], set: [0.92, 0.6, 0.32], glow: [1.0, 0.92, 0.76], night: [0.01, 0.009, 0.007], haze: 1, disc: 1 },
  uranus:  { zen: [0.06, 0.3, 0.42], hor: [0.34, 0.68, 0.74], set: [0.45, 0.7, 0.75], glow: [0.9, 1.0, 1.0], night: [0.004, 0.01, 0.012], haze: 1, disc: 1 },
  neptune: { zen: [0.02, 0.05, 0.36], hor: [0.1, 0.22, 0.78], set: [0.25, 0.35, 0.8], glow: [0.8, 0.9, 1.0], night: [0.003, 0.005, 0.015], haze: 1, disc: 1 }
};
const LANDS = {
  earth:   { sky: "earth", lo: [0.16, 0.3, 0.09], hi: [0.4, 0.52, 0.2], hill: 18, far: 140, crater: 0, rocks: 0, trees: 260 },
  mars:    { sky: "mars", lo: [0.42, 0.2, 0.1], hi: [0.74, 0.46, 0.27], hill: 5, far: 150, crater: 0.25, rocks: 420, rock: [0.32, 0.17, 0.1] },
  moon:    { sky: "none", lo: [0.3, 0.295, 0.29], hi: [0.58, 0.57, 0.55], hill: 1.6, far: 30, crater: 1, rocks: 260, rock: [0.36, 0.35, 0.34] },
  mercury: { sky: "none", lo: [0.27, 0.25, 0.23], hi: [0.52, 0.48, 0.44], hill: 3, far: 110, crater: 1, rocks: 200, rock: [0.3, 0.28, 0.26] },
  venus:   { sky: "venus", lo: [0.36, 0.22, 0.1], hi: [0.6, 0.42, 0.2], hill: 1.5, far: 90, crater: 0, rocks: 360, rock: [0.3, 0.2, 0.1], slabs: true },
  pluto:   { sky: "pluto", lo: [0.52, 0.4, 0.3], hi: [0.92, 0.8, 0.66], hill: 0.6, far: 420, crater: 0, rocks: 70, rock: [0.8, 0.74, 0.68], cells: true },
  jupiter: { sky: "jupiter", gas: [[0.82, 0.68, 0.5], [0.95, 0.9, 0.82], [0.62, 0.42, 0.3]] },
  saturn:  { sky: "saturn", gas: [[0.88, 0.78, 0.56], [0.97, 0.92, 0.78], [0.76, 0.64, 0.42]] },
  uranus:  { sky: "uranus", gas: [[0.58, 0.84, 0.88], [0.8, 0.95, 0.96], [0.45, 0.72, 0.8]] },
  neptune: { sky: "neptune", gas: [[0.22, 0.36, 0.82], [0.62, 0.74, 0.98], [0.14, 0.24, 0.62]] }
};

// seeded value noise
function noise2(seed) {
  const P = new Uint8Array(512);
  let s = seed;
  for (let i = 0; i < 256; i++) P[i] = i;
  for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [P[i], P[j]] = [P[j], P[i]]; }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i];
  const g = (i, j) => P[P[i & 255] + (j & 255)] / 255;
  const f = (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, a = u * u * (3 - 2 * u), b = v * v * (3 - 2 * v);
    return (g(i, j) * (1 - a) + g(i + 1, j) * a) * (1 - b) + (g(i, j + 1) * (1 - a) + g(i + 1, j + 1) * a) * b;
  };
  return (x, y, oct = 4) => { let t = 0, amp = 0.5, fr = 1; for (let o = 0; o < oct; o++) { t += amp * f(x * fr, y * fr); amp *= 0.5; fr *= 2.03; } return t; };
}

const skyVS = LOGV + `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
  }`;
const skyFS = LOGF + `
  uniform vec3 zen, hor, setc, glow, night, sun, up; uniform float haze, grad, disc, sunR, bright;
  varying vec3 vD;
  void main() {
    vec3 d = normalize(vD);
    float h = dot(d, up), sh = dot(sun, up), mu = dot(d, sun);
    float day = smoothstep(-0.2, 0.1, sh);
    float hh = max(h, 0.0);
    vec3 c = mix(hor, zen, pow(hh, grad));
    float low = (1.0 - smoothstep(0.0, 0.32, sh)) * smoothstep(-0.22, 0.02, sh);
    c = mix(c, setc, low * pow(1.0 - hh, 2.5) * (0.35 + 0.65 * pow(max(mu, 0.0), 2.0)));
    c *= day * bright;
    c += glow * bright * (pow(max(mu, 0.0), 6.0) * 0.16 + pow(max(mu, 0.0), 80.0) * 0.4) * smoothstep(-0.25, 0.05, sh) * min(haze, 1.0);
    c = mix(night, c, max(day, 0.0)) + night * 0.0;
    float a = clamp(max(max(c.r, c.g), c.b) * 2.2, 0.0, 1.0);
    // the Sun's disc and its tight glare
    float ang = acos(clamp(mu, -1.0, 1.0));
    float discK = disc * (1.0 - smoothstep(sunR * 0.85, sunR * 1.05, ang));
    float glare = disc * (exp(-ang / (sunR * 1.6)) * 0.55 + exp(-ang / (sunR * 7.0)) * 0.18);
    vec3 col = c + vec3(1.0, 0.97, 0.9) * (discK * 2.0 + glare);
    a = max(a, clamp(discK + glare, 0.0, 1.0));
    gl_FragColor = vec4(pow(min(col, vec3(1.0)), vec3(1.0 / 2.2)), a);
    #include <logdepthbuf_fragment>
  }`;

const gasVS = LOGV + `varying vec2 vP; varying float vDist; uniform float t;
  void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vP = position.xz; vDist = length(wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;
const gasFS = LOGF + `
  uniform vec3 c0, c1, c2, fogc, sunc; uniform float t, light, layer;
  varying vec2 vP; varying float vDist;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
  float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n(p); p = p * 2.02 + vec2(7.1, 3.3); a *= 0.5; } return s; }
  void main() {
    vec2 p = vP * 0.0045 + vec2(t * 0.01 * (1.0 + layer), 0.0);
    vec2 q = vec2(fbm(p + vec2(0.0, t * 0.002)), fbm(p * 1.3 + 4.0));
    float f = fbm(p * 1.7 + q * 1.6);
    float bands = 0.5 + 0.5 * sin(vP.y * 0.006 + q.x * 3.0);
    vec3 col = pow(mix(c2, mix(c0, c1, smoothstep(0.35, 0.75, f)), 0.35 + 0.65 * bands), vec3(2.2));
    col *= 0.45 + 0.8 * smoothstep(0.25, 0.8, f);    // puffy tops catch the light
    col = col * light + sunc * pow(f, 3.0) * 0.25 * light;
    float fog = 1.0 - exp(-vDist * 0.00016);
    col = mix(col, fogc, fog);
    float a = layer > 0.5 ? smoothstep(0.48, 0.7, f) * 0.85 * (1.0 - fog * 0.6) : 1.0;
    gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), a);
    #include <logdepthbuf_fragment>
  }`;

function detailTexture() {
  // tileable value noise (lattice wraps every P cells), a few octaves
  const N = 256, c = document.createElement("canvas"); c.width = c.height = N;
  const g = c.getContext("2d"), img = g.createImageData(N, N);
  let s = 99;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const val = new Float32Array(N * N);
  for (const [P, amp] of [[8, 0.42], [16, 0.26], [32, 0.16], [64, 0.1], [128, 0.06]]) {
    const L = Array.from({ length: P * P }, rnd), cell = N / P;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = x / cell, fy = y / cell, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      const a = u * u * (3 - 2 * u), b = v * v * (3 - 2 * v), q = (ii, jj) => L[(jj % P) * P + (ii % P)];
      val[y * N + x] += amp * ((q(i, j) * (1 - a) + q(i + 1, j) * a) * (1 - b) + (q(i, j + 1) * (1 - a) + q(i + 1, j + 1) * a) * b);
    }
  }
  for (let k = 0; k < N * N; k++) { const v = Math.round(214 + (val[k] - 0.5) * 150); img.data.set([v, v, v, 255], k * 4); }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;     // a brightness multiplier around 0.84, not a colour
  t.anisotropy = 8;
  return t;
}

export class Ground {
  constructor(renderer, sys, sky) {
    this.renderer = renderer; this.sys = sys; this.sky = sky;
    this.active = false; this.fov = 62;
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.05, 20000);
    this.scene = new THREE.Scene();
    this.yaw = 0; this.pitch = 0.1; this.vy = 0; this.vp = 0;
    this.skyU = { zen: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, setc: { value: new THREE.Color() }, glow: { value: new THREE.Color() },
      night: { value: new THREE.Color() }, sun: { value: new THREE.Vector3() }, up: { value: new THREE.Vector3() }, haze: { value: 1 }, grad: { value: 0.45 }, disc: { value: 1 }, sunR: { value: 0.005 }, bright: { value: 1 } };
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(9000, 64, 32), new THREE.ShaderMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, uniforms: this.skyU, vertexShader: skyVS, fragmentShader: skyFS }));
    this.dome.renderOrder = -10;
    this.scene.add(this.dome);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this.hemi = new THREE.HemisphereLight(0x8899aa, 0x332211, 0.6);
    this.scene.add(this.sunLight, this.sunLight.target, this.hemi);
    this.scene.fog = new THREE.FogExp2(0x000000, 0.0004);
    this.land = new THREE.Group();          // local horizon frame: x east, y up, z south
    this.sky3 = new THREE.Group();          // things in the sky (world orientation)
    this.scene.add(this.land, this.sky3);
    this.detail = detailTexture();
    this.frame = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    this.M = new THREE.Matrix4();
    this.Q = new THREE.Quaternion();
    // planets as dots in the sky
    const n = BODIES.length;
    this.dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
    this.dots.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.dots.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.dots.frustumCulled = false;
    this.dots.renderOrder = -5;
    this.sky3.add(this.dots);
    this.labels = document.createElement("div");
    this.labels.className = "glabels";
    document.querySelector(".labels").appendChild(this.labels);
    this.lbl = {};
  }

  resize(W, H) { this.W = W; this.H = H; this.camera.aspect = W / H; this.camera.updateProjectionMatrix(); }
  look(dx, dy) {
    const k = (this.fov / 62) * 0.0042;
    this.yaw += dx * k; this.pitch = Math.max(-0.6, Math.min(1.5, this.pitch + dy * k));
    this.vy = dx * k; this.vp = dy * k;
    this.panToSun = false;
  }
  setFov(f) { this.fov = Math.max(12, Math.min(80, f)); }

  enter(id, spot, d) {
    this.clear();
    this.active = true; this.id = id; this.spot = spot;
    this.b = BY_ID[id];
    this.cfg = LANDS[id];
    this.sk = SKY[this.cfg.sky];
    const s = this.sk;
    this.skyU.zen.value.setRGB(...s.zen); this.skyU.hor.value.setRGB(...s.hor); this.skyU.setc.value.setRGB(...s.set);
    this.skyU.glow.value.setRGB(...s.glow); this.skyU.night.value.setRGB(...s.night); this.skyU.haze.value = s.haze; this.skyU.grad.value = s.grad || (s.haze > 1.5 ? 0.9 : 0.45); this.skyU.disc.value = s.disc;
    this.fov = (this.H > this.W ? 70 : 60) * (id === "moon" ? 0.7 : 1);
    if (this.cfg.gas) this.buildClouds(); else this.buildLand();
    this.buildSkyBodies();
    this.update(d, 0);
    this.aim();
    for (const b of BODIES) {
      if (b.id === id) continue;
      const el = document.createElement("span");
      el.className = "glbl";
      this.labels.appendChild(el);
      this.lbl[b.id] = el;
    }
  }
  leave() { this.active = false; this.clear(); }
  clear() {
    for (const g of [this.land, this.sky3]) {
      for (const c of [...g.children]) {
        if (c === this.dots) continue;
        g.remove(c);
        c.traverse((o) => { if (o.geometry && !o.userData.shared) o.geometry.dispose(); if (o.material && !o.userData.shared) o.material.dispose(); });
      }
    }
    this.big = [];
    if (this.labels) this.labels.innerHTML = "";
    this.lbl = {};
  }

  // ---------- landscapes ----------
  buildLand() {
    const c = this.cfg, nz = noise2(this.id.length * 131 + 7);
    // polar grid: dense near your feet, coarse at the horizon
    const rings = 120, segs = 160, r0 = 0.6, r1 = 7000;
    const pos = [], col = [], uv = [], idx = [];
    const lo = new THREE.Color(...c.lo), hi = new THREE.Color(...c.hi), tmp = new THREE.Color();
    const craters = [];
    let s = 4242;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 90 * c.crater; k++) {
      const r = 8 + Math.pow(rnd(), 2.2) * 900 * (rnd() < 0.08 ? 3 : 1), ang = rnd() * Math.PI * 2, dist = 160 + r * 1.2 + rnd() * 3200;
      craters.push([Math.cos(ang) * dist, Math.sin(ang) * dist, r]);
    }
    const height = (x, z) => {
      const r = Math.hypot(x, z);
      let h = (nz(x * 0.004, z * 0.004, 5) - 0.5) * c.hill * 2 + (nz(x * 0.03, z * 0.03, 3) - 0.5) * c.hill * 0.25;
      h += Math.pow(nz(x * 0.0009 + 3, z * 0.0009 + 5, 4), 2) * c.far * 2.2 * Math.min(1, Math.max(0, (r - 600) / 2600));
      for (const [cx, cz, cr] of craters) {
        const dd = Math.hypot(x - cx, z - cz) / cr;
        if (dd < 1.6) h += cr * 0.055 * (dd < 1 ? (dd * dd - 1) * 0.9 : Math.pow(Math.cos(((dd - 1) / 0.6) * Math.PI * 0.5), 2) * 0.35);
      }
      if (c.cells) h -= (1 - smoothEdge(cellEdge(x, z, 260))) * 2.2;
      // keep a calm spot where you stand
      return h * Math.min(1, 0.15 + r / 40);
    };
    for (let i = 0; i <= rings; i++) {
      const r = i === 0 ? 0 : r0 * Math.pow(r1 / r0, (i - 1) / (rings - 1));
      for (let j = 0; j < segs; j++) {
        const a = (j / segs) * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
        const y = height(x, z);
        pos.push(x, y, z);
        let v = nz(x * 0.02 + 50, z * 0.02, 4);
        if (c.cells) v = 0.35 + 0.6 * smoothEdge(cellEdge(x, z, 260)) + (nz(x * 0.02, z * 0.02, 3) - 0.5) * 0.3;
        tmp.copy(lo).lerp(hi, Math.min(1, Math.max(0, v * 1.3 - 0.15 + y / (c.hill * 8 + c.far * 2) * 0.4)));
        col.push(tmp.r, tmp.g, tmp.b);
        uv.push(x / 3, z / 3);
        if (i > 0) {
          const a0 = (i - 1) * segs + j, a1 = (i - 1) * segs + ((j + 1) % segs), b0 = i * segs + j, b1 = i * segs + ((j + 1) % segs);
          idx.push(a0, a1, b0, a1, b1, b0);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, map: this.detail }));
    this.land.add(ground);
    this.height = height;
    // rocks / trees
    if (c.rocks) {
      const geo = new THREE.IcosahedronGeometry(1, 1), p = geo.attributes.position, nz2 = noise2(5);
      for (let k = 0; k < p.count; k++) { const f = 0.75 + nz2(p.getX(k) * 2 + 9, p.getY(k) * 2 + p.getZ(k) * 2, 2) * 0.6; p.setXYZ(k, p.getX(k) * f, p.getY(k) * f * (c.slabs ? 0.3 : 0.7), p.getZ(k) * f); }
      geo.computeVertexNormals();
      const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: new THREE.Color(...c.rock), flatShading: true }), c.rocks);
      const o = new THREE.Object3D(), ccol = new THREE.Color();
      for (let k = 0; k < c.rocks; k++) {
        const dist = 3 + Math.pow(rnd(), 1.7) * 260, a = rnd() * Math.PI * 2, x = Math.cos(a) * dist, z = Math.sin(a) * dist;
        const sc = (0.08 + Math.pow(rnd(), 3) * (c.slabs ? 1.4 : 1.1)) * (dist < 8 ? 0.6 : 1);
        o.position.set(x, height(x, z) + sc * 0.15, z);
        o.rotation.set(rnd() * 0.4, rnd() * 6.3, rnd() * 0.4);
        o.scale.set(sc * (0.8 + rnd() * 0.6), sc, sc * (0.8 + rnd() * 0.6));
        o.updateMatrix();
        m.setMatrixAt(k, o.matrix);
        m.setColorAt(k, ccol.setRGB(...c.rock).multiplyScalar(0.8 + rnd() * 0.45));
      }
      this.land.add(m);
    }
    if (c.trees) {
      const cone = new THREE.ConeGeometry(1, 2.6, 7).translate(0, 2.2, 0), trunk = new THREE.CylinderGeometry(0.12, 0.16, 1, 5).translate(0, 0.5, 0);
      const crowns = new THREE.InstancedMesh(cone, new THREE.MeshLambertMaterial({ color: 0x3f7a34, flatShading: true }), c.trees);
      const stems = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: 0x4a3524 }), c.trees);
      const o = new THREE.Object3D(), ccol = new THREE.Color();
      for (let k = 0; k < c.trees; k++) {
        // trees in loose groves
        const grove = Math.floor(rnd() * 9), ga = grove * 0.7 + 0.4, gd = 60 + grove * 70;
        const a = ga + (rnd() - 0.5) * 0.5, dist = gd + (rnd() - 0.5) * 70;
        const x = Math.cos(a) * dist, z = Math.sin(a) * dist, sc = 2.2 + rnd() * 2.6;
        o.position.set(x, height(x, z) - 0.2, z); o.rotation.set(0, rnd() * 6, 0); o.scale.set(sc, sc * (0.9 + rnd() * 0.5), sc); o.updateMatrix();
        crowns.setMatrixAt(k, o.matrix); stems.setMatrixAt(k, o.matrix);
        crowns.setColorAt(k, ccol.setRGB(0.6 + rnd() * 0.5, 0.75 + rnd() * 0.5, 0.55 + rnd() * 0.4));
      }
      this.land.add(crowns, stems);
    }
  }

  buildClouds() {
    const c = this.cfg.gas;
    this.gasU = [];
    for (const layer of [0, 1]) {
      const u = { c0: { value: new THREE.Color(...c[0]) }, c1: { value: new THREE.Color(...c[1]) }, c2: { value: new THREE.Color(...c[2]) },
        fogc: { value: new THREE.Color() }, sunc: { value: new THREE.Color(1, 0.95, 0.85) }, t: { value: 0 }, light: { value: 1 }, layer: { value: layer } };
      const m = new THREE.Mesh(new THREE.CircleGeometry(9000, 96).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ uniforms: u, vertexShader: gasVS, fragmentShader: gasFS, transparent: layer > 0, depthWrite: layer === 0 }));
      m.position.y = layer ? -14 : -70;
      m.renderOrder = layer ? 2 : 1;
      this.land.add(m);
      this.gasU.push(u);
    }
    this.height = () => 0;
  }

  // ---------- sky bodies ----------
  buildSkyBodies() {
    this.big = [];
    const S = 4000;
    // big, real spheres when they'd be more than a dot: Earth from the Moon, the Moon from Earth, Jupiter's moons are dots
    for (const it of this.sys.items) {
      if (!it.b || it.id === this.id || it.id === "sun") continue;
      const m = new THREE.Mesh(this.sys.sphere, it.mesh.material);
      m.userData.shared = true;
      m.renderOrder = -4;
      const g = new THREE.Group();
      g.add(m);
      if (it.clouds) { const cl = new THREE.Mesh(this.sys.sphere, it.clouds.material); cl.userData.shared = true; cl.scale.setScalar(1.006); cl.renderOrder = -3; g.add(cl); }
      g.visible = false;
      this.sky3.add(g);
      this.big.push({ it, g });
    }
    if (this.b.ring) {
      const it = this.sys.byId[this.id];
      const mat = it.ring.material.clone();
      mat.uniforms.map.value = it.ringU.map.value;
      mat.uniforms.L = it.L;
      mat.depthTest = false;
      this.ringU = mat.uniforms;
      this.ring = new THREE.Mesh(it.ring.geometry, mat);
      this.ring.userData.shared = false;
      this.ring.geometry = it.ring.geometry.clone();
      this.ring.renderOrder = -6;
      this.ring.scale.setScalar(S * 0.25);
      this.sky3.add(this.ring);
    } else this.ring = null;
  }

  aim() {
    // look at the most exciting thing: Earth from the Moon, the rings from Saturn, else the Sun – with the horizon in view
    const dir = this.id === "moon" ? this.dirTo("earth") : this.ring ? this.ringDir : this.sunW;
    [this.yaw, this.pitch] = this.view(dir);
  }
  // yaw/pitch that frame a sky direction nicely
  view(dir) {
    const l = this.toLocal(dir), half = (this.fov * Math.PI) / 360, el = Math.asin(Math.max(-1, Math.min(1, l[1])));
    let yaw = Math.atan2(l[0], -l[2]);
    // a high Sun (or Earth, from the Moon) would sit right behind the title: nudge it off to the side
    if (el > half * 0.6) yaw += 0.5 * Math.atan(Math.tan(half) * this.camera.aspect);
    const pitch = this.cfg.gas ? Math.max(-0.03, Math.min(el - half * 0.35, half * 0.12))   // a sea of clouds fills the lower half
      : el > 0 ? Math.max(0.04, Math.min(el - half * 0.35, half * (this.id === "moon" ? 0.85 : this.ring ? 0.45 : 0.3))) : 0.06;
    return [yaw, pitch];
  }

  toLocal(w) { const f = this.frame; return [w[0] * f.x[0] + w[1] * f.x[1] + w[2] * f.x[2], w[0] * f.y[0] + w[1] * f.y[1] + w[2] * f.y[2], w[0] * f.z[0] + w[1] * f.z[1] + w[2] * f.z[2]]; }
  dirTo(id) {
    const p = this.sys.byId[id].pD, o = this.obs;
    const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]], l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  sunElev(d) {
    const b = this.b, ax = bodyAxes(b, d, primeW(b, d), {}), up = this.zenith(ax);
    const p = this.sys.byId[this.id].pD, r = Math.hypot(...p);
    return -(up[0] * p[0] + up[1] * p[1] + up[2] * p[2]) / r;
  }
  zenith(ax) {
    const la = this.spot.lat * D2R, lo = this.spot.lon * D2R;
    const l = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
    return [0, 1, 2].map((i) => l[0] * ax.x[i] + l[1] * ax.y[i] + l[2] * ax.z[i]);
  }
  isDay() { return !this.active || (this.sunUp ?? 1) > 0.02; }
  // days to wait for a nice high Sun (null if it's already up)
  toDaylight(d) {
    if (this.sunElev(d) > 0.25) return 0;
    const span = this.id === "moon" ? 29.53 : Math.abs(this.b.day) * (this.id === "earth" ? 1 : 1), n = 240;
    let best = 0, bt = 0;
    for (let k = 1; k <= n; k++) { const t = (k / n) * span, e = this.sunElev(d + t); if (e > best + 1e-4) { best = e; bt = t; } }
    // stop a little before the highest point: a morning Sun is prettier than noon
    this.panToSun = true;
    return bt * 0.92;
  }

  update(d, dt) {
    if (!this.active) return;
    const b = this.b, it = this.sys.byId[this.id];
    const ax = bodyAxes(b, d, primeW(b, d), {});
    const up = this.zenith(ax);
    const pole = ax.y, pu = pole[0] * up[0] + pole[1] * up[1] + pole[2] * up[2];
    let north = [pole[0] - up[0] * pu, pole[1] - up[1] * pu, pole[2] - up[2] * pu];
    const nl = Math.hypot(...north) || 1; north = north.map((v) => v / nl);
    const east = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
    this.frame = { x: east, y: up, z: north.map((v) => -v) };
    const f = this.frame;
    this.M.set(f.x[0], f.y[0], f.z[0], 0, f.x[1], f.y[1], f.z[1], 0, f.x[2], f.y[2], f.z[2], 0, 0, 0, 0, 1);
    this.Q.setFromRotationMatrix(this.M);
    this.land.quaternion.copy(this.Q);
    const eye = this.cfg.gas ? 0 : 1.6 + (this.height ? this.height(0, 0) : 0);
    this.land.position.set(-up[0] * eye, -up[1] * eye, -up[2] * eye);
    // observer & Sun
    const R = b.r / AU;
    this.obs = [it.pD[0] + up[0] * R, it.pD[1] + up[1] * R, it.pD[2] + up[2] * R];
    const sr = Math.hypot(...this.obs);
    this.sunW = this.obs.map((v) => -v / sr);
    this.sunUp = this.sunW[0] * up[0] + this.sunW[1] * up[1] + this.sunW[2] * up[2];
    const U = this.skyU;
    U.sun.value.set(...this.sunW); U.up.value.set(...up);
    U.sunR.value = Math.max(0.0022, Math.asin(695700 / (sr * AU)) * 1.8);   // drawn a bit larger than life so it reads as a disc
    const bright = Math.min(1, Math.pow(1 / Math.max(sr, 0.3), 0.2));
    U.bright.value = bright;
    const s = this.sk, day = smooth(-0.2, 0.1, this.sunUp);
    this.dayK = day;
    // light
    const airy = s.haze >= 0.5;   // a real daytime sky (Pluto's thin haze doesn't count)
    const lightK = smooth(-0.06, 0.12, this.sunUp) * bright * (s.haze > 1.5 ? 0.55 : 1);
    this.sunLight.position.set(...this.sunW).multiplyScalar(100);
    this.sunLight.intensity = 3.4 * lightK;
    const lowSun = 1 - smooth(0.0, 0.35, this.sunUp);
    this.sunLight.color.setRGB(1, 1 - 0.35 * lowSun * (airy ? 1 : 0), 1 - 0.6 * lowSun * (airy ? 1 : 0));
    const C = this.C || (this.C = { a: new THREE.Color(), b: new THREE.Color(), n: new THREE.Color(), amb: new THREE.Color(0.05, 0.06, 0.09), body: {}, wdir: new THREE.Vector3() });
    this.hemi.color.setRGB(...s.zen).lerp(C.b.setRGB(...s.hor), 0.4).multiplyScalar(day * bright).add(C.amb);
    this.hemi.groundColor.setRGB(...(this.cfg.lo || [0.2, 0.2, 0.2])).multiplyScalar(0.5 * lightK + 0.05);
    this.hemi.intensity = airy ? 1.5 : 0.35;
    this.hemi.position.set(...up);
    const fogC = C.a.setRGB(...s.hor).multiplyScalar(day * bright).lerp(C.b.setRGB(...s.set), lowSun * day * 0.4).add(C.n.setRGB(...s.night));
    this.scene.fog.color.copy(fogC);
    this.scene.fog.density = s.haze === 0 ? 0.00004 : s.haze > 1.5 ? 0.0011 : this.cfg.sky === "pluto" ? 0.0001 : this.cfg.gas ? 0.00012 : 0.00028;
    if (this.gasU) for (const u of this.gasU) { u.t.value += dt * 6; u.light.value = 0.12 + lightK * 0.95; u.fogc.value.copy(fogC); }
    // other worlds
    const dots = this.dots.geometry.attributes.position, cols = this.dots.geometry.attributes.color;
    const starK = s.haze > 1.5 ? 0 : Math.max(0, 1 - day * (airy ? 1.4 : 0.15));
    this.starK = starK;
    let k = 0;
    for (const o of BODIES) {
      if (o.id === this.id) { dots.setXYZ(k, 0, -1e5, 0); k++; continue; }
      const p = this.sys.byId[o.id].pD, dir = o._dir || (o._dir = [0, 0, 0]);
      for (let i = 0; i < 3; i++) dir[i] = p[i] - this.obs[i];
      const l = Math.hypot(dir[0], dir[1], dir[2]);
      for (let i = 0; i < 3; i++) dir[i] /= l;
      dots.setXYZ(k, dir[0] * 6000, dir[1] * 6000, dir[2] * 6000);
      const c = C.body[o.id] || (C.body[o.id] = new THREE.Color(o.color)), vis = o.id === "sun" ? 0 : Math.min(1, starK * 1.3 + (airy ? 0 : 0.6));
      cols.setXYZ(k, c.r * vis, c.g * vis, c.b * vis);
      o._ang = Math.atan((o.r / AU) / l);
      k++;
    }
    dots.needsUpdate = cols.needsUpdate = true;
    for (const bb of this.big) {
      const o = bb.it.b, ang = o._ang, S = 4000;
      bb.g.visible = ang > 0.0007 && s.haze < 1.5;
      if (!bb.g.visible) continue;
      bb.g.position.set(o._dir[0] * S, o._dir[1] * S, o._dir[2] * S);
      bb.g.quaternion.copy(bb.it.spin.quaternion);
      bb.g.scale.setScalar(S * Math.tan(ang) * 1.8);   // like the Sun: drawn a bit larger than life so it reads
    }
    if (this.ring) {
      const S = 1000, sp = this.sys.byId[this.id].spin.quaternion;
      this.ring.quaternion.copy(sp);
      this.ring.position.set(-up[0] * S, -up[1] * S, -up[2] * S);
      this.ring.scale.setScalar(S);
      this.ringU.C.value.copy(this.ring.position);
      this.ringU.R.value = S;
      this.ringU.rN.value.set(...ax.y);
      this.ringU.fade.value = 1;
      // where the rings arc highest: towards the equator
      const eq = this.toLocal(ax.y)[1] > 0 ? -1 : 1;
      this.ringDir = [0, 1, 2].map((i) => up[i] * 0.55 + north[i] * eq * 0.8);
    }
    // camera
    if (this.panToSun && this.sunUp > 0.05) {
      const [want, wantP] = this.view(this.sunW), k = Math.min(1, dt * 2.5);
      const dy = ((want - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this.yaw += dy * k;
      this.pitch += (wantP - this.pitch) * k;
      if (Math.abs(dy) < 0.01 && Math.abs(wantP - this.pitch) < 0.01) this.panToSun = false;
    }
    if (dt) { this.yaw += this.vy; this.pitch = Math.max(-0.6, Math.min(1.5, this.pitch + this.vp)); this.vy *= 0.9; this.vp *= 0.9; }
    const lx = Math.sin(this.yaw) * Math.cos(this.pitch), ly = Math.sin(this.pitch), lz = -Math.cos(this.yaw) * Math.cos(this.pitch);
    const wdir = C.wdir.set(lx, ly, lz).applyQuaternion(this.Q);
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(...up);
    this.camera.lookAt(wdir);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov += (this.fov - this.camera.fov) * 0.25; this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld();
    this.placeLabels();
  }

  placeLabels() {
    const v = new THREE.Vector3(), W = this.W, H = this.H;
    for (const id in this.lbl) {
      const el = this.lbl[id], o = BY_ID[id];
      if (!o._dir) continue;
      const up = this.skyU.up.value;
      const elev = o._dir[0] * up.x + o._dir[1] * up.y + o._dir[2] * up.z;
      const big = o._ang > 0.0007;
      const show = elev > 0.01 && (id === "sun" ? this.sk.haze < 0.5 :   /* in a blue sky the Sun needs no label */ (this.starK > 0.35 || big) && this.sk.haze < 1.5) && (id !== "moon" || this.id === "earth") ;
      v.set(o._dir[0], o._dir[1], o._dir[2]).multiplyScalar(1000).applyMatrix4(this.camera.matrixWorldInverse).applyMatrix4(this.camera.projectionMatrix);
      const on = show && v.z < 1 && Math.abs(v.x) < 1.1 && v.y < 1.1 - 260 / H && v.y > -1.1;
      el.classList.toggle("is-on", on);
      if (!on) continue;
      if (!el.textContent) el.textContent = (document.documentElement.lang === "de" ? o.name.de : o.name.en);
      const r = big ? (Math.tan(o._ang) / Math.tan((this.camera.fov * Math.PI) / 360)) * H * 0.5 : 2;
      el.style.transform = `translate(${((v.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * H + r + (id === "sun" ? 16 : 6)).toFixed(1)}px) translateX(-50%)`;
    }
  }

  render() {
    const r = this.renderer;
    this.sky.render(r, this.camera, this.starK * (this.sk.haze >= 0.5 ? 1 : 0.85));
    r.render(this.scene, this.camera);
  }
}

// distance to the nearest cell border of a jittered grid (Pluto's nitrogen-ice cells, shrunk to fit the view)
function cellEdge(x, z, size) {
  const gx = Math.floor(x / size), gz = Math.floor(z / size);
  let d1 = 1e9, d2 = 1e9;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const cx = gx + i, cz = gz + j, h1 = fract(Math.sin(cx * 127.1 + cz * 311.7) * 43758.5), h2 = fract(Math.sin(cx * 269.5 + cz * 183.3) * 43758.5);
    const d = Math.hypot((cx + h1) * size - x, (cz + h2) * size - z);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return (d2 - d1) * 0.5;
}
const fract = (v) => v - Math.floor(v);
const smoothEdge = (e) => smooth(3, 22, e);   // troughs ~40 m wide
function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
