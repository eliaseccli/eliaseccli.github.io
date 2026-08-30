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
    places.forEach(function (place, i) {
      var slot = document.createElement("div");
      slot.className = "slot";
      slot.setAttribute("data-slot", String(i));
      var hold = document.createElement("div");
      hold.className = "float";
      if (place.day) {
        var day = document.createElement("img");
        day.src = place.day;
        day.alt = "";
        day.draggable = false;
        day.setAttribute("data-when", "day");
        hold.appendChild(day);
      }
      if (place.night) {
        var night = document.createElement("img");
        night.src = place.night;
        night.alt = "";
        night.draggable = false;
        night.setAttribute("data-when", "night");
        hold.appendChild(night);
      }
      slot.appendChild(hold);
      track.appendChild(slot);
      paintSlot(i);
    });
    layout(false);
    syncMeta();
  }


  function isNightNow() {
    var h = new Date().getHours();
    return h >= 19 || h < 7;
  }

  function showNightFor(place) {
    if (!place) return false;
    var night = isNightNow();
    if (night && place.night) return true;
    if (!night && place.day) return false;
    return !!place.night;
  }

  function paintSlot(i) {
    var place = places[i];
    if (!place) return;
    var slot = track.children[i];
    if (!slot) return;
    var showNight = showNightFor(place);
    var imgs = slot.querySelectorAll("img");
    var n, img, when;
    for (n = 0; n < imgs.length; n++) {
      img = imgs[n];
      when = img.getAttribute("data-when");
      img.classList.toggle("is-on", showNight ? when === "night" : when === "day");
    }
    if (!place.day && place.night) {
      var only = slot.querySelector('img[data-when="night"]');
      if (only) only.classList.add("is-on");
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

  setInterval(function () {
    var i;
    for (i = 0; i < places.length; i++) paintSlot(i);
  }, 60000);

  window.addEventListener("resize", function () { layout(false); });

  fetch("./stills.json", { cache: "no-store" }).then(function (res) {
    return res.ok ? res.json() : [];
  }).then(function (raw) {
    places = asList(raw).map(normalize).filter(Boolean).sort(newestFirst);
    render();
  }).catch(function () {
    places = [];
    render();
  });
})();
