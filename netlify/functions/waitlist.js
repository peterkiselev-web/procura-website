"use strict";
// Waitlist intake for venues that were sent a private invite link.
//
// How it fits together:
//  1. When you decide to invite a venue, a task for it is created in the ClickUp "Venue Pipeline" list with a
//     random code in its "Invite code" custom field. The invite link carries the task id and that code.
//  2. The waitlist page calls GET /api/waitlist to check the link, then POST /api/waitlist with the form.
//  3. If the code matches, the venue's details are added to that same task, its status moves to Waitlisted,
//     the first update reminder is set as the due date, and the code is cleared so the link works once.
// The ClickUp token lives only in this function's environment variables. It never reaches the browser.
const crypto = require("crypto");

const API = "https://api.clickup.com/api/v2";
const INVITE_FIELD = "Invite code";
const PRIVACY_VERSION = "2026-10-03";
const MAX_BODY = 20 * 1024;

// Keep these lists in step with the select options on the contact page and waitlist page.
const VENUE_TYPES = [
  "Gym or leisure centre", "Hotel", "Café or coffee shop", "Restaurant", "Bar, pub or club",
  "Cinema or entertainment venue", "Co-working space", "Transport hub", "Shopping centre or retail",
  "University or student union", "Stadium, events or festival", "Other",
];
const FOOTFALL = ["Under 100 people", "100 to 500 people", "500 to 2,000 people", "Over 2,000 people"];
const CHANNELS = { both: "Email and WhatsApp", email: "Email only", whatsapp: "WhatsApp only" };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Form field -> name of the custom field in ClickUp. A field that does not exist in the list is skipped,
// because the full record is always written to the task description as well.
const FIELD_NAMES = {
  business_name: "Business name",
  contact_name: "Contact person",
  email: "Email",
  whatsapp: "WhatsApp",
  address: "Address",
  venue_type: "Venue type",
  opening_hours: "Opening hours",
  footfall: "Daily footfall",
  channel: "Update channel",
  waitlisted_on: "Waitlisted on",
};

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanMultiline(v, max) {
  return String(v == null ? "" : v).replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

// Returns +CCNNNNNNNN, or null. A leading 0 is read as a UK number.
function normalizePhone(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!/^[+()\d\s-]{7,24}$/.test(s)) return null;
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  else if (s.startsWith("0")) s = "+44" + s.slice(1);
  s = s.replace(/^\+440/, "+44");
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

function validate(input) {
  const d = {
    business_name: clean(input.business_name, 120),
    contact_name: clean(input.contact_name, 100),
    email: clean(input.email, 160),
    whatsapp: clean(input.whatsapp, 24),
    address: clean(input.address, 300),
    venue_type: clean(input.venue_type, 80),
    opening_hours: clean(input.opening_hours, 300),
    footfall: clean(input.footfall, 40),
    channel: clean(input.channel, 12) || "both",
    notes: cleanMultiline(input.notes, 1000),
  };
  for (const f of ["business_name", "contact_name", "email", "whatsapp", "address", "venue_type", "opening_hours"]) {
    if (!d[f]) return { error: "Please fill this in.", field: f };
  }
  if (!EMAIL.test(d.email)) return { error: "That email address doesn't look right.", field: "email" };
  const phone = normalizePhone(d.whatsapp);
  if (!phone) return { error: "Please check the number, and include the country code if it isn't a UK number.", field: "whatsapp" };
  if (!VENUE_TYPES.includes(d.venue_type)) return { error: "Please choose a venue type.", field: "venue_type" };
  if (d.footfall && !FOOTFALL.includes(d.footfall)) return { error: "Please choose one of the options.", field: "footfall" };
  if (!CHANNELS[d.channel]) return { error: "Please choose one of the options.", field: "channel" };
  d.whatsapp = phone;
  return { data: d };
}

// Markdown block added to the task description. Venue text is escaped so it cannot add links or formatting.
function buildDescription(d, when) {
  const md = (s) => String(s).replace(/([\\`*_\[\]<>#|~])/g, "\\$1");
  const lines = [
    "## Waitlist details",
    `- **Business name:** ${md(d.business_name)}`,
    `- **Contact person:** ${md(d.contact_name)}`,
    `- **Email:** ${md(d.email)}`,
    `- **WhatsApp:** ${md(d.whatsapp)} ([open chat](https://wa.me/${d.whatsapp.replace(/\D/g, "")}))`,
    `- **Address:** ${md(d.address)}`,
    `- **Venue type:** ${md(d.venue_type)}`,
    `- **Opening hours:** ${md(d.opening_hours)}`,
    `- **Daily footfall:** ${md(d.footfall || "Not given")}`,
    `- **Updates by:** ${CHANNELS[d.channel]}`,
  ];
  if (d.notes) lines.push("", "**Notes from the venue**", ...d.notes.split("\n").map((l) => "> " + md(l)));
  lines.push("", `_Submitted through the private waitlist page on ${when.toISOString()}. Privacy notice version ${PRIVACY_VERSION}._`);
  return lines.join("\n");
}

// Noon UTC keeps the date stable whatever timezone the ClickUp user is in.
function dueDate(now, days) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 12, 0, 0);
}

function settingsFrom(env) {
  const days = parseInt(env.UPDATE_CADENCE_DAYS, 10);
  return {
    cadenceDays: Math.min(60, Math.max(1, days || 14)),
    statusWaitlisted: env.WAITLIST_STATUS || "Waitlisted",
    assigneeIds: String(env.CLICKUP_ASSIGNEE_IDS || "").split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number),
  };
}

function sameSecret(a, b) {
  const h = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// Value to send for a custom field of the given type, or undefined to skip it.
function encodeField(field, raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  switch (field.type) {
    case "drop_down": {
      const opt = field.options.find((o) => norm(o.name) === norm(raw));
      return opt ? opt.id : undefined;
    }
    case "date": return typeof raw === "number" ? raw : undefined;
    case "short_text": case "text": case "email": case "url": case "phone": return String(raw);
    default: return undefined;
  }
}

function clickupStore({ token, listId, fetchImpl, settings }) {
  const doFetch = fetchImpl || fetch;
  async function call(method, path, body, attempt = 0) {
    const res = await doFetch(API + path, {
      method,
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1200));
      return call(method, path, body, 1);
    }
    let json = null;
    try { const text = await res.text(); json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json };
  }

  return {
    async getTask(id) {
      const r = await call("GET", `/task/${id}?include_markdown_description=true`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`ClickUp GET task returned ${r.status}`);
      const t = r.json || {};
      return {
        id: t.id,
        name: t.name || "",
        listId: String(t.list && t.list.id),
        description: t.markdown_description || t.description || "",
        fields: (t.custom_fields || []).map((f) => ({
          id: f.id, name: f.name, type: f.type, value: f.value,
          options: (f.type_config && f.type_config.options) || [],
        })),
      };
    },

    // Writes the submission. The description write must succeed. Everything after it is best effort and any
    // problem is noted on the task so you can see it in ClickUp.
    async saveSubmission(task, d, { now }) {
      const block = buildDescription(d, now);
      const body = {
        markdown_description: task.description ? `${task.description}\n\n---\n\n${block}` : block,
        due_date: dueDate(now, settings.cadenceDays),
        due_date_time: false,
      };
      if (settings.assigneeIds.length) body.assignees = { add: settings.assigneeIds };

      const issues = [];
      let r = await call("PUT", `/task/${task.id}`, { ...body, status: settings.statusWaitlisted });
      if (!r.ok) {
        r = await call("PUT", `/task/${task.id}`, body);
        if (!r.ok) throw new Error(`ClickUp PUT task returned ${r.status}`);
        issues.push(`Status could not be set to "${settings.statusWaitlisted}". Check that the status exists in the list.`);
      }

      const values = { ...d, waitlisted_on: now.getTime() };
      const jobs = [];
      for (const [key, fieldName] of Object.entries(FIELD_NAMES)) {
        const field = task.fields.find((f) => norm(f.name) === norm(fieldName));
        const value = field && encodeField(field, values[key]);
        if (value === undefined) continue;
        jobs.push(call("POST", `/task/${task.id}/field/${field.id}`, { value }).then((res) => {
          if (!res.ok) issues.push(`Custom field "${fieldName}" could not be set (${res.status}).`);
        }));
      }
      const invite = task.fields.find((f) => norm(f.name) === norm(INVITE_FIELD));
      jobs.push(call("DELETE", `/task/${task.id}/field/${invite.id}`).then((res) => {
        if (!res.ok) issues.push(`The invite code could not be cleared (${res.status}). Clear the "${INVITE_FIELD}" field by hand so the link stops working.`);
      }));
      await Promise.all(jobs.map((p) => p.catch((e) => issues.push(`ClickUp request failed: ${e.message}`))));

      const text = `Waitlist form submitted by ${d.contact_name}. Details are in the description. Next update is due ${new Date(body.due_date).toISOString().slice(0, 10)}.` +
        (issues.length ? `\n\nNeeds attention:\n- ${issues.join("\n- ")}` : "");
      await call("POST", `/task/${task.id}/comment`, { comment_text: text, notify_all: false }).catch(() => null);
      return { issues };
    },
  };
}

function createHandler({ store, settings, listId, now }) {
  const clock = now || (() => new Date());
  const hits = new Map();
  // Per-instance throttle on top of the unguessable code. 20 calls per 10 minutes per address.
  function limited(ip) {
    const t = Date.now();
    const list = (hits.get(ip) || []).filter((x) => t - x < 10 * 60 * 1000);
    list.push(t);
    hits.set(ip, list);
    return list.length > 20;
  }

  // Returns the task when the id and code match, otherwise null. Every failure looks the same to the caller.
  async function verify(t, k) {
    if (!/^[A-Za-z0-9]{3,24}$/.test(t || "") || !/^[A-Za-z0-9_-]{16,80}$/.test(k || "")) return null;
    const task = await store.getTask(t);
    if (!task || task.listId !== String(listId)) return null;
    const field = task.fields.find((f) => norm(f.name) === norm(INVITE_FIELD));
    if (!field) throw new Error(`The list has no "${INVITE_FIELD}" custom field`);
    if (!field.value || !sameSecret(field.value, k)) return null;
    return task;
  }

  return async function handle({ method, query, body, ip }) {
    const q = query || {};
    const invalid = { status: 404, json: { ok: false, error: "invalid" } };
    if (limited(ip || "unknown")) return { status: 429, json: { ok: false, error: "rate_limited" } };
    try {
      if (method === "GET") {
        const task = await verify(q.t, q.k);
        return task ? { status: 200, json: { ok: true, venue: task.name } } : invalid;
      }
      if (method !== "POST") return { status: 405, json: { ok: false, error: "method" } };

      const input = body || {};
      if (input.website) return { status: 200, json: { ok: true } }; // honeypot filled: pretend success
      const { data, error, field } = validate(input);
      if (error) return { status: 400, json: { ok: false, error, field } };
      const task = await verify(input.t, input.k);
      if (!task) return invalid;
      const result = await store.saveSubmission(task, data, { now: clock() });
      if (result.issues.length) console.warn(`waitlist: task ${task.id} saved with issues: ${result.issues.join(" | ")}`);
      return { status: 200, json: { ok: true } };
    } catch (e) {
      // Log the cause without the venue's details. The visitor only sees a generic message.
      console.error(`waitlist: ${method} failed: ${e.message}`);
      return { status: 502, json: { ok: false, error: "unavailable" } };
    }
  };
}

// Netlify entry point.
let cached = null;
function instance(env) {
  if (!cached) {
    const settings = settingsFrom(env);
    const store = clickupStore({ token: env.CLICKUP_TOKEN, listId: env.CLICKUP_LIST_ID, settings });
    cached = createHandler({ store, settings, listId: env.CLICKUP_LIST_ID });
  }
  return cached;
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  const send = (status, json) => ({ statusCode: status, headers, body: JSON.stringify(json) });
  const env = process.env;
  if (!env.CLICKUP_TOKEN || !env.CLICKUP_LIST_ID) {
    console.error("waitlist: CLICKUP_TOKEN or CLICKUP_LIST_ID is not set");
    return send(500, { ok: false, error: "not_configured" });
  }
  let body = null;
  if (event.httpMethod === "POST") {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
    if (raw.length > MAX_BODY) return send(413, { ok: false, error: "too_large" });
    try { body = JSON.parse(raw || "{}"); } catch (e) { return send(400, { ok: false, error: "bad_request" }); }
  }
  const h = event.headers || {};
  const ip = h["x-nf-client-connection-ip"] || String(h["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const out = await instance(env)({ method: event.httpMethod, query: event.queryStringParameters, body, ip });
  return send(out.status, out.json);
};

Object.assign(exports, { createHandler, clickupStore, settingsFrom, validate, normalizePhone, buildDescription, dueDate, MAX_BODY });
