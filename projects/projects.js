(function () {
  var VAULT = {"v":1,"iters":210000,"salt":"KTO4IQeL8nDExMoPWHbMBQ==","iv":"nm2XQd5M0JbwpnXL","ct":"QxhC6o3UUohQz7IPZnOtMLqYCDvN3KLi77Jjt+idwp4oOYBw8O/Tu18r+fxtpd1BJ34/aRWIn+HyFYJHF4kYKLUnAwFL0CX8pku97rTMyFR5Qv485tuwIKbn7WN/Gsi318fES4xxvvW/GjKApphER3PTWcxhyoeaiGS6bTZ7GjPA87ADqrUxAQSrFBApD0tnHUdKhJcxhdBWhyvrdnDdzYu6wup8fs82klER+qNyNU7Yt7Jg55HsvvLV9zezVO5bhluzXA/AqqIqsIAFpfg/5AgJRecDy8iGFm8FdZVH2kx5hGeFzP534q4gtlbW1bm03yp7vGIoC0Fy3RNqmDzxi8XM7L2OUBEAbleXNZwTBymZ/yTlt8h47ehI4SBWJmjqtz7la+m5ArdscZbhc5/81+5TM6deKfehPYAeXCHWB4SqFxrZoIWMpgtR7+TzHkDFv3gKDh8KJboVykj+0YF7Jh+0WuPXYKWGQ77N0EjQKowHbfFdHeOZ8I2OgNCqqoyR+ecstIEKkfIfZISQlO6GUoIPUg9cgNosSa5s8Ahz+ZOoXM+B/ksiT4xt0Q1H69wul2pVAl4bdVw0PvGVtqrEq9IjPJ3bRdCv85igdJX5CDTYk5GuAXnZbzCb2JS+NQxgBjyzK5EHOT6YuXQYOj3qNcc9Gkv63f1cS+CAyocEhOYGbuElX92UotYasRSsR3Xx7JgIl3VYDVJCQUMpGfWmzev6yhskpRIQQln+3jfaApnpSlycWA=="};
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
    if (!ctx || locked) return;
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

  function paintLensedStars(hx, hy, hr) {
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
    ctx.lineCap = "round";

    var rs = hr;
    var outer = rs * 4.8;
    var i, p, sx, sy, d, gap, ang, u, edge, arc, warm, alpha, lw, col, cr, cg, cb, span;
    for (i = 0; i < field.length; i++) {
      p = field[i];
      sx = p.nx * w;
      sy = p.ny * h;
      d = Math.hypot(sx - hx, sy - hy);
      if (d < rs * 1.03) continue;
      ang = Math.atan2(sy - hy, sx - hx);
      gap = d - rs;
      u = 1 / (1 + gap / (rs * 0.252));
      u = Math.pow(u, 1.55);
      edge = (outer - d) / (outer - rs);
      if (edge < 0) edge = 0;
      if (edge > 1) edge = 1;
      edge = edge * edge * (3 - 2 * edge);
      u *= edge;
      arc = u * Math.PI * 1.85;
      if (gap < rs * 0.22) arc += Math.pow(1 - gap / (rs * 0.22), 1.2) * Math.PI * 0.9 * edge;
      warm = Math.min(1, u * 0.75 + Math.pow(rs / d, 2.1) * 1.6 * edge);
      col = p.col || [255, 255, 255];
      cr = Math.round(col[0] + (255 - col[0]) * warm * 0.55);
      cg = Math.round(col[1] + (168 - col[1]) * warm);
      cb = Math.round(col[2] + (72 - col[2]) * warm);
      alpha = Math.min(1, p.a * (1 + u * 1.1 + warm * 0.5));
      lw = Math.max(p.r, p.r * (1 + u * 0.55));
      span = arc * d;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = "rgb(" + cr + "," + cg + "," + cb + ")";
      ctx.fillStyle = ctx.strokeStyle;
      if (span < lw * 1.2) {
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(p.r, lw * 0.5), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(hx, hy, d, ang - arc / 2, ang + arc / 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawHole(hctx, x, y, r) {
    var i, rr, fall, a;
    for (i = 22; i >= 1; i--) {
      rr = r * (1 + i * 0.05);
      fall = Math.pow(1 - i / 22, 1.55);
      a = i <= 5 ? 0.22 * fall : 0.14 * fall;
      hctx.beginPath();
      hctx.arc(x, y, rr, 0, Math.PI * 2);
      hctx.strokeStyle = i <= 5
        ? "rgba(255, 214, 155, " + a.toFixed(3) + ")"
        : "rgba(168, 78, 38, " + a.toFixed(3) + ")";
      hctx.lineWidth = 4;
      hctx.stroke();
    }
    hctx.beginPath();
    hctx.arc(x, y, r, 0, Math.PI * 2);
    hctx.strokeStyle = "rgba(255, 186, 110, 0.88)";
    hctx.lineWidth = Math.max(2.4, r * 0.045);
    hctx.stroke();
    hctx.beginPath();
    hctx.arc(x, y, r, 0, Math.PI * 2);
    hctx.strokeStyle = "rgba(255, 252, 246, 1)";
    hctx.lineWidth = Math.max(1.1, r * 0.02);
    hctx.stroke();
    hctx.fillStyle = "#000";
    hctx.beginPath();
    hctx.arc(x, y, r * 0.99, 0, Math.PI * 2);
    hctx.fill();
  }

  function startBlackHole() {
    if (locked) return;
    locked = true;
    markAte();

    var gate = document.querySelector("[data-gate]");
    var input = document.querySelector("[data-pass]");
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
    var w = window.innerWidth;
    var h = window.innerHeight;
    var rect = (input || gate).getBoundingClientRect();
    var inW = input ? input.offsetWidth : rect.width;
    var inH = input ? input.offsetHeight : rect.height;
    var roundX = inW > 0 ? Math.min(1, inH / inW) : 1;
    var tx = rect.left + rect.width / 2;
    var ty = rect.top + rect.height / 2;
    var corner = Math.floor(Math.random() * 4);
    var dur = 6222;
    var growFor = 0.18;
    var shrinkFor = 0.18;
    var started = performance.now();
    var lastW = 0;
    var lastH = 0;

    function corners() {
      var R = 28 + Math.min(w, h) * 0.078;
      var m = R + 18;
      if (m > w * 0.28) m = w * 0.28;
      if (m > h * 0.28) m = h * 0.28;
      var pairs = [
        [m, m, w - m, h - m],
        [w - m, m, m, h - m],
        [m, h - m, w - m, m],
        [w - m, h - m, m, m]
      ];
      return pairs[corner];
    }

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
      var pair = corners();
      var x0 = pair[0], y0 = pair[1], x1 = pair[2], y1 = pair[3];
      var elapsed = now - started;
      var t = Math.min(1, elapsed / dur);
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var hx = x0 + (x1 - x0) * e;
      var hy = y0 + (y1 - y0) * e;
      var R = 28 + Math.min(w, h) * 0.078;
      var rScale;
      if (e < growFor) {
        var u = e / growFor;
        rScale = 1 - Math.pow(1 - u, 3);
      } else if (e > 1 - shrinkFor) {
        var u = (e - (1 - shrinkFor)) / shrinkFor;
        rScale = 1 - u * u * u;
      } else {
        rScale = 1;
      }
      var r = Math.max(0.4, R * rScale);
      var travelT = e;

      paintLensedStars(hx, hy, r);
      hctx.clearRect(0, 0, w, h);
      if (rScale > 0.02) drawHole(hctx, hx, hy, r);

      var dx = hx - tx;
      var dy = hy - ty;
      var dist = Math.hypot(dx, dy) || 1;
      var pull = Math.max(0, 1 - dist / (r * 2.8));
      var eaten = dist < r * 0.82 || travelT > 0.58;
      var suck = eaten ? 1 : pull;
      var ox = (dx / dist) * suck * Math.min(140, r * 1.1);
      var oy = (dy / dist) * suck * Math.min(140, r * 1.1);
      var sc = eaten ? Math.max(0, 1 - (travelT - 0.42) * 3.4) : 1 - pull * 0.35;
      var rot = (eaten ? (travelT - 0.4) * 420 : pull * 18) * (dx >= 0 ? 1 : -1);
      var skew = pull * 12 * (dy >= 0 ? 1 : -1);
      var pinchFar = Math.hypot(w, h) * 0.42;
      var pinchNear = r * 3.4;
      var pinchU = (pinchFar - dist) / Math.max(8, pinchFar - pinchNear);
      if (pinchU < 0) pinchU = 0;
      if (pinchU > 1) pinchU = 1;
      pinchU = pinchU * pinchU * (3 - 2 * pinchU);
      var sx = 1 + (roundX - 1) * pinchU;

      if (input) {
        input.style.animation = "none";
        input.style.transformOrigin = "50% 50%";
        input.style.transform = "scaleX(" + sx.toFixed(3) + ")";
      }
      if (gate) {
        gate.style.transformOrigin = "50% 50%";
        gate.style.transform =
          "translate(" + ox.toFixed(1) + "px," + oy.toFixed(1) + "px) rotate(" +
          rot.toFixed(1) + "deg) skewX(" + skew.toFixed(1) + "deg) scale(" +
          Math.max(0, sc).toFixed(3) + ")";
        gate.style.filter =
          "contrast(" + (1 + pull * 0.8).toFixed(2) + ") brightness(" +
          (1 - suck * 0.55).toFixed(2) + ") blur(" + (suck * 2.4).toFixed(2) + "px)";
        gate.style.opacity = eaten && travelT > 0.62 ? "0" : String(1 - suck * 0.25);
      }

      if (elapsed < dur) requestAnimationFrame(tick);
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
