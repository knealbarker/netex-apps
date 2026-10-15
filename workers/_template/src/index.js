// Starter for a new netexcleaners.com app (copy to workers/<name>; see docs/new-app.md).
// What it already does:
//  - every request goes through this Worker first; nothing (not even a static file) is served without a valid Access sign-in
//  - /api/* also needs the person on the user list with a role in this app (env.APP_ID)
//  - Users & access for this app (Admins and the Owner), which keeps the "Netex users" Access group in step
//  - one example data endpoint reading the shared database
import { currentUser, verifyAccessJwt, requireRole } from "../../planner/src/auth.js";
import { listUsers, createUser, updateUser, syncAccessGroup } from "../../planner/src/users.js";
import { HttpError, json, readJson } from "../../planner/src/util.js";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
const withHeaders = res => { const r = new Response(res.body, res); for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v); return r; };

// today's date in the company's time zone, 'YYYY-MM-DD'
export const localToday = (tz = "America/Chicago", at = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

// [method, path pattern, handler(req, env, me, match, opts)] — `me` = { id, email, name, role, roles }
const routes = [
  ["GET", /^\/api\/me$/, async (req, env, me) => json({ user: me, app: { id: env.APP_ID, name: env.APP_NAME || env.APP_ID }, today: localToday(env.TIMEZONE) })],

  // Example: read the shared database. SMRT times are Central local with offset, so a day is a string range.
  ["GET", /^\/api\/orders-today$/, async (req, env) => {
    const day = new URL(req.url).searchParams.get("day") || localToday(env.TIMEZONE);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "Use a date like 2026-10-15.");
    const next = new Date(Date.parse(day + "T12:00:00Z") + 864e5).toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(`SELECT COALESCE(l.name, 'Unknown') AS store, COUNT(*) AS orders
        FROM pos_orders o JOIN pos_order_statuses s ON s.id = o.status_id LEFT JOIN core_locations l ON l.id = o.drop_location_id
       WHERE o.org_id = ? AND o.detailed_at >= ? AND o.detailed_at < ? AND s.is_void = 0 AND o.smrt_deleted_at IS NULL
       GROUP BY 1 ORDER BY 2 DESC`).bind(env.ORG_ID, day, next).all();
    return json({ day, stores: results });
  }],

  // Users & access for this app (same code as the planner and Retail Snapshot)
  ["GET", /^\/api\/users$/, async (req, env, me) => json({ users: await listUsers(env.DB, env, me), groupSync: Boolean(env.CF_API_TOKEN && env.ACCESS_GROUP_ID) })],
  ["POST", /^\/api\/users$/, async (req, env, me, m, opts) => {
    const r = await createUser(env.DB, env, me, await readJson(req));
    return json({ ...r, access: await syncAccessGroup(env.DB, env, opts.fetchImpl) }, 201);
  }],
  ["PATCH", /^\/api\/users\/([0-9A-Z]{26})$/, async (req, env, me, m, opts) => {
    const r = await updateUser(env.DB, env, me, m[1], await readJson(req));
    return json({ ...r, access: r.changed ? await syncAccessGroup(env.DB, env, opts.fetchImpl) : { synced: false, reason: "unchanged" } });
  }],

  // Example of a role check: Admins and the Owner only
  ["GET", /^\/api\/admin-check$/, async (req, env, me) => { requireRole(me, "admin"); return json({ ok: true }); }],
];

export async function handle(req, env, opts = {}) {
  const url = new URL(req.url);
  try {
    if (url.pathname.startsWith("/api/")) {
      const me = await currentUser(req, env, opts);
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await fn(req, env, me, m, opts);
      }
      const anyPath = routes.some(([, re]) => re.test(url.pathname));
      throw new HttpError(anyPath ? 405 : 404, anyPath ? "Method not allowed." : "Not found.");
    }
    // Pages and files: a valid Access sign-in is enough (they hold no company data; the data comes from /api)
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
    return json({ error: "Something went wrong on our side. Try again; if it keeps happening, tell Neal." }, 500);
  }
}

export default {
  async fetch(req, env) { return withHeaders(await handle(req, env)); },
  // Only runs if [triggers] crons is set in wrangler.toml
  async scheduled(event, env, ctx) { console.log(JSON.stringify({ job: env.APP_ID, cron: event.cron })); },
};
