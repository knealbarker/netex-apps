// Attendance against today's plan (Neal, Oct 13): a plan can put someone on a station from any time, now or later in the
// day. Once that planned start (or their late-arrival time from Team) is 15 minutes past and the time clock has no punch
// for them, it's written down once in "Changes today" as a warning; if they clock in later, how late is written too.
//  - Runs from the cron (every 15 minutes) on the saved plan for today. An unsaved suggestion isn't checked.
//  - Only judged on a time clock report that arrived after the grace time, so Rippling's 10-minute delay can't make a
//    "not clocked in" out of someone who just punched in.
import { ulid, nowIso } from "./util.js";
import { localNow } from "./pieces.js";
import { loadPlan } from "./plan.js";

export const GRACE_MIN = 15;     // minutes after the planned start before "not clocked in" is written down
export const LATE_MIN = 10;      // a clock-in this many minutes after the planned start is written down as late

const toMin = hm => { const m = /^(\d\d):(\d\d)/.exec(hm || ""); return m ? +m[1] * 60 + +m[2] : null; };
const ampm = min => { let h = Math.floor(min / 60) % 24; const m = min % 60, ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${ap}`; };

/** Checks today's saved plan against the time clock and records what it finds. Returns what it recorded. */
export async function checkAttendance(env, { now = Date.now() } = {}) {
  const db = env.DB, tz = env.TIMEZONE || "America/Chicago";
  const { day, hm } = localNow(tz, new Date(now));
  const P = await loadPlan(db, env, day);
  if (!P.rev) return { status: "no saved plan", events: [] };
  if (!P.clockAsOf || localNow(tz, new Date(P.clockAsOf)).day !== day) return { status: "no time clock report today", events: [] };
  const asOf = toMin(localNow(tz, new Date(P.clockAsOf)).hm), nowMin = toMin(hm);
  const out = new Set((P.callouts || []).map(c => c.personId));
  const late = Object.fromEntries((P.late || []).map(l => [l.personId, l.at]));
  const firstIn = {};
  for (const c of P.clock || []) { const t = String(c.clockIn).slice(11, 16); if (!firstIn[c.personId] || t < firstIn[c.personId]) firstIn[c.personId] = t; }
  const labels = new Map((await db.prepare("SELECT code, label FROM plan_stations").all()).results.map(s => [s.code, s.label]));
  const names = new Map((await db.prepare("SELECT id, COALESCE(display_name, first_name || ' ' || last_name) AS n FROM core_people WHERE org_id=?").bind(env.ORG_ID).all()).results.map(p => [p.id, p.n]));
  const events = [];
  const seen = new Set();
  for (const [code, c] of Object.entries(P.crew)) {
    const pid = c.personId; if (!pid || seen.has(pid) || out.has(pid)) continue;
    seen.add(pid);
    const start = toMin(c.start); if (start == null) continue;
    const due = Math.max(start, toMin(late[pid]) ?? 0), name = names.get(pid) || "Someone", where = labels.get(code) || code;
    const inAt = toMin(firstIn[pid]);
    if (inAt != null) {
      if (inAt - due >= LATE_MIN) events.push({ key: `clock-late:${pid}`, kind: "note",
        text: `${name} clocked in at ${ampm(inAt)}, ${inAt - due} min after the planned start (${ampm(due)}, ${where})` });
    } else if (nowMin >= due + GRACE_MIN && asOf >= due + GRACE_MIN) {
      events.push({ key: `clock-noshow:${pid}`, kind: "warn",
        text: `${name} wasn't clocked in by ${ampm(due + GRACE_MIN)} — planned on ${where} from ${ampm(due)}` });
    }
  }
  const added = [];
  for (const e of events) {
    const r = await db.prepare("INSERT INTO plan_events(id, org_id, day, key, kind, text, at, user_id) VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(org_id, day, key) DO NOTHING")
      .bind(ulid(), env.ORG_ID, day, e.key, e.kind, e.text, nowIso()).run();
    if (r?.meta?.changes) added.push(e);
  }
  return { status: "checked", events: added };
}
