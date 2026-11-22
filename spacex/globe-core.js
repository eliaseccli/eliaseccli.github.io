import * as THREE from "/vendor/three.module.min.js";

/* ============================================================
   Shared globe: Earth (day/night shader), atmosphere, stars,
   sun direction and the Earth-fixed lat/lon -> vector mapping.
   Used by /spacex/ and the Starlink globe tab.
   Frame: +Y north pole, lon 0 on +X, lon 90E on -Z. 1 unit = R_E.
   ============================================================ */

import { R_E, D2R } from "./earth.js?v=e1";
export { R_E, D2R };

export function ll2v(latDeg, lonDeg, r, out) {
  const la = latDeg * D2R, lo = lonDeg * D2R;
  const v = out || new THREE.Vector3();
  return v.set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

// unit vector to the sun in the Earth-fixed frame
export function sunDir(date) {
  const d = date.getTime() / 864e5 - 10957.5; // days since J2000
  const g = (357.529 + 0.98560028 * d) * D2R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * d) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((280.46061837 + 360.98564736629 * d) % 360) * D2R;
  const lon = ra - gmst;
  return ll2v(dec / D2R, lon / D2R, 1);
}

const asset = (f) => new URL("./assets/" + f, import.meta.url).href;

// Adds Earth + atmosphere (layer 0) and stars (layer 1) to the scene; returns the shared sun uniform.
export function addEarth(renderer, scene) {
  const loader = new THREE.TextureLoader();
  const maxTex = renderer.capabilities.maxTextureSize;
  const earthTex = loader.load(asset(maxTex >= 4096 ? "earth-mono-4k.jpg" : "earth-mono-2k.jpg"));
  earthTex.colorSpace = THREE.SRGBColorSpace;
  earthTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const nightTex = loader.load(asset(maxTex >= 4096 ? "earth-night-4k.jpg" : "earth-night-2k.jpg"));
  nightTex.anisotropy = earthTex.anisotropy;
  const uSun = { value: new THREE.Vector3(1, 0, 0) };
  const earthMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: earthTex }, night: { value: nightTex }, sun: uSun },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        vUv = uv;
        vN = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform sampler2D map; uniform sampler2D night; uniform vec3 sun;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        vec3 c = texture2D(map, vUv).rgb;
        c = pow(c, vec3(2.2));
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(vec3(l), c, 0.85);
        float facing = clamp(dot(vN, vView), 0.0, 1.0);
        float limb = 0.5 + 0.5 * pow(facing, 0.5);
        float sd = dot(vN, normalize(sun));
        // soft but obvious terminator: ~±7° twilight band, night clearly darker
        float dayW = smoothstep(-0.12, 0.12, sd);
        float day = mix(0.13, 1.0, dayW);
        float land = smoothstep(0.03, 0.09, l);
        vec3 col = c * limb * day * mix(1.0, 1.22, land);
        col += vec3(0.010, 0.017, 0.032) * limb * day * (1.0 - land);
        // faint city lights (NASA Black Marble, desaturated) only on the night side
        float lights = texture2D(night, vUv).r;
        float nightW = 1.0 - smoothstep(-0.16, 0.02, sd);
        col += vec3(0.86, 0.9, 1.0) * pow(lights, 1.6) * nightW * 0.42 * (0.6 + 0.4 * facing);
        float rim = pow(1.0 - facing, 4.0);
        col += vec3(0.5, 0.62, 0.8) * rim * 0.09 * mix(0.25, 1.0, dayW);
        gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
      }`
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 112), earthMat);
  scene.add(earth);

  // atmosphere halo (back faces, additive)
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.035, 96, 64),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { sun: uSun },
      vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW;
        void main(){ vN = normalize(normalMatrix * normal); vW = normalize(position); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 sun; varying vec3 vN; varying vec3 vV; varying vec3 vW;
        void main(){ float f = pow(clamp(1.0 + dot(vN, vV) * 1.0, 0.0, 1.0), 5.0);
          float lit = mix(0.18, 1.0, smoothstep(-0.25, 0.2, dot(vW, normalize(sun))));
          gl_FragColor = vec4(vec3(0.6,0.7,0.88) * f * 0.42 * lit, 1.0); }`
    })
  );
  scene.add(atmo);

  // stars (layer 1: main view only)
  const stars = starfield();
  stars.layers.set(1);
  scene.add(stars);

  return { uSun, earth, atmo, stars };
}

// seeded random starfield on a sphere of radius r (fixed pixel size, like a night sky)
export function starfield(n = 2400, r = 60, seed = 1337) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < n; k++) {
    const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
    const q = Math.sqrt(1 - u * u);
    pos.set([r * q * Math.cos(a), r * u, r * q * Math.sin(a)], k * 3);
    const b = 0.18 + Math.pow(rnd(), 6) * 0.75;
    col.set([b, b, b * 1.05], k * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
}
