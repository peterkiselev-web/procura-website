"use strict";
// Minimal Stripe REST client (no SDK, so the functions stay small). Server side only.
// Uses form encoding and an Idempotency-Key on every write that moves money.
const crypto = require("crypto");

class StripeError extends Error {
  constructor(message, info = {}) { super(message); this.name = "StripeError"; Object.assign(this, info); }
}

// Stripe takes nested values as bracket keys: metadata[rental_id]=x, payment_method_types[0]=card
function encodeForm(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? encodeForm(item, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`)));
    else if (typeof v === "object") encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

const modeOf = (secretKey) => (/^(sk|rk)_live_/.test(secretKey) ? "live" : "test");

function createStripe({ secretKey, apiBase = "https://api.stripe.com", fetchImpl = fetch, timeoutMs = 12000 }) {
  if (!/^(sk|rk)_(test|live)_/.test(secretKey || "")) throw new Error("A Stripe secret or restricted key is required");

  async function api(method, path, params, idempotencyKey) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = { Authorization: `Bearer ${secretKey}` };
    let url = apiBase + path, body;
    if (method === "GET") { const q = params ? encodeForm(params).join("&") : ""; if (q) url += "?" + q; }
    else { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = encodeForm(params || {}).join("&"); }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let res, text;
    try { res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal }); text = await res.text(); }
    catch (e) { throw new StripeError(e.name === "AbortError" ? "Stripe timed out" : "Stripe unreachable", { kind: "network" }); }
    finally { clearTimeout(timer); }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* below */ }
    if (!res.ok) {
      const err = (json && json.error) || {};
      throw new StripeError(err.message || `Stripe HTTP ${res.status}`, {
        kind: err.type || "http", status: res.status, code: err.code, declineCode: err.decline_code, paymentIntent: err.payment_intent || null,
      });
    }
    return json;
  }

  return {
    mode: modeOf(secretKey),
    createCustomer({ email, rentalId }) {
      return api("POST", "/v1/customers", { email, description: "Procura QR rental", metadata: { rental_id: rentalId } }, `cus-${rentalId}`);
    },
    // The first-hour payment. The card is saved for later off-session charges (spec section 4).
    createFirstPayment({ amount, currency, customer, rentalId, email, description }) {
      return api("POST", "/v1/payment_intents", {
        amount, currency, customer, description, receipt_email: email,
        setup_future_usage: "off_session",
        payment_method_types: ["card"], // card covers Apple Pay and Google Pay
        metadata: { rental_id: rentalId, kind: "first_hour" },
      }, `first-${rentalId}`);
    },
    retrievePaymentIntent(id) { return api("GET", `/v1/payment_intents/${encodeURIComponent(id)}`); },
    // Charges the saved card without the customer present. Returns { ok: true, paymentIntent } or { ok: false, ... }.
    async chargeOffSession({ amount, currency, customer, paymentMethod, rentalId, kind, email, description, key }) {
      try {
        const pi = await api("POST", "/v1/payment_intents", {
          amount, currency, customer, payment_method: paymentMethod, off_session: true, confirm: true, description, receipt_email: email,
          payment_method_types: ["card"], metadata: { rental_id: rentalId, kind },
        }, key);
        if (pi.status === "succeeded") return { ok: true, paymentIntent: pi };
        return { ok: false, code: pi.last_payment_error ? pi.last_payment_error.code : pi.status, requiresAction: pi.status === "requires_action", message: `payment is ${pi.status}`, paymentIntentId: pi.id };
      } catch (e) {
        if (e.kind === "network" || (e.status && e.status >= 500) || e.status === 409 || e.status === 429) throw e; // unknown outcome: let the caller retry with the same key
        return { ok: false, code: e.code || e.kind, declineCode: e.declineCode, requiresAction: e.code === "authentication_required", message: e.message, paymentIntentId: e.paymentIntent && e.paymentIntent.id };
      }
    },
    cancelPaymentIntent(id, rentalId) { return api("POST", `/v1/payment_intents/${encodeURIComponent(id)}/cancel`, {}, `cancel-${rentalId}`); },
    // The key carries a counter that only moves after Stripe answered with a server error (which Stripe may remember
    // against the key), and only after checking with listRefunds that the earlier try did not go through.
    createRefund({ paymentIntent, rentalId, amount, key }) {
      return api("POST", "/v1/refunds", { payment_intent: paymentIntent, amount, metadata: { rental_id: rentalId } }, key || `refund-${rentalId}`);
    },
    async listRefunds(paymentIntent) {
      const j = await api("GET", "/v1/refunds", { payment_intent: paymentIntent, limit: 10 });
      return (j && j.data) || [];
    },
    // Used to check whether an earlier charge for this rental went through before trying again under a new key.
    async findChargeForRental({ customer, rentalId, kind }) {
      const j = await api("GET", "/v1/payment_intents", { customer, limit: 20 });
      return ((j && j.data) || []).find((pi) => pi.metadata && pi.metadata.rental_id === rentalId && pi.metadata.kind === kind && pi.status === "succeeded") || null;
    },
  };
}

// Verifies the Stripe-Signature header against the exact raw body, then returns the parsed event.
// Follows Stripe's documented manual scheme: only t and v1 are used, any v1 may match, and old timestamps are refused.
function verifyWebhook(rawBody, header, secret, { toleranceSeconds = 300, nowMs = Date.now() } = {}) {
  const fail = (m) => { throw new StripeError(m, { kind: "signature" }); };
  if (!secret) fail("webhook secret is not set");
  if (typeof rawBody !== "string" || !header) fail("missing signature");
  let t = null;
  const sigs = [];
  for (const part of String(header).split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") sigs.push(v);
  }
  if (!t || !/^\d+$/.test(t) || !sigs.length) fail("malformed signature header");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const ok = sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    return crypto.timingSafeEqual(expected, Buffer.from(s, "hex"));
  });
  if (!ok) fail("signature does not match");
  if (toleranceSeconds <= 0 || Math.abs(nowMs / 1000 - Number(t)) > toleranceSeconds) fail("timestamp outside tolerance");
  try { return JSON.parse(rawBody); } catch (e) { return fail("body is not JSON"); }
}

// Builds a header the way Stripe does. Used by tests and the local demo to send signed events.
function signWebhook(rawBody, secret, nowMs = Date.now()) {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

module.exports = { createStripe, verifyWebhook, signWebhook, StripeError, encodeForm, modeOf };
