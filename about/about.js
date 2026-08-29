(function () {
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
})();
