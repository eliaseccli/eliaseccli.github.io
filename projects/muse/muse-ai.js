/* Muse "describe it", fully on-device:
   1) instant keyword parser -> genome change (always available, also the fallback),
   2) a local code model (WebLLM + Qwen2.5-Coder-1.5B, WebGPU, in a Web Worker) that writes a whole SVG artwork. */
import { sanitize, valid } from "./muse-svg.js?v=1";
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const FAMS = ["flow", "bauhaus", "blobs", "voronoi", "contour", "circles", "landscape", "stripes", "waves", "truchet", "sunset", "orbits"];

/* ---------- 1. keyword parser ---------- */
const HUES = { red: 0, rot: 0, crimson: 350, orange: 25, gold: 45, golden: 45, gelb: 55, yellow: 55, lime: 90, green: 125, grün: 125, gruen: 125, mint: 155, teal: 175, türkis: 175, tuerkis: 175, turquoise: 175, cyan: 190, blue: 220, blau: 220, navy: 230, indigo: 250, purple: 275, lila: 275, violet: 275, violett: 275, magenta: 305, pink: 325, rosa: 325, brown: 28, braun: 28 };
const FAMW = { flow: "flow", fließend: "flow", fliessend: "flow", strömung: "flow", hair: "flow", haare: "flow", geometric: "bauhaus", geometrisch: "bauhaus", bauhaus: "bauhaus", squares: "bauhaus", quadrate: "bauhaus", tiles: "truchet", kacheln: "truchet", maze: "truchet", labyrinth: "truchet", blobs: "blobs", blob: "blobs", gradient: "blobs", verlauf: "blobs", nebel: "blobs", fog: "blobs", cells: "voronoi", zellen: "voronoi", mosaic: "voronoi", mosaik: "voronoi", voronoi: "voronoi", crystal: "voronoi", kristall: "voronoi", contour: "contour", contours: "contour", topo: "contour", topographic: "contour", höhenlinien: "contour", map: "contour", karte: "contour", circles: "circles", kreise: "circles", bubbles: "circles", blasen: "circles", dots: "circles", punkte: "circles", landscape: "landscape", landschaft: "landscape", mountains: "landscape", berge: "landscape", hills: "landscape", hügel: "landscape", stripes: "stripes", streifen: "stripes", lines: "waves", linien: "waves", waves: "waves", wellen: "waves", wave: "waves", welle: "waves", ocean: "waves", meer: "waves", sunset: "sunset", sonnenuntergang: "sunset", sun: "sunset", sonne: "sunset", sunrise: "sunset", orbits: "orbits", orbit: "orbits", planets: "orbits", planeten: "orbits", space: "orbits", weltall: "orbits", rings: "orbits", ringe: "orbits", organic: "flow", organisch: "flow" };
// each knob: [field, delta]; fields: hue*, sat, lum, spread, dark, scheme, density(p0), size(p1), grain, contrast
const KNOBS = {
  warm: [["hueTo", 25]], warmer: [["hueTo", 25]], cool: [["hueTo", 210]], cold: [["hueTo", 210]], kalt: [["hueTo", 210]], kühl: [["hueTo", 210]], kuehl: [["hueTo", 210]],
  pastel: [["sat", -0.35], ["lum", 0.35], ["dark", 0]], pastell: [["sat", -0.35], ["lum", 0.35], ["dark", 0]],
  neon: [["sat", 0.5], ["dark", 1], ["lum", 0.1]], vivid: [["sat", 0.35]], kräftig: [["sat", 0.35]], kraeftig: [["sat", 0.35]], bold: [["sat", 0.3], ["size", 0.25]], mutig: [["sat", 0.3], ["size", 0.25]],
  monochrome: [["scheme", 3], ["spread", -1]], monochrom: [["scheme", 3], ["spread", -1]], einfarbig: [["scheme", 3], ["spread", -1]],
  colorful: [["scheme", 2], ["spread", 0.6], ["sat", 0.3]], colourful: [["scheme", 2], ["spread", 0.6], ["sat", 0.3]], bunt: [["scheme", 2], ["spread", 0.6], ["sat", 0.3]], farbig: [["spread", 0.4]],
  dark: [["dark", 1], ["lum", -0.3]], dunkel: [["dark", 1], ["lum", -0.3]], night: [["dark", 1], ["lum", -0.3]], nacht: [["dark", 1], ["lum", -0.3]],
  bright: [["dark", 0], ["lum", 0.3]], hell: [["dark", 0], ["lum", 0.3]], light: [["dark", 0], ["lum", 0.3]], licht: [["dark", 0], ["lum", 0.3]],
  grey: [["sat", -0.8]], gray: [["sat", -0.8]], grau: [["sat", -0.8]], muted: [["sat", -0.35]], gedämpft: [["sat", -0.35]], blass: [["sat", -0.35]],
  minimal: [["density", -0.45], ["grain", -0.2]], minimalistisch: [["density", -0.45], ["grain", -0.2]], simple: [["density", -0.4]], einfach: [["density", -0.4]], clean: [["density", -0.3], ["grain", -0.4]], sauber: [["density", -0.3], ["grain", -0.4]],
  busy: [["density", 0.45]], dense: [["density", 0.45]], dicht: [["density", 0.45]], detailed: [["density", 0.4]], detailliert: [["density", 0.4]], complex: [["density", 0.4]], komplex: [["density", 0.4]], voll: [["density", 0.4]],
  calm: [["density", -0.25], ["spread", -0.25], ["sat", -0.15]], ruhig: [["density", -0.25], ["spread", -0.25], ["sat", -0.15]], peaceful: [["density", -0.25], ["spread", -0.25]], friedlich: [["density", -0.25], ["spread", -0.25]],
  chaotic: [["density", 0.4], ["spread", 0.4], ["chaos", 0.5]], chaotisch: [["density", 0.4], ["spread", 0.4], ["chaos", 0.5]], wild: [["density", 0.35], ["chaos", 0.5], ["sat", 0.2]],
  soft: [["sat", -0.2], ["grain", -0.2], ["contrast", -0.3]], sanft: [["sat", -0.2], ["grain", -0.2], ["contrast", -0.3]], weich: [["sat", -0.2], ["grain", -0.2], ["contrast", -0.3]], gentle: [["sat", -0.2], ["contrast", -0.25]], dreamy: [["sat", -0.2], ["contrast", -0.3]], verträumt: [["sat", -0.2], ["contrast", -0.3]],
  cozy: [["hueTo", 28], ["grain", 0.3], ["dark", 1], ["sat", -0.1]], cosy: [["hueTo", 28], ["grain", 0.3], ["dark", 1]], gemütlich: [["hueTo", 28], ["grain", 0.3], ["dark", 1]], gemuetlich: [["hueTo", 28], ["grain", 0.3], ["dark", 1]],
  happy: [["dark", 0], ["sat", 0.3], ["hueTo", 50]], fröhlich: [["dark", 0], ["sat", 0.3], ["hueTo", 50]], sad: [["dark", 1], ["sat", -0.3], ["hueTo", 220]], traurig: [["dark", 1], ["sat", -0.3], ["hueTo", 220]],
  moody: [["dark", 1], ["sat", -0.15], ["contrast", 0.2]], düster: [["dark", 1], ["lum", -0.3]], fire: [["hueTo", 15], ["sat", 0.4]], feuer: [["hueTo", 15], ["sat", 0.4]], forest: [["hueTo", 130], ["sat", -0.1]], wald: [["hueTo", 130], ["sat", -0.1]],
  texture: [["grain", 0.35]], textur: [["grain", 0.35]], grainy: [["grain", 0.4]], körnig: [["grain", 0.4]], koernig: [["grain", 0.4]], grain: [["grain", 0.35]], vintage: [["grain", 0.4], ["sat", -0.2]], retro: [["grain", 0.3], ["sat", -0.15], ["hueTo", 30]],
  smooth: [["grain", -0.6]], glatt: [["grain", -0.6]], contrast: [["contrast", 0.35]], kontrast: [["contrast", 0.35]],
  big: [["size", 0.3]], bigger: [["size", 0.3]], large: [["size", 0.3]], larger: [["size", 0.3]], huge: [["size", 0.5]], groß: [["size", 0.3]], gross: [["size", 0.3]], größer: [["size", 0.3]], groesser: [["size", 0.3]], riesig: [["size", 0.5]],
  small: [["size", -0.3]], smaller: [["size", -0.3]], tiny: [["size", -0.5]], klein: [["size", -0.3]], kleiner: [["size", -0.3]], winzig: [["size", -0.5]],
  random: [["chaos", 1]], zufällig: [["chaos", 1]], different: [["chaos", 0.7]], anders: [["chaos", 0.7]], new: [["chaos", 1]], neu: [["chaos", 1]],
};
const NEG = new Set(["no", "not", "without", "kein", "keine", "keinen", "keiner", "nicht", "ohne", "less", "weniger", "fewer", "minus"]);
const BOOST = { very: 1.6, much: 1.6, sehr: 1.6, viel: 1.6, super: 1.8, extremely: 2, extrem: 2, mega: 1.8, really: 1.4, more: 1.2, mehr: 1.2, slightly: 0.5, bit: 0.5, bisschen: 0.5, etwas: 0.5, little: 0.5, leicht: 0.5, wenig: 0.5 };
const stem = (w) => w.replace(/(er|en|e|s)$/i, "");

export function parse(text) {
  const words = text.toLowerCase().normalize("NFC").replace(/[^\p{L}\s-]/gu, " ").split(/[\s-]+/).filter(Boolean);
  const out = { fam: null, avoidFam: [], hue: null, avoidHue: [], d: {}, chips: [] };
  let neg = false, k = 1, negAge = 0;
  const add = (f, v) => { out.d[f] = (out.d[f] || 0) + v; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (NEG.has(w)) { neg = true; negAge = 0; continue; }
    if (BOOST[w]) { k *= BOOST[w]; continue; }
    const hk = HUES[w] != null ? w : HUES[stem(w)] != null ? stem(w) : null;
    const fk = FAMW[w] ? w : FAMW[stem(w)] ? stem(w) : null;
    const kk = KNOBS[w] ? w : KNOBS[stem(w)] ? stem(w) : null;
    if (hk) { if (neg) { out.avoidHue.push(HUES[hk]); out.chips.push("no " + hk); } else { out.hue = HUES[hk]; if (hk === "brown" || hk === "braun") add("sat", -0.3); out.chips.push(hk); } }
    else if (kk) { for (const [f, v] of KNOBS[kk]) { if (f === "hueTo") { if (!neg) out.hue = v; else out.avoidHue.push(v); } else if (f === "dark" || f === "scheme") { out.d[f] = neg ? (f === "dark" ? 1 - v : null) : v; } else add(f, (neg ? -1 : 1) * v * k); } out.chips.push((neg ? "less " : "") + kk + (k > 1.3 ? "+" : k < 0.8 ? "·" : "")); }
    else if (fk) { if (neg) { out.avoidFam.push(FAMW[fk]); out.chips.push("no " + fk); } else { out.fam = FAMW[fk]; out.chips.push(fk); } }
    else { if (++negAge > 1) neg = false; continue; } // unknown word: ignore (a negation survives one filler word: "no more red")
    neg = false; k = 1;
  }
  return out;
}

/* apply a parsed/LLM intent to a genome. mutate() is passed in so variation matches the app */
export function apply(g0, it, mutate) {
  let g = mutate(g0, it.d.chaos ? 0.1 + it.d.chaos * 0.3 : 0.03);
  if (it.fam && it.fam !== g.fam) { g.fam = it.fam; g.seed = (Math.random() * 1e9) | 0; }
  else if (it.avoidFam.includes(g.fam)) { const ok = FAMS.filter((f) => !it.avoidFam.includes(f)); g.fam = ok[(Math.random() * ok.length) | 0]; }
  if (it.hue != null) g.hue = (it.hue + (Math.random() - 0.5) * 16 + 360) % 360;
  for (const a of it.avoidHue) { const dh = Math.abs((((g.hue - a) % 360) + 540) % 360 - 180); if (dh < 50) g.hue = (a + 130 + Math.random() * 100) % 360; if (g.scheme !== 3) g.spread = Math.min(g.spread, 0.3); }
  const d = it.d;
  if (d.sat) g.sat = clamp(g.sat + d.sat, 0.05, 1);
  if (d.lum) g.lum = clamp(g.lum + d.lum, 0, 1);
  if (d.spread) g.spread = clamp(g.spread + d.spread, 0, 1);
  if (d.dark != null) g.bgDark = d.dark ? 1 : 0;
  if (d.scheme != null) g.scheme = d.scheme;
  if (d.density) g.p[0] = clamp(g.p[0] + d.density, 0, 1);
  if (d.size) g.p[1] = clamp(g.p[1] + d.size, 0, 1);
  if (d.grain) g.grain = clamp(g.grain + d.grain, 0, 0.9);
  if (d.contrast) { g.sat = clamp(g.sat + d.contrast * 0.5, 0.05, 1); g.lum = clamp(g.bgDark ? g.lum - d.contrast * 0.4 : g.lum + d.contrast * 0.4, 0, 1); g.p[7] = clamp(g.p[7] + d.contrast * 0.5, 0, 1); }
  return g;
}

/* ---------- 2. local LLM: writes SVG art ---------- */
const LIB = "./vendor/web-llm-0.2.87.js";
const OLD = ["Qwen2.5-0.5B-Instruct-q4f16_1-MLC", "Qwen2.5-0.5B-Instruct-q4f32_1-MLC"]; // the previous small model: removed once the new one is in
let engine = null, loading = null, lib = null;
export const ai = { state: "idle", progress: 0, error: "", model: "", sizeMB: 0 };
export const hasGPU = () => !!(navigator.gpu);
export function load(onProgress) {
  if (loading) return loading;
  if (!hasGPU()) { ai.state = "unsupported"; return (loading = Promise.resolve(null)); }
  ai.state = "loading"; ai.progress = 0;
  loading = (async () => {
    const adapter = await navigator.gpu.requestAdapter(); if (!adapter) { ai.state = "unsupported"; return null; }
    const f16 = adapter.features.has("shader-f16");
    const id = f16 ? "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC" : "Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC"; ai.model = id;
    lib = await import(LIB);
    const opts = { initProgressCallback: (r) => { ai.progress = r.progress || 0; onProgress && onProgress(ai.progress, r.text || ""); } };
    try { // a worker keeps the page (swipes, the swirl) smooth while the model thinks
      engine = await lib.CreateWebWorkerMLCEngine(new Worker(new URL("./muse-llm-worker.js?v=1", import.meta.url), { type: "module" }), id, opts);
    } catch (e) { console.warn("Muse AI worker failed, using main thread:", e); engine = await lib.CreateMLCEngine(id, opts); }
    ai.state = "ready";
    for (const o of OLD) { try { if (await lib.hasModelInCache(o)) await lib.deleteModelAllInfoInCache(o); } catch (e) {} }
    return engine;
  })().catch((e) => { if (ai.state === "unsupported") return null; ai.state = "error"; ai.error = String(e && e.message || e); console.warn("Muse AI:", e); engine = null; loading = null; return null; });
  return loading;
}
export const ready = () => !!engine || !!window.__museSvgStub;

const SYS = `You are a world-class generative vector artist. You write ONE complete, self-contained SVG artwork and nothing else.
Rules:
- Output only SVG code, starting with <svg and ending with </svg>. No markdown, no explanation.
- Use exactly the viewBox you are given. The first element after <defs> must be a full-size background <rect> covering the whole viewBox (full-bleed, no empty margins).
- Make real art, not clip-art or icons: a clear composition with foreground, middle ground and background, depth, light, and a harmonious palette of 4-7 colours.
- Use <defs> with linearGradient/radialGradient (and optionally a feGaussianBlur or feTurbulence filter) and reference them with fill="url(#id)".
- Use many shapes (30-80): layered paths with smooth curves (C, Q), circles, ellipses, polygons, varied opacity. Repeat motifs with small variations.
- Never use <script>, <foreignObject>, <image>, <style>, event attributes or external links. No text unless asked.
- Keep numbers short (integers or one decimal).`;
const EX1U = `Picture: "calm moonlit lake with pine trees". viewBox="0 0 600 1000"`;
const EX1A = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 1000"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1335"/><stop offset=".6" stop-color="#3a4f8f"/><stop offset="1" stop-color="#9fb4e0"/></linearGradient><radialGradient id="moon"><stop offset="0" stop-color="#fffbe8"/><stop offset=".5" stop-color="#fff3c4" stop-opacity=".5"/><stop offset="1" stop-color="#fff3c4" stop-opacity="0"/></radialGradient><linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6c84c4"/><stop offset="1" stop-color="#0a1230"/></linearGradient><filter id="soft"><feGaussianBlur stdDeviation="6"/></filter></defs><rect width="600" height="1000" fill="url(#sky)"/><circle cx="420" cy="230" r="160" fill="url(#moon)"/><circle cx="420" cy="230" r="46" fill="#fffbe8"/><g fill="#fff" opacity=".8"><circle cx="80" cy="90" r="1.6"/><circle cx="190" cy="160" r="1.2"/><circle cx="300" cy="70" r="1.8"/><circle cx="540" cy="120" r="1.3"/><circle cx="130" cy="300" r="1"/></g><path d="M0 560 C120 470 220 520 320 480 C420 440 500 500 600 470 L600 620 L0 620Z" fill="#2b3a6e"/><path d="M0 600 C150 540 260 590 380 560 C470 540 540 580 600 560 L600 640 L0 640Z" fill="#1c2752"/><rect y="630" width="600" height="370" fill="url(#lake)"/><ellipse cx="420" cy="700" rx="30" ry="90" fill="#fffbe8" opacity=".35" filter="url(#soft)"/><g fill="#0b1430"><polygon points="40,640 70,520 100,640"/><polygon points="80,645 120,480 160,645"/><polygon points="140,640 165,550 190,640"/><polygon points="470,640 500,530 530,640"/><polygon points="520,642 555,500 590,642"/></g><g stroke="#cfdcff" stroke-width="2" opacity=".35" stroke-linecap="round"><path d="M360 720 H480"/><path d="M380 760 H460"/><path d="M340 800 H500"/><path d="M390 850 H450"/></g></svg>`;
const EX2U = `Picture: "abstract warm geometric sunrise, bauhaus". viewBox="0 0 600 1000"`;
const EX2A = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 1000"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6e7cf"/><stop offset="1" stop-color="#eac9a0"/></linearGradient><linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#e2492f"/></linearGradient></defs><rect width="600" height="1000" fill="url(#bg)"/><circle cx="300" cy="420" r="190" fill="url(#sun)"/><g fill="#f6e7cf"><rect x="100" y="440" width="400" height="14"/><rect x="100" y="480" width="400" height="20"/><rect x="100" y="526" width="400" height="28"/></g><rect y="600" width="600" height="400" fill="#1f3a5f"/><path d="M0 600 A300 300 0 0 1 300 900 L0 900Z" fill="#2f6f73"/><path d="M600 600 A300 300 0 0 0 300 900 L600 900Z" fill="#e2492f" opacity=".9"/><rect y="900" width="600" height="100" fill="#14263f"/><g fill="#14263f"><circle cx="90" cy="160" r="40"/><rect x="460" y="110" width="80" height="80" transform="rotate(20 500 150)"/></g><g fill="none" stroke="#1f3a5f" stroke-width="6"><path d="M60 260 Q150 200 240 260"/><path d="M360 250 Q450 190 540 250"/></g><g fill="#ffb347"><polygon points="300,610 330,660 270,660"/><polygon points="300,680 330,730 270,730"/><polygon points="300,750 330,800 270,800"/></g><g fill="#f6e7cf" opacity=".7"><circle cx="150" cy="940" r="8"/><circle cx="200" cy="950" r="8"/><circle cx="250" cy="940" r="8"/><circle cx="350" cy="950" r="8"/><circle cx="400" cy="940" r="8"/><circle cx="450" cy="950" r="8"/></g></svg>`;

export function viewBoxFor(W, H) { const w = 600; return [w, Math.round(w * H / Math.max(1, W))]; }
export function messagesFor(text, vw, vh, prev) {
  const m = [{ role: "system", content: SYS }, { role: "user", content: EX1U }, { role: "assistant", content: EX1A }, { role: "user", content: EX2U }, { role: "assistant", content: EX2A }];
  const vb = `viewBox="0 0 ${vw} ${vh}"`;
  if (prev && prev.length < 3600) m.push({ role: "user", content: `Here is an artwork you made for "${text}":\n${prev}\nNow paint a fresh VARIATION of it: same mood and palette family, but a new composition, moved and reshaped elements, a few new details. Full new SVG, ${vb}.` });
  else m.push({ role: "user", content: `Picture: "${text.slice(0, 300)}"${prev ? " (a new variation, different composition)" : ""}. ${vb}` });
  return m;
}
/* writes an SVG for the text (or a variation of prev). onProgress(0..1). Retries once, returns { svg, ms } or null */
export async function drawSVG(text, { W, H, prev = null, onProgress } = {}) {
  const [vw, vh] = viewBoxFor(W, H), t0 = performance.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = messagesFor(text, vw, vh, attempt ? null : prev);
    let raw = "";
    try { raw = await generate(msgs, attempt, onProgress); } catch (e) { console.warn("Muse AI:", e); if (/lost|disposed|Instance/i.test(String(e && e.message || e))) { ai.state = "error"; engine = null; loading = null; return null; } }
    const r = sanitize(raw, vw, vh);
    if (valid(r)) { ai.lastMs = Math.round(performance.now() - t0); return { svg: r.svg, ms: ai.lastMs, tries: attempt + 1 }; }
    console.warn("Muse AI: unusable SVG, attempt", attempt + 1, raw.slice(0, 200));
  }
  ai.lastMs = Math.round(performance.now() - t0); return null;
}
const MAXTOK = 1500;
async function generate(messages, attempt, onProgress) {
  if (window.__museSvgStub) return await window.__museSvgStub(messages, attempt, onProgress);
  if (!engine) return "";
  const lim = window.__museAITimeout || 150000, t0 = performance.now();
  const stream = await engine.chat.completions.create({ messages, temperature: attempt ? 0.9 : 0.75, top_p: 0.95, max_tokens: MAXTOK, stream: true });
  let out = "", n = 0;
  for await (const ch of stream) {
    out += (ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content) || ""; n++;
    onProgress && onProgress(Math.min(0.99, n / 1100)); // a typical piece is ~1000 tokens
    if (out.includes("</svg>") || performance.now() - t0 > lim) { try { engine.interruptGenerate(); } catch (e) {} break; } // a cut-off piece is repaired by the sanitizer
  }
  return out;
}
export async function unload() { const e = engine; engine = null; loading = null; ai.state = "idle"; ai.progress = 0; try { e && await e.unload(); } catch (err) {} }
/* delete every WebLLM cache (Cache Storage + IndexedDB). Returns freed bytes, or null if the browser can't tell */
export async function removeModel() {
  await unload();
  const est = async () => { try { return (await navigator.storage.estimate()).usage; } catch (e) { return null; } };
  const before = await est(); let n = 0;
  try { for (const k of await caches.keys()) if (/webllm|mlc|tvmjs/i.test(k)) { await caches.delete(k); n++; } } catch (e) {}
  try { if (indexedDB.databases) for (const d of await indexedDB.databases()) if (d.name && /webllm|mlc|tvmjs/i.test(d.name)) { await new Promise((res) => { const r = indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = () => res(); }); n++; } } catch (e) {}
  const after = await est();
  return { freed: before != null && after != null ? Math.max(0, before - after) : null, n };
}
export async function cached() { try { return (await caches.keys()).some((k) => /webllm/i.test(k)); } catch (e) { return false; } }
