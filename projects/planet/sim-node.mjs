// Headless balance check for eco.js:  node projects/planet/sim-node.mjs [years] [warm] [rain] [seed]
import { createEco } from "./eco.js";
const years = +process.argv[2] || 20000, warm = +(process.argv[3] ?? 0.5), rain = +(process.argv[4] ?? 0.5);
let s = (+process.argv[5] || 7) >>> 0;
const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
// same base terrain as planet.js
let ws = 0x51a7; const r = () => ((ws = (ws * 1664525 + 1013904223) >>> 0) / 4294967296);
const waves = [];
const nv = () => { const x = r() * 2 - 1, y = r() * 2 - 1, z = r() * 2 - 1, l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
for (let i = 0; i < 9; i++) waves.push({ v: nv(), f: 1.6 + i * 0.9, a: 0.034 / (1 + i * 0.55), p: r() * 6.28 });
for (let i = 0; i < 16; i++) waves.push({ v: nv(), f: 7 + i * 1.9, a: 0.0042 / (1 + i * 0.18), p: r() * 6.28 });
const baseH = (x, y, z) => { let n = 0; for (const w of waves) n += Math.sin((x * w.v[0] + y * w.v[1] + z * w.v[2]) * w.f + w.p) * w.a; return 1.034 + n; };
const E = createEco({ rng });
E.warm = warm; E.rain = rain;
const H = new Float32Array(E.n); for (let k = 0; k < E.n; k++) H[k] = baseH(E.dir[k * 3], E.dir[k * 3 + 1], E.dir[k * 3 + 2]) - 1;
E.refreshTerrain((k) => H[k], (k) => (H[k] < 0 ? 1 : 0));
E.seed();
let land = 0; for (let k = 0; k < E.n; k++) if (!E.kind[k]) land++;
console.log(`tiles ${E.n}, land ${land}, warm ${warm}, rain ${rain}`);
const rows = [], ev = { volcano: 0, storm: 0 }; let fires = 0, msLog = [];
const t0 = Date.now();
for (let y = 1; y <= years; y++) {
  for (const e of E.tick()) {
    if (e.t === "volcano") { ev.volcano++; const k = e.k; E.damage(E.dir[k * 3], E.dir[k * 3 + 1], E.dir[k * 3 + 2], 0.12, "wurde von Lava begraben"); }
    if (e.t === "storm") ev.storm++;
    if (e.t === "ms") msLog.push(`J${y} ${e.s}`);
  }
  let g = 0, f = 0; for (let k = 0; k < E.n; k++) if (!E.kind[k]) { g += E.grass[k]; f += E.forest[k]; }
  fires += E.burning;
  rows.push({ y, g: g / land, f: f / land, c: E.critters, t: E.towns.length, p: Math.round(E.pop), b: E.routes.length, fire: E.burning });
}
const ms = (Date.now() - t0) / years;
const step = Math.max(1, Math.floor(years / 40));
for (let i = step - 1; i < rows.length; i += step) { const q = rows[i]; console.log(`J${String(q.y).padStart(6)}  gras ${q.g.toFixed(2)} wald ${q.f.toFixed(2)} tiere ${String(q.c).padStart(5)} orte ${String(q.t).padStart(2)} einw ${String(q.p).padStart(5)} boote ${q.b} feuer ${q.fire}`); }
// liveliness metrics over the 2nd half
const half = rows.slice(rows.length >> 1);
const stat = (key) => { const v = half.map((q) => q[key]); const m = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); return { min: Math.min(...v), max: Math.max(...v), mean: +m.toFixed(2), cv: +(sd / (m || 1)).toFixed(2) }; };
console.log("2nd half:", JSON.stringify({ tiere: stat("c"), orte: stat("t"), einw: stat("p"), wald: stat("f"), boote: stat("b") }));
console.log("died", E.died||0, "towns now", E.towns.length, "events", ev, "fireTileYears", fires, "log entries", E.log.length, `ms/yr ${ms.toFixed(2)}`);
console.log("milestones", msLog.join(" | "));
console.log("last log:\n " + E.log.slice(-12).map((l) => `Jahr ${l.y}: ${l.s}`).join("\n "));
const extinct = half.some((q) => q.c === 0), noTowns = half.filter((q) => q.t === 0).length / half.length;
console.log(`CHECK critters-extinct-in-2nd-half: ${extinct}  share-years-without-towns: ${noTowns.toFixed(2)}`);
