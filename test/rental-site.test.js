"use strict";
// Site-level checks for the QR rental: security headers, wiring, the pages, and that no secret can reach a browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const { loadConfig } = require("../lib/rental/config");
const { termsTokens, consentText } = require("../lib/rental/copy");
const { CSP } = require("../server.js");

const toml = read("netlify.toml");
const headerValue = (name) => (toml.match(new RegExp(`${name} = "((?:[^"\\\\]|\\\\.)*)"`)) || [])[1];

test("the content security policy is the same in netlify.toml and server.js, and allows Stripe only where it must", () => {
  assert.equal(headerValue("Content-Security-Policy"), CSP);
  const directive = (name) => (CSP.match(new RegExp(`${name} ([^;]+)`)) || [])[1] || "";
  assert.match(directive("script-src"), /https:\/\/js\.stripe\.com/);
  assert.match(directive("frame-src"), /https:\/\/js\.stripe\.com/);
  assert.match(directive("frame-src"), /https:\/\/hooks\.stripe\.com/);
  assert.match(directive("connect-src"), /https:\/\/api\.stripe\.com/);
  assert.match(directive("img-src"), /https:\/\/\*\.stripe\.com/);
  assert.ok(!/unsafe-eval/.test(CSP) && !/script-src[^;]*unsafe-inline/.test(CSP), "no inline or eval scripts");
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /object-src 'none'/);
  assert.ok(!/\*(\s|;|$)/.test(CSP.replace(/https:\/\/\*\.[a-z.]+/g, "")), "no bare wildcard sources");
});

test("wallets are allowed to work: Permissions-Policy lets Stripe's frames use payment, and popups are not cut off", () => {
  const pp = headerValue("Permissions-Policy").replace(/\\"/g, '"');
  assert.match(pp, /payment=\(self "https:\/\/js\.stripe\.com" "https:\/\/\*\.js\.stripe\.com"\)/);
  assert.match(pp, /camera=\(\)/);
  assert.equal(headerValue("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");
});

test("netlify.toml wires the functions, the schedule, the noindex headers and hides internals", () => {
  assert.match(toml, /\[functions\."rent-cron"\]\s+schedule = "\* \* \* \* \*"/);
  for (const [from, to] of [["/api/rent/*", "/.netlify/functions/rent/:splat"], ["/api/stripe/webhook", "/.netlify/functions/stripe-webhook"], ["/api/bajie/callback/*", "/.netlify/functions/bajie-callback/:splat"], ["/admin", "/.netlify/functions/admin"], ["/admin/*", "/.netlify/functions/admin"]]) {
    assert.match(toml, new RegExp(`from = "${from.replace(/[*/]/g, "\\$&")}"\\s+to = "${to.replace(/[*/.:]/g, "\\$&")}"\\s+status = 200`), `${from} -> ${to}`);
  }
  for (const fn of ["rent", "stripe-webhook", "bajie-callback", "rent-cron", "admin"]) assert.ok(fs.existsSync(path.join(ROOT, "netlify", "functions", fn + ".js")), fn);
  for (const p of ["/rent*", "/admin*"]) assert.match(toml, new RegExp(`for = "${p.replace("*", "\\*")}"\\s+\\[headers\\.values\\]\\s+X-Robots-Tag = "noindex, nofollow"\\s+Cache-Control = "no-store"`));
  for (const hidden of ["/lib/*", "/supabase/*", "/js/dev-stripe.js"]) assert.match(toml, new RegExp(`from = "${hidden.replace(/[*/.]/g, "\\$&")}"\\s+to = "/404.html"\\s+status = 404`), hidden);
});

test("the rent page: noindex, not in the sitemap, not linked from anywhere else, no menu or call-to-action", () => {
  const rent = read("rent.html");
  assert.match(rent, /<meta name="robots" content="noindex">/);
  assert.ok(!/rel="canonical"/.test(rent));
  assert.ok(!/class="dock"/.test(rent) && !/class="menu"/.test(rent) && !/Book a free call/.test(rent));
  assert.match(rent, /<script src="\/js\/rent\.js"><\/script>/);
  const sitemap = read("sitemap.xml");
  assert.ok(!/\/rent</.test(sitemap) && !/rental-terms/.test(sitemap));
  for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith(".html") && n !== "rent.html")) {
    assert.ok(!/href="\/rent(\?[^"]*)?"/.test(read(f)), `${f} links to the rent page`);
  }
  assert.ok(!/rent/.test(read("robots.txt")), "robots.txt does not advertise the page");
});

test("the rent page states the fee and the cut-off on the page itself, not only in the terms", () => {
  const rent = read("rent.html");
  assert.match(rent, /data-money="nonReturnFeePence"/);
  assert.match(rent, /data-text="cutoffLabel"/);
  assert.match(rent, /data-money="maxTotalPence"/);
  assert.match(rent, /data-text="consentText"/);
  assert.match(rent, /id="consent"[^>]*required/);
  assert.match(rent, /href="\/rental-terms"/);
});

test("the terms page shows the configured prices and the exact consent wording, with nothing left unfilled", () => {
  const terms = read("rental-terms.html");
  const c = loadConfig({});
  assert.ok(!/@@[A-Z_]+@@/.test(terms));
  for (const v of ["£3.00", "£20.00", "£40.00", "12 hours"]) assert.ok(terms.includes(v), v);
  assert.ok(terms.includes(consentText(c)), "the consent shown at payment is quoted word for word");
  assert.match(terms, /<meta name="robots" content="noindex">/);
  // Other settings change the page.
  const t = termsTokens(loadConfig({ RENTAL_PRICE_PER_HOUR_PENCE: "250", RENTAL_MAX_RENT_PENCE: "1500", RENTAL_NON_RETURN_FEE_PENCE: "1000", RENTAL_CUTOFF_HOURS: "6", RENTAL_FIRST_CHARGE_PENCE: "250" }));
  assert.equal(t["@@PRICE_PER_HOUR@@"], "£2.50");
  assert.equal(t["@@MAX_TOTAL@@"], "£25.00");
  assert.equal(t["@@CUTOFF@@"], "6 hours");
  assert.match(t["@@CONSENT_TEXT@@"], /£10\.00 non-return fee/);
});

test("no secret can reach a browser: nothing public mentions a key name, a key, or the supplier login", () => {
  const publicFiles = [...fs.readdirSync(path.join(ROOT, "js")).map((f) => `js/${f}`), ...fs.readdirSync(ROOT).filter((n) => n.endsWith(".html")), ...fs.readdirSync(path.join(ROOT, "src", "pages")).map((f) => `src/pages/${f}`), "css/style.css"];
  const forbidden = [/STRIPE_SECRET/, /STRIPE_WEBHOOK/, /BAJIE_/, /SERVICE_ROLE/, /ADMIN_PASSWORD/, /\b(sk|rk)_(test|live)_[A-Za-z0-9]/, /whsec_[A-Za-z0-9]/, /oauth2\/login/, /chargenow/];
  for (const f of publicFiles) for (const re of forbidden) assert.ok(!re.test(read(f)), `${f} matches ${re}`);
  // The browser may hold only the publishable key, which the server hands over at run time.
  assert.ok(!/pk_(test|live)_/.test(read("js/rent.js")));
});

test("the page never trusts itself to release anything: the script has no way to start a release", () => {
  const js = read("js/rent.js");
  assert.ok(!/order\/create|tradeNo|cabinet/i.test(js));
  assert.match(js, /\/api\/rent\/start/);
});

test("the local Stripe stand-in is hidden on the live site, and only loaded when the server says its fake is on", () => {
  assert.match(toml, /from = "\/js\/dev-stripe\.js"/);
  assert.match(read("js/rent.js"), /station_\.devStripe \? "\/js\/dev-stripe\.js" : "https:\/\/js\.stripe\.com\/v3"/);
});

test("nothing new uses an em or en dash", () => {
  const dirs = ["lib/rental", "netlify/functions", "js", "src/pages", "supabase/migrations", "test"];
  // (build.js is left out: it contains the dash characters on purpose, in the check that stops them reaching a page.)
  const files = ["README.md", ".env.example", "netlify.toml", "server.js", "css/style.css"];
  for (const d of dirs) for (const f of fs.readdirSync(path.join(ROOT, d))) {
    if (!fs.statSync(path.join(ROOT, d, f)).isFile()) continue;
    if (d === "test" && !f.startsWith("rental-")) continue; // older tests have the characters in their own checks
    files.push(`${d}/${f}`);
  }
  for (const f of files) if (fs.existsSync(path.join(ROOT, f))) assert.ok(!/[\u2013\u2014]/.test(read(f)), `${f} has a dash`);
});

// ---- the Netlify functions, called the way Netlify calls them ----------------------------------------------------
test("Netlify functions: routing by path, base64 bodies for the webhook, and fail-closed without settings", async () => {
  const { resetRuntime } = require("../lib/rental/runtime");
  const { signWebhook } = require("../lib/rental/stripe");
  const keep = { ...process.env };
  const set = {
    STRIPE_FAKE: "yes", STRIPE_SECRET_KEY: "rk_test_fake", STRIPE_PUBLISHABLE_KEY: "pk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
    STATIONS: "AJ1=DTA59552", SITE_URL: "https://procuracharge.com", SUPPLIER_MODE: "fake", RENTAL_STORE: "memory", ADMIN_PASSWORD: "a-long-enough-password",
  };
  for (const k of ["CONTEXT", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT"]) delete process.env[k];
  try {
    // Closed with nothing set.
    for (const k of Object.keys(set)) delete process.env[k];
    resetRuntime();
    const rent = require("../netlify/functions/rent").handler;
    assert.equal((await rent({ httpMethod: "GET", path: "/api/rent/station", queryStringParameters: { station: "AJ1" }, headers: {} })).statusCode, 503);

    Object.assign(process.env, set);
    resetRuntime();
    const rt = require("../lib/rental/runtime").getRuntime();
    assert.equal(rt.ready, true, rt.problems.join());
    for (const p of ["/api/rent/station", "/.netlify/functions/rent/station"]) {
      const out = await rent({ httpMethod: "GET", path: p, queryStringParameters: { station: "AJ1" }, headers: { "x-nf-client-connection-ip": "5.5.5.5" } });
      assert.equal(out.statusCode, 200, p);
      assert.equal(out.headers["Cache-Control"], "no-store");
      assert.equal(JSON.parse(out.body).available, true);
    }
    assert.equal((await rent({ httpMethod: "POST", path: "/api/rent/start", body: "{not json", headers: {} })).statusCode, 400);
    assert.equal((await rent({ httpMethod: "POST", path: "/api/rent/start", body: "x".repeat(10000), headers: {} })).statusCode, 413);

    // Pay, with the webhook delivered the way Netlify delivers it: base64 body, lower-case headers.
    const station = JSON.parse((await rent({ httpMethod: "GET", path: "/api/rent/station", queryStringParameters: { station: "AJ1" }, headers: {} })).body);
    const start = JSON.parse((await rent({ httpMethod: "POST", path: "/api/rent/start", headers: {}, body: JSON.stringify({ station: "AJ1", email: "a@b.co", consent: true, consentVersion: station.consent.version }) })).body);
    assert.equal(start.ok, true);
    const pi = start.clientSecret.split("_secret_")[0];
    const d = rt.fakeStripe.completePayment(pi);
    const hook = require("../netlify/functions/stripe-webhook").handler;
    const wh = await hook({ httpMethod: "POST", path: "/api/stripe/webhook", headers: { "stripe-signature": d.signature }, body: Buffer.from(d.body).toString("base64"), isBase64Encoded: true });
    assert.equal(wh.statusCode, 200);
    assert.equal((await rt.store.get(start.rentalId)).status, "releasing");
    const bad = await hook({ httpMethod: "POST", path: "/api/stripe/webhook", headers: { "stripe-signature": signWebhook(d.body, "whsec_other") }, body: d.body });
    assert.equal(bad.statusCode, 400);
    assert.equal((await hook({ httpMethod: "GET", path: "/api/stripe/webhook", headers: {} })).statusCode, 405);

    const cron = require("../netlify/functions/rent-cron").handler;
    const ran = await cron({});
    assert.equal(ran.statusCode, 200);
    assert.equal((await rt.store.get(start.rentalId)).status, "active");

    const admin = require("../netlify/functions/admin").handler;
    assert.equal((await admin({ httpMethod: "GET", path: "/admin", headers: {} })).statusCode, 401);
    const view = await admin({ httpMethod: "GET", path: "/admin", headers: { authorization: "Basic " + Buffer.from("admin:a-long-enough-password").toString("base64") } });
    assert.equal(view.statusCode, 200);
    assert.match(view.body, /active/);

    // The callback function reads the secret and the rental from the path, in either form.
    process.env.BAJIE_CALLBACK_SECRET_PATH = "z".repeat(30);
    process.env.BAJIE_USERNAME = "u"; // (the fake supplier ignores these)
    resetRuntime();
    const cb = require("../netlify/functions/bajie-callback").handler;
    for (const p of [`/api/bajie/callback/${"z".repeat(30)}/${start.rentalId}`, `/.netlify/functions/bajie-callback/${"z".repeat(30)}/${start.rentalId}`]) {
      assert.equal((await cb({ httpMethod: "POST", path: p, headers: {}, body: "{}" })).statusCode, 200, p);
    }
    assert.equal((await cb({ httpMethod: "POST", path: "/api/bajie/callback/wrong/x", headers: {}, body: "{}" })).statusCode, 404);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
    resetRuntime();
  }
});
