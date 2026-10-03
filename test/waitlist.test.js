"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler, clickupStore, settingsFrom, validate, normalizePhone, buildDescription } = require("../netlify/functions/waitlist.js");

const CODE = "Zk3Qm9Lw2PxR7vTb";
const NOW = new Date("2026-10-05T10:00:00Z");

// A tiny stand-in for the ClickUp API that records every call.
function fakeClickUp(opts = {}) {
  const calls = [];
  const task = {
    id: "abc123", name: "Blue Door Cafe", list: { id: "L1" }, markdown_description: "Met on 1 Oct. Keen.",
    custom_fields: [
      { id: "f_invite", name: "Invite code", type: "short_text", value: CODE },
      { id: "f_email", name: "Email", type: "email" },
      { id: "f_type", name: "Venue type", type: "drop_down", type_config: { options: [{ id: "o1", name: "Hotel" }, { id: "o2", name: "Café or coffee shop" }] } },
      { id: "f_when", name: "Waitlisted on", type: "date" },
      { id: "f_other", name: "Something else", type: "short_text" },
    ],
  };
  const reply = (status, json) => ({ ok: status < 300, status, text: async () => JSON.stringify(json) });
  async function fetchImpl(url, init = {}) {
    const method = init.method || "GET";
    const path = url.replace("https://api.clickup.com/api/v2", "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body, auth: init.headers.Authorization });
    if (method === "GET" && path.startsWith("/task/abc123")) return reply(200, task);
    if (method === "GET" && path.startsWith("/task/")) return reply(404, { err: "Task not found" });
    if (method === "PUT" && path === "/task/abc123") {
      if (opts.failPut) return reply(500, {});
      if (opts.rejectStatus && body.status) return reply(400, { err: "Status not found" });
      return reply(200, {});
    }
    if (method === "POST" && path.startsWith("/task/abc123/field/")) return reply(opts.failFields ? 400 : 200, {});
    if (method === "DELETE" && path === "/task/abc123/field/f_invite") {
      if (opts.failClear) return reply(500, {});
      task.custom_fields.find((f) => f.id === "f_invite").value = undefined;
      return reply(200, {});
    }
    if (method === "POST" && path === "/task/abc123/comment") return reply(200, {});
    return reply(500, {});
  }
  return { fetchImpl, calls, task };
}

function setup(opts, env = { CLICKUP_ASSIGNEE_IDS: "123, 456", UPDATE_CADENCE_DAYS: "14" }) {
  const fake = fakeClickUp(opts);
  const settings = settingsFrom(env);
  const store = clickupStore({ token: "pk_test", listId: "L1", fetchImpl: fake.fetchImpl, settings });
  const handle = createHandler({ store, settings, listId: "L1", now: () => NOW });
  return { ...fake, handle };
}

const form = (extra = {}) => ({
  t: "abc123", k: CODE, business_name: "The Blue Door Cafe", contact_name: "Sam Ortiz", email: "sam@bluedoor.example",
  whatsapp: "07700 900123", address: "1 High Street\nLondon", venue_type: "Café or coffee shop",
  opening_hours: "Mon to Fri 7am to 6pm", footfall: "100 to 500 people", channel: "both", notes: "", website: "", ...extra,
});

test("normalizePhone reads UK and international numbers", () => {
  assert.equal(normalizePhone("07700 900123"), "+447700900123");
  assert.equal(normalizePhone("+44 (0) 7700 900123"), "+447700900123");
  assert.equal(normalizePhone("0044 7700 900123"), "+447700900123");
  assert.equal(normalizePhone("+1 415 555 0132"), "+14155550132");
  assert.equal(normalizePhone("7700900123"), null);
  assert.equal(normalizePhone("07700+900"), null);
  assert.equal(normalizePhone("abc"), null);
});

test("validate rejects bad input and names the field", () => {
  assert.equal(validate(form({ email: "nope" })).field, "email");
  assert.equal(validate(form({ whatsapp: "123" })).field, "whatsapp");
  assert.equal(validate(form({ venue_type: "Spaceship" })).field, "venue_type");
  assert.equal(validate(form({ business_name: "  " })).field, "business_name");
  assert.equal(validate(form({ channel: "carrier pigeon" })).field, "channel");
  const ok = validate(form());
  assert.equal(ok.data.whatsapp, "+447700900123");
  assert.equal(ok.data.address, "1 High Street London");
});

test("description escapes venue text so it cannot inject links", () => {
  const { data } = validate(form({ contact_name: "[click](https://evil.example)", notes: "line one\n# heading" }));
  const md = buildDescription(data, NOW);
  assert.ok(!md.includes("[click](https://evil.example)"));
  assert.ok(md.includes("\\[click\\]"));
  assert.ok(md.includes("> \\# heading"));
  assert.ok(md.includes("https://wa.me/447700900123"));
});

test("GET gives the venue name for a good link and an identical answer for every bad one", async () => {
  const { handle } = setup();
  const good = await handle({ method: "GET", query: { t: "abc123", k: CODE }, ip: "1" });
  assert.deepEqual(good, { status: 200, json: { ok: true, venue: "Blue Door Cafe" } });
  const bad = [
    { t: "abc123", k: "wrongwrongwrongwrong" }, // wrong code
    { t: "zzz999", k: CODE },                    // unknown task
    { t: "abc123", k: "short" },                 // malformed code
    { t: "../etc", k: CODE },                    // malformed id
    {},                                          // nothing
  ];
  for (const q of bad) assert.deepEqual(await handle({ method: "GET", query: q, ip: "1" }), { status: 404, json: { ok: false, error: "invalid" } });
});

test("a task from a different list is refused", async () => {
  const fake = fakeClickUp();
  fake.task.list.id = "OTHER";
  const settings = settingsFrom({});
  const handle = createHandler({ store: clickupStore({ token: "t", listId: "L1", fetchImpl: fake.fetchImpl, settings }), settings, listId: "L1", now: () => NOW });
  assert.equal((await handle({ method: "GET", query: { t: "abc123", k: CODE }, ip: "1" })).status, 404);
});

test("POST writes the venue into its task, sets the reminder, and uses the invite once", async () => {
  const { handle, calls, task } = setup();
  const out = await handle({ method: "POST", body: form(), ip: "1" });
  assert.deepEqual(out, { status: 200, json: { ok: true } });

  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put.auth, "pk_test");
  assert.equal(put.body.status, "Waitlisted");
  assert.equal(put.body.due_date, Date.UTC(2026, 9, 19, 12, 0, 0)); // 14 days on, noon UTC
  assert.equal(put.body.due_date_time, false);
  assert.deepEqual(put.body.assignees, { add: [123, 456] });
  assert.ok(put.body.markdown_description.startsWith("Met on 1 Oct. Keen."), "keeps the notes already on the task");
  assert.ok(put.body.markdown_description.includes("**Contact person:** Sam Ortiz"));

  // Only fields that exist in the list are set, and the dropdown maps to its option id.
  const sets = calls.filter((c) => c.method === "POST" && c.path.includes("/field/"));
  assert.deepEqual(sets.map((c) => c.path.split("/").pop()).sort(), ["f_email", "f_type", "f_when"]);
  assert.equal(sets.find((c) => c.path.endsWith("f_type")).body.value, "o2");
  assert.equal(sets.find((c) => c.path.endsWith("f_when")).body.value, NOW.getTime());

  assert.ok(calls.some((c) => c.method === "DELETE" && c.path.endsWith("f_invite")));
  const comment = calls.find((c) => c.path.endsWith("/comment"));
  assert.ok(comment.body.comment_text.includes("due 2026-10-19"));
  assert.ok(!comment.body.comment_text.includes("Needs attention"));

  // The link no longer works.
  assert.equal((await handle({ method: "GET", query: { t: "abc123", k: CODE }, ip: "1" })).status, 404);
  assert.equal(task.custom_fields[0].value, undefined);
});

test("if the status does not exist yet, details are still saved and the problem is noted on the task", async () => {
  const { handle, calls } = setup({ rejectStatus: true });
  assert.equal((await handle({ method: "POST", body: form(), ip: "1" })).status, 200);
  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[1].body.status, undefined);
  assert.ok(calls.find((c) => c.path.endsWith("/comment")).body.comment_text.includes('Status could not be set to "Waitlisted"'));
});

test("failed custom fields and a failed code clear are reported on the task, not to the venue", async () => {
  const { handle, calls } = setup({ failFields: true, failClear: true });
  assert.equal((await handle({ method: "POST", body: form(), ip: "1" })).status, 200);
  const text = calls.find((c) => c.path.endsWith("/comment")).body.comment_text;
  assert.ok(text.includes('Custom field "Venue type" could not be set'));
  assert.ok(text.includes("invite code could not be cleared"));
});

test("if the description cannot be saved the venue is told to retry and the invite stays valid", async () => {
  const { handle, calls } = setup({ failPut: true });
  const out = await handle({ method: "POST", body: form(), ip: "1" });
  assert.equal(out.status, 502);
  assert.equal(out.json.error, "unavailable");
  assert.ok(!calls.some((c) => c.method === "DELETE"));
  assert.equal((await handle({ method: "GET", query: { t: "abc123", k: CODE }, ip: "1" })).status, 200);
});

test("a wrong code never writes anything", async () => {
  const { handle, calls } = setup();
  const out = await handle({ method: "POST", body: form({ k: "wrongwrongwrongwrong" }), ip: "1" });
  assert.equal(out.status, 404);
  assert.ok(!calls.some((c) => c.method !== "GET"));
});

test("invalid form data is rejected before ClickUp is contacted", async () => {
  const { handle, calls } = setup();
  const out = await handle({ method: "POST", body: form({ email: "nope" }), ip: "1" });
  assert.equal(out.status, 400);
  assert.equal(out.json.field, "email");
  assert.equal(calls.length, 0);
});

test("the honeypot gets a fake success and nothing is stored", async () => {
  const { handle, calls } = setup();
  assert.deepEqual(await handle({ method: "POST", body: form({ website: "http://spam.example" }), ip: "1" }), { status: 200, json: { ok: true } });
  assert.equal(calls.length, 0);
});

test("callers are throttled", async () => {
  const { handle } = setup();
  let last;
  for (let i = 0; i < 21; i++) last = await handle({ method: "GET", query: {}, ip: "9.9.9.9" });
  assert.equal(last.status, 429);
  assert.equal((await handle({ method: "GET", query: {}, ip: "8.8.8.8" })).status, 404, "other addresses are unaffected");
});

test("a list without an Invite code field fails closed", async () => {
  const fake = fakeClickUp();
  fake.task.custom_fields = fake.task.custom_fields.filter((f) => f.name !== "Invite code");
  const settings = settingsFrom({});
  const handle = createHandler({ store: clickupStore({ token: "t", listId: "L1", fetchImpl: fake.fetchImpl, settings }), settings, listId: "L1", now: () => NOW });
  assert.equal((await handle({ method: "GET", query: { t: "abc123", k: CODE }, ip: "1" })).status, 502);
});

test("settings fall back to safe defaults", () => {
  const s = settingsFrom({});
  assert.deepEqual(s, { cadenceDays: 14, statusWaitlisted: "Waitlisted", assigneeIds: [] });
  assert.equal(settingsFrom({ UPDATE_CADENCE_DAYS: "7" }).cadenceDays, 7);
  assert.equal(settingsFrom({ UPDATE_CADENCE_DAYS: "9999" }).cadenceDays, 60);
  assert.deepEqual(settingsFrom({ CLICKUP_ASSIGNEE_IDS: "12, x, 34" }).assigneeIds, [12, 34]);
});
