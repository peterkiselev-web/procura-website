/* LOCAL TESTING ONLY. A stand-in for Stripe.js so the rent page can be tried with no Stripe account.
   The server only asks the page to load this when its fake Stripe is on, which it refuses on the live site,
   and netlify.toml hides this file on the live site.
   Card 4000 0000 0000 9995 is "declined". Anything else pays. */
(function () {
  "use strict";
  window.Stripe = function () {
    return {
      elements: function (groupOpts) {
        var box = null;
        var group = {
          locale: (groupOpts && groupOpts.locale) || "en",
          create: function (type, opts) {
            group.createdWith = opts;
            return {
              mount: function (sel) {
                box = document.createElement("input");
                box.type = "text"; box.value = "4242 4242 4242 4242"; box.setAttribute("aria-label", "Card number (fake)"); box.setAttribute("data-test", "card");
                box.setAttribute("data-order", (opts && opts.paymentMethodOrder || []).join(","));
                document.querySelector(sel).appendChild(box);
              },
              on: function () {},
              destroy: function () { if (box && box.parentNode) box.parentNode.removeChild(box); box = null; },
            };
          },
          update: function (o) { if (o && o.locale) { group.locale = o.locale; if (box) box.setAttribute("data-locale", o.locale); } },
          submit: function () { return Promise.resolve(box && box.value.trim() ? {} : { error: { message: "Enter a card number." } }); },
          _card: function () { return box ? box.value.replace(/\s+/g, "") : ""; },
        };
        return group;
      },
      confirmPayment: function (opts) {
        if (opts.elements._card() === "4000000000009995") return Promise.resolve({ error: { message: "Your card was declined." } });
        var pi = String(opts.clientSecret).split("_secret_")[0];
        return fetch("/__dev/stripe/pay?pi=" + encodeURIComponent(pi), { method: "POST" }).then(function (r) { return r.json(); }).then(function (j) {
          return j && j.ok ? { paymentIntent: { status: "succeeded" } } : { error: { message: "Fake payment failed." } };
        });
      },
    };
  };
})();
