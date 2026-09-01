(function () {
  var KEY = "projects.ok";
  try {
    if (!sessionStorage.getItem(KEY)) {
      location.replace("../");
      return;
    }
  } catch (err) {
    location.replace("../");
    return;
  }
  document.documentElement.classList.add("is-open");


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

  var stage = document.querySelector("[data-stage]");
  var track = document.querySelector("[data-track]");
  var emptyEl = document.querySelector("[data-empty]");
  var caption = document.querySelector("[data-caption]");
  var phaseEl = document.querySelector("[data-phase]");
  var places = [];
  var nightOf = Object.create(null);
  var leaveTimer = Object.create(null);
  var index = 0;
  var width = 0;
  var drag = null;


  function captureDate(raw) {
    var v = raw && (raw.date || raw.taken || raw.captured || raw.datetimeOriginal || raw.DateTimeOriginal);
    if (v == null) return { raw: "", label: "" };
    v = String(v).trim();
    if (!v) return { raw: "", label: "" };
    var m = v.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
    if (!m) return { raw: v, label: "" };
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var month = +m[2];
    var day = +m[3];
    if (month < 1 || month > 12 || day < 1 || day > 31) return { raw: v, label: "" };
    return { raw: v, label: day + " " + months[month - 1] + " " + m[1] };
  }

  function dateKey(place) {
    var m = String(place && place.date || "").match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
    if (!m) return 0;
    return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
  }

  function newestFirst(a, b) {
    return dateKey(b) - dateKey(a);
  }

  function fileName(slug, when) {
    return "stills/diorama-" + slug + "-" + when + ".png";
  }

  function asList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.places)) return raw.places;
    return [];
  }

  function slugFromStill(path) {
    var m = String(path || "").match(/diorama-([a-z0-9-]+)-(?:day|night)\.(?:png|webp|jpe?g)/i);
    return m ? m[1] : "";
  }

  function normalize(raw) {
    var slug = String(raw.slug || raw.id || "").trim();
    if (!slug) slug = slugFromStill(raw.day) || slugFromStill(raw.night);
    if (!slug) return null;
    var day = raw.day || raw.dayPng || fileName(slug, "day");
    var night = raw.night || raw.nightPng || fileName(slug, "night");
    if (raw.day === false) day = "";
    if (raw.night === false) night = "";
    var when = captureDate(raw);
    return {
      slug: slug,
      title: String(raw.title || slug),
      date: when.raw,
      dateLabel: when.label,
      day: day,
      night: night
    };
  }

  function render() {
    track.innerHTML = "";
    if (!places.length) {
      emptyEl.hidden = false;
      caption.hidden = true;
      phaseEl.hidden = true;
      caption.textContent = "";
      phaseEl.textContent = "";
      layout(false);
      return;
    }
    emptyEl.hidden = true;
    index = places.length - 1;
    places.forEach(function (place, i) {
      var slot = document.createElement("div");
      slot.className = "slot";
      slot.setAttribute("data-slot", String(i));
      var hold = document.createElement("div");
      hold.className = "float";
      var halo = document.createElement("div");
      halo.className = "halo";
      var photos = document.createElement("div");
      photos.className = "photos";
      if (place.day) {
        halo.appendChild(makeHalo(place.day, "day"));
        photos.appendChild(makeStill(place.day, "day"));
      }
      if (place.night) {
        halo.appendChild(makeHalo(place.night, "night"));
        photos.appendChild(makeStill(place.night, "night"));
      }
      hold.appendChild(halo);
      hold.appendChild(photos);
      warmSlot(hold);
      slot.appendChild(hold);
      track.appendChild(slot);
      paintSlot(i);
    });
    layout(false);
    syncMeta();
  }


  var FALLBACK_LAT = 47.3644;
  var FALLBACK_LON = 9.6916;
  var PHASE_LAG_MS = 30 * 60 * 1000;
  var geo = { lat: FALLBACK_LAT, lon: FALLBACK_LON };
  try {
    var savedGeo = JSON.parse(localStorage.getItem("diorama.geo") || "null");
    if (savedGeo && typeof savedGeo.lat === "number" && typeof savedGeo.lon === "number") {
      geo.lat = savedGeo.lat;
      geo.lon = savedGeo.lon;
    }
  } catch (err) {}

  function sunEvent(date, lat, lon, rising) {
    var rad = Math.PI / 180;
    var start = new Date(date.getFullYear(), 0, 0);
    var n = Math.floor((date - start) / 86400000);
    var lngHour = lon / 15;
    var t = n + ((rising ? 6 : 18) - lngHour) / 24;
    var M = (0.9856 * t - 3.289) % 360;
    var L = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634) % 360;
    if (L < 0) L += 360;
    var RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
    RA = (RA + 360) % 360;
    RA = RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90);
    RA = RA / 15;
    var sinDec = 0.39782 * Math.sin(L * rad);
    var cosDec = Math.cos(Math.asin(sinDec));
    var cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null;
    var H = Math.acos(cosH) / rad;
    if (rising) H = 360 - H;
    H = H / 15;
    var T = H + RA - 0.06571 * t - 6.622;
    var UT = T - lngHour;
    UT = ((UT % 24) + 24) % 24;
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + UT * 3600000);
  }

  function isNightNow() {
    var now = new Date();
    var rise = sunEvent(now, geo.lat, geo.lon, true);
    var set = sunEvent(now, geo.lat, geo.lon, false);
    if (!rise || !set) {
      var h = now.getHours();
      return h >= 19 || h < 7;
    }
    var t = now.getTime();
    var dayStart = rise.getTime() + PHASE_LAG_MS;
    var nightStart = set.getTime() + PHASE_LAG_MS;
    return t < dayStart || t >= nightStart;
  }

  function watchGeo() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      geo.lat = pos.coords.latitude;
      geo.lon = pos.coords.longitude;
      try {
        localStorage.setItem("diorama.geo", JSON.stringify({ lat: geo.lat, lon: geo.lon }));
      } catch (err) {}
      if (places.length) paintSlot(index);
    }, function () {}, { maximumAge: 24 * 3600 * 1000, timeout: 4000 });
  }

  function showNightFor(place) {
    if (!place) return false;
    var forced = nightOf[place.slug];
    var night = (forced === true || forced === false) ? forced : isNightNow();
    if (night && place.night) return true;
    if (!night && place.day) return false;
    return !!place.night;
  }

  function stillImg(src) {
    var img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    img.loading = "eager";
    return img;
  }

  function makeHalo(src, when) {
    var img = stillImg(src);
    img.setAttribute("data-when", when);
    return img;
  }

  function makeStill(src, when) {
    var wrap = document.createElement("div");
    wrap.className = "still";
    wrap.setAttribute("data-when", when);
    wrap.appendChild(stillImg(src));
    return wrap;
  }

  function warmImg(img) {
    if (!img) return;
    if (typeof img.decode === "function") img.decode().catch(function () {});
  }

  function warmSlot(root) {
    if (!root) return;
    var imgs = root.querySelectorAll ? root.querySelectorAll("img") : [];
    var n;
    for (n = 0; n < imgs.length; n++) warmImg(imgs[n]);
  }


  function armHalo(img, on, haloBox) {
    if (!on) {
      img.classList.remove("is-on");
      return;
    }
    function show() {
      img.classList.add("is-on");
      if (haloBox) haloBox.classList.add("is-ready");
    }
    if (img.complete && img.naturalWidth) {
      show();
      return;
    }
    if (typeof img.decode === "function") {
      img.decode().then(show).catch(show);
      return;
    }
    img.addEventListener("load", show, { once: true });
  }

  function incomingStill(slot, showNight) {
    if (!slot) return null;
    var wrap = slot.querySelector(showNight ? '.still[data-when="night"]' : '.still[data-when="day"]');
    return wrap ? wrap.querySelector("img") : null;
  }

  function flip() {
    var place = current();
    if (!place || !place.day || !place.night) return;
    var i = index;
    var leavingWhen = showNightFor(place) ? "night" : "day";
    nightOf[place.slug] = !showNightFor(place);
    var showNight = showNightFor(place);
    var slot = track.children[i];
    var incoming = incomingStill(slot, showNight);
    function paint() {
      if (index !== i) return;
      paintSlot(i, leavingWhen);
    }
    if (incoming && typeof incoming.decode === "function") {
      incoming.decode().then(paint).catch(paint);
    } else {
      paint();
    }
  }

  function paintSlot(i, leavingWhen) {
    var place = places[i];
    if (!place) return;
    var slot = track.children[i];
    if (!slot) return;
    var showNight = showNightFor(place);
    var haloBox = slot.querySelector(".halo");
    var halos = slot.querySelectorAll(".halo img");
    var h;
    for (h = 0; h < halos.length; h++) {
      var hw = halos[h].getAttribute("data-when");
      var hon = showNight ? hw === "night" : hw === "day";
      if (!place.day && place.night && hw === "night") hon = true;
      armHalo(halos[h], hon, haloBox);
    }
    var stills = slot.querySelectorAll(".photos .still");
    var n, wrap, when, on;
    for (n = 0; n < stills.length; n++) {
      wrap = stills[n];
      when = wrap.getAttribute("data-when");
      on = showNight ? when === "night" : when === "day";
      if (!place.day && place.night && when === "night") on = true;
      if (on) {
        wrap.classList.add("is-on");
        wrap.classList.remove("is-leaving");
      } else if (leavingWhen && when === leavingWhen) {
        wrap.classList.add("is-leaving");
        wrap.classList.add("is-on");
      } else {
        wrap.classList.remove("is-on");
        wrap.classList.remove("is-leaving");
      }
    }
    if (leaveTimer[i]) clearTimeout(leaveTimer[i]);
    if (leavingWhen) {
      leaveTimer[i] = setTimeout(function () {
        var s = track.children[i];
        if (!s) return;
        var gone = s.querySelectorAll(".still.is-leaving");
        var k;
        for (k = 0; k < gone.length; k++) {
          gone[k].classList.remove("is-on");
          gone[k].classList.remove("is-leaving");
        }
      }, 480);
    }
  }

  function current() {
    return places[index] || null;
  }

  function hasPair(place) {
    return !!(place && place.day && place.night);
  }

  function syncMeta() {
    var place = current();
    if (!place) {
      caption.hidden = true;
      phaseEl.hidden = true;
      return;
    }
    caption.hidden = false;
    caption.textContent = "";
    var name = document.createElement("span");
    name.textContent = place.title;
    caption.appendChild(name);
    if (place.dateLabel) {
      var whenEl = document.createElement("span");
      whenEl.className = "when";
      whenEl.textContent = " · " + place.dateLabel;
      caption.appendChild(whenEl);
    }
    phaseEl.hidden = true;
    phaseEl.textContent = "";
  }

  function clampIndex(i) {
    if (!places.length) return 0;
    if (i < 0) return 0;
    if (i > places.length - 1) return places.length - 1;
    return i;
  }

  function layout(animate) {
    width = stage.clientWidth || window.innerWidth;
    apply(animate);
  }

  function apply(animate) {
    var dx = drag ? drag.dx : 0;
    if (!places.length) {
      var rubber = dx;
      if (Math.abs(rubber) > 72) rubber = (rubber < 0 ? -1 : 1) * (72 + (Math.abs(rubber) - 72) * 0.12);
      track.style.transition = animate ? "transform 0.38s cubic-bezier(.22,.8,.3,1)" : "none";
      if (emptyEl) {
        emptyEl.style.transition = animate ? "transform 0.38s cubic-bezier(.22,.8,.3,1)" : "none";
        emptyEl.style.transform = "translate(calc(-50% + " + rubber.toFixed(1) + "px), -50%)";
      }
      track.style.transform = "translate3d(0,0,0)";
      return;
    }
    if (emptyEl) emptyEl.style.transform = "";
    var max = (places.length - 1) * width;
    var tx = -index * width + dx;
    if (tx > 0) tx *= 0.28;
    else if (tx < -max) tx = -max + (tx + max) * 0.28;
    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.style.transition = animate && !reduced ? "transform 0.38s cubic-bezier(.22,.8,.3,1)" : "none";
    track.style.transform = "translate3d(" + tx.toFixed(1) + "px,0,0)";
  }

  function go(next, animate) {
    index = clampIndex(next);
    drag = null;
    stage.classList.remove("is-drag");
    apply(animate !== false);
    syncMeta();
  }


  function onDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (nav.contains(e.target)) return;
    if (e.target.closest && e.target.closest("a, button.nav-btn")) return;
    var pt = e.touches ? e.touches[0] : e;
    drag = {
      x: pt.clientX,
      y: pt.clientY,
      dx: 0,
      t: performance.now(),
      moved: false,
      id: e.pointerId
    };
    stage.classList.add("is-drag");
    if (stage.setPointerCapture && e.pointerId != null) {
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    }
    apply(false);
    e.preventDefault();
  }

  function onMove(e) {
    if (!drag) return;
    var pt = e.touches ? e.touches[0] : e;
    var dx = pt.clientX - drag.x;
    var dy = pt.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    drag.dx = dx;
    apply(false);
    e.preventDefault();
  }

  function onUp(e) {
    if (!drag) return;
    var dt = Math.max(16, performance.now() - drag.t);
    var dx = drag.dx;
    var vx = dx / dt;
    var moved = drag.moved;
    stage.classList.remove("is-drag");
    if (stage.releasePointerCapture && drag.id != null) {
      try { stage.releasePointerCapture(drag.id); } catch (err) {}
    }
    if (!moved) {
      drag = null;
      apply(true);
      flip();
      return;
    }
    var next = index;
    if (places.length) {
      if (dx < -Math.max(56, width * 0.16) || vx < -0.45) next += 1;
      else if (dx > Math.max(56, width * 0.16) || vx > 0.45) next -= 1;
    }
    go(next, true);
    e.preventDefault();
  }

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);

  window.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") go(index + 1, true);
    else if (e.key === "ArrowLeft") go(index - 1, true);
  });

  window.addEventListener("resize", function () { paintStars(); layout(false); });

  fetch("./stills.json", { cache: "no-store" }).then(function (res) {
    return res.ok ? res.json() : [];
  }).then(function (raw) {
    places = asList(raw).map(normalize).filter(Boolean).sort(newestFirst);
    places.reverse();
    places.forEach(function (place) {
      if (place.day) { var d = new Image(); d.src = place.day; }
      if (place.night) { var n = new Image(); n.src = place.night; }
    });
    render();
    watchGeo();
  }).catch(function () {
    places = [];
    render();
  });
})();
