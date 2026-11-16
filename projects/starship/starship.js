import * as THREE from "./vendor/three.module.min.js";

/* ============================================================
   Starship · flight globe
   Data: Launch Library 2 (mission) + CelesTrak (orbit when the
   ship is catalogued), else a clearly labelled nominal profile.
   ============================================================ */

const R_E = 6371;              // km
const MU = 398600.4418;        // km^3/s^2
const OMEGA_E = 7.2921159e-5;  // rad/s
const D2R = Math.PI / 180;
const TZ = "Europe/Vienna";
const DAY = 86400;

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapLon = (l) => ((l + 540) % 360) - 180;

/* ---------------- nav (same as every inner page) ---------------- */
(function () {
  const nav = $("[data-nav]"), btn = $("[data-nav-btn]"), list = document.getElementById("nav-list");
  if (!nav || !btn || !list) return;
  const set = (open) => { nav.classList.toggle("is-open", open); btn.setAttribute("aria-expanded", open ? "true" : "false"); list.hidden = !open; };
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(!nav.classList.contains("is-open")); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
  document.addEventListener("click", (e) => { if (nav.classList.contains("is-open") && !nav.contains(e.target)) set(false); });
})();

/* ---------------- data: Launch Library 2 ---------------- */
const LL_HOSTS = ["https://ll.thespacedevs.com", "https://lldev.thespacedevs.com"];
const LL_CACHE = "starship.ll2.v2";
const LL_TTL = 30 * 60 * 1000;
const CT_CACHE = "starship.celestrak.v1";
const CT_TTL = 3 * 60 * 60 * 1000;

// Last-known data so the page still works offline / when rate-limited.
const BAKED = {
  previous: [{
    name: "Starship | Starlink Group 31-2 (Starship Flight 15)",
    net: "2026-11-13T22:47:36Z",
    status: { abbrev: "Success" },
    pad: { name: "Orbital Launch Pad 2", latitude: 25.99677, longitude: -97.15799, location: { name: "SpaceX Starbase, TX, USA" } },
    mission: { orbit: { abbrev: "LEO" }, description: "The ship is expected to fly at an altitude approximately 275 km above Earth and complete approximately 14 orbits around the planet for more than 22 hours, with the ship expected to attempt returning back to Starbase, Texas on its launch pad by pad arms catching." }
  }],
  upcoming: []
};

function readCache(key, ttl) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    if (v && v.ts) return { data: v.data, fresh: Date.now() - v.ts < ttl, ts: v.ts };
  } catch (e) {}
  return null;
}
function writeCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
}

async function fetchJSON(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchText(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchLL(path) {
  let err;
  for (const h of LL_HOSTS) {
    try { return await fetchJSON(h + path); } catch (e) { err = e; }
  }
  throw err;
}

const isStarship = (l) => /^starship\b/i.test(l.name || "") ||
  /starship/i.test(((l.rocket || {}).configuration || {}).name || "");

async function loadLaunches() {
  const c = readCache(LL_CACHE, LL_TTL);
  if (c && c.fresh) return { ...c.data, cached: true };
  try {
    const [up, prev] = await Promise.all([
      fetchLL("/2.3.0/launches/upcoming/?search=starship&limit=6&mode=normal"),
      fetchLL("/2.3.0/launches/previous/?search=starship&limit=3&mode=normal")
    ]);
    const data = {
      upcoming: (up.results || []).filter(isStarship).map(slim),
      previous: (prev.results || []).filter(isStarship).map(slim)
    };
    writeCache(LL_CACHE, data);
    return data;
  } catch (e) {
    if (c) return { ...c.data, stale: true };
    return { ...BAKED, offline: true };
  }
}

function slim(l) {
  const pad = l.pad || {};
  const m = l.mission || {};
  return {
    name: l.name, net: l.net, net_precision: (l.net_precision || {}).name || null,
    status: { abbrev: (l.status || {}).abbrev || "" },
    pad: { name: pad.name, latitude: +pad.latitude, longitude: +pad.longitude, location: { name: (pad.location || {}).name || "" } },
    mission: { orbit: { abbrev: (m.orbit || {}).abbrev || "" }, description: m.description || "" }
  };
}

/* ---------------- data: CelesTrak ---------------- */
async function loadCelestrak(flightNo) {
  if (!flightNo) return null;
  const key = CT_CACHE + "." + flightNo;
  const c = readCache(key, CT_TTL);
  if (c && c.fresh) return c.data;
  try {
    const sat = await fetchJSON("https://celestrak.org/satcat/records.php?NAME=STARSHIP-" + flightNo + "&FORMAT=json");
    const rec = Array.isArray(sat) ? sat.find((s) => String(s.OBJECT_NAME).toUpperCase() === "STARSHIP-" + flightNo) : null;
    let out = { rec: rec || null, gp: null };
    if (rec && !rec.DECAY_DATE) {
      try {
        const txt = await fetchText("https://celestrak.org/NORAD/elements/gp.php?CATNR=" + rec.NORAD_CAT_ID + "&FORMAT=TLE");
        const ln = txt.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        const l1 = ln.find((x) => x.startsWith("1 ")), l2 = ln.find((x) => x.startsWith("2 "));
        if (l1 && l2) out.gp = { tle1: l1, tle2: l2, INCLINATION: +l2.slice(8, 16), MEAN_MOTION: +l2.slice(52, 63) };
      } catch (e) {}
    }
    writeCache(key, out);
    return out;
  } catch (e) {
    return c ? c.data : null;
  }
}

/* ---------------- mission model ---------------- */
function parseMission(l) {
  const name = String(l.name || "Starship");
  const after = (name.split("|").slice(1).join("|").trim() || name).replace(/^spacex\s+/i, "");
  const fm = name.match(/flight\s*(\d+)/i);
  const flightNo = fm ? +fm[1] : null;
  const title = flightNo ? "STARSHIP FLIGHT " + flightNo : ("STARSHIP · " + after).toUpperCase();
  const desc = (l.mission || {}).description || "";
  const orbitAbbrev = (((l.mission || {}).orbit || {}).abbrev || "").toUpperCase();
  const altM = desc.match(/altitude (?:of )?(?:approximately |about |around )?(\d{3})\s*km/i);
  const orbM = desc.match(/(?:approximately |about )?(\d{1,2})\s+orbits/i);
  const hrsM = desc.match(/for (?:more than |nearly |about |approximately |around )?(\d{1,2}(?:\.\d)?)\s*hours/i);
  const rtls = /back to (?:starbase|the launch site)|returning (?:the )?.{0,40}?(?:back )?to (?:the )?launch site|pad arms catching|catch(?:ing)? the ship/i.test(desc) && /ship/i.test(desc);
  const splM = desc.match(/splashdown (?:targeted |planned )?in (?:the )?([A-Za-z ,]+?)(?:\.|,|$)/i);
  const orbital = orbitAbbrev && orbitAbbrev !== "SUB" ? true : false;
  const pad = l.pad || {};
  return {
    raw: l,
    name: after,
    title,
    flightNo,
    net: new Date(l.net),
    netPrecision: l.net_precision,
    status: (l.status || {}).abbrev || "",
    padName: pad.name || "Starbase",
    site: ((pad.location || {}).name || "").replace(/,?\s*USA$/, ""),
    lat: isFinite(pad.latitude) ? +pad.latitude : 25.99677,
    lon: isFinite(pad.longitude) ? +pad.longitude : -97.15799,
    orbital,
    altKm: altM ? +altM[1] : null,
    orbits: orbM ? +orbM[1] : null,
    hours: hrsM ? +hrsM[1] : null,
    rtls: orbital && rtls,
    splash: splM ? splM[1].trim() : null
  };
}

/*
  Trajectory: a great circle (the orbit plane) through the pad, flown with a
  phase-dependent speed/altitude profile. Positions are integrated in the
  inertial frame and rotated into Earth-fixed coordinates.
*/
function buildTrajectory(m, ct) {
  const T_INS = 510;              // SECO ~T+8:30
  let incl, alt, tEnd, tEntry, kind, source, sourceDetail, gpRec = null;

  if (ct && ct.gp && window.satellite) {
    source = "celestrak";
    sourceDetail = "CelesTrak GP · SGP4";
    gpRec = ct.gp;
    incl = +ct.gp.INCLINATION;
    const n = +ct.gp.MEAN_MOTION * 2 * Math.PI / DAY;
    alt = Math.cbrt(MU / (n * n)) - R_E;
  } else if (ct && ct.rec && ct.rec.INCLINATION) {
    source = "celestrak";
    sourceDetail = "CelesTrak SATCAT · nominal timeline";
    incl = +ct.rec.INCLINATION;
    alt = ((+ct.rec.APOGEE || 0) + (+ct.rec.PERIGEE || 0)) / 2 || null;
  } else {
    source = "nominal";
    sourceDetail = "Nominal profile";
  }

  kind = m.orbital ? "orbit" : "sub";
  if (!alt) alt = m.altKm || (kind === "orbit" ? 275 : 190);
  if (!incl) incl = kind === "orbit" ? 30.5 : 26.5;
  incl = Math.max(incl, Math.abs(m.lat) + 0.4);

  const ENTRY_D = kind === "orbit" ? 1500 : 1110;
  const vOrb = Math.sqrt(MU / (R_E + alt)); // km/s
  const period = 2 * Math.PI * Math.sqrt(Math.pow(R_E + alt, 3) / MU);

  if (kind === "sub") {
    tEnd = 3930;      // ~T+1:05:30
  } else {
    let hrs = m.hours || (m.orbits ? m.orbits * period / 3600 : 1.6);
    tEnd = Math.round(hrs * 3600);
    if (m.hours && m.orbits) tEnd = Math.round(Math.max(m.hours * 3600, m.orbits * period));
  }

  // orbit geometry
  const i = incl * D2R;
  const latP = m.lat * D2R;
  const u0 = Math.PI - Math.asin(clamp(Math.sin(latP) / Math.sin(i), -1, 1)); // heading ESE
  const Om = m.lon * D2R - Math.atan2(Math.cos(i) * Math.sin(u0), Math.cos(u0));

  function geo(u, t) {
    const lat = Math.asin(Math.sin(i) * Math.sin(u));
    const lonI = Om + Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u));
    return [lat / D2R, wrapLon((lonI - OMEGA_E * t) / D2R)];
  }

  // speed (km/s) and altitude (km) by time
  const vCoastSub = 7.33;
  function profile(t, tEndL) {
    const tE = tEndL - ENTRY_D;
    if (t <= 0) return [0, 0, "PRE-LAUNCH"];
    if (t < T_INS) {
      const p = t / T_INS;
      const vTop = kind === "sub" ? vCoastSub : vOrb;
      const ph = t < 165 ? "BOOSTER ASCENT" : t < 175 ? "STAGE SEPARATION" : "SHIP ASCENT";
      return [vTop * Math.pow(p, 1.75), (kind === "sub" ? 150 : alt * 0.62) * (1 - Math.pow(1 - p, 1.9)), ph];
    }
    if (t < tE) {
      const q = (t - T_INS) / (tE - T_INS);
      if (kind === "sub") return [vCoastSub - 0.08 * Math.sin(Math.PI * q), 150 + 62 * Math.sin(Math.PI * q) - 30 * q, "COAST"];
      const a0 = alt * 0.62;
      const up = smooth(0, 1, (t - T_INS) / 900);
      const down = kind === "orbit" ? smooth(tE - 1200, tE, t) : 0;
      const a = lerp(a0, alt, up) - (alt - 120) * down + 1.5 * Math.sin(t / period * 2 * Math.PI);
      return [Math.sqrt(MU / (R_E + a)), a, down > 0.02 ? "DEORBIT" : "ORBIT"];
    }
    if (t <= tEndL) {
      const q = (t - tE) / ENTRY_D;
      const v0 = kind === "sub" ? vCoastSub - 0.08 : Math.sqrt(MU / (R_E + 120));
      const v = v0 * (1 - smooth(0.12, 0.82, q)) * (1 - 0.15 * q) + 0.09 * (1 - smooth(0.9, 1, q));
      const a = 120 * Math.pow(1 - q, 1.55);
      const ph = q < 0.15 ? "ENTRY INTERFACE" : q < 0.7 ? "PEAK HEATING" : q < 0.96 ? "BELLYFLOP" : (m.rtls ? "LANDING FLIP · CATCH" : "LANDING FLIP · SPLASHDOWN");
      return [Math.max(v, 0), a, ph];
    }
    return [0, 0, m.rtls ? "CAUGHT" : "SPLASHDOWN"];
  }

  // integrate downrange angle
  function integrate(tEndL, dt) {
    const n = Math.ceil(tEndL / dt) + 1;
    const th = new Float64Array(n);
    let acc = 0, prev = 0;
    for (let k = 1; k < n; k++) {
      const t = Math.min(k * dt, tEndL);
      const [v, a] = profile(t - dt / 2, tEndL);
      acc += (v / (R_E + a)) * (t - prev);
      prev = t;
      th[k] = acc;
    }
    return th;
  }

  // For return-to-launch-site missions pick the end time whose ground track
  // comes back over the pad, near the advertised mission length.
  let blend = null;
  if (kind === "orbit" && m.rtls) {
    let best = null;
    const base = tEnd;
    for (let cand = Math.max(base - 3600, T_INS + ENTRY_D + 600); cand <= base + 3 * 3600; cand += 20) {
      const th = integrate(cand, 20);
      const [la, lo] = geo(u0 + th[th.length - 1], cand);
      const d = Math.hypot(la - m.lat, wrapLon(lo - m.lon) * Math.cos(latP));
      const score = d + Math.abs(cand - base) / 3600 * 1.5;
      if (!best || score < best.score) best = { cand, score, la, lo };
    }
    tEnd = best.cand;
    blend = { dLat: m.lat - best.la, dLon: wrapLon(m.lon - best.lo) };
  }
  tEntry = tEnd - ENTRY_D;

  const DT = tEnd > 20000 ? 10 : 2;
  const th = integrate(tEnd, DT);
  const N = th.length;
  const lat = new Float32Array(N), lon = new Float32Array(N), altA = new Float32Array(N), spd = new Float32Array(N);
  let satrec = null;
  if (gpRec) {
    try {
      satrec = window.satellite.twoline2satrec(gpRec.tle1, gpRec.tle2);
    } catch (e) { satrec = null; }
  }
  const t0ms = m.net.getTime();
  for (let k = 0; k < N; k++) {
    const t = Math.min(k * DT, tEnd);
    let [v, a] = profile(t, tEnd);
    let [la, lo] = geo(u0 + th[k], t);
    if (blend) {
      const w = smooth(tEntry - 2400, tEnd, t);
      la += blend.dLat * w; lo = wrapLon(lo + blend.dLon * w);
    }
    if (satrec && t >= T_INS && t <= tEntry) {
      const s = sgp4At(satrec, new Date(t0ms + t * 1000));
      if (s) {
        const w = smooth(T_INS, T_INS + 600, t) * (1 - smooth(tEntry - 600, tEntry, t));
        la = lerp(la, s.lat, w); lo = wrapLon(lo + wrapLon(s.lon - lo) * w); a = lerp(a, s.alt, w); v = lerp(v, s.v, w);
      }
    }
    lat[k] = la; lon[k] = lo; altA[k] = a; spd[k] = v * 3600;
  }

  const events = [
    { t: 0, label: "LIFTOFF" },
    { t: T_INS, label: kind === "sub" ? "SECO" : "ORBIT" },
    { t: tEntry, label: "ENTRY" },
    { t: tEnd, label: m.rtls ? "CATCH" : "SPLASH" }
  ];

  return {
    kind, source, sourceDetail, incl, period, altCoast: alt, tEnd, tEntry, DT, N, lat, lon, alt: altA, spd, events,
    maxAlt: Math.max(...altA), phaseAt: (t) => profile(clamp(t, -1, tEnd + 1), tEnd)[2],
    sample(t) {
      if (t <= 0) return { lat: m.lat, lon: m.lon, alt: 0, spd: 0, k: 0 };
      if (t >= tEnd) return { lat: lat[N - 1], lon: lon[N - 1], alt: 0, spd: 0, k: N - 1 };
      const f = t / DT, k = Math.floor(f), w = f - k, k2 = Math.min(k + 1, N - 1);
      return {
        lat: lerp(lat[k], lat[k2], w),
        lon: wrapLon(lon[k] + wrapLon(lon[k2] - lon[k]) * w),
        alt: lerp(altA[k], altA[k2], w),
        spd: lerp(spd[k], spd[k2], w),
        k: f
      };
    }
  };
}

function sgp4At(satrec, date) {
  try {
    const sat = window.satellite;
    const pv = sat.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const g = sat.eciToGeodetic(pv.position, sat.gstime(date));
    const v = pv.velocity;
    return { lat: g.latitude / D2R, lon: wrapLon(g.longitude / D2R), alt: g.height, v: Math.hypot(v.x, v.y, v.z) };
  } catch (e) { return null; }
}

/* ---------------- sun ---------------- */
function sunDir(date) {
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

function ll2v(latDeg, lonDeg, r, out) {
  const la = latDeg * D2R, lo = lonDeg * D2R;
  const v = out || new THREE.Vector3();
  return v.set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

/* ---------------- three.js scene ---------------- */
const canvas = $("[data-gl]");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
renderer.setClearColor(0x000000, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.autoClear = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 200);
const miniCam = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
camera.layers.enable(1);
miniCam.layers.set(0);

const loader = new THREE.TextureLoader();
const maxTex = renderer.capabilities.maxTextureSize;
const earthTex = loader.load(maxTex >= 4096 ? "./assets/earth-mono-4k.jpg" : "./assets/earth-mono-2k.jpg");
earthTex.colorSpace = THREE.SRGBColorSpace;
earthTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const uSun = { value: new THREE.Vector3(1, 0, 0) };
const earthMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: earthTex }, sun: uSun },
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
    uniform sampler2D map; uniform vec3 sun;
    varying vec2 vUv; varying vec3 vN; varying vec3 vView;
    void main() {
      vec3 c = texture2D(map, vUv).rgb;
      c = pow(c, vec3(2.2));
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, 0.85);
      float facing = clamp(dot(vN, vView), 0.0, 1.0);
      float limb = 0.5 + 0.5 * pow(facing, 0.5);
      float sd = dot(vN, normalize(sun));
      float day = 0.6 + 0.4 * smoothstep(-0.2, 0.25, sd);
      float land = smoothstep(0.03, 0.09, l);
      vec3 col = c * limb * day * mix(1.0, 1.22, land);
      col += vec3(0.010, 0.017, 0.032) * limb * day * (1.0 - land);
      float rim = pow(1.0 - facing, 4.0);
      col += vec3(0.5, 0.62, 0.8) * rim * 0.09;
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
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(clamp(1.0 + dot(vN, vV) * 1.0, 0.0, 1.0), 5.0); gl_FragColor = vec4(vec3(0.6,0.7,0.88) * f * 0.42, 1.0); }`
  })
);
scene.add(atmo);

// stars (main view only)
(function stars() {
  const n = 2400, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let s = 1337;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < n; k++) {
    const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = 60;
    const q = Math.sqrt(1 - u * u);
    pos.set([r * q * Math.cos(a), r * u, r * q * Math.sin(a)], k * 3);
    const b = 0.18 + Math.pow(rnd(), 6) * 0.75;
    col.set([b, b, b * 1.05], k * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
  p.layers.set(1);
  scene.add(p);
})();

// ground track: one line, alpha computed per vertex from its mission time
const LIFT = 1.0025;
const uTrack = { now: { value: 0 }, trail: { value: 1e9 }, lead: { value: 1e9 }, started: { value: 0 } };
const trackMat = new THREE.ShaderMaterial({
  uniforms: uTrack, transparent: true, depthWrite: false,
  vertexShader: `attribute float tt; varying float vT; void main(){ vT = tt; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform float now; uniform float trail; uniform float lead; uniform float started; varying float vT;
    void main(){
      float d = now - vT; float a;
      if (d >= 0.0) a = started * 0.95 * (1.0 - smoothstep(trail * 0.55, trail, d));
      else a = 0.17 * (1.0 - smoothstep(lead * 0.5, lead, -d));
      if (a < 0.003) discard;
      gl_FragColor = vec4(1.0, 1.0, 1.0, a);
    }`
});
let trackLine = null, trackCount = 0;
function buildTrack(traj) {
  if (trackLine) { scene.remove(trackLine); trackLine.geometry.dispose(); }
  const step = Math.max(1, Math.round(traj.N / 8000));
  const pts = [];
  for (let k = 0; k < traj.N; k += step) pts.push(k);
  if (pts[pts.length - 1] !== traj.N - 1) pts.push(traj.N - 1);
  trackCount = pts.length;
  const pos = new Float32Array(trackCount * 3), tt = new Float32Array(trackCount);
  const v = new THREE.Vector3();
  pts.forEach((k, j) => {
    ll2v(traj.lat[k], traj.lon[k], LIFT + traj.alt[k] / R_E * 0.6, v);
    pos.set([v.x, v.y, v.z], j * 3);
    tt[j] = Math.min(k * traj.DT, traj.tEnd);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("tt", new THREE.BufferAttribute(tt, 1));
  trackLine = new THREE.Line(g, trackMat);
  trackLine.renderOrder = 2;
  trackLine.frustumCulled = false;
  scene.add(trackLine);
  const long = traj.kind === "orbit" && traj.tEnd > traj.period * 1.6;
  uTrack.trail.value = long ? traj.period * 0.85 : 1e9;
  uTrack.lead.value = long ? traj.period * 0.45 : 1e9;
}

// pad marker (small cross)
const padDot = new THREE.Mesh(new THREE.RingGeometry(0.006, 0.0095, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
scene.add(padDot);

/* ---------------- camera controls ---------------- */
const ctl = {
  lat: 10, lon: 10, dist: 3.6, tLat: 10, tLon: 10, tDist: 3.6,
  vLat: 0, vLon: 0, follow: true, dragging: false, minD: 1.45, maxD: 9, fitD: 3.6
};
const pointers = new Map();
let pinch0 = null, last = null, lastMoveT = 0;

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  ctl.dragging = true; ctl.vLat = ctl.vLon = 0;
  canvas.classList.add("is-drag");
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: ctl.tDist };
  }
  last = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size >= 2 && pinch0) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    ctl.tDist = clamp(pinch0.dist * pinch0.d / Math.max(d, 1), ctl.minD, ctl.maxD);
    return;
  }
  if (!last) return;
  const dx = e.clientX - last.x, dy = e.clientY - last.y;
  const now = performance.now(), dt = Math.max(now - last.t, 1);
  const k = degPerPx();
  if (Math.abs(dx) + Math.abs(dy) > 2) setFollow(false);
  ctl.tLon -= dx * k; ctl.tLat = clamp(ctl.tLat + dy * k, -85, 85);
  ctl.lon = ctl.tLon; ctl.lat = ctl.tLat;
  ctl.vLon = -dx * k / dt * 16; ctl.vLat = dy * k / dt * 16;
  last = { x: e.clientX, y: e.clientY, t: now };
  lastMoveT = now;
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch0 = null;
  if (pointers.size === 0) {
    ctl.dragging = false; canvas.classList.remove("is-drag");
    if (performance.now() - lastMoveT > 80) ctl.vLat = ctl.vLon = 0;
    last = null;
  } else {
    const p = [...pointers.values()][0]; last = { x: p.x, y: p.y, t: performance.now() };
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  ctl.tDist = clamp(ctl.tDist * Math.exp(e.deltaY * 0.0012), ctl.minD, ctl.maxD);
}, { passive: false });
canvas.addEventListener("dblclick", () => setFollow(true));

function degPerPx() {
  const h = canvas.clientHeight || 800;
  // visible arc per pixel shrinks as we zoom in
  return (ctl.dist - 1) / ctl.fitD * 120 / h * 1.15 + 0.01;
}

const followBtn = $("[data-follow]");
function setFollow(on) {
  ctl.follow = on;
  followBtn.hidden = on;
}
followBtn.addEventListener("click", () => { setFollow(true); ctl.tDist = ctl.fitD; });

/* ---------------- layout ---------------- */
const hud = $("[data-hud]");
const miniEl = $("[data-mini]");
let W = 0, H = 0, globeArea = { top: 0, bottom: 0 };
function layout() {
  W = window.innerWidth; H = window.innerHeight;
  renderer.setSize(W, H, false);
  const hudTop = hud.getBoundingClientRect().top;
  const top = Math.min(80, H * 0.09);
  const areaH = Math.max(hudTop - top, H * 0.35);
  const cy = top + areaH / 2;
  // globe radius on screen: fit inside area
  const rPx = Math.min(areaH * 0.44, W * 0.45);
  camera.aspect = W / H;
  // shift projection so the globe is centred in the free area
  camera.setViewOffset(W, H, 0, (H / 2 - cy), W, H);
  // distance so that the globe has radius rPx
  const f = H / 2 / Math.tan(camera.fov * D2R / 2);
  const ang = Math.atan(rPx / f);
  ctl.fitD = 1 / Math.sin(ang);
  if (!layout.done) { ctl.dist = ctl.tDist = ctl.fitD; layout.done = true; }
  ctl.maxD = ctl.fitD * 2.4;
  camera.updateProjectionMatrix();
  globeArea = { cx: W / 2, cy, top, areaH };
  followBtn.style.top = (top + 8) + "px";
  followBtn.style.top = "auto";
  followBtn.style.bottom = (H - hudTop + 12) + "px";
}
window.addEventListener("resize", layout);
window.addEventListener("orientationchange", () => setTimeout(layout, 250));

/* ---------------- HUD ---------------- */
const el = {
  speed: $("[data-speed]"), alt: $("[data-alt]"),
  sign: $("[data-sign]"), clock: $("[data-clock]"), zone: $("[data-zone]"),
  mission: $("[data-mission]"), phase: $("[data-phase]"),
  kind: $("[data-kind]"), net: $("[data-net]"), pad: $("[data-pad]"), src: $("[data-src]"), srcDot: $("[data-src-dot]"), other: $("[data-other]"),
  range: $("[data-range]"), ticks: $("[data-ticks]"), play: $("[data-play]"), playIcon: $("[data-play-icon]"), rate: $("[data-rate]"),
  now: $("[data-now]"), mode: $("[data-mode]"), marker: $("[data-marker]"), ring: $("[data-ring]"), ship: $("[data-ship]"), toast: $("[data-toast]")
};

// gauge arcs: 270° sweep, opening at bottom
const G_START = 135, G_SWEEP = 270;
function arcPath(frac) {
  const r = 46, cx = 50, cy = 50;
  const a0 = G_START * D2R, a1 = (G_START + G_SWEEP * clamp(frac, 0, 1)) * D2R;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = G_SWEEP * frac > 180 ? 1 : 0;
  if (frac <= 0.0005) return "";
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
document.querySelectorAll(".gauge .g-track").forEach((p) => p.setAttribute("d", arcPath(1)));
const gFill = { speed: $('[data-gauge="speed"] .g-fill'), alt: $('[data-gauge="alt"] .g-fill') };

const pad2 = (n) => String(n).padStart(2, "0");
function fmtDur(s) {
  s = Math.floor(Math.abs(s));
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  if (d >= 2) return `${d}D ${pad2(h)}:${pad2(m)}:${pad2(x)}`;
  return `${pad2(h + d * 24)}:${pad2(m)}:${pad2(x)}`;
}
const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const fmtDate = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const fmtDateTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function zoneAbbr(d) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" }).formatToParts(d).find((x) => x.type === "timeZoneName");
    const v = p ? p.value : "";
    if (/^GMT\+1$/.test(v)) return "CET";
    if (/^GMT\+2$/.test(v)) return "CEST";
    return v || "CET";
  } catch (e) { return "CET"; }
}
function fmtNet(m) {
  const p = (m.netPrecision || "").toUpperCase();
  if (/MONTH/.test(p)) return "NET " + new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "short", year: "numeric" }).format(m.net);
  if (/QUARTER/.test(p)) return "NET Q" + (Math.floor(m.net.getUTCMonth() / 3) + 1) + " " + m.net.getUTCFullYear();
  if (/HALF/.test(p)) return "NET H" + (m.net.getUTCMonth() < 6 ? 1 : 2) + " " + m.net.getUTCFullYear();
  if (/YEAR/.test(p)) return "NET " + m.net.getUTCFullYear();
  if (/DAY/.test(p)) return "NET " + fmtDate.format(m.net);
  return fmtDateTime.format(m.net) + " " + zoneAbbr(m.net);
}

/* ---------------- state ---------------- */
const S = {
  data: null, mission: null, traj: null, which: "auto",
  t: 0, live: false, playing: false, rate: 1, mode: "mission", lastFrame: performance.now()
};
const T_PRE = -1800;

function rangeMin() { return T_PRE; }
function rangeMax() { return S.traj ? S.traj.tEnd + 300 : 3600; }
function realT() { return S.mission ? (Date.now() - S.mission.net.getTime()) / 1000 : 0; }

function setT(t, fromSlider) {
  S.t = clamp(t, rangeMin(), rangeMax());
  if (!fromSlider) el.range.value = String(Math.round(S.t - rangeMin()));
  el.range.style.setProperty("--p", ((S.t - rangeMin()) / (rangeMax() - rangeMin()) * 100).toFixed(3) + "%");
}

el.range.addEventListener("input", () => {
  S.live = false; el.now.classList.remove("is-on");
  setT(rangeMin() + +el.range.value, true);
});
el.play.addEventListener("click", () => {
  S.playing = !S.playing;
  if (S.playing && S.t >= rangeMax() - 1) setT(rangeMin());
  syncButtons();
});
el.rate.addEventListener("click", () => {
  S.rate = S.rate === 1 ? 60 : 1;
  if (S.live && S.rate !== 1) { S.live = false; }
  syncButtons();
});
el.now.addEventListener("click", () => {
  S.live = true; S.playing = true; S.rate = 1;
  setT(realT());
  const rt = realT();
  if (rt > rangeMax()) toast("Mission ended " + fmtDur(rt - S.traj.tEnd) + " ago");
  else if (rt < rangeMin()) toast("Launch in " + fmtDur(-rt));
  setFollow(true);
  syncButtons();
});
el.mode.addEventListener("click", () => {
  S.mode = S.mode === "mission" ? "local" : "mission";
  try { localStorage.setItem("starship.mode", S.mode); } catch (e) {}
  syncButtons();
});
el.other.addEventListener("click", () => {
  S.which = S.which === "next" || (S.which === "auto" && S.autoPick === "next") ? "latest" : "next";
  applyMission();
});
document.addEventListener("keydown", (e) => {
  if (e.target && e.target.tagName === "INPUT" && e.key !== " ") return;
  if (e.key === " ") { e.preventDefault(); el.play.click(); }
  else if (e.key === "ArrowRight") { S.live = false; setT(S.t + (e.shiftKey ? 600 : 60)); }
  else if (e.key === "ArrowLeft") { S.live = false; setT(S.t - (e.shiftKey ? 600 : 60)); }
});

function syncButtons() {
  el.playIcon.setAttribute("d", S.playing ? "M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" : "M8 5.5v13l11-6.5z");
  el.play.setAttribute("aria-label", S.playing ? "Pause" : "Play");
  el.rate.textContent = S.rate + "×";
  el.rate.classList.toggle("is-on", S.rate !== 1);
  el.now.classList.toggle("is-on", S.live);
  el.mode.textContent = S.mode === "mission" ? "T+" : "CET";
  el.mode.textContent = S.mode === "mission" ? "T+" : zoneAbbr(new Date());
  el.mode.classList.toggle("is-on", S.mode === "local");
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function buildTicks() {
  el.ticks.innerHTML = "";
  const a = rangeMin(), b = rangeMax();
  let lastPct = -100;
  for (const ev of S.traj.events) {
    const s = document.createElement("span");
    const pct = (ev.t - a) / (b - a) * 100;
    s.style.left = pct.toFixed(3) + "%";
    const em = document.createElement("em"); em.textContent = ev.label;
    if (pct - lastPct > 7) { s.appendChild(em); lastPct = pct; }
    el.ticks.appendChild(s);
  }
  el.range.max = String(Math.round(b - a));
}

/* ---------------- mission selection ---------------- */
async function boot() {
  layout();
  try { const m = localStorage.getItem("starship.mode"); if (m === "local" || m === "mission") S.mode = m; } catch (e) {}
  const q = new URLSearchParams(location.search);
  if (q.get("mission") === "next" || q.get("mission") === "latest") S.which = q.get("mission");
  syncButtons();
  S.data = await loadLaunches();
  await applyMission(q.has("t") ? +q.get("t") : null);
  requestAnimationFrame(frame);
}

function pickLaunch() {
  const up = (S.data.upcoming || []).filter((l) => new Date(l.net).getTime() > Date.now() - 6 * 3600e3)
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const prev = (S.data.previous || []).slice().sort((a, b) => new Date(b.net) - new Date(a.net));
  const next = up[0] || null, latest = prev[0] || null;
  let auto = "latest";
  if (next && (!latest || new Date(next.net).getTime() - Date.now() < 45 * DAY * 1000)) auto = "next";
  if (!latest) auto = "next";
  if (!next) auto = "latest";
  S.autoPick = auto;
  const which = S.which === "auto" ? auto : S.which;
  const chosen = which === "next" ? (next || latest) : (latest || next);
  return { chosen, which: chosen === next ? "next" : "latest", next, latest };
}

async function applyMission(tParam) {
  const p = pickLaunch();
  if (!p.chosen) { el.kind.textContent = "No Starship data"; return; }
  const m = parseMission(p.chosen);
  S.mission = m;
  el.kind.textContent = (p.which === "next" ? "Next launch" : "Latest flight") + (m.status && p.which === "next" ? " · " + m.status : "");
  el.mission.textContent = m.title;
  el.net.textContent = fmtNet(m);
  el.pad.textContent = (m.site && /starbase/i.test(m.site) ? "Starbase" : (m.site || "")) + (m.padName ? " · " + m.padName : "");
  const other = p.which === "next" ? p.latest : p.next;
  if (other) {
    const om = parseMission(other);
    el.other.hidden = false;
    el.other.textContent = (p.which === "next" ? "Latest: " : "Next: ") + (om.flightNo ? "Flight " + om.flightNo : om.name.replace(/^spacex\s+/i, "")) + " · " + (p.which === "next" ? fmtDate.format(om.net) : fmtNet(om).replace(/^NET /, "NET "));
  } else el.other.hidden = true;

  el.src.textContent = "Nominal profile";
  S.traj = buildTrajectory(m, null);
  buildTrack(S.traj); buildTicks();
  ll2v(m.lat, m.lon, 1.0008, padDot.position); padDot.lookAt(padDot.position.clone().multiplyScalar(2));
  setSource();
  startTime(tParam, p.which);

  // CelesTrak (async, non-blocking)
  const ct = await loadCelestrak(m.flightNo);
  if (S.mission === m && ct && (ct.gp || ct.rec)) {
    S.traj = buildTrajectory(m, ct);
    buildTrack(S.traj); buildTicks(); setSource(); setT(S.t);
  }
}

function setSource() {
  const tr = S.traj;
  el.src.textContent = tr.source === "celestrak" ? tr.sourceDetail : "Nominal profile · not live data";
  el.srcDot.classList.toggle("is-live", tr.source === "celestrak");
}

function startTime(tParam, which) {
  const rt = realT();
  if (tParam != null && isFinite(tParam)) { S.live = false; S.playing = false; setT(tParam); }
  else if (rt >= rangeMin() && rt <= rangeMax()) { S.live = true; S.playing = true; setT(rt); }
  else if (which === "next") { S.live = true; S.playing = true; setT(rt); }
  else {
    // past mission: open on a nice mid-flight moment (ship over Africa)
    let tt = Math.min(1800, S.traj.tEnd * 0.5);
    for (let k = 0; k < S.traj.N; k++) {
      const la = S.traj.lat[k], lo = S.traj.lon[k];
      if (lo > 18 && lo < 40 && la > -15 && la < 8 && k * S.traj.DT > 600) { tt = k * S.traj.DT; break; }
    }
    S.live = false; S.playing = false; setT(tt);
  }
  const s = S.traj.sample(clamp(S.t, 0, S.traj.tEnd));
  ctl.lat = ctl.tLat = clamp(s.lat + 6, -60, 60); ctl.lon = ctl.tLon = s.lon - 10;
  syncButtons();
}

/* ---------------- frame ---------------- */
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), camDir = new THREE.Vector3();
let lastSec = -1;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - S.lastFrame) / 1000, 0.1);
  S.lastFrame = now;

  // time
  let dispT = S.t;
  if (S.live) { dispT = realT(); setT(dispT); }
  else if (S.playing) {
    setT(S.t + dt * S.rate);
    dispT = S.t;
    if (S.t >= rangeMax()) { S.playing = false; syncButtons(); }
  }
  const tr = S.traj, m = S.mission;
  const tc = clamp(S.t, 0, tr.tEnd);
  const s = tr.sample(tc);

  // camera
  if (!ctl.dragging) {
    if (Math.abs(ctl.vLon) + Math.abs(ctl.vLat) > 0.001) {
      ctl.tLon += ctl.vLon; ctl.tLat = clamp(ctl.tLat + ctl.vLat, -85, 85);
      const decay = Math.pow(0.9, dt * 60);
      ctl.vLon *= decay; ctl.vLat *= decay;
    } else if (ctl.follow) {
      const wantLat = clamp(s.lat + 4, -70, 70), wantLon = s.lon - 6;
      const k = 1 - Math.pow(0.04, dt);
      ctl.tLat += (wantLat - ctl.tLat) * k;
      ctl.tLon += wrapLon(wantLon - ctl.tLon) * k;
    }
  }
  const kz = 1 - Math.pow(0.0005, dt);
  ctl.dist += (ctl.tDist - ctl.dist) * kz;
  ctl.lat += (ctl.tLat - ctl.lat) * (ctl.dragging ? 1 : kz);
  ctl.lon += wrapLon(ctl.tLon - ctl.lon) * (ctl.dragging ? 1 : kz);
  ll2v(ctl.lat, ctl.lon, ctl.dist, camera.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // sun at the displayed instant
  const simDate = new Date(m.net.getTime() + S.t * 1000);
  uSun.value.copy(sunDir(simDate));

  const vNow = ll2v(s.lat, s.lon, LIFT + s.alt / R_E * 0.6, tmpV);
  uTrack.now.value = tc; uTrack.started.value = S.t > 0 ? 1 : 0;

  // render main
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.clear();
  renderer.render(scene, camera);

  // mini globe (always centred on the ship)
  const r = miniEl.getBoundingClientRect();
  if (r.width > 4) {
    ll2v(s.lat, s.lon, 4.2, miniCam.position); miniCam.up.set(0, 1, 0); miniCam.lookAt(0, 0, 0);
    miniCam.aspect = 1; miniCam.updateProjectionMatrix();
    const y = H - r.bottom;
    renderer.setScissorTest(true);
    renderer.setScissor(r.left, y, r.width, r.height);
    renderer.setViewport(r.left, y, r.width, r.height);
    renderer.clearDepth();
    renderer.render(scene, miniCam);
    renderer.setScissorTest(false);
  }

  // marker
  camera.updateMatrixWorld();
  tmpV2.copy(vNow).project(camera);
  const sx = (tmpV2.x * 0.5 + 0.5) * W, sy = (-tmpV2.y * 0.5 + 0.5) * H;
  camDir.copy(camera.position).normalize();
  const visible = vNow.clone().normalize().dot(camDir) > 1 / ctl.dist - 0.02 || s.alt > 60 && vNow.clone().normalize().dot(camDir) > 0.6 / ctl.dist;
  el.marker.hidden = false;
  el.marker.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
  el.marker.classList.toggle("is-behind", !visible);
  // marker icon heading: direction of travel on screen
  const ahead = tr.sample(Math.min(tc + 30, tr.tEnd));
  const va = ll2v(ahead.lat, ahead.lon, LIFT, new THREE.Vector3()).project(camera);
  const hx = (va.x * 0.5 + 0.5) * W - sx, hy = (-va.y * 0.5 + 0.5) * H - sy;
  const head = (Math.hypot(hx, hy) > 0.5 && S.t > 0 && S.t < tr.tEnd) ? Math.atan2(hx, -hy) / D2R : 0;
  el.marker.firstElementChild.style.transform = `rotate(${head.toFixed(1)}deg)`;

  // faint ring around the globe
  const c0 = new THREE.Vector3(0, 0, 0).project(camera);
  const cx = (c0.x * 0.5 + 0.5) * W, cy = (-c0.y * 0.5 + 0.5) * H;
  const fpx = H / 2 / Math.tan(camera.fov * D2R / 2);
  const rpx = fpx * Math.tan(Math.asin(1 / ctl.dist));
  el.ring.setAttribute("cx", cx.toFixed(1)); el.ring.setAttribute("cy", cy.toFixed(1)); el.ring.setAttribute("r", (rpx * 1.16).toFixed(1));

  // HUD (throttle text work)
  const sec = Math.floor(dispT);
  const kmh = Math.round(s.spd), km = Math.round(s.alt);
  el.speed.textContent = String(kmh);
  el.alt.textContent = String(km);
  gFill.speed.setAttribute("d", arcPath(kmh / 30000));
  gFill.alt.setAttribute("d", arcPath(km / Math.max(300, tr.maxAlt * 1.1)));
  if (sec !== lastSec || !S.playing) {
    lastSec = sec;
    if (S.mode === "mission") {
      el.sign.textContent = dispT < 0 ? "T−" : "T+";
      el.clock.textContent = fmtDur(dispT);
      el.zone.hidden = true;
    } else {
      const d = new Date(m.net.getTime() + dispT * 1000);
      el.sign.textContent = "";
      el.clock.textContent = fmtTime.format(d);
      el.zone.hidden = false;
      el.zone.textContent = zoneAbbr(d);
    }
    const phase = S.t < 0 ? (S.live && dispT < rangeMin() ? "COUNTDOWN" : "PRE-LAUNCH") : tr.phaseAt(S.t);
    el.phase.textContent = S.mode === "local" ? (phase + " · " + (dispT < 0 ? "T−" : "T+") + fmtDur(dispT) + " · " + fmtDate.format(new Date(m.net.getTime() + dispT * 1000)).toUpperCase()) : phase;
  }
  // attitude (nose-up degrees): ascent pitches over, coast level, entry belly-first, flip to land
  let noseUp;
  if (S.t <= 0) noseUp = 90;
  else if (S.t < 510) noseUp = 90 - 85 * smooth(0, 510, S.t);
  else if (S.t < tr.tEntry) noseUp = 0;
  else if (S.t < tr.tEnd - 25) noseUp = 40 * smooth(tr.tEntry, tr.tEntry + 240, S.t) - 40 * smooth(tr.tEnd - 420, tr.tEnd - 120, S.t);
  else noseUp = 90 * smooth(tr.tEnd - 25, tr.tEnd - 10, S.t);
  const pitch = noseUp;
  el.ship.style.transform = `rotate(${pitch.toFixed(1)}deg)`;
}

layout();
boot().catch((e) => { console.error(e); el.kind.textContent = "Could not load"; });
