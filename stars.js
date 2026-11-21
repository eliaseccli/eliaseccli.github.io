/* Static seeded starfield for <canvas class="stars"> on the inner pages (About, Projects, Diorama).
   The homepage has its own interactive field in home.js. Exposes window.SiteStars. */
(function () {
  var canvas = document.querySelector("canvas.stars");
  var ctx = canvas && canvas.getContext("2d");
  var field = [];
  var paused = false;
  var s = 0xE11A5C;
  function rnd() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  }
  for (var i = 0, roll; i < 360; i++) {
    roll = rnd();
    field.push({
      col: roll < 0.08 ? [170, 205, 255] : roll < 0.2 ? [255, 228, 190] : [255, 255, 255],
      nx: rnd(),
      ny: rnd(),
      r: 0.4 + rnd() * 1.15,
      a: 0.32 + rnd() * 0.55
    });
  }

  function paint() {
    if (!ctx || paused) return;
    var w = window.innerWidth;
    var h = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w * h * dpr * dpr > 8400000) dpr = Math.max(1, Math.sqrt(8400000 / (w * h))); // canvas memory cap
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (var j = 0, p; j < field.length; j++) {
      p = field[j];
      ctx.beginPath();
      ctx.fillStyle = "rgba(" + p.col[0] + "," + p.col[1] + "," + p.col[2] + "," + p.a + ")";
      ctx.arc(p.nx * w, p.ny * h, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  paint();
  window.addEventListener("resize", paint);
  window.SiteStars = { field: field, paint: paint, pause: function () { paused = true; } };
})();
