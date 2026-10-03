/* Private waitlist page. Checks the invite link, then sends the form to /api/waitlist. */
(function () {
  "use strict";
  var form = document.getElementById("waitlist-form");
  if (!form) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var states = {};
  $$("[data-state]").forEach(function (el) { states[el.getAttribute("data-state")] = el; });
  function show(name) {
    Object.keys(states).forEach(function (k) { states[k].hidden = k !== name; });
    if (name !== "form" && states[name]) { states[name].setAttribute("tabindex", "-1"); states[name].focus({ preventScroll: false }); }
  }

  var params = new URLSearchParams(location.search);
  var t = params.get("t") || "", k = params.get("k") || "";
  var submit = $("button[type=submit]", form);
  var status = $(".form-status", form);

  function setErr(input, msg) {
    var box = input.closest(".field");
    var err = box && $(".err", box);
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    if (err) err.textContent = msg || "";
  }
  function validate() {
    var ok = true, first = null;
    $$("[required]", form).forEach(function (input) {
      var v = (input.value || "").trim(), msg = "";
      if (!v) msg = "Please fill this in.";
      else if (input.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) msg = "That email address doesn't look right.";
      else if (input.name === "whatsapp" && !/^[+()\d\s-]{7,24}$/.test(v)) msg = "Please check the number.";
      setErr(input, msg);
      if (msg) { ok = false; if (!first) first = input; }
    });
    if (first) first.focus();
    return ok;
  }
  $$("input, select, textarea", form).forEach(function (el) {
    el.addEventListener("input", function () { if (el.getAttribute("aria-invalid") === "true") setErr(el, ""); });
  });

  function say(msg, isError) {
    status.textContent = msg;
    status.classList.add("is-shown");
    status.classList.toggle("is-error", !!isError);
  }

  if (!t || !k || location.protocol === "file:") { show("invalid"); return; }

  // Check the link. The venue name comes back so the form can start filled in.
  fetch("/api/waitlist?t=" + encodeURIComponent(t) + "&k=" + encodeURIComponent(k), { headers: { Accept: "application/json" }, cache: "no-store" })
    .then(function (r) {
      if (r.status === 404) { show("invalid"); return null; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (j) {
      if (!j) return;
      if (j.venue) $("#business_name", form).value = j.venue;
      show("form");
    })
    .catch(function () { show("error"); });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!validate()) return;
    var data = { t: t, k: k };
    new FormData(form).forEach(function (v, key) { data[key] = String(v).trim(); });
    if (data.website) return; // honeypot
    status.classList.remove("is-shown", "is-error");
    submit.disabled = true;
    $(".btn-text", submit).textContent = "Sending...";
    fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.json.ok) {
          $("[data-first-name]").textContent = data.contact_name.split(" ")[0];
          show("done");
        } else if (res.status === 400 && res.json.field) {
          var input = form.elements[res.json.field];
          if (input) { setErr(input, res.json.error); input.focus(); }
          else say(res.json.error, true);
        } else if (res.status === 404) {
          show("invalid");
        } else if (res.status === 429) {
          say("Too many attempts. Please wait a few minutes and try again.", true);
        } else {
          say("We couldn't save your details just now. Please try again in a few minutes, or email peter@procuracharge.com.", true);
        }
      })
      .catch(function () { say("We couldn't reach our server. Please check your connection and try again.", true); })
      .then(function () { submit.disabled = false; $(".btn-text", submit).textContent = "Join the waitlist"; });
  });
})();
