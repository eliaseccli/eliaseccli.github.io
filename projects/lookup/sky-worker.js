/* Look up: SGP4 in a worker so 10k Starlink sats do not freeze the UI. */
/* global satellite */
importScripts("./vendor/satellite.min.js");

var MIN_EL = -2.5;
var MAX_DRAW = 480;
var LIVE_STARLINK = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json";
var LIVE_STATIONS = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json";
var ISS_ID = 25544;

var catalog = [];
var meta = { source: "", epoch: "", n: 0 };

function checksum(line) {
  var s = 0, i, c;
  for (i = 0; i < 68; i++) {
    c = line.charAt(i);
    if (c === "-") s += 1;
    else if (c >= "0" && c <= "9") s += c.charCodeAt(0) - 48;
  }
  return String(s % 10);
}

function put(arr, col, str) {
  var s = String(str);
  var i;
  for (i = 0; i < s.length && col - 1 + i < 68; i++) arr[col - 1 + i] = s.charAt(i);
}

function norad5(id) {
  id = id | 0;
  if (id < 100000) return ("00000" + id).slice(-5);
  var letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  var li = Math.floor(id / 10000) - 10;
  if (li < 0 || li >= letters.length) return "99999";
  return letters.charAt(li) + ("0000" + (id % 10000)).slice(-4);
}

function epochField(iso) {
  var s = String(iso || "").trim();
  if (!s) return "00001.00000000";
  if (!/[zZ]|[+-]\d\d:\d\d$/.test(s)) s += "Z";
  var d = new Date(s);
  if (isNaN(d.getTime())) return "00001.00000000";
  var y = d.getUTCFullYear();
  var start = Date.UTC(y, 0, 1);
  var doy = (d.getTime() - start) / 86400000 + 1;
  var yy = y % 100;
  var whole = Math.floor(doy);
  var frac = doy - whole;
  return (yy < 10 ? "0" : "") + yy + ("00" + whole).slice(-3) + "." + frac.toFixed(8).slice(2);
}

function ndotField(ndot) {
  if (!ndot) return " .00000000";
  var sign = ndot < 0 ? "-" : " ";
  var s = Math.abs(ndot).toFixed(8);
  if (s.charAt(0) === "0") s = s.slice(1);
  return (sign + s).slice(0, 10);
}

function sci8(val) {
  if (!val || !isFinite(val) || Math.abs(val) < 1e-16) return " 00000-0";
  var sign = val < 0 ? "-" : " ";
  var a = Math.abs(val);
  var exp = Math.floor(Math.log10(a) + 1e-14) + 1;
  var digits = Math.round(a / Math.pow(10, exp) * 1e5);
  if (digits >= 100000) {
    digits = 10000;
    exp += 1;
  }
  return sign + ("00000" + digits).slice(-5) + (exp < 0 ? "-" : "+") + Math.abs(exp);
}

function angle8(deg) {
  var v = ((Number(deg) % 360) + 360) % 360;
  return ("        " + v.toFixed(4)).slice(-8);
}

function buildTle(id, epoch, mm, ecc, inc, raan, argp, ma, bstar, ndot) {
  var cat = norad5(id);
  var a = new Array(69);
  var i;
  for (i = 0; i < 69; i++) a[i] = " ";
  put(a, 1, "1");
  put(a, 3, cat);
  put(a, 8, "U");
  put(a, 10, "00000A  ");
  put(a, 19, epochField(epoch));
  put(a, 34, ndotField(ndot));
  put(a, 45, " 00000-0");
  put(a, 54, sci8(bstar));
  put(a, 63, "0");
  put(a, 65, " 999");
  var l1 = a.slice(0, 68).join("") + checksum(a.slice(0, 68).join(""));
  var b = new Array(69);
  for (i = 0; i < 69; i++) b[i] = " ";
  put(b, 1, "2");
  put(b, 3, cat);
  put(b, 9, angle8(inc));
  put(b, 18, angle8(raan));
  put(b, 27, ("0000000" + Math.round(Math.abs(ecc) * 1e7)).slice(-7));
  put(b, 35, angle8(argp));
  put(b, 44, angle8(ma));
  put(b, 53, ("           " + Number(mm).toFixed(8)).slice(-11));
  put(b, 64, "    0");
  var l2 = b.slice(0, 68).join("") + checksum(b.slice(0, 68).join(""));
  return [l1, l2];
}

function ommToRow(rec, kind) {
  if (!rec || rec.NORAD_CAT_ID == null) return null;
  var id = +rec.NORAD_CAT_ID;
  if (!isFinite(id)) return null;
  var mm = +rec.MEAN_MOTION;
  var ecc = +rec.ECCENTRICITY;
  if (!isFinite(mm) || !isFinite(ecc)) return null;
  return [
    String(rec.OBJECT_NAME || ("SAT-" + id)).trim(),
    id,
    String(rec.EPOCH || ""),
    mm,
    ecc,
    +rec.INCLINATION,
    +rec.RA_OF_ASC_NODE,
    +rec.ARG_OF_PERICENTER,
    +rec.MEAN_ANOMALY,
    +rec.BSTAR || 0,
    +rec.MEAN_MOTION_DOT || 0,
    kind || "sl"
  ];
}

function rowsFromPayload(raw) {
  var rows = [];
  var i, rec, row;
  if (!raw) return rows;
  if (Array.isArray(raw)) {
    for (i = 0; i < raw.length; i++) {
      row = ommToRow(raw[i], "sl");
      if (row) rows.push(row);
    }
    return rows;
  }
  if (Array.isArray(raw.sats)) {
    for (i = 0; i < raw.sats.length; i++) {
      rec = raw.sats[i];
      if (Array.isArray(rec) && rec.length >= 11) rows.push(rec);
      else {
        row = ommToRow(rec, rec && rec.k);
        if (row) rows.push(row);
      }
    }
  }
  return rows;
}

function pickIss(records) {
  var byId = null;
  var zarya = null;
  var i, rec, id, name;
  for (i = 0; i < records.length; i++) {
    rec = records[i];
    id = +rec.NORAD_CAT_ID;
    name = String(rec.OBJECT_NAME || "");
    if (id === ISS_ID) {
      byId = rec;
      if (/ZARYA/i.test(name)) {
        zarya = rec;
        break;
      }
    }
  }
  return zarya || byId;
}

function loadRows(rows, source, epoch) {
  var next = [];
  var seen = Object.create(null);
  var i, r, tle, satrec, kind;
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    if (!r || seen[r[1]]) continue;
    tle = buildTle(r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]);
    try {
      satrec = satellite.twoline2satrec(tle[0], tle[1]);
    } catch (err) {
      continue;
    }
    if (!satrec || satrec.error) continue;
    seen[r[1]] = 1;
    kind = r[11] === "iss" || r[1] === ISS_ID ? "iss" : "sl";
    next.push({
      satrec: satrec,
      id: r[1],
      name: String(r[0] || ""),
      kind: kind
    });
  }
  if (!next.length) return false;
  catalog = next;
  meta = {
    source: source || "Celestrak GP JSON",
    epoch: epoch || "",
    n: next.length
  };
  return true;
}

function propagateAt(satrec, d) {
  return satellite.propagate(
    satrec,
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds() + d.getUTCMilliseconds() / 1000
  );
}

function tick(msg) {
  if (!catalog.length) {
    self.postMessage({ type: "sky", sats: [], nInSky: 0, iss: null, source: meta.source, epoch: meta.epoch, n: 0 });
    return;
  }
  var now = msg.t ? new Date(msg.t) : new Date();
  var lat = +msg.lat;
  var lon = +msg.lon;
  var alt = +msg.altKm || 0;
  var minEl = msg.minEl == null ? MIN_EL : +msg.minEl;
  var obs = {
    longitude: satellite.degreesToRadians(lon),
    latitude: satellite.degreesToRadians(lat),
    height: alt
  };
  var gmst = satellite.gstime(now);
  var visible = [];
  var iss = null;
  var i, item, pv, pos, ecf, look, el, az, range, row;
  for (i = 0; i < catalog.length; i++) {
    item = catalog[i];
    pv = propagateAt(item.satrec, now);
    pos = pv && pv.position;
    if (!pos || pos === false || !isFinite(pos.x)) continue;
    ecf = satellite.eciToEcf(pos, gmst);
    look = satellite.ecfToLookAngles(obs, ecf);
    el = look.elevation * 180 / Math.PI;
    if (el < minEl && item.kind !== "iss") continue;
    az = look.azimuth * 180 / Math.PI;
    if (az < 0) az += 360;
    range = look.rangeSat;
    row = {
      id: item.id,
      name: item.name,
      kind: item.kind,
      az: az,
      el: el,
      range: range
    };
    if (item.kind === "iss") iss = row;
    if (el >= minEl) visible.push(row);
  }
  visible.sort(function (a, b) {
    return b.el - a.el;
  });
  var nInSky = visible.length;
  if (visible.length > MAX_DRAW) {
    visible = visible.filter(function (s) { return s.kind === "iss"; }).concat(
      visible.filter(function (s) { return s.kind !== "iss"; }).slice(0, MAX_DRAW)
    );
  }
  self.postMessage({
    type: "sky",
    sats: visible,
    nInSky: nInSky,
    iss: iss && iss.el >= minEl ? iss : null,
    source: meta.source,
    epoch: meta.epoch,
    n: meta.n
  });
}

function fetchJson(url, ms) {
  var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = null;
  var opts = { cache: "no-store" };
  if (ctrl) {
    opts.signal = ctrl.signal;
    timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms || 12000);
  }
  return fetch(url, opts).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).finally(function () {
    if (timer) clearTimeout(timer);
  });
}

function boot(msg) {
  var dumpUrl = msg.dumpUrl;
  fetchJson(dumpUrl, 15000).then(function (raw) {
    var rows = rowsFromPayload(raw);
    var ok = loadRows(rows, (raw && raw.source) || "in-repo GP dump", (raw && raw.epoch) || "");
    if (!ok) throw new Error("empty dump");
    self.postMessage({ type: "ready", source: meta.source, epoch: meta.epoch, n: meta.n, live: false });
    return tryLive();
  }).catch(function (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
    return tryLive();
  });
}

function tryLive() {
  return fetchJson(LIVE_STARLINK, 12000).then(function (starlink) {
    var rows = rowsFromPayload(starlink);
    return fetchJson(LIVE_STATIONS, 8000).then(function (stations) {
      var iss = pickIss(Array.isArray(stations) ? stations : []);
      var row = iss ? ommToRow(iss, "iss") : null;
      if (row) {
        rows = rows.filter(function (r) { return r[1] !== row[1]; });
        rows.push(row);
      }
      return rows;
    }).catch(function () {
      return rows;
    });
  }).then(function (rows) {
    if (!rows || !rows.length) return;
    var epochs = [];
    var i;
    for (i = 0; i < rows.length; i++) if (rows[i][2]) epochs.push(rows[i][2]);
    if (loadRows(rows, "Celestrak GP live", epochs.length ? epochs.sort().slice(-1)[0] : "")) {
      self.postMessage({ type: "ready", source: meta.source, epoch: meta.epoch, n: meta.n, live: true });
    }
  }).catch(function () {
    // Celestrak 500 / CORS / timeout: keep the last good dump.
  });
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.type === "boot") boot(msg);
  else if (msg.type === "tick") tick(msg);
};
