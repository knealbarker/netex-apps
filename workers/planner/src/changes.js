// "Changes today": what people changed in the planner today, in plain words (plus the shuttle alerts when shuttles are on).
//  - Plan saves record readable lines (who moved where, hours, hard stops, typed piece counts); other changes come from
//    the audit log's entity and action.
//  - Shuttle alerts are noticed by whichever PC has the planner open and stored once per day and key (plan_events).
import { SHUTTLES } from "./features.js";
import { HttpError, ulid, nowIso } from "./util.js";
import { localNow } from "./pieces.js";

const CAT = { dct: "DC tops", dcb: "DC bottoms", slt: "Starch tops", slb: "Starch bottoms", comf: "Comforters", tc: "Tablecloths" };
const clock = t => { const m = /^(\d\d):(\d\d)$/.exec(t || ""); if (!m) return t || ""; let h = +m[1]; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; };
const hrs = h => { const m = Math.round(+h * 60); return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`; };

/**
 * Readable lines for a plan save. before/after: {code: {personId, start, hours, stop}}; ov: {cat: pieces}.
 * labels: code -> station name; names: person id -> name.
 */
export function planDiff(before, after, ovBefore, ovAfter, labels, names) {
  const out = [], L = c => labels.get(c) || c, N = id => names.get(id) || "Someone";
  const where = crew => new Map(Object.entries(crew).filter(([, c]) => c && c.personId).map(([code, c]) => [c.personId, code]));
  const wb = where(before), wa = where(after);
  const moved = new Set();
  for (const [pid, code] of wa) {
    const was = wb.get(pid);
    if (!was) { const c = after[code]; out.push(`${N(pid)} on ${L(code)} (starts ${clock(c.start)}, ${hrs(c.hours)})`); moved.add(code); continue; }
    if (was !== code) { out.push(`${N(pid)} moved from ${L(was)} to ${L(code)}`); moved.add(code); }
  }
  for (const [pid, code] of wb) if (!wa.has(pid)) out.push(`${N(pid)} taken off ${L(code)}`);
  for (const [pid, code] of wa) {
    const a = after[code], b = before[wb.get(pid)];
    if (!b) continue;
    if (a.start !== b.start) out.push(`${N(pid)}: planned start ${clock(b.start)} → ${clock(a.start)}`);
    if (+a.hours !== +b.hours) out.push(`${N(pid)}: hours ${hrs(b.hours)} → ${hrs(a.hours)}`);
    if ((a.stop || "") !== (b.stop || "")) out.push(a.stop ? `${N(pid)}: clock out ${clock(a.stop)}` : `${N(pid)}: clock-out time removed`);
    const brk = v => String(v).split("-").map(clock).join("–");
    if ((a.brk || "") !== (b.brk || "")) out.push(a.brk ? `${N(pid)}: break ${brk(a.brk)}` : `${N(pid)}: no break`);
    const mv = c => { try { return JSON.parse(c.moves || "[]"); } catch { return []; } };
    const ma = mv(a), mb = mv(b), key = m => `${m.at}>${m.to}`;
    for (const m of ma) if (!mb.some(x => key(x) === key(m))) out.push(`${N(pid)} moves to ${L(m.to)} at ${clock(m.at)}`);
    for (const m of mb) if (!ma.some(x => key(x) === key(m))) out.push(`${N(pid)}: move to ${L(m.to)} at ${clock(m.at)} taken out`);
  }
  for (const k of Object.keys(CAT)) {
    const x = ovBefore[k], y = ovAfter[k];
    if (x === y || (x == null && y == null)) continue;
    out.push(y == null ? `${CAT[k]}: back to SMRT's count` : `${CAT[k]}: ${y} pieces typed in${x != null ? ` (was ${x})` : ""}`);
  }
  return out;
}

/** Records a shuttle alert (or other event) once per day and key. Returns { added }. */
export async function addEvent(db, env, me, body) {
  const day = String(body.day || ""), key = String(body.key || "").slice(0, 80), kind = String(body.kind || ""), text = String(body.text || "").trim().slice(0, 300);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !key || !text || !["ready", "warn", "note"].includes(kind)) throw new HttpError(400, "Send a day, key, kind and text.");
  const r = await db.prepare("INSERT INTO plan_events(id, org_id, day, key, kind, text, at, user_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(org_id, day, key) DO NOTHING")
    .bind(ulid(), env.ORG_ID, day, key, kind, text, nowIso(), me?.id || null).run();
  return { added: !!(r?.meta?.changes) };
}

const SETTINGS_NAMES = { day: "Working day", money: "Labor & prices", route: "Route deliveries", limits: "Daily limits", alerts: "Shuttle alerts",
  smrt: "SMRT mapping", rippling: "Rippling", business: "Business", summary: "Daily summary email" };

/** Everything changed on a day (Central time), newest first. */
export async function listChanges(db, env, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "Use a date like 2026-10-12.");
  const tz = env.TIMEZONE || "America/Chicago";
  const lo = new Date(Date.parse(day + "T00:00:00Z") - 864e5).toISOString(), hi = new Date(Date.parse(day + "T00:00:00Z") + 2 * 864e5).toISOString();
  const rows = (await db.prepare(`SELECT a.at, a.entity, a.entity_id AS eid, a.action, a.changes_json AS ch, u.display_name AS who FROM core_audit_log a LEFT JOIN core_users u ON u.id=a.user_id
      WHERE a.org_id=? AND a.at >= ? AND a.at < ? AND (a.app_id=? OR a.app_id IS NULL) ORDER BY a.at DESC LIMIT 400`).bind(env.ORG_ID, lo, hi, env.APP_ID || "planner").all()).results
    .filter(r => localNow(tz, new Date(r.at)).day === day);
  const people = new Map((await db.prepare("SELECT id, COALESCE(display_name, first_name || ' ' || last_name) AS n FROM core_people WHERE org_id=?").bind(env.ORG_ID).all()).results.map(p => [p.id, p.n]));
  const short = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const TRAIN = Object.fromEntries((await db.prepare("SELECT id, name FROM plan_trainings").all()).results.map(t => [t.id, t.name]));
  const out = [];
  const push = (r, text, tag = "") => out.push({ at: r.at, who: r.who || null, text, tag });
  for (const r of rows) {
    let c = {}; try { c = r.ch ? JSON.parse(r.ch) : {}; } catch { /* keep going */ }
    const forDay = c.day && c.day !== day ? ` (plan for ${short(c.day)})` : "";
    if (r.entity === "plan_days" && r.action === "update") { if (c.lines?.length) for (const l of c.lines) push(r, l + forDay, "plan"); }
    else if (r.entity === "plan_days" && r.action === "publish") push(r, `Published the plan${c.day ? ` for ${short(c.day)}` : ""}`, "publish");
    else if (r.entity === "plan_callouts") push(r, `${people.get(c.personId) || "Someone"} ${r.action === "delete" ? "back on the list (call-out undone)" : "called out"}${c.note ? ` — ${c.note}` : ""}${forDay}`, "callout");
    else if (r.entity === "plan_time_off") {
      const when = c.fromDay ? (c.toDay && c.toDay !== c.fromDay ? `${short(c.fromDay)} – ${short(c.toDay)}` : short(c.fromDay)) : "";
      const what = c.kind === "late" ? `in late at ${c.at || "?"}` : "out";
      push(r, r.action === "delete" ? `${people.get(c.personId) || "Someone"}: removed "${what}" for ${when}` : `${people.get(c.personId) || "Someone"} ${what} ${when}${c.note ? ` — ${c.note}` : ""}`, "callout");
    }
    else if (r.entity === "plan_depth") push(r, `Depth chart for ${TRAIN[r.eid] || r.eid} changed`, "team");
    else if (r.entity === "plan_person_trainings") push(r, `Trainings for ${people.get(r.eid) || "someone"} changed`, "team");
    else if (r.entity === "core_people") push(r, `${r.action === "create" ? "Added" : "Updated"} ${people.get(r.eid) || "someone"} on the team`, "team");
    else if (r.entity === "core_settings") push(r, `Settings: ${SETTINGS_NAMES[String(r.eid).replace(/^planner\./, "")] || r.eid} changed`, "settings");
    else if (r.entity === "plan_station_rates") push(r, "Settings: stations & speeds changed", "settings");
    else if (r.entity === "plan_runs") push(r, "Settings: shuttle runs changed", "settings");
    else if (r.entity === "plan_followups") push(r, `Follow-up ${c.status === "resolved" ? "marked done" : "noted"}`, "review");
    else if (r.entity === "core_users") push(r, `Users & access: ${r.action === "create" ? "added someone" : "changed a user"}`, "users");
  }
  const ev = (await db.prepare(`SELECT e.at, e.key, e.kind, e.text, u.display_name AS who FROM plan_events e LEFT JOIN core_users u ON u.id=e.user_id WHERE e.org_id=? AND e.day=? ORDER BY e.at DESC`)
    .bind(env.ORG_ID, day).all()).results;
  // shuttle alerts are keyed ready:<run> and warn<min>:<run>; hidden while shuttles are off
  for (const e of ev) if (SHUTTLES || !/^(ready|warn\d+):|^(accept|dismiss):risk:/.test(e.key || "")) out.push({ at: e.at, who: null, text: e.text, tag: e.kind === "ready" ? "ready" : e.kind === "warn" ? "warn" : e.kind });
  // the time clock: punches edited or removed in Rippling (Production), so a punch that came and went leaves a trace
  const hm = iso => { const m = /T(\d\d:\d\d)/.exec(iso || ""); return m ? clock(m[1]) : "?"; };
  let punches = [];
  try {
    punches = (await db.prepare(`SELECT l.seen_at AS at, l.person_id AS pid, l.change, l.clock_in AS cin, l.clock_out AS cout, l.was_in AS wasIn, l.was_out AS wasOut
        FROM labor_punch_log l WHERE l.org_id=? AND l.day=? AND l.change IN ('changed','removed')
        AND (l.department_id IS NULL OR l.department_id=(SELECT d.id FROM core_departments d WHERE d.org_id=l.org_id AND d.name='Production')) ORDER BY l.seen_at DESC`)
      .bind(env.ORG_ID, day).all()).results;
  } catch { /* table not there yet */ }
  for (const p of punches) {
    const who = people.get(p.pid) || "Someone";
    const span = (i, o) => `${hm(i)}${o ? `–${hm(o)}` : ""}`;
    out.push({ at: p.at, who: "Rippling", tag: "clock", text: p.change === "removed"
      ? `Time clock: ${who}'s punch ${span(p.cin, p.cout)} was removed in Rippling`
      : `Time clock: ${who}'s punch changed in Rippling, ${span(p.wasIn, p.wasOut)} → ${span(p.cin, p.cout)}` });
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return { day, list: out.slice(0, 300) };
}
