/* Ascent profiles from real flights (data: ascent-templates.js, built and validated by
   tools/spacex_ascent.py). Pure functions, no DOM: spacex.js and the node tests use them.

   - pickTemplate(m): which template fits a mission (vehicle from Launch Library 2's
     rocket configuration, then orbit class and inclination).
   - eventTimes(tpl, ll2Timeline): the launch's own LL2 event times (MECO, SECO-1, ...)
     over the template's defaults.
   - makeAscent(id, at, geom): altitude and speed against mission time, retimed onto
     those events and rescaled to the mission's launch azimuth; null past the template.
   Speeds: the webcast (and this page) shows speed relative to the ground; inertial speed
   is what moves the rocket along its orbit plane. groundFromInertial / inertialFromGround
   convert at any point of the plane (Clairaut: cos(lat)·sin(heading) = cos(incl)). */
import { TEMPLATES } from "./ascent-templates.js?v=at1";
import { R_E, D2R, OMEGA_E } from "./earth.js?v=e1";

export { TEMPLATES };

// LL2 timeline event -> template event key (tools/spacex_ascent.py EVENT_KEYS, same table)
export const LL2_EVENTS = {
  "MECO": "meco", "SECO-1": "seco", "SES-2": "ses2", "SECO-2": "seco2", "Orbital Insertion Burn Start": "oib",
  "Atmospheric Entry": "entry", "Starship Landing": "land", "Starship Catch": "land",
  "Starlink Deployment": "deploy", "Dragon Separation": "deploy", "Payload Separation": "deploy", "Payload Deployment Sequence Start": "deploy"
};
// event keys that retime the curves (the rest only label the clock)
const ANCHORS = ["meco", "seco", "oib", "entry", "land"];

// ISO 8601 duration ("PT2M26S", "-PT38M", "P0D") -> seconds
export function isoSeconds(s) {
  const m = /^(-)?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || ""));
  if (!m) return NaN;
  const v = (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0);
  return m[1] ? -v : v;
}

// LL2 "timeline" ([{type: {abbrev}, relative_time}]) -> {meco: s, seco: s, ...}, first of each, after liftoff
export function timelineFromLL2(tl) {
  const out = {};
  for (const e of Array.isArray(tl) ? tl : []) {
    const k = LL2_EVENTS[((e && e.type) || {}).abbrev];
    const t = isoSeconds(e && e.relative_time);
    if (k && t > 0 && !(k in out)) out[k] = t;
  }
  return out;
}

/* Which vehicle flies: Launch Library 2's rocket configuration (id, families, full name),
   the launch name only when a record has no configuration (old caches, fixtures). */
const LL2_CONFIG = { 164: "falcon-9", 161: "falcon-heavy" }; // Falcon 9 Block 5, Falcon Heavy
const ROCKET = { "falcon-9": "Falcon 9", "falcon-heavy": "Falcon Heavy", "starship": "Starship" };
const byLabel = (x) => /starship|super\s*heavy/i.test(x) ? "starship" : /falcon\s*heavy/i.test(x) ? "falcon-heavy" : /falcon\s*9/i.test(x) ? "falcon-9" : null;
export function vehicleOf(l) {
  const cfg = ((l && l.rocket) || {}).configuration || {};
  const fams = (cfg.families || []).map((f) => (typeof f === "string" ? f : (f && f.name) || "")).join(" ");
  const name = String((l && l.name) || "");
  const vehicle = LL2_CONFIG[cfg.id] || byLabel([cfg.full_name, cfg.name, fams].join(" ")) || byLabel(name.split("|")[0]) || "other";
  const rocket = ROCKET[vehicle] || String(cfg.name || name.split("|")[0]).replace(/\s*block\s*\d+/i, "").trim() || "SpaceX";
  return { vehicle, rocket };
}

const WHY = {
  "f9-leo": "Falcon 9 LEO", "f9-iss": "Falcon 9 ISS", "f9-gto": "Falcon 9 GTO", "f9-sso": "Falcon 9 SSO",
  "fh": "Falcon Heavy", "starship-orbit": "Starship orbital", "starship-sub": "Starship suborbital"
};
export function pickTemplate(m) {
  const ab = String(m.orbitAbbrev || "").toUpperCase();
  let id;
  if (m.vehicle === "starship") id = m.orbital ? "starship-orbit" : "starship-sub";
  else if (m.vehicle === "falcon-heavy") id = "fh";
  else if (m.iss) id = "f9-iss";
  else if (m.gto) id = "f9-gto";
  else if (ab === "SSO" && !m.starlinkLike) id = "f9-sso";
  else id = "f9-leo"; // Starlink of every shell, other LEO, polar, classified: the heavy LEO ascent
  return { id, label: WHY[id] + " template", from: TEMPLATES[id].from };
}

// the launch's own events where LL2 has them, the template's defaults for the rest; kept in order
export function eventTimes(id, own) {
  const tpl = TEMPLATES[id];
  const at = { ...tpl.at };
  for (const [k, v] of Object.entries(own || {})) if (isFinite(v) && v > 0) at[k] = v;
  // anchors must rise with time; drop any default that a launch's own event overtook
  let last = 0;
  for (const k of ANCHORS) {
    if (!(k in at)) continue;
    if (at[k] <= last + 5) delete at[k]; else last = at[k];
  }
  return at;
}

// sin(heading) of the orbit plane at latitude lat (deg), from its inclination
export function eastShare(lat, incl) {
  return Math.max(-1, Math.min(1, Math.cos(incl * D2R) / Math.cos(lat * D2R)));
}
const rotSpeed = (lat, h) => OMEGA_E * (R_E + h) * Math.cos(lat * D2R); // km/s
export function inertialFromGround(vg, lat, incl, h) {
  const e = eastShare(lat, incl), w = rotSpeed(lat, h);
  return e * w + Math.sqrt(Math.max(e * e * w * w - w * w + vg * vg, 0));
}
export function groundFromInertial(v, lat, incl, h) {
  const e = eastShare(lat, incl), w = rotSpeed(lat, h);
  return Math.sqrt(Math.max(v * v - 2 * v * w * e + w * w, 0));
}

function warp(t, pairs) {
  for (let k = 1; k < pairs.length; k++) {
    const [a0, b0] = pairs[k - 1], [a1, b1] = pairs[k];
    if (t <= a1) return b0 + (t - a0) * (b1 - b0) / (a1 - a0);
  }
  const [a0, b0] = pairs[pairs.length - 1];
  return b0 + (t - a0);
}

/* geom: { lat, incl } of the mission (pad latitude, plane inclination).
   Returns { id, end (mission s), at, sample(t) -> {alt km, vh, vz, vg (ground km/s)} | null }. */
export function makeAscent(id, at, geom) {
  const tpl = TEMPLATES[id];
  const keys = ANCHORS.filter((k) => k in tpl.src && k in at);
  const toTpl = [[0, 0], ...keys.map((k) => [at[k], tpl.src[k]])];    // mission -> template time
  const toMis = toTpl.map(([a, b]) => [b, a]);                        // template -> mission time
  const tplEnd = (tpl.alt.length - 1) * tpl.step;
  // horizontal ground speed scale: same inertial speed at SECO-1, this mission's azimuth
  const vS = tpl.seco_v / 1000, hS = tpl.seco_h;
  const vIn = inertialFromGround(vS, tpl.lat, tpl.incl, hS);
  const k = groundFromInertial(vIn, geom.lat, geom.incl, hS) / vS;
  const at1 = (arr, f) => { const i = Math.min(Math.floor(f), arr.length - 2), w = f - i; return arr[i] + (arr[i + 1] - arr[i]) * w; };
  return {
    id, at, k, end: warp(tplEnd, toMis), from: tpl.from,
    tplTime: (t) => warp(t, toTpl),
    sample(t) {
      if (t <= 0) return { alt: 0, vh: 0, vz: 0, vg: 0 };
      const tt = warp(t, toTpl);
      if (tt > tplEnd) return null;
      const f = tt / tpl.step;
      const alt = at1(tpl.alt, f), vh = at1(tpl.vh, f) * k / 1000, vz = at1(tpl.vz, f) / 1000;
      return { alt, vh, vz, vg: Math.hypot(vh, vz) };
    }
  };
}
