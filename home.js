(function () {
  var wrap = document.querySelector("[data-wave]");
  var root = document.documentElement;
  if (!wrap) return;

  var wave = wrap.querySelector(".wave");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  var fine = window.matchMedia("(pointer: fine)");

  var tx = 0, ty = 0, tr = 0;
  var x = 0, y = 0, r = 0;
  var lx = 52, ly = 34, tlx = 52, tly = 34;
  var t0 = performance.now();
  var running = false;

  var pointing = false;
  var aimR = 0;
  var restoreTimer = null;

  var WAVE = "\uD83D\uDC4B";
  var POINT = "\uD83D\uDC48";
  var ROCKET = "\uD83D\uDE80";
  var BOOM = "\uD83D\uDCA5";

  var tip = wrap.querySelector(".tip");
  if (!tip) {
    tip = document.createElement("i");
    tip.className = "tip";
    tip.setAttribute("aria-hidden", "true");
    wrap.appendChild(tip);
  }

  function follow(e) {
    if (!fine.matches || reduced.matches) return;
    var nx = (e.clientX / window.innerWidth) * 2 - 1;
    var ny = (e.clientY / window.innerHeight) * 2 - 1;
    tx = nx * 30;
    ty = ny * 20;
    tr = nx * 9 - ny * 3.5;
    tlx = 50 + nx * 26;
    tly = 32 + ny * 20;
  }

  function applyTransform() {
    var rot = pointing ? aimR : r;
    wrap.style.transform =
      "translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0)" +
      " rotateX(" + (-y * 0.22).toFixed(2) + "deg)" +
      " rotateY(" + (x * 0.18).toFixed(2) + "deg)" +
      " rotate(" + rot.toFixed(2) + "deg)";
  }

  function tick(now) {
    if (reduced.matches) {
      wrap.style.transform = "none";
      running = false;
      return;
    }

    var t = (now - t0) / 1000;
    var sx = Math.sin(t * 0.68) * 8;
    var sy = Math.cos(t * 0.52) * 5.5;
    var sr = Math.sin(t * 0.42) * 3.6;

    var k = 0.065;
    x += (tx + sx - x) * k;
    y += (ty + sy - y) * k;
    r += (tr + sr - r) * k;
    lx += (tlx - lx) * 0.08;
    ly += (tly - ly) * 0.08;

    applyTransform();

    root.style.setProperty("--lx", lx.toFixed(2) + "%");
    root.style.setProperty("--ly", ly.toFixed(2) + "%");

    requestAnimationFrame(tick);
  }

  function start() {
    if (running || reduced.matches) return;
    running = true;
    t0 = performance.now();
    requestAnimationFrame(tick);
  }

  function nearestDeg(from, to) {
    var d = to - from;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return from + d;
  }

  function bezierPoint(p0, p1, p2, p3, t) {
    var u = 1 - t;
    var tt = t * t;
    var uu = u * u;
    return {
      x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
      y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y
    };
  }

  function bezierTangent(p0, p1, p2, p3, t) {
    var u = 1 - t;
    return {
      x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
      y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y)
    };
  }

  function placeEl(el, px, py, rot, scale, opacity) {
    el.style.opacity = opacity == null ? "1" : String(opacity);
    el.style.transform =
      "translate3d(" + px.toFixed(2) + "px," + py.toFixed(2) + "px,0)" +
      " translate(-50%,-50%)" +
      " rotate(" + rot.toFixed(2) + "deg)" +
      " scale(" + (scale == null ? 1 : scale).toFixed(3) + ")";
  }

  function spawnBoom(px, py) {
    var el = document.createElement("div");
    el.className = "rocket boom";
    el.setAttribute("aria-hidden", "true");
    el.textContent = BOOM;
    document.body.appendChild(el);
    placeEl(el, px, py, 0, 0.85, 1);

    var started = performance.now();
    var dur = 420;

    function boomTick(now) {
      var t = Math.min(1, (now - started) / dur);
      placeEl(el, px, py, 0, 0.85 + t * 1.15, 1 - t * t);
      if (t < 1) requestAnimationFrame(boomTick);
      else if (el.parentNode) el.parentNode.removeChild(el);
    }
    requestAnimationFrame(boomTick);
  }

  function launchRocket(x0, y0, x1, y1) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    var len = Math.hypot(dx, dy);
    if (len < 8) {
      spawnBoom(x1, y1);
      return;
    }

    var inv = 1 / len;
    var nx = -dy * inv;
    var ny = dx * inv;
    var side = Math.random() < 0.5 ? 1 : -1;
    var b1 = (0.22 + Math.random() * 0.42) * len * side;
    var b2 = (0.22 + Math.random() * 0.42) * len * -side;
    var jx = (Math.random() - 0.5) * 0.12 * len;
    var jy = (Math.random() - 0.5) * 0.12 * len;

    var p0 = { x: x0, y: y0 };
    var p3 = { x: x1, y: y1 };
    var p1 = {
      x: x0 + dx * (0.28 + Math.random() * 0.12) + nx * b1 + jx,
      y: y0 + dy * (0.28 + Math.random() * 0.12) + ny * b1 + jy
    };
    var p2 = {
      x: x0 + dx * (0.58 + Math.random() * 0.14) + nx * b2 - jx,
      y: y0 + dy * (0.58 + Math.random() * 0.14) + ny * b2 - jy
    };

    var el = document.createElement("div");
    el.className = "rocket";
    el.setAttribute("aria-hidden", "true");
    el.textContent = ROCKET;
    document.body.appendChild(el);

    var dur = 460 + Math.min(len, 980) * 0.38;
    var started = performance.now();

    function flight(now) {
      var t = Math.min(1, (now - started) / dur);
      var e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      var p = bezierPoint(p0, p1, p2, p3, e);
      var d = bezierTangent(p0, p1, p2, p3, e);
      var ang = Math.atan2(d.y, d.x) * 180 / Math.PI + 45;
      placeEl(el, p.x, p.y, ang, 1, 1);
      if (t < 1) requestAnimationFrame(flight);
      else {
        if (el.parentNode) el.parentNode.removeChild(el);
        spawnBoom(x1, y1);
      }
    }
    requestAnimationFrame(flight);
  }

  function pointAt(clientX, clientY) {
    var rect = wrap.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var theta = Math.atan2(clientY - cy, clientX - cx);
    aimR = nearestDeg(r, (theta - Math.PI) * 180 / Math.PI);
    pointing = true;
    if (wave) wave.textContent = POINT;
    applyTransform();

    var tipRect = tip.getBoundingClientRect();
    var tipX = tipRect.left;
    var tipY = tipRect.top;

    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(function () {
      pointing = false;
      r = aimR;
      if (wave) wave.textContent = WAVE;
      restoreTimer = null;
    }, 200 + Math.random() * 80);

    return { tipX: tipX, tipY: tipY };
  }

  function onPointer(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var node = e.target;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (node && node.closest && node.closest(".chip")) return;

    var cx = e.clientX;
    var cy = e.clientY;

    if (reduced.matches) {
      if (wave) wave.textContent = POINT;
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = setTimeout(function () {
        if (wave) wave.textContent = WAVE;
        restoreTimer = null;
      }, 180);
      spawnBoom(cx, cy);
      return;
    }

    var from = pointAt(cx, cy);
    launchRocket(from.tipX, from.tipY, cx, cy);
  }

  window.addEventListener("pointermove", follow, { passive: true });
  window.addEventListener("pointerdown", onPointer, { passive: true });

  reduced.addEventListener("change", function () {
    if (reduced.matches) {
      wrap.style.transform = "none";
      pointing = false;
      if (wave) wave.textContent = WAVE;
    } else {
      start();
    }
  });

  start();
})();
