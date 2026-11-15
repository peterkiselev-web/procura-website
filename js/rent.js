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
  var station_ = null, stripe = null, cardElements = null, expressElements = null, cardEl = null, ece = null, walletDecided = false, current = null, pollTimer = null, lastState = null, waitStarted = 0;

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

  function elementsOptions() {
    return {
      mode: "payment", amount: station_.pricing.firstChargePence, currency: station_.pricing.currency,
      setupFutureUsage: "off_session", paymentMethodTypes: ["card"],
      appearance: { theme: "stripe", variables: { colorPrimary: "#0a0a0a", fontFamily: "system-ui, sans-serif", borderRadius: "10px" } },
    };
  }

  function startStripe() {
    if (stripe) return Promise.resolve();
    // Stripe.js must come from js.stripe.com. Only the local test setup swaps in a stand-in, and the server only
    // says so when its fake Stripe is on, which it refuses on the live site.
    var src = station_.devStripe ? "/js/dev-stripe.js" : "https://js.stripe.com/v3";
    return loadScript(src).then(function () {
      stripe = window.Stripe(station_.publishableKey);
      // One thing at a time: first find out whether the one-tap Apple Pay or Google Pay button can show, and only
      // then build the card form. That way only one part of the page is ever asking the phone about Apple Pay.
      try { startExpress(); } catch (e) { decideWallets(false); }
    });
  }

  // withWallets false: card only, because the one-tap button above handles Apple Pay and Google Pay.
  // withWallets true: the one-tap button could not show, so this form offers Apple Pay first and pre-selected,
  // exactly as the page did before the one-tap button existed.
  function mountCardForm(withWallets) {
    if (cardEl && cardEl.destroy) cardEl.destroy();
    cardElements = stripe.elements(elementsOptions()); // a fresh group each time
    var opts = withWallets
      ? { layout: "tabs", paymentMethodOrder: ["apple_pay", "google_pay", "card"] }
      : { layout: "tabs", wallets: { applePay: "never", googlePay: "never" } };
    try { cardEl = cardElements.create("payment", opts); } catch (e) { cardEl = cardElements.create("payment", { layout: "tabs" }); }
    cardEl.mount("#payment-element");
    if (cardEl.on) cardEl.on("change", function () { var pe = document.getElementById("payment-error"); if (pe) pe.textContent = ""; });
  }

  // Called once: either the one-tap button shows (card form below it), or it is removed and the form takes over.
  function decideWallets(buttonShows) {
    if (walletDecided) return;
    walletDecided = true;
    if (buttonShows) {
      $("#express-box").hidden = false;
      $("#rent-or").hidden = false;
      mountCardForm(false);
      return;
    }
    if (ece && ece.destroy) { try { ece.destroy(); } catch (e) { /* already gone */ } }
    ece = null;
    $("#express-box").hidden = true;
    $("#rent-or").hidden = true;
    $("#pay-label").textContent = "Pay with";
    mountCardForm(true);
  }

  function anyWallet(methods) {
    return !!methods && Object.keys(methods).some(function (k) { return methods[k]; });
  }

  function startExpress() {
    expressElements = stripe.elements(elementsOptions());
    var opts = {
      emailRequired: true, // Apple Pay and Google Pay only share the email when asked
      lineItems: [{ name: "Power bank rental, first hour", amount: station_.pricing.firstChargePence }],
      // "always", as Stripe advises: Apple Pay shows even when Stripe cannot detect a card in the wallet, and Google Pay
      // shows on iPhones too (on iOS browsers Stripe only offers Google Pay when it is set to "always").
      paymentMethods: { applePay: "always", googlePay: "always" },
      buttonType: { applePay: "rent", googlePay: "pay" },
      buttonHeight: 54,
      layout: { maxColumns: 1, maxRows: 3, overflow: "never" },
    };
    if (station_.applePayOptions) opts.applePay = station_.applePayOptions; // optional, from config
    try { ece = expressElements.create("expressCheckout", opts); }
    catch (e) { ece = expressElements.create("expressCheckout", { emailRequired: true, paymentMethods: { applePay: "always", googlePay: "always" } }); }
    // The box stays visible while Stripe works out which buttons to show: Stripe cannot lay out buttons in a hidden box.
    var settle = null;
    ece.on("ready", function (ev) {
      if (anyWallet(ev && ev.availablePaymentMethods)) return decideWallets(true);
      settle = setTimeout(function () { decideWallets(false); }, 2500); // Stripe can report buttons a moment later
    });
    ece.on("availablepaymentmethodschange", function (ev) {
      if (anyWallet(ev && (ev.paymentMethods || ev.availablePaymentMethods))) { if (settle) clearTimeout(settle); decideWallets(true); }
    });
    ece.on("loaderror", function () { decideWallets(false); });
    ece.on("click", function (ev) { clearSay(); ev.resolve(); });
    ece.on("confirm", function (ev) {
      pay(expressElements, (ev.billingDetails && ev.billingDetails.email) || "", ev);
    });
    ece.mount("#express-checkout");
    // If Stripe never says anything (blocked or failed), fall back rather than leave the page without a form.
    setTimeout(function () { decideWallets(false); }, 6000);
  }

  $("#email", form).addEventListener("input", function (e) { if (e.target.getAttribute("aria-invalid") === "true") setErr(e.target, ""); });

  function busy(on, label) {
    payButton.disabled = on;
    $(".btn-text", payButton).textContent = label || "Pay by card and release a power bank";
  }

  function startOnServer(email) {
    return api("/api/rent/start", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ station: station, email: email, consent: true, consentVersion: station_.consent.version }),
    }).then(function (res) {
      if (res.status === 409 && res.json.error === "terms_changed") { location.reload(); throw { quiet: true }; }
      if (res.status === 409) { show("unavailable"); throw { quiet: true }; }
      if (res.status === 400 && res.json.message) throw { shown: res.json.message };
      if (res.status === 503 && res.json.error === "not_configured") { show("soon"); throw { quiet: true }; }
      if (res.status === 429) throw { shown: "Too many attempts. Please wait a few minutes and try again." };
      if (res.status !== 200 || !res.json.ok) throw { shown: "We couldn't start the payment. You have not been charged. Please try again." };
      return { rentalId: res.json.rentalId, token: res.json.token, clientSecret: res.json.clientSecret };
    });
  }

  // Shared by the wallet button and the card form: check what was entered, ask our server for the payment,
  // then confirm it with Stripe. The power bank is released by the server only after Stripe confirms the payment.
  function pay(group, email, walletEvent) {
    var confirming = false;
    clearSay();
    busy(true, "Paying...");
    group.submit().then(function (r) {
      if (r && r.error) throw { shown: r.error.message || "Please check your payment details." };
      return current && current.clientSecret ? current : startOnServer(email);
    }).then(function (rec) {
      current = rec;
      save({ station: station, rentalId: rec.rentalId, token: rec.token });
      var back = location.origin + "/rent?station=" + encodeURIComponent(station) + "&rental=" + encodeURIComponent(rec.rentalId) + "&t=" + encodeURIComponent(rec.token);
      confirming = true;
      return stripe.confirmPayment({ elements: group, clientSecret: rec.clientSecret, confirmParams: { return_url: back }, redirect: "if_required" });
    }).then(function (result) {
      if (result && result.error) throw { shown: result.error.message || "Your payment didn't go through. You have not been charged." };
      waitStarted = Date.now();
      show("waiting");
      follow(current);
    }).catch(function (err) {
      // Close the Apple Pay or Google Pay sheet if we failed before handing over to Stripe.
      if (walletEvent && !confirming && walletEvent.paymentFailed) { try { walletEvent.paymentFailed({ reason: "fail" }); } catch (e) { /* already closed */ } }
      busy(false);
      if (err && err.quiet) return;
      say((err && err.shown) || "Something went wrong. You have not been charged. Please try again.", true);
      if (statusBox.scrollIntoView) statusBox.scrollIntoView({ block: "center", behavior: "smooth" });
      // A declined card keeps the same payment, so the next try uses the same one instead of starting another.
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("#email", form);
    var mail = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { setErr(email, "Please enter an email address for your receipt."); email.focus(); return; }
    setErr(email, "");
    pay(cardElements, mail, null);
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
