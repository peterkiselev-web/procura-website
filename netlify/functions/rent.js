"use strict";
// Customer API for the QR rental page: /api/rent/station, /api/rent/start, /api/rent/status, /api/rent/staff.
const { getRuntime } = require("../../lib/rental/runtime");
const { rentApi, rawBodyOf, ipOf, toNetlify, json, MAX_JSON } = require("../../lib/rental/http");

exports.handler = async (event) => {
  const action = String(event.path || "").split("/").filter(Boolean).pop();
  let body = null;
  if (event.httpMethod === "POST") {
    const raw = rawBodyOf(event);
    if (raw.length > MAX_JSON) return toNetlify(json(413, { ok: false, error: "too_large" }));
    try { body = JSON.parse(raw || "{}"); } catch (e) { return toNetlify(json(400, { ok: false, error: "bad_request" })); }
  }
  return toNetlify(await rentApi(getRuntime(), { method: event.httpMethod, action, query: event.queryStringParameters || {}, body, ip: ipOf(event) }));
};
