"use strict";
// Receives Stripe's events at /api/stripe/webhook. The signature is checked against the exact raw body.
const { getRuntime } = require("../../lib/rental/runtime");
const { stripeWebhookApi, rawBodyOf, toNetlify } = require("../../lib/rental/http");

exports.handler = async (event) => toNetlify(await stripeWebhookApi(getRuntime(), {
  method: event.httpMethod, rawBody: rawBodyOf(event), headers: event.headers || {},
}));
