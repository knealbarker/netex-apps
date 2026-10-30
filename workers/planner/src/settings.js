// Planner settings.
//  - Simple values (working day, money, alerts, SMRT/Rippling mapping) live in core_settings,
//    one row per group, checked against SCHEMA below so bad values never get saved.
//  - Things with their own shape live in their own tables: piece categories, station speeds,
//    stations (names, on/off) and the shuttle runs with their stops.
// Everyone can read settings; Admins and the Owner change them.
import { HttpError, ulid, nowIso, audit, cleanPhone } from "./util.js";
import { requireRole, rank } from "./auth.js";

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
  emails: d => ({ kind: "emails", d }),
  phones: d => ({ kind: "phones", d }),
  days: d => ({ kind: "days", d }),
  perCat: (inner, d) => ({ kind: "perCat", inner, d }),
};
export const SCHEMA = {
  business: { name: f.text("Town & Country Cleaners") },
  day: { workDays: f.days([1, 2, 3, 4, 5]), defStart: f.time("07:00"), breakMin: f.int(30, 0, 120), breakAfter: f.num(4, 0, 12) },
  money: { payAvg: f.num(15, 0, 200), laborTarget: f.num(17, 0, 100), pdfMoney: f.bool(false),
    prices: f.perCat(f.num(0, 0, 1000), { dct: 7.5, dcb: 8, slt: 4.15, slb: 7.25, comf: 30, tc: 12 }) },
  route: { dayBefore: f.bool(true) },
  // the most pieces a department should have due in a day (0 = no limit) and who gets a text as the next work day nears it (Neal, Oct 30)
  limits: { maxDcb: f.int(0, 0, 100000), maxDct: f.int(0, 0, 100000), maxSlb: f.int(0, 0, 100000), maxSlt: f.int(0, 0, 100000), alertPct: f.int(15, 0, 100), phones: f.phones([]) },
  alerts: { warnFirst: f.int(45, 0, 240), warnSecond: f.int(15, 0, 240), notify: f.bool(true), weekStart: f.int(1, 0, 6) },
  smrt: { overdue: f.bool(true), transitRack: f.text("Van", 40),
    departments: f.perCat(f.text("", 200), { dct: "Dry Cleaning Tops", dcb: "Dry Cleaning Bottoms", slt: "Laundry Tops", slb: "Laundry Bottoms", comf: "", tc: "" }),
    itemTypes: f.perCat(f.text("", 200), { dct: "", dcb: "", slt: "", slb: "", comf: "Z-SS*", tc: "Tablecloth, Table Cloth" }),
    // item types worked at the Laundry Hub, left out of the planner unless a kind of work above claims them (Neal, Oct 23)
    hubTypes: f.text("Bedspread, Comforter", 200) },
  rippling: { departments: f.list(["Production"]) },
  // the end-of-day email: today against the plan, and the next work day
  summary: { on: f.bool(true), to: f.emails(["neal@towncountryclean.com"]), at: f.time("18:10") },
  // station tablets at the starch bottoms presses (Neal, Oct 14): the station goal, and a photo with each count;
  // startDelay (Oct 21): the press counts as started this many minutes after the first person planned on it clocks in
  tally: { goal: f.num(20, 1, 200), startDelay: f.int(10, 0, 60), photos: f.bool(true), keepDays: f.int(30, 1, 365) },
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
    case "emails": {
      if (!Array.isArray(v) || v.some(x => typeof x !== "string")) throw new HttpError(400, `${where}: must be a list of email addresses.`);
      const list = [...new Set(v.map(x => x.trim().toLowerCase()).filter(Boolean))];
      const bad = list.find(x => !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(x));
      if (bad) throw new HttpError(400, `"${bad}" isn't an email address.`);
      if (list.length > 10) throw new HttpError(400, "Up to 10 addresses.");
      return list;
    }
    case "phones": {
      if (!Array.isArray(v) || v.some(x => typeof x !== "string")) throw new HttpError(400, `${where}: must be a list of phone numbers.`);
      const list = v.map(x => { try { return cleanPhone(x); } catch { throw new HttpError(400, `"${x}" isn't a 10-digit mobile number. Separate numbers with commas.`); } }).filter(Boolean);
      if (new Set(list).size > 10) throw new HttpError(400, "Up to 10 numbers.");
      return [...new Set(list)];
    }
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
  // only what's in SCHEMA: values saved for settings since removed are left out
  const known = g => Object.fromEntries(Object.entries(saved[g] || {}).filter(([k]) => SCHEMA[g][k]));
  if (saved.limits?.phone && !saved.limits.phones) saved.limits.phones = [saved.limits.phone];   // saved when there was one number
  return Object.fromEntries(Object.keys(SCHEMA).map(g => [g, { ...defaults(g), ...known(g) }]));
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

// ---------------- production setup: categories, stations, speeds ----------------
export async function loadProduction(db, orgId) {
  const q = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
  const categories = await q("SELECT id, name, color, needs_assembly AS needsAssembly, sort FROM plan_categories ORDER BY sort");
  const stationTypes = await q("SELECT id, name FROM plan_station_types");
  const stations = await q(`SELECT s.id, s.code, s.label, s.station_type_id AS type, s.training_id AS training, s.is_active AS active, s.sort
      FROM plan_stations s JOIN core_locations l ON l.id = s.location_id WHERE l.org_id = ? AND s.deleted_at IS NULL ORDER BY s.sort`, orgId);
  const rates = await q("SELECT station_type_id AS type, category_id AS category, pieces_per_hour AS perHour FROM plan_station_rates WHERE deleted_at IS NULL");
  return { categories: categories.map(c => ({ ...c, needsAssembly: !!c.needsAssembly })), stationTypes, stations: stations.map(s => ({ ...s, active: !!s.active })), rates };
}

const posNum = (v, what, max = 10000) => {
  const n = +v;
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new HttpError(400, `${what} must be a number above 0.`);
  return n;
};

/** Statements that save the production setup. */
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
  for (const c of body.categories || []) {
    if (!catIds.has(c.id)) throw new HttpError(400, `Unknown category ${c.id}.`);
    stmts.push(db.prepare("UPDATE plan_categories SET needs_assembly=? WHERE id=?").bind(c.needsAssembly ? 1 : 0, c.id));
  }
  const stationIds = new Map(known.stations.map(s => [s.code, s.id]));
  for (const s of body.stations || []) {
    const id = stationIds.get(s.code);
    if (!id) throw new HttpError(400, `Unknown station ${s.code}.`);
    const label = s.label !== undefined ? String(s.label).trim().slice(0, 40) : null;
    if (label === "") throw new HttpError(400, "A station needs a name.");
    stmts.push(db.prepare(`UPDATE plan_stations SET is_active=COALESCE(?, is_active), label=COALESCE(?, label), updated_at=?, updated_by=?, rev=rev+1 WHERE id=?`)
      .bind(s.active === undefined ? null : s.active ? 1 : 0, label, now, userId, id));
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

// The order of the station rows on the Plan (Neal, Oct 13: "configurable which station is on top").
// Only the screen order: the engine's station order (stations.sort) isn't touched. Managers change it.
export const BOARD_KEYS = ["slb", "slt", "dct", "dcb", "tc", "comf", "asm", "ops"];
async function loadBoardOrder(db, orgId) {
  const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='planner' AND key='board_order' AND deleted_at IS NULL").bind(orgId).first();
  const saved = r ? JSON.parse(r.value_json) : [];
  const list = (Array.isArray(saved) ? saved : []).filter(k => BOARD_KEYS.includes(k));
  return [...new Set([...list, ...BOARD_KEYS])];
}
export async function saveBoardOrder(db, env, me, body) {
  requireRole(me, "manager");
  const list = body && Array.isArray(body.order) ? body.order : null;
  if (!list || list.some(k => !BOARD_KEYS.includes(k))) throw new HttpError(400, "Send the stations in order.");
  const order = [...new Set([...list, ...BOARD_KEYS])];
  await putGroupStmt(db, env.ORG_ID, "board_order", order, me.id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_settings", entityId: "planner.board_order", action: "update", changes: { order } });
  return order;
}

export async function allSettings(db, env, me = null) {
  const [groups, production, runs, boardOrder] = await Promise.all([loadGroups(db, env.ORG_ID), loadProduction(db, env.ORG_ID), loadRuns(db, env.ORG_ID), loadBoardOrder(db, env.ORG_ID)]);
  const admin = me && rank(me.role) >= rank("admin");
  if (me && !admin) groups.limits.phones = [];   // people's mobile numbers: Admins and the Owner only
  return { groups, ...production, runs, boardOrder, ...(admin ? { status: await adminStatus(db, env) } : {}) };
}

/** For the Settings screen (Admins): what Rippling last sent (and whether it carries pay rates), and the last summary email. */
async function adminStatus(db, env) {
  const get = async (app, key) => { const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id=? AND key=?").bind(env.ORG_ID, app, key).first(); return r ? JSON.parse(r.value_json) : null; };
  const last = await get("core", "rippling_last");
  const dep = await db.prepare("SELECT id FROM core_departments WHERE org_id=? AND name='Production'").bind(env.ORG_ID).first();
  const r = dep ? await db.prepare(`SELECT COUNT(*) AS people, SUM(CASE WHEN EXISTS (SELECT 1 FROM labor_pay_rates r WHERE r.person_id=p.id AND r.deleted_at IS NULL) THEN 1 ELSE 0 END) AS withRate
      FROM core_people p WHERE p.org_id=? AND p.department_id=? AND p.status='active' AND p.deleted_at IS NULL`).bind(env.ORG_ID, dep.id).first() : null;
  return { rippling: last ? { at: last.at, rows: last.rows, rateColumn: last.rateColumn || null } : null, payRates: { people: r?.people || 0, withRate: r?.withRate || 0 },
    summary: await get("planner", "summary_last"), summaryTest: await get("planner", "summary_test"), emailReady: !!env.SEND_EMAIL,
    limits: await get("planner", "limits_last"), textsReady: !!env.TEXTS };
}
