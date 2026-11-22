import * as THREE from "/vendor/three.module.min.js";
import { addEarth, sunDir, ll2v } from "./globe-core.js?v=g4";
import { LIVE_BEFORE, LIVE_AFTER, lkey, classifyLaunches, chooseSide } from "./pick-launch.js?v=sx15";
import { R_E, MU, OMEGA_E, D2R } from "./earth.js?v=e1";
import { vehicleOf, pickTemplate, eventTimes, makeAscent, timelineFromLL2, groundFromInertial, inertialFromGround } from "./ascent.js?v=as1";
import { normalizeTLE, parse3LE, preFromTLE, ommToTLE, pickTrackedObject } from "./tle.js?v=tl1";

/* ============================================================
   SpaceX · flight globe
   Data: Launch Library 2 (the next / last SpaceX launch, any
   vehicle, and its event timeline) + CelesTrak (pre-launch
   prediction, then the tracked elements of the launch's upper
   stage or payloads), else a nominal profile from real flights'
   telemetry (ascent.js), labelled as such.
   ============================================================ */

const TZ = "Europe/Vienna";
const DAY = 86400;

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// signed difference in (-180, 180]; JS % keeps the sign, so normalise twice
const wrapLon = (l) => ((((l + 180) % 360) + 360) % 360) - 180;

/* ---------------- data: Launch Library 2 ---------------- */
const LL_HOSTS = ["https://ll.thespacedevs.com"]; // production only; lldev is a stale sandbox
const LL_CACHE = "spacex.ll2.v2"; // v2: launch id, COSPAR designator, rocket configuration
const LL_TTL = 30 * 60 * 1000;
const SPACEX_LSP = 121; // Launch Library 2 agency id of SpaceX

// Last-known data so the page still works offline / when rate-limited.
const BAKED = {
  previous: [{
    id: "0f867f0c-5422-4d44-93b8-d7faaae7019b", launch_designator: "2026-256",
    name: "Starship | Starlink Group 31-2 (Starship Flight 15)",
    net: "2026-11-13T22:47:36Z", net_precision: "Second",
    status: { abbrev: "Success" }, rocket: { configuration: { id: 522, name: "Starship", full_name: "Starship V3", families: ["Starship"] } },
    pad: { name: "Orbital Launch Pad 2", latitude: 25.99677, longitude: -97.15799, location: { name: "SpaceX Starbase, TX, USA" } },
    mission: { name: "Starlink Group 31-2 (Starship Flight 15)", orbit: { abbrev: "LEO" }, description: "The ship is expected to fly at an altitude approximately 275 km above Earth and complete approximately 14 orbits around the planet for more than 22 hours, with the ship expected to attempt returning back to Starbase, Texas on its launch pad by pad arms catching." }
  }, {
    id: "57ce0a39-d035-4f16-a418-bd6108f78199", launch_designator: "2026-246",
    name: "Falcon 9 Block 5 | Starlink Group 15-18",
    net: "2026-10-31T04:04:34Z", net_precision: "Second",
    status: { abbrev: "Success" }, rocket: { configuration: { id: 164, name: "Falcon 9", full_name: "Falcon 9 Block 5", families: ["Falcon", "Falcon 9"] } },
    pad: { name: "Space Launch Complex 4E", latitude: 34.632, longitude: -120.611, location: { name: "Vandenberg SFB, CA, USA" } },
    mission: { name: "Starlink Group 15-18", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "A batch of 27 satellites for the Starlink mega-constellation." }
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

// LL2 often leaves a just-flown launch in "upcoming" as well as "previous".
// Keep both lists intact; classifyLaunches treats them as one pool.

async function loadLaunches() {
  const c = readCache(LL_CACHE, LL_TTL);
  if (c && c.fresh) return { ...c.data, cached: true };
  try {
    const [up, prev] = await Promise.all([
      fetchLL("/2.3.0/launches/upcoming/?lsp__id=" + SPACEX_LSP + "&limit=8&mode=normal&ordering=net"),
      fetchLL("/2.3.0/launches/previous/?lsp__id=" + SPACEX_LSP + "&limit=8&mode=normal&ordering=-net")
    ]);
    const data = {
      upcoming: (up.results || []).map(slim),
      previous: (prev.results || []).map(slim)
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
  const cfg = (l.rocket || {}).configuration || {};
  return {
    id: l.id || null, launch_designator: l.launch_designator || null,
    name: l.name, net: l.net, net_precision: (l.net_precision || {}).name || null,
    status: { abbrev: (l.status || {}).abbrev || "" },
    rocket: { configuration: { id: cfg.id || null, name: cfg.name || "", full_name: cfg.full_name || "", families: (cfg.families || []).map((f) => f.name || "") } },
    pad: { name: pad.name, latitude: +pad.latitude, longitude: +pad.longitude, location: { name: (pad.location || {}).name || "" } },
    mission: { name: m.name || "", orbit: { abbrev: (m.orbit || {}).abbrev || "", name: (m.orbit || {}).name || "" }, description: m.description || "" }
  };
}

/* ---------------- data: Launch Library 2 timeline ----------------
   The chosen launch's own event times (MECO, SECO-1, SES-2, deployment ...) retime the
   ascent template. Only "detailed" mode carries them, so it is one request for the
   launch on screen: cached 6 h once it has a timeline, else asked again after 2 h. */
const TL_CACHE = "spacex.timeline.v1";
async function loadTimeline(l) {
  if (!l || !l.id) return {};
  const key = TL_CACHE + "." + l.id;
  const c = readCache(key, 864e5);
  if (c && Date.now() - c.ts < (c.data && Object.keys(c.data).length ? 6 : 2) * 3600e3) return c.data;
  try {
    const r = await fetchLL("/2.3.0/launches/" + encodeURIComponent(l.id) + "/?mode=detailed");
    const tl = timelineFromLL2(r && r.timeline);
    writeCache(key, tl);
    return tl;
  } catch (e) {
    return c ? c.data : {};
  }
}

/* ---------------- data: CelesTrak, the tracked objects of a flown launch ----------------
   As soon as 18 SDS catalogues a launch, CelesTrak lists its objects under the COSPAR
   designator Launch Library 2 gives it (launch_designator, e.g. 2026-246):
   - satcat/records.php?INTDES= answers 200 with an empty body until then (no console
     noise), so it is the poll; gp.php?INTDES=&FORMAT=json (OMM, which carries 6-digit
     catalogue numbers) is asked only once SATCAT lists live objects.
   - Without a designator yet, the last-30-days set (SATCAT + GP) stands in, matched by
     UTC launch date + range (AFWTR = Vandenberg, AFETR = Florida) and names.
   Of the launch's objects the upper stage (R/B) is followed while it is in orbit, else
   its payloads (tle.js pickTrackedObject). Polled at most every 20 min in the first three
   days after liftoff (every 6 h after that); a found set is kept 2 h, CelesTrak's update
   rate. Every answer carries Access-Control-Allow-Origin: * (checked Nov 2026). */
const CT = "https://celestrak.org/";
const TRK_CACHE = "spacex.tracked.v1";
const TRK_HIT_TTL = 2 * 3600e3;
const trkMissTtl = (age) => (age < 3 * DAY * 1000 ? 20 * 60e3 : 6 * 3600e3);
const OMM_KEYS = ["OBJECT_NAME", "OBJECT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER",
  "MEAN_ANOMALY", "EPHEMERIS_TYPE", "CLASSIFICATION_TYPE", "NORAD_CAT_ID", "ELEMENT_SET_NO", "REV_AT_EPOCH", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT"];
// SATCAT rows + GP (OMM) rows -> [{ name, id, type, date, site, decay, omm }]
function joinObjects(sat, gp) {
  const els = new Map((Array.isArray(gp) ? gp : []).map((g) => [+g.NORAD_CAT_ID, Object.fromEntries(OMM_KEYS.map((k) => [k, g[k]]))]));
  return (Array.isArray(sat) ? sat : []).filter((x) => els.has(+x.NORAD_CAT_ID)).map((x) => ({
    name: x.OBJECT_NAME, id: x.OBJECT_ID, type: x.OBJECT_TYPE, date: x.LAUNCH_DATE, site: x.LAUNCH_SITE, decay: x.DECAY_DATE || "", omm: els.get(+x.NORAD_CAT_ID)
  }));
}
const jsonOrEmpty = (txt) => { txt = String(txt || "").trim(); return txt.startsWith("[") ? JSON.parse(txt) : []; };
async function trackedByDesignator(m, age) {
  const des = m.designator;
  const key = TRK_CACHE + "." + des;
  const c = readCache(key, 864e5);
  if (c && Date.now() - c.ts < (c.data ? TRK_HIT_TTL : trkMissTtl(age))) return c.data;
  try {
    const sat = jsonOrEmpty(await fetchText(CT + "satcat/records.php?INTDES=" + des + "&FORMAT=json", 15000));
    let objs = [];
    if (sat.some((x) => !x.DECAY_DATE)) {
      const gp = await fetchText(CT + "NORAD/elements/gp.php?INTDES=" + des + "&FORMAT=json", 15000).then(jsonOrEmpty, () => []);
      objs = joinObjects(sat, gp);
    }
    const found = pickTrackedObject(objs);
    writeCache(key, found);
    return found;
  } catch (e) {
    return c ? c.data : null;
  }
}
const RECENT_CACHE = "spacex.recent.v2"; // v2: whole OMM per object
const RECENT_TTL = 3 * 3600e3;
const SITE_CODE = { vandenberg: "AFWTR", florida: "AFETR" };
let recentP = null, recentAt = 0;
function loadRecentSet() {
  if (!recentP || Date.now() - recentAt > RECENT_TTL) recentAt = Date.now(), recentP = (async () => {
    const c = readCache(RECENT_CACHE, RECENT_TTL);
    if (c && c.fresh) return c.data;
    try {
      const [sat, gp] = await Promise.all([
        fetchJSON(CT + "satcat/records.php?GROUP=last-30-days&FORMAT=json", 25000),
        fetchJSON(CT + "NORAD/elements/gp.php?GROUP=last-30-days&FORMAT=json", 25000)
      ]);
      const data = joinObjects(sat, gp);
      writeCache(RECENT_CACHE, data);
      return data;
    } catch (e) {
      recentP = null; // try again on the next check
      return c ? c.data : null;
    }
  })();
  return recentP;
}
async function trackedByDate(m) {
  const set = await loadRecentSet();
  if (!Array.isArray(set)) return null;
  const day = new Date(m.net.getTime()).toISOString().slice(0, 10);
  const code = SITE_CODE[m.site_kind] || null;
  let objs = set.filter((o) => o.date === day && (!code || o.site === code));
  const named = objs.filter((o) => m.starlinkLike ? /^STARLINK/i.test(o.name) || o.type === "R/B" : m.vehicle === "starship" ? /^STARSHIP/i.test(o.name) : true);
  if (m.starlinkLike || !code) objs = named;          // unknown range: only trust names that fit
  if (!objs.length) return null;
  // several launches that day: the biggest group (one COSPAR launch number) that fits
  const groups = new Map();
  for (const o of objs) { const k = String(o.id).slice(0, 8); groups.set(k, (groups.get(k) || []).concat(o)); }
  return pickTrackedObject([...groups.values()].sort((a, b) => b.length - a.length)[0]);
}
// one catalogued object, as the trajectory code wants it
function trackedSet(o) {
  const tle = ommToTLE(o.omm);
  if (!tle) return null;
  const pre = preFromTLE(o.name, tle[0], tle[1], "CelesTrak GP");
  return pre && { ...pre, intdes: String(o.id || ""), role: o.role, count: o.count || 1, omm: o.omm };
}
async function loadTracked(m) {
  const age = Date.now() - m.net.getTime();
  if (age < 0 || age > 31 * DAY * 1000) return null;
  const o = m.designator ? await trackedByDesignator(m, age) : await trackedByDate(m);
  return o ? trackedSet(o) : null;
}
function gmstRad(ms) {
  const d = ms / 864e5 - 10957.5;
  return ((((280.46061837 + 360.98564736629 * d) % 360) + 360) % 360) * D2R;
}
/* Elements this close to liftoff are propagated with SGP4 back to the ascent (position and
   phase); older ones only give the orbit: inclination, altitude and the node, regressed back
   to T-0 with J2, which picks the branch the rocket flew. */
const SGP4_SPAN = 3 * DAY * 1000;
function flownOrbit(gp, m) {
  const o = gp.omm, epochMs = gp.epochMs;
  const i = +o.INCLINATION, e = +o.ECCENTRICITY;
  const n = +o.MEAN_MOTION * 2 * Math.PI / DAY, a = Math.cbrt(MU / (n * n)), Re = 6378.137, J2 = 1.08263e-3;
  const dOm = -1.5 * n * J2 * Math.pow(Re / a, 2) * Math.cos(i * D2R) / Math.pow(1 - e * e, 2); // rad/s
  const raan0 = +o.RA_OF_ASC_NODE * D2R + dOm * (m.net.getTime() - epochMs) / 1000;
  return { name: gp.name, intdes: gp.intdes, role: gp.role, INCLINATION: i, MEAN_MOTION: +o.MEAN_MOTION, nodeLonT0: raan0 - gmstRad(m.net.getTime()), epochMs };
}
// tracked elements -> what buildTrajectory reads: full SGP4 ("tracked"), or the orbit plane only ("flown")
function trackedCt(gp, m, fixture) {
  const leo = gp.MEAN_MOTION > 11 && gp.MEAN_MOTION < 17.5;
  if (Math.abs(gp.epochMs - m.net.getTime()) < SGP4_SPAN) return { gp, tracked: gp, fixture };
  if (m.orbital && !leo) return null; // a weeks-old GTO / high orbit set does not fit the circular model
  return { flown: flownOrbit(gp, m), tracked: gp, planeOnly: true, fixture };
}

/* ---------------- data: CelesTrak pre-launch (SupGP) ----------------
   What sup-gp.php supports (checked with curl, Nov 2026; every answer
   carries Access-Control-Allow-Origin: *):
   - FILE=<set>: the only way to reach a launch's pre-launch file
     (e.g. FILE=starlink-g31-2 -> "STARLINK-G31-2 SINGLE", cat 72001). A
     missing file answers HTTP 200 "Invalid query ... not found", so guessing
     file names costs nothing in the console.
   - NAME=<part>: substring search, but only over the operational SupGP data
     (NAME=STARLINK-100 finds STARLINK-1008, NAME=STARLINK-G31-2 finds
     nothing). Misses answer HTTP 404, so NAME= is asked once (NAME=STARSHIP
     covers STARSHIP-16, STARSHIP FLIGHT 16 ...) and only close to liftoff.
   - SOURCE= / INTDES= / CATNR= also search the operational data only; the
     index page lists the standard files but not the pre-launch ones.
   So: guess a handful of FILE= names from the LL2 launch and mission names,
   fetch them in parallel with a timeout, and accept a set only if its epoch
   and inclination fit this liftoff. Results (hits and misses) are cached
   for hours to stay well within CelesTrak's usage policy. */
const SUP = "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?";
const PRE_CACHE = "spacex.prelaunch.v1";
const PRE_HIT_TTL = 3 * 3600e3;    // a found set: keep 3 h
const PRE_MISS_TTL = 2 * 3600e3;   // nothing yet: ask again after 2 h (6 h when liftoff is > 3 days out)

const slugify = (x) => String(x || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function prelaunchFiles(m) {
  const out = [];
  const add = (f) => { f = slugify(f); if (f && f.length > 3 && !out.includes(f)) out.push(f); };
  const names = [String((m.raw && m.raw.name) || ""), m.missionName || ""];
  for (const n of names) {
    const g = n.match(/starlink[\s-]*(?:group[\s-]*|g)(\d+)-(\d+)/i);
    if (g) add("starlink-g" + g[1] + "-" + g[2]);
  }
  if (m.vehicle === "starship" && m.flightNo) { add("starship-flight-" + m.flightNo); add("starship-" + m.flightNo); }
  for (const n of names) {
    const part = n.split("|").slice(1).join(" ").trim() || n; // "Falcon 9 Block 5 | X" / "Starship | X (Flight 16)" -> "X"
    const base = slugify(part.replace(/^spacex\s+/i, ""));
    if (base && !/^starship(-flight)?-?\d*$/.test(base) && !/^starlink-group-\d+-\d+$/.test(base)) add(base);
  }
  return out.slice(0, 5);
}
function plausibleIncl(m) {
  const nom = nominalOrbit(m), latA = Math.abs(m.lat);
  const ab = String(m.orbitAbbrev || "").toUpperCase();
  if (m.targetIncl) return [m.targetIncl - 2.5, m.targetIncl + 2.5];
  if (ab === "SSO" || ab === "PO") return [80, 105];
  if (m.iss) return [50.6, 52.6];
  // anything a vehicle from this pad can reach without a big dogleg
  return [latA - 0.5, Math.max(75, nom.incl + 5)];
}
async function loadPrelaunch(m) {
  // pre-launch sets only exist around launch; skip long-past or far-future flights
  const dt = Date.now() - m.net.getTime();
  if (Math.abs(dt) > 10 * DAY * 1000) return null;
  const key = PRE_CACHE + "." + slugify(m.raw && m.raw.name).slice(0, 60) + "." + m.net.getTime();
  const c = readCache(key, 864e5);
  if (c && Date.now() - c.ts < (c.data ? PRE_HIT_TTL : (dt < -3 * DAY * 1000 ? 3 : 1) * PRE_MISS_TTL)) return c.data;
  const t0 = m.net.getTime();
  const [iLo, iHi] = plausibleIncl(m);
  const ship = m.vehicle !== "starship" ? /(?!)/ : m.flightNo ? new RegExp("^STARSHIP[\\s-]*(?:FLIGHT[\\s-]*|F)?" + m.flightNo + "\\b", "i") : /^STARSHIP\b/i;
  const files = prelaunchFiles(m);
  const tries = files.map((f) => ({ q: "FILE=" + f + "&FORMAT=3LE", file: f }));
  if (m.vehicle === "starship" && dt > -3 * DAY * 1000 && dt < 2 * DAY * 1000) tries.push({ q: "NAME=STARSHIP&FORMAT=3LE", file: null });
  let anyOk = false;
  const answers = await Promise.all(tries.map(async (tr) => {
    try {
      const txt = await fetchText(SUP + tr.q, 8000).catch((e) => { if (/404/.test(String(e))) return ""; throw e; });
      anyOk = true;
      if (!txt || /^(No SupGP|Invalid query)/i.test(txt.trim())) return [];
      return parse3LE(txt).map((x) => ({ ...x, tr }));
    } catch (e) { return []; }
  }));
  const cands = [];
  for (const x of answers.flat()) {
    const pre = preFromTLE(x.name, x.l1, x.l2, x.tr.q.split("&")[0]);
    if (!pre) continue;
    const okEpoch = pre.epochMs > t0 - 3600e3 && pre.epochMs < t0 + 6 * 3600e3;
    const okIncl = pre.INCLINATION >= iLo && pre.INCLINATION <= iHi;
    // LEO only: a GTO / high-orbit set (or a later stage of one) does not fit the
    // circular model, so those missions keep the nominal parking-orbit profile
    const okMM = pre.MEAN_MOTION > 11 && pre.MEAN_MOTION < 17.5;
    if (!okEpoch || !okIncl || !okMM) continue;
    const isShip = ship.test(x.name);
    // a non-ship object is only trusted from this mission's own pre-launch file
    // (e.g. the Starlink stack, which rides in the ship's orbit until deployment)
    if (!isShip && !x.tr.file) continue;
    pre.proxy = isShip ? null : (/^starlink-g/.test(x.tr.file) ? x.tr.file.replace(/^starlink-g/i, "Starlink G") : x.tr.file);
    pre.rank = (isShip ? 0 : 10) + tries.indexOf(x.tr);
    cands.push(pre);
  }
  cands.sort((a, b) => a.rank - b.rank);
  const found = cands[0] || null;
  if (anyOk) writeCache(key, found);
  return found || (c ? c.data : null);
}

// Harmless test fixtures (no network for the launch or the orbit):
//   ?fixture=f14-prelaunch  Starbase flight with a pre-launch element set
//   ?fixture=f14-tracked    the same flight, tracked: the ship's catalogued elements
//   ?fixture=florida        Starlink-like flight from LC-39A, nominal 53° NE
//   ?fixture=florida-hls    non-Starlink LEO flight from SLC-37, nominal 43° SE
//   ?fixture=f9-vandenberg  Falcon 9 Starlink Group 15 from SLC-4E, nominal 70° SSE
//   ?fixture=f9-florida     Falcon 9 Starlink Group 10 from SLC-40, nominal 43° SE
//   ?fixture=f9-iss         Falcon 9 Cargo Dragon from LC-39A, nominal 51.6° NE
//   ?fixture=f9-gto         Falcon 9 GTO from SLC-40, parking orbit + transfer burn
//   ?fixture=fh             Falcon Heavy from LC-39A to GTO
//   ?fixture=last-flight    next launch in 2 days without data; with &mission=latest the last
//                           flight (Starlink 15-18) with its real catalogued orbit plane
const VSFB = { name: "Space Launch Complex 4E", latitude: 34.632, longitude: -120.611, location: { name: "Vandenberg SFB, CA, USA" } };
const F9 = { configuration: { id: 164, name: "Falcon 9", full_name: "Falcon 9 Block 5", families: ["Falcon", "Falcon 9"] } };
const FH = { configuration: { id: 161, name: "Falcon Heavy", full_name: "Falcon Heavy", families: ["Falcon"] } };
const F14 = {
  name: "Starship | Starlink Group 31-1 (Starship Flight 14)", net: "2026-09-28T12:48:59Z", net_precision: "Second",
  status: { abbrev: "Success" },
  pad: { name: "Orbital Launch Pad 2", latitude: 25.99677, longitude: -97.15799, location: { name: "SpaceX Starbase, TX, USA" } },
  mission: { orbit: { abbrev: "LEO" }, description: "The ship is expected to fly at an altitude approximately 275 km above Earth and complete approximately 6 orbits around the planet for nearly 10 hours, with splashdown targeted in the Pacific Ocean west of Chile." }
};
const CCSFS40 = { name: "Space Launch Complex 40", latitude: 28.56194122, longitude: -80.57735736, location: { name: "Cape Canaveral SFS, FL, USA" } };
const KSC39A = { name: "Launch Complex 39A", latitude: 28.60822681, longitude: -80.60428186, location: { name: "Kennedy Space Center, FL, USA" } };
const FIXTURES = {
  "f14-prelaunch": {
    launch: F14,
    tle: ["STARSHIP-14",
      "1 99998U 26271.55155093 .00000000 00000-0 50000-4 0 07",
      "2 99998 30.5122 340.6000 0001503 0.0000 218.3000 15.99431098 04"]
  },
  "f14-tracked": {
    launch: F14,
    // the pre-launch set above as a catalogued object (OMM, as gp.php?INTDES= answers)
    tracked: { name: "STARSHIP-14", id: "2026-225A", type: "PAY", decay: "", omm: {
      OBJECT_NAME: "STARSHIP-14", OBJECT_ID: "2026-225A", EPOCH: "2026-09-28T13:14:13.000", MEAN_MOTION: 15.99431098, ECCENTRICITY: 0.0001503,
      INCLINATION: 30.5122, RA_OF_ASC_NODE: 340.6, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 218.3, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U",
      NORAD_CAT_ID: 99998, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 0, BSTAR: 0.00005, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0 } }
  },
  "f9-gto": {
    launch: {
      name: "Falcon 9 Block 5 | Test GEO Sat 1", net: "2026-10-20T14:00:00Z", net_precision: "Second",
      status: { abbrev: "Success" }, rocket: F9, pad: CCSFS40,
      mission: { name: "Test GEO Sat 1", orbit: { abbrev: "GTO", name: "Geostationary Transfer Orbit" }, description: "Test fixture. A communications satellite to geostationary transfer orbit." }
    }
  },
  "fh": {
    launch: {
      name: "Falcon Heavy | Test GEO Sat 2", net: "2026-10-20T14:00:00Z", net_precision: "Second",
      status: { abbrev: "Success" }, rocket: FH, pad: KSC39A,
      mission: { name: "Test GEO Sat 2", orbit: { abbrev: "GTO", name: "Geostationary Transfer Orbit" }, description: "Test fixture. A heavy satellite to geostationary transfer orbit." }
    }
  },
  "florida": {
    launch: {
      name: "Starship | Starlink Group 40-1 (Starship Flight 99)", net: "2026-10-20T14:00:00Z", net_precision: "Second",
      status: { abbrev: "Success" },
      pad: { name: "Launch Complex 39A Starship Pad", latitude: 28.60822681, longitude: -80.60428186, location: { name: "Kennedy Space Center, FL, USA" } },
      mission: { name: "Starlink Group 40-1", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "Test fixture. The ship is expected to fly at an altitude approximately 275 km above Earth and complete approximately 3 orbits around the planet, with splashdown targeted in the Indian Ocean." }
    }
  },
  "florida-hls": {
    launch: {
      name: "Starship | Test Mission (Starship Flight 98)", net: "2026-10-20T14:00:00Z", net_precision: "Second",
      status: { abbrev: "Success" },
      pad: { name: "Space Launch Complex 37", latitude: 28.5314, longitude: -80.5662, location: { name: "Cape Canaveral SFS, FL, USA" } },
      mission: { name: "Test Mission", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "Test fixture. The ship is expected to fly at an altitude approximately 275 km above Earth and complete approximately 3 orbits around the planet, with splashdown targeted in the Indian Ocean." }
    }
  },
  "f9-vandenberg": {
    launch: {
      name: "Falcon 9 Block 5 | Starlink Group 15-20", net: "2026-10-20T14:00:00Z", net_precision: "Second",
      status: { abbrev: "Success" }, rocket: F9, pad: VSFB,
      mission: { name: "Starlink Group 15-20", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "Test fixture. A batch of Starlink satellites." }
    }
  },
  "f9-florida": {
    launch: {
      name: "Falcon 9 Block 5 | Starlink Group 10-30", net: "2026-10-20T14:00:00Z", net_precision: "Second",
      status: { abbrev: "Success" }, rocket: F9,
      pad: CCSFS40,
      mission: { name: "Starlink Group 10-30", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "Test fixture. A batch of Starlink satellites." }
    }
  },
  "f9-iss": {
    launch: {
      name: "Falcon 9 Block 5 | Dragon CRS-2 SpX-99", net: "2026-10-20T14:00:00Z", net_precision: "Second",
      status: { abbrev: "Success" }, rocket: F9,
      pad: KSC39A,
      mission: { name: "Dragon CRS-2 SpX-99", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "Test fixture. Cargo Dragon resupply mission to the International Space Station." }
    }
  },
  "two-flying": {
    upcoming: [{
      name: "Falcon 9 Block 5 | Starlink Group 10-99", net: null, inDays: -0.02, net_precision: "Minute",
      status: { abbrev: "In Flight" }, rocket: F9,
      pad: CCSFS40,
      mission: { name: "Starlink Group 10-99", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "Test fixture. Second of two launches in flight at once." }
    }, {
      name: "Falcon 9 Block 5 | USSF-999", net: null, inDays: 2.3, net_precision: "Minute",
      status: { abbrev: "Go" }, rocket: F9, pad: VSFB,
      mission: { name: "USSF-999", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "Test fixture. The next launch after the two in flight." }
    }],
    previous: [{
      name: "Falcon 9 Block 5 | Starlink Group 17-99", net: null, inDays: -0.06, net_precision: "Minute",
      status: { abbrev: "Success" }, rocket: F9, pad: VSFB,
      mission: { name: "Starlink Group 17-99", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "Test fixture. First of two launches in flight at once." }
    }]
  },
  "last-flight": {
    upcoming: [{
      name: "Falcon 9 Block 5 | USSF-999", net: null, inDays: 2.3, net_precision: "Minute",
      status: { abbrev: "Go" }, rocket: F9, pad: VSFB,
      mission: { name: "USSF-999", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "Test fixture. A classified mission without pre-launch data." }
    }],
    previous: [{
      name: "Falcon 9 Block 5 | Starlink Group 15-18", net: "2026-10-31T04:04:34Z", net_precision: "Second",
      status: { abbrev: "Success" }, rocket: F9, pad: VSFB,
      mission: { name: "Starlink Group 15-18", orbit: { abbrev: "LEO", name: "Low Earth Orbit" }, description: "A batch of 27 satellites for the Starlink mega-constellation." }
    }],
    // CelesTrak GP (OMM) for 2026-246P (STARLINK-38183), 21 Nov 2026: three weeks after liftoff,
    // so only its plane is used (SGP4 back to the ascent only for sets < 3 days after T-0)
    tracked: { "Falcon 9 Block 5 | Starlink Group 15-18": { name: "STARLINK-38183", id: "2026-246P", type: "PAY", decay: "", role: "payload", count: 27, omm: {
      OBJECT_NAME: "STARLINK-38183", OBJECT_ID: "2026-246P", EPOCH: "2026-11-21T23:14:34.774656", MEAN_MOTION: 15.68347885, ECCENTRICITY: 0.00035214,
      INCLINATION: 69.9987, RA_OF_ASC_NODE: 113.9265, ARG_OF_PERICENTER: 273.7136, MEAN_ANOMALY: 86.3657, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U",
      NORAD_CAT_ID: 101243, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 471, BSTAR: 0.00053546257, MEAN_MOTION_DOT: 0.0006058, MEAN_MOTION_DDOT: 0 } } }
  }
};
// every fixture as { upcoming, previous, tle: {launch name: 3LE}, tracked: {launch name: catalogued object} }
function activeFixture() {
  let f = null;
  try { f = FIXTURES[new URLSearchParams(location.search).get("fixture")] || null; } catch (e) { f = null; }
  if (!f) return null;
  if (f.launch) return { upcoming: [], previous: [f.launch], tle: f.tle ? { [f.launch.name]: f.tle } : {}, tracked: f.tracked ? { [f.launch.name]: pickTrackedObject([f.tracked]) } : {} };
  const when = (l) => l.net ? l : { ...l, net: new Date(Math.round((Date.now() + l.inDays * DAY * 1000) / 60000) * 60000).toISOString() };
  return { upcoming: (f.upcoming || []).map(when), previous: (f.previous || []).map(when), tle: f.tle || {}, tracked: f.tracked || {} };
}

/* ---------------- mission model ---------------- */
function parseMission(l) {
  const name = String(l.name || "SpaceX");
  const { vehicle, rocket } = vehicleOf(l);
  const ship = vehicle === "starship";
  const after = (name.split("|").slice(1).join("|").trim() || name).replace(/^spacex\s+/i, "");
  const fm = ship ? name.match(/flight\s*(\d+)/i) : null;
  const flightNo = fm ? +fm[1] : null;
  const short = flightNo ? "Starship Flight " + flightNo : after.replace(/^starlink group\s+/i, "Starlink ");
  const title = flightNo ? "STARSHIP FLIGHT " + flightNo : (rocket + " · " + short).toUpperCase();
  const desc = (l.mission || {}).description || "";
  const orbitAbbrev = (((l.mission || {}).orbit || {}).abbrev || "").toUpperCase();
  const altM = ship ? desc.match(/altitude (?:of )?(?:approximately |about |around )?(\d{3})\s*km/i) : null;
  const orbM = ship ? desc.match(/(?:approximately |about )?(\d{1,2})\s+orbits/i) : null;
  const hrsM = ship ? desc.match(/for (?:more than |nearly |about |approximately |around )?(\d{1,2}(?:\.\d)?)\s*hours/i) : null;
  const rtls = ship && /back to (?:starbase|the launch site)|returning (?:the )?.{0,40}?(?:back )?to (?:the )?launch site|pad arms catching|catch(?:ing)? the ship/i.test(desc) && /ship/i.test(desc);
  const splM = ship ? desc.match(/splashdown (?:targeted |planned )?in (?:the )?([A-Za-z ,]+?)(?:\.|,|$)/i) : null;
  // Starship: orbital only with an orbit class (its test flights were suborbital); Falcon: orbital unless SUB
  const orbital = ship ? !!(orbitAbbrev && orbitAbbrev !== "SUB") : orbitAbbrev !== "SUB";
  const pad = l.pad || {};
  const lat = isFinite(pad.latitude) && pad.latitude !== null ? +pad.latitude : 25.99677;
  const lon = isFinite(pad.longitude) && pad.longitude !== null ? +pad.longitude : -97.15799;
  const inclM = desc.match(/(\d{1,3}(?:\.\d+)?)\s*(?:°|deg(?:rees?)?)\s*(?:orbital\s+)?inclination|inclination (?:of )?(?:approximately |about |around |~)?(\d{1,3}(?:\.\d+)?)\s*(?:°|deg)/i);
  const missionName = String((l.mission || {}).name || "");
  const all = name + " " + missionName;
  const sg = all.match(/starlink[\s-]*(?:group[\s-]*|g)(\d+)-(\d+)/i);
  const iss = /\b(ISS|CRS|Crew-\d+|Ax-\d+|Axiom|Cygnus|Cargo Dragon)\b/i.test(all) || /international space station/i.test(desc);
  // a Dragon on top instead of a fairing (Cygnus, NG-xx, flies under a fairing)
  const dragon = vehicle === "falcon-9" && /\b(Dragon|Crew-\d+|Ax-\d+|Axiom|SpX-\d+|CRS-\d+|Fram2|Polaris)\b/i.test(all + " " + desc) && !/\b(Cygnus|NG-\d+)\b/i.test(all);
  return {
    raw: l,
    missionName,
    orbitAbbrev,
    vehicle,
    rocket,
    short,
    site_kind: siteKind(lat, lon, ((pad.location || {}).name || "") + " " + (pad.name || "")),
    targetIncl: inclM ? +(inclM[1] || inclM[2]) : null,
    starlinkLike: /starlink/i.test(all),
    starlinkGroup: sg ? +sg[1] : null,
    iss,
    dragon,
    gto: /^(GTO|GSO|GEO|GSTO|SSGTO|MEO|HEO|LO|TLI|HCO|SO|ELL)$/.test(orbitAbbrev),
    name: after,
    title,
    flightNo,
    designator: /^\d{4}-\d{3}$/.test(l.launch_designator || "") ? l.launch_designator : null, // COSPAR, once LL2 has it
    net: new Date(l.net),
    netPrecision: l.net_precision,
    status: (l.status || {}).abbrev || "",
    padName: pad.name || "Starbase",
    site: ((pad.location || {}).name || "").replace(/,?\s*USA$/, ""),
    lat,
    lon,
    orbital,
    altKm: altM ? +altM[1] : null,
    orbits: orbM ? +orbM[1] : null,
    hours: hrsM ? +hrsM[1] : null,
    rtls: orbital && rtls,
    splash: splM ? splM[1].trim() : null
  };
}

/* ---------------- pad-aware nominal orbit ----------------
   Without CelesTrak data the plane comes from the pad (LL2 latitude/longitude),
   the LL2 orbit class and any inclination in the mission text.
   - Starbase TX: unchanged fit to the flown Starbase flights (30.5° orbital,
     26.5° suborbital), heading ESE over the Gulf (descending branch).
   - Florida (LC-39A, SLC-37 ...): default 43°, or 53° for Starlink-like
     missions; SSO 97.5°, polar 90°, GTO/GEO/lunar/beyond: a due-east parking
     orbit (pad latitude + 0.5°). Direction follows the Cape's corridors:
     below 50° south-east over the Atlantic toward the Bahamas (like Falcon 9
     43° Starlink), 50–80° north-east along the coast (53° Starlink, ISS),
     polar/SSO south past Miami.
   - Other Gulf coast pads (e.g. Louisiana): like Starbase, ESE over the Gulf,
     at least 1.5° above the pad latitude.
   - ISS missions (Dragon, Cygnus, Axiom ...): 51.6°.
   - Vandenberg SLC-4E (Falcon 9): south over the Pacific (descending branch);
     Starlink by group (11: 53°, 2/15: 70°, 9/13/17: 97.6°, else 53°), other
     LEO 70°, SSO 97.6°.
   - Florida Falcon 9 Starlink: groups 6/10/12 43°, others 53°.
   - GTO/GEO/beyond: a ~28.5° (pad latitude) due-east parking orbit and the
     transfer burn ~T+26 min (nominal only).
   - Anywhere else: same orbit-class defaults, descending below 50°.
   Launch azimuth from north: sin(az) = cos(i) / cos(lat); ascending = az,
   descending = 180° − az. */
function siteKind(lat, lon, label) {
  if (Math.abs(lat - 25.99) < 0.4 && Math.abs(lon + 97.16) < 0.5) return "starbase";
  if (/starbase/i.test(label) && /\bTX\b|texas/i.test(label)) return "starbase";
  if (lat > 27 && lat < 31 && lon > -82.2 && lon < -79.5) return "florida";
  if ((lat > 34 && lat < 35.2 && lon > -121.2 && lon < -120.2) || /vandenberg/i.test(label)) return "vandenberg";
  if (lat > 24 && lat < 31.5 && lon > -98 && lon < -84) return "gulf";
  return "other";
}
function nominalOrbit(m) {
  const kind = m.orbital ? "orbit" : "sub";
  const ab = String(m.orbitAbbrev || "").toUpperCase();
  const latA = Math.abs(m.lat);
  let incl, why;
  if (m.targetIncl) { incl = m.targetIncl; why = "mission text"; }
  else if (m.site_kind === "starbase") { incl = kind === "orbit" ? 30.5 : 26.5; why = "Starbase fit"; }
  else if (m.iss) { incl = 51.6; why = "ISS"; }
  else if (ab === "SSO") { incl = m.site_kind === "vandenberg" ? 97.6 : 97.5; why = "SSO"; }
  else if (ab === "PO") { incl = 90; why = "polar"; }
  else if (m.gto) { incl = Math.max(28.5, latA + 0.4); why = "due-east parking orbit"; }
  else if (m.site_kind === "vandenberg") {
    const g = m.starlinkGroup;
    if (m.starlinkLike) { incl = [9, 13, 17].includes(g) ? 97.6 : [2, 15].includes(g) ? 70 : 53; why = "Vandenberg Starlink"; }
    else { incl = 70; why = "Vandenberg LEO"; }
  }
  else if (m.site_kind === "florida" && m.vehicle !== "starship" && m.starlinkLike) { incl = [6, 10, 12].includes(m.starlinkGroup) ? 43 : 53; why = "Florida Starlink"; }
  else if (m.site_kind === "florida") { incl = m.starlinkLike ? 53 : 43; why = m.starlinkLike ? "Florida Starlink" : "Florida LEO"; }
  else if (m.site_kind === "gulf") { incl = Math.max(30.5, latA + 1.5); why = "Gulf coast"; }
  else { incl = kind === "orbit" ? (m.starlinkLike ? 53 : 43) : latA + 1; why = "default"; }
  incl = Math.max(incl, latA + 0.4);
  let dir = "desc";
  if (m.site_kind === "florida" || m.site_kind === "other") dir = incl >= 50 && incl < 80 ? "asc" : "desc";
  return { incl, dir, why };
}
function launchAzimuth(lat, incl, dir) {
  const az = Math.asin(clamp(Math.cos(incl * D2R) / Math.cos(lat * D2R), -1, 1)) / D2R;
  return dir === "asc" ? (az + 360) % 360 : 180 - az;
}

/*
  Trajectory: a great circle (the orbit plane) through the pad. Up to orbit insertion
  altitude and speed follow a template made from real flights' telemetry (ascent.js),
  retimed to this launch's own event times (LL2 timeline) and rescaled to its azimuth.
  Past the template a circular-orbit model takes over, blended in over BLEND seconds, and
  with an element set (pre-launch prediction or the tracked stage / payloads) SGP4 is
  blended in from SECO. Positions are integrated in the inertial frame and rotated into
  Earth-fixed coordinates; the speed shown is relative to the ground, like the webcasts.
*/
const BLEND = 600;   // s, template end -> orbit model
const SGP4_IN = 600; // s, nominal -> SGP4
const altOfMM = (mm) => { const n = mm * 2 * Math.PI / DAY; return Math.cbrt(MU / (n * n)) - R_E; };
const fmtEpoch = (ms) => { const d = new Date(ms); return fmtDateTime.format(d) + " " + zoneAbbr(d); };
function sourceOf(m, ct, tpl, incl) {
  const fx = ct && ct.fixture ? " · test fixture" : "";
  const tr = ct && ct.tracked;
  if (tr) {
    const what = tr.name + (tr.intdes ? ", " + tr.intdes : "") + (tr.role === "stage" ? ", upper stage" : tr.role === "payload" ? ", payload" + (tr.count > 1 ? " of " + tr.count : "") : "");
    return { source: "tracked", detail: (ct.planeOnly ? "Tracked orbit plane (TLE " : "Tracked (TLE ") + what + ", epoch " + fmtEpoch(tr.epochMs) + ")" + (ct.planeOnly ? " · nominal timeline" : "") + fx };
  }
  if (ct && ct.prelaunch) {
    return { source: "prelaunch", detail: "Pre-launch TLE (CelesTrak" + (ct.gp.proxy ? " · " + ct.gp.proxy : "") + ", epoch " + fmtEpoch(ct.gp.epochMs) + ")" + fx };
  }
  // away from Starbase the plane is a guess from the pad, so say which
  return { source: "nominal", detail: "Nominal profile · " + tpl.label + (m.site_kind !== "starbase" ? " · " + Math.round(incl) + "°" : "") + " · not live data" };
}

function buildTrajectory(m, ct, timeline) {
  const falcon = m.vehicle !== "starship";
  const kind = m.orbital ? "orbit" : "sub";
  const nom = nominalOrbit(m);
  const tpl = pickTemplate(m);
  const at = eventTimes(tpl.id, timeline);
  const gpRec = ct && ct.gp && window.satellite ? ct.gp : null;
  const flown = ct && ct.flown;

  // the orbit: the element set's plane and height; a weeks-old set only gives the plane
  let incl = flown ? flown.INCLINATION : gpRec ? gpRec.INCLINATION : nom.incl;
  incl = Math.max(incl, Math.abs(m.lat) + 0.4);
  // Falcon: nominal insertion altitudes (Starlink ~280 km, Dragon ~210 km, GTO parking ~200 km)
  const falconAlt = m.iss ? 210 : m.gto ? 200 : m.starlinkLike ? 280 : /^(SSO|PO)$/.test(m.orbitAbbrev) ? 500 : 400;
  // (a set in transfer orbit keeps the nominal parking orbit below it)
  const alt = gpRec && gpRec.MEAN_MOTION > 11 ? altOfMM(gpRec.MEAN_MOTION) : m.altKm || (falcon ? falconAlt : kind === "orbit" ? 275 : 190);
  const { source, detail: sourceDetail } = sourceOf(m, ct, tpl, incl);
  let dir = nom.dir;

  const asc = makeAscent(tpl.id, at, { lat: m.lat, incl });
  const tTpl = asc.end;                      // mission time where the real-flight data ends
  const tSeco = at.seco;
  const ENTRY_D = kind === "orbit" ? 1500 : 1110;
  const period = 2 * Math.PI * Math.sqrt(Math.pow(R_E + alt, 3) / MU);

  // Falcon second stage: payload deploy from the timeline (or the template's median), a
  // GTO transfer burn between SES-2 and SECO-2, then stay in orbit a bit past one revolution
  const tDeploy = falcon ? at.deploy || (m.iss ? 720 : m.gto ? 1980 : 3300) : null;
  const gtoBurn = falcon && m.gto && at.ses2 && at.seco2 > at.ses2 ? [at.ses2, at.seco2] : falcon && m.gto ? [1560, 1920] : null;
  let tEnd;
  if (falcon) tEnd = Math.round(Math.max(tDeploy + 1500, kind === "sub" ? 1800 : period * 1.15));
  else if (kind === "sub") tEnd = Math.round(at.land || tTpl);
  else {
    const hrs = m.hours || (m.orbits ? m.orbits * period / 3600 : 1.6);
    tEnd = Math.round(hrs * 3600);
    if (m.hours && m.orbits) tEnd = Math.round(Math.max(m.hours * 3600, m.orbits * period));
  }

  // orbit geometry
  const i = incl * D2R;
  const latP = m.lat * D2R;
  // argument of latitude at the pad: descending branch (heading ESE from Starbase) or
  // ascending branch (heading NE), see nominalOrbit()
  const uAsc = Math.asin(clamp(Math.sin(latP) / Math.sin(i), -1, 1));
  const uOf = (d) => (d === "asc" ? uAsc : Math.PI - uAsc);
  const omOf = (d) => { const u = uOf(d); return m.lon * D2R - Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u)); };
  let u0 = uOf(dir), Om = omOf(dir);
  function geo(u, t) {
    const lat = Math.asin(Math.sin(i) * Math.sin(u));
    const lonI = Om + Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u));
    return [lat / D2R, wrapLon((lonI - OMEGA_E * t) / D2R)];
  }
  const latAt = (u) => Math.asin(Math.sin(i) * Math.sin(u)) / D2R;

  /* altitude (km), horizontal and total ground speed (km/s), phase by mission time; lat is
     the vehicle's latitude, which sets how much of Earth's rotation the ground speed lacks */
  const deployLabel = m.iss ? (/cygnus/i.test(m.name) ? "CYGNUS SEPARATION" : "DRAGON SEPARATION") : m.starlinkLike ? "STARLINK DEPLOY" : "PAYLOAD DEPLOY";
  const gtoA = (R_E + alt + 42164) / 2, gtoE = (42164 - R_E - alt) / (42164 + R_E + alt), gtoN = Math.sqrt(MU / Math.pow(gtoA, 3));
  function gtoAt(t) { // transfer orbit from the parking perigee to geostationary height (Kepler)
    const M = gtoN * (t - gtoBurn[1]);
    let E = M;
    for (let k = 0; k < 8; k++) E = E - (E - gtoE * Math.sin(E) - M) / (1 - gtoE * Math.cos(E));
    const r = gtoA * (1 - gtoE * Math.cos(E));
    return [Math.sqrt(MU * (2 / r - 1 / gtoA)), r - R_E];
  }
  let tE = kind === "orbit" && !falcon ? tEnd - ENTRY_D : Infinity; // Starship orbital: deorbit + entry (moves with tEnd)
  // the orbit model: inertial speed and altitude after insertion
  function orbitModel(t) {
    if (gtoBurn && t >= gtoBurn[0]) {
      if (t < gtoBurn[1]) {
        const q = smooth(gtoBurn[0], gtoBurn[1], t), [vg, ag] = gtoAt(gtoBurn[1]);
        return [lerp(Math.sqrt(MU / (R_E + alt)), vg, q), lerp(alt, ag, q)];
      }
      return gtoAt(t);
    }
    if (t >= tE) {
      const q = (t - tE) / ENTRY_D;
      if (q > 1) return [0, 0];
      const v0 = Math.sqrt(MU / (R_E + 120));
      return [Math.max(0, v0 * (1 - smooth(0.12, 0.82, q)) * (1 - 0.15 * q) + 0.09 * (1 - smooth(0.9, 1, q))), 120 * Math.pow(1 - q, 1.55)];
    }
    const down = tE < Infinity ? smooth(tE - 1200, tE, t) : 0;
    const a = alt - (alt - 120) * down + 1.5 * Math.sin(t / period * 2 * Math.PI);
    return [Math.sqrt(MU / (R_E + a)), a];
  }
  // template end state, carried on with its vertical rate fading out over the blend
  const last = asc.sample(tTpl - 1e-6) || { alt, vh: 0, vz: 0 };
  function state(t, lat) {
    if (t <= 0) return { alt: 0, vh: 0, vi: 0, vg: 0 };
    const s = asc.sample(t);
    if (s) return { alt: s.alt, vh: s.vh, vi: inertialFromGround(s.vh, lat, incl, s.alt), vg: s.vg };
    if (kind === "sub" && !falcon) return { alt: 0, vh: 0, vi: 0, vg: 0 }; // landed: the template covers the whole flight
    const [vO, aO] = orbitModel(t);
    const w = smooth(tTpl, tTpl + BLEND, t);
    if (w >= 1) {
      const g = groundFromInertial(vO, lat, incl, aO);
      return { alt: aO, vh: g, vi: vO, vg: g };
    }
    const tau = Math.min(t - tTpl, BLEND);
    const aH = last.alt + last.vz * tau * (1 - tau / (2 * BLEND));
    const viH = inertialFromGround(last.vh, lat, incl, aH);
    const vi = lerp(viH, vO, w), a = lerp(aH, aO, w);
    const g = groundFromInertial(vi, lat, incl, a);
    return { alt: a, vh: g, vi, vg: Math.hypot(g, last.vz * (1 - w)) };
  }
  function phaseAt(t) {
    if (t <= 0) return "PRE-LAUNCH";
    if (!falcon) {
      if (t < at.meco) return "BOOSTER ASCENT";
      if (t < at.meco + 15) return "HOT STAGING";
      if (t < tSeco) return "SHIP ASCENT";
      if (at.oib && Math.abs(t - at.oib) < 45) return "ORBIT INSERTION BURN";
      const tEn = kind === "sub" ? at.entry || tEnd - ENTRY_D : tE;
      if (t < tEn) return kind === "sub" || (at.oib && t < at.oib) ? "COAST" : t > tE - 1200 ? "DEORBIT" : "ORBIT";
      if (t <= tEnd) {
        const q = (t - tEn) / (tEnd - tEn);
        return q < 0.15 ? "ENTRY INTERFACE" : q < 0.7 ? "PEAK HEATING" : q < 0.96 ? "BELLYFLOP" : (m.rtls ? "LANDING FLIP · CATCH" : "LANDING FLIP · SPLASHDOWN");
      }
      return m.rtls ? "CAUGHT" : "SPLASHDOWN";
    }
    if (t < at.meco) return m.vehicle === "falcon-heavy" && t > at.meco - 80 ? "CENTER CORE ASCENT" : "FIRST STAGE ASCENT";
    if (t < at.meco + 15) return "STAGE SEPARATION";
    if (t < tSeco) return "SECOND STAGE ASCENT";
    if (Math.abs(t - tDeploy) < 120) return deployLabel;
    if (gtoBurn && t >= gtoBurn[0]) return t < gtoBurn[1] ? "TRANSFER BURN" : t < tDeploy ? "TRANSFER ORBIT" : "GTO";
    if (at.ses2 && at.seco2 && t >= at.ses2 && t < at.seco2) return "SECOND BURN";
    return t < tDeploy ? (m.gto ? "PARKING ORBIT" : "COAST") : "ORBIT";
  }

  // downrange angle, integrated from the inertial horizontal speed
  function integrate(tEndL, dt) {
    const n = Math.ceil(tEndL / dt) + 1;
    const th = new Float64Array(n);
    let acc = 0, prev = 0;
    for (let k = 1; k < n; k++) {
      const t = Math.min(k * dt, tEndL);
      const s = state(t - dt / 2, latAt(u0 + acc));
      acc += (s.vi / (R_E + s.alt)) * (t - prev);
      prev = t;
      th[k] = acc;
    }
    return th;
  }

  let satrec = null;
  if (gpRec) { try { satrec = window.satellite.twoline2satrec(gpRec.tle1, gpRec.tle2); } catch (e) { satrec = null; } }
  const t0ms = m.net.getTime();
  // SGP4 joins after SECO-1 (a set in transfer orbit: after the transfer burn)
  const tSgp = satrec ? (gpRec.MEAN_MOTION < 11 ? (gtoBurn ? gtoBurn[1] : null) : tSeco) : null;
  // With a real element set (outside Starbase) take the branch whose insertion point lies
  // closer to where SGP4 puts the object then
  if (satrec && tSgp && m.site_kind !== "starbase") {
    const s = sgp4At(satrec, new Date(t0ms + tSgp * 1000));
    if (s) {
      const score = (d) => {
        dir = d; u0 = uOf(d); Om = omOf(d);
        const th = integrate(tSgp, 5);
        const [la, lo] = geo(u0 + th[th.length - 1], tSgp);
        return Math.hypot(la - s.lat, wrapLon(lo - s.lon) * Math.cos(s.lat * D2R));
      };
      const sa = score("asc"), sd = score("desc");
      dir = sa < sd ? "asc" : "desc";
    }
  }
  // tracked orbit plane only: the branch whose node (regressed to T-0) matches
  if (flown && isFinite(flown.nodeLonT0)) {
    const off = (d) => Math.abs(wrapLon((omOf(d) - flown.nodeLonT0) / D2R));
    dir = off("asc") < off("desc") ? "asc" : "desc";
  }
  u0 = uOf(dir); Om = omOf(dir);
  const azimuth = launchAzimuth(m.lat, incl, dir);

  // For return-to-launch-site missions pick the end time whose ground track comes back over
  // the pad, near the advertised mission length.
  let blend = null;
  if (kind === "orbit" && !falcon && m.rtls) {
    let best = null;
    const base = tEnd;
    for (let cand = Math.max(base - 3600, tTpl + BLEND + ENTRY_D + 600); cand <= base + 3 * 3600; cand += 20) {
      tE = cand - ENTRY_D;
      const th = integrate(cand, 20);
      const [la, lo] = geo(u0 + th[th.length - 1], cand);
      const d = Math.hypot(la - m.lat, wrapLon(lo - m.lon) * Math.cos(latP));
      const score = d + Math.abs(cand - base) / 3600 * 1.5;
      if (!best || score < best.score) best = { cand, score, la, lo };
    }
    tEnd = best.cand;
    blend = { dLat: m.lat - best.la, dLon: wrapLon(m.lon - best.lo) };
  }
  if (tE < Infinity) tE = tEnd - ENTRY_D;
  const tEntry = falcon ? Infinity : kind === "sub" ? at.entry || tEnd - ENTRY_D : tE;
  const tSgpEnd = falcon ? Infinity : tEntry; // Falcon: follow the element set to the end

  const DT = tEnd > 20000 ? 10 : 2;
  const th = integrate(tEnd, DT);
  const N = th.length;
  const lat = new Float32Array(N), lon = new Float32Array(N), altA = new Float32Array(N), spd = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const t = Math.min(k * DT, tEnd);
    let [la, lo] = geo(u0 + th[k], t);
    const s = state(t, la);
    let a = s.alt, v = s.vg;
    if (blend) {
      const w = smooth(tEntry - 2400, tEnd, t);
      la += blend.dLat * w; lo = wrapLon(lo + blend.dLon * w);
    }
    if (satrec && tSgp && t >= tSgp && t <= tSgpEnd) {
      const g = sgp4At(satrec, new Date(t0ms + t * 1000));
      if (g) {
        const w = smooth(tSgp, tSgp + SGP4_IN, t) * (1 - smooth(tSgpEnd - 600, tSgpEnd, t));
        la = lerp(la, g.lat, w); lo = wrapLon(lo + wrapLon(g.lon - lo) * w); a = lerp(a, g.alt, w); v = lerp(v, g.vg, w);
      }
    }
    lat[k] = la; lon[k] = lo; altA[k] = a; spd[k] = v * 3600;
  }
  // nose-up attitude: the flight path angle up to SECO-1 (pitching over from the vertical),
  // level in orbit, belly-first entry and a flip before landing
  function noseUpAt(t) {
    if (t <= 0) return 90;
    if (t < tSeco) {
      const s = asc.sample(t);
      return s ? clamp(Math.atan2(s.vz, s.vh) / D2R, 0, 90) : 0;
    }
    if (t < tEntry) return 0;
    if (t < tEnd - 25) return 40 * smooth(tEntry, tEntry + 240, t) - 40 * smooth(tEnd - 420, tEnd - 120, t);
    return 90 * smooth(tEnd - 25, tEnd - 10, t);
  }

  const events = falcon ? [
    { t: 0, label: "LIFTOFF" },
    { t: at.meco, label: "MECO" },
    { t: tSeco, label: "SECO" },
    ...(gtoBurn ? [{ t: gtoBurn[0], label: "GTO BURN" }] : []),
    { t: tDeploy, label: m.iss ? "SEP" : "DEPLOY" }
  ] : [
    { t: 0, label: "LIFTOFF" },
    { t: at.meco, label: "MECO" },
    { t: at.oib || tSeco, label: kind === "sub" ? "SECO" : "ORBIT" },
    { t: tEntry, label: "ENTRY" },
    { t: tEnd, label: m.rtls ? "CATCH" : "SPLASH" }
  ];

  const landed = !falcon;
  return {
    kind, falcon, template: tpl.id, templateLabel: tpl.label, templateFrom: tpl.from, at,
    source, sourceDetail, tracked: (ct && ct.tracked) || null, incl, dir, azimuth, nominalWhy: nom.why, period, altCoast: alt,
    tEnd, tEntry, tSeco, DT, N, lat, lon, alt: altA, spd, events,
    maxAlt: Math.max(...altA), phaseAt: (t) => phaseAt(clamp(t, -1, tEnd + 1)), noseUpAt,
    sample(t) {
      if (t <= 0) return { lat: m.lat, lon: m.lon, alt: 0, spd: 0, k: 0 };
      if (t >= tEnd) return { lat: lat[N - 1], lon: lon[N - 1], alt: landed ? 0 : altA[N - 1], spd: landed ? 0 : spd[N - 1], k: N - 1 };
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

// New data for the launch on screen (an element set arrived, a newer epoch): glide from the
// old path to the new one over a few seconds instead of jumping
const HANDOVER_MS = 2500;
function handover(prev, next) {
  const base = next.sample, t0 = performance.now();
  next.sample = (t) => {
    const b = base(t), w = smooth(0, HANDOVER_MS, performance.now() - t0);
    if (w >= 1) { next.sample = base; return b; }
    const a = prev.sample(t);
    return { lat: lerp(a.lat, b.lat, w), lon: wrapLon(a.lon + wrapLon(b.lon - a.lon) * w), alt: lerp(a.alt, b.alt, w), spd: lerp(a.spd, b.spd, w), k: b.k };
  };
  return next;
}

// SGP4 position and speed over the ground (km/s; the webcasts' speed, like the templates)
function sgp4At(satrec, date) {
  try {
    const sat = window.satellite;
    const pv = sat.propagate(satrec, date);
    if (!pv || !pv.position || !pv.velocity) return null;
    const g = sat.eciToGeodetic(pv.position, sat.gstime(date));
    const r = pv.position, v = pv.velocity;
    return { lat: g.latitude / D2R, lon: wrapLon(g.longitude / D2R), alt: g.height, vg: Math.hypot(v.x + OMEGA_E * r.y, v.y - OMEGA_E * r.x, v.z) };
  } catch (e) { return null; }
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

const { uSun } = addEarth(renderer, scene);

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
  lat: 10, lon: 10, dist: 3.6, followT: 0, tLat: 10, tLon: 10, tDist: 3.6,
  vLat: 0, vLon: 0, follow: true, dragging: false, minD: 1.45, maxD: 9, fitD: 3.6
};
const pointers = new Map();
let pinch0 = null, last = null, lastMoveT = 0, tapStart = null;
// set once a second finger lands; the leftover finger of a pinch must not pan (or drop follow mode)
let multiGesture = false;
const markerScreen = { x: -1e4, y: -1e4, on: false };
const FOLLOW_EASE_MS = 2200; // glide time onto the ship when follow turns on
const MARKER_HIT = 38; // px, generous for fingers

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) tapStart = { x: e.clientX, y: e.clientY, t: performance.now(), multi: false };
  else if (tapStart) tapStart.multi = true;
  ctl.dragging = true; ctl.vLat = ctl.vLon = 0;
  canvas.classList.add("is-drag");
  if (pointers.size >= 2) multiGesture = true;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: ctl.tDist };
    ctl.zoomAuto = false; // a pinch takes over the zoom (the view mode and lock-on stay)
  }
  last = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) {
    canvas.classList.toggle("is-hot", markerScreen.on && Math.hypot(e.clientX - markerScreen.x, e.clientY - markerScreen.y) < MARKER_HIT);
    return;
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size >= 2 && pinch0) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    ctl.tDist = clamp(pinch0.dist * pinch0.d / Math.max(d, 1), ctl.minD, ctl.maxD);
    return;
  }
  if (!last) return;
  if (multiGesture) { last = { x: e.clientX, y: e.clientY, t: performance.now() }; return; }
  const dx = e.clientX - last.x, dy = e.clientY - last.y;
  const now = performance.now(), dt = Math.max(now - last.t, 1);
  const k = degPerPx();
  if (ctl.follow && (!tapStart || Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 8)) setFollow(false);
  ctl.tLon -= dx * k; ctl.tLat = clamp(ctl.tLat + dy * k, -85, 85);
  ctl.lon = ctl.tLon; ctl.lat = ctl.tLat;
  ctl.vLon = -dx * k / dt * 16; ctl.vLat = dy * k / dt * 16;
  last = { x: e.clientX, y: e.clientY, t: now };
  lastMoveT = now;
});
function endPointer(e) {
  // a short, still tap near the rocket marker turns follow mode on
  if (e.type === "pointerup" && tapStart && !tapStart.multi && pointers.size === 1 &&
      Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) < 12 && performance.now() - tapStart.t < 600 &&
      markerScreen.on && Math.hypot(e.clientX - markerScreen.x, e.clientY - markerScreen.y) < MARKER_HIT) {
    setFollow(true);
    ctl.vLat = ctl.vLon = 0;
    lastMoveT = 0;
  }
  if (pointers.size <= 1) tapStart = null;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch0 = null;
  if (pointers.size === 0) {
    ctl.dragging = false; canvas.classList.remove("is-drag"); multiGesture = false;
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
  ctl.zoomAuto = false;
  ctl.tDist = clamp(ctl.tDist * Math.exp(e.deltaY * 0.0012), ctl.minD, ctl.maxD);
}, { passive: false });
// never let the browser zoom the page (iOS Safari pinch / double-tap); globe zoom is handled above
["gesturestart", "gesturechange", "gestureend"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTouchEnd < 320 && !(e.target.closest && e.target.closest("button, a, input"))) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

function degPerPx() {
  const h = canvas.clientHeight || 800;
  // visible arc per pixel shrinks as we zoom in
  return (ctl.dist - 1) / ctl.fitD * 120 / h * 1.15 + 0.01;
}

const followBtn = $("[data-follow]");
function setFollow(on) {
  if (on && !ctl.follow) { ctl.followT = performance.now(); ctl.followOff = null; if (ctl.view === "sky") ctl.view = "earth"; }
  ctl.follow = on;
  followBtn.hidden = false;
  followBtn.classList.toggle("is-on", on);
  followBtn.setAttribute("aria-pressed", on ? "true" : "false");
  const v = on ? ctl.view : "earth";
  followBtn.dataset.view = v;
  const name = on ? VIEW_NAMES[v] : "Follow off";
  followBtn.title = name + " · tap: " + (on ? "next view" : "follow") + " · long-press: stop following";
  followBtn.setAttribute("aria-label", "Camera view: " + name + ". Tap for the " + (on ? "next view" : "Earth view") + ", long-press to stop following");
}

/* Camera views (one button): Earth view (whole globe, locked on the ship) -> Close follow (locked
   on the ship, zoomed so a full 0° visibility circle fits) -> Your sky (centred on your location,
   same circle zoom; only with a saved location) -> Earth view. A drag still turns following off,
   a long-press on the button too; pinch/wheel keep the view and take over the zoom. Rotation and
   zoom glide with the same ease-in-out as the follow glide. */
const VIEW_NAMES = { earth: "Earth view", close: "Close follow", sky: "Your sky" };
ctl.view = "earth"; ctl.zoomAuto = false; ctl.zoomT = 0; ctl.zoomFrom = ctl.dist; ctl.hNow = 0;
const pillEl = $("[data-view-pill]");
let pillTimer = 0;
function pill(txt) {
  pillEl.textContent = txt;
  pillEl.classList.add("is-show");
  clearTimeout(pillTimer); pillTimer = setTimeout(() => pillEl.classList.remove("is-show"), 1700);
}
// camera distance at which a circle of angular radius lam (rad) around the view centre fits the globe area
function fitCircleD(lam) {
  const amax = Math.atan(globeArea.rPx / globeArea.f);
  return clamp(Math.cos(lam) + Math.sin(lam) / Math.tan(amax), ctl.minD, ctl.fitD);
}
function viewDist(v) {
  if (v !== "close" && v !== "sky") return ctl.fitD;
  const h = Math.max(ctl.hNow || 0, (S.traj && S.traj.altCoast) || 300);
  return fitCircleD(visLam(h, 0) * (v === "close" ? 1.2 : 1.12));
}
function setView(v) {
  if (!ctl.follow) setFollow(true);
  else { ctl.followT = performance.now(); ctl.followOff = null; }
  ctl.view = v;
  setFollow(true); // labels + icon for the new view
  ctl.vLat = ctl.vLon = 0;
  ctl.zoomAuto = true; ctl.zoomFrom = ctl.dist; ctl.zoomT = performance.now();
  if (v === "sky" && !vis.on) setVis(true);
  pill(VIEW_NAMES[v]);
}
const followLong = longPress(followBtn, () => { if (ctl.follow) { setFollow(false); pill("Follow off"); } });
followBtn.addEventListener("click", () => {
  if (!ctl.follow) return setView("earth");
  if (ctl.view === "earth") return setView("close");
  if (ctl.view === "close") return setView(vis.obs ? "sky" : "earth"); // no location yet: the rings button is the way in
  setView("earth");
});

// long-press (~600 ms) for touch and mouse, right-click as a desktop fallback; the click that
// ends a long press is swallowed so it never also toggles
function longPress(btn, onLong, ms = 600) {
  let t = 0, x0 = 0, y0 = 0, fired = -1e9;
  const clear = () => { clearTimeout(t); t = 0; };
  const fire = () => { clear(); fired = performance.now(); try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} onLong(); };
  btn.addEventListener("pointerdown", (e) => { if (e.button > 0) return; x0 = e.clientX; y0 = e.clientY; clear(); t = setTimeout(fire, ms); });
  btn.addEventListener("pointermove", (e) => { if (t && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) clear(); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(ev, clear);
  btn.addEventListener("contextmenu", (e) => { e.preventDefault(); if (performance.now() - fired < 1500) return; fire(); });
  btn.addEventListener("click", (e) => {
    if (performance.now() - fired < 1500) { e.stopImmediatePropagation(); e.preventDefault(); fired = -1e9; }
  }, true);
  return () => performance.now() - fired < 1500;
}

/* ---------------- visibility circle ----------------
   Rings on the ground around the viewer: the ship (at its current altitude h)
   stands e degrees above the viewer's horizon anywhere within the central
   angle  lambda = acos(R / (R + h) * cos e) - e.  0° always; the higher rings
   and N/E/S/W fade in as the camera zooms in. The location is asked once
   (navigator.geolocation) and kept in localStorage, so toggles never ask again. */
const VIS_KEY = "spacex.observer.v1", VIS_ON = "spacex.vis.v1";
const VIS_RINGS = [ // elevation, zoom level where it fades in (0 = whole globe, 1 = closest)
  { e: 0, z: -1 }, { e: 10, z: 0.12 }, { e: 20, z: 0.26 }, { e: 30, z: 0.38 }, { e: 45, z: 0.5 }, { e: 60, z: 0.62 }, { e: 75, z: 0.74 }
];
const VIS_SEG = 160, VIS_LIFT = 1.0018;
const visBtn = $("[data-vis]"), visLayer = $("[data-vis-layer]"), visMe = $("[data-vis-me]"), visInfo = $("[data-vis-info]");
const vis = { on: false, obs: null, asking: false, h: -1, rings: [], labels: [] };
try { const o = JSON.parse(localStorage.getItem(VIS_KEY) || "null"); if (o && isFinite(o.lat) && isFinite(o.lon)) vis.obs = { lat: +o.lat, lon: +o.lon }; } catch (e) {}
for (const r of VIS_RINGS) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(VIS_SEG * 3), 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const line = new THREE.LineLoop(g, mat);
  line.renderOrder = 3; line.frustumCulled = false; line.visible = false;
  line.layers.set(1); // main view only, not the mini globe
  scene.add(line);
  const lab = document.createElement("span"); lab.textContent = r.e + "°";
  visLayer.appendChild(lab);
  vis.rings.push({ ...r, line, lab, lam: 0, a: 0 });
}
for (const [txt, brg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
  const lab = document.createElement("span"); lab.textContent = txt; lab.className = "is-dir";
  visLayer.appendChild(lab);
  vis.labels.push({ lab, brg, a: 0 });
}
// point at angular distance d (rad) and bearing b (rad) from (lat, lon) in degrees
function destPoint(lat, lon, d, b) {
  const p1 = lat * D2R, l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / D2R, wrapLon(l2 / D2R)];
}
const visLam = (h, e) => Math.max(0, Math.acos(clamp(R_E / (R_E + h) * Math.cos(e * D2R), -1, 1)) - e * D2R);
function visRebuild(h) {
  vis.h = h;
  const v = new THREE.Vector3();
  for (const r of vis.rings) {
    r.lam = visLam(h, r.e);
    const pos = r.line.geometry.attributes.position;
    for (let k = 0; k < VIS_SEG; k++) {
      const [la, lo] = destPoint(vis.obs.lat, vis.obs.lon, r.lam, k / VIS_SEG * 2 * Math.PI);
      ll2v(la, lo, VIS_LIFT, v); pos.setXYZ(k, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
  }
}
// elevation / azimuth of the ship seen from the viewer (spherical Earth)
function visLook(s) {
  const o = ll2v(vis.obs.lat, vis.obs.lon, R_E, new THREE.Vector3());
  const p = ll2v(s.lat, s.lon, R_E + Math.max(s.alt, 0), new THREE.Vector3());
  const up = o.clone().normalize(), d = p.sub(o);
  const el = Math.asin(clamp(d.dot(up) / Math.max(d.length(), 1e-6), -1, 1)) / D2R;
  const p1 = vis.obs.lat * D2R, p2 = s.lat * D2R, dl = (s.lon - vis.obs.lon) * D2R;
  const az = (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / D2R + 360) % 360;
  return { el, az };
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function setVis(on) {
  vis.on = on && !!vis.obs;
  visBtn.classList.toggle("is-on", vis.on);
  visBtn.setAttribute("aria-pressed", vis.on ? "true" : "false");
  visLayer.hidden = !vis.on;
  visInfo.hidden = !vis.on;
  if (!vis.on) for (const r of vis.rings) { r.line.visible = false; r.a = 0; }
  vis.h = -1;
  try { localStorage.setItem(VIS_ON, vis.on ? "1" : "0"); } catch (e) {}
}
// ask the browser for the location (only from the sheet, or a long-press once one is saved)
function askLocation(update) {
  if (vis.asking) return;
  if (!navigator.geolocation) { toast("Location not available"); return; }
  vis.asking = true; visBtn.classList.add("is-busy");
  navigator.geolocation.getCurrentPosition((p) => {
    vis.asking = false; visBtn.classList.remove("is-busy");
    vis.obs = { lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3) }; // ~100 m is plenty
    try { localStorage.setItem(VIS_KEY, JSON.stringify(vis.obs)); } catch (e) {}
    vis.h = -1; // rebuild the rings around the new spot
    if (ctl.follow && ctl.view === "sky") { ctl.followT = performance.now(); ctl.followOff = null; }
    if (update) toast("Location updated");
    else {
      setVis(true);
      let seen = false;
      try { seen = localStorage.getItem("spacex.vis.hint") === "1"; localStorage.setItem("spacex.vis.hint", "1"); } catch (e) {}
      if (!seen) toast("Long-press the button to update your location");
    }
  }, (err) => {
    vis.asking = false; visBtn.classList.remove("is-busy");
    toast(err && err.code === 1 ? "Location permission denied" : "Could not get your location");
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: update ? 0 : 10 * 60 * 1000 });
}
const sheet = $("[data-vis-sheet]");
function openSheet(open) {
  sheet.hidden = !open;
  if (open) { try { sheet.querySelector("[data-sheet-yes]").focus({ preventScroll: true }); } catch (e) {} }
}
sheet.querySelector("[data-sheet-yes]").addEventListener("click", () => { openSheet(false); askLocation(false); });
sheet.querySelector("[data-sheet-no]").addEventListener("click", () => openSheet(false));
sheet.addEventListener("click", (e) => { if (e.target === sheet) openSheet(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) openSheet(false); });
longPress(visBtn, () => { if (vis.obs) askLocation(true); else openSheet(true); });
visBtn.addEventListener("click", () => {
  if (vis.obs) { setVis(!vis.on); return; }
  openSheet(true); // first time: say what it does and why it needs the location, before the browser asks
});
try { if (vis.obs && localStorage.getItem(VIS_ON) === "1") setVis(true); } catch (e) {}

// per frame, after the camera is set
const visV = new THREE.Vector3(), visW = new THREE.Vector3();
function visFrame(s, tr, camDirN, dt) {
  if (!vis.on || !vis.obs) return;
  // before liftoff / after landing the ship sits at ~0 km: use the orbit altitude instead
  const h = s.alt > 40 ? s.alt : (tr.altCoast || 300);
  if (Math.abs(h - vis.h) > 2) visRebuild(h);
  const z = clamp((ctl.fitD - ctl.dist) / Math.max(ctl.fitD - ctl.minD, 1e-3), 0, 1);
  const look = visLook({ lat: s.lat, lon: s.lon, alt: h });
  const up = look.el >= 0;
  // sunlit? outside Earth's cylindrical shadow (sun direction is in the same Earth-fixed frame)
  const sp = ll2v(s.lat, s.lon, R_E + h, visW), sd = sp.dot(uSun.value);
  const lit = sd > 0 || Math.sqrt(Math.max(sp.lengthSq() - sd * sd, 0)) > R_E;
  // your sky dark enough? sun at least 6° below your horizon (end of civil twilight, the usual ISS rule)
  const sunEl = Math.asin(clamp(ll2v(vis.obs.lat, vis.obs.lon, 1, visW).dot(uSun.value), -1, 1)) / D2R;
  const dark = sunEl <= -6;
  const shine = up && lit && dark;
  const k = 1 - Math.pow(0.002, dt); // smooth fades, no popping
  const lim = 1 / ctl.dist;
  const toScreen = (la, lo, el2) => {
    ll2v(la, lo, VIS_LIFT, visV);
    const facing = visW.copy(visV).normalize().dot(camDirN);
    visV.project(camera);
    const x = (visV.x * 0.5 + 0.5) * W, y = (-visV.y * 0.5 + 0.5) * H;
    const f = smooth(lim - 0.01, lim + 0.06, facing);
    el2.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    return f;
  };
  for (const r of vis.rings) {
    const want = r.e === 0 ? (shine ? 0.85 : 0.42) : 0.26 * smooth(r.z, r.z + 0.1, z);
    r.a += (want - r.a) * k;
    r.line.visible = r.a > 0.004 && r.lam > 0.0005;
    r.line.material.opacity = r.a;
    // degree label on the south-east side of its ring
    const la = r.e === 0 ? 0.9 * smooth(0.05, 0.15, z) : r.a / 0.26;
    if (la > 0.01 && r.lam > 0.0005) {
      const [pla, plo] = destPoint(vis.obs.lat, vis.obs.lon, r.lam, 135 * D2R);
      const f = toScreen(pla, plo, r.lab);
      r.lab.style.opacity = (la * f).toFixed(3);
    } else r.lab.style.opacity = "0";
  }
  const r0 = vis.rings[0], dA = 0.9 * smooth(0.04, 0.14, z);
  for (const l of vis.labels) {
    l.a += (dA - l.a) * k;
    if (l.a > 0.01) {
      const [pla, plo] = destPoint(vis.obs.lat, vis.obs.lon, r0.lam + 0.9 * D2R / Math.max(0.35, 1 - z * 0.6), l.brg * D2R);
      l.lab.style.opacity = (l.a * toScreen(pla, plo, l.lab)).toFixed(3);
    } else l.lab.style.opacity = "0";
  }
  visMe.style.opacity = toScreen(vis.obs.lat, vis.obs.lon, visMe).toFixed(3);
  const where = Math.round(look.el) + "° high, " + COMPASS[Math.round(look.az / 45) % 8];
  const txt = s.alt <= 40 ? "Your visibility circle · at " + Math.round(h) + " km"
    : shine ? "Visible from you · " + where
    : up && !lit ? "In Earth's shadow · " + where
    : up ? "Sky too bright · " + where
    : "Below your horizon";
  if (visInfo.textContent !== txt) visInfo.textContent = txt;
  visInfo.classList.toggle("is-up", shine && s.alt > 40);
  window.__spacexVis = () => ({ on: vis.on, obs: vis.obs, h, z, el: look.el, az: look.az, up, lit, dark, sunEl, shine,
    rings: vis.rings.map((r) => ({ e: r.e, lamDeg: r.lam / D2R, a: +r.a.toFixed(3), label: +r.lab.style.opacity })),
    dirs: vis.labels.map((l) => [l.lab.textContent, +l.lab.style.opacity]) });
}

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
  globeArea.rPx = rPx; globeArea.f = f;
  ctl.fitD = 1 / Math.sin(ang);
  if (!layout.done) { ctl.dist = ctl.tDist = ctl.fitD; layout.done = true; }
  ctl.maxD = ctl.fitD * 2.4;
  camera.updateProjectionMatrix();
  globeArea = { cx: W / 2, cy, top, areaH, rPx, f };
  followBtn.style.top = (top + 8) + "px";
  followBtn.style.top = "auto";
  followBtn.style.bottom = (H - hudTop + 12) + "px";
  visBtn.style.top = "auto";
  visBtn.style.bottom = (H - hudTop + 12 + (followBtn.offsetHeight || 37) + 10) + "px";
  pillEl.style.bottom = (H - hudTop + 12 + ((followBtn.offsetHeight || 37) - (pillEl.offsetHeight || 26)) / 2) + "px";
}
window.addEventListener("resize", layout);
window.addEventListener("orientationchange", () => setTimeout(layout, 250));

/* ---------------- HUD ---------------- */
const el = {
  speed: $("[data-speed]"), alt: $("[data-alt]"),
  sign: $("[data-sign]"), clock: $("[data-clock]"), zone: $("[data-zone]"),
  mission: $("[data-mission]"), phase: $("[data-phase]"),
  kind: $("[data-kind]"), net: $("[data-net]"), pad: $("[data-pad]"), src: $("[data-src]"), other: $("[data-other]"), flying: $("[data-flying]"),
  range: $("[data-range]"), ticks: $("[data-ticks]"), play: $("[data-play]"), playIcon: $("[data-play-icon]"), rate: $("[data-rate]"),
  now: $("[data-now]"), mode: $("[data-mode]"), marker: $("[data-marker]"), ring: $("[data-ring]"), ship: $("[data-ship]"), vehicle: $("[data-vehicle]"), toast: $("[data-toast]")
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

/* Fine scrubbing (Starlink-style, smoother): on the track it is 1:1; moving
   the finger/pointer vertically away (above or below) slows time per pixel
   along a log-scale curve, so every extra pixel slows it by the same small
   factor, from full speed at the track down to SCRUB_FINE_S_PER_PX at
   scrubFineRange() px. No steps, no plateau until the far end. */
const SCRUB_FINE_S_PER_PX = 1;
const SCRUB_DEAD_PX = 6; // finger jitter right on the track stays 1:1
function scrubFineRange() {
  const r = el.range.getBoundingClientRect();
  const room = Math.max(r.top + r.height / 2, window.innerHeight - r.top - r.height / 2);
  return clamp(room * 0.55, 180, 300);
}
function scrubSecPerPx(absDy, trackWidth, span, range) {
  if (!(trackWidth > 0) || !(span > 0)) return 0;
  const R = range || 280;
  const coarse = span / trackWidth;
  const fine = Math.min(SCRUB_FINE_S_PER_PX, coarse);
  const d = Math.max(0, Math.abs(absDy) - SCRUB_DEAD_PX);
  const t = clamp(d / (R - SCRUB_DEAD_PX), 0, 1);
  return coarse * Math.pow(fine / coarse, t);
}
const sliderEl = $("[data-slider]"), scrubHint = $("[data-scrub-hint]");
let scrubDrag = null;
function trackBox() {
  const r = el.range.getBoundingClientRect();
  return { left: r.left + 9, width: Math.max(r.width - 18, 1), top: r.top, height: r.height };
}
function valueAtClientX(x) {
  const r = trackBox();
  return rangeMin() + clamp((x - r.left) / r.width, 0, 1) * (rangeMax() - rangeMin());
}
function fmtRate(spp) {
  if (spp >= 120) return (spp / 60).toFixed(spp >= 600 ? 0 : 1) + " MIN/PX";
  if (spp >= 10) return Math.round(spp) + " S/PX";
  return spp.toFixed(1) + " S/PX";
}
function scrubTo(v) { S.live = false; el.now.classList.remove("is-on"); setT(v); }
function onScrubMove(e) {
  if (!scrubDrag || e.pointerId !== scrubDrag.id) return;
  e.preventDefault();
  const r = trackBox();
  const dy = e.clientY - (r.top + r.height / 2);
  const spp = scrubSecPerPx(dy, r.width, rangeMax() - rangeMin(), scrubFineRange());
  scrubDrag.value = clamp(scrubDrag.value + (e.clientX - scrubDrag.lastX) * spp, rangeMin(), rangeMax());
  scrubDrag.lastX = e.clientX;
  scrubTo(scrubDrag.value);
  const fine = Math.abs(dy) > SCRUB_DEAD_PX + 8;
  scrubHint.hidden = !fine;
  if (fine) scrubHint.textContent = "FINE SCRUB · " + fmtRate(spp);
  sliderEl.dataset.spp = spp.toFixed(3);
}
function onScrubUp(e) {
  if (!scrubDrag || e.pointerId !== scrubDrag.id) return;
  scrubDrag = null;
  sliderEl.classList.remove("is-scrubbing");
  scrubHint.hidden = true;
  window.removeEventListener("pointermove", onScrubMove);
  window.removeEventListener("pointerup", onScrubUp);
  window.removeEventListener("pointercancel", onScrubUp);
  window.removeEventListener("touchmove", onScrubTouchMove);
}
function onScrubTouchMove(e) { if (scrubDrag) e.preventDefault(); }
sliderEl.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  try { el.range.focus({ preventScroll: true }); } catch (err) {}
  try { sliderEl.setPointerCapture(e.pointerId); } catch (err) {}
  sliderEl.classList.add("is-scrubbing");
  scrubDrag = { id: e.pointerId, lastX: e.clientX, value: valueAtClientX(e.clientX) };
  window.addEventListener("pointermove", onScrubMove);
  window.addEventListener("pointerup", onScrubUp);
  window.addEventListener("pointercancel", onScrubUp);
  window.addEventListener("touchmove", onScrubTouchMove, { passive: false });
  scrubTo(scrubDrag.value);
});
sliderEl.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
window.__spacexScrub = window.__starshipScrub = { scrubSecPerPx, scrubFineRange };
window.__spacexDebug = window.__starshipDebug = { traj: () => S.traj, normalizeTLE, pick: () => S.pick, tracked: (l) => loadTracked(parseMission(l)) };

el.range.addEventListener("input", () => {
  S.live = false; el.now.classList.remove("is-on");
  setT(rangeMin() + +el.range.value, true);
});
el.play.addEventListener("click", () => {
  S.playing = !S.playing;
  if (S.playing && S.t >= rangeMax() - 1) setT(rangeMin());
  syncButtons();
});
const rateWrap = $("[data-rate-wrap]"), rateMenu = $("[data-rate-menu]");
function setRateMenu(open) {
  rateMenu.hidden = !open;
  el.rate.setAttribute("aria-expanded", open ? "true" : "false");
  el.rate.classList.toggle("is-open", open);
}
el.rate.addEventListener("click", (e) => { e.stopPropagation(); setRateMenu(rateMenu.hidden); });
rateMenu.addEventListener("click", (e) => {
  const b = e.target.closest("[data-speed]");
  if (!b) return;
  e.stopPropagation();
  S.rate = +b.dataset.speed;
  if (S.live && S.rate !== 1) S.live = false;
  if (!S.playing) { S.playing = true; if (S.t >= rangeMax() - 1) setT(rangeMin()); }
  setRateMenu(false);
  syncButtons();
});
document.addEventListener("pointerdown", (e) => { if (!rateMenu.hidden && !rateWrap.contains(e.target)) setRateMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !rateMenu.hidden) { setRateMenu(false); el.rate.focus(); } });
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
  try { localStorage.setItem("spacex.mode", S.mode); } catch (e) {}
  syncButtons();
});
el.other.addEventListener("click", () => {
  S.which = S.which === "next" || (S.which === "auto" && S.autoPick === "next") ? "latest" : "next";
  applyMission(null, Infinity);
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
  rateMenu.querySelectorAll("[data-speed]").forEach((b) => {
    const on = +b.dataset.speed === S.rate;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
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

/* ---------------- mission selection ----------------
   Auto (every open/refresh): the next SpaceX launch (any vehicle), or the one
   flying right now; nominal orbit until CelesTrak has a pre-launch set. The
   most recent flown launch ("Last flight") only when there is no next launch
   or when tapped — including classified missions with no catalogue data.
   Re-checked every 10 minutes for new data. ?mission=next|latest forces one side. */
const RECHECK_MS = 10 * 60 * 1000;
const dataCache = new Map();     // launch -> Promise<ct | null>
const timelineCache = new Map(); // launch -> Promise<{ meco, seco, ... }>
const within = (p, ms) => ms === Infinity ? p : Promise.race([p, new Promise((r) => setTimeout(() => r(undefined), ms))]);

async function boot() {
  layout();
  try { const m = localStorage.getItem("spacex.mode") || localStorage.getItem("starship.mode"); if (m === "local" || m === "mission") S.mode = m; } catch (e) {}
  const q = new URLSearchParams(location.search);
  if (q.get("mission") === "next" || q.get("mission") === "latest") S.which = q.get("mission");
  syncButtons();
  const fx = activeFixture();
  S.data = fx ? { upcoming: fx.upcoming, previous: fx.previous } : await loadLaunches();
  // first paint without waiting long on CelesTrak; upgrade once its answers are in
  await applyMission(q.has("t") ? +q.get("t") : null, 4000);
  requestAnimationFrame(frame);
  recheck(false);
  setInterval(() => recheck(true), RECHECK_MS);
}

/* Orbit data for a launch, best first:
   1. the tracked objects of the launch (upper stage, else payloads) once CelesTrak lists them;
   2. a pre-launch prediction (CelesTrak SupGP) close to liftoff;
   3. nothing: the nominal profile.
   Memoised per launch for one pick; recheck() clears the memo and the loaders' own caches
   decide what goes to the network. */
function dataFor(l) {
  const k = lkey(l);
  if (!dataCache.has(k)) {
    dataCache.set(k, (async () => {
      const m = parseMission(l);
      const fx = activeFixture();
      const t0 = m.net.getTime();
      const fits = (pre) => pre && pre.epochMs > t0 - 3600e3 && pre.epochMs < t0 + 6 * 3600e3;
      if (fx) {
        const t = fx.tle[l.name], f = fx.tracked[l.name];
        if (f) { const gp = trackedSet(f); return gp && trackedCt(gp, m, true); }
        const pre = t ? preFromTLE(t[0], t[1], t[2], "fixture") : null;
        return fits(pre) ? { gp: pre, prelaunch: true, fixture: true } : null;
      }
      const past = t0 < Date.now();
      if (past) {
        const gp = await loadTracked(m).catch(() => null);
        const ct = gp && trackedCt(gp, m, false);
        if (ct) return ct;
      }
      // pre-launch sets: for the next launch always (any mission); for flown ones only where
      // CelesTrak publishes them (Starlink, Starship), to keep requests low
      if (!past || m.starlinkLike || m.vehicle === "starship") {
        const pre = await loadPrelaunch(m).catch(() => null);
        if (fits(pre)) return { gp: pre, prelaunch: true };
      }
      return null;
    })().catch(() => null));
  }
  return dataCache.get(k);
}
// the event timeline, for the launch on screen only
function timelineFor(l) {
  const k = lkey(l);
  if (!timelineCache.has(k)) timelineCache.set(k, activeFixture() ? Promise.resolve({}) : loadTimeline(l).catch(() => ({})));
  return timelineCache.get(k);
}
// what the path was built from, to tell whether a re-check brought anything new
function dataSig(ct, timeline) {
  const src = !ct ? "nominal" : ct.prelaunch ? "pre" : ct.planeOnly ? "plane" : "tracked";
  const gp = ct && (ct.gp || ct.tracked);
  return [src, gp ? gp.name + "@" + gp.epochMs : "", JSON.stringify(timeline || {})].join("|");
}

async function pickLaunch(waitMs) {
  const now = Date.now();
  const { flying, next, latest } = classifyLaunches(S.data, now, S.pin);
  let pending = false;
  const ctOf = async (l) => {
    if (!l) return null;
    const ct = await within(dataFor(l), waitMs);
    if (ct === undefined) { pending = true; return null; }
    return ct;
  };
  // orbit data is only for the path, and only for the two candidates — never a filter
  const nextCt = await ctOf(next);
  const latestCt = await ctOf(latest);
  const side = chooseSide(S.which, next, latest);
  S.autoPick = side.auto;
  let timeline = side.chosen ? await within(timelineFor(side.chosen), waitMs) : {};
  if (timeline === undefined) { pending = true; timeline = {}; }
  const tNext = next ? (now - new Date(next.net).getTime()) / 1000 : 0;
  const nextLive = !!next && tNext > -LIVE_BEFORE && tNext < LIVE_AFTER;
  const other = side.which === "next" ? latest : next;
  return {
    chosen: side.chosen, ct: side.which === "next" ? nextCt : latestCt, timeline, which: side.which,
    next, latest, pending, flying, other, om: other ? parseMission(other) : null, nextLive
  };
}

async function applyMission(tParam, waitMs = Infinity) {
  const p = await pickLaunch(waitMs);
  if (!p.chosen) { el.kind.textContent = "No SpaceX data"; return; }
  showPick(p, tParam);
}

function showPick(p, tParam, keepTime) {
  const m = parseMission(p.chosen);
  S.mission = m; S.pick = p;
  const inFlight = p.which === "next" && (p.flying || []).includes(p.chosen);
  el.kind.textContent = inFlight ? "In flight" : p.which === "next" ? "Next launch" + (m.status ? " · " + m.status : "") : "Last flight";
  el.mission.textContent = m.title;
  el.net.textContent = fmtNet(m);
  const padShort = String(m.padName || "").replace(/^Space Launch Complex\s*/i, "SLC-").replace(/^Launch Complex\s*/i, "LC-");
  el.vehicle.setAttribute("href", "#veh-" + (m.vehicle === "falcon-9" && m.dragon ? "falcon-9-dragon" : m.vehicle === "other" ? "generic" : m.vehicle));
  el.pad.textContent = (m.site && /starbase/i.test(m.site) ? "Starbase" : (m.site || "")) + (padShort ? " · " + padShort : "");
  updateOther();
  const traj = buildTrajectory(m, p.ct, p.timeline);
  S.traj = keepTime && S.traj ? handover(S.traj, traj) : traj;
  buildTrack(S.traj); buildTicks();
  ll2v(m.lat, m.lon, 1.0008, padDot.position); padDot.lookAt(padDot.position.clone().multiplyScalar(2));
  window.__spacex = window.__starship = () => ({
    which: S.pick.which, autoPick: S.autoPick, launch: m.raw.name, rocket: m.rocket, vehicle: m.vehicle, art: el.vehicle.getAttribute("href"), net: m.net.toISOString(),
    other: S.pick.other ? S.pick.other.name : null, otherText: el.other.hidden ? null : el.other.textContent,
    site: m.site_kind, incl: S.traj.incl, dir: S.traj.dir, azimuth: S.traj.azimuth, why: S.traj.nominalWhy,
    source: S.traj.source, sourceDetail: S.traj.sourceDetail, srcText: el.src.textContent, tEnd: S.traj.tEnd,
    template: S.traj.template, events: S.traj.at, tracked: S.traj.tracked && { name: S.traj.tracked.name, intdes: S.traj.tracked.intdes, role: S.traj.tracked.role, epoch: new Date(S.traj.tracked.epochMs).toISOString() },
    lat0: S.traj.lat[0], lon0: S.traj.lon[0], latIns: S.traj.sample(S.traj.tSeco).lat, lonIns: S.traj.sample(S.traj.tSeco).lon
  });
  setSource();
  setFollow(ctl.follow);
  if (keepTime) setT(S.live ? realT() : S.t);
  else startTime(tParam, p.which);
}

// the small line under the mission: the other side, with a live countdown to the next launch
// two or more launches in flight at once: a chip per launch to switch between them
function updateFlying() {
  const p = S.pick, fl = (p && p.flying) || [];
  if (fl.length < 2) { el.flying.hidden = true; el.flying.textContent = ""; return; }
  el.flying.hidden = false;
  const cur = p.which === "next" ? lkey(p.chosen) : "";
  const sig = fl.map(lkey).join("|") + "#" + cur;
  if (el.flying.dataset.sig === sig) return;
  el.flying.dataset.sig = sig;
  el.flying.textContent = "";
  const lab = document.createElement("span"); lab.className = "info-flying-label"; lab.textContent = fl.length + " in flight";
  el.flying.appendChild(lab);
  for (const l of fl) {
    const m = parseMission(l), b = document.createElement("button");
    b.type = "button"; b.className = "info-chip" + (lkey(l) === cur ? " is-on" : "");
    b.textContent = m.short; b.title = m.title;
    b.setAttribute("aria-pressed", lkey(l) === cur ? "true" : "false");
    b.addEventListener("click", () => { S.pin = lkey(l); S.which = "next"; applyMission(null, Infinity); });
    el.flying.appendChild(b);
  }
}

function updateOther() {
  updateFlying();
  const p = S.pick;
  if (!p || !p.other) { el.other.hidden = true; return; }
  const om = p.om;
  el.other.hidden = false;
  if (p.which === "next") { el.other.textContent = "Last: " + om.short + " · " + fmtDate.format(om.net); return; }
  const coarse = /MONTH|QUARTER|HALF|YEAR|DAY/i.test(om.netPrecision || "");
  const dt = (om.net.getTime() - Date.now()) / 1000;
  const when = coarse ? fmtNet(om) : (dt >= 0 ? "T−" : "T+") + fmtDur(dt);
  el.other.textContent = "Next: " + om.rocket + " · " + om.short + " · " + when;
}

// pick again (after CelesTrak answered, and every 10 min); rebuild only if the answer changed.
// A refresh asks the loaders again, whose caches decide what goes to the network: a launch
// moves from the nominal profile to a pre-launch set to its tracked stage, and to newer epochs.
async function recheck(refresh) {
  if (refresh) {
    dataCache.clear(); timelineCache.clear();
    if (!activeFixture()) { try { S.data = await loadLaunches(); } catch (e) {} }
  }
  const p = await pickLaunch(Infinity);
  if (!p.chosen) return;
  const cur = S.pick;
  if (cur && lkey(cur.chosen) === lkey(p.chosen) && dataSig(cur.ct, cur.timeline) === dataSig(p.ct, p.timeline)) {
    S.pick = { ...p }; updateOther();
    return;
  }
  if (cur && lkey(cur.chosen) === lkey(p.chosen)) showPick(p, null, true); // same launch, data arrived: keep the clock
  else showPick(p, null);
}

function setSource() {
  const tr = S.traj;
  el.src.textContent = tr.sourceDetail;
  el.src.dataset.source = tr.source;
  el.src.title = tr.source === "nominal" ? "Altitude and speed from " + tr.templateFrom + ", retimed to this launch" : "";
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
  const dt = Math.min((now - S.lastFrame) / 1000, 0.25);
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

  // camera: a pinch keeps following (it only zooms); a one-finger hold pauses follow, and when it
  // resumes the camera glides back instead of snapping
  const pinching = ctl.dragging && multiGesture;
  if (ctl.follow && ctl.dragging && !pinching) ctl.followHeld = true;
  if (!ctl.dragging || pinching) {
    if (ctl.follow && ctl.followHeld) { ctl.followHeld = false; ctl.followT = performance.now(); ctl.followOff = null; }
    if (!pinching && Math.abs(ctl.vLon) + Math.abs(ctl.vLat) > 0.001) {
      ctl.tLon += ctl.vLon; ctl.tLat = clamp(ctl.tLat + ctl.vLat, -85, 85);
      const decay = Math.pow(0.9, dt * 60);
      ctl.vLon *= decay; ctl.vLat *= decay;
    } else if (ctl.follow) {
      // glide onto the ship: the offset captured when follow starts shrinks to zero along an
      // ease-in-out curve over FOLLOW_EASE_MS, so the camera stays locked to the ship (centred at any
      // speed) while the leftover offset fades out smoothly
      const sky = ctl.view === "sky" && vis.obs;
      const wantLat = clamp(sky ? vis.obs.lat : s.lat, -75, 75), wantLon = sky ? vis.obs.lon : s.lon;
      if (!ctl.followOff) ctl.followOff = { lat: ctl.lat - wantLat, lon: wrapLon(ctl.lon - wantLon) };
      const u = clamp((performance.now() - ctl.followT) / FOLLOW_EASE_MS, 0, 1);
      const left = 1 - (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
      ctl.lat = wantLat + ctl.followOff.lat * left; ctl.lon = wrapLon(wantLon + ctl.followOff.lon * left);
      ctl.tLat = ctl.lat; ctl.tLon = ctl.lon;
    }
  }
  // view zoom: glide (same ease-in-out) to the view's distance, then track it as the altitude changes
  ctl.hNow = s.alt;
  if (ctl.follow && ctl.zoomAuto) {
    const target = viewDist(ctl.view);
    const u = clamp((performance.now() - ctl.zoomT) / FOLLOW_EASE_MS, 0, 1);
    if (u < 1) { const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; ctl.tDist = ctl.dist = lerp(ctl.zoomFrom, target, e); }
    else ctl.tDist = target;
  }
  const kz = 1 - Math.pow(0.0005, dt);
  ctl.dist += (ctl.tDist - ctl.dist) * kz;
  ctl.lat += (ctl.tLat - ctl.lat) * (ctl.dragging ? 1 : kz);
  ctl.lon += wrapLon(ctl.tLon - ctl.lon) * (ctl.dragging ? 1 : kz);
  ctl.lon = wrapLon(ctl.lon); ctl.tLon = ctl.lon + wrapLon(ctl.tLon - ctl.lon);
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
  markerScreen.x = sx; markerScreen.y = sy; markerScreen.on = visible;

  visFrame(s, tr, camDir, dt);
  window.__spacexCam = () => {
    const v = new THREE.Vector3(), box = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, front: 0, n: 0 };
    const pos = vis.rings[0].line.geometry.attributes.position;
    if (vis.obs) for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k);
      const f = v.clone().normalize().dot(camDir) > 1 / ctl.dist; v.project(camera);
      const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
      box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
      box.front += f ? 1 : 0; box.n++;
    }
    return { view: ctl.view, follow: ctl.follow, zoomAuto: ctl.zoomAuto, dist: ctl.dist, tDist: ctl.tDist, fitD: ctl.fitD, minD: ctl.minD,
      lat: ctl.lat, lon: ctl.lon, ship: [s.lat, s.lon], obs: vis.obs, closeD: viewDist("close"), skyD: viewDist("sky"),
      area: { cx: globeArea.cx, cy: globeArea.cy, rPx: globeArea.rPx, W, H }, ring0: box };
  };

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
    if (S.pick && S.pick.which === "latest") updateOther();
    el.phase.textContent = S.mode === "local" ? (phase + " · " + (dispT < 0 ? "T−" : "T+") + fmtDur(dispT) + " · " + fmtDate.format(new Date(m.net.getTime() + dispT * 1000)).toUpperCase()) : phase;
  }
  // attitude (nose-up degrees): ascent pitches over, coast level, entry belly-first, flip to land
  el.ship.style.transform = `rotate(${tr.noseUpAt(S.t).toFixed(1)}deg)`;
}

layout();
boot().catch((e) => { console.error(e); el.kind.textContent = "Could not load"; });
