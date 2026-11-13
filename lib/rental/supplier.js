"use strict";
// Client for the Bajie Charging open API (spec section 5). Server side only: the credentials never leave here.
// Every response is { code, msg, data } and code 0 means success. The calls are:
//   checkCabinet (5.2), createOrder (5.3), requeryOrder (5.4), getOrderDetail (5.5), closeOrder (5.6)
// How the credentials are presented is an open question (spec 12.6), so BAJIE_AUTH_MODE must be set explicitly:
//   basic_plain   HTTP Basic with the plain password
//   basic_sha256  HTTP Basic with the SHA-256 hex digest of the password
//   token         POST /oauth2/login with the digest, then send the returned token (header and prefix are settings)
const crypto = require("crypto");
const { parseSupplierTime } = require("./supplier-time");

const sha256hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const TRADE_NO = /^[A-Za-z0-9_.:-]{1,80}$/;

class SupplierError extends Error {
  // kind: "api" (supplier answered with a failure), "http" (non-2xx), "network" (no usable answer), "auth" or "shape"
  // definitive: true when we know the supplier did not act on the request, so it is safe to treat the call as failed.
  constructor(message, { kind, status, code, definitive = false } = {}) {
    super(message);
    this.name = "SupplierError";
    Object.assign(this, { kind, status, code, definitive });
  }
}

const truthy = (v) => v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";

function createBajieSupplier({ baseUrl, username, password, authMode, tokenHeader = "Authorization", tokenPrefix = "Bearer ", timeZone = "UTC", timeoutMs = 8000, fetchImpl = fetch }) {
  if (!["basic_plain", "basic_sha256", "token"].includes(authMode)) throw new Error("BAJIE_AUTH_MODE must be basic_plain, basic_sha256 or token");
  if (!username || !password) throw new Error("Supplier credentials are missing");
  let token = null;

  async function raw(method, path, { query, form, headers = {} } = {}) {
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetchImpl(baseUrl + path + qs, {
        method, signal: ctrl.signal, headers: { Accept: "application/json", ...headers },
        body: form ? new URLSearchParams(form).toString() : undefined,
      });
      text = await res.text();
    } catch (e) {
      throw new SupplierError(e.name === "AbortError" ? "supplier timed out" : "supplier unreachable", { kind: "network" });
    } finally { clearTimeout(timer); }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* handled below */ }
    if (!res.ok) throw new SupplierError(`supplier HTTP ${res.status}`, { kind: "http", status: res.status, definitive: res.status >= 400 && res.status < 500 });
    if (!json || typeof json !== "object") throw new SupplierError("supplier sent something that is not JSON", { kind: "shape" });
    return json;
  }

  async function login() {
    const j = await raw("POST", "/oauth2/login", { form: { username, password: sha256hex(password) }, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    if (Number(j.code) !== 0 || !j.token) throw new SupplierError("supplier login failed", { kind: "auth", code: j.code, definitive: true });
    token = String(j.token);
  }

  async function authHeaders() {
    if (authMode === "token") {
      if (!token) await login();
      return { [tokenHeader]: tokenPrefix + token };
    }
    const secret = authMode === "basic_sha256" ? sha256hex(password) : password;
    return { Authorization: "Basic " + Buffer.from(`${username}:${secret}`).toString("base64") };
  }

  // One call, with one re-login if a token has stopped working.
  async function call(method, path, query) {
    for (let attempt = 0; ; attempt++) {
      let j;
      try {
        j = await raw(method, path, { query, headers: await authHeaders() });
      } catch (e) {
        if (authMode === "token" && attempt === 0 && e.kind === "http" && (e.status === 401 || e.status === 403)) { token = null; continue; }
        throw e;
      }
      if (Number(j.code) !== 0) {
        const authish = /token|login|auth|expired|unauthor/i.test(String(j.msg || ""));
        if (authMode === "token" && attempt === 0 && authish) { token = null; continue; }
        throw new SupplierError(`supplier refused: ${String(j.msg || "no message").slice(0, 120)}`, { kind: authish ? "auth" : "api", code: j.code, definitive: true });
      }
      return j.data === undefined ? null : j.data;
    }
  }

  const tradeNoOk = (no) => { if (!TRADE_NO.test(String(no || ""))) throw new SupplierError("bad order number", { kind: "shape", definitive: true }); return String(no); };

  return {
    kind: "bajie",
    async checkCabinet(deviceId) {
      const data = await call("GET", "/rent/cabinet/query", { deviceId });
      const cab = (data && data.cabinet) || {};
      const batteries = Array.isArray(data && data.batteries) ? data.batteries.map((b) => ({ slot: b.slotNum, batteryId: b.batteryId, vol: Number(b.vol) })) : [];
      return { online: truthy(cab.isOnline), batteries, slots: cab.slots, emptySlots: cab.emptySlots, busySlots: cab.busySlots };
    },
    async createOrder(deviceId, callbackURL) {
      const data = await call("POST", "/rent/order/create", { deviceId, callbackURL });
      if (!data || !data.tradeNo) throw new SupplierError("order created but no order number came back", { kind: "shape" });
      return { tradeNo: tradeNoOk(data.tradeNo) };
    },
    async requeryOrder(tradeNo) { await call("POST", "/rent/order/query", { tradeNo: tradeNoOk(tradeNo) }); },
    async getOrderDetail(tradeNo) {
      const d = (await call("GET", "/rent/order/detail", { tradeNo: tradeNoOk(tradeNo) })) || {};
      const keep = ["orderId", "cabinetId", "batteryId", "borrowSlot", "borrowTime", "borrowStatus", "paymentStatus", "returnTime", "returnSlot", "returnCabinetId", "orderAmount", "deposit", "price", "priceMinute", "dailyMaxPrice", "freeMinutes", "autoSettleTime", "currency", "orderType"];
      const detail = {};
      for (const k of keep) if (d[k] !== undefined) detail[k] = d[k];
      return {
        borrowTime: parseSupplierTime(d.borrowTime, timeZone),
        returnTime: parseSupplierTime(d.returnTime, timeZone),
        borrowStatus: d.borrowStatus, paymentStatus: d.paymentStatus, detail,
      };
    },
    async closeOrder(tradeNo) { await call("POST", "/rent/order/close", { tradeNo: tradeNoOk(tradeNo) }); },
  };
}

// True when the machine is online and at least one battery is charged enough to rent.
function canRent(cabinet, minVol) {
  return Boolean(cabinet.online) && cabinet.batteries.some((b) => Number.isFinite(b.vol) && b.vol >= minVol);
}

module.exports = { createBajieSupplier, SupplierError, canRent, sha256hex };
