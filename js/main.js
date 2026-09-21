/* Procura UK: motion and interaction. Needs GSAP + ScrollTrigger + Lenis (loaded before this file). */
(function () {
  "use strict";

  var doc = document.documentElement;
  doc.classList.remove("no-js");
  doc.classList.add("js");

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasGsap = !!window.gsap;
  var gsap = window.gsap;
  var ST = window.ScrollTrigger;
  if (hasGsap && ST) gsap.registerPlugin(ST);

  function $(s, c) { return (c || document).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); }

  function safeGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

  /* ---------- Without GSAP, show everything and stop ---------- */
  if (!hasGsap) {
    doc.classList.remove("js");
    var l = $(".loader"); if (l) l.hidden = true;
    document.body.classList.remove("is-loading");
    initEstimator(); initForm(); initFaqPlain(); initMenuPlain();
    return;
  }

  /* ---------- Smooth scroll ---------- */
  var lenis = null;
  if (!reduce && window.Lenis) {
    lenis = new window.Lenis({ duration: 1.15, easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); }, smoothWheel: true });
    lenis.on("scroll", ST.update);
    gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
    gsap.ticker.lagSmoothing(0);
  }
  window.procuraLenis = lenis;

  /* ---------- Split headings into masked words ---------- */
  $$("[data-split]").forEach(function (el) {
    var html = [];
    // Keep <br> as explicit line breaks, split text on spaces.
    el.childNodes.forEach(function (node) {
      if (node.nodeType === 3) {
        node.textContent.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) { html.push(" "); return; }
          html.push('<span class="w"><span class="w-in">' + part.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span></span>");
        });
      } else if (node.nodeName === "BR") {
        html.push("<br>");
      } else {
        html.push('<span class="w"><span class="w-in">' + node.outerHTML + "</span></span>");
      }
    });
    el.setAttribute("aria-label", el.innerHTML.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim());
    el.innerHTML = html.join("");
    $$(".w", el).forEach(function (w) { w.setAttribute("aria-hidden", "true"); });
  });

  function revealSplit(el, delay) {
    return gsap.fromTo($$(".w-in", el), { yPercent: 110 }, { yPercent: 0, duration: 1.2, ease: "expo.out", stagger: 0.06, delay: delay || 0 });
  }

  /* ---------- Page intro: preloader on first home visit, curtain elsewhere ---------- */
  var loader = $(".loader");
  var curtain = $(".curtain");
  var introDone = false;
  var introCallbacks = [];
  function onIntro(fn) { if (introDone) fn(); else introCallbacks.push(fn); }
  function finishIntro() {
    introDone = true;
    document.body.classList.remove("is-loading");
    if (lenis) lenis.start();
    introCallbacks.forEach(function (fn) { fn(); });
    ST.refresh();
  }

  if (lenis) lenis.stop();

  if (loader && !reduce && document.visibilityState === "visible" && !safeGet("procura-seen")) {
    safeSet("procura-seen", "1");
    var count = $(".loader__count", loader);
    var bar = $(".loader__bar", loader);
    var obj = { v: 0 };
    var modelReady = false;
    window.addEventListener("procura:model-ready", function () { modelReady = true; }, { once: true });
    var tl = gsap.timeline();
    tl.to(obj, {
      v: 100, duration: 2.2, ease: "power2.inOut",
      onUpdate: function () { count.textContent = String(Math.round(obj.v)).padStart(2, "0"); bar.style.transform = "scaleX(" + obj.v / 100 + ")"; }
    })
      .to(loader, { clipPath: "inset(0 0 100% 0)", duration: 1.1, ease: "expo.inOut" }, "+=0.15")
      .add(function () { loader.hidden = true; finishIntro(); }, "-=0.45");
    loader.style.clipPath = "inset(0 0 0% 0)";
  } else {
    if (loader) loader.hidden = true;
    if (curtain && !reduce) {
      gsap.set(curtain, { yPercent: 0 });
      gsap.to(curtain, { yPercent: -100, duration: 0.9, ease: "expo.inOut", delay: 0.05, onComplete: function () { gsap.set(curtain, { yPercent: 100 }); } });
      setTimeout(finishIntro, 350);
    } else {
      finishIntro();
    }
  }

  /* ---------- Page transition on internal links ---------- */
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || !curtain || reduce) return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#" || a.target === "_blank" || a.hasAttribute("download") || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !/\.html$|\/$/.test(url.pathname)) return;
    if (url.pathname === location.pathname && url.hash) return;
    e.preventDefault();
    closeMenu(true);
    gsap.fromTo(curtain, { yPercent: 100 }, { yPercent: 0, duration: 0.7, ease: "expo.inOut", onComplete: function () { location.href = a.href; } });
  });
  window.addEventListener("pageshow", function (e) { if (e.persisted && curtain) gsap.set(curtain, { yPercent: 100 }); });

  /* ---------- Hero intro ---------- */
  onIntro(function () {
    $$("[data-hero] [data-split]").forEach(function (el, i) { revealSplit(el, 0.1 + i * 0.12); });
    gsap.fromTo("[data-hero] [data-hero-fade]", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 1.2, ease: "expo.out", stagger: 0.08, delay: 0.5 });
  });

  /* ---------- Scroll reveals ---------- */
  onIntro(function () {
    $$("[data-split]").forEach(function (el) {
      if (el.closest("[data-hero]")) return;
      gsap.set($$(".w-in", el), { yPercent: 110 });
      ST.create({ trigger: el, start: "top 88%", once: true, onEnter: function () { revealSplit(el); } });
    });
    $$("[data-fade]").forEach(function (el) {
      if (el.closest("[data-hero]")) { gsap.set(el, { opacity: 1, y: 0 }); return; }
      gsap.to(el, { opacity: 1, y: 0, duration: 1.2, ease: "expo.out", delay: parseFloat(el.dataset.fade) || 0, scrollTrigger: { trigger: el, start: "top 90%", once: true } });
    });

    /* Count-up numbers */
    $$("[data-count]").forEach(function (el) {
      var end = parseFloat(el.dataset.count);
      var pre = el.dataset.prefix || "", suf = el.dataset.suffix || "";
      var dec = (el.dataset.count.split(".")[1] || "").length;
      var o = { v: 0 };
      el.textContent = pre + (0).toFixed(dec) + suf;
      ST.create({
        trigger: el, start: "top 90%", once: true,
        onEnter: function () {
          gsap.to(o, { v: end, duration: 2, ease: "power3.out", onUpdate: function () {
            el.textContent = pre + o.v.toLocaleString("en-GB", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
          } });
        }
      });
    });

    /* Bars grow from the baseline */
    $$(".bar__fill").forEach(function (el) {
      gsap.fromTo(el, { scaleX: 0 }, { scaleX: 1, duration: 1.6, ease: "expo.out", scrollTrigger: { trigger: el, start: "top 92%", once: true } });
    });

    /* Parallax */
    $$("[data-speed]").forEach(function (el) {
      var s = parseFloat(el.dataset.speed);
      gsap.fromTo(el, { yPercent: -s * 50 }, { yPercent: s * 50, ease: "none", scrollTrigger: { trigger: el.parentElement, start: "top bottom", end: "bottom top", scrub: true } });
    });

    /* Big numbers scale up gently as they enter (the £0) */
    $$("[data-scale-in]").forEach(function (el) {
      gsap.fromTo(el, { scale: 0.7, opacity: 0.2 }, { scale: 1, opacity: 1, ease: "none", scrollTrigger: { trigger: el, start: "top 100%", end: "top 40%", scrub: true } });
    });

    /* Money flow: lines draw across as the section scrolls in */
    $$("[data-flow]").forEach(function (flow) {
      var lines = $$(".flow__line i", flow);
      var vertical = window.innerWidth < 800;
      gsap.fromTo(lines, vertical ? { scaleY: 0 } : { scaleX: 0 }, { scaleX: 1, scaleY: 1, ease: "none", stagger: 0.5,
        scrollTrigger: { trigger: flow, start: "top 85%", end: "top 45%", scrub: true } });
      gsap.fromTo($$(".flow__node", flow), { opacity: 0.25, y: 20 }, { opacity: 1, y: 0, ease: "none", stagger: 0.5,
        scrollTrigger: { trigger: flow, start: "top 90%", end: "top 45%", scrub: true } });
    });

    initRail();
    initSteps();
    initMarquee();
    initDockProgress();
  });

  /* ---------- Horizontal rail (pinned on desktop, swipe on mobile) ---------- */
  function initRail() {
    var rail = $("[data-rail]");
    if (!rail) return;
    var track = $(".rail__track", rail);
    var mm = gsap.matchMedia();
    mm.add("(min-width: 900px)", function () {
      var dist = function () { return Math.max(0, track.scrollWidth - window.innerWidth); };
      var tween = gsap.to(track, {
        x: function () { return -dist(); }, ease: "none",
        scrollTrigger: { trigger: rail, start: "top top", end: function () { return "+=" + dist(); }, pin: true, scrub: 0.6, invalidateOnRefresh: true, anticipatePin: 1 }
      });
      return function () { tween.scrollTrigger && tween.scrollTrigger.kill(); tween.kill(); gsap.set(track, { x: 0 }); };
    });
    mm.add("(max-width: 899px)", function () {
      track.style.overflowX = "auto";
      track.style.scrollSnapType = "x mandatory";
      $$(".machine-card", track).forEach(function (c) { c.style.scrollSnapAlign = "center"; });
      return function () { track.style.overflowX = ""; };
    });
  }

  /* ---------- Steps: highlight the one in view ---------- */
  function initSteps() {
    $$(".step").forEach(function (step) {
      ST.create({
        trigger: step, start: "top 60%", end: "bottom 40%",
        onToggle: function (self) { step.classList.toggle("is-active", self.isActive); }
      });
    });
  }

  /* ---------- Marquee: constant drift, nudged by scroll speed ---------- */
  function initMarquee() {
    $$(".marquee__inner").forEach(function (inner) {
      inner.innerHTML += inner.innerHTML;
      var x = 0, dir = -1, extra = 0;
      if (lenis) lenis.on("scroll", function (e) { extra = Math.min(12, Math.abs(e.velocity) * 0.4); dir = e.direction >= 0 ? -1 : 1; });
      gsap.ticker.add(function () {
        var half = inner.scrollWidth / 2;
        if (!half) return;
        x += dir * (0.6 + extra);
        extra *= 0.92;
        if (x <= -half) x += half;
        if (x > 0) x -= half;
        inner.style.transform = "translate3d(" + x + "px,0,0)";
      });
    });
  }

  /* ---------- Dock: scroll percentage ---------- */
  function initDockProgress() {
    var p = $(".dock__progress");
    if (!p) return;
    ST.create({ start: 0, end: "max", onUpdate: function (self) { p.textContent = String(Math.round(self.progress * 100)).padStart(2, "0") + "%"; } });
  }

  /* ---------- Header hides on scroll down ---------- */
  var header = $(".header");
  if (header) {
    ST.create({ start: 120, end: "max", onUpdate: function (self) { header.classList.toggle("is-hidden", self.direction === 1 && self.scroll() > 200); } });
  }

  /* ---------- Menu ---------- */
  var menu = $(".menu");
  var menuBtn = $(".dock__menu");
  var menuOpen = false;
  function openMenu() {
    if (!menu) return;
    menuOpen = true;
    doc.classList.add("menu-open");
    menuBtn.setAttribute("aria-expanded", "true");
    menu.style.visibility = "visible";
    if (lenis) lenis.stop();
    gsap.fromTo(menu, { clipPath: "inset(100% 0 0 0)" }, { clipPath: "inset(0% 0 0 0)", duration: 0.9, ease: "expo.inOut" });
    gsap.fromTo($$(".menu a", menu), { yPercent: 100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 1, ease: "expo.out", stagger: 0.05, delay: 0.35 });
    var first = $("a", menu); if (first) setTimeout(function () { first.focus(); }, 400);
  }
  function closeMenu(instant) {
    if (!menu || !menuOpen) return;
    menuOpen = false;
    doc.classList.remove("menu-open");
    menuBtn.setAttribute("aria-expanded", "false");
    if (lenis) lenis.start();
    if (instant) { menu.style.visibility = "hidden"; return; }
    gsap.to(menu, { clipPath: "inset(0 0 100% 0)", duration: 0.8, ease: "expo.inOut", onComplete: function () { menu.style.visibility = "hidden"; } });
  }
  if (menuBtn) {
    menuBtn.addEventListener("click", function () { menuOpen ? closeMenu() : openMenu(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && menuOpen) { closeMenu(); menuBtn.focus(); } });
  }

  /* ---------- Anchor links go through Lenis ---------- */
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("href");
      if (id.length < 2) return;
      var t = $(id);
      if (!t) return;
      e.preventDefault();
      if (lenis) lenis.scrollTo(t, { offset: -20 }); else t.scrollIntoView({ behavior: "smooth" });
    });
  });

  /* ---------- FAQ: animated open/close ---------- */
  $$(".faq details").forEach(function (d) {
    var summary = $("summary", d);
    var body = $(".faq__a", d);
    summary.addEventListener("click", function (e) {
      e.preventDefault();
      if (d.open) {
        gsap.to(body, { height: 0, duration: 0.6, ease: "expo.inOut", onComplete: function () { d.open = false; body.style.height = ""; ST.refresh(); } });
      } else {
        d.open = true;
        gsap.fromTo(body, { height: 0 }, { height: body.scrollHeight, duration: 0.7, ease: "expo.out", onComplete: function () { body.style.height = "auto"; ST.refresh(); } });
      }
    });
  });

  /* ---------- Videos play only while on screen ---------- */
  if ("IntersectionObserver" in window) {
    var vio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var v = en.target;
        if (en.isIntersecting && !reduce) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        else v.pause();
      });
    }, { threshold: 0.15 });
    $$("video[autoplay]").forEach(function (v) { if (reduce) v.removeAttribute("autoplay"); vio.observe(v); });
  }

  initEstimator();
  initForm();

  /* ================= Rental income estimator ================= */
  function initEstimator() {
    $$("[data-estimator]").forEach(function (box) {
      var ins = {}, outs = {};
      $$("[data-in]", box).forEach(function (i) { ins[i.dataset.in] = i; });
      $$("[data-out]", box).forEach(function (o) { outs[o.dataset.out] = o; });
      var shown = { v: 0 };
      function calc() {
        var r = +ins.rentals.value, h = +ins.hours.value, d = +ins.days.value;
        outs.rentals.textContent = r; outs.hours.textContent = h; outs.days.textContent = d;
        // £3 an hour, weeks averaged across the year
        var monthly = Math.round(r * h * 3 * d * 52 / 12);
        var fmt = function (n) { return "£" + Math.round(n).toLocaleString("en-GB"); };
        if (window.gsap && !reduce) gsap.to(shown, { v: monthly, duration: 0.6, ease: "power3.out", overwrite: true, onUpdate: function () { outs.total.textContent = fmt(shown.v); } });
        else { shown.v = monthly; outs.total.textContent = fmt(monthly); }
      }
      Object.keys(ins).forEach(function (k) { ins[k].addEventListener("input", calc); });
      calc();
    });
  }

  /* ================= Contact form ================= */
  function initForm() {
    var form = $("#enquiry");
    if (!form) return;
    var status = $(".form-status", form);
    var submit = $("button[type=submit]", form);

    // ?type=question preselects the second tab
    var params = new URLSearchParams(location.search);
    if (params.get("type") === "question") { var q = $("#type-question", form); if (q) q.checked = true; }
    syncType();
    $$("input[name=enquiry_type]", form).forEach(function (r) { r.addEventListener("change", syncType); });
    function syncType() {
      var call = $("#type-call", form);
      var isCall = call && call.checked;
      $$("[data-call-only]", form).forEach(function (el) { el.hidden = !isCall; });
      if (submit) $(".btn-text", submit).textContent = isCall ? "Book my free consultation" : "Send my question";
    }

    function setErr(input, msg) {
      var box = input.closest(".field");
      var err = box && $(".err", box);
      input.setAttribute("aria-invalid", msg ? "true" : "false");
      if (err) err.textContent = msg || "";
    }
    function validate() {
      var ok = true, first = null;
      $$("[required]", form).forEach(function (input) {
        if (input.closest("[hidden]")) { setErr(input, ""); return; }
        var v = (input.value || "").trim(), msg = "";
        if (!v) msg = "Please fill this in.";
        else if (input.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) msg = "That email address doesn't look right.";
        setErr(input, msg);
        if (msg) { ok = false; if (!first) first = input; }
      });
      var phone = $("#phone", form);
      if (phone && phone.value.trim() && !/^[+()\d\s-]{7,20}$/.test(phone.value.trim())) { setErr(phone, "Please check the number."); ok = false; first = first || phone; }
      if (first) first.focus();
      return ok;
    }
    $$("input, select, textarea", form).forEach(function (el) {
      el.addEventListener("input", function () { if (el.getAttribute("aria-invalid") === "true") setErr(el, ""); });
    });

    function show(msg, isError) {
      status.textContent = msg;
      status.classList.add("is-shown");
      status.classList.toggle("is-error", !!isError);
      status.setAttribute("tabindex", "-1");
      status.focus();
    }

    function mailtoFallback(data) {
      var to = form.dataset.fallbackEmail;
      var lines = [];
      Object.keys(data).forEach(function (k) { if (k !== "website" && data[k]) lines.push(k.replace(/_/g, " ") + ": " + data[k]); });
      var subject = (data.enquiry_type === "call" ? "Consultation call request: " : "Question: ") + (data.venue || data.name);
      location.href = "mailto:" + to + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(lines.join("\n"));
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!validate()) return;
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = String(v).trim(); });
      if (data.website) return; // honeypot
      var canMail = !!form.dataset.fallbackEmail;
      var offlineMsg = "We couldn't send your details just now. Please try again in a few minutes.";
      if (location.protocol === "file:") {
        if (canMail) { show("Opening your email app so you can send this to us."); mailtoFallback(data); } else show(offlineMsg, true);
        return;
      }
      submit.disabled = true;
      $(".btn-text", submit).textContent = "Sending...";
      // Netlify catches a form-encoded post to the site itself. Our own Node server takes JSON.
      var netlify = form.hasAttribute("data-netlify");
      var endpoint = netlify ? (form.dataset.endpoint || "/") : "/api/contact";
      var body = netlify ? new URLSearchParams(new FormData(form)).toString() : JSON.stringify(data);
      var headers = netlify
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : { "Content-Type": "application/json", "Accept": "application/json" };
      fetch(endpoint, { method: "POST", headers: headers, body: body })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); })
        .then(function () {
          form.reset(); syncType();
          show(data.enquiry_type === "call"
            ? "Thanks, " + data.name.split(" ")[0] + ". We've got your request and our team will get back to you to book your call."
            : "Thanks, " + data.name.split(" ")[0] + ". We've got your question and our team will get back to you.");
        })
        .catch(function () {
          if (canMail) { show("We couldn't reach our server, so we're opening your email app with your details filled in. Just press send."); mailtoFallback(data); }
          else show(offlineMsg, true);
        })
        .then(function () { submit.disabled = false; syncType(); });
    });
  }

  function initFaqPlain() { /* native <details> works without JS */ }
  function initMenuPlain() {
    var btn = $(".dock__menu"), m = $(".menu");
    if (!btn || !m) return;
    btn.addEventListener("click", function () {
      var open = m.style.visibility === "visible";
      m.style.visibility = open ? "hidden" : "visible";
      m.style.clipPath = open ? "" : "none";
      btn.setAttribute("aria-expanded", String(!open));
    });
  }
})();
