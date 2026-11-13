"use strict";
// A fake of the supplier for local testing and automated tests. It follows the same interface as supplier.js
// and has controls to play out the situations in spec section 11 without a real machine.
const { SupplierError } = require("./supplier");

function createFakeSupplier({ now = () => Date.now(), releaseDelayMs = 0 } = {}) {
  const machines = new Map(); // deviceId -> { online, batteries }
  const orders = new Map();   // tradeNo -> order
  const log = [];
  let seq = 0;
  const control = { failNextCreate: null, neverRelease: false, releaseDelayMs, down: false, closeFails: false };

  const need = (deviceId) => { const m = machines.get(deviceId); if (!m) throw new SupplierError("supplier refused: device not found", { kind: "api", code: 1001, definitive: true }); return m; };
  const alive = () => { if (control.down) throw new SupplierError("supplier unreachable", { kind: "network" }); };

  return {
    kind: "fake",
    control,
    log,
    addMachine(deviceId, { online = true, charges = [80, 55] } = {}) {
      machines.set(deviceId, { online, batteries: charges.map((vol, i) => ({ slot: i + 1, batteryId: `B${deviceId}${i}`, vol })) });
    },
    setOnline(deviceId, online) { need(deviceId).online = online; },
    setCharges(deviceId, charges) { need(deviceId).batteries = charges.map((vol, i) => ({ slot: i + 1, batteryId: `B${deviceId}${i}`, vol })); },
    async checkCabinet(deviceId) {
      alive(); log.push(["checkCabinet", deviceId]);
      const m = need(deviceId);
      return { online: m.online, batteries: m.batteries.map((b) => ({ ...b })), slots: m.batteries.length, emptySlots: 0, busySlots: m.batteries.length };
    },
    async createOrder(deviceId, callbackURL) {
      alive(); log.push(["createOrder", deviceId, callbackURL]);
      const m = need(deviceId);
      if (control.failNextCreate) { const e = control.failNextCreate; control.failNextCreate = null; throw e; }
      if (!m.online) throw new SupplierError("supplier refused: cabinet offline", { kind: "api", code: 2001, definitive: true });
      const tradeNo = `T${Date.now().toString(36)}${++seq}`.toUpperCase();
      orders.set(tradeNo, { tradeNo, deviceId, createdAt: now(), borrowTime: null, returnTime: null, closed: false });
      return { tradeNo };
    },
    async requeryOrder(tradeNo) { alive(); log.push(["requeryOrder", tradeNo]); },
    async getOrderDetail(tradeNo) {
      alive(); log.push(["getOrderDetail", tradeNo]);
      const o = orders.get(tradeNo);
      if (!o) throw new SupplierError("supplier refused: order not found", { kind: "api", code: 1002, definitive: true });
      if (o.borrowTime === null && !control.neverRelease && now() - o.createdAt >= control.releaseDelayMs) o.borrowTime = now();
      return { borrowTime: o.borrowTime, returnTime: o.returnTime, borrowStatus: o.borrowTime ? 1 : 0, paymentStatus: o.closed ? 1 : 0, detail: { orderId: tradeNo, borrowStatus: o.borrowTime ? 1 : 0 } };
    },
    async closeOrder(tradeNo) {
      alive(); log.push(["closeOrder", tradeNo]);
      if (control.closeFails) throw new SupplierError("supplier HTTP 500", { kind: "http", status: 500 });
      const o = orders.get(tradeNo);
      if (!o) throw new SupplierError("supplier refused: order not found", { kind: "api", code: 1002, definitive: true });
      o.closed = true;
    },
    // Controls for tests and the local demo.
    simulateReturn(tradeNo, at = now()) { const o = orders.get(tradeNo); if (!o) throw new Error("no such order"); o.returnTime = at; },
    simulateBorrowAt(tradeNo, at) { const o = orders.get(tradeNo); if (!o) throw new Error("no such order"); o.borrowTime = at; },
    orders,
  };
}

module.exports = { createFakeSupplier };
