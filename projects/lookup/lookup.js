(function () {
  var KEY = "projects.ok";
  try {
    if (!sessionStorage.getItem(KEY)) {
      try { sessionStorage.setItem("projects.next", location.pathname); } catch (e) {}
      location.replace("../?next=" + encodeURIComponent(location.pathname));
      return;
    }
  } catch (err) {
    location.replace("../");
    return;
  }
  document.documentElement.classList.add("is-open");

  var FALLBACK = { lat: 47.3644, lon: 9.6916, altKm: 0.408, name: "Hohenems" };
  var DEG = Math.PI / 180;

  var canvas = document.querySelector(".stars");
  var ctx = canvas && canvas.getContext("2d");
  var field = [];
  function seedStars() {
    var s = 0xE11A5C;
    function rnd() {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    }
    field = [];
    var i, roll, col;
    for (i = 0; i < 360; i++) {
      roll = rnd();
      col = roll < 0.08 ? [170, 205, 255] : roll < 0.2 ? [255, 228, 190] : [255, 255, 255];
      field.push({
        nx: rnd(),
        ny: rnd(),
        r: 0.4 + rnd() * 1.15,
        a: 0.32 + rnd() * 0.55,
        col: col
      });
    }
  }
  function paintStars() {
    if (!ctx) return;
    var w = window.innerWidth;
    var h = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var i, p, col;
    for (i = 0; i < field.length; i++) {
      p = field[i];
      col = p.col || [255, 255, 255];
      ctx.beginPath();
      ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + p.a + ")";
      ctx.arc(p.nx * w, p.ny * h, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  seedStars();
  paintStars();
  window.addEventListener("resize", paintStars);

  var nav = document.querySelector("[data-nav]");
  var btn = document.querySelector("[data-nav-btn]");
  var list = document.getElementById("nav-list");
  function setNav(open) {
    nav.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    list.hidden = !open;
  }
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    setNav(!nav.classList.contains("is-open"));
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setNav(false);
  });
  document.addEventListener("click", function (e) {
    if (nav.classList.contains("is-open") && !nav.contains(e.target)) setNav(false);
  });

  var sky = document.querySelector("[data-sky]");
  var sctx = sky && sky.getContext("2d");
  var satsEl = document.querySelector("[data-sats]");
  var issEl = document.querySelector("[data-iss]");
  var placeEl = document.querySelector("[data-place]");
  var headEl = document.querySelector("[data-heading]");
  var locBtn = document.querySelector("[data-loc]");
  var compassBtn = document.querySelector("[data-compass]");

  var observer = {
    lat: FALLBACK.lat,
    lon: FALLBACK.lon,
    altKm: FALLBACK.altKm,
    fallback: true,
    asked: false
  };
  var view = { az: 180, el: 90, roll: 0 };
  var gyroOn = false;
  var hasCompass = false;
  var skySats = [];
  var skyIss = null;
  var nInSky = 0;
  var catalogN = 0;
  var catalogSource = "";
  var needsDraw = true;
  var drag = null;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function wrap360(v) {
    v = v % 360;
    if (v < 0) v += 360;
    return v;
  }
  function vec(x, y, z) { return { x: x, y: y, z: z }; }
  function vlen(a) { return Math.hypot(a.x, a.y, a.z); }
  function vnorm(a) {
    var l = vlen(a) || 1;
    return vec(a.x / l, a.y / l, a.z / l);
  }
  function vdot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function vcross(a, b) {
    return vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  function azElToVec(azDeg, elDeg) {
    var az = azDeg * DEG;
    var el = elDeg * DEG;
    var ce = Math.cos(el);
    return vec(ce * Math.sin(az), ce * Math.cos(az), Math.sin(el));
  }

  function viewBasis(az, el, roll) {
    var f = azElToVec(az, el);
    var worldUp = vec(0, 0, 1);
    var right, up;
    if (Math.abs(el) > 82) {
      var head = azElToVec(az, 0);
      up = vnorm(vec(head.x - f.x * vdot(head, f), head.y - f.y * vdot(head, f), head.z - f.z * vdot(head, f)));
      right = vnorm(vcross(f, up));
      up = vnorm(vcross(right, f));
    } else {
      right = vnorm(vcross(f, worldUp));
      up = vnorm(vcross(right, f));
    }
    if (roll) {
      var c = Math.cos(roll);
      var s = Math.sin(roll);
      var ru = vec(right.x * c + up.x * s, right.y * c + up.y * s, right.z * c + up.z * s);
      var uu = vec(up.x * c - right.x * s, up.y * c - right.y * s, up.z * c - right.z * s);
      right = ru;
      up = uu;
    }
    return { f: f, right: right, up: up };
  }

  function project(az, el, basis, cx, cy, half) {
    var s = azElToVec(az, el);
    var z = vdot(s, basis.f);
    var ang = Math.acos(clamp(z, -1, 1));
    if (ang > 1.85) return null;
    var x = vdot(s, basis.right);
    var y = vdot(s, basis.up);
    var len = Math.hypot(x, y);
    var r = (ang / (Math.PI / 2)) * half;
    if (len < 1e-9) return { x: cx, y: cy, z: z };
    return { x: cx + (x / len) * r, y: cy - (y / len) * r, z: z };
  }

  function cardinal(az) {
    var dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(az / 45) % 8];
  }

  function fmtCoord(lat, lon) {
    var ns = lat >= 0 ? "N" : "S";
    var ew = lon >= 0 ? "E" : "W";
    return Math.abs(lat).toFixed(2) + "°" + ns + " " + Math.abs(lon).toFixed(2) + "°" + ew;
  }

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
    if (typeof window.orientation === "number") return window.orientation;
    return 0;
  }

  function deviceMatrix(alpha, beta, gamma) {
    var a = alpha * DEG;
    var b = beta * DEG;
    var g = gamma * DEG;
    var ca = Math.cos(a), sa = Math.sin(a);
    var cb = Math.cos(b), sb = Math.sin(b);
    var cg = Math.cos(g), sg = Math.sin(g);
    return [
      ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg,
      sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg,
      -cb * sg, sb, cb * cg
    ];
  }

  function lookFromDevice(alpha, beta, gamma) {
    if (beta == null || gamma == null || !isFinite(beta) || !isFinite(gamma)) return null;
    if (alpha == null || !isFinite(alpha)) alpha = 180;
    var R = deviceMatrix(alpha, beta, gamma);
    var e = -R[2], n = -R[5], u = -R[8];
    var az = Math.atan2(e, n) / DEG;
    if (az < 0) az += 360;
    var el = Math.atan2(u, Math.hypot(e, n)) / DEG;
    var te = R[1], tn = R[4], tu = R[7];
    var f = vnorm(vec(e, n, u));
    var top = vec(te, tn, tu);
    var camUp = vec(top.x - f.x * vdot(top, f), top.y - f.y * vdot(top, f), top.z - f.z * vdot(top, f));
    var worldUp = vec(-f.x * f.z, -f.y * f.z, 1 - f.z * f.z);
    var roll = 0;
    if (vlen(camUp) > 1e-6 && vlen(worldUp) > 1e-6) {
      camUp = vnorm(camUp);
      worldUp = vnorm(worldUp);
      var cr = vcross(worldUp, camUp);
      var sign = vdot(cr, f) < 0 ? -1 : 1;
      roll = sign * Math.acos(clamp(vdot(worldUp, camUp), -1, 1));
    }
    return { az: az, el: el, roll: roll };
  }

  function shortestDelta(from, to) {
    var d = (to - from) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  var yawBias = 0;
  var smoothLook = { az: null, el: null, roll: null };
  var wantAbsolute = false;

  function onOrient(ev) {
    if (!gyroOn) return;
    if (wantAbsolute && ev.type === "deviceorientation") return;
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    if (!isFinite(ev.alpha) || !isFinite(ev.beta) || !isFinite(ev.gamma)) return;
    var look = lookFromDevice(ev.alpha, ev.beta, ev.gamma);
    if (!look) return;
    look.az = wrap360(look.az - screenAngle());
    var heading = ev.webkitCompassHeading;
    if (heading != null && isFinite(heading)) {
      hasCompass = true;
      if (look.el < 48) {
        yawBias += shortestDelta(wrap360(look.az + yawBias), heading) * 0.18;
      }
    } else if (ev.absolute) {
      hasCompass = true;
    }
    look.az = wrap360(look.az + yawBias);
    var k = 0.12 + 0.28 * Math.max(0, Math.cos(look.el * DEG));
    if (smoothLook.az == null) {
      smoothLook.az = look.az;
      smoothLook.el = look.el;
      smoothLook.roll = look.roll;
    } else {
      smoothLook.az = wrap360(smoothLook.az + shortestDelta(smoothLook.az, look.az) * k);
      smoothLook.el = smoothLook.el + (look.el - smoothLook.el) * Math.min(0.4, k + 0.08);
      smoothLook.roll = smoothLook.roll + (look.roll - smoothLook.roll) * k;
    }
    view.az = smoothLook.az;
    view.el = smoothLook.el;
    view.roll = smoothLook.roll;
    needsDraw = true;
  }

  function canOrient() {
    return typeof window.DeviceOrientationEvent !== "undefined";
  }

  function startGyro() {
    function arm() {
      gyroOn = true;
      hasCompass = false;
      yawBias = 0;
      smoothLook.az = null;
      window.removeEventListener("deviceorientation", onOrient, true);
      window.removeEventListener("deviceorientationabsolute", onOrient, true);
      wantAbsolute = "ondeviceorientationabsolute" in window;
      if (wantAbsolute) {
        window.addEventListener("deviceorientationabsolute", onOrient, true);
      } else {
        window.addEventListener("deviceorientation", onOrient, true);
      }
      if (compassBtn) compassBtn.hidden = true;
    }
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then(function (state) {
        if (state === "granted") arm();
        else if (compassBtn) compassBtn.hidden = false;
      }).catch(function () {
        if (compassBtn) compassBtn.hidden = false;
      });
      return;
    }
    if (canOrient()) arm();
  }

  function stopGyro() {
    gyroOn = false;
    window.removeEventListener("deviceorientation", onOrient, true);
    window.removeEventListener("deviceorientationabsolute", onOrient, true);
    if (canOrient() && compassBtn) compassBtn.hidden = false;
  }

  function applyGeo(pos) {
    if (!pos || !pos.coords) return;
    observer.lat = pos.coords.latitude;
    observer.lon = pos.coords.longitude;
    observer.altKm = (pos.coords.altitude || 0) / 1000;
    observer.fallback = false;
    observer.asked = true;
    if (locBtn) locBtn.hidden = true;
    updateHud();
    requestTick();
  }

  function useFallback(reason) {
    observer.lat = FALLBACK.lat;
    observer.lon = FALLBACK.lon;
    observer.altKm = FALLBACK.altKm;
    observer.fallback = true;
    observer.asked = true;
    if (locBtn) locBtn.hidden = false;
    updateHud();
    requestTick();
  }

  function askLocation() {
    if (!navigator.geolocation) {
      useFallback("unavailable");
      return;
    }
    navigator.geolocation.getCurrentPosition(applyGeo, function () {
      useFallback("denied");
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
  }

  function sizeSky() {
    if (!sctx) return;
    var w = window.innerWidth;
    var h = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    sky.width = Math.round(w * dpr);
    sky.height = Math.round(h * dpr);
    sky.style.width = w + "px";
    sky.style.height = h + "px";
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    if (!sctx) return;
    var w = window.innerWidth;
    var h = window.innerHeight;
    sctx.clearRect(0, 0, w, h);
    var cx = w * 0.5;
    var cy = h * 0.5;
    var half = Math.min(w, h) * 0.46;
    var basis = viewBasis(view.az, view.el, view.roll);
    var i, p, sat, r, a;

    sctx.strokeStyle = "rgba(255,255,255,0.16)";
    sctx.lineWidth = 1;
    sctx.setLineDash([4, 8]);
    sctx.beginPath();
    var first = true;
    for (i = 0; i <= 72; i++) {
      p = project(i * 5, 0, basis, cx, cy, half);
      if (!p) {
        first = true;
        continue;
      }
      if (first) {
        sctx.moveTo(p.x, p.y);
        first = false;
      } else sctx.lineTo(p.x, p.y);
    }
    sctx.stroke();
    sctx.setLineDash([]);

    sctx.font = "600 11px SF Pro Text, system-ui, sans-serif";
    sctx.textAlign = "center";
    sctx.textBaseline = "middle";
    var labels = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
    for (i = 0; i < labels.length; i++) {
      p = project(labels[i][1], 1.2, basis, cx, cy, half);
      if (!p) continue;
      sctx.fillStyle = "rgba(255,255,255,0.28)";
      sctx.fillText(labels[i][0], p.x, p.y);
    }

    for (i = 0; i < skySats.length; i++) {
      sat = skySats[i];
      if (sat.kind === "iss") continue;
      p = project(sat.az, sat.el, basis, cx, cy, half);
      if (!p) continue;
      r = clamp(1800 / Math.max(sat.range, 280), 1.15, 2.7);
      a = clamp(0.42 + (sat.el / 90) * 0.45, 0.38, 0.92);
      sctx.beginPath();
      sctx.fillStyle = "rgba(168, 214, 255," + a.toFixed(3) + ")";
      sctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      sctx.fill();
    }

    if (skyIss && skyIss.el >= -2.5) {
      p = project(skyIss.az, skyIss.el, basis, cx, cy, half);
      if (p) {
        sctx.beginPath();
        sctx.fillStyle = "rgba(255, 186, 110, 0.22)";
        sctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
        sctx.fill();
        sctx.beginPath();
        sctx.fillStyle = "rgba(255, 204, 140, 0.95)";
        sctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
        sctx.fill();
      }
    }
    needsDraw = false;
  }

  function updateHud() {
    var n = nInSky;
    if (!catalogN) satsEl.textContent = "Loading orbits…";
    else if (!n && skySats) satsEl.textContent = "0 Starlink above the horizon";
    else satsEl.textContent = n + " Starlink in the sky";

    if (skyIss && skyIss.el >= -2.5) {
      issEl.hidden = false;
      issEl.textContent = "ISS · " + Math.round(skyIss.el) + "° " + cardinal(skyIss.az);
    } else {
      issEl.hidden = true;
      issEl.textContent = "";
    }

    if (observer.fallback) {
      placeEl.textContent = "Hohenems fallback · " + fmtCoord(observer.lat, observer.lon);
    } else {
      placeEl.textContent = fmtCoord(observer.lat, observer.lon);
    }

    var lookWord = view.el > 75 ? "looking up" : view.el < 8 ? "horizon" : Math.round(view.el) + "° elev";
    var compassBit = gyroOn
      ? (hasCompass ? cardinal(view.az) + " " + Math.round(view.az) + "°" : "no compass · " + cardinal(view.az) + " " + Math.round(view.az) + "°")
      : cardinal(view.az) + " " + Math.round(view.az) + "°";
    headEl.textContent = compassBit + " · " + lookWord;
  }

  function onDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (nav.contains(e.target)) return;
    if (e.target.closest && e.target.closest("a, button")) return;
    var pt = e.touches ? e.touches[0] : e;
    drag = { x: pt.clientX, y: pt.clientY, az: view.az, el: view.el, id: e.pointerId };
    if (gyroOn) stopGyro();
    document.body.classList.add("is-drag");
    if (sky.setPointerCapture && e.pointerId != null) {
      try { sky.setPointerCapture(e.pointerId); } catch (err) {}
    }
    e.preventDefault();
  }

  function onMove(e) {
    if (!drag) return;
    var pt = e.touches ? e.touches[0] : e;
    var dx = pt.clientX - drag.x;
    var dy = pt.clientY - drag.y;
    view.az = wrap360(drag.az - dx * 0.18);
    view.el = clamp(drag.el + dy * 0.14, -8, 90);
    view.roll = 0;
    needsDraw = true;
    updateHud();
    e.preventDefault();
  }

  function onUp() {
    if (!drag) return;
    if (sky.releasePointerCapture && drag.id != null) {
      try { sky.releasePointerCapture(drag.id); } catch (err) {}
    }
    drag = null;
    document.body.classList.remove("is-drag");
  }

  sky.addEventListener("pointerdown", onDown);
  sky.addEventListener("pointermove", onMove);
  sky.addEventListener("pointerup", onUp);
  sky.addEventListener("pointercancel", onUp);

  if (locBtn) {
    locBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      askLocation();
    });
  }
  if (compassBtn) {
    compassBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      startGyro();
    });
    if (canOrient()) compassBtn.hidden = false;
  }

  var worker = null;
  var tickTimer = 0;

  function requestTick() {
    if (!worker) return;
    worker.postMessage({
      type: "tick",
      t: Date.now(),
      lat: observer.lat,
      lon: observer.lon,
      altKm: observer.altKm
    });
  }

  function armWorker() {
    try {
      worker = new Worker("./sky-worker.js?v=lookup1");
    } catch (err) {
      satsEl.textContent = "Sky worker failed to start.";
      return;
    }
    worker.onmessage = function (ev) {
      var msg = ev.data || {};
      if (msg.type === "ready") {
        catalogN = msg.n || 0;
        catalogSource = msg.source || "";
        updateHud();
        requestTick();
      } else if (msg.type === "sky") {
        skySats = msg.sats || [];
        skyIss = msg.iss || null;
        nInSky = msg.nInSky || skySats.length;
        catalogN = msg.n || catalogN;
        catalogSource = msg.source || catalogSource;
        needsDraw = true;
        updateHud();
      } else if (msg.type === "error") {
        if (!catalogN) satsEl.textContent = "No orbital data.";
      }
    };
    worker.onerror = function () {
      if (!catalogN) satsEl.textContent = "No orbital data.";
    };
    worker.postMessage({
      type: "boot",
      dumpUrl: "/starlink/gp.json?v=lookup1"
    });
  }

  function loop() {
    if (needsDraw || gyroOn) draw();
    requestAnimationFrame(loop);
  }

  sizeSky();
  window.addEventListener("resize", function () {
    sizeSky();
    paintStars();
    needsDraw = true;
  });

  askLocation();
  armWorker();
  updateHud();
  tickTimer = setInterval(requestTick, 1000);
  requestAnimationFrame(loop);
})();
