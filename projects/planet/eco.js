/* Ecosystem layer: a per-tile simulation on a cube-sphere grid. Pure JS (no three.js) so it also runs headless in node.
   One tick = one year. Each tile: altitude, moisture, temperature, grass, forest, critters, fire, ash; towns live on tiles. */
export const TN = 22;
const FM = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const FU = [[0,0,-1],[0,0,1],[1,0,0],[1,0,0],[1,0,0],[-1,0,0]];
const FV = [[0,1,0],[0,1,0],[0,0,-1],[0,0,1],[0,1,0],[0,1,0]];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const NBK = 8;
const PRE = ["Moos","Birk","Tann","Fels","Wolf","Hasel","Sonn","Nebel","Eich","Kiesel","Reh","Lind","Erlen","Falken","Mühl","Wein","Bär","Kranich","Weiden","Stein","Rosen","Gold","Biber","Fuchs","Otter","Ahorn","Buchen","Schilf","Kalk","Hirsch"];
const SUF = ["bucht","dorf","au","heim","hafen","bach","wald","feld","see","ried","berg","tal","furt","ufer","hain","brück","grund","wiese","eck","horn"];

export function createEco(o = {}) {
  const R = o.rng || Math.random;
  const n = 6 * TN * TN, dir = new Float32Array(n * 3);
  for (let f = 0; f < 6; f++) for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
    const u = (i + 0.5) / TN * 2 - 1, v = (j + 0.5) / TN * 2 - 1, M = FM[f], U = FU[f], W = FV[f];
    const x = M[0] + U[0] * u + W[0] * v, y = M[1] + U[1] * u + W[1] * v, z = M[2] + U[2] * u + W[2] * v, l = Math.hypot(x, y, z);
    const k = f * TN * TN + j * TN + i; dir[k * 3] = x / l; dir[k * 3 + 1] = y / l; dir[k * 3 + 2] = z / l;
  }
  const dot = (a, b) => dir[a * 3] * dir[b * 3] + dir[a * 3 + 1] * dir[b * 3 + 1] + dir[a * 3 + 2] * dir[b * 3 + 2];
  const nb = new Int32Array(n * NBK).fill(-1);
  for (let a = 0; a < n; a++) {
    const c = [];
    for (let b = 0; b < n; b++) if (b !== a) { const d = dot(a, b); if (d > 0.985) c.push([d, b]); }
    c.sort((p, q) => q[0] - p[0]);
    for (let m = 0; m < NBK && m < c.length; m++) nb[a * NBK + m] = c[m][1];
  }
  const ringCache = new Map();
  function ring(k, cosR = 0.9875) { // ~2 tile rings around k (town catchment)
    let r = ringCache.get(k); if (r) return r;
    r = []; for (let b = 0; b < n; b++) if (dot(k, b) > cosR) r.push(b);
    ringCache.set(k, r); return r;
  }
  function tileAt(x, y, z) {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    const f = ax >= ay && ax >= az ? (x > 0 ? 0 : 1) : ay >= az ? (y > 0 ? 2 : 3) : (z > 0 ? 4 : 5);
    const M = FM[f], U = FU[f], W = FV[f], m = x * M[0] + y * M[1] + z * M[2];
    const i = clamp(Math.floor(((x * U[0] + y * U[1] + z * U[2]) / m + 1) * 0.5 * TN), 0, TN - 1);
    const j = clamp(Math.floor(((x * W[0] + y * W[1] + z * W[2]) / m + 1) * 0.5 * TN), 0, TN - 1);
    return f * TN * TN + j * TN + i;
  }

  // ---- state ----
  const kind = new Uint8Array(n);      // 0 land, 1 sea, 2 lake
  const alt = new Float32Array(n);     // height above sea level
  const coast = new Uint8Array(n), shore = new Uint8Array(n), seaId = new Int32Array(n).fill(-1);
  const moist = new Float32Array(n).fill(0.5), temp = new Float32Array(n);
  const grass = new Float32Array(n), forest = new Float32Array(n), crit = new Float32Array(n), ash = new Float32Array(n);
  const fire = new Uint8Array(n), ruin = new Uint8Array(n);
  const tmp = new Float32Array(n);
  const townAt = new Array(n).fill(null);
  const E = {
    n, dir, nb, NBK, kind, alt, coast, shore, seaId, moist, temp, grass, forest, crit, ash, fire, ruin, townAt,
    towns: [], routes: [], log: [], ms: [], year: 0, warm: 0.5, rain: 0.5, drift: 0, W: 0.5, Rn: 0.5,
    names: new Set(), ph: [R() * 6.28, R() * 6.28, R() * 6.28, R() * 6.28], routeDirty: true, burning: 0, bigFire: false, quietFire: 0,
    tileAt, ring, dot
  };
  let out = [];
  const say = (s) => { E.log.push({ y: E.year, s }); if (E.log.length > 80) E.log.shift(); out.push({ t: "log", s, y: E.year }); };
  const mile = (id, s) => { if (E.ms.includes(id)) return; E.ms.push(id); out.push({ t: "ms", s }); say("🏅 " + s); };
  function newName() {
    for (let i = 0; i < 40; i++) { const s = PRE[(R() * PRE.length) | 0] + SUF[(R() * SUF.length) | 0]; if (!E.names.has(s)) { E.names.add(s); return s; } }
    const s = PRE[(R() * PRE.length) | 0] + SUF[(R() * SUF.length) | 0] + " " + (E.names.size + 1); E.names.add(s); return s;
  }
  const label = (t) => (t.pop >= 150 ? (t.harbor ? "die Hafenstadt" : "die Stadt") : "das Dorf") + " " + t.name;
  const Label = (t) => label(t).replace(/^d/, "D");

  // ---- terrain sync (called by host when land moves / water changes) ----
  E.refreshTerrain = function (altFn, kindFn) {
    for (let k = 0; k < n; k++) {
      alt[k] = altFn(k);
      const was = kind[k]; kind[k] = kindFn(k);
      if (kind[k] && !was) { grass[k] = forest[k] = crit[k] = ash[k] = 0; fire[k] = 0; if (townAt[k]) killTown(townAt[k], "ist in den Fluten versunken"); }
    }
    for (let k = 0; k < n; k++) {
      let c = 0, s = 0; for (let m = 0; m < NBK; m++) { const b = nb[k * NBK + m]; if (b < 0) continue; if (kind[b] === 1) c = 1; if (kind[b]) s = 1; }
      coast[k] = kind[k] === 0 ? c : 0; shore[k] = kind[k] === 0 ? s : 0;
    }
    seaId.fill(-1); let id = 0; const q = [];
    for (let k = 0; k < n; k++) {
      if (kind[k] !== 1 || seaId[k] >= 0) continue;
      seaId[k] = id; q.length = 0; q.push(k);
      for (let h = 0; h < q.length; h++) { const a = q[h]; for (let m = 0; m < 4; m++) { const b = nb[a * NBK + m]; if (b >= 0 && kind[b] === 1 && seaId[b] < 0) { seaId[b] = id; q.push(b); } } }
      id++;
    }
    E.routeDirty = true;
  };

  function foundTown(k) {
    const t = { k, name: newName(), pop: 12 + R() * 6, born: E.year, plague: 0, immune: 0, big: false, harbor: false, peak: 0 };
    E.towns.push(t); townAt[k] = t; ruin[k] = 0;
    say(`Am ${coast[k] ? "Meeresufer" : "Seeufer"} entsteht das Dorf ${t.name}.`);
    mile("dorf", "Erstes Dorf");
    return t;
  }
  function killTown(t, why) {
    if (t.dead) return; t.dead = true;
    say(`${Label(t)} ${why}.`); E.died = (E.died || 0) + 1;
    townAt[t.k] = null; ruin[t.k] = 40;
    E.towns.splice(E.towns.indexOf(t), 1);
    for (let i = E.routes.length - 1; i >= 0; i--) { const r = E.routes[i]; if (r.a === t || r.b === t) { E.routes.splice(i, 1); say(`Die Boote zwischen ${r.a.name} und ${r.b.name} bleiben im Hafen.`); } }
  }

  // ---- routes: towns on the same sea trade by boat ----
  function seaStart(t) { let best = -1; for (let m = 0; m < NBK; m++) { const b = nb[t.k * NBK + m]; if (b >= 0 && kind[b] === 1) { best = b; break; } } return best; }
  function bfs(src) {
    const prev = new Int32Array(n).fill(-2), dist = new Int32Array(n).fill(-1), q = [src];
    prev[src] = -1; dist[src] = 0;
    for (let h = 0; h < q.length; h++) { const a = q[h]; if (dist[a] > 140) continue; for (let m = 0; m < NBK; m++) { const b = nb[a * NBK + m]; if (b >= 0 && kind[b] === 1 && prev[b] === -2) { prev[b] = a; dist[b] = dist[a] + 1; q.push(b); } } }
    return { prev, dist };
  }
  function updateRoutes() {
    E.routeDirty = false;
    const H = E.towns.filter((t) => t.harbor);
    for (let i = E.routes.length - 1; i >= 0; i--) { const r = E.routes[i]; if (!r.a.harbor || !r.b.harbor) { E.routes.splice(i, 1); say(`Die Handelsroute ${r.a.name} – ${r.b.name} ist eingeschlafen.`); } }
    const has = (a, b) => E.routes.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
    const deg = (a) => E.routes.reduce((s, r) => s + (r.a === a || r.b === a), 0);
    for (const a of H) {
      if (deg(a) >= 2) continue;
      const s = seaStart(a); if (s < 0) continue;
      const { prev, dist } = bfs(s);
      const cand = [];
      for (const b of H) { if (b === a || has(a, b) || deg(b) >= 3) continue; const e = seaStart(b); if (e >= 0 && dist[e] > 2) cand.push([dist[e], b, e]); }
      cand.sort((p, q) => p[0] - q[0]);
      for (const [, b, e] of cand.slice(0, 2 - deg(a))) {
        const path = []; for (let c = e; c >= 0; c = prev[c]) path.push(c); path.reverse();
        E.routes.push({ a, b, path, u: 0, sp: 1 });
        if (E.routes.length === 1 || !E.ms.includes("route")) mile("route", "Erste Handelsroute");
        say(`Handelsroute ${a.name} – ${b.name} eröffnet. ⛵`);
      }
    }
    // reject stale paths (land poked into the sea)
    for (let i = E.routes.length - 1; i >= 0; i--) if (E.routes[i].path.some((k) => kind[k] !== 1)) { const r = E.routes.splice(i, 1)[0]; say(`Neues Land versperrt den Seeweg ${r.a.name} – ${r.b.name}.`); E.routeDirty = true; }
  }

  // ---- damage hooks (volcano lava, meteor, storm) ----
  E.damage = function (x, y, z, rad, why) {
    const c = Math.cos(rad), l = Math.hypot(x, y, z);
    for (let k = 0; k < n; k++) {
      if ((dir[k * 3] * x + dir[k * 3 + 1] * y + dir[k * 3 + 2] * z) / l < c) continue;
      forest[k] = 0; grass[k] *= 0.2; crit[k] = 0; ash[k] = 1; fire[k] = 0;
      if (townAt[k]) killTown(townAt[k], why);
    }
  };
  E.rainOn = function (x, y, z, amt) { const k = tileAt(x, y, z); moist[k] = Math.min(1.3, moist[k] + amt); for (let m = 0; m < NBK; m++) { const b = nb[k * NBK + m]; if (b >= 0) moist[b] = Math.min(1.3, moist[b] + amt * 0.6); } };
  E.ignite = function (k) { if (kind[k] === 0 && forest[k] > 0.1 && !fire[k]) { fire[k] = 3; return true; } return false; };

  function randomLand(test) { for (let i = 0; i < 200; i++) { const k = (R() * n) | 0; if (kind[k] === 0 && (!test || test(k))) return k; } return -1; }
  E.seed = function () {
    for (let k = 0; k < n; k++) if (kind[k] === 0) grass[k] = 0.15 + 0.25 * R();
    for (let i = 0; i < 8; i++) { const k = randomLand((k) => alt[k] < 0.05); if (k < 0) continue; forest[k] = 0.7; for (let m = 0; m < NBK; m++) { const b = nb[k * NBK + m]; if (b >= 0 && !kind[b]) forest[b] = Math.max(forest[b], 0.35); } }
    for (let i = 0; i < 8; i++) { const k = randomLand(); if (k >= 0) crit[k] = 0.4; }
  };

  // ---- one year ----
  E.tick = function () {
    out = [];
    const y = ++E.year, P = E.ph, TAU = 6.2832;
    E.drift = clamp(E.drift * 0.93 + (R() - 0.5) * 0.09, -0.3, 0.3);
    E.W = E.warm + 0.07 * Math.sin(TAU * y / 311 + P[0]) + 0.04 * Math.sin(TAU * y / 89 + P[3]);
    E.Rn = Math.max(0, E.rain * (0.85 + 0.32 * Math.sin(TAU * y / 173 + P[1]) + 0.16 * Math.sin(TAU * y / 47 + P[2]) + E.drift));
    const W = E.W, Rn = E.Rn;
    // vegetation, critters, fire start
    let burning = 0;
    for (let k = 0; k < n; k++) {
      if (kind[k]) { tmp[k] = 0; continue; }
      const lat = dir[k * 3 + 1], a = Math.max(0, alt[k]);
      const T = 0.3 + 0.7 * W - 0.45 * lat * lat - 4 * Math.max(0, a - 0.02); temp[k] = T;
      let wn = 0; for (let m = 0; m < NBK; m++) { const b = nb[k * NBK + m]; if (b >= 0 && kind[b]) wn++; }
      const dx = dir[k * 3], dy = lat, dz = dir[k * 3 + 2];
      const reg = Math.sin(dx * 2.3 + dz * 1.1 + y / 70 + P[0]) + Math.sin(dz * 2.7 - dy * 1.9 - y / 110 + P[1]) * 0.8; // drifting wet & dry regions
      const Mt = Rn * (0.9 + 0.08 * wn) * (1 + 0.32 * reg) * (T > 0.8 ? 0.8 : 1);
      moist[k] += (Mt - moist[k]) * 0.3;
      const mo = moist[k];
      const tS = clamp(1 - Math.abs(T - 0.55) / 0.45, 0, 1), wS = clamp((mo - 0.08) / 0.45, 0, 1);
      let suit = tS * wS * (ash[k] > 0 ? 1.25 : 1);
      if (ash[k] > 0) ash[k] = Math.max(0, ash[k] - 0.08);
      if (ruin[k] > 0) ruin[k]--;
      // neighbours
      let gN = 0, fN = 0, cN = 0, ln = 0;
      for (let m = 0; m < NBK; m++) { const b = nb[k * NBK + m]; if (b < 0 || kind[b]) continue; gN += grass[b]; fN += forest[b]; cN += crit[b]; ln++; }
      if (ln) { gN /= ln; fN /= ln; cN /= ln; }
      let g = grass[k], f = forest[k], c = crit[k];
      if (fire[k]) {
        burning++;
        fire[k]--; f *= 0.35; g *= 0.5; c *= 0.3;
        for (let m = 0; m < NBK; m++) { const b = nb[k * NBK + m]; if (b < 0 || kind[b] || fire[b] || forest[b] < 0.18) continue; if (R() < 0.5 * forest[b] * (moist[b] < 0.42 ? 1 : 0.15)) fire[b] = 4; }
        if (!fire[k]) { f = 0; g = 0.06; ash[k] = 1; }
      } else {
        g += 0.35 * suit * (1 - g) * Math.min(1, g + gN * 0.6 + 0.02) - 0.18 * (1 - suit) * g;
        if (suit > 0.3 && g > 0.35) f += 0.07 * suit * (1 - f) * Math.min(1, f * 1.6 + fN * 1.4 + (R() < 0.002 ? 0.3 : 0.0));
        if (T < 0.12 || a > 0.072) f -= 0.12;
        if (mo < 0.2) f -= 0.03 * (0.2 - mo) / 0.2 + 0.01;
        f -= 0.02 * f * f; // old forests thin themselves
        if (f > 0.3 && mo < 0.3 && R() < 0.006 * f * (0.3 - mo) / 0.3 * (0.6 + W)) fire[k] = 3;
      }
      // critters: logistic on food, grazing feedback, starvation, diffusion
      const food = 0.7 * g + 0.6 * f;
      const K = food * 0.8;
      c = 0.82 * c + 0.18 * cN;
      if (c > 0) {
        c += 0.4 * c * (1 - c / (K + 0.001));
        if (c > K) c -= 0.45 * (c - K);
        if (T < 0.08) c *= 0.6;
        g -= 0.06 * c * g; f -= 0.006 * c * f;
      }
      if (c < 0.004) c = 0;
      if (c === 0 && food > 0.45 && R() < 0.0015) c = 0.06;
      grass[k] = clamp(g, 0, 1); forest[k] = clamp(f, 0, 1); tmp[k] = clamp(c, 0, 2);
    }
    crit.set(tmp);
    E.burning = burning;
    if (burning > 40 && !E.bigFire) { E.bigFire = true; say("Ein großer Waldbrand wütet. 🔥"); }
    if (burning < 5) E.bigFire = false;

    // towns
    let total = 0;
    for (let i = E.towns.length - 1; i >= 0; i--) {
      const t = E.towns[i], k = t.k, rg = ring(k);
      if (kind[k]) { killTown(t, "ist in den Fluten versunken"); continue; }
      if (fire[k] && t.pop < 90 && R() < 0.6) { killTown(t, "ist abgebrannt"); continue; }
      if (fire[k]) t.pop *= 0.7;
      let foodA = 0; for (const b of rg) if (!kind[b]) foodA += crit[b] * 18 + grass[b] * 9 + forest[b] * 4; else if (kind[b] === 1) foodA += 3; else foodA += 5;
      let trade = 0; for (const r of E.routes) if (r.a === t || r.b === t) trade++;
      const cap = foodA * (1 + 0.25 * trade);
      t.cap = cap;
      t.pop += 0.09 * t.pop * (1 - t.pop / (cap + 1));
      if (t.pop > cap) t.pop -= 0.12 * (t.pop - cap);
      // people hunt, farm, clear forest; big towns over-use their land
      const use = t.pop / rg.length;
      for (const b of rg) { if (kind[b]) continue; crit[b] = Math.max(0, crit[b] - 0.0016 * use); if (forest[b] > 0) { const cl = Math.min(forest[b], 0.0035 * use); forest[b] -= cl; grass[b] = Math.min(1, grass[b] + cl * 0.5); } grass[b] = Math.max(0, grass[b] - 0.0009 * use); }
      if (t.plague > 0) { t.pop *= 0.8; t.plague--; if (!t.plague) { t.immune = 80; say(`Die Pest in ${t.name} ist vorbei.`); } else for (const r of E.routes) { const o = r.a === t ? r.b : r.b === t ? r.a : null; if (o && !o.plague && !o.immune && R() < 0.25) { o.plague = 5; say(`Die Pest erreicht über das Meer ${o.name}.`); } } }
      if (t.immune > 0) t.immune--;
      t.harbor = !!coast[k] && t.pop >= (t.harbor ? 28 : 40);
      if (t.harbor && !t.wasHarbor) { E.routeDirty = true; mile("hafen", `Erster Hafen (${t.name})`); }
      t.wasHarbor = t.harbor;
      if (t.pop >= 150 && !t.big) { t.big = true; say(`${t.name} ist zur Stadt gewachsen.`); mile("stadt", "Erste Stadt"); }
      if (t.pop < 110) t.big = false;
      if (t.pop > cap * 1.15 && t.pop > 60 && !t.hunger) { t.hunger = 1; say(`Hungersnot in ${t.name}.`); } else if (t.pop < cap) t.hunger = 0;
      t.peak = Math.max(t.peak * 0.995, t.pop);
      if (t.pop < 0.3 * t.peak && t.peak > 60 && R() < 0.04) { killTown(t, "ist verlassen worden – das Land gab nichts mehr her"); continue; }
      if (t.pop < 5) { killTown(t, t.plague ? "ist an der Pest zugrunde gegangen" : t.peak > 80 ? "ist verlassen worden – das Land gab nichts mehr her" : "ist verlassen worden"); continue; }
      total += t.pop;
    }
    E.pop = total;
    if (total >= 1000) mile("p1k", "1.000 Einwohner");
    if (total >= 5000) mile("p5k", "5.000 Einwohner");
    if (total >= 10000) mile("p10k", "10.000 Einwohner");
    if (y >= 1000) mile("y1k", "Jahr 1.000");
    if (y >= 10000) mile("y10k", "Jahr 10.000");
    if (E.towns.length >= 10) mile("t10", "Zehn Siedlungen");

    // founding: enough critters on a shore (sea or lake)
    for (let tries = 0; tries < 6; tries++) {
      const k = (R() * n) | 0;
      if (kind[k] || !shore[k] || townAt[k] || fire[k] || ruin[k] > 25 || alt[k] > 0.06) continue;
      let cs = crit[k]; for (let m = 0; m < NBK; m++) { const b = nb[k * NBK + m]; if (b >= 0) cs += crit[b]; }
      if (cs < 2.2) continue;
      let ok = true; for (const t of E.towns) if (dot(t.k, k) > 0.94) { ok = false; break; }
      if (ok && R() < 0.35) { foundTown(k); break; }
    }
    if (E.routeDirty || y % 6 === 0) updateRoutes();

    // milestones from nature
    let fo = 0, cr = 0; for (let k = 0; k < n; k++) { if (forest[k] > 0.5) fo++; cr += crit[k]; }
    E.forestTiles = fo; E.critters = Math.round(cr * 3);
    if (fo > 30) mile("wald", "Erster Wald");
    if (E.critters >= 1000) mile("c1k", "1.000 Tiere");

    // random events
    if (R() < 1 / 420) { const k = randomLand((k) => !townAt[k]); if (k >= 0) { out.push({ t: "volcano", k }); say("Die Erde bebt – ein Vulkan bricht hervor. 🌋"); } }
    if (R() < 1 / 85) {
      const k = (R() * n) | 0; out.push({ t: "storm", k });
      for (const b of ring(k, 0.95)) { moist[b] = Math.min(1.3, moist[b] + 0.6); const tw = townAt[b]; if (tw && coast[b]) tw.pop *= 0.85; }
      const hit = ring(k, 0.95).filter((b) => !kind[b] && forest[b] > 0.3);
      if (hit.length && R() < 0.5) E.ignite(hit[(R() * hit.length) | 0]);
      const near = E.towns.find((t) => dot(t.k, k) > 0.95);
      say(near ? `Ein schwerer Sturm zieht über ${near.name}. ⛈️` : "Ein schwerer Sturm zieht übers Land. ⛈️");
    }
    if (R() < 1 / 160) {
      const c = E.towns.filter((t) => t.pop > 70 && !t.plague && !t.immune);
      if (c.length) { const t = c[(R() * c.length) | 0]; t.plague = 5; say(`Die Pest bricht in ${t.name} aus. ☠️`); }
    }
    return out;
  };

  E.info = function (k) {
    let t = townAt[k];
    if (!t) for (const o of E.towns) if (dot(o.k, k) > 0.997) t = o;
    return { k, kind: kind[k], alt: alt[k], temp: temp[k], moist: moist[k], grass: grass[k], forest: forest[k], crit: crit[k], fire: fire[k], ash: ash[k], town: t,
      routes: t ? E.routes.filter((r) => r.a === t || r.b === t).map((r) => (r.a === t ? r.b : r.a).name) : [] };
  };
  E.reset = function () {
    for (const a of [grass, forest, crit, ash, fire, ruin]) a.fill(0); moist.fill(0.5);
    E.towns = []; E.routes = []; E.log = []; E.ms = []; E.year = 0; E.drift = 0; E.names = new Set(); townAt.fill(null); E.routeDirty = true; E.pop = 0; E.critters = 0; E.died = 0;
  };
  E.townLabel = (t) => (t.pop >= 150 ? (t.harbor ? "Hafenstadt" : "Stadt") : t.harbor ? "Hafendorf" : "Dorf");

  // ---- persistence ----
  const enc = (a) => { const u = a instanceof Uint8Array ? a : new Uint8Array(a.buffer); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const dec = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const q8 = (a, s) => { const u = new Uint8Array(n); for (let k = 0; k < n; k++) u[k] = clamp(Math.round(a[k] * s), 0, 255); return enc(u); };
  const u8 = (str, a, s) => { const u = dec(str); if (u.length === n) for (let k = 0; k < n; k++) a[k] = u[k] / s; };
  E.serialize = () => ({ v: 1, TN, y: E.year, warm: E.warm, rain: E.rain, dr: E.drift, ph: E.ph, ms: E.ms, log: E.log.slice(-60),
    g: q8(grass, 255), f: q8(forest, 255), c: q8(crit, 120), m: q8(moist, 190), a: q8(ash, 255), fi: enc(fire), r: enc(ruin),
    towns: E.towns.map((t) => ({ k: t.k, n: t.name, p: Math.round(t.pop * 10) / 10, b: t.born, pl: t.plague, im: t.immune, big: t.big ? 1 : 0, pk: Math.round(t.peak), h: t.harbor ? 1 : 0 })), names: [...E.names],
    routes: E.routes.map((r) => ({ a: E.towns.indexOf(r.a), b: E.towns.indexOf(r.b), p: r.path })) });
  E.load = function (s) {
    if (!s || s.TN !== TN) return false;
    E.year = s.y || 0; E.warm = s.warm ?? 0.5; E.rain = s.rain ?? 0.5; E.drift = s.dr || 0; if (s.ph) E.ph = s.ph; E.ms = s.ms || []; E.log = s.log || [];
    u8(s.g, grass, 255); u8(s.f, forest, 255); u8(s.c, crit, 120); u8(s.m, moist, 190); u8(s.a, ash, 255);
    const fi = dec(s.fi); if (fi.length === n) fire.set(fi); const r = dec(s.r); if (r.length === n) ruin.set(r);
    E.names = new Set(s.names || []);
    E.towns = []; townAt.fill(null);
    for (const o of s.towns || []) { const t = { k: o.k, name: o.n, pop: o.p, born: o.b, plague: o.pl || 0, immune: o.im || 0, big: !!o.big, peak: o.pk || o.p, harbor: !!o.h }; t.wasHarbor = t.harbor; E.towns.push(t); townAt[t.k] = t; }
    E.routes = []; for (const r of s.routes || []) { const a = E.towns[r.a], b = E.towns[r.b]; if (a && b && Array.isArray(r.p)) E.routes.push({ a, b, path: r.p, u: 0, sp: 1 }); }
    E.routeDirty = true; return true;
  };
  return E;
}
