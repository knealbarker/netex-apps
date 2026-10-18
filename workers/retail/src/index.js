// retailview.netexcleaners.com — Retail Snapshot: store and company sales, revenue, labor hours and labor cost.
// Same sign-in as the planner (Cloudflare Access "Netex apps" + core_users); roles come from core_user_app_roles for app 'retail'.
// Every request comes through here first (static files too), so nothing is served without a valid sign-in.
import { currentUser, verifyAccessJwt, requireRole } from "../../planner/src/auth.js";
import { listUsers, createUser, updateUser, syncAccessGroup } from "../../planner/src/users.js";
import { HttpError, json, readJson, audit } from "../../planner/src/util.js";
import { ingestRippling } from "../../sync/src/rippling.js";
import { snapshot, localToday, addDays } from "./snapshot.js";
import { buildSummary, deliver, scheduledSummary } from "./summary.js";
import { loadSettings, saveSettings, settingsContext } from "./settings.js";
import { counter, markCheck } from "./counter.js";
import { wrongStoreAlerts, wrongStoreNow } from "./alerts.js";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
const withHeaders = res => {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
};
const MAX_CSV = 5 * 1024 * 1024;

const routes = [
  ["GET", /^\/api\/me$/, async (req, env, me) => json({ user: me, app: { id: env.APP_ID, name: "Retail Snapshot" }, today: localToday(env.TIMEZONE, env.NOW ? new Date(env.NOW) : new Date()), weekStart: (await loadSettings(env.DB, env)).weekStart })],
  ["GET", /^\/api\/snapshot$/, async (req, env, me) => {
    const u = new URL(req.url);
    return json(await snapshot(env.DB, env, me, u.searchParams.get("from"), u.searchParams.get("to"), { now: env.NOW ? Date.parse(env.NOW) : Date.now() }));
  }],
  // Counter: visits, detailing speed, visits per labor hour and the clock check (SMRT work vs Rippling punches)
  ["GET", /^\/api\/counter$/, async (req, env, me) => {
    const u = new URL(req.url);
    return json(await counter(env.DB, env, me, u.searchParams.get("from"), u.searchParams.get("to"), { now: env.NOW ? Date.parse(env.NOW) : Date.now() }));
  }],
  ["GET", /^\/api\/counter\/now$/, async (req, env) => json({ wrongStore: await wrongStoreNow(env.DB, env, { now: env.NOW ? Date.parse(env.NOW) : Date.now() }) })],
  ["POST", /^\/api\/counter\/check$/, async (req, env, me) => json(await markCheck(env.DB, env, me, await readJson(req)))],
  ["GET", /^\/api\/settings$/, async (req, env, me) => {
    requireRole(me, "admin");
    return json({ settings: await loadSettings(env.DB, env), ...(await settingsContext(env.DB, env)) });
  }],
  ["PUT", /^\/api\/settings$/, async (req, env, me) => json({ settings: await saveSettings(env.DB, env, me, await readJson(req)) })],
  // One-time or catch-up load of a Rippling "All Time Clock Entries" CSV (e.g. after the export schedule was off). Owner only.
  ["POST", /^\/api\/import\/rippling$/, async (req, env, me) => {
    requireRole(me, "owner");
    const body = await readJson(req);
    const csv = String(body.csv || "");
    if (!csv.trim()) throw new HttpError(400, "Choose the Rippling CSV file.");
    if (csv.length > MAX_CSV) throw new HttpError(400, "That file is too big (5 MB at most).");
    let res;
    try { res = await ingestRippling(env.DB, { orgId: env.ORG_ID, integrationId: "rippling", today: localToday(env.TIMEZONE), csv, keepToday: true }); }
    catch (e) { throw new HttpError(400, String(e.message || e)); }
    await audit(env.DB, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "labor_daily_hours", entityId: "rippling-import", action: "create", changes: { rows: res.rows, used: res.used, days: res.days } });
    return json(res);
  }],
  // Daily summary: preview (any day) and a test send (to the summary list, or to you if the list is empty). Admins and the Owner.
  ["GET", /^\/api\/summary\/preview$/, async (req, env, me) => {
    requireRole(me, "admin");
    const d = new URL(req.url).searchParams.get("day") || addDays(localToday(env.TIMEZONE), -1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, "Use a date like 2026-10-12.");
    const msg = await buildSummary(env.DB, env, d);
    return new Response(msg.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }],
  ["POST", /^\/api\/summary\/test$/, async (req, env, me, m, opts) => {
    requireRole(me, "admin");
    const s = await loadSettings(env.DB, env);
    const to = s.summary.to.length ? s.summary.to : [me.email];
    const msg = await buildSummary(env.DB, env, addDays(localToday(env.TIMEZONE), -1));
    let res;
    try { res = await deliver(env, msg, to, { send: opts.send }); } catch (e) { throw new HttpError(503, String(e.message || e)); }
    if (!res.sent.length) throw new HttpError(502, `Couldn't send: ${res.failed.map(f => `${f.to} (${f.error})`).join("; ")}. Each address must be verified in Cloudflare › Email Routing › Destination addresses.`);
    return json(res);
  }],
  ["GET", /^\/api\/users$/, async (req, env, me) => json({ users: await listUsers(env.DB, env, me), groupSync: Boolean(env.CF_API_TOKEN && env.ACCESS_GROUP_ID) })],
  ["POST", /^\/api\/users$/, async (req, env, me) => {
    const r = await createUser(env.DB, env, me, await readJson(req));
    return json({ ...r, access: await syncAccessGroup(env.DB, env) }, 201);
  }],
  ["PATCH", /^\/api\/users\/([0-9A-Z]{26})$/, async (req, env, me, m) => {
    const r = await updateUser(env.DB, env, me, m[1], await readJson(req));
    return json({ ...r, access: r.changed ? await syncAccessGroup(env.DB, env) : { synced: false, reason: "unchanged" } });
  }],
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
    // The page itself holds no company data; the data comes from /api, which checks the user list.
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
  // every 10 minutes: the wrong-store text; the daily summary email goes out once, at the hour set in Settings
  async scheduled(event, env, ctx) {
    try { console.log(JSON.stringify({ job: "wrong-store-text", ...(await wrongStoreAlerts(env)) })); }
    catch (e) { console.log(JSON.stringify({ job: "wrong-store-text", status: "error", error: String(e.message || e) })); }
    try { console.log(JSON.stringify({ job: "retail-summary", ...(await scheduledSummary(env)) })); }
    catch (e) { console.log(JSON.stringify({ job: "retail-summary", status: "error", error: String(e.message || e) })); }
  },
};
