// Loads SMRT history a little at a time, newest day first, a few days per run at night.
// Progress is kept per day in int_backfill_days and the position in core_settings ('smrt_backfill'),
// so it can stop and pick up again at any time. Re-loading a day changes nothing (rows are matched).
import { REPORT_ORDERS, REPORT_ITEMS } from "./smrt.js";
import { ingestDay } from "./ingest.js";
import { ulid, nowIso, addDays } from "./util.js";

export const DEFAULTS = { daysPerRun: 2, stopAfterEmptyDays: 21, oldestDay: "2021-01-01", maxAttempts: 3 };

async function getState(db, orgId) {
  const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='smrt_backfill'").bind(orgId).first();
  return r ? JSON.parse(r.value_json) : null;
}
async function putState(db, orgId, s) {
  await db.prepare(`INSERT INTO core_settings(org_id,app_id,key,value_json) VALUES(?, 'core', 'smrt_backfill', ?)
    ON CONFLICT(org_id,app_id,key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at, rev=rev+1`).bind(orgId, JSON.stringify(s)).run();
}

/**
 * One backfill run.
 * @returns {{ status, loaded: Array<{day, orders, items}>, state }}
 */
export async function runBackfill(db, smrt, { orgId, integrationId, today, reports = {}, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  let s = await getState(db, orgId);
  if (!s) s = { next: addDays(today, -1), emptyStreak: 0, finished: false, started: nowIso() };
  if (s.finished) return { status: "finished", loaded: [], state: s };

  const runId = ulid();
  await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status,message) VALUES(?,?,?,?,?)").bind(runId, integrationId, nowIso(), "running", "history backfill").run();
  const ctx = { orgId, runId, mode: "backfill" };
  const loaded = []; let error = null, rowsRead = 0, rowsChanged = 0;

  for (let n = 0; n < o.daysPerRun; n++) {
    const day = s.next;
    if (day < o.oldestDay) { s.finished = true; s.reason = `reached ${o.oldestDay}`; break; }
    try {
      ctx.day = day;
      const orders = await smrt.dayObjects(reports.orders || REPORT_ORDERS, day);
      const items = orders.length ? await smrt.dayObjects(reports.items || REPORT_ITEMS, day) : [];
      const st = await ingestDay(db, ctx, orders, items);
      rowsRead += orders.length + items.length; rowsChanged += st.ordersWritten + st.itemsWritten;
      const empty = orders.length === 0;
      await db.prepare(`INSERT INTO int_backfill_days(integration_id,day,status,orders,items,attempts,loaded_at,sync_run_id) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(integration_id,day) DO UPDATE SET status=excluded.status, orders=excluded.orders, items=excluded.items, attempts=int_backfill_days.attempts+1, last_error=NULL, loaded_at=excluded.loaded_at, sync_run_id=excluded.sync_run_id`)
        .bind(integrationId, day, empty ? "empty" : "done", st.orders, st.items, 1, nowIso(), runId).run();
      loaded.push({ day, orders: st.orders, items: st.items });
      s.emptyStreak = empty ? s.emptyStreak + 1 : 0;
      s.next = addDays(day, -1); s.attempts = 0;
      if (s.emptyStreak >= o.stopAfterEmptyDays) { s.finished = true; s.reason = `no orders for ${s.emptyStreak} days before ${addDays(day, s.emptyStreak)}`; break; }
    } catch (e) {
      error = String(e.message || e);
      s.attempts = (s.attempts || 0) + 1;
      if (s.attempts >= o.maxAttempts) { // give up on this day, note it, and move on so one bad day doesn't stall the history
        await db.prepare(`INSERT INTO int_backfill_days(integration_id,day,status,attempts,last_error,loaded_at,sync_run_id) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(integration_id,day) DO UPDATE SET status='error', attempts=excluded.attempts, last_error=excluded.last_error, loaded_at=excluded.loaded_at`)
          .bind(integrationId, day, "error", s.attempts, error, nowIso(), runId).run();
        s.next = addDays(day, -1); s.attempts = 0;
      }
      break; // try again next run
    }
  }
  s.lastRun = nowIso();
  await putState(db, orgId, s);
  await db.prepare("UPDATE int_sync_runs SET finished_at=?, status=?, rows_read=?, rows_changed=?, message=? WHERE id=?")
    .bind(nowIso(), error ? "error" : "ok", rowsRead, rowsChanged, error ? `history backfill: ${error}` : `history backfill: ${loaded.map(x => x.day).join(", ") || "nothing to do"}`, runId).run();
  return { status: error ? "error" : s.finished ? "finished" : "ok", loaded, error, state: s };
}

// how far along the history is, for a status line in the app
export async function backfillProgress(db, orgId, integrationId) {
  const s = await getState(db, orgId);
  const r = await db.prepare(`SELECT COUNT(*) AS days, SUM(orders) AS orders, SUM(items) AS items, MIN(day) AS oldest, SUM(status='error') AS errors
    FROM int_backfill_days WHERE integration_id=?`).bind(integrationId).first();
  return { ...r, next: s && s.next, finished: !!(s && s.finished), reason: s && s.reason };
}
