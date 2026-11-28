/* Starlink page: the Chart tab (today + history via timeline.js), then the Globe/Chart tab switch. Needs state.js and timeline.js. */
(function () {
  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");
  function fitPlot() {
    var landscape = window.matchMedia("(orientation: landscape)").matches;
    var lead = document.querySelector(".lead");
    var board = document.querySelector(".board");
    var sideCol = document.querySelector(".side");
    var transport = document.querySelector("[data-transport]");
    var stage = document.querySelector(".stage");
    function transportH() {
      return transport ? transport.offsetHeight + 8 : 0;
    }
    function applySize(side) {
      canvas.style.width = side + "px";
      canvas.style.height = side + "px";
      if (stage) stage.style.width = side + "px";
      if (transport) transport.style.width = side + "px";
    }
    if (landscape) {
      var vv = window.visualViewport;
      var vh = vv ? vv.height : window.innerHeight;
      var vw = vv ? vv.width : window.innerWidth;
      var menuClear = 58;
      var edge = 8;
      var gap = board ? (parseFloat(window.getComputedStyle(board).gap) || 18) : 18;
      var leadH = (lead && lead.offsetParent !== null) ? lead.offsetHeight : 0;
      var sideW = sideCol ? sideCol.offsetWidth : 256;
      var bar = transportH();
      var availH = vh - leadH - edge * 2 - bar;
      var availW = vw - menuClear - edge - sideW - gap;
      var side = Math.floor(Math.min(availH, availW));
      if (side < 140) side = 140;
      applySize(side);
      var bar2 = transportH();
      if (bar2 !== bar) {
        availH = vh - leadH - edge * 2 - bar2;
        side = Math.floor(Math.min(availH, availW));
        if (side < 140) side = 140;
        applySize(side);
      }
      if (sideCol) sideCol.style.maxHeight = side + "px";
    } else {
      if (sideCol) sideCol.style.maxHeight = "";
      if (stage) stage.style.width = "";
      var side = Math.floor(board.clientWidth);
      applySize(side);
    }
  }
  window.addEventListener("resize", fitPlot);
  window.addEventListener("orientationchange", function () { setTimeout(fitPlot, 80); });
  fitPlot();
  var data = null, selected = -1;
  var on = {};
  var view = { k: 1, tx: 0, ty: 0 };
  var KMIN = 1, KMAX = 28;
  var pointers = {};
  var pinch = null;
  var drag = null;
  var moved = false;

  function pad() { return 56; }
  function cssToCanvas(cssX, cssY) {
    var rect = canvas.getBoundingClientRect();
    return [cssX * canvas.width / rect.width, cssY * canvas.height / rect.height];
  }
  function basePix(x, y) {
    var p = pad(), s = canvas.width - 2 * p;
    return [p + (x / 360) * s, p + (1 - y / 360) * s];
  }
  function toPix(x, y) {
    var b = basePix(x, y);
    return [b[0] * view.k + view.tx, b[1] * view.k + view.ty];
  }
  function fromCanvas(cx, cy) {
    var p = pad(), s = canvas.width - 2 * p;
    var bx = (cx - view.tx) / view.k;
    var by = (cy - view.ty) / view.k;
    return [(bx - p) / s * 360, (1 - (by - p) / s) * 360];
  }
  function clampView() {
    view.k = Math.max(KMIN, Math.min(KMAX, view.k));
    var p = pad(), s = canvas.width - 2 * p;
    var left = p * view.k + view.tx;
    var top = p * view.k + view.ty;
    var right = (p + s) * view.k + view.tx;
    var bottom = (p + s) * view.k + view.ty;
    if (left > p) view.tx += p - left;
    if (top > p) view.ty += p - top;
    if (right < p + s) view.tx += (p + s) - right;
    if (bottom < p + s) view.ty += (p + s) - bottom;
  }
  function zoomAt(cx, cy, factor) {
    var k2 = Math.max(KMIN, Math.min(KMAX, view.k * factor));
    var f = k2 / view.k;
    view.tx = cx - (cx - view.tx) * f;
    view.ty = cy - (cy - view.ty) * f;
    view.k = k2;
    clampView();
  }
  function resetView() {
    view.k = 1; view.tx = 0; view.ty = 0;
    draw();
  }
  var shellStats = {};

  var TL = window.StarlinkTimeline, hexToRgba = TL.hexToRgba; // shared chart drawing: timeline.js
  function colorOf(sid) {
    if (!window.StarlinkColors.on()) return window.StarlinkColors.GREY;
    for (var i = 0; i < data.shells.length; i++) {
      if (data.shells[i].id === sid) return data.shells[i].color;
    }
    return "#fff";
  }
  function buildShellStats() {
    var by = {};
    for (var i = 0; i < data.sats.length; i++) {
      var s = data.sats[i];
      (by[s.s] || (by[s.s] = [])).push(s.alt);
    }
    shellStats = {};
    data.shells.forEach(function (sh) {
      var alts = (by[sh.id] || []).slice().sort(function (a, b) { return a - b; });
      var med = alts.length ? alts[(alts.length / 2) | 0] : 0;
      var devs = alts.map(function (a) { return Math.abs(a - med); }).sort(function (a, b) { return a - b; });
      var mad = devs.length ? devs[(devs.length / 2) | 0] : 0;
      var dmax = devs.length ? devs[devs.length - 1] : 0;
      var sigma = Math.max(1.4826 * mad * 2.2, 1e-6);
      var gmin = Math.exp(-0.5 * (dmax / sigma) * (dmax / sigma));
      shellStats[sh.id] = { med: med, sigma: sigma, dmax: dmax, gmin: gmin, full: sh.color };
    });
  }
  function satFill(sat) {
    var st = shellStats[sat.s];
    var hex = colorOf(sat.s);
    if (!st) return hex;
    if (st.dmax < 1e-9) return hex;
    var d = Math.abs(sat.alt - st.med);
    var g = Math.exp(-0.5 * (d / st.sigma) * (d / st.sigma));
    var a = (g - st.gmin) / (1 - st.gmin);
    if (a < 0) a = 0;
    if (a > 1) a = 1;
    return hexToRgba(hex, a);
  }
  function visibleCount() {
    var n = 0;
    for (var i = 0; i < data.sats.length; i++) if (on[data.sats[i].s]) n++;
    return n;
  }
  function updateMeta() {
    if (!data) return;
    var d = new Date(data.epoch);
    document.querySelector("[data-meta]").textContent =
      d.toISOString().slice(0, 10) + "  " + d.toISOString().slice(11, 16) + " UTC  ·  " +
      visibleCount() + " / " + data.n + " satellites";
  }

  function draw() {
    if (tl && tl.active()) {
      tl.draw();
      return;
    }
    if (!data) return;
    var w = canvas.width, p = pad(), s = w - 2 * p;
    TL.chartFrame(ctx, w, p);
    var r = TL.dotRadius(view.k, KMAX);
    var dim = selected >= 0 && on[data.sats[selected].s];
    var lw = Math.max(0.9, r * 0.28);
    for (var i = 0; i < data.sats.length; i++) {
      var sat = data.sats[i];
      if (!on[sat.s] || i === selected) continue;
      var xy = toPix(sat.x, sat.y);
      var hex = colorOf(sat.s);
      TL.dot(ctx, xy, r, lw, dim ? hexToRgba(hex, 0.3) : satFill(sat), dim ? hexToRgba(hex, 0.3) : hex);
    }
    if (selected >= 0 && on[data.sats[selected].s]) {
      var sat = data.sats[selected];
      var xy = toPix(sat.x, sat.y);
      TL.pickedDot(ctx, xy, r, lw, satFill(sat), colorOf(sat.s), sat.name, p, s);
    }
    ctx.restore();
    updateMeta();
  }

  function nearest(cssX, cssY) {
    var cxy = cssToCanvas(cssX, cssY);
    var xy = fromCanvas(cxy[0], cxy[1]);
    var best = -1, bestD = 1e9;
    for (var i = 0; i < data.sats.length; i++) {
      if (!on[data.sats[i].s]) continue;
      var dx = data.sats[i].x - xy[0], dy = data.sats[i].y - xy[1];
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return -1;
    var pix = toPix(data.sats[best].x, data.sats[best].y);
    var distPx = Math.hypot(pix[0] - cxy[0], pix[1] - cxy[1]);
    var rect = canvas.getBoundingClientRect();
    return distPx * (rect.width / canvas.width) <= 16 ? best : -1;
  }

  function showPick(i, quiet) {
    var el = document.querySelector("[data-pick]");
    if (!quiet && !(tl && tl.active())) window.StarlinkSel.set(i >= 0 ? data.sats[i].id : null, i >= 0 ? data.sats[i].name : "");
    if (i < 0) { el.textContent = "Tap a satellite"; return; }
    var sat = data.sats[i];
    var sh = data.shells.find(function (s) { return s.id === sat.s; });
    el.innerHTML = "<strong><a class=\"sat-link\" href=\"https://satellitemap.space/sat/" + sat.id + "\" target=\"_blank\" rel=\"noopener\">" + sat.name + "<span class=\"ext\" aria-hidden=\"true\">↗</span></a></strong>" +
      sat.alt.toFixed(2) + " km · " + (sh ? String(sh.label).replace(/· raising$/, "· orbit raising") : sat.s) +
      (window.StarlinkLaunch(sat.id) ? " · " + window.StarlinkLaunch(sat.id) : "");
  }

  function eventCss(e) {
    var rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var css = eventCss(e);
    var cxy = cssToCanvas(css[0], css[1]);
    zoomAt(cxy[0], cxy[1], e.deltaY < 0 ? 1.12 : 1 / 1.12);
    draw();
  }, { passive: false });

  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    var css = eventCss(e);
    pointers[e.pointerId] = { x: css[0], y: css[1] };
    var ids = Object.keys(pointers);
    if (ids.length === 2) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        k: view.k, tx: view.tx, ty: view.ty
      };
      drag = null;
    } else {
      drag = { x: css[0], y: css[1], tx: view.tx, ty: view.ty };
      moved = false;
    }
  });

  canvas.addEventListener("pointermove", function (e) {
    if (!pointers[e.pointerId]) return;
    var css = eventCss(e);
    pointers[e.pointerId] = { x: css[0], y: css[1] };
    var ids = Object.keys(pointers);
    if (pinch && ids.length === 2) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var dist = Math.hypot(a.x - b.x, a.y - b.y);
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var cxy = cssToCanvas(pinch.mx, pinch.my);
      view.k = pinch.k; view.tx = pinch.tx; view.ty = pinch.ty;
      if (pinch.dist > 4) zoomAt(cxy[0], cxy[1], dist / pinch.dist);
      var nxy = cssToCanvas(mx, my), oxy = cssToCanvas(pinch.mx, pinch.my);
      view.tx += nxy[0] - oxy[0];
      view.ty += nxy[1] - oxy[1];
      clampView();
      moved = true;
      draw();
      return;
    }
    if (drag && ids.length === 1) {
      var dx = css[0] - drag.x, dy = css[1] - drag.y;
      if (Math.hypot(dx, dy) > 6) {
        moved = true;
        canvas.classList.add("drag");
      }
      if (moved) {
        var c0 = cssToCanvas(drag.x, drag.y);
        var c1 = cssToCanvas(css[0], css[1]);
        view.tx = drag.tx + (c1[0] - c0[0]);
        view.ty = drag.ty + (c1[1] - c0[1]);
        clampView();
        draw();
      }
    }
  });

  function inPlotField(cssX, cssY) {
    var cxy = cssToCanvas(cssX, cssY);
    var p = pad(), s = canvas.width - 2 * p;
    return cxy[0] >= p && cxy[0] <= p + s && cxy[1] >= p && cxy[1] <= p + s;
  }
  function endPtr(e) {
    var css = eventCss(e);
    delete pointers[e.pointerId];
    var ids = Object.keys(pointers);
    if (ids.length < 2) pinch = null;
    if (ids.length === 1) {
      var p = pointers[ids[0]];
      drag = { x: p.x, y: p.y, tx: view.tx, ty: view.ty };
    }
    if (ids.length === 0) {
      canvas.classList.remove("drag");
      if (!moved && inPlotField(css[0], css[1])) {
        if (tl && tl.active()) {
          if (!tl.playing()) tl.pickAt(css[0], css[1]);
        } else {
          selected = selected >= 0 ? -1 : nearest(css[0], css[1]);
          showPick(selected);
        }
        draw();
      }
      drag = null;
      moved = false;
    }
  }
  canvas.addEventListener("pointerup", endPtr);
  canvas.addEventListener("pointercancel", endPtr);
  canvas.addEventListener("dblclick", function (e) {
    e.preventDefault();
    resetView();
  });

  var INC_LABEL = { 43: "43°", 53: "53°", 70: "70°", 97: "97.6°" };

  function shellsOf(inc) {
    return data.shells.filter(function (s) { return s.inc === inc; });
  }
  function isListed(sh) {
    return sh.listed !== false && sh.km != null;
  }
  function listedOf(inc) {
    return shellsOf(inc).filter(isListed);
  }
  function incOrder() {
    var seen = [];
    data.shells.forEach(function (s) {
      if (seen.indexOf(s.inc) === -1) seen.push(s.inc);
    });
    return seen;
  }
  function clearIfHidden() {
    if (selected >= 0 && !on[data.sats[selected].s]) {
      selected = -1;
      showPick(-1);
    }
  }
  function setShellChecks(ids, v) {
    ids.forEach(function (id) {
      on[id] = v;
      var el = document.querySelector('[data-shell="' + id + '"]');
      if (el) { el.checked = v; el.indeterminate = false; }
    });
  }
  function syncTree() {
    var allBox = document.querySelector("[data-all]");
    var allIds = data.shells.map(function (s) { return s.id; });
    var nAll = allIds.filter(function (id) { return on[id]; }).length;
    allBox.checked = nAll === allIds.length;
    allBox.indeterminate = nAll > 0 && nAll < allIds.length;
    incOrder().forEach(function (inc) {
      var ids = shellsOf(inc).map(function (s) { return s.id; });
      var nOn = ids.filter(function (id) { return on[id]; }).length;
      var box = document.querySelector('[data-inc="' + inc + '"]');
      if (!box) return;
      box.checked = nOn === ids.length && ids.length > 0;
      box.indeterminate = nOn > 0 && nOn < ids.length;
    });
  }

  function buildFilters() {
    var root = document.querySelector("[data-filters]");
    window.StarlinkShells.known(data.shells.map(function (sh) { return sh.id; }));
    data.shells.forEach(function (sh) { on[sh.id] = window.StarlinkShells.isOn(sh.id); });
    incOrder().forEach(function (inc) {
      var group = shellsOf(inc);
      var n = group.reduce(function (a, s) { return a + s.n; }, 0);
      var rows = listedOf(inc).map(function (sh) {
        return "<label class=\"chk\"><input type=\"checkbox\" data-shell=\"" + sh.id + "\" checked>" +
          "<span class=\"swatch\" style=\"background:" + sh.color + "\"></span>" +
          sh.km + " km <em>" + sh.n + " satellites</em></label>";
      }).join("") +
      // satellites still raising (or lowering) in this inclination: last row, like on the Globe
      shellsOf(inc).filter(function (sh) { return !isListed(sh) && sh.n > 0; }).map(function (sh) {
        return "<label class=\"chk\"><input type=\"checkbox\" data-shell=\"" + sh.id + "\" checked>" +
          "<span class=\"swatch\" style=\"background:" + sh.color + "\"></span>" +
          "orbit raising <em>" + sh.n + " satellites</em></label>";
      }).join("");
      root.insertAdjacentHTML("beforeend", window.StarlinkIncBlock.html(inc, inc === 53, "data-inc=\"" + inc + "\"",
        INC_LABEL[inc] || (inc + "°"), n, rows));
    });

    window.StarlinkIncBlock.bind(root);
    root.querySelector("[data-all]").addEventListener("change", function () {
      setShellChecks(data.shells.map(function (s) { return s.id; }), this.checked);
      this.indeterminate = false;
      window.StarlinkShells.set(data.shells.map(function (s) { return s.id; }), this.checked);
      clearIfHidden();
      syncTree();
      draw();
    });
    root.querySelectorAll("[data-inc]").forEach(function (el) {
      el.addEventListener("change", function () {
        var inc = parseInt(this.getAttribute("data-inc"), 10);
        setShellChecks(shellsOf(inc).map(function (s) { return s.id; }), this.checked);
        this.indeterminate = false;
        window.StarlinkShells.set(shellsOf(inc).map(function (s) { return s.id; }), this.checked);
        clearIfHidden();
        syncTree();
        draw();
      });
    });
    root.querySelectorAll("[data-shell]").forEach(function (el) {
      el.addEventListener("change", function () {
        on[this.getAttribute("data-shell")] = this.checked;
        window.StarlinkShells.set([this.getAttribute("data-shell")], this.checked);
        clearIfHidden();
        syncTree();
        draw();
      });
    });
  }

  // shell visibility shared with the Globe / URL
  function syncFromShared() {
    if (!data) return;
    data.shells.forEach(function (sh) {
      on[sh.id] = window.StarlinkShells.isOn(sh.id);
      var el = document.querySelector('[data-shell="' + sh.id + '"]');
      if (el) { el.checked = on[sh.id]; el.indeterminate = false; }
    });
    syncTree();
    if (data.sats[selected] && !on[data.sats[selected].s]) { selected = -1; showPick(-1, true); }
    updateMeta();
    draw();
  }
  window.StarlinkShells.sub(syncFromShared);
  // adopt the shared selection (from the URL or the Globe)
  window.__chartSync = function () {
    if (!data || (tl && tl.active())) return;
    var s = window.StarlinkSel.get(), el = document.querySelector("[data-pick]");
    if (s.id == null) { if (selected >= 0) { selected = -1; showPick(-1, true); draw(); } return; }
    var idx = -1;
    for (var i = 0; i < data.sats.length; i++) if (data.sats[i].id === s.id) { idx = i; break; }
    if (idx >= 0 && on[data.sats[idx].s]) { selected = idx; showPick(idx, true); draw(); return; }
    selected = -1; draw();
    var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
    var launch = window.StarlinkLaunch(s.id);
    el.innerHTML = "<strong><a class=\"sat-link\" href=\"https://satellitemap.space/sat/" + s.id + "\" target=\"_blank\" rel=\"noopener\">" +
      esc(s.name || ("NORAD " + s.id)) + "<span class=\"ext\" aria-hidden=\"true\">↗</span></a></strong>" +
      (launch ? launch + " · " : "") +
      (idx >= 0 ? "in a shell that is turned off here" : "not in the chart data, only on the Globe");
  };

  function incOn(inc) {
    if (inc === 43 || inc === 53 || inc === 70 || inc === 97) {
      var box = document.querySelector('[data-inc="' + inc + '"]');
      if (!box) return true;
      return box.checked || box.indeterminate;
    }
    var all = document.querySelector("[data-all]");
    return !all || all.checked || all.indeterminate;
  }

  var colorsBox = document.querySelector("[data-colors]");
  colorsBox.checked = window.StarlinkColors.on();
  colorsBox.addEventListener("change", function () { window.StarlinkColors.set(this.checked); });
  window.StarlinkColors.sub(function (v) { colorsBox.checked = v; draw(); });
  var tl = null;
  if (window.StarlinkTimeline) {
    tl = window.StarlinkTimeline.mount({
      canvas: canvas,
      ctx: ctx,
      view: view,
      KMAX: KMAX,
      pad: pad,
      toPix: toPix,
      fromCanvas: fromCanvas,
      cssToCanvas: cssToCanvas,
      catalogUrl: "/starlink/timeline/catalog.json?v=w10sm",
      binUrl: function (ym) { return "/starlink/timeline/v1/" + ym + ".bin?v=w10sm"; },
      incOn: incOn,
      onRedraw: function () { draw(); },
      onMode: function (timeline) {
        document.body.classList.toggle("is-timeline", timeline);
        if (!timeline) {
          selected = -1;
          showPick(-1);
          if (data) updateMeta();
        }
        fitPlot();
      },
      onMeta: function (text) {
        document.querySelector("[data-meta]").textContent = text;
      },
      onPick: function (html, text) {
        var el = document.querySelector("[data-pick]");
        if (html) el.innerHTML = html;
        else el.textContent = text || "Tap a satellite";
      }
    });
  }

  var satsP = fetch("./sats.json", { cache: "no-store" })
    .then(function (r) { return r.json(); });
  window.__starlinkSatsP = satsP;
  satsP
    .then(function (j) {
      data = j;
      buildShellStats();
      buildFilters();
      syncFromShared();
      if (window.StarlinkView.get() === "chart") window.__chartSync();
      fitPlot();
      if (tl && tl.alignToday) {
        tl.alignToday(data.sats).then(function () { draw(); }, function () { draw(); });
      } else {
        draw();
      }
    })
    .catch(function () {
      document.querySelector("[data-meta]").textContent = "Sat list missing.";
    });
})();

(function () {
  var globe = null, globeP = null;
  var sec = document.querySelector("[data-globe]");
  function apply() {
    var g = window.StarlinkView.get() === "globe";
    sec.hidden = !g;
    document.querySelectorAll("[data-tab]").forEach(function (t) {
      t.setAttribute("aria-selected", (t.getAttribute("data-tab") === "globe") === g ? "true" : "false");
    });
    if (g) {
      if (!globeP) {
        globeP = import("./globe.js?v=sg15").then(function (m) {
          globe = m.mountGlobe({
            root: sec, satsP: window.__starlinkSatsP,
            colorsOn: window.StarlinkColors.on, setColors: window.StarlinkColors.set
          });
          window.StarlinkColors.sub(function () { globe.colors(); });
          window.__starlinkGlobe = globe;
          return globe;
        });
      }
      globeP.then(function (gl) {
        if (window.StarlinkView.get() !== "globe") return;
        gl.show();
        gl.ready().then(function () { if (window.StarlinkView.get() === "globe") gl.syncSel(); });
      });
    } else {
      if (globe) globe.hide();
      window.dispatchEvent(new Event("resize"));
      if (window.__chartSync) window.__chartSync();
    }
  }
  document.querySelectorAll("[data-tab]").forEach(function (t) {
    t.addEventListener("click", function (e) {
      e.preventDefault();
      var want = t.getAttribute("data-tab") === "chart" ? "chart" : "globe";
      if (window.StarlinkView.get() === want) return;
      window.StarlinkView.set(want);
      apply();
    });
  });
  // our own URL updates use replaceState (no hashchange), so a hashchange is a pasted / edited link:
  // reload so view, satellite, shells and colors all come from it
  window.addEventListener("hashchange", function () { location.reload(); });
  apply();
  window.StarlinkWriteHash();
})();
