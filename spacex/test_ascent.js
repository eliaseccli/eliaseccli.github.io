import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, vehicleOf, pickTemplate, eventTimes, makeAscent, timelineFromLL2, isoSeconds, groundFromInertial, inertialFromGround } from "./ascent.js";

const F9 = { vehicle: "falcon-9", orbital: true, orbitAbbrev: "LEO" };

describe("vehicleOf", () => {
  const cfg = (c, name = "X | Y") => ({ name, rocket: { configuration: c } });
  it("reads Launch Library 2's rocket configuration id first", () => {
    assert.equal(vehicleOf(cfg({ id: 164, name: "Falcon 9" })).vehicle, "falcon-9");
    assert.equal(vehicleOf(cfg({ id: 161, name: "Falcon Heavy" })).vehicle, "falcon-heavy");
    // a configuration name never overrides the id (no "Heavy" guess from a mission name)
    assert.equal(vehicleOf(cfg({ id: 164, name: "Falcon 9" }, "Falcon 9 Block 5 | Falcon Heavy Demo Rideshare")).vehicle, "falcon-9");
  });
  it("then families and full name (Starship V3 and later, new Falcon configurations)", () => {
    assert.deepEqual(vehicleOf(cfg({ id: 522, name: "Starship", full_name: "Starship V3", families: ["Starship"] })), { vehicle: "starship", rocket: "Starship" });
    assert.equal(vehicleOf(cfg({ id: 999, name: "Falcon 9 Block 6", families: [{ name: "Falcon" }, { name: "Falcon 9" }] })).vehicle, "falcon-9");
    assert.equal(vehicleOf(cfg({ id: 998, name: "Falcon Heavy Block 6", families: ["Falcon"] })).vehicle, "falcon-heavy");
  });
  it("falls back to the launch name only without a configuration", () => {
    assert.equal(vehicleOf({ name: "Starship | Flight 16" }).vehicle, "starship");
    assert.equal(vehicleOf({ name: "Falcon Heavy | USSF-99" }).rocket, "Falcon Heavy");
    assert.deepEqual(vehicleOf({ name: "Electron | Something" }), { vehicle: "other", rocket: "Electron" });
  });
});

describe("pickTemplate", () => {
  it("follows vehicle, then orbit class", () => {
    assert.equal(pickTemplate({ ...F9, starlinkLike: true }).id, "f9-leo");
    assert.equal(pickTemplate({ ...F9, iss: true }).id, "f9-iss");
    assert.equal(pickTemplate({ ...F9, gto: true, orbitAbbrev: "GTO" }).id, "f9-gto");
    assert.equal(pickTemplate({ ...F9, orbitAbbrev: "SSO" }).id, "f9-sso");
    assert.equal(pickTemplate({ ...F9, orbitAbbrev: "SSO", starlinkLike: true }).id, "f9-leo");
    assert.equal(pickTemplate({ ...F9, orbitAbbrev: "PO" }).id, "f9-leo");
    assert.equal(pickTemplate({ vehicle: "falcon-heavy", orbital: true, gto: true }).id, "fh");
    assert.equal(pickTemplate({ vehicle: "starship", orbital: true }).id, "starship-orbit");
    assert.equal(pickTemplate({ vehicle: "starship", orbital: false }).id, "starship-sub");
  });
});

describe("templates", () => {
  for (const [id, t] of Object.entries(TEMPLATES)) {
    it(id + " is well formed and physical", () => {
      assert.equal(t.alt.length, t.vh.length);
      assert.equal(t.alt.length, t.vz.length);
      assert.ok(t.src.meco > 100 && t.src.seco > t.src.meco, "MECO before SECO-1");
      assert.ok(t.alt[0] < 0.5 && t.vh[0] < 30, "starts on the pad");
      const iS = Math.round(t.src.seco / t.step);
      const vS = Math.hypot(t.vh[iS], t.vz[iS]) * 3.6;
      assert.ok(vS > 20000 && vS < 29000, "ground speed at SECO-1 " + vS);
      assert.ok(t.alt[iS] > 120 && t.alt[iS] < 650, "altitude at SECO-1 " + t.alt[iS]);
      for (let k = 1; k < t.alt.length; k++) assert.ok(Math.abs(t.alt[k] - t.alt[k - 1]) < 12, "no jumps in altitude at knot " + k);
    });
  }
});

describe("LL2 timeline", () => {
  it("reads ISO durations and keeps the first of each event after liftoff", () => {
    assert.equal(isoSeconds("PT2M26S"), 146);
    assert.equal(isoSeconds("-PT38M"), -2280);
    assert.equal(isoSeconds("P0D"), 0);
    assert.equal(isoSeconds("PT1H1M58S"), 3718);
    const tl = [{ type: { abbrev: "Liftoff" }, relative_time: "P0D" }, { type: { abbrev: "MECO" }, relative_time: "PT2M26S" },
      { type: { abbrev: "SECO-1" }, relative_time: "PT8M39S" }, { type: { abbrev: "Payload Separation" }, relative_time: "PT55M" },
      { type: { abbrev: "Payload Separation" }, relative_time: "PT60M" }];
    assert.deepEqual(timelineFromLL2(tl), { meco: 146, seco: 519, deploy: 3300 });
  });
  it("own events override the defaults, out-of-order defaults are dropped", () => {
    const at = eventTimes("starship-orbit", { seco: 1700 });
    assert.equal(at.seco, 1700);
    assert.ok(!("oib" in at), "default OIB before the launch's own SECO-1 is dropped");
  });
});

describe("makeAscent", () => {
  it("hits the mission's own event times and is continuous", () => {
    const at = eventTimes("f9-leo", { meco: 146, seco: 519 });
    const a = makeAscent("f9-leo", at, { lat: 34.63, incl: 70 });
    const t = TEMPLATES["f9-leo"];
    // the template's SECO-1 state lands on the mission's SECO-1
    const s = a.sample(519);
    assert.ok(Math.abs(s.alt - t.alt[Math.round(t.src.seco / t.step)]) < 0.6);
    let prev = a.sample(0);
    for (let x = 1; x < a.end; x += 1) {
      const c = a.sample(x);
      assert.ok(Math.abs(c.alt - prev.alt) < 2.5 && Math.abs(c.vg - prev.vg) < 0.12, "smooth at T+" + x);
      prev = c;
    }
    assert.equal(a.sample(a.end + 5), null);
  });
  it("rescales the ground speed for the launch azimuth (westward needs more)", () => {
    const at = eventTimes("f9-leo", {});
    const east = makeAscent("f9-leo", at, { lat: 28.5, incl: 43 }).sample(at.seco).vg;
    const polar = makeAscent("f9-leo", at, { lat: 34.6, incl: 97.6 }).sample(at.seco).vg;
    assert.ok(polar - east > 0.3 && polar - east < 0.7, "SSO needs ~0.45 km/s more ground speed: " + (polar - east));
  });
  it("ground and inertial speed are inverses", () => {
    for (const [lat, incl] of [[28.5, 28.6], [28.5, 53], [34.6, 97.6], [26, 30.5]]) {
      const v = 7.8, g = groundFromInertial(v, lat, incl, 200);
      assert.ok(Math.abs(inertialFromGround(g, lat, incl, 200) - v) < 1e-9);
    }
  });
});
