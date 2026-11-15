"use strict";
// Every number and switch for the QR rental lives here, read from environment variables.
// Nothing about price, timing or limits is written anywhere else in the code. Defaults are the values
// in the build spec (section 3). Secrets are only ever read on the server and never sent to the browser.

const int = (env, name, dflt, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  return n;
};

const AUTH_MODES = ["basic_plain", "basic_sha256", "token"];
const STATION_CODE = /^[A-Z0-9_-]{1,16}$/;

// STATIONS is either JSON ({"AJ1":"DTA59552"} or {"AJ1":{"deviceId":"DTA59552","name":"Al Jawhara"}})
// or a list: AJ1=DTA59552,LB2=DTA10001. Which value the supplier wants as deviceId (the machine number or the
// QR code content) is an open question, so it is simply whatever you put here.
function parseStations(raw) {
  const out = {};
  const text = String(raw || "").trim();
  if (!text) return out;
  let entries;
  if (text.startsWith("{")) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error("STATIONS is not valid JSON"); }
    entries = Object.entries(obj).map(([code, v]) => [code, typeof v === "string" ? { deviceId: v } : v || {}]);
  } else {
    entries = text.split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
      const i = pair.indexOf("=");
      if (i < 1) throw new Error(`STATIONS entry "${pair}" should look like AJ1=DEVICEID`);
      return [pair.slice(0, i).trim(), { deviceId: pair.slice(i + 1).trim() }];
    });
  }
  for (const [code, v] of entries) {
    const key = String(code).toUpperCase();
    if (!STATION_CODE.test(key)) throw new Error(`Station code "${code}" must be 1 to 16 letters, digits, - or _`);
    if (!v.deviceId || !/^[A-Za-z0-9_.:-]{1,64}$/.test(String(v.deviceId))) throw new Error(`Station ${key} needs a deviceId`);
    // lang: the page opens in this language unless the customer has chosen one ("en" or "ar").
    const lang = v.lang === "ar" || v.lang === "en" ? v.lang : null;
    out[key] = { code: key, deviceId: String(v.deviceId), name: String(v.name || key).slice(0, 80), lang };
  }
  return out;
}

function loadConfig(env = process.env) {
  const cfg = {
    currency: "gbp",
    pricing: {
      pricePerHourPence: int(env, "RENTAL_PRICE_PER_HOUR_PENCE", 300, { min: 1, max: 100000 }),
      firstChargePence: int(env, "RENTAL_FIRST_CHARGE_PENCE", 300, { min: 30, max: 100000 }),
      maxRentPence: int(env, "RENTAL_MAX_RENT_PENCE", 2000, { min: 1, max: 100000 }),
      nonReturnFeePence: int(env, "RENTAL_NON_RETURN_FEE_PENCE", 2000, { min: 0, max: 100000 }),
      cutoffHours: int(env, "RENTAL_CUTOFF_HOURS", 12, { min: 1, max: 72 }),
      // For testing only: a cut-off in minutes replaces the hours value (spec section 11, test 5).
      cutoffMinutesOverride: int(env, "RENTAL_CUTOFF_MINUTES_OVERRIDE", 0, { min: 0, max: 4320 }),
    },
    timing: {
      releaseTimeoutSeconds: int(env, "RENTAL_RELEASE_TIMEOUT_SECONDS", 60, { min: 10, max: 600 }),
      pollIntervalSeconds: int(env, "RENTAL_POLL_INTERVAL_SECONDS", 60, { min: 10, max: 3600 }),
      settleMaxAttempts: int(env, "RENTAL_SETTLE_MAX_ATTEMPTS", 3, { min: 1, max: 10 }),
      settleRetryMinutes: int(env, "RENTAL_SETTLE_RETRY_MINUTES", 60, { min: 1, max: 1440 }),
      staleUnpaidMinutes: int(env, "RENTAL_STALE_UNPAID_MINUTES", 30, { min: 5, max: 1440 }),
      supplierTimeoutMs: int(env, "BAJIE_TIMEOUT_MS", 8000, { min: 1000, max: 25000 }),
      closeMaxAttempts: int(env, "BAJIE_CLOSE_MAX_ATTEMPTS", 5, { min: 1, max: 20 }),
    },
    // A power bank counts as charged enough to rent at or above this level. The supplier's "vol" field is the
    // charge level; its unit is not documented, so this is a setting to confirm on the real machine.
    minBatteryVol: int(env, "RENTAL_MIN_BATTERY_VOL", 30, { min: 0, max: 100 }),
    rentalsEnabled: String(env.RENTALS_ENABLED || "yes").toLowerCase() !== "no",
    stations: parseStations(env.STATIONS),
    siteUrl: String(env.SITE_URL || env.URL || "").replace(/\/+$/, ""),
    deployContext: env.CONTEXT || "",
    // True anywhere that is not a developer's own machine: Netlify builds and functions, previews included.
    // Fakes (supplier, store, Stripe) are refused there, whatever else is set.
    hosted: Boolean(env.CONTEXT || env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME || env.LAMBDA_TASK_ROOT),
    receiptTimeZone: env.RENTAL_DISPLAY_TIME_ZONE || "Europe/London",
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || "",
      publishableKey: env.STRIPE_PUBLISHABLE_KEY || "",
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
      allowLive: String(env.ALLOW_LIVE_PAYMENTS || "").toLowerCase() === "yes",
      apiBase: env.STRIPE_API_BASE || "https://api.stripe.com",
      // Optional JSON passed straight to the Payment Element's applePay option (for Apple's deferred or
      // recurring payment sheet). Left unset until the exact shape is confirmed against the current Stripe docs.
      applePayOptions: env.STRIPE_APPLE_PAY_OPTIONS_JSON || "",
    },
    supplier: {
      mode: env.SUPPLIER_MODE || "bajie", // "bajie" or "fake" (local testing only, refused in production)
      baseUrl: (env.BAJIE_BASE_URL || "https://developer.chargenow.top/cdb-open-api/v1").replace(/\/+$/, ""),
      username: env.BAJIE_USERNAME || "",
      password: env.BAJIE_PASSWORD || "",
      authMode: env.BAJIE_AUTH_MODE || "", // basic_plain | basic_sha256 | token. No default: the supplier has not confirmed it.
      tokenHeader: env.BAJIE_TOKEN_HEADER || "Authorization",
      // A word before the token, always followed by one space. Empty means send the bare token.
      tokenPrefix: env.BAJIE_TOKEN_PREFIX === undefined ? "Bearer " : String(env.BAJIE_TOKEN_PREFIX).trim() ? String(env.BAJIE_TOKEN_PREFIX).trim() + " " : "",
      timeZone: env.BAJIE_TIME_ZONE || "UTC",
      callbackSecretPath: env.BAJIE_CALLBACK_SECRET_PATH || "",
      callbackAck: env.BAJIE_CALLBACK_ACK || "success",
    },
    store: {
      mode: env.RENTAL_STORE || "", // "supabase" or "memory" (tests and local testing only)
      supabaseUrl: String(env.SUPABASE_URL || "").replace(/\/+$/, ""),
      supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    },
    admin: {
      username: env.ADMIN_USERNAME || "admin",
      password: env.ADMIN_PASSWORD || "",
    },
  };
  if (cfg.pricing.firstChargePence > cfg.pricing.maxRentPence) throw new Error("RENTAL_FIRST_CHARGE_PENCE cannot be more than RENTAL_MAX_RENT_PENCE");
  return cfg;
}

// The cut-off in milliseconds. A test override in minutes wins when set.
function cutoffMs(cfg) {
  const p = cfg.pricing;
  return (p.cutoffMinutesOverride ? p.cutoffMinutesOverride * 60 : p.cutoffHours * 3600) * 1000;
}

// Reasons the system must not take payment or run. An empty list means it is safe to start.
// Called at the start of every request, so a missing variable fails closed instead of half working.
function configProblems(cfg, env = process.env) {
  const problems = [];
  const s = cfg.stripe;
  if (!/^(sk|rk)_(test|live)_/.test(s.secretKey)) problems.push("STRIPE_SECRET_KEY is missing or not a Stripe secret or restricted key");
  if (/^(sk|rk)_live_/.test(s.secretKey) && !s.allowLive) problems.push("a live Stripe key is set but ALLOW_LIVE_PAYMENTS is not yes");
  if (!/^pk_(test|live)_/.test(s.publishableKey)) problems.push("STRIPE_PUBLISHABLE_KEY is missing");
  if (/^sk_|^rk_/.test(s.secretKey) && /^pk_/.test(s.publishableKey) && s.secretKey.includes("_live_") !== s.publishableKey.includes("_live_")) problems.push("Stripe test and live keys are mixed");
  if (!/^whsec_/.test(s.webhookSecret)) problems.push("STRIPE_WEBHOOK_SECRET is missing");
  if (!Object.keys(cfg.stations).length) problems.push("STATIONS is empty");
  if (!/^https:\/\//.test(cfg.siteUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.siteUrl)) problems.push("SITE_URL must be the https address of the site");
  if (String(env.STRIPE_FAKE || "").toLowerCase() === "yes" && cfg.hosted) problems.push("the fake Stripe is refused on the hosted site");
  if (cfg.supplier.mode === "fake") {
    if (cfg.hosted) problems.push("the fake supplier is refused on the hosted site");
  } else {
    if (!cfg.supplier.username || !cfg.supplier.password) problems.push("BAJIE_USERNAME or BAJIE_PASSWORD is missing");
    if (!AUTH_MODES.includes(cfg.supplier.authMode)) problems.push("BAJIE_AUTH_MODE must be basic_plain, basic_sha256 or token (the supplier has not confirmed which)");
    if (cfg.supplier.callbackSecretPath.length < 24) problems.push("BAJIE_CALLBACK_SECRET_PATH must be a random string of at least 24 characters");
  }
  if (cfg.store.mode === "memory") {
    if (cfg.hosted) problems.push("the in-memory store is refused on the hosted site");
  } else if (!cfg.store.supabaseUrl || !cfg.store.supabaseKey) problems.push("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing");
  return problems;
}

module.exports = { loadConfig, configProblems, cutoffMs, parseStations, AUTH_MODES };
