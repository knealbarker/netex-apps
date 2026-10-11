// netex-sync: background jobs for the netexcleaners.com apps.
// For now it only loads SMRT history (overnight on work days, all day on days off); the desktop planner still does the live reads during the day.
import { Smrt } from "./smrt.js";
import { runBackfill, backfillProgress } from "./backfill.js";
import { localNow } from "./util.js";

const inWindow = (hour, start, end) => (start <= end ? hour >= start && hour < end : hour >= start || hour < end);
const weekday = day => new Date(day + "T12:00:00Z").getUTCDay(); // 0 = Sunday

/** History loads overnight on work days, and all day on days off (nobody is using SMRT for production then). */
export function backfillAllowed({ day, hour, workDays = [1, 2, 3, 4, 5], start = 20, end = 5 }) {
  if (!workDays.includes(weekday(day))) return true;
  return inWindow(hour, start, end);
}

async function workDays(db, orgId) {
  try {
    const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='planner' AND key='day'").bind(orgId).first();
    const d = r && JSON.parse(r.value_json).workDays;
    return Array.isArray(d) && d.length ? d : undefined;
  } catch { return undefined; }
}

export default {
  async scheduled(event, env, ctx) {
    const tz = env.TIMEZONE || "America/Chicago";
    const { day, hour } = localNow(tz);
    // history overnight on work days (default 8 pm - 5 am) and all day on days off, so it never competes with the day's work in SMRT
    const allowed = backfillAllowed({ day, hour, workDays: await workDays(env.DB, env.ORG_ID), start: +(env.BACKFILL_START_HOUR ?? 20), end: +(env.BACKFILL_END_HOUR ?? 5) });
    if (!allowed) return;
    if (!env.SMRT_KEY) { console.log(JSON.stringify({ job: "smrt-backfill", status: "waiting", reason: "SMRT_KEY secret not set" })); return; }
    const smrt = new Smrt({ url: env.SMRT_URL, key: env.SMRT_KEY });
    const res = await runBackfill(env.DB, smrt, {
      orgId: env.ORG_ID, integrationId: env.SMRT_INTEGRATION_ID, today: day,
      daysPerRun: +(env.BACKFILL_DAYS_PER_RUN ?? 2), oldestDay: env.BACKFILL_OLDEST_DAY || "2021-01-01",
    });
    console.log(JSON.stringify({ job: "smrt-backfill", status: res.status, days: res.loaded.map(x => x.day), error: res.error }));
  },

  // GET /status -> history progress (only reachable once a netexcleaners.com route behind Cloudflare Access is added)
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/status") return Response.json(await backfillProgress(env.DB, env.ORG_ID, env.SMRT_INTEGRATION_ID));
    return new Response("netex-sync", { status: 200 });
  },
};
