// The production team: people in the Production department, their usual clock-in, Rippling id,
// and the trainings they have, in order (1 = where they belong first). Training is per kind of work:
// SLB 1 and SLB 2 share one training, as do DCT 1-3.
// Everyone signed in can see the team. Managers and up can change trainings (they do it while planning);
// Admins and the Owner add, edit and turn off people.
import { HttpError, ulid, nowIso, cleanName, audit } from "./util.js";
import { requireRole, rank } from "./auth.js";
import { payRates, rateOn } from "./pay.js";

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
        p.payroll_id AS payrollId, p.status, pp.usual_start AS usualStart, pp.note
      FROM core_people p LEFT JOIN plan_person_prefs pp ON pp.person_id = p.id
      WHERE p.org_id=? AND p.department_id=? AND p.deleted_at IS NULL
      ORDER BY p.status='active' DESC, COALESCE(p.display_name, p.first_name || ' ' || p.last_name) COLLATE NOCASE`).bind(env.ORG_ID, departmentId).all()).results;
  const rows = (await db.prepare(`SELECT pt.person_id AS personId, pt.training_id AS t FROM plan_person_trainings pt
      JOIN core_people p ON p.id = pt.person_id WHERE p.org_id=? AND pt.deleted_at IS NULL ORDER BY pt.priority`).bind(env.ORG_ID).all()).results;
  const byPerson = new Map();
  for (const r of rows) (byPerson.get(r.personId) || byPerson.set(r.personId, []).get(r.personId)).push(r.t);
  // pay rates (from Rippling) only go to Admins and the Owner
  const rates = me && rank(me.role) >= rank("admin") ? await payRates(db, env.ORG_ID) : null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    trainings: trainings.filter(t => t.stations.length),
    people: people.map(p => ({ ...p, name: p.displayName || `${p.firstName} ${p.lastName}`.trim(), trainings: byPerson.get(p.id) || [],
      ...(rates ? { rate: rateOn(rates.get(p.id), today) } : {}) })),
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
  return { firstName, lastName, displayName, payrollId, usualStart, note };
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
    db.prepare("INSERT INTO plan_person_prefs(person_id, usual_start, note, updated_by) VALUES(?,?,?,?)").bind(id, v.usualStart, v.note, me.id),
  ]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_people", entityId: id, action: "create", changes: v });
  return { id };
}

export async function updatePerson(db, env, me, id, body) {
  requireRole(me, "admin");
  const cur = await db.prepare(`SELECT p.first_name AS firstName, p.last_name AS lastName, p.display_name AS displayName, p.payroll_id AS payrollId,
      p.status, pp.usual_start AS usualStart, pp.note FROM core_people p LEFT JOIN plan_person_prefs pp ON pp.person_id=p.id
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
    db.prepare(`INSERT INTO plan_person_prefs(person_id, usual_start, note, updated_by) VALUES(?,?,?,?)
      ON CONFLICT(person_id) DO UPDATE SET usual_start=excluded.usual_start, note=excluded.note, updated_at=?, updated_by=excluded.updated_by, rev=rev+1`)
      .bind(id, v.usualStart, v.note, me.id, now),
  ]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_people", entityId: id, action: "update", changes: { ...body } });
  return { id };
}

/** Statements that replace a person's trainings with an ordered list of training ids (first = priority 1). */
export function trainingStmts(db, personId, list, userId) {
  return [db.prepare("DELETE FROM plan_person_trainings WHERE person_id=?").bind(personId),
    ...list.map((t, i) => db.prepare("INSERT INTO plan_person_trainings(person_id, training_id, priority, updated_by) VALUES(?,?,?,?)").bind(personId, t, i + 1, userId))];
}

/** Replaces a person's trainings, in order. */
export async function setTrainings(db, env, me, personId, list) {
  requireRole(me, "manager");
  if (!Array.isArray(list)) throw new HttpError(400, "Send the trainings in order.");
  if (new Set(list).size !== list.length) throw new HttpError(400, "A training can only be listed once.");
  const known = new Set((await listTrainings(db)).map(t => t.id));
  const bad = list.find(t => !known.has(t));
  if (bad) throw new HttpError(400, `No training called ${bad}.`);
  const p = await db.prepare("SELECT id FROM core_people WHERE id=? AND org_id=? AND deleted_at IS NULL").bind(personId, env.ORG_ID).first();
  if (!p) throw new HttpError(404, "That person isn't on the team list.");
  await db.batch(trainingStmts(db, personId, list, me.id));
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_person_trainings", entityId: personId, action: "update", changes: { trainings: list } });
  return { personId, trainings: list };
}
