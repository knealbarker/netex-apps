// Live SMRT sync on work days: keeps orders and pieces current so the planner can count what's due,
// what's done and what's late. Every run re-reads:
//   - everything created in the last LIVE_RECENT_DAYS days (new orders, new pieces, today's assembly), and
//   - each older created day that still has an open order due soon or overdue (up to 14 days back).
// Once a day (the first run) it also re-reads every created day in the last 45 days that has any open order,
// so older special orders (alterations, repairs) stay current.
// The daily full run also re-reads the orders report alone for the last PAYMENT_LOOKBACK_DAYS (in 15-day calls), so payments made
// after pickup (statements, AutoPay) reach the Retail Snapshot's revenue numbers.
// Shuttle stores (Neal, Oct 19: 26261-5050 sat on SHELF in Emory but Shuttle status still listed it): every run also re-reads
// the created days of shuttle orders due today or earlier, not picked up, with a piece not yet known to be at its store or on
// the van, whatever the order's status. Ready orders aren't in the days above, so without this a piece racked at the store
// after it was ready never reached the page. At most SHUTTLE_MAX_RANGES ranges a run, the longest-unread first.
// SMRT calls per run: 2 column calls + 1 orders call + 3 items calls + 2 per older day range (~8) + up to 8 for shuttle days;
// +4 orders calls once a day.
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
export const SHUTTLE_MAX_RANGES = 4;      // shuttle day ranges re-read per run (2 SMRT calls each)
const SHUTTLE_LOOKBACK_DAYS = 45;  // as the Shuttle status page

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

/**
 * Created days of shuttle-store orders the Shuttle status page counts (open, not picked up/returned/delivered, not route
 * deliveries, due today or up to 45 days back) that still have a piece not known to be at its store, on the van or back with
 * the customer. Ready orders are included: a piece racked at the store after the order was ready only shows up this way.
 */
export async function shuttleCreatedDays(db, orgId, today) {
  let transit = "VAN";
  try {
    const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='planner' AND key='smrt' AND deleted_at IS NULL").bind(orgId).first();
    const t = r && String(JSON.parse(r.value_json).transitRack || "").trim();
    if (t) transit = t.toUpperCase();
  } catch { /* default */ }
  const r = await db.prepare(`SELECT DISTINCT substr(o.smrt_created_at, 1, 10) AS day FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id
      WHERE o.org_id=? AND s.is_void=0 AND s.is_closed=0 AND o.smrt_deleted_at IS NULL AND o.returned_at IS NULL AND o.picked_up_at IS NULL
        AND o.delivered_at IS NULL AND o.is_route_delivery=0
        AND substr(o.due_at, 1, 10) BETWEEN ? AND ?
        AND o.return_location_id IN (SELECT st.location_id FROM plan_run_stops st JOIN plan_runs ru ON ru.id=st.run_id
          WHERE ru.org_id=? AND ru.kind='shuttle' AND ru.is_active=1 AND ru.deleted_at IS NULL AND st.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM pos_items i WHERE i.order_id=o.id AND i.removed_at IS NULL AND i.returned_at IS NULL
          AND (i.last_rack_store_id IS NULL OR i.last_rack_store_id <> o.return_location_id)
          AND upper(trim(COALESCE(i.last_rack_location, ''))) NOT IN (?, 'RETURNED', 'DELIVERED'))
      ORDER BY 1`).bind(orgId, addDays(today, -SHUTTLE_LOOKBACK_DAYS), today, orgId, transit).all();
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
  // runs that died partway (the Worker was stopped) never finish: close them so the log doesn't say "running" forever
  await db.prepare("UPDATE int_sync_runs SET status='error', finished_at=?, message=message || ' — stopped before it finished' WHERE integration_id=? AND status='running' AND started_at<?")
    .bind(new Date(now).toISOString(), integrationId, new Date(now - 15 * 60e3).toISOString()).run();
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

  // shuttle days not already read above, longest-unread first (state.shuttleRead: day -> when last read)
  const covered = new Set([...Array.from({ length: LIVE_RECENT_DAYS }, (_, i) => addDays(recentFrom, i)), ...older]);
  const lastRead = state.shuttleRead || {};
  const shuttleDays = (await shuttleCreatedDays(db, orgId, today)).filter(d => !covered.has(d));
  const shuttle = dayRanges(shuttleDays, ITEMS_DAYS_PER_CALL)
    .map(r => ({ r, at: lastRead[r[0]] || "" }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.r[0].localeCompare(b.r[0]))
    .slice(0, SHUTTLE_MAX_RANGES).map(x => x.r).sort((a, b) => a[0].localeCompare(b[0]));

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
    for (const r of shuttle) groups.push({ orders: [r], items: [r] });
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

  if (!error) {
    const read = {}, now = nowIso(), keepFrom = addDays(today, -SHUTTLE_LOOKBACK_DAYS - 15);
    for (const [d, at] of Object.entries(lastRead)) if (d >= keepFrom) read[d] = at;
    for (const [a, b] of shuttle) for (let d = a; d < b; d = addDays(d, 1)) read[d] = now;
    await putState(db, orgId, { ...state, fullDay: full ? today : state.fullDay, lastOk: now, olderDays: older.length, shuttleRead: read, shuttleDays: shuttleDays.length });
  }
  await db.prepare("UPDATE int_sync_runs SET finished_at=?, status=?, rows_read=?, rows_changed=?, message=? WHERE id=?")
    .bind(nowIso(), error ? "error" : "ok", totals.orders + totals.items, totals.ordersWritten + totals.itemsWritten,
      error ? `live: ${error}` : `live${full ? " (daily full refresh)" : ""}: ${totals.orders} orders, ${totals.items} pieces read; ${totals.changes} changes${shuttle.length ? `; shuttle days ${shuttle.map(r => r[0]).join(",")} (${shuttleDays.length} waiting)` : ""}${full ? `; ${totals.paymentsChanged || 0} payments updated` : ""}; ${smrt.calls} SMRT calls`, runId).run();
  return { status: error ? "error" : "ok", error, full, olderDays: older.length, shuttleRanges: shuttle, shuttleDays: shuttleDays.length, calls: smrt.calls, ...totals };
}

// ---------------- "Check now" (Shuttle status page) ----------------
// The page asks for a store's pieces to be read from SMRT right away instead of waiting up to 10 minutes for the live sync.
// SMRT's reports can only be filtered by the day an order was created, so this re-reads the created days the page sends
// (the days of that store's open orders due today or earlier), orders and pieces, through the same ingest as the live sync.
export const CHECK_RANGE_DAYS = 3;   // created days per SMRT call (as the live sync)
export const CHECK_MAX_RANGES = 8;   // at most 16 report calls; the oldest days are left to the live sync
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
