// netex-sms at sms.netexcleaners.com: the shared text-message service.
//  /twilio/inbound, /twilio/status  Twilio webhooks. Public (Access Bypass for /twilio); every request must carry a valid Twilio signature.
//  /api/*                           the Texts page (sign-in + a role in app 'sms'; Admins and the Owner see and send)
//  other apps                       call the Texts entrypoint over a service binding (see src/worker.js, README.md)
import { currentUser, verifyAccessJwt, requireRole } from "../../planner/src/auth.js";
import { listUsers, createUser, updateUser, syncAccessGroup } from "../../planner/src/users.js";
import { HttpError, json, readJson } from "../../planner/src/util.js";
import { readTwilio, receive, status, send, markHandled, pretty } from "./texts.js";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
export const withHeaders = res => { const r = new Response(res.body, res); for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v); return r; };

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const twiml = () => new Response(EMPTY_TWIML, { headers: { "content-type": "text/xml; charset=utf-8" } });

const routes = [
  ["GET", /^\/api\/me$/, async (req, env, me) => json({ user: me, app: { id: env.APP_ID, name: env.APP_NAME }, number: pretty(env.TWILIO_FROM || ""),
    ready: Boolean(env.TWILIO_AUTH_TOKEN && env.TWILIO_ACCOUNT_SID && env.TWILIO_MESSAGING_SERVICE_SID) })],

  // all texts, newest first (Admins and the Owner)
  ["GET", /^\/api\/messages$/, async (req, env, me) => {
    requireRole(me, "admin");
    const q = new URL(req.url).searchParams;
    const before = q.get("before") || "9999", app = q.get("app") || null, phone = q.get("phone") || null;
    const { results } = await env.DB.prepare(`SELECT m.id, m.direction, m.phone, m.body, m.media_count, m.app_id, a.name AS app_name, m.ref, m.reply_to_id,
          m.route, m.keyword, m.status, m.error_code, m.handled_at, m.forwarded_at, m.created_at, u.display_name AS name, s.display_name AS sent_by_name
        FROM sms_messages m LEFT JOIN core_apps a ON a.id = m.app_id LEFT JOIN core_users u ON u.id = m.user_id LEFT JOIN core_users s ON s.id = m.sent_by
       WHERE m.org_id=? AND m.created_at < ? AND (? IS NULL OR m.app_id = ?) AND (? IS NULL OR m.phone = ?)
       ORDER BY m.created_at DESC, m.id DESC LIMIT 100`).bind(env.ORG_ID, before, app, app, phone, phone).all();
    const opted = (await env.DB.prepare("SELECT phone FROM sms_contacts WHERE org_id=? AND opted_out_at IS NOT NULL").bind(env.ORG_ID).all()).results.map(r => r.phone);
    return json({ messages: results, optedOut: opted });
  }],

  // send a text by hand (Admins and the Owner); replies come back to this page
  ["POST", /^\/api\/send$/, async (req, env, me, m, opts) => {
    requireRole(me, "admin");
    const b = await readJson(req);
    const r = await send(env, { app: env.APP_ID, to: b.to, body: b.body, ref: "manual", sentBy: me.id }, { fetchImpl: opts.fetchImpl });
    if (!r.ok && r.reason !== "twilio") throw new HttpError(400, r.error);
    return json(r, r.ok ? 201 : 502);
  }],

  // mark a reply dealt with (Admins and the Owner; any app's)
  ["POST", /^\/api\/messages\/([0-9A-Z]{26})\/handled$/, async (req, env, me, m) => {
    requireRole(me, "admin");
    const row = await env.DB.prepare("SELECT app_id FROM sms_messages WHERE id=? AND org_id=?").bind(m[1], env.ORG_ID).first();
    if (!row) throw new HttpError(404, "Not found.");
    if (!row.app_id) {   // unrouted texts belong to no app; mark directly
      await env.DB.prepare("UPDATE sms_messages SET handled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND handled_at IS NULL").bind(m[1]).run();
      return json({ updated: 1 });
    }
    return json(await markHandled(env, { app: row.app_id, ids: [m[1]] }));
  }],

  ["GET", /^\/api\/users$/, async (req, env, me) => json({ users: await listUsers(env.DB, env, me), groupSync: Boolean(env.CF_API_TOKEN && env.ACCESS_GROUP_ID) })],
  ["POST", /^\/api\/users$/, async (req, env, me, m, opts) => {
    const r = await createUser(env.DB, env, me, await readJson(req));
    return json({ ...r, access: await syncAccessGroup(env.DB, env, opts.fetchImpl) }, 201);
  }],
  ["PATCH", /^\/api\/users\/([0-9A-Z]{26})$/, async (req, env, me, m, opts) => {
    const r = await updateUser(env.DB, env, me, m[1], await readJson(req));
    return json({ ...r, access: r.changed ? await syncAccessGroup(env.DB, env, opts.fetchImpl) : { synced: false, reason: "unchanged" } });
  }],
];

export async function handle(req, env, opts = {}) {
  const url = new URL(req.url);
  try {
    // Twilio webhooks: no Access sign-in (Bypass for /twilio); the Twilio signature is the check
    if (url.pathname === "/twilio/inbound" || url.pathname === "/twilio/status") {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed.");
      const params = await readTwilio(req, env);
      if (url.pathname === "/twilio/inbound") { await receive(env, params, { send: opts.sendEmail }); return twiml(); }
      await status(env, params);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/twilio/")) throw new HttpError(404, "Not found.");

    if (url.pathname.startsWith("/api/")) {
      const me = await currentUser(req, env, opts);
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await fn(req, env, me, m, opts);
      }
      const anyPath = routes.some(([, re]) => re.test(url.pathname));
      throw new HttpError(anyPath ? 405 : 404, anyPath ? "Method not allowed." : "Not found.");
    }
    if (!(env.DEV_EMAIL && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      const token = req.headers.get("cf-access-jwt-assertion") || (req.headers.get("cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
      await verifyAccessJwt(token, { teamDomain: env.TEAM_DOMAIN, aud: env.ACCESS_AUD, fetchImpl: opts.fetchImpl || fetch });
    }
    return await env.ASSETS.fetch(req);
  } catch (e) {
    if (e instanceof HttpError) {
      if (!url.pathname.startsWith("/api/")) return new Response(`${e.message}\n`, { status: e.status, headers: { "content-type": "text/plain; charset=utf-8" } });
      return json({ error: e.message, ...(e.extra || {}) }, e.status);
    }
    console.error(JSON.stringify({ error: String(e && e.stack || e), path: url.pathname }));
    // Twilio retries on 5xx, which is what we want if the database hiccups
    return json({ error: "Something went wrong on our side. Try again; if it keeps happening, tell Neal." }, 500);
  }
}
