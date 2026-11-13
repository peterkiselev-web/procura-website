"use strict";
// Rental states. The first five are the happy path from the spec. The rest are end states, plus two internal
// ones (refunding, expired) that exist so that a refund or a cut-off charge can be retried safely.
const S = {
  CREATED: "created",
  PAID: "paid",
  RELEASING: "releasing",
  ACTIVE: "active",
  RETURNED: "returned",
  SETTLED: "settled",
  REFUNDING: "refunding",
  RELEASE_FAILED_REFUNDED: "release_failed_refunded",
  EXPIRED: "expired",
  EXPIRED_CHARGED: "expired_charged",
  PAYMENT_FAILED: "payment_failed",
  ABANDONED: "abandoned",
};

const TERMINAL = new Set([S.SETTLED, S.RELEASE_FAILED_REFUNDED, S.EXPIRED_CHARGED, S.PAYMENT_FAILED, S.ABANDONED]);
// A rental the machine may still be out on, or that still needs work from the scheduled job.
const OPEN = [S.PAID, S.RELEASING, S.ACTIVE, S.RETURNED, S.EXPIRED, S.REFUNDING];

const NEXT = {
  [S.CREATED]: [S.PAID, S.ABANDONED, S.REFUNDING],
  [S.PAID]: [S.RELEASING, S.REFUNDING],
  [S.RELEASING]: [S.ACTIVE, S.REFUNDING],
  [S.ACTIVE]: [S.RETURNED, S.EXPIRED],
  [S.RETURNED]: [S.SETTLED, S.PAYMENT_FAILED],
  [S.EXPIRED]: [S.EXPIRED_CHARGED, S.PAYMENT_FAILED],
  [S.REFUNDING]: [S.RELEASE_FAILED_REFUNDED],
  [S.SETTLED]: [], [S.RELEASE_FAILED_REFUNDED]: [], [S.EXPIRED_CHARGED]: [], [S.PAYMENT_FAILED]: [], [S.ABANDONED]: [],
};

const canMove = (from, to) => (NEXT[from] || []).includes(to);

module.exports = { S, TERMINAL, OPEN, NEXT, canMove };
