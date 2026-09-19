// Procura website server. Zero dependencies.
// Serves the static site from an allowlist and receives enquiries at POST /api/contact.
// Each enquiry is appended to data/enquiries.log first, then emailed if SMTP is configured
// (optional: `npm install nodemailer` and set the SMTP_* variables in .env).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URLSearchParams } = require("url");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const LOG_FILE = path.join(ROOT, "data", "enquiries.log");
const MAX_BODY = 20 * 1024;

// Only these paths are ever served. Everything else is a 404, including .env and this file.
const PUBLIC_FILES = new Set(["index.html", "machines.html", "how-it-works.html", "why-host.html", "about.html", "contact.html", "privacy.html", "thanks.html"]);
const PUBLIC_DIRS = ["css/", "js/", "assets/"];

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".glb": "model/gltf-binary", ".json": "application/json", ".ico": "image/x-icon",
};

const FIELDS = ["enquiry_type", "name", "venue", "email", "phone", "venue_type", "location", "footfall", "call_time", "message"];
const REQUIRED = ["name", "venue", "email", "venue_type", "location"];

// Basic per-IP rate limit: 5 enquiries per 10 minutes.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

function loadEnv(file) {
  // Reads KEY=VALUE lines into process.env without printing them.
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function resolvePublic(urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  if (p === "") p = "index.html";
  if (p.includes("\0") || p.split("/").some((seg) => seg === ".." || seg.startsWith("."))) return null;
  if (!PUBLIC_FILES.has(p) && !PUBLIC_DIRS.some((d) => p.startsWith(d))) return null;
  const full = path.join(ROOT, p);
  if (!full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function serveFile(req, res, full) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const type = TYPES[path.extname(full).toLowerCase()] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cache-Control": full.includes(path.sep + "assets" + path.sep) ? "public, max-age=86400" : "no-cache",
      "Accept-Ranges": "bytes",
    };
    // Range support so video seeks and plays in Safari.
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0;
      const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      return req.method === "HEAD" ? res.end() : fs.createReadStream(full, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

function validate(input) {
  const out = {};
  for (const f of FIELDS) out[f] = clean(input[f], f === "message" ? 2000 : 200);
  out.enquiry_type = out.enquiry_type === "question" ? "question" : "call";
  const missing = REQUIRED.filter((f) => !out[f]);
  if (missing.length) return { error: `Missing: ${missing.join(", ")}` };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { error: "Invalid email" };
  if (out.phone && !/^[+()\d\s-]{7,20}$/.test(out.phone)) return { error: "Invalid phone" };
  return { data: out };
}

async function sendEmail(entry) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ENQUIRY_TO, ENQUIRY_FROM } = process.env;
  if (!SMTP_HOST || !ENQUIRY_TO) return "skipped: SMTP not configured";
  let nodemailer;
  try { nodemailer = require("nodemailer"); } catch (e) { return "skipped: nodemailer not installed"; }
  const t = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT) || 587, secure: Number(SMTP_PORT) === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  const d = entry.data;
  const text = FIELDS.filter((f) => d[f]).map((f) => `${f.replace(/_/g, " ")}: ${d[f]}`).join("\n");
  await t.sendMail({
    from: ENQUIRY_FROM || SMTP_USER, to: ENQUIRY_TO, replyTo: d.email,
    subject: `${d.enquiry_type === "call" ? "Consultation call" : "Question"}: ${d.venue} (${d.venue_type})`,
    text: `${text}\n\nReceived ${entry.received}`,
  });
  return "sent";
}

function handleContact(req, res) {
  const ip = req.socket.remoteAddress || "unknown";
  if (limited(ip)) return sendJson(res, 429, { ok: false, error: "Too many requests" });
  let body = "", size = 0, aborted = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { aborted = true; sendJson(res, 413, { ok: false, error: "Too large" }); req.destroy(); return; }
    body += chunk;
  });
  req.on("end", async () => {
    if (aborted) return;
    const ctype = (req.headers["content-type"] || "").split(";")[0];
    let input = {};
    try { input = ctype === "application/json" ? JSON.parse(body || "{}") : Object.fromEntries(new URLSearchParams(body)); }
    catch (e) { return sendJson(res, 400, { ok: false, error: "Bad request" }); }
    const wantsJson = (req.headers.accept || "").includes("application/json");

    if (input.website) { // honeypot filled: pretend success
      return wantsJson ? sendJson(res, 200, { ok: true }) : redirect(res, "/thanks.html");
    }
    const { data, error } = validate(input);
    if (error) return wantsJson ? sendJson(res, 400, { ok: false, error }) : redirect(res, "/contact.html?error=1");

    const entry = { received: new Date().toISOString(), data };
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.error("Could not write enquiry log:", e.message);
      return wantsJson ? sendJson(res, 500, { ok: false }) : redirect(res, "/contact.html?error=1");
    }
    sendEmail(entry).then((r) => console.log(`Enquiry from ${data.venue}: email ${r}`)).catch((e) => console.error("Email failed:", e.message));
    return wantsJson ? sendJson(res, 200, { ok: true }) : redirect(res, "/thanks.html");
  });
}

function redirect(res, to) {
  res.writeHead(303, { Location: to });
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.url.split("?")[0] === "/api/contact") {
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }
    return handleContact(req, res);
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  let full;
  try { full = resolvePublic(req.url); } catch (e) { full = null; }
  if (!full) return notFound(res);
  serveFile(req, res, full);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Procura site running at http://${HOST}:${PORT}`));
}
module.exports = { server, resolvePublic, validate };
