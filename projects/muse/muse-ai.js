/* Muse "describe it": turns a short English/German text into a genome change, fully on-device.
   1) instant keyword parser (always available), 2) a small local LLM (WebLLM + Qwen2.5-0.5B, WebGPU) loaded lazily. */
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

/* ---------- 2. local LLM ---------- */
const LIB = "./vendor/web-llm-0.2.87.js";
let engine = null, loading = null, modelId = null;
export const ai = { state: "idle", progress: 0, error: "", model: "" };
export const hasGPU = () => !!(navigator.gpu);
export function load(onProgress) {
  if (loading) return loading;
  if (!hasGPU()) { ai.state = "unsupported"; return (loading = Promise.resolve(null)); }
  ai.state = "loading";
  loading = (async () => {
    const adapter = await navigator.gpu.requestAdapter(); if (!adapter) { ai.state = "unsupported"; return null; }
    const f16 = adapter.features.has("shader-f16");
    modelId = f16 ? "Qwen2.5-0.5B-Instruct-q4f16_1-MLC" : "Qwen2.5-0.5B-Instruct-q4f32_1-MLC"; ai.model = modelId;
    const webllm = await import(LIB);
    engine = await webllm.CreateMLCEngine(modelId, { initProgressCallback: (r) => { ai.progress = r.progress || 0; onProgress && onProgress(ai.progress, r.text || ""); } });
    ai.state = "ready"; return engine;
  })().catch((e) => { if (ai.state === "unsupported") return null; ai.state = "error"; ai.error = String(e && e.message || e); console.warn("Muse AI:", e); engine = null; return null; });
  return loading;
}
const SCHEMA = { type: "object", properties: {
  family: { type: "string", enum: ["keep", ...FAMS] }, hue: { type: "integer", minimum: -1, maximum: 360 },
  saturation: { type: "number" }, brightness: { type: "number" }, dark_background: { type: "boolean" }, colour_variety: { type: "number" },
  density: { type: "number" }, shape_size: { type: "number" }, texture: { type: "number" }, avoid_hue: { type: "integer", minimum: -1, maximum: 360 } },
  required: ["family", "hue", "saturation", "brightness", "dark_background", "colour_variety", "density", "shape_size", "texture", "avoid_hue"] };
const SYS = `You control a generative art machine. The user describes the picture they want or a change, in English or German.
Reply with ONLY a JSON object of new settings, starting from the current settings and changing only what the user asked for.
Fields: family = art style ("keep" or one of: flow=organic flowing hair-like lines, bauhaus=geometric tiles, blobs=soft blurred gradients, voronoi=cell mosaic, contour=topographic lines, circles=packed circles/bubbles, landscape=mountain layers, stripes, waves=wavy lines, truchet=maze tiles, sunset=retro sun, orbits=planets and rings).
hue = main colour angle 0-360 (red 0, orange 25, yellow 55, green 125, teal 175, blue 220, purple 275, pink 325), or -1 to keep.
saturation, brightness, colour_variety, density (amount of detail), shape_size, texture (film grain) are numbers 0..1.
dark_background true/false. avoid_hue = a colour angle the user does NOT want, else -1.`;
export async function ask(text, g) {
  if (!engine) return null;
  try { return await ask1(text, g); } catch (e) { console.warn('Muse AI:', e); if (/lost|disposed|Instance/i.test(String(e && e.message || e))) { ai.state = 'error'; engine = null; } return null; }
}
async function ask1(text, g) {
  const cur = { family: g.fam, hue: Math.round(g.hue), saturation: +g.sat.toFixed(2), brightness: +g.lum.toFixed(2), dark_background: !!g.bgDark, colour_variety: +g.spread.toFixed(2), density: +g.p[0].toFixed(2), shape_size: +g.p[1].toFixed(2), texture: +g.grain.toFixed(2), avoid_hue: -1 };
  const t0 = performance.now();
  const lim = window.__museAITimeout || 20000; let timer;
  const gen = engine.chat.completions.create({ messages: [{ role: "system", content: SYS }, { role: "user", content: `Current settings: ${JSON.stringify(cur)}\nUser: ${text.slice(0, 300)}` }],
    temperature: 0.3, max_tokens: 160, response_format: { type: "json_object", schema: JSON.stringify(SCHEMA) } });
  const r = await Promise.race([gen, new Promise((res) => (timer = setTimeout(() => { try { engine.interruptGenerate(); } catch (e) {} res(null); }, lim)))]); clearTimeout(timer);
  if (!r) { ai.lastMs = lim; ai.timedOut = true; return null; }
  ai.lastMs = Math.round(performance.now() - t0);
  let j; try { j = JSON.parse(r.choices[0].message.content); } catch (e) { return null; }
  return toIntent(j, cur);
}
function num(v, d) { v = Number(v); return Number.isFinite(v) ? clamp(v, 0, 1) : d; }
function toIntent(j, cur) {
  const it = { fam: null, avoidFam: [], hue: null, avoidHue: [], d: {}, chips: [] };
  if (FAMS.includes(j.family) && j.family !== cur.family) { it.fam = j.family; it.chips.push(j.family); }
  const h = Number(j.hue); if (Number.isFinite(h) && h >= 0 && Math.abs(((h - cur.hue + 540) % 360) - 180) > 12) { it.hue = h % 360; it.chips.push("hue " + Math.round(h)); }
  const ah = Number(j.avoid_hue); if (Number.isFinite(ah) && ah >= 0) { it.avoidHue.push(ah % 360); it.chips.push("avoid " + Math.round(ah)); }
  const set = (k, f, label) => { const v = num(j[k], cur[k]), dv = v - cur[k]; if (Math.abs(dv) > 0.04) { it.d[f] = dv; it.chips.push(label + (dv > 0 ? "↑" : "↓")); } };
  set("saturation", "sat", "sat"); set("brightness", "lum", "light"); set("colour_variety", "spread", "variety"); set("density", "density", "detail"); set("shape_size", "size", "size"); set("texture", "grain", "texture");
  if (typeof j.dark_background === "boolean" && j.dark_background !== cur.dark_background) { it.d.dark = j.dark_background ? 1 : 0; it.chips.push(j.dark_background ? "dark" : "light bg"); }
  return it;
}
