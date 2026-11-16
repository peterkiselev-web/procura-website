"use strict";
// The rental business logic. It talks to three things it is handed, so tests can swap in fakes:
//   store     where rentals live (store-memory or store-supabase)
//   supplier  the machine (supplier.js or supplier-fake.js)
//   stripe    payments (stripe.js)
//
// Rules this code holds to (spec sections 4, 6 and 7):
//  - A power bank is released only after a signature-verified payment_intent.succeeded webhook, and at most once
//    per rental: the paid > releasing step is a compare-and-set that only one caller can win.
//  - A callback or event from the supplier is only a hint. Anything that changes a rental or charges someone
//    is based on a fresh GET /rent/order/detail.
//  - Every charge and refund carries an idempotency key, and nothing is ever billed beyond the caps.
const crypto = require("crypto");
const { S, TERMINAL, OPEN } = require("./states");
const { returnSettlement, cutoffSettlement, money, maxTotalPence } = require("./pricing");
const { canRent } = require("./supplier");
const { cutoffMs, configProblems } = require("./config");
const { consentText, consentTextAr, consentVersion, publicPricing } = require("./copy");
const { verifyWebhook } = require("./stripe");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const brief = (e) => String((e && e.message) || e || "error").slice(0, 200);

function createService({ store, supplier, stripe, config, now = Date.now, log = () => {} }) {
  const iso = (ms = now()) => new Date(ms).toISOString();
  const ms = (v) => (v ? Date.parse(v) : NaN);
  const p = config.pricing;
  const releaseTimeoutMs = config.timing.releaseTimeoutSeconds * 1000;

  const history = (row, text) => [...(row.history || []), { at: iso(), text: String(text).slice(0, 300) }].slice(-40);
  const flagged = (row, flag) => (row.flags || []).includes(flag) ? row.flags : [...(row.flags || []), flag];

  // ---- The customer page ------------------------------------------------------------------------------------

  // check false: prices and wording only, without asking the supplier about the machine (the page asks for both at
  // once so the payment form can appear sooner; startRental always checks the machine before taking payment).
  async function getStation(code, { check = true } = {}) {
    const station = config.stations[String(code || "").toUpperCase()];
    if (!station) return { status: 404, json: { ok: false, error: "unknown_station" } };
    const problems = configProblems(config);
    if (problems.length) { log("config", problems.join("; ")); return { status: 503, json: { ok: false, error: "not_configured" } }; }
    const text = consentText(config), textAr = consentTextAr(config);
    const base = {
      ok: true, station: { code: station.code, name: station.name, lang: station.lang || null }, pricing: publicPricing(config),
      consent: { text, version: consentVersion(text) },
      consentAr: { text: textAr, version: consentVersion(textAr) },
      publishableKey: config.stripe.publishableKey, applePayOptions: parseApplePay(config.stripe.applePayOptions),
    };
    if (!config.rentalsEnabled) return { status: 200, json: { ...base, available: false, reason: "paused" } };
    if (!check) return { status: 200, json: { ...base, available: null, reason: null } };
    try {
      const cab = await supplier.checkCabinet(station.deviceId);
      const available = canRent(cab, config.minBatteryVol);
      return { status: 200, json: { ...base, available, reason: available ? null : (cab.online ? "no_charged_battery" : "offline") } };
    } catch (e) {
      log("supplier", `cabinet check failed: ${brief(e)}`);
      return { status: 200, json: { ...base, available: false, reason: "unreachable" } };
    }
  }

  // For the setup check: what the supplier says about a station's machine. No ids, keys or personal data.
  async function stationDiagnostics(code, { orders = false } = {}) {
    const station = config.stations[String(code || "").toUpperCase()];
    if (!station) return { station: String(code || "").slice(0, 16), known: false };
    let out;
    try {
      const cab = await supplier.checkCabinet(station.deviceId);
      out = { station: station.code, known: true, reachable: true, online: cab.online, canRent: canRent(cab, config.minBatteryVol), minBatteryVol: config.minBatteryVol, supplierSaid: cab.shape || null };
    } catch (e) {
      return { station: station.code, known: true, reachable: false, error: { kind: e.kind || "error", code: e.code === undefined ? null : e.code, status: e.status || null, message: brief(e).replace(/[^\x20-\x7E]/g, "").slice(0, 160) } };
    }
    if (orders) out.orderAccess = await probeOrderAccess();
    return out;
  }

  // Setup check, sandbox only: creates the same first-hour payment a customer's phone would start (no customer, no
  // card), reads back which payment methods Stripe put on it, then cancels it at once. Nothing can be charged. It
  // proves Stripe accepts the request as we send it, which is what failed on 15 Nov 2026 (API version change).
  async function stripeCheck() {
    if (stripe.mode !== "test") return { ran: false, reason: "live mode: not run, to keep the live account clean" };
    const id = "check-" + crypto.randomBytes(6).toString("hex");
    try {
      const pi = await stripe.createFirstPayment({ amount: p.firstChargePence, currency: config.currency, rentalId: id, description: "Procura setup check, cancelled at once" });
      let cancelled = false;
      try { await stripe.cancelPaymentIntent(pi.id, id); cancelled = true; } catch (e) { /* reported below */ }
      return { ran: true, ok: true, paymentMethodTypes: pi.payment_method_types || null, setupFutureUsage: pi.setup_future_usage || null, cancelled };
    } catch (e) {
      return { ran: true, ok: false, code: e.code || e.kind || null, message: brief(e).slice(0, 200) };
    }
  }

  // Asks the supplier about an order number that does not exist, once for each order call the rentals rely on:
  // detail (confirms a release and spots a return), query (asks for the result again) and close (ends the order).
  // There is no such order, so nothing can be released or closed. "Order not found" means the account may make
  // the call; a refusal about permission or authorisation means it may not, and rentals cannot work until it can.
  const PROBE_ORDER = "PROCURA-ACCESS-CHECK-0";
  async function probeOrderAccess() {
    const one = async (fn) => {
      try { await fn(); return { answered: true, code: 0, message: "accepted" }; }
      catch (e) {
        const message = String((e && e.message) || "").replace(/[\x00-\x1F\x7F]/g, " ").slice(0, 160);
        const refused = /permission|forbidden|denied|unauthori[sz]|no auth|not allowed|权限|无权|禁止/i.test(message) || e.status === 401 || e.status === 403 || e.kind === "auth";
        // An answer from the supplier that is not a permission refusal (for example "order not found") means access is fine.
        return { answered: e.kind === "api" && !refused, refused, kind: e.kind || "error", code: e.code === undefined ? null : e.code, status: e.status || null, message };
      }
    };
    const access = {
      detail: await one(() => supplier.getOrderDetail(PROBE_ORDER)),
      query: await one(() => supplier.requeryOrder(PROBE_ORDER)),
      close: await one(() => supplier.closeOrder(PROBE_ORDER)),
    };
    access.allAnswered = access.detail.answered && access.query.answered && access.close.answered;
    return access;
  }

  function parseApplePay(raw) {
    if (!raw) return null;
    try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : null; } catch (e) { return null; }
  }

  async function startRental({ station: code, email, consent, consentVersion: seen, lang }) {
    const station = config.stations[String(code || "").toUpperCase()];
    if (!station) return { status: 404, json: { ok: false, error: "unknown_station" } };
    if (configProblems(config).length) return { status: 503, json: { ok: false, error: "not_configured" } };
    if (!config.rentalsEnabled) return { status: 409, json: { ok: false, error: "unavailable" } };
    const mail = String(email || "").trim();
    // Optional: Apple Pay and Google Pay usually supply it, and the card form asks for it. Without one there is no receipt.
    if (mail && (!EMAIL.test(mail) || mail.length > 160)) return { status: 400, json: { ok: false, error: "bad_email", message: "That email address doesn't look right." } };
    // The wording is recorded in the language the customer saw it in.
    const text = lang === "ar" ? consentTextAr(config) : consentText(config);
    if (consent !== true) return { status: 400, json: { ok: false, error: "consent_required", message: "Please tick the box to agree." } };
    if (seen !== consentVersion(text)) return { status: 409, json: { ok: false, error: "terms_changed" } };

    // Global brake on unpaid starts, so a flood of requests cannot create unlimited Stripe customers.
    const recent = await store.list({ statuses: [S.CREATED], since: iso(now() - 10 * 60 * 1000), limit: 200 });
    if (recent.length >= 60) return { status: 429, json: { ok: false, error: "busy" } };

    // Never take payment from a machine that cannot lend a power bank (spec 2, step 2).
    let cab;
    try { cab = await supplier.checkCabinet(station.deviceId); } catch (e) { return { status: 409, json: { ok: false, error: "unavailable" } }; }
    if (!canRent(cab, config.minBatteryVol)) return { status: 409, json: { ok: false, error: "unavailable" } };

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("base64url");
    const row = await store.insert({
      id, created_at: iso(), updated_at: iso(), station: station.code, device_id: station.deviceId, status: S.CREATED,
      access_hash: sha256(token), email: mail || null, consent_text: text, consent_version: seen, consent_at: iso(),
      paid_pence: 0, fee_pence: 0, charged_extra_pence: 0, settle_attempts: 0, refunded_pence: 0, close_attempts: 0, flags: [], history: [{ at: iso(), text: "rental created" }],
    });
    try {
      const customer = await stripe.createCustomer({ email: mail || undefined, rentalId: id });
      const pi = await stripe.createFirstPayment({
        amount: p.firstChargePence, currency: config.currency, customer: customer.id, rentalId: id, email: mail || undefined,
        description: `Procura power bank rental, first hour (${station.code})`,
      });
      const saved = await store.update(id, { stripe_customer_id: customer.id, stripe_payment_intent_id: pi.id, history: history(row, "payment started") }, { status: S.CREATED });
      if (!saved) throw new Error("rental changed while starting");
      return { status: 200, json: { ok: true, rentalId: id, token, clientSecret: pi.client_secret } };
    } catch (e) {
      log("stripe", `could not start payment: ${brief(e)}`);
      await store.update(id, { status: S.ABANDONED, last_error: brief(e), history: history(row, "payment could not be started") }, { status: S.CREATED }).catch(() => {});
      return { status: 502, json: { ok: false, error: "payment_unavailable" } };
    }
  }

  async function getStatus({ id, token }) {
    const row = await ownedRental(id, token);
    if (!row) return { status: 404, json: { ok: false, error: "not_found" } };
    let fresh = row;
    // While the page waits for the payment, ask Stripe directly instead of relying only on the webhook.
    if (row.status === S.CREATED) fresh = (await checkPaidWithStripe(row, "checked while the page waited").catch(() => null)) || row;
    // The page polls this while it waits, so use the poll to move a release along without waiting for the scheduled job.
    if (row.status === S.RELEASING && now() - (ms(row.last_polled_at) || 0) >= 2000) fresh = (await refreshRelease(row).catch(() => null)) || (await store.get(id)) || row;
    return { status: 200, json: { ok: true, ...publicView(fresh) } };
  }

  async function ownedRental(id, token) {
    if (!/^[0-9a-f-]{36}$/.test(String(id || "")) || !token) return null;
    const row = await store.get(id);
    return row && same(row.access_hash, sha256(token)) ? row : null;
  }

  // What the customer's browser may see. No supplier order number, no Stripe ids, no internals.
  function publicView(row) {
    const view = {
      state: customerState(row), station: (config.stations[row.station] || {}).name || row.station,
      paidPence: row.paid_pence || 0, maxRentPence: p.maxRentPence, pricePerHourPence: p.pricePerHourPence, cutoffAt: row.cutoff_at || null, releasedAt: row.released_at || null,
      totalPence: [S.SETTLED, S.EXPIRED_CHARGED, S.PAYMENT_FAILED].includes(row.status) ? (row.paid_pence || 0) + (row.charged_extra_pence || 0) : null,
      duePence: row.status === S.PAYMENT_FAILED ? row.due_pence || 0 : null, refundedPence: row.refunded_pence || 0,
      cutoffLabel: publicPricing(config).cutoffLabel, cutoffMs: cutoffMs(config),
    };
    return view;
  }

  function customerState(row) {
    switch (row.status) {
      case S.CREATED: return "awaiting_payment";
      case S.PAID: case S.RELEASING: return "releasing";
      case S.ACTIVE: return "active";
      case S.RETURNED: case S.SETTLED: return "returned";
      case S.REFUNDING: case S.RELEASE_FAILED_REFUNDED: return row.status === S.REFUNDING ? "refunding" : "refunded";
      case S.EXPIRED: case S.EXPIRED_CHARGED: return "expired";
      case S.PAYMENT_FAILED: return row.settle_kind === "cutoff" ? "expired_unpaid" : "returned_unpaid";
      default: return "closed";
    }
  }

  // Optional receipt, asked for after paying: saves the email and has Stripe email the receipt for each charge so far.
  // Later charges on this rental also send their receipt to it.
  async function sendReceipt({ id, token, email }) {
    const row = await ownedRental(id, token);
    if (!row) return { status: 404, json: { ok: false, error: "not_found" } };
    const mail = String(email || "").trim();
    if (!EMAIL.test(mail) || mail.length > 160) return { status: 400, json: { ok: false, error: "bad_email" } };
    await store.update(row.id, { email: mail, history: history(row, "receipt email added") });
    try {
      if (row.stripe_customer_id) await stripe.updateCustomer(row.stripe_customer_id, { email: mail });
      for (const piId of [row.paid_pence > 0 ? row.stripe_payment_intent_id : null, row.settle_pi_id]) {
        if (!piId) continue;
        const pi = await stripe.retrievePaymentIntent(piId);
        const charge = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge && pi.latest_charge.id;
        if (charge && pi.status === "succeeded") await stripe.updateChargeReceipt(charge, mail);
      }
    } catch (e) {
      log("stripe", `receipt for ${row.id} failed: ${brief(e)}`);
      return { status: 502, json: { ok: false, error: "receipt_failed" } };
    }
    return { status: 200, json: { ok: true } };
  }

  // ---- Stripe webhook ---------------------------------------------------------------------------------------

  // rawBody must be the exact bytes Stripe sent. Returns { status, body } for the HTTP layer.
  async function handleStripeWebhook(rawBody, signature) {
    let event;
    try { event = verifyWebhook(rawBody, signature, config.stripe.webhookSecret, { nowMs: now() }); }
    catch (e) { return { status: 400, body: "invalid signature" }; }
    if (!event || typeof event.id !== "string" || !event.type) return { status: 400, body: "bad event" };

    const claim = await store.claimEvent(event.id, event.type);
    if (claim === "done") return { status: 200, body: "already handled" };
    if (claim === "busy") return { status: 409, body: "being handled" }; // Stripe will try again shortly
    try {
      await dispatch(event);
      await store.finishEvent(event.id);
      return { status: 200, body: "ok" };
    } catch (e) {
      log("webhook", `${event.type} ${event.id} failed: ${brief(e)}`);
      await store.abandonEvent(event.id).catch(() => {});
      return { status: 500, body: "try again" };
    }
  }

  async function dispatch(event) {
    const obj = event.data && event.data.object;
    if (!obj) return;
    if (event.type === "payment_intent.succeeded") {
      if (!obj.metadata || obj.metadata.kind !== "first_hour") return; // a later charge: nothing to release
      const row = await store.findByPaymentIntent(obj.id);
      if (!row) { log("webhook", `payment ${obj.id} has no rental`); return; }
      await onFirstPayment(row, obj);
    } else if (event.type === "charge.dispute.created" && obj.payment_intent) {
      const row = await store.findByPaymentIntent(obj.payment_intent);
      if (row) await store.update(row.id, { flags: flagged(row, "disputed"), history: history(row, "dispute opened by the card issuer") });
    }
  }

  async function onFirstPayment(row, pi, source = "webhook") {
    const paid = await store.update(row.id, {
      status: S.PAID, paid_pence: Number(pi.amount_received) || Number(pi.amount) || 0, paid_at: iso(),
      stripe_payment_method_id: typeof pi.payment_method === "string" ? pi.payment_method : null,
      history: history(row, source === "webhook" ? "payment confirmed by Stripe" : `payment confirmed by Stripe (${source})`),
    }, { status: S.CREATED });
    if (paid) return startRelease(paid);
    // Not "created" any more: either this event was delivered twice (do nothing), or the rental had been given
    // up on before the money arrived (return the money).
    const now2 = await store.get(row.id);
    if (now2 && now2.status === S.ABANDONED) {
      const moved = await store.update(row.id, { status: S.REFUNDING, paid_pence: Number(pi.amount_received) || 0, last_error: "paid after the rental was given up", flags: flagged(now2, "late_payment"), history: history(now2, "payment arrived after the rental was given up, refunding") }, { status: S.ABANDONED });
      if (moved) await finishRefund(moved);
    }
  }

  // Asks Stripe directly whether a started rental's first payment has gone through, so a power bank comes out even
  // when the webhook is late, misconfigured or never arrives (seen on 16 Nov 2026: paid, and no webhook delivered).
  // The payment is read from Stripe with our own secret key, by the id we created and stored for this rental, and
  // must be the first-hour payment for this rental, succeeded, for at least the first-hour amount. The phone's word
  // is never taken. onFirstPayment only moves a rental that is still "created", so this and the webhook cannot both
  // release: whichever comes first wins and the other does nothing.
  // Only soon after the payment started: 10 minutes while the customer's page is open and waiting, 3 minutes from the
  // scheduled job (the page was closed, so the customer may have walked away). After that, the stale sweep refunds,
  // rather than pushing a power bank out to nobody.
  const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
  const JOB_CONFIRM_WINDOW_MS = 3 * 60 * 1000;
  const lastPaidCheck = new Map(); // rental id -> time of the last check, so a waiting page does not ask too often
  async function checkPaidWithStripe(row, source, windowMs = CONFIRM_WINDOW_MS) {
    if (!row || row.status !== S.CREATED || !row.stripe_payment_intent_id) return row;
    if (now() - (ms(row.created_at) || 0) > windowMs) return row;
    if (now() - (lastPaidCheck.get(row.id) || 0) < 1500) return row;
    lastPaidCheck.set(row.id, now());
    if (lastPaidCheck.size > 500) lastPaidCheck.clear();
    let pi;
    try { pi = await stripe.retrievePaymentIntent(row.stripe_payment_intent_id); }
    catch (e) { log("stripe", `payment check for ${row.id} failed: ${brief(e)}`); return row; }
    if (!pi || pi.id !== row.stripe_payment_intent_id || pi.status !== "succeeded") return row;
    if (!pi.metadata || pi.metadata.rental_id !== row.id || pi.metadata.kind !== "first_hour") return row;
    if ((Number(pi.amount_received) || 0) < p.firstChargePence) return row;
    await onFirstPayment(row, pi, source);
    return (await store.get(row.id)) || row;
  }

  // ---- Release (spec 5.3 and 6) -----------------------------------------------------------------------------

  async function startRelease(paidRow) {
    const releasing = await store.update(paidRow.id, { status: S.RELEASING, release_requested_at: iso(), history: history(paidRow, "asking the machine to release") }, { status: S.PAID });
    if (!releasing) return null; // another caller already owns this step: never ask twice
    const callbackURL = `${config.siteUrl}/api/bajie/callback/${config.supplier.callbackSecretPath || "none"}/${paidRow.id}`;
    try {
      const { tradeNo } = await supplier.createOrder(paidRow.device_id, callbackURL);
      const saved = await store.update(paidRow.id, { trade_no: tradeNo, history: history(releasing, "supplier order created") }, { status: S.RELEASING });
      if (!saved) await supplier.closeOrder(tradeNo).catch(() => {}); // the rental moved on while the order was being made
      return saved;
    } catch (e) {
      if (e.definitive) {
        log("supplier", `release refused: ${brief(e)}`);
        return beginRefund(releasing, [S.RELEASING], `the machine refused the release: ${brief(e)}`);
      }
      // We do not know whether the order was made. Never retry the order (it could release twice).
      // The 60 second rule below ends this safely.
      await store.update(paidRow.id, { last_error: brief(e), history: history(releasing, `order result unknown: ${brief(e)}`) }, { status: S.RELEASING });
      return releasing;
    }
  }

  // Moves a releasing rental forward: confirmed (active), still waiting, or failed (refund).
  async function refreshRelease(row) {
    if (row.status !== S.RELEASING) return row;
    const age = now() - (ms(row.release_requested_at) || now());
    let detail = null, lastError = null;
    if (row.trade_no) {
      try { detail = await supplier.getOrderDetail(row.trade_no); } catch (e) { lastError = brief(e); }
    }
    if (detail && detail.borrowTime) {
      const started = now();
      const active = await store.update(row.id, {
        status: S.ACTIVE, released_at: iso(started), borrow_time: iso(detail.borrowTime), cutoff_at: iso(started + cutoffMs(config)),
        last_detail: detail.detail, last_polled_at: iso(), last_error: null, history: history(row, "power bank released"),
      }, { status: S.RELEASING });
      return active || (await store.get(row.id));
    }
    if (age >= releaseTimeoutMs) {
      return beginRefund(row, [S.RELEASING], `no confirmation from the machine within ${config.timing.releaseTimeoutSeconds} seconds`);
    }
    const patch = { last_polled_at: iso() };
    if (detail) patch.last_detail = detail.detail;
    if (lastError) patch.last_error = lastError;
    // Spec 5.4: if nothing has arrived after about 15 seconds, ask the supplier to send the result again.
    if (row.trade_no && age >= 15000 && !(row.flags || []).includes("requeried")) {
      try { await supplier.requeryOrder(row.trade_no); patch.flags = flagged(row, "requeried"); } catch (e) { /* the poll above is what we rely on */ }
    }
    return (await store.update(row.id, patch, { status: S.RELEASING })) || (await store.get(row.id));
  }

  // ---- Refund (spec 6, 7) -----------------------------------------------------------------------------------

  async function beginRefund(row, fromStatuses, reason) {
    const moved = await store.update(row.id, { status: S.REFUNDING, last_error: String(reason).slice(0, 200), history: history(row, `refunding: ${reason}`) }, { status: fromStatuses });
    return moved ? finishRefund(moved) : store.get(row.id);
  }

  async function finishRefund(row) {
    const epoch = row.key_epoch || 0;
    let refund;
    try {
      refund = await stripe.createRefund({ paymentIntent: row.stripe_payment_intent_id, rentalId: row.id, key: `refund-${row.id}-${epoch}` });
    } catch (e) {
      if (e.code === "charge_already_refunded") refund = { id: "already_refunded", amount: row.paid_pence };
      else {
        const patch = { last_error: `refund failed: ${brief(e)}` };
        if (e.status >= 500) {
          // Stripe may remember a server error against the key. Check the refund did not actually go through,
          // then use a new key next time. Never move the key without checking, or a refund could be paid twice.
          const existing = await stripe.listRefunds(row.stripe_payment_intent_id).then((l) => l.find((r) => r.status !== "failed" && r.status !== "canceled")).catch(() => null);
          if (existing) refund = existing; else patch.key_epoch = epoch + 1;
        }
        if (!refund) { await store.update(row.id, patch, { status: S.REFUNDING }); log("stripe", `refund failed for ${row.id}: ${brief(e)}`); return row; }
      }
    }
    const done = await store.update(row.id, {
      status: S.RELEASE_FAILED_REFUNDED, refund_id: refund.id, refunded_pence: refund.amount || row.paid_pence, history: history(row, "refunded"),
    }, { status: S.REFUNDING });
    const final = done || (await store.get(row.id));
    if (final && final.trade_no && !final.supplier_closed_at) await tryClose(final);
    return (await store.get(row.id)) || final;
  }

  // ---- Return, cut-off and settlement (spec 5.5, 5.6, 6) ----------------------------------------------------

  // Looks at one open rental on the machine. Returns the rental as it is afterwards.
  async function pollActive(row) {
    if (row.status !== S.ACTIVE) return row;
    let detail;
    try { detail = await supplier.getOrderDetail(row.trade_no); }
    catch (e) {
      // The machine or the supplier is unreachable. Keep waiting: never charge on something we could not confirm.
      await store.update(row.id, { last_error: brief(e), last_polled_at: iso() }, { status: S.ACTIVE });
      return row;
    }
    const seen = await store.update(row.id, { last_polled_at: iso(), last_detail: detail.detail, last_error: null }, { status: S.ACTIVE });
    if (!seen) return store.get(row.id);
    row = seen;
    const borrowMs = detail.borrowTime || ms(row.borrow_time);
    if (detail.returnTime) {
      const duration = Math.max(0, detail.returnTime - borrowMs);
      // Back after the cut-off time: the rule is the same as for one that never came back.
      if (duration > cutoffMs(config)) return enterCutoff(row, detail, borrowMs, "returned after the cut-off");
      const { rentPence, duePence } = returnSettlement(duration, row.paid_pence, p);
      const returned = await store.update(row.id, {
        status: S.RETURNED, settle_kind: "return", return_time: iso(detail.returnTime), borrow_time: iso(borrowMs),
        rent_pence: rentPence, due_pence: duePence, fee_pence: 0, settle_attempts: 0, next_attempt_at: iso(),
        history: history(row, `power bank returned, ${money(rentPence)} rent, ${money(duePence)} still to charge`),
      }, { status: S.ACTIVE });
      return returned ? settle(returned) : store.get(row.id);
    }
    if (now() >= ms(row.cutoff_at)) return enterCutoff(row, detail, borrowMs, `not returned within ${config.pricing.cutoffHours} hours`);
    return row;
  }

  async function enterCutoff(row, detail, borrowMs, why) {
    const { rentPence, feePence, duePence } = cutoffSettlement(cutoffMs(config), row.paid_pence, p);
    const expired = await store.update(row.id, {
      status: S.EXPIRED, settle_kind: "cutoff", borrow_time: iso(borrowMs), return_time: detail.returnTime ? iso(detail.returnTime) : null,
      rent_pence: rentPence, fee_pence: feePence, due_pence: duePence, settle_attempts: 0, next_attempt_at: iso(),
      history: history(row, `${why}: ${money(rentPence)} rent plus ${money(feePence)} fee, ${money(duePence)} to charge`),
    }, { status: S.ACTIVE });
    return expired ? settle(expired) : store.get(row.id);
  }

  // Charges what is still owed on a returned or expired rental, once, with retries only after a decline.
  async function settle(row) {
    if (row.status !== S.RETURNED && row.status !== S.EXPIRED) return row;
    const okStatus = row.status === S.RETURNED ? S.SETTLED : S.EXPIRED_CHARGED;
    const kind = row.settle_kind === "cutoff" ? "cutoff" : "return";
    const due = row.due_pence || 0;

    // Whatever else happens, the customer is never billed past the limits.
    const limit = kind === "cutoff" ? maxTotalPence(p) : p.maxRentPence;
    if ((row.paid_pence || 0) + (row.charged_extra_pence || 0) + due > Math.max(limit, row.paid_pence || 0)) {
      await store.update(row.id, { last_error: "charge would go past the limit, not charged", flags: flagged(row, "cap_blocked") }, { status: row.status });
      log("cap", `blocked a charge on ${row.id}`);
      return row;
    }
    if (due <= 0) return finishSettlement(row, okStatus, { settle_pi_id: null });

    if (!row.stripe_customer_id || !row.stripe_payment_method_id) {
      return finishSettlement(row, S.PAYMENT_FAILED, { last_error: "no saved card to charge", flags: flagged(row, "no_saved_card") });
    }
    let result;
    try {
      result = await stripe.chargeOffSession({
        amount: due, currency: config.currency, customer: row.stripe_customer_id, paymentMethod: row.stripe_payment_method_id,
        rentalId: row.id, kind, email: row.email,
        description: kind === "cutoff" ? `Procura power bank not returned (${row.station})` : `Procura power bank rental, extra time (${row.station})`,
        key: `settle-${row.id}-${row.settle_attempts || 0}-${row.key_epoch || 0}`, // same key until a decline is recorded, so a retry can never charge twice
      });
    } catch (e) {
      const patch = { last_error: `charge outcome unknown: ${brief(e)}` };
      if (e.status >= 500) {
        // Stripe may remember a server error against the key. Look for a charge that did go through before using a new key.
        const found = await stripe.findChargeForRental({ customer: row.stripe_customer_id, rentalId: row.id, kind }).catch(() => null);
        if (found) return finishSettlement(row, okStatus, { charged_extra_pence: found.amount_received || due, settle_pi_id: found.id, last_error: null });
        patch.key_epoch = (row.key_epoch || 0) + 1;
      }
      await store.update(row.id, patch, { status: row.status });
      return row; // the next run tries again (same key after a timeout, a new one only after a checked server error)
    }
    if (result.ok) return finishSettlement(row, okStatus, { charged_extra_pence: due, settle_pi_id: result.paymentIntent.id, last_error: null });

    const attempts = (row.settle_attempts || 0) + 1;
    const giveUp = attempts >= config.timing.settleMaxAttempts || result.requiresAction;
    const note = `charge declined (${result.declineCode || result.code || "declined"}), attempt ${attempts} of ${config.timing.settleMaxAttempts}`;
    if (giveUp) {
      return finishSettlement(row, S.PAYMENT_FAILED, {
        settle_attempts: attempts, last_error: note, settle_pi_id: result.paymentIntentId || null,
        flags: result.requiresAction ? flagged(row, "needs_customer_authentication") : row.flags,
      });
    }
    const retried = await store.update(row.id, {
      settle_attempts: attempts, next_attempt_at: iso(now() + config.timing.settleRetryMinutes * 60000), last_error: note, history: history(row, note),
    }, { status: row.status, settle_attempts: row.settle_attempts || 0 });
    return retried || store.get(row.id);
  }

  async function finishSettlement(row, status, patch) {
    const done = await store.update(row.id, { ...patch, status, history: history(row, status === S.PAYMENT_FAILED ? `payment failed: ${patch.last_error || ""}` : "settled") }, { status: row.status, settle_attempts: row.settle_attempts || 0 });
    const fresh = done || (await store.get(row.id));
    if (fresh && fresh.trade_no && !fresh.supplier_closed_at) await tryClose(fresh);
    return (await store.get(row.id)) || fresh;
  }

  // Spec 5.6: close the order on the supplier's side. A failure here never undoes a settlement; it is retried.
  async function tryClose(row) {
    try {
      await supplier.closeOrder(row.trade_no);
      await store.update(row.id, { supplier_closed_at: iso(), close_error: null });
    } catch (e) {
      await store.update(row.id, { close_attempts: (row.close_attempts || 0) + 1, close_error: brief(e) });
    }
  }

  // ---- A hint from the supplier's callback ------------------------------------------------------------------

  // The callback has no authentication, so its content is not believed. It only prompts a fresh look at the order.
  async function handleSupplierHint(rentalId, bodyText) {
    if (!/^[0-9a-f-]{36}$/.test(String(rentalId || ""))) return;
    const row = await store.get(rentalId);
    if (!row) return;
    const samples = (row.history || []).filter((h) => h.text.startsWith("callback:")).length;
    if (samples < 4) await store.update(row.id, { history: history(row, `callback: ${String(bodyText || "").replace(/\s+/g, " ").slice(0, 200)}`) });
    const fresh = (await store.get(row.id)) || row;
    if (fresh.status === S.RELEASING) await refreshRelease(fresh).catch(() => {});
    else if (fresh.status === S.ACTIVE) await pollActive(fresh).catch(() => {});
  }

  // ---- The scheduled job (runs every minute) -----------------------------------------------------------------

  async function runJobs({ budgetMs = 24000 } = {}) {
    const started = now();
    const out = { releasing: 0, active: 0, settled: 0, refunds: 0, closed: 0, stale: 0, errors: [] };
    const room = () => now() - started < budgetMs;
    const step = async (name, fn) => { try { await fn(); } catch (e) { out.errors.push(`${name}: ${brief(e)}`); log("job", `${name}: ${brief(e)}`); } };

    // Payments started in the last few minutes: confirm with Stripe directly, in case the webhook has not come
    // (and the customer closed the page, so nothing else is asking).
    await step("confirm", async () => {
      const recent = await store.list({ statuses: [S.CREATED], since: iso(now() - JOB_CONFIRM_WINDOW_MS), limit: 20 });
      for (const row of recent) {
        if (!room()) break;
        if (!row.stripe_payment_intent_id) continue;
        const after = await checkPaidWithStripe(row, "checked by the scheduled job", JOB_CONFIRM_WINDOW_MS);
        if (after && after.status !== S.CREATED) out.releasing++;
      }
    });
    await step("releasing", async () => {
      for (const row of await store.list({ statuses: [S.PAID, S.RELEASING], limit: 50 })) {
        if (!room()) break;
        if (row.status === S.PAID && now() - (ms(row.paid_at) || 0) > 120000) { await startRelease(row); out.releasing++; } // a webhook that died after saving "paid"
        else if (row.status === S.RELEASING) { await refreshRelease(row); out.releasing++; }
      }
    });
    await step("refunds", async () => {
      for (const row of await store.list({ statuses: [S.REFUNDING], limit: 50 })) { if (!room()) break; await finishRefund(row); out.refunds++; }
    });
    await step("active", async () => {
      for (const row of await store.list({ statuses: [S.ACTIVE], limit: 100 })) {
        if (!room()) break;
        if (now() - (ms(row.last_polled_at) || 0) < config.timing.pollIntervalSeconds * 1000 - 5000) continue;
        await pollActive(row); out.active++;
      }
    });
    await step("settle", async () => {
      for (const row of await store.list({ statuses: [S.RETURNED, S.EXPIRED], limit: 50 })) {
        if (!room()) break;
        if ((ms(row.next_attempt_at) || 0) <= now()) { await settle(row); out.settled++; }
      }
    });
    await step("close", async () => {
      const rows = await store.list({ statuses: [S.SETTLED, S.EXPIRED_CHARGED, S.RELEASE_FAILED_REFUNDED, S.PAYMENT_FAILED], since: iso(now() - 3 * 86400000), limit: 100 });
      for (const row of rows) {
        if (!room()) break;
        if (row.trade_no && !row.supplier_closed_at && (row.close_attempts || 0) < config.timing.closeMaxAttempts) { await tryClose(row); out.closed++; }
      }
    });
    await step("stale", async () => {
      const cutoff = now() - config.timing.staleUnpaidMinutes * 60000;
      let n = 0;
      for (const row of await store.list({ statuses: [S.CREATED], limit: 100 })) {
        if (!room() || n >= 10) break;
        if (ms(row.created_at) > cutoff) continue;
        n++; out.stale++;
        await sweepUnpaid(row);
      }
    });
    return out;
  }

  // A rental that was started but never confirmed as paid. The money is checked with Stripe directly,
  // but a power bank is still only ever released from the webhook: if a payment turns up here, it is refunded.
  async function sweepUnpaid(row) {
    if (!row.stripe_payment_intent_id) {
      await store.update(row.id, { status: S.ABANDONED, history: history(row, "never reached payment") }, { status: S.CREATED });
      return;
    }
    const pi = await stripe.retrievePaymentIntent(row.stripe_payment_intent_id);
    if (pi.status === "succeeded") {
      const moved = await store.update(row.id, {
        status: S.REFUNDING, paid_pence: Number(pi.amount_received) || 0, last_error: "paid, but the payment webhook never arrived",
        flags: flagged(row, "webhook_missed"), history: history(row, "paid, but no webhook: refunding"),
      }, { status: S.CREATED });
      if (moved) await finishRefund(moved);
      return;
    }
    await store.update(row.id, { status: S.ABANDONED, history: history(row, "not paid in time") }, { status: S.CREATED });
    if (pi.status !== "canceled" && stripe.cancelPaymentIntent) await stripe.cancelPaymentIntent(pi.id, row.id).catch(() => {});
  }

  // ---- Admin ------------------------------------------------------------------------------------------------

  async function adminOverview({ days = 30 } = {}) {
    const rows = await store.list({ since: iso(now() - days * 86400000), limit: 500 });
    const t = now();
    const attention = [];
    for (const r of rows) {
      const why = [];
      if (r.status === S.PAYMENT_FAILED) why.push(`payment failed: ${money(r.due_pence || 0)} still owed`);
      if (r.status === S.REFUNDING) why.push("refund not completed yet");
      if (r.status === S.ACTIVE && ms(r.cutoff_at) < t - 30 * 60000) why.push("past the cut-off and not settled (supplier unreachable?)");
      if (r.status === S.CREATED && ms(r.created_at) < t - 10 * 60000) why.push("started but not confirmed as paid");
      if (r.status === S.RELEASING && ms(r.release_requested_at) < t - 5 * 60000) why.push("still releasing after 5 minutes");
      if ((r.flags || []).length) why.push(`flags: ${r.flags.join(", ")}`);
      if (r.close_error && !r.supplier_closed_at && (r.close_attempts || 0) >= config.timing.closeMaxAttempts) why.push("could not close the supplier order");
      if (why.length) attention.push({ rental: r, why });
    }
    return {
      attention,
      open: rows.filter((r) => OPEN.includes(r.status)).sort((a, b) => ms(a.created_at) - ms(b.created_at)),
      failed: rows.filter((r) => r.status === S.PAYMENT_FAILED),
      refunds: rows.filter((r) => r.status === S.RELEASE_FAILED_REFUNDED || r.status === S.REFUNDING),
      recent: rows.filter((r) => TERMINAL.has(r.status) && r.status !== S.ABANDONED).slice(0, 50),
      stripeMode: stripe.mode || "test",
    };
  }

  return {
    getStation, startRental, getStatus, sendReceipt, handleStripeWebhook, handleSupplierHint, runJobs, adminOverview, stationDiagnostics, stripeCheck,
    // exposed for tests and the admin page
    refreshRelease, pollActive, settle, finishRefund, publicView, customerState,
  };
}

module.exports = { createService, sha256 };
