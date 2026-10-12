// A day's plan: who is on which station (and when), piece counts typed over SMRT's, call-outs, and publishing.
//  - Managers and up change and publish plans; everyone can read them.
//  - Saving sends the plan's revision; if someone else saved in between, the save is refused (409) with the newer plan,
//    so two PCs never silently overwrite each other.
//  - Publishing stores a frozen copy (snapshot) of the plan as published: the Floor screens and Review read it.
import { HttpError, ulid, nowIso, audit } from "./util.js";
import { requireRole } from "./auth.js";
import { productionIds } from "./team.js";
import { planDiff } from "./changes.js";
import { timeOffBetween } from "./timeoff.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CATS = ["dct", "dcb", "slt", "slb", "comf", "tc"];
const checkDay = d => { if (!DAY.test(d)) throw new HttpError(400, "Use a date like 2026-10-12."); return d; };

async function dayRow(db, locationId, day) {
  return db.prepare("SELECT id, status, rev, updated_at AS updatedAt, updated_by AS updatedBy FROM plan_days WHERE location_id=? AND work_date=?").bind(locationId, day).first();
}

export async function loadPlan(db, env, day) {
  checkDay(day);
  const { locationId, departmentId } = await productionIds(db, env.ORG_ID);
  const d = await dayRow(db, locationId, day);
  const crew = {}, overrides = {}; let callouts = [], published = null, updatedByName = null;
  if (d) {
    for (const a of (await db.prepare(`SELECT s.code, a.person_id AS personId, a.starts_at AS start, a.hours, a.hard_stop AS stop, a.source
        FROM plan_assignments a JOIN plan_stations s ON s.id=a.station_id WHERE a.day_id=? AND a.deleted_at IS NULL`).bind(d.id).all()).results)
      crew[a.code] = { personId: a.personId, start: a.start, hours: a.hours, stop: a.stop || "", source: a.source };
    for (const o of (await db.prepare("SELECT category_id AS k, pieces FROM plan_count_overrides WHERE day_id=? AND deleted_at IS NULL").bind(d.id).all()).results) overrides[o.k] = o.pieces;
    callouts = (await db.prepare(`SELECT c.id, c.person_id AS personId, s.code AS station, c.note, c.created_at AS at FROM plan_callouts c LEFT JOIN plan_stations s ON s.id=c.station_id
        WHERE c.day_id=? AND c.deleted_at IS NULL ORDER BY c.created_at`).bind(d.id).all()).results;
    const p = await db.prepare(`SELECT p.published_at AS at, u.display_name AS by, p.snapshot_json AS snap FROM plan_publications p LEFT JOIN core_users u ON u.id=p.published_by
        WHERE p.day_id=? ORDER BY p.published_at DESC LIMIT 1`).bind(d.id).first();
    if (p) { const snap = JSON.parse(p.snap); published = { at: p.at, by: p.by, sig: snap.sig || null, source: snap.source || null }; }
    if (d.updatedBy) updatedByName = (await db.prepare("SELECT display_name AS n FROM core_users WHERE id=?").bind(d.updatedBy).first())?.n || null;
  }
  // Time off from the Team screen: "out" joins the call-outs (same effect on the plan), "late" sets the earliest start.
  const away = await timeOffBetween(db, env.ORG_ID, day, day);
  const outIds = new Set(callouts.map(c => c.personId));
  for (const t of away) if (t.kind === "out" && !outIds.has(t.personId)) { callouts.push({ id: t.id, timeOff: true, personId: t.personId, station: null, note: t.note, at: t.createdAt, fromDay: t.fromDay, toDay: t.toDay }); outIds.add(t.personId); }
  // suggestions already accepted or dismissed today (Plan › Suggestions right now)
  const hidden = (await db.prepare("SELECT key FROM plan_events WHERE org_id=? AND day=? AND (key LIKE 'dismiss:%' OR key LIKE 'accept:%')").bind(env.ORG_ID, day).all()).results
    .map(r => r.key.replace(/^(dismiss|accept):/, ""));
  const late = away.filter(t => t.kind === "late" && !outIds.has(t.personId)).map(t => ({ id: t.id, personId: t.personId, at: t.at, note: t.note }));
  return { day, rev: d ? d.rev : 0, status: d ? d.status : "new", updatedAt: d?.updatedAt || null, updatedBy: updatedByName, crew, overrides, callouts, late, hidden, published,
    history: await history(db, env, day, departmentId, locationId), clock: await clockToday(db, env, day) };
}

/** Who worked recent days (hours, first clock-in) and who was planned where: for "suggest from history" and the 40-hour watch. */
async function history(db, env, day, departmentId, locationId) {
  const from = new Date(Date.parse(day + "T12:00:00Z") - 56 * 864e5).toISOString().slice(0, 10);
  const hours = (await db.prepare(`SELECT h.work_date AS day, h.person_id AS personId, h.hours, h.first_in AS firstIn FROM labor_daily_hours h
      WHERE h.department_id=? AND h.work_date >= ? AND h.work_date < ? AND h.deleted_at IS NULL`).bind(departmentId, from, day).all()).results;
  const planned = (await db.prepare(`SELECT d.work_date AS day, s.code AS station, a.person_id AS personId FROM plan_assignments a JOIN plan_days d ON d.id=a.day_id
      JOIN plan_stations s ON s.id=a.station_id WHERE d.location_id=? AND d.work_date >= ? AND d.work_date < ? AND a.person_id IS NOT NULL AND a.deleted_at IS NULL`).bind(locationId, from, day).all()).results;
  return { hours, planned };
}
async function clockToday(db, env, day) {
  const r = await db.prepare(`SELECT c.person_id AS personId, c.clock_in AS clockIn, c.clock_out AS clockOut FROM labor_clock_today c JOIN core_people p ON p.id=c.person_id
      WHERE p.org_id=? AND substr(c.clock_in,1,10)=? AND (c.department_id IS NULL OR c.department_id=(SELECT d.id FROM core_departments d WHERE d.org_id=p.org_id AND d.name='Production')) ORDER BY c.clock_in`).bind(env.ORG_ID, day).all();
  return r.results;
}

function cleanCrew(crew, stations, people) {
  if (!crew || typeof crew !== "object") throw new HttpError(400, "Send the crew.");
  const out = [], seen = new Set();
  for (const [code, c] of Object.entries(crew)) {
    if (!c || !c.personId) continue;
    const st = stations.get(code); if (!st) throw new HttpError(400, `No station ${code}.`);
    if (!people.has(c.personId)) throw new HttpError(400, "Someone on the crew isn't on the team list.");
    if (seen.has(c.personId)) throw new HttpError(400, `${people.get(c.personId)} is on two stations.`);
    seen.add(c.personId);
    if (!TIME.test(c.start || "")) throw new HttpError(400, `Clock-in for ${code} must be a time like 05:30.`);
    if (c.stop && !TIME.test(c.stop)) throw new HttpError(400, `Hard stop for ${code} must be a time like 14:00.`);
    const hours = +c.hours; if (!(hours >= 0 && hours <= 16)) throw new HttpError(400, `Hours for ${code} must be between 0 and 16.`);
    out.push({ stationId: st, personId: c.personId, start: c.start, hours, stop: c.stop || null, source: c.source === "suggested" ? "suggested" : c.source === "clock" ? "clock" : "user" });
  }
  return out;
}

export async function savePlan(db, env, me, day, body) {
  requireRole(me, "manager"); checkDay(day);
  const { locationId } = await productionIds(db, env.ORG_ID);
  const stRows = (await db.prepare("SELECT code, id, label FROM plan_stations WHERE location_id=? AND deleted_at IS NULL").bind(locationId).all()).results;
  const stations = new Map(stRows.map(s => [s.code, s.id]));
  const people = new Map((await db.prepare("SELECT id, first_name || ' ' || last_name AS n FROM core_people WHERE org_id=? AND deleted_at IS NULL").bind(env.ORG_ID).all()).results.map(p => [p.id, p.n]));
  const crew = cleanCrew(body.crew, stations, people);
  const overrides = Object.entries(body.overrides || {}).filter(([k, v]) => CATS.includes(k) && v !== null && v !== "").map(([k, v]) => {
    const n = Math.round(+v); if (!(n >= 0 && n <= 20000)) throw new HttpError(400, `Pieces for ${k} must be a number.`); return [k, n]; });

  const cur = await dayRow(db, locationId, day);
  const rev = cur ? cur.rev : 0;
  // what it was, for the "Changes today" list
  const before = {}, ovBefore = {};
  if (cur) {
    for (const a of (await db.prepare(`SELECT s.code, a.person_id AS personId, a.starts_at AS start, a.hours, a.hard_stop AS stop FROM plan_assignments a JOIN plan_stations s ON s.id=a.station_id
        WHERE a.day_id=? AND a.deleted_at IS NULL`).bind(cur.id).all()).results) before[a.code] = a;
    for (const o of (await db.prepare("SELECT category_id AS k, pieces FROM plan_count_overrides WHERE day_id=? AND deleted_at IS NULL").bind(cur.id).all()).results) ovBefore[o.k] = o.pieces;
  }
  if (body.rev !== undefined && +body.rev !== rev) {
    throw new HttpError(409, `${cur?.updatedBy ? "Someone else" : "Another PC"} changed this plan since you opened it. Your view has been refreshed with their version.`, { latest: await loadPlan(db, env, day) });
  }
  const now = nowIso(), id = cur ? cur.id : ulid();
  // Every write below only happens if this save is the one that bumped the revision (checked inside the same
  // transaction), so two saves at the same moment can't mix their crews: one wins, the other gets a 409.
  const G = "(SELECT rev FROM plan_days WHERE id=?)=? AND (SELECT updated_at FROM plan_days WHERE id=?)=?", g = [id, rev + 1, id, now];
  const stmts = [cur
    ? db.prepare("UPDATE plan_days SET rev=rev+1, updated_at=?, updated_by=? WHERE id=? AND rev=?").bind(now, me.id, id, rev)
    : db.prepare("INSERT INTO plan_days(id, location_id, work_date, status, updated_by, updated_at, rev) VALUES(?,?,?,'draft',?,?,1)").bind(id, locationId, day, me.id, now)];
  stmts.push(db.prepare(`DELETE FROM plan_assignments WHERE day_id=? AND ${G}`).bind(id, ...g));
  for (const c of crew) stmts.push(db.prepare(`INSERT INTO plan_assignments(id, day_id, station_id, person_id, starts_at, hours, hard_stop, source, updated_by)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${G}`).bind(ulid(), id, c.stationId, c.personId, c.start, c.hours, c.stop, c.source, me.id, ...g));
  stmts.push(db.prepare(`DELETE FROM plan_count_overrides WHERE day_id=? AND ${G}`).bind(id, ...g));
  for (const [k, n] of overrides) stmts.push(db.prepare(`INSERT INTO plan_count_overrides(day_id, category_id, pieces, updated_by) SELECT ?,?,?,? WHERE ${G}`).bind(id, k, n, me.id, ...g));
  let res;
  try { res = await db.batch(stmts); }
  catch (e) { if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, "Someone else started this plan at the same moment. Your view has been refreshed with their version.", { latest: await loadPlan(db, env, day) }); throw e; }
  if (cur && res?.[0]?.meta && res[0].meta.changes === 0) throw new HttpError(409, "Someone else saved this plan at the same moment. Your view has been refreshed with their version.", { latest: await loadPlan(db, env, day) });
  const codeOf = new Map(stRows.map(s => [s.id, s.code]));
  const after = Object.fromEntries(crew.map(c => [codeOf.get(c.stationId), { personId: c.personId, start: c.start, hours: c.hours, stop: c.stop }]));
  const lines = planDiff(before, after, ovBefore, Object.fromEntries(overrides), new Map(stRows.map(s => [s.code, s.label])), people);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_days", entityId: id, action: "update", changes: { day, rev: rev + 1, crew: crew.length, overrides: Object.fromEntries(overrides), lines: lines.slice(0, 40) } });
  return { rev: rev + 1, day };
}

export async function publishPlan(db, env, me, day, body) {
  requireRole(me, "manager"); checkDay(day);
  const { locationId } = await productionIds(db, env.ORG_ID);
  const d = await dayRow(db, locationId, day);
  if (!d) throw new HttpError(409, "Save the plan before publishing it.");
  if (body.rev !== undefined && +body.rev !== d.rev) throw new HttpError(409, "The plan changed since you opened it. Check it, then publish again.", { latest: await loadPlan(db, env, day) });
  const snap = body.snapshot;
  if (!snap || typeof snap !== "object" || !snap.input || !snap.metrics) throw new HttpError(400, "Missing the plan snapshot.");
  const json = JSON.stringify({ ...snap, source: "web", rev: d.rev });
  if (json.length > 400000) throw new HttpError(413, "The plan snapshot is too large.");
  const at = nowIso();
  await db.batch([
    db.prepare("UPDATE plan_days SET status='published', updated_at=?, updated_by=? WHERE id=?").bind(at, me.id, d.id),
    db.prepare("INSERT INTO plan_publications(id, day_id, published_by, published_at, snapshot_json) VALUES(?,?,?,?,?)").bind(ulid(), d.id, me.id, at, json),
  ]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_days", entityId: d.id, action: "publish", changes: { day, rev: d.rev, metrics: snap.metrics } });
  return { published: { at, by: me.name, sig: snap.sig || null } };
}

export async function addCallout(db, env, me, day, body) {
  requireRole(me, "manager"); checkDay(day);
  const { locationId } = await productionIds(db, env.ORG_ID);
  let d = await dayRow(db, locationId, day);
  if (!d) { const id = ulid(); await db.prepare("INSERT INTO plan_days(id, location_id, work_date, status, updated_by, rev) VALUES(?,?,?,'draft',?,0)").bind(id, locationId, day, me.id).run(); d = { id }; }
  const p = await db.prepare("SELECT id FROM core_people WHERE id=? AND org_id=?").bind(body.personId, env.ORG_ID).first();
  if (!p) throw new HttpError(404, "That person isn't on the team list.");
  const st = body.station ? await db.prepare("SELECT id FROM plan_stations WHERE location_id=? AND code=?").bind(locationId, body.station).first() : null;
  const id = ulid();
  await db.prepare("INSERT INTO plan_callouts(id, day_id, person_id, station_id, note, updated_by) VALUES(?,?,?,?,?,?)").bind(id, d.id, p.id, st?.id || null, String(body.note || "").slice(0, 300) || null, me.id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_callouts", entityId: id, action: "create", changes: { day, personId: p.id, note: String(body.note || "").slice(0, 300) || null } });
  return { id };
}

export async function removeCallout(db, env, me, day, id) {
  requireRole(me, "manager"); checkDay(day);
  const c = await db.prepare("SELECT person_id AS personId FROM plan_callouts WHERE id=?").bind(id).first();
  await db.prepare("UPDATE plan_callouts SET deleted_at=?, updated_by=? WHERE id=?").bind(nowIso(), me.id, id).run();
  if (c) await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_callouts", entityId: id, action: "delete", changes: { day, personId: c.personId } });
  return { id };
}

/** The latest published plan for a day (for the Floor screens). */
export async function publishedPlan(db, env, day) {
  checkDay(day);
  const { locationId } = await productionIds(db, env.ORG_ID);
  const p = await db.prepare(`SELECT p.published_at AS at, u.display_name AS by, p.snapshot_json AS snap FROM plan_publications p JOIN plan_days d ON d.id=p.day_id
      LEFT JOIN core_users u ON u.id=p.published_by WHERE d.location_id=? AND d.work_date=? ORDER BY p.published_at DESC LIMIT 1`).bind(locationId, day).first();
  return p ? { at: p.at, by: p.by, snapshot: JSON.parse(p.snap) } : null;
}
