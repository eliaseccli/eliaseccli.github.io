/* Muse: strict SVG sanitizer for model-written art. Pure string code (no DOM), so it runs in node tests too.
   Parses the text into a tree, keeps only whitelisted elements/attributes, repairs unclosed tags, re-serializes. */
const EL = new Set(["svg", "g", "defs", "linearGradient", "radialGradient", "stop", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "clipPath", "mask", "pattern", "use", "symbol", "filter", "feGaussianBlur", "feTurbulence", "feDisplacementMap", "feColorMatrix",
  "feBlend", "feOffset", "feMerge", "feMergeNode", "feComposite", "feFlood", "feMorphology", "feComponentTransfer", "feFuncR", "feFuncG", "feFuncB", "feFuncA", "feDropShadow"]);
const DRAW = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "use"]);
const TEXTY = new Set(["text", "tspan"]);
const AT = new Set(("id class viewBox preserveAspectRatio x y x1 y1 x2 y2 cx cy r rx ry fx fy fr width height d points transform fill stroke " +
  "stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity stroke-miterlimit fill-opacity fill-rule clip-rule opacity " +
  "offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod patternUnits patternContentUnits patternTransform clip-path clipPathUnits " +
  "mask maskUnits maskContentUnits filter filterUnits primitiveUnits stdDeviation in in2 result mode type values baseFrequency numOctaves seed stitchTiles " +
  "scale xChannelSelector yChannelSelector dx dy operator k1 k2 k3 k4 flood-color flood-opacity radius tableValues slope intercept amplitude exponent " +
  "font-size font-family font-weight font-style text-anchor dominant-baseline letter-spacing mix-blend-mode href xlink:href pathLength vector-effect " +
  "paint-order visibility display shape-rendering color-interpolation-filters").split(" "));
const MAXLEN = 80000;
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const dec = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10) || 32) : ENT[e.toLowerCase()] ?? " ");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// a value is unsafe if it reaches outside the document or carries script
const BAD = /javascript|vbscript|data:|expression\s*\(|@import|<|behavior|-moz-binding|\\/i;
function okUrl(v) { const all = v.match(/url\s*\(([^)]*)\)/gi) || []; return all.every((u) => /^url\s*\(\s*['"]?#[\w.-]+['"]?\s*\)$/i.test(u)); }
function cleanAttr(name, raw) {
  if (/^on/i.test(name)) return null;
  if (!AT.has(name) && name !== "style") return null;
  const v = dec(raw).replace(/[\u0000-\u001f]/g, " ").trim();
  if (v.length > 20000 || BAD.test(v) || !okUrl(v)) return null;
  if (name === "href" || name === "xlink:href") return /^#[\w.-]+$/.test(v) ? v : null;
  if (name === "style") return v.split(";").map((d) => d.trim()).filter((d) => { const k = d.split(":")[0].trim().toLowerCase(); return k && /^[a-z-]+$/.test(k) && !/^(position|content|behavior)$/.test(k); }).join(";") || null;
  // shorten long decimals: fewer tokens when the piece is fed back for a variation
  return /^(d|points|transform|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|viewBox|stroke-width)$/.test(name) ? v.replace(/(-?\d+\.\d)\d+/g, "$1") : v;
}
export function extractSvg(text) {
  if (typeof text !== "string") return "";
  const i = text.search(/<svg[\s>]/i); if (i < 0) return "";
  const j = text.lastIndexOf("</svg>");
  return j > i ? text.slice(i, j + 6) : text.slice(i); // unclosed (cut off): the parser repairs it
}
/* returns { svg, shapes, w, h } or null. w/h set the viewBox when the model's own is missing or broken */
export function sanitize(text, w = 600, h = 1000) {
  let src = extractSvg(text).slice(0, MAXLEN); if (!src) return null;
  const tok = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<[!?][^>]*>?|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|<|[^<]+/g;
  const out = [], stack = []; let skip = 0, shapes = 0, root = false, m;
  const top = () => stack[stack.length - 1];
  while ((m = tok.exec(src))) {
    const s = m[0];
    if (m[3]) { // open tag
      const name = m[3], self = !!m[5];
      if (skip || !EL.has(name) || (!root && name !== "svg") || (root && !stack.length)) { if (!self) skip++; continue; }
      const attrs = {}; const ar = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; let a;
      while ((a = ar.exec(m[4] || ""))) { const k = a[1], v = cleanAttr(k, a[2] ?? a[3] ?? a[4] ?? ""); if (v != null && !(k in attrs)) attrs[k] = v; }
      if (name === "svg" && !root) {
        root = true; const vb = (attrs.viewBox || "").split(/[\s,]+/).map(Number);
        const vbOk = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
        out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbOk ? vb.join(" ") : `0 0 ${w} ${h}`}" preserveAspectRatio="xMidYMid slice"`);
        for (const k in attrs) if (!/^(viewBox|preserveAspectRatio|width|height|x|y)$/.test(k)) out.push(` ${k}="${esc(attrs[k])}"`);
        out.push(">"); stack.push("svg"); if (self) { stack.pop(); } continue;
      }
      if (DRAW.has(name)) shapes++;
      out.push("<" + name); for (const k in attrs) out.push(` ${k}="${esc(attrs[k])}"`);
      if (self) out.push("/>"); else { out.push(">"); stack.push(name); }
    } else if (m[2]) { // close tag
      const name = m[2];
      if (skip) { skip--; continue; }
      const k = stack.lastIndexOf(name); if (k < 0) continue;
      while (stack.length > k) out.push(`</${stack.pop()}>`);
      if (!stack.length) break; // root closed: ignore anything after it
    } else if (s[0] === "<" && s.length > 1 && s[1] !== "!" && s[1] !== "?") { // lone "<"
      continue;
    } else if (!skip && stack.length && !/^<[!?]/.test(s)) {
      const t = top();
      if (TEXTY.has(t)) out.push(esc(dec(s)).slice(0, 400));
    }
  }
  if (!root) return null;
  while (stack.length) out.push(`</${stack.pop()}>`);
  return { svg: out.join(""), shapes };
}
// size the root for rasterising (Image from a blob URL) at an exact pixel size
export function sized(svg, pw, ph) { return svg.replace(/^<svg /, `<svg width="${Math.round(pw)}" height="${Math.round(ph)}" `); }
export function valid(r, min = 6) { return !!(r && r.svg && r.shapes >= min && r.svg.length > 200); }
