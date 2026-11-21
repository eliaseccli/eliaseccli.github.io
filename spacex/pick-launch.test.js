import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LIVE_AFTER, classifyLaunches, chooseSide, lkey } from "./pick-launch.js";

const T0 = Date.parse("2026-11-21T16:00:00Z");
const hour = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const L = (name, netMs, status = "Success") => ({
  name, net: iso(netMs), status: { abbrev: status }
});

const names = (c) => ({
  next: c.next ? c.next.name : null,
  latest: c.latest ? c.latest.name : null,
  flying: c.flying.map((l) => l.name)
});

const ussf = L("Falcon 9 Block 5 | USSF-317", T0 - 12 * hour, "Success");
const starship = L("Starship | Starlink Group 31-2 (Starship Flight 15)", T0 - 8 * 24 * hour, "Success");
const starlink = L("Falcon 9 Block 5 | Starlink Group 15-18", T0 - 21 * 24 * hour, "Success");
const nrol = L("Falcon 9 Block 5 | NROL-136", T0 + 20 * hour, "Go");
const ussfNext = L("Falcon 9 Block 5 | USSF-266", T0 + 3 * 24 * hour, "Go");

describe("classifyLaunches", () => {
  it("picks a classified last flight even when a older launch has catalogued orbit data", () => {
    // no orbit/TLE is attached here on purpose: selection must not wait for it
    const c = classifyLaunches({ upcoming: [nrol], previous: [ussf, starship, starlink] }, T0);
    assert.deepEqual(names(c), { next: "Falcon 9 Block 5 | NROL-136", latest: "Falcon 9 Block 5 | USSF-317", flying: [] });
  });

  it("picks a classified upcoming launch as next, with no pre-launch orbit data", () => {
    const upcomingClassified = L("Falcon 9 Block 5 | USSF-317", T0 + 14 * hour, "Go");
    const c = classifyLaunches({ upcoming: [upcomingClassified, ussfNext], previous: [starship] }, T0);
    assert.deepEqual(names(c), { next: "Falcon 9 Block 5 | USSF-317", latest: "Starship | Starlink Group 31-2 (Starship Flight 15)", flying: [] });
    assert.equal(chooseSide("auto", c.next, c.latest).which, "next");
    assert.equal(chooseSide("auto", c.next, c.latest).chosen.name, upcomingClassified.name);
  });

  it("picks a classified launch in flight from either LL2 list, with no orbit data", () => {
    const flying = L("Falcon 9 Block 5 | USSF-317", T0 - 30 * 60 * 1000, "In Flight");
    for (const data of [{ upcoming: [flying, nrol], previous: [starship] }, { upcoming: [nrol], previous: [flying, starship] }]) {
      const c = classifyLaunches(data, T0);
      assert.deepEqual(names(c), { next: flying.name, latest: starship.name, flying: [flying.name] });
      assert.equal(chooseSide("auto", c.next, c.latest).which, "next");
    }
  });

  it("keeps a just-succeeded launch that LL2 has not yet moved out of upcoming", () => {
    const flownStillUpcoming = L("Falcon 9 Block 5 | USSF-317", T0 - 12 * hour, "Success");
    const c = classifyLaunches({ upcoming: [flownStillUpcoming, nrol], previous: [starship] }, T0);
    assert.equal(c.latest.name, flownStillUpcoming.name);
    assert.equal(c.next.name, nrol.name);
  });

  it("treats a just-succeeded launch still in upcoming as in flight inside the live window", () => {
    const justUp = L("Falcon 9 Block 5 | USSF-317", T0 - 20 * 60 * 1000, "Success");
    const c = classifyLaunches({ upcoming: [justUp, nrol], previous: [starship] }, T0);
    assert.deepEqual(c.flying.map((l) => l.name), [justUp.name]);
    assert.equal(c.next.name, justUp.name);
    assert.equal(c.latest.name, starship.name);
  });

  it("drops a launch from in-flight after LIVE_AFTER and shows it as last flight", () => {
    const t = T0 - (LIVE_AFTER * 1000 + 1000);
    const done = L("Falcon 9 Block 5 | USSF-317", t, "Success");
    const c = classifyLaunches({ upcoming: [nrol], previous: [done, starship] }, T0);
    assert.deepEqual(c.flying, []);
    assert.equal(c.latest.name, done.name);
    assert.equal(c.next.name, nrol.name);
  });

  it("lists several in-flight launches, newest first, and honours a pin", () => {
    const a = L("Falcon 9 Block 5 | Starlink Group 10-99", T0 - 10 * 60 * 1000, "In Flight");
    const b = L("Falcon 9 Block 5 | USSF-317", T0 - 40 * 60 * 1000, "In Flight");
    const c = classifyLaunches({ upcoming: [a, nrol], previous: [b, starship] }, T0);
    assert.deepEqual(c.flying.map((l) => l.name), [a.name, b.name]);
    assert.equal(c.next.name, a.name);
    const pinned = classifyLaunches({ upcoming: [a, nrol], previous: [b, starship] }, T0, lkey(b));
    assert.equal(pinned.next.name, b.name);
  });

  it("ignores a failure when picking last flight", () => {
    const fail = L("Falcon 9 Block 5 | Demo Fail", T0 - 2 * hour, "Failure");
    const c = classifyLaunches({ upcoming: [nrol], previous: [fail, ussf] }, T0);
    assert.equal(c.latest.name, ussf.name);
  });

  it("dedupes the same launch when LL2 still lists it in both upcoming and previous", () => {
    const c = classifyLaunches({ upcoming: [ussf, nrol], previous: [ussf, starship] }, T0);
    assert.equal(c.prev.filter((l) => l.name === ussf.name).length, 1);
    assert.equal(c.latest.name, ussf.name);
  });

  it("tapping last flight prefers the most recent flown launch over the next one", () => {
    const c = classifyLaunches({ upcoming: [nrol], previous: [ussf, starship] }, T0);
    const side = chooseSide("latest", c.next, c.latest);
    assert.equal(side.which, "latest");
    assert.equal(side.chosen.name, ussf.name);
  });
});
