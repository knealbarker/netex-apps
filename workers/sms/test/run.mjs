// Tests for netex-sms: Twilio signature, incoming texts and routing, STOP/START, delivery updates, sending, the app API, the page API.
// Run: node workers/sms/test/run.mjs   (Node 22; no network: Twilio and email are fakes)
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { freshDb, fakeAccess, TEAM, AUD } from "../../planner/test/harness.mjs";
import { handle } from "../src/index.js";
import { twilioSignature, send, replies, markHandled, forwardText } from "../src/texts.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const here = dirname(fileURLToPath(import.meta.url)), PUBLIC = join(here, "../public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
const assets = { async fetch(req) { let p = new URL(req.url).pathname; if (p.endsWith("/")) p += "index.html"; const f = join(PUBLIC, p);
  return f.startsWith(PUBLIC) && existsSync(f) ? new Response(readFileSync(f), { headers: { "content-type": TYPES[extname(f)] || "application/octet-stream" } }) : new Response("Not found", { status: 404 }); } };

const A = await fakeAccess();
const { db, sqlite } = freshDb();
const TOKEN = "test-auth-token-0123456789abcdef";
const env = { DB: db, ASSETS: assets, ORG_ID: "tcc", APP_ID: "sms", APP_NAME: "Texts", TIMEZONE: "America/Chicago", TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD,
  PUBLIC_URL: "https://sms.netexcleaners.com", TWILIO_AUTH_TOKEN: TOKEN, TWILIO_ACCOUNT_SID: "ACtest", TWILIO_MESSAGING_SERVICE_SID: "MGtest",
  TWILIO_FROM: "+19036899487", FORWARD_TO: "neal@towncountryclean.com", FORWARD_MODE: "all", MAX_PER_APP_PER_DAY: "3" };

const addUser = (email, roles, phone = null) => {
  let id = sqlite.prepare("SELECT id FROM core_users WHERE email=?").get(email)?.id;
  if (!id) { id = "01" + Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(24, "0");
    sqlite.prepare("INSERT INTO core_users(id, org_id, email, display_name, phone) VALUES(?,?,?,?,?)").run(id, "tcc", email, email.split("@")[0], phone); }
  for (const [app, role] of Object.entries(roles)) sqlite.prepare("INSERT OR REPLACE INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES(?,?,?,?)").run(id, app, role, "x");
  return id;
};
const NEAL = "neal@towncountryclean.com";
const nealId = sqlite.prepare("SELECT id FROM core_users WHERE email=?").get(NEAL)?.id || addUser(NEAL, {}, "+12146937094");
sqlite.prepare("UPDATE core_users SET phone='+12146937094', display_name='Neal Barker' WHERE id=?").run(nealId);
addUser(NEAL, { sms: "owner" });
addUser("mgr@x.com", { sms: "manager" });

// fake Twilio REST API
const twilioCalls = [];
let twilioReply = () => ({ status: 201, body: { sid: "SM" + twilioCalls.length.toString().padStart(32, "0"), status: "accepted" } });
const fetchImpl = async (url, init) => {
  if (String(url).startsWith("https://api.twilio.com/")) {
    twilioCalls.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(String(init.body))), auth: init.headers.authorization });
    const r = twilioReply(); return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }
  return A.fetchImpl(url, init);
};
const emails = [];
const sendEmail = async (from, to, raw) => { emails.push({ from, to, raw }); };

// a webhook exactly as Twilio would post it
const webhook = async (path, params, { sign = true, url = `https://sms.netexcleaners.com${path}` } = {}) => {
  const h = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (sign) h.set("x-twilio-signature", await twilioSignature(TOKEN, `https://sms.netexcleaners.com${path}`, params));
  const r = await handle(new Request(url, { method: "POST", headers: h, body: new URLSearchParams(params) }), env, { fetchImpl, sendEmail });
  return { status: r.status, type: r.headers.get("content-type") || "", body: await r.text() };
};
let n = 0;
const inbound = (from, body, extra = {}) => webhook("/twilio/inbound", { MessageSid: "SMin" + String(++n).padStart(30, "0"), From: from, To: "+19036899487", Body: body, NumMedia: "0", ...extra });

const call = async (method, path, { as = NEAL, body } = {}) => {
  const h = new Headers();
  if (as) h.set("cf-access-jwt-assertion", await A.token({ email: as }));
  if (body) h.set("content-type", "application/json");
  const r = await handle(new Request(`https://sms.netexcleaners.com${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl, sendEmail });
  const type = r.headers.get("content-type") || "";
  return { status: r.status, body: type.includes("json") ? await r.json() : await r.text() };
};
const get = id => sqlite.prepare("SELECT * FROM sms_messages WHERE id=?").get(id);
const lastIn = () => sqlite.prepare("SELECT * FROM sms_messages WHERE direction='in' ORDER BY created_at DESC, id DESC LIMIT 1").get();

console.log("netex-sms");
await t("signature: Twilio's documented example", async () => {
  // Twilio docs example; value confirmed with the official twilio npm library (getExpectedTwilioSignature)
  const sig = await twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2",
    { CallSid: "CA1234567890ABCDE", Caller: "+14158675309", Digits: "1234", From: "+14158675309", To: "+18005551212" });
  eq(sig, "RSOYDt4T1cUTdK1PDd93/VVr8B8=");
});

await t("webhook without a valid signature is refused and saves nothing", async () => {
  eq((await webhook("/twilio/inbound", { MessageSid: "SMx", From: "+12146937094", Body: "hi" }, { sign: false })).status, 403);
  const forged = await webhook("/twilio/inbound", { MessageSid: "SMx", From: "+12146937094", Body: "hi" }, { url: "https://sms.netexcleaners.com/twilio/inbound?x=1" });
  eq(forged.status, 403, "signed for a different URL");
  eq(sqlite.prepare("SELECT COUNT(*) n FROM sms_messages").get().n, 0);
  eq((await call("GET", "/twilio/inbound", { as: null })).status, 405);
});

await t("text out of the blue: saved, unrouted, empty reply (no auto-text), emailed to Neal", async () => {
  const r = await inbound("+12146937094", "Got it!");
  eq(r.status, 200); ok(r.type.includes("xml")); ok(r.body.includes("<Response></Response>"), "no <Message> back");
  const m = lastIn();
  eq([m.phone, m.body, m.route, m.app_id, m.user_id, m.status], ["+12146937094", "Got it!", "unrouted", null, nealId, "received"]);
  ok(m.forwarded_at, "forwarded");
  eq(emails.length, 1); eq(emails[0].to, NEAL);
  const raw = emails[0].raw;
  ok(raw.includes("Subject: Text from Neal Barker (214) 693-7094"), raw.slice(0, 300));
  ok(Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString().includes("Not a reply to any text we sent"));
});

await t("Twilio retry of the same message isn't saved twice", async () => {
  const before = sqlite.prepare("SELECT COUNT(*) n FROM sms_messages").get().n;
  const sid = lastIn().twilio_sid;
  await webhook("/twilio/inbound", { MessageSid: sid, From: "+12146937094", To: "+19036899487", Body: "Got it!" });
  eq(sqlite.prepare("SELECT COUNT(*) n FROM sms_messages").get().n, before);
});

let outId;
await t("an app sends: Twilio gets the messaging service, status callback; row saved for routing", async () => {
  const r = await send(env, { app: "planner", to: "(214) 693-7094", body: "Diana clocked in 7:42 AM, planned 7:30.", ref: "late:2026-10-16:diana" }, { fetchImpl });
  ok(r.ok, JSON.stringify(r)); outId = r.id;
  const c = twilioCalls.at(-1);
  eq([c.form.To, c.form.MessagingServiceSid, c.form.StatusCallback], ["+12146937094", "MGtest", "https://sms.netexcleaners.com/twilio/status"]);
  eq(c.auth, "Basic " + btoa("ACtest:" + TOKEN), "auth token when no API key");
  const row = get(r.id);
  eq([row.direction, row.app_id, row.ref, row.status, row.user_id], ["out", "planner", "late:2026-10-16:diana", "accepted", nealId]);
});

await t("a reply routes to the app whose text it answers, with its ref", async () => {
  await inbound("+12146937094", "She called, flat tire");
  const m = lastIn();
  eq([m.route, m.app_id, m.ref, m.reply_to_id, m.handled_at], ["reply", "planner", "late:2026-10-16:diana", outId, null]);
  const rs = await replies(env, { app: "planner" });
  eq(rs.map(x => x.body), ["She called, flat tire"]); eq(rs[0].name, "Neal Barker");
  eq((await replies(env, { app: "retail" })).length, 0, "other apps don't see it");
  ok(forwardText({ ...m, name: "Neal Barker", answering: "Diana clocked in" }).text.includes("Routed to: planner"));
});

await t("an app can only mark its own replies handled", async () => {
  const id = lastIn().id;
  eq((await markHandled(env, { app: "retail", ids: [id] })).updated, 0);
  eq((await markHandled(env, { app: "planner", ids: [id] })).updated, 1);
  eq((await replies(env, { app: "planner" })).length, 0);
  eq((await replies(env, { app: "planner", all: true })).length, 1);
});

await t("replies after 7 days are no longer routed", async () => {
  sqlite.prepare("UPDATE sms_messages SET created_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(outId);
  await inbound("+12146937094", "late answer");
  eq([lastIn().route, lastIn().app_id], ["unrouted", null]);
});

await t("STOP opts out (sending refused before Twilio); START opts back in", async () => {
  await inbound("+12145550100", "Stop", { OptOutType: "STOP" });
  const m = lastIn(); eq([m.keyword, m.route], ["STOP", "keyword"]); ok(m.handled_at, "nothing for an app to do");
  const calls = twilioCalls.length;
  const r = await send(env, { app: "planner", to: "+12145550100", body: "hi" }, { fetchImpl });
  eq([r.ok, r.reason], [false, "opted_out"]); eq(twilioCalls.length, calls, "Twilio not called");
  await inbound("+12145550100", "start");
  eq(lastIn().keyword, "START");
  ok((await send(env, { app: "planner", to: "+12145550100", body: "hi" }, { fetchImpl })).ok);
});

await t("sending: bad number, empty, unknown app, daily cap, Twilio refusal is saved with its code", async () => {
  eq((await send(env, { app: "planner", to: "12", body: "x" }, { fetchImpl })).reason, "bad_number");
  eq((await send(env, { app: "planner", to: "+12145550101", body: "  " }, { fetchImpl })).reason, "empty");
  eq((await send(env, { app: "nope", to: "+12145550101", body: "x" }, { fetchImpl })).reason, "bad_app");
  twilioReply = () => ({ status: 400, body: { code: 21610, message: "Attempt to send to unsubscribed recipient" } });
  const r = await send(env, { app: "supplies", to: "+12145550102", body: "x" }, { fetchImpl });
  eq([r.ok, r.reason, r.code], [false, "twilio", 21610]);
  eq([get(r.id).status, get(r.id).error_code], ["failed", 21610]);
  twilioReply = () => ({ status: 201, body: { sid: "SMok" + twilioCalls.length, status: "queued" } });
  // the cap (3 here) counts the app's texts in the last 24 hours
  const sent = () => sqlite.prepare("SELECT COUNT(*) n FROM sms_messages WHERE direction='out' AND app_id='planner' AND created_at >= ?").get(new Date(Date.now() - 864e5).toISOString()).n;
  while (sent() < 3) ok((await send(env, { app: "planner", to: "+12145550103", body: "x" }, { fetchImpl })).ok);
  eq((await send(env, { app: "planner", to: "+12145550103", body: "x" }, { fetchImpl })).reason, "daily_cap");
  ok((await send(env, { app: "retail", to: "+12145550103", body: "x" }, { fetchImpl })).ok, "cap is per app");
});

await t("delivery updates: signed, applied by Twilio id, a final status isn't undone", async () => {
  const sid = get(outId).twilio_sid;
  eq((await webhook("/twilio/status", { MessageSid: sid, MessageStatus: "sent" })).status, 204);
  eq(get(outId).status, "sent");
  await webhook("/twilio/status", { MessageSid: sid, MessageStatus: "undelivered", ErrorCode: "30034" });
  eq([get(outId).status, get(outId).error_code], ["undelivered", 30034]);
  await webhook("/twilio/status", { MessageSid: sid, MessageStatus: "sent" });
  eq(get(outId).status, "undelivered", "late 'sent' callback ignored");
  eq((await webhook("/twilio/status", { MessageSid: sid, MessageStatus: "delivered" }, { sign: false })).status, 403);
});

await t("FORWARD_MODE unrouted: replies to apps aren't emailed; none: nothing is", async () => {
  env.FORWARD_MODE = "unrouted";
  await send(env, { app: "retail", to: "+12145550104", body: "q?" }, { fetchImpl });
  const before = emails.length;
  await inbound("+12145550104", "yes");
  eq(emails.length, before, "reply not emailed");
  await inbound("+12145550105", "who is this?");
  eq(emails.length, before + 1, "unrouted emailed");
  env.FORWARD_MODE = "none";
  await inbound("+12145550106", "hello");
  eq(emails.length, before + 1);
  env.FORWARD_MODE = "all";
});

await t("not set up: webhook says so (503), sending returns not_set_up", async () => {
  const saved = env.TWILIO_AUTH_TOKEN; delete env.TWILIO_AUTH_TOKEN;
  eq((await webhook("/twilio/inbound", { MessageSid: "SMy", From: "+12146937094", Body: "x" }, { sign: false })).status, 503);
  eq((await send(env, { app: "planner", to: "+12145550107", body: "x" }, { fetchImpl })).reason, "not_set_up");
  env.TWILIO_AUTH_TOKEN = saved;
});

await t("API key used for sending when set", async () => {
  env.TWILIO_API_KEY_SID = "SKtest"; env.TWILIO_API_KEY_SECRET = "sec";
  await send(env, { app: "sms", to: "+12145550108", body: "x" }, { fetchImpl });
  eq(twilioCalls.at(-1).auth, "Basic " + btoa("SKtest:sec"));
  delete env.TWILIO_API_KEY_SID; delete env.TWILIO_API_KEY_SECRET;
});

await t("page and API: sign-in needed; managers can't read texts; owner lists, filters, sends, marks done", async () => {
  eq((await call("GET", "/", { as: null })).status, 401);
  eq((await call("GET", "/api/messages", { as: null })).status, 401);
  eq((await call("GET", "/api/messages", { as: "mgr@x.com" })).status, 403);
  const page = await call("GET", "/"); eq(page.status, 200); ok(page.body.includes("<title>Texts</title>"));
  const me = await call("GET", "/api/me"); eq([me.body.number, me.body.ready], ["(903) 689-9487", true]);
  const all = await call("GET", "/api/messages"); eq(all.status, 200); ok(all.body.messages.length > 10);
  ok(all.body.messages[0].created_at >= all.body.messages.at(-1).created_at, "newest first");
  const conv = await call("GET", "/api/messages?phone=%2B12146937094");
  ok(conv.body.messages.every(m => m.phone === "+12146937094"));
  const s = await call("POST", "/api/send", { body: { to: "214-693-7094", body: "From the Texts page" } });
  eq(s.status, 201, JSON.stringify(s.body));
  const row = get(s.body.id); eq([row.app_id, row.ref, row.sent_by], ["sms", "manual", nealId]);
  eq((await call("POST", "/api/send", { body: { to: "x", body: "y" } })).status, 400);
  eq((await call("POST", "/api/send", { as: "mgr@x.com", body: { to: "2146937094", body: "y" } })).status, 403);
  await inbound("+12146937094", "reply to the page");
  const m = lastIn(); eq([m.app_id, m.route], ["sms", "reply"]);
  eq((await call("POST", `/api/messages/${m.id}/handled`)).body.updated, 1);
  const un = sqlite.prepare("SELECT id FROM sms_messages WHERE route='unrouted' AND handled_at IS NULL LIMIT 1").get();
  eq((await call("POST", `/api/messages/${un.id}/handled`)).body.updated, 1, "unrouted texts can be marked done too");
});

await t("unknown paths 404", async () => {
  eq((await call("GET", "/api/nope")).status, 404);
  eq((await webhook("/twilio/other", {})).status, 404);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
