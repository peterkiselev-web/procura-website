"use strict";
// Customer-facing wording that states the money rules. It is built from the pricing config, so the page, the
// consent record and the terms page can never disagree with what the server actually charges.
const crypto = require("crypto");
const { money, maxTotalPence } = require("./pricing");
const moneyPlain = money;
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

// Arabic number agreement: 1, 2, 3 to 10, and 11 or more take different forms.
function arCount(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  return n >= 3 && n <= 10 ? `${n} ${few}` : `${n} ${many}`;
}
function cutoffLabelAr(cfg) {
  const ms = cutoffMs(cfg);
  const hours = ms / 3600000;
  if (Number.isInteger(hours)) return arCount(hours, "ساعة واحدة", "ساعتين", "ساعات", "ساعة");
  return arCount(Math.round(ms / 60000), "دقيقة واحدة", "دقيقتين", "دقائق", "دقيقة");
}

// The same agreement in Arabic, for the Arabic version of the page. Have a native speaker check it.
function consentTextAr(cfg) {
  const p = cfg.pricing;
  // Each amount is wrapped in invisible left-to-right marks so it reads "£3.00" inside the Arabic sentence.
  const money = (pence) => "\u2066" + moneyPlain(pence) + "\u2069";
  return `أوافق على شروط الإيجار. يحق لشركة Procura Charge أن تخصم من هذه البطاقة ${money(p.firstChargePence)} الآن، ولاحقاً دون حضوري ${money(p.pricePerHourPence)} عن كل ساعة إضافية تبدأ (لا يتجاوز الإيجار ${money(p.maxRentPence)} أبداً). ` +
    `إذا لم أُعِد الباور بانك خلال ${cutoffLabelAr(cfg)}، فستُخصم مني أيضاً رسوم عدم إعادة قدرها ${money(p.nonReturnFeePence)}، وبذلك لا يتجاوز الحد الأقصى الذي يمكن خصمه مني ${money(maxTotalPence(p))}.`;
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

module.exports = { cutoffLabel, cutoffLabelAr, publicPricing, consentText, consentTextAr, consentVersion, termsTokens };
