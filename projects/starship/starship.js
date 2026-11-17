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
// signed difference in (-180, 180]; JS % keeps the sign, so normalise twice
const wrapLon = (l) => ((((l + 180) % 360) + 360) % 360) - 180;

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
const LL_CACHE = "starship.ll2.v3";
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
    mission: { name: m.name || "", orbit: { abbrev: (m.orbit || {}).abbrev || "", name: (m.orbit || {}).name || "" }, description: m.description || "" }
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
const PRE_CACHE = "starship.prelaunch.v2";
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
  if (m.flightNo) { add("starship-flight-" + m.flightNo); add("starship-" + m.flightNo); }
  for (const n of names) {
    const part = n.split("|").slice(1).join(" ").trim() || n; // "Starship | X (Flight 16)" -> "X"
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
  const ship = m.flightNo ? new RegExp("^STARSHIP[\\s-]*(?:FLIGHT[\\s-]*|F)?" + m.flightNo + "\\b", "i") : /^STARSHIP\b/i;
  const files = prelaunchFiles(m);
  const tries = files.map((f) => ({ q: "FILE=" + f + "&FORMAT=3LE", file: f }));
  if (dt > -3 * DAY * 1000 && dt < 2 * DAY * 1000) tries.push({ q: "NAME=STARSHIP&FORMAT=3LE", file: null });
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

// Rebuild a TLE pair in strict fixed columns (pre-launch sets are often
// shared with collapsed spacing, e.g. without the international designator).
function tleChecksum(l) {
  let c = 0;
  for (const ch of l.slice(0, 68)) { if (ch >= "0" && ch <= "9") c += +ch; else if (ch === "-") c += 1; }
  return String(c % 10);
}
function normalizeTLE(l1, l2) {
  l1 = String(l1 || "").trim(); l2 = String(l2 || "").trim();
  if (l1.length === 69 && l2.length === 69 && l1[18] !== " " && l2[7] === " ") return [l1, l2];
  const a = l1.split(/\s+/), b = l2.split(/\s+/);
  if (a[0] !== "1" || b[0] !== "2") return null;
  const catCls = a[1];
  const cat = catCls.replace(/[A-Z]$/i, "").padStart(5, "0").slice(-5);
  const cls = /[A-Z]$/i.test(catCls) ? catCls.slice(-1).toUpperCase() : "U";
  let i = 2, intdes = "";
  if (!/^\d{5}\.\d+$/.test(a[i])) intdes = a[i++];
  const epoch = a[i++], ndot = a[i++], nddot = a[i++], bstar = a[i++], eph = a[i++] || "0";
  // last token is element-set number + checksum digit
  const elTok = a[i++] || "9990";
  const el = (elTok.length > 1 ? elTok.slice(0, -1) : elTok).slice(-4);
  if (!/^\d{5}\.\d+$/.test(epoch)) return null;
  const sgnF = (v, w) => (v.startsWith("-") || v.startsWith("+") ? v.replace("+", " ") : " " + v).padStart(w, " ").slice(-w);
  const f = (x, w, d) => (+x).toFixed(d).padStart(w, " ");
  let L1 = "1 " + cat + cls + " " + intdes.padEnd(8, " ").slice(0, 8) + " " + epoch.padStart(14, "0").slice(0, 14) + " " +
    sgnF(ndot.replace(/^(-?)0\./, "$1."), 10) + " " + sgnF(nddot, 8) + " " + sgnF(bstar, 8) + " " + eph.slice(0, 1) + " " + el.padStart(4, " ");
  L1 = L1.slice(0, 68).padEnd(68, " "); L1 += tleChecksum(L1);
  const inc = b[2], raan = b[3], ecc = b[4], argp = b[5], ma = b[6];
  let mm = b[7] || "";
  // last token is rev number + checksum digit (or glued to the mean motion)
  let rev = b[8] ? (b[8].length > 1 ? b[8].slice(0, -1) : "0") : "0";
  if (mm.length > 11) { rev = mm.slice(11, -1) || "0"; mm = mm.slice(0, 11); }
  let L2 = "2 " + cat + " " + f(inc, 8, 4) + " " + f(raan, 8, 4) + " " + ecc.replace(/^0?\./, "").padStart(7, "0").slice(0, 7) + " " +
    f(argp, 8, 4) + " " + f(ma, 8, 4) + " " + f(mm, 11, 8) + String(rev.replace(/\D/g, "").slice(0, 5) || "0").padStart(5, " ");
  L2 = L2.slice(0, 68).padEnd(68, " "); L2 += tleChecksum(L2);
  return [L1, L2];
}
function tleEpochMs(l1) {
  const yy = +l1.slice(18, 20), doy = +l1.slice(20, 32);
  const y = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(y, 0, 1) + (doy - 1) * 864e5;
}
function parse3LE(txt) {
  const ln = String(txt || "").split(/\r?\n/).map((x) => x.replace(/\s+$/, "")).filter((x) => x.trim());
  const out = [];
  for (let k = 0; k < ln.length; k++) {
    if (ln[k].startsWith("1 ") && ln[k + 1] && ln[k + 1].startsWith("2 ")) {
      const name = k > 0 && !ln[k - 1].startsWith("2 ") && !ln[k - 1].startsWith("1 ") ? ln[k - 1].replace(/^0\s+/, "").trim() : "";
      out.push({ name, l1: ln[k], l2: ln[k + 1] }); k++;
    }
  }
  return out;
}
function preFromTLE(name, l1, l2, source) {
  const n = normalizeTLE(l1, l2);
  if (!n) return null;
  return { tle1: n[0], tle2: n[1], name, source, epochMs: tleEpochMs(n[0]), INCLINATION: +n[1].slice(8, 16), MEAN_MOTION: +n[1].slice(52, 63) };
}
// Harmless test fixtures (no network for the launch or the orbit):
//   ?fixture=f14-prelaunch  Starbase flight with a pre-launch element set
//   ?fixture=florida        Starlink-like flight from LC-39A, nominal 53° NE
//   ?fixture=florida-hls    non-Starlink LEO flight from SLC-37, nominal 43° SE
const FIXTURES = {
  "f14-prelaunch": {
    launch: {
      name: "Starship | Starlink Group 31-1 (Starship Flight 14)", net: "2026-09-28T12:48:59Z", net_precision: "Second",
      status: { abbrev: "Success" },
      pad: { name: "Orbital Launch Pad 2", latitude: 25.99677, longitude: -97.15799, location: { name: "SpaceX Starbase, TX, USA" } },
      mission: { orbit: { abbrev: "LEO" }, description: "The ship is expected to fly at an altitude approximately 275 km above Earth and complete approximately 6 orbits around the planet for nearly 10 hours, with splashdown targeted in the Pacific Ocean west of Chile." }
    },
    tle: ["STARSHIP-14",
      "1 99998U 26271.55155093 .00000000 00000-0 50000-4 0 07",
      "2 99998 30.5122 340.6000 0001503 0.0000 218.3000 15.99431098 04"]
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
  }
};
function activeFixture() {
  try { return FIXTURES[new URLSearchParams(location.search).get("fixture")] || null; } catch (e) { return null; }
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
  const lat = isFinite(pad.latitude) && pad.latitude !== null ? +pad.latitude : 25.99677;
  const lon = isFinite(pad.longitude) && pad.longitude !== null ? +pad.longitude : -97.15799;
  const inclM = desc.match(/(\d{1,3}(?:\.\d+)?)\s*(?:°|deg(?:rees?)?)\s*(?:orbital\s+)?inclination|inclination (?:of )?(?:approximately |about |around |~)?(\d{1,3}(?:\.\d+)?)\s*(?:°|deg)/i);
  const missionName = String((l.mission || {}).name || "");
  return {
    raw: l,
    missionName,
    orbitAbbrev,
    site_kind: siteKind(lat, lon, ((pad.location || {}).name || "") + " " + (pad.name || "")),
    targetIncl: inclM ? +(inclM[1] || inclM[2]) : null,
    starlinkLike: /starlink/i.test(name + " " + missionName),
    name: after,
    title,
    flightNo,
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
   - Anywhere else: same orbit-class defaults, descending below 50°.
   Launch azimuth from north: sin(az) = cos(i) / cos(lat); ascending = az,
   descending = 180° − az. */
function siteKind(lat, lon, label) {
  if (Math.abs(lat - 25.99) < 0.4 && Math.abs(lon + 97.16) < 0.5) return "starbase";
  if (/starbase/i.test(label) && /\bTX\b|texas/i.test(label)) return "starbase";
  if (lat > 27 && lat < 31 && lon > -82.2 && lon < -79.5) return "florida";
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
  else if (ab === "SSO") { incl = 97.5; why = "SSO"; }
  else if (ab === "PO") { incl = 90; why = "polar"; }
  else if (/^(GTO|GSO|GEO|GSTO|MEO|HEO|LO|TLI|HCO|SO|ELL)$/.test(ab)) { incl = latA + 0.5; why = "due-east parking orbit"; }
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
  Trajectory: a great circle (the orbit plane) through the pad, flown with a
  phase-dependent speed/altitude profile. Positions are integrated in the
  inertial frame and rotated into Earth-fixed coordinates.
*/
function buildTrajectory(m, ct) {
  const T_INS = 510;              // SECO ~T+8:30
  let incl, alt, tEnd, tEntry, kind, source, sourceDetail, gpRec = null;

  if (ct && ct.gp && window.satellite) {
    source = "celestrak";
    sourceDetail = ct.prelaunch ? "CelesTrak pre-launch prediction" + (ct.gp.proxy ? " · " + ct.gp.proxy : "") + (ct.fixture ? " · test fixture" : "") : "CelesTrak GP · SGP4";
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
  const nom = nominalOrbit(m);
  if (!alt) alt = m.altKm || (kind === "orbit" ? 275 : 190);
  if (!incl) incl = nom.incl;
  incl = Math.max(incl, Math.abs(m.lat) + 0.4);
  let dir = nom.dir;

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
  // argument of latitude at the pad: descending branch (heading ESE from
  // Starbase) or ascending branch (heading NE), see nominalOrbit()
  const uAsc = Math.asin(clamp(Math.sin(latP) / Math.sin(i), -1, 1));
  let u0 = dir === "asc" ? uAsc : Math.PI - uAsc;
  let Om = m.lon * D2R - Math.atan2(Math.cos(i) * Math.sin(u0), Math.cos(u0));

  function geo(u, t) {
    const lat = Math.asin(Math.sin(i) * Math.sin(u));
    const lonI = Om + Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u));
    return [lat / D2R, wrapLon((lonI - OMEGA_E * t) / D2R)];
  }

  // With a real element set (outside Starbase) take the branch whose
  // insertion point lies closer to where SGP4 puts the object at T+8:30.
  if (gpRec && m.site_kind !== "starbase" && window.satellite) {
    try {
      const sr = window.satellite.twoline2satrec(gpRec.tle1, gpRec.tle2);
      const s = sgp4At(sr, new Date(m.net.getTime() + T_INS * 1000));
      if (s) {
        const dAng = 0.62 * T_INS * Math.sqrt(MU / (R_E + alt)) / (R_E + alt * 0.4); // rough downrange
        const score = (d) => {
          u0 = d === "asc" ? uAsc : Math.PI - uAsc;
          Om = m.lon * D2R - Math.atan2(Math.cos(i) * Math.sin(u0), Math.cos(u0));
          const [la, lo] = geo(u0 + dAng, T_INS);
          return Math.hypot(la - s.lat, wrapLon(lo - s.lon) * Math.cos(s.lat * D2R));
        };
        const sa = score("asc"), sd = score("desc");
        dir = sa < sd ? "asc" : "desc";
      }
    } catch (e) {}
    u0 = dir === "asc" ? uAsc : Math.PI - uAsc;
    Om = m.lon * D2R - Math.atan2(Math.cos(i) * Math.sin(u0), Math.cos(u0));
  }
  const azimuth = launchAzimuth(m.lat, incl, dir);

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
    kind, source, sourceDetail, incl, dir, azimuth, nominalWhy: nom.why, period, altCoast: alt, tEnd, tEntry, DT, N, lat, lon, alt: altA, spd, events,
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

const nightTex = loader.load(maxTex >= 4096 ? "./assets/earth-night-4k.jpg" : "./assets/earth-night-2k.jpg");
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
  // a short, still tap near the Starship marker turns follow mode on
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
  if (on && !ctl.follow) { ctl.followT = performance.now(); ctl.followOff = null; }
  ctl.follow = on;
  followBtn.hidden = false;
  followBtn.classList.toggle("is-on", on);
  followBtn.setAttribute("aria-pressed", on ? "true" : "false");
  followBtn.title = on ? "Following Starship" : "Follow Starship";
}
// the button toggles follow; turning it on also re-centres and resets the zoom
followBtn.addEventListener("click", () => { if (ctl.follow) { setFollow(false); return; } setFollow(true); ctl.vLat = ctl.vLon = 0; ctl.tDist = ctl.fitD; });

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
window.__starshipScrub = { scrubSecPerPx, scrubFineRange };
window.__starshipDebug = { traj: () => S.traj, normalizeTLE };

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

/* ---------------- mission selection ---------------- */
async function boot() {
  layout();
  try { const m = localStorage.getItem("starship.mode"); if (m === "local" || m === "mission") S.mode = m; } catch (e) {}
  const q = new URLSearchParams(location.search);
  if (q.get("mission") === "next" || q.get("mission") === "latest") S.which = q.get("mission");
  syncButtons();
  const fx = activeFixture();
  S.data = fx ? { upcoming: [], previous: [fx.launch] } : await loadLaunches();
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
  window.__starship = () => ({ site: m.site_kind, incl: S.traj.incl, dir: S.traj.dir, azimuth: S.traj.azimuth, why: S.traj.nominalWhy, source: S.traj.sourceDetail, lat0: S.traj.lat[0], lon0: S.traj.lon[0], latIns: S.traj.sample(510).lat, lonIns: S.traj.sample(510).lon });
  setSource();
  startTime(tParam, p.which);

  // CelesTrak (async, non-blocking): (a) pre-launch SupGP, (b) SATCAT/GP, (c) nominal
  let ct = null;
  const fx = activeFixture();
  let pre = fx ? (fx.tle ? preFromTLE(fx.tle[0], fx.tle[1], fx.tle[2], "fixture") : null) : await loadPrelaunch(m);
  // only use a predicted set that belongs to this liftoff (epoch between T-1h and T+6h)
  if (pre && !(pre.epochMs > m.net.getTime() - 3600e3 && pre.epochMs < m.net.getTime() + 6 * 3600e3)) pre = null;
  if (pre) ct = { gp: pre, prelaunch: true, fixture: !!fx };
  else if (!fx) ct = await loadCelestrak(m.flightNo);
  if (S.mission === m && ct && (ct.gp || ct.rec)) {
    S.traj = buildTrajectory(m, ct);
    buildTrack(S.traj); buildTicks(); setSource(); setT(S.t);
  }
}

function setSource() {
  const tr = S.traj;
  // away from Starbase the nominal plane is a guess from the pad, so say which
  const nomTxt = S.mission && S.mission.site_kind !== "starbase" ? "Nominal profile · " + Math.round(tr.incl) + "° · not live data" : "Nominal profile · not live data";
  el.src.textContent = tr.source === "celestrak" ? tr.sourceDetail : nomTxt;
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

  // camera
  if (!ctl.dragging) {
    if (Math.abs(ctl.vLon) + Math.abs(ctl.vLat) > 0.001) {
      ctl.tLon += ctl.vLon; ctl.tLat = clamp(ctl.tLat + ctl.vLat, -85, 85);
      const decay = Math.pow(0.9, dt * 60);
      ctl.vLon *= decay; ctl.vLat *= decay;
    } else if (ctl.follow) {
      // glide onto the ship: the offset captured when follow starts shrinks to zero along an
      // ease-in-out curve over FOLLOW_EASE_MS, so the camera stays locked to the ship (centred at any
      // speed) while the leftover offset fades out smoothly
      const wantLat = clamp(s.lat, -75, 75), wantLon = s.lon;
      if (!ctl.followOff) ctl.followOff = { lat: ctl.lat - wantLat, lon: wrapLon(ctl.lon - wantLon) };
      const u = clamp((performance.now() - ctl.followT) / FOLLOW_EASE_MS, 0, 1);
      const left = 1 - (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
      ctl.lat = wantLat + ctl.followOff.lat * left; ctl.lon = wrapLon(wantLon + ctl.followOff.lon * left);
      ctl.tLat = ctl.lat; ctl.tLon = ctl.lon;
    }
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
