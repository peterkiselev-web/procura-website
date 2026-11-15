"use strict";
// The supplier's order times (borrowTime, returnTime) have no documented format. This accepts the likely ones:
//  - a number or numeric string: epoch milliseconds or epoch seconds
//  - an ISO string with an offset (2026-11-13T10:00:00Z or +00:00)
//  - a wall-clock string with no offset (2026-11-13 10:00:00), read in BAJIE_TIME_ZONE (default UTC)
// Billing only ever uses returnTime minus borrowTime, so a fixed offset cancels out. Only a clock change
// during a rental could matter, and only if the supplier sends wall-clock local time.

function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function zonedToUtc(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = tzOffsetMs(guess, timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

// Returns epoch milliseconds, or null when the value is empty or not understood.
function parseSupplierTime(value, timeZone = "UTC") {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") value = value.trim();
  if (value === "" || value === 0 || value === "0") return null;
  if (typeof value === "number" || /^\d+$/.test(value)) {
    const n = Number(value);
    if (n >= 1e12) return Math.round(n);
    if (n >= 1e9) return Math.round(n * 1000);
    return null;
  }
  const s = String(value);
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    return Number.isNaN(t) ? null : t;
  }
  // Dashes or slashes, and single-digit parts: 2026-11-13 10:00:00, 2026/11/13 10:00:00, 2026/1/5 9:00:00
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!m) return null;
  try { return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), timeZone); } catch (e) { return null; }
}

module.exports = { parseSupplierTime };
