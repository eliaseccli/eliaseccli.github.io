import * as THREE from "/vendor/three.module.min.js";
import { BODIES, MOONS, BY_ID, AU, R_EARTH, D2R, helio, moonGeo, bodyAxes, primeW, halleyPos, HALLEY, orbitPos, elements } from "./bodies.js?v=5";

/* ============================================================
   The solar system scene: Sun, planets, moons, rings, belts, orbits.
   Three ways to place everything (blended while switching):
     o  overview   – squeezed so all fits: r' = (6 + 28·r^0.6)/34, sizes ~ √R
     s  sizes      – true sizes side by side (a lineup), units = 0.01 Earth radii
     d  distances  – true distances and true sizes, units = AU
   Rendering is relative to a floating origin (the camera target), so
   true-scale views stay precise.
   ============================================================ */

const TEX = (f) => new URL("./tex/" + f, import.meta.url).href;
const ER_AU = R_EARTH / AU;

export const mapO = (r) => (6 + 28 * Math.pow(r, 0.6)) / 34;
const sizeO = (rKm) => (rKm === 695700 ? 10.5 : 2.2 * Math.sqrt(rKm / R_EARTH)) / 34;
const sizeS = (rKm) => (rKm / R_EARTH) * 0.01;

// the same radial squeeze in GLSL (orbits, belts) – one definition, two languages
const MAP_GLSL = `
  uniform vec3 wMode; uniform vec3 origin;
  vec3 mapPos(vec3 p) { float r = length(p); float ro = (6.0 + 28.0 * pow(r, 0.6)) / 34.0;
    return p / max(r, 1e-9) * (wMode.x * ro + wMode.z * r) - origin; }`;

export const LOGV = "#include <common>\n#include <logdepthbuf_pars_vertex>\n";
export const LOGF = "#include <logdepthbuf_pars_fragment>\n";
const sphereVS = LOGV + `
  varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

// globe-style shading (same recipe as /spacex/globe-core.js): linearised texture, slight desaturation,
// limb, soft terminator, rim light; plus a gentle lambert so planets read as balls
const planetFS = LOGF + `
  uniform sampler2D map; uniform vec3 L; uniform vec3 atmo; uniform float atmoK; uniform float soft;
  uniform float isEarth; uniform sampler2D night;
  uniform float ringOn; uniform vec3 C; uniform float R; uniform vec3 rN; uniform vec2 rIO; uniform sampler2D ringTex;
  uniform vec3 tint;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 c = pow(texture2D(map, vUv).rgb, vec3(2.2)) * tint;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 0.9);
    float facing = clamp(dot(vN, vV), 0.0, 1.0);
    float limb = 0.5 + 0.5 * pow(facing, 0.5);
    float sd = dot(vN, L);
    float dayW = smoothstep(-soft, soft, sd);
    float lam = 0.45 + 0.55 * smoothstep(-0.05, 0.9, sd);
    float sh = 1.0;
    if (ringOn > 0.5) {               // Saturn: the rings' shadow on the clouds
      float dn = dot(L, rN);
      if (abs(dn) > 1e-4) {
        float t = dot(C - vW, rN) / dn;
        if (t > 0.0) {
          float rr = length(vW + L * t - C) / R;
          float u = (rr - rIO.x) / (rIO.y - rIO.x);
          if (u > 0.0 && u < 1.0) sh = 1.0 - 0.8 * texture2D(ringTex, vec2(u, 0.5)).a;
        }
      }
    }
    vec3 col = c * limb * mix(0.035, 1.0, dayW * sh) * mix(1.0, lam, dayW);
    if (isEarth > 0.5) {
      float land = smoothstep(0.03, 0.09, l);
      col *= mix(1.0, 1.12, land);
      float lights = texture2D(night, vUv).r;
      float nightW = 1.0 - smoothstep(-0.16, 0.02, sd);
      col += vec3(1.0, 0.84, 0.6) * pow(lights, 1.5) * nightW * 0.55 * (0.6 + 0.4 * facing);
    }
    float rim = pow(1.0 - facing, 3.0);
    col += atmo * rim * atmoK * mix(0.12, 1.0, dayW);
    gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
  }`;

const cloudFS = LOGF + `
  uniform sampler2D map; uniform vec3 L;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    #include <logdepthbuf_fragment>
    float a = texture2D(map, vUv).r;
    float facing = clamp(dot(vN, vV), 0.0, 1.0);
    float sd = dot(vN, L);
    float day = smoothstep(-0.12, 0.12, sd) * (0.5 + 0.5 * smoothstep(-0.05, 0.9, sd));
    gl_FragColor = vec4(vec3(0.97) * day * (0.55 + 0.45 * pow(facing, 0.4)), a * a * 0.9 * (0.4 + 0.6 * pow(facing, 0.3)));
  }`;

const atmoVS = LOGV + `
  varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = normalize(mat3(modelMatrix) * position); vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;
const atmoFS = LOGF + `
  uniform vec3 L; uniform vec3 atmo; uniform float k;
  varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    #include <logdepthbuf_fragment>
    float f = pow(clamp(1.0 + dot(vN, vV), 0.0, 1.0), 5.0);
    float lit = mix(0.12, 1.0, smoothstep(-0.25, 0.2, dot(vW, L)));
    gl_FragColor = vec4(atmo * f * k * lit, 1.0);
  }`;

const sunFS = LOGF + `
  uniform sampler2D map; uniform float t; uniform float glow;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 w = vec2(sin(t * 0.21 + vUv.y * 31.0), cos(t * 0.17 + vUv.x * 47.0)) * 0.0035;
    vec3 a = texture2D(map, vUv + w).rgb, b = texture2D(map, vUv * vec2(1.0, 1.0) - w.yx + vec2(t * 0.0007, 0.0)).rgb;
    float l = dot(mix(a, b, 0.5 + 0.5 * sin(t * 0.13)), vec3(0.3, 0.55, 0.15));
    float facing = clamp(dot(vN, vV), 0.0, 1.0);
    float e = smoothstep(0.15, 0.95, l) * (0.55 + 0.45 * pow(facing, 0.6));
    vec3 c = mix(vec3(0.95, 0.42, 0.08), vec3(1.0, 0.93, 0.74), e) * (0.75 + 0.5 * e);
    c += vec3(1.0, 0.6, 0.25) * pow(1.0 - facing, 3.0) * 0.4;
    gl_FragColor = vec4(pow(min(c, vec3(1.0)), vec3(1.0 / 2.2)) * glow, 1.0);
  }`;

const moonletFS = LOGF + `
  uniform vec3 L; uniform vec3 base;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vW;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vUv * vec2(16.0, 8.0);
    float v = 0.55 * n(p) + 0.3 * n(p * 2.7) + 0.15 * n(p * 7.1);
    vec3 c = pow(base, vec3(2.2)) * (0.65 + 0.6 * v);
    float facing = clamp(dot(vN, vV), 0.0, 1.0), sd = dot(vN, L);
    float dayW = smoothstep(-0.1, 0.1, sd);
    vec3 col = c * (0.5 + 0.5 * pow(facing, 0.5)) * mix(0.03, 1.0, dayW) * (0.45 + 0.55 * smoothstep(-0.05, 0.9, sd));
    gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
  }`;

const ringVS = LOGV + `
  varying vec2 vUv; varying vec3 vW; varying vec3 vV;
  void main() { vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;
const ringFS = LOGF + `
  uniform sampler2D map; uniform vec3 L; uniform vec3 C; uniform float R; uniform vec3 rN; uniform float fade;
  varying vec2 vUv; varying vec3 vW; varying vec3 vV;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vec2(vUv.x, 0.5));
    vec3 c = pow(t.rgb, vec3(2.2));
    // planet shadow on the rings
    vec3 oc = C - vW; float b = dot(oc, L); float sh = 1.0;
    if (b > 0.0) { float d2 = dot(oc, oc) - b * b; sh = smoothstep(R * R * 0.94, R * R * 1.02, d2); }
    float sameSide = sign(dot(L, rN)) * sign(dot(vV, rN));
    float lit = sameSide > 0.0 ? 1.0 : 0.32;   // seen from the dark side, light only glows through
    vec3 col = c * lit * mix(0.06, 1.0, sh) * 1.1;
    gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), t.a * fade);
  }`;

const lineVS = LOGV + MAP_GLSL + `
  attribute float u; varying float vU;
  void main() { vU = u; vec4 mv = modelViewMatrix * vec4(mapPos(position), 1.0); gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;
const lineFS = LOGF + `
  uniform vec3 color; uniform float alpha; uniform float head; varying float vU;
  void main() {
    #include <logdepthbuf_fragment>
    float tail = fract(head - vU);                 // brighter just behind the planet
    gl_FragColor = vec4(color, alpha * (0.45 + 0.55 * pow(1.0 - tail, 3.0)));
  }`;

// asteroids + Kuiper belt: Kepler-circular orbits animated on the GPU
const beltVS = LOGV + MAP_GLSL + `
  attribute vec4 orb;          // a [AU], phase0, n [rad/day], z [AU]
  attribute float sz;
  uniform float day; uniform float px; varying float vA;
  void main() {
    float ang = orb.y + orb.z * day;
    vec3 p = vec3(orb.x * cos(ang), orb.w, -orb.x * sin(ang));
    vec4 mv = modelViewMatrix * vec4(mapPos(p), 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = sz * px;
    vA = sz;
    #include <logdepthbuf_vertex>
  }`;
const beltFS = LOGF + `
  uniform vec3 color; uniform float alpha; varying float vA;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 q = gl_PointCoord - 0.5; float d = dot(q, q);
    if (d > 0.25) discard;
    gl_FragColor = vec4(color, alpha * smoothstep(0.25, 0.05, d));
  }`;

function shader(vs, fs, uniforms, extra) {
  return new THREE.ShaderMaterial(Object.assign({ vertexShader: vs, fragmentShader: fs, uniforms }, extra || {}));
}

function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d"), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, "rgba(255,244,214,1)"); gr.addColorStop(0.1, "rgba(255,226,160,0.85)");
  gr.addColorStop(0.25, "rgba(255,190,100,0.28)"); gr.addColorStop(0.5, "rgba(255,160,70,0.08)"); gr.addColorStop(1, "rgba(255,140,60,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const V = () => new Float64Array(3);
const DOWN = new THREE.Vector3(0, -1, 0);
const lerp = (a, b, t) => a + (b - a) * t;
const ORDER = ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"];

export class System {
  constructor(renderer, lowPower) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.loader = new THREE.TextureLoader();
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.items = [];
    this.byId = {};
    this.t = 0;
    this.portrait = false;
    this.sphere = new THREE.SphereGeometry(1, 96, 64);
    this.sphereLo = new THREE.SphereGeometry(1, 40, 28);
    this.ringTex = this.tex("saturn-ring.webp");
    this.ringTex.wrapS = THREE.ClampToEdgeWrapping;
    for (const b of BODIES) this.addBody(b);
    for (const m of MOONS) this.addMoonlet(m);
    this.addOrbits();
    this.addBelts(lowPower ? 1800 : 4200, lowPower ? 1200 : 2600);
    this.addHalley();
  }

  tex(f, srgb = true) {
    const t = this.loader.load(TEX(f));
    if (srgb) t.colorSpace = THREE.NoColorSpace;      // shaders linearise themselves (globe recipe)
    t.anisotropy = this.aniso;
    return t;
  }

  addBody(b) {
    const it = { id: b.id, b, kind: b.kind, group: new THREE.Group(), spin: new THREE.Group(), pos: V(), R: 1,
      pO: V(), pS: V(), pD: V(), rO: sizeO(b.r), rS: sizeS(b.r), rD: b.r / AU, hiLoaded: false, angle: null, axes: {} };
    it.group.add(it.spin);
    this.scene.add(it.group);
    if (b.id === "sun") {
      it.uni = { map: { value: this.tex("sun-1k.webp") }, t: { value: 0 }, glow: { value: 1 } };
      it.mesh = new THREE.Mesh(this.sphere, shader(sphereVS, sunFS, it.uni));
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      glow.renderOrder = 5;
      it.glow = glow;
      it.group.add(glow);
    } else {
      const atm = b.atmo || [0.6, 0.6, 0.6, 0.0];
      it.L = { value: new THREE.Vector3(1, 0, 0) };
      it.uni = {
        map: { value: this.tex(b.tex + "-1k.webp") }, L: it.L, atmo: { value: new THREE.Vector3(atm[0], atm[1], atm[2]) },
        atmoK: { value: atm[3] * 0.55 }, soft: { value: b.kind === "planet" && b.r > 20000 ? 0.16 : 0.1 },
        isEarth: { value: b.id === "earth" ? 1 : 0 }, night: { value: null }, tint: { value: new THREE.Vector3(1, 1, 1) },
        ringOn: { value: b.ring ? 1 : 0 }, C: { value: new THREE.Vector3() }, R: { value: 1 }, rN: { value: new THREE.Vector3(0, 1, 0) },
        rIO: { value: new THREE.Vector2(b.ring ? b.ring[0] / b.r : 1, b.ring ? b.ring[1] / b.r : 2) }, ringTex: { value: this.ringTex }
      };
      if (b.id === "earth") it.uni.night.value = this.tex("earth-night-1k.webp");
      it.mesh = new THREE.Mesh(this.sphere, shader(sphereVS, planetFS, it.uni));
      if (b.atmo) {
        it.atmo = new THREE.Mesh(this.sphereLo, shader(atmoVS, atmoFS, { L: it.L, atmo: it.uni.atmo, k: { value: atm[3] } },
          { side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        it.atmo.scale.setScalar(b.id === "earth" ? 1.035 : b.id === "mars" ? 1.02 : 1.03);
        it.spin.add(it.atmo);
      }
      if (b.id === "earth") {
        it.cloudU = { map: { value: this.tex("earth-clouds-1k.webp") }, L: it.L };
        it.clouds = new THREE.Mesh(this.sphere, shader(sphereVS, cloudFS, it.cloudU, { transparent: true, depthWrite: false }));
        it.clouds.scale.setScalar(1.006);
        it.spin.add(it.clouds);
      }
      if (b.ring) {
        const [ri, ro] = [b.ring[0] / b.r, b.ring[1] / b.r];
        const g = new THREE.RingGeometry(ri, ro, 192, 1);
        const p = g.attributes.position, uv = g.attributes.uv;
        for (let k = 0; k < p.count; k++) uv.setXY(k, (Math.hypot(p.getX(k), p.getY(k)) - ri) / (ro - ri), 0.5);
        g.rotateX(-Math.PI / 2);
        it.ringU = { map: { value: this.ringTex }, L: it.L, C: it.uni.C, R: it.uni.R, rN: it.uni.rN, fade: { value: 1 } };
        it.ring = new THREE.Mesh(g, shader(ringVS, ringFS, it.ringU, { transparent: true, depthWrite: false, side: THREE.DoubleSide }));
        it.ring.renderOrder = 2;
        it.spin.add(it.ring);
      }
    }
    it.spin.add(it.mesh);
    this.items.push(it);
    this.byId[b.id] = it;
  }

  addMoonlet(m) {
    const p = BY_ID[m.parent];
    const it = { id: m.id, m, kind: "moonlet", group: new THREE.Group(), spin: new THREE.Group(), pos: V(), R: 1,
      pO: V(), pS: V(), pD: V(), rO: sizeO(m.r) * 0.85, rS: sizeS(m.r), rD: m.r / AU, parent: p.id };
    it.L = { value: new THREE.Vector3(1, 0, 0) };
    it.mesh = new THREE.Mesh(this.sphereLo, shader(sphereVS, moonletFS, { L: it.L, base: { value: new THREE.Vector3(...m.color) } }));
    it.spin.add(it.mesh);
    it.group.add(it.spin);
    this.scene.add(it.group);
    this.items.push(it);
    this.byId[m.id] = it;
  }

  orbitMat(color, alpha) {
    return shader(lineVS, lineFS, { wMode: this.wMode || (this.wMode = { value: new THREE.Vector3(1, 0, 0) }),
      origin: this.uOrigin || (this.uOrigin = { value: new THREE.Vector3() }),
      color: { value: new THREE.Color(color) }, alpha: { value: alpha }, head: { value: 0 } },
      { transparent: true, depthWrite: false });
  }

  addOrbits() {
    this.orbits = new THREE.Group();
    this.scene.add(this.orbits);
    const n = 360, d0 = 0;
    for (const it of this.items) {
      if (it.kind !== "planet" && it.kind !== "dwarf") continue;
      const [a, e, I, , peri, node] = elements(it.id, d0);
      const pos = new Float32Array((n + 1) * 3), u = new Float32Array(n + 1), o = [0, 0, 0];
      for (let k = 0; k <= n; k++) {
        orbitPos(a, e, I, peri, node, (k / n) * Math.PI * 2, o);
        pos.set(o, k * 3); u[k] = k / n;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("u", new THREE.BufferAttribute(u, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const line = new THREE.Line(g, this.orbitMat(0xffffff, it.kind === "dwarf" ? 0.1 : 0.16));
      line.frustumCulled = false;
      it.orbit = line;
      this.orbits.add(line);
    }
  }

  addBelts(nA, nK) {
    const make = (n, a0, a1, zAmp, size, color, alpha, seed) => {
      let s = seed;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const orb = new Float32Array(n * 4), sz = new Float32Array(n), pos = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        // clumpy radial distribution with Kirkwood-ish gaps for the main belt
        let a = a0 + (a1 - a0) * Math.pow(rnd(), 0.9);
        if (a0 < 3 && (Math.abs(a - 2.5) < 0.03 || Math.abs(a - 2.82) < 0.025 || Math.abs(a - 2.95) < 0.02)) a += 0.06;
        orb.set([a, rnd() * Math.PI * 2, 0.01720209895 / Math.pow(a, 1.5), (rnd() - 0.5) * 2 * zAmp * a * rnd()], k * 4);
        sz[k] = size * (0.5 + Math.pow(rnd(), 3) * 1.6);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("orb", new THREE.BufferAttribute(orb, 4));
      g.setAttribute("sz", new THREE.BufferAttribute(sz, 1));
      const u = { wMode: this.wMode, origin: this.uOrigin, day: { value: 0 }, px: { value: 1 }, color: { value: new THREE.Color(color) }, alpha: { value: alpha } };
      const pts = new THREE.Points(g, shader(beltVS, beltFS, u, { transparent: true, depthWrite: false }));
      pts.frustumCulled = false;
      pts.userData.u = u;
      this.scene.add(pts);
      return pts;
    };
    this.belt = make(nA, 2.1, 3.3, 0.07, 1.6, 0xcbb9a2, 0.55, 4242);
    this.kuiper = make(nK, 30, 50, 0.12, 1.5, 0x9fb4cf, 0.32, 777);
  }

  addHalley() {
    const n = 600, pos = new Float32Array((n + 1) * 3), u = new Float32Array(n + 1), o = [0, 0, 0];
    for (let k = 0; k <= n; k++) {
      // denser sampling near the Sun: walk the eccentric anomaly
      const E = (k / n) * Math.PI * 2, M = E - HALLEY.e * Math.sin(E);
      orbitPos(HALLEY.a, HALLEY.e, HALLEY.I, HALLEY.w + HALLEY.node, HALLEY.node, M, o);
      pos.set(o, k * 3); u[k] = k / n;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("u", new THREE.BufferAttribute(u, 1));
    this.halleyOrbit = new THREE.Line(g, this.orbitMat(0x9fd0ff, 0.07));
    this.halleyOrbit.frustumCulled = false;
    this.scene.add(this.halleyOrbit);
    const tail = document.createElement("canvas"); tail.width = 64; tail.height = 256;
    const c = tail.getContext("2d"), gr = c.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, "rgba(220,240,255,0.95)"); gr.addColorStop(0.15, "rgba(170,210,255,0.4)"); gr.addColorStop(1, "rgba(120,170,255,0)");
    c.fillStyle = gr; c.beginPath(); c.moveTo(32, 0); c.quadraticCurveTo(64, 120, 58, 256); c.lineTo(6, 256); c.quadraticCurveTo(0, 120, 32, 0); c.fill();
    const tt = new THREE.CanvasTexture(tail);
    this.halley = { pD: V(), pO: V(), pos: V(), head: new THREE.Mesh(this.sphereLo, new THREE.MeshBasicMaterial({ color: 0xe8f4ff })),
      tail: new THREE.Mesh(new THREE.PlaneGeometry(1, 4).translate(0, -2, 0), new THREE.MeshBasicMaterial({ map: tt, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })) };
    this.scene.add(this.halley.head, this.halley.tail);
  }

  // the lineup for "true sizes": Sun's edge at 0, planets in a row; axis +X (landscape) or -Y (portrait)
  lineup() {
    const gap = 0.012;
    let x = 0;
    const out = {};
    for (const id of ORDER) {
      const it = this.byId[id];
      if (id === "sun") { out.sun = -it.rS; continue; }
      const ext = it.b.ring ? it.rS * 2.45 : it.rS;
      x += gap + ext;
      out[id] = x;
      x += ext;
    }
    out.end = x;
    return out;
  }

  loadHi(it) {
    if (it.hiLoaded || !it.b || !it.b.hi) return;
    it.hiLoaded = true;
    const hi = this.loader.load(TEX(it.b.tex + "-2k.webp"), (t) => { it.uni.map.value = t; });
    hi.colorSpace = THREE.NoColorSpace; hi.anisotropy = this.aniso;
    if (it.id === "earth") {
      const n = this.loader.load(TEX("earth-night-2k.webp"), (t) => { it.uni.night.value = t; });
      n.anisotropy = this.aniso;
      const c = this.loader.load(TEX("earth-clouds-2k.webp"), (t) => { it.cloudU.map.value = t; });
      c.anisotropy = this.aniso;
    }
  }

  /* Where everything is. d: days since J2000, w: [o, s, d] mode weights. */
  compute(d, w, realDt) {
    this.t += realDt;
    this.d = d; this.w = w;
    const tmp = [0, 0, 0], L = this.lineup(), port = this.portrait;
    for (const it of this.items) {
      if (it.kind === "moonlet" || it.id === "moon") continue;
      if (it.id === "sun") it.pD.fill(0);
      else helio(it.id, d, it.pD);
      const r = Math.hypot(it.pD[0], it.pD[1], it.pD[2]), k = r > 0 ? mapO(r) / r : 0;
      for (let i = 0; i < 3; i++) it.pO[i] = it.pD[i] * k;
      const x = L[it.id];
      it.pS[0] = port ? 0 : x; it.pS[1] = port ? -x : 0; it.pS[2] = 0;
    }
    const earth = this.byId.earth, moon = this.byId.moon;
    moonGeo(d, tmp);
    const md = Math.hypot(tmp[0], tmp[1], tmp[2]);
    for (let i = 0; i < 3; i++) {
      moon.pD[i] = earth.pD[i] + tmp[i];
      moon.pO[i] = earth.pO[i] + (tmp[i] / md) * earth.rO * 4.4;
    }
    moon.pS[0] = port ? 0 : L.moon; moon.pS[1] = port ? -L.moon : 0; moon.pS[2] = 0;
    for (const it of this.items) if (it.b) this.orient(it, d, realDt);
    for (const it of this.items) {
      if (it.kind !== "moonlet") continue;
      const p = this.byId[it.parent], m = it.m;
      const ang = (m.L0 + (360 / m.P) * d) * D2R, c = Math.cos(ang), s = Math.sin(ang);
      // orbit in the parent's equator plane (its X/Z axes)
      const dx = p.axes.x[0] * c - p.axes.z[0] * s, dy = p.axes.x[1] * c - p.axes.z[1] * s, dz = p.axes.x[2] * c - p.axes.z[2] * s;
      const aAU = m.a / AU, ao = p.rO * (2.0 + 0.62 * Math.log(m.a / p.b.r));
      it.pD[0] = p.pD[0] + dx * aAU; it.pD[1] = p.pD[1] + dy * aAU; it.pD[2] = p.pD[2] + dz * aAU;
      it.pO[0] = p.pO[0] + dx * ao; it.pO[1] = p.pO[1] + dy * ao; it.pO[2] = p.pO[2] + dz * ao;
      it.pS[0] = p.pS[0]; it.pS[1] = p.pS[1]; it.pS[2] = p.pS[2];
      it.spin.quaternion.copy(p.spin.quaternion);
    }
    for (const it of this.items) {
      for (let i = 0; i < 3; i++) it.pos[i] = w[0] * it.pO[i] + w[1] * it.pS[i] + w[2] * it.pD[i];
      it.R = Math.exp(w[0] * Math.log(it.rO) + w[1] * Math.log(it.rS) + w[2] * Math.log(it.rD));
    }
    const h = this.halley;
    halleyPos(d, h.pD);
    const hr = Math.hypot(h.pD[0], h.pD[1], h.pD[2]);
    h.r = hr;
    for (let i = 0; i < 3; i++) h.pos[i] = w[0] * (h.pD[i] / hr) * mapO(hr) + w[2] * h.pD[i];
  }

  /* Draw relative to the floating origin. pxAt(dist): world units per CSS pixel at that distance. */
  place(origin, camPos, pxAt) {
    const w = this.w, d = this.d, sun = this.byId.sun;
    // past ~130 AU (scene units are AU) planet dots, belts and the comet would read as stars around the Sun: shrink/fade them out by ~400 AU
    const far = 1 - Math.min(1, Math.max(0, (Math.log10(camPos.length()) - 2.1) / 0.5));
    for (const it of this.items) {
      it.group.position.set(it.pos[0] - origin[0], it.pos[1] - origin[1], it.pos[2] - origin[2]);
      const px = pxAt(it.group.position.distanceTo(camPos));
      const minR = px * (it.kind === "moonlet" ? 1.4 : it.id === "sun" ? 3 : 2.2);
      it.screenR = it.R / px;
      it.group.visible = (it.kind !== "moonlet" || w[1] < 0.98) && (far > 0.02 || it.id === "sun");
      it.spin.scale.setScalar(Math.max(it.R, it.id === "sun" ? minR : minR * far));
    }
    const sp = sun.group.position;
    for (const it of this.items) {
      if (!it.L) continue;
      it.L.value.copy(sp).sub(it.group.position).normalize();
      // side by side, light comes from over your shoulder so every ball is (mostly) lit
      if (w[1] > 0) {
        this._c = (this._c || new THREE.Vector3()).copy(camPos).sub(it.group.position).normalize();
        it.L.value.lerp(this._c.add(this._up || (this._up = new THREE.Vector3(0, 0.25, 0))).normalize(), w[1] * 0.8).normalize();
      }
      if (it.b && it.b.ring) {
        it.uni.C.value.copy(it.group.position);
        it.uni.R.value = it.spin.scale.x;
        it.uni.rN.value.set(it.axes.y[0], it.axes.y[1], it.axes.y[2]);
      }
    }
    sun.uni.t.value = this.t;
    // sun glow: a big soft halo, and never less than a bright star
    const gsz = Math.max(sun.spin.scale.x * lerp(9, 2.4, w[1]), pxAt(sp.distanceTo(camPos)) * 60);
    sun.glow.scale.setScalar(gsz);
    this.wMode.value.set(w[0], w[1], w[2]);
    this.uOrigin.value.set(origin[0], origin[1], origin[2]);
    const lineA = 1 - w[1];
    this.orbits.visible = lineA > 0.01;
    for (const it of this.items) {
      if (!it.orbit) continue;
      const [, , , Lm, peri] = elements(it.id, d);
      it.orbit.material.uniforms.head.value = (((Lm - peri) % 360) + 360) % 360 / 360;
      it.orbit.material.uniforms.alpha.value = (it.focus ? 0.4 : it.kind === "dwarf" ? 0.11 : 0.19) * lineA;
    }
    const beltA = lineA * far;
    for (const b of [this.belt, this.kuiper]) {
      b.visible = beltA > 0.01;
      b.userData.u.day.value = d;
      b.userData.u.px.value = this.renderer.getPixelRatio();
    }
    this.belt.userData.u.alpha.value = 0.5 * beltA;
    this.kuiper.userData.u.alpha.value = 0.28 * beltA;
    const h = this.halley;
    h.head.position.set(h.pos[0] - origin[0], h.pos[1] - origin[1], h.pos[2] - origin[2]);
    h.head.scale.setScalar(pxAt(h.head.position.distanceTo(camPos)) * 1.6);
    const tailLen = Math.min(1, 1.6 / (h.r * h.r)) * (w[0] * 0.4 + w[2] * 0.35);
    h.head.visible = this.halleyOrbit.visible = beltA > 0.01;
    h.tail.visible = tailLen > 0.002 && beltA > 0.01;
    this.halleyOrbit.material.uniforms.alpha.value = 0.08 * beltA;
    if (h.tail.visible) {
      h.tail.position.copy(h.head.position);
      this._v = (this._v || new THREE.Vector3()).copy(h.head.position).sub(sp).normalize();
      h.tail.quaternion.setFromUnitVectors(DOWN, this._v);
      h.tail.scale.set(tailLen * 0.15, tailLen, 1);
    }
  }

  orient(it, d, realDt) {
    const b = it.b;
    const target = primeW(b, d);
    // rotation follows the real prime meridian, but never spins faster than ~1 turn / 4 s on screen
    // (step per real second, so a pause – realDt 0 – stops a planet that was still catching up)
    if (it.angle === null) it.angle = target;
    const diff = ((target - it.angle) % 360 + 540) % 360 - 180, maxStep = 96 * realDt;
    it.angle = Math.abs(diff) <= maxStep ? target : it.angle + Math.sign(b.W[1]) * maxStep;
    bodyAxes(b, d, it.angle, it.axes);
    const x = it.axes.x, y = it.axes.y, z = it.axes.z;
    if (!this._m) this._m = new THREE.Matrix4();
    this._m.set(x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1);
    it.spin.quaternion.setFromRotationMatrix(this._m);
    if (it.clouds) it.clouds.rotation.y = this.t * 0.004;
  }
}
