/* Starlink page: shared state (URL hash, colors, shells, selection, view), launch dates and the shell-row builder.
   Loaded in <head> on purpose: it sets the is-globe / sl-grey classes before first paint. */
/* Shared page state for Chart and Globe, mirrored in the URL hash:
     #[chart][&sat=NORAD][&off=TOKENS | &on=TOKENS][&c=1][&spd=N]
   no "chart" = Globe (default view; old #globe links still work). Shell tokens: "53-463" one shell,
   "43" a whole inclination, "53r" its orbit-raising group, "o" the Globe's orbit raising / deorbiting
   group. c=1 = Colors on (default grey). spd=10|60|300|1000 is the globe time multiplier (omitted at
   1×, live). Only non-defaults are written. A link carrying sat/off/on/c is applied for the visit
   without touching saved prefs; a toggle the visitor changes is saved. spd alone does not do that. */
(function () {
  var root = document.documentElement;
  var KEY_C = "starlink.colors.v1", KEY_OFF = "starlink.globe.off.v2";
  var q = {}, h = location.hash.replace(/^#/, "");
  h.split("&").forEach(function (kv, i) {
    if (!kv) return;
    var k = kv.split("=")[0], v = kv.slice(k.length + 1);
    if (i === 0 && !v) q.view = k; else q[k] = decodeURIComponent(v);
  });
  var shared = "sat" in q || "off" in q || "on" in q || "c" in q;
  var view = q.view === "chart" ? "chart" : "globe";
  root.classList.toggle("is-globe", view === "globe");

  // ---- colors ----
  var cOn = false, cSubs = [];
  if (shared) cOn = q.c === "1";
  else { try { cOn = localStorage.getItem(KEY_C) === "1"; } catch (e) {} }
  root.classList.toggle("sl-grey", !cOn);
  window.StarlinkColors = {
    GREY: "#a3abb8",
    on: function () { return cOn; },
    set: function (v) {
      cOn = !!v;
      try { localStorage.setItem(KEY_C, cOn ? "1" : "0"); } catch (e) {}
      root.classList.toggle("sl-grey", !cOn);
      cSubs.forEach(function (f) { f(cOn); });
      writeHash();
    },
    sub: function (f) { cSubs.push(f); }
  };

  // ---- shell visibility (one state for both views) ----
  var tokMode = null, toks = [];          // unresolved URL tokens until the shell list is known
  var off = {}, ids = null, sSubs = [];
  function tokMatch(t, id) {
    if (t === id) return true;
    if (t === "o") return id === "other";
    if (/^\d+r$/.test(t)) return id === t.slice(0, -1) + "-raising";
    if (/^\d+$/.test(t)) return id.indexOf(t + "-") === 0;
    return false;
  }
  function urlOff(id) {
    var m = toks.some(function (t) { return tokMatch(t, id); });
    return tokMode === "on" ? !m : m;
  }
  if (shared) {
    if ("off" in q) { tokMode = "off"; toks = q.off.split(",").filter(Boolean); }
    else if ("on" in q) { tokMode = "on"; toks = q.on.split(",").filter(Boolean); }
  } else {
    try { (JSON.parse(localStorage.getItem(KEY_OFF) || "[]") || []).forEach(function (k) { off[k] = 1; }); } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(KEY_OFF, JSON.stringify(Object.keys(off))); } catch (e) {}
  }
  window.StarlinkShells = {
    // every shell id either view knows (chart shells + "other"); resolves URL tokens once
    known: function (list) {
      var seen = ids || [];
      list.forEach(function (id) { if (seen.indexOf(id) < 0) seen.push(id); });
      ids = seen;
      if (tokMode) list.forEach(function (id) { if (urlOff(id)) off[id] = 1; });
    },
    isOn: function (id) { return !off[id] && !(tokMode && !ids && urlOff(id)); },
    set: function (list, visible, quiet) {
      list.forEach(function (id) { if (visible) delete off[id]; else off[id] = 1; });
      save();
      if (!quiet) sSubs.forEach(function (f) { f(); });
      writeHash();
    },
    sub: function (f) { sSubs.push(f); }
  };
  function encodeShells() {
    if (!ids) return toks.length ? tokMode + "=" + toks.join(",") : "";
    var groups = {}, offT = [], onT = [], nOff = 0;
    ids.forEach(function (id) {
      var g = id === "other" ? "o" : id.split("-")[0];
      (groups[g] = groups[g] || []).push(id);
      if (off[id]) nOff++;
    });
    if (!nOff) return "";
    var tok = function (id) { return id === "other" ? "o" : /-raising$/.test(id) ? id.split("-")[0] + "r" : id; };
    Object.keys(groups).forEach(function (g) {
      var list = groups[g], o = list.filter(function (id) { return off[id]; });
      if (o.length === list.length) offT.push(g === "o" ? "o" : g);
      else o.forEach(function (id) { offT.push(tok(id)); });
      if (!o.length) onT.push(g === "o" ? "o" : g);
      else if (o.length < list.length) list.forEach(function (id) { if (!off[id]) onT.push(tok(id)); });
    });
    var a = "off=" + offT.join(","), b = "on=" + onT.join(",");
    return onT.length && b.length < a.length ? b : a;
  }

  // ---- selected satellite (one selection for both views) ----
  var sel = { id: shared && /^\d+$/.test(q.sat || "") ? +q.sat : null, name: "" };
  window.StarlinkSel = {
    get: function () { return sel; },
    set: function (id, name) { sel = { id: id == null ? null : +id, name: name || "" }; writeHash(); }
  };

  // ---- simulated clock (globe time multiplier) ----
  var SPEEDS = [1, 10, 60, 300, 1000];
  var speed = 1, simTime = Date.now(), tracking = true, clockSubs = [];
  if (SPEEDS.indexOf(+q.spd) >= 0 && +q.spd !== 1) { speed = +q.spd; tracking = false; }
  function clockNotify() { clockSubs.forEach(function (f) { f(); }); }
  window.StarlinkClock = {
    SPEEDS: SPEEDS,
    speed: function () { return speed; },
    now: function () { return simTime; },
    isLive: function () { return tracking && speed === 1; },
    setSpeed: function (v) {
      v = +v;
      if (SPEEDS.indexOf(v) < 0 || v === speed) return;
      speed = v;
      if (v !== 1) tracking = false;
      writeHash();
      clockNotify();
    },
    live: function () {
      speed = 1;
      tracking = true;
      simTime = Date.now();
      writeHash();
      clockNotify();
    },
    tick: function (dtMs) {
      if (tracking && speed === 1) { simTime = Date.now(); return simTime; }
      var dt = dtMs;
      if (!(dt > 0)) dt = 0;
      if (dt > 250) dt = 250;
      simTime += dt * speed;
      return simTime;
    },
    sub: function (f) { clockSubs.push(f); }
  };

  // ---- view + URL ----
  window.StarlinkView = {
    get: function () { return view; },
    set: function (v) { view = v === "chart" ? "chart" : "globe"; root.classList.toggle("is-globe", view === "globe"); writeHash(); },
    fromHash: function () { return /^#chart(&|$)/.test(location.hash) ? "chart" : "globe"; }
  };
  var pend = false;
  function writeHash() {
    if (pend) return;
    pend = true;
    Promise.resolve().then(function () {
      pend = false;
      var parts = [];
      if (view === "chart") parts.push("chart");
      if (sel.id != null) parts.push("sat=" + sel.id);
      var sh = encodeShells(); if (sh) parts.push(sh);
      if (cOn) parts.push("c=1");
      if (speed !== 1) parts.push("spd=" + speed);
      var want = parts.length ? "#" + parts.join("&") : "";
      if (want !== location.hash && !(want === "" && location.hash === "#")) {
        history.replaceState(null, "", location.pathname + location.search + want);
      }
    });
  }
  window.StarlinkWriteHash = writeHash;
})();
// One inclination block for Chart and Globe: the expand button and the checkbox label sit side by side
// in one row (never nested). The button covers the row's empty space, so tapping the arrow or the
// blank part of the row expands; tapping the checkbox or its text toggles it.
window.StarlinkIncBlock = {
  html: function (key, open, checkAttr, label, count, rows) {
    return '<div class="inc-block' + (open ? " is-open" : "") + '" data-incblock="' + key + '">' +
      '<div class="inc-row"><button type="button" class="inc-toggle" aria-expanded="' + !!open + '" aria-label="' + label + ' shells"></button>' +
      '<label class="chk inc"><input type="checkbox" ' + checkAttr + " checked> " + label + " <em>" + count + " satellites</em></label></div>" +
      '<div class="heights"' + (open ? "" : " hidden") + ">" + rows + "</div></div>";
  },
  bind: function (root, onToggle) {
    root.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest(".inc-toggle");
      if (!btn || !root.contains(btn)) return;
      var blk = btn.parentNode.parentNode, open = !blk.classList.contains("is-open");
      blk.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", String(open));
      blk.querySelector(".heights").hidden = !open;
      if (onToggle) onToggle(blk.getAttribute("data-incblock"), open);
    });
  }
};
// launch dates by NORAD id (ranges from ./launches.json); "" when unknown, never a guess
(function () {
  var R = null, MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  fetch("./launches.json?v=l1").then(function (r) { return r.json(); }).then(function (j) { R = j.ranges || []; }, function () { R = []; });
  window.StarlinkLaunch = function (norad) {
    if (!R || !R.length) return "";
    var lo = 0, hi = R.length - 1, n = +norad;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, r = R[mid];
      if (n < r[0]) hi = mid - 1; else if (n > r[1]) lo = mid + 1;
      else {
        var p = String(r[2]).split("-");
        if (p.length === 3) return "Launched " + (+p[2]) + " " + MON[+p[1] - 1] + " " + p[0];
        return /^\d{4}$/.test(p[0]) ? "Launched " + p[0] : "";
      }
    }
    return "";
  };
})();
