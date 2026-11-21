/* Secret hall of fame. Loaded in <head>: bounces visitors who didn't find the homepage secret before first paint. */
(function () {
  var ok = false;
  try { ok = sessionStorage.getItem("homeSecret") === "1"; } catch (e) {}
  if (!ok) location.replace("../");
})();
document.addEventListener("DOMContentLoaded", function () {
  var API = "https://hof.eliaseccli.workers.dev";
  var KEY = "secretHof.signed";
  var listEl = document.querySelector("[data-list]");
  var emptyEl = document.querySelector("[data-empty]");
  var form = document.querySelector("[data-form]");
  var input = document.querySelector("[data-name]");
  var hint = document.querySelector("[data-hint]");
  var btn = form.querySelector("button");

  function paint(names, signed) {
    listEl.innerHTML = "";
    names.forEach(function (row) {
      var li = document.createElement("li");
      li.textContent = row.name;
      listEl.appendChild(li);
    });
    emptyEl.hidden = names.length > 0;
    var local = false;
    try { local = sessionStorage.getItem(KEY) === "1" || localStorage.getItem(KEY) === "1"; } catch (e) {}
    form.hidden = Boolean(signed || local);
  }

  function load() {
    return fetch(API, { method: "GET" }).then(function (r) { return r.json(); }).then(function (data) {
      paint(data.names || [], data.signed);
    }).catch(function () {
      hint.textContent = "Hall is sleeping. Try again in a bit.";
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    hint.textContent = "";
    btn.disabled = true;
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.value })
    }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
    .then(function (res) {
      if (res.ok) {
        try { localStorage.setItem(KEY, "1"); } catch (err) {}
        paint(res.data.names || [], true);
        hint.textContent = "";
        return;
      }
      if (res.status === 409) {
        try { localStorage.setItem(KEY, "1"); } catch (err) {}
        form.hidden = true;
        hint.textContent = "This connection already signed.";
        return load();
      }
      if (res.data && res.data.error === "name") hint.textContent = "2–24 letters, numbers, spaces.";
      else hint.textContent = "Couldn’t add that.";
    }).catch(function () {
      hint.textContent = "Couldn’t add that.";
    }).then(function () { btn.disabled = false; });
  });

  load();
});
