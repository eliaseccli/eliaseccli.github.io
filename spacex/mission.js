/* The mission model, without the page: what launch it is (parseMission), the orbit plane
   it flies (nominalOrbit), and its trajectory over time (buildTrajectory). No DOM and no
   three.js, so node tests can run it (SGP4 via globalThis.satellite, satellite.js). */
import { R_E, MU, OMEGA_E, D2R } from "./earth.js?v=e1";
import { vehicleOf, pickTemplate, eventTimes, makeAscent, groundFromInertial, inertialFromGround } from "./ascent.js?v=as1";
import { LIVE_AFTER } from "./pick-launch.js?v=sx15";

export const DAY = 86400;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// signed difference in (-180, 180]; JS % keeps the sign, so normalise twice
export const wrapLon = (l) => ((((l + 180) % 360) + 360) % 360) - 180;

/* ---------------- mission model ---------------- */
export function parseMission(l) {
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
export function siteKind(lat, lon, label) {
  if (Math.abs(lat - 25.99) < 0.4 && Math.abs(lon + 97.16) < 0.5) return "starbase";
  if (/starbase/i.test(label) && /\bTX\b|texas/i.test(label)) return "starbase";
  if (lat > 27 && lat < 31 && lon > -82.2 && lon < -79.5) return "florida";
  if ((lat > 34 && lat < 35.2 && lon > -121.2 && lon < -120.2) || /vandenberg/i.test(label)) return "vandenberg";
  if (lat > 24 && lat < 31.5 && lon > -98 && lon < -84) return "gulf";
  return "other";
}
export function nominalOrbit(m) {
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
export function launchAzimuth(lat, incl, dir) {
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
export const altOfMM = (mm) => { const n = mm * 2 * Math.PI / DAY; return Math.cbrt(MU / (n * n)) - R_E; };
export function buildTrajectory(m, ct, timeline) {
  const falcon = m.vehicle !== "starship";
  const kind = m.orbital ? "orbit" : "sub";
  const nom = nominalOrbit(m);
  const tpl = pickTemplate(m);
  const at = eventTimes(tpl.id, timeline);
  const gpRec = ct && ct.gp && globalThis.satellite ? ct.gp : null;
  const flown = ct && ct.flown;

  // the orbit: the element set's plane and height; a weeks-old set only gives the plane
  let incl = flown ? flown.INCLINATION : gpRec ? gpRec.INCLINATION : nom.incl;
  incl = Math.max(incl, Math.abs(m.lat) + 0.4);
  // Falcon: nominal insertion altitudes (Starlink ~280 km, Dragon ~210 km, GTO parking ~200 km)
  const falconAlt = m.iss ? 210 : m.gto ? 200 : m.starlinkLike ? 280 : /^(SSO|PO)$/.test(m.orbitAbbrev) ? 500 : 400;
  // (a set in transfer orbit keeps the nominal parking orbit below it)
  const alt = gpRec && gpRec.MEAN_MOTION > 11 ? altOfMM(gpRec.MEAN_MOTION) : m.altKm || (falcon ? falconAlt : kind === "orbit" ? 275 : 190);
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
  // Falcon: the second stage and payloads stay in orbit, so the drawn path covers at least
  // the whole time the page shows the launch as in flight (sample() carries on past it)
  if (falcon) tEnd = Math.round(Math.max(tDeploy + 1500, kind === "sub" ? 1800 : period * 1.15, LIVE_AFTER + 600));
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
  const gtoB = gtoE / (1 + Math.sqrt(1 - gtoE * gtoE));
  // transfer orbit from the parking perigee to geostationary height (Kepler): inertial speed,
  // altitude and the true anomaly, unwrapped (it keeps growing revolution after revolution)
  function gtoAt(t) {
    const M = gtoN * (t - gtoBurn[1]);
    let E = M;
    for (let k = 0; k < 12; k++) E = E - (E - gtoE * Math.sin(E) - M) / (1 - gtoE * Math.cos(E));
    const r = gtoA * (1 - gtoE * Math.cos(E));
    return [Math.sqrt(MU * (2 / r - 1 / gtoA)), r - R_E, E + 2 * Math.atan2(gtoB * Math.sin(E), 1 - gtoB * Math.cos(E))];
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
  if (gpRec) { try { satrec = globalThis.satellite.twoline2satrec(gpRec.tle1, gpRec.tle2); } catch (e) { satrec = null; } }
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
        // (Falcon never fades out: tSgpEnd is Infinity, and smooth(Inf - 600, Inf, t) would be NaN)
        const w = smooth(tSgp, tSgp + SGP4_IN, t) * (tSgpEnd < Infinity ? 1 - smooth(tSgpEnd - 600, tSgpEnd, t) : 1);
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

  /* Past the arrays a Starship has landed; anything else is still in orbit and moves on: with
     an element set by SGP4 (the arrays end on it, fully blended in), else the orbit model in
     closed form (circular, or the transfer orbit by Kepler), continuing the arrays' last angle */
  const landed = !falcon;
  const uEnd = u0 + th[N - 1];
  const gtoEnd = gtoBurn && tEnd > gtoBurn[1] ? gtoAt(tEnd) : null;
  const nEnd = Math.sqrt(MU / Math.pow(R_E + alt, 3));
  function beyond(t) {
    const g = satrec && tSgp != null ? sgp4At(satrec, new Date(t0ms + t * 1000)) : null;
    if (g) return { lat: g.lat, lon: g.lon, alt: g.alt, spd: g.vg * 3600, k: N - 1 };
    let du, a, vi;
    if (gtoEnd) { const k1 = gtoAt(t); vi = k1[0]; a = k1[1]; du = k1[2] - gtoEnd[2]; }
    else { du = nEnd * (t - tEnd); a = alt + 1.5 * Math.sin(t / period * 2 * Math.PI); vi = Math.sqrt(MU / (R_E + a)); }
    const [la, lo] = geo(uEnd + du, t);
    return { lat: la, lon: lo, alt: a, spd: groundFromInertial(vi, la, incl, a) * 3600, k: N - 1 };
  }

  return {
    kind, falcon, landed, template: tpl.id, templateLabel: tpl.label, templateFrom: tpl.from, at,
    tracked: (ct && ct.tracked) || null, incl, dir, azimuth, nominalWhy: nom.why, period, altCoast: alt,
    tEnd, tEntry, tSeco, DT, N, lat, lon, alt: altA, spd, events,
    maxAlt: Math.max(...altA), phaseAt: (t) => phaseAt(clamp(t, -1, tEnd + 1)), noseUpAt,
    sample(t) {
      if (t <= 0) return { lat: m.lat, lon: m.lon, alt: 0, spd: 0, k: 0 };
      if (t >= tEnd) return landed ? { lat: lat[N - 1], lon: lon[N - 1], alt: 0, spd: 0, k: N - 1 } : beyond(t);
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
export function handover(prev, next) {
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
export function sgp4At(satrec, date) {
  try {
    const sat = globalThis.satellite;
    const pv = sat.propagate(satrec, date);
    if (!pv || !pv.position || !pv.velocity) return null;
    const g = sat.eciToGeodetic(pv.position, sat.gstime(date));
    const r = pv.position, v = pv.velocity;
    return { lat: g.latitude / D2R, lon: wrapLon(g.longitude / D2R), alt: g.height, vg: Math.hypot(v.x + OMEGA_E * r.y, v.y - OMEGA_E * r.x, v.z) };
  } catch (e) { return null; }
}
