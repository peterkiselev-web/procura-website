"use strict";
// Receives the supplier's callback at /api/bajie/callback/<secret>/<rentalId>.
// The supplier sends no signature, so this is only ever a hint: the order is looked up again before anything changes.
const { getRuntime } = require("../../lib/rental/runtime");
const { supplierCallbackApi, rawBodyOf, toNetlify } = require("../../lib/rental/http");

exports.handler = async (event) => {
  const segs = String(event.path || "").split("/").filter(Boolean);
  const at = segs.lastIndexOf("callback") >= 0 ? segs.lastIndexOf("callback") : segs.lastIndexOf("bajie-callback");
  const [secret, rentalId] = segs.slice(at + 1);
  return toNetlify(await supplierCallbackApi(getRuntime(), {
    method: event.httpMethod, secret, rentalId, rawBody: rawBodyOf(event).slice(0, 4096), query: event.queryStringParameters || {},
  }));
};
