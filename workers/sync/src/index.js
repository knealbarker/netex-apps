// netex-sync: background jobs for the netexcleaners.com apps.
//  - Live SMRT sync every 10 minutes during the work day (work days only)          -> src/live.js
//  - SMRT history, a little at a time: overnight on work days, all day on days off  -> src/backfill.js
//  - Rippling hours from the scheduled report emailed to reports@netexcleaners.com  -> src/rippling.js
import PostalMime from "postal-mime";
import { Smrt } from "./smrt.js";
import { runBackfill, backfillProgress } from "./backfill.js";
import { runLive } from "./live.js";
import { ingestRippling } from "./rippling.js";
import { localNow } from "./util.js";

const inWindow = (hour, start, end) => (start <= end ? hour >= start && hour < end : hour >= start || hour < end);
const weekday = day => new Date(day + "T12:00:00Z").getUTCDay(); // 0 = Sunday
export const LIVE_CRON = "*/10 * * * *";

/** History loads overnight on work days, and all day on days off (nobody is using SMRT for production then). */
export function backfillAllowed({ day, hour, workDays = [1, 2, 3, 4, 5], start = 20, end = 5 }) {
  if (!workDays.includes(weekday(day))) return true;
  return inWindow(hour, start, end);
}
/** Live sync runs on work days during working hours (default 4 am - 9 pm). */
export function liveAllowed({ day, hour, workDays = [1, 2, 3, 4, 5], start = 4, end = 21 }) {
  return workDays.includes(weekday(day)) && inWindow(hour, start, end);
}

async function workDays(db, orgId) {
  try {
    const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='planner' AND key='day'").bind(orgId).first();
    const d = r && JSON.parse(r.value_json).workDays;
    return Array.isArray(d) && d.length ? d : undefined;
  } catch { return undefined; }
}

const log = o => console.log(JSON.stringify(o));

/** Is this really from Rippling? The From address can be faked, so require a passing DKIM signature (or SPF) for rippling.com. */
export function fromRippling(from, headers) {
  if (!/@([a-z0-9-]+\.)*rippling\.com$/i.test(String(from || "").trim())) return { ok: false, why: "not a rippling.com sender" };
  const auth = ["authentication-results", "arc-authentication-results", "received-spf"].map(h => String(headers.get(h) || "")).join(" ").toLowerCase();
  if (/dkim=pass[^;]*header\.(d|i)=@?([a-z0-9-]+\.)*rippling\.com/.test(auth)) return { ok: true, why: "dkim" };
  if (/spf=pass[^;]*rippling\.com/.test(auth) || /^\s*pass\b[^;]*rippling\.com/.test(String(headers.get("received-spf") || "").toLowerCase())) return { ok: true, why: "spf" };
  return { ok: false, why: "no passing DKIM/SPF for rippling.com", auth: auth.slice(0, 300) };
}
const forwardTo = env => env.FORWARD_TO || "neal@towncountryclean.com";

export default {
  async scheduled(event, env, ctx) {
    const tz = env.TIMEZONE || "America/Chicago";
    const { day, hour } = localNow(tz);
    const wd = await workDays(env.DB, env.ORG_ID);
    if (!env.SMRT_KEY) { log({ job: "smrt", status: "waiting", reason: "SMRT_KEY secret not set" }); return; }
    const smrt = new Smrt({ url: env.SMRT_URL, key: env.SMRT_KEY });

    if (event.cron === LIVE_CRON) {
      if (!liveAllowed({ day, hour, workDays: wd, start: +(env.LIVE_START_HOUR ?? 4), end: +(env.LIVE_END_HOUR ?? 21) })) return;
      const res = await runLive(env.DB, smrt, { orgId: env.ORG_ID, integrationId: env.SMRT_INTEGRATION_ID, today: day });
      log({ job: "smrt-live", ...res });
      return;
    }
    // history overnight on work days (default 8 pm - 5 am) and all day on days off, so it never competes with the day's work in SMRT
    if (!backfillAllowed({ day, hour, workDays: wd, start: +(env.BACKFILL_START_HOUR ?? 20), end: +(env.BACKFILL_END_HOUR ?? 5) })) return;
    const res = await runBackfill(env.DB, smrt, {
      orgId: env.ORG_ID, integrationId: env.SMRT_INTEGRATION_ID, today: day,
      daysPerRun: +(env.BACKFILL_DAYS_PER_RUN ?? 2), oldestDay: env.BACKFILL_OLDEST_DAY || "2021-01-01",
    });
    log({ job: "smrt-backfill", status: res.status, days: res.loaded.map(x => x.day), error: res.error });
  },

  // Email Routing sends reports@netexcleaners.com here. Every message is still forwarded to Neal;
  // Rippling's time-clock export is also read into the hours tables.
  async email(message, env, ctx) {
    // Rippling's export is read and NOT forwarded (Neal doesn't need a copy). Anything else, or a Rippling email that
    // couldn't be read, is forwarded so nothing is lost silently.
    let handled = false;
    try {
      const check = fromRippling(message.from, message.headers);
      if (!check.ok && /rippling\.com/i.test(String(message.from || ""))) log({ job: "rippling-email", status: "rejected", ...check });
      if (check.ok) {
        const mail = await PostalMime.parse(message.raw);
        const csv = (mail.attachments || []).find(a => /\.csv$/i.test(a.filename || "") || /csv/i.test(a.mimeType || ""));
        if (csv) {
          const text = typeof csv.content === "string" ? csv.content : new TextDecoder().decode(csv.content);
          const res = await ingestRippling(env.DB, { orgId: env.ORG_ID, integrationId: env.RIPPLING_INTEGRATION_ID || "rippling", today: localNow(env.TIMEZONE || "America/Chicago").day, csv: text });
          log({ job: "rippling-email", subject: mail.subject, ...res });
          handled = true;
        } else log({ job: "rippling-email", status: "skipped", reason: "no CSV attachment", subject: mail.subject });
      }
    } catch (e) { log({ job: "rippling-email", status: "error", error: String(e.message || e) }); }
    if (!handled) await message.forward(forwardTo(env));
  },

  // GET /status -> history progress (only reachable once a netexcleaners.com route behind Cloudflare Access is added)
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/status") return Response.json(await backfillProgress(env.DB, env.ORG_ID, env.SMRT_INTEGRATION_ID));
    return new Response("netex-sync", { status: 200 });
  },
};
