// Time off and late arrivals (Team screen). "out" covers from_day..to_day; "late" is one day with an arrival time.
// Managers and up add and remove them; everyone can see them.
import { HttpError, ulid, nowIso, audit } from "./util.js";
import { requireRole } from "./auth.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const COLS = "t.id, t.person_id AS personId, t.kind, t.from_day AS fromDay, t.to_day AS toDay, t.at, t.note, t.created_at AS createdAt, u.display_name AS by";

/** Entries that touch [from, to] (inclusive). */
export async function timeOffBetween(db, orgId, from, to) {
  return (await db.prepare(`SELECT ${COLS} FROM plan_time_off t LEFT JOIN core_users u ON u.id = t.created_by
      WHERE t.org_id=? AND t.deleted_at IS NULL AND t.to_day >= ? AND t.from_day <= ? ORDER BY t.from_day, t.at`).bind(orgId, from, to).all()).results;
}

export async function listTimeOff(db, env, { from, to }) {
  if (!DAY.test(from || "") || !DAY.test(to || "") || to < from) throw new HttpError(400, "Use dates like 2026-10-12.");
  return { list: await timeOffBetween(db, env.ORG_ID, from, to) };
}

export async function addTimeOff(db, env, me, body) {
  requireRole(me, "manager");
  const kind = body.kind === "late" ? "late" : body.kind === "out" ? "out" : null;
  if (!kind) throw new HttpError(400, "Pick Out or In late.");
  const fromDay = String(body.fromDay || ""), toDay = kind === "late" ? fromDay : String(body.toDay || body.fromDay || "");
  if (!DAY.test(fromDay) || !DAY.test(toDay)) throw new HttpError(400, "Pick a date.");
  if (toDay < fromDay) throw new HttpError(400, "The last day can't be before the first day.");
  if ((Date.parse(toDay) - Date.parse(fromDay)) / 864e5 > 120) throw new HttpError(400, "Time off can be at most 4 months at once.");
  const at = kind === "late" ? String(body.at || "") : null;
  if (kind === "late" && !TIME.test(at)) throw new HttpError(400, "Pick the time they'll come in.");
  const p = await db.prepare("SELECT id FROM core_people WHERE id=? AND org_id=? AND deleted_at IS NULL").bind(body.personId, env.ORG_ID).first();
  if (!p) throw new HttpError(404, "That person isn't on the team list.");
  const note = String(body.note || "").trim().slice(0, 300) || null;
  // a new entry replaces what it overlaps for that person (out over late, or a corrected late time)
  const clash = (await db.prepare(`SELECT id FROM plan_time_off WHERE org_id=? AND person_id=? AND deleted_at IS NULL AND to_day >= ? AND from_day <= ?
      AND (kind='late' OR ?='out')`).bind(env.ORG_ID, p.id, fromDay, toDay, kind).all()).results;
  const now = nowIso(), id = ulid();
  await db.batch([
    ...clash.map(c => db.prepare("UPDATE plan_time_off SET deleted_at=?, updated_at=?, updated_by=?, rev=rev+1 WHERE id=?").bind(now, now, me.id, c.id)),
    db.prepare("INSERT INTO plan_time_off(id, org_id, person_id, kind, from_day, to_day, at, note, created_by, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(id, env.ORG_ID, p.id, kind, fromDay, toDay, at, note, me.id, me.id),
  ]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_time_off", entityId: id, action: "create", changes: { personId: p.id, kind, fromDay, toDay, at, note } });
  return { id, replaced: clash.map(c => c.id) };
}

export async function removeTimeOff(db, env, me, id) {
  requireRole(me, "manager");
  const t = await db.prepare("SELECT person_id AS personId, kind, from_day AS fromDay, to_day AS toDay, at FROM plan_time_off WHERE id=? AND org_id=? AND deleted_at IS NULL").bind(id, env.ORG_ID).first();
  if (!t) throw new HttpError(404, "That time off was already removed.");
  const now = nowIso();
  await db.prepare("UPDATE plan_time_off SET deleted_at=?, updated_at=?, updated_by=?, rev=rev+1 WHERE id=?").bind(now, now, me.id, id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_time_off", entityId: id, action: "delete", changes: t });
  return { id };
}
