"use strict";
// A fake of the Stripe REST API, for automated tests and the local demo. It speaks just enough of Stripe for this
// project: customers, payment intents (including off-session confirm), refunds, and idempotency keys.
// It is NOT Stripe: nothing here proves anything about real cards, Apple Pay or real declines.
const { signWebhook } = require("./stripe");

function parse(body) {
  const flat = {};
  for (const [k, v] of new URLSearchParams(body || "")) flat[k] = v;
  const out = { metadata: {} };
  for (const [k, v] of Object.entries(flat)) {
    const m = k.match(/^metadata\[(.+)\]$/);
    if (m) out.metadata[m[1]] = v; else out[k] = v;
  }
  return out;
}

function createFakeStripe({ webhookSecret = "whsec_test_fake", now = () => Date.now() } = {}) {
  const state = { customers: new Map(), intents: new Map(), refunds: new Map(), idem: new Map(), calls: [], seq: 0 };
  // throw500Once: Stripe answers 500 and (as Stripe may do) remembers that answer against the idempotency key.
  // throw500AfterCommit: the same, but the charge or refund really did go through first.
  const controls = { decline: null, requireAuth: false, failRefund: null, networkFail: false, throw500Once: false, throw500AfterCommit: false };
  const next = (prefix) => `${prefix}_${(++state.seq).toString().padStart(4, "0")}`;
  const reply = (status, json) => ({ ok: status < 300, status, text: async () => JSON.stringify(json) });
  const err = (status, type, code, message, extra = {}) => reply(status, { error: { type, code, message, ...extra } });

  async function fetchImpl(url, init = {}) {
    const method = init.method || "GET";
    const u = new URL(url);
    const params = method === "GET" ? Object.fromEntries(u.searchParams) : parse(init.body);
    const key = init.headers && init.headers["Idempotency-Key"];
    state.calls.push({ method, path: u.pathname, params, key, auth: init.headers && init.headers.Authorization });
    if (controls.networkFail) { controls.networkFail = false; throw new Error("network down"); }
    if (key && state.idem.has(key)) return state.idem.get(key);
    let res;
    if (controls.throw500Once && method === "POST") { controls.throw500Once = false; res = reply(500, { error: { type: "api_error", message: "oops" } }); }
    else if (controls.throw500AfterCommit && method === "POST") { controls.throw500AfterCommit = false; route(method, u.pathname, params); res = reply(500, { error: { type: "api_error", message: "oops" } }); }
    else res = route(method, u.pathname, params);
    if (key && method === "POST") state.idem.set(key, res);
    return res;
  }

  function route(method, path, p) {
    let m;
    if (method === "POST" && path === "/v1/customers") {
      const c = { id: next("cus"), email: p.email, metadata: p.metadata }; state.customers.set(c.id, c); return reply(200, c);
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      const pi = {
        id: next("pi"), object: "payment_intent", amount: Number(p.amount), currency: p.currency, customer: p.customer, status: "requires_payment_method",
        metadata: p.metadata, setup_future_usage: p.setup_future_usage || null, receipt_email: p.receipt_email || null, payment_method: null, amount_received: 0, refunded: false,
      };
      pi.client_secret = `${pi.id}_secret_${next("s")}`;
      if (p.confirm === "true") {
        if (p.off_session !== "true" || !p.payment_method) return err(400, "invalid_request_error", "parameter_missing", "off_session charges need a saved payment method");
        pi.payment_method = p.payment_method;
        if (controls.requireAuth) { pi.status = "requires_action"; state.intents.set(pi.id, pi); return err(402, "card_error", "authentication_required", "Authentication required", { payment_intent: { id: pi.id, status: pi.status } }); }
        if (controls.decline) { pi.status = "requires_payment_method"; state.intents.set(pi.id, pi); return err(402, "card_error", "card_declined", "Your card was declined.", { decline_code: controls.decline, payment_intent: { id: pi.id, status: pi.status } }); }
        pi.status = "succeeded"; pi.amount_received = pi.amount;
      }
      state.intents.set(pi.id, pi);
      return reply(200, pi);
    }
    if (method === "GET" && path === "/v1/payment_intents") {
      return reply(200, { data: [...state.intents.values()].filter((pi) => !p.customer || pi.customer === p.customer) });
    }
    if (method === "GET" && path === "/v1/refunds") {
      return reply(200, { data: [...state.refunds.values()].filter((r) => !p.payment_intent || r.payment_intent === p.payment_intent) });
    }
    if ((m = path.match(/^\/v1\/payment_intents\/([^/]+)$/)) && method === "GET") {
      const pi = state.intents.get(m[1]); return pi ? reply(200, pi) : err(404, "invalid_request_error", "resource_missing", "No such payment_intent");
    }
    if ((m = path.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/)) && method === "POST") {
      const pi = state.intents.get(m[1]);
      if (!pi) return err(404, "invalid_request_error", "resource_missing", "No such payment_intent");
      if (pi.status === "succeeded") return err(400, "invalid_request_error", "payment_intent_unexpected_state", "Already succeeded");
      pi.status = "canceled"; return reply(200, pi);
    }
    if (method === "POST" && path === "/v1/refunds") {
      if (controls.failRefund) return err(500, "api_error", null, "refund failed");
      const pi = state.intents.get(p.payment_intent);
      if (!pi || pi.status !== "succeeded") return err(400, "invalid_request_error", "charge_not_refundable", "Nothing to refund");
      if (pi.refunded) return err(400, "invalid_request_error", "charge_already_refunded", "Charge has already been refunded.");
      pi.refunded = true;
      const r = { id: next("re"), amount: p.amount ? Number(p.amount) : pi.amount_received, payment_intent: pi.id, status: "succeeded" };
      state.refunds.set(r.id, r); return reply(200, r);
    }
    return err(404, "invalid_request_error", "resource_missing", `Unrecognised request ${method} ${path}`);
  }

  // Plays the customer completing payment: marks the intent paid and returns the signed webhook delivery for it.
  function completePayment(piId, { paymentMethod = "pm_card_visa", eventId = next("evt") } = {}) {
    const pi = state.intents.get(piId);
    if (!pi) throw new Error("no such payment intent");
    pi.status = "succeeded"; pi.amount_received = pi.amount; pi.payment_method = paymentMethod;
    return deliveryFor(pi, "payment_intent.succeeded", eventId);
  }
  function deliveryFor(object, type, eventId = next("evt")) {
    const body = JSON.stringify({ id: eventId, object: "event", type, created: Math.floor(now() / 1000), data: { object } });
    return { body, signature: signWebhook(body, webhookSecret, now()), eventId };
  }

  return { fetchImpl, state, controls, completePayment, deliveryFor, webhookSecret };
}

module.exports = { createFakeStripe };
