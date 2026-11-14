"use strict";
// Pricing maths. Pure functions, integer pence, every number comes from the config passed in.
const HOUR_MS = 3600 * 1000;

// Hours billed for a rental of this length. Any started hour counts, and there is always at least one.
function startedHours(durationMs) {
  const ms = Math.max(0, Number(durationMs) || 0);
  return Math.max(1, Math.ceil(ms / HOUR_MS));
}

// Total rent for a rental of this length, capped.
function rentFor(durationMs, pricing) {
  return Math.min(pricing.maxRentPence, startedHours(durationMs) * pricing.pricePerHourPence);
}

// What is still to be charged when the power bank comes back. Never negative.
function returnSettlement(durationMs, paidPence, pricing) {
  const rentPence = Math.max(rentFor(durationMs, pricing), paidPence);
  return { rentPence, duePence: Math.max(0, rentPence - paidPence) };
}

// What is to be charged at the cut-off: the rent for the time up to the cut-off that is still owed, plus the fee.
function cutoffSettlement(cutoffDurationMs, paidPence, pricing) {
  const rentPence = Math.max(rentFor(cutoffDurationMs, pricing), paidPence);
  const feePence = pricing.nonReturnFeePence;
  return { rentPence, feePence, duePence: Math.max(0, rentPence - paidPence) + feePence };
}

// The most a customer can ever be billed for one rental.
function maxTotalPence(pricing) {
  return pricing.maxRentPence + pricing.nonReturnFeePence;
}

const pounds = (pence) => (pence / 100).toFixed(2);
const money = (pence) => "£" + pounds(pence);

module.exports = { startedHours, rentFor, returnSettlement, cutoffSettlement, maxTotalPence, pounds, money, HOUR_MS };
