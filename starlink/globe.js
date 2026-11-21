import * as THREE from "/vendor/three.module.min.js";
import { addEarth, sunDir, ll2v, R_E, D2R } from "../spacex/globe-core.js?v=g3";

/* ============================================================
   Starlink · globe tab
   Same Earth as /spacex/ (shared globe-core.js). Every Starlink
   in orbit from the daily Celestrak GP dump (./gp.json), SGP4 in
   the browser. Shells come from ./sats.json (same as the chart).
   SGP4 runs at keyframes 10 s apart (spread over frames); the
   vertex shader blends the two keyframes and turns ECI into the
   Earth-fixed frame, so the main thread stays nearly idle.
   ============================================================ */

const STEP = 10000;               // ms between SGP4 keyframes
const MAX_AGE_D = 30;             // elements older than this: treat as gone
const MIN_ALT = 150;              // km; below this it is re-entering
const OPEN_KEY = "starlink.globe.open.v1";
const GREY = "#a3abb8";
const RAISING = "other";
const RAISING_COLOR = "#8a94a6";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapLon = (l) => ((((l + 180) % 360) + 360) % 360) - 180;

/* ---------- OMM row -> TLE (satellite.js 5 has no sgp4init export) ---------- */
function checksum(line) {
  let s = 0;
  for (let i = 0; i < 68; i++) { const c = line.charAt(i); if (c === "-") s += 1; else if (c >= "0" && c <= "9") s += c.charCodeAt(0) - 48; }
  return String(s % 10);
}
function put(arr, col, str) { const s = String(str); for (let i = 0; i < s.length && col - 1 + i < 68; i++) arr[col - 1 + i] = s.charAt(i); }
function norad5(id) {
  id |= 0;
  if (id < 100000) return ("00000" + id).slice(-5);
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ", li = Math.floor(id / 10000) - 10;
  if (li < 0 || li >= letters.length) return "99999";
  return letters.charAt(li) + ("0000" + (id % 10000)).slice(-4);
}
function epochMs(iso) { let s = String(iso || "").trim(); if (!/[zZ]|[+-]\d\d:\d\d$/.test(s)) s += "Z"; return new Date(s).getTime(); }
function epochField(ms) {
  const d = new Date(ms), y = d.getUTCFullYear();
  const doy = (ms - Date.UTC(y, 0, 1)) / 864e5 + 1, yy = y % 100, whole = Math.floor(doy);
  return (yy < 10 ? "0" : "") + yy + ("00" + whole).slice(-3) + "." + (doy - whole).toFixed(8).slice(2);
}
function ndotField(n) { if (!n) return " .00000000"; let s = Math.abs(n).toFixed(8); if (s.charAt(0) === "0") s = s.slice(1); return ((n < 0 ? "-" : " ") + s).slice(0, 10); }
function sci8(v) {
  if (!v || !isFinite(v) || Math.abs(v) < 1e-16) return " 00000-0";
  const a = Math.abs(v); let exp = Math.floor(Math.log10(a) + 1e-14) + 1, dg = Math.round(a / Math.pow(10, exp) * 1e5);
  if (dg >= 100000) { dg = 10000; exp += 1; }
  return (v < 0 ? "-" : " ") + ("00000" + dg).slice(-5) + (exp < 0 ? "-" : "+") + Math.abs(exp);
}
const ang8 = (d) => ("        " + ((((+d) % 360) + 360) % 360).toFixed(4)).slice(-8);
function rowToSatrec(r, ep) {
  const [, id, , mm, ecc, inc, raan, argp, ma, bstar, ndot] = r;
  const a = new Array(68).fill(" "), b = new Array(68).fill(" "), cat = norad5(id);
  put(a, 1, "1"); put(a, 3, cat); put(a, 8, "U"); put(a, 10, "00000A  "); put(a, 19, epochField(ep));
  put(a, 34, ndotField(ndot)); put(a, 45, " 00000-0"); put(a, 54, sci8(bstar)); put(a, 63, "0"); put(a, 65, " 999");
  put(b, 1, "2"); put(b, 3, cat); put(b, 9, ang8(inc)); put(b, 18, ang8(raan));
  put(b, 27, ("0000000" + Math.round(Math.abs(ecc) * 1e7)).slice(-7)); put(b, 35, ang8(argp)); put(b, 44, ang8(ma));
  put(b, 53, ("           " + Number(mm).toFixed(8)).slice(-11)); put(b, 64, "    0");
  const l1 = a.join(""), l2 = b.join("");
  const rec = window.satellite.twoline2satrec(l1 + checksum(l1), l2 + checksum(l2));
  return rec && !rec.error ? rec : null;
}

function loadSatelliteJs() {
  if (window.satellite) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "/vendor/satellite.min.js"; s.onload = () => res(); s.onerror = rej;
    document.head.appendChild(s);
  });
}
const idle = () => new Promise((r) => setTimeout(r, 0));

export function mountGlobe(opts) {
  const root = opts.root;
  const canvas = root.querySelector("[data-globe-gl]");
  const metaEl = root.querySelector("[data-globe-meta]");
  const shellsEl = root.querySelector("[data-globe-shells]");
  const hud = root.querySelector("[data-globe-hud]");

  /* ---------- scene (same globe as /spacex/) ---------- */
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 200);
  camera.layers.enable(1);
  const { uSun } = addEarth(renderer, scene);

  /* ---------- camera controls (drag / inertia / pinch / wheel, as on /spacex/) ---------- */
  const ctl = { lat: 25, lon: 15, tLat: 25, tLon: 15, dist: 3.6, tDist: 3.6, vLat: 0, vLon: 0, dragging: false, minD: 1.25, maxD: 9, fitD: 3.6 };
  const pointers = new Map();
  let pinch0 = null, last = null, lastMoveT = 0, multi = false, tap0 = null;
  const degPerPx = () => (ctl.dist - 1) / ctl.fitD * 120 / (canvas.clientHeight || 800) * 1.15 + 0.01;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    ctl.dragging = true; ctl.vLat = ctl.vLon = 0;
    if (pointers.size >= 2) multi = true;
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: ctl.tDist }; }
    last = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (pointers.size === 1) tap0 = { x: e.clientX, y: e.clientY, t: performance.now(), ok: true };
    else if (tap0) tap0.ok = false;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (tap0 && Math.hypot(e.clientX - tap0.x, e.clientY - tap0.y) > 8) tap0.ok = false;
    if (pointers.size >= 2 && pinch0) {
      const [a, b] = [...pointers.values()];
      ctl.tDist = clamp(pinch0.dist * pinch0.d / Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), ctl.minD, ctl.maxD);
      return;
    }
    if (!last) return;
    if (multi) { last = { x: e.clientX, y: e.clientY, t: performance.now() }; return; }
    const dx = e.clientX - last.x, dy = e.clientY - last.y, now = performance.now(), dt = Math.max(now - last.t, 1), k = degPerPx();
    ctl.tLon -= dx * k; ctl.tLat = clamp(ctl.tLat + dy * k, -85, 85);
    ctl.lon = ctl.tLon; ctl.lat = ctl.tLat;
    ctl.vLon = -dx * k / dt * 16; ctl.vLat = dy * k / dt * 16;
    last = { x: e.clientX, y: e.clientY, t: now }; lastMoveT = now;
  });
  function endPointer(e) {
    // a short, still, one-finger tap picks the nearest satellite (or clears the pick)
    if (e.type === "pointerup" && tap0 && tap0.ok && pointers.size === 1 && performance.now() - tap0.t < 600 &&
        Math.hypot(e.clientX - tap0.x, e.clientY - tap0.y) < 10) {
      ctl.vLat = ctl.vLon = 0; lastMoveT = 0;
      select(pickAt(e.clientX, e.clientY));
    }
    if (pointers.size <= 1) tap0 = null;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = null;
    if (pointers.size === 0) {
      ctl.dragging = false; multi = false;
      if (performance.now() - lastMoveT > 80) ctl.vLat = ctl.vLon = 0;
      last = null;
    } else { const p = [...pointers.values()][0]; last = { x: p.x, y: p.y, t: performance.now() }; }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); ctl.tDist = clamp(ctl.tDist * Math.exp(e.deltaY * 0.0012), ctl.minD, ctl.maxD); }, { passive: false });
  canvas.addEventListener("dblclick", () => { ctl.tDist = ctl.fitD; });

  let W = 0, H = 0;
  function layout() {
    W = window.innerWidth; H = window.innerHeight;
    if (!W || !H) return;
    renderer.setSize(W, H, false);
    const hr = hud.getBoundingClientRect();
    const side = hr.width && hr.left > W * 0.4; // landscape: HUD is a column on the right
    const hudTop = side ? H : (hr.top || H);
    const right = side ? hr.left : W;
    const top = side ? 0 : Math.min(64, H * 0.08);
    const areaH = Math.max(hudTop - top, H * 0.35);
    const cy = top + areaH / 2, cx = right / 2;
    // leave room for the shells (orbits reach ~1.09 R_E)
    const rPx = Math.min(areaH * 0.42, right * 0.43);
    camera.aspect = W / H;
    camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
    const f = H / 2 / Math.tan(camera.fov * D2R / 2);
    ctl.fitD = 1 / Math.sin(Math.atan(rPx / f));
    if (!layout.done) { ctl.dist = ctl.tDist = ctl.fitD; layout.done = true; }
    ctl.maxD = ctl.fitD * 2.4;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", () => { if (running) layout(); });
  window.addEventListener("orientationchange", () => setTimeout(() => { if (running) layout(); }, 250));

  /* ---------- satellites ---------- */
  const MAXSH = 32;
  const uMask = { value: new Float32Array(MAXSH).fill(1) };
  const uni = { u: { value: 0 }, gmst: { value: 0 }, size: { value: 2 * dpr }, mask: uMask, grey: { value: 0 }, greyCol: { value: new THREE.Color(GREY) } };
  const satMat = new THREE.ShaderMaterial({
    uniforms: uni, transparent: true, depthWrite: false, depthTest: true,
    vertexShader: `
      attribute vec3 p0; attribute vec3 p1; attribute vec3 tint; attribute float shell;
      uniform float u; uniform float gmst; uniform float size; uniform float mask[${MAXSH}]; uniform float grey; uniform vec3 greyCol;
      varying vec3 vC; varying float vA;
      void main() {
        float on = mask[int(shell + 0.5)];
        if (on < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; vC = vec3(0.0); return; }
        vec3 e = mix(p0, p1, u);                       // TEME, Earth radii
        float c = cos(gmst), s = sin(gmst);
        vec3 f = vec3(e.x * c + e.y * s, -e.x * s + e.y * c, e.z); // Earth-fixed
        vec3 w = vec3(f.x, f.z, -f.y);                 // scene frame (see ll2v)
        // always full brightness: no Earth-shadow or day/night dimming
        vA = 1.0;
        vC = mix(tint, greyCol, grey);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 1.0);
        gl_PointSize = size;
      }`,
    fragmentShader: `
      varying vec3 vC; varying float vA;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float r = dot(q, q) * 4.0;
        if (r > 1.0) discard;
        gl_FragColor = vec4(pow(vC, vec3(1.0 / 2.2)), vA * (1.0 - smoothstep(0.7, 1.0, r))); // linear -> sRGB, unlit
      }`
  });

  let names = [], ids = [], satShell = [], sel = -1;
  let N = 0, recs = [], P0, P1, PN, a0, a1, t0 = 0, t1 = 0, tN = 0, cursor = 0, points = null;
  let shells = [], counts = [];
  // shell visibility is shared with the Chart (and the URL), see StarlinkShells in index.html
  const SS = window.StarlinkShells;
  const off = { has: (id) => !SS.isOn(id) };

  function propInto(arr, i, date, fallback) {
    let pv = null;
    try { pv = window.satellite.propagate(recs[i], date); } catch (e) { pv = null; }
    const p = pv && pv.position;
    if (p && isFinite(p.x)) { arr[i * 3] = p.x / R_E; arr[i * 3 + 1] = p.y / R_E; arr[i * 3 + 2] = p.z / R_E; }
    else if (fallback) { arr[i * 3] = fallback[i * 3]; arr[i * 3 + 1] = fallback[i * 3 + 1]; arr[i * 3 + 2] = fallback[i * 3 + 2]; }
  }

  const INC_LABEL = { 43: "43°", 53: "53°", 70: "70°", 97: "97.6°" };
  const fmt = (n) => n.toLocaleString("en-US");
  const incOf = (inc) => shells.filter((s) => s.inc === inc && counts[shells.indexOf(s)] > 0);
  let openIncs = new Set();
  try { (JSON.parse(localStorage.getItem(OPEN_KEY) || "[]") || []).forEach((k) => openIncs.add(k)); } catch (e) { /* ignore */ }

  function applyMask() {
    shells.forEach((s, i) => { uMask.value[i] = off.has(s.id) ? 0 : 1; });
    let shown = 0;
    shells.forEach((s, i) => { if (!off.has(s.id)) shown += counts[i]; });
    shellsEl.querySelectorAll("[data-gshell]").forEach((b) => { b.checked = !off.has(b.getAttribute("data-gshell")); });
    const tri = (box, ids) => {
      const n = ids.filter((id) => !off.has(id)).length;
      box.checked = n === ids.length && n > 0; box.indeterminate = n > 0 && n < ids.length;
    };
    shellsEl.querySelectorAll("[data-ginc]").forEach((b) => tri(b, incOf(+b.getAttribute("data-ginc")).map((s) => s.id)));
    const all = shellsEl.querySelector("[data-gall]");
    if (all) tri(all, shells.filter((s, i) => counts[i] > 0).map((s) => s.id));
    metaEl.textContent = (shown === N ? fmt(N) + " Starlink satellites in orbit" : fmt(shown) + " of " + fmt(N) + " satellites shown") + " · " + dataNote;
    root.dataset.shown = String(shown);
    root.dataset.total = String(N);
  }
  let dataNote = "";

  // same pattern as the Chart tab: All, then one collapsible block per inclination
  function buildChips() {
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const incs = [...new Set(shells.filter((s) => s.inc != null).map((s) => s.inc))];
    let html = `<div class="g-top"><label class="chk all"><input type="checkbox" data-gall checked> All</label>` +
      `<label class="chk all colors"><input type="checkbox" data-colors> Colors</label></div>`;
    incs.forEach((inc) => {
      const group = incOf(inc);
      if (!group.length) return;
      const n = group.reduce((a, s) => a + counts[shells.indexOf(s)], 0);
      const rows = group.map((s) => `<label class="chk"><input type="checkbox" data-gshell="${esc(s.id)}" checked><span class="swatch" style="background:${esc(s.color)}"></span>` +
        `${s.km != null ? s.km + " km" : "orbit raising"} <em>${fmt(counts[shells.indexOf(s)])} satellites</em></label>`).join("");
      html += window.StarlinkIncBlock.html(inc, openIncs.has(String(inc)), `data-ginc="${inc}"`, INC_LABEL[inc] || inc + "°", fmt(n), rows);
    });
    const oi = shells.findIndex((s) => s.id === RAISING);
    if (oi >= 0 && counts[oi]) {
      html += `<div class="g-other"><label class="chk"><input type="checkbox" data-gshell="${RAISING}" checked><span class="swatch" style="background:${RAISING_COLOR}"></span>` +
        `Orbit raising / deorbiting <em>${fmt(counts[oi])} satellites</em></label></div>`;
    }
    shellsEl.innerHTML = html;
    window.StarlinkIncBlock.bind(shellsEl, (inc, open) => {
      open ? openIncs.add(inc) : openIncs.delete(inc);
      try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openIncs])); } catch (e) { /* ignore */ }
      layout();
    });
    shellsEl.addEventListener("change", (e) => {
      const b = e.target;
      if (b.hasAttribute("data-colors")) { opts.setColors(b.checked); return; }
      if (b.hasAttribute("data-gshell")) SS.set([b.getAttribute("data-gshell")], b.checked);
      else if (b.hasAttribute("data-ginc")) SS.set(incOf(+b.getAttribute("data-ginc")).map((s) => s.id), b.checked);
      else if (b.hasAttribute("data-gall")) SS.set(shells.map((s) => s.id), b.checked);
    });
    syncColors();
  }
  function syncColors() {
    const on = opts.colorsOn();
    uni.grey.value = on ? 0 : 1;
    const box = shellsEl.querySelector("[data-colors]");
    if (box) box.checked = on;
  }

  /* ---------- tap a satellite (same info as the Chart tab) ---------- */
  const pickEl = root.querySelector("[data-globe-pick]");
  const PICK_PX = 28;
  const wv = new THREE.Vector3(), pv3 = new THREE.Vector3();
  // current scene-frame position of sat i (same math as the vertex shader)
  function worldOf(i, out) {
    const u = uni.u.value, g = uni.gmst.value, c = Math.cos(g), s = Math.sin(g), k = i * 3;
    const x = P0[k] + (P1[k] - P0[k]) * u, y = P0[k + 1] + (P1[k + 1] - P0[k + 1]) * u, z = P0[k + 2] + (P1[k + 2] - P0[k + 2]) * u;
    return out.set(x * c + y * s, z, -(-x * s + y * c));
  }
  function hiddenByEarth(w) {
    const cam = camera.position, dx = w.x - cam.x, dy = w.y - cam.y, dz = w.z - cam.z, L = Math.hypot(dx, dy, dz);
    const b = (cam.x * dx + cam.y * dy + cam.z * dz) / L, c = cam.lengthSq() - 1, disc = b * b - c;
    if (disc <= 0) return false;
    const t = -b - Math.sqrt(disc);
    return t > 0 && t < L;
  }
  function pickAt(cx, cy) {
    if (!N) return -1;
    camera.updateMatrixWorld();
    let best = -1, bd = PICK_PX * PICK_PX;
    for (let i = 0; i < N; i++) {
      if (uMask.value[satShell[i]] < 0.5) continue;
      worldOf(i, wv);
      pv3.copy(wv).project(camera);
      if (pv3.z > 1) continue;
      const sx = (pv3.x * 0.5 + 0.5) * W, sy = (-pv3.y * 0.5 + 0.5) * H, d = (sx - cx) * (sx - cx) + (sy - cy) * (sy - cy);
      if (d < bd && !hiddenByEarth(wv)) { bd = d; best = i; }
    }
    return best;
  }
  const hiGeo = new THREE.BufferGeometry();
  hiGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
  const hiMat = new THREE.ShaderMaterial({
    uniforms: { size: { value: 22 * dpr } }, transparent: true, depthWrite: false, depthTest: true,
    vertexShader: `uniform float size; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = size; }`,
    fragmentShader: `void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(0.62, 0.72, r) * (1.0 - smoothstep(0.86, 0.96, r)) + (1.0 - smoothstep(0.18, 0.26, r));
      if (a < 0.01) discard; gl_FragColor = vec4(1.0, 1.0, 1.0, a); }`
  });
  const hi = new THREE.Points(hiGeo, hiMat);
  hi.frustumCulled = false; hi.renderOrder = 4; hi.visible = false;
  scene.add(hi);
  let pickT = 0;
  function select(i, quiet) {
    sel = i;
    if (!quiet && window.StarlinkSel) window.StarlinkSel.set(i >= 0 ? ids[i] : null, i >= 0 ? names[i] : "");
    hi.visible = i >= 0;
    pickEl.hidden = i < 0;
    root.dataset.picked = i >= 0 ? String(ids[i]) : "";
    pickT = 0;
    updatePick(true);
  }
  function updatePick(force) {
    if (sel < 0) return;
    if (uMask.value[satShell[sel]] < 0.5) { select(-1); return; }
    worldOf(sel, wv);
    hiGeo.attributes.position.setXYZ(0, wv.x, wv.y, wv.z); hiGeo.attributes.position.needsUpdate = true;
    const t = performance.now();
    if (!force && t - pickT < 1000) return;
    pickT = t;
    let alt = wv.length() * R_E - R_E;
    try {
      const d = new Date(), q = window.satellite.propagate(recs[sel], d);
      if (q && q.position) alt = window.satellite.eciToGeodetic(q.position, window.satellite.gstime(d)).height;
    } catch (e) { /* keep spherical altitude */ }
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    if (force || pickEl.dataset.id !== String(ids[sel])) {
      // built once per selection so a tap on the link never lands on a re-rendered node
      pickEl.dataset.id = String(ids[sel]);
      pickEl.innerHTML = `<strong><a class="sat-link" href="https://satellitemap.space/sat/${ids[sel]}" target="_blank" rel="noopener">${esc(names[sel])}<span class="ext" aria-hidden="true">↗</span></a></strong><span data-pick-info></span>`;
    }
    pickEl.querySelector("[data-pick-info]").textContent = alt.toFixed(2) + " km · " + shells[satShell[sel]].label +
      (window.StarlinkLaunch && window.StarlinkLaunch(ids[sel]) ? " · " + window.StarlinkLaunch(ids[sel]) : "");
  }

  async function load() {
    metaEl.textContent = "Loading satellites…";
    const [gp, sats] = await Promise.all([
      fetch("./gp.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error("gp " + r.status); return r.json(); }),
      (opts.satsP || fetch("./sats.json", { cache: "no-cache" }).then((r) => r.json())).catch(() => null),
      loadSatelliteJs()
    ]);
    // shells: the chart's listed shells, plus one bucket for raising / lowering / unassigned
    const shellOf = new Map();
    const all = sats && sats.shells ? sats.shells : [];
    shells = all.slice(0, MAXSH - 1).map((s) => ({ id: s.id, inc: s.inc, label: String(s.label || s.id).replace(/· raising$/, "· orbit raising"), km: s.listed !== false ? s.km : null, color: s.listed !== false && s.km != null ? s.color : RAISING_COLOR }));
    shells.push({ id: RAISING, label: "Orbit raising / deorbiting", inc: null, km: null, color: RAISING_COLOR });
    const idx = new Map(shells.map((s, i) => [s.id, i]));
    if (sats && sats.sats) sats.sats.forEach((r) => shellOf.set(r.id, r.s));
    counts = shells.map(() => 0);

    const now = Date.now(), nowD = new Date(now);
    const rows = (gp.sats || []).filter((r) => Array.isArray(r) && r[11] !== "iss");
    const keep = [], shIdx = [], colors = [];
    const tmp = new THREE.Color();
    let dropped = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i % 400 === 0) await idle();
      const r = rows[i], ep = epochMs(r[2]);
      if (!isFinite(ep) || (now - ep) / 864e5 > MAX_AGE_D) { dropped++; continue; }
      const rec = rowToSatrec(r, ep);
      if (!rec) { dropped++; continue; }
      let pv = null;
      try { pv = window.satellite.propagate(rec, nowD); } catch (e) { pv = null; }
      const p = pv && pv.position;
      if (!p || !isFinite(p.x) || Math.hypot(p.x, p.y, p.z) - R_E < MIN_ALT) { dropped++; continue; }
      const si = idx.has(shellOf.get(r[1])) ? idx.get(shellOf.get(r[1])) : idx.get(RAISING);
      keep.push(rec); shIdx.push(si); counts[si]++; names.push(String(r[0] || "")); ids.push(r[1]);
      tmp.set(shells[si].color); colors.push(tmp.r, tmp.g, tmp.b);
    }
    recs = keep; N = recs.length; satShell = shIdx;
    P0 = new Float32Array(N * 3); P1 = new Float32Array(N * 3); PN = new Float32Array(N * 3);
    t0 = now; t1 = now + STEP;
    for (let i = 0; i < N; i++) { if (i % 1500 === 0) await idle(); propInto(P0, i, new Date(t0), null); }
    for (let i = 0; i < N; i++) { if (i % 1500 === 0) await idle(); propInto(P1, i, new Date(t1), P0); }
    tN = t1 + STEP; cursor = 0;

    const g = new THREE.BufferGeometry();
    a0 = new THREE.BufferAttribute(P0, 3); a1 = new THREE.BufferAttribute(P1, 3);
    a0.setUsage(THREE.DynamicDrawUsage); a1.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3)); // unused, keeps three happy
    g.setAttribute("p0", a0); g.setAttribute("p1", a1);
    g.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(colors), 3));
    g.setAttribute("shell", new THREE.BufferAttribute(new Float32Array(shIdx), 1));
    points = new THREE.Points(g, satMat);
    points.frustumCulled = false;
    points.renderOrder = 3;
    scene.add(points);

    const fetched = gp.fetched ? new Date(gp.fetched) : null;
    dataNote = fetched ? "elements " + new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Vienna", day: "numeric", month: "short" }).format(fetched) + ", SGP4 live" : "SGP4 live";
    // drop empty shells from the chips (keeps the list honest when the chart file is newer or older)
    SS.known(shells.map((s) => s.id));
    SS.sub(() => applyMask());
    buildChips();
    applyMask();
    layout();
    root.dataset.ready = "1";
  }

  /* ---------- keyframe stepping ---------- */
  function step(now, budgetMs) {
    if (!N) return;
    const until = performance.now() + budgetMs, dN = new Date(tN);
    if (now >= t1 && cursor < N) budgetMs = 1e9; // late: finish now
    while (cursor < N) {
      propInto(PN, cursor, dN, P1); cursor++;
      if ((cursor & 63) === 0 && budgetMs < 1e8 && performance.now() > until) break;
    }
    if (cursor >= N && now >= t1) {
      P0.set(P1); P1.set(PN);
      a0.needsUpdate = true; a1.needsUpdate = true;
      t0 = t1; t1 = tN; tN = t1 + STEP; cursor = 0;
      if (now >= t1) { // tab was in the background: resync everything
        t0 = now; t1 = now + STEP; tN = t1 + STEP;
        for (let i = 0; i < N; i++) propInto(P0, i, new Date(t0), P0);
        for (let i = 0; i < N; i++) propInto(P1, i, new Date(t1), P0);
        a0.needsUpdate = true; a1.needsUpdate = true;
      }
    }
  }

  let running = false, lastFrame = 0, loaded = null;
  function frame(tms) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min((tms - (lastFrame || tms)) / 1000, 0.25); lastFrame = tms;
    const now = Date.now();
    step(now, 3);

    if (!ctl.dragging && Math.abs(ctl.vLon) + Math.abs(ctl.vLat) > 0.001) {
      ctl.tLon += ctl.vLon; ctl.tLat = clamp(ctl.tLat + ctl.vLat, -85, 85);
      const decay = Math.pow(0.9, dt * 60); ctl.vLon *= decay; ctl.vLat *= decay;
    }
    const kz = 1 - Math.pow(0.0005, dt);
    ctl.dist += (ctl.tDist - ctl.dist) * kz;
    ctl.lat += (ctl.tLat - ctl.lat) * (ctl.dragging ? 1 : kz);
    ctl.lon += wrapLon(ctl.tLon - ctl.lon) * (ctl.dragging ? 1 : kz);
    ctl.lon = wrapLon(ctl.lon); ctl.tLon = ctl.lon + wrapLon(ctl.tLon - ctl.lon);
    ll2v(ctl.lat, ctl.lon, ctl.dist, camera.position);
    camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0);

    const d = new Date(now);
    uSun.value.copy(sunDir(d));
    uni.gmst.value = window.satellite ? window.satellite.gstime(d) : 0;
    uni.u.value = t1 > t0 ? clamp((now - t0) / (t1 - t0), 0, 1.5) : 0;
    uni.size.value = dpr * clamp(1.9 * (ctl.fitD - 1) / Math.max(ctl.dist - 1, 0.05), 1.9, 5);
    updatePick(false);
    renderer.render(scene, camera);
  }

  return {
    show() {
      if (running) return;
      running = true; lastFrame = 0;
      layout();
      requestAnimationFrame(frame);
      if (!loaded) loaded = load().catch((e) => { metaEl.textContent = "Could not load satellites."; console.error(e); });
    },
    hide() { running = false; },
    ready() { return loaded || Promise.resolve(); },
    // adopt the shared selection (from the URL or the Chart); centre the globe on it
    syncSel() {
      const s = window.StarlinkSel ? window.StarlinkSel.get() : { id: null };
      if (!N) return;
      if (s.id == null) { if (sel >= 0) select(-1, true); return; }
      const i = ids.indexOf(s.id);
      if (i < 0) { if (sel >= 0) select(-1, true); return; }
      if (!SS.isOn(shells[satShell[i]].id)) { if (sel >= 0) select(-1, true); return; }
      select(i, true);
      worldOf(i, wv);
      const r = wv.length();
      ctl.vLat = ctl.vLon = 0;
      ctl.tLat = clamp(Math.asin(wv.y / r) / D2R, -75, 75);
      ctl.tLon = Math.atan2(-wv.z, wv.x) / D2R;
    },
    colors() { syncColors(); },
    debug() { return { N, shells: shells.map((s, i) => ({ id: s.id, n: counts[i], on: !off.has(s.id) })), shown: +root.dataset.shown || 0, sel: sel >= 0 ? { name: names[sel], id: ids[sel] } : null }; },
    pickAt(x, y) { return pickAt(x, y); },
    selectAt(x, y) { select(pickAt(x, y)); return sel >= 0 ? ids[sel] : null; },
    screenOf(i) { worldOf(i, wv); camera.updateMatrixWorld(); pv3.copy(wv).project(camera); return { x: (pv3.x * 0.5 + 0.5) * W, y: (-pv3.y * 0.5 + 0.5) * H, hidden: hiddenByEarth(wv), shellOn: uMask.value[satShell[i]] > 0.5 }; }
  };
}
