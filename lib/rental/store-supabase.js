"use strict";
// Rental store on Supabase Postgres, reached through its REST interface (PostgREST) with the service role key.
// The key stays on the server. Updates are atomic compare-and-set: PATCH with filters on the current values,
// asking for the changed rows back, so two callers can never both win the same transition.
const SAFE = /^[A-Za-z0-9_:.\-]+$/;
const EVENT_LEASE_MS = 5 * 60 * 1000;

function createSupabaseStore({ url, key, fetchImpl = fetch, now = () => new Date() }) {
  if (!url || !key) throw new Error("Supabase URL and key are required");
  const base = `${url.replace(/\/+$/, "")}/rest/v1`;
  const headers = (extra) => ({ apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra });

  async function call(method, pathAndQuery, body, prefer) {
    const res = await fetchImpl(base + pathAndQuery, {
      method, headers: headers(prefer ? { Prefer: prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (res.status === 409 || (json && json.code === "23505")) throw Object.assign(new Error("duplicate"), { code: "conflict" });
    if (!res.ok) throw Object.assign(new Error(`Supabase ${method} ${pathAndQuery.split("?")[0]} failed with ${res.status}`), { code: "store_error", status: res.status });
    return json;
  }

  const safe = (v) => { if (!SAFE.test(String(v))) throw new Error("unsafe filter value"); return encodeURIComponent(v); };
  function filters(expect) {
    return Object.entries(expect || {}).map(([col, v]) => {
      if (!/^[a-z_]+$/.test(col)) throw new Error("unsafe column");
      if (v === null) return `${col}=is.null`;
      if (Array.isArray(v)) return `${col}=in.(${v.map((x) => safe(x)).join(",")})`;
      return `${col}=eq.${safe(v)}`;
    });
  }
  const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

  return {
    kind: "supabase",
    async insert(row) { return one(await call("POST", "/rentals", row, "return=representation")); },
    async get(id) { return one(await call("GET", `/rentals?${filters({ id }).join("&")}&select=*`)); },
    async findByPaymentIntent(piId) { return one(await call("GET", `/rentals?${filters({ stripe_payment_intent_id: piId }).join("&")}&select=*`)); },
    async findByTradeNo(no) { return one(await call("GET", `/rentals?${filters({ trade_no: no }).join("&")}&select=*`)); },
    async update(id, patch, expect = {}) {
      const q = filters({ id, ...expect }).join("&");
      return one(await call("PATCH", `/rentals?${q}`, { ...patch, updated_at: now().toISOString() }, "return=representation"));
    },
    async list({ statuses, since, limit = 200 } = {}) {
      const q = [];
      if (statuses) q.push(...filters({ status: statuses }));
      if (since) q.push(`created_at=gte.${encodeURIComponent(new Date(since).toISOString())}`);
      q.push("select=*", "order=created_at.desc", `limit=${Math.min(1000, Math.max(1, limit | 0))}`);
      return (await call("GET", `/rentals?${q.join("&")}`)) || [];
    },
    async claimEvent(id, type) {
      try {
        await call("POST", "/stripe_events", { id, type, status: "processing", created_at: now().toISOString() }, "return=minimal");
        return "new";
      } catch (e) {
        if (e.code !== "conflict") throw e;
      }
      const have = one(await call("GET", `/stripe_events?${filters({ id }).join("&")}&select=*`));
      if (!have) return "busy";
      if (have.status === "done") return "done";
      if (now().getTime() - Date.parse(have.created_at) > EVENT_LEASE_MS) {
        // Take over a delivery that was abandoned mid-way. Compare-and-set on the old timestamp so only one taker wins.
        const took = one(await call("PATCH", `/stripe_events?${filters({ id, status: "processing", created_at: have.created_at }).join("&")}`, { created_at: now().toISOString() }, "return=representation"));
        return took ? "new" : "busy";
      }
      return "busy";
    },
    async finishEvent(id) { await call("PATCH", `/stripe_events?${filters({ id }).join("&")}`, { status: "done" }, "return=minimal"); },
    async abandonEvent(id) { await call("DELETE", `/stripe_events?${filters({ id }).join("&")}`, undefined, "return=minimal"); },
  };
}

module.exports = { createSupabaseStore };
