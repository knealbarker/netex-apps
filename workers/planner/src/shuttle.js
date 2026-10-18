// Shuttle status (prodplanner.netexcleaners.com/shuttlestatus): is everything for a store on the van?
// Neal, Oct 18 2026: the driver racks every piece for a store's run to VAN in SMRT. Before he leaves, every piece due at
// that store today or earlier must be on VAN, unless it's already there (taken on an earlier run: racked at that store)
// or back with the customer. A piece held over has its order's due date moved later in SMRT (split the order first when
// only some pieces stay) and a note on the piece saying why; until it has a note it still holds up the run.
//
//   counted   orders returned to the store, due today or up to LOOKBACK_DAYS before, not voided/deleted/closed, not returned,
//             picked up or delivered, not route deliveries (they go out on the route van); each piece not removed
//   left out  piece back with the customer (return date, RETURNED/DELIVERED rack, status "customer") or last racked at the
//             store itself (SMRT's "Last racked store")
//   on VAN    last rack location matches Settings › SMRT mapping › "Rack location for orders on the van" (VAN)
//   held over the order's due date moved today from today-or-earlier to later (or the piece was split onto such an order)
import { loadGroups, loadRuns, } from "./settings.js";
import { localNow, addDays, runDeadline } from "./pieces.js";
import { HttpError } from "./util.js";

export const LOOKBACK_DAYS = 45; // the live sync keeps open orders this far back current
const toMin = t => { const m = /^(\d\d):(\d\d)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const hm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fmtNo = no => (String(no).length > 5 ? `${String(no).slice(0, 5)}-${String(no).slice(5)}` : String(no));
const smrtLink = (cid, no) => (cid ? `https://towncountryclean.smrtapp.com/posx/dash/customer/clothestracker/${encodeURIComponent(cid)}/?saleId=${encodeURIComponent(no)}` : null);

/** UTC instant of midnight starting `day` in the company's time zone. */
export function dayStartUtc(day, tz = "America/Chicago") {
  const noon = new Date(day + "T12:00:00Z");
  const local = toMin(localNow(tz, noon).hm);
  return new Date(Date.parse(day + "T00:00:00Z") + (12 * 60 - local) * 60e3).toISOString();
}

/** The stores the shuttle runs go to (Settings › Shuttle runs), with the run and when the van leaves the plant. */
export async function shuttleStores(db, orgId) {
  const runs = (await loadRuns(db, orgId)).filter(r => r.kind === "shuttle");
  const locs = (await db.prepare("SELECT id, name FROM core_locations WHERE org_id=?").bind(orgId).all()).results;
  const byName = new Map(locs.map(l => [l.name.toLowerCase(), l.id]));
  const out = [];
  for (const r of runs) {
    const dl = runDeadline(r);
    for (const s of r.stops) {
      const id = byName.get(String(s.store || "").toLowerCase());
      if (id && !out.some(x => x.id === id)) out.push({ id, name: s.store, run: r.name, runId: r.id, leaves: dl == null ? null : hm(dl), arrive: s.arrive || null });
    }
  }
  return out;
}

const COLS = `o.id AS oid, o.smrt_order_no AS no, o.return_location_id AS store, o.due_at AS due, o.piece_count AS opieces, o.customer_ref AS customer, o.customer_name AS cname,
  o.customer_internal_id AS cid, o.notes AS onote, o.smrt_created_at AS created, s.name AS ostatus,
  i.id AS iid, i.line_no AS line, i.barcode, t.name AS type, i.colors, i.brand, d.name AS dep, st.name AS istatus, COALESCE(st.is_assembled,0) AS isAsm,
  i.assembled_at AS asm, i.lot_status AS lot, i.last_rack_location AS rack, i.last_rack_store_id AS rackStoreId, rs.name AS rackStore, i.racked_at AS rackedAt,
  ps.smrt_name AS rackedBy, i.notes AS inote, i.returned_at AS iret`;
const JOINS = `FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id
  LEFT JOIN pos_items i ON i.order_id=o.id AND i.removed_at IS NULL
  LEFT JOIN pos_item_types t ON t.id=i.item_type_id LEFT JOIN pos_departments d ON d.id=i.department_id
  LEFT JOIN pos_item_statuses st ON st.id=i.status_id LEFT JOIN core_locations rs ON rs.id=i.last_rack_store_id
  LEFT JOIN pos_staff ps ON ps.id=i.racked_by_staff_id`;
const OPEN = `o.org_id=? AND s.is_void=0 AND s.is_closed=0 AND o.smrt_deleted_at IS NULL AND o.returned_at IS NULL AND o.picked_up_at IS NULL
  AND o.delivered_at IS NULL AND o.is_route_delivery=0`;

async function loadRows(db, orgId, storeIds, today) {
  if (!storeIds.length) return { due: [], held: [] };
  const ins = storeIds.map(() => "?").join(",");
  const due = (await db.prepare(`SELECT ${COLS} ${JOINS} WHERE ${OPEN} AND o.return_location_id IN (${ins})
      AND substr(o.due_at,1,10) BETWEEN ? AND ?`).bind(orgId, ...storeIds, addDays(today, -LOOKBACK_DAYS), today).all()).results;
  // held over today: the order's due date moved from today-or-earlier to later, or the piece was split onto such an order
  const since = dayStartUtc(today);
  const moved = (await db.prepare(`SELECT ${COLS}, c.old_value AS heldFrom, c.kind AS heldHow, c.detected_at AS heldAt ${JOINS}
      JOIN pos_changes c ON c.order_id=o.id AND c.kind='due_changed' AND c.detected_at>=? AND substr(c.old_value,1,10)<=? AND substr(c.new_value,1,10)>?
      WHERE ${OPEN} AND o.return_location_id IN (${ins}) AND substr(o.due_at,1,10)>?`).bind(since, today, today, orgId, ...storeIds, today).all()).results;
  const split = (await db.prepare(`SELECT ${COLS}, po.due_at AS heldFrom, c.kind AS heldHow, c.detected_at AS heldAt
      FROM pos_changes c JOIN pos_items i ON i.id=c.item_id AND i.removed_at IS NULL JOIN pos_orders o ON o.id=i.order_id JOIN pos_orders po ON po.id=c.old_value
      JOIN pos_order_statuses s ON s.id=o.status_id
      LEFT JOIN pos_item_types t ON t.id=i.item_type_id LEFT JOIN pos_departments d ON d.id=i.department_id
      LEFT JOIN pos_item_statuses st ON st.id=i.status_id LEFT JOIN core_locations rs ON rs.id=i.last_rack_store_id
      LEFT JOIN pos_staff ps ON ps.id=i.racked_by_staff_id
      WHERE c.kind='item_moved' AND c.detected_at>=? AND substr(po.due_at,1,10)<=? AND substr(po.due_at,1,10)>=?
        AND ${OPEN} AND o.return_location_id IN (${ins}) AND substr(o.due_at,1,10)>?`)
    .bind(since, today, addDays(today, -LOOKBACK_DAYS), orgId, ...storeIds, today).all()).results;
  const seen = new Set(), held = [];
  for (const r of [...moved, ...split].sort((a, b) => String(b.heldAt).localeCompare(String(a.heldAt)))) {
    const k = r.iid || "o" + r.oid; if (seen.has(k)) continue; seen.add(k); held.push(r);
  }
  await fillRackStores(db, [...due, ...held], today);
  return { due, held };
}

/**
 * Pieces read before Oct 18 (or not re-read since) don't have SMRT's "Last racked store" yet. A rack label belongs to one
 * store (G18 is Greenville's, PH84 the plant's), so when the store is missing it's taken from other pieces on the same rack
 * in the last 60 days, if they all say the same store. Labels used at several stores (LONG, SHELF) stay unknown.
 */
export async function fillRackStores(db, rows, today) {
  const labels = [...new Set(rows.filter(r => r.iid && r.rack && !r.rackStoreId).map(r => r.rack))];
  if (!labels.length) return;
  const byRack = new Map();
  for (let i = 0; i < labels.length; i += 80) {
    const part = labels.slice(i, i + 80);
    const res = (await db.prepare(`SELECT i.last_rack_location AS rack, i.last_rack_store_id AS sid, l.name AS store, COUNT(*) AS n FROM pos_items i
        JOIN core_locations l ON l.id=i.last_rack_store_id
        WHERE i.assembled_at >= ? AND i.last_rack_store_id IS NOT NULL AND i.last_rack_location IN (${part.map(() => "?").join(",")})
        GROUP BY 1, 2, 3`).bind(addDays(today, -60), ...part).all()).results;
    for (const x of res) (byRack.get(x.rack) || byRack.set(x.rack, []).get(x.rack)).push(x);
  }
  // a numbered rack never seen with a store (Q100): its letters decide, when every known rack with them is one store's (Q → Quitman)
  const prefix = rack => { const m = /^([A-Za-z][A-Za-z ]*?)\s*\d+$/.exec(String(rack).trim()); return m ? m[1].toUpperCase() : null; };
  const prefixes = [...new Set(labels.filter(l => { const s = byRack.get(l); return !(s && s.length === 1); }).map(prefix).filter(Boolean))];
  const byPrefix = new Map();
  if (prefixes.length) {
    const res = (await db.prepare(`SELECT upper(rtrim(rtrim(i.last_rack_location, '0123456789'), ' ')) AS p, i.last_rack_store_id AS sid, l.name AS store, COUNT(*) AS n
        FROM pos_items i JOIN core_locations l ON l.id=i.last_rack_store_id
        WHERE i.assembled_at >= ? AND i.last_rack_store_id IS NOT NULL AND i.last_rack_location GLOB '*[0-9]'
        GROUP BY 1, 2, 3`).bind(addDays(today, -60)).all()).results;
    for (const x of res) if (prefixes.includes(x.p)) (byPrefix.get(x.p) || byPrefix.set(x.p, []).get(x.p)).push(x);
  }
  for (const r of rows) {
    if (!r.iid || !r.rack || r.rackStoreId) continue;
    let seen = byRack.get(r.rack);
    if (!(seen && seen.length === 1)) seen = byPrefix.get(prefix(r.rack));
    if (seen && seen.length === 1) { r.rackStoreId = seen[0].sid; r.rackStore = seen[0].store; r.rackStoreGuessed = true; }
  }
}

const ASSEMBLED_ORDER = /^(assembled|racked|ready|complete|completed)$/i;
const GONE_RACK = /^(returned|delivered)$/i;

/** One table row for a piece (or an order with no pieces detailed yet), or null when it isn't part of the run any more. */
export function classify(r, transit, today, { held = false } = {}) {
  const base = {
    orderId: r.oid, order: fmtNo(r.no), orderNo: String(r.no), store: r.store, link: smrtLink(r.cid, r.no), customer: r.cname || r.customer || "", customerId: r.customer || "",
    due: r.due || null, created: String(r.created || "").slice(0, 10) || null, orderNote: r.onote || null,
  };
  if (!r.iid) { // the order hasn't been detailed: SMRT only knows how many pieces
    if (held) return { ...base, key: "o" + r.oid, kind: "order", status: "held", pieces: r.opieces || 0, item: `${r.opieces || "?"} pieces, not detailed`, prod: "Not detailed", rack: null,
      heldFrom: r.heldFrom || null, noted: !!r.onote, note: r.onote || null };
    return { ...base, key: "o" + r.oid, kind: "order", status: "blocked", pieces: r.opieces || 0, item: `${r.opieces || "?"} pieces, not detailed`, prod: "Not detailed",
      rack: null, reason: "Not detailed yet", note: r.onote || null };
  }
  if (r.iret || GONE_RACK.test(String(r.rack || "").trim()) || /^customer$/i.test(String(r.istatus || "").trim())) return null; // with the customer
  if (r.rackStoreId && r.rackStoreId === r.store) return null; // already racked at the store (an earlier run)
  const ready = !!r.isAsm || !!r.asm || ASSEMBLED_ORDER.test(String(r.ostatus || "").replace(/[\s_-]/g, ""));
  const lot = String(r.lot || "").trim();
  const prod = ready ? "Ready" : `${r.istatus ? r.istatus[0].toUpperCase() + r.istatus.slice(1) : "Not scanned"}${lot && !/^completed?$/i.test(lot) ? ` · ${lot.toLowerCase()}` : ""}`;
  const item = [r.type, r.colors].filter(Boolean).join(" · ") || "Piece";
  const onVan = !!r.rack && transit.test(r.rack);
  const p = {
    ...base, key: r.iid, kind: "piece", pieces: 1, line: r.line, tag: r.barcode || "", item, brand: r.brand || "", dep: r.dep || "", prod, ready,
    rack: r.rack || null, rackStore: r.rackStore || null, rackedAt: r.rackedAt || null, rackedBy: r.rackedBy || null, note: r.inote || null,
  };
  if (held) return { ...p, status: "held", heldFrom: r.heldFrom || null, noted: !!(r.inote || r.onote), note: r.inote || r.onote || null };
  if (onVan) return { ...p, status: "van", vanSince: r.rackedAt && String(r.rackedAt).slice(0, 10) < today ? String(r.rackedAt).slice(0, 10) : null };
  return { ...p, status: "blocked", reason: !ready ? "Not ready" : r.rack ? `Ready, on ${r.rack}` : "Ready, not racked" };
}

const ORDER = { blocked: 0, held: 1, van: 2 };
export const sortRows = rows => rows.sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (a.status === "held" ? (a.noted - b.noted) : 0)
  || String(a.orderNo).localeCompare(String(b.orderNo)) || (a.line || 0) - (b.line || 0));

function summarize(rows) {
  const s = { pieces: 0, van: 0, blocked: 0, notReady: 0, held: 0, heldNoNote: 0, vanEarlier: 0 };
  for (const r of rows) {
    if (r.status === "van") { s.van++; s.pieces++; if (r.vanSince) s.vanEarlier++; }
    else if (r.status === "blocked") { s.blocked += r.pieces; s.pieces += r.pieces; if (!r.ready) s.notReady += r.pieces; }
    else if (r.status === "held") { s.held += r.pieces; if (!r.noted) s.heldNoNote += r.pieces; }
  }
  s.ok = s.blocked === 0 && s.heldNoNote === 0;
  s.nothing = s.pieces === 0 && s.held === 0;
  return s;
}

async function freshness(db) {
  const last = await db.prepare(`SELECT finished_at AS at, message FROM int_sync_runs WHERE integration_id='smrt' AND status='ok'
      AND (message LIKE 'live%' OR message LIKE 'check now%') ORDER BY finished_at DESC LIMIT 1`).first();
  const running = await db.prepare(`SELECT started_at AS at, message FROM int_sync_runs WHERE integration_id='smrt' AND status='running' AND started_at>=?
      ORDER BY started_at DESC LIMIT 1`).bind(new Date(Date.now() - 4 * 60e3).toISOString()).first();
  return { asOf: last ? last.at : null, how: last ? (/^check/.test(last.message) ? "check" : "sync") : null, checking: running && /^check/.test(running.message) ? running.at : null };
}

/** Every shuttle store's totals, and the full list for one store (`storeId`). */
export async function shuttleView(db, env, { storeId = null, at = new Date() } = {}) {
  const today = localNow(env.TIMEZONE, at).day;
  const groups = await loadGroups(db, env.ORG_ID);
  const transitName = String(groups.smrt.transitRack || "Van").trim() || "Van";
  const transit = new RegExp(`^\\s*${transitName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const stores = await shuttleStores(db, env.ORG_ID);
  if (storeId && !stores.some(s => s.id === storeId)) throw new HttpError(404, "That store isn't on a shuttle run (Settings › Shuttle runs).");
  const { due, held } = await loadRows(db, env.ORG_ID, stores.map(s => s.id), today);
  const rowsOf = id => sortRows([
    ...due.filter(r => r.store === id).map(r => classify(r, transit, today)).filter(Boolean),
    ...held.filter(r => r.store === id).map(r => classify(r, transit, today, { held: true })).filter(Boolean),
  ]);
  const out = stores.map(s => ({ ...s, ...summarize(rowsOf(s.id)) }));
  const fresh = await freshness(db);
  const res = { day: today, now: at.toISOString(), transitRack: transitName, lookbackDays: LOOKBACK_DAYS, stores: out, ...fresh, sync: !!env.SYNC };
  if (storeId) res.rows = rowsOf(storeId);
  return res;
}

/** "Check now": re-read this store's orders from SMRT right away (netex-sync, through the SYNC service binding), then the view. */
export async function checkNow(db, env, me, storeId, { at = new Date() } = {}) {
  if (!env.SYNC) throw new HttpError(503, "Check now isn't connected yet (the planner needs its SYNC service binding to netex-sync).");
  const today = localNow(env.TIMEZONE, at).day;
  const stores = await shuttleStores(db, env.ORG_ID);
  const store = stores.find(s => s.id === storeId);
  if (!store) throw new HttpError(404, "That store isn't on a shuttle run (Settings › Shuttle runs).");
  // only the created days of orders that still hold up the run (not on VAN, or held over without a note): pieces already on
  // VAN or at the store don't need re-reading, so a check near departure is a few SMRT calls, not every open day (+ today, always)
  const groups = await loadGroups(db, env.ORG_ID);
  const transitName = String(groups.smrt.transitRack || "Van").trim() || "Van";
  const transit = new RegExp(`^\\s*${transitName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const { due, held } = await loadRows(db, env.ORG_ID, [store.id], today);
  const open = [...due.map(r => [r, classify(r, transit, today)]), ...held.map(r => [r, classify(r, transit, today, { held: true })])]
    .filter(([, c]) => c && (c.status === "blocked" || (c.status === "held" && !c.noted)));
  const days = [...new Set(open.map(([r]) => String(r.created || "").slice(0, 10)).filter(Boolean))].sort();
  let result;
  try {
    const r = await env.SYNC.fetch("https://netex-sync/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ days, label: store.name }) });
    result = await r.json().catch(() => ({ status: "error", error: `netex-sync answered ${r.status}` }));
  } catch (e) {
    console.error(JSON.stringify({ job: "shuttle-check", store: store.name, error: String(e && e.message || e) }));
    result = { status: "error", error: "SMRT couldn't be read just now. Try again in a minute." };
  }
  let view;
  try { view = await shuttleView(db, env, { storeId, at }); }
  catch (e) { // the database can be slow right after a big check: try once more before giving up
    console.error(JSON.stringify({ job: "shuttle-check-view", error: String(e && e.message || e) }));
    await new Promise(r => setTimeout(r, 1500));
    view = await shuttleView(db, env, { storeId, at });
  }
  return { ...view, check: { status: result.status, error: result.error ? String(result.error).slice(0, 200) : undefined, at: result.at || null, calls: result.calls || 0, days: days.length, by: me?.name || null } };
}
