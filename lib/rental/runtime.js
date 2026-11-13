"use strict";
// Builds the working service from environment variables. One per server process.
// Fails closed: with anything missing or unsafe, requests get a plain "not configured" answer and no payment starts.
const { loadConfig, configProblems } = require("./config");
const { createService } = require("./service");
const { createStripe } = require("./stripe");
const { createBajieSupplier } = require("./supplier");
const { createSupabaseStore } = require("./store-supabase");
const { createMemoryStore } = require("./store-memory");

let cached = null;

function buildRuntime(env = process.env, overrides = {}) {
  const config = loadConfig(env);
  const hosted = config.hosted;
  const log = overrides.log || ((kind, msg) => console.log(`[rental:${kind}] ${msg}`));
  const problems = configProblems(config, env);

  const store = overrides.store || (config.store.mode === "memory" ? createMemoryStore() : (config.store.supabaseUrl && config.store.supabaseKey ? createSupabaseStore({ url: config.store.supabaseUrl, key: config.store.supabaseKey }) : null));

  let supplier = overrides.supplier || null, fakeSupplier = null;
  if (!supplier) {
    if (config.supplier.mode === "fake" && !hosted) {
      fakeSupplier = require("./supplier-fake").createFakeSupplier();
      for (const s of Object.values(config.stations)) fakeSupplier.addMachine(s.deviceId);
      supplier = fakeSupplier;
    } else if (config.supplier.mode !== "fake" && config.supplier.username && config.supplier.password && ["basic_plain", "basic_sha256", "token"].includes(config.supplier.authMode)) {
      supplier = createBajieSupplier({ ...config.supplier, timeoutMs: config.timing.supplierTimeoutMs });
    }
  }

  // Local testing only: Stripe replaced by an in-process fake, so the whole flow can be tried with no Stripe account.
  let fakeStripe = null, stripe = overrides.stripe || null;
  if (!stripe && String(env.STRIPE_FAKE || "").toLowerCase() === "yes" && !hosted) {
    fakeStripe = require("./stripe-fake").createFakeStripe({ webhookSecret: config.stripe.webhookSecret });
    stripe = createStripe({ secretKey: config.stripe.secretKey || "rk_test_fake", fetchImpl: fakeStripe.fetchImpl });
  } else if (!stripe && /^(sk|rk)_(test|live)_/.test(config.stripe.secretKey)) {
    stripe = createStripe({ secretKey: config.stripe.secretKey, apiBase: hosted ? "https://api.stripe.com" : config.stripe.apiBase });
  }

  const ready = problems.length === 0 && store && supplier && stripe;
  const service = ready ? createService({ store, supplier, stripe, config, log }) : null;
  return { config, problems, ready: Boolean(ready), service, store, supplier, stripe, fakeSupplier, fakeStripe, log, devMode: Boolean(fakeStripe || fakeSupplier) };
}

function getRuntime(env = process.env) {
  if (!cached) cached = buildRuntime(env);
  return cached;
}

// For tests: forget the cached runtime.
function resetRuntime() { cached = null; }

module.exports = { buildRuntime, getRuntime, resetRuntime };
