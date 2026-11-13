"use strict";
// Shared setup for the rental tests: a service wired to fakes, with a clock the test controls.
const { loadConfig } = require("../lib/rental/config");
const { createMemoryStore } = require("../lib/rental/store-memory");
const { createFakeSupplier } = require("../lib/rental/supplier-fake");
const { createFakeStripe } = require("../lib/rental/stripe-fake");
const { createStripe } = require("../lib/rental/stripe");
const { createService } = require("../lib/rental/service");
const { consentText, consentVersion } = require("../lib/rental/copy");

const T0 = Date.parse("2026-11-20T10:00:00Z");
const HOUR = 3600e3, MIN = 60e3;

const ENV = {
  STRIPE_SECRET_KEY: "rk_test_abc", STRIPE_PUBLISHABLE_KEY: "pk_test_abc", STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
  STATIONS: "AJ1=DTA59552", SITE_URL: "https://procuracharge.com", SUPPLIER_MODE: "fake", RENTAL_STORE: "memory",
};

function setup(envOverrides = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const config = loadConfig({ ...ENV, ...envOverrides });
  const store = createMemoryStore({ now: () => new Date(clock.t) });
  const supplier = createFakeSupplier({ now });
  supplier.addMachine("DTA59552");
  const fakeStripe = createFakeStripe({ now });
  const stripe = createStripe({ secretKey: config.stripe.secretKey, fetchImpl: fakeStripe.fetchImpl });
  const logs = [];
  const service = createService({ store, supplier, stripe, config, now, log: (k, m) => logs.push([k, m]) });
  const version = consentVersion(consentText(config));
  return {
    clock, config, store, supplier, fakeStripe, stripe, service, logs, version,
    advance(ms) { clock.t += ms; },
    // A customer who has accepted the terms starts a rental.
    async start(extra = {}) {
      return service.startRental({ station: "AJ1", email: "sam@example.com", consent: true, consentVersion: version, ...extra });
    },
    // The customer's payment completes and Stripe sends the webhook.
    async pay(piId, opts) {
      const d = fakeStripe.completePayment(piId, opts);
      const res = await service.handleStripeWebhook(d.body, d.signature);
      return { res, delivery: d };
    },
    // Full happy path up to "the power bank is out".
    async rentUntilActive() {
      const s = await this.start();
      const row0 = await store.get(s.json.rentalId);
      const paid = await this.pay(row0.stripe_payment_intent_id);
      const row = await store.get(s.json.rentalId);
      await service.refreshRelease(row);
      return { rentalId: s.json.rentalId, token: s.json.token, piId: row0.stripe_payment_intent_id, paid, row: await store.get(s.json.rentalId) };
    },
  };
}

module.exports = { setup, T0, HOUR, MIN, ENV };
