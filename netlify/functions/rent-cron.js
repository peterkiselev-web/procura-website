"use strict";
// Runs every minute (schedule in netlify.toml). Confirms releases, detects returns, settles, applies the cut-off,
// retries refunds and closes. Netlify runs scheduled functions on the published production deploy only.
const { getRuntime } = require("../../lib/rental/runtime");

exports.handler = async () => {
  const rt = getRuntime();
  if (!rt.ready) { rt.log("config", `scheduled job skipped, not ready: ${rt.problems.join("; ") || "setup incomplete"}`); return { statusCode: 200, body: "not configured" }; }
  const out = await rt.service.runJobs();
  if (out.errors.length) rt.log("job", `finished with errors: ${out.errors.join(" | ")}`);
  return { statusCode: 200, body: JSON.stringify({ ...out, errors: out.errors.length }) };
};
