(function () {
  function seeded(seed) {
    var s = seed >>> 0;
    return function () {
      s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function makeStarField() {
    var rand = seeded(0xE11A5C);
    var count = 168;
    var stars = [];
    var i;
    for (i = 0; i < count; i++) {
      var nx = rand();
      var ny = rand();
      var roll = rand();
      var hue;
      var sat;
      var light;
      var alpha;
      if (roll < 0.12) {
        hue = 200 + rand() * 20;
        sat = 32 + rand() * 28;
        light = 86 + rand() * 10;
        alpha = 0.55 + rand() * 0.35;
      } else if (roll < 0.22) {
        hue = 45 + rand() * 10;
        sat = 38 + rand() * 28;
        light = 84 + rand() * 10;
        alpha = 0.5 + rand() * 0.35;
      } else {
        hue = 210 + rand() * 16;
        sat = 3 + rand() * 8;
        light = 93 + rand() * 5;
        alpha = 0.42 + rand() * 0.4;
      }
      var sizeRoll = rand();
      var size;
      if (sizeRoll < 0.82) size = 0.35 + rand() * 0.65;
      else if (sizeRoll < 0.96) size = 0.95 + rand() * 0.7;
      else size = 1.7 + rand() * 0.9;
      stars.push({ nx: nx, ny: ny, hue: hue, sat: sat, light: light, alpha: alpha, size: size });
    }
    return stars;
  }

  var starField = makeStarField();
  var deadStars = {};

  function paintStars() {
    var canvas = document.querySelector("canvas.stars");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth;
    var h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var i;
    for (i = 0; i < starField.length; i++) {
      if (deadStars[i]) continue;
      var s = starField[i];
      ctx.beginPath();
      ctx.fillStyle = "hsla(" + s.hue + "," + s.sat + "%," + s.light + "%," + s.alpha + ")";
      ctx.arc(s.nx * w, s.ny * h, s.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function blastStars(px, py) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var radius = Math.max(48, Math.min(66, Math.min(w, h) * 0.075));
    var r2 = radius * radius;
    var i;
    for (i = 0; i < starField.length; i++) {
      if (deadStars[i]) continue;
      var s = starField[i];
      var dx = s.nx * w - px;
      var dy = s.ny * h - py;
      if (dx * dx + dy * dy <= r2) deadStars[i] = true;
    }
    paintStars();
  }

  paintStars();
  window.addEventListener("resize", paintStars);

  var wrap = document.querySelector("[data-wave]");
  if (!wrap) return;

  var wave = wrap.querySelector(".wave");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  var fine = window.matchMedia("(pointer: fine)");

  var tx = 0, ty = 0, tr = 0;
  var x = 0, y = 0, r = 0;
  var t0 = performance.now();
  var running = false;

  var pointing = false;
  var aimR = 0;
  var restoreTimer = null;
  var knocked = false;

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
  }

  function applyTransform(scaleX, scaleY) {
    var rot = pointing ? aimR : r;
    var sx = scaleX == null ? 1 : scaleX;
    var sy = scaleY == null ? 1 : scaleY;
    wrap.style.transform =
      "translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0)" +
      " rotateX(" + (-y * 0.22).toFixed(2) + "deg)" +
      " rotateY(" + (x * 0.18).toFixed(2) + "deg)" +
      " rotate(" + rot.toFixed(2) + "deg)" +
      " scale(" + sx.toFixed(3) + "," + sy.toFixed(3) + ")";
  }

  function tick(now) {
    if (reduced.matches) {
      wrap.style.transform = "none";
      running = false;
      return;
    }
    if (knocked) {
      requestAnimationFrame(tick);
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

    applyTransform();
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

  function easeOutBack(t) {
    var c1 = 2.05;
    var c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function inPalm(clientX, clientY) {
    if (!wave) return false;
    var rect = wave.getBoundingClientRect();
    var px = rect.left + rect.width * 0.47;
    var py = rect.top + rect.height * 0.56;
    var rx = rect.width * 0.3;
    var ry = rect.height * 0.28;
    var dx = (clientX - px) / rx;
    var dy = (clientY - py) / ry;
    return dx * dx + dy * dy <= 1;
  }

  function yeetHand(px, py) {
    knocked = true;
    pointing = false;
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    if (wave) wave.textContent = WAVE;

    var rect = wrap.getBoundingClientRect();
    var hx = rect.left + rect.width / 2;
    var hy = rect.top + rect.height / 2;
    var dx = hx - px;
    var dy = hy - py;
    var len = Math.hypot(dx, dy) || 1;
    var dirX = dx / len;
    var dirY = dy / len - 0.42;
    var n = Math.hypot(dirX, dirY) || 1;
    dirX /= n;
    dirY /= n;

    var dist = Math.max(window.innerWidth, window.innerHeight) * 1.45;
    var x0 = x;
    var y0 = y;
    var r0 = r;
    var x1 = x0 + dirX * dist;
    var y1 = y0 + dirY * dist;
    var spin = (820 + Math.random() * 400) * (dirX >= 0 ? 1 : -1);
    var started = performance.now();
    var flyDur = 1000;

    function flyTick(now) {
      var t = Math.min(1, (now - started) / flyDur);
      var e = t * t * (1.12 - 0.12 * t);
      x = x0 + (x1 - x0) * e;
      y = y0 + (y1 - y0) * e;
      r = r0 + spin * e;
      var squash = Math.sin(t * Math.PI);
      applyTransform(1 + squash * 0.18, 1 - squash * 0.14);
      if (t < 1) requestAnimationFrame(flyTick);
      else {
        wrap.style.visibility = "hidden";
        setTimeout(slideInNewHand, 1000);
      }
    }
    requestAnimationFrame(flyTick);
  }

  function slideInNewHand() {
    if (wave) wave.textContent = WAVE;
    pointing = false;
    x = -Math.max(window.innerWidth * 0.98, 480);
    y = 18;
    r = -22;
    wrap.style.visibility = "";
    applyTransform();
    var xFrom = x;
    var yFrom = y;
    var rFrom = r;
    var started = performance.now();
    var dur = 1229;

    function slide(now) {
      var t = Math.min(1, (now - started) / dur);
      var e = easeOutBack(t);
      x = xFrom * (1 - e);
      y = yFrom * (1 - Math.min(1, t * 1.15));
      r = rFrom * (1 - e);
      applyTransform();
      if (t < 1) requestAnimationFrame(slide);
      else {
        x = 0;
        y = 0;
        r = 0;
        tx = 0;
        ty = 0;
        tr = 0;
        t0 = performance.now();
        knocked = false;
        applyTransform();
      }
    }
    requestAnimationFrame(slide);
  }

  function spawnBoom(px, py, punch) {
    var el = document.createElement("div");
    el.className = "rocket boom";
    el.setAttribute("aria-hidden", "true");
    el.textContent = BOOM;
    document.body.appendChild(el);
    blastStars(px, py);
    if (punch && !reduced.matches) yeetHand(px, py);
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

  function launchRocket(x0, y0, x1, y1, punch) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    var len = Math.hypot(dx, dy);
    if (len < 8) {
      spawnBoom(x1, y1, punch);
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

    var dur = (460 + Math.min(len, 980) * 0.38) * 10 / 7;
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
        spawnBoom(x1, y1, punch);
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
    if (knocked) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var node = e.target;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (node && node.closest && node.closest(".chip")) return;

    var cx = e.clientX;
    var cy = e.clientY;
    var punch = inPalm(cx, cy);

    if (reduced.matches) {
      if (wave) wave.textContent = POINT;
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = setTimeout(function () {
        if (wave) wave.textContent = WAVE;
        restoreTimer = null;
      }, 180);
      spawnBoom(cx, cy, false);
      return;
    }

    var from = pointAt(cx, cy);
    launchRocket(from.tipX, from.tipY, cx, cy, punch);
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
