import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseMission, buildTrajectory, handover, DAY } from "./mission.js";
import { pickTemplate, TEMPLATES } from "./ascent.js";
import { ommToTLE, preFromTLE } from "./tle.js";

globalThis.satellite = createRequire(import.meta.url)("../vendor/satellite.min.js");

const F9 = { configuration: { id: 164, name: "Falcon 9" } }, FH = { configuration: { id: 161, name: "Falcon Heavy" } };
const SS = { configuration: { id: 522, name: "Starship", families: ["Starship"] } };
const CAPE = { name: "SLC-40", latitude: 28.5619, longitude: -80.5774, location: { name: "Cape Canaveral SFS, FL, USA" } };
const VSFB = { name: "SLC-4E", latitude: 34.632, longitude: -120.611, location: { name: "Vandenberg SFB, CA, USA" } };
const STARBASE = { name: "Orbital Launch Pad 2", latitude: 25.99677, longitude: -97.15799, location: { name: "SpaceX Starbase, TX, USA" } };
const NET = "2026-11-21T04:00:00Z";
const launch = (name, rocket, pad, orbit, description = "") => ({ name, net: NET, rocket, pad, status: { abbrev: "Success" }, mission: { name: name.split("| ")[1], orbit: { abbrev: orbit }, description } });
// one mission per template
const MISSIONS = {
  "f9-leo": launch("Falcon 9 Block 5 | Starlink Group 10-30", F9, CAPE, "LEO"),
  "f9-iss": launch("Falcon 9 Block 5 | Dragon CRS-2 SpX-99", F9, CAPE, "LEO", "Cargo Dragon resupply mission to the International Space Station."),
  "f9-gto": launch("Falcon 9 Block 5 | Test GEO Sat", F9, CAPE, "GTO"),
  "f9-sso": launch("Falcon 9 Block 5 | Transporter-99", F9, VSFB, "SSO"),
  "fh": launch("Falcon Heavy | USSF-99", FH, CAPE, "GTO"),
  "starship-orbit": launch("Starship | Starlink Group 31-9 (Starship Flight 99)", SS, STARBASE, "LEO", "The ship is expected to fly at an altitude approximately 275 km above Earth and complete approximately 3 orbits."),
  "starship-sub": launch("Starship | Starship Flight 98", SS, STARBASE, "")
};
// an element set of the stage, epoch 1 h after liftoff (as tracking delivers it), in the orbit the
// nominal ascent flies: node and phase fitted so it is within a few hundred km at T+15 min, like a
// real stage's set (a set elsewhere is a different object and would rightly jump)
const OMM = { OBJECT_NAME: "FALCON 9 R/B", OBJECT_ID: "2026-999B", EPOCH: "2026-11-21T05:00:00.000", MEAN_MOTION: 15.95, ECCENTRICITY: 0.0012, INCLINATION: 53.0,
  RA_OF_ASC_NODE: 0, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U", NORAD_CAT_ID: 99990, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1,
  BSTAR: 0.0002, MEAN_MOTION_DOT: 0.0001, MEAN_MOTION_DDOT: 0 };
const RAD = Math.PI / 180;
function fitOMM(nominal) {
  const sat = globalThis.satellite, T = 900, d = new Date(Date.parse(NET) + T * 1000), want = nominal.sample(T);
  let best = null;
  for (let raan = 0; raan < 360; raan += 3) for (let ma = 0; ma < 360; ma += 3) {
    const o = { ...OMM, RA_OF_ASC_NODE: raan, MEAN_ANOMALY: ma };
    const pv = sat.propagate(sat.twoline2satrec(...ommToTLE(o)), d);
    const g = sat.eciToGeodetic(pv.position, sat.gstime(d));
    const err = arc(want, { lat: g.latitude / RAD, lon: g.longitude / RAD });
    if (!best || err < best.err) best = { o, err };
  }
  return best.o;
}
function trackedCt(omm) {
  const [l1, l2] = ommToTLE(omm);
  const gp = { ...preFromTLE(omm.OBJECT_NAME, l1, l2, "CelesTrak GP"), intdes: omm.OBJECT_ID, role: "stage" };
  return { gp, tracked: gp };
}

const arc = (a, b) => { // degrees of great circle between two samples
  const c = Math.sin(a.lat * RAD) * Math.sin(b.lat * RAD) + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return Math.acos(Math.min(1, Math.max(-1, c))) / RAD;
};
const STEP = 60, SPAN = 3 * DAY;
// the marker keeps moving (never parked) without jumping, every minute from T+0 to T+3 days
function assertMoves(tr, label) {
  let prev = tr.sample(0), parkedAt = null;
  for (let t = STEP; t <= SPAN; t += STEP) {
    const s = tr.sample(t);
    for (const k of ["lat", "lon", "alt", "spd"]) assert.ok(Number.isFinite(s[k]), `${label}: ${k} not finite at T+${t}s`);
    const d = arc(prev, s);
    assert.ok(d < 6, `${label}: jumps ${d.toFixed(2)}° at T+${t}s`);
    if (tr.landed && t - STEP >= tr.tEnd) {          // Starship: on the ground at the landing point
      assert.ok(d < 1e-5, `${label}: moves after landing`);
      assert.equal(s.alt, 0);
    } else {
      assert.ok(d > 0 || s.alt !== prev.alt, `${label}: parked at T+${t}s (lat ${s.lat.toFixed(2)}, lon ${s.lon.toFixed(2)})`);
      if (!tr.landed && t > 1200) assert.ok(s.alt > 150 && s.spd > (tr.at.seco2 && /gto|fh/.test(label) ? 1000 : 20000), `${label}: fell out of orbit at T+${t}s (${s.alt.toFixed(0)} km, ${s.spd.toFixed(0)} km/h)`);
    }
    prev = s;
  }
}

describe("trajectory keeps moving", () => {
  for (const [id, l] of Object.entries(MISSIONS)) {
    it(`${id}: nominal profile, T+0 to T+3 days`, () => {
      const m = parseMission(l);
      assert.equal(pickTemplate(m).id, id);
      const tr = buildTrajectory(m, null, {});
      assert.equal(tr.landed, m.vehicle === "starship");
      assertMoves(tr, id);
    });
  }
  it("every template has a mission here", () => assert.deepEqual(Object.keys(MISSIONS).sort(), Object.keys(TEMPLATES).sort()));
  it("Falcon paths cover the whole time a launch counts as in flight", () => {
    for (const id of ["f9-leo", "f9-iss", "f9-gto", "f9-sso", "fh"]) assert.ok(buildTrajectory(parseMission(MISSIONS[id]), null, {}).tEnd >= 3 * 3600, id);
  });
  it("tracked TLE (SGP4 blended in from SECO, then SGP4 past the arrays)", () => {
    const m = parseMission(MISSIONS["f9-leo"]);
    const omm = fitOMM(buildTrajectory(m, null, {}));
    const tr = buildTrajectory(m, trackedCt(omm), {});
    assertMoves(tr, "f9-leo tracked");
    // past the arrays it is SGP4 itself
    const t = 2 * DAY, s = tr.sample(t);
    const sat = globalThis.satellite, rec = sat.twoline2satrec(...ommToTLE(omm));
    const g = sat.eciToGeodetic(sat.propagate(rec, new Date(Date.parse(NET) + t * 1000)).position, sat.gstime(new Date(Date.parse(NET) + t * 1000)));
    assert.ok(Math.abs(s.lat - g.latitude / RAD) < 1e-6 && Math.abs(s.alt - g.height) < 1e-6);
  });
  it("handover from the nominal path to the tracked one keeps moving", () => {
    const m = parseMission(MISSIONS["f9-leo"]);
    const nominal = buildTrajectory(m, null, {}), tracked = buildTrajectory(m, trackedCt(fitOMM(nominal)), {});
    const h = handover(nominal, tracked); // mid-glide: performance.now() barely moved
    assertMoves(h, "handover");
  });
});
