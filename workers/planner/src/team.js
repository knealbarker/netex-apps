// The production team: people in the Production department, their usual clock-in, Rippling id,
// and how well they run each station (1st = best fit, 2nd = good backup, 3rd = can fill in).
// Everyone signed in can see the team. Managers and up can change station rankings (they do it while planning);
// Admins and the Owner add, edit and turn off people.
import { HttpError, ulid, nowIso, cleanName, audit } from "./util.js";
import { requireRole } from "./auth.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function productionIds(db, orgId) {
  const dep = await db.prepare("SELECT id FROM core_departments WHERE org_id=? AND name='Production'").bind(orgId).first();
  const loc = await db.prepare("SELECT id FROM core_locations WHERE org_id=? AND kind='plant' ORDER BY created_at LIMIT 1").bind(orgId).first();
  if (!dep || !loc) throw new HttpError(500, "The Production department or the Workshop is missing from the database.");
  return { departmentId: dep.id, locationId: loc.id };
}

export async function listTeam(db, env) {
  const { departmentId, locationId } = await productionIds(db, env.ORG_ID);
  const stations = (await db.prepare(`SELECT id, code, label, station_type_id AS type FROM plan_stations
      WHERE location_id=? AND deleted_at IS NULL AND is_active=1 ORDER BY sort`).bind(locationId).all()).results;
  const people = (await db.prepare(`SELECT p.id, p.first_name AS firstName, p.last_name AS lastName, p.display_name AS displayName,
        p.payroll_id AS payrollId, p.status, pp.usual_start AS usualStart, pp.note
      FROM core_people p LEFT JOIN plan_person_prefs pp ON pp.person_id = p.id
      WHERE p.org_id=? AND p.department_id=? AND p.deleted_at IS NULL
      ORDER BY p.status='active' DESC, COALESCE(p.display_name, p.first_name || ' ' || p.last_name) COLLATE NOCASE`).bind(env.ORG_ID, departmentId).all()).results;
  const skills = (await db.prepare(`SELECT k.person_id AS personId, s.code, k.rank FROM plan_skills k JOIN plan_stations s ON s.id = k.station_id
      WHERE s.location_id=? AND k.deleted_at IS NULL`).bind(locationId).all()).results;
  const byPerson = new Map();
  for (const k of skills) (byPerson.get(k.personId) || byPerson.set(k.personId, {}).get(k.personId))[k.code] = k.rank;
  return {
    stations,
    people: people.map(p => ({ ...p, name: p.displayName || `${p.firstName} ${p.lastName}`.trim(), skills: byPerson.get(p.id) || {} })),
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

/** Sets one station ranking. rank 1-3, or null for "not trained". */
export async function setSkill(db, env, me, personId, code, rank) {
  requireRole(me, "manager");
  if (rank !== null && ![1, 2, 3].includes(rank)) throw new HttpError(400, "Rank must be 1, 2, 3 or empty.");
  const { locationId } = await productionIds(db, env.ORG_ID);
  const st = await db.prepare("SELECT id FROM plan_stations WHERE location_id=? AND code=? AND deleted_at IS NULL").bind(locationId, code).first();
  if (!st) throw new HttpError(404, `No station ${code}.`);
  const p = await db.prepare("SELECT id FROM core_people WHERE id=? AND org_id=? AND deleted_at IS NULL").bind(personId, env.ORG_ID).first();
  if (!p) throw new HttpError(404, "That person isn't on the team list.");
  const now = nowIso();
  await (rank === null
    ? db.prepare("DELETE FROM plan_skills WHERE person_id=? AND station_id=?").bind(personId, st.id)
    : db.prepare(`INSERT INTO plan_skills(person_id, station_id, rank, updated_by) VALUES(?,?,?,?)
        ON CONFLICT(person_id, station_id) DO UPDATE SET rank=excluded.rank, updated_at=?, updated_by=excluded.updated_by, deleted_at=NULL, rev=rev+1`).bind(personId, st.id, rank, me.id, now)
  ).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_skills", entityId: `${personId}:${code}`, action: "update", changes: { rank } });
  return { personId, code, rank };
}
