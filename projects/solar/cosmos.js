import * as THREE from "/vendor/three.module.min.js";
import { radec2w, eq2w, LY } from "./bodies.js?v=3";

/* ============================================================
   Beyond the solar system: one continuous zoom from the Sun's bubble
   to the edge of the observable universe. Every layer lives in
   light-years and is drawn relative to a target that drifts with the
   zoom (Sun → galactic centre → Local Group → back to us), scaled by
   1/D so a camera at distance 1 sees the right picture at any scale.
   Real data where it's cheap (HYG stars, galaxy positions); the
   galaxy, clusters and cosmic web are drawn, not measured.
   ============================================================ */

const L10 = Math.log10;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const band = (lg, r) => smooth(r[0], r[1], lg) * (1 - smooth(r[2], r[3], lg));

// galactic (l, b) -> world, light-years
const GAL = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.44482963, 0.7469822445], [-0.867666149, -0.1980763734, 0.4559837762]];
function gal2w(lDeg, bDeg, r) {
  const l = (lDeg * Math.PI) / 180, b = (bDeg * Math.PI) / 180;
  const g = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
  const e = [0, 1, 2].map((i) => GAL[0][i] * g[0] + GAL[1][i] * g[1] + GAL[2][i] * g[2]);
  return eq2w(e[0] * r, e[1] * r, e[2] * r, [0, 0, 0]);
}
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

const R_GC = 26000;
const GC = V(gal2w(0, 0, R_GC));
const M31 = V(radec2w(10.6847, 41.2690, 2.5e6));
const M33 = V(radec2w(23.4621, 30.6599, 2.73e6));
const LMC = V(radec2w(80.894, -69.756, 1.6e5));
const SMC = V(radec2w(13.187, -72.829, 2.0e5));
const VIRGO = V(radec2w(187.7059, 12.3911, 5.35e7));
const FORNAX = V(radec2w(54.62, -35.45, 6.2e7));
const GA = V(gal2w(307, 9, 2.5e8));          // Great Attractor, heart of Laniakea
const LG = M31.clone().multiplyScalar(0.5);   // halfway to Andromeda: both fit on screen

const T = (en, de) => ({ en, de });
export const LAYERS = [
  { key: "helio", lg: [-2.25, -1.7], name: T("Heliosphere", "Heliosphäre"), scale: T("The Sun's bubble", "Die Blase der Sonne"),
    kid: T("The Sun blows a wind of tiny particles. It blows a giant bubble around all the planets. Voyager 1, a little robot, flew out of it in 2012!",
      "Die Sonne bläst einen Wind aus winzigen Teilchen. Der bläst eine riesige Blase um alle Planeten. Voyager 1, ein kleiner Roboter, ist 2012 hinausgeflogen!"),
    fun: T("Voyager 1 is now about 170 AU away – its radio signals need almost a full day to reach us.", "Voyager 1 ist jetzt etwa 170 AE entfernt – seine Funksignale brauchen fast einen ganzen Tag bis zu uns.") },
  { key: "oort", lg: [-1.7, -0.3], name: T("Oort cloud", "Oortsche Wolke"), scale: T("Up to 1.5 light-years", "Bis 1,5 Lichtjahre"),
    kid: T("Far, far out, trillions of icy comets float around the Sun in a giant ball. Sunlight needs more than a year to get there!",
      "Ganz weit draußen schweben Billionen eisiger Kometen in einer riesigen Kugel um die Sonne. Sonnenlicht braucht mehr als ein Jahr bis dorthin!"),
    fun: T("Nobody has ever seen the Oort cloud directly – we know it's there because of the long-period comets that fall in from it.",
      "Niemand hat die Oortsche Wolke je direkt gesehen – wir wissen von ihr durch die langperiodischen Kometen, die aus ihr hereinfallen.") },
  { key: "stars", lg: [-0.3, 2.3], name: T("Our neighbour stars", "Unsere Nachbarsterne"), scale: T("Real positions (HYG catalogue)", "Echte Positionen (HYG-Katalog)"),
    kid: T("Every star is a sun! The closest one, Proxima Centauri, is so far away that its light travels more than 4 years to reach us.",
      "Jeder Stern ist eine Sonne! Der nächste, Proxima Centauri, ist so weit weg, dass sein Licht über 4 Jahre zu uns braucht."),
    fun: T("With today's fastest spacecraft the trip to Proxima Centauri would take about 6,000 years.", "Mit den schnellsten Raumsonden von heute würde die Reise zu Proxima Centauri etwa 6.000 Jahre dauern.") },
  { key: "disk", lg: [2.3, 3.7], name: T("Our corner of the Milky Way", "Unsere Ecke der Milchstraße"), scale: T("The stars you see at night", "Die Sterne am Nachthimmel"),
    kid: T("Almost all the stars you can see at night are in this little bubble – our closest neighbours in a giant city of stars.",
      "Fast alle Sterne, die du nachts siehst, sind in dieser kleinen Blase – unsere nächsten Nachbarn in einer riesigen Sternenstadt."),
    fun: T("Betelgeuse in Orion is so big that it would swallow Mars' orbit if it sat where the Sun is.", "Beteigeuze im Orion ist so groß, dass sie an der Stelle der Sonne die Marsbahn verschlucken würde.") },
  { key: "mw", lg: [3.7, 5.6], name: T("The Milky Way", "Die Milchstraße"), scale: T("Our galaxy – 100,000 light-years", "Unsere Galaxie – 100.000 Lichtjahre"),
    kid: T("Our galaxy: a giant spinning wheel of hundreds of billions of stars. We live out in one of its arms – right here!",
      "Unsere Galaxie: ein riesiges Rad aus Hunderten Milliarden Sternen, das sich dreht. Wir wohnen draußen in einem der Arme – genau hier!"),
    fun: T("The Sun needs about 230 million years to go around the centre once. In the middle sits a black hole 4 million times heavier than the Sun.",
      "Die Sonne braucht etwa 230 Millionen Jahre für eine Runde um das Zentrum. In der Mitte sitzt ein Schwarzes Loch, 4 Millionen Mal schwerer als die Sonne.") },
  { key: "lg", lg: [5.6, 7.3], name: T("Local Group", "Lokale Gruppe"), scale: T("Our galaxy's neighbours", "Die Nachbarn unserer Galaxie"),
    kid: T("The Milky Way has neighbours too! Andromeda is the biggest – one day, in about 4.5 billion years, the two will bump together and become one.",
      "Auch die Milchstraße hat Nachbarn! Andromeda ist die größte – in etwa 4,5 Milliarden Jahren stoßen die beiden zusammen und werden eins."),
    fun: T("Andromeda is the farthest thing you can see with bare eyes: its light left 2.5 million years ago.", "Andromeda ist das Fernste, was man mit bloßem Auge sehen kann: Ihr Licht ist vor 2,5 Millionen Jahren losgeflogen.") },
  { key: "virgo", lg: [7.3, 8.4], name: T("Virgo Supercluster", "Virgo-Superhaufen"), scale: T("Thousands of galaxies", "Tausende Galaxien"),
    kid: T("Galaxies live in families. Our Local Group is a tiny village at the edge of a huge family with thousands of galaxies.",
      "Galaxien leben in Familien. Unsere Lokale Gruppe ist ein kleines Dorf am Rand einer riesigen Familie mit Tausenden Galaxien."),
    fun: T("The Virgo Cluster in the middle holds over 1,300 galaxies, 54 million light-years away.", "Der Virgo-Haufen in der Mitte hat über 1.300 Galaxien, 54 Millionen Lichtjahre entfernt.") },
  { key: "web", lg: [8.4, 9.9], name: T("Cosmic web", "Kosmisches Netz"), scale: T("Laniakea and beyond", "Laniakea und weiter"),
    kid: T("On the biggest scale, galaxies make long glowing threads with giant empty bubbles in between – like a sponge or a spider's web.",
      "Im ganz Großen bilden Galaxien lange leuchtende Fäden mit riesigen leeren Blasen dazwischen – wie ein Schwamm oder ein Spinnennetz."),
    fun: T("Our home supercluster is called Laniakea – Hawaiian for 'immeasurable heaven'. It's about 500 million light-years across.",
      "Unser Superhaufen heißt Laniakea – hawaiianisch für 'unermesslicher Himmel'. Er ist etwa 500 Millionen Lichtjahre groß.") },
  { key: "universe", lg: [9.9, 13], name: T("Observable universe", "Beobachtbares Universum"), scale: T("93 billion light-years across", "93 Milliarden Lichtjahre groß"),
    kid: T("This is everything we can see – about 2 trillion galaxies! Light from the edge has been travelling for 13.8 billion years to reach us.",
      "Das ist alles, was wir sehen können – etwa 2 Billionen Galaxien! Licht vom Rand ist 13,8 Milliarden Jahre zu uns unterwegs."),
    fun: T("It's 93 billion light-years wide (not 27.6) because space kept stretching while the light travelled. And yes – it's centred on us, as it is for every place in the universe.",
      "Es ist 93 Milliarden Lichtjahre groß (nicht 27,6), weil sich der Raum gedehnt hat, während das Licht unterwegs war. Und ja – es ist um uns zentriert, so wie für jeden Ort im Universum.") }
];
const LBY = Object.fromEntries(LAYERS.map((l) => [l.key, l]));

/* soft round points; size in ly (scaled with distance) or fixed px */
const ptsVS = `
  attribute float size; attribute vec3 color;
  uniform float pxScale, sizeK, minPx, maxPx, fixedPx, dpr;   // sizes are CSS px; dpr turns them into device px
  varying vec3 vC; varying float vK;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float ps = fixedPx > 0.5 ? size * dpr : size * sizeK * pxScale / max(-mv.z, 1e-9);
    gl_PointSize = clamp(ps, minPx * dpr, maxPx * dpr);
    vK = fixedPx > 0.5 ? 1.0 : clamp(ps / (minPx * dpr), 0.0, 1.0);   // too small: fade instead of shrinking
    vC = color;
  }`;
const ptsFS = `
  uniform float alpha; varying vec3 vC; varying float vK;
  void main() {
    vec2 q = gl_PointCoord - 0.5; float d = dot(q, q) * 4.0;
    float a = exp(-d * 4.0) + 0.25 * exp(-d * 0.9);
    gl_FragColor = vec4(vC * a * alpha * vK, 1.0);
  }`;

function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r()); }
function bv2rgb(bv) {
  const t = Math.max(-0.4, Math.min(2, bv));
  const r = t < 0.4 ? 0.62 + 0.38 * (t + 0.4) / 0.8 : 1, g = t < 0.4 ? 0.75 + 0.2 * (t + 0.4) / 0.8 : 0.95 - 0.3 * (t - 0.4) / 1.6, b = t < 0.0 ? 1 : 1 - 0.65 * Math.min(1, t / 1.8);
  return [r, g, b];
}

// spiral arms (shared by the painted disc and the 3D sparkle): radius as a fraction of the texture, about 300° of winding
const ARM = { wind: 2.2, tmax: 2.45, pitch: 0.3 };
const armR = (t) => 0.085 * Math.exp(ARM.pitch * t * ARM.wind);
// texture angle of the Sun: 26,000 ly out (t ≈ 1.42 → arm angle ≈ 3.12) and a little behind an arm, like the Orion spur
const MW_ROT = 3.3;

function galaxyTexture(seed, opts = {}) {
  const N = 1024, c = document.createElement("canvas"); c.width = c.height = N;
  const g = c.getContext("2d"), r = rng(seed), cx = N / 2;
  g.fillStyle = "#000"; g.fillRect(0, 0, N, N);
  g.globalCompositeOperation = "lighter";
  const blob = (x, y, rad, col, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  };
  // halo + bulge
  blob(cx, cx, N * 0.48, "120,140,190", 0.12);
  blob(cx, cx, N * 0.16, "255,214,160", 0.55);
  blob(cx, cx, N * 0.06, "255,236,200", 0.8);
  // a bar
  for (let k = 0; k < 160; k++) { const t = (r() - 0.5) * 2, w = gauss(r) * 0.02; blob(cx + t * N * 0.11 + w * N, cx + t * N * 0.05 * (opts.bar || 1) + gauss(r) * N * 0.012, N * 0.03, "255,210,150", 0.06); }
  // arms: logarithmic spirals, trailing; bright blue knots + pink nebulae + dust
  const arms = opts.arms || 4;
  for (let a = 0; a < arms; a++) {
    const off = (a / arms) * Math.PI * 2 + (r() - 0.5) * 0.3, strong = a % 2 === 0 ? 1 : 0.6;
    for (let k = 0; k < 3200; k++) {
      const t = Math.pow(r(), 0.85) * ARM.tmax, rad = N * armR(t);
      if (rad > N * 0.47) continue;
      const spread = N * 0.016 * (0.6 + t * 0.35);
      const th = off + t * ARM.wind + gauss(r) * 0.06, x = cx + Math.cos(th) * rad + gauss(r) * spread, y = cx + Math.sin(th) * rad + gauss(r) * spread;
      const pick = r();
      if (pick < 0.06) blob(x, y, 2 + r() * 5, "255,140,190", 0.4 * strong);
      else if (pick < 0.46) blob(x, y, 1.5 + r() * 3.5, "200,222,255", 0.4 * strong);
      else blob(x, y, 10 + r() * 26, "140,165,230", 0.05 * strong);
    }
  }
  // a faint sea of old stars between the arms
  for (let k = 0; k < 2500; k++) { const rad = Math.abs(gauss(r)) * N * 0.17, th = r() * 6.283; blob(cx + Math.cos(th) * rad, cx + Math.sin(th) * rad, 1 + r() * 2.5, "255,235,210", 0.25); }
  // dust lanes (darken)
  g.globalCompositeOperation = "multiply";
  // thin, soft lanes on the inner edge of each arm
  for (let a = 0; a < arms; a++) {
    const off = (a / arms) * Math.PI * 2 - 0.14;
    for (let k = 0; k < 1400; k++) {
      const t = 0.15 + r() * (ARM.tmax - 0.3), rad = N * armR(t);
      if (rad > N * 0.44) continue;
      const th = off + t * ARM.wind + gauss(r) * 0.025, x = cx + Math.cos(th) * rad, y = cx + Math.sin(th) * rad, s = 3 + r() * 6;
      const gr = g.createRadialGradient(x, y, 0, x, y, s);
      gr.addColorStop(0, "rgba(130,110,100,0.13)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(x - s, y - s, s * 2, s * 2);
    }
  }
  // fade the square's edge
  g.globalCompositeOperation = "destination-in";
  const m = g.createRadialGradient(cx, cx, N * 0.3, cx, cx, N * 0.5);
  m.addColorStop(0, "rgba(0,0,0,1)"); m.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = m; g.fillRect(0, 0, N, N);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function blobTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.3, "rgba(255,255,255,0.35)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class Cosmos {
  constructor(renderer, lowPower) {
    this.renderer = renderer;
    this.low = lowPower;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1e-6, 1e7);
    this.level = 0; this.skyK = 1; this.sysK = 1; this.lg = -9;
    this.layers = {};
    this.mats = [];
    this.target = new THREE.Vector3();
    this.labels = [];
    this.labelEl = document.createElement("div");
    this.labelEl.className = "clabels";
    document.querySelector(".labels").appendChild(this.labelEl);
    this.built = new Set();
  }

  points(n, opts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("size", new THREE.BufferAttribute(new Float32Array(n), 1));
    const u = { pxScale: { value: 1 }, sizeK: { value: 1 }, minPx: { value: opts.minPx ?? 1.2 }, maxPx: { value: opts.maxPx ?? 64 }, fixedPx: { value: opts.fixed ? 1 : 0 }, dpr: { value: 1 }, alpha: { value: 1 } };
    const p = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: u, vertexShader: ptsVS, fragmentShader: ptsFS, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    p.frustumCulled = false;
    this.mats.push(u);
    p.userData.u = u;
    return p;
  }

  layer(key) {
    if (this.layers[key]) return this.layers[key];
    const grp = new THREE.Group();
    grp.userData.items = [];
    this.scene.add(grp);
    this.layers[key] = grp;
    this["build_" + key](grp);
    return grp;
  }
  add(grp, obj, base) { obj.userData.base = base ?? 1; grp.add(obj); grp.userData.items.push(obj); return obj; }
  label(key, pos, lg, opts = {}) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "clbl" + (opts.here ? " is-here" : "") + (opts.big ? " is-big" : "");
    el.innerHTML = "<i></i><span></span>";
    el.addEventListener("click", () => this.onPick && this.onPick(opts.card || LBY[key] || null));
    this.labelEl.appendChild(el);
    this.labels.push({ el, pos: pos.clone(), lg, name: opts.name, card: opts.card, here: opts.here, big: opts.big });
    this.order = null;
  }

  /* ---------- layers ---------- */
  build_helio(grp) {
    // the heliosphere: a comet-shaped bubble, nose towards the interstellar wind (ecliptic lon 255°, lat 5°)
    const AU = 1 / LY, g = new THREE.SphereGeometry(1, 64, 48), p = g.attributes.position;
    for (let k = 0; k < p.count; k++) { const z = p.getZ(k); p.setZ(k, z > 0 ? z * 2.4 : z); }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { alpha: { value: 1 } },
      vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
      fragmentShader: "uniform float alpha; varying vec3 vN; varying vec3 vV; void main(){ float f = 1.0 - abs(dot(vN, vV)); gl_FragColor = vec4(vec3(0.35,0.55,1.0) * pow(f, 2.5) * 0.9 * alpha, 1.0); }"
    }));
    m.userData.u = m.material.uniforms;
    const lon = (255 * Math.PI) / 180, lat = (5 * Math.PI) / 180;
    const nose = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), nose);
    m.scale.setScalar(120 * AU);
    this.add(grp, m);
    const ts = m.clone(); ts.material = m.material.clone(); ts.userData.u = ts.material.uniforms; ts.scale.setScalar(90 * AU);
    this.add(grp, ts, 0.5);
    // Voyagers
    const v1 = V(radec2w(257.5, 12.1, 170 * AU)), v2 = V(radec2w(300.0, -59.5, 142 * AU));
    const pts = this.points(2, { fixed: true, minPx: 1, maxPx: 8 });
    const a = pts.geometry.attributes;
    a.position.setXYZ(0, v1.x, v1.y, v1.z); a.position.setXYZ(1, v2.x, v2.y, v2.z);
    for (const k of [0, 1]) { a.color.setXYZ(k, 0.9, 0.95, 1); a.size.setX(k, 6); }
    this.add(grp, pts);
    const VOY = T("A robot from Earth, launched in 1977 – the farthest thing people ever built. It carries a golden record with music and greetings.",
      "Ein Roboter von der Erde, 1977 gestartet – das Fernste, was Menschen je gebaut haben. Er trägt eine goldene Schallplatte mit Musik und Grüßen.");
    this.label("helio", v1, [-2.35, -1.6], { name: T("Voyager 1", "Voyager 1"), card: { name: T("Voyager 1", "Voyager 1"), scale: T("~170 AU from the Sun", "~170 AE von der Sonne"), kid: VOY, fun: LBY.helio.fun } });
    this.label("helio", v2, [-2.35, -1.6], { name: T("Voyager 2", "Voyager 2"), card: { name: T("Voyager 2", "Voyager 2"), scale: T("~142 AU from the Sun", "~142 AE von der Sonne"), kid: VOY } });
    this.label("helio", nose.clone().multiplyScalar(120 * AU), [-2.35, -1.85], { name: LBY.helio.name });
  }

  build_oort(grp) {
    const n = this.low ? 9000 : 20000, pts = this.points(n, { fixed: true, minPx: 0.5, maxPx: 4 }), a = pts.geometry.attributes, r = rng(31), AU = 1 / LY;
    for (let k = 0; k < n; k++) {
      const inner = k < n * 0.3;
      const rad = (inner ? 2000 + r() * 18000 : 20000 + Math.pow(r(), 0.6) * 80000) * AU;
      const u = r() * 2 - 1, th = r() * Math.PI * 2, q = Math.sqrt(1 - u * u);
      const flat = inner ? 0.35 : 1;
      a.position.setXYZ(k, rad * q * Math.cos(th), rad * u * flat, rad * q * Math.sin(th));
      const b = 0.45 + r() * 0.45;
      a.color.setXYZ(k, b * 0.75, b * 0.88, b);
      a.size.setX(k, 2 + r() * 1.5);
    }
    this.add(grp, pts);
    // a faint icy glow so the whole cloud reads as a ball from outside
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: blobTexture(), color: 0x5a7cc0, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    glow.scale.setScalar(3.4); glow.userData.mat = glow.material;
    this.add(grp, glow, 0.2);
    this.label("oort", V([0.55, 0.25, -0.5]), [-1.6, -0.4], { name: LBY.oort.name });
  }

  build_stars(grp) {
    const pts = this.points(1, { fixed: true, minPx: 1, maxPx: 9 });
    this.add(grp, pts);
    this.starsPts = pts;
    fetch(new URL("./stars.json", import.meta.url)).then((r) => r.json()).then((j) => {
      const S = j.stars, n = S.length + 1, g = pts.geometry;
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), o = [0, 0, 0];
      // the Sun itself
      col.set([1, 0.9, 0.7], 0); size[0] = 5;
      const want = new Set(["Proxima Centauri", "Alpha Centauri A", "Barnard's Star", "Sirius", "Wolf 359", "Procyon", "Epsilon Eridani", "Tau Ceti", "61 Cygni A",
        "Vega", "Altair", "Arcturus", "Aldebaran", "Fomalhaut", "Pollux", "Capella", "Regulus", "Betelgeuse", "Rigel", "Deneb", "Polaris", "Antares", "Canopus", "Spica"]);
      S.forEach((s, i) => {
        eq2w(s[0], s[1], s[2], o);
        pos.set(o, (i + 1) * 3);
        const c = bv2rgb(s[3]), L = Math.pow(10, (4.8 - s[4]) / 2.5);
        const br = Math.min(1, 0.35 + 0.18 * Math.log10(1 + L * 3));
        col.set([c[0] * br, c[1] * br, c[2] * br], (i + 1) * 3);
        size[i + 1] = Math.min(9, 2.2 + Math.log10(1 + L) * 1.6);
        if (want.has(s[5])) {
          const d = Math.hypot(s[0], s[1], s[2]);
          const name = s[5] === "Alpha Centauri A" ? "Alpha Centauri" : s[5];
          this.label("stars", V(o), d < 13 ? [-0.7, 1.9] : d < 120 ? [0.6, 2.6] : [1.9, 3.7], { name: T(name, DE_STAR[name] || name), card: starCard(name, d) });
        }
      });
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    });
    this.label("stars", new THREE.Vector3(), [-1.2, 3.0], { name: T("Sun", "Sonne"), here: true, card: LBY.stars });
  }

  build_disk(grp) {
    // a statistical neighbourhood: the thin disc of stars around us out to ~7,000 ly
    const n = this.low ? 12000 : 26000, pts = this.points(n, { fixed: true, minPx: 0.6, maxPx: 3 }), a = pts.geometry.attributes, r = rng(77);
    const { e1, e2, e3 } = this.galBasis();
    for (let k = 0; k < n; k++) {
      const rad = 30 + Math.pow(r(), 0.6) * 7000, th = r() * Math.PI * 2, z = gauss(r) * (300 + rad * 0.05);
      const p = e1.clone().multiplyScalar(Math.cos(th) * rad).addScaledVector(e2, Math.sin(th) * rad).addScaledVector(e3, z);
      a.position.setXYZ(k, p.x, p.y, p.z);
      const c = bv2rgb(r() * 1.6 - 0.1), b = 0.4 + Math.pow(r(), 4) * 0.6;
      a.color.setXYZ(k, c[0] * b, c[1] * b, c[2] * b);
      a.size.setX(k, 1 + Math.pow(r(), 3) * 2);
    }
    this.add(grp, pts);
  }

  // camera direction (from target to camera) that shows the galaxy from above, at an angle
  galaxyView() {
    const { e1, e3 } = this.galBasis();
    return e3.clone().multiplyScalar(Math.sin(1.0)).addScaledVector(e1, -Math.cos(1.0)).normalize();
  }

  // camera direction for the Local Group: the Milky Way–Andromeda line runs along the long side of the screen
  lgView(portrait) {
    const axis = M31.clone().normalize(), up = new THREE.Vector3(0, 1, 0);
    if (!portrait) return new THREE.Vector3().crossVectors(axis, up).normalize().addScaledVector(up, 0.6).normalize();
    const h = axis.clone().addScaledVector(up, -axis.y).normalize();       // the line's horizontal part
    return up.multiplyScalar(Math.hypot(axis.x, axis.z)).addScaledVector(h, -axis.y).normalize();   // ⟂ the line, in its vertical plane
  }

  galBasis() {
    if (this._gb) return this._gb;
    const e1 = GC.clone().normalize(), ngp = V(gal2w(0, 90, 1));
    const e3 = ngp.sub(e1.clone().multiplyScalar(ngp.dot(e1))).normalize(), e2 = new THREE.Vector3().crossVectors(e3, e1);
    return (this._gb = { e1, e2, e3 });
  }

  galaxyMesh(tex, sizeLy, center, X, Y, alpha = 1) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(sizeLy, sizeLy), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: alpha }));
    const Z = new THREE.Vector3().crossVectors(X, Y);
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
    m.position.copy(center);
    m.userData.mat = m.material;
    return m;
  }

  build_mw(grp) {
    const { e1, e2, e3 } = this.galBasis();
    const tex = galaxyTexture(7, { arms: 4 });
    this.mwTex = tex;
    // the texture's +x points from the centre towards the Sun's side: put the Sun on an arm edge (Orion spur)
    const rot = MW_ROT, X = e1.clone().multiplyScalar(-Math.cos(rot)).addScaledVector(e2, -Math.sin(rot)), Y = new THREE.Vector3().crossVectors(e3, X);
    this.add(grp, this.galaxyMesh(tex, 120000, GC, X, Y, 1));
    // 3D sparkle: stars sampled along the same arms, a thin disc and a fat bulge
    const n = this.low ? 14000 : 32000, pts = this.points(n, { minPx: 0.7, maxPx: 3.5 }), a = pts.geometry.attributes, r = rng(5);
    for (let k = 0; k < n; k++) {
      let x, y, z, c;
      if (k < n * 0.2) {
        const rr = Math.abs(gauss(r)) * 3500; const u = r() * 2 - 1, th = r() * 6.283, q = Math.sqrt(1 - u * u);
        x = rr * q * Math.cos(th); y = rr * q * Math.sin(th) * 1.0; z = rr * u * 0.55; c = [1, 0.82, 0.6];
      } else {
        const arm = Math.floor(r() * 4), t = Math.pow(r(), 0.85) * ARM.tmax, rad = 120000 * armR(t) * (1 + gauss(r) * 0.06);
        if (rad > 56000) { k--; continue; }
        const th = (arm / 4) * Math.PI * 2 + t * ARM.wind + gauss(r) * 0.08;
        x = Math.cos(th) * rad; y = Math.sin(th) * rad; z = gauss(r) * 400; c = r() < 0.1 ? [1, 0.6, 0.75] : [0.72, 0.82, 1];
      }
      // texture space (x,y) -> world, same orientation as the textured disc
      const p = GC.clone().addScaledVector(X, x).addScaledVector(Y, -y).addScaledVector(e3, z);
      a.position.setXYZ(k, p.x, p.y, p.z);
      const b = 0.25 + r() * 0.5;
      a.color.setXYZ(k, c[0] * b, c[1] * b, c[2] * b);
      a.size.setX(k, 30 + r() * 70);
    }
    this.add(grp, pts, 0.45);
    this.label("mw", new THREE.Vector3(), [3.0, 6.9], { name: T("You are here", "Du bist hier"), here: true, card: LBY.mw });
    this.label("mw", GC, [3.9, 5.5], { name: T("Galactic centre", "Zentrum der Galaxie"),
      card: { name: T("Sagittarius A*", "Sagittarius A*"), scale: T("26,000 light-years away", "26.000 Lichtjahre entfernt"),
        kid: T("In the very middle of our galaxy sits a giant black hole. It's so heavy that nothing – not even light – can escape it.", "Ganz in der Mitte unserer Galaxie sitzt ein riesiges Schwarzes Loch. Es ist so schwer, dass nichts entkommt – nicht einmal Licht."),
        fun: T("It weighs as much as 4 million Suns, and astronomers took its photo in 2022.", "Es wiegt so viel wie 4 Millionen Sonnen, und 2022 haben Astronomen ein Foto davon gemacht.") } });
  }

  build_lg(grp) {
    const tex = this.mwTex || galaxyTexture(7);
    const plane = (pos, inc, pa, size, tint) => {
      const d = pos.clone().normalize(), zN = V(eq2w(0, 0, 1, [0, 0, 0]));
      const north = zN.clone().sub(d.clone().multiplyScalar(zN.dot(d))).normalize(), east = new THREE.Vector3().crossVectors(zN, d).normalize();
      const P = (pa * Math.PI) / 180, I = (inc * Math.PI) / 180;
      const major = north.clone().multiplyScalar(Math.cos(P)).addScaledVector(east, Math.sin(P));
      const minor = north.clone().multiplyScalar(-Math.sin(P)).addScaledVector(east, Math.cos(P));
      const nrm = d.clone().multiplyScalar(-Math.cos(I)).addScaledVector(minor, Math.sin(I)).normalize();
      const Y = new THREE.Vector3().crossVectors(nrm, major).normalize();
      const m = this.galaxyMesh(tex, size, pos, major, Y, 1);
      m.material.color.setRGB(...tint);
      return m;
    };
    this.add(grp, plane(M31, 77, 38, 260000, [1, 0.95, 0.9]));
    this.add(grp, plane(M33, 54, 23, 70000, [0.85, 0.9, 1]));
    // soft halos so galaxies still read as glows when they're only a few pixels big
    const halo = new THREE.SpriteMaterial({ map: blobTexture(), color: 0x8fa6d8, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, opacity: 0.5 });
    for (const [p, s] of [[M31, 5e5], [M33, 1.6e5], [new THREE.Vector3(), 3e5]]) {
      const h = new THREE.Sprite(halo.clone()); h.position.copy(p); h.scale.setScalar(s); h.userData.mat = h.material; this.add(grp, h, 0.35);
    }
    // Magellanic clouds + dwarfs as glowing clumps
    const n = this.low ? 4000 : 8000, pts = this.points(n, { minPx: 0.8, maxPx: 10 }), a = pts.geometry.attributes, r = rng(9);
    const dwarfs = [];
    for (let k = 0; k < 60; k++) {
      const host = r() < 0.5 ? new THREE.Vector3() : M31, rad = 2e5 + Math.pow(r(), 0.7) * 1.2e6;
      const u = r() * 2 - 1, th = r() * 6.283, q = Math.sqrt(1 - u * u);
      dwarfs.push(host.clone().add(new THREE.Vector3(q * Math.cos(th), u, q * Math.sin(th)).multiplyScalar(rad)));
    }
    for (let k = 0; k < n; k++) {
      let p, s = 200, c = [0.8, 0.85, 1];
      if (k < n * 0.35) p = LMC.clone().add(new THREE.Vector3(gauss(r) * 5000, gauss(r) * 2500, gauss(r) * 4000));
      else if (k < n * 0.5) p = SMC.clone().add(new THREE.Vector3(gauss(r) * 3000, gauss(r) * 2000, gauss(r) * 3000));
      else { const dw = dwarfs[k % dwarfs.length]; p = dw.clone().add(new THREE.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(1500)); s = 300; c = [1, 0.9, 0.75]; }
      a.position.setXYZ(k, p.x, p.y, p.z);
      const b = 0.2 + r() * 0.4;
      a.color.setXYZ(k, c[0] * b, c[1] * b, c[2] * b);
      a.size.setX(k, s * (0.5 + r()));
    }
    this.add(grp, pts);
    // the Milky Way itself, seen from outside (only once the galaxy layer has faded)
    const { e1, e2, e3 } = this.galBasis();
    const rot = MW_ROT, X = e1.clone().multiplyScalar(-Math.cos(rot)).addScaledVector(e2, -Math.sin(rot)), Y = new THREE.Vector3().crossVectors(e3, X);
    this.add(grp, this.galaxyMesh(tex, 120000, GC, X, Y, 1));
    const card = (en, de, s, kid) => ({ name: T(en, de), scale: s, kid });
    this.label("lg", M31, [5.7, 7.5], { name: T("Andromeda", "Andromeda"), card: card("Andromeda Galaxy", "Andromeda-Galaxie", T("2.5 million light-years", "2,5 Millionen Lichtjahre"), LBY.lg.kid) });
    this.label("lg", M33, [5.9, 6.7], { name: T("Triangulum", "Dreiecksnebel"), card: card("Triangulum Galaxy", "Dreiecksgalaxie", T("2.7 million light-years", "2,7 Millionen Lichtjahre"),
      T("The third-biggest galaxy in our Local Group – a pretty little spiral.", "Die drittgrößte Galaxie unserer Lokalen Gruppe – eine hübsche kleine Spirale.")) });
    const MC = T("A small galaxy that circles our Milky Way. From the southern half of Earth you can see it at night as a faint cloud.", "Eine kleine Galaxie, die um unsere Milchstraße kreist. Von der Südhalbkugel sieht man sie nachts als blasse Wolke.");
    this.label("lg", LMC, [5.1, 6.4], { name: T("Large Magellanic Cloud", "Große Magellansche Wolke"), card: card("Large Magellanic Cloud", "Große Magellansche Wolke", T("160,000 light-years", "160.000 Lichtjahre"), MC) });
    this.label("lg", SMC, [5.3, 6.3], { name: T("Small Magellanic Cloud", "Kleine Magellansche Wolke"), card: card("Small Magellanic Cloud", "Kleine Magellansche Wolke", T("200,000 light-years", "200.000 Lichtjahre"), MC) });
  }

  build_virgo(grp) {
    const n = this.low ? 9000 : 20000, pts = this.points(n, { minPx: 0.7, maxPx: 8 }), a = pts.geometry.attributes, r = rng(13);
    // the Local Supercluster is a flattened pancake around Virgo; we sit near its edge
    const nrm = V(gal2w(47.4, 6.3, 1)).cross(VIRGO.clone().normalize()).normalize();       // roughly the supergalactic pole
    const u = VIRGO.clone().normalize(), w = new THREE.Vector3().crossVectors(nrm, u);
    const groups = [];
    for (let k = 0; k < 90; k++) {
      const rad = Math.pow(r(), 0.7) * 6e7, th = r() * 6.283;
      groups.push(VIRGO.clone().addScaledVector(u, Math.cos(th) * rad).addScaledVector(w, Math.sin(th) * rad).addScaledVector(nrm, gauss(r) * 6e6));
    }
    for (let k = 0; k < n; k++) {
      let p;
      const pick = r();
      if (pick < 0.3) p = VIRGO.clone().add(new THREE.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(4.5e6));
      else if (pick < 0.38) p = FORNAX.clone().add(new THREE.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(2.5e6));
      else p = groups[Math.floor(r() * groups.length)].clone().add(new THREE.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(1.6e6));
      a.position.setXYZ(k, p.x, p.y, p.z);
      const b = 0.35 + Math.pow(r(), 2) * 0.65, warm = r() < 0.5;
      a.color.setXYZ(k, (warm ? 1 : 0.8) * b, (warm ? 0.88 : 0.88) * b, (warm ? 0.72 : 1) * b);
      a.size.setX(k, 1.2e5 * (0.4 + r()));
    }
    this.add(grp, pts);
    this.label("virgo", VIRGO, [7.1, 8.6], { name: T("Virgo Cluster", "Virgo-Haufen"), card: LBY.virgo });
    this.label("virgo", FORNAX, [7.4, 8.5], { name: T("Fornax Cluster", "Fornax-Haufen"), card: LBY.virgo });
    this.label("virgo", new THREE.Vector3(), [6.9, 9.6], { name: T("You are here", "Du bist hier"), here: true, card: LBY.virgo });
  }

  web(n, R, nodes, seed, center) {
    const pts = this.points(n, { minPx: 0.7, maxPx: 7 }), a = pts.geometry.attributes, r = rng(seed);
    const N = [];
    for (let k = 0; k < nodes; k++) {
      const u = r() * 2 - 1, th = r() * 6.283, q = Math.sqrt(1 - u * u), rad = R * Math.cbrt(r());
      N.push(new THREE.Vector3(q * Math.cos(th), u, q * Math.sin(th)).multiplyScalar(rad).add(center));
    }
    // filaments: each node links to its 3 nearest neighbours
    const edges = [];
    for (let i = 0; i < nodes; i++) {
      const d = N.map((p, j) => [p.distanceToSquared(N[i]), j]).sort((x, y) => x[0] - y[0]);
      for (let k = 1; k <= 3; k++) if (i < d[k][1]) edges.push([i, d[k][1]]);
    }
    const spacing = R / Math.cbrt(nodes);
    for (let k = 0; k < n; k++) {
      let p;
      if (r() < 0.3) p = N[Math.floor(r() * nodes)].clone().add(new THREE.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(spacing * 0.06));
      else {
        const [i, j] = edges[Math.floor(r() * edges.length)], t = r();
        p = N[i].clone().lerp(N[j], t).add(new THREE.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(spacing * 0.035));
      }
      a.position.setXYZ(k, p.x, p.y, p.z);
      const b = 0.18 + Math.pow(r(), 2) * 0.5, hue = r();
      a.color.setXYZ(k, (0.75 + hue * 0.25) * b, (0.78 + 0.1 * hue) * b, (1 - hue * 0.2) * b);
      a.size.setX(k, spacing * 0.02 * (0.5 + r()));
    }
    return pts;
  }

  build_web(grp) {
    this.add(grp, this.web(this.low ? 22000 : 50000, 1.6e9, 420, 21, GA.clone().multiplyScalar(0.6)), 1.3);
    this.label("web", GA, [8.3, 9.4], { name: T("Laniakea", "Laniakea"), card: LBY.web });
    this.label("web", new THREE.Vector3(), [9.4, 11.5], { name: T("You are here", "Du bist hier"), here: true, card: LBY.universe });
  }

  build_universe(grp) {
    const R = 4.65e10;
    this.add(grp, this.web(this.low ? 26000 : 60000, R * 0.97, 1600, 99, new THREE.Vector3()), 1.6);
    const m = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { alpha: { value: 1 } },
      vertexShader: "varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vP = normalize(position); vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
      fragmentShader: `uniform float alpha; varying vec3 vN; varying vec3 vV; varying vec3 vP;
        float h(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float n3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(h(i), h(i+vec3(1,0,0)), f.x), mix(h(i+vec3(0,1,0)), h(i+vec3(1,1,0)), f.x), f.y),
                     mix(mix(h(i+vec3(0,0,1)), h(i+vec3(1,0,1)), f.x), mix(h(i+vec3(0,1,1)), h(i+vec3(1,1,1)), f.x), f.y), f.z); }
        void main(){
          float t = n3(vP * 6.0) * 0.6 + n3(vP * 14.0) * 0.3 + n3(vP * 31.0) * 0.1;
          vec3 cmb = mix(vec3(0.15, 0.3, 0.9), vec3(1.0, 0.55, 0.2), smoothstep(0.35, 0.65, t));
          float f = 1.0 - abs(dot(vN, vV));
          gl_FragColor = vec4(cmb * (0.05 + 0.4 * pow(f, 3.0)) * alpha, 1.0);
        }`
    }));
    m.userData.u = m.material.uniforms;
    this.add(grp, m);
    this.label("universe", V(radec2w(30, 20, R)), [10.2, 13], { name: LBY.universe.name, big: true });
    this.label("universe", V(radec2w(210, -30, R)), [10.4, 13], { name: T("The edge we can see", "Der Rand, den wir sehen"),
      card: { name: T("Cosmic microwave background", "Kosmische Hintergrundstrahlung"), scale: T("13.8 billion years old light", "13,8 Milliarden Jahre altes Licht"),
        kid: T("The oldest light there is – a glow left over from when the universe was a baby, just 380,000 years old.", "Das älteste Licht, das es gibt – ein Leuchten aus der Zeit, als das Universum ein Baby war, erst 380.000 Jahre alt."),
        fun: T("Its tiny warm and cool spots (drawn here as orange and blue) became the seeds of all galaxies.", "Seine winzigen warmen und kühlen Flecken (hier orange und blau) wurden zu den Keimen aller Galaxien.") } });
  }

  /* ---------- per frame ---------- */
  // D: light-years from the camera to its target (0 = still inside the solar system)
  update(D, cam, dt, W, H) {
    const lg = D > 0 ? L10(D) : -9;
    this.lg = lg; this.D = D;
    this.level = smooth(-2.45, -2.1, lg);   // cosmic titles start just beyond a view of all the planets
    this.sysK = 1 - smooth(-2.4, -1.5, lg);
    this.skyK = 1 - smooth(-1.4, 0.5, lg);
    this.W = W; this.H = H;
    if (lg < -4) { this.active = false; return; }
    this.active = true;
    // which way the view drifts: Sun → galactic centre → Local Group → (Virgo) → back to us
    const t = this.target.set(0, 0, 0);
    t.addScaledVector(GC, smooth(4.2, 5.4, lg) * (1 - smooth(5.5, 6.2, lg)));
    t.addScaledVector(LG, smooth(6.0, 6.9, lg) * (1 - smooth(7.2, 7.8, lg)));
    t.addScaledVector(VIRGO, 0.5 * smooth(7.0, 7.8, lg) * (1 - smooth(8.4, 9.4, lg)));
    t.addScaledVector(GA, 0.5 * smooth(8.2, 8.9, lg) * (1 - smooth(9.4, 10.2, lg)));
    const s = 1 / D;
    const vis = {
      helio: band(lg, [-2.45, -2.15, -1.9, -1.3]), oort: band(lg, [-2.4, -1.6, 0.0, 0.8]), stars: band(lg, [-2.4, -1.2, 2.7, 3.5]),
      disk: band(lg, [1.7, 2.5, 3.9, 4.6]), mw: band(lg, [3.5, 4.1, 5.4, 6.0]), lg: band(lg, [5.0, 5.8, 7.0, 7.7]),
      virgo: band(lg, [6.7, 7.4, 8.5, 9.1]), web: band(lg, [8.0, 8.7, 9.6, 10.4]), universe: band(lg, [9.4, 10.1, 13, 14])
    };
    this.vis = vis;
    const pxScale = (H * this.renderer.getPixelRatio()) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    for (const key in vis) {
      if (vis[key] <= 0.001) { if (this.layers[key]) this.layers[key].visible = false; continue; }
      const grp = this.layer(key);
      grp.visible = true;
      grp.scale.setScalar(s);
      grp.position.copy(t).multiplyScalar(-s);
      for (const o of grp.userData.items) {
        const a = vis[key] * o.userData.base;
        if (o.userData.u) {
          const u = o.userData.u;
          if (u.alpha) u.alpha.value = a;
          if (u.pxScale) { u.pxScale.value = pxScale; u.sizeK.value = s; u.dpr.value = this.renderer.getPixelRatio(); }
        }
        if (o.userData.mat) o.userData.mat.opacity = a;
      }
    }
    // the painted galaxy only comes in once it's small enough not to look blurry; the sparkle carries the zoom before that
    if (this.layers.mw) {
      const [disc, sparkle] = this.layers.mw.userData.items;
      disc.userData.mat.opacity = vis.mw * smooth(4.5, 5.05, lg);
      sparkle.userData.u.alpha.value = vis.mw * (0.35 + 0.65 * (1 - smooth(4.6, 5.3, lg)));
    }
    // the Milky Way disc inside the Local Group layer only appears once the galaxy layer is gone
    if (this.layers.lg) { const it = this.layers.lg.userData.items; it[it.length - 1].userData.mat.opacity = vis.lg * (1 - vis.mw); }
    this.camera.fov = cam.fov; this.camera.aspect = cam.aspect;
    this.camera.near = 1e-4; this.camera.far = 1e6;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(cam.position).normalize();
    this.camera.quaternion.copy(cam.quaternion);
    this.camera.updateMatrixWorld();
  }

  render(renderer) {
    if (!this.active) return;
    renderer.render(this.scene, this.camera);
  }

  current() {
    if (!this.active || this.level < 0.5) return null;
    let best = null;
    for (const L of LAYERS) if (this.lg >= L.lg[0]) best = L;
    return best;
  }

  placeLabels(W, H) {
    const on = this.active && this.level > 0.4;
    this.labelEl.style.display = on ? "" : "none";
    if (!on) return;
    const v = new THREE.Vector3(), s = 1 / this.D, lang = document.documentElement.lang === "de" ? "de" : "en";
    // keep clear of the title above and the time bar + strip below; "you are here" wins, then the order labels were made in
    const top = W < 700 ? 215 : 120, bottom = H - (W < 700 ? 185 : 150), boxes = [];
    if (!this.order) this.order = [...this.labels].sort((a, b) => (b.here ? 1 : 0) - (a.here ? 1 : 0));
    for (const l of this.order) {
      let vis = this.lg > l.lg[0] && this.lg < l.lg[1];
      if (vis) {
        v.copy(l.pos).sub(this.target).multiplyScalar(s).applyMatrix4(this.camera.matrixWorldInverse).applyMatrix4(this.camera.projectionMatrix);
        l.x = (v.x * 0.5 + 0.5) * W; l.y = (-v.y * 0.5 + 0.5) * H;
        vis = v.z < 1 && l.x > 4 && l.x < W - 4 && l.y > top && l.y < bottom;
      }
      if (vis) {
        const name = l.name[lang] || l.name.en, wpx = 22 + name.length * 8, left = !l.big && l.x + wpx > W - 6;   // near the right edge: text on the left
        const box = left ? [l.x - wpx, l.y - 10, l.x + 8, l.y + 10] : [l.x - 8, l.y - 10, l.x + wpx, l.y + 10];
        l.el.classList.toggle("is-left", left);
        vis = !boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
        if (vis) boxes.push(box);
      }
      l.el.classList.toggle("is-on", vis);
      if (!vis) continue;
      if (l.lang !== lang) { l.el.querySelector("span").textContent = l.name[lang] || l.name.en; l.lang = lang; }
      l.el.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px)`;
    }
  }

  pick(x, y) {
    if (!this.active || this.level < 0.4) return null;
    let best = null, bd = 34;
    for (const l of this.labels) {
      if (!l.el.classList.contains("is-on")) continue;
      const d = Math.hypot(l.x - x, l.y - y);
      if (d < bd) { bd = d; best = l; }
    }
    return best ? best.card || this.current() : null;
  }
}

const DE_STAR = { "Alpha Centauri": "Alpha Centauri", "Barnard's Star": "Barnards Stern", "Sirius": "Sirius", "Betelgeuse": "Beteigeuze", "Polaris": "Polarstern", "Vega": "Wega", "Arcturus": "Arktur", "Spica": "Spika", "Procyon": "Prokyon", "Tau Ceti": "Tau Ceti", "61 Cygni A": "61 Cygni" };
const STAR_KID = {
  "Proxima Centauri": T("The closest star to the Sun – a small red dwarf. It even has planets!", "Der nächste Stern nach der Sonne – ein kleiner roter Zwerg. Er hat sogar Planeten!"),
  "Alpha Centauri": T("Two Sun-like stars dancing around each other, very close to us.", "Zwei sonnenähnliche Sterne, die umeinander tanzen, ganz nah bei uns."),
  "Sirius": T("The brightest star in our night sky. Look for it in winter, below Orion!", "Der hellste Stern an unserem Nachthimmel. Im Winter unter dem Orion zu sehen!"),
  "Betelgeuse": T("A giant red star in Orion's shoulder – one day it will explode as a supernova.", "Ein riesiger roter Stern in Orions Schulter – eines Tages explodiert er als Supernova."),
  "Polaris": T("The North Star: it always stays in the same place in the sky, so sailors used it to find north.", "Der Polarstern: Er bleibt immer an derselben Stelle am Himmel, deshalb fanden Seefahrer mit ihm den Norden."),
  "Vega": T("A bright blue-white star, high in the summer sky.", "Ein heller blauweißer Stern, hoch am Sommerhimmel.")
};
function starCard(name, d) {
  const de = Math.round(d) + "", en = Math.round(d) + "";
  return { name: T(name, DE_STAR[name] || name), scale: T(`${d < 20 ? d.toFixed(1) : en} light-years away`, `${d < 20 ? d.toFixed(1).replace(".", ",") : de} Lichtjahre entfernt`),
    kid: STAR_KID[name] || T(`Another sun! Its light needs ${Math.round(d)} years to reach us.`, `Noch eine Sonne! Ihr Licht braucht ${Math.round(d)} Jahre bis zu uns.`) };
}
