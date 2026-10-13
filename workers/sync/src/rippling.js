// Rippling hours. Rippling emails the scheduled "All Time Clock Entries Export" (a CSV) to reports@netexcleaners.com;
// Cloudflare Email Routing hands the message to this Worker.
//   - Every department is kept (Oct 11, for the Retail Snapshot). Rows in the planner's Rippling departments
//     (Settings > Rippling; "Production" by default) go to the Production department; others (Retail, Laundry Hub ...)
//     to a department of the same name, created on first sight.
//   - Each row's work_location becomes a location ("TCC SS Retail" -> Sulphur Springs, "TCC SS Workshop" -> Workshop,
//     "TCC Laundry Hub" -> Laundry Hub). Overrides: core_settings core/rippling_locations {"<Rippling name>": "<location>"}.
//   - People are matched by Rippling employee number (core_people.payroll_id). Someone new is added in their department.
//   - Finished days go into labor_daily_hours (one row per person, day, department and location).
//   - Today's punches replace labor_clock_today, so the apps can see who's in right now.
//     What changed since the last report (new punch, clock-out, edit, removal) is kept in labor_punch_log.
//   - If the export has a pay rate column (pay_rate, hourly_rate, ...), the rate goes into labor_pay_rates.
// Clock punches themselves are not kept after the day is added up (Neal, Oct 10).
import { ulid, nowIso, sha1 } from "./util.js";

export const RIPPLING_COLUMNS = ["time_entry_id", "employee_name", "employee_number", "department_path", "time_entry_date", "clock_in_local", "clock_out_local", "duration_hours"];
const RATE_COLUMNS = ["pay_rate", "hourly_rate", "hourly_pay_rate", "base_pay_rate", "pay_rate_amount", "rate", "hourly_pay", "compensation_rate", "wage", "hourly_wage"];
const MAX_HOURLY = 200;   // a bigger number is a salary or a typo, not an hourly rate

/** Small CSV parser: quotes, escaped quotes, commas and newlines inside quotes, CRLF, BOM. */
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some(x => x !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const TZ = { CDT: "-05:00", CST: "-06:00", EDT: "-04:00", EST: "-05:00", MDT: "-06:00", MST: "-07:00", PDT: "-07:00", PST: "-08:00" };
/** "09/08/2026 03:50 AM CDT" -> { day: "2026-09-08", hm: "03:50", iso: "2026-09-08T03:50:00-05:00" } */
export function ripTime(v) {
  const m = String(v || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s*([A-Z]{2,4})?$/i);
  if (!m) return null;
  let h = +m[4]; const ap = (m[6] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0;
  const day = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`, hm = `${String(h).padStart(2, "0")}:${m[5]}`;
  return { day, hm, iso: `${day}T${hm}:00${TZ[(m[7] || "").toUpperCase()] || ""}` };
}
const ripDay = v => { const m = String(v || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };

async function plannerSettings(db, orgId) {
  const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='planner' AND key='rippling'").bind(orgId).first();
  const s = r ? JSON.parse(r.value_json) : {};
  return { departments: (Array.isArray(s.departments) && s.departments.length ? s.departments : ["Production"]).map(d => d.toLowerCase()) };
}
async function locationOverrides(db, orgId) {
  const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='rippling_locations'").bind(orgId).first();
  const o = r ? JSON.parse(r.value_json) : {};
  return new Map(Object.entries(o && typeof o === "object" ? o : {}).map(([k, v]) => [k.trim().toLowerCase(), String(v).trim()]));
}

/** Rippling work location -> our location name. "TCC SS Retail" -> "Sulphur Springs", "TCC SS Workshop" -> "Workshop". */
export function locationName(raw, overrides = new Map()) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const o = overrides.get(s.toLowerCase()); if (o) return o;
  if (/workshop|plant/i.test(s)) return "Workshop";
  let n = s.replace(/^TCC\s+/i, "").replace(/\s+(retail|store|counter|drop store)$/i, "").trim();
  if (/^ss$/i.test(n)) n = "Sulphur Springs";
  return n || null;
}
const plantLike = name => /workshop|hub|plant/i.test(name);

/** "$15.50", "15.5", "15.50 USD / hour" -> 1550 cents. Blank, salaries and nonsense -> null. */
export function rateCents(v) {
  const m = String(v ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = +m[0];
  if (!(n > 0) || n > MAX_HOURLY) return null;
  return Math.round(n * 100);
}

/**
 * Stores one Rippling export.
 * @param keepToday  true for a hand import of an older file: leave today's punches alone
 * @returns {{ rows, used, days, people, added: string[], today: number, skipped: number, departments: object, rates: number }}
 */
export async function ingestRippling(db, { orgId, integrationId, today, csv, keepToday = false }) {
  // Rippling can send the same export many times; an identical file on the same day changes nothing, so skip it
  const hash = await sha1(`${today}|${csv}`);
  const last = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='rippling_last'").bind(orgId).first();
  if (!keepToday && last && JSON.parse(last.value_json).hash === hash) {
    // same report as last time: nothing changed, but the time clock is now known to be current as of this report
    await db.prepare("UPDATE core_settings SET value_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id=? AND app_id='core' AND key='rippling_last'")
      .bind(JSON.stringify({ ...JSON.parse(last.value_json), at: nowIso() }), orgId).run();
    return { duplicate: true, rows: 0, used: 0, days: 0, people: 0, added: [], today: 0, skipped: 0, departments: {}, rates: 0 };
  }
  const rows = parseCsv(csv);
  if (!rows.length) return { rows: 0, used: 0, days: 0, people: 0, added: [], today: 0, skipped: 0, departments: {}, rates: 0 };
  const miss = RIPPLING_COLUMNS.filter(c => !(c in rows[0]));
  if (miss.length) throw new Error(`Rippling export is missing ${miss.join(", ")}`);
  const keyOf = h => h.trim().toLowerCase().replace(/[\s\-]+/g, "_");
  // the pay rate column: a known name first, else any "...rate..." / "...wage..." column whose values look like hourly pay
  const looksLikePay = h => { const v = rows.map(r => r[h]).filter(x => x !== "").slice(0, 20); return v.length > 0 && v.filter(x => rateCents(x) != null).length >= v.length * 0.8; };
  const rateCol = Object.keys(rows[0]).find(h => RATE_COLUMNS.includes(keyOf(h)))
    || Object.keys(rows[0]).find(h => /rate|wage/.test(keyOf(h)) && !/date|period|type|overtime|^ot_|double|bonus|tax/.test(keyOf(h)) && looksLikePay(h));

  const { departments: prodDepts } = await plannerSettings(db, orgId);
  const isProduction = r => { const d = (r.department_path || "").toLowerCase(); return prodDepts.some(x => d === x || d.endsWith("/" + x) || d.split(/\s*[>/]\s*/).includes(x)); };
  const overrides = await locationOverrides(db, orgId);

  const prod = await db.prepare("SELECT id FROM core_departments WHERE org_id=? AND name='Production'").bind(orgId).first();
  const plant = await db.prepare("SELECT id FROM core_locations WHERE org_id=? AND kind='plant' ORDER BY created_at LIMIT 1").bind(orgId).first();
  if (!prod) throw new Error("Production department missing");
  const people = new Map((await db.prepare("SELECT id, payroll_id, home_location_id FROM core_people WHERE org_id=? AND payroll_id IS NOT NULL").bind(orgId).all()).results.map(p => [String(p.payroll_id), p]));
  const depts = new Map((await db.prepare("SELECT id, name, payroll_name FROM core_departments WHERE org_id=? AND deleted_at IS NULL").bind(orgId).all()).results
    .flatMap(d => [[d.name.toLowerCase(), d.id], ...(d.payroll_name ? [[d.payroll_name.toLowerCase(), d.id]] : [])]));
  const locs = new Map((await db.prepare("SELECT id, name FROM core_locations WHERE org_id=?").bind(orgId).all()).results.map(l => [l.name.toLowerCase(), l.id]));
  const rates = new Map((await db.prepare(`SELECT r.person_id AS pid, r.hourly_cents AS c FROM labor_pay_rates r JOIN core_people p ON p.id=r.person_id
      WHERE p.org_id=? AND r.deleted_at IS NULL ORDER BY r.effective_on`).bind(orgId).all()).results.map(r => [r.pid, r.c])); // latest wins

  const runId = ulid(), now = nowIso(), stmts = [], added = [];
  stmts.push(db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status,message) VALUES(?,?,?,?,?)").bind(runId, integrationId, now, "running", keepToday ? "rippling import" : "rippling email"));

  const departmentFor = r => {
    if (isProduction(r)) return prod.id;
    const path = String(r.department_path || "").trim() || "Other";
    const name = path.split(/\s*[>/]\s*/).pop() || path;
    let id = depts.get(path.toLowerCase()) || depts.get(name.toLowerCase());
    if (id) return id;
    id = ulid(); depts.set(path.toLowerCase(), id); depts.set(name.toLowerCase(), id);
    stmts.push(db.prepare("INSERT INTO core_departments(id, org_id, name, payroll_name) VALUES(?,?,?,?)").bind(id, orgId, name, path));
    return id;
  };
  const locationFor = (r, depId, person) => {
    const name = locationName(r.work_location, overrides);
    if (!name) return (person && person.home_location_id) || (plant ? plant.id : null);
    let id = locs.get(name.toLowerCase()); if (id) return id;
    id = ulid(); locs.set(name.toLowerCase(), id);
    stmts.push(db.prepare("INSERT INTO core_locations(id, org_id, name, kind, pos_name) VALUES(?,?,?,?,NULL)").bind(id, orgId, name, plantLike(name) ? "plant" : "store"));
    return id;
  };
  const personFor = (r, depId) => {
    const no = String(r.employee_number || "").trim(); if (!no) return null;
    let p = people.get(no); if (p) return p;
    p = { id: ulid(), payroll_id: no, home_location_id: null }; people.set(no, p);
    p.home_location_id = locationFor(r, depId, null);
    const parts = String(r.employee_name || "").trim().split(/\s+/);
    stmts.push(db.prepare("INSERT INTO core_people(id, org_id, department_id, home_location_id, first_name, last_name, payroll_id, status) VALUES(?,?,?,?,?,?,?, 'active')")
      .bind(p.id, orgId, depId, p.home_location_id, parts[0] || "?", parts.slice(1).join(" "), no));
    added.push(r.employee_name || no);
    return p;
  };

  // add up finished days per person, department and location; collect today's punches and pay rates
  const daily = new Map(); const todayRows = []; const byDept = {}; const seenRate = new Map(); let used = 0, skipped = 0;
  for (const r of rows) {
    const day = ripDay(r.time_entry_date), cin = ripTime(r.clock_in_local), cout = ripTime(r.clock_out_local);
    if (!day || !cin) { skipped++; continue; }
    const depId = departmentFor(r);
    const person = personFor(r, depId); if (!person) { skipped++; continue; }
    const locId = locationFor(r, depId, person);
    if (!locId) { skipped++; continue; }
    used++;
    const dn = String(r.department_path || "Other").trim(); byDept[dn] = (byDept[dn] || 0) + 1;
    if (rateCol) { const c = rateCents(r[rateCol]); if (c) { const s = seenRate.get(person.id); if (!s || day < s.day) seenRate.set(person.id, { c, day }); } }
    if (day === today) { todayRows.push({ pid: person.id, depId, locId, id: r.time_entry_id, cin, cout }); continue; }
    if (day > today) { skipped++; continue; }
    const k = `${person.id}|${day}|${depId}|${locId}`, d = daily.get(k) || { pid: person.id, day, depId, locId, hours: 0, first: null, last: null, open: false };
    d.hours += Number.parseFloat(r.duration_hours) || 0;
    if (!d.first || cin.hm < d.first) d.first = cin.hm;
    if (!cout) d.open = true; else if (!d.last || cout.hm > d.last) d.last = cout.hm;
    daily.set(k, d);
  }
  for (const d of daily.values()) {
    stmts.push(db.prepare(`INSERT INTO labor_daily_hours(person_id, work_date, department_id, location_id, hours, first_in, last_out, sync_run_id) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(person_id, work_date, department_id, location_id) DO UPDATE SET hours=excluded.hours, first_in=excluded.first_in, last_out=excluded.last_out,
        sync_run_id=excluded.sync_run_id, updated_at=?, rev=rev+1`)
      .bind(d.pid, d.day, d.depId, d.locId, Math.round(d.hours * 100) / 100, d.first, d.open ? null : d.last, runId, now));
  }
  // pay rates: a new rate applies from the person's first day in this export (first time) or from today (a change)
  let rateChanges = 0;
  for (const [pid, { c, day }] of seenRate) {
    const had = rates.get(pid);
    if (had === c) continue;
    const from = had == null ? day : today;
    stmts.push(db.prepare(`INSERT INTO labor_pay_rates(id, person_id, effective_on, hourly_cents) VALUES(?,?,?,?)
      ON CONFLICT(person_id, effective_on) DO UPDATE SET hourly_cents=excluded.hourly_cents, updated_at=?, rev=rev+1`).bind(ulid(), pid, from, c, now));
    rateChanges++;
  }
  // today's punches: replace the whole table (yesterday's are added up above)
  if (!keepToday) {
    stmts.push(db.prepare("DELETE FROM labor_clock_today WHERE person_id IN (SELECT id FROM core_people WHERE org_id=?)").bind(orgId));
    for (const t of todayRows) {
      stmts.push(db.prepare("INSERT INTO labor_clock_today(id, person_id, department_id, location_id, clock_in, clock_out, payroll_entry_id, sync_run_id) VALUES(?,?,?,?,?,?,?,?)")
        .bind(ulid(), t.pid, t.depId, t.locId, t.cin.iso, t.cout ? t.cout.iso : null, t.id || null, runId));
    }
  }
  stmts.push(db.prepare("UPDATE int_sync_runs SET finished_at=?, status='ok', rows_read=?, rows_changed=?, message=? WHERE id=?")
    .bind(nowIso(), rows.length, daily.size + todayRows.length,
      `rippling: ${used} entries, ${daily.size} person-days, ${keepToday ? "today left alone" : `${todayRows.length} punches today`}${rateChanges ? `, ${rateChanges} pay rates` : ""}${added.length ? `; added ${added.join(", ")}` : ""}`, runId));
  if (!keepToday) stmts.push(db.prepare(`INSERT INTO core_settings(org_id,app_id,key,value_json) VALUES(?, 'core', 'rippling_last', ?)
    ON CONFLICT(org_id,app_id,key) DO UPDATE SET value_json=excluded.value_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), rev=rev+1`)
    .bind(orgId, JSON.stringify({ hash, at: nowIso(), rows: rows.length, rateColumn: rateCol || null })));
  // what changed in today's punches since the last report (kept: the table above is replaced each time)
  let punchLog = [];
  if (!keepToday) punchLog = await punchChanges(db, orgId, today, todayRows, runId, now);
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  if (punchLog.length) {
    try { for (let i = 0; i < punchLog.length; i += 90) await db.batch(punchLog.slice(i, i + 90)); }
    catch (e) { console.log(JSON.stringify({ job: "rippling-punch-log", status: "error", error: String(e.message || e) })); }
  }
  return { punchChanges: punchLog.length, rows: rows.length, used, days: daily.size, people: new Set([...daily.values()].map(d => d.pid)).size, added, today: keepToday ? 0 : todayRows.length, skipped, departments: byDept, rates: rateChanges, rateColumn: rateCol || null };
}

/**
 * Compares today's punches in the new report with the ones stored from the last report and returns the inserts for
 * labor_punch_log: 'in' (a new punch), 'out' (a clock-out added), 'changed' (times edited in Rippling), 'removed'
 * (the punch is gone from the report). Matched by Rippling's time_entry_id (or person + clock-in when it has none).
 */
export async function punchChanges(db, orgId, today, todayRows, runId, now) {
  let before = [];
  try {
    before = (await db.prepare(`SELECT c.person_id AS pid, c.department_id AS depId, c.clock_in AS cin, c.clock_out AS cout, c.payroll_entry_id AS eid
        FROM labor_clock_today c JOIN core_people p ON p.id=c.person_id WHERE p.org_id=? AND substr(c.clock_in,1,10)=?`).bind(orgId, today).all()).results;
  } catch { return []; }
  const keyOf = (eid, pid, cin) => eid ? `e:${eid}` : `p:${pid}|${cin}`;
  const old = new Map(before.map(b => [keyOf(b.eid, b.pid, b.cin), b]));
  const out = [], add = (pid, depId, eid, change, cin, cout, wasIn = null, wasOut = null) => out.push(db.prepare(
    `INSERT INTO labor_punch_log(id, org_id, person_id, day, department_id, payroll_entry_id, change, clock_in, clock_out, was_in, was_out, seen_at, sync_run_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ulid(), orgId, pid, today, depId || null, eid || null, change, cin, cout, wasIn, wasOut, now, runId));
  const seen = new Set();
  for (const t of todayRows) {
    const cin = t.cin.iso, cout = t.cout ? t.cout.iso : null, k = keyOf(t.id, t.pid, cin);
    seen.add(k);
    const b = old.get(k);
    if (!b) { add(t.pid, t.depId, t.id, "in", cin, null); if (cout) add(t.pid, t.depId, t.id, "out", cin, cout); continue; }
    if (b.cin !== cin || (b.cout && cout && b.cout !== cout) || (b.cout && !cout)) add(t.pid, t.depId, t.id, "changed", cin, cout, b.cin, b.cout);
    else if (!b.cout && cout) add(t.pid, t.depId, t.id, "out", cin, cout);
  }
  for (const [k, b] of old) if (!seen.has(k)) add(b.pid, b.depId, b.eid, "removed", b.cin, b.cout);
  return out;
}
