// Rippling hours. Rippling emails the scheduled "All Time Clock Entries Export" (a CSV) to reports@netexcleaners.com;
// Cloudflare Email Routing hands the message to this Worker.
//   - Only rows in the planner's Rippling departments (Settings > Rippling; "Production" by default) are used.
//   - People are matched by Rippling employee number (core_people.payroll_id). Someone new in Production is added to
//     the team (with no trainings yet) so their hours aren't lost.
//   - Finished days go into labor_daily_hours (one row per person per day: hours, first in, last out).
//   - Today's punches replace labor_clock_today, so the planner can see who's in right now.
// Clock punches themselves are not kept after the day is added up (Neal, Oct 10).
import { ulid, nowIso } from "./util.js";

export const RIPPLING_COLUMNS = ["time_entry_id", "employee_name", "employee_number", "department_path", "time_entry_date", "clock_in_local", "clock_out_local", "duration_hours"];

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

/**
 * Stores one Rippling export.
 * @returns {{ rows, used, days, people, added: string[], today: number, skipped: number }}
 */
export async function ingestRippling(db, { orgId, integrationId, today, csv }) {
  const rows = parseCsv(csv);
  if (!rows.length) return { rows: 0, used: 0, days: 0, people: 0, added: [], today: 0, skipped: 0 };
  const miss = RIPPLING_COLUMNS.filter(c => !(c in rows[0]));
  if (miss.length) throw new Error(`Rippling export is missing ${miss.join(", ")}`);
  const { departments } = await plannerSettings(db, orgId);
  const inDept = r => { const d = (r.department_path || "").toLowerCase(); return departments.some(x => d === x || d.endsWith("/" + x) || d.split(/\s*[>/]\s*/).includes(x)); };

  const dep = await db.prepare("SELECT id FROM core_departments WHERE org_id=? AND name='Production'").bind(orgId).first();
  const loc = await db.prepare("SELECT id FROM core_locations WHERE org_id=? AND kind='plant' ORDER BY created_at LIMIT 1").bind(orgId).first();
  if (!dep) throw new Error("Production department missing");
  const people = new Map((await db.prepare("SELECT id, payroll_id FROM core_people WHERE org_id=? AND payroll_id IS NOT NULL").bind(orgId).all()).results.map(p => [String(p.payroll_id), p.id]));

  const runId = ulid(), now = nowIso(), stmts = [], added = [];
  stmts.push(db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status,message) VALUES(?,?,?,?,?)").bind(runId, integrationId, now, "running", "rippling email"));
  const personFor = r => {
    const no = String(r.employee_number || "").trim(); if (!no) return null;
    let id = people.get(no); if (id) return id;
    id = ulid(); people.set(no, id);
    const parts = String(r.employee_name || "").trim().split(/\s+/);
    stmts.push(db.prepare("INSERT INTO core_people(id, org_id, department_id, home_location_id, first_name, last_name, payroll_id, status) VALUES(?,?,?,?,?,?,?, 'active')")
      .bind(id, orgId, dep.id, loc ? loc.id : null, parts[0] || "?", parts.slice(1).join(" "), no));
    added.push(r.employee_name || no);
    return id;
  };

  // add up finished days per person; collect today's punches
  const daily = new Map(); const todayRows = []; let used = 0, skipped = 0;
  for (const r of rows) {
    if (!inDept(r)) { skipped++; continue; }
    const day = ripDay(r.time_entry_date), cin = ripTime(r.clock_in_local), cout = ripTime(r.clock_out_local);
    if (!day || !cin) { skipped++; continue; }
    const pid = personFor(r); if (!pid) { skipped++; continue; }
    used++;
    if (day === today) { todayRows.push({ pid, id: r.time_entry_id, cin, cout }); continue; }
    if (day > today) { skipped++; continue; }
    const k = `${pid}|${day}`, d = daily.get(k) || { pid, day, hours: 0, first: null, last: null, open: false };
    d.hours += Number.parseFloat(r.duration_hours) || 0;
    if (!d.first || cin.hm < d.first) d.first = cin.hm;
    if (!cout) d.open = true; else if (!d.last || cout.hm > d.last) d.last = cout.hm;
    daily.set(k, d);
  }
  for (const d of daily.values()) {
    stmts.push(db.prepare(`INSERT INTO labor_daily_hours(person_id, work_date, department_id, location_id, hours, first_in, last_out, sync_run_id) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(person_id, work_date, department_id) DO UPDATE SET hours=excluded.hours, first_in=excluded.first_in, last_out=excluded.last_out,
        sync_run_id=excluded.sync_run_id, updated_at=?, rev=rev+1`)
      .bind(d.pid, d.day, dep.id, loc ? loc.id : null, Math.round(d.hours * 100) / 100, d.first, d.open ? null : d.last, runId, now));
  }
  // today's punches: replace the whole table (yesterday's are added up above)
  stmts.push(db.prepare("DELETE FROM labor_clock_today WHERE person_id IN (SELECT id FROM core_people WHERE org_id=?)").bind(orgId));
  for (const t of todayRows) {
    stmts.push(db.prepare("INSERT INTO labor_clock_today(id, person_id, department_id, clock_in, clock_out, payroll_entry_id, sync_run_id) VALUES(?,?,?,?,?,?,?)")
      .bind(ulid(), t.pid, dep.id, t.cin.iso, t.cout ? t.cout.iso : null, t.id || null, runId));
  }
  stmts.push(db.prepare("UPDATE int_sync_runs SET finished_at=?, status='ok', rows_read=?, rows_changed=?, message=? WHERE id=?")
    .bind(nowIso(), rows.length, daily.size + todayRows.length,
      `rippling: ${used} entries, ${daily.size} person-days, ${todayRows.length} punches today${added.length ? `; added ${added.join(", ")}` : ""}`, runId));
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  return { rows: rows.length, used, days: daily.size, people: new Set([...daily.values()].map(d => d.pid)).size, added, today: todayRows.length, skipped };
}
