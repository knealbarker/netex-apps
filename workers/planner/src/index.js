// prodplanner.netexcleaners.com — the Production Planner web app.
// Every request comes through here first (static files too), so nothing is served without a valid sign-in.
import { currentUser, verifyAccessJwt } from "./auth.js";
import { listUsers, createUser, updateUser, syncAccessGroup } from "./users.js";
import { requireRole } from "./auth.js";
import { HttpError, json, readJson } from "./util.js";
import { allSettings, saveGroup, saveProduction, saveRuns } from "./settings.js";
import { listTeam, addPerson, updatePerson, setTrainings, teamHistory } from "./team.js";
import { importDesktop } from "./import.js";
import { piecesView } from "./pieces.js";
import { loadPlan, savePlan, publishPlan, addCallout, removeCallout, publishedPlan } from "./plan.js";
import { reviewDay, noteFollowup, laborStreak } from "./review.js";
import { listChanges, addEvent } from "./changes.js";
import { buildSummary, sendNow, scheduledSummary } from "./summary.js";
import { checkAttendance } from "./attendance.js";
import { localNow } from "./pieces.js";
import { listTimeOff, addTimeOff, removeTimeOff } from "./timeoff.js";

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

const routes = [
  ["GET", /^\/api\/me$/, async (req, env, me) => json({ user: me, app: { id: env.APP_ID, name: "Production Planner" } })],
  ["GET", /^\/api\/users$/, async (req, env, me) => json({ users: await listUsers(env.DB, env, me), groupSync: Boolean(env.CF_API_TOKEN && env.ACCESS_GROUP_ID) })],
  ["POST", /^\/api\/users$/, async (req, env, me, m, ctx) => {
    const r = await createUser(env.DB, env, me, await readJson(req));
    return json({ ...r, access: await syncAccessGroup(env.DB, env) }, 201);
  }],
  ["POST", /^\/api\/users\/sync-access$/, async (req, env, me) => { requireRole(me, "admin"); return json({ access: await syncAccessGroup(env.DB, env) }); }],
  ["PATCH", /^\/api\/users\/([0-9A-Z]{26})$/, async (req, env, me, m) => {
    const r = await updateUser(env.DB, env, me, m[1], await readJson(req));
    return json({ ...r, access: r.changed ? await syncAccessGroup(env.DB, env) : { synced: false, reason: "unchanged" } });
  }],
  ["GET", /^\/api\/settings$/, async (req, env, me) => json(await allSettings(env.DB, env, me))],
  ["PUT", /^\/api\/settings\/production$/, async (req, env, me) => json(await saveProduction(env.DB, env, me, await readJson(req)))],
  ["PUT", /^\/api\/settings\/runs$/, async (req, env, me) => json({ runs: await saveRuns(env.DB, env, me, (await readJson(req)).runs) })],
  ["PUT", /^\/api\/settings\/(\w+)$/, async (req, env, me, m) => json({ [m[1]]: await saveGroup(env.DB, env, me, m[1], await readJson(req)) })],
  ["GET", /^\/api\/team$/, async (req, env, me) => json(await listTeam(env.DB, env, me))],
  ["GET", /^\/api\/timeoff$/, async (req, env) => { const u = new URL(req.url).searchParams; return json(await listTimeOff(env.DB, env, { from: u.get("from"), to: u.get("to") })); }],
  ["POST", /^\/api\/timeoff$/, async (req, env, me) => json(await addTimeOff(env.DB, env, me, await readJson(req)), 201)],
  ["DELETE", /^\/api\/timeoff\/([0-9A-Z]{26})$/, async (req, env, me, m) => json(await removeTimeOff(env.DB, env, me, m[1]))],
  ["GET", /^\/api\/team\/history$/, async (req, env, me) => json(await teamHistory(env.DB, env, me))],
  ["POST", /^\/api\/team$/, async (req, env, me) => json(await addPerson(env.DB, env, me, await readJson(req)), 201)],
  ["PATCH", /^\/api\/team\/([0-9A-Z]{26})$/, async (req, env, me, m) => json(await updatePerson(env.DB, env, me, m[1], await readJson(req)))],
  ["PUT", /^\/api\/team\/([0-9A-Z]{26})\/trainings$/, async (req, env, me, m) => json(await setTrainings(env.DB, env, me, m[1], (await readJson(req)).trainings))],
  ["POST", /^\/api\/import\/desktop$/, async (req, env, me) => json(await importDesktop(env.DB, env, me, await readJson(req)))],
  ["GET", /^\/api\/pieces$/, async (req, env) => { const d = new URL(req.url).searchParams.get("day"); return json(await piecesView(env.DB, env, { day: /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : null })); }],
  ["GET", /^\/api\/plan\/(\d{4}-\d{2}-\d{2})$/, async (req, env, me, m) => json(await loadPlan(env.DB, env, m[1]))],
  ["PUT", /^\/api\/plan\/(\d{4}-\d{2}-\d{2})$/, async (req, env, me, m) => json(await savePlan(env.DB, env, me, m[1], await readJson(req)))],
  ["POST", /^\/api\/plan\/(\d{4}-\d{2}-\d{2})\/publish$/, async (req, env, me, m) => json(await publishPlan(env.DB, env, me, m[1], await readJson(req)))],
  ["POST", /^\/api\/plan\/(\d{4}-\d{2}-\d{2})\/callouts$/, async (req, env, me, m) => json(await addCallout(env.DB, env, me, m[1], await readJson(req)), 201)],
  ["GET", /^\/api\/review\/(\d{4}-\d{2}-\d{2})$/, async (req, env, me, m) => json(await reviewDay(env.DB, env, me, m[1]))],
  ["PATCH", /^\/api\/followups\/([0-9A-Z]{26})$/, async (req, env, me, m) => json(await noteFollowup(env.DB, env, me, m[1], await readJson(req)))],
  ["DELETE", /^\/api\/plan\/(\d{4}-\d{2}-\d{2})\/callouts\/([0-9A-Z]{26})$/, async (req, env, me, m) => json(await removeCallout(env.DB, env, me, m[1], m[2]))],
  ["GET", /^\/api\/summary\/preview$/, async (req, env, me) => {
    requireRole(me, "admin");
    const d = new URL(req.url).searchParams.get("day"), today = localNow(env.TIMEZONE).day;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(d || "") && d <= today ? d : today;
    const m = await buildSummary(env.DB, env, day); return json({ subject: m.subject, html: m.html, day: m.day, next: m.next });
  }],
  ["POST", /^\/api\/summary\/send$/, async (req, env, me) => { requireRole(me, "admin"); const b = await readJson(req); return json(await sendNow(env.DB, env, me, { to: b.to || null, day: b.day || null })); }],
  ["GET", /^\/api\/changes\/(\d{4}-\d{2}-\d{2})$/, async (req, env, me, m) => json(await listChanges(env.DB, env, m[1]))],
  ["POST", /^\/api\/events$/, async (req, env, me) => json(await addEvent(env.DB, env, me, await readJson(req)))],
  ["GET", /^\/api\/floor\/(\d{4}-\d{2}-\d{2})$/, async (req, env, me, m) => json({ published: await publishedPlan(env.DB, env, m[1]), ...(new URL(req.url).searchParams.has("streak") ? { streak: await laborStreak(env.DB, env).catch(() => null) } : {}) })],
  ["GET", /^\/api\/system$/, async (req, env) => {
    const db = env.DB;
    const s = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='smrt_backfill'").bind(env.ORG_ID).first();
    const h = await db.prepare("SELECT COUNT(*) AS days, MIN(day) AS oldest, SUM(orders) AS orders, SUM(items) AS items FROM int_backfill_days WHERE integration_id='smrt' AND status IN ('done','empty')").first();
    const last = await db.prepare("SELECT started_at AS at, status, message FROM int_sync_runs WHERE integration_id='smrt' ORDER BY started_at DESC LIMIT 1").first();
    const state = s ? JSON.parse(s.value_json) : null;
    return json({ smrtHistory: { ...h, finished: !!state?.finished }, lastSync: last });
  }],
];

export async function handle(req, env, opts = {}) {
  const url = new URL(req.url);
  try {
    if (url.pathname.startsWith("/api/")) {
      const me = await currentUser(req, env, opts);
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await fn(req, env, me, m);
      }
      const anyPath = routes.some(([, re]) => re.test(url.pathname));
      throw new HttpError(anyPath ? 405 : 404, anyPath ? "Method not allowed." : "Not found.");
    }
    // The page itself holds no company data, so anyone Access let in gets it; the data comes from /api, which checks the user list.
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
  // every 5 minutes: today's plan against the time clock (not clocked in / clocked in late, written once each);
  // the daily summary email goes out once, after its time on work days
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAttendance(env).then(r => { if (r.events.length) console.log(JSON.stringify({ job: "attendance", ...r })); })
      .catch(e => console.error(JSON.stringify({ job: "attendance", error: String(e && e.stack || e) }))));
    ctx.waitUntil(scheduledSummary(env).then(r => { if (r.status === "sent" || r.status === "failed") console.log(JSON.stringify({ job: "summary", ...r })); })
      .catch(e => console.error(JSON.stringify({ job: "summary", error: String(e && e.stack || e) }))));
  },
};
