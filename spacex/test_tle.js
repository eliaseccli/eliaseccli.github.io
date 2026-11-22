import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ommToTLE, alpha5, normalizeTLE, tleEpochMs, pickTrackedObject } from "./tle.js";

const satellite = createRequire(import.meta.url)("../vendor/satellite.min.js");

// CelesTrak gp.php?CATNR=25544, FORMAT=json and FORMAT=tle, fetched together on 22 Nov 2026
const ISS_OMM = { OBJECT_NAME: "ISS (ZARYA)", OBJECT_ID: "1998-067A", EPOCH: "2026-11-22T04:07:11.627040", MEAN_MOTION: 15.49546258, ECCENTRICITY: 0.00073933,
  INCLINATION: 51.6321, RA_OF_ASC_NODE: 238.2738, ARG_OF_PERICENTER: 52.3454, MEAN_ANOMALY: 307.8204, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 25544, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 59624, BSTAR: 0.00018757194, MEAN_MOTION_DOT: 0.00010101, MEAN_MOTION_DDOT: 0 };
const ISS_TLE = ["1 25544U 98067A   26326.17166235  .00010101  00000+0  18757-3 0  9993",
                 "2 25544  51.6321 238.2738 0007393  52.3454 307.8204 15.49546258596247"];
// gp.php?INTDES=2026-246, first object (6-digit catalogue number: JSON only)
const SL_OMM = { OBJECT_NAME: "STARLINK-38432", OBJECT_ID: "2026-246A", EPOCH: "2026-11-22T03:07:14.777760", MEAN_MOTION: 15.68336186, ECCENTRICITY: 0.0003235,
  INCLINATION: 69.9989, RA_OF_ASC_NODE: 113.2755, ARG_OF_PERICENTER: 279.4706, MEAN_ANOMALY: 80.6123, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 101230, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 474, BSTAR: 0.0014989151, MEAN_MOTION_DOT: 0.00172165, MEAN_MOTION_DDOT: 0 };

describe("ommToTLE", () => {
  it("rebuilds CelesTrak's own TLE from its JSON", () => {
    const [l1, l2] = ommToTLE(ISS_OMM);
    assert.equal(l1, ISS_TLE[0]);
    assert.equal(l2, ISS_TLE[1]);
  });
  it("propagates the same as the original TLE", () => {
    const a = satellite.twoline2satrec(...ommToTLE(ISS_OMM)), b = satellite.twoline2satrec(...ISS_TLE);
    const d = new Date(Date.parse("2026-11-22T10:00:00Z"));
    const pa = satellite.propagate(a, d).position, pb = satellite.propagate(b, d).position;
    assert.ok(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) < 0.01, "same position to 10 m");
  });
  it("carries 6-digit catalogue numbers as Alpha-5", () => {
    assert.equal(alpha5(25544), "25544");
    assert.equal(alpha5(101230), "A1230");
    assert.equal(alpha5(339999), "Z9999");
    const [l1, l2] = ommToTLE(SL_OMM);
    assert.equal(l1.length, 69); assert.equal(l2.length, 69);
    assert.equal(l1.slice(2, 7), "A1230");
    const r = satellite.twoline2satrec(l1, l2);
    const p = satellite.propagate(r, new Date(Date.parse("2026-11-22T04:00:00Z"))).position;
    const alt = Math.hypot(p.x, p.y, p.z) - 6378.137;
    assert.ok(alt > 340 && alt < 380, "Starlink shell altitude " + alt);
    assert.ok(Math.abs(tleEpochMs(l1) - Date.parse(SL_OMM.EPOCH + "Z")) < 1);
  });
  it("normalizeTLE leaves a good pair alone", () => {
    assert.deepEqual(normalizeTLE(...ISS_TLE), ISS_TLE);
  });
});

describe("pickTrackedObject", () => {
  const o = (name, type, n, decay = "") => ({ name, type, decay, omm: { MEAN_MOTION: n } });
  it("takes the upper stage while it is in orbit", () => {
    const p = pickTrackedObject([o("SAT A", "PAY", 15.1), o("FALCON 9 R/B", "R/B", 15.3), o("SAT B", "PAY", 15.2)]);
    assert.equal(p.name, "FALCON 9 R/B"); assert.equal(p.role, "stage");
  });
  it("falls back to the payloads (median) when the stage is gone or not catalogued", () => {
    const p = pickTrackedObject([o("FALCON 9 R/B", "R/B", 16.2, "2026-11-01"), o("S1", "PAY", 15.0), o("S2", "PAY", 15.6), o("S3", "PAY", 15.2)]);
    assert.equal(p.name, "S3"); assert.equal(p.role, "payload");
  });
  it("counts Starship's ship (catalogued as a payload) as the upper stage", () => {
    const p = pickTrackedObject([o("STARLINK-40083", "PAY", 15.9), o("STARSHIP-14", "PAY", 16.0), o("STARLINK-40084", "PAY", 15.9)]);
    assert.equal(p.name, "STARSHIP-14"); assert.equal(p.role, "stage");
  });
  it("nothing usable -> null", () => {
    assert.equal(pickTrackedObject([o("X", "PAY", 15, "2026-11-02")]), null);
    assert.equal(pickTrackedObject([]), null);
  });
});
