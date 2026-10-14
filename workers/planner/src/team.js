// The production team: people in the Production department, their usual clock-in, Rippling id,
// and the station depth chart: each training has one ordered list of people (#1, #2, #3 ...; Neal, Oct 13).
// Training is per kind of work: SLB 1 and SLB 2 share one list, as do DCT 1-3.
// Everyone signed in can see the team. Managers and up can change trainings (they do it while planning);
// Admins and the Owner add, edit and turn off people.
import { HttpError, ulid, nowIso, cleanName, audit } from "./util.js";
import { requireRole, rank } from "./auth.js";
import { payRates, rateOn } from "./pay.js";
import { localNow } from "./pieces.js";
import { timeOffBetween } from "./timeoff.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function productionIds(db, orgId) {
  const dep = await db.prepare("SELECT id FROM core_departments WHERE org_id=? AND name='Production'").bind(orgId).first();
  const loc = await db.prepare("SELECT id FROM core_locations WHERE org_id=? AND kind='plant' ORDER BY created_at LIMIT 1").bind(orgId).first();
  if (!dep || !loc) throw new HttpError(500, "The Production department or the Workshop is missing from the database.");
  return { departmentId: dep.id, locationId: loc.id };
}

export async function listTrainings(db) {
  return (await db.prepare("SELECT id, name, short FROM plan_trainings ORDER BY sort").all()).results;
}

export async function listTeam(db, env, me = null) {
  const { departmentId, locationId } = await productionIds(db, env.ORG_ID);
  const trainings = await listTrainings(db);
  // which stations each training covers (only stations in use)
  const st = (await db.prepare("SELECT training_id AS t, label FROM plan_stations WHERE location_id=? AND deleted_at IS NULL AND is_active=1 ORDER BY sort").bind(locationId).all()).results;
  for (const t of trainings) t.stations = st.filter(x => x.t === t.id).map(x => x.label);
  const people = (await db.prepare(`SELECT p.id, p.first_name AS firstName, p.last_name AS lastName, p.display_name AS displayName,
        p.payroll_id AS payrollId, p.status, pp.usual_start AS usualStart, pp.note,
        pp.usual_hours AS usualHours, pp.usual_days AS usualDays, pp.leave_by AS leaveBy, pp.leave_note AS leaveNote
      FROM core_people p LEFT JOIN plan_person_prefs pp ON pp.person_id = p.id
      WHERE p.org_id=? AND p.department_id=? AND p.deleted_at IS NULL
      ORDER BY p.status='active' DESC, COALESCE(p.display_name, p.first_name || ' ' || p.last_name) COLLATE NOCASE`).bind(env.ORG_ID, departmentId).all()).results;
  const rows = (await db.prepare(`SELECT pt.person_id AS personId, pt.training_id AS t, pt.depth FROM plan_person_trainings pt
      JOIN core_people p ON p.id = pt.person_id WHERE p.org_id=? AND pt.deleted_at IS NULL ORDER BY pt.priority`).bind(env.ORG_ID).all()).results;
  const byPerson = new Map(), depthOf = new Map();
  for (const r of rows) {
    (byPerson.get(r.personId) || byPerson.set(r.personId, []).get(r.personId)).push(r.t);
    (depthOf.get(r.personId) || depthOf.set(r.personId, {}).get(r.personId))[r.t] = r.depth;
  }
  // pay rates (from Rippling) only go to Admins and the Owner
  const rates = me && rank(me.role) >= rank("admin") ? await payRates(db, env.ORG_ID) : null;
  const today = localNow(env.TIMEZONE).day;
  // time off from today on (and anything still running), soonest first
  const away = await timeOffBetween(db, env.ORG_ID, today, "9999-12-31");
  const awayOf = new Map(); for (const t of away) (awayOf.get(t.personId) || awayOf.set(t.personId, []).get(t.personId)).push(t);
  return {
    trainings: trainings.filter(t => t.stations.length),
    people: people.map(p => ({ ...p, name: p.displayName || `${p.firstName} ${p.lastName}`.trim(), trainings: byPerson.get(p.id) || [], depth: depthOf.get(p.id) || {}, away: awayOf.get(p.id) || [],
      ...(rates ? { rate: rateOn(rates.get(p.id), today) } : {}) })),
    today,
    ...(rates ? { ratesShown: true } : {}),
  };
}

function personFields(body, current = {}) {
  const firstName = body.firstName !== undefined ? cleanName(body.firstName, "First name") : current.firstName;
  const lastName = body.lastName !== undefined ? String(body.lastName ?? "").trim().replace(/\s+/g, " ").slice(0, 80) : current.lastName ?? "";
  const displayName = body.displayName !== undefined ? (String(body.displayName ?? "").trim().slice(0, 80) || null) : current.displayName ?? null;
  const payrollId = body.payrollId !== undefined ? (String(body.payrollId ?? "").trim().slice(0, 40) || null) : current.payrollId ?? null;
  const usualStart = body.usualStart !== undefined ? (body.usualStart || null) : current.usualStart ?? null;
  if (usualStart && !TIME.test(usualStart)) throw new HttpError(400, "Usual clock-in must be a time like 05:30.");
  const note = body.note !== undefined ? (String(body.note ?? "").trim().slice(0, 500) || null) : current.note ?? null;
  return { firstName, lastName, displayName, payrollId, usualStart, note, ...scheduleFields(body, current) };
}
/** The standing schedule (Neal, Oct 13): usual hours and days, and a "must leave by" time with its reason. */
const SCHEDULE_KEYS = ["usualStart", "usualHours", "usualDays", "leaveBy", "leaveNote"];
function scheduleFields(body, current = {}) {
  const usualHours = body.usualHours !== undefined ? (body.usualHours === null || body.usualHours === "" ? null : +body.usualHours) : current.usualHours ?? null;
  if (usualHours != null && !(usualHours > 0 && usualHours <= 16)) throw new HttpError(400, "Usual hours must be between 0 and 16.");
  const usualDays = body.usualDays !== undefined ? ([...new Set(String(body.usualDays ?? "").replace(/[^0-6]/g, ""))].sort().join("") || null) : current.usualDays ?? null;
  const leaveBy = body.leaveBy !== undefined ? (body.leaveBy || null) : current.leaveBy ?? null;
  if (leaveBy && !TIME.test(leaveBy)) throw new HttpError(400, "Must leave by must be a time like 14:45.");
  const leaveNote = body.leaveNote !== undefined ? (String(body.leaveNote ?? "").trim().slice(0, 120) || null) : current.leaveNote ?? null;
  return { usualHours, usualDays, leaveBy, leaveNote };
}

async function payrollTaken(db, orgId, payrollId, exceptId = "") {
  if (!payrollId) return false;
  return !!(await db.prepare("SELECT id FROM core_people WHERE org_id=? AND payroll_id=? AND id<>?").bind(orgId, payrollId, exceptId).first());
}

export async function addPerson(db, env, me, body) {
  requireRole(me, "admin");
  const v = personFields(body);
  if (await payrollTaken(db, env.ORG_ID, v.payrollId)) throw new HttpError(409, `Rippling id ${v.payrollId} already belongs to someone on the list.`);
  const { departmentId, locationId } = await productionIds(db, env.ORG_ID);
  const id = ulid();
  await db.batch([
    db.prepare(`INSERT INTO core_people(id, org_id, department_id, home_location_id, first_name, last_name, display_name, payroll_id, updated_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(id, env.ORG_ID, departmentId, locationId, v.firstName, v.lastName, v.displayName, v.payrollId, me.id),
    db.prepare("INSERT INTO plan_person_prefs(person_id, usual_start, note, usual_hours, usual_days, leave_by, leave_note, updated_by) VALUES(?,?,?,?,?,?,?,?)")
      .bind(id, v.usualStart, v.note, v.usualHours, v.usualDays, v.leaveBy, v.leaveNote, me.id),
  ]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_people", entityId: id, action: "create", changes: v });
  return { id };
}

export async function updatePerson(db, env, me, id, body) {
  // managers keep the standing schedule up to date; names, Rippling ids and status stay with Admins
  requireRole(me, Object.keys(body || {}).every(k => SCHEDULE_KEYS.includes(k)) ? "manager" : "admin");
  const cur = await db.prepare(`SELECT p.first_name AS firstName, p.last_name AS lastName, p.display_name AS displayName, p.payroll_id AS payrollId,
      p.status, pp.usual_start AS usualStart, pp.note, pp.usual_hours AS usualHours, pp.usual_days AS usualDays, pp.leave_by AS leaveBy, pp.leave_note AS leaveNote FROM core_people p LEFT JOIN plan_person_prefs pp ON pp.person_id=p.id
      WHERE p.id=? AND p.org_id=? AND p.deleted_at IS NULL`).bind(id, env.ORG_ID).first();
  if (!cur) throw new HttpError(404, "That person isn't on the team list.");
  const v = personFields(body, cur);
  const status = body.status !== undefined ? body.status : cur.status;
  if (!["active", "inactive"].includes(status)) throw new HttpError(400, "Status must be active or inactive.");
  if (await payrollTaken(db, env.ORG_ID, v.payrollId, id)) throw new HttpError(409, `Rippling id ${v.payrollId} already belongs to someone else.`);
  const now = nowIso();
  const leftOn = status === "inactive" && cur.status !== "inactive" ? now.slice(0, 10) : status === "active" ? null : undefined;
  await db.batch([
    db.prepare(`UPDATE core_people SET first_name=?, last_name=?, display_name=?, payroll_id=?, status=?, left_on=${leftOn === undefined ? "left_on" : "?"},
      updated_at=?, updated_by=?, rev=rev+1 WHERE id=?`).bind(...[v.firstName, v.lastName, v.displayName, v.payrollId, status, ...(leftOn === undefined ? [] : [leftOn]), now, me.id, id]),
    db.prepare(`INSERT INTO plan_person_prefs(person_id, usual_start, note, usual_hours, usual_days, leave_by, leave_note, updated_by) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(person_id) DO UPDATE SET usual_start=excluded.usual_start, note=excluded.note, usual_hours=excluded.usual_hours, usual_days=excluded.usual_days,
        leave_by=excluded.leave_by, leave_note=excluded.leave_note, updated_at=?, updated_by=excluded.updated_by, rev=rev+1`)
      .bind(id, v.usualStart, v.note, v.usualHours, v.usualDays, v.leaveBy, v.leaveNote, me.id, now),
  ]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_people", entityId: id, action: "update", changes: { ...body } });
  return { id };
}

/** The whole depth chart: {training: [personId, ...]} in rank order (#1 first). */
async function loadChart(db, orgId) {
  const rows = (await db.prepare(`SELECT pt.person_id AS p, pt.training_id AS t FROM plan_person_trainings pt JOIN core_people c ON c.id = pt.person_id
      WHERE c.org_id=? AND pt.deleted_at IS NULL ORDER BY pt.training_id, pt.depth IS NULL, pt.depth, pt.priority`).bind(orgId).all()).results;
  const chart = {}; for (const r of rows) (chart[r.t] = chart[r.t] || []).push(r.p);
  return chart;
}
/** Statements that write the chart back for the given people: depth = place on each list; priority (each person's own
 *  order, kept for older readers) = their trainings by rank, then by the trainings' order. */
function chartStmts(db, chart, personIds, sortOf, userId) {
  const out = [], keep = new Set(personIds);
  out.push(db.prepare(`DELETE FROM plan_person_trainings WHERE person_id IN (${personIds.map(() => "?").join(",")})`).bind(...personIds));
  const mine = {};
  for (const [t, L] of Object.entries(chart)) L.forEach((p, i) => { if (keep.has(p)) (mine[p] = mine[p] || []).push({ t, d: i + 1 }); });
  for (const [p, list] of Object.entries(mine)) list.sort((a, b) => a.d - b.d || (sortOf[a.t] ?? 99) - (sortOf[b.t] ?? 99))
    .forEach((x, i) => out.push(db.prepare("INSERT INTO plan_person_trainings(person_id, training_id, priority, depth, updated_by) VALUES(?,?,?,?,?)").bind(p, x.t, i + 1, x.d, userId)));
  return out;
}
async function trainingSort(db) { return Object.fromEntries((await db.prepare("SELECT id, sort FROM plan_trainings").all()).results.map(r => [r.id, r.sort])); }
/** Statements that replace a person's trainings: kept trainings keep their rank, new ones go to the bottom of that
 *  station's list. */
async function trainingStmts(db, orgId, personId, list, userId) {
  const before = await loadChart(db, orgId), after = JSON.parse(JSON.stringify(before));
  for (const t of Object.keys(after)) if (!list.includes(t)) after[t] = after[t].filter(x => x !== personId);
  for (const t of list) { after[t] = after[t] || []; if (!after[t].includes(personId)) after[t].push(personId); }
  // the whole chart is rewritten, so everyone has a rank on every list (people the desktop import added had none)
  const ids = [...new Set([personId, ...Object.values(before).flat(), ...Object.values(after).flat()])];
  return chartStmts(db, after, ids, await trainingSort(db), userId);
}

/** The desktop import's statements: the desktop list is the whole truth for that person; their place on each
 *  station's list is left unset (they go below everyone ranked) until someone sets the depth chart. */
export function importTrainingStmts(db, personId, list, userId) {
  return [db.prepare("DELETE FROM plan_person_trainings WHERE person_id=?").bind(personId),
    ...list.map((t, i) => db.prepare("INSERT INTO plan_person_trainings(person_id, training_id, priority, updated_by) VALUES(?,?,?,?)").bind(personId, t, i + 1, userId))];
}

/** Replaces a person's trainings. Their rank on each station's list is set in the depth chart. */
export async function setTrainings(db, env, me, personId, list) {
  requireRole(me, "manager");
  if (!Array.isArray(list)) throw new HttpError(400, "Send the trainings.");
  if (new Set(list).size !== list.length) throw new HttpError(400, "A training can only be listed once.");
  const known = new Set((await listTrainings(db)).map(t => t.id));
  const bad = list.find(t => !known.has(t));
  if (bad) throw new HttpError(400, `No training called ${bad}.`);
  const p = await db.prepare("SELECT id FROM core_people WHERE id=? AND org_id=? AND deleted_at IS NULL").bind(personId, env.ORG_ID).first();
  if (!p) throw new HttpError(404, "That person isn't on the team list.");
  await db.batch(await trainingStmts(db, env.ORG_ID, personId, list, me.id));
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_person_trainings", entityId: personId, action: "update", changes: { trainings: list } });
  return { personId, trainings: list };
}

/** Replaces one station's depth chart: people in rank order (#1 first). Being on the list = trained there. */
export async function setChart(db, env, me, training, people) {
  requireRole(me, "manager");
  const t = (await listTrainings(db)).find(x => x.id === training);
  if (!t) throw new HttpError(404, `No training called ${training}.`);
  if (!Array.isArray(people)) throw new HttpError(400, "Send the people in order, #1 first.");
  if (new Set(people).size !== people.length) throw new HttpError(400, "Someone is on the list twice.");
  const known = new Set((await db.prepare("SELECT id FROM core_people WHERE org_id=? AND deleted_at IS NULL").bind(env.ORG_ID).all()).results.map(r => r.id));
  if (people.some(p => !known.has(p))) throw new HttpError(400, "Someone on the list isn't on the team.");
  const before = await loadChart(db, env.ORG_ID), after = { ...before, [training]: people };
  const ids = [...new Set([...Object.values(before).flat(), ...people])];
  if (ids.length) await db.batch(chartStmts(db, after, ids, await trainingSort(db), me.id));
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_depth", entityId: training, action: "update", changes: { people } });
  return { training, people };
}

/** The last 90 days of who was planned where, and who clocked in (for the Team screen's "order from history"). */
export async function teamHistory(db, env, me) {
  requireRole(me, "manager");
  const { departmentId, locationId } = await productionIds(db, env.ORG_ID);
  const from = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const planned = (await db.prepare(`SELECT d.work_date AS day, s.code AS station, a.person_id AS personId FROM plan_assignments a JOIN plan_days d ON d.id=a.day_id
      JOIN plan_stations s ON s.id=a.station_id WHERE d.location_id=? AND d.work_date >= ? AND a.person_id IS NOT NULL AND a.deleted_at IS NULL AND a.hours > 0`).bind(locationId, from).all()).results;
  const worked = (await db.prepare(`SELECT work_date AS day, person_id AS personId FROM labor_daily_hours WHERE department_id=? AND work_date >= ? AND hours > 0 AND deleted_at IS NULL GROUP BY work_date, person_id`)
    .bind(departmentId, from).all()).results;
  const stations = (await db.prepare("SELECT code, training_id AS training FROM plan_stations WHERE location_id=? AND deleted_at IS NULL").bind(locationId).all()).results;
  return { planned, worked, trainingOf: Object.fromEntries(stations.filter(s => s.training).map(s => [s.code, s.training])) };
}
