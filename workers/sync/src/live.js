// Live SMRT sync on work days: keeps orders and pieces current so the planner can count what's due,
// what's done and what's late. Every run re-reads:
//   - everything created in the last LIVE_RECENT_DAYS days (new orders, new pieces, today's assembly), and
//   - each older created day that still has an open order due soon or overdue (up to 14 days back).
// Once a day (the first run) it also re-reads every created day in the last 45 days that has any open order,
// so older special orders (alterations, repairs) stay current.
// The daily full run also re-reads the orders report alone for the last PAYMENT_LOOKBACK_DAYS (in 15-day calls), so payments made
// after pickup (statements, AutoPay) reach the Retail Snapshot's revenue numbers.
// SMRT calls per run: 2 column calls + 1 orders call + 3 items calls + 2 per older day range (~8); +4 orders calls once a day.
// Unchanged rows aren't rewritten.
import { REPORT_ORDERS, REPORT_ITEMS } from "./smrt.js";
import { ingestDay, Lookups, refreshPayments, PAYMENT_LOOKBACK_DAYS } from "./ingest.js";
import { ulid, nowIso, addDays } from "./util.js";

export const LIVE_RECENT_DAYS = 7;
const ITEMS_DAYS_PER_CALL = 3;      // ~1,100 pieces a day; SMRT caps a call at 5,000 rows (bigger answers are split automatically)
const OPEN_LOOKBACK_DAYS = 45;
const OVERDUE_DAYS = 14;
const PAYMENT_DAYS_PER_CALL = 15;  // ~231 orders a day -> ~3,500 rows per call
const SOON_DAYS = 4;               // due by then counts as "soon" (covers a weekend before the next work day)

async function getState(db, orgId) {
  const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='smrt_live'").bind(orgId).first();
  return r ? JSON.parse(r.value_json) : {};
}
async function putState(db, orgId, s) {
  await db.prepare(`INSERT INTO core_settings(org_id,app_id,key,value_json) VALUES(?, 'core', 'smrt_live', ?)
    ON CONFLICT(org_id,app_id,key) DO UPDATE SET value_json=excluded.value_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), rev=rev+1`).bind(orgId, JSON.stringify(s)).run();
}

/** Created days (before `before`) that still hold an open order; with dueFrom/dueTo, only orders due in that span. */
export async function openCreatedDays(db, orgId, { since, before, dueFrom, dueTo }) {
  const r = await db.prepare(`SELECT DISTINCT substr(o.smrt_created_at, 1, 10) AS day FROM pos_orders o JOIN pos_order_statuses s ON s.id = o.status_id
      WHERE o.org_id=? AND s.is_done=0 AND s.is_closed=0 AND s.is_void=0
        AND o.ready_at IS NULL AND o.returned_at IS NULL AND o.picked_up_at IS NULL AND o.delivered_at IS NULL AND o.smrt_deleted_at IS NULL
        AND substr(o.smrt_created_at, 1, 10) >= ? AND substr(o.smrt_created_at, 1, 10) < ?
        ${dueFrom ? "AND substr(o.due_at, 1, 10) BETWEEN ? AND ?" : ""}
      ORDER BY 1`).bind(orgId, since, before, ...(dueFrom ? [dueFrom, dueTo] : [])).all();
  return r.results.map(x => x.day).filter(Boolean);
}

/** Groups days into [from, to) ranges of consecutive days, at most `max` days each. */
export function dayRanges(days, max) {
  const out = [];
  for (const d of [...new Set(days)].sort()) {
    const cur = out[out.length - 1];
    if (cur && cur[1] === d && Math.round((Date.parse(cur[1]) - Date.parse(cur[0])) / 864e5) < max) cur[1] = addDays(d, 1);
    else out.push([d, addDays(d, 1)]);
  }
  return out;
}

/** An SMRT run started in the last few minutes that hasn't finished (a run that crashed stops counting after BUSY_MIN). */
const BUSY_MIN = 4;
export async function runningSync(db, integrationId, { onlyChecks = false, now = Date.now() } = {}) {
  const since = new Date(now - BUSY_MIN * 60e3).toISOString();
  return db.prepare(`SELECT id, started_at, message FROM int_sync_runs WHERE integration_id=? AND status='running' AND started_at>=?
      ${onlyChecks ? "AND message LIKE 'check now%'" : ""} ORDER BY started_at DESC LIMIT 1`).bind(integrationId, since).first();
}

export async function runLive(db, smrt, { orgId, integrationId, today, reports = {} }) {
  // a "Check now" (Shuttle status) is reading SMRT right now: skip this round rather than write the same pieces twice
  const busy = await runningSync(db, integrationId, { onlyChecks: true });
  if (busy) return { status: "skipped", reason: "a Check now is running", calls: 0 };
  const state = await getState(db, orgId);
  const full = state.fullDay !== today;
  const recentFrom = addDays(today, -(LIVE_RECENT_DAYS - 1)), end = addDays(today, 1);
  const older = full
    ? await openCreatedDays(db, orgId, { since: addDays(today, -OPEN_LOOKBACK_DAYS), before: recentFrom })
    : await openCreatedDays(db, orgId, { since: addDays(today, -OPEN_LOOKBACK_DAYS), before: recentFrom, dueFrom: addDays(today, -OVERDUE_DAYS), dueTo: addDays(today, SOON_DAYS) });

  const runId = ulid();
  await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status,message) VALUES(?,?,?,?,?)").bind(runId, integrationId, nowIso(), "running", "live").run();
  const ctx = { orgId, runId, mode: "live", lookups: await new Lookups(db, orgId).load() };
  const ordersId = reports.orders || REPORT_ORDERS, itemsId = reports.items || REPORT_ITEMS;
  const totals = { orders: 0, items: 0, ordersWritten: 0, itemsWritten: 0, changes: 0, followups: 0 };
  let error = null;
  try {
    // recent days: one orders call for the week, items two days at a time; then the older days with open orders
    const groups = [{ orders: [[recentFrom, end]], items: dayRanges(Array.from({ length: LIVE_RECENT_DAYS }, (_, i) => addDays(recentFrom, i)), ITEMS_DAYS_PER_CALL) }];
    for (const r of dayRanges(older, ITEMS_DAYS_PER_CALL)) groups.push({ orders: [r], items: [r] });
    for (const g of groups) {
      const orders = [], items = [];
      for (const [a, b] of g.orders) orders.push(...(await smrt.rangeObjects(ordersId, a, b)));
      for (const [a, b] of g.items) items.push(...(await smrt.rangeObjects(itemsId, a, b)));
      ctx.day = g.orders[0][0];
      const st = await ingestDay(db, ctx, orders, items);
      for (const k in totals) totals[k] += st[k] || 0;
    }
    // once a day: payments on orders that are otherwise finished
    if (full) {
      const ranges = dayRanges(Array.from({ length: PAYMENT_LOOKBACK_DAYS - LIVE_RECENT_DAYS }, (_, i) => addDays(today, -PAYMENT_LOOKBACK_DAYS + 1 + i)), PAYMENT_DAYS_PER_CALL);
      for (const [a, b] of ranges) {
        const p = await refreshPayments(db, ctx, await smrt.rangeObjects(ordersId, a, b));
        totals.paymentsChanged = (totals.paymentsChanged || 0) + p.changed;
      }
    }
  } catch (e) { error = String(e.message || e); }

  if (!error) await putState(db, orgId, { ...state, fullDay: full ? today : state.fullDay, lastOk: nowIso(), olderDays: older.length });
  await db.prepare("UPDATE int_sync_runs SET finished_at=?, status=?, rows_read=?, rows_changed=?, message=? WHERE id=?")
    .bind(nowIso(), error ? "error" : "ok", totals.orders + totals.items, totals.ordersWritten + totals.itemsWritten,
      error ? `live: ${error}` : `live${full ? " (daily full refresh)" : ""}: ${totals.orders} orders, ${totals.items} pieces read; ${totals.changes} changes${full ? `; ${totals.paymentsChanged || 0} payments updated` : ""}; ${smrt.calls} SMRT calls`, runId).run();
  return { status: error ? "error" : "ok", error, full, olderDays: older.length, calls: smrt.calls, ...totals };
}

// ---------------- "Check now" (Shuttle status page) ----------------
// The page asks for a store's pieces to be read from SMRT right away instead of waiting up to 10 minutes for the live sync.
// SMRT's reports can only be filtered by the day an order was created, so this re-reads the created days the page sends
// (the days of that store's open orders due today or earlier), orders and pieces, through the same ingest as the live sync.
export const CHECK_RANGE_DAYS = 3;   // created days per SMRT call (as the live sync)
export const CHECK_MAX_RANGES = 6;   // at most 12 report calls; the oldest days are left to the live sync
export const CHECK_REPEAT_S = 45;    // the same days checked again this soon get the answer just read
const CHECK_LOOKBACK = 60;

async function getCheck(db, orgId) {
  const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='smrt_check'").bind(orgId).first();
  return r ? JSON.parse(r.value_json) : {};
}
async function putCheck(db, orgId, s) {
  await db.prepare(`INSERT INTO core_settings(org_id,app_id,key,value_json) VALUES(?, 'core', 'smrt_check', ?)
    ON CONFLICT(org_id,app_id,key) DO UPDATE SET value_json=excluded.value_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), rev=rev+1`).bind(orgId, JSON.stringify(s)).run();
}

export async function runCheck(db, smrt, { orgId, integrationId, today, days, label = "", reports = {}, now = Date.now() }) {
  const clean = [...new Set((Array.isArray(days) ? days : []).map(String).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today && d >= addDays(today, -CHECK_LOOKBACK)))].sort();
  if (!clean.includes(today)) clean.push(today); // orders entered today
  const ranges = dayRanges(clean, CHECK_RANGE_DAYS).slice(-CHECK_MAX_RANGES);
  const key = ranges.map(r => r.join("~")).join(",");
  const prev = await getCheck(db, orgId);
  if (prev.key === key && prev.at && now - Date.parse(prev.at) < CHECK_REPEAT_S * 1000) return { status: "recent", at: prev.at, calls: 0 };
  const busy = await runningSync(db, integrationId, { now });
  if (busy) return { status: "busy", since: busy.started_at, what: /^check/.test(busy.message || "") ? "check" : "sync", calls: 0 };

  const runId = ulid(), started = nowIso();
  await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status,message) VALUES(?,?,?,?,?)").bind(runId, integrationId, started, "running", `check now${label ? " " + label : ""}`).run();
  const ctx = { orgId, runId, mode: "live", lookups: await new Lookups(db, orgId).load() };
  const ordersId = reports.orders || REPORT_ORDERS, itemsId = reports.items || REPORT_ITEMS;
  const totals = { orders: 0, items: 0, ordersWritten: 0, itemsWritten: 0, changes: 0, followups: 0 };
  let error = null;
  try {
    for (const [a, b] of ranges) {
      const orders = await smrt.rangeObjects(ordersId, a, b), items = await smrt.rangeObjects(itemsId, a, b);
      ctx.day = a;
      const st = await ingestDay(db, ctx, orders, items);
      for (const k in totals) totals[k] += st[k] || 0;
    }
  } catch (e) { error = String(e.message || e); }
  const at = nowIso();
  if (!error) await putCheck(db, orgId, { at, key, label });
  await db.prepare("UPDATE int_sync_runs SET finished_at=?, status=?, rows_read=?, rows_changed=?, message=? WHERE id=?")
    .bind(at, error ? "error" : "ok", totals.orders + totals.items, totals.ordersWritten + totals.itemsWritten,
      `check now${label ? " " + label : ""}: ${error || `${totals.orders} orders, ${totals.items} pieces read; ${totals.changes} changes`}; ${smrt.calls} SMRT calls; days ${key}`, runId).run();
  return { status: error ? "error" : "ok", error, at, started, ranges, calls: smrt.calls, ...totals };
}
