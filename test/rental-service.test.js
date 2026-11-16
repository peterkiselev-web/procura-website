"use strict";
// The rental rules from the build spec, played out against fakes of Stripe and the supplier.
// These prove the logic. They do not prove anything about the real Stripe or the real machine (spec section 11).
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, HOUR, MIN } = require("./rental-helpers");
const { SupplierError } = require("../lib/rental/supplier");
const { S } = require("../lib/rental/states");

const offSessionCharges = (h) => h.fakeStripe.state.calls.filter((c) => c.method === "POST" && c.path === "/v1/payment_intents" && c.params.off_session === "true");
const createOrders = (h) => h.supplier.log.filter((l) => l[0] === "createOrder");
const closes = (h) => h.supplier.log.filter((l) => l[0] === "closeOrder");

test("station page: shows price and consent, and refuses an unknown or offline machine", async () => {
  const h = setup();
  const ok = await h.service.getStation("aj1");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.available, true);
  assert.equal(ok.json.pricing.firstChargePence, 300);
  assert.equal(ok.json.pricing.nonReturnFeePence, 2000);
  assert.match(ok.json.consent.text, /12 hours/);
  assert.match(ok.json.consent.text, /£20\.00 non-return fee/);
  assert.equal(ok.json.publishableKey, "pk_test_abc");
  assert.ok(!JSON.stringify(ok.json).includes("DTA59552"), "the supplier device id stays on the server");
  assert.equal((await h.service.getStation("NOPE")).status, 404);

  h.supplier.setOnline("DTA59552", false);
  assert.equal((await h.service.getStation("AJ1")).json.available, false);
  h.supplier.setOnline("DTA59552", true);
  h.supplier.setCharges("DTA59552", [5, 10]); // online but nothing charged enough
  assert.equal((await h.service.getStation("AJ1")).json.available, false);
});

test("spec 11.3: no payment can be started while the machine is switched off", async () => {
  const h = setup();
  h.supplier.setOnline("DTA59552", false);
  const out = await h.start();
  assert.equal(out.status, 409);
  assert.equal(out.json.error, "unavailable");
  assert.equal(h.fakeStripe.state.intents.size, 0, "no payment intent was created");
  assert.equal(h.fakeStripe.state.customers.size, 0);
  assert.equal((await h.store.list()).length, 0);
});

test("start checks the email if one is given, and needs the exact consent that was shown", async () => {
  const h = setup();
  assert.equal((await h.start({ email: "nope" })).json.error, "bad_email");
  // No email at all is allowed (a wallet that shares none): the rental just has no receipt address.
  const noEmail = await h.start({ email: "" });
  assert.equal(noEmail.status, 200);
  assert.equal((await h.store.get(noEmail.json.rentalId)).email, null);
  const pi = h.fakeStripe.state.calls.filter((c) => c.path === "/v1/payment_intents").pop();
  assert.equal(pi.params.receipt_email, undefined, "no empty receipt address is sent to Stripe");
  assert.equal((await h.start({ consent: false })).json.error, "consent_required");
  assert.equal((await h.start({ consentVersion: "old" })).json.error, "terms_changed");
});

test("start creates a 3.00 GBP payment that saves the card, on a customer, with the consent recorded", async () => {
  const h = setup();
  const out = await h.start();
  assert.equal(out.status, 200);
  assert.match(out.json.clientSecret, /_secret_/);
  const pi = [...h.fakeStripe.state.intents.values()][0];
  assert.equal(pi.amount, 300);
  assert.equal(pi.currency, "gbp");
  assert.equal(pi.setup_future_usage, "off_session");
  assert.ok(pi.customer.startsWith("cus_"));
  assert.equal(pi.receipt_email, "sam@example.com");
  assert.equal(pi.metadata.kind, "first_hour");
  const row = await h.store.get(out.json.rentalId);
  assert.equal(row.status, S.CREATED);
  assert.match(row.consent_text, /£20\.00 non-return fee/);
  assert.equal(row.consent_version, h.version);
  assert.equal(row.access_hash.length, 64);
  assert.ok(!row.access_hash.includes(out.json.token), "only a hash of the token is kept");
});

test("a power bank is released only after a verified payment webhook", async () => {
  const h = setup();
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  assert.equal(createOrders(h).length, 0, "nothing released at the point of paying");

  // A forged webhook is refused and releases nothing.
  const forged = h.fakeStripe.completePayment(row.stripe_payment_intent_id);
  const bad = await h.service.handleStripeWebhook(forged.body, forged.signature.replace(/v1=(.)/, (m, c) => "v1=" + (c === "0" ? "1" : "0")));
  assert.equal(bad.status, 400);
  assert.equal(createOrders(h).length, 0);
  assert.equal((await h.store.get(row.id)).status, S.CREATED);

  const good = await h.service.handleStripeWebhook(forged.body, forged.signature);
  assert.equal(good.status, 200);
  assert.equal(createOrders(h).length, 1);
  const after = await h.store.get(row.id);
  assert.equal(after.status, S.RELEASING);
  assert.ok(after.trade_no);
  assert.equal(after.paid_pence, 300);
  assert.equal(after.stripe_payment_method_id, "pm_card_visa");
  const [, device, callback] = createOrders(h)[0];
  assert.equal(device, "DTA59552");
  assert.match(callback, /^https:\/\/procuracharge\.com\/api\/bajie\/callback\//);
});

test("one payment never releases two power banks, even if the webhook is sent twice or under a new event id", async () => {
  const h = setup();
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  const first = await h.pay(row.stripe_payment_intent_id);
  assert.equal(first.res.status, 200);
  const again = await h.service.handleStripeWebhook(first.delivery.body, first.delivery.signature);
  assert.equal(again.status, 200);
  assert.equal(again.body, "already handled");
  // Stripe can also deliver a fresh event for the same payment.
  const other = h.fakeStripe.deliveryFor(h.fakeStripe.state.intents.get(row.stripe_payment_intent_id), "payment_intent.succeeded");
  assert.equal((await h.service.handleStripeWebhook(other.body, other.signature)).status, 200);
  assert.equal(createOrders(h).length, 1);
});

test("an event that fails to process is retried, and still releases only once", async () => {
  const h = setup();
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  const realUpdate = h.store.update;
  let boom = true;
  h.store.update = async (...args) => { if (boom && args[1].status === S.PAID) { boom = false; throw new Error("database blip"); } return realUpdate.apply(h.store, args); };
  const d = h.fakeStripe.completePayment(row.stripe_payment_intent_id);
  assert.equal((await h.service.handleStripeWebhook(d.body, d.signature)).status, 500);
  assert.equal(createOrders(h).length, 0);
  assert.equal((await h.service.handleStripeWebhook(d.body, d.signature)).status, 200, "Stripe retries and it works");
  assert.equal(createOrders(h).length, 1);
});

test("payments for other things (later charges) never release anything", async () => {
  const h = setup();
  const other = h.fakeStripe.deliveryFor({ id: "pi_x", metadata: { kind: "return" }, amount: 600 }, "payment_intent.succeeded");
  assert.equal((await h.service.handleStripeWebhook(other.body, other.signature)).status, 200);
  const unknown = h.fakeStripe.deliveryFor({ id: "pi_unknown", metadata: { kind: "first_hour" }, amount: 300 }, "payment_intent.succeeded");
  assert.equal((await h.service.handleStripeWebhook(unknown.body, unknown.signature)).status, 200);
  assert.equal(createOrders(h).length, 0);
});

test("the page sees 'Take your power bank' once the supplier confirms, and never sees internals", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  assert.equal(r.row.status, S.ACTIVE);
  assert.equal(r.row.cutoff_at, new Date(h.clock.t + 12 * HOUR).toISOString());
  const view = await h.service.getStatus({ id: r.rentalId, token: r.token });
  assert.equal(view.json.state, "active");
  const text = JSON.stringify(view.json);
  assert.ok(!text.includes(r.row.trade_no) && !text.includes("pi_") && !text.includes("cus_") && !text.includes("DTA59552"));
  assert.equal((await h.service.getStatus({ id: r.rentalId, token: "wrong" })).status, 404, "wrong token is the same as no rental");
  assert.equal((await h.service.getStatus({ id: "00000000-0000-0000-0000-000000000000", token: r.token })).status, 404);
});

test("spec 11.1: returned after 5 minutes costs 3.00 and nothing more", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.advance(5 * MIN);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(r.rentalId));
  const row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.SETTLED);
  assert.equal(row.rent_pence, 300);
  assert.equal(row.due_pence, 0);
  assert.equal(offSessionCharges(h).length, 0, "no extra charge");
  assert.equal(closes(h).length, 1, "the supplier order is closed (5.6)");
  assert.ok(row.supplier_closed_at);
  const view = await h.service.getStatus({ id: r.rentalId, token: r.token });
  assert.equal(view.json.state, "returned");
  assert.equal(view.json.totalPence, 300);
});

test("spec 11.2: returned after 70 minutes costs 3.00 at the start and 3.00 on return", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.advance(70 * MIN);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(r.rentalId));
  const row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.SETTLED);
  assert.equal(row.charged_extra_pence, 300);
  const [charge] = offSessionCharges(h);
  assert.equal(charge.params.amount, "300");
  assert.equal(charge.params.currency, "gbp");
  assert.equal(charge.params.off_session, "true");
  assert.equal(charge.params.confirm, "true");
  assert.equal(charge.params.payment_method, "pm_card_visa");
  assert.equal(charge.params.customer, h.fakeStripe.state.intents.get(r.piId).customer);
  assert.equal(charge.params.metadata.kind, "return");
  assert.ok(charge.key.startsWith("settle-"));
});

test("spec section 3 examples: 2h10m owes 6.00 more, 9 hours owes 17.00 more", async () => {
  for (const [minutes, extra] of [[130, 600], [9 * 60, 1700]]) {
    const h = setup();
    const r = await h.rentUntilActive();
    h.advance(minutes * MIN);
    h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
    await h.service.pollActive(await h.store.get(r.rentalId));
    const row = await h.store.get(r.rentalId);
    assert.equal(row.status, S.SETTLED);
    assert.equal(row.charged_extra_pence, extra, `${minutes} minutes`);
    assert.equal(row.paid_pence + row.charged_extra_pence <= 2000, true);
  }
});

test("billing uses the supplier's own borrow and return times, not our clock", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.supplier.simulateBorrowAt(r.row.trade_no, h.clock.t - 3 * HOUR); // the machine says it was lent 3 hours ago
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(r.rentalId));
  assert.equal((await h.store.get(r.rentalId)).charged_extra_pence, 600, "3 started hours = 9.00, less the 3.00 paid");
});

test("spec 11.5: not returned by the cut-off, so the rent owed plus the 20.00 fee is charged once and the rental closes", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.advance(11 * HOUR);
  await h.service.pollActive(await h.store.get(r.rentalId));
  assert.equal((await h.store.get(r.rentalId)).status, S.ACTIVE, "still inside the 12 hours");
  assert.equal(offSessionCharges(h).length, 0);

  h.advance(HOUR + MIN);
  await h.service.pollActive(await h.store.get(r.rentalId));
  const row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.EXPIRED_CHARGED);
  assert.equal(row.rent_pence, 2000);
  assert.equal(row.fee_pence, 2000);
  assert.equal(row.charged_extra_pence, 3700, "17.00 rent still owed + 20.00 fee");
  assert.equal(row.paid_pence + row.charged_extra_pence, 4000, "the 40.00 maximum");
  assert.equal(offSessionCharges(h).length, 1);
  assert.equal(closes(h).length, 1);

  // Nothing more is ever charged, even if the power bank comes back later.
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  h.advance(HOUR);
  await h.service.runJobs();
  await h.service.pollActive(await h.store.get(r.rentalId));
  assert.equal(offSessionCharges(h).length, 1);
  assert.equal((await h.store.get(r.rentalId)).status, S.EXPIRED_CHARGED);
});

test("a shortened cut-off in config is honoured (for the real-machine test)", async () => {
  const h = setup({ RENTAL_CUTOFF_MINUTES_OVERRIDE: "90" });
  const r = await h.rentUntilActive();
  assert.equal(r.row.cutoff_at, new Date(h.clock.t + 90 * MIN).toISOString());
  h.advance(91 * MIN);
  await h.service.pollActive(await h.store.get(r.rentalId));
  const row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.EXPIRED_CHARGED);
  assert.equal(row.rent_pence, 600, "two started hours of rent up to the cut-off");
  assert.equal(row.charged_extra_pence, 300 + 2000);
});

test("a power bank that comes back after the cut-off is treated like one that never came back", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.advance(13 * HOUR);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(r.rentalId));
  const row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.EXPIRED_CHARGED);
  assert.equal(row.charged_extra_pence, 3700);
});

test("machine unreachable at the cut-off: wait, never charge on something unconfirmed", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.advance(13 * HOUR);
  h.supplier.control.down = true;
  await h.service.runJobs();
  assert.equal((await h.store.get(r.rentalId)).status, S.ACTIVE);
  assert.equal(offSessionCharges(h).length, 0);
  const overview = await h.service.adminOverview();
  assert.ok(overview.attention.some((a) => a.rental.id === r.rentalId && /past the cut-off/.test(a.why.join())), "flagged for a person");
  h.supplier.control.down = false;
  h.advance(2 * MIN);
  await h.service.runJobs();
  assert.equal((await h.store.get(r.rentalId)).status, S.EXPIRED_CHARGED);
});

test("a fake callback cannot close a rental or charge anyone: only the order detail counts", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  await h.service.handleSupplierHint(r.rentalId, JSON.stringify({ tradeNo: r.row.trade_no, event: "RETURNED", returnTime: "2026-11-20 10:01:00" }));
  const row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.ACTIVE);
  assert.equal(offSessionCharges(h).length, 0);
  assert.equal(closes(h).length, 0);
  assert.ok(row.history.some((x) => x.text.startsWith("callback:")), "what arrived is kept so the format can be learned");
  // A hint for a rental that does not exist, or with a junk id, does nothing.
  await h.service.handleSupplierHint("not-an-id", "x");
  await h.service.handleSupplierHint("00000000-0000-0000-0000-000000000000", "x");
});

test("a callback prompts a fresh look at a releasing order and confirms it from the order detail", async () => {
  const h = setup();
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  await h.pay(row.stripe_payment_intent_id);
  await h.service.handleSupplierHint(s.json.rentalId, "ok");
  assert.equal((await h.store.get(s.json.rentalId)).status, S.ACTIVE);
});

test("spec 11.4: if the machine refuses the release, the 3.00 is refunded automatically", async () => {
  const h = setup();
  h.supplier.control.failNextCreate = new SupplierError("supplier refused: slot jammed", { kind: "api", code: 9, definitive: true });
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  await h.pay(row.stripe_payment_intent_id);
  const after = await h.store.get(row.id);
  assert.equal(after.status, S.RELEASE_FAILED_REFUNDED);
  assert.equal(after.refunded_pence, 300);
  assert.equal(h.fakeStripe.state.refunds.size, 1);
  const view = await h.service.getStatus({ id: row.id, token: s.json.token });
  assert.equal(view.json.state, "refunded");
  assert.equal(view.json.refundedPence, 300);
});

test("no confirmation within 60 seconds: refund 3.00 and close the order", async () => {
  const h = setup();
  h.supplier.control.neverRelease = true;
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  await h.pay(row.stripe_payment_intent_id);
  let cur = await h.store.get(row.id);
  assert.equal(cur.status, S.RELEASING);

  h.advance(30 * MIN / 60); // 30 seconds
  await h.service.refreshRelease(cur);
  assert.equal((await h.store.get(row.id)).status, S.RELEASING, "still waiting at 30 seconds");
  assert.ok(h.supplier.log.some((l) => l[0] === "requeryOrder"), "asked the supplier to send the result again after about 15 seconds (5.4)");

  h.advance(31 * 1000);
  await h.service.refreshRelease(await h.store.get(row.id));
  cur = await h.store.get(row.id);
  assert.equal(cur.status, S.RELEASE_FAILED_REFUNDED);
  assert.equal(cur.refunded_pence, 300);
  assert.equal(closes(h).length, 1);
  const refund = h.fakeStripe.state.calls.find((c) => c.path === "/v1/refunds");
  assert.equal(refund.key, `refund-${row.id}-0`);
});

test("a release that is slow but does confirm is not refunded", async () => {
  const h = setup();
  h.supplier.control.releaseDelayMs = 40 * 1000;
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  await h.pay(row.stripe_payment_intent_id);
  h.advance(45 * 1000);
  await h.service.refreshRelease(await h.store.get(row.id));
  assert.equal((await h.store.get(row.id)).status, S.ACTIVE);
  assert.equal(h.fakeStripe.state.refunds.size, 0);
});

test("when we do not know whether the order was made, we never ask twice, and the 60 second rule ends it", async () => {
  const h = setup();
  h.supplier.control.failNextCreate = new SupplierError("supplier timed out", { kind: "network" });
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  await h.pay(row.stripe_payment_intent_id);
  assert.equal((await h.store.get(row.id)).status, S.RELEASING);
  h.advance(61 * 1000);
  await h.service.runJobs();
  assert.equal((await h.store.get(row.id)).status, S.RELEASE_FAILED_REFUNDED);
  assert.equal(createOrders(h).length, 1, "the order was only ever attempted once");
});

test("a refund that fails is retried by the scheduled job and then completes", async () => {
  const h = setup();
  h.supplier.control.failNextCreate = new SupplierError("supplier refused", { kind: "api", definitive: true });
  h.fakeStripe.controls.failRefund = true;
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  await h.pay(row.stripe_payment_intent_id);
  assert.equal((await h.store.get(row.id)).status, S.REFUNDING);
  assert.equal((await h.service.adminOverview()).attention.some((a) => a.rental.id === row.id), true);
  h.fakeStripe.controls.failRefund = false;
  await h.service.runJobs();
  assert.equal((await h.store.get(row.id)).status, S.RELEASE_FAILED_REFUNDED);
  assert.equal(h.fakeStripe.state.refunds.size, 1, "one refund, however many tries");
});

test("a refund that Stripe answered with a server error is checked before a new key is used", async () => {
  // The error is remembered against the key, but the refund really did go through: it must not be paid twice.
  const h = setup();
  h.supplier.control.failNextCreate = new SupplierError("supplier refused", { kind: "api", definitive: true });
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  const d1 = h.fakeStripe.completePayment(row.stripe_payment_intent_id);
  h.fakeStripe.controls.throw500AfterCommit = true; // the refund call: it goes through, but the answer is an error
  await h.service.handleStripeWebhook(d1.body, d1.signature);
  // The refund is found at Stripe straight away and adopted, instead of being asked for again.
  assert.equal((await h.store.get(row.id)).status, S.RELEASE_FAILED_REFUNDED);
  assert.equal(h.fakeStripe.state.refunds.size, 1, "still only one refund");

  // The error is remembered and nothing went through: a new key is used and the refund completes.
  const h2 = setup();
  h2.supplier.control.failNextCreate = new SupplierError("supplier refused", { kind: "api", definitive: true });
  const s2 = await h2.start();
  const row2 = await h2.store.get(s2.json.rentalId);
  const d = h2.fakeStripe.completePayment(row2.stripe_payment_intent_id);
  h2.fakeStripe.controls.throw500Once = true; // hits the refund
  await h2.service.handleStripeWebhook(d.body, d.signature);
  assert.equal((await h2.store.get(row2.id)).status, S.REFUNDING);
  await h2.service.runJobs();
  assert.equal((await h2.store.get(row2.id)).status, S.RELEASE_FAILED_REFUNDED);
  assert.equal(h2.fakeStripe.state.refunds.size, 1);
});

test("spec 11.6: a card that declines on the later charge shows as payment failed after a small number of tries", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.fakeStripe.controls.decline = "insufficient_funds";
  h.advance(2 * HOUR);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(r.rentalId));
  let row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.RETURNED, "first decline: will try again");
  assert.equal(row.settle_attempts, 1);
  assert.equal(closes(h).length, 0, "not closed until settled or given up");

  await h.service.runJobs();
  assert.equal((await h.store.get(r.rentalId)).settle_attempts, 1, "not retried before the wait is over");
  h.advance(61 * MIN);
  await h.service.runJobs();
  assert.equal((await h.store.get(r.rentalId)).settle_attempts, 2);
  h.advance(61 * MIN);
  await h.service.runJobs();
  row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.PAYMENT_FAILED);
  assert.equal(offSessionCharges(h).length, 3, "three tries, then stop");
  assert.equal(new Set(offSessionCharges(h).map((c) => c.key)).size, 3, "each try has its own idempotency key");
  assert.equal(closes(h).length, 1);

  h.advance(24 * HOUR);
  await h.service.runJobs();
  assert.equal(offSessionCharges(h).length, 3, "never retried forever");
  const overview = await h.service.adminOverview();
  assert.equal(overview.failed.length, 1);
  assert.match(overview.attention[0].why.join(), /payment failed: £3\.00 still owed/);
  const view = await h.service.getStatus({ id: r.rentalId, token: r.token });
  assert.equal(view.json.state, "returned_unpaid");
  assert.equal(view.json.duePence, 300);
});

test("a card that needs the customer to authenticate is not retried", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.fakeStripe.controls.requireAuth = true;
  h.advance(2 * HOUR);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(r.rentalId));
  const row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.PAYMENT_FAILED);
  assert.ok(row.flags.includes("needs_customer_authentication"));
  assert.equal(offSessionCharges(h).length, 1);
});

test("a charge with no answer (timeout) is retried with the same key, so it can never charge twice", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.advance(2 * HOUR);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  h.fakeStripe.controls.networkFail = true;
  await h.service.pollActive(await h.store.get(r.rentalId));
  assert.equal((await h.store.get(r.rentalId)).status, S.RETURNED);
  await h.service.runJobs();
  const row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.SETTLED);
  const keys = offSessionCharges(h).map((c) => c.key);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "same idempotency key on the retry");
  assert.equal([...h.fakeStripe.state.intents.values()].filter((p) => p.metadata.kind === "return").length, 1, "one real charge");
});

test("a charge Stripe answered with a server error: if it went through it is adopted, if not a new key is used", async () => {
  const returnAfter2h = async (h) => {
    const r = await h.rentUntilActive();
    h.advance(2 * HOUR);
    h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
    return r;
  };
  const real = (h) => [...h.fakeStripe.state.intents.values()].filter((p) => p.metadata.kind === "return" && p.status === "succeeded");

  const a = setup();
  const ra = await returnAfter2h(a);
  a.fakeStripe.controls.throw500AfterCommit = true; // went through, but the answer was an error
  await a.service.pollActive(await a.store.get(ra.rentalId));
  await a.service.runJobs();
  assert.equal((await a.store.get(ra.rentalId)).status, S.SETTLED);
  assert.equal(real(a).length, 1, "not charged twice");

  const b = setup();
  const rb = await returnAfter2h(b);
  b.fakeStripe.controls.throw500Once = true; // did not go through
  await b.service.pollActive(await b.store.get(rb.rentalId));
  assert.equal((await b.store.get(rb.rentalId)).status, S.RETURNED);
  await b.service.runJobs();
  assert.equal((await b.store.get(rb.rentalId)).status, S.SETTLED);
  assert.equal(real(b).length, 1);
  assert.equal(new Set(offSessionCharges(b).map((c) => c.key)).size, 2, "a new key after a checked server error");
});

test("never bills beyond the cap, even if a row is wrong", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.advance(2 * HOUR);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  const active = await h.store.get(r.rentalId);
  // A bad row: owes more than the rent cap allows.
  await h.store.update(r.rentalId, { status: S.RETURNED, settle_kind: "return", due_pence: 5000, rent_pence: 5300, next_attempt_at: new Date(h.clock.t).toISOString() });
  await h.service.settle(await h.store.get(r.rentalId));
  assert.equal(offSessionCharges(h).length, 0);
  const row = await h.store.get(r.rentalId);
  assert.ok(row.flags.includes("cap_blocked"));
  assert.ok(active);
});

test("the total across every outcome never exceeds 40.00", async () => {
  for (const minutes of [1, 59, 60, 61, 119, 120, 121, 419, 420, 421, 600, 719]) {
    const h = setup();
    const r = await h.rentUntilActive();
    h.advance(minutes * MIN);
    h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
    await h.service.pollActive(await h.store.get(r.rentalId));
    const row = await h.store.get(r.rentalId);
    assert.equal(row.status, S.SETTLED, `${minutes} minutes`);
    assert.ok(row.paid_pence + row.charged_extra_pence <= 2000, `${minutes} minutes total ${row.paid_pence + row.charged_extra_pence}`);
  }
});

test("an unpaid rental is given up on, its payment cancelled, and a payment that turns up later is refunded", async () => {
  const h = setup();
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  h.advance(31 * MIN);
  await h.service.runJobs();
  assert.equal((await h.store.get(row.id)).status, S.ABANDONED);
  assert.equal(h.fakeStripe.state.intents.get(row.stripe_payment_intent_id).status, "canceled");

  // Edge: the money lands after it was given up on (a race with the cancel).
  const h2 = setup();
  const s2 = await h2.start();
  const row2 = await h2.store.get(s2.json.rentalId);
  await h2.store.update(row2.id, { status: S.ABANDONED });
  await h2.pay(row2.stripe_payment_intent_id);
  assert.equal((await h2.store.get(row2.id)).status, S.RELEASE_FAILED_REFUNDED);
  assert.equal(createOrders(h2).length, 0, "no power bank is released for a rental that was given up on");
});

// Seen on 16 Nov 2026: the payment went through and Stripe delivered no webhook, so the page waited forever.
test("paid but no webhook: the waiting page's check asks Stripe directly and releases, once", async () => {
  const h = setup();
  const s = await h.start();
  const row0 = await h.store.get(s.json.rentalId);
  const ask = () => h.service.getStatus({ id: s.json.rentalId, token: s.json.token });
  h.advance(2000);
  assert.equal((await ask()).json.state, "awaiting_payment", "nothing happens before the money is there");
  assert.equal(createOrders(h).length, 0);
  const delivery = h.fakeStripe.completePayment(row0.stripe_payment_intent_id); // paid at Stripe; the webhook is lost
  h.advance(2000);
  assert.equal((await ask()).json.state, "releasing");
  assert.equal(createOrders(h).length, 1);
  const row = await h.store.get(row0.id);
  assert.equal(row.paid_pence, 300);
  assert.ok(row.history.some((x) => /payment confirmed by Stripe \(checked while the page waited\)/.test(x.text)));
  // The webhook turns up late, and the page keeps asking: neither releases a second power bank.
  const late = await h.service.handleStripeWebhook(delivery.body, delivery.signature);
  assert.equal(late.status, 200);
  h.advance(2000);
  await ask();
  assert.equal(createOrders(h).length, 1, "one payment, one power bank");
});

test("the direct check only accepts this rental's own first-hour payment, succeeded, for the full amount", async () => {
  // A payment whose details do not match this rental is never taken as payment for it.
  for (const tamper of [(pi) => { pi.metadata.rental_id = "someone-else"; }, (pi) => { pi.metadata.kind = "extra"; }, (pi) => { pi.amount_received = 100; }]) {
    const h = setup();
    const s = await h.start();
    const row0 = await h.store.get(s.json.rentalId);
    h.fakeStripe.completePayment(row0.stripe_payment_intent_id);
    tamper(h.fakeStripe.state.intents.get(row0.stripe_payment_intent_id));
    h.advance(2000);
    const st = await h.service.getStatus({ id: s.json.rentalId, token: s.json.token });
    assert.equal(st.json.state, "awaiting_payment");
    assert.equal(createOrders(h).length, 0);
  }
  // Stripe unreachable during the check: keep waiting, release nothing; the next check (Stripe back) releases.
  const h = setup();
  const s = await h.start();
  const row0 = await h.store.get(s.json.rentalId);
  h.fakeStripe.completePayment(row0.stripe_payment_intent_id);
  h.fakeStripe.controls.networkFail = true; // the next request to Stripe fails
  h.advance(2000);
  assert.equal((await h.service.getStatus({ id: s.json.rentalId, token: s.json.token })).json.state, "awaiting_payment");
  assert.equal(createOrders(h).length, 0);
  h.advance(2000);
  assert.equal((await h.service.getStatus({ id: s.json.rentalId, token: s.json.token })).json.state, "releasing");
  assert.equal(createOrders(h).length, 1);
});

test("page closed and no webhook: the scheduled job confirms within 3 minutes; after that it refunds instead of releasing", async () => {
  const h = setup();
  const s = await h.start();
  const row0 = await h.store.get(s.json.rentalId);
  h.fakeStripe.completePayment(row0.stripe_payment_intent_id);
  h.advance(60 * 1000);
  await h.service.runJobs();
  assert.notEqual((await h.store.get(row0.id)).status, S.CREATED);
  assert.equal(createOrders(h).length, 1);

  // Paid, but nothing noticed for 4 minutes (page closed, no webhook): the customer may have gone, so no release.
  const h2 = setup();
  const s2 = await h2.start();
  const r2 = await h2.store.get(s2.json.rentalId);
  h2.fakeStripe.completePayment(r2.stripe_payment_intent_id);
  h2.advance(4 * MIN);
  await h2.service.runJobs();
  assert.equal((await h2.store.get(r2.id)).status, S.CREATED);
  assert.equal(createOrders(h2).length, 0);
  h2.advance(27 * MIN);
  await h2.service.runJobs();
  assert.equal((await h2.store.get(r2.id)).status, S.RELEASE_FAILED_REFUNDED, "refunded by the sweep at 30 minutes");
  assert.equal(createOrders(h2).length, 0);
});

test("paid but the webhook never arrived: refunded by the sweep, never released from it", async () => {
  const h = setup();
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  h.fakeStripe.completePayment(row.stripe_payment_intent_id); // paid at Stripe, but we never hear about it
  h.advance(31 * MIN);
  await h.service.runJobs();
  const after = await h.store.get(row.id);
  assert.equal(after.status, S.RELEASE_FAILED_REFUNDED);
  assert.ok(after.flags.includes("webhook_missed"));
  assert.equal(createOrders(h).length, 0);
});

test("the scheduled job drives a rental all the way through on its own", async () => {
  const h = setup();
  const s = await h.start();
  const row = await h.store.get(s.json.rentalId);
  await h.pay(row.stripe_payment_intent_id);
  await h.service.runJobs();
  assert.equal((await h.store.get(row.id)).status, S.ACTIVE);
  h.advance(3 * HOUR);
  h.supplier.simulateReturn((await h.store.get(row.id)).trade_no, h.clock.t);
  await h.service.runJobs();
  assert.equal((await h.store.get(row.id)).status, S.SETTLED);
});

test("a failed close at the supplier is retried and never undoes the settlement", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  h.supplier.control.closeFails = true;
  h.advance(5 * MIN);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(r.rentalId));
  let row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.SETTLED);
  assert.equal(row.supplier_closed_at, undefined);
  assert.equal(row.close_attempts, 1);
  h.supplier.control.closeFails = false;
  await h.service.runJobs();
  row = await h.store.get(r.rentalId);
  assert.ok(row.supplier_closed_at);
  assert.equal(row.status, S.SETTLED);
});

test("the rental switch: with rentals paused the page says so and nothing can start", async () => {
  const h = setup({ RENTALS_ENABLED: "no" });
  assert.equal((await h.service.getStation("AJ1")).json.available, false);
  assert.equal((await h.start()).status, 409);
});

test("a charge on a card with no saved payment method fails closed instead of guessing", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  await h.store.update(r.rentalId, { stripe_payment_method_id: null });
  h.advance(2 * HOUR);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(r.rentalId));
  const row = await h.store.get(r.rentalId);
  assert.equal(row.status, S.PAYMENT_FAILED);
  assert.ok(row.flags.includes("no_saved_card"));
});

test("Arabic: the station offers the consent in Arabic, and a rental started in Arabic records the Arabic wording", async () => {
  const h = setup();
  const st = (await h.service.getStation("AJ1")).json;
  assert.match(st.consentAr.text, /^أوافق على شروط الإيجار/);
  assert.match(st.consentAr.text, /12 ساعة/);
  assert.match(st.consentAr.text, /£20\.00/);
  assert.notEqual(st.consentAr.version, st.consent.version);
  // The English version number does not pass for the Arabic wording, and the other way round.
  assert.equal((await h.start({ lang: "ar" })).json.error, "terms_changed");
  const out = await h.start({ lang: "ar", consentVersion: st.consentAr.version });
  assert.equal(out.status, 200);
  assert.equal((await h.store.get(out.json.rentalId)).consent_text, st.consentAr.text);
  // Station language setting.
  const h2 = setup({ STATIONS: '{"AJ1":{"deviceId":"DTA59552","name":"Al Jawhara Garden","lang":"ar"}}' });
  const st2 = (await h2.service.getStation("AJ1")).json;
  assert.equal(st2.station.lang, "ar");
  assert.equal(st2.station.name, "Al Jawhara Garden");
});

test("the quick station request skips the machine check, and starting always checks the machine", async () => {
  const h = setup();
  h.supplier.setOnline("DTA59552", false);
  const quick = (await h.service.getStation("AJ1", { check: false })).json;
  assert.equal(quick.available, null, "not checked");
  assert.equal(h.supplier.log.filter((l) => l[0] === "checkCabinet").length, 0, "the supplier was not asked");
  assert.equal((await h.service.getStation("AJ1")).json.available, false, "the full request does check");
  assert.equal((await h.start()).json.error, "unavailable", "and no payment can start on an offline machine");
});

test("optional receipt: saves the email, updates the customer, and has Stripe email the receipt for each charge", async () => {
  const h = setup();
  const r = await h.rentUntilActive();
  assert.equal((await h.store.get(r.rentalId)).email, "sam@example.com"); // the harness starts with one
  assert.equal((await h.service.sendReceipt({ id: r.rentalId, token: "wrong", email: "a@b.co" })).status, 404);
  assert.equal((await h.service.sendReceipt({ id: r.rentalId, token: r.token, email: "nope" })).status, 400);
  const ok = await h.service.sendReceipt({ id: r.rentalId, token: r.token, email: "new@example.com" });
  assert.equal(ok.status, 200);
  assert.equal((await h.store.get(r.rentalId)).email, "new@example.com");
  const pi = h.fakeStripe.state.intents.get(r.piId);
  assert.equal(h.fakeStripe.state.customers.get(pi.customer).email, "new@example.com");
  const charge = h.fakeStripe.state.charges.get(pi.latest_charge);
  assert.equal(charge.receipt_email, "new@example.com");
  assert.equal(charge.receipts_sent, 1);
  // A later charge on the rental goes to the new address too, and asking again covers it.
  h.advance(2 * HOUR);
  h.supplier.simulateReturn(r.row.trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(r.rentalId));
  const settled = await h.store.get(r.rentalId);
  assert.equal(h.fakeStripe.state.intents.get(settled.settle_pi_id).receipt_email, "new@example.com");
  await h.service.sendReceipt({ id: r.rentalId, token: r.token, email: "new@example.com" });
  const extra = h.fakeStripe.state.charges.get(h.fakeStripe.state.intents.get(settled.settle_pi_id).latest_charge);
  assert.equal(extra.receipts_sent, 1);
});

test("a rental with no email at all works end to end (no receipt address is ever sent to Stripe)", async () => {
  const h = setup();
  const s = await h.start({ email: undefined });
  const row = await h.store.get(s.json.rentalId);
  assert.equal(row.email, null);
  await h.pay(row.stripe_payment_intent_id);
  await h.service.refreshRelease(await h.store.get(row.id));
  h.advance(2 * HOUR);
  h.supplier.simulateReturn((await h.store.get(row.id)).trade_no, h.clock.t);
  await h.service.pollActive(await h.store.get(row.id));
  assert.equal((await h.store.get(row.id)).status, "settled");
  const charge = h.fakeStripe.state.calls.find((c) => c.params.off_session === "true");
  assert.equal(charge.params.receipt_email, undefined);
});
