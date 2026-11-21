/* ============================================================
   Solar system data: where everything is (real positions for any
   date), how it spins, and what we tell kids and grown-ups about it.
   Frame ("world"): ecliptic J2000, x to the March equinox, +Y = ecliptic
   north, world = (x_ecl, z_ecl, -y_ecl). Distances in AU, radii in km.
   ============================================================ */

export const AU = 149597870.7;      // km
export const LY = 63241.077;        // AU
export const R_EARTH = 6371;        // km
export const D2R = Math.PI / 180;
const OBL = 23.43928 * D2R;         // obliquity J2000

export const days = (date) => date.getTime() / 864e5 - 10957.5; // days since J2000 (TT~UTC)

// equatorial (J2000) unit/vector -> world
export function eq2w(x, y, z, out) {
  const ye = Math.cos(OBL) * y + Math.sin(OBL) * z, ze = -Math.sin(OBL) * y + Math.cos(OBL) * z;
  out[0] = x; out[1] = ze; out[2] = -ye;
  return out;
}
export function radec2w(raDeg, decDeg, r, out) {
  const a = raDeg * D2R, d = decDeg * D2R;
  return eq2w(r * Math.cos(d) * Math.cos(a), r * Math.cos(d) * Math.sin(a), r * Math.sin(d), out || [0, 0, 0]);
}

/* JPL "Approximate positions of the planets" (Standish), valid 1800-2050, fine for a picture
   well beyond. a, e, I, L, long.peri, long.node + rates per Julian century. */
const KEP = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus:   [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
  earth:   [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  mars:    [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn:  [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  uranus:  [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  pluto:   [39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684, -0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482]
};

function solveKepler(M, e) {
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

// position on an orbit from elements (angles in degrees), mean anomaly M (rad) -> world [AU]
export function orbitPos(a, e, I, peri, node, M, out) {
  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const w = (peri - node) * D2R, O = node * D2R, i = I * D2R;
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i);
  const x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp;
  const y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp;
  const z = (sw * si) * xp + (cw * si) * yp;
  out[0] = x; out[1] = z; out[2] = -y;
  return out;
}

export function elements(id, d) {
  const k = KEP[id], T = d / 36525;
  return [k[0] + k[6] * T, k[1] + k[7] * T, k[2] + k[8] * T, k[3] + k[9] * T, k[4] + k[10] * T, k[5] + k[11] * T];
}

export function helio(id, d, out) {
  const [a, e, I, L, peri, node] = elements(id, d);
  return orbitPos(a, e, I, peri, node, ((L - peri) % 360) * D2R, out);
}

// geocentric Moon (low precision, ~0.3°), world [AU]
export function moonGeo(d, out) {
  const L = (218.316 + 13.176396 * d) * D2R, M = (134.963 + 13.064993 * d) * D2R, F = (93.272 + 13.229350 * d) * D2R;
  const lam = L + 6.289 * D2R * Math.sin(M), bet = 5.128 * D2R * Math.sin(F), r = (385001 - 20905 * Math.cos(M)) / AU;
  out[0] = r * Math.cos(bet) * Math.cos(lam); out[1] = r * Math.sin(bet); out[2] = -r * Math.cos(bet) * Math.sin(lam);
  return out;
}

/* IAU rotation (pole RA/Dec, prime meridian W0 + Wd*d). Gives the body-fixed axes in world:
   Y = north pole, X = longitude 0, -Z = 90°E — the same layout as /spacex/globe-core.js and
   three.js' SphereGeometry texture mapping. */
export function bodyAxes(b, d, W, out) {
  const p = radec2w(b.pole[0], b.pole[1], 1, [0, 0, 0]);
  const a = b.pole[0] * D2R;
  const n = eq2w(-Math.sin(a), Math.cos(a), 0, [0, 0, 0]);          // ascending node of the body equator
  const q = [p[1] * n[2] - p[2] * n[1], p[2] * n[0] - p[0] * n[2], p[0] * n[1] - p[1] * n[0]]; // p x n
  const c = Math.cos(W * D2R), s = Math.sin(W * D2R);
  const x = [n[0] * c + q[0] * s, n[1] * c + q[1] * s, n[2] * c + q[2] * s];
  const z = [x[1] * p[2] - x[2] * p[1], x[2] * p[0] - x[0] * p[2], x[0] * p[1] - x[1] * p[0]]; // x × y
  out.x = x; out.y = p; out.z = z;
  return out;
}
export const primeW = (b, d) => b.W[0] + b.W[1] * d;

/* ---------- the bodies ----------
   r km · pole/W IAU · day/year in Earth days · g in Earth g · moons known (NASA, 2026)
   temp °C · tex: texture key (1k loaded first, 2k when you get close) */
export const BODIES = [
  { id: "sun", kind: "star", r: 695700, pole: [286.13, 63.87], W: [84.176, 14.1844], tex: "sun", hi: false,
    day: 25.4, g: 27.9, temp: [5500], color: "#ffcf7a",
    name: { en: "Sun", de: "Sonne" } },
  { id: "mercury", kind: "planet", r: 2439.7, pole: [281.0103, 61.4155], W: [329.5988, 6.1385108], tex: "mercury", hi: true,
    day: 175.94, year: 87.97, moons: 0, g: 0.38, temp: [-173, 427], color: "#b4aca4", atmo: null,
    name: { en: "Mercury", de: "Merkur" } },
  { id: "venus", kind: "planet", r: 6051.8, pole: [272.76, 67.16], W: [160.2, -1.4813688], tex: "venus", hi: false,
    day: 116.75, year: 224.7, moons: 0, g: 0.9, temp: [464], color: "#e8cf98", atmo: [0.95, 0.82, 0.55, 0.55],
    name: { en: "Venus", de: "Venus" } },
  { id: "earth", kind: "planet", r: 6371, pole: [0, 90], W: [190.147, 360.9856235], tex: "earth", hi: true,
    day: 1, year: 365.26, moons: 1, g: 1, temp: [15], color: "#6f9fd8", atmo: [0.55, 0.7, 1.0, 0.6],
    name: { en: "Earth", de: "Erde" } },
  { id: "moon", kind: "moon", parent: "earth", r: 1737.4, pole: [269.9949, 66.5392], W: [38.3213, 13.17635815], tex: "moon", hi: true,
    day: 29.53, year: 27.32, g: 0.17, temp: [-173, 127], color: "#bdbab4", atmo: null,
    name: { en: "Moon", de: "Mond" } },
  { id: "mars", kind: "planet", r: 3389.5, pole: [317.269, 54.432], W: [176.049, 350.891983], tex: "mars", hi: true,
    day: 1.027, year: 686.98, moons: 2, g: 0.38, temp: [-63], color: "#d9805a", atmo: [0.95, 0.62, 0.45, 0.32],
    name: { en: "Mars", de: "Mars" } },
  { id: "jupiter", kind: "planet", r: 69911, pole: [268.057, 64.495], W: [284.95, 870.536], tex: "jupiter", hi: true,
    day: 0.4135, year: 4332.6, moons: 115, g: 2.53, temp: [-110], color: "#d8b892", atmo: [0.9, 0.82, 0.68, 0.3],
    name: { en: "Jupiter", de: "Jupiter" } },
  { id: "saturn", kind: "planet", r: 58232, pole: [40.589, 83.537], W: [38.9, 810.7939024], tex: "saturn", hi: true,
    day: 0.444, year: 10759, moons: 293, g: 1.07, temp: [-140], color: "#e3cf9e", atmo: [0.95, 0.86, 0.66, 0.28],
    ring: [74500, 140220], name: { en: "Saturn", de: "Saturn" } },
  { id: "uranus", kind: "planet", r: 25362, pole: [257.311, -15.175], W: [203.81, -501.1600928], tex: "uranus", hi: false,
    day: 0.718, year: 30687, moons: 29, g: 0.89, temp: [-195], color: "#a6dbe0", atmo: [0.62, 0.88, 0.95, 0.45],
    name: { en: "Uranus", de: "Uranus" } },
  { id: "neptune", kind: "planet", r: 24622, pole: [299.36, 43.46], W: [249.978, 541.1397757], tex: "neptune", hi: false,
    day: 0.671, year: 60190, moons: 16, g: 1.14, temp: [-200], color: "#5b7fe0", atmo: [0.45, 0.6, 1.0, 0.5],
    name: { en: "Neptune", de: "Neptun" } },
  { id: "pluto", kind: "dwarf", r: 1188.3, pole: [132.993, -6.163], W: [302.695, 56.3625225], tex: "pluto", hi: true,
    day: 6.39, year: 90560, moons: 5, g: 0.063, temp: [-230], color: "#d8c3aa", atmo: null,
    name: { en: "Pluto", de: "Pluto" } }
];
export const BY_ID = Object.fromEntries(BODIES.map((b) => [b.id, b]));

/* Small moons: drawn as tinted spheres, circular orbits in the parent's equator.
   a km, period days (negative = backwards), L0 = rough mean longitude at J2000. */
export const MOONS = [
  { id: "io", parent: "jupiter", r: 1821.6, a: 421700, P: 1.769138, L0: 106.08, color: [0.93, 0.8, 0.42], name: { en: "Io", de: "Io" } },
  { id: "europa", parent: "jupiter", r: 1560.8, a: 671034, P: 3.551181, L0: 175.73, color: [0.86, 0.8, 0.7], name: { en: "Europa", de: "Europa" } },
  { id: "ganymede", parent: "jupiter", r: 2634.1, a: 1070412, P: 7.154553, L0: 120.56, color: [0.62, 0.58, 0.53], name: { en: "Ganymede", de: "Ganymed" } },
  { id: "callisto", parent: "jupiter", r: 2410.3, a: 1882709, P: 16.689018, L0: 84.44, color: [0.42, 0.38, 0.34], name: { en: "Callisto", de: "Kallisto" } },
  { id: "titan", parent: "saturn", r: 2574.7, a: 1221870, P: 15.945421, L0: 15.15, color: [0.86, 0.62, 0.3], name: { en: "Titan", de: "Titan" } },
  { id: "triton", parent: "neptune", r: 1353.4, a: 354759, P: -5.876854, L0: 264.8, color: [0.82, 0.74, 0.7], name: { en: "Triton", de: "Triton" } },
  { id: "charon", parent: "pluto", r: 606, a: 19591, P: 6.387221, L0: 0, color: [0.66, 0.62, 0.6], name: { en: "Charon", de: "Charon" } }
];

export const HALLEY = { a: 17.834, e: 0.96714, I: 162.26, node: 58.42, w: 111.33, T: Date.UTC(1986, 1, 9) };
export function halleyPos(d, out) {
  const n = 360 / (365.25 * Math.pow(HALLEY.a, 1.5));
  const M = (n * (d - days(new Date(HALLEY.T)))) * D2R;
  return orbitPos(HALLEY.a, HALLEY.e, HALLEY.I, HALLEY.w + HALLEY.node, HALLEY.node, M, out);
}

/* ---------- landing spots ---------- */
export const LAND = {
  mercury: { lat: -5, lon: 160, place: { en: "Caloris rim", de: "Rand des Caloris-Beckens" } },
  venus:   { lat: -11, lon: 301, place: { en: "Venera 13 landing site", de: "Landeplatz von Venera 13" } },
  earth:   { lat: 48.21, lon: 16.37, place: { en: "Vienna", de: "Wien" } },
  moon:    { lat: 12.7, lon: 62.2, place: { en: "Sea of Crises (Luna 24)", de: "Meer der Gefahren (Luna 24)" } },
  mars:    { lat: 18.4, lon: 77.5, place: { en: "Jezero crater (Perseverance)", de: "Jezero-Krater (Perseverance)" } },
  jupiter: { lat: 22, lon: 30, place: { en: "in the clouds", de: "in den Wolken" }, gas: true },
  saturn:  { lat: 28, lon: 0, place: { en: "in the clouds", de: "in den Wolken" }, gas: true },
  uranus:  { lat: 10, lon: 0, place: { en: "in the clouds", de: "in den Wolken" }, gas: true },
  neptune: { lat: -20, lon: 0, place: { en: "in the clouds", de: "in den Wolken" }, gas: true },
  pluto:   { lat: 25, lon: 175, place: { en: "Sputnik Planitia, the heart", de: "Sputnik Planitia, das Herz" } }
};

/* ---------- words ----------
   kid: read aloud to a 2–6 year old. fun: for the grown-up. like: the size of a fruit
   if Earth were a cherry (2 cm). */
export const TEXT = {
  sun: {
    sub: { en: "Our star", de: "Unser Stern" },
    kid: { en: "The Sun is a giant ball of fire. It gives us light and keeps us warm. A million Earths would fit inside!",
           de: "Die Sonne ist ein riesiger Feuerball. Sie schenkt uns Licht und Wärme. Eine Million Erden würden hineinpassen!" },
    fun: { en: "Sunlight needs 8 minutes and 20 seconds to reach us – the light you see left the Sun before you blinked eight hundred times.",
           de: "Sonnenlicht braucht 8 Minuten und 20 Sekunden bis zu uns – das Licht, das du siehst, ist losgeflogen, bevor du achthundertmal geblinzelt hast." },
    like: ["🎪", { en: "as tall as a grown-up (2.2 m)", de: "so groß wie ein Erwachsener (2,2 m)" }]
  },
  mercury: {
    sub: { en: "The smallest, fastest planet", de: "Der kleinste, schnellste Planet" },
    kid: { en: "Mercury is the closest to the Sun. It races around it faster than every other planet!",
           de: "Merkur ist der Sonne am nächsten. Er saust schneller um sie herum als alle anderen Planeten!" },
    fun: { en: "One day on Mercury (sunrise to sunrise) lasts two of its years.",
           de: "Ein Tag auf Merkur (von Sonnenaufgang zu Sonnenaufgang) dauert zwei seiner Jahre." },
    like: ["🟢", { en: "a pea", de: "eine Erbse" }]
  },
  venus: {
    sub: { en: "The hottest planet", de: "Der heißeste Planet" },
    kid: { en: "Venus is wrapped in thick yellow clouds. Under them it is hotter than a pizza oven!",
           de: "Venus ist in dicke gelbe Wolken gehüllt. Darunter ist es heißer als in einem Pizzaofen!" },
    fun: { en: "Venus spins backwards and so slowly that its day is longer than its year. The Sun rises in the west.",
           de: "Venus dreht sich rückwärts und so langsam, dass ihr Tag länger ist als ihr Jahr. Die Sonne geht im Westen auf." },
    like: ["🍒", { en: "a cherry, almost like Earth", de: "eine Kirsche, fast wie die Erde" }]
  },
  earth: {
    sub: { en: "Our home", de: "Unser Zuhause" },
    kid: { en: "This is Earth – our home! It has oceans, trees, animals and you.",
           de: "Das ist die Erde – unser Zuhause! Hier gibt es Meere, Bäume, Tiere und dich." },
    fun: { en: "Earth is the only place we know with life – and with liquid water oceans on the outside.",
           de: "Die Erde ist der einzige Ort, von dem wir wissen, dass es Leben gibt – und Meere aus flüssigem Wasser an der Oberfläche." },
    like: ["🍒", { en: "a cherry (2 cm)", de: "eine Kirsche (2 cm)" }]
  },
  moon: {
    sub: { en: "Earth's companion", de: "Der Begleiter der Erde" },
    kid: { en: "The Moon goes around the Earth. Astronauts walked on it and left footprints that are still there!",
           de: "Der Mond kreist um die Erde. Astronauten sind auf ihm spaziert – ihre Fußspuren sind immer noch da!" },
    fun: { en: "The Moon always shows us the same face, and it drifts 3.8 cm farther away every year.",
           de: "Der Mond zeigt uns immer dieselbe Seite und entfernt sich jedes Jahr um 3,8 cm." },
    like: ["⚫", { en: "a peppercorn", de: "ein Pfefferkorn" }]
  },
  mars: {
    sub: { en: "The red planet", de: "Der rote Planet" },
    kid: { en: "Mars is red because its dust is rusty. Little robot cars drive around on it right now!",
           de: "Mars ist rot, weil sein Staub rostig ist. Gerade jetzt fahren kleine Roboterautos auf ihm herum!" },
    fun: { en: "Olympus Mons on Mars is the biggest volcano we know – almost three times as tall as Mount Everest.",
           de: "Olympus Mons auf dem Mars ist der größte bekannte Vulkan – fast dreimal so hoch wie der Mount Everest." },
    like: ["🫐", { en: "a blueberry", de: "eine Heidelbeere" }]
  },
  jupiter: {
    sub: { en: "The giant", de: "Der Riese" },
    kid: { en: "Jupiter is the biggest planet. It's made of clouds and has a storm bigger than the whole Earth!",
           de: "Jupiter ist der größte Planet. Er besteht aus Wolken und hat einen Sturm, der größer ist als die ganze Erde!" },
    fun: { en: "All the other planets together would still fit inside Jupiter – twice over.",
           de: "Alle anderen Planeten zusammen würden in Jupiter hineinpassen – sogar zweimal." },
    like: ["🍉", { en: "a watermelon (22 cm)", de: "eine Wassermelone (22 cm)" }]
  },
  saturn: {
    sub: { en: "The ringed planet", de: "Der Ringplanet" },
    kid: { en: "Saturn wears beautiful rings made of ice and rocks. It is so light, it could float in a giant bathtub!",
           de: "Saturn trägt wunderschöne Ringe aus Eis und Steinen. Er ist so leicht, dass er in einer Riesenbadewanne schwimmen würde!" },
    fun: { en: "The rings are almost 300,000 km wide but in places only about 10 m thick.",
           de: "Die Ringe sind fast 300.000 km breit, aber stellenweise nur etwa 10 m dick." },
    like: ["🥥", { en: "a coconut (19 cm, without rings)", de: "eine Kokosnuss (19 cm, ohne Ringe)" }]
  },
  uranus: {
    sub: { en: "The sideways planet", de: "Der gekippte Planet" },
    kid: { en: "Uranus rolls around the Sun lying on its side, like a ball rolling along!",
           de: "Uranus rollt auf der Seite liegend um die Sonne, wie ein Ball, der dahinkullert!" },
    fun: { en: "Because it's tipped over, each pole gets 42 years of daylight and then 42 years of night.",
           de: "Weil er umgekippt ist, hat jeder Pol 42 Jahre Tag und danach 42 Jahre Nacht." },
    like: ["🍊", { en: "an orange (8 cm)", de: "eine Orange (8 cm)" }]
  },
  neptune: {
    sub: { en: "The windy blue planet", de: "Der stürmische blaue Planet" },
    kid: { en: "Neptune is deep blue, icy cold and very, very windy. It's the farthest planet from the Sun.",
           de: "Neptun ist tiefblau, eiskalt und sehr, sehr windig. Er ist der Planet, der am weitesten von der Sonne weg ist." },
    fun: { en: "Its winds blow at up to 2,000 km/h – the fastest in the solar system. Since its discovery in 1846 it has gone around the Sun only once.",
           de: "Seine Winde wehen mit bis zu 2.000 km/h – die schnellsten im Sonnensystem. Seit seiner Entdeckung 1846 hat er die Sonne erst einmal umrundet." },
    like: ["🍊", { en: "an orange (8 cm)", de: "eine Orange (8 cm)" }]
  },
  pluto: {
    sub: { en: "The little dwarf planet", de: "Der kleine Zwergplanet" },
    kid: { en: "Pluto is tiny and frozen, far, far away. Look – it has a big heart on it!",
           de: "Pluto ist winzig und gefroren, ganz weit weg. Schau – er hat ein großes Herz!" },
    fun: { en: "Pluto has not finished one trip around the Sun since it was discovered in 1930 – that takes 248 years.",
           de: "Seit seiner Entdeckung 1930 hat Pluto die Sonne noch kein einziges Mal umrundet – das dauert 248 Jahre." },
    like: ["🟤", { en: "a lentil", de: "eine Linse" }]
  }
};

export const LAND_TEXT = {
  gas: { en: "There's no ground here – you would float in endless clouds, sinking deeper and deeper where it gets hotter and darker.",
         de: "Hier gibt es keinen Boden – du würdest in endlosen Wolken schweben und immer tiefer sinken, wo es heißer und dunkler wird." },
  sun: { en: "Too hot to land! The surface is 5,500 °C.", de: "Viel zu heiß zum Landen! Die Oberfläche hat 5.500 °C." },
  venus: { en: "The air is so thick and hot (464 °C) that every robot that landed here broke within two hours.",
           de: "Die Luft ist so dick und heiß (464 °C), dass jeder Roboter, der hier landete, nach zwei Stunden kaputt war." },
  moon: { en: "No air, so the sky is black even in daytime. And look – there's the Earth, hanging over the horizon!",
          de: "Keine Luft, deshalb ist der Himmel sogar am Tag schwarz. Und schau – da hängt die Erde über dem Horizont!" },
  mars: { en: "The sky is butterscotch by day – and sunsets on Mars are blue.",
          de: "Am Tag ist der Himmel karamellfarben – und Sonnenuntergänge auf dem Mars sind blau." },
  mercury: { en: "The Sun looks almost three times bigger here – and the sky stays black.",
             de: "Die Sonne sieht hier fast dreimal so groß aus – und der Himmel bleibt schwarz." },
  pluto: { en: "So far away that the Sun is just a very bright star. Charon always stays on the other side of Pluto.",
           de: "So weit weg, dass die Sonne nur ein sehr heller Stern ist. Charon bleibt immer auf der anderen Seite von Pluto." },
  earth: { en: "Home sweet home – the real sky over Vienna, right now.",
           de: "Daheim – der echte Himmel über Wien, genau jetzt." },
  saturn: { en: "No ground here, just clouds – but look up: the rings stretch across the whole sky!",
            de: "Kein Boden, nur Wolken – aber schau hinauf: Die Ringe spannen sich über den ganzen Himmel!" }
};
