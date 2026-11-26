"use strict";
// The admin page: plain HTML written on the server, no scripts. Everything from the database is escaped.
const { money } = require("./pricing");

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (v, tz) => (v ? new Date(v).toLocaleString("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

function stripeLink(mode, pi, label) {
  if (!pi || !/^pi_[A-Za-z0-9_]+$/.test(pi)) return "";
  return `<a href="https://dashboard.stripe.com${mode === "live" ? "" : "/test"}/payments/${esc(pi)}" rel="noreferrer noopener" target="_blank">${esc(label)}</a>`;
}

function table(rows, mode, tz, empty) {
  if (!rows.length) return `<p class="none">${esc(empty)}</p>`;
  const body = rows.map((item) => {
    const r = item.rental || item;
    const why = item.why ? `<div class="why">${item.why.map(esc).join("<br>")}</div>` : "";
    const last = (r.history || []).slice(-3).map((h) => `${esc(when(h.at, tz))} ${esc(h.text)}`).join("<br>");
    // What the supplier last said about the order. Their status numbers are not documented, so they are shown as they are.
    const d = r.last_detail || {};
    const supplierSays = (d.borrowStatus !== undefined || d.paymentStatus !== undefined ? `<div class="hist">supplier: borrowStatus ${esc(d.borrowStatus)}, paymentStatus ${esc(d.paymentStatus)}</div>` : "")
      + (Array.isArray(d._fields) && !(d._fields.includes("borrowTime") && d._fields.includes("returnTime")) ? `<div class="err">supplier order fields differ from the documentation: ${esc(d._fields.join(", "))}</div>` : "");
    return `<tr>
<td>${esc(when(r.created_at, tz))}<br><span class="id">${esc(String(r.id).slice(0, 8))}</span></td>
<td>${esc(r.station)}<br><span class="st st-${esc(r.status)}">${esc(r.status)}</span></td>
<td>${r.staff_name ? `<b>staff: ${esc(r.staff_name)}</b>` : esc(r.email || "")}</td>
<td>${r.staff_name ? "free (staff)<br>" : `paid ${money(r.paid_pence || 0)}<br>`}${r.charged_extra_pence ? `extra ${money(r.charged_extra_pence)}<br>` : ""}${r.status === "payment_failed" ? `<b>owed ${money(r.due_pence || 0)}</b><br>` : ""}${r.refunded_pence ? `refunded ${money(r.refunded_pence)}` : ""}</td>
<td>${r.borrow_time ? `out ${esc(when(r.borrow_time, tz))}<br>` : ""}${r.return_time ? `back ${esc(when(r.return_time, tz))}<br>` : ""}${r.cutoff_at && r.status === "active" ? `cut-off ${esc(when(r.cutoff_at, tz))}` : ""}</td>
<td>${r.trade_no ? `<code>${esc(r.trade_no)}</code>` : "none"}</td>
<td>${stripeLink(mode, r.stripe_payment_intent_id, "first payment")}<br>${stripeLink(mode, r.settle_pi_id, "later charge")}</td>
<td>${why}${supplierSays}<div class="hist">${last}</div>${r.last_error ? `<div class="err">${esc(r.last_error)}</div>` : ""}</td>
</tr>`;
  }).join("");
  return `<div class="scroll"><table><thead><tr><th>Started</th><th>Station and status</th><th>Email</th><th>Money</th><th>Times</th><th>Supplier order</th><th>Stripe</th><th>Notes</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderAdmin(o, config) {
  const tz = config.receiptTimeZone;
  const section = (title, rows, empty) => `<h2>${esc(title)} <span>${rows.length}</span></h2>${table(rows, o.stripeMode, tz, empty)}`;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="60"><title>Rentals admin</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:#f6f6f4;color:#161616}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}h2 span{font-weight:400;color:#666}
.mode{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:${o.stripeMode === "live" ? "#7a1414" : "#1d5b34"};color:#fff}
.scroll{overflow-x:auto;background:#fff;border:1px solid #ddd;border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:880px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid #eee}th{font-size:12px;color:#555;background:#fafafa}
.id,.hist{color:#777;font-size:12px}.why{color:#7a1414;font-weight:600}.err{color:#7a1414;font-size:12px}.none{color:#666}
.st{font-size:12px;padding:1px 6px;border-radius:4px;background:#eee}.st-payment_failed,.st-refunding,.st-expired{background:#f8d7d7}.st-active{background:#d9ecff}.st-settled,.st-expired_charged,.st-release_failed_refunded{background:#e2f1e2}
code{font-size:12px}a{color:#0b57d0}
</style></head><body>
<h1>Rentals <span class="mode">Stripe ${esc(o.stripeMode)} mode</span></h1>
<p class="none">Refreshes every minute. Times are ${esc(tz)}. The last 30 days are shown.</p>
${section("Needs attention", o.attention, "Nothing needs attention.")}
${section("Open rentals", o.open, "No open rentals.")}
${section("Failed payments", o.failed, "No failed payments.")}
${section("Refunds", o.refunds, "No refunds.")}
${section("Recently finished", o.recent, "Nothing finished yet.")}
</body></html>`;
}

module.exports = { renderAdmin, esc };
