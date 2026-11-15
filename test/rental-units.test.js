"use strict";
// Unit tests for the pieces under the rental service: config, pricing, the Stripe and supplier clients,
// the stores, and the HTTP handlers. Fakes only: nothing here touches the real Stripe, Supabase or supplier.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { loadConfig, configProblems, parseStations, cutoffMs } = require("../lib/rental/config");
const pricing = require("../lib/rental/pricing");
const { verifyWebhook, signWebhook, encodeForm, createStripe } = require("../lib/rental/stripe");
const { createBajieSupplier, SupplierError, canRent, sha256hex } = require("../lib/rental/supplier");
const { parseSupplierTime } = require("../lib/rental/supplier-time");
const { createMemoryStore } = require("../lib/rental/store-memory");
const { createSupabaseStore } = require("../lib/rental/store-supabase");
const { rentApi, supplierCallbackApi, adminApi, stripeWebhookApi } = require("../lib/rental/http");
const { renderAdmin } = require("../lib/rental/admin-html");
const { setup, ENV } = require("./rental-helpers");
const { S } = require("../lib/rental/states");

// ---- config -----------------------------------------------------------------------------------------------------
test("config defaults are the spec's numbers, all in pence", () => {
  const c = loadConfig({});
  assert.deepEqual(c.pricing, { pricePerHourPence: 300, firstChargePence: 300, maxRentPence: 2000, nonReturnFeePence: 2000, cutoffHours: 12, cutoffMinutesOverride: 0 });
  assert.equal(cutoffMs(c), 12 * 3600e3);
  assert.equal(c.currency, "gbp");
  assert.equal(pricing.maxTotalPence(c.pricing), 4000);
});

test("every pricing number can be changed in config, and bad values are refused", () => {
  const c = loadConfig({ RENTAL_PRICE_PER_HOUR_PENCE: "250", RENTAL_FIRST_CHARGE_PENCE: "250", RENTAL_MAX_RENT_PENCE: "1500", RENTAL_NON_RETURN_FEE_PENCE: "1000", RENTAL_CUTOFF_HOURS: "6" });
  assert.equal(pricing.returnSettlement(5 * 3600e3, 250, c.pricing).rentPence, 1250);
  assert.equal(pricing.cutoffSettlement(cutoffMs(c), 250, c.pricing).duePence, 1250 + 1000, "cap 15.00 less 2.50 paid, plus 10.00 fee");
  assert.throws(() => loadConfig({ RENTAL_MAX_RENT_PENCE: "abc" }), /whole number/);
  assert.throws(() => loadConfig({ RENTAL_CUTOFF_HOURS: "0" }), /between/);
  assert.throws(() => loadConfig({ RENTAL_FIRST_CHARGE_PENCE: "5000" }), /cannot be more/);
});

test("STATIONS accepts a list or JSON, normalises codes and rejects junk", () => {
  assert.deepEqual(Object.keys(parseStations("aj1=DTA59552, lb2=DTA1")), ["AJ1", "LB2"]);
  assert.equal(parseStations('{"AJ1":{"deviceId":"DTA59552","name":"Al Jawhara"}}').AJ1.name, "Al Jawhara");
  assert.throws(() => parseStations("AJ1"), /AJ1=DEVICEID/);
  assert.throws(() => parseStations("A J=x"), /Station code/);
  assert.throws(() => parseStations("AJ1=bad id!"), /deviceId/);
  assert.deepEqual(parseStations(""), {});
});

test("config fails closed: every missing or unsafe setting is named", () => {
  assert.deepEqual(configProblems(loadConfig(ENV)), []);
  const none = configProblems(loadConfig({})).join("|");
  for (const word of ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STATIONS", "SITE_URL", "BAJIE_USERNAME", "BAJIE_AUTH_MODE", "BAJIE_CALLBACK_SECRET_PATH", "SUPABASE_URL"]) assert.match(none, new RegExp(word));
  assert.match(configProblems(loadConfig({ ...ENV, STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_PUBLISHABLE_KEY: "pk_live_abc" })).join(), /ALLOW_LIVE_PAYMENTS/);
  assert.deepEqual(configProblems(loadConfig({ ...ENV, STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_PUBLISHABLE_KEY: "pk_live_abc", ALLOW_LIVE_PAYMENTS: "yes" })), []);
  assert.match(configProblems(loadConfig({ ...ENV, STRIPE_SECRET_KEY: "rk_live_abc", ALLOW_LIVE_PAYMENTS: "yes" })).join(), /mixed/);
  assert.match(configProblems(loadConfig({ ...ENV, STRIPE_WEBHOOK_SECRET: "nope" })).join(), /WEBHOOK/);
  assert.match(configProblems(loadConfig({ ...ENV, SITE_URL: "http://example.com" })).join(), /SITE_URL/);
});

test("the supplier login style must be chosen explicitly, never defaulted", () => {
  const real = { ...ENV, SUPPLIER_MODE: "bajie", RENTAL_STORE: "supabase", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", BAJIE_USERNAME: "u", BAJIE_PASSWORD: "p", BAJIE_CALLBACK_SECRET_PATH: "x".repeat(30) };
  assert.match(configProblems(loadConfig(real)).join(), /BAJIE_AUTH_MODE/);
  assert.deepEqual(configProblems(loadConfig({ ...real, BAJIE_AUTH_MODE: "basic_sha256" })), []);
  assert.match(configProblems(loadConfig({ ...real, BAJIE_AUTH_MODE: "basic_sha256", BAJIE_CALLBACK_SECRET_PATH: "short" })).join(), /at least 24/);
  assert.match(configProblems(loadConfig({ ...real, BAJIE_AUTH_MODE: "magic" })).join(), /BAJIE_AUTH_MODE/);
});

test("fakes are refused anywhere hosted (Netlify, previews, Lambda), whatever else is set", () => {
  for (const host of [{ CONTEXT: "production" }, { CONTEXT: "deploy-preview" }, { NETLIFY: "true" }, { AWS_LAMBDA_FUNCTION_NAME: "x" }]) {
    const problems = configProblems(loadConfig({ ...ENV, ...host, STRIPE_FAKE: "yes" }), { ...ENV, ...host, STRIPE_FAKE: "yes" }).join("|");
    assert.match(problems, /fake supplier/);
    assert.match(problems, /in-memory store/);
    assert.match(problems, /fake Stripe/);
  }
});

// ---- pricing ----------------------------------------------------------------------------------------------------
test("pricing: started hours, caps and the spec's worked examples", () => {
  const p = loadConfig({}).pricing, M = 60e3, H = 3600e3;
  assert.equal(pricing.startedHours(0), 1);
  assert.equal(pricing.startedHours(60 * M), 1);
  assert.equal(pricing.startedHours(60 * M + 1), 2);
  assert.equal(pricing.rentFor(40 * M, p), 300);
  assert.equal(pricing.rentFor(130 * M, p), 900);
  assert.equal(pricing.rentFor(9 * H, p), 2000);
  assert.equal(pricing.rentFor(7 * H, p), 2000, "the cap is reached at hour 7");
  assert.equal(pricing.rentFor(6 * H, p), 1800);
  assert.deepEqual(pricing.returnSettlement(40 * M, 300, p), { rentPence: 300, duePence: 0 });
  assert.deepEqual(pricing.returnSettlement(130 * M, 300, p), { rentPence: 900, duePence: 600 });
  assert.deepEqual(pricing.returnSettlement(9 * H, 300, p), { rentPence: 2000, duePence: 1700 });
  assert.deepEqual(pricing.cutoffSettlement(12 * H, 300, p), { rentPence: 2000, feePence: 2000, duePence: 3700 });
  assert.equal(pricing.money(3700), "£37.00");
});

// ---- Stripe client ----------------------------------------------------------------------------------------------
test("webhook signature: right secret and body pass, everything else is refused", () => {
  const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
  const now = Date.now();
  const header = signWebhook(body, "whsec_a", now);
  assert.equal(verifyWebhook(body, header, "whsec_a", { nowMs: now }).id, "evt_1");
  const refuse = (b, h, secret = "whsec_a", opts = {}) => assert.throws(() => verifyWebhook(b, h, secret, { nowMs: now, ...opts }), (e) => e.kind === "signature");
  refuse(body, header, "whsec_b");
  refuse(body + " ", header);
  refuse(body, "");
  refuse(body, "garbage");
  refuse(body, header.replace(/v1=(.)/, (m, c) => "v1=" + (c === "0" ? "1" : "0"))); // always a real change
  refuse(body, header, "whsec_a", { nowMs: now + 6 * 60 * 1000 });
  refuse(body, header, "whsec_a", { toleranceSeconds: 0 });
  refuse(body, header, "");
  // Several v1 entries (a rolled secret) and extra debug entries are fine, as long as one v1 matches.
  const t = header.match(/t=(\d+)/)[1];
  assert.ok(verifyWebhook(body, `${header},v1=${"0".repeat(64)},v0=abc,secret=whsec_****,destination=we_1,payload=a25aefc6`, "whsec_a", { nowMs: now }));
  assert.throws(() => verifyWebhook(body, `t=${t},v0=${crypto.createHmac("sha256", "whsec_a").update(`${t}.${body}`).digest("hex")}`, "whsec_a", { nowMs: now }), (e) => e.kind === "signature", "a v0 signature is not accepted");
});

test("Stripe client: form encoding, keys and idempotency headers", async () => {
  assert.equal(encodeForm({ a: 1, m: { k: "x y" }, l: ["card"], skip: undefined, no: null }).join("&"), "a=1&m%5Bk%5D=x%20y&l%5B0%5D=card");
  assert.throws(() => createStripe({ secretKey: "pk_test_x" }), /secret or restricted/);
  const seen = [];
  const stripe = createStripe({ secretKey: "rk_test_abc", fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => '{"id":"pi_1","status":"succeeded"}' }; } });
  assert.equal(stripe.mode, "test");
  assert.equal(createStripe({ secretKey: "sk_live_abc", fetchImpl: async () => {} }).mode, "live");
  await stripe.createFirstPayment({ amount: 300, currency: "gbp", customer: "cus_1", rentalId: "r1", email: "a@b.co", description: "d" });
  const { url, init } = seen[0];
  assert.equal(url, "https://api.stripe.com/v1/payment_intents");
  assert.equal(init.headers.Authorization, "Bearer rk_test_abc");
  assert.equal(init.headers["Idempotency-Key"], "first-r1");
  assert.match(init.body, /setup_future_usage=off_session/);
  assert.match(init.body, /payment_method_types%5B0%5D=card/);
  assert.match(init.body, /metadata%5Bkind%5D=first_hour/);
});

// ---- supplier client --------------------------------------------------------------------------------------------
function fakeSupplierHttp(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body };
    calls.push(call);
    const out = await handler(call);
    return { ok: (out.status || 200) < 400, status: out.status || 200, text: async () => (typeof out.body === "string" ? out.body : JSON.stringify(out.body)) };
  };
  return { fetchImpl, calls };
}
const base = { baseUrl: "https://developer.chargenow.top/cdb-open-api/v1", username: "user", password: "pa ss" };

test("supplier auth: plain and hashed Basic, and token login with one automatic re-login", async () => {
  const plain = fakeSupplierHttp(() => ({ body: { code: 0, msg: "ok", data: {} } }));
  await createBajieSupplier({ ...base, authMode: "basic_plain", fetchImpl: plain.fetchImpl }).closeOrder("T1");
  assert.equal(plain.calls[0].headers.Authorization, "Basic " + Buffer.from("user:pa ss").toString("base64"));

  const hashed = fakeSupplierHttp(() => ({ body: { code: 0, data: {} } }));
  await createBajieSupplier({ ...base, authMode: "basic_sha256", fetchImpl: hashed.fetchImpl }).closeOrder("T1");
  assert.equal(hashed.calls[0].headers.Authorization, "Basic " + Buffer.from("user:" + sha256hex("pa ss")).toString("base64"));
  assert.equal(sha256hex("pa ss").length, 64);

  let logins = 0;
  const tok = fakeSupplierHttp((c) => {
    if (c.path.endsWith("/oauth2/login")) { logins++; return { body: { code: 0, msg: "ok", token: `tok${logins}` } }; }
    if (c.headers.Authorization === "Bearer tok1" && logins === 1 && c.path.endsWith("/close") && tok.calls.filter((x) => x.path.endsWith("/close")).length === 2) return { status: 401, body: "{}" };
    return { body: { code: 0, data: {} } };
  });
  const sup = createBajieSupplier({ ...base, authMode: "token", fetchImpl: tok.fetchImpl });
  await sup.closeOrder("T1");
  const login = tok.calls[0];
  assert.equal(login.method, "POST");
  assert.equal(login.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(login.body, `username=user&password=${sha256hex("pa ss")}`);
  assert.equal(tok.calls[1].headers.Authorization, "Bearer tok1");
  await sup.closeOrder("T2"); // gets a 401, logs in again once, and succeeds
  assert.equal(logins, 2);
  assert.throws(() => createBajieSupplier({ ...base, authMode: "", fetchImpl: plain.fetchImpl }), /BAJIE_AUTH_MODE/);
});

test("supplier calls: paths, parameters, and what counts as a definite failure", async () => {
  const http = fakeSupplierHttp((c) => {
    if (c.path.endsWith("/rent/cabinet/query")) return { body: { code: 0, data: { cabinet: { id: 1, slots: 8, isOnline: true }, batteries: [{ slotNum: 1, batteryId: "B1", vol: 80 }, { slotNum: 2, batteryId: "B2", vol: 10 }], shop: {} } } };
    if (c.path.endsWith("/rent/order/create")) return { body: { code: 0, data: { tradeNo: "T123" } } };
    if (c.path.endsWith("/rent/order/detail")) return { body: { code: 0, data: { orderId: "T123", borrowTime: "2026-11-20 10:00:00", returnTime: "", borrowStatus: 1, paymentStatus: 0, secretNoise: "x" } } };
    return { body: { code: 0, data: null } };
  });
  const sup = createBajieSupplier({ ...base, authMode: "basic_plain", fetchImpl: http.fetchImpl });
  const cab = await sup.checkCabinet("DTA59552");
  assert.deepEqual(http.calls[0].query, { deviceId: "DTA59552" });
  assert.equal(cab.online, true);
  assert.equal(canRent(cab, 30), true);
  assert.equal(canRent(cab, 90), false);
  assert.equal(canRent({ ...cab, online: false }, 30), false);

  const order = await sup.createOrder("DTA59552", "https://procuracharge.com/api/bajie/callback/s/r?x=1&y=2");
  assert.equal(order.tradeNo, "T123");
  const create = http.calls[1];
  assert.equal(create.method, "POST");
  assert.deepEqual(create.query, { deviceId: "DTA59552", callbackURL: "https://procuracharge.com/api/bajie/callback/s/r?x=1&y=2" }, "both parameters travel in the query string and survive encoding");

  const d = await sup.getOrderDetail("T123");
  assert.equal(d.borrowTime, Date.UTC(2026, 10, 20, 10, 0, 0));
  assert.equal(d.returnTime, null, "an empty returnTime means not returned");
  assert.equal(d.detail.secretNoise, undefined, "only known fields are kept");
  await assert.rejects(sup.getOrderDetail("../etc/passwd"), /bad order number/);

  const err = async (out) => {
    const s = createBajieSupplier({ ...base, authMode: "basic_plain", fetchImpl: fakeSupplierHttp(() => out).fetchImpl });
    try { await s.createOrder("D", "https://x"); } catch (e) { return e; }
  };
  const refused = await err({ body: { code: 5, msg: "cabinet offline" } });
  assert.ok(refused instanceof SupplierError && refused.definitive && refused.kind === "api");
  assert.equal((await err({ status: 400, body: "{}" })).definitive, true);
  assert.equal((await err({ status: 502, body: "bad gateway" })).definitive, false, "a server error leaves it unknown");
  assert.equal((await err({ body: "<html>" })).kind, "shape");
  assert.equal((await err({ body: { code: 0, data: {} } })).kind, "shape", "no order number is not a success");
  const timeout = createBajieSupplier({ ...base, authMode: "basic_plain", timeoutMs: 20, fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
  const t = await timeout.createOrder("D", "https://x").catch((e) => e);
  assert.equal(t.kind, "network");
  assert.equal(t.definitive, false);
});

test("supplier times: epoch, ISO and wall-clock formats", () => {
  assert.equal(parseSupplierTime(1789000000), 1789000000000);
  assert.equal(parseSupplierTime("1789000000000"), 1789000000000);
  assert.equal(parseSupplierTime("2026-11-13T10:00:00Z"), Date.UTC(2026, 10, 13, 10));
  assert.equal(parseSupplierTime("2026-11-13 10:00:00+01:00"), Date.UTC(2026, 10, 13, 9));
  assert.equal(parseSupplierTime("2026-11-13 10:00:00", "UTC"), Date.UTC(2026, 10, 13, 10));
  assert.equal(parseSupplierTime("2026-07-01 10:00:00", "Europe/London"), Date.UTC(2026, 6, 1, 9), "summer time is read as London time");
  assert.equal(parseSupplierTime("2026-12-01 10:00:00", "Europe/London"), Date.UTC(2026, 11, 1, 10));
  assert.equal(parseSupplierTime("2026/11/13 10:00:00"), Date.UTC(2026, 10, 13, 10), "slashes, as many supplier systems write dates");
  assert.equal(parseSupplierTime("2026/1/5 9:07:03"), Date.UTC(2026, 0, 5, 9, 7, 3), "single-digit month, day and hour");
  for (const empty of [null, undefined, "", 0, "0", "not a date", 12345]) assert.equal(parseSupplierTime(empty), null);
});

// ---- stores -------------------------------------------------------------------------------------------------------
// A tiny stand-in for Supabase's REST interface: enough of PostgREST's filters to run the store against.
function fakePostgrest() {
  const tables = { rentals: new Map(), stripe_events: new Map() };
  const unique = { rentals: ["id", "stripe_payment_intent_id", "trade_no"], stripe_events: ["id"] };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const table = u.pathname.replace("/rest/v1/", "");
    const rows = tables[table];
    const method = init.method || "GET";
    calls.push({ method, table, query: u.search, headers: init.headers });
    if (!init.headers.apikey || init.headers.Authorization !== `Bearer ${init.headers.apikey}`) return { ok: false, status: 401, text: async () => "{}" };
    const match = (row) => [...u.searchParams].every(([k, v]) => {
      if (["select", "order", "limit"].includes(k)) return true;
      const [op, ...rest] = v.split("."); const val = rest.join(".");
      const have = row[k] === undefined ? null : row[k];
      if (op === "eq") return String(have) === val;
      if (op === "is") return have === null;
      if (op === "in") return val.slice(1, -1).split(",").map(decodeURIComponent).includes(String(have));
      if (op === "gte") return Date.parse(have) >= Date.parse(val);
      throw new Error("unsupported filter " + k + "=" + v);
    });
    const reply = (status, json) => ({ ok: status < 300, status, text: async () => (json === undefined ? "" : JSON.stringify(json)) });
    if (method === "POST") {
      const row = JSON.parse(init.body);
      for (const col of unique[table]) if (row[col] != null && [...rows.values()].some((r) => r[col] === row[col])) return reply(409, { code: "23505" });
      rows.set(row.id, row); return reply(201, init.headers.Prefer.includes("representation") ? [row] : undefined);
    }
    if (method === "PATCH") {
      const hit = [...rows.values()].filter(match);
      hit.forEach((r) => Object.assign(r, JSON.parse(init.body)));
      return reply(200, init.headers.Prefer.includes("representation") ? hit : undefined);
    }
    if (method === "DELETE") { [...rows.values()].filter(match).forEach((r) => rows.delete(r.id)); return reply(204); }
    let out = [...rows.values()].filter(match);
    if (u.searchParams.get("order") === "created_at.desc") out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (u.searchParams.get("limit")) out = out.slice(0, Number(u.searchParams.get("limit")));
    return reply(200, out);
  };
  return { fetchImpl, calls, tables };
}

for (const [name, make] of [
  ["memory", () => createMemoryStore()],
  ["supabase (against a stand-in for its REST interface)", () => createSupabaseStore({ url: "https://x.supabase.co", key: "service-key", fetchImpl: fakePostgrest().fetchImpl })],
]) {
  test(`store contract: ${name}`, async () => {
    const store = make();
    const row = (id, extra = {}) => ({ id, status: "created", created_at: new Date(Date.now() - 1000).toISOString(), flags: [], history: [], ...extra });
    await store.insert(row("a", { stripe_payment_intent_id: "pi_1" }));
    await assert.rejects(store.insert(row("b", { stripe_payment_intent_id: "pi_1" })), (e) => e.code === "conflict");
    assert.equal((await store.get("a")).status, "created");
    assert.equal(await store.get("zzz"), null);
    assert.equal((await store.findByPaymentIntent("pi_1")).id, "a");
    // Compare-and-set: the second caller loses.
    assert.equal((await store.update("a", { status: "paid", trade_no: "T1" }, { status: "created" })).status, "paid");
    assert.equal(await store.update("a", { status: "other" }, { status: "created" }), null);
    assert.equal((await store.get("a")).status, "paid");
    assert.equal((await store.findByTradeNo("T1")).id, "a");
    assert.equal((await store.update("a", { last_error: "x" }, { status: ["paid", "active"], supplier_closed_at: null })).last_error, "x");
    assert.equal(await store.update("a", { last_error: "y" }, { status: ["active"] }), null);
    await store.insert(row("c", { status: "active", created_at: new Date(Date.now() - 5000).toISOString() }));
    assert.deepEqual((await store.list({ statuses: ["paid", "active"] })).map((r) => r.id), ["a", "c"]);
    assert.deepEqual((await store.list({ statuses: ["active"] })).map((r) => r.id), ["c"]);
    assert.equal((await store.list({ since: new Date(Date.now() - 2000).toISOString() })).length, 1);
    assert.equal((await store.list({ limit: 1 })).length, 1);
    // Webhook idempotency.
    assert.equal(await store.claimEvent("evt_1", "t"), "new");
    assert.equal(await store.claimEvent("evt_1", "t"), "busy");
    await store.finishEvent("evt_1");
    assert.equal(await store.claimEvent("evt_1", "t"), "done");
    assert.equal(await store.claimEvent("evt_2", "t"), "new");
    await store.abandonEvent("evt_2");
    assert.equal(await store.claimEvent("evt_2", "t"), "new", "an abandoned event can be taken again");
  });
}

test("Supabase store: sends the service key, escapes filters, and refuses unsafe ones", async () => {
  const pg = fakePostgrest();
  const store = createSupabaseStore({ url: "https://x.supabase.co/", key: "service-key", fetchImpl: pg.fetchImpl });
  await store.get("a");
  assert.equal(pg.calls[0].headers.apikey, "service-key");
  assert.equal(pg.calls[0].headers.Authorization, "Bearer service-key");
  assert.equal(pg.calls[0].query, "?id=eq.a&select=*");
  await assert.rejects(store.get("a&status=eq.paid"), /unsafe/);
  await assert.rejects(store.update("a", {}, { "status; drop": "x" }), /unsafe/);
  assert.throws(() => createSupabaseStore({ url: "", key: "" }), /required/);
  const broken = createSupabaseStore({ url: "https://x.supabase.co", key: "k", fetchImpl: async () => ({ ok: false, status: 500, text: async () => "{}" }) });
  await assert.rejects(broken.get("a"), (e) => e.code === "store_error");
});

// ---- HTTP handlers ------------------------------------------------------------------------------------------------
function runtimeFor(h, over = {}) {
  return { ready: true, problems: [], config: h.config, service: h.service, log: () => {}, fakeStripe: null, ...over };
}

test("the HTTP layer answers 'not configured' instead of half working", async () => {
  const rt = { ready: false, problems: ["x"], log: () => {} };
  assert.equal((await rentApi(rt, { method: "GET", action: "station", query: { station: "AJ1" } })).status, 503);
  assert.equal((await stripeWebhookApi(rt, { method: "POST", rawBody: "{}", headers: {} })).status, 503);
  assert.equal((await supplierCallbackApi(rt, { method: "POST", secret: "x" })).status, 404);
});

test("rent API: methods, routing and rate limits", async () => {
  const h = setup();
  const rt = runtimeFor(h);
  assert.equal((await rentApi(rt, { method: "GET", action: "station", query: { station: "AJ1" } })).status, 200);
  assert.equal((await rentApi(rt, { method: "POST", action: "station" })).status, 405);
  assert.equal((await rentApi(rt, { method: "GET", action: "start" })).status, 405);
  assert.equal((await rentApi(rt, { method: "GET", action: "nothing" })).status, 404);
  const res = await rentApi(rt, { method: "GET", action: "station", query: { station: "AJ1" } });
  assert.equal(res.headers["Cache-Control"], "no-store");
  let last;
  for (let i = 0; i < 310; i++) last = await rentApi(rt, { method: "GET", action: "station", query: { station: "AJ1" }, ip: "9.9.9.9" });
  assert.equal(last.status, 429);
  const start = await rentApi(rt, { method: "POST", action: "start", body: { station: "AJ1", email: "a@b.co", consent: true, consentVersion: h.version }, ip: "1.1.1.1" });
  assert.equal(start.status, 200);
  assert.equal(JSON.parse(start.body).ok, true);
});

test("supplier callback: only the secret path gets in, and it answers with the configured acknowledgement", async () => {
  const h = setup({ BAJIE_CALLBACK_SECRET_PATH: "s".repeat(30), BAJIE_CALLBACK_ACK: "OK" });
  const rt = runtimeFor(h);
  const call = (secret, extra = {}) => supplierCallbackApi(rt, { method: "POST", secret, rentalId: "00000000-0000-0000-0000-000000000000", rawBody: "{}", ...extra });
  assert.equal((await call("wrong")).status, 404);
  assert.equal((await call("")).status, 404);
  assert.equal((await call(undefined)).status, 404);
  const ok = await call("s".repeat(30));
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "OK");
  assert.equal((await call("s".repeat(30), { method: "DELETE" })).status, 405);
  assert.equal((await supplierCallbackApi({ ...rt, config: { ...h.config, supplier: { ...h.config.supplier, callbackSecretPath: "" } } }, { method: "POST", secret: "" })).status, 404, "no secret configured means closed");
});

test("admin: password protected, switched off without a strong password, and everything is escaped", async () => {
  const h = setup({ ADMIN_PASSWORD: "a-long-enough-password" });
  const rt = runtimeFor(h);
  const auth = (user, pass) => ({ authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") });
  const get = (headers, ip) => adminApi(rt, { method: "GET", headers, ip, render: renderAdmin });
  assert.equal((await get({}, "a1")).status, 401);
  assert.match((await get({}, "a2")).headers["WWW-Authenticate"], /Basic/);
  assert.equal((await get(auth("admin", "wrong-password-here"), "a3")).status, 401);
  assert.equal((await get(auth("root", "a-long-enough-password"), "a4")).status, 401);
  assert.equal((await get({ authorization: "Bearer a-long-enough-password" }, "a5")).status, 401);

  // A rental whose fields contain markup must not become markup.
  await h.store.insert({ id: "11111111-1111-1111-1111-111111111111", created_at: new Date(h.clock.t).toISOString(), station: "AJ1", device_id: "d", status: S.PAYMENT_FAILED, email: '<script>alert(1)</script>@x.co', paid_pence: 300, due_pence: 600, last_error: '"><img src=x onerror=alert(1)>', flags: [], history: [], stripe_payment_intent_id: "pi_abc123" });
  const ok = await get(auth("admin", "a-long-enough-password"), "a6");
  assert.equal(ok.status, 200);
  assert.ok(!ok.body.includes("<script>alert(1)"));
  assert.ok(!ok.body.includes("<img src=x"));
  assert.match(ok.body, /&lt;script&gt;/);
  assert.match(ok.body, /dashboard\.stripe\.com\/test\/payments\/pi_abc123/);
  assert.match(ok.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.equal(ok.headers["X-Robots-Tag"], "noindex, nofollow");
  assert.equal(ok.headers["Cache-Control"], "no-store");

  for (const weak of ["", "short"]) {
    const off = await adminApi({ ...rt, config: { ...h.config, admin: { username: "admin", password: weak } } }, { method: "GET", headers: auth("admin", weak), ip: "z", render: renderAdmin });
    assert.equal(off.status, 503);
  }
  let limited;
  for (let i = 0; i < 35; i++) limited = await get(auth("admin", "nope-nope-nope-nope"), "brute");
  assert.equal(limited.status, 429);
});

// ---- the database matches the code --------------------------------------------------------------------------------
test("every column the service writes exists in the SQL migration (a fake store would never notice a missing one)", async () => {
  const fs = require("node:fs");
  const sql = fs.readFileSync(require("node:path").join(__dirname, "..", "supabase", "migrations", "0001_rentals.sql"), "utf8");
  const table = sql.match(/create table if not exists public\.rentals \(([\s\S]*?)\n\);/)[1];
  const columns = new Set(table.split("\n").map((l) => (l.match(/^\s{2}([a-z_]+)\s+[a-z]/) || [])[1]).filter(Boolean));
  assert.ok(columns.size > 30);

  const { HOUR, MIN } = require("./rental-helpers");
  const used = new Set();
  const note = (row) => Object.keys(row).forEach((k) => used.add(k));
  const run = async (scenario) => {
    const h = setup();
    const realInsert = h.store.insert, realUpdate = h.store.update;
    h.store.insert = async (row) => { note(row); return realInsert.call(h.store, row); };
    h.store.update = async (id, patch, expect) => { note(patch); Object.keys(expect || {}).forEach((k) => used.add(k)); return realUpdate.call(h.store, id, patch, expect); };
    await scenario(h);
  };
  await run(async (h) => { const r = await h.rentUntilActive(); h.advance(2 * HOUR); h.supplier.simulateReturn(r.row.trade_no, h.clock.t); await h.service.pollActive(await h.store.get(r.rentalId)); });
  await run(async (h) => { const r = await h.rentUntilActive(); h.advance(13 * HOUR); await h.service.pollActive(await h.store.get(r.rentalId)); });
  await run(async (h) => { h.supplier.control.neverRelease = true; const s = await h.start(); const row = await h.store.get(s.json.rentalId); await h.pay(row.stripe_payment_intent_id); h.advance(61 * 1000); await h.service.runJobs(); });
  await run(async (h) => { h.fakeStripe.controls.decline = "insufficient_funds"; const r = await h.rentUntilActive(); h.advance(2 * HOUR); h.supplier.simulateReturn(r.row.trade_no, h.clock.t); await h.service.pollActive(await h.store.get(r.rentalId)); h.advance(61 * MIN); await h.service.runJobs(); });
  await run(async (h) => { const s = await h.start(); h.advance(31 * MIN); await h.service.runJobs(); });
  await run(async (h) => { const r = await h.rentUntilActive(); await h.service.handleSupplierHint(r.rentalId, "x"); await h.store.update(r.rentalId, { stripe_payment_method_id: null }); h.supplier.control.closeFails = true; h.advance(2 * HOUR); h.supplier.simulateReturn(r.row.trade_no, h.clock.t); await h.service.pollActive(await h.store.get(r.rentalId)); });
  const missing = [...used].filter((k) => !columns.has(k));
  assert.deepEqual(missing, [], `columns used by the code but not in the migration: ${missing.join(", ")}`);
});

test("Supabase store: the take-over of an abandoned webhook event works with a real timestamp (it has a + in it)", async () => {
  const pg = fakePostgrest();
  let t = Date.parse("2026-11-20T10:00:00Z");
  const store = createSupabaseStore({ url: "https://x.supabase.co", key: "k", fetchImpl: pg.fetchImpl, now: () => new Date(t) });
  assert.equal(await store.claimEvent("evt_1", "x"), "new");
  pg.tables.stripe_events.get("evt_1").created_at = "2026-11-20T10:00:00.123456+00:00"; // how Postgres writes it back
  assert.equal(await store.claimEvent("evt_1", "x"), "busy");
  t += 6 * 60 * 1000;
  assert.equal(await store.claimEvent("evt_1", "x"), "new", "taken over after the lease ran out");
});

test("setup check: names what is missing without ever showing a value", async () => {
  const { loadConfig, configProblems } = require("../lib/rental/config");
  const env = { STRIPE_SECRET_KEY: "rk_test_SECRETVALUE123", STRIPE_PUBLISHABLE_KEY: "pk_test_x", BAJIE_PASSWORD: "hunter2-secret", BAJIE_USERNAME: "u", SUPABASE_SERVICE_ROLE_KEY: "eyJsecret" };
  const config = loadConfig(env);
  const rt = { ready: false, problems: configProblems(config, env), log: () => {} };
  const out = await rentApi(rt, { method: "GET", action: "health", ip: "h1" });
  assert.equal(out.status, 200);
  const j = JSON.parse(out.body);
  assert.equal(j.ready, false);
  assert.ok(j.problems.some((p) => /STRIPE_WEBHOOK_SECRET/.test(p)));
  assert.ok(j.problems.some((p) => /SITE_URL/.test(p)));
  for (const secret of Object.values(env)) if (secret.length > 3) assert.ok(!out.body.includes(secret), "no value leaks");
  const h = setup();
  const ready = await rentApi(runtimeFor(h), { method: "GET", action: "health", ip: "h2" });
  assert.deepEqual(JSON.parse(ready.body), { ok: true, ready: true, problems: [] });
});

test("setup check with a station: shows what the supplier said about the machine, without its device id", async () => {
  const h = setup();
  const rt = runtimeFor(h);
  const out = JSON.parse((await rentApi(rt, { method: "GET", action: "health", query: { station: "aj1" }, ip: "h3" })).body);
  assert.equal(out.ready, true);
  assert.equal(out.machine.station, "AJ1");
  assert.equal(out.machine.reachable, true);
  assert.equal(out.machine.online, true);
  assert.equal(out.machine.canRent, true);
  h.supplier.setOnline("DTA59552", false);
  const off = JSON.parse((await rentApi(rt, { method: "GET", action: "health", query: { station: "AJ1" }, ip: "h4" })).body);
  assert.equal(off.machine.online, false);
  h.supplier.control.down = true;
  const down = JSON.parse((await rentApi(rt, { method: "GET", action: "health", query: { station: "AJ1" }, ip: "h5" })).body);
  assert.equal(down.machine.reachable, false);
  assert.equal(down.machine.error.kind, "network");
  const unknown = JSON.parse((await rentApi(rt, { method: "GET", action: "health", query: { station: "ZZ" }, ip: "h6" })).body);
  assert.equal(unknown.machine.known, false);
  for (const o of [out, off, down]) assert.ok(!JSON.stringify(o).includes("DTA59552"));
});

test("setup check with &orders=1: shows whether the account may use the order calls, without releasing anything", async () => {
  const h = setup();
  const rt = runtimeFor(h);
  const ask = async (ip) => JSON.parse((await rentApi(rt, { method: "GET", action: "health", query: { station: "AJ1", orders: "1" }, ip })).body).machine.orderAccess;
  // The fake answers "order not found" for a number it never issued: that is the supplier saying the call is allowed.
  const ok = await ask("o1");
  assert.equal(ok.allAnswered, true);
  assert.equal(ok.detail.refused, false);
  assert.ok(!h.supplier.log.some((l) => l[0] === "createOrder"), "never creates an order");
  // A permission refusal (as the supplier said the account had at first) shows up as refused.
  const real = h.supplier.getOrderDetail;
  h.supplier.getOrderDetail = async () => { throw Object.assign(new Error("supplier refused: no permission for this interface"), { kind: "api", code: 403 }); };
  const blocked = await ask("o2");
  assert.equal(blocked.detail.refused, true);
  assert.equal(blocked.detail.answered, false);
  assert.equal(blocked.allAnswered, false);
  h.supplier.getOrderDetail = real;
  // Without &orders=1 the order calls are left alone.
  const plain = JSON.parse((await rentApi(rt, { method: "GET", action: "health", query: { station: "AJ1" }, ip: "o3" })).body).machine;
  assert.equal(plain.orderAccess, undefined);
});

test("supplier client reports the shape of the cabinet reply, with no identifiers", async () => {
  const http = fakeSupplierHttp(() => ({ body: { code: 0, data: { cabinet: { id: 77, qrCode: "SECRETQR", isOnline: false, offlineCause: "network", signal: 12, slots: 8 }, batteries: [{ slotNum: 1, batteryId: "B1", vol: 90 }], shop: { name: "x" } } } }));
  const cab = await createBajieSupplier({ ...base, authMode: "basic_plain", fetchImpl: http.fetchImpl }).checkCabinet("D1");
  assert.deepEqual(cab.shape.dataKeys, ["cabinet", "batteries", "shop"]);
  assert.equal(cab.shape.isOnline, false);
  assert.equal(cab.shape.offlineCause, "network");
  assert.deepEqual(cab.shape.vols, [90]);
  assert.ok(!JSON.stringify(cab.shape).includes("SECRETQR"), "the QR content is not echoed");
});

test("the machine counts as online whichever field the supplier uses (the live API sends 'online', the docs say 'isOnline')", async () => {
  const cabinetWith = async (cabinet) => {
    const http = fakeSupplierHttp(() => ({ body: { code: 0, data: { cabinet, batteries: [{ slotNum: 1, batteryId: "B1", vol: 100 }] } } }));
    return createBajieSupplier({ ...base, authMode: "basic_plain", fetchImpl: http.fetchImpl }).checkCabinet("D1");
  };
  for (const yes of [{ online: true }, { online: 1 }, { online: "1" }, { online: "true" }, { online: "online" }, { isOnline: true }, { isOnline: true, online: false }]) {
    assert.equal((await cabinetWith(yes)).online, true, JSON.stringify(yes));
  }
  for (const no of [{ online: false }, { online: 0 }, { online: "offline" }, {}, { isOnline: false, online: true }, { posOnlineStatus: "online" }]) {
    assert.equal((await cabinetWith(no)).online, false, JSON.stringify(no));
  }
});

test("an order reply laid out differently is reported with its field names", async () => {
  const http = fakeSupplierHttp((c) => (c.path.endsWith("/create") ? { body: { code: 0, data: { orderNo: "X1", orderId: 5 } } } : { body: { code: 0, data: { orderId: "T1", startTime: "2026-11-14 10:00:00" } } }));
  const sup = createBajieSupplier({ ...base, authMode: "basic_plain", fetchImpl: http.fetchImpl });
  const e = await sup.createOrder("D1", "https://x").catch((x) => x);
  assert.match(e.message, /fields: orderNo, orderId/);
  assert.equal(e.definitive, false, "still treated as unknown: never asked again, refunded by the 60 second rule");
  const d = await sup.getOrderDetail("T1");
  assert.deepEqual(d.detail._fields, ["orderId", "startTime"]);
  assert.equal(d.borrowTime, null);
  const html = renderAdmin({ attention: [], open: [{ id: "r1", created_at: new Date().toISOString(), station: "AJ1", status: "releasing", last_detail: d.detail, history: [], flags: [] }], failed: [], refunds: [], recent: [], stripeMode: "test" }, loadConfig({}));
  assert.match(html, /supplier order fields differ from the documentation: orderId, startTime/);
});
