(function () {
  var wrap = document.querySelector("[data-wave]");
  var root = document.documentElement;
  if (!wrap) return;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  var fine = window.matchMedia("(pointer: fine)");

  var tx = 0, ty = 0, tr = 0;
  var x = 0, y = 0, r = 0;
  var lx = 52, ly = 34, tlx = 52, tly = 34;
  var t0 = performance.now();
  var running = false;

  function follow(e) {
    if (!fine.matches || reduced.matches) return;
    var nx = (e.clientX / window.innerWidth) * 2 - 1;
    var ny = (e.clientY / window.innerHeight) * 2 - 1;
    tx = nx * 30;
    ty = ny * 20;
    tr = nx * 9 - ny * 3.5;
    tlx = 50 + nx * 26;
    tly = 32 + ny * 20;
  }

  function tick(now) {
    if (reduced.matches) {
      wrap.style.transform = "none";
      running = false;
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
    lx += (tlx - lx) * 0.08;
    ly += (tly - ly) * 0.08;

    wrap.style.transform =
      "translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0)" +
      " rotateX(" + (-y * 0.22).toFixed(2) + "deg)" +
      " rotateY(" + (x * 0.18).toFixed(2) + "deg)" +
      " rotate(" + r.toFixed(2) + "deg)";

    root.style.setProperty("--lx", lx.toFixed(2) + "%");
    root.style.setProperty("--ly", ly.toFixed(2) + "%");

    requestAnimationFrame(tick);
  }

  function start() {
    if (running || reduced.matches) return;
    running = true;
    t0 = performance.now();
    requestAnimationFrame(tick);
  }

  window.addEventListener("pointermove", follow, { passive: true });
  reduced.addEventListener("change", function () {
    if (reduced.matches) {
      wrap.style.transform = "none";
    } else {
      start();
    }
  });

  start();
})();
