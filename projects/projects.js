(function () {
  var VAULT = {"v":1,"iters":210000,"salt":"NB73aylcuKc3pGNlfbcjFQ==","iv":"/ZcCtOdyZQfpuDJC","ct":"WpbZYhYT+zj9PgUlKeJY1UHqC+5JE36y2SFzukAw/Ga/nmwakreHjWRiDrfojQl8xBMf9EgQDQ6wTEaHUDt5l2zmvsLZpE5867cSSj0HE7X/NF3q2Az7IC+tElYszBjJvqabIh+pvfK3fTtrI0IwaMjbPvueG6SxHopdv887TEW5g5XxaiEZHLW72+Lbo0wiQifbSRFqm6fDPETWo7NMa+pi8SXshpfHNLSmJLzCc2yVvUCYwYrBh1hcVsLpKWI+h2B71QdD50TEiar5G/H4bL529m1xLhwGVJ+TkBIfubYNXeKFwd8sodWVCRoomuHsEAIwYRYqGPRZtX/y+xWHX2WsZ8QdAKXvy9RcbFIf6UIERvQr3r18kqwmGGnh7FJ1hF7XYBDaKOhnygg="};
  var KEY = "projects.ok";
  var ATE = "projectsAte";
  var strikes = 0;
  var locked = false;
  var pending = false;

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
    var i;
    for (i = 0; i < 96; i++) {
      field.push({
        nx: rnd(),
        ny: rnd(),
        r: 0.45 + rnd() * 1.15,
        a: 0.28 + rnd() * 0.55
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
    var i, p;
    for (i = 0; i < field.length; i++) {
      p = field[i];
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,255,255," + p.a + ")";
      ctx.arc(p.nx * w, p.ny * h, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  seedStars();
  paintStars();
  window.addEventListener("resize", paintStars);

  function b64(s) {
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    var i;
    for (i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function deriveKey(password, salt) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: VAULT.iters, hash: "SHA-256" },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
      );
    });
  }

  function unlock(html) {
    var gate = document.querySelector("[data-gate]");
    var panel = document.querySelector("[data-panel]");
    panel.innerHTML = html;
    gate.hidden = true;
    panel.hidden = false;
    document.body.classList.add("is-open");
  }

  function fail() {
    if (locked) return;
    strikes += 1;
    if (strikes >= 3) {
      startBlackHole();
      return;
    }
    var gate = document.querySelector("[data-gate]");
    var hint = document.querySelector("[data-hint]");
    var input = document.querySelector("[data-pass]");
    gate.classList.remove("bad");
    void gate.offsetWidth;
    gate.classList.add("bad");
    hint.textContent = "Nope.";
    input.select();
  }

  function tryPass(password) {
    if (locked || pending) return;
    pending = true;
    var salt = b64(VAULT.salt);
    var iv = b64(VAULT.iv);
    var ct = b64(VAULT.ct);
    return deriveKey(password, salt).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
    }).then(function (buf) {
      var html = new TextDecoder().decode(buf);
      try { sessionStorage.setItem(KEY, html); } catch (err) {}
      unlock(html);
    }).catch(fail).then(function () {
      pending = false;
    });
  }

  function markAte() {
    try { sessionStorage.setItem(ATE, "1"); } catch (err) {}
  }

  function goHome() {
    markAte();
    window.location.href = "../";
  }

  function makeLensField() {
    var s = 0xE11A5C ^ 0x51A4;
    function rnd() {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    }
    var out = [];
    var i, roll, col;
    for (i = 0; i < 260; i++) {
      roll = rnd();
      col = roll < 0.12
        ? "rgb(170, 205, 255)"
        : roll < 0.28
          ? "rgb(255, 228, 190)"
          : "rgb(255, 255, 255)";
      out.push({
        nx: rnd(),
        ny: rnd(),
        r: 0.4 + rnd() * 1.25,
        a: 0.32 + rnd() * 0.6,
        col: col
      });
    }
    return out;
  }

  function paintLensedStars(hx, hy, hr, lensField) {
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
    var rs = hr * 0.97;
    var ein = hr * 1.42;
    var inf = hr * 8.2;
    var i, p, sx, sy, dx, dy, d, ang, defl, d2, px, py, stretch, tx, ty;
    for (i = 0; i < lensField.length; i++) {
      p = lensField[i];
      sx = p.nx * w;
      sy = p.ny * h;
      dx = sx - hx;
      dy = sy - hy;
      d = Math.hypot(dx, dy);
      if (d < rs * 1.04) continue;
      ang = Math.atan2(dy, dx);
      if (d < inf) {
        defl = (ein * ein) / Math.max(d, 1);
        d2 = d - defl * 1.45;
        if (d2 < rs * 1.06) d2 = rs * 1.06;
        ang += (ein / d) * 1.15;
        stretch = Math.pow(Math.min(2.8, ein / d), 1.55) * hr * 0.92;
      } else {
        d2 = d;
        stretch = 0;
      }
      px = hx + Math.cos(ang) * d2;
      py = hy + Math.sin(ang) * d2;
      if (stretch > 1.15) {
        tx = -Math.sin(ang);
        ty = Math.cos(ang);
        ctx.strokeStyle = p.col;
        ctx.globalAlpha = p.a;
        ctx.lineWidth = Math.max(0.55, p.r);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(px - tx * stretch, py - ty * stretch);
        ctx.lineTo(px + tx * stretch, py + ty * stretch);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.col;
        ctx.globalAlpha = p.a;
        ctx.beginPath();
        ctx.arc(px, py, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawHole(hctx, x, y, r) {
    var halo = hctx.createRadialGradient(x, y, r * 0.99, x, y, r * 2.45);
    halo.addColorStop(0, "rgba(255, 214, 160, 0.3)");
    halo.addColorStop(0.14, "rgba(210, 118, 62, 0.18)");
    halo.addColorStop(0.4, "rgba(120, 52, 28, 0.07)");
    halo.addColorStop(1, "rgba(0,0,0,0)");
    hctx.fillStyle = halo;
    hctx.beginPath();
    hctx.arc(x, y, r * 2.45, 0, Math.PI * 2);
    hctx.fill();

    hctx.save();
    hctx.shadowColor = "rgba(255, 220, 170, 0.95)";
    hctx.shadowBlur = r * 0.22;
    hctx.beginPath();
    hctx.arc(x, y, r, 0, Math.PI * 2);
    hctx.strokeStyle = "rgba(255, 196, 130, 0.95)";
    hctx.lineWidth = Math.max(2.4, r * 0.075);
    hctx.stroke();
    hctx.shadowBlur = r * 0.08;
    hctx.beginPath();
    hctx.arc(x, y, r, 0, Math.PI * 2);
    hctx.strokeStyle = "rgba(255, 252, 246, 1)";
    hctx.lineWidth = Math.max(1.2, r * 0.038);
    hctx.stroke();
    hctx.restore();

    hctx.fillStyle = "#000";
    hctx.beginPath();
    hctx.arc(x, y, r * 0.968, 0, Math.PI * 2);
    hctx.fill();
  }

  function startBlackHole() {
    if (locked) return;
    locked = true;
    markAte();

    var gate = document.querySelector("[data-gate]");
    var input = document.querySelector("[data-pass]");
    var bloom = document.querySelector(".bloom");
    var hint = document.querySelector("[data-hint]");
    if (input) {
      input.blur();
      input.disabled = true;
      input.setAttribute("readonly", "readonly");
    }
    if (hint) hint.textContent = "";
    document.body.classList.add("is-eating");

    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) {
      goHome();
      return;
    }

    var hole = document.querySelector("[data-hole]");
    if (!hole) {
      hole = document.createElement("canvas");
      hole.className = "hole";
      hole.setAttribute("data-hole", "");
      hole.setAttribute("aria-hidden", "true");
      document.body.appendChild(hole);
    }
    var hctx = hole.getContext("2d");
    var lensField = makeLensField();
    var w = window.innerWidth;
    var h = window.innerHeight;
    var rect = (input || gate).getBoundingClientRect();
    var tx = rect.left + rect.width / 2;
    var ty = rect.top + rect.height / 2;
    var ang = Math.random() * Math.PI * 2;
    var reach = Math.hypot(w, h) * 0.72 + 120;
    var x0 = tx - Math.cos(ang) * reach;
    var y0 = ty - Math.sin(ang) * reach;
    var x1 = tx + Math.cos(ang) * reach;
    var y1 = ty + Math.sin(ang) * reach;
    var maxR = Math.min(w, h) * 0.24 + 64;
    var started = performance.now();
    var dur = 9333;
    var lastW = 0;
    var lastH = 0;

    function sizeHole() {
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      hole.width = Math.round(w * dpr);
      hole.height = Math.round(h * dpr);
      hole.style.width = w + "px";
      hole.style.height = h + "px";
      hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    sizeHole();

    function tick(now) {
      w = window.innerWidth;
      h = window.innerHeight;
      sizeHole();
      var t = Math.min(1, (now - started) / dur);
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var hx = x0 + (x1 - x0) * e;
      var hy = y0 + (y1 - y0) * e;
      var swell = Math.sin(Math.min(1, t / 0.92) * Math.PI);
      var r = 40 + maxR * (0.38 + 0.62 * swell);

      paintLensedStars(hx, hy, r, lensField);
      hctx.clearRect(0, 0, w, h);
      drawHole(hctx, hx, hy, r);

      var dx = hx - tx;
      var dy = hy - ty;
      var dist = Math.hypot(dx, dy) || 1;
      var pull = Math.max(0, 1 - dist / (r * 2.8));
      var eaten = dist < r * 0.82 || t > 0.58;
      var suck = eaten ? 1 : pull;
      var ox = (dx / dist) * suck * Math.min(140, r * 1.1);
      var oy = (dy / dist) * suck * Math.min(140, r * 1.1);
      var sc = eaten ? Math.max(0, 1 - (t - 0.42) * 3.4) : 1 - pull * 0.35;
      var rot = (eaten ? (t - 0.4) * 420 : pull * 18) * (dx >= 0 ? 1 : -1);
      var skew = pull * 12 * (dy >= 0 ? 1 : -1);

      if (gate) {
        gate.style.transformOrigin = "50% 50%";
        gate.style.transform =
          "translate(" + ox.toFixed(1) + "px," + oy.toFixed(1) + "px) rotate(" +
          rot.toFixed(1) + "deg) skewX(" + skew.toFixed(1) + "deg) scale(" +
          Math.max(0, sc).toFixed(3) + ")";
        gate.style.filter =
          "contrast(" + (1 + pull * 0.8).toFixed(2) + ") brightness(" +
          (1 - suck * 0.55).toFixed(2) + ") blur(" + (suck * 2.4).toFixed(2) + "px)";
        gate.style.opacity = eaten && t > 0.62 ? "0" : String(1 - suck * 0.25);
      }
      if (bloom) {
        var bPull = Math.max(0, 1 - dist / (Math.hypot(w, h) * 0.55));
        bloom.style.transformOrigin = hx + "px " + hy + "px";
        bloom.style.transform =
          "translate(" + (dx * bPull * 0.08).toFixed(1) + "px," +
          (dy * bPull * 0.08).toFixed(1) + "px) scale(" +
          (1 + bPull * 0.22).toFixed(3) + ")";
        bloom.style.filter =
          "blur(" + (40 + bPull * 18).toFixed(1) + "px) contrast(" +
          (1 + bPull * 0.7).toFixed(2) + ") saturate(" +
          (1 + bPull * 0.4).toFixed(2) + ")";
        bloom.style.opacity = String(Math.max(0, 1 - Math.max(0, t - 0.55) / 0.35));
      }

      if (t < 1) requestAnimationFrame(tick);
      else goHome();
    }
    requestAnimationFrame(tick);
  }

  window.addEventListener("pageshow", function (e) {
    var ate = false;
    try { ate = sessionStorage.getItem(ATE) === "1"; } catch (err) {}
    if (ate) {
      try { sessionStorage.removeItem(ATE); } catch (err) {}
    }
    if (e.persisted || ate) {
      strikes = 0;
      locked = false;
      location.reload();
    }
  });

  try {
    var cached = sessionStorage.getItem(KEY);
    if (cached) {
      unlock(cached);
      return;
    }
  } catch (err) {}

  var form = document.querySelector("[data-gate]");
  var input = document.querySelector("[data-pass]");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (locked || pending) return;
    var hint = document.querySelector("[data-hint]");
    hint.textContent = "";
    tryPass(input.value);
  });
  if (input) input.focus();
})();
