"use strict";
// Drives the real rent page in a real browser against the real server, with the local fakes for Stripe and the
// machine (the same ones the automated tests use). The page loads a stand-in for Stripe.js, so this proves the page,
// the API, the webhook path and the scheduled job work together. It does not prove anything about real Stripe,
// Apple Pay, Google Pay or the real machine. Skipped when Playwright is not installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

let chromium = null;
try { ({ chromium } = require("playwright")); } catch (e) { /* skipped below */ }

const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const ENV = {
  ...process.env, PORT: String(PORT), STRIPE_FAKE: "yes", STRIPE_SECRET_KEY: "rk_test_fake", STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_test_fake", STATIONS: "AJ1=DTA59552", SITE_URL: BASE, SUPPLIER_MODE: "fake", RENTAL_STORE: "memory",
  ADMIN_PASSWORD: "local-test-password", RENTAL_POLL_INTERVAL_SECONDS: "10", DEV_JOBS_EVERY_MS: "60000", RENTAL_RELEASE_TIMEOUT_SECONDS: "10",
};
for (const k of ["CONTEXT", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT"]) delete ENV[k];

const post = (p) => fetch(BASE + p, { method: "POST" }).then((r) => r.json());
const get = (p, opts) => fetch(BASE + p, opts).then((r) => r.json());

test("the rent page works end to end in a browser", { skip: !chromium && "Playwright is not installed", timeout: 120000 }, async (t) => {
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  t.after(() => server.kill());
  for (let i = 0; i < 50 && !log.includes("running at"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(log, /Rental: ready/, log);

  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip("no browser available: " + e.message); return; }
  t.after(() => browser.close());
  const newPage = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    // Only this site is reachable in the test: fonts and CDN scripts are blocked so nothing waits on the network.
    await page.route("**/*", (route) => (new URL(route.request().url()).hostname === "localhost" ? route.continue() : route.abort()));
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    return { page, errors };
  };
  const rentals = async () => (await get("/__dev/rentals")).rentals;

  await t.test("an unknown station and an offline machine are shown plainly, with no payment form", async () => {
    const { page } = await newPage();
    await page.goto(`${BASE}/rent?station=ZZ9`);
    await page.waitForSelector('[data-state="unknown"]:not([hidden])');
    assert.equal(await page.locator("#rent-form").isHidden(), true);

    await post("/__dev/supplier/machine?deviceId=DTA59552&online=0");
    await page.goto(`${BASE}/rent?station=AJ1`);
    await page.waitForSelector('[data-state="unavailable"]:not([hidden])');
    assert.match(await page.locator('[data-state="unavailable"]').innerText(), /You have not been charged/);
    assert.equal(await page.locator("#rent-form").isHidden(), true);
    assert.equal((await rentals()).length, 0, "nothing was created");
    await post("/__dev/supplier/machine?deviceId=DTA59552&online=1");
  });

  await t.test("no email before paying, Apple Pay first, and the fee, cut-off and consent on the page", async () => {
    const { page, errors } = await newPage();
    await page.goto(`${BASE}/rent?station=AJ1`);
    await page.waitForSelector("#rent-form:not([hidden])");
    const text = await page.locator("#rent-form").innerText();
    assert.equal((await page.locator(".rent-price__now").textContent()).replace(/\s+/g, " ").trim(), "£3 per hour", "one big price, nothing else");
    assert.match(text, /£3\.00/);
    assert.match(text, /12 hours/);
    assert.match(text, /£20\.00 non-return fee/);
    assert.match(text, /£40\.00/);
    assert.equal(await page.locator("#rent-form input[type=email]").count(), 0, "nothing to type before paying");
    assert.equal(await page.locator('[data-test="card"]').getAttribute("data-order"), "apple_pay,google_pay,card", "Apple Pay comes first and is selected");
    assert.equal(await page.locator('[data-test="card"]').getAttribute("data-terms"), "never", "Stripe's duplicate future-payments paragraph is hidden; ours is on the page");
    assert.equal((await page.locator("#pay-button").textContent()).replace(/\s+/g, " ").trim(), "Pay £3 and get a power bank →", "the button says what is taken now");
    // The button switches on when Stripe's form says it is ready; the placeholder goes at the same moment.
    await page.waitForFunction(() => !document.getElementById("pay-button").disabled, null, { timeout: 5000 });
    assert.equal(await page.locator("[data-pay-skeleton]").isHidden(), true, "the placeholder goes once Stripe's form is ready");
    assert.deepEqual(errors, []);
  });

  await t.test("a declined card keeps the same rental, paying again releases the power bank, and a receipt can be asked for after", async () => {
    const { page, errors } = await newPage();
    await page.goto(`${BASE}/rent?station=AJ1`);
    await page.waitForSelector("#rent-form:not([hidden])");
    await page.fill('[data-test="card"]', "4000 0000 0000 9995");
    await page.click("#pay-button");
    await page.waitForSelector(".form-status.is-error");
    assert.match(await page.locator(".form-status").innerText(), /declined/i);
    assert.equal((await rentals()).filter((r) => r.status === "created").length, 1, "one unpaid rental");
    assert.equal((await rentals()).filter((r) => r.trade_no).length, 0, "nothing released for a declined card");

    await page.fill('[data-test="card"]', "4242 4242 4242 4242");
    await page.click("#pay-button");
    await page.waitForSelector('[data-state="active"]:not([hidden])', { timeout: 20000 });
    assert.match(await page.locator('[data-state="active"]').innerText(), /Take your power bank/);
    let all = await rentals();
    assert.equal(all.length, 1, "the retry reused the same rental");
    assert.equal(all[0].status, "active");
    assert.equal(all[0].paid_pence, 300);
    assert.equal(all[0].email, null, "no email was needed to rent");
    assert.ok(!/[?&]t=/.test(page.url()), "the access token is not left in the address bar");

    // The optional receipt, once the power bank is out.
    const receipt = page.locator('[data-state="active"] .rent-receipt');
    await receipt.locator("input").fill("sam@example.com");
    await receipt.locator("button").click();
    await page.waitForFunction(() => /Receipt sent/.test(document.querySelector('[data-state="active"] .rent-receipt__status').textContent));
    all = await rentals();
    assert.equal(all[0].email, "sam@example.com", "later receipts go to it too");

    // Come back later on the same phone: the page picks the rental up again.
    await page.goto(`${BASE}/rent?station=AJ1`);
    await page.waitForSelector('[data-state="active"]:not([hidden])', { timeout: 10000 });

    // The customer returns it after 2 hours 10 minutes (by the machine's clock): the extra 3.00 is taken on return.
    await post(`/__dev/supplier/return?tradeNo=${all[0].trade_no}&minutes=130`);
    // (The job skips a rental it looked at in the last few seconds, so give it a moment.)
    let done;
    for (let i = 0; i < 15; i++) {
      await get("/__dev/jobs");
      [done] = await rentals();
      if (done.status === "settled") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(done.status, "settled");
    assert.equal(done.charged_extra_pence, 600);
    await page.goto(`${BASE}/rent?station=AJ1`);
    await page.waitForSelector('[data-state="returned"]:not([hidden])', { timeout: 10000 });
    assert.match(await page.locator('[data-state="returned"]').innerText(), /£9\.00/);
    assert.deepEqual(errors, []);

    // The admin list shows it, behind a password.
    assert.equal((await fetch(`${BASE}/admin`)).status, 401);
    const admin = await fetch(`${BASE}/admin`, { headers: { Authorization: "Basic " + Buffer.from("admin:local-test-password").toString("base64") } });
    assert.equal(admin.status, 200);
    const html = await admin.text();
    assert.match(html, /settled/);
    assert.match(html, new RegExp(done.trade_no));
    assert.match(html, /dashboard\.stripe\.com\/test\/payments\/pi_/);
    assert.match(admin.headers.get("x-robots-tag"), /noindex/);
  });

  await t.test("Arabic: the switch translates the page, lays it out right to left, and the Arabic wording is what is recorded", async () => {
    const { page, errors } = await newPage();
    await page.goto(`${BASE}/rent?station=AJ1`);
    await page.waitForSelector("#rent-form:not([hidden])");
    await page.click('[data-lang="ar"]');
    assert.equal(await page.locator("#rent").getAttribute("dir"), "rtl");
    assert.equal(await page.locator("#rent-head h1").innerText(), "استأجر باور بانك");
    const formText = await page.locator("#rent-form").innerText();
    assert.equal((await page.locator(".rent-price__now").textContent()).replace(/\s+/g, " ").trim(), "£3 لكل ساعة");
    assert.match(formText, /أوافق على شروط الإيجار/);
    assert.match(formText, /12 ساعة/);
    assert.match(formText, /£20\.00/);
    assert.equal(await page.locator('[data-test="card"]').getAttribute("data-locale"), "ar", "Stripe's form switches to Arabic too");
    const before = (await rentals()).length;
    await page.click("#pay-button");
    await page.waitForSelector('[data-state="active"]:not([hidden])', { timeout: 20000 });
    assert.match(await page.locator('[data-state="active"]').innerText(), /خذ الباور بانك/);
    const mine = (await rentals()).slice(0, (await rentals()).length - before)[0];
    assert.match(mine.consent_text, /^أوافق على شروط الإيجار/, "the Arabic wording the customer saw is the one recorded");
    // The choice is remembered on this phone.
    await page.goto(`${BASE}/rent?station=AJ1`);
    await page.waitForSelector('[data-state="active"]:not([hidden])', { timeout: 10000 });
    assert.equal(await page.locator("#rent").getAttribute("dir"), "rtl");
    await page.click('[data-lang="en"]');
    assert.match(await page.locator('[data-state="active"]').innerText(), /Take your power bank/);
    assert.deepEqual(errors, []);
    await post(`/__dev/supplier/return?tradeNo=${mine.trade_no}&minutes=5`);
  });

  await t.test("if the machine never releases, the customer sees the automatic refund", async () => {
    const { page } = await newPage();
    await post("/__dev/supplier/machine?deviceId=DTA59552&neverRelease=1");
    await page.goto(`${BASE}/rent?station=AJ1`);
    await page.waitForSelector("#rent-form:not([hidden])");
    await page.click("#pay-button");
    await page.waitForSelector('[data-state="waiting"]:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('[data-state="refunded"]:not([hidden])', { timeout: 40000 });
    assert.match(await page.locator('[data-state="refunded"]').innerText(), /£3\.00 has been refunded in full/);
    const refunded = (await rentals()).find((r) => r.status === "release_failed_refunded");
    assert.ok(refunded);
    assert.equal(refunded.refunded_pence, 300);
    await post("/__dev/supplier/machine?deviceId=DTA59552&neverRelease=0");
  });
});

test("before the payment settings are in, the page sends people to the machine's own screen", { skip: !chromium && "Playwright is not installed", timeout: 60000 }, async (t) => {
  const port = PORT + 600;
  const env = { ...process.env, PORT: String(port) };
  for (const k of Object.keys(ENV)) if (k !== "PORT" && !(k in process.env)) delete env[k];
  for (const k of ["STRIPE_FAKE", "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STATIONS", "SITE_URL", "SUPPLIER_MODE", "RENTAL_STORE", "CONTEXT", "NETLIFY"]) delete env[k];
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  t.after(() => server.kill());
  for (let i = 0; i < 50 && !log.includes("running at"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(log, /Rental: off/);
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip("no browser available"); return; }
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.route("**/*", (route) => (new URL(route.request().url()).hostname === "localhost" ? route.continue() : route.abort()));
  await page.goto(`http://localhost:${port}/rent?station=AJ1`);
  await page.waitForSelector('[data-state="soon"]:not([hidden])', { timeout: 10000 });
  const text = await page.locator('[data-state="soon"]').innerText();
  assert.match(text, /screen on the machine/);
  assert.match(text, /You have not been charged/);
  assert.equal(await page.locator("#rent-form").isHidden(), true);
});
