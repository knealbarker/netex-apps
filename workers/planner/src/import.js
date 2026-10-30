// One-time (repeatable) import from the desktop planner:
//   planner-data.json  -> team, station rankings, usual clock-ins, settings, speeds, shuttle runs
//   Plan History/*.json -> each day's saved plan (as a published plan) and actual hours from Rippling (labor_daily_hours)
// Running it again updates the same rows (people are matched by Rippling id, then by name); nothing is duplicated.
// Owner only.
import { HttpError, ulid, nowIso, audit } from "./util.js";
import { requireRole } from "./auth.js";
import { loadGroups, validateGroup, putGroupStmt, productionStmts, runsStmts } from "./settings.js";
import { productionIds, importTrainingStmts } from "./team.js";

const CATS = ["dct", "dcb", "slt", "slb", "comf", "tc"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const hhmm = h => { if (typeof h !== "number" || !Number.isFinite(h)) return null; const m = Math.round(h * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const splitName = full => { const p = String(full || "").trim().split(/\s+/); return { first: p[0] || "?", last: p.slice(1).join(" ") }; };
const iso = ms => (typeof ms === "number" ? new Date(ms).toISOString() : nowIso());

/** Desktop settings -> the web app's settings groups (only values the desktop file has). */
export function mapSettings(d) {
  const has = k => d[k] !== undefined && d[k] !== null;
  const pick = pairs => Object.fromEntries(pairs.filter(([, k]) => has(k)).map(([to, k]) => [to, d[k]]));
  const g = {
    business: pick([["name", "biz"]]),
    day: pick([["defStart", "defStart"], ["breakMin", "breakMin"], ["breakAfter", "breakAfter"]]),
    money: { ...pick([["payAvg", "payAvg"], ["laborTarget", "laborTarget"], ["pdfMoney", "pdfMoney"]]), ...(d.price ? { prices: d.price } : {}) },
    alerts: {}, smrt: {}, rippling: {},
  };
  const sh = d.shuttles || {};
  if (Array.isArray(sh.warn)) { if (sh.warn[0] != null) g.alerts.warnFirst = sh.warn[0]; if (sh.warn[1] != null) g.alerts.warnSecond = sh.warn[1]; }
  if (sh.notify !== undefined) g.alerts.notify = !!sh.notify;
  if (sh.weekStart !== undefined) g.alerts.weekStart = sh.weekStart;
  const sm = d.smrtMap || {};
  if (sm.overdue !== undefined) g.smrt.overdue = !!sm.overdue;
  if (sm.deps) g.smrt.departments = sm.deps;
  const types = { ...(sm.types || {}) };
  for (const [cat, aliases] of Object.entries(d.csvAliases || {})) { // e.g. comforters also called "Bedspread" in SMRT
    const list = new Set(String(types[cat] || "").split(",").map(s => s.trim()).filter(Boolean));
    for (const a of aliases) list.add(a);
    types[cat] = [...list].join(", ");
  }
  if (Object.keys(types).length) g.smrt.itemTypes = types;
  if (d.rip) { if (Array.isArray(d.rip.depts)) g.rippling.departments = d.rip.depts; }
  return g;
}

/** Desktop rates (pieces/hour) -> plan_station_rates rows. */
export function mapRates(r = {}) {
  const out = [];
  const add = (type, category, v) => { if (typeof v === "number" && v > 0) out.push({ type, category, perHour: v }); };
  add("slt", "slt", r.sltSolo); add("slt_helper", "slt", r.sltPair); add("slb", "slb", r.slb);
  add("dct", "dct", r.dct); add("dcb", "dcb", r.dcb); add("dcb", "tc", r.tc); add("comf", "comf", r.comf);
  for (const c of CATS) add("asm", c, r.asm);
  return out;
}

export function mapRuns(sh = {}) {
  const runs = (sh.runs || []).map(r => ({
    name: r.name, kind: "shuttle", driveBack: r.back ?? null,
    stops: (r.stops || []).map(s => ({ store: s.store, arrive: s.arrive, drive: s.drive ?? 0, stay: s.stay ?? 15, cutoff: s.cutoff || null })),
  }));
  if (sh.counter && sh.counter.store) runs.push({ name: sh.counter.name || `${sh.counter.store} counter`, kind: "counter", driveBack: null,
    stops: [{ store: sh.counter.store, arrive: sh.counter.ready, drive: 0, stay: 0, cutoff: sh.counter.cutoff || null }] });
  return runs;
}

export async function importDesktop(db, env, me, body) {
  requireRole(me, "owner");
  const d = body && body.data;
  if (!d || typeof d !== "object" || !Array.isArray(d.employees)) throw new HttpError(400, "That doesn't look like the desktop planner's planner-data.json.");
  const history = Array.isArray(body.history) ? body.history : [];
  const orgId = env.ORG_ID, now = nowIso();
  const { departmentId, locationId } = await productionIds(db, orgId);
  const stmts = [];
  const summary = { peopleAdded: 0, peopleUpdated: 0, trainings: 0, settings: 0, runs: 0, planDays: 0, hoursRows: 0, skipped: [] };

  // ---- people (match by Rippling id, then by full name)
  const existing = (await db.prepare("SELECT id, payroll_id AS payrollId, lower(trim(first_name || ' ' || last_name)) AS full FROM core_people WHERE org_id=? AND deleted_at IS NULL").bind(orgId).all()).results;
  const byPayroll = new Map(existing.filter(p => p.payrollId).map(p => [String(p.payrollId), p.id]));
  const byName = new Map(existing.map(p => [p.full, p.id]));
  const personFor = (rip, name, active) => {
    const n = splitName(name), full = `${n.first} ${n.last}`.trim().toLowerCase();
    let id = (rip && byPayroll.get(String(rip))) || byName.get(full);
    if (id) {
      if (active) {
        stmts.push(db.prepare(`UPDATE core_people SET first_name=?, last_name=?, payroll_id=COALESCE(?, payroll_id), department_id=?, home_location_id=COALESCE(home_location_id, ?),
          status='active', updated_at=?, updated_by=?, rev=rev+1 WHERE id=?`).bind(n.first, n.last, rip ? String(rip) : null, departmentId, locationId, now, me.id, id));
        summary.peopleUpdated++;
      }
      return id;
    }
    id = ulid();
    stmts.push(db.prepare(`INSERT INTO core_people(id, org_id, department_id, home_location_id, first_name, last_name, payroll_id, status, updated_by) VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(id, orgId, departmentId, locationId, n.first, n.last, rip ? String(rip) : null, active ? "active" : "inactive", me.id));
    if (rip) byPayroll.set(String(rip), id);
    byName.set(full, id);
    summary.peopleAdded++;
    return id;
  };

  const stations = new Map((await db.prepare("SELECT code, id FROM plan_stations WHERE location_id=?").bind(locationId).all()).results.map(s => [s.code, s.id]));
  // desktop ranks are per station (1st/2nd/3rd, ties allowed); here each person has one ordered list per training
  const trainingOf = new Map((await db.prepare("SELECT s.code, s.training_id AS t, tr.sort FROM plan_stations s JOIN plan_trainings tr ON tr.id = s.training_id WHERE s.location_id=?").bind(locationId).all()).results.map(r => [r.code, r]));
  const empToPerson = new Map();
  for (const e of d.employees) {
    if (!e || !e.name) continue;
    const pid = personFor(e.rip || null, e.ripName || e.name, true);
    empToPerson.set(e.id, pid);
    stmts.push(db.prepare(`INSERT INTO plan_person_prefs(person_id, usual_start, updated_by) VALUES(?,?,?)
      ON CONFLICT(person_id) DO UPDATE SET usual_start=COALESCE(excluded.usual_start, usual_start), updated_at=?, updated_by=excluded.updated_by, rev=rev+1`)
      .bind(pid, /^\d\d:\d\d$/.test(e.start || "") ? e.start : null, me.id, now));
    const best = new Map();
    for (const [code, v] of Object.entries(e.skills || {})) {
      const tr = trainingOf.get(code), rank = v === true ? 1 : +v;
      if (!tr || ![1, 2, 3].includes(rank)) { summary.skipped.push(`${e.name}: ranking ${code}=${v}`); continue; }
      const cur = best.get(tr.t);
      if (!cur || rank < cur.rank) best.set(tr.t, { rank, sort: tr.sort });
    }
    const list = [...best.entries()].sort((a, b) => a[1].rank - b[1].rank || a[1].sort - b[1].sort).map(([t]) => t);
    stmts.push(...importTrainingStmts(db, pid, list, me.id)); // the desktop list is the whole truth for these people
    summary.trainings += list.length;
  }

  // ---- settings groups
  const current = await loadGroups(db, orgId);
  for (const [group, patch] of Object.entries(mapSettings(d))) {
    if (!Object.keys(patch).length) continue;
    stmts.push(putGroupStmt(db, orgId, group, validateGroup(group, current[group], patch), me.id));
    summary.settings++;
  }
  // ---- speeds, assembly
  const categories = CATS.filter(c => d.asmInclude && c in d.asmInclude).map(c => ({ id: c, needsAssembly: !!d.asmInclude[c] }));
  stmts.push(...(await productionStmts(db, orgId, me.id, { rates: mapRates(d.rates), categories })));
  // ---- shuttle runs
  const runs = mapRuns(d.shuttles);
  if (runs.length) { stmts.push(...(await runsStmts(db, orgId, me.id, runs))); summary.runs = runs.length; }

  // ---- plan history
  for (const h of history) {
    if (!h || !DAY.test(h.day || "")) { summary.skipped.push("history file without a day"); continue; }
    if (h.actual && Array.isArray(h.actual.people)) {
      for (const p of h.actual.people) {
        if (!p.name || typeof p.hours !== "number") continue;
        const pid = personFor(p.rip || null, p.name, false);
        stmts.push(db.prepare(`INSERT INTO labor_daily_hours(person_id, work_date, department_id, location_id, hours, first_in, last_out, updated_by) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(person_id, work_date, department_id, location_id) DO UPDATE SET hours=excluded.hours, first_in=excluded.first_in, last_out=excluded.last_out, updated_at=?, updated_by=excluded.updated_by, rev=rev+1`)
          .bind(pid, h.day, departmentId, locationId, Math.round(p.hours * 100) / 100, hhmm(p.in), p.open ? null : hhmm(p.out), me.id, now));
        summary.hoursRows++;
      }
    }
    if (h.plan && Array.isArray(h.plan.crew)) {
      const day = await db.prepare("SELECT id FROM plan_days WHERE location_id=? AND work_date=?").bind(locationId, h.day).first();
      const dayId = day ? day.id : ulid();
      if (!day) stmts.push(db.prepare("INSERT INTO plan_days(id, location_id, work_date, status, updated_by) VALUES(?,?,?,'published',?)").bind(dayId, locationId, h.day, me.id));
      else stmts.push(db.prepare("UPDATE plan_days SET status='published', updated_at=?, updated_by=?, rev=rev+1 WHERE id=?").bind(now, me.id, dayId));
      stmts.push(db.prepare("DELETE FROM plan_assignments WHERE day_id=?").bind(dayId));
      for (const c of h.plan.crew) {
        const sid = stations.get(c.st);
        if (!sid || !/^\d\d:\d\d$/.test(c.start || "")) continue;
        const pid = c.name ? personFor(c.rip || null, c.name, false) : null;
        stmts.push(db.prepare("INSERT INTO plan_assignments(id, day_id, station_id, person_id, starts_at, hours, hard_stop, source, updated_by) VALUES(?,?,?,?,?,?,?,?,?)")
          .bind(ulid(), dayId, sid, pid, c.start, +c.hrs || 0, c.stop || null, "user", me.id));
      }
      stmts.push(db.prepare("DELETE FROM plan_publications WHERE day_id=? AND json_extract(snapshot_json, '$.source')='desktop'").bind(dayId));
      stmts.push(db.prepare("INSERT INTO plan_publications(id, day_id, published_by, published_at, snapshot_json) VALUES(?,?,?,?,?)")
        .bind(ulid(), dayId, me.id, iso(h.plan.at), JSON.stringify({ source: "desktop", pieces: h.plan.q, prices: h.plan.price, crew: h.plan.crew, metrics: h.plan.metrics, smrt: h.smrt ? { due: h.smrt.due, overdue: h.smrt.overdue, readAt: h.smrt.readAt } : null })));
      summary.planDays++;
    }
  }

  // D1 batches are atomic; keep each under its statement limit
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  await audit(db, { orgId, userId: me.id, appId: env.APP_ID, entity: "import", entityId: "desktop", action: "create", changes: summary });
  return summary;
}
