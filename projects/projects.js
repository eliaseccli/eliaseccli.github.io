(function () {
  var VAULT = {"v":1,"iters":210000,"salt":"BNF6B64OZyVQuD7prQ2m7g==","iv":"kCm5sfyX1LILlfvZ","ct":"6jyTK8GzYvECxd/EdIwEIas9+2XwbllSxel5zd6SLaTT1cyitv76VHvStKbzwSnhyHdjPSGSpAc2TwZnrBt5I74hDsTUVgNzHInb2gsAjACnFCcRBD4Ddjrww9EqfHUzO1NYmWfVVMCj09h4I7NcfKv+Qoj2mtU1gUK0sWcYEOLlBE9hsR9YG2+6hEtl4w8Vy/+aRUVaM+HanFUtlAMPYScVFJYi4n7yHF3ZoheR0bfsFsCAP6MGUVS4f3AF/WjA/3GH93Mq/h7S1IDdPtl5uWnFPwdp6Kt4pIW6KbPQtvJt422rnoQ1MCVxyA8Mnk4tCx0NSWmZ1x+99uQfToHG+BupCKVL/f6xWBfUStsKcIf6+oP/Z/a/PlhOvzfL6U1XuSZEeMKzMDqucV5Ca6b0EIfrzX5eC9RdZABii+Kg2nugO8p0Men/ybyaJJCjgS1jwHzBh07N0hzhNjnPAoqyRFj0okL1doaRKdmto5/cpZfH+Ahw/Z8vFarHfexSRF5ykEeaHK6FaIJHUfZ0AVPlWsG3mKmqKNzl94U77A16Ixs7MIophlXeHQ=="};
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
      alpha = Math.min(1, p.a * (0.5 + u * 1.6 + warm * 0.5));
      lw = Math.max(0.65, p.r * (0.7 + u * 0.55));
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
    var inW = input ? input.offsetWidth : rect.width;
    var inH = input ? input.offsetHeight : rect.height;
    var roundX = inW > 0 ? Math.min(1, inH / inW) : 1;
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
      var r = (28 + Math.min(w, h) * 0.078) * (0.84 + 0.16 * swell);

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
