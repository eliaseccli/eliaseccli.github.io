(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StarlinkTimeline = api;
})(typeof self !== "undefined" ? self : this, function () {
  var INC_COLOR = { 43: "#34d399", 53: "#fb923c", 70: "#22d3ee", 97: "#8b5cf6" };
  var INC_OTHER = "#64748b";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MAGIC = "STLK";
  var PACK_ID = "6efd2c9";
  var LOAD_ATTEMPTS = 3;
  var LOAD_RETRY_MS = 1000;
  var PREFETCH_MONTHS = 2;

  function withPack(url) {
    if (!url) return url;
    if (url.indexOf("v=" + PACK_ID) !== -1) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "v=" + PACK_ID;
  }

  function angleDeg(u16) {
    return (u16 * 360.0) / 65536.0;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function parseISO(s) {
    var p = String(s).split("-");
    return { y: +p[0], m: +p[1], d: +p[2] };
  }

  function toUTC(p) {
    return Date.UTC(p.y, p.m - 1, p.d);
  }

  function addDays(p, n) {
    var dt = new Date(toUTC(p) + n * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  function ymdInt(p) {
    return p.y * 10000 + p.m * 100 + p.d;
  }

  function monthKey(p) {
    return p.y + "-" + pad2(p.m);
  }

  function nextMonthKey(p) {
    if (p.m === 12) return (p.y + 1) + "-01";
    return p.y + "-" + pad2(p.m + 1);
  }

  function addMonthsKey(p, n) {
    var m = p.m + n;
    var y = p.y;
    while (m > 12) { m -= 12; y += 1; }
    while (m < 1) { m += 12; y -= 1; }
    return y + "-" + pad2(m);
  }

  function formatPlayhead(p) {
    return p.d + " " + MONTHS[p.m - 1] + " " + p.y;
  }

  function daysInclusive(a, b) {
    return Math.round((toUTC(b) - toUTC(a)) / 86400000) + 1;
  }

  var SCRUB_FINE_RANGE_PX = 140;
  var SCRUB_DAY_STEP_PX = 10;

  function clampNum(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function scrubDaysPerPx(absDy, trackWidth, nSteps) {
    if (!(trackWidth > 0) || !(nSteps > 0)) return 0;
    var coarse = nSteps / trackWidth;
    var fine = 1 / SCRUB_DAY_STEP_PX;
    var t = clampNum(Math.abs(absDy) / SCRUB_FINE_RANGE_PX, 0, 1);
    t = t * t;
    return coarse + (fine - coarse) * t;
  }

  function scrubKeyDelta(key, keyCode) {
    if (key === "ArrowLeft" || key === "Left" || key === "ArrowDown" || keyCode === 37 || keyCode === 40) return -1;
    if (key === "ArrowRight" || key === "Right" || key === "ArrowUp" || keyCode === 39 || keyCode === 38) return 1;
    if (key === "Home" || keyCode === 36) return "start";
    if (key === "End" || keyCode === 35) return "end";
    return 0;
  }

  function hexToRgba(hex, a) {
    var h = hex.replace("#", "");
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + a.toFixed(3) + ")";
  }

  function decodeMonth(buffer) {
    if (!buffer || buffer.byteLength < 32) throw new Error("timeline bin too short");
    var view = new DataView(buffer);
    var magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== MAGIC) throw new Error("bad timeline magic");
    var version = view.getUint8(4);
    if (version !== 1) throw new Error("unsupported timeline version");
    var year = view.getUint16(8, true);
    var month = view.getUint8(10);
    var nDays = view.getUint8(11);
    var catalogLen = view.getUint32(12, true);
    var firstDate = view.getUint32(16, true);
    var maskBytes = Math.ceil(catalogLen / 8);
    var off = 32;
    var days = [];
    var d, i, date, flags, n, xRaw, yRaw;
    var slots, xs, ys;
    for (d = 0; d < nDays; d++) {
      if (off + 8 + maskBytes > buffer.byteLength) throw new Error("truncated timeline day header");
      date = view.getUint32(off, true);
      off += 4;
      flags = view.getUint8(off);
      off += 4;
      n = 0;
      for (i = 0; i < catalogLen; i++) {
        if (view.getUint8(off + (i >> 3)) & (1 << (i & 7))) n++;
      }
      if (off + maskBytes + n * 4 > buffer.byteLength) throw new Error("truncated timeline coords");
      slots = new Uint32Array(n);
      xs = new Float32Array(n);
      ys = new Float32Array(n);
      n = 0;
      for (i = 0; i < catalogLen; i++) {
        if (view.getUint8(off + (i >> 3)) & (1 << (i & 7))) {
          slots[n] = i;
          n++;
        }
      }
      off += maskBytes;
      for (i = 0; i < n; i++) {
        xRaw = view.getUint16(off, true);
        off += 2;
        yRaw = view.getUint16(off, true);
        off += 2;
        xs[i] = angleDeg(xRaw);
        ys[i] = angleDeg(yRaw);
      }
      days.push({ date: date, flags: flags, n: n, slot: slots, x: xs, y: ys });
    }
    return {
      magic: magic,
      version: version,
      year: year,
      month: month,
      nDays: nDays,
      catalogLen: catalogLen,
      firstDate: firstDate,
      days: days
    };
  }

  function mount(opts) {
    opts = opts || {};
    var canvas = opts.canvas;
    var ctx = opts.ctx;
    var view = opts.view;
    var KMAX = opts.KMAX || 28;
    var padFn = opts.pad;
    var toPix = opts.toPix;
    var fromCanvas = opts.fromCanvas;
    var cssToCanvas = opts.cssToCanvas;
    var catalogUrl = withPack(opts.catalogUrl || "/starlink/timeline/catalog.json");
    var binUrl = opts.binUrl || function (ym) {
      return "/starlink/timeline/v1/" + ym + ".bin";
    };
    function binUrlFor(ym) {
      var url = typeof binUrl === "function" ? binUrl(ym) : binUrl;
      return withPack(url);
    }
    var playBtn = document.querySelector("[data-tl-play]");
    var stopBtn = document.querySelector("[data-tl-stop]");
    var scrub = document.querySelector("[data-tl-scrub]");
    var scrubInput = document.querySelector("[data-tl-scrub-input]");
    var dateEl = document.querySelector("[data-tl-date]");
    var fpsEl = document.querySelector("[data-tl-fps]");
    var fpsLabel = document.querySelector("[data-tl-fps-label]");

    var catalog = null;
    var start = null;
    var end = null;
    var nDays = 0;
    var PLAYBACK_FPS = 15;
    var FPS_MIN = 1;
    var FPS_MAX = 15;
    var fps = PLAYBACK_FPS;
    var index = 0;
    var todayIndex = 0;
    var mode = "today";
    var playing = false;
    var raf = 0;
    var lastTick = 0;
    var acc = 0;
    var selected = -1;
    var lastFrame = null;
    var lastFrameDate = 0;
    var months = {};

    function emitMode() {
      if (opts.onMode) opts.onMode(mode === "timeline", playing);
    }

    function emitMeta(text) {
      if (opts.onMeta) opts.onMeta(text);
    }

    function emitPick(html, text) {
      if (opts.onPick) opts.onPick(html, text);
    }

    function redraw() {
      if (opts.onRedraw) opts.onRedraw();
    }

    function incOn(inc) {
      return opts.incOn ? opts.incOn(inc) : true;
    }

    function dateAt(i) {
      return addDays(start, i);
    }

    function scrubIndex() {
      return mode === "today" ? todayIndex : index;
    }

    function renderScrub() {
      if (!scrub) return;
      var max = todayIndex > 0 ? todayIndex : 1;
      var v = scrubIndex();
      if (v < 0) v = 0;
      if (v > max) v = max;
      scrub.setAttribute("data-value", String(v));
      if (scrub.max !== undefined && scrub.tagName === "INPUT") {
        scrub.max = String(max);
        scrub.value = String(v);
      }
      scrub.setAttribute("aria-valuemin", "0");
      scrub.setAttribute("aria-valuemax", String(max));
      scrub.setAttribute("aria-valuenow", String(v));
      var label = mode === "today" ? "Today" : (start ? formatPlayhead(dateAt(index)) : "Today");
      scrub.setAttribute("aria-valuetext", label);
      if (scrubInput) {
        scrubInput.max = String(max);
        scrubInput.min = "0";
        scrubInput.step = "1";
        scrubInput.value = String(v);
      }
      var pct = (100 * v / max);
      var fill = scrub.querySelector("[data-tl-fill]");
      var thumb = scrub.querySelector("[data-tl-thumb]");
      if (fill) fill.style.width = pct + "%";
      if (thumb) thumb.style.left = pct + "%";
    }

    function syncScrub() {
      renderScrub();
    }

    function syncDate() {
      if (!dateEl) return;
      dateEl.textContent = mode === "today" ? "Today" : formatPlayhead(dateAt(index));
    }

    function syncButtons() {
      if (playBtn) {
        playBtn.textContent = playing ? "Pause" : "Play";
        playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
      }
    }

    function clampFps(v) {
      v = parseInt(v, 10);
      if (!isFinite(v)) v = PLAYBACK_FPS;
      if (v < FPS_MIN) v = FPS_MIN;
      if (v > FPS_MAX) v = FPS_MAX;
      return v;
    }

    function syncFps() {
      if (fpsLabel) fpsLabel.textContent = fps + " fps";
      if (fpsEl) fpsEl.value = String(fps);
    }

    function onFps() {
      if (!fpsEl) return;
      fps = clampFps(fpsEl.value);
      var frameMs = 1000 / fps;
      if (acc > frameMs) acc = frameMs;
      syncFps();
    }

    function syncUi() {
      syncScrub();
      syncDate();
      syncButtons();
      syncFps();
    }

    function setToday() {
      var was = mode;
      playing = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      mode = "today";
      index = todayIndex;
      selected = -1;
      lastFrame = null;
      lastFrameDate = 0;
      syncUi();
      emitPick(null, "Tap a satellite");
      if (was !== "today") emitMode();
      else emitMode();
    }

    function enterTimeline(i) {
      if (i < 0) i = 0;
      if (i >= nDays) {
        setToday();
        redraw();
        return;
      }
      var was = mode;
      mode = "timeline";
      index = i;
      selected = -1;
      syncUi();
      if (was !== "timeline") emitMode();
    }

    function loadCatalog() {
      return fetch(catalogUrl, { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("catalog " + r.status);
          return r.json();
        })
        .then(function (j) {
          catalog = j;
          start = parseISO(j.start);
          end = parseISO(j.end);
          nDays = daysInclusive(start, end);
          todayIndex = nDays;
          index = todayIndex;
          syncUi();
          prefetchAhead(start, PREFETCH_MONTHS);
          prefetch(monthKey(end));
          return catalog;
        });
    }

    function storeMonth(ym, rec) {
      months[ym] = rec;
      return rec;
    }

    function attemptFetch(ym, left) {
      return fetch(binUrlFor(ym))
        .then(function (r) {
          if (!r.ok) throw new Error("bin " + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          return storeMonth(ym, { status: "ok", data: decodeMonth(buf) });
        })
        .catch(function () {
          if (left > 1) return attemptFetch(ym, left - 1);
          return storeMonth(ym, { status: "failed", retryAt: Date.now() + LOAD_RETRY_MS });
        });
    }

    function loadMonth(ym) {
      var rec = months[ym];
      if (rec) {
        if (rec.status === "pending") return rec.promise;
        if (rec.status === "ok") return Promise.resolve(rec);
        if (rec.status === "failed" && rec.retryAt && Date.now() < rec.retryAt) {
          return Promise.resolve(rec);
        }
      }
      var p = attemptFetch(ym, LOAD_ATTEMPTS)
        .then(function (done) {
          if (mode === "timeline") redraw();
          return done;
        });
      months[ym] = { status: "pending", promise: p };
      return p;
    }

    function frameFromMonth(rec, dateInt) {
      if (!rec || rec.status !== "ok" || !rec.data) return null;
      var days = rec.data.days;
      for (var i = 0; i < days.length; i++) {
        if (days[i].date === dateInt) return days[i];
      }
      return null;
    }

    function holdFrame(dateInt) {
      if (lastFrame && lastFrame.date <= dateInt) return lastFrame;
      var best = null, bestDate = -1, ym, rec, days, i;
      for (ym in months) {
        rec = months[ym];
        if (!rec || rec.status !== "ok" || !rec.data) continue;
        days = rec.data.days;
        for (i = 0; i < days.length; i++) {
          if (days[i].date <= dateInt && days[i].date >= bestDate) {
            bestDate = days[i].date;
            best = days[i];
          }
        }
      }
      if (best) lastFrame = best;
      return lastFrame;
    }

    function prefetch(ym) {
      if (!ym) return;
      if (end && ym > monthKey(end)) return;
      var rec = months[ym];
      if (rec && rec.status !== "failed") return;
      loadMonth(ym);
    }

    function prefetchAhead(p, extra) {
      if (!p) return;
      extra = extra == null ? PREFETCH_MONTHS : extra;
      prefetch(monthKey(p));
      var i;
      for (i = 1; i <= extra; i++) prefetch(addMonthsKey(p, i));
    }

    function monthRec(i) {
      if (!start || i < 0 || i >= nDays) return null;
      return months[monthKey(dateAt(i))] || null;
    }

    function resolveFrame(i) {
      if (!start || i < 0 || i >= nDays) return lastFrame;
      var p = dateAt(i);
      var ym = monthKey(p);
      var rec = months[ym];
      if (!rec) loadMonth(ym);
      prefetchAhead(p, PREFETCH_MONTHS);
      rec = months[ym];
      if (!rec || rec.status === "pending" || rec.status === "failed") {
        return null;
      }
      var found = frameFromMonth(rec, ymdInt(p));
      if (found) {
        lastFrame = found;
        return found;
      }
      return holdFrame(ymdInt(p));
    }

    function ensureFrame(i) {
      if (!start || i < 0 || i >= nDays) return Promise.resolve(lastFrame);
      var p = dateAt(i);
      prefetchAhead(p, PREFETCH_MONTHS);
      return loadMonth(monthKey(p)).then(function () {
        return resolveFrame(i);
      });
    }

    function visibleStats(frame) {
      var vis = 0, total = 0;
      if (!frame) return { vis: 0, total: 0 };
      total = frame.n;
      for (var i = 0; i < frame.n; i++) {
        var sat = catalog && catalog.sats ? catalog.sats[frame.slot[i]] : null;
        var inc = sat ? sat.inc : 0;
        if (incOn(inc)) vis++;
      }
      return { vis: vis, total: total };
    }

    function metaText(frame) {
      var p = dateAt(index);
      var st = visibleStats(frame);
      return formatPlayhead(p) + "  ·  " + st.vis + " / " + st.total + " satellites";
    }

    function drawLabel(xy, r, name, p, s) {
      ctx.fillStyle = "#fff";
      ctx.font = "42px system-ui,sans-serif";
      var tw = ctx.measureText(name).width;
      var th = 42;
      var gap = 16;
      var inset = 10;
      var L = p + inset, R = p + s - inset, T = p + inset, B = p + s - inset;
      var tx = xy[0] + r + gap;
      if (tx + tw > R) tx = xy[0] - r - gap - tw;
      if (tx < L) tx = L;
      if (tx + tw > R) tx = R - tw;
      var ty = xy[1] - r - 12;
      if (ty - th * 0.85 < T) ty = xy[1] + r + th * 0.85 + 10;
      if (ty > B) ty = B;
      if (ty - th * 0.85 < T) ty = T + th * 0.85;
      ctx.fillText(name, tx, ty);
    }

    function draw() {
      if (!canvas || !ctx) return;
      var w = canvas.width, p = padFn(), s = w - 2 * p;
      ctx.fillStyle = "#0a0a10";
      ctx.fillRect(0, 0, w, w);
      ctx.strokeStyle = "rgba(255,255,255,.12)";
      ctx.lineWidth = 1;
      ctx.strokeRect(p, p, s, s);
      ctx.fillStyle = "rgba(255,255,255,.45)";
      ctx.font = "22px system-ui,sans-serif";
      ctx.fillText("Anomaly (deg)", p + s / 2 - 70, w - 16);
      ctx.save();
      ctx.translate(20, p + s / 2 + 50);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("RAAN (deg)", 0, 0);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(p, p, s, s);
      ctx.clip();
      var frame = resolveFrame(index);
      var rMin = 3.36;
      var rMax = rMin * 8;
      var r = rMin * Math.pow(view.k, Math.log(rMax / rMin) / Math.log(KMAX));
      if (r > rMax) r = rMax;
      var lw = Math.max(0.9, r * 0.28);
      var showPick = !playing && selected >= 0;
      var i, sat, inc, hex, xy, dim;
      if (frame) {
        dim = showPick;
        for (i = 0; i < frame.n; i++) {
          sat = catalog && catalog.sats ? catalog.sats[frame.slot[i]] : null;
          inc = sat ? sat.inc : 0;
          if (!incOn(inc)) continue;
          if (showPick && frame.slot[i] === selected) continue;
          hex = INC_COLOR[inc] || INC_OTHER;
          xy = toPix(frame.x[i], frame.y[i]);
          ctx.fillStyle = dim ? hexToRgba(hex, 0.3) : hex;
          ctx.strokeStyle = dim ? hexToRgba(hex, 0.3) : hex;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.arc(xy[0], xy[1], r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        if (showPick) {
          for (i = 0; i < frame.n; i++) {
            if (frame.slot[i] !== selected) continue;
            sat = catalog && catalog.sats ? catalog.sats[frame.slot[i]] : null;
            inc = sat ? sat.inc : 0;
            if (!incOn(inc)) break;
            hex = INC_COLOR[inc] || INC_OTHER;
            xy = toPix(frame.x[i], frame.y[i]);
            ctx.fillStyle = hex;
            ctx.strokeStyle = hex;
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.arc(xy[0], xy[1], r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(xy[0], xy[1], r + 5, 0, Math.PI * 2);
            ctx.stroke();
            if (sat && sat.name) drawLabel(xy, r, sat.name, p, s);
            break;
          }
        }
      }
      ctx.restore();
      emitMeta(metaText(frame));
    }

    function nearest(cssX, cssY) {
      var frame = resolveFrame(index);
      if (!frame) return -1;
      var cxy = cssToCanvas(cssX, cssY);
      var xy = fromCanvas(cxy[0], cxy[1]);
      var best = -1, bestD = 1e9, bestSlot = -1;
      var i, dx, dy, d;
      for (i = 0; i < frame.n; i++) {
        var sat = catalog && catalog.sats ? catalog.sats[frame.slot[i]] : null;
        var inc = sat ? sat.inc : 0;
        if (!incOn(inc)) continue;
        dx = frame.x[i] - xy[0];
        dy = frame.y[i] - xy[1];
        d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; bestSlot = frame.slot[i]; }
      }
      if (best < 0) return -1;
      var pix = toPix(frame.x[best], frame.y[best]);
      var distPx = Math.hypot(pix[0] - cxy[0], pix[1] - cxy[1]);
      var rect = canvas.getBoundingClientRect();
      return distPx * (rect.width / canvas.width) <= 16 ? bestSlot : -1;
    }

    function showPick(slot) {
      selected = slot;
      if (slot < 0) {
        emitPick(null, "Tap a satellite");
        return;
      }
      var sat = catalog && catalog.sats ? catalog.sats[slot] : null;
      if (!sat) {
        emitPick(null, "Tap a satellite");
        return;
      }
      var lab = INC_COLOR[sat.inc] ? sat.inc + "\u00b0" : "other";
      emitPick("<strong>" + sat.name + "</strong>" + lab, null);
    }

    function pickAt(cssX, cssY) {
      if (playing) return;
      var slot = nearest(cssX, cssY);
      showPick(selected >= 0 ? -1 : slot);
    }

    function pause() {
      playing = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      syncButtons();
      emitMode();
      emitPick(null, "Tap a satellite");
      redraw();
    }

    function finishToToday() {
      setToday();
      redraw();
    }

    function step() {
      if (index + 1 >= nDays) {
        finishToToday();
        return false;
      }
      index += 1;
      selected = -1;
      syncUi();
      return true;
    }

    function tick(now) {
      if (!playing) return;
      if (!lastTick) lastTick = now;
      acc += now - lastTick;
      lastTick = now;
      var frameMs = 1000 / fps;
      var moved = false;
      while (acc >= frameMs) {
        var next = index + 1;
        if (next >= nDays) {
          finishToToday();
          return;
        }
        var rec = monthRec(next);
        if (!rec || rec.status !== "ok") {
          prefetchAhead(dateAt(next), PREFETCH_MONTHS);
          loadMonth(monthKey(dateAt(next)));
          if (acc > frameMs) acc = frameMs;
          break;
        }
        acc -= frameMs;
        if (!step()) return;
        moved = true;
        resolveFrame(index);
        prefetchAhead(dateAt(index), PREFETCH_MONTHS);
      }
      if (moved) redraw();
      raf = requestAnimationFrame(tick);
    }

    function startPlay() {
      if (mode === "today") enterTimeline(0);
      playing = true;
      selected = -1;
      lastTick = 0;
      acc = 0;
      syncButtons();
      emitMode();
      emitPick(null, "Playing");
      prefetchAhead(dateAt(index), PREFETCH_MONTHS);
      ensureFrame(index).then(function () {
        if (!playing) return;
        redraw();
        raf = requestAnimationFrame(tick);
      });
    }

    function togglePlay() {
      if (playing) {
        pause();
        return;
      }
      catalogReady.then(function () {
        if (!catalog || playing) return;
        startPlay();
      });
    }

    function applyScrubIndex(v) {
      v = Math.round(v);
      if (!isFinite(v)) return;
      if (v < 0) v = 0;
      if (v >= todayIndex) {
        finishToToday();
        return;
      }
      if (playing) {
        playing = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        syncButtons();
      }
      enterTimeline(v);
      ensureFrame(index).then(function () {
        emitPick(null, "Tap a satellite");
        redraw();
      });
    }

    function onScrub() {
      if (!catalog || !scrub) return;
      var raw = scrubInput ? scrubInput.value
        : (scrub.tagName === "INPUT" ? scrub.value : scrub.getAttribute("data-value"));
      applyScrubIndex(parseInt(raw, 10));
    }

    function setScrubbing(on) {
      if (scrub) scrub.classList.toggle("is-scrubbing", on);
      document.documentElement.classList.toggle("is-scrubbing", on);
      document.body.classList.toggle("is-scrubbing", on);
    }

    function bindFineScrub() {
      if (!scrub) return;
      if (scrub.tagName === "INPUT") {
        scrub.addEventListener("input", onScrub);
        scrub.addEventListener("change", onScrub);
        return;
      }
      var drag = null;

      function trackBox() {
        return scrub.getBoundingClientRect();
      }

      function valueAtClientX(clientX) {
        var r = trackBox();
        var w = r.width || 1;
        var x = clampNum(clientX - r.left, 0, w);
        return (x / w) * todayIndex;
      }

      function moveTo(v) {
        if (!catalog) return;
        applyScrubIndex(v);
      }

      function keyStep(e) {
        var delta = scrubKeyDelta(e.key, e.keyCode || e.which);
        if (!delta) return false;
        e.preventDefault();
        if (delta === "start") moveTo(0);
        else if (delta === "end") moveTo(todayIndex);
        else moveTo(scrubIndex() + delta);
        return true;
      }

      function onWindowTouchMove(e) {
        if (drag) e.preventDefault();
      }

      function onPointerDown(e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        try { scrub.focus({ preventScroll: true }); } catch (err) {}
        if (scrub.setPointerCapture) {
          try { scrub.setPointerCapture(e.pointerId); } catch (err) {}
        }
        setScrubbing(true);
        drag = { id: e.pointerId, lastX: e.clientX, value: valueAtClientX(e.clientX) };
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);
        window.addEventListener("touchmove", onWindowTouchMove, { passive: false });
        moveTo(drag.value);
      }

      function onPointerMove(e) {
        if (!drag || e.pointerId !== drag.id) return;
        e.preventDefault();
        var r = trackBox();
        var dpp = scrubDaysPerPx(e.clientY - (r.top + r.height / 2), r.width, todayIndex);
        drag.value = clampNum(drag.value + (e.clientX - drag.lastX) * dpp, 0, todayIndex);
        drag.lastX = e.clientX;
        moveTo(drag.value);
      }

      function onPointerUp(e) {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        setScrubbing(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        window.removeEventListener("touchmove", onWindowTouchMove);
      }

      scrub.addEventListener("pointerdown", onPointerDown);
      scrub.addEventListener("touchstart", function (e) { e.preventDefault(); }, { passive: false });
      scrub.addEventListener("touchmove", function (e) { e.preventDefault(); }, { passive: false });
      scrub.addEventListener("keydown", keyStep);
      if (scrubInput) {
        scrubInput.addEventListener("keydown", keyStep);
        scrubInput.addEventListener("input", onScrub);
        scrubInput.addEventListener("change", onScrub);
      }
      document.addEventListener("keydown", function (e) {
        var active = document.activeElement;
        if (active !== scrub && active !== scrubInput) return;
        keyStep(e);
      });
    }

    function alignToday(sats) {
      if (!sats || !sats.length) return Promise.resolve(false);
      var ready = catalog ? Promise.resolve(catalog) : catalogReady;
      return ready.then(function () {
        if (!catalog || nDays < 1) return false;
        return ensureFrame(nDays - 1).then(function (frame) {
          if (!frame) return false;
          var byId = {};
          var i, sat, rec, xy;
          for (i = 0; i < frame.n; i++) {
            sat = catalog.sats ? catalog.sats[frame.slot[i]] : null;
            if (sat) byId[sat.id] = [frame.x[i], frame.y[i]];
          }
          var changed = false;
          for (i = 0; i < sats.length; i++) {
            rec = sats[i];
            xy = byId[rec.id];
            if (!xy) continue;
            if (rec.x !== xy[0] || rec.y !== xy[1]) changed = true;
            rec.x = xy[0];
            rec.y = xy[1];
          }
          return changed;
        });
      }).catch(function () { return false; });
    }
    if (playBtn) playBtn.addEventListener("click", togglePlay);
    if (stopBtn) stopBtn.addEventListener("click", finishToToday);
    bindFineScrub();
    if (fpsEl) {
      fpsEl.addEventListener("input", onFps);
      fpsEl.addEventListener("change", onFps);
    }
    syncFps();

    var catalogReady = loadCatalog().catch(function () {
      if (dateEl) dateEl.textContent = "Today";
      emitMeta("Timeline catalog missing.");
    });

    return {
      active: function () { return mode === "timeline"; },
      playing: function () { return playing; },
      draw: draw,
      pickAt: pickAt,
      goToday: finishToToday,
      alignToday: alignToday
    };
  }

  return {
    decodeMonth: decodeMonth,
    PACK_ID: PACK_ID,
    withPack: withPack,
    angleDeg: angleDeg,
    INC_COLOR: INC_COLOR,
    INC_OTHER: INC_OTHER,
    mount: mount,
    scrubDaysPerPx: scrubDaysPerPx,
    scrubKeyDelta: scrubKeyDelta,
    SCRUB_FINE_RANGE_PX: SCRUB_FINE_RANGE_PX,
    SCRUB_DAY_STEP_PX: SCRUB_DAY_STEP_PX
  };
});
