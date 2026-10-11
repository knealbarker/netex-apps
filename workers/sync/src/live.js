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

export async function runLive(db, smrt, { orgId, integrationId, today, reports = {} }) {
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
