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
  var nightOf = Object.create(null);
  var width = 0;
  var drag = null;
  var mvLoaded = false;

  function fileName(slug, when) {
    return "stills/diorama-" + slug + "-" + when + ".png";
  }

  function asList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.places)) return raw.places;
    return [];
  }

  function normalize(raw) {
    var slug = String(raw.slug || raw.id || "").trim();
    if (!slug && raw.day) {
      var m = String(raw.day).match(/diorama-([a-z0-9-]+)-day\.png/i);
      if (m) slug = m[1];
    }
    if (!slug) return null;
    var day = raw.day || raw.dayPng || fileName(slug, "day");
    var night = raw.night || raw.nightPng || fileName(slug, "night");
    if (raw.day === false) day = "";
    if (raw.night === false) night = "";
    return {
      slug: slug,
      title: String(raw.title || slug),
      day: day,
      night: night,
      glb: raw.glb || ""
    };
  }

  function loadModelViewer() {
    if (mvLoaded) return;
    mvLoaded = true;
    var s = document.createElement("script");
    s.type = "module";
    s.src = "https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js";
    document.head.appendChild(s);
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
      if (place.glb) {
        loadModelViewer();
        var mv = document.createElement("model-viewer");
        mv.setAttribute("src", place.glb);
        mv.setAttribute("camera-controls", "");
        mv.setAttribute("touch-action", "none");
        mv.setAttribute("interaction-prompt", "none");
        mv.className = "is-on";
        hold.appendChild(mv);
      } else {
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
      }
      slot.appendChild(hold);
      track.appendChild(slot);
      paintSlot(i);
    });
    layout(false);
    syncMeta();
  }

  function paintSlot(i) {
    var place = places[i];
    if (!place || place.glb) return;
    var slot = track.children[i];
    if (!slot) return;
    var showNight = !!nightOf[place.slug] && !!place.night;
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
    return !!(place && place.day && place.night && !place.glb);
  }

  function syncMeta() {
    var place = current();
    if (!place) {
      caption.hidden = true;
      phaseEl.hidden = true;
      return;
    }
    caption.hidden = false;
    caption.textContent = place.title;
    if (hasPair(place)) {
      phaseEl.hidden = false;
      phaseEl.textContent = nightOf[place.slug] ? "night" : "day";
    } else {
      phaseEl.hidden = true;
      phaseEl.textContent = "";
    }
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

  function flip() {
    var place = current();
    if (!hasPair(place)) return;
    nightOf[place.slug] = !nightOf[place.slug];
    paintSlot(index);
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
    else if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === " " || e.key === "Enter") {
      if (e.key === " ") e.preventDefault();
      flip();
    }
  });

  window.addEventListener("resize", function () { layout(false); });

  fetch("./stills.json", { cache: "no-store" }).then(function (res) {
    return res.ok ? res.json() : [];
  }).then(function (raw) {
    places = asList(raw).map(normalize).filter(Boolean);
    render();
  }).catch(function () {
    places = [];
    render();
  });
})();
