/* Site menu: the one list every page's hamburger shows. Edit items here only.
   Each page keeps <nav class="nav" data-nav> with its button and an empty
   <ul class="nav-list" id="nav-list" hidden>; this file fills the list and
   runs open/close (button, Escape, tap outside). Load with defer. */
(function () {
  var ITEMS = [
    ["/", "HOME"],
    ["/teslastores/", "Tesla-Stores"],
    ["/starlink/", "Starlink"],
    ["/spacex/", "SpaceX Launches"],
    ["/projects/", "Projects"],
    ["/about/", "About"]
  ];
  var nav = document.querySelector("[data-nav]");
  if (!nav) return;
  var btn = nav.querySelector("[data-nav-btn]");
  var list = document.getElementById("nav-list");
  if (!list) {
    list = document.createElement("ul");
    list.className = "nav-list"; list.id = "nav-list"; list.hidden = true;
    nav.appendChild(list);
  }

  var path = location.pathname.replace(/index\.html$/, "");
  if (path.charAt(path.length - 1) !== "/") path += "/";
  list.textContent = "";
  ITEMS.forEach(function (it) {
    var li = document.createElement("li"), a = document.createElement("a");
    a.href = it[0];
    a.textContent = it[1];
    if (path === it[0]) a.setAttribute("aria-current", "page");
    else if (it[0] !== "/" && path.indexOf(it[0]) === 0) a.setAttribute("aria-current", "true"); // e.g. /projects/lookup/
    li.appendChild(a);
    list.appendChild(li);
  });

  function setNav(open) {
    nav.classList.toggle("is-open", open);
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    list.hidden = !open;
  }
  if (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      setNav(!nav.classList.contains("is-open"));
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setNav(false);
  });
  // capture phase, so a page handler that stops propagation can't keep the menu open
  document.addEventListener("pointerdown", function (e) {
    if (nav.classList.contains("is-open") && !nav.contains(e.target)) setNav(false);
  }, true);
  window.SiteNav = { setOpen: setNav };
})();
