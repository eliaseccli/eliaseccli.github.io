(function () {
  var VAULT = {"v":1,"iters":210000,"salt":"BNF6B64OZyVQuD7prQ2m7g==","iv":"kCm5sfyX1LILlfvZ","ct":"6jyTK8GzYvECxd/EdIwEIas9+2XwbllSxel5zd6SLaTT1cyitv76VHvStKbzwSnhyHdjPSGSpAc2TwZnrBt5I74hDsTUVgNzHInb2gsAjACnFCcRBD4Ddjrww9EqfHUzO1NYmWfVVMCj09h4I7NcfKv+Qoj2mtU1gUK0sWcYEOLlBE9hsR9YG2+6hEtl4w8Vy/+aRUVaM+HanFUtlAMPYScVFJYi4n7yHF3ZoheR0bfsFsCAP6MGUVS4f3AF/WjA/3GH93Mq/h7S1IDdPtl5uWnFPwdp6Kt4pIW6KbPQtvJt422rnoQ1MCVxyA8Mnk4tCx0NSWmZ1x+99uQfToHG+BupCKVL/f6xWBfUStsKcIf6+oP/Z/a/PlhOvzfL6U1XuSZEeMKzMDqucV5Ca6b0EIfrzX5eC9RdZABii+Kg2nugO8p0Men/ybyaJJCjgS1jwHzBh07N0hzhNjnPAoqyRFj0okL1doaRKdmto5/cpZfH+Ahw/Z8vFarHfexSRF5ykEeaHK6FaIJHUfZ0AVPlWsG3mKmqKNzl94U77A16Ixs7MIophlXeHQ=="};
  var KEY = "projects.ok";

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
    var salt = b64(VAULT.salt);
    var iv = b64(VAULT.iv);
    var ct = b64(VAULT.ct);
    return deriveKey(password, salt).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
    }).then(function (buf) {
      var html = new TextDecoder().decode(buf);
      try { sessionStorage.setItem(KEY, html); } catch (err) {}
      unlock(html);
    }).catch(fail);
  }

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
    var hint = document.querySelector("[data-hint]");
    hint.textContent = "";
    tryPass(input.value);
  });
  if (input) input.focus();
})();
