// Planner settings.
//  - Simple values (working day, overtime, money, washers, alerts, SMRT/Rippling mapping) live in core_settings,
//    one row per group, checked against SCHEMA below so bad values never get saved.
//  - Things with their own shape live in their own tables: piece categories, station speeds, wash programs,
//    stations (max hours, on/off) and the shuttle runs with their stops.
// Everyone can read settings; Admins and the Owner change them.
import { HttpError, ulid, nowIso, audit } from "./util.js";
import { requireRole } from "./auth.js";

const CATS = ["dct", "dcb", "slt", "slb", "comf", "tc"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// field kinds: [kind, default, ...limits]
const f = {
  time: d => ({ kind: "time", d }),
  num: (d, min, max) => ({ kind: "num", d, min, max }),
  int: (d, min, max) => ({ kind: "int", d, min, max }),
  bool: d => ({ kind: "bool", d }),
  text: (d, max = 80) => ({ kind: "text", d, max }),
  list: d => ({ kind: "list", d }),
  days: d => ({ kind: "days", d }),
  perCat: (inner, d) => ({ kind: "perCat", inner, d }),
};
export const SCHEMA = {
  business: { name: f.text("Town & Country Cleaners") },
  day: { workDays: f.days([1, 2, 3, 4, 5]), defStart: f.time("07:00"), fullDay: f.num(7.5, 1, 14), breakMin: f.int(30, 0, 120), breakAfter: f.num(4, 0, 12), spread: f.int(30, 0, 240), staggerBreaks: f.bool(true) },
  staffing: { allowOT: f.bool(true), otMax: f.num(2, 0, 8), otMult: f.num(1.5, 1, 3), allowMoves: f.bool(true), allowClockOut: f.bool(true), minPaid: f.num(4, 0, 12) },
  money: { payAvg: f.num(15, 0, 200), laborTarget: f.num(17, 0, 100), pdfMoney: f.bool(false),
    prices: f.perCat(f.num(0, 0, 1000), { dct: 7.5, dcb: 8, slt: 4.15, slb: 7.25, comf: 30, tc: 12 }) },
  route: { dayBefore: f.bool(true), readyBy: f.time("08:00") },
  wash: { on: f.bool(true), washers: f.int(3, 0, 20), delay: f.int(20, 0, 240) },
  alerts: { warnFirst: f.int(45, 0, 240), warnSecond: f.int(15, 0, 240), notify: f.bool(true), weekStart: f.int(1, 0, 6) },
  smrt: { overdue: f.bool(true), transitRack: f.text("Van", 40),
    departments: f.perCat(f.text("", 200), { dct: "Dry Cleaning Tops", dcb: "Dry Cleaning Bottoms", slt: "Laundry Tops", slb: "Laundry Bottoms", comf: "", tc: "" }),
    itemTypes: f.perCat(f.text("", 200), { dct: "", dcb: "", slt: "", slb: "", comf: "Comforter, Bedspread", tc: "Tablecloth, Table Cloth" }) },
  rippling: { departments: f.list(["Production"]), useTimes: f.bool(true) },
};

const defaults = group => Object.fromEntries(Object.entries(SCHEMA[group]).map(([k, s]) => [k, structuredClone(s.d)]));

function check(group, key, s, v) {
  const where = `${group}.${key}`;
  switch (s.kind) {
    case "time": if (typeof v !== "string" || !TIME.test(v)) throw new HttpError(400, `${where}: use a time like 07:00.`); return v;
    case "num": case "int": {
      const n = typeof v === "string" && v.trim() !== "" ? +v : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new HttpError(400, `${where}: must be a number.`);
      if (s.kind === "int" && !Number.isInteger(n)) throw new HttpError(400, `${where}: must be a whole number.`);
      if (n < s.min || n > s.max) throw new HttpError(400, `${where}: must be between ${s.min} and ${s.max}.`);
      return n;
    }
    case "bool": if (typeof v !== "boolean") throw new HttpError(400, `${where}: must be yes or no.`); return v;
    case "text": if (typeof v !== "string" || v.length > s.max) throw new HttpError(400, `${where}: text too long.`); return v.trim();
    case "days": {
      if (!Array.isArray(v) || v.some(x => !Number.isInteger(x) || x < 0 || x > 6)) throw new HttpError(400, `${where}: pick days of the week.`);
      const d = [...new Set(v)].sort();
      if (!d.length) throw new HttpError(400, "Pick at least one work day.");
      return d;
    }
    case "list": if (!Array.isArray(v) || v.some(x => typeof x !== "string")) throw new HttpError(400, `${where}: must be a list.`); return v.map(x => x.trim()).filter(Boolean);
    case "perCat": {
      if (!v || typeof v !== "object") throw new HttpError(400, `${where}: missing values.`);
      return Object.fromEntries(CATS.map(c => [c, check(group, `${key}.${c}`, s.inner, v[c] ?? s.d[c])]));
    }
  }
}
/** Validates a (possibly partial) group, merged over what's saved. */
export function validateGroup(group, current, patch) {
  const schema = SCHEMA[group];
  if (!schema) throw new HttpError(404, `No settings group "${group}".`);
  const out = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!schema[k]) throw new HttpError(400, `${group}.${k} isn't a setting.`);
    out[k] = check(group, k, schema[k], v);
  }
  return out;
}

export async function loadGroups(db, orgId) {
  const { results } = await db.prepare("SELECT key, value_json FROM core_settings WHERE org_id=? AND app_id='planner' AND deleted_at IS NULL").bind(orgId).all();
  const saved = Object.fromEntries(results.map(r => [r.key, JSON.parse(r.value_json)]));
  return Object.fromEntries(Object.keys(SCHEMA).map(g => [g, { ...defaults(g), ...(saved[g] || {}) }]));
}

export const putGroupStmt = (db, orgId, group, value, userId) =>
  db.prepare(`INSERT INTO core_settings(org_id, app_id, key, value_json, updated_by) VALUES(?, 'planner', ?, ?, ?)
    ON CONFLICT(org_id, app_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by=excluded.updated_by, deleted_at=NULL, rev=rev+1`)
    .bind(orgId, group, JSON.stringify(value), userId || null);

export async function saveGroup(db, env, me, group, patch) {
  requireRole(me, "admin");
  const all = await loadGroups(db, env.ORG_ID);
  if (!all[group]) throw new HttpError(404, `No settings group "${group}".`);
  const next = validateGroup(group, all[group], patch);
  await putGroupStmt(db, env.ORG_ID, group, next, me.id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_settings", entityId: `planner.${group}`, action: "update", changes: patch });
  return next;
}

// ---------------- production setup: categories, stations, speeds, wash programs ----------------
export async function loadProduction(db, orgId) {
  const q = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
  const categories = await q("SELECT id, name, color, needs_assembly AS needsAssembly, sort FROM plan_categories ORDER BY sort");
  const stationTypes = await q("SELECT id, name FROM plan_station_types");
  const stations = await q(`SELECT s.id, s.code, s.label, s.station_type_id AS type, s.max_hours AS maxHours, s.is_active AS active, s.sort
      FROM plan_stations s JOIN core_locations l ON l.id = s.location_id WHERE l.org_id = ? AND s.deleted_at IS NULL ORDER BY s.sort`, orgId);
  const rates = await q("SELECT station_type_id AS type, category_id AS category, pieces_per_hour AS perHour FROM plan_station_rates WHERE deleted_at IS NULL");
  const wash = await q("SELECT category_id AS category, pieces_per_load AS perLoad, cycle_min AS cycleMin FROM plan_wash_programs WHERE deleted_at IS NULL");
  return { categories: categories.map(c => ({ ...c, needsAssembly: !!c.needsAssembly })), stationTypes, stations: stations.map(s => ({ ...s, active: !!s.active })), rates, wash };
}

const posNum = (v, what, max = 10000) => {
  const n = +v;
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new HttpError(400, `${what} must be a number above 0.`);
  return n;
};

/** Statements that save the production setup (used by the Settings screen and the desktop import). */
export async function productionStmts(db, orgId, userId, body) {
  const stmts = [];
  const now = nowIso();
  const known = await loadProduction(db, orgId);
  const typeIds = new Set(known.stationTypes.map(t => t.id)), catIds = new Set(known.categories.map(c => c.id));
  for (const r of body.rates || []) {
    if (!typeIds.has(r.type) || !catIds.has(r.category)) throw new HttpError(400, `Unknown station type or category: ${r.type}/${r.category}.`);
    stmts.push(db.prepare(`INSERT INTO plan_station_rates(station_type_id, category_id, pieces_per_hour, updated_by) VALUES(?,?,?,?)
      ON CONFLICT(station_type_id, category_id) DO UPDATE SET pieces_per_hour=excluded.pieces_per_hour, updated_at=?, updated_by=excluded.updated_by, deleted_at=NULL, rev=rev+1`)
      .bind(r.type, r.category, posNum(r.perHour, `Speed for ${r.type}`), userId, now));
  }
  for (const w of body.wash || []) {
    if (!catIds.has(w.category)) throw new HttpError(400, `Unknown category ${w.category}.`);
    const perLoad = Math.round(posNum(w.perLoad, "Pieces per load", 1000)), cycle = Math.round(posNum(w.cycleMin, "Cycle minutes", 600));
    stmts.push(db.prepare(`INSERT INTO plan_wash_programs(category_id, pieces_per_load, cycle_min, updated_by) VALUES(?,?,?,?)
      ON CONFLICT(category_id) DO UPDATE SET pieces_per_load=excluded.pieces_per_load, cycle_min=excluded.cycle_min, updated_at=?, updated_by=excluded.updated_by, deleted_at=NULL, rev=rev+1`)
      .bind(w.category, perLoad, cycle, userId, now));
  }
  for (const c of body.categories || []) {
    if (!catIds.has(c.id)) throw new HttpError(400, `Unknown category ${c.id}.`);
    stmts.push(db.prepare("UPDATE plan_categories SET needs_assembly=? WHERE id=?").bind(c.needsAssembly ? 1 : 0, c.id));
  }
  const stationIds = new Map(known.stations.map(s => [s.code, s.id]));
  for (const s of body.stations || []) {
    const id = stationIds.get(s.code);
    if (!id) throw new HttpError(400, `Unknown station ${s.code}.`);
    const max = s.maxHours === null || s.maxHours === "" || s.maxHours === undefined ? null : posNum(s.maxHours, `Max hours for ${s.code}`, 24);
    const label = s.label !== undefined ? String(s.label).trim().slice(0, 40) : null;
    if (label === "") throw new HttpError(400, "A station needs a name.");
    stmts.push(db.prepare(`UPDATE plan_stations SET max_hours=?, is_active=COALESCE(?, is_active), label=COALESCE(?, label), updated_at=?, updated_by=?, rev=rev+1 WHERE id=?`)
      .bind(max, s.active === undefined ? null : s.active ? 1 : 0, label, now, userId, id));
  }
  return stmts;
}

export async function saveProduction(db, env, me, body) {
  requireRole(me, "admin");
  const stmts = await productionStmts(db, env.ORG_ID, me.id, body);
  if (stmts.length) await db.batch(stmts);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_station_rates", entityId: "production", action: "update", changes: body });
  return loadProduction(db, env.ORG_ID);
}

// ---------------- shuttle runs ----------------
export async function loadRuns(db, orgId) {
  const runs = (await db.prepare("SELECT id, name, kind, drive_back_min AS driveBack, sort FROM plan_runs WHERE org_id=? AND deleted_at IS NULL AND is_active=1 ORDER BY sort").bind(orgId).all()).results;
  const stops = (await db.prepare(`SELECT s.run_id AS runId, s.seq, l.name AS store, s.arrive_at AS arrive, s.drive_min AS drive, s.stop_min AS stay, s.dropoff_cutoff AS cutoff
      FROM plan_run_stops s JOIN core_locations l ON l.id = s.location_id JOIN plan_runs r ON r.id = s.run_id
      WHERE r.org_id=? AND s.deleted_at IS NULL ORDER BY s.seq`).bind(orgId).all()).results;
  return runs.map(r => ({ ...r, stops: stops.filter(s => s.runId === r.id).map(({ runId, seq, ...s }) => s) }));
}

async function storeId(db, orgId, name, cache, stmts) {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const row = await db.prepare("SELECT id FROM core_locations WHERE org_id=? AND lower(name)=?").bind(orgId, key).first();
  const id = row ? row.id : ulid();
  if (!row) stmts.push(db.prepare("INSERT INTO core_locations(id, org_id, name, kind) VALUES(?,?,?,'store')").bind(id, orgId, name));
  cache.set(key, id);
  return id;
}

/** Replaces the run list. Runs not sent are switched off (kept for history). */
export async function runsStmts(db, orgId, userId, runs) {
  if (!Array.isArray(runs)) throw new HttpError(400, "Send the list of runs.");
  const stmts = [], cache = new Map(), now = nowIso();
  const existing = new Set((await db.prepare("SELECT id FROM plan_runs WHERE org_id=?").bind(orgId).all()).results.map(r => r.id));
  const keep = new Set();
  for (const [i, r] of runs.entries()) {
    const name = String(r.name || "").trim();
    if (!name) throw new HttpError(400, `Run ${i + 1} needs a name.`);
    const kind = r.kind === "counter" ? "counter" : "shuttle";
    if (!Array.isArray(r.stops) || !r.stops.length) throw new HttpError(400, `${name}: add at least one stop.`);
    const id = r.id && existing.has(r.id) ? r.id : ulid();
    keep.add(id);
    const back = r.driveBack === "" || r.driveBack == null ? null : Math.round(+r.driveBack);
    if (back !== null && !(back >= 0 && back <= 600)) throw new HttpError(400, `${name}: drive back must be minutes.`);
    stmts.push(existing.has(id)
      ? db.prepare("UPDATE plan_runs SET name=?, kind=?, drive_back_min=?, sort=?, is_active=1, deleted_at=NULL, updated_at=?, updated_by=?, rev=rev+1 WHERE id=?").bind(name, kind, back, i, now, userId, id)
      : db.prepare("INSERT INTO plan_runs(id, org_id, name, kind, drive_back_min, sort, updated_by) VALUES(?,?,?,?,?,?,?)").bind(id, orgId, name, kind, back, i, userId));
    stmts.push(db.prepare("DELETE FROM plan_run_stops WHERE run_id=?").bind(id));
    const seen = new Set();
    for (const [j, s] of r.stops.entries()) {
      const store = String(s.store || "").trim();
      if (!store) throw new HttpError(400, `${name}: stop ${j + 1} needs a store.`);
      if (seen.has(store.toLowerCase())) throw new HttpError(400, `${name}: ${store} is listed twice.`);
      seen.add(store.toLowerCase());
      if (!TIME.test(s.arrive || "")) throw new HttpError(400, `${name} › ${store}: arrival must be a time like 11:30.`);
      if (s.cutoff && !TIME.test(s.cutoff)) throw new HttpError(400, `${name} › ${store}: drop-off cutoff must be a time like 11:00.`);
      const drive = Math.round(+(s.drive ?? 0)), stay = Math.round(+(s.stay ?? 15));
      if (!(drive >= 0 && drive <= 600 && stay >= 0 && stay <= 600)) throw new HttpError(400, `${name} › ${store}: drive and stop times are minutes.`);
      const loc = await storeId(db, orgId, store, cache, stmts);
      stmts.push(db.prepare("INSERT INTO plan_run_stops(id, run_id, location_id, seq, arrive_at, drive_min, stop_min, dropoff_cutoff, updated_by) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(ulid(), id, loc, j + 1, s.arrive, drive, stay, s.cutoff || null, userId));
    }
  }
  for (const id of existing) if (!keep.has(id)) stmts.push(db.prepare("UPDATE plan_runs SET is_active=0, updated_at=?, updated_by=?, rev=rev+1 WHERE id=?").bind(now, userId, id));
  return stmts;
}

export async function saveRuns(db, env, me, runs) {
  requireRole(me, "admin");
  await db.batch(await runsStmts(db, env.ORG_ID, me.id, runs));
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_runs", entityId: "all", action: "update", changes: { runs: runs.length } });
  return loadRuns(db, env.ORG_ID);
}

export async function allSettings(db, env) {
  const [groups, production, runs] = await Promise.all([loadGroups(db, env.ORG_ID), loadProduction(db, env.ORG_ID), loadRuns(db, env.ORG_ID)]);
  return { groups, ...production, runs };
}
