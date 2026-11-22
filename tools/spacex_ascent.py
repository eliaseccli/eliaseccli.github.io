#!/usr/bin/env python3
"""Build spacex/ascent-templates.js from real ascent telemetry, and validate it.

    python3 tools/spacex_ascent.py            # download (cached), build, validate, write
    python3 tools/spacex_ascent.py --check    # build + validate only, do not write

Sources (all public; downloaded into ~/.cache/eliaseccli-spacex, never committed):
  - shahar603/Telemetry-Data (The Unlicense): Falcon 9 / Falcon Heavy webcast
    telemetry, 30 fps OCR of the SpaceX webcast HUD (speed, altitude).
  - Launch Dashboard API by shahar603 (MIT), the same OCR for 2020 flights; the API
    is offline, the Wayback Machine keeps the responses used here.
  - calvinboyle/otto-rocket: OCR of the Starlink-4 webcast (17 Feb 2020).
  - StarDash Flight Data Archives (stardash.live/archive): SpaceX's own published
    Starship tracker feed, recorded; "redistributed as recorded".
  - Launch Library 2 (thespacedevs.com): event timelines of recent SpaceX launches,
    for the default event times of each template (MECO, SECO-1, ...).

Model. The webcast shows speed relative to the ground. That number depends on the
launch azimuth (Earth's rotation adds up to ~0.4 km/s). A template keeps its
flight's altitude, horizontal ground speed and vertical speed against time; for
another mission the horizontal part is scaled so it ends at the ground speed
that mission needs for the same inertial speed at SECO-1 (gain_ratio). So one
Falcon 9 LEO ascent serves 43°, 53°, 70° and 97° missions alike. A template runs to the end of its flight's data (Falcon: SECO-1
and a little coast; Starship: through the orbit insertion burn, or to splashdown
for a suborbital flight); after that the page blends into its orbit model.
"""
import json, math, os, re, statistics, sys, csv, io, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "spacex", "ascent-templates.js")
CACHE = os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "eliaseccli-spacex")
MU, R_E, OMEGA = 398600.4418, 6371.0, 7.2921159e-5
D2R = math.pi / 180
STEP = 5  # s between template knots

SH = "https://raw.githubusercontent.com/shahar603/Telemetry-Data/master/"
WB = "https://web.archive.org/web/"


def get(url, name):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, name)
    if not os.path.exists(p):
        req = urllib.request.Request(url, headers={"User-Agent": "eliaseccli.com spacex template builder"})
        with urllib.request.urlopen(req, timeout=90) as r, open(p, "wb") as f:
            f.write(r.read())
    return p


# ---------------- loaders: every source -> list of (t s, alt km, ground speed m/s) ----------------
def per_second(ts, vs, hs):
    """30 fps OCR -> one median sample per second (drops OCR glitches)."""
    b = {}
    for t, v, h in zip(ts, vs, hs):
        if t is None or v is None or h is None:
            continue
        b.setdefault(int(round(t)), []).append((v, h))
    return [(k, statistics.median(x[1] for x in b[k]), statistics.median(x[0] for x in b[k])) for k in sorted(b)]


def sh_raw(mission):
    q = urllib.parse.quote(mission)
    d = json.load(open(get(SH + q + "/JSON/stage2%20raw.json", "sh-" + mission + "-stage2.json")))
    return per_second(d["time"], d["velocity"], d["altitude"])


def wayback(ts, url, name):
    d = json.load(open(get(WB + ts + "id_/" + url, name)))
    a = d["analysed"][0]["telemetry"]
    return [(x["time"], x["altitude"], x["velocity"]) for x in a]


def otto():
    import openpyxl
    p = get("https://raw.githubusercontent.com/calvinboyle/otto-rocket/master/2-17-2020%20Starlink%20Data/data.xlsx", "otto-starlink4.xlsx")
    ws = openpyxl.load_workbook(p, read_only=True, data_only=True).worksheets[0]
    out = []
    for r in list(ws.iter_rows(values_only=True))[1:]:
        if r[0] is None or r[5] is None:
            continue
        out.append((float(r[5]), float(r[0]), float(r[2]) / 3.6))
    return out


def stardash(flight):
    p = get("https://stardash.live/data/flight%d-derived.csv" % flight, "stardash-f%d.csv" % flight)
    out = []
    for x in csv.DictReader(open(p)):
        if not x["met_sched"] or not x["alt_km"] or not x["spd_ms"]:
            continue
        t = float(x["met_sched"])
        if t >= 0:
            out.append((t, float(x["alt_km"]), float(x["spd_ms"])))
    if out and out[0][0] > 0:
        out.insert(0, (0.0, 0.0, 0.0))  # liftoff (the feed samples every 10-30 s)
    return out


# ---------------- geometry ----------------
# The webcast speed is relative to the ground. At SECO the rocket needs the same INERTIAL speed
# whatever the azimuth, so the ground speed it shows there differs (Earth's rotation, up to
# ~0.4 km/s, helps due east and hurts toward the west). A template keeps its flight's ground
# speed; for another mission the horizontal part is scaled by gain(target) / gain(source), the
# ground speed needed for the same inertial SECO speed (exact at liftoff and at SECO, smooth in
# between). ascent.js does the same.
def heading_east(lat, incl, branch):
    """east share of the inertial heading of the orbit plane at the pad (sin of the azimuth)."""
    return math.cos(incl * D2R) / math.cos(lat * D2R)


def rot_speed(lat, h=0.0):
    return OMEGA * (R_E + h) * 1000 * math.cos(lat * D2R)


def inertial_from_ground(V, lat, incl, branch, h):
    e, w = heading_east(lat, incl, branch), rot_speed(lat, h)
    return e * w + math.sqrt(max(e * e * w * w - w * w + V * V, 0.0))


def ground_from_inertial(v, lat, incl, branch, h):
    e, w = heading_east(lat, incl, branch), rot_speed(lat, h)
    return math.sqrt(max(v * v - 2 * v * w * e + w * w, 0.0))


def gain_ratio(src, tgt, V_seco, h_seco):
    """scale of the horizontal ground speed from a source flight's geometry to a target's."""
    v = inertial_from_ground(V_seco, src["lat"], src["incl"], src["branch"], h_seco)
    return ground_from_inertial(v, tgt["lat"], tgt["incl"], tgt["branch"], h_seco) / V_seco


def to_knots_frame(samples):
    """webcast samples (t, alt, ground speed) -> (t, alt, horizontal ground speed, vertical speed)."""
    s = smooth(samples)
    out = []
    for k, (t, h, V) in enumerate(s):
        j0, j1 = k, k
        while j0 > 0 and s[k][0] - s[j0][0] < 3:
            j0 -= 1
        while j1 < len(s) - 1 and s[j1][0] - s[k][0] < 3:
            j1 += 1
        vz = (s[j1][1] - s[j0][1]) * 1000 / max(s[j1][0] - s[j0][0], 1e-6)
        vz = max(-V, min(V, vz))
        out.append((t, h, math.sqrt(max(V * V - vz * vz, 0.0)), vz))
    return out


def smooth(samples, win=2.0):
    """centred running mean over +-win seconds (OCR digits jitter by a unit); keeps t."""
    out = []
    for k in range(len(samples)):
        part = [p for p in samples[max(0, k - 8):k + 9] if abs(p[0] - samples[k][0]) <= win]
        out.append((samples[k][0], sum(p[1] for p in part) / len(part), sum(p[2] for p in part) / len(part)))
    return out


def interp(xs, ys, x):
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    lo, hi = 0, len(xs) - 1
    while hi - lo > 1:
        m = (lo + hi) // 2
        if xs[m] <= x:
            lo = m
        else:
            hi = m
    f = (x - xs[lo]) / (xs[hi] - xs[lo])
    return ys[lo] + (ys[hi] - ys[lo]) * f


# ---------------- flights ----------------
# at: event times (s) of that flight: from its webcast/LL2 timeline where known. A flight whose
# webcast telemetry stops while the engine still burns has no "seco"; validation then anchors on
# MECO only. "end" (last second of usable data) is filled in from the data.
CAPE40 = 28.5619; CAPE39 = 28.6082; VSFB = 34.632; STARBASE = 25.9968
SHD = "shahar603/Telemetry-Data (The Unlicense), %s/JSON/stage2 raw.json"
LDW = "Launch Dashboard API (shahar603, MIT), Wayback snapshot %s of /v1/launches/latest/spacex"
SDA = "stardash.live/data/flight%d-derived.csv (SpaceX's Starship tracker feed, recorded)"
FLIGHTS = {
    "starlink-8": dict(name="Starlink 8 (13 Jun 2020, SLC-40, 53°)", src=LDW % "2020-07-01",
                       load=lambda: wayback("20200701150131", "http://api.launchdashboard.space:80/v1/launches/latest/spacex", "ld-starlink8.json"),
                       lat=CAPE40, incl=53.0, branch="asc", at=dict(meco=156, seco=541)),
    "starlink-4": dict(name="Starlink-4 (17 Feb 2020, SLC-40, 53°)", src="github.com/calvinboyle/otto-rocket, 2-17-2020 Starlink Data/data.xlsx",
                       load=otto, lat=CAPE40, incl=53.0, branch="asc", at=dict(meco=159, seco=542)),
    "iridium-7": dict(name="Iridium NEXT 7 (25 Jul 2018, SLC-4E, 86.4°)", src=SHD % "Iridium NEXT 7",
                      load=lambda: sh_raw("Iridium NEXT 7"), lat=VSFB, incl=86.4, branch="desc", at=dict(meco=146)),
    "dm-2": dict(name="Crew Dragon Demo-2 (30 May 2020, LC-39A, 51.6°)", src=LDW % "2020-06-01",
                 load=lambda: wayback("20200601113716", "http://api.launchdashboard.space:80/v1/launches/latest/spacex", "ld-dm2.json"),
                 lat=CAPE39, incl=51.6, branch="asc", at=dict(meco=158, seco=534)),
    "dm-1": dict(name="Crew Dragon Demo-1 (2 Mar 2019, LC-39A, 51.6°)", src=SHD % "DM-1",
                 load=lambda: sh_raw("DM-1"), lat=CAPE39, incl=51.6, branch="asc", at=dict(meco=158)),
    "crs-16": dict(name="CRS-16 (5 Dec 2018, SLC-40, 51.6°)", src=SHD % "SpaceX CRS-16",
                   load=lambda: sh_raw("SpaceX CRS-16"), lat=CAPE40, incl=51.6, branch="asc", at=dict(meco=145)),
    "crs-14": dict(name="CRS-14 (2 Apr 2018, SLC-40, 51.6°)", src=SHD % "SpaceX CRS-14",
                   load=lambda: sh_raw("SpaceX CRS-14"), lat=CAPE40, incl=51.6, branch="asc", at=dict(meco=164)),
    "telstar-19v": dict(name="Telstar 19 VANTAGE (22 Jul 2018, SLC-40, GTO)", src=SHD % "TelStar v19",
                        load=lambda: sh_raw("TelStar v19"), lat=CAPE40, incl=28.6, branch="asc", at=dict(meco=153, seco=496), until=505),
    "bangabandhu-1": dict(name="Bangabandhu-1 (11 May 2018, LC-39A, GTO)", src=SHD % "Bangabandhu-1",
                          load=lambda: sh_raw("Bangabandhu-1"), lat=CAPE39, incl=28.7, branch="asc", at=dict(meco=152, seco=500), until=505),
    "eshail-2": dict(name="Es'hail 2 (15 Nov 2018, LC-39A, GTO)", src=SHD % "Eshail 2",
                     load=lambda: sh_raw("Eshail 2"), lat=CAPE39, incl=28.7, branch="asc", at=dict(meco=152), until=482),
    "sso-a": dict(name="SSO-A rideshare (3 Dec 2018, SLC-4E, 97.7°)", src=SHD % "SSO-A",
                  load=lambda: sh_raw("SSO-A"), lat=VSFB, incl=97.7, branch="desc", at=dict(meco=143, seco=600)),  # webcast telemetry ends at T+10:00, at SECO-1
    "fh-demo": dict(name="Falcon Heavy Demo (6 Feb 2018, LC-39A)", src=SHD % "Falcon Heavy Demo 1",
                    load=lambda: sh_raw("Falcon Heavy Demo 1"), lat=CAPE39, incl=29.0, branch="asc", at=dict(meco=185, seco=512)),
    # Starship: event times from Launch Library 2's timeline of each flight
    "starship-15": dict(name="Starship Flight 15 (13 Nov 2026, Starbase, orbital)", src=SDA % 15,
                        load=lambda: stardash(15), lat=STARBASE, incl=30.5, branch="desc", at=dict(meco=139, seco=489, oib=1570), until=1800),
    "starship-14": dict(name="Starship Flight 14 (28 Sep 2026, Starbase, orbital)", src=SDA % 14,
                        load=lambda: stardash(14), lat=STARBASE, incl=30.5, branch="desc", at=dict(meco=140, seco=491, oib=1528), until=1800),
    "starship-13": dict(name="Starship Flight 13 (24 Jul 2026, Starbase, suborbital)", src=SDA % 13,
                        load=lambda: stardash(13), lat=STARBASE, incl=26.5, branch="desc", at=dict(meco=138, seco=485, entry=2850, land=3912), until=3925),
}

_flights = {}
def flight(key):
    if key in _flights:
        return _flights[key]
    f = dict(FLIGHTS[key])
    raw = [x for x in f["load"]() if x[0] >= 0]
    if f.get("until"):
        raw = [x for x in raw if x[0] <= f["until"]]
    f["key"] = key
    f["ground"] = smooth(raw)
    f["end"] = raw[-1][0]
    f["series"] = to_knots_frame(raw)
    _flights[key] = f
    return f


# ---------------- templates ----------------
TEMPLATES = [
    # id, flights merged (the first one is the time base), what it serves
    ("f9-leo", ["starlink-8"], "Falcon 9 to LEO: Starlink (43°, 53°, 70°, 97.6° shells), other LEO, polar"),
    ("f9-iss", ["dm-2"], "Falcon 9 to the ISS (51.6°): Crew and Cargo Dragon, Cygnus"),
    ("f9-gto", ["telstar-19v", "bangabandhu-1"], "Falcon 9 to GTO / GEO / MEO / beyond (to SECO-1; the page models the parking orbit and SES-2)"),
    ("f9-sso", ["sso-a"], "Falcon 9 to SSO: rideshares (Transporter, Bandwagon), light direct inserts"),
    ("fh", ["fh-demo"], "Falcon Heavy: any mission (center core + upper stage, to SECO-1)"),
    ("starship-orbit", ["starship-15", "starship-14"], "Starship V3 orbital flights: ascent, coast, orbit insertion burn"),
    ("starship-sub", ["starship-13"], "Starship suborbital test flights: the whole flight to splashdown"),
]
VALIDATE = {  # template -> flights it is checked against (none of them are in the template)
    "f9-leo": ["starlink-4", "iridium-7"],
    "f9-iss": ["dm-1", "crs-16", "crs-14"],
    "f9-gto": ["eshail-2"],
}


def anchors(a, b):
    """common event times of two flights, as matched (ta, tb) pairs from liftoff on."""
    keys = [k for k in ("meco", "seco", "oib", "entry", "land") if k in a and k in b]
    return [(0.0, 0.0)] + sorted((float(a[k]), float(b[k])) for k in keys)


def warp(t, pairs):
    """piecewise-linear map through the anchor pairs; slope 1 past the last one."""
    for (a0, b0), (a1, b1) in zip(pairs, pairs[1:]):
        if t <= a1:
            return b0 + (t - a0) * (b1 - b0) / (a1 - a0)
    a0, b0 = pairs[-1]
    return b0 + (t - a0)


def build(tid, keys):
    fl = [flight(k) for k in keys]
    ref = fl[0]
    end = min(min(f["end"] for f in fl), max(f["end"] for f in fl))
    ks = []
    for t in range(0, int(ref["end"]) + 1, STEP):
        vals = []
        for f in fl:
            tt = warp(t, anchors(ref["at"], f["at"]))
            if tt > f["end"]:
                continue
            xs = [p[0] for p in f["series"]]
            vals.append([interp(xs, [p[j] for p in f["series"]], tt) for j in (1, 2, 3)])
        if vals:
            ks.append((t,) + tuple(sum(v[j] for v in vals) / len(vals) for j in range(3)))
    t_s = ref["at"].get("seco", ks[-1][0])
    k_s = min(ks, key=lambda k: abs(k[0] - t_s))
    return dict(id=tid, ref=ref, flights=fl, knots=ks, at=dict(ref["at"]), end=ks[-1][0],
                seco_v=math.hypot(k_s[2], k_s[3]), seco_h=k_s[1])


# ---------------- what the page shows: template -> mission ----------------
def page_profile(tpl, at, lat0, incl, branch, t_until):
    """ground speed (m/s) and altitude (km) the page shows for a mission with events `at`."""
    ks = tpl["knots"]
    xs = [k[0] for k in ks]
    cols = [[k[j] for k in ks] for j in (1, 2, 3)]
    pairs = [(b, a) for a, b in anchors(tpl["at"], at)]  # mission time -> template time
    k = gain_ratio(tpl["ref"], dict(lat=lat0, incl=incl, branch=branch), tpl["seco_v"], tpl["seco_h"])
    out, t = [], 0.0
    while t <= t_until:
        tt = warp(t, pairs)
        if tt > tpl["end"]:
            break
        h, vh, vz = (interp(xs, c, tt) for c in cols)
        out.append((t, h, math.hypot(vh * k, vz)))
        t += 1.0
    return out


def old_page_profile(kind, t_until):
    """the formulas the page used before (spacex.js falconProfile/profile, up to sx15)."""
    out = []
    for t in range(0, int(t_until) + 1):
        p = min(t / 510, 1)
        if kind.startswith("starship"):
            sub = kind == "starship-sub"
            alt = 275
            vt = 7.33 if sub else math.sqrt(MU / (R_E + alt))
            if t < 510:
                a, v = (150 if sub else alt * 0.62) * (1 - (1 - p) ** 1.9), vt * p ** 1.75
            elif sub:
                q = (t - 510) / (3930 - 1110 - 510)
                a, v = 150 + 62 * math.sin(math.pi * q) - 30 * q, vt - 0.08 * math.sin(math.pi * q)
            else:
                a = alt * 0.62 + (alt - alt * 0.62) * min(1, (t - 510) / 900)
                v = math.sqrt(MU / (R_E + a))
        else:
            alt = {"f9-iss": 210, "f9-gto": 200, "f9-leo": 280, "f9-sso": 500}.get(kind, 400)
            vO = math.sqrt(MU / (R_E + alt))
            if t < 510:
                a, v = alt * 0.8 * (1 - (1 - p) ** 1.9), vO * p ** 1.75
            else:
                a = alt * 0.8 + alt * 0.2 * min(1, (t - 510) / 900); v = math.sqrt(MU / (R_E + a))
        out.append((t, a, v * 1000))
    return out


def errors(pred, truth, t1):
    tp = {int(round(p[0])): p for p in pred}
    da, dv = [], []
    for t, h, V in truth:
        if t > t1 or int(round(t)) not in tp:
            continue
        p = tp[int(round(t))]
        da.append(p[1] - h); dv.append((p[2] - V) * 3.6)
    rms = lambda x: math.sqrt(sum(y * y for y in x) / len(x))
    return dict(n=len(da), alt_rms=rms(da), alt_max=max(map(abs, da)), spd_rms=rms(dv), spd_max=max(map(abs, dv)))


def fmt(e):
    return "alt RMS %5.1f km, max %5.1f · speed RMS %5.0f km/h, max %5.0f" % (e["alt_rms"], e["alt_max"], e["spd_rms"], e["spd_max"])


def check(tpl, f, note):
    t1 = min(f["end"], f["at"].get("seco", f["end"]) if tpl["id"].startswith("f") else f["end"])
    pred = page_profile(tpl, f["at"], f["lat"], f["incl"], f["branch"], t1)
    t1 = min(t1, pred[-1][0])
    new, old = errors(pred, f["ground"], t1), errors(old_page_profile(tpl["id"], t1), f["ground"], t1)
    ev = ", ".join("%s %d" % (k.upper(), v) for k, v in f["at"].items())
    return ["%s vs %s, T+0..%d s (%s; %s)" % (tpl["id"], f["name"], t1, ev, note), "    new: " + fmt(new), "    old: " + fmt(old)]


def validate(built):
    lines = []
    for tid, tpl in built.items():
        for k in VALIDATE.get(tid, []):
            lines += check(tpl, flight(k), "retimed to its events")
    # Starship orbital: leave one flight out; ascent, coast and orbit insertion burn
    for a, b in (("starship-15", "starship-14"), ("starship-14", "starship-15")):
        lines += check(build("starship-orbit", [a]), flight(b), "template from %s only" % a)
    return lines


def to_js(built, defaults, hdr, report):
    out = ["/* GENERATED by tools/spacex_ascent.py; do not edit by hand, run the script.",
           "   Ascent templates from real flights, one knot every %d s from liftoff to the end of" % STEP,
           "   the flight's usable data: altitude (km), horizontal ground speed and vertical speed (m/s)",
           "   as the webcast shows them; ascent.js rescales the horizontal part for another launch",
           "   azimuth (seco_v / seco_h: the source's speed and altitude at SECO-1, for that).",
           "   \"src\" events are the source flight's; \"at\" are the defaults the",
           "   page retimes to when a launch has no Launch Library 2 timeline (medians of recent",
           "   SpaceX launches). Sources and validation:", ""]
    out += ["   " + l for l in hdr + [""] + report]
    out.append("*/")
    out.append("export const TEMPLATES = {")
    items = list(built.items())
    for n, (tid, tpl) in enumerate(items):
        ks = tpl["knots"]
        out.append("  // %s" % next(t[2] for t in TEMPLATES if t[0] == tid))
        for f in tpl["flights"]:
            out.append("  //   %s: %s" % (f["name"], f["src"]))
        out.append('  "%s": {' % tid)
        out.append("    from: %s," % json.dumps(" + ".join(f["name"] for f in tpl["flights"])))
        out.append("    step: %d, lat: %.4f, incl: %.1f, branch: \"%s\"," % (STEP, tpl["ref"]["lat"], tpl["ref"]["incl"], tpl["ref"]["branch"]))
        out.append("    seco_v: %d, seco_h: %.1f," % (round(tpl["seco_v"]), tpl["seco_h"]))
        out.append("    src: %s," % json.dumps({k: round(v) for k, v in tpl["at"].items()}, separators=(",", ":")))
        out.append("    at: %s," % json.dumps(defaults.get(tid, {}), separators=(",", ":")))
        out.append("    alt: [%s]," % ",".join("%.1f" % k[1] for k in ks))
        out.append("    vh: [%s]," % ",".join("%d" % round(k[2]) for k in ks))
        out.append("    vz: [%s]" % ",".join("%d" % round(k[3]) for k in ks))
        out.append("  }" + ("," if n < len(items) - 1 else ""))
    out.append("};")
    return "\n".join(out) + "\n"


# ---------------- default event times from Launch Library 2 ----------------
def iso_s(s):
    neg = s.startswith("-")
    m = re.match(r"-?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?", s)
    d, h, mi, se = [float(x or 0) for x in m.groups()]
    v = d * 86400 + h * 3600 + mi * 60 + se
    return -v if neg else v


# LL2 timeline event -> template event key; the page (ascent.js LL2_EVENTS) uses the same table
EVENT_KEYS = {"MECO": "meco", "SECO-1": "seco", "SES-2": "ses2", "SECO-2": "seco2", "Orbital Insertion Burn Start": "oib",
              "Atmospheric Entry": "entry", "Starship Landing": "land", "Starship Catch": "land",
              "Starlink Deployment": "deploy", "Dragon Separation": "deploy", "Payload Separation": "deploy", "Payload Deployment Sequence Start": "deploy"}


def ll2_class(l):
    cfg = ((l.get("rocket") or {}).get("configuration") or {}).get("name", "")
    orbit = (((l.get("mission") or {}).get("orbit") or {}).get("abbrev") or "").upper()
    name = l.get("name", "")
    if "Starship" in cfg:
        return "starship-orbit" if orbit and orbit != "SUB" else "starship-sub"
    if "Heavy" in cfg:
        return "fh"
    if re.search(r"Crew|CRS|Cygnus|Axiom|Ax-\d", name):
        return "f9-iss"
    if orbit in ("GTO", "GEO", "MEO", "HEO", "GSO", "SSGTO"):
        return "f9-gto"
    if orbit == "SSO":
        return "f9-sso"
    return "f9-leo"


def ll2_defaults():
    p = get("https://ll.thespacedevs.com/2.3.0/launches/previous/?lsp__id=121&limit=60&mode=detailed&ordering=-net", "ll2-previous-detailed.json")
    res = json.load(open(p)).get("results", [])
    acc = {}
    for l in res:
        seen = {}
        for e in l.get("timeline") or []:
            k = EVENT_KEYS.get((e.get("type") or {}).get("abbrev"))
            t = iso_s(e.get("relative_time") or "P0D")
            if k and t > 0 and k not in seen:
                seen[k] = t
        for k, t in seen.items():
            acc.setdefault(ll2_class(l), {}).setdefault(k, []).append(t)
    out = {tid: {k: round(statistics.median(v)) for k, v in ev.items()} for tid, ev in acc.items()}
    return out, len(res), (res[-1].get("net", "")[:10], res[0].get("net", "")[:10]) if res else ("", "")


def main():
    built = {tid: build(tid, keys) for tid, keys, _ in TEMPLATES}
    report = validate(built)
    defaults, n, (d0, d1) = ll2_defaults()
    hdr = ["Templates (source flights; their ground speed and altitude at SECO-1):"]
    for tid, tpl in built.items():
        g = tpl["ref"]["ground"]
        sec = tpl["at"].get("seco", tpl["end"])
        s = min(g, key=lambda x: abs(x[0] - sec))
        hdr.append("  %-15s %-28s SECO-1 T+%3ds  %3.0f km  %5.0f km/h  (data to T+%d s)" % (tid, " + ".join(f["key"] for f in tpl["flights"]), sec, s[1], s[2] * 3.6, tpl["end"]))
    hdr.append("Default event times: medians of the LL2 timelines of %d SpaceX launches, %s to %s." % (n, d0, d1))
    print("\n".join(hdr)); print(json.dumps(defaults)); print("\n".join(report))
    if "--check" not in sys.argv:
        open(OUT, "w").write(to_js(built, defaults, hdr, ["Validation (new = this page, old = the formulas before Nov 2026):"] + report))
        print("wrote", os.path.relpath(OUT, ROOT))


if __name__ == "__main__":
    main()
