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

  var off = document.createElement("canvas");
  var offCtx = off.getContext("2d", { willReadFrequently: true });
  var srcSnap = null;
  var snapW = 0;
  var snapH = 0;

  function ensureStarSnap() {
    paintStars();
    var dw = canvas.width;
    var dh = canvas.height;
    if (srcSnap && snapW === dw && snapH === dh) return;
    off.width = dw;
    off.height = dh;
    offCtx.setTransform(1, 0, 0, 1, 0, 0);
    offCtx.drawImage(canvas, 0, 0);
    srcSnap = offCtx.getImageData(0, 0, dw, dh);
    snapW = dw;
    snapH = dh;
  }

  function sampleSnap(data, dw, dh, x, y) {
    if (x < 0 || y < 0 || x >= dw - 1 || y >= dh - 1) {
      return [5, 5, 8, 255];
    }
    var x0 = Math.floor(x);
    var y0 = Math.floor(y);
    var fx = x - x0;
    var fy = y - y0;
    function pix(ix, iy) {
      var i = (iy * dw + ix) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    }
    var p00 = pix(x0, y0);
    var p10 = pix(x0 + 1, y0);
    var p01 = pix(x0, y0 + 1);
    var p11 = pix(x0 + 1, y0 + 1);
    var out = [0, 0, 0, 0];
    var i, a, b;
    for (i = 0; i < 4; i++) {
      a = p00[i] * (1 - fx) + p10[i] * fx;
      b = p01[i] * (1 - fx) + p11[i] * fx;
      out[i] = a * (1 - fy) + b * fy;
    }
    return out;
  }

  function paintLensedStars(hx, hy, hr) {
    if (!ctx) return;
    ensureStarSnap();
    var dw = canvas.width;
    var dh = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(off, 0, 0);

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rIn = hr * dpr;
    var rOut = rIn * 1.1;
    var cx = hx * dpr;
    var cy = hy * dpr;
    var pad = 3;
    var x0 = Math.max(0, Math.floor(cx - rOut - pad));
    var y0 = Math.max(0, Math.floor(cy - rOut - pad));
    var x1 = Math.min(dw, Math.ceil(cx + rOut + pad));
    var y1 = Math.min(dh, Math.ceil(cy + rOut + pad));
    var bw = x1 - x0;
    var bh = y1 - y0;
    if (bw < 2 || bh < 2) return;

    var dest = ctx.getImageData(x0, y0, bw, bh);
    var ddata = dest.data;
    var sdata = srcSnap.data;
    var reach = Math.hypot(dw, dh) * 0.5;
    var xi, yi, px, py, dx, dy, d, frac, srcR, srcAng, col, idx;

    for (yi = 0; yi < bh; yi++) {
      py = y0 + yi + 0.5;
      for (xi = 0; xi < bw; xi++) {
        px = x0 + xi + 0.5;
        dx = px - cx;
        dy = py - cy;
        d = Math.hypot(dx, dy);
        if (d <= rIn || d >= rOut) continue;
        frac = (d - rIn) / (rOut - rIn);
        srcR = Math.tan((1 - frac) * 1.34) * reach;
        srcAng = Math.atan2(dy, dx) + (1 - frac) * 2.5;
        col = sampleSnap(sdata, dw, dh, cx + Math.cos(srcAng) * srcR, cy + Math.sin(srcAng) * srcR);
        idx = (yi * bw + xi) * 4;
        ddata[idx] = col[0];
        ddata[idx + 1] = col[1];
        ddata[idx + 2] = col[2];
        ddata[idx + 3] = 255;
      }
    }
    ctx.putImageData(dest, x0, y0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawHole(hctx, x, y, r) {
    var rOut = r * 1.1;
    hctx.save();
    hctx.beginPath();
    hctx.arc(x, y, rOut, 0, Math.PI * 2);
    hctx.arc(x, y, r, 0, Math.PI * 2, true);
    hctx.clip();
    var glow = hctx.createRadialGradient(x, y, r, x, y, rOut);
    glow.addColorStop(0, "rgba(255, 220, 175, 0.2)");
    glow.addColorStop(0.55, "rgba(210, 118, 62, 0.08)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    hctx.fillStyle = glow;
    hctx.fillRect(x - rOut, y - rOut, rOut * 2, rOut * 2);
    hctx.restore();

    hctx.save();
    hctx.shadowColor = "rgba(255, 220, 170, 0.85)";
    hctx.shadowBlur = r * 0.045;
    hctx.beginPath();
    hctx.arc(x, y, r, 0, Math.PI * 2);
    hctx.strokeStyle = "rgba(255, 196, 130, 0.95)";
    hctx.lineWidth = Math.max(1, r * 0.016);
    hctx.stroke();
    hctx.shadowBlur = r * 0.02;
    hctx.beginPath();
    hctx.arc(x, y, r, 0, Math.PI * 2);
    hctx.strokeStyle = "rgba(255, 252, 246, 1)";
    hctx.lineWidth = Math.max(0.7, r * 0.009);
    hctx.stroke();
    hctx.restore();

    hctx.fillStyle = "#000";
    hctx.beginPath();
    hctx.arc(x, y, r * 0.997, 0, Math.PI * 2);
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

      paintLensedStars(hx, hy, r);
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
