// Texts: the one place netexcleaners.com sends and receives text messages (Twilio, (903) 689-9487).
//  - send():      any app sends through here (service binding), so the Twilio credentials live in one Worker only
//  - receive():   Twilio posts each incoming text; it is saved, routed to the app whose text it answers, and emailed to Neal
//  - status():    Twilio posts delivery updates for texts we sent
// Runs in Cloudflare Workers and in Node 22 (tests). Network calls go through an injectable fetch.
import { ulid, nowIso, HttpError, cleanPhone } from "../../planner/src/util.js";

export const REPLY_WINDOW_DAYS = 7;          // a text counts as a reply to our latest text to that phone within this many days
export const MAX_BODY = 1000;                // ~7 text segments; longer is almost certainly a bug
const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const OPT_IN = new Set(["START", "UNSTOP", "OPTIN"]);
const HELP = new Set(["HELP", "INFO"]);

const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const enc = new TextEncoder();

/** Twilio's request signature: base64(HMAC-SHA1(auth token, URL + each POST param name+value, sorted by name)). */
export async function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
const sameString = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/** Reads a Twilio webhook (form POST) and checks it really came from Twilio. Returns the params. */
export async function readTwilio(req, env) {
  if (!env.TWILIO_AUTH_TOKEN) throw new HttpError(503, "Texts aren't set up yet (TWILIO_AUTH_TOKEN is missing).");
  const form = await req.formData();
  const params = {};
  for (const [k, v] of form) params[k] = String(v);
  const u = new URL(req.url);   // Twilio signs the full URL it posted to, query string included
  const url = env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/$/, "") + u.pathname + u.search : req.url;
  const expected = await twilioSignature(env.TWILIO_AUTH_TOKEN, url, params);
  if (!sameString(req.headers.get("x-twilio-signature") || "", expected)) throw new HttpError(403, "Bad signature.");
  return params;
}

const keywordOf = (params, body) => {
  const t = String(params.OptOutType || "").toUpperCase();
  if (["STOP", "START", "HELP"].includes(t)) return t;
  const w = String(body || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (OPT_OUT.has(w)) return "STOP";
  if (OPT_IN.has(w)) return "START";
  if (HELP.has(w)) return "HELP";
  return null;
};

const userByPhone = (db, org, phone) =>
  db.prepare("SELECT id, display_name AS name FROM core_users WHERE org_id=? AND phone=? AND deleted_at IS NULL").bind(org, phone).first();

/** An incoming text from Twilio. Saves it, routes it, and (by FORWARD_MODE) emails it. Returns the saved row. */
export async function receive(env, params, { now = Date.now(), send } = {}) {
  const db = env.DB, org = env.ORG_ID;
  const phone = normalize(params.From);
  if (!phone) throw new HttpError(400, "No sender.");
  if (params.MessageSid) {
    const dup = await db.prepare("SELECT * FROM sms_messages WHERE twilio_sid=?").bind(params.MessageSid).first();
    if (dup) return dup;   // Twilio retried; already saved
  }
  const body = String(params.Body || "").slice(0, 4000);
  const keyword = keywordOf(params, body);
  const since = new Date(now - REPLY_WINDOW_DAYS * 864e5).toISOString();
  const last = await db.prepare(`SELECT id, app_id, ref, body FROM sms_messages
      WHERE org_id=? AND direction='out' AND phone=? AND app_id IS NOT NULL AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .bind(org, phone, since).first();
  const user = await userByPhone(db, org, phone);
  const route = keyword ? "keyword" : last ? "reply" : "unrouted";
  const at = new Date(now).toISOString();
  const row = {
    id: ulid(now), org_id: org, direction: "in", phone, our_number: normalize(params.To), body,
    media_count: +params.NumMedia || 0, app_id: last ? last.app_id : null, ref: last ? last.ref : null, reply_to_id: last ? last.id : null,
    user_id: user ? user.id : null, route, keyword, twilio_sid: params.MessageSid || null, status: "received",
    handled_at: keyword ? at : null,   // STOP/START/HELP need nothing from the app; Twilio answers them itself
    created_at: at,
  };
  await db.prepare(`INSERT INTO sms_messages(id, org_id, direction, phone, our_number, body, media_count, app_id, ref, reply_to_id, user_id,
      route, keyword, twilio_sid, status, handled_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, org, "in", phone, row.our_number, body, row.media_count, row.app_id, row.ref, row.reply_to_id, row.user_id,
      route, keyword, row.twilio_sid, row.status, row.handled_at, at, at).run();
  if (keyword === "STOP" || keyword === "START") {
    await db.prepare(`INSERT INTO sms_contacts(org_id, phone, opted_out_at, updated_at) VALUES(?,?,?,?)
        ON CONFLICT(org_id, phone) DO UPDATE SET opted_out_at=excluded.opted_out_at, updated_at=excluded.updated_at`)
      .bind(org, phone, keyword === "STOP" ? at : null, at).run();
  }
  const mode = String(env.FORWARD_MODE || "all").toLowerCase();
  if (env.FORWARD_TO && (mode === "all" || (mode === "unrouted" && route !== "reply"))) {
    try {
      const r = await forwardEmail(env, { ...row, name: user ? user.name : null, answering: last ? last.body : null }, { send, now });
      if (r.sent.length) await db.prepare("UPDATE sms_messages SET forwarded_at=? WHERE id=?").bind(at, row.id).run();
      if (r.failed.length) console.error(JSON.stringify({ job: "sms-forward", failed: r.failed }));
    } catch (e) { console.error(JSON.stringify({ job: "sms-forward", error: String(e.message || e) })); }
  }
  return row;
}

/** Delivery update from Twilio for a text we sent. */
export async function status(env, params) {
  const sid = params.MessageSid || params.SmsSid;
  if (!sid) throw new HttpError(400, "No message id.");
  const st = String(params.MessageStatus || params.SmsStatus || "").toLowerCase() || null;
  const code = params.ErrorCode ? +params.ErrorCode || null : null;
  // never move a final status back (Twilio can deliver callbacks out of order)
  const r = await env.DB.prepare(`UPDATE sms_messages SET status=?, error_code=COALESCE(?, error_code), updated_at=?
      WHERE twilio_sid=? AND direction='out' AND COALESCE(status,'') NOT IN ('delivered','undelivered','failed')`)
    .bind(st, code, nowIso(), sid).run();
  return { updated: r.meta.changes };
}

export const normalize = v => { try { return cleanPhone(v); } catch { return null; } };

/**
 * Sends a text. `app` = the sending app's id (replies route back to it), `ref` = its own reference for the conversation.
 * Never throws for Twilio refusals: returns { ok:false, reason, error } so the caller can carry on (e.g. fall back to email).
 */
export async function send(env, { app, to, body, ref = null, sentBy = null }, { fetchImpl = fetch, now = Date.now() } = {}) {
  const db = env.DB, org = env.ORG_ID;
  const phone = normalize(to);
  if (!phone) return { ok: false, reason: "bad_number", error: "That isn't a mobile number." };
  const text = String(body ?? "").trim();
  if (!text) return { ok: false, reason: "empty", error: "The text is empty." };
  if (text.length > MAX_BODY) return { ok: false, reason: "too_long", error: `Keep texts under ${MAX_BODY} characters.` };
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_MESSAGING_SERVICE_SID || !(env.TWILIO_API_KEY_SID ? env.TWILIO_API_KEY_SECRET : env.TWILIO_AUTH_TOKEN))
    return { ok: false, reason: "not_set_up", error: "Texts aren't set up yet (Twilio settings are missing on netex-sms)." };
  if (!app || !(await db.prepare("SELECT 1 FROM core_apps WHERE id=?").bind(app).first())) return { ok: false, reason: "bad_app", error: `Unknown app "${app}".` };
  const opted = await db.prepare("SELECT opted_out_at FROM sms_contacts WHERE org_id=? AND phone=?").bind(org, phone).first();
  if (opted && opted.opted_out_at) return { ok: false, reason: "opted_out", error: "That number texted STOP. They have to text START to (903) 689-9487 first." };
  // a runaway loop in some app must not send hundreds of texts
  const cap = +env.MAX_PER_APP_PER_DAY || 200;
  const n = await db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE org_id=? AND direction='out' AND app_id=? AND created_at >= ?")
    .bind(org, app, new Date(now - 864e5).toISOString()).first();
  if (n.n >= cap) return { ok: false, reason: "daily_cap", error: `This app already sent ${cap} texts in the last 24 hours.` };

  const id = ulid(now), at = new Date(now).toISOString();
  const form = new URLSearchParams({ To: phone, Body: text, MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID });
  if (env.PUBLIC_URL) form.set("StatusCallback", env.PUBLIC_URL.replace(/\/$/, "") + "/twilio/status");
  const user = env.TWILIO_API_KEY_SID || env.TWILIO_ACCOUNT_SID, pass = env.TWILIO_API_KEY_SID ? env.TWILIO_API_KEY_SECRET : env.TWILIO_AUTH_TOKEN;
  let sid = null, st = "failed", code = null, err = null;
  try {
    const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST", body: form,
      headers: { authorization: "Basic " + btoa(`${user}:${pass}`), "content-type": "application/x-www-form-urlencoded" },
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { sid = j.sid || null; st = j.status || "queued"; }
    else { code = +j.code || null; err = j.message || `Twilio said ${r.status}.`; }
  } catch (e) { err = "Couldn't reach Twilio: " + String(e.message || e); }
  await db.prepare(`INSERT INTO sms_messages(id, org_id, direction, phone, our_number, body, app_id, ref, user_id, twilio_sid, status, error_code, sent_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,(SELECT id FROM core_users WHERE org_id=? AND phone=? AND deleted_at IS NULL),?,?,?,?,?,?)`)
    .bind(id, org, "out", phone, env.TWILIO_FROM || null, text, app, ref, org, phone, sid, st, code, sentBy, at, at).run();
  return err ? { ok: false, id, reason: "twilio", error: err, code } : { ok: true, id, sid, status: st };
}

/** Replies routed to an app. By default only those the app hasn't marked handled. Oldest first. */
export async function replies(env, { app, all = false, limit = 100 } = {}) {
  const { results } = await env.DB.prepare(`SELECT m.id, m.phone, m.body, m.media_count, m.ref, m.reply_to_id, m.user_id, u.display_name AS name,
        m.route, m.keyword, m.handled_at, m.created_at
      FROM sms_messages m LEFT JOIN core_users u ON u.id = m.user_id
     WHERE m.org_id=? AND m.direction='in' AND m.app_id=? ${all ? "" : "AND m.handled_at IS NULL"}
     ORDER BY m.created_at, m.id LIMIT ?`).bind(env.ORG_ID, app, Math.min(+limit || 100, 500)).all();
  return results;
}

/** An app marks replies it has dealt with (only its own). */
export async function markHandled(env, { app, ids }) {
  if (!Array.isArray(ids) || !ids.length) return { updated: 0 };
  const at = nowIso(); let updated = 0;
  for (const id of ids.slice(0, 500)) {
    const r = await env.DB.prepare("UPDATE sms_messages SET handled_at=?, updated_at=? WHERE id=? AND org_id=? AND direction='in' AND app_id=? AND handled_at IS NULL")
      .bind(at, at, String(id), env.ORG_ID, app).run();
    updated += r.meta.changes;
  }
  return { updated };
}

// ---------------------------------------------------------------- email copy to Neal
export const pretty = p => { const d = String(p || "").replace(/\D/g, ""); return d.length === 11 && d[0] === "1" ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : p; };
const FROM = "reports@netexcleaners.com";
const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...enc.encode(s)))}?=`;
const b64text = s => btoa(String.fromCharCode(...enc.encode(s))).replace(/.{76}/g, "$&\r\n");

export function forwardText(m, tz = "America/Chicago") {
  const who = m.name ? `${m.name} ${pretty(m.phone)}` : pretty(m.phone);
  const when = new Date(m.created_at).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const lines = [
    m.body || "(no text)", "",
    `From: ${who}`, `Received: ${when}`,
    m.media_count ? `Pictures: ${m.media_count} (not saved; see the Twilio log)` : null,
    m.keyword === "STOP" ? "They opted out: no more texts can go to this number until they text START." : null,
    m.keyword === "START" ? "They opted back in." : null,
    m.route === "reply" ? `Routed to: ${m.app_id}${m.ref ? ` (${m.ref})` : ""}` : m.route === "unrouted" ? "Not a reply to any text we sent in the last 7 days." : null,
    m.answering ? `Answering our text: "${m.answering}"` : null,
    "", "All texts: https://sms.netexcleaners.com",
  ];
  return { subject: `Text from ${who}`, text: lines.filter(l => l !== null).join("\n") };
}

export async function forwardEmail(env, m, { send, now = Date.now() } = {}) {
  if (!send) {
    if (!env.SEND_EMAIL) throw new Error("SEND_EMAIL binding is missing.");
    const { EmailMessage } = await import("cloudflare:email");
    send = (from, rcpt, raw) => env.SEND_EMAIL.send(new EmailMessage(from, rcpt, raw));
  }
  const { subject, text } = forwardText(m, env.TIMEZONE);
  const sent = [], failed = [];
  for (const rcpt of String(env.FORWARD_TO).split(",").map(s => s.trim()).filter(Boolean)) {
    const raw = [`From: Texts <${FROM}>`, `To: ${rcpt}`, `Subject: ${encWord(subject)}`, `Date: ${new Date(now).toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@netexcleaners.com>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64", "", b64text(text), ""].join("\r\n");
    try { await send(FROM, rcpt, raw); sent.push(rcpt); } catch (e) { failed.push({ to: rcpt, error: String(e.message || e) }); }
  }
  return { sent, failed };
}
