"use strict";
// In-memory store. For tests and local testing only: a serverless function forgets everything between calls,
// so this must never be used in production (config refuses it when CONTEXT=production).
// It behaves like the Supabase store: reads and writes are copies, updates are compare-and-set, and the
// payment intent and order number must be unique.
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const UNIQUE = ["id", "stripe_payment_intent_id", "trade_no"];
const EVENT_LEASE_MS = 5 * 60 * 1000;

function matches(row, expect) {
  return Object.entries(expect || {}).every(([k, v]) => {
    const have = row[k] === undefined ? null : row[k];
    if (Array.isArray(v)) return v.includes(have);
    return have === v;
  });
}

function createMemoryStore({ now = () => new Date() } = {}) {
  const rows = new Map();
  const events = new Map();
  const conflict = (what) => Object.assign(new Error(`duplicate ${what}`), { code: "conflict" });

  return {
    kind: "memory",
    async insert(row) {
      for (const col of UNIQUE) {
        if (row[col] != null && [...rows.values()].some((r) => r[col] === row[col])) throw conflict(col);
      }
      rows.set(row.id, clone(row));
      return clone(row);
    },
    async get(id) { return clone(rows.get(id)) || null; },
    async findByPaymentIntent(piId) { return clone([...rows.values()].find((r) => r.stripe_payment_intent_id === piId)) || null; },
    async findByTradeNo(no) { return clone([...rows.values()].find((r) => r.trade_no === no)) || null; },
    // Compare-and-set: changes the row only if every column in `expect` still has that value.
    // Returns the updated row, or null if the row is missing or has moved on.
    async update(id, patch, expect = {}) {
      const row = rows.get(id);
      if (!row || !matches(row, expect)) return null;
      if (patch.trade_no != null && [...rows.values()].some((r) => r.id !== id && r.trade_no === patch.trade_no)) throw conflict("trade_no");
      Object.assign(row, clone(patch), { updated_at: now().toISOString() });
      return clone(row);
    },
    async list({ statuses, since, limit = 200 } = {}) {
      let out = [...rows.values()];
      if (statuses) out = out.filter((r) => statuses.includes(r.status));
      if (since) out = out.filter((r) => Date.parse(r.created_at) >= Date.parse(since));
      out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return clone(out.slice(0, limit));
    },
    // Webhook idempotency on the Stripe event id: "new" means this caller should process it,
    // "done" means it was already handled, "busy" means another delivery is processing it right now.
    async claimEvent(id, type) {
      const have = events.get(id);
      if (!have) { events.set(id, { id, type, status: "processing", at: now().getTime() }); return "new"; }
      if (have.status === "done") return "done";
      if (now().getTime() - have.at > EVENT_LEASE_MS) { have.at = now().getTime(); return "new"; }
      return "busy";
    },
    async finishEvent(id) { const e = events.get(id); if (e) e.status = "done"; },
    async abandonEvent(id) { events.delete(id); },
    _rows: rows,
  };
}

module.exports = { createMemoryStore };
