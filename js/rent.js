/* Rent a power bank. Checks the machine, takes payment with Stripe's Payment Element (Apple Pay first, Google Pay
   on Android, card), then follows the rental until the power bank is out, and shows what happens after.
   Nothing secret lives here: prices, wording and the Stripe publishable key all come from /api/rent/station.
   A power bank is only ever released by the server after Stripe confirms payment, never because of anything in this page.
   English and Arabic: the switch at the top, the phone's language, or the station's setting picks one. */
(function () {
  "use strict";
  var root = document.getElementById("rent");
  if (!root) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var params = new URLSearchParams(location.search);
  var station = (params.get("station") || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 16);
  var STORE_KEY = "procura_rental_v1", LANG_KEY = "procura_lang";
  var panels = {};
  $$("[data-state]", root).forEach(function (el) { panels[el.getAttribute("data-state")] = el; });
  var form = document.getElementById("rent-form");
  var payButton = document.getElementById("pay-button");
  var statusBox = $(".form-status", form);
  var head = document.getElementById("rent-head");
  var station_ = null, stripe = null, elements = null, current = null, lastRental = null, pollTimer = null, waitStarted = 0, stripeReady = false;
  var lastFill = {}, lastView = null;
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  // Start fetching Stripe.js straight away, alongside everything else, so the payment form appears sooner.
  // (Stripe.js must come from js.stripe.com. Only the local test setup swaps in a stand-in.)
  var stripeJs = isLocal ? null : loadScript("https://js.stripe.com/v3").catch(function () { return null; });

  // ---- English and Arabic -----------------------------------------------------------------------------------------
  // Arabic wording for every [data-i18n] element. English is what the page already contains.
  // Links inside are written as site addresses because this text is added after the page is built.
  var AR = {
    heroTitle: "استأجر باور بانك",
    checking: "جارٍ التحقق من الجهاز.",
    unknownLabel: "الجهاز غير معروف",
    unknownTitle: "لم نتعرّف على هذا الجهاز.",
    unknownText: "يرجى مسح رمز QR الموجود على الجهاز مرة أخرى. لم يتم خصم أي مبلغ منك.",
    unavailableLabel: "غير متاح مؤقتاً",
    unavailableTitle: "لا يمكن لهذا الجهاز تأجير باور بانك الآن.",
    unavailableText: "يرجى المحاولة مرة أخرى بعد بضع دقائق أو استخدام جهاز آخر. لم يتم خصم أي مبلغ منك.",
    checkAgain: "تحقّق مرة أخرى",
    soonLabel: "قريباً",
    soonTitle: "الدفع بالهاتف سيتوفر قريباً.",
    soonText: "حالياً، يرجى استئجار باور بانك باستخدام شاشة الجهاز. لم يتم خصم أي مبلغ منك.",
    soonExtra: "",
    errorLabel: "حدث خطأ ما",
    errorTitle: "تعذّر علينا التحقق من الجهاز الآن.",
    errorText: "يرجى تحديث الصفحة بعد دقيقة. لم يتم خصم أي مبلغ منك. إذا استمرت المشكلة، راسلنا على <a href=\"mailto:peter@procuracharge.com\">peter@procuracharge.com</a>.",
    fastTag: "شحن فائق السرعة · الكابلات مدمجة",
    perHour: "لكل ساعة",
    consentLead: "بالدفع، فإنك تؤكد:",
    termsLink: "شروط الإيجار الكاملة (بالإنجليزية)",
    securePay: "دفع آمن",
    payButton: "ادفع <span data-money-short=\"firstChargePence\"></span> واستلم الباور بانك",
    assure: "إذا لم يخرج الباور بانك، نردّ لك المبلغ تلقائياً. تتم معالجة الدفع بأمان عبر Stripe.",
    activeLabel: "جاهز",
    activeTitle: "خذ الباور بانك",
    activeOut: "لقد خرج من الجهاز الآن. خذه من الفتحة المفتوحة.",
    activeSeated: "<strong>هل تجلس على طاولة؟</strong> سيُحضره لك أحد الموظفين.",
    soFarLabel: "حتى الآن",
    seated: "<strong>هل تجلس على طاولة؟</strong> نادِ أحد الموظفين وسيُحضر لك الباور بانك.",
    activeRules: "أعِده إلى الجهاز خلال <strong data-text=\"cutoffLabel\"></strong>، أي قبل الساعة <strong data-text=\"deadline\"></strong>. كل ساعة إضافية تبدأ تكلّف <strong data-money=\"pricePerHourPence\"></strong> بحدّ أقصى <strong data-money=\"maxRentPence\"></strong> إجمالاً، ونخصم أي مبلغ إضافي من بطاقتك المحفوظة عند إعادته. بعد انتهاء المهلة تُطبَّق رسوم قدرها <strong data-money=\"nonReturnFeePence\"></strong>.",
    activeClose: "يمكنك إغلاق هذه الصفحة. امسح رمز الجهاز مرة أخرى في أي وقت لرؤيتها.",
    receiptLabel: "هل تريد إيصالاً؟ أضف بريدك الإلكتروني وسنرسله إليك. اختياري.",
    receiptSend: "إرسال",
    returnedLabel: "تمت الإعادة",
    returnedTitle: "شكراً، انتهى كل شيء.",
    returnedText: "إجمالي هذا الإيجار <strong data-text=\"total\"></strong>.",
    rentAnother: "استئجار باور بانك آخر",
    refundedLabel: "تم الاسترداد",
    noReleaseTitle: "تعذّر إخراج باور بانك.",
    refundedText: "تم استرداد <strong data-text=\"refunded\"></strong> بالكامل. قد يستغرق ظهوره في كشف حسابك من 5 إلى 10 أيام عمل. لم يتم خصم أي مبلغ آخر منك.",
    tryAgain: "حاول مرة أخرى",
    refundingLabel: "جارٍ الاسترداد",
    refundingText: "نقوم الآن باسترداد مبلغك. ستتحدّث هذه الصفحة عند الانتهاء. لم يتم خصم أي مبلغ آخر منك.",
    lateLabel: "لم تتم الإعادة في الوقت المحدد",
    lateTitle: "انتهت المهلة.",
    expiredText: "لم تتم إعادة الباور بانك خلال <strong data-text=\"cutoffLabel\"></strong>، لذلك خصمنا الإيجار المستحق ورسوم عدم الإعادة. الإجمالي <strong data-text=\"total\"></strong>. لن يتم خصم أي مبلغ آخر.",
    thanksReturn: "شكراً لإعادته.",
    returnedUnpaidText: "تعذّر علينا خصم المبلغ المتبقي <strong data-text=\"due\"></strong> من بطاقتك. يرجى مراسلتنا على <a href=\"mailto:peter@procuracharge.com\">peter@procuracharge.com</a> وسنقوم بحل الأمر.",
    expiredUnpaidText: "لم تتم إعادة الباور بانك خلال <strong data-text=\"cutoffLabel\"></strong> وتعذّر علينا خصم المبلغ المستحق <strong data-text=\"due\"></strong> من بطاقتك. يرجى مراسلتنا على <a href=\"mailto:peter@procuracharge.com\">peter@procuracharge.com</a>.",
    closedLabel: "انتهى",
    closedTitle: "انتهى هذا الإيجار.",
    rentOne: "استأجر باور بانك",
    foot: "تديرها شركة JUKIE Experiences Ltd باسم Procura. <a href=\"/rental-terms\" target=\"_blank\" rel=\"noopener\">شروط الإيجار</a> و<a href=\"/privacy\" target=\"_blank\" rel=\"noopener\">إشعار الخصوصية</a> (بالإنجليزية).",
  };
  // Messages the script writes itself: [English, Arabic].
  var MSG = {
    paying: ["Paying...", "جارٍ الدفع..."],
    confirmingLabel: ["Confirming payment", "جارٍ تأكيد الدفع"],
    paidLabel: ["Payment received", "تم استلام الدفع"],
    confirmingTitle: ["Confirming your payment", "جارٍ تأكيد دفعتك"],
    releasingTitle: ["Releasing your power bank", "جارٍ إخراج الباور بانك"],
    waitShort: ["Stay on this page. It takes a few seconds.", "ابقَ على هذه الصفحة، يستغرق الأمر بضع ثوانٍ."],
    waitLong: ["This is taking longer than usual. Please keep this page open and don't pay again. If no power bank comes out, your payment is refunded automatically.",
      "يستغرق الأمر وقتاً أطول من المعتاد. يرجى إبقاء هذه الصفحة مفتوحة وعدم الدفع مرة أخرى. إذا لم يخرج الباور بانك، سيتم استرداد مبلغك تلقائياً."],
    generic: ["Something went wrong. You have not been charged. Please try again.", "حدث خطأ ما. لم يتم خصم أي مبلغ منك. يرجى المحاولة مرة أخرى."],
    startFailed: ["We couldn't start the payment. You have not been charged. Please try again.", "تعذّر بدء عملية الدفع. لم يتم خصم أي مبلغ منك. يرجى المحاولة مرة أخرى."],
    tooMany: ["Too many attempts. Please wait a few minutes and try again.", "محاولات كثيرة. يرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى."],
    notThrough: ["Your payment didn't go through. You have not been charged.", "لم تتم عملية الدفع. لم يتم خصم أي مبلغ منك."],
    checkDetails: ["Please check your payment details.", "يرجى التحقق من بيانات الدفع."],
    receiptSent: ["Receipt sent.", "تم إرسال الإيصال."],
    receiptBad: ["That email address doesn't look right.", "عنوان البريد الإلكتروني غير صحيح."],
    receiptFailed: ["We couldn't send it just now. Please try again.", "تعذّر الإرسال الآن. يرجى المحاولة مرة أخرى."],
    meterNext: ["In use {t} · next {p} from {time}", "قيد الاستخدام منذ {t} · المبلغ التالي {p} ابتداءً من {time}"],
    meterCapped: ["In use {t} · rent has reached the {max} maximum", "قيد الاستخدام منذ {t} · بلغ الإيجار الحد الأقصى {max}"],
  };
  var LANG = "en";
  var msg = function (key) { return MSG[key][LANG === "ar" ? 1 : 0]; };

  // "12 hours" in Arabic follows Arabic number agreement: 1, 2, 3 to 10, and 11 or more.
  function arCount(n, one, two, few, many) {
    if (n === 1) return one;
    if (n === 2) return two;
    return n >= 3 && n <= 10 ? n + " " + few : n + " " + many;
  }
  function cutoffText(ms, english) {
    if (LANG !== "ar" || !ms) return english || "";
    var hours = ms / 3600000;
    if (Number.isInteger(hours)) return arCount(hours, "ساعة واحدة", "ساعتين", "ساعات", "ساعة");
    return arCount(Math.round(ms / 60000), "دقيقة واحدة", "دقيقتين", "دقائق", "دقيقة");
  }

  function setLang(lang, remember) {
    LANG = lang === "ar" ? "ar" : "en";
    if (remember) { try { localStorage.setItem(LANG_KEY, LANG); } catch (e) { /* private mode */ } }
    $$("[data-i18n]").forEach(function (el) {
      if (el.getAttribute("data-en") === null) el.setAttribute("data-en", el.innerHTML);
      var key = el.getAttribute("data-i18n");
      el.innerHTML = LANG === "ar" && AR[key] !== undefined ? AR[key] : el.getAttribute("data-en");
    });
    [root, head].forEach(function (el) { if (el) { el.setAttribute("dir", LANG === "ar" ? "rtl" : "ltr"); el.setAttribute("lang", LANG); } });
    $$("[data-lang]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-lang") === LANG)); });
    if (station_ && station_.station) $("[data-station-line]").textContent = station_.station.name;
    refill();
    if (elements && elements.update) { try { elements.update({ locale: LANG }); } catch (e) { /* older Stripe.js */ } }
  }
  $$("[data-lang]").forEach(function (b) { b.addEventListener("click", function () { setLang(b.getAttribute("data-lang"), true); }); });

  function startingLang() {
    try { var saved = localStorage.getItem(LANG_KEY); if (saved) return saved; } catch (e) { /* ignore */ }
    var langs = navigator.languages || [navigator.language || ""];
    return langs.some(function (l) { return /^ar\b/i.test(l || ""); }) ? "ar" : "en";
  }
  function hasSavedLang() { try { return !!localStorage.getItem(LANG_KEY); } catch (e) { return false; } }

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
    // Messages take focus so screen readers read them out. The loading placeholder does not: it announces itself,
    // and focusing it would scroll the page away from the heading while the price loads.
    if (el && name !== "form" && name !== "loading") { el.setAttribute("tabindex", "-1"); try { el.focus({ preventScroll: false }); } catch (e) { /* older browsers */ } }
  }
  function fill(map) {
    Object.keys(map).forEach(function (k) { lastFill[k] = map[k]; });
    Object.keys(lastFill).forEach(function (k) {
      $$('[data-text="' + k + '"]', root).forEach(function (el) { el.textContent = lastFill[k]; });
    });
  }
  function fillMoney(pricing) {
    $$("[data-money]", root).forEach(function (el) {
      var key = el.getAttribute("data-money");
      if (pricing && pricing[key] !== undefined) el.textContent = money(pricing[key]);
    });
    // The big price drops the pence when it is whole pounds: "£3", not "£3.00".
    $$("[data-money-short]", root).forEach(function (el) {
      var key = el.getAttribute("data-money-short");
      var p = pricing && pricing[key];
      if (typeof p === "number") el.textContent = p % 100 === 0 ? "£" + p / 100 : money(p);
    });
  }
  // Puts the numbers and wording back after a language switch rewrote the text around them.
  function refill() {
    if (station_ && station_.pricing) {
      fillMoney(station_.pricing);
      var consent = LANG === "ar" && station_.consentAr ? station_.consentAr : station_.consent;
      lastFill.consentText = consent ? consent.text : "";
      lastFill.cutoffLabel = cutoffText(station_.pricing.cutoffMs, station_.pricing.cutoffLabel);
    }
    if (lastView) applyView(lastView);
    fill({});
  }
  function say(text, isError) {
    statusBox.textContent = text;
    statusBox.classList.add("is-shown");
    statusBox.classList.toggle("is-error", !!isError);
  }
  function clearSay() { statusBox.classList.remove("is-shown", "is-error"); statusBox.textContent = ""; }

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
    lastRental = rec;
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

  // ---- running total, while the power bank is out ----------------------------------------------------------------
  // What returning it now would cost, worked out on the phone with the server's own rule: any started hour counts,
  // at least one, capped. Nothing extra to run and no extra charges. The machine starts its clock a few seconds
  // before the page hears the power bank is out, so the next charge time is shown 2 minutes early, rounded down:
  // a customer who goes by it can never be caught out.
  function durText(ms) {
    var mins = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(mins / 60), m = mins % 60, mm = (m < 10 ? "0" : "") + m;
    if (LANG === "ar") return h ? h + " س " + mm + " د" : m + " د";
    return h ? h + " h " + mm + " min" : m + " min";
  }
  function hhmm(t) { return new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
  function updateMeter(v) {
    var box = $(".rent-meter", panels.active);
    if (!box) return;
    var start = Date.parse((v && v.releasedAt) || ""), per = Number(v && v.pricePerHourPence), max = Number(v && v.maxRentPence);
    if (!v || v.state !== "active" || !start || !per || !max) { box.hidden = true; return; }
    var elapsed = Math.max(0, Date.now() - start);
    var hours = Math.max(1, Math.ceil(elapsed / 3600000));
    var rent = Math.max(Math.min(max, hours * per), Number(v.paidPence) || 0);
    var line = hours * per >= max
      ? msg("meterCapped").replace("{max}", money(max))
      : msg("meterNext").replace("{p}", money(Math.min(per, max - hours * per)))
        .replace("{time}", hhmm(Math.floor((start + hours * 3600000 - 120000) / 60000) * 60000));
    fill({ soFar: money(rent), meterNext: line.replace("{t}", durText(elapsed)) });
    box.hidden = false;
  }

  function applyView(v) {
    updateMeter(v);
    fill({
      cutoffLabel: cutoffText(v.cutoffMs, v.cutoffLabel), total: money(v.totalPence), due: money(v.duePence), refunded: money(v.refundedPence || v.paidPence),
      deadline: v.cutoffAt ? new Date(v.cutoffAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "",
    });
  }

  function render(v) {
    lastView = v;
    applyView(v);
    if (v.state === "awaiting_payment" || v.state === "releasing") {
      var long = Date.now() - waitStarted > 45000;
      $("[data-waiting-label]", panels.waiting).textContent = msg(v.state === "awaiting_payment" ? "confirmingLabel" : "paidLabel");
      $("[data-waiting-title]", panels.waiting).textContent = msg(v.state === "awaiting_payment" ? "confirmingTitle" : "releasingTitle");
      $("[data-waiting-text]", panels.waiting).textContent = msg(long ? "waitLong" : "waitShort");
      show("waiting");
      pollTimer = setTimeout(poll, 2000);
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
  }

  // ---- the machine and the payment form ------------------------------------------------------------------------
  // Two requests at once: the prices and wording come back quickly, while the machine check (which asks the
  // supplier) runs alongside. The form shows as soon as it can. Nothing is charged without a fresh machine check:
  // the server checks the machine again before it creates the payment.
  function loadStation() {
    show("loading");
    if (!station) { show("unknown"); return; }
    var q = "/api/rent/station?station=" + encodeURIComponent(station);
    var machine = api(q).catch(function () { return null; });
    api(q + "&check=0").then(function (res) {
      if (res.status === 404) { show("unknown"); return; }
      if (res.status === 503 && res.json.error === "not_configured") { $("[data-station-line]").textContent = LANG === "ar" ? "قريباً" : "Coming soon"; show("soon"); return; }
      if (res.status !== 200 || !res.json.ok) throw new Error("station " + res.status);
      station_ = res.json;
      if (!hasSavedLang() && station_.station.lang && station_.station.lang !== LANG) setLang(station_.station.lang, false);
      $("[data-station-line]").textContent = station_.station.name;
      if (station_.available === false) { show("unavailable"); return; }
      refill();
      var unavailable = false;
      // The machine check decides whether the form may stay.
      machine.then(function (m) {
        if (!m) return;
        if (m.status === 404) { unavailable = true; return show("unknown"); }
        if (m.status === 200 && m.json && m.json.available === false) { unavailable = true; return show("unavailable"); }
      });
      // The price and the form show now. The pay button waits (with a placeholder where Apple Pay goes) until
      // Stripe's form is ready, instead of the whole page waiting behind a loading message.
      if (!unavailable) show("form");
      return startStripe().then(function () { if (stripeReady) busy(false); }).catch(function () { show("error"); });
    }).catch(function () { show("error"); });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve; s.onerror = function () { reject(new Error("script did not load")); };
      document.head.appendChild(s);
    });
  }

  function startStripe() {
    if (stripe) return Promise.resolve();
    var ready = station_.devStripe ? loadScript("/js/dev-stripe.js") : (stripeJs || loadScript("https://js.stripe.com/v3"));
    return Promise.resolve(ready).then(function () {
      if (!window.Stripe) throw new Error("Stripe.js did not load");
      stripe = window.Stripe(station_.publishableKey);
      elements = stripe.elements({
        mode: "payment", amount: station_.pricing.firstChargePence, currency: station_.pricing.currency,
        setupFutureUsage: "off_session", paymentMethodTypes: ["card"], locale: LANG,
        appearance: { theme: "stripe", variables: { colorPrimary: "#0a0a0a", fontFamily: "system-ui, sans-serif", borderRadius: "10px" } },
      });
      // Apple Pay first and already selected (Google Pay on Android), then card.
      // terms "never" hides Stripe's own "you allow ... to charge your card / Apple Pay account for future payments"
      // paragraphs: our consent wording directly above the pay button already says exactly that, with the amounts and timing.
      var opts = { layout: "tabs", paymentMethodOrder: ["apple_pay", "google_pay", "card"], terms: { card: "never", applePay: "never", googlePay: "never" } };
      if (station_.applePayOptions) opts.applePay = station_.applePayOptions; // optional, from config
      var el;
      try { el = elements.create("payment", opts); } catch (e) { el = elements.create("payment", { layout: "tabs" }); }
      el.mount("#payment-element");
      if (el.on) {
        el.on("change", function () { var pe = document.getElementById("payment-error"); if (pe) pe.textContent = ""; });
        el.on("ready", function () {
          stripeReady = true;
          var sk = $("[data-pay-skeleton]");
          if (sk) sk.hidden = true;
          busy(false);
        });
        el.on("loaderror", function () { show("error"); });
      }
    });
  }

  function busy(on, label) {
    payButton.disabled = on;
    var text = $(".btn-text", payButton);
    if (on) { text.textContent = label; return; }
    text.innerHTML = LANG === "ar" ? AR.payButton : (text.getAttribute("data-en") || 'Pay <span data-money-short="firstChargePence"></span> and get a power bank');
    if (station_ && station_.pricing) fillMoney(station_.pricing); // the amount on the button
  }

  function startOnServer() {
    var consent = LANG === "ar" && station_.consentAr ? station_.consentAr : station_.consent;
    return api("/api/rent/start", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ station: station, consent: true, consentVersion: consent.version, lang: LANG }),
    }).then(function (res) {
      if (res.status === 409 && res.json.error === "terms_changed") { location.reload(); throw { quiet: true }; }
      if (res.status === 409) { show("unavailable"); throw { quiet: true }; }
      if (res.status === 503 && res.json.error === "not_configured") { show("soon"); throw { quiet: true }; }
      if (res.status === 429) throw { shown: msg("tooMany") };
      if (res.status !== 200 || !res.json.ok) throw { shown: msg("startFailed") };
      return { rentalId: res.json.rentalId, token: res.json.token, clientSecret: res.json.clientSecret };
    });
  }

  // Check what was entered (this opens Apple Pay or Google Pay when chosen), ask our server for the payment,
  // then confirm it with Stripe. The power bank is released by the server only after Stripe confirms the payment.
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearSay();
    busy(true, msg("paying"));
    elements.submit().then(function (r) {
      if (r && r.error) throw { shown: r.error.message || msg("checkDetails") };
      return current && current.clientSecret ? current : startOnServer();
    }).then(function (rec) {
      current = rec;
      lastRental = rec;
      save({ station: station, rentalId: rec.rentalId, token: rec.token });
      var back = location.origin + "/rent?station=" + encodeURIComponent(station) + "&rental=" + encodeURIComponent(rec.rentalId) + "&t=" + encodeURIComponent(rec.token);
      return stripe.confirmPayment({ elements: elements, clientSecret: rec.clientSecret, confirmParams: { return_url: back }, redirect: "if_required" });
    }).then(function (result) {
      if (result && result.error) throw { shown: result.error.message || msg("notThrough") };
      waitStarted = Date.now();
      show("waiting");
      follow(current);
    }).catch(function (err) {
      busy(false);
      if (err && err.quiet) return;
      say((err && err.shown) || msg("generic"), true);
      if (statusBox.scrollIntoView) statusBox.scrollIntoView({ block: "center", behavior: "smooth" });
      // A declined card keeps the same payment, so the next try uses the same one instead of starting another.
    });
  });

  // ---- optional receipt, after the power bank is out ------------------------------------------------------------
  $$(".rent-receipt", root).forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $("input", f), status = $(".rent-receipt__status", f), button = $("button", f);
      var mail = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { status.textContent = msg("receiptBad"); input.focus(); return; }
      var rec = current || lastRental;
      if (!rec) return;
      button.disabled = true;
      api("/api/rent/receipt", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ rental: rec.rentalId, t: rec.token, email: mail }),
      }).then(function (res) {
        var ok = res.status === 200 && res.json.ok;
        status.textContent = ok ? msg("receiptSent") : res.status === 400 ? msg("receiptBad") : msg("receiptFailed");
        if (ok) input.disabled = true; else button.disabled = false;
      }).catch(function () { status.textContent = msg("receiptFailed"); button.disabled = false; });
    });
  });

  $$('[data-action="retry"]', root).forEach(function (b) { b.addEventListener("click", loadStation); });
  $$('[data-action="again"]', root).forEach(function (b) {
    b.addEventListener("click", function () { forget(); current = null; lastView = null; history.replaceState(null, "", "/rent?station=" + encodeURIComponent(station)); loadStation(); });
  });
  window.addEventListener("pageshow", function (ev) { if (ev.persisted && current) poll(); });

  // ---- start ---------------------------------------------------------------------------------------------------
  setLang(startingLang(), false);
  if (location.protocol === "file:") { show("error"); return; }
  var rentalId = params.get("rental"), token = params.get("t");
  function stationDetails() {
    api("/api/rent/station?station=" + encodeURIComponent(station) + "&check=0").then(function (res) {
      if (res.json && res.json.station) { station_ = res.json; $("[data-station-line]").textContent = res.json.station.name; refill(); }
    }).catch(function () {});
  }
  if (rentalId && token) {
    // Back from Stripe (for example after a bank check). Keep the token out of the address bar and history.
    save({ station: station, rentalId: rentalId, token: token });
    history.replaceState(null, "", "/rent?station=" + encodeURIComponent(station));
    follow({ rentalId: rentalId, token: token });
    stationDetails();
    return;
  }
  var saved = load();
  if (saved && saved.station === station && saved.rentalId && saved.token) { follow({ rentalId: saved.rentalId, token: saved.token }); stationDetails(); }
  else loadStation();
})();
