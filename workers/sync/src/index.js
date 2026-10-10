// netex-sync: background jobs for the netexcleaners.com apps.
// For now it only loads SMRT history at night; the desktop planner still does the live reads during the day.
import { Smrt } from "./smrt.js";
import { runBackfill, backfillProgress } from "./backfill.js";
import { localNow } from "./util.js";

const inWindow = (hour, start, end) => (start <= end ? hour >= start && hour < end : hour >= start || hour < end);

export default {
  async scheduled(event, env, ctx) {
    const tz = env.TIMEZONE || "America/Chicago";
    const { day, hour } = localNow(tz);
    // history only overnight (default 8 pm - 5 am), so it never competes with the day's work in SMRT
    if (!inWindow(hour, +(env.BACKFILL_START_HOUR ?? 20), +(env.BACKFILL_END_HOUR ?? 5))) return;
    const smrt = new Smrt({ url: env.SMRT_URL, key: env.SMRT_KEY });
    const res = await runBackfill(env.DB, smrt, {
      orgId: env.ORG_ID, integrationId: env.SMRT_INTEGRATION_ID, today: day,
      daysPerRun: +(env.BACKFILL_DAYS_PER_RUN ?? 2), oldestDay: env.BACKFILL_OLDEST_DAY || "2021-01-01",
    });
    console.log(JSON.stringify({ job: "smrt-backfill", status: res.status, days: res.loaded.map(x => x.day), error: res.error }));
  },

  // GET /status -> history progress (behind Cloudflare Access like everything on the domain)
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/status") return Response.json(await backfillProgress(env.DB, env.ORG_ID, env.SMRT_INTEGRATION_ID));
    return new Response("netex-sync", { status: 200 });
  },
};
