// Daily limits (Settings › Daily limits, Neal Oct 30): a text when the pieces due the next work day get close to a
// department's max. With a max of 300 and 15%, the text goes out at 255 pieces; a second one if it goes over 300.
//  - Pieces are the Plan's count: due that work day and not finished, route orders the work day before, no forecast.
//  - At most two texts per department for each day planned: near the max, then over it. Dropping back doesn't reset them.
//  - Work days, 7 AM to 7 PM Central. A level reached outside those hours waits, if it's still there at 7 AM.
// What's been sent is in core_settings (planner.limits_last). A text that fails isn't marked, so the next check tries again.
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
  if (!lim.phone || !LIMITS.some(([, f]) => +lim[f] > 0)) return { status: "off" };
  const { day: today, hm } = localNow(env.TIMEZONE, at);
  if (!(groups.day.workDays || [1, 2, 3, 4, 5]).includes(weekday(today)) || hm < FROM || hm >= UNTIL) return { status: "outside hours" };
  if (!env.TEXTS) return { status: "no texts binding" };

  const V = await piecesView(db, env, { at }), D = V.days[V.next];
  if (!D) return { status: "no day" };
  const last = await loadLast(db, org), sent = last.day === V.next ? last.sent || {} : {};
  const list = dueAlerts(D.q, lim, sent);
  const save = v => putGroupStmt(db, org, "limits_last", { ...last, day: V.next, sent, ...v }, null).run();
  if (!list.length) return { status: "nothing new", day: V.next };

  const body = alertText(list, V.next, lim.alertPct);
  let r;
  try { r = await env.TEXTS.send({ app: env.APP_ID, to: lim.phone, body, ref: `limits:${V.next}` }); }
  catch (e) { r = { ok: false, error: String(e.message || e) }; }
  if (!r.ok) { await save({ error: r.error || "Not sent.", errorAt: at.toISOString() }); return { status: "failed", error: r.error, day: V.next }; }
  for (const a of list) sent[a.k] = a.stage;
  await save({ error: null, errorAt: null, lastAt: at.toISOString(), lastBody: body });
  return { status: "sent", sent: list.map(a => `${a.label} ${a.stage}`), day: V.next };
}

/** Settings' "Send a test text": to the saved number. */
export async function testText(env) {
  const lim = (await loadGroups(env.DB, env.ORG_ID)).limits;
  if (!lim.phone) throw new HttpError(400, "Save a mobile number first.");
  if (!env.TEXTS) throw new HttpError(503, "Texts aren't switched on for the planner yet.");
  const r = await env.TEXTS.send({ app: env.APP_ID, to: lim.phone, body: "Test from the Production Planner: daily limit alerts will come to this number.", ref: "limits:test" });
  if (!r.ok) throw new HttpError(502, r.error || "Not sent.");
  return { ok: true };
}
