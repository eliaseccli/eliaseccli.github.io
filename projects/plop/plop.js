/* Plop — merge same letters of the same colour, from A up to a giant Z.
   Custom circle physics (fixed 120 Hz substeps, impulse solver + positional correction, spatial hash),
   tuned for bouncy, squishy, satisfying merges. The screen edges are the container. */
(() => {
"use strict";
const COLS = ["#ff6b6b", "#ffc23d", "#34d399", "#4da3ff", "#b07cff"];
const DARK = ["#c2413f", "#d0901a", "#16a072", "#2571c9", "#7d4dd0"];
const LET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ZL = 25, KEY = "plop.v1";
const canvas = document.getElementById("c"), ctx = canvas.getContext("2d");
const $ = (s) => document.querySelector(s);
const rnd = (a, b) => a + Math.random() * (b - a), clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* ---------- layout: viewport is the box, minus iOS safe areas ---------- */
let W = 0, H = 0, DPR = 1, box = { l: 0, t: 0, r: 0, b: 0 }, rA = 10, G = 1.1;
const rad = (L) => rA * Math.pow(G, L);
function measure() {
  const cs = getComputedStyle($("[data-safe]"));
  const px = (v) => parseFloat(v) || 0;
  W = innerWidth; H = innerHeight; DPR = Math.min(3, devicePixelRatio || 1);
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  box = { l: px(cs.paddingLeft), t: px(cs.paddingTop) + 62, r: W - px(cs.paddingRight), b: H - px(cs.paddingBottom) };
  const bw = box.r - box.l, bh = box.b - box.t;
  // ~240 A's fill 3/4 of the box at hex spacing 2.3 r; a Z spans ~58% of the short side
  rA = Math.sqrt((bw * bh * 0.75) / (240 * 0.866)) / 2.3;
  G = Math.pow((Math.min(bw, bh) * 0.29) / rA, 1 / ZL);
  sprites.clear();
}

/* ---------- bodies (struct of arrays would be faster, but ~400 objects is fine) ---------- */
let B = [], nextId = 1;
function body(x, y, L, c, o = {}) {
  const b = { id: nextId++, x, y, vx: o.vx || 0, vy: o.vy || 0, L, c, r: rad(L), m: 0, ang: o.ang ?? rnd(-0.25, 0.25), av: 0,
    sc: o.sc ?? 1, sv: o.sv || 0, sq: 0, sqv: 0, sqa: 0, born: now, dead: false };
  b.m = b.r * b.r; B.push(b); return b;
}
function resizeBodies(oldBox, oldRA, oldG) {
  const sx = (box.r - box.l) / Math.max(1, oldBox.r - oldBox.l), sy = (box.b - box.t) / Math.max(1, oldBox.b - oldBox.t);
  for (const b of B) { b.x = box.l + (b.x - oldBox.l) * sx; b.y = box.t + (b.y - oldBox.t) * sy; b.r = rad(b.L); b.m = b.r * b.r; }
}

/* ---------- spatial hash ---------- */
let cell = 20, gw = 1, gh = 1, heads = new Int32Array(1), nexts = new Int32Array(1), owner = new Int32Array(1), mark = new Int32Array(1);
let ecount = 0;
function buildGrid() {
  cell = Math.max(8, rA * 2.6); gw = Math.ceil(W / cell) + 2; gh = Math.ceil(H / cell) + 2;
  if (heads.length < gw * gh) heads = new Int32Array(gw * gh);
  heads.fill(-1); ecount = 0;
  let need = 0; for (const b of B) need += (Math.ceil((2 * b.r) / cell) + 1) ** 2;
  if (nexts.length < need) { nexts = new Int32Array(need * 2); owner = new Int32Array(need * 2); }
  if (mark.length < B.length) mark = new Int32Array(B.length * 2);
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    const x0 = clamp(Math.floor((b.x - b.r) / cell) + 1, 0, gw - 1), x1 = clamp(Math.floor((b.x + b.r) / cell) + 1, 0, gw - 1);
    const y0 = clamp(Math.floor((b.y - b.r) / cell) + 1, 0, gh - 1), y1 = clamp(Math.floor((b.y + b.r) / cell) + 1, 0, gh - 1);
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) { const h = gy * gw + gx; owner[ecount] = i; nexts[ecount] = heads[h]; heads[h] = ecount++; }
  }
}

/* ---------- physics ---------- */
const GRAV = 2600, REST = 0.42, WREST = 0.5, STEP = 1 / 120;
let gravOn = 0, now = 0, merges = [], best = 0, total = 0, won = false, dropT = 0;
function solvePairs(first) {
  buildGrid(); mark.fill(-1, 0, B.length);
  for (let i = 0; i < B.length; i++) {
    const a = B[i]; if (a.dead) continue;
    const x0 = clamp(Math.floor((a.x - a.r) / cell) + 1, 0, gw - 1), x1 = clamp(Math.floor((a.x + a.r) / cell) + 1, 0, gw - 1);
    const y0 = clamp(Math.floor((a.y - a.r) / cell) + 1, 0, gh - 1), y1 = clamp(Math.floor((a.y + a.r) / cell) + 1, 0, gh - 1);
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      for (let e = heads[gy * gw + gx]; e >= 0; e = nexts[e]) {
        const j = owner[e]; if (j <= i || mark[j] === i) continue; mark[j] = i;
        const b = B[j]; if (b.dead) continue;
        let dx = b.x - a.x, dy = b.y - a.y; const rr = a.r + b.r, d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 === 0) {
          // same letter + colour just kissing: plop
          if (first && a.L === b.L && a.c === b.c && a.L < ZL && d2 < (rr + 1.5) ** 2 && gravOn > 0.2) merges.push([a, b]);
          continue;
        }
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, pen = rr - d;
        if (first && a.L === b.L && a.c === b.c && a.L < ZL && gravOn > 0.2) merges.push([a, b]);
        const ia = 1 / a.m, ib = 1 / b.m, wa = a.held ? 0 : ia, wb = b.held ? 0 : ib, ws = wa + wb || 1;
        const corr = Math.max(0, pen - 0.3) * 0.8 / ws;
        a.x -= nx * corr * wa; a.y -= ny * corr * wa; b.x += nx * corr * wb; b.y += ny * corr * wb;
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy, vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const e = vn < -120 ? REST : 0.02; // bouncy on real hits, calm when resting in a pile
          const j = (-(1 + e) * vn) / ws;
          a.vx -= nx * j * wa; a.vy -= ny * j * wa; b.vx += nx * j * wb; b.vy += ny * j * wb;
          // friction + spin from the tangential slip
          const tx = -ny, ty = nx, vt = rvx * tx + rvy * ty + a.av * a.r + b.av * b.r;
          const jt = clamp(-vt / ws * 0.18, -j * 0.4, j * 0.4);
          a.vx -= tx * jt * wa; a.vy -= ty * jt * wa; b.vx += tx * jt * wb; b.vy += ty * jt * wb;
          a.av += jt * wa / a.r * 0.6; b.av += jt * wb / b.r * 0.6;
          if (-vn > 160) { squish(a, nx, ny, -vn); squish(b, nx, ny, -vn); if (-vn > 700) tick(Math.min(a.L, b.L), -vn); }
        }
      }
    }
  }
}
function squish(b, nx, ny, v) {
  const s = clamp(v / 2600, 0, 0.32) / (1 + b.L * 0.04);
  if (s > Math.abs(b.sq)) { b.sq = s; b.sqa = Math.atan2(ny, nx); }
}
function walls(b) {
  const k = 1;
  if (b.y + b.r > box.b) { b.y = box.b - b.r; if (b.vy > 0) { if (b.vy > 160) squish(b, 0, 1, b.vy); b.vy = b.vy > 120 ? -b.vy * WREST : 0; b.vx *= 0.985; b.av = lerp(b.av, b.vx / b.r, 0.2); } }
  if (b.y - b.r < box.t) { b.y = box.t + b.r; if (b.vy < 0) { if (b.vy < -160) squish(b, 0, 1, -b.vy); b.vy = -b.vy * WREST; } }
  if (b.x - b.r < box.l) { b.x = box.l + b.r; if (b.vx < 0) { if (b.vx < -160) squish(b, 1, 0, -b.vx); b.vx = -b.vx * WREST * k; } }
  if (b.x + b.r > box.r) { b.x = box.r - b.r; if (b.vx > 0) { if (b.vx > 160) squish(b, 1, 0, b.vx); b.vx = -b.vx * WREST * k; } }
}
const lerp = (a, b, t) => a + (b - a) * t;
function step(dt) {
  now += dt;
  gravOn = Math.min(1, gravOn + dt / 0.5 * (now > 1.1 ? 1 : 0));
  const g = GRAV * gravOn * gravOn;
  for (const b of B) {
    if (b.held) {
      const tx = clamp(drag.x, box.l + b.r, box.r - b.r), ty = clamp(drag.y, box.t + b.r, box.b - b.r);
      // stiff, slightly underdamped spring to the finger: feels like holding a jelly
      const kx = (tx - b.x) * 22, ky = (ty - b.y) * 22, lim = 3200;
      b.vx = lerp(b.vx, clamp(kx, -lim, lim), 0.32); b.vy = lerp(b.vy, clamp(ky, -lim, lim), 0.32);
    } else { b.vy += g * dt; if (gravOn < 1) { b.vx += Math.sin(now * 1.7 + b.id) * 6 * dt; b.vy += Math.cos(now * 1.3 + b.id * 1.7) * 6 * dt; } }
    b.vx *= 0.9993; b.vy *= 0.9993; b.av *= 0.985;
    b.x += b.vx * dt; b.y += b.vy * dt; b.ang += b.av * dt;
    // springs: pop scale and squash wobble
    b.sv += (-(b.sc - 1) * 420 - b.sv * 13) * dt; b.sc += b.sv * dt;
    b.sqv += (-b.sq * 620 - b.sqv * 16) * dt; b.sq += b.sqv * dt;
  }
  merges.length = 0;
  for (let it = 0; it < 4; it++) { solvePairs(it === 0); for (const b of B) walls(b); }
  doMerges();
  if (B.some((b) => b.dead)) B = B.filter((b) => !b.dead);
  dropT -= dt; if (gravOn >= 1 && dropT <= 0) { dropT = 0.9; maybeDrop(); }
}

/* ---------- merging + juice ---------- */
let combo = 0, comboT = 0, plops = 0;
function doMerges() {
  for (const [a, b] of merges) {
    if (a.dead || b.dead) continue;
    a.dead = b.dead = true;
    const L = a.L + 1, m = a.m + b.m;
    const x = (a.x * a.m + b.x * b.m) / m, y = (a.y * a.m + b.y * b.m) / m;
    const n = body(x, y, L, a.c, { vx: (a.vx * a.m + b.vx * b.m) / m, vy: (a.vy * a.m + b.vy * b.m) / m - 160, sc: 0.62, sv: 9, ang: (a.ang + b.ang) / 2 });
    n.av = (a.av + b.av) / 2 + rnd(-3, 3);
    if (a.held || b.held) { n.held = true; drag.b = n; }
    n.sq = 0.22; n.sqa = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2; // squash across the line of the two parents
    // shockwave: shove neighbours outward so the pile bounces
    const R = n.r * 3.2;
    for (const o of B) {
      if (o === n || o.dead) continue;
      const dx = o.x - x, dy = o.y - y, d = Math.hypot(dx, dy);
      if (d < R && d > 0.01) { const f = (1 - d / R) * (240 + 26 * L) * Math.min(1.6, n.m / o.m) ** 0.25; o.vx += (dx / d) * f; o.vy += (dy / d) * f - f * 0.25; squish(o, dx / d, dy / d, f * 2.2); }
    }
    // chain = the fresh letter plops again right away (A+A -> B, B+B -> C ...)
    const fresh2 = (q) => now - q.born < 0.9 ? q.chain || 1 : 0;
    n.chain = Math.max(fresh2(a), fresh2(b)) + 1; combo = n.chain;
    plops++; total++;
    burst(x, y, n.r, a.c, L);
    ring(x, y, n.r, a.c);
    plop(L, combo, merges.length);
    if (combo >= 2 && now - comboT > 0.25) { comboT = now; floater(x, y - n.r, combo >= 4 ? `${combo}× chain!!` : `${combo}× chain`, a.c, 1 + Math.min(0.6, combo * 0.1)); }
    if (L > best) { best = L; showBest(true); if (L >= 6) floater(x, y - n.r * 1.2, `new best: ${LET[L]}!`, a.c, 1.4); }
    if (L === ZL && !won) { won = true; setTimeout(win, 700); }
  }
}
// keep the screen ~3/4 full: drop fresh letters from the ceiling, tiers trailing your best so Z stays reachable
function maybeDrop() {
  const area = (box.r - box.l) * (box.b - box.t);
  let used = 0; for (const b of B) used += Math.PI * b.r * b.r;
  if (used / area > 0.6) return;
  const hi = Math.max(0, best - 2), lo = Math.max(0, best - 6);
  const L = Math.min(ZL - 1, lo + Math.floor(Math.pow(Math.random(), 1.8) * (hi - lo + 1)));
  const r = rad(L), x = rnd(box.l + r, box.r - r), y = box.t + r + 2;
  for (const o of B) if (Math.hypot(o.x - x, o.y - y) < o.r + r) return;
  body(x, y, L, (Math.random() * 5) | 0, { vy: 200, sc: 0.3, sv: 6 });
  if (used / area < 0.4) dropT = 0.22; else if (used / area < 0.5) dropT = 0.45;
}

/* ---------- fresh game: a floating lattice of A's filling the lower 3/4 ---------- */
function fresh() {
  B = []; best = 0; total = 0; won = false; now = 0; gravOn = 0; combo = 0;
  const s = rA * 2.3, top = box.t + (box.b - box.t) * 0.25;
  let row = 0;
  for (let y = box.b - rA - 2; y > top; y -= s * 0.866, row++) {
    for (let x = box.l + rA + 2 + (row % 2 ? s / 2 : 0); x < box.r - rA - 1; x += s) {
      body(x + rnd(-1.2, 1.2), y + rnd(-1.2, 1.2), 0, (Math.random() * 5) | 0, { sc: 0, sv: rnd(4, 9) });
    }
  }
  showBest(); $("[data-win]").hidden = true; save();
}

/* ---------- particles, rings, floaters ---------- */
const P = [], RINGS = [], FL = [];
function burst(x, y, r, c, L) {
  const n = Math.min(40, 12 + L * 2);
  for (let i = 0; i < n; i++) {
    const a = rnd(0, Math.PI * 2), v = rnd(180, 520) * (1 + L * 0.05);
    P.push({ x: x + Math.cos(a) * r * 0.6, y: y + Math.sin(a) * r * 0.6, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120, r: rnd(2, 4.5) * (1 + L * 0.04), t: 0, life: rnd(0.35, 0.7), c: Math.random() < 0.25 ? "#fff" : COLS[c] });
  }
  if (P.length > 700) P.splice(0, P.length - 700);
}
function ring(x, y, r, c) { RINGS.push({ x, y, r, t: 0, c }); }
function floater(x, y, text, c, big = 1) { FL.push({ x, y, text, c, t: 0, big }); }

/* ---------- sound + haptics ---------- */
let AC = null, master = null, muted = localStorage.getItem("plop.mute") === "1", lastSnd = 0, lastTick = 0, lastVib = 0;
function audio() {
  if (AC || muted) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain(); master.gain.value = 0.55;
    const comp = AC.createDynamicsCompressor(); master.connect(comp); comp.connect(AC.destination);
  } catch (e) { AC = null; }
}
function plop(L, combo, many) {
  const t0 = performance.now();
  if (navigator.vibrate && t0 - lastVib > 70) { lastVib = t0; try { navigator.vibrate(L > 8 ? [14, 30, 10] : 8 + L); } catch (e) {} }
  if (!AC || muted || t0 - lastSnd < 28) return; lastSnd = t0;
  const t = AC.currentTime, semi = Math.min(12, combo - 1);
  const f0 = 980 * Math.pow(0.9, L) * Math.pow(2, semi / 12);
  // the "plop": a sine whose pitch falls fast, like a bubble popping, + a soft click
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(f0 * 1.6, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.09 + L * 0.006);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.55, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16 + L * 0.012);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.4 + L * 0.02);
  const o2 = AC.createOscillator(), g2 = AC.createGain(); // bubbly overtone
  o2.type = "triangle"; o2.frequency.setValueAtTime(f0 * 3.1, t); o2.frequency.exponentialRampToValueAtTime(f0 * 1.2, t + 0.05);
  g2.gain.setValueAtTime(0.18, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  o2.connect(g2); g2.connect(master); o2.start(t); o2.stop(t + 0.1);
  if (L >= 6) { // big letters get a body thump
    const o3 = AC.createOscillator(), g3 = AC.createGain();
    o3.frequency.setValueAtTime(140 * Math.pow(0.95, L - 6), t); o3.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    g3.gain.setValueAtTime(0.5, t); g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o3.connect(g3); g3.connect(master); o3.start(t); o3.stop(t + 0.4);
  }
}
function tick(L, v) {
  const t0 = performance.now(); if (!AC || muted || t0 - lastTick < 45) return; lastTick = t0;
  const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(1500 * Math.pow(0.92, L), t); o.frequency.exponentialRampToValueAtTime(500 * Math.pow(0.92, L), t + 0.03);
  g.gain.setValueAtTime(Math.min(0.12, v / 12000), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.06);
}

/* ---------- sprites ---------- */
const sprites = new Map();
function sprite(L, c) {
  const k = L * 8 + c; let s = sprites.get(k); if (s) return s;
  const r = rad(L), pad = 3, size = Math.ceil((r * 2 + pad * 2) * DPR);
  const cv = document.createElement("canvas"); cv.width = cv.height = size; const g = cv.getContext("2d");
  g.scale(DPR, DPR); const cx = r + pad;
  const grd = g.createRadialGradient(cx - r * 0.35, cx - r * 0.45, r * 0.1, cx, cx, r);
  grd.addColorStop(0, lighten(COLS[c], 0.35)); grd.addColorStop(0.65, COLS[c]); grd.addColorStop(1, DARK[c]);
  g.beginPath(); g.arc(cx, cx, r, 0, Math.PI * 2); g.fillStyle = grd; g.fill();
  g.beginPath(); g.ellipse(cx - r * 0.3, cx - r * 0.42, r * 0.38, r * 0.2, -0.5, 0, Math.PI * 2); g.fillStyle = "rgba(255,255,255,.28)"; g.fill();
  g.font = `900 ${r * 1.28}px ui-rounded, "SF Pro Rounded", "Nunito", "Arial Rounded MT Bold", system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "rgba(0,0,0,.18)"; g.fillText(LET[L], cx, cx + r * 0.1);
  g.fillStyle = "#fff"; g.fillText(LET[L], cx, cx + r * 0.06);
  s = { cv, half: cx }; sprites.set(k, s); return s;
}
function lighten(hex, t) { const n = parseInt(hex.slice(1), 16); const f = (v) => Math.round(v + (255 - v) * t); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; }

/* ---------- render ---------- */
function render(dt) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = "#14131f"; ctx.fillRect(0, 0, W, H);
  for (const b of B) {
    const s = sprite(b.L, b.c), sc = Math.max(0.01, b.sc);
    ctx.save(); ctx.translate(b.x, b.y);
    if (Math.abs(b.sq) > 0.002) { ctx.rotate(b.sqa); ctx.scale(1 - b.sq, 1 + b.sq * 0.85); ctx.rotate(-b.sqa); }
    ctx.rotate(b.ang); ctx.scale(sc, sc);
    ctx.drawImage(s.cv, -s.half, -s.half, s.cv.width / DPR, s.cv.height / DPR);
    ctx.restore();
  }
  for (let i = RINGS.length - 1; i >= 0; i--) {
    const q = RINGS[i]; q.t += dt; const k = q.t / 0.45; if (k >= 1) { RINGS.splice(i, 1); continue; }
    ctx.beginPath(); ctx.arc(q.x, q.y, q.r * (1 + k * 1.8), 0, Math.PI * 2);
    ctx.strokeStyle = COLS[q.c]; ctx.globalAlpha = (1 - k) * 0.7; ctx.lineWidth = 3 + (1 - k) * 5; ctx.stroke(); ctx.globalAlpha = 1;
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i]; p.t += dt; if (p.t >= p.life) { P.splice(i, 1); continue; }
    p.vx *= 0.96; p.vy = p.vy * 0.96 + 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    const k = 1 - p.t / p.life; ctx.globalAlpha = k; ctx.fillStyle = p.c;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.4 + k * 0.6), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = FL.length - 1; i >= 0; i--) {
    const f = FL[i]; f.t += dt; if (f.t > 1.1) { FL.splice(i, 1); continue; }
    const k = f.t / 1.1, s = 1 + 0.5 * Math.exp(-f.t * 9) * Math.sin(f.t * 30);
    ctx.globalAlpha = 1 - k * k; ctx.font = `900 ${18 * f.big * s}px ui-rounded, system-ui, sans-serif`;
    ctx.fillStyle = "#fff"; ctx.strokeStyle = DARK[f.c]; ctx.lineWidth = 4; ctx.strokeText(f.text, f.x, f.y - k * 50); ctx.fillText(f.text, f.x, f.y - k * 50);
  }
  ctx.globalAlpha = 1;
}

/* ---------- input: grab a letter with a spring ---------- */
const drag = { b: null, x: 0, y: 0, id: -1 };
canvas.addEventListener("pointerdown", (e) => {
  audio(); if (AC && AC.state === "suspended") AC.resume();
  if (drag.b) return;
  let pick = null, pd = 1e9;
  for (const b of B) { const d = Math.hypot(b.x - e.clientX, b.y - e.clientY); if (d < b.r + 14 && d - b.r < pd) { pd = d - b.r; pick = b; } }
  if (!pick) return;
  canvas.setPointerCapture?.(e.pointerId);
  drag.b = pick; drag.id = e.pointerId; drag.x = e.clientX; drag.y = e.clientY; pick.held = true;
  pick.sc = 1.12; pick.sv = 2; tick(pick.L, 3000);
});
canvas.addEventListener("pointermove", (e) => { if (e.pointerId === drag.id) { drag.x = e.clientX; drag.y = e.clientY; } });
const release = (e) => { if (e.pointerId !== drag.id) return; if (drag.b) drag.b.held = false; for (const b of B) b.held = false; drag.b = null; drag.id = -1; };
canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release);
document.addEventListener("gesturestart", (e) => e.preventDefault());

/* ---------- HUD ---------- */
function showBest(bump) {
  const el = $("[data-best] b"); el.textContent = LET[best]; el.style.color = "#fff";
  if (bump) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); setTimeout(() => el.classList.remove("bump"), 300); }
}
const sndBtn = $("[data-sound]");
const setSnd = () => { sndBtn.textContent = muted ? "🔇" : "🔊"; };
setSnd();
sndBtn.addEventListener("click", () => { muted = !muted; localStorage.setItem("plop.mute", muted ? "1" : "0"); setSnd(); audio(); if (AC) AC.resume(); });
$("[data-reset]").addEventListener("click", () => { fresh(); });
$("[data-again]").addEventListener("click", () => { fresh(); });
$("[data-keep]").addEventListener("click", () => { $("[data-win]").hidden = true; });
function win() {
  $("[data-win]").hidden = false;
  for (let i = 0; i < 6; i++) setTimeout(() => { const x = rnd(W * 0.2, W * 0.8), y = rnd(H * 0.2, H * 0.6), c = (Math.random() * 5) | 0; burst(x, y, 30, c, 20); ring(x, y, 40, c); plop(3 + i, i + 1); }, i * 160);
}

/* ---------- save ---------- */
function save() {
  try {
    const bw = box.r - box.l, bh = box.b - box.t;
    localStorage.setItem(KEY, JSON.stringify({ v: 1, best, total, won, b: B.map((b) => [+((b.x - box.l) / bw).toFixed(4), +((b.y - box.t) / bh).toFixed(4), b.L, b.c]) }));
  } catch (e) {}
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!s || s.v !== 1 || !Array.isArray(s.b) || !s.b.length) return false;
    const bw = box.r - box.l, bh = box.b - box.t;
    B = []; for (const [x, y, L, c] of s.b) body(box.l + x * bw, box.t + y * bh, clamp(L | 0, 0, ZL), clamp(c | 0, 0, 4));
    best = s.best | 0; total = s.total | 0; won = !!s.won; now = 2; gravOn = 1; showBest(); return true;
  } catch (e) { return false; }
}
setInterval(save, 2000);
addEventListener("visibilitychange", () => { if (document.hidden) save(); });
addEventListener("pagehide", save);

/* ---------- boot + loop ---------- */
measure();
if (!load()) fresh();
let resizeT = 0;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { const ob = box, oa = rA, og = G; measure(); resizeBodies(ob, oa, og); }, 60); });
let prev = performance.now(), acc = 0, fpsAvg = 60, frames = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - prev) / 1000); prev = t; frames++;
  if (dt > 0) fpsAvg = lerp(fpsAvg, 1 / Math.max(dt, 0.001), 0.05);
  acc += dt; let n = 0;
  while (acc >= STEP && n < 4) { step(STEP); acc -= STEP; n++; }
  if (n === 4) acc = 0;
  render(dt);
}
requestAnimationFrame(frame);
window.__plop = { stats: () => ({ n: B.length, best, total, fps: Math.round(fpsAvg), frames, outside: B.filter((b) => b.x < box.l - 1 || b.x > box.r + 1 || b.y < box.t - 1 || b.y > box.b + 1).length, maxPen: maxPen() }), get B() { return B; }, box: () => box, rad, fresh, save };
function maxPen() { let m = 0; for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) { const a = B[i], b = B[j]; const p = a.r + b.r - Math.hypot(a.x - b.x, a.y - b.y); if (p > m) m = p; } return +m.toFixed(2); }
})();
