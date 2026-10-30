// Daily limits (Settings › Daily limits, Neal Oct 30): a text when the pieces due the next work day get close to a
// department's max. With a max of 300 and 15%, the text goes out at 255 pieces; a second one if it goes over 300.
//  - Pieces are the Plan's count: due that work day and not finished, route orders the work day before, no forecast.
//  - At most two texts per department for each day planned, to each number: near the max, then over it. Dropping back doesn't reset them.
//  - Work days, 7 AM to 7 PM Central. A level reached outside those hours waits, if it's still there at 7 AM.
// What's been sent, per number, is in core_settings (planner.limits_last). A text that fails isn't marked, so the next check
// tries that number again without repeating the others.
import { HttpError } from "./util.js";
import { loadGroups, putGroupStmt } from "./settings.js";
import { piecesView, localNow } from "./pieces.js";

export const LIMITS = [["dcb", "maxDcb", "DCB"], ["dct", "maxDct", "DCT"], ["slb", "maxSlb", "SLB"], ["slt", "maxSlt", "SLT"]];
const FROM = "07:00", UNTIL = "19:00", LINK = "prodplanner.netexcleaners.com/#/plan";
const weekday = day => new Date(day + "T12:00:00Z").getUTCDay();

/** The departments to text about now: [{ k, label, n, max, level, stage: "near" | "over" }]. `sent` = { k: stage already texted }. */
export function dueAlerts(q, lim, sent = {}) {
  const out = [];
  for (const [k, field, label] of LIMITS) {
    const max = +lim[field] || 0, n = Math.round(+q[k] || 0); if (max <= 0) continue;
    const level = max * (100 - lim.alertPct) / 100;
    const stage = n > max ? "over" : n >= level ? "near" : null;
    if (!stage || sent[k] === stage || sent[k] === "over") continue;
    out.push({ k, label, n, max, level, stage });
  }
  return out;
}

/** One text for everything that crossed in this check. */
export function alertText(list, day, pct) {
  const when = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });
  const lines = list.map(a => (a.stage === "over" ? `${a.label}: ${a.n} due, over the ${a.max} max.` : `${a.label}: ${a.n} due, within ${pct}% of the ${a.max} max.`));
  return `Production for ${when}\n${lines.join("\n")}\n${LINK}`;
}

async function loadLast(db, org) {
  const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='planner' AND key='limits_last'").bind(org).first();
  return r ? JSON.parse(r.value_json) : {};
}

/** Cron: checks the next work day against the limits and texts when one is reached. */
export async function checkLimits(env, { at = new Date() } = {}) {
  const db = env.DB, org = env.ORG_ID, groups = await loadGroups(db, org), lim = groups.limits;
  if (!lim.phones.length || !LIMITS.some(([, f]) => +lim[f] > 0)) return { status: "off" };
  const { day: today, hm } = localNow(env.TIMEZONE, at);
  if (!(groups.day.workDays || [1, 2, 3, 4, 5]).includes(weekday(today)) || hm < FROM || hm >= UNTIL) return { status: "outside hours" };
  if (!env.TEXTS) return { status: "no texts binding" };

  const V = await piecesView(db, env, { at }), D = V.days[V.next];
  if (!D) return { status: "no day" };
  const last = await loadLast(db, org), same = last.day === V.next;
  const before = same ? last.sent || {} : {}, sentTo = same ? last.sentTo || {} : {};   // `sent`: from when there was one number
  const results = [], failed = [];
  let lastBody = null;
  for (const to of lim.phones) {
    const list = dueAlerts(D.q, lim, { ...before, ...sentTo[to] });
    if (!list.length) continue;
    const body = alertText(list, V.next, lim.alertPct);
    let r;
    try { r = await env.TEXTS.send({ app: env.APP_ID, to, body, ref: `limits:${V.next}` }); }
    catch (e) { r = { ok: false, error: String(e.message || e) }; }
    if (!r.ok) { failed.push(`${to}: ${r.error || "Not sent."}`); continue; }
    sentTo[to] = { ...sentTo[to] }; for (const x of list) sentTo[to][x.k] = x.stage;
    lastBody = body; results.push(...list.map(x => `${x.label} ${x.stage}`));
  }
  if (!lastBody && !failed.length) return { status: "nothing new", day: V.next };
  const error = failed.join(" · ") || null;
  await putGroupStmt(db, org, "limits_last", { ...last, day: V.next, sent: before, sentTo, error, errorAt: error ? at.toISOString() : null,
    ...(lastBody ? { lastAt: at.toISOString(), lastBody } : {}) }, null).run();
  return { status: lastBody ? "sent" : "failed", day: V.next, ...(lastBody ? { sent: [...new Set(results)] } : {}), ...(error ? { error } : {}) };
}

/** Settings' "Send a test text": to each saved number. */
export async function testText(env) {
  const lim = (await loadGroups(env.DB, env.ORG_ID)).limits;
  if (!lim.phones.length) throw new HttpError(400, "Save a mobile number first.");
  if (!env.TEXTS) throw new HttpError(503, "Texts aren't switched on for the planner yet.");
  const sent = [], failed = [];
  for (const to of lim.phones) {
    const r = await env.TEXTS.send({ app: env.APP_ID, to, body: "Test from the Production Planner: daily limit alerts will come to this number.", ref: "limits:test" });
    if (r.ok) sent.push(to); else failed.push(`${to}: ${r.error || "Not sent."}`);
  }
  if (failed.length) throw new HttpError(502, failed.join(" · "));
  return { sent };
}
