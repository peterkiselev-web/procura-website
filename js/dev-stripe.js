/* LOCAL TESTING ONLY. A stand-in for Stripe.js so the rent page can be tried with no Stripe account.
   The server only asks the page to load this when its fake Stripe is on, which it refuses on the live site,
   and netlify.toml hides this file on the live site.
   Card: 4000 0000 0000 9995 is "declined", anything else pays.
   Wallet: a fake "Rent with Apple Pay" button that pays and supplies wallet@example.com (only when asked for the email). */
(function () {
  "use strict";
  window.Stripe = function () {
    return {
      elements: function () {
        var box = null, express = false;
        return {
          create: function (type, opts) {
            if (type === "expressCheckout") {
              express = true;
              var handlers = {};
              return {
                on: function (name, fn) { handlers[name] = fn; },
                destroy: function () { var b = document.querySelector('[data-test="wallet"]'); if (b) b.parentNode.removeChild(b); },
                mount: function (sel) {
                  var b = document.createElement("button");
                  b.type = "button"; b.className = "btn"; b.textContent = "Rent with Apple Pay (fake)"; b.setAttribute("data-test", "wallet");
                  b.addEventListener("click", function () {
                    var resolved = !handlers.click;
                    if (handlers.click) handlers.click({ resolve: function () { resolved = true; } });
                    if (!resolved || !handlers.confirm) return;
                    handlers.confirm({
                      expressPaymentType: "apple_pay",
                      billingDetails: { name: "Wallet Payer", email: opts && opts.emailRequired ? "wallet@example.com" : "" },
                      paymentFailed: function () { b.setAttribute("data-failed", "1"); },
                    });
                  });
                  document.querySelector(sel).appendChild(b);
                  var none = window.__devNoWallets === true; // tests use this to play a phone with no wallet
                  if (none) b.style.display = "none";
                  setTimeout(function () { if (handlers.ready) handlers.ready({ availablePaymentMethods: none ? undefined : { applePay: true, googlePay: false } }); }, 0);
                },
              };
            }
            return {
              mount: function (sel) {
                box = document.createElement("input");
                box.type = "text"; box.value = "4242 4242 4242 4242"; box.setAttribute("aria-label", "Card number (fake)"); box.setAttribute("data-test", "card");
                document.querySelector(sel).appendChild(box);
              },
              on: function () {},
              destroy: function () { if (box && box.parentNode) box.parentNode.removeChild(box); box = null; },
              _opts: opts,
            };
          },
          submit: function () { return Promise.resolve(express || (box && box.value.trim()) ? {} : { error: { message: "Enter a card number." } }); },
          _card: function () { return box ? box.value.replace(/\s+/g, "") : ""; },
        };
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
