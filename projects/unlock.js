/* Projects unlock: lasts until local midnight on this device (localStorage + expiry).
   Migrates the old per-tab sessionStorage flag. Value = whatever the gate stored (decrypted shelf HTML). */
(function () {
  var K = "projects.ok", E = "projects.ok.exp";
  function midnight() { var d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); }
  function clear() { try { localStorage.removeItem(K); localStorage.removeItem(E); sessionStorage.removeItem(K); } catch (e) {} }
  function set(v, keepExpiry) {
    try {
      var exp = +localStorage.getItem(E) || 0;
      localStorage.setItem(K, v);
      localStorage.setItem(E, String(keepExpiry && exp > Date.now() ? exp : midnight()));
      sessionStorage.removeItem(K);
    } catch (e) {}
  }
  function get() {
    try {
      var v = localStorage.getItem(K), exp = +localStorage.getItem(E) || 0;
      if (v && Date.now() < exp) return v;
      if (v || exp) { localStorage.removeItem(K); localStorage.removeItem(E); }
      var s = sessionStorage.getItem(K);
      if (s) { set(s); return s; }
    } catch (e) {}
    return null;
  }
  window.ProjectsUnlock = { get: get, set: set, clear: clear };
})();

/* <script src="/projects/unlock.js?v=2" data-gate> on a project page: until unlocked, bounce to the
   Projects password page (which returns here afterwards); once unlocked, mark <html class="is-open">. */
(function () {
  var me = document.currentScript;
  if (!me || !me.hasAttribute("data-gate")) return;
  if (window.ProjectsUnlock.get()) { document.documentElement.classList.add("is-open"); return; }
  try { sessionStorage.setItem("projects.next", location.pathname); } catch (e) {}
  location.replace("/projects/?next=" + encodeURIComponent(location.pathname));
})();
