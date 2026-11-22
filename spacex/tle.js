/* Two-line element sets: parsing, repair, CelesTrak OMM (JSON) -> TLE, and which catalogued
   object of a launch stands for its upper stage. Pure functions (no DOM, no network), shared
   by spacex.js and the node tests. */

export function tleChecksum(l) {
  let c = 0;
  for (const ch of l.slice(0, 68)) { if (ch >= "0" && ch <= "9") c += +ch; else if (ch === "-") c += 1; }
  return String(c % 10);
}

// Rebuild a TLE pair in strict fixed columns (pre-launch sets are often shared with
// collapsed spacing, e.g. without the international designator).
export function normalizeTLE(l1, l2) {
  l1 = String(l1 || "").trim(); l2 = String(l2 || "").trim();
  if (l1.length === 69 && l2.length === 69 && l1[18] !== " " && l2[7] === " ") return [l1, l2];
  const a = l1.split(/\s+/), b = l2.split(/\s+/);
  if (a[0] !== "1" || b[0] !== "2") return null;
  const catCls = a[1];
  const cat = catCls.replace(/[A-Z]$/i, "").padStart(5, "0").slice(-5);
  const cls = /[A-Z]$/i.test(catCls) ? catCls.slice(-1).toUpperCase() : "U";
  let i = 2, intdes = "";
  if (!/^\d{5}\.\d+$/.test(a[i])) intdes = a[i++];
  const epoch = a[i++], ndot = a[i++], nddot = a[i++], bstar = a[i++], eph = a[i++] || "0";
  // last token is element-set number + checksum digit
  const elTok = a[i++] || "9990";
  const el = (elTok.length > 1 ? elTok.slice(0, -1) : elTok).slice(-4);
  if (!/^\d{5}\.\d+$/.test(epoch)) return null;
  const sgnF = (v, w) => (v.startsWith("-") || v.startsWith("+") ? v.replace("+", " ") : " " + v).padStart(w, " ").slice(-w);
  const f = (x, w, d) => (+x).toFixed(d).padStart(w, " ");
  let L1 = "1 " + cat + cls + " " + intdes.padEnd(8, " ").slice(0, 8) + " " + epoch.padStart(14, "0").slice(0, 14) + " " +
    sgnF(ndot.replace(/^(-?)0\./, "$1."), 10) + " " + sgnF(nddot, 8) + " " + sgnF(bstar, 8) + " " + eph.slice(0, 1) + " " + el.padStart(4, " ");
  L1 = L1.slice(0, 68).padEnd(68, " "); L1 += tleChecksum(L1);
  const inc = b[2], raan = b[3], ecc = b[4], argp = b[5], ma = b[6];
  let mm = b[7] || "";
  // last token is rev number + checksum digit (or glued to the mean motion)
  let rev = b[8] ? (b[8].length > 1 ? b[8].slice(0, -1) : "0") : "0";
  if (mm.length > 11) { rev = mm.slice(11, -1) || "0"; mm = mm.slice(0, 11); }
  let L2 = "2 " + cat + " " + f(inc, 8, 4) + " " + f(raan, 8, 4) + " " + ecc.replace(/^0?\./, "").padStart(7, "0").slice(0, 7) + " " +
    f(argp, 8, 4) + " " + f(ma, 8, 4) + " " + f(mm, 11, 8) + String(rev.replace(/\D/g, "").slice(0, 5) || "0").padStart(5, " ");
  L2 = L2.slice(0, 68).padEnd(68, " "); L2 += tleChecksum(L2);
  return [L1, L2];
}

export function tleEpochMs(l1) {
  const yy = +l1.slice(18, 20), doy = +l1.slice(20, 32);
  const y = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(y, 0, 1) + (doy - 1) * 864e5;
}

export function parse3LE(txt) {
  const ln = String(txt || "").split(/\r?\n/).map((x) => x.replace(/\s+$/, "")).filter((x) => x.trim());
  const out = [];
  for (let k = 0; k < ln.length; k++) {
    if (ln[k].startsWith("1 ") && ln[k + 1] && ln[k + 1].startsWith("2 ")) {
      const name = k > 0 && !ln[k - 1].startsWith("2 ") && !ln[k - 1].startsWith("1 ") ? ln[k - 1].replace(/^0\s+/, "").trim() : "";
      out.push({ name, l1: ln[k], l2: ln[k + 1] }); k++;
    }
  }
  return out;
}

// a TLE pair -> the element set the trajectory code uses
export function preFromTLE(name, l1, l2, source) {
  const n = normalizeTLE(l1, l2);
  if (!n) return null;
  return { tle1: n[0], tle2: n[1], name, source, epochMs: tleEpochMs(n[0]), INCLINATION: +n[1].slice(8, 16), MEAN_MOTION: +n[1].slice(52, 63) };
}

/* CelesTrak OMM (gp.php FORMAT=json) -> TLE lines. Objects catalogued now have 6-digit
   numbers, which TLE columns carry as Alpha-5 (A = 10 ... Z = 33, without I and O). */
const ALPHA5 = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export function alpha5(n) {
  n = Math.round(+n);
  if (!(n >= 0) || n >= 340000) return "99999";
  if (n < 100000) return String(n).padStart(5, "0");
  return ALPHA5[Math.floor(n / 10000) - 10] + String(n % 10000).padStart(4, "0");
}
// TLE "decimal point assumed" exponent field, e.g. 0.00018757194 -> " 18757-3"
function expField(x) {
  x = +x || 0;
  if (x === 0) return " 00000+0";
  const s = x < 0 ? "-" : " ";
  let e = Math.floor(Math.log10(Math.abs(x))) + 1, m = Math.round(Math.abs(x) / Math.pow(10, e) * 1e5);
  if (m >= 1e5) { m = Math.round(m / 10); e += 1; }
  return s + String(m).padStart(5, "0") + (e < 0 ? "-" : "+") + Math.abs(e);
}
export function ommToTLE(o) {
  const ep = new Date(/Z$/.test(o.EPOCH) ? o.EPOCH : o.EPOCH + "Z");
  if (isNaN(ep)) return null;
  const y = ep.getUTCFullYear(), doy = (ep.getTime() - Date.UTC(y, 0, 1)) / 864e5 + 1;
  const cat = alpha5(o.NORAD_CAT_ID);
  const id = String(o.OBJECT_ID || "");
  const intdes = /^\d{4}-\d{3}/.test(id) ? id.slice(2, 4) + id.slice(5) : "";
  const ndot = +o.MEAN_MOTION_DOT || 0;
  const ndotS = (ndot < 0 ? "-" : " ") + Math.abs(ndot).toFixed(8).replace(/^0/, "");
  let L1 = "1 " + cat + (o.CLASSIFICATION_TYPE || "U").slice(0, 1) + " " + intdes.padEnd(8, " ").slice(0, 8) + " " +
    String(y % 100).padStart(2, "0") + doy.toFixed(8).padStart(12, "0") + " " + ndotS + " " + expField(o.MEAN_MOTION_DDOT) + " " +
    expField(o.BSTAR) + " " + String(o.EPHEMERIS_TYPE || 0).slice(0, 1) + " " + String((+o.ELEMENT_SET_NO || 999) % 10000).padStart(4, " ");
  const f = (x, w, d) => (+x).toFixed(d).padStart(w, " ");
  let L2 = "2 " + cat + " " + f(o.INCLINATION, 8, 4) + " " + f(o.RA_OF_ASC_NODE, 8, 4) + " " + (+o.ECCENTRICITY).toFixed(7).slice(2) + " " +
    f(o.ARG_OF_PERICENTER, 8, 4) + " " + f(o.MEAN_ANOMALY, 8, 4) + " " + f(o.MEAN_MOTION, 11, 8) + String((+o.REV_AT_EPOCH || 0) % 100000).padStart(5, " ");
  L1 = L1.slice(0, 68).padEnd(68, " "); L1 += tleChecksum(L1);
  L2 = L2.slice(0, 68).padEnd(68, " "); L2 += tleChecksum(L2);
  return [L1, L2];
}

/* The objects CelesTrak catalogued for one launch (SATCAT rows joined with their GP) ->
   the one that stands for the upper stage: the rocket body itself while it is still in
   orbit (OBJECT_TYPE "R/B"), else the payloads it carried there (the median by mean
   motion of the largest group: right after deployment they ride in the stage's orbit;
   SpaceX's LEO stages deorbit, so they are often not catalogued at all). */
export function pickTrackedObject(objs) {
  const live = (objs || []).filter((o) => o && !o.decay && o.omm);
  if (!live.length) return null;
  // the upper stage: a rocket body, or Starship's ship (catalogued as a payload, STARSHIP-n)
  const rb = live.filter((o) => o.type === "R/B" || /^STARSHIP\b/i.test(o.name || ""));
  if (rb.length) return { ...rb[0], role: "stage" };
  const pays = live.filter((o) => o.type === "PAY");
  const use = (pays.length ? pays : live).slice().sort((a, b) => +a.omm.MEAN_MOTION - +b.omm.MEAN_MOTION);
  return { ...use[Math.floor(use.length / 2)], role: pays.length ? "payload" : "object", count: live.length };
}
