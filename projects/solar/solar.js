import * as THREE from "/vendor/three.module.min.js";
import { BODIES, MOONS, BY_ID, TEXT, LAND, LAND_TEXT, AU, LY, R_EARTH, days } from "./bodies.js?v=1";
import { System } from "./system.js?v=1";
import { Sky } from "./sky.js?v=1";
import { Ground } from "./ground.js?v=1";
import { Cosmos } from "./cosmos.js?v=1";

/* ============================================================
   Solar system – app shell: renderer, camera rig (orbit / fly-to /
   zoom out to the universe), modes, time, land, UI, URL.
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let lang = (localStorage.getItem("solar.lang") || (navigator.language || "en")).slice(0, 2) === "de" ? "de" : "en";
const tr = (o) => (o && typeof o === "object" ? o[lang] || o.en : o);
const UI = {
  overview: { en: "Overview", de: "Überblick" }, sizes: { en: "True sizes", de: "Echte Größen" }, distances: { en: "True distances", de: "Echte Abstände" },
  system: { en: "Solar system", de: "Sonnensystem" }, land: { en: "Land", de: "Landen" }, takeoff: { en: "Take off", de: "Abheben" },
  tour: { en: "Tour", de: "Tour" }, today: { en: "Today", de: "Heute" }, day: { en: "Daytime", de: "Tag" },
  hintO: { en: "Squeezed so everything fits on screen", de: "Zusammengeschoben, damit alles auf den Schirm passt" },
  hintS: { en: "Real sizes, side by side", de: "Echte Größen, nebeneinander" },
  hintD: { en: "Real distances – planets are tiny dots! Pinch out to leave the solar system", de: "Echte Abstände – die Planeten sind winzige Punkte! Weiter rauszoomen, um das Sonnensystem zu verlassen" },
  speeds: [
    { s: 1 / 86400, en: "real time", de: "Echtzeit" }, { s: 1 / 24, en: "1 hour / s", de: "1 Stunde / s" },
    { s: 1, en: "1 day / s", de: "1 Tag / s" }, { s: 7, en: "1 week / s", de: "1 Woche / s" },
    { s: 30.44, en: "1 month / s", de: "1 Monat / s" }, { s: 365.25, en: "1 year / s", de: "1 Jahr / s" }
  ]
};

/* ---------- renderer ---------- */
const canvas = $("canvas.gl");
const lowPower = /iPhone|iPad|Android/.test(navigator.userAgent) || Math.min(screen.width, screen.height) < 500;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.autoClear = false;
renderer.setClearColor(0x000000, 1);
const camera = new THREE.PerspectiveCamera(40, 1, 1e-7, 1e9);
const sys = new System(renderer, lowPower);
const sky = new Sky();
const ground = new Ground(renderer, sys, sky);
const cosmos = new Cosmos(renderer, lowPower);
cosmos.onPick = (c) => { stopTour(); if (c) openCard({ cosmic: c }); };

let W = 1, H = 1;
function resize() {
  W = innerWidth; H = innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  const port = H > W * 1.05;
  if (port !== sys.portrait) { sys.portrait = port; }
  ground.resize(W, H);
}
addEventListener("resize", resize);
resize();

/* ---------- time ---------- */
const time = { d: days(new Date()), speedI: 2, paused: false, warp: null };
function setSpeed(i) { time.speedI = clamp(i, 0, UI.speeds.length - 1); paintTime(); }

/* ---------- modes ---------- */
const MODES = ["overview", "sizes", "distances"];
const view = { mode: "overview", from: "overview", t0: -1, dur: 1.9, w: [1, 0, 0] };
const modeW = (m) => [m === "overview" ? 1 : 0, m === "sizes" ? 1 : 0, m === "distances" ? 1 : 0];

/* ---------- camera rig ----------
   anchor: a body id or "home". The camera orbits the anchor at
   dist = base(anchor) * exp(zoom). Fly-to blends two anchors. */
const rig = { anchor: "home", yaw: 0.35, pitch: innerHeight > innerWidth ? 0.85 : 0.52, zoom: 0, vYaw: 0, vPitch: 0, vZoom: 0, fly: null, origin: new Float64Array(3), dist: 1 };
const HOME = { o: 7.4, s: 1, d: 26 };

function fitK(R) {
  // distance at which a ball of radius R fills ~44% of the narrow side
  const halfV = (camera.fov * Math.PI) / 360, halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  return 1 / (0.44 * Math.tan(Math.min(halfV, halfH)));
}
function anchorPos(a, out) {
  if (a === "home") {
    const L = sys.lineup(), c = L.end * (sys.portrait ? 0.5 : 0.49);
    // short landscape screens: keep the lineup clear of the title above
    const lift = !sys.portrait && innerHeight < 500 ? sys.byId.jupiter.rS * 0.2 : 0;
    out[0] = view.w[1] * (sys.portrait ? 0 : c); out[1] = view.w[1] * (sys.portrait ? -c : lift); out[2] = 0;
    return out;
  }
  const it = sys.byId[a];
  out[0] = it.pos[0]; out[1] = it.pos[1]; out[2] = it.pos[2];
  return out;
}
function anchorDist(a) {
  if (a === "home") {
    const L = sys.lineup(), halfV = (camera.fov * Math.PI) / 360, halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const along = sys.portrait ? halfV : halfH, across = sys.portrait ? halfH : halfV;
    const s = Math.max((L.end * (sys.portrait ? 0.8 : 0.6)) / Math.tan(along), (sys.byId.jupiter.rS * (innerHeight < 500 ? 2.1 : 1.4)) / Math.tan(across));
    const o = HOME.o * (camera.aspect < 0.8 ? 1.3 : 1), dd = HOME.d * (camera.aspect < 0.8 ? 1.3 : 1);
    return Math.exp(view.w[0] * Math.log(o) + view.w[1] * Math.log(s) + view.w[2] * Math.log(dd));
  }
  const it = sys.byId[a];
  const ext = it.b && it.b.ring ? it.b.ring[1] / it.b.r : 1;
  return it.R * ext * fitK();
}
function zoomLimits() {
  if (rig.anchor === "home") return [-4, view.mode === "distances" ? 40 : 1.4];
  const it = sys.byId[rig.anchor];
  const ext = it.b && it.b.ring ? it.b.ring[1] / it.b.r : 1;
  return [Math.log(1.25 / (ext * fitK())), view.mode === "distances" ? 48 : 5];
}

function flyTo(a, opts = {}) {
  if (ground.active) leaveGround(true);
  const p0 = anchorPos(rig.anchor, [0, 0, 0]), p1 = anchorPos(a, [0, 0, 0]);
  const d0 = anchorDist(rig.anchor) * Math.exp(rig.zoom), d1 = anchorDist(a) * Math.exp(opts.zoom || 0);
  const sep = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const bump = Math.log(1 + sep / Math.max(d0, d1)) * 0.75;
  const span = Math.abs(Math.log(d1 / d0)) + bump * 2;
  rig.fly = { a: rig.anchor, b: a, t0: now, dur: reduceMotion ? 0.01 : clamp(1.2 + span * 0.16, 1.4, 4.2), d0, d1, bump,
    yaw0: rig.yaw, pitch0: rig.pitch, yaw1: opts.yaw ?? rig.yaw, pitch1: opts.pitch ?? clamp(rig.pitch, 0.12, 0.6), zoom1: opts.zoom || 0 };
  rig.vYaw = rig.vPitch = rig.vZoom = 0;
  if (a !== "home") sys.loadHi(sys.byId[a]);
  focusChanged(a);
}

function setMode(m, keepAnchor = true) {
  if (m === view.mode && view.t0 < 0) return;
  if (ground.active) leaveGround(true);
  view.from = view.mode; view.mode = m; view.t0 = now;
  view.wFrom = view.w.slice();
  if (m === "sizes") { rig.fly = null; rig.yawT = 0; rig.pitchT = 0.1; }
  if (!keepAnchor) rig.anchor = "home";
  rig.zoomT = 0;
  hint(tr(UI[m === "overview" ? "hintO" : m === "sizes" ? "hintS" : "hintD"]));
  paintModes();
  writeHash();
}

/* ---------- input ---------- */
const ptrs = new Map();
let gesture = null, lastTap = 0, now = 0;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
  gesture = ptrs.size === 1 ? { kind: "drag", moved: 0 } : { kind: "pinch", d0: pinchDist(), z0: rig.zoom, f0: ground.fov };
  rig.vYaw = rig.vPitch = rig.vZoom = 0;
  stopTour();
});
canvas.addEventListener("pointermove", (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (!gesture) return;
  if (gesture.kind === "drag") {
    gesture.moved += Math.abs(dx) + Math.abs(dy);
    if (ground.active) { ground.look(dx, dy); return; }
    const k = 3.6 / Math.max(W, H) * 1.6;
    rig.yaw -= dx * k; rig.pitch = clamp(rig.pitch + dy * k, -1.45, 1.45);
    rig.vYaw = -dx * k; rig.vPitch = dy * k;
    rig.yawT = rig.pitchT = undefined;
  } else if (ptrs.size >= 2) {
    const d = pinchDist();
    if (ground.active) { ground.setFov(gesture.f0 * gesture.d0 / d); return; }
    setZoom(gesture.z0 - Math.log(d / gesture.d0) * 1.2);
  }
});
const endPtr = (e) => {
  const p = ptrs.get(e.pointerId);
  ptrs.delete(e.pointerId);
  if (!p) return;
  if (gesture && gesture.kind === "drag" && gesture.moved < 10 && performance.now() - p.t0 < 450) tap(e.clientX, e.clientY);
  if (ptrs.size === 0) gesture = null;
  else if (ptrs.size === 1) gesture = { kind: "drag", moved: 99 };
};
canvas.addEventListener("pointerup", endPtr);
canvas.addEventListener("pointercancel", endPtr);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  stopTour();
  if (ground.active) { ground.setFov(ground.fov * Math.exp(e.deltaY * 0.0015)); return; }
  rig.vZoom += e.deltaY * (e.ctrlKey ? 0.01 : 0.0016);
}, { passive: false });
function pinchDist() { const a = [...ptrs.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1; }
const MAX_DIST = 1.6e11 * LY;   // AU: the whole observable universe in view
function setZoom(z) {
  let [lo, hi] = zoomLimits();
  hi = Math.min(hi, Math.log(MAX_DIST / anchorDist(rig.anchor)));
  rig.zoom = clamp(z, lo, hi);
  rig.zoomT = undefined;
}

/* ---------- picking ---------- */
const v3 = new THREE.Vector3();
function screenOf(obj, out) {
  v3.copy(obj.position).project(camera);
  out.x = (v3.x * 0.5 + 0.5) * W; out.y = (-v3.y * 0.5 + 0.5) * H; out.z = v3.z;
  return out;
}
function tap(x, y) {
  if (ground.active) return;
  const c = cosmos.pick(x, y);
  if (c) { openCard({ cosmic: c }); return; }
  let best = null, bd = 1e9;
  for (const it of sys.items) {
    if (!it.group.visible || !it.scr || it.scr.z > 1) continue;
    const r = Math.max(26, it.screenR * 1.05), d = Math.hypot(it.scr.x - x, it.scr.y - y);
    if (d < r && d - it.screenR * 0.5 < bd) { bd = d - it.screenR * 0.5; best = it; }
  }
  if (!best) return;
  const id = best.kind === "moonlet" ? best.parent : best.id;
  if (id === rig.anchor && !rig.fly) openCard({ id });
  else flyTo(best.kind === "moonlet" ? best.id : id);
}

/* ---------- labels ---------- */
const labelsEl = $(".labels");
const scr = { x: 0, y: 0, z: 0 };
for (const it of sys.items) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "lbl" + (it.kind === "moonlet" ? " is-small" : "") + (it.kind === "dwarf" ? " is-dwarf" : "");
  el.innerHTML = "<i></i><span></span>";
  el.addEventListener("click", () => { stopTour(); it.id === rig.anchor ? openCard({ id: it.kind === "moonlet" ? it.parent : it.id }) : flyTo(it.id); });
  labelsEl.appendChild(el);
  it.lbl = el;
}
function paintLabelNames() {
  for (const it of sys.items) it.lbl.querySelector("span").textContent = tr((it.b || it.m).name);
}
function placeLabels() {
  const hideAll = ground.active || cosmos.level > 0.6;
  const sideways = view.w[1] > 0.5 && sys.portrait;
  const cand = [];
  for (const it of sys.items) {
    it.scr = screenOf(it.group, it.scr || {});
    let show = !hideAll && it.group.visible && it.scr.z < 1 && it.scr.x > -50 && it.scr.x < W + 50 && it.scr.y > -50 && it.scr.y < H + 50;
    if (show && (it.kind === "moonlet" || it.id === "moon")) {
      const p = sys.byId[it.parent || "earth"];
      const near = rig.anchor === p.id || rig.anchor === it.id || it.id === "moon";
      show = near && p.scr && Math.hypot(it.scr.x - p.scr.x, it.scr.y - p.scr.y) > Math.max(46, p.screenR + 30) && view.w[1] < 0.5;
    }
    if (show && it.screenR > Math.min(W, H) * 0.32) show = false;
    if (show) cand.push(it);
    else it.lbl.classList.remove("is-on");
  }
  // biggest (and the focused one) first; skip labels that would overlap one already placed
  cand.sort((a, b) => (b.id === rig.anchor) - (a.id === rig.anchor) || (b.kind !== "moonlet") - (a.kind !== "moonlet") || b.screenR - a.screenR);
  const boxes = [];
  for (const it of cand) {
    const r = Math.max(it.screenR, 2), w = (it.lbl.textContent.length * 7.4 + 18), h = 20;
    const x = sideways ? it.scr.x + r + 10 : it.scr.x - w / 2, y = sideways ? it.scr.y - 11 : it.scr.y + r + 8;
    const hit = boxes.some((b) => x < b[2] && x + w > b[0] && y < b[3] && y + h > b[1]);
    if (hit && it.id !== rig.anchor) { it.lbl.classList.remove("is-on"); continue; }
    boxes.push([x, y, x + w, y + h]);
    const el = it.lbl;
    el.classList.add("is-on");
    el.classList.toggle("is-ring", it.screenR < 5 && view.w[2] > 0.5);
    el.classList.toggle("is-focus", it.id === rig.anchor);
    el.style.transform = sideways ? `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` : `translate(${it.scr.x.toFixed(1)}px, ${y.toFixed(1)}px) translateX(-50%)`;
    el.style.setProperty("--r", Math.max(9, r + 6).toFixed(1) + "px");
  }
}

/* ---------- UI ---------- */
const titleEl = $(".title"), nameEl = $(".t-name"), subEl = $(".t-sub");
const infoBtn = $("[data-info]"), landBtn = $("[data-land]"), dayBtn = $("[data-day]");
const strip = $(".strip"), timeEl = $("[data-date]"), speedBtn = $("[data-speed]"), playBtn = $("[data-play]");
const STRIP = ["home", "sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"];
for (const id of STRIP) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.id = id;
  b.innerHTML = id === "home" ? '<b class="ball is-home"></b><span></span>' : `<b class="ball" style="--tex:url(tex/${BY_ID[id].tex}-1k.webp)"></b><span></span>`;
  if (id === "saturn") b.querySelector(".ball").classList.add("has-ring");
  b.addEventListener("click", () => { stopTour(); if (id === rig.anchor && !ground.active) { if (id !== "home") openCard({ id }); } else { setCosmicHome(); flyTo(id); } });
  strip.appendChild(b);
}
function setCosmicHome() { /* flying anywhere from deep space also brings the camera back home */ }

function paintStrip() {
  for (const b of strip.children) {
    const id = b.dataset.id;
    b.querySelector("span").textContent = id === "home" ? tr(UI.system) : tr(BY_ID[id].name);
    b.classList.toggle("is-on", id === rig.anchor);
    b.setAttribute("aria-pressed", id === rig.anchor ? "true" : "false");
  }
}
function paintTitle() {
  const c = cosmos.level > 0.6 ? cosmos.current() : null;
  if (ground.active) {
    nameEl.textContent = tr(BY_ID[ground.id].name);
    subEl.textContent = tr(LAND[ground.id].place);
  } else if (c) {
    nameEl.textContent = tr(c.name); subEl.textContent = c.scale ? tr(c.scale) : "";
  } else if (rig.anchor === "home") {
    nameEl.textContent = tr(UI.system); subEl.textContent = "";
  } else {
    const it = sys.byId[rig.anchor];
    nameEl.textContent = tr((it.b || it.m).name);
    subEl.textContent = it.b && TEXT[it.id] ? tr(TEXT[it.id].sub) : tr(BY_ID[it.parent].name);
  }
  titleEl.classList.toggle("is-long", nameEl.textContent.length > 13);
  const bodyId = ground.active ? ground.id : rig.anchor;
  infoBtn.hidden = !(c || ground.active || (bodyId !== "home" && TEXT[bodyId]));
  landBtn.hidden = ground.active || !!c || !(LAND[rig.anchor] || rig.anchor === "sun") || view.w[1] > 0.5;
  landBtn.textContent = tr(UI.land);
  $("[data-takeoff]").hidden = !ground.active;
  $("[data-takeoff]").textContent = tr(UI.takeoff);
  dayBtn.hidden = !ground.active || ground.isDay();
  document.body.classList.toggle("is-ground", ground.active);
  document.body.classList.toggle("is-cosmic", !!c);
}
function focusChanged(id) {
  rig.next = id;
  for (const it of sys.items) it.focus = it.id === id;
  closeCard();
  queueMicrotask(() => { paintStrip(); paintTitle(); });
}
infoBtn.addEventListener("click", () => {
  const c = cosmos.level > 0.6 ? cosmos.current() : null;
  if (c) openCard({ cosmic: c });
  else openCard({ id: ground.active ? ground.id : rig.anchor });
});
landBtn.addEventListener("click", () => { stopTour(); if (rig.anchor === "sun") { hint(tr(LAND_TEXT.sun), 4200); return; } land(rig.anchor); });
$("[data-takeoff]").addEventListener("click", () => leaveGround());
dayBtn.addEventListener("click", () => { const dt = ground.toDaylight(time.d); if (dt) warpTime(dt); });

function paintModes() {
  for (const b of document.querySelectorAll("[data-mode]")) {
    const on = b.dataset.mode === view.mode;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.querySelector("span").textContent = tr(UI[b.dataset.mode]);
  }
}
for (const b of document.querySelectorAll("[data-mode]")) b.addEventListener("click", () => { stopTour(); setMode(b.dataset.mode); });

const fmtDate = (d) => new Date((d + 10957.5) * 864e5).toLocaleDateString(lang === "de" ? "de-AT" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
function paintTime() {
  speedBtn.textContent = tr(UI.speeds[time.speedI]);
  playBtn.classList.toggle("is-paused", time.paused);
  playBtn.setAttribute("aria-label", time.paused ? "Play" : "Pause");
  $("[data-today]").textContent = tr(UI.today);
}
playBtn.addEventListener("click", () => { time.paused = !time.paused; paintTime(); });
speedBtn.addEventListener("click", () => setSpeed((time.speedI + 1) % UI.speeds.length));
$("[data-today]").addEventListener("click", () => warpTime(days(new Date()) - time.d));
function warpTime(dt) { time.warp = { d0: time.d, d1: time.d + dt, t0: now, dur: clamp(0.8 + Math.log10(1 + Math.abs(dt)) * 0.5, 0.8, 2.4) }; }

let hintTimer = 0;
function hint(text, ms = 3200) {
  const el = $(".hint");
  el.textContent = text;
  el.classList.add("is-on");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove("is-on"), ms);
}

/* ---------- info card ---------- */
const card = $(".card");
const fmt = (n, dec = 0) => n.toLocaleString(lang === "de" ? "de-AT" : "en-GB", { maximumFractionDigits: dec, minimumFractionDigits: 0 });
function dur(hours) {
  const de = lang === "de";
  if (hours < 1 / 60) return fmt(hours * 3600, 0) + (de ? " Sekunden" : " seconds");
  if (hours < 1) return fmt(hours * 60, 0) + (de ? " Minuten" : " minutes");
  if (hours < 48) return fmt(hours, hours < 10 ? 1 : 0) + (de ? " Stunden" : " hours");
  const d = hours / 24;
  if (d < 365 * 2) return fmt(d, 0) + (de ? " Tage" : " days");
  const y = d / 365.25;
  const p = y < 100 ? 1 : Math.pow(10, Math.floor(Math.log10(y)) - 1);   // two significant digits
  return fmt(Math.round(y / p) * p, 0) + (de ? " Jahre" : " years");
}
function dayLen(dd) {
  const de = lang === "de";
  if (dd < 2) return fmt(dd * 24, 1) + (de ? " Stunden" : " hours");
  return fmt(dd, 0) + (de ? " Erdtage" : " Earth days");
}
function yearLen(dd) {
  const de = lang === "de";
  if (dd < 800) return fmt(dd, 0) + (de ? " Tage" : " days");
  return fmt(dd / 365.25, 1) + (de ? " Jahre" : " years");
}
let weightKg = +(localStorage.getItem("solar.kg") || 15);
function openCard(o) {
  stopTour();
  const de = lang === "de";
  let html = "";
  if (o.cosmic) {
    const c = o.cosmic;
    html = `<header><h2>${tr(c.name)}</h2><p class="sub">${c.scale ? tr(c.scale) : ""}</p></header>
      <p class="kid">${tr(c.kid)}</p>${c.fun ? `<p class="fun">${tr(c.fun)}</p>` : ""}`;
  } else {
    const id = o.id, b = BY_ID[id], T = TEXT[id];
    if (!b || !T) return;
    const it = sys.byId[id];
    const R = b.r, dE = R / R_EARTH;
    const eP = sys.byId.earth.pD, p = it.pD;
    const distKm = id === "earth" ? 0 : Math.hypot(p[0] - eP[0], p[1] - eP[1], p[2] - eP[2]) * AU;
    const sunKm = Math.hypot(p[0], p[1], p[2]) * AU;
    const temp = b.temp.length > 1 ? `${fmt(b.temp[0])} … ${fmt(b.temp[1])} °C` : `${fmt(b.temp[0])} °C`;
    const rows = [
      [de ? "Durchmesser" : "Diameter", `${fmt(R * 2)} km`, id === "earth" ? "" : `${fmt(dE, dE < 10 ? 2 : 0)} × ${de ? "Erde" : "Earth"}`],
      id === "sun" ? null : [id === "moon" ? (de ? "Von der Erde" : "From Earth") : (de ? "Von der Sonne" : "From the Sun"),
        id === "moon" ? `${fmt(distKm / 1000, 0)}${de ? " Tsd." : "k"} km` : `${fmt(sunKm / 1e6, 0)} ${de ? "Mio." : "million"} km`,
        id === "moon" ? "" : `${fmt(sunKm / AU, 2)} AU`],
      [de ? "Ein Tag" : "One day", dayLen(b.day), id === "sun" ? (de ? "am Äquator" : "at the equator") : (id === "earth" ? "" : de ? "Sonnenaufgang bis -aufgang" : "sunrise to sunrise")],
      b.year ? [id === "moon" ? (de ? "Einmal um die Erde" : "Once around Earth") : (de ? "Ein Jahr" : "One year"), yearLen(b.year), ""] : null,
      b.moons !== undefined ? [de ? "Monde" : "Moons", fmt(b.moons), b.moons > 10 ? (de ? "bekannt, 2026" : "known, 2026") : ""] : null,
      [de ? "Temperatur" : "Temperature", temp, ""],
      [de ? "Schwerkraft" : "Gravity", `${fmt(b.g, 2)} g`, ""]
    ].filter(Boolean);
    const travel = id === "earth" ? "" : `<section class="travel"><h3>${de ? "Von der Erde dorthin – heute" : "Getting there from Earth – today"} <small>${fmt(distKm / 1e6, distKm < 1e7 ? 2 : 0)} ${de ? "Mio." : "million"} km</small></h3>
      <ul><li><b>🚗</b><span>${de ? "Auto" : "Car"}</span><em>${dur(distKm / 100)}</em></li>
      <li><b>✈️</b><span>${de ? "Flugzeug" : "Plane"}</span><em>${dur(distKm / 900)}</em></li>
      <li><b>🚀</b><span>${de ? "Rakete" : "Rocket"}</span><em>${dur(distKm / 40000)}</em></li>
      <li><b>💡</b><span>${de ? "Licht" : "Light"}</span><em>${dur(distKm / 299792.458 / 3600)}</em></li></ul></section>`;
    html = `<header><b class="ball" style="--tex:url(tex/${b.tex}-1k.webp)"></b><div><h2>${tr(b.name)}</h2><p class="sub">${tr(T.sub)}</p></div></header>
      <p class="kid">${tr(T.kid)}</p>
      <p class="like"><b>${T.like[0]}</b><span>${de ? "Wäre die Erde eine Kirsche 🍒, wäre " + tr(b.name) + " …" : "If Earth were a cherry 🍒, " + tr(b.name) + " would be …"}<strong>${tr(T.like[1])}</strong></span></p>
      <section class="weigh"><label>${de ? "Du wiegst" : "You weigh"} <input type="number" inputmode="numeric" min="1" max="250" value="${weightKg}" data-kg aria-label="${de ? "Gewicht in kg" : "Weight in kg"}"> kg</label>
      <p>${de ? "Auf " + (id === "sun" || id === "moon" ? "der/dem " : "") + tr(b.name) + " wärst du" : "On " + (id === "sun" || id === "moon" ? "the " : "") + tr(b.name) + " you'd weigh"} <strong data-kgout>${fmt(weightKg * b.g, 1)} kg</strong></p></section>
      <dl>${rows.map((r) => `<div><dt>${r[0]}</dt><dd>${r[1]}${r[2] ? `<small>${r[2]}</small>` : ""}</dd></div>`).join("")}</dl>
      ${travel}
      <p class="fun">${tr(T.fun)}</p>`;
    if (de) html = html.replace("Auf der/dem Sonne", "Auf der Sonne").replace("Auf der/dem Mond", "Auf dem Mond");
  }
  html += `<footer><button type="button" data-lang>${lang === "de" ? "English" : "Deutsch"}</button>
    <button type="button" data-credits>${de ? "Quellen" : "Credits"}</button></footer>`;
  $(".card-body").innerHTML = html;
  const kg = $("[data-kg]");
  if (kg) kg.addEventListener("input", () => {
    weightKg = clamp(+kg.value || 0, 0, 500);
    localStorage.setItem("solar.kg", String(weightKg));
    $("[data-kgout]").textContent = fmt(weightKg * BY_ID[o.id].g, 1) + " kg";
  });
  $("[data-lang]").addEventListener("click", () => { setLang(lang === "de" ? "en" : "de"); openCard(o); });
  $("[data-credits]").addEventListener("click", () => openCredits());
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add("is-on"));
  card.scrollTop = 0;
  $(".card-body").scrollTop = 0;
}
function openCredits() {
  $(".card-body").innerHTML = `<header><div><h2>${lang === "de" ? "Quellen" : "Credits"}</h2></div></header><ul class="credits">
    <li>Planet, Moon, Sun &amp; Milky Way textures: <a href="https://www.solarsystemscope.com/textures/" rel="noopener" target="_blank">Solar System Scope</a> (CC BY 4.0), based on NASA data</li>
    <li>Pluto: NASA / Johns Hopkins APL / SwRI, New Horizons (public domain)</li>
    <li>Nearby stars: <a href="https://github.com/astronexus/HYG-Database" rel="noopener" target="_blank">HYG database</a> v4.1 (CC BY-SA 4.0)</li>
    <li>Planet positions: JPL approximate Keplerian elements; rotation: IAU WGCCRE</li>
    <li>3D: <a href="https://threejs.org" rel="noopener" target="_blank">three.js</a> (MIT) · Font: Barlow (OFL)</li>
    <li><a href="./tex/CREDITS.txt" target="_blank">${lang === "de" ? "Alle Bilder, Datei für Datei" : "Every image, file by file"}</a></li></ul>`;
}
function closeCard() {
  if (card.hidden) return;
  card.classList.remove("is-on");
  setTimeout(() => { if (!card.classList.contains("is-on")) card.hidden = true; }, 320);
}
$("[data-close]").addEventListener("click", closeCard);
addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });
function setLang(l) {
  lang = l;
  localStorage.setItem("solar.lang", l);
  document.documentElement.lang = l;
  paintAll();
}

/* ---------- land ---------- */
function land(id) {
  closeCard();
  const L = LAND[id];
  if (!L) return;
  rig.landing = { id, t0: now, d0: rig.zoom };
  // dive towards the planet, then switch to the ground view
  const [lo] = zoomLimits();
  rig.zoomT = lo;
  setTimeout(() => {
    ground.enter(id, L, time.d);
    if (time.speedI > 1) setSpeed(0);
    paintTitle(); writeHash();
    const t = LAND_TEXT[L.gas ? (id === "saturn" ? "saturn" : "gas") : id];
    if (t) hint(tr(t), 6000);
  }, reduceMotion ? 0 : 700);
}
function leaveGround(silent) {
  ground.leave();
  rig.landing = null;
  rig.zoom = zoomLimits()[0] + 0.2; rig.zoomT = 0;
  if (!silent) { paintTitle(); writeHash(); }
}

/* ---------- tour ---------- */
const TOUR = ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto", "cosmos"];
let tour = null;
const capEl = $(".caption");
function startTour() {
  closeCard();
  if (view.mode !== "overview") setMode("overview");
  tour = { i: -1, t: 0 };
  nextTour();
  $("[data-tour]").classList.add("is-on");
}
function nextTour() {
  if (!tour) return;
  tour.i++;
  if (tour.i >= TOUR.length) { stopTour(); flyTo("home"); return; }
  const id = TOUR[tour.i];
  if (id === "cosmos") {
    setMode("distances", false);
    rig.zoomT = 34;
    capEl.innerHTML = `<p>${lang === "de" ? "Und jetzt ganz weit hinaus – bis zum Rand des sichtbaren Universums!" : "And now all the way out – to the edge of the universe we can see!"}</p>`;
    tour.until = now + 22;
  } else {
    flyTo(id, { yaw: rig.yaw + 0.5 });
    capEl.innerHTML = `<h3>${tr(BY_ID[id].name)}</h3><p>${tr(TEXT[id].kid)}</p>`;
    tour.until = now + 9.5;
  }
  capEl.classList.add("is-on");
}
function stopTour() {
  if (!tour) return;
  tour = null;
  capEl.classList.remove("is-on");
  $("[data-tour]").classList.remove("is-on");
}
$("[data-tour]").addEventListener("click", () => (tour ? stopTour() : startTour()));
capEl.addEventListener("click", () => nextTour());

/* ---------- URL ---------- */
function writeHash() {
  const parts = [];
  if (view.mode !== "overview") parts.push(view.mode);
  const a = rig.next || rig.anchor;
  if (a !== "home") parts.push(a);
  if (ground.active) parts.push("land");
  const h = parts.length ? "#" + parts.join("/") : "";
  if (location.hash !== h) history.replaceState(null, "", h || location.pathname + location.search);
}
function readHash() {
  const parts = location.hash.replace(/^#/, "").toLowerCase().split("/").filter(Boolean);
  let m = "overview", a = "home", l = false;
  for (const p of parts) {
    if (MODES.includes(p)) m = p;
    else if (sys.byId[p]) a = p;
    else if (p === "land") l = true;
  }
  view.mode = view.from = m; view.w = modeW(m); view.t0 = -1;
  if (m === "sizes") { rig.yaw = 0; rig.pitch = 0.1; }   // the lineup is seen face-on
  rig.anchor = rig.next = a;
  for (const it of sys.items) it.focus = it.id === a;
  if (a !== "home") sys.loadHi(sys.byId[a]);
  sys.compute(time.d, view.w, 0);
  if (l && LAND[a]) { ground.enter(a, LAND[a], time.d); time.speedI = 0; }
}

function paintAll() { paintLabelNames(); paintStrip(); paintTitle(); paintModes(); paintTime(); }

/* ---------- loop ---------- */
const clock = { last: performance.now() };
const tmpV = new THREE.Vector3();
const pxAt = (dist) => (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / H;
let frames = 0;

function frame(tms) {
  const dt = Math.min(0.05, (tms - clock.last) / 1000);
  clock.last = tms;
  now += dt;
  // time
  if (time.warp) {
    const u = clamp((now - time.warp.t0) / time.warp.dur, 0, 1);
    time.d = lerp(time.warp.d0, time.warp.d1, ease(u));
    if (u >= 1) time.warp = null;
  } else if (!time.paused) time.d += UI.speeds[time.speedI].s * dt;
  // modes
  if (view.t0 >= 0) {
    const u = clamp((now - view.t0) / view.dur, 0, 1), e = ease(u), to = modeW(view.mode);
    view.w = view.wFrom.map((v, i) => lerp(v, to[i], e));
    if (u >= 1) { view.t0 = -1; view.w = to; }
  }
  // camera rig
  if (!gesture && !rig.fly) {
    rig.yaw += rig.vYaw; rig.pitch = clamp(rig.pitch + rig.vPitch, -1.45, 1.45);
    rig.vYaw *= 0.92; rig.vPitch *= 0.92;
    if (Math.abs(rig.vZoom) > 1e-5) { setZoom(rig.zoom + rig.vZoom * 0.25); rig.vZoom *= 0.8; }
    if (rig.yawT !== undefined) { rig.yaw = lerp(rig.yaw, rig.yawT, 1 - Math.pow(0.02, dt)); rig.pitch = lerp(rig.pitch, rig.pitchT, 1 - Math.pow(0.02, dt)); }
    if (rig.zoomT !== undefined) { rig.zoom = lerp(rig.zoom, rig.zoomT, 1 - Math.pow(rig.landing ? 0.004 : 0.03, dt)); if (Math.abs(rig.zoom - rig.zoomT) < 1e-3) rig.zoomT = undefined; }
    if (tour && !tour.until) tour.until = now + 9;
  }
  // zooming out of a squeezed view switches to true distances (the only honest way further out)
  if (view.mode !== "distances" && view.t0 < 0 && !rig.fly && rig.zoom > zoomLimits()[1] - 0.05 && (rig.vZoom > 0 || (gesture && gesture.kind === "pinch"))) {
    if (rig.anchor !== "home") flyTo("home", { zoom: 0.6 });
    setMode("distances");
  }
  sys.compute(time.d, view.w, dt);
  let dist;
  const tp = [0, 0, 0];
  if (rig.fly) {
    const f = rig.fly, u = clamp((now - f.t0) / f.dur, 0, 1), e = ease(u);
    const a = anchorPos(f.a, [0, 0, 0]), b = anchorPos(f.b, [0, 0, 0]);
    for (let i = 0; i < 3; i++) tp[i] = lerp(a[i], b[i], e);
    const d1 = anchorDist(f.b) * Math.exp(f.zoom1);
    dist = Math.exp(lerp(Math.log(f.d0), Math.log(d1), e) + f.bump * Math.sin(Math.PI * e));
    rig.yaw = lerp(f.yaw0, f.yaw1, e); rig.pitch = lerp(f.pitch0, f.pitch1, e);
    if (u >= 1) { rig.anchor = f.b; rig.zoom = f.zoom1; rig.fly = null; writeHash(); paintTitle(); }
  } else {
    anchorPos(rig.anchor, tp);
    dist = anchorDist(rig.anchor) * Math.exp(rig.zoom);
  }
  rig.dist = dist;
  // zooming through galactic scales turns the view to look down on the Milky Way (only while zooming)
  const lgNow = Math.log10(dist / LY), dLg = lgNow - (rig.lgPrev ?? lgNow);
  rig.lgPrev = lgNow;
  if (dLg && lgNow > 3.2 && lgNow < 5.2 && view.w[2] > 0.99) {
    const g = cosmos.galaxyView(), yawT = Math.atan2(g.x, g.z), pitchT = Math.asin(g.y);
    const k = clamp(Math.abs(dLg) * 1.6, 0, 1);
    rig.yaw += (((yawT - rig.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * k;
    rig.pitch += (pitchT - rig.pitch) * k;
  }
  // floating origin: everything is drawn relative to the camera target
  rig.origin.set(tp);
  const cp = Math.cos(rig.pitch);
  camera.position.set(Math.sin(rig.yaw) * cp * dist, Math.sin(rig.pitch) * dist, Math.cos(rig.yaw) * cp * dist);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  camera.near = dist * 1e-4; camera.far = dist * 1e7;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  sys.place(rig.origin, camera.position, pxAt);
  // deep space: how far out are we (light years), relative to the Sun
  cosmos.update(view.w[2] > 0.99 ? dist / LY : 0, camera, dt, W, H);
  sys.scene.visible = cosmos.sysK > 0.01;
  // render
  renderer.clear();
  if (ground.active) {
    ground.update(time.d, dt);
    ground.render();
  } else {
    sky.render(renderer, camera, cosmos.skyK);
    cosmos.render(renderer, camera);
    if (sys.scene.visible) renderer.render(sys.scene, camera);
  }
  placeLabels();
  cosmos.placeLabels(W, H);
  if ((frames++ & 7) === 0) { timeEl.textContent = fmtDate(time.d); scaleBar(); if (ground.active) dayBtn.hidden = ground.isDay(); paintTitleCosmic(); }
  if (tour && tour.until && now > tour.until) nextTour();
  requestAnimationFrame(frame);
}

let lastCosmic = null;
function paintTitleCosmic() {
  const c = cosmos.level > 0.6 ? cosmos.current() : null;
  if (c !== lastCosmic) { lastCosmic = c; paintTitle(); }
}

const scaleEl = $(".scale");
function scaleBar() {
  const on = !ground.active && view.w[2] > 0.99 && view.t0 < 0;
  scaleEl.classList.toggle("is-on", on);
  if (!on) return;
  // width of the screen at the target, in km
  const halfH = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
  const km = 2 * rig.dist * Math.tan(halfH) * AU;
  const de = lang === "de";
  let txt;
  const ly = km / (AU * LY);
  if (km < 1e6) txt = fmt(km, 0) + " km";
  else if (ly < 0.05) txt = fmt(km / AU, km / AU < 10 ? 1 : 0) + (de ? " AE" : " AU");
  else if (ly < 1000) txt = fmt(ly, ly < 10 ? 1 : 0) + (de ? " Lichtjahre" : " light-years");
  else if (ly < 1e6) txt = fmt(ly / 1000, 0) + (de ? " Tsd. Lichtjahre" : " thousand light-years");
  else if (ly < 1e9) txt = fmt(ly / 1e6, 0) + (de ? " Mio. Lichtjahre" : " million light-years");
  else txt = fmt(ly / 1e9, 1) + (de ? " Mrd. Lichtjahre" : " billion light-years");
  scaleEl.querySelector("span").textContent = "⟷ " + txt;
}

readHash();
paintAll();
document.documentElement.lang = lang;
requestAnimationFrame((t) => { clock.last = t; requestAnimationFrame(frame); });
addEventListener("hashchange", () => { const a = location.hash; readHash(); paintAll(); });

// test hooks (Playwright)
window.__solar = { flyTo, setMode, land, leaveGround, rig, view, time, sys, cosmos, ground, openCard, setZoom, startTour, setSpeed };
