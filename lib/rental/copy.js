"use strict";
// Customer-facing wording that states the money rules. It is built from the pricing config, so the page, the
// consent record and the terms page can never disagree with what the server actually charges.
const crypto = require("crypto");
const { money, maxTotalPence } = require("./pricing");
const { cutoffMs } = require("./config");

function cutoffLabel(cfg) {
  const ms = cutoffMs(cfg);
  const hours = ms / 3600000;
  if (Number.isInteger(hours)) return hours === 1 ? "1 hour" : `${hours} hours`;
  const minutes = Math.round(ms / 60000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function publicPricing(cfg) {
  const p = cfg.pricing;
  return {
    currency: cfg.currency,
    firstChargePence: p.firstChargePence,
    pricePerHourPence: p.pricePerHourPence,
    maxRentPence: p.maxRentPence,
    nonReturnFeePence: p.nonReturnFeePence,
    maxTotalPence: maxTotalPence(p),
    cutoffLabel: cutoffLabel(cfg),
    cutoffMs: cutoffMs(cfg),
  };
}

// The sentence the customer agrees to when paying. The exact text is saved against the rental.
function consentText(cfg) {
  const p = cfg.pricing;
  return `I agree to the rental terms. Procura Charge may charge this card ${money(p.firstChargePence)} now, and later, without me present, ` +
    `${money(p.pricePerHourPence)} for each further started hour (rent is never more than ${money(p.maxRentPence)}). ` +
    `If I have not returned the power bank within ${cutoffLabel(cfg)}, I will also be charged a ${money(p.nonReturnFeePence)} non-return fee, ` +
    `so the most I can be charged is ${money(maxTotalPence(p))}.`;
}

const consentVersion = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

// Plain facts for the terms page (filled in by build.js).
function termsTokens(cfg) {
  const p = cfg.pricing;
  return {
    "@@PRICE_PER_HOUR@@": money(p.pricePerHourPence),
    "@@FIRST_CHARGE@@": money(p.firstChargePence),
    "@@MAX_RENT@@": money(p.maxRentPence),
    "@@NON_RETURN_FEE@@": money(p.nonReturnFeePence),
    "@@MAX_TOTAL@@": money(maxTotalPence(p)),
    "@@CUTOFF@@": cutoffLabel(cfg),
    "@@CONSENT_TEXT@@": consentText(cfg),
  };
}

module.exports = { cutoffLabel, publicPricing, consentText, consentVersion, termsTokens };
