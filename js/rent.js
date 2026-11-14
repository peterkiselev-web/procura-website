/* Rent a power bank. Checks the machine, takes payment with Stripe's Payment Element (Apple Pay, Google Pay, card),
   then follows the rental until the power bank is out, and shows what happens after.
   Nothing secret lives here: prices, wording and the Stripe publishable key all come from /api/rent/station.
   A power bank is only ever released by the server after Stripe confirms payment, never because of anything in this page. */
(function () {
  "use strict";
  var root = document.getElementById("rent");
  if (!root) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var params = new URLSearchParams(location.search);
  var station = (params.get("station") || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 16);
  var STORE_KEY = "procura_rental_v1";
  var panels = {};
  $$("[data-state]", root).forEach(function (el) { panels[el.getAttribute("data-state")] = el; });
  var form = document.getElementById("rent-form");
  var payButton = document.getElementById("pay-button");
  var statusBox = $(".form-status", form);
  var station_ = null, stripe = null, elements = null, current = null, pollTimer = null, lastState = null, waitStarted = 0;

  // ---- small helpers --------------------------------------------------------------------------------------------
  var money = function (pence) { return "£" + (Number(pence || 0) / 100).toFixed(2); };
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { Accept: "application/json" }, cache: "no-store" }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; });
    });
  }
  function show(name) {
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== name; });
    var el = panels[name];
    if (el && name !== "form") { el.setAttribute("tabindex", "-1"); try { el.focus({ preventScroll: false }); } catch (e) { /* older browsers */ } }
  }
  function fill(map) {
    Object.keys(map).forEach(function (k) {
      $$('[data-text="' + k + '"]', root).forEach(function (el) { el.textContent = map[k]; });
    });
  }
  function fillMoney(pricing) {
    $$("[data-money]", root).forEach(function (el) {
      var key = el.getAttribute("data-money");
      if (pricing[key] !== undefined) el.textContent = money(pricing[key]);
    });
  }
  function say(msg, isError) {
    statusBox.textContent = msg;
    statusBox.classList.add("is-shown");
    statusBox.classList.toggle("is-error", !!isError);
  }
  function clearSay() { statusBox.classList.remove("is-shown", "is-error"); statusBox.textContent = ""; }
  function setErr(input, msg) {
    var box = input.closest(".field");
    var err = box && $(".err", box);
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    if (err) err.textContent = msg || "";
  }

  // ---- remembering a rental in progress (this browser only) -----------------------------------------------------
  function save(rec) { try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign({ at: Date.now() }, rec))); } catch (e) { /* private mode */ } }
  function load() {
    try {
      var rec = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (rec && Date.now() - rec.at < 3 * 86400000) return rec;
    } catch (e) { /* ignore */ }
    return null;
  }
  function forget() { try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } }

  // ---- following a rental ---------------------------------------------------------------------------------------
  function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  function follow(rec) {
    current = rec;
    stopPolling();
    waitStarted = waitStarted || Date.now();
    poll();
  }

  function poll() {
    if (!current) return;
    api("/api/rent/status?rental=" + encodeURIComponent(current.rentalId) + "&t=" + encodeURIComponent(current.token)).then(function (res) {
      if (res.status === 404) { forget(); current = null; return loadStation(); }
      if (res.status !== 200 || !res.json.ok) throw new Error("status " + res.status);
      render(res.json);
    }).catch(function () {
      pollTimer = setTimeout(poll, 5000); // keep trying: a dropped connection should not lose the rental
    });
  }

  function render(v) {
    var wait = v.state === "awaiting_payment" || v.state === "releasing";
    fill({
      cutoffLabel: v.cutoffLabel || "", total: money(v.totalPence), due: money(v.duePence), refunded: money(v.refundedPence || v.paidPence),
      deadline: v.cutoffAt ? new Date(v.cutoffAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "",
    });
    if (wait) {
      var long = Date.now() - waitStarted > 45000;
      $("[data-waiting-label]", panels.waiting).textContent = v.state === "awaiting_payment" ? "Confirming payment" : "Payment received";
      $("[data-waiting-title]", panels.waiting).textContent = v.state === "awaiting_payment" ? "Confirming your payment" : "Releasing your power bank";
      $("[data-waiting-text]", panels.waiting).textContent = long
        ? "This is taking longer than usual. Please keep this page open and don't pay again. If no power bank comes out, your payment is refunded automatically."
        : "Stay on this page. It takes a few seconds.";
      show("waiting");
      pollTimer = setTimeout(poll, 2000);
      lastState = v.state;
      return;
    }
    if (v.state === "active") {
      show("active");
      pollTimer = setTimeout(poll, 20000); // slow check, in case the rental finishes while the page is open
    } else if (v.state === "refunding") {
      show("refunding");
      pollTimer = setTimeout(poll, 4000);
    } else {
      show(panels[v.state] ? v.state : "closed");
      forget();
      current = null;
    }
    lastState = v.state;
  }

  // ---- the machine and the payment form ------------------------------------------------------------------------
  function loadStation() {
    show("loading");
    if (!station) { show("unknown"); return; }
    api("/api/rent/station?station=" + encodeURIComponent(station)).then(function (res) {
      if (res.status === 404) { show("unknown"); return; }
      // Not switched on yet (payment settings not in place): send people to the machine's own screen.
      if (res.status === 503 && res.json.error === "not_configured") { $("[data-station-line]").textContent = "Coming soon"; show("soon"); return; }
      if (res.status !== 200 || !res.json.ok) throw new Error("station " + res.status);
      station_ = res.json;
      $("[data-station-line]").textContent = station_.station.name;
      if (!station_.available) { show("unavailable"); return; }
      fillMoney(station_.pricing);
      fill({ cutoffLabel: station_.pricing.cutoffLabel, consentText: station_.consent.text });
      return startStripe().then(function () { show("form"); }).catch(function () { show("error"); });
    }).catch(function () { show("error"); });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.Stripe) return resolve();
      var s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve; s.onerror = function () { reject(new Error("Stripe.js did not load")); };
      document.head.appendChild(s);
    });
  }

  function startStripe() {
    if (elements) return Promise.resolve();
    // Stripe.js must come from js.stripe.com. Only the local test setup swaps in a stand-in, and the server only
    // says so when its fake Stripe is on, which it refuses on the live site.
    var src = station_.devStripe ? "/js/dev-stripe.js" : "https://js.stripe.com/v3";
    return loadScript(src).then(function () {
      stripe = window.Stripe(station_.publishableKey);
      elements = stripe.elements({
        mode: "payment", amount: station_.pricing.firstChargePence, currency: station_.pricing.currency,
        setupFutureUsage: "off_session", paymentMethodTypes: ["card"],
        appearance: { theme: "stripe", variables: { colorPrimary: "#0a0a0a", fontFamily: "system-ui, sans-serif", borderRadius: "10px" } },
      });
      var opts = { layout: "tabs" };
      if (station_.applePayOptions) opts.applePay = station_.applePayOptions; // optional, from config
      var el;
      try { el = elements.create("payment", opts); } catch (e) { el = elements.create("payment", { layout: "tabs" }); }
      el.mount("#payment-element");
      el.on && el.on("change", function () { var pe = document.getElementById("payment-error"); if (pe) pe.textContent = ""; });
    });
  }

  function updatePayButton() { payButton.disabled = !$("#consent", form).checked; }
  $("#consent", form).addEventListener("change", updatePayButton);
  $("#email", form).addEventListener("input", function (e) { if (e.target.getAttribute("aria-invalid") === "true") setErr(e.target, ""); });

  function busy(on, label) {
    payButton.disabled = on || !$("#consent", form).checked;
    $(".btn-text", payButton).textContent = label || "Pay and release a power bank";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearSay();
    var email = $("#email", form), consent = $("#consent", form);
    var mail = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { setErr(email, "Please enter an email address for your receipt."); email.focus(); return; }
    setErr(email, "");
    if (!consent.checked) { setErr(consent, "Please tick the box to agree."); return; }
    setErr(consent, "");
    busy(true, "Paying...");

    // 1. Let the Payment Element check what was entered. 2. Ask our server for the payment. 3. Confirm it with Stripe.
    elements.submit().then(function (r) {
      if (r && r.error) throw { shown: r.error.message || "Please check your payment details." };
      return current && current.clientSecret ? current : api("/api/rent/start", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ station: station, email: mail, consent: true, consentVersion: station_.consent.version }),
      }).then(function (res) {
        if (res.status === 409 && res.json.error === "terms_changed") { location.reload(); throw { quiet: true }; }
        if (res.status === 409) { show("unavailable"); throw { quiet: true }; }
        if (res.status === 400 && res.json.message) throw { shown: res.json.message };
        if (res.status === 503 && res.json.error === "not_configured") { show("soon"); throw { quiet: true }; }
        if (res.status === 429) throw { shown: "Too many attempts. Please wait a few minutes and try again." };
        if (res.status !== 200 || !res.json.ok) throw { shown: "We couldn't start the payment. You have not been charged. Please try again." };
        return { rentalId: res.json.rentalId, token: res.json.token, clientSecret: res.json.clientSecret };
      });
    }).then(function (rec) {
      current = rec;
      save({ station: station, rentalId: rec.rentalId, token: rec.token });
      var back = location.origin + "/rent?station=" + encodeURIComponent(station) + "&rental=" + encodeURIComponent(rec.rentalId) + "&t=" + encodeURIComponent(rec.token);
      return stripe.confirmPayment({ elements: elements, clientSecret: rec.clientSecret, confirmParams: { return_url: back }, redirect: "if_required" });
    }).then(function (result) {
      if (result && result.error) throw { shown: result.error.message || "Your payment didn't go through. You have not been charged.", retry: true };
      waitStarted = Date.now();
      show("waiting");
      follow(current);
    }).catch(function (err) {
      if (err && err.quiet) return;
      busy(false);
      say((err && err.shown) || "Something went wrong. You have not been charged. Please try again.", true);
      // A declined card keeps the same payment, so the next try uses the same one instead of starting another.
    });
  });

  $$('[data-action="retry"]', root).forEach(function (b) { b.addEventListener("click", loadStation); });
  $$('[data-action="again"]', root).forEach(function (b) {
    b.addEventListener("click", function () { forget(); current = null; history.replaceState(null, "", "/rent?station=" + encodeURIComponent(station)); loadStation(); });
  });
  window.addEventListener("pageshow", function (ev) { if (ev.persisted && current) poll(); });

  // ---- start ---------------------------------------------------------------------------------------------------
  if (location.protocol === "file:") { show("error"); return; }
  var rentalId = params.get("rental"), token = params.get("t");
  if (rentalId && token) {
    // Back from Stripe (for example after a bank check). Keep the token out of the address bar and history.
    save({ station: station, rentalId: rentalId, token: token });
    history.replaceState(null, "", "/rent?station=" + encodeURIComponent(station));
    follow({ rentalId: rentalId, token: token });
    api("/api/rent/station?station=" + encodeURIComponent(station)).then(function (res) { if (res.json && res.json.station) { station_ = res.json; $("[data-station-line]").textContent = res.json.station.name; } }).catch(function () {});
    return;
  }
  var saved = load();
  if (saved && saved.station === station && saved.rentalId && saved.token) { follow({ rentalId: saved.rentalId, token: saved.token }); api("/api/rent/station?station=" + encodeURIComponent(station)).then(function (res) { if (res.json && res.json.station) $("[data-station-line]").textContent = res.json.station.name; }).catch(function () {}); }
  else loadStation();
})();
