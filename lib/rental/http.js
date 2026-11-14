"use strict";
// HTTP-shaped handlers shared by the Netlify functions and the local server. Each takes plain values and returns
// plain values, so neither platform's request format leaks into the logic.
const crypto = require("crypto");

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const MAX_JSON = 8 * 1024;
const MAX_RAW = 256 * 1024;

// A small in-memory limiter. A serverless instance forgets it when it is recycled, so it only slows down casual abuse.
// The limits are generous on purpose: everyone on a venue's Wi-Fi or a mobile carrier can share one public address.
function createLimiter() {
  const hits = new Map();
  return function limited(key, max, windowMs, now = Date.now()) {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return list.length > max;
  };
}
const limited = createLimiter();

const json = (status, obj, headers = {}) => ({ status, headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...headers }, body: JSON.stringify(obj) });
const text = (status, body, headers = {}) => ({ status, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE, ...headers }, body });

const NOT_READY = () => json(503, { ok: false, error: "not_configured" });

// ---- Customer API: /api/rent/station, /api/rent/start, /api/rent/status -------------------------------------------
async function rentApi(rt, { method, action, query = {}, body, ip = "unknown" }) {
  // Setup check: says whether the system is ready and, if not, which settings are missing or wrong.
  // Only setting names and fixed descriptions, never a value, so it is safe to be public.
  if (action === "health" && method === "GET") {
    if (limited(`hc:${ip}`, 30, 60000)) return json(429, { ok: false, error: "slow_down" });
    const out = { ok: true, ready: rt.ready, problems: rt.ready ? [] : (rt.problems.length ? rt.problems : ["setup incomplete"]) };
    // With ?station=AJ1, also ask the supplier about that machine and show what came back.
    if (rt.ready && query.station) {
      if (limited(`hd:${ip}`, 10, 60000)) return json(429, { ok: false, error: "slow_down" });
      try { out.machine = await rt.service.stationDiagnostics(String(query.station)); } catch (e) { out.machine = { error: "check failed" }; }
    }
    return json(200, out);
  }
  if (!rt.ready) { rt.log("config", `not ready: ${rt.problems.join("; ") || "missing store, supplier or Stripe"}`); return NOT_READY(); }
  try {
    if (action === "station" && method === "GET") {
      if (limited(`st:${ip}`, 300, 60000)) return json(429, { ok: false, error: "slow_down" });
      const out = await rt.service.getStation(String(query.station || ""));
      // Tells the page to use the local stand-in for Stripe.js. Only true while the fake Stripe is on, which config refuses when hosted.
      if (out.json && out.json.ok && rt.fakeStripe) out.json.devStripe = true;
      return json(out.status, out.json);
    }
    if (action === "start" && method === "POST") {
      if (limited(`go:${ip}`, 40, 10 * 60000)) return json(429, { ok: false, error: "slow_down" });
      const b = body && typeof body === "object" ? body : {};
      const out = await rt.service.startRental({ station: b.station, email: b.email, consent: b.consent, consentVersion: b.consentVersion });
      return json(out.status, out.json);
    }
    if (action === "status" && method === "GET") {
      if (limited(`ss:${ip}`, 900, 60000)) return json(429, { ok: false, error: "slow_down" });
      const out = await rt.service.getStatus({ id: String(query.rental || ""), token: String(query.t || "") });
      return json(out.status, out.json);
    }
    if (action === "station" || action === "start" || action === "status") return json(405, { ok: false, error: "method_not_allowed" }, { Allow: action === "start" ? "POST" : "GET" });
    return json(404, { ok: false, error: "not_found" });
  } catch (e) {
    rt.log("error", `${action}: ${e && e.message}`);
    return json(500, { ok: false, error: "server_error" });
  }
}

// ---- Stripe webhook ---------------------------------------------------------------------------------------------
async function stripeWebhookApi(rt, { method, rawBody, headers = {} }) {
  if (method !== "POST") return text(405, "POST only", { Allow: "POST" });
  if (!rt.ready) return text(503, "not configured");
  if (typeof rawBody !== "string" || rawBody.length > MAX_RAW) return text(400, "bad body");
  try {
    const out = await rt.service.handleStripeWebhook(rawBody, headers["stripe-signature"]);
    return text(out.status, out.body);
  } catch (e) {
    rt.log("error", `webhook: ${e && e.message}`);
    return text(500, "try again");
  }
}

// ---- Supplier callback: /api/bajie/callback/<secret>/<rentalId> -------------------------------------------------
// The supplier sends no signature, so the long secret in the path is the only gate, and what arrives is only a hint.
async function supplierCallbackApi(rt, { method, secret, rentalId, rawBody = "", query = {} }) {
  if (!rt.ready || !rt.config.supplier.callbackSecretPath) return text(404, "not found");
  const want = crypto.createHash("sha256").update(rt.config.supplier.callbackSecretPath).digest();
  const have = crypto.createHash("sha256").update(String(secret || "")).digest();
  if (!crypto.timingSafeEqual(want, have)) return text(404, "not found");
  if (method !== "POST" && method !== "GET") return text(405, "method not allowed");
  const sample = rawBody ? String(rawBody).slice(0, 400) : JSON.stringify(query).slice(0, 400);
  try { await rt.service.handleSupplierHint(rentalId, sample); }
  catch (e) { rt.log("error", `callback: ${e && e.message}`); }
  return text(200, rt.config.supplier.callbackAck); // what the supplier expects back is unconfirmed: see BAJIE_CALLBACK_ACK
}

// ---- Admin ------------------------------------------------------------------------------------------------------
function basicCredentials(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(String(header || ""));
  if (!m) return null;
  const s = Buffer.from(m[1], "base64").toString("utf8");
  const i = s.indexOf(":");
  return i < 0 ? null : { user: s.slice(0, i), pass: s.slice(i + 1) };
}
const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

async function adminApi(rt, { method, headers = {}, ip = "unknown", render }) {
  const secureHeaders = {
    "Content-Type": "text/html; charset=utf-8", ...NO_STORE, "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
  const deny = (status, msg, extra = {}) => ({ status, headers: { ...secureHeaders, ...extra }, body: `<!doctype html><meta charset="utf-8"><title>Admin</title><p>${msg}</p>` });
  if (method !== "GET" && method !== "HEAD") return deny(405, "Not allowed");
  const { password, username } = rt.config.admin;
  if (!password || password.length < 12) return deny(503, "The admin page is switched off until ADMIN_PASSWORD is set (12 characters or more).");
  if (limited(`ad:${ip}`, 30, 15 * 60000)) return deny(429, "Too many attempts. Try again later.");
  const c = basicCredentials(headers.authorization);
  const ok = c && crypto.timingSafeEqual(digest(c.user), digest(username)) & crypto.timingSafeEqual(digest(c.pass), digest(password));
  if (!ok) return deny(401, "Sign in required.", { "WWW-Authenticate": 'Basic realm="Procura admin", charset="UTF-8"' });
  if (!rt.ready) return deny(503, `Not ready: ${rt.problems.map((x) => String(x).replace(/[<>&]/g, "")).join("; ") || "setup incomplete"}`);
  try {
    const overview = await rt.service.adminOverview();
    return { status: 200, headers: secureHeaders, body: method === "HEAD" ? "" : render(overview, rt.config) };
  } catch (e) {
    rt.log("error", `admin: ${e && e.message}`);
    return deny(500, "Something went wrong reading rentals.");
  }
}

// ---- Netlify event helpers ----------------------------------------------------------------------------------------
function rawBodyOf(event) {
  if (event.body == null) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : String(event.body);
}
function ipOf(event) {
  const h = event.headers || {};
  return h["x-nf-client-connection-ip"] || h["client-ip"] || String(h["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}
const toNetlify = (r) => ({ statusCode: r.status, headers: r.headers, body: r.body });

module.exports = { rentApi, stripeWebhookApi, supplierCallbackApi, adminApi, rawBodyOf, ipOf, toNetlify, json, text, MAX_JSON, MAX_RAW, createLimiter };
