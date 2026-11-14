"use strict";
// The password-protected rentals list at /admin. Server-rendered HTML, no scripts.
const { getRuntime } = require("../../lib/rental/runtime");
const { adminApi, ipOf, toNetlify } = require("../../lib/rental/http");
const { renderAdmin } = require("../../lib/rental/admin-html");

exports.handler = async (event) => toNetlify(await adminApi(getRuntime(), {
  method: event.httpMethod, headers: event.headers || {}, ip: ipOf(event), render: renderAdmin,
}));
