// Rack scans (Neal, Oct 19 2026): SMRT's saved report "TCC Racked Last 12 Hours" lists every rack scan, of TICKETS (an order's
// bags: '26287-5444-A' = order 26287-5444, ticket A; tickets contain items) and of single items (by tag). The van driver scans
// tickets to VAN; stores scan them to their racks or DELIVERED. The report is filtered by scan time, so a read is small.
//  - Every 2 minutes on work days (and first thing on a Shuttle status "Check now"): the scans since the last read, with an
//    overlap (a scan already stored is skipped). The end of the window is always tomorrow's date, so nothing new is missed.
//  - Until 45 days are loaded, each run also reads a couple of earlier whole days, newest first (one-time history).
//  - pos_rack_events keeps every scan; pos_tickets keeps each ticket's latest scan (where it is now).
//  - The customer's name on a ticket fills pos_orders.customer_name when the order has none.
import { REPORT_RACKS } from "./smrt.js";
import { Lookups } from "./ingest.js";
import { ulid, nowIso, addDays, text, int, stamp } from "./util.js";

export const RACK_HISTORY_DAYS = 45;
export const RACK_HISTORY_PER_RUN = 2;
export const RACK_OVERLAP_MIN = 10;
const LIMIT = 5000;
const BATCH = 100;

/** '26287-5444-A' -> { orderNo: '262875444', letter: 'A' }; null for anything else. */
export function ticketParts(id) {
  const m = /^(\d{5})-(\d{1,6})-([A-Z]{1,3})$/i.exec(String(id || "").trim());
  return m ? { orderNo: m[1] + m[2], letter: m[3].toUpperCase() } : null;
}

/** 'YYYY-MM-DDTHH:MM:SS' in the company's time zone (what SMRT's reports take as a start). */
export function localStamp(ms, tz = "America/Chicago") {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

async function getState(db, orgId) {
  const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='smrt_racks'").bind(orgId).first();
  return r ? JSON.parse(r.value_json) : {};
}
async function putState(db, orgId, s) {
  await db.prepare(`INSERT INTO core_settings(org_id,app_id,key,value_json) VALUES(?, 'core', 'smrt_racks', ?)
    ON CONFLICT(org_id,app_id,key) DO UPDATE SET value_json=excluded.value_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), rev=rev+1`).bind(orgId, JSON.stringify(s)).run();
}

/** Stores scans (objects keyed by the report's column names). Returns counts. */
export async function ingestScans(db, ctx, rows) {
  const L = ctx.lookups || (ctx.lookups = await new Lookups(db, ctx.orgId).load());
  const events = [], latest = new Map(), names = new Map(), itemNames = new Map();
  for (const r of rows) {
    const kind = (text(r["Inventory type"]) || "item").toLowerCase(), ref = text(r["ID"]), at = stamp(r["Date of entry"]);
    if (!ref || !at) continue;
    const t = kind === "ticket" ? ticketParts(ref) : null;
    const v = {
      kind, ref, orderNo: t ? t.orderNo : null, letter: t ? t.letter : null, location: text(r["Location label"]), barcode: text(r["Location barcode"]) || "",
      rack: text(r["Rack"]), station: text(r["Station"]), store: L.location(r["Store"]), drop: L.location(r["Agent"]), at, by: text(r["Racked by"]),
      rerack: /^(1|true|yes)$/i.test(String(r["Is rerack event"] ?? "").trim()) ? 1 : 0, current: /^(1|true|yes)$/i.test(String(r["Is current"] ?? "").trim()) ? 1 : 0,
      customer: text(r["Customer full Name"]) ? text(r["Customer full Name"]).replace(/\s+/g, " ") : null, price: int(r["Price"]),
    };
    events.push(v);
    if (t) {
      const cur = latest.get(ref);
      if (!cur || Date.parse(v.at) >= Date.parse(cur.at)) latest.set(ref, { ...v, first: cur ? (Date.parse(cur.first) < Date.parse(v.at) ? cur.first : v.at) : v.at });
      else if (Date.parse(v.at) < Date.parse(cur.first)) cur.first = v.at;
      if (v.customer) names.set(t.orderNo, v.customer);
    } else if (v.kind === "item" && v.customer) itemNames.set(v.ref, v.customer);
  }
  const stmts = [...L.take()];
  for (const v of events) stmts.push(db.prepare(`INSERT INTO pos_rack_events(id,org_id,kind,ref,order_no,ticket_letter,location,location_barcode,rack,station,store_id,drop_store_id,at,racked_by,is_rerack,is_current,customer_name,price_cents)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,kind,ref,at,location_barcode) DO NOTHING`)
    .bind(ulid(), ctx.orgId, v.kind, v.ref, v.orderNo, v.letter, v.location, v.barcode, v.rack, v.station, v.store, v.drop, v.at, v.by, v.rerack, v.current, v.customer, v.price));
  for (const [id, v] of latest) stmts.push(db.prepare(`INSERT INTO pos_tickets(org_id,ticket_id,order_no,letter,location,store_id,at,racked_by,customer_name,first_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(org_id,ticket_id) DO UPDATE SET
        location=CASE WHEN excluded.at >= pos_tickets.at THEN excluded.location ELSE pos_tickets.location END,
        store_id=CASE WHEN excluded.at >= pos_tickets.at THEN excluded.store_id ELSE pos_tickets.store_id END,
        racked_by=CASE WHEN excluded.at >= pos_tickets.at THEN excluded.racked_by ELSE pos_tickets.racked_by END,
        at=CASE WHEN excluded.at >= pos_tickets.at THEN excluded.at ELSE pos_tickets.at END,
        first_at=CASE WHEN excluded.first_at < COALESCE(pos_tickets.first_at, excluded.first_at) THEN excluded.first_at ELSE COALESCE(pos_tickets.first_at, excluded.first_at) END,
        customer_name=COALESCE(excluded.customer_name, pos_tickets.customer_name),
        updated_at=excluded.updated_at`)
    .bind(ctx.orgId, id, v.orderNo, v.letter, v.location, v.store, v.at, v.by, v.customer, v.first, nowIso()));
  for (const [no, name] of names) stmts.push(db.prepare("UPDATE pos_orders SET customer_name=? WHERE org_id=? AND smrt_order_no=? AND (customer_name IS NULL OR customer_name='')").bind(name, ctx.orgId, no));
  // item scans carry the name too: the order the tag is on now (orders with no ticket scanned yet get their name this way)
  for (const [tag, name] of itemNames) stmts.push(db.prepare(`UPDATE pos_orders SET customer_name=? WHERE (customer_name IS NULL OR customer_name='') AND id=(
      SELECT i.order_id FROM pos_items i JOIN pos_orders o ON o.id=i.order_id WHERE o.org_id=? AND i.barcode=? AND i.removed_at IS NULL ORDER BY i.smrt_created_at DESC LIMIT 1)`).bind(name, ctx.orgId, tag));
  for (let i = 0; i < stmts.length; i += BATCH) await db.batch(stmts.slice(i, i + BATCH));
  return { scans: events.length, tickets: latest.size };
}

async function readWindow(smrt, id, cols, from, to) {
  const rows = await smrt.rows(id, from, to);
  if (rows.length >= LIMIT) throw new Error(`more than ${LIMIT} scans between ${from} and ${to}`);
  return rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

/**
 * Reads the newest scans (and, until it's loaded, a little history). `now` and `tz` decide the window; `label` names the run
 * in the sync log ('racks' for the 2-minute job, 'racks (check now Quitman)' for a Check now).
 */
export async function runRacks(db, smrt, { orgId, integrationId, now = Date.now(), tz = "America/Chicago", label = "racks", reportId = REPORT_RACKS, history = true }) {
  const state = await getState(db, orgId);
  const today = localStamp(now, tz).slice(0, 10), tomorrow = addDays(today, 1);
  const runId = ulid();
  await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status,message) VALUES(?,?,?,?,?)").bind(runId, integrationId, nowIso(), "running", label).run();
  const ctx = { orgId, runId };
  let error = null, read = 0, tickets = 0, from = null;
  const hist = [];
  try {
    let cols = Array.isArray(state.cols) && state.cols.length ? state.cols : null;
    if (!cols) cols = await smrt.columns(reportId, today);
    // newest scans: from the last read (less an overlap) to tomorrow; the first read takes all of today
    from = state.until ? localStamp(Date.parse(state.until) - RACK_OVERLAP_MIN * 60e3, tz) : `${today}T00:00:00`;
    if (from.slice(0, 10) < addDays(today, -1)) from = `${addDays(today, -1)}T00:00:00`; // a long pause: today and yesterday, history does the rest
    let rows = await readWindow(smrt, reportId, cols, from, tomorrow);
    if (rows.length && !("ID" in rows[0])) { cols = await smrt.columns(reportId, today); rows = await readWindow(smrt, reportId, cols, from, tomorrow); } // columns changed in SMRT
    const st = await ingestScans(db, ctx, rows);
    read += st.scans; tickets += st.tickets;
    state.cols = cols; state.until = new Date(now).toISOString();
    // one-time history, a couple of days a run, newest first
    if (history) {
      let back = state.backTo || addDays(today, -1);
      for (let i = 0; i < RACK_HISTORY_PER_RUN && back > addDays(today, -RACK_HISTORY_DAYS); i++) {
        const day = back;
        const h = await readWindow(smrt, reportId, cols, day, addDays(day, 1));
        const hs = await ingestScans(db, ctx, h);
        hist.push(`${day}: ${hs.scans}`);
        back = addDays(day, -1);
      }
      state.backTo = back;
    }
    await putState(db, orgId, state);
  } catch (e) { error = String(e.message || e); }
  await db.prepare("UPDATE int_sync_runs SET finished_at=?, status=?, rows_read=?, message=? WHERE id=?")
    .bind(nowIso(), error ? "error" : "ok", read, `${label}: ${error || `${read} scans since ${from}, ${tickets} tickets${hist.length ? `; history ${hist.join(", ")}` : ""}`}; ${smrt.calls} SMRT calls`, runId).run();
  return { status: error ? "error" : "ok", error, scans: read, tickets, from, history: hist, calls: smrt.calls };
}
