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
//
// TICKETS (Neal, Oct 19: "call them Tickets just like SMRT does. Tickets contain Items and are subsets of Orders"): the driver
// scans an order's tickets (its bags, 26287-5444-A) to VAN, and the stores scan them to their racks or DELIVERED. netex-sync
// keeps each ticket's latest scan (pos_tickets, from SMRT's rack-scan report every 2 minutes). An order with tickets is listed
// ticket by ticket: on VAN, or not (with where it is); tickets last scanned at the store, DELIVERED or RETURNED are left out.
// Its items not ready yet get one row of their own. Orders with no ticket scans yet are listed item by item as before.
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
  o.customer_internal_id AS cid, o.order_type AS otype, o.notes AS onote, o.smrt_created_at AS created, s.name AS ostatus,
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
      AND o.due_at >= ? AND o.due_at < ?`).bind(orgId, ...storeIds, addDays(today, -LOOKBACK_DAYS), addDays(today, 1)).all()).results;
  // held over today: the order's due date moved from today-or-earlier to later, or the piece was split onto such an order
  const since = dayStartUtc(today);
  const moved = (await db.prepare(`SELECT ${COLS}, c.old_value AS heldFrom, c.kind AS heldHow, c.detected_at AS heldAt ${JOINS}
      JOIN pos_changes c ON c.order_id=o.id AND c.kind='due_changed' AND c.detected_at>=? AND substr(c.old_value,1,10)<=? AND substr(c.new_value,1,10)>?
      WHERE ${OPEN} AND o.return_location_id IN (${ins}) AND o.due_at >= ?`).bind(since, today, today, orgId, ...storeIds, addDays(today, 1)).all()).results;
  const split = (await db.prepare(`SELECT ${COLS}, po.due_at AS heldFrom, c.kind AS heldHow, c.detected_at AS heldAt
      FROM pos_changes c JOIN pos_items i ON i.id=c.item_id AND i.removed_at IS NULL JOIN pos_orders o ON o.id=i.order_id JOIN pos_orders po ON po.id=c.old_value
      JOIN pos_order_statuses s ON s.id=o.status_id
      LEFT JOIN pos_item_types t ON t.id=i.item_type_id LEFT JOIN pos_departments d ON d.id=i.department_id
      LEFT JOIN pos_item_statuses st ON st.id=i.status_id LEFT JOIN core_locations rs ON rs.id=i.last_rack_store_id
      LEFT JOIN pos_staff ps ON ps.id=i.racked_by_staff_id
      WHERE c.kind='item_moved' AND c.detected_at>=? AND substr(po.due_at,1,10)<=? AND substr(po.due_at,1,10)>=?
        AND ${OPEN} AND o.return_location_id IN (${ins}) AND o.due_at >= ?`)
    .bind(since, today, addDays(today, -LOOKBACK_DAYS), orgId, ...storeIds, addDays(today, 1)).all()).results;
  const seen = new Set(), held = [];
  for (const r of [...moved, ...split].sort((a, b) => String(b.heldAt).localeCompare(String(a.heldAt)))) {
    const k = r.iid || "o" + r.oid; if (seen.has(k)) continue; seen.add(k); held.push(r);
  }
  await fillRackStores(db, [...due, ...held], today);
  const tickets = await loadTickets(db, orgId, [...new Set([...due, ...held].map(r => String(r.no)))]);
  await fillNamesFromScans(db, orgId, [...due, ...held]);
  return { due, held, tickets };
}

/** Orders without a customer name get it from an item scan of one of their tags (SMRT's rack-scan report carries the name). */
export async function fillNamesFromScans(db, orgId, rows) {
  const need = rows.filter(r => !r.cname && r.barcode);
  const tags = [...new Set(need.map(r => r.barcode))];
  if (!tags.length) return;
  const byTag = new Map();
  for (let i = 0; i < tags.length; i += 90) {
    const part = tags.slice(i, i + 90);
    const res = (await db.prepare(`SELECT ref, customer_name AS name, MAX(at) AS at FROM pos_rack_events WHERE org_id=? AND kind='item' AND customer_name IS NOT NULL
        AND ref IN (${part.map(() => "?").join(",")}) GROUP BY ref, customer_name`).bind(orgId, ...part).all()).results;
    for (const x of res) { const cur = byTag.get(x.ref); if (!cur || x.at > cur.at) byTag.set(x.ref, x); }
  }
  const byOrder = new Map();
  for (const r of need) { const hit = byTag.get(r.barcode); if (hit && !byOrder.has(r.oid)) byOrder.set(r.oid, hit.name); }
  for (const r of rows) if (!r.cname && byOrder.has(r.oid)) r.cname = byOrder.get(r.oid);
}

/** Each order's tickets with their latest scan (Map order number -> list). */
export async function loadTickets(db, orgId, orderNos) {
  const out = new Map();
  for (let i = 0; i < orderNos.length; i += 90) {
    const part = orderNos.slice(i, i + 90);
    const res = (await db.prepare(`SELECT t.ticket_id AS id, t.order_no AS no, t.letter, t.location, t.store_id AS storeId, l.name AS store, t.at, t.racked_by AS by, t.customer_name AS customer
        FROM pos_tickets t LEFT JOIN core_locations l ON l.id=t.store_id WHERE t.org_id=? AND t.order_no IN (${part.map(() => "?").join(",")})
        ORDER BY t.ticket_id`).bind(orgId, ...part).all()).results;
    for (const t of res) (out.get(t.no) || out.set(t.no, []).get(t.no)).push(t);
  }
  return out;
}

/**
 * An order with no ticket scans yet: one row for all its items (Neal, Oct 19: every row is a ticket; an order without one
 * is one row), from the item-by-item rules. Not-detailed orders and Wash & Fold rows are already one row.
 */
export function noTicketRow(items) {
  if (!items.length || items.some(r => r.kind !== "piece")) return items;
  const r0 = items[0], n = items.length;
  const count = st => items.filter(r => r.status === st).length;
  const racks = [...new Set(items.map(r => r.rack).filter(Boolean))];
  const prods = [...new Set(items.map(r => r.prod).filter(Boolean))];
  const base = {
    ...r0, key: "i" + r0.orderId, kind: "items", unit: "item", line: "", tag: "", brand: "", ticket: null,
    item: itemsLabel(n), prod: prods.join(", "), rack: racks.join(", ") || null, rackStore: null,
    location: [...new Set(items.map(r => r.location))].join(", "), details: items.flatMap(r => r.details || []),
    rackedAt: items.map(r => r.rackedAt).filter(Boolean).sort().pop() || null, rackedBy: [...new Set(items.map(r => r.rackedBy).filter(Boolean))].join(", ") || null,
    note: items.map(r => r.note).find(Boolean) || null, ready: items.every(r => r.ready),
  };
  if (count("held") === n) return [{ ...base, status: "held", pieces: n, noted: items.every(r => r.noted), heldFrom: r0.heldFrom }];
  if (count("van") === n) return [{ ...base, status: "van", pieces: n, vanSince: items.map(r => r.vanSince).filter(Boolean).sort()[0] || null }];
  const blocked = items.filter(r => r.status === "blocked");
  const why = {}; for (const r of blocked) { const k = r.ready ? (r.rack ? `ready on ${r.rack}` : "ready, not racked") : "not ready"; why[k] = (why[k] || 0) + 1; }
  const onVan = count("van");
  return [{ ...base, status: "blocked", pieces: blocked.length, ready: blocked.every(r => r.ready), notReady: blocked.filter(r => !r.ready).length, vanPart: onVan,
    rack: [...new Set(blocked.map(r => r.rack).filter(Boolean))].join(", ") || null,
    location: [...new Set(blocked.map(r => r.location))].join(", "),
    reason: Object.entries(why).map(([k, v]) => `${v} ${k}`).join(", ") + (onVan ? `; ${onVan} on VAN` : "") }];
}

/**
 * The rows for one order: ticket by ticket when it has ticket scans (plus one row for its items not ready yet), otherwise
 * item by item (classify). `rows` are the order's item rows from loadRows; `held` when the order was held over today.
 */
export function orderRows(rows, tickets, transit, today, { held = false } = {}) {
  if (!tickets || !tickets.length) return noTicketRow(rows.map(r => classify(r, transit, today, { held })).filter(Boolean));
  const r0 = rows[0];
  const base = {
    orderId: r0.oid, order: fmtNo(r0.no), orderNo: String(r0.no), store: r0.store, link: smrtLink(r0.cid, r0.no),
    customer: r0.cname || tickets.find(t => t.customer)?.customer || r0.customer || "", customerId: r0.customer || "",
    due: r0.due || null, created: String(r0.created || "").slice(0, 10) || null, orderNote: r0.onote || null,
  };
  // items not ready yet (not in a ticket): one row for the order. While there are any, the order is still being assembled, so
  // its tickets are "In Assembly" (unless already on VAN); once every item is done they're "Ready for Shuttle" (Neal, Oct 20).
  const doneOrder = ASSEMBLED_ORDER.test(String(r0.ostatus || "").replace(/[\s_-]/g, ""));
  const live = rows.filter(r => r.iid && !r.iret && !/^customer$/i.test(String(r.istatus || "").trim()));
  const notReady = doneOrder ? [] : live.filter(r => !r.isAsm && !r.asm);
  const inTickets = live.filter(r => !notReady.includes(r)).map(itemDetail);
  const ticketProd = notReady.length ? "In Assembly" : "Ready for Shuttle";
  const out = [];
  for (const t of tickets) {
    if ((t.storeId && t.storeId === r0.store) || GONE_RACK.test(String(t.location || "").trim())) continue; // at the store, or back with the customer
    const row = {
      ...base, key: "t" + t.id, kind: "ticket", unit: "ticket", pieces: 1, line: t.letter, tag: t.id, ticket: t.id, item: `Ticket ${t.letter || ""}`.trim(),
      customer: t.customer || base.customer, prod: t.location && transit.test(t.location) ? "Ready for Shuttle" : ticketProd, ready: true, rack: t.location || null, location: locOf(t.location, true), details: inTickets,
      scan: { location: t.location || null, store: t.store || null, at: t.at || null, by: t.by || null }, rackStore: t.store || null, rackedAt: t.at || null, rackedBy: t.by || null, note: r0.onote || null,
    };
    if (held) { out.push({ ...row, status: "held", heldFrom: r0.heldFrom || null, noted: !!(r0.onote || rows.some(x => x.inote)), note: r0.onote || rows.find(x => x.inote)?.inote || null }); continue; }
    if (t.location && transit.test(t.location)) { out.push({ ...row, status: "van", vanSince: String(t.at || "").slice(0, 10) < today ? String(t.at).slice(0, 10) : null }); continue; }
    out.push({ ...row, status: "blocked", reason: t.location ? `Ticket at ${t.location}` : "Ticket not scanned" });
  }
  if (notReady.length) {
    const what = [...new Set(notReady.map(r => `${r.istatus ? r.istatus[0].toUpperCase() + r.istatus.slice(1) : "Not scanned"}${r.lot && !/^completed?$/i.test(String(r.lot).trim()) ? ` · ${String(r.lot).toLowerCase()}` : ""}`))].join(", ");
    const row = { ...base, key: "n" + r0.oid, kind: "items", unit: "item", pieces: notReady.length, tag: "", item: itemsLabel(notReady.length),
      prod: what, ready: false, rack: null, location: PLANT, details: notReady.map(itemDetail), note: r0.onote || null };
    out.push(held ? { ...row, status: "held", heldFrom: r0.heldFrom || null, noted: !!(r0.onote || notReady.some(x => x.inote)) } : { ...row, status: "blocked", reason: "Not ready" });
  }
  return out;
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

const WASH_FOLD = /wash\s*(&|and)?\s*fold/i;
const ASSEMBLED_ORDER = /^(assembled|racked|ready|complete|completed)$/i;
const GONE_RACK = /^(returned|delivered)$/i;
export const PLANT = "PLANT";
const cap = x => (x ? x[0].toUpperCase() + x.slice(1) : x);
const isReady = r => !!r.isAsm || !!r.asm || ASSEMBLED_ORDER.test(String(r.ostatus || "").replace(/[\s_-]/g, ""));
const prodOf = r => {
  if (isReady(r)) return "Ready";
  const lot = String(r.lot || "").trim();
  return `${r.istatus ? cap(r.istatus) : "Not scanned"}${lot && !/^completed?$/i.test(lot) ? ` · ${lot.toLowerCase()}` : ""}`;
};
/**
 * Where something is, for the Location column (Neal, Oct 20): the rack it was last scanned to (VAN, PH12…), or PLANT for items
 * that haven't reached assembly yet (not ready, or ready but not racked).
 */
export const locOf = (rack, ready) => (ready && rack ? String(rack).trim().toUpperCase() : PLANT);
/** One item for the details dialog (Items column). */
export function itemDetail(r) {
  const ready = isReady(r);
  return {
    tag: r.barcode || "", line: r.line ?? null, item: [r.type, r.colors].filter(Boolean).join(" · ") || "Item", brand: r.brand || "", dep: r.dep || "",
    prod: prodOf(r), ready, location: locOf(r.rack, ready), rack: r.rack || null, rackStore: r.rackStore || null, rackedAt: r.rackedAt || null, rackedBy: r.rackedBy || null,
    note: r.inote || null,
  };
}
const itemsLabel = k => `${k} item${k === 1 ? "" : "s"}`;

/** One table row for a piece (or an order with no pieces detailed yet), or null when it isn't part of the run any more. */
export function classify(r, transit, today, { held = false } = {}) {
  const base = {
    orderId: r.oid, order: fmtNo(r.no), orderNo: String(r.no), store: r.store, link: smrtLink(r.cid, r.no), customer: r.cname || r.customer || "", customerId: r.customer || "",
    due: r.due || null, created: String(r.created || "").slice(0, 10) || null, orderNote: r.onote || null,
  };
  // Wash & Fold: SMRT's items report never lists the bag (Neal, Oct 19: 26287-5444 was on the van but showed "not detailed";
  // every bag also shares tag 90000000), so its rack can't be seen. A ready bag is listed for the driver to check by hand
  // and doesn't hold up the run; one not ready yet does.
  if (!r.iid && WASH_FOLD.test(String(r.otype || ""))) {
    const ready = ASSEMBLED_ORDER.test(String(r.ostatus || "").replace(/[\s_-]/g, ""));
    const wf = { ...base, key: "o" + r.oid, kind: "wf", pieces: 1, item: "Wash & Fold bag", prod: ready ? "Ready" : (r.ostatus ? r.ostatus[0].toUpperCase() + r.ostatus.slice(1) : "Not ready"), ready, rack: null, location: ready ? null : PLANT, note: r.onote || null };
    if (held) return { ...wf, status: "held", heldFrom: r.heldFrom || null, noted: !!r.onote };
    return ready ? { ...wf, status: "wf", reason: "Check by hand: SMRT doesn't report where W&F bags are racked" } : { ...wf, status: "blocked", reason: "Wash & Fold not ready" };
  }
  if (!r.iid) { // the order hasn't been detailed: SMRT only knows how many pieces
    if (held) return { ...base, key: "o" + r.oid, kind: "order", status: "held", pieces: r.opieces || 0, item: `${r.opieces || "?"} pieces, not detailed`, prod: "Not detailed", rack: null, location: PLANT,
      heldFrom: r.heldFrom || null, noted: !!r.onote, note: r.onote || null };
    return { ...base, key: "o" + r.oid, kind: "order", status: "blocked", pieces: r.opieces || 0, item: `${r.opieces || "?"} pieces, not detailed`, prod: "Not detailed",
      rack: null, location: PLANT, reason: "Not detailed yet", note: r.onote || null };
  }
  if (r.iret || GONE_RACK.test(String(r.rack || "").trim()) || /^customer$/i.test(String(r.istatus || "").trim())) return null; // with the customer
  if (r.rackStoreId && r.rackStoreId === r.store) return null; // already racked at the store (an earlier run)
  const ready = isReady(r);
  const prod = prodOf(r);
  const item = [r.type, r.colors].filter(Boolean).join(" · ") || "Piece";
  const onVan = !!r.rack && transit.test(r.rack);
  const p = {
    ...base, key: r.iid, kind: "piece", pieces: 1, line: r.line, tag: r.barcode || "", item, brand: r.brand || "", dep: r.dep || "", prod, ready,
    rack: r.rack || null, rackStore: r.rackStore || null, rackedAt: r.rackedAt || null, rackedBy: r.rackedBy || null, note: r.inote || null,
    location: locOf(r.rack, ready), details: [itemDetail(r)],
  };
  if (held) return { ...p, status: "held", heldFrom: r.heldFrom || null, noted: !!(r.inote || r.onote), note: r.inote || r.onote || null };
  if (onVan) return { ...p, status: "van", vanSince: r.rackedAt && String(r.rackedAt).slice(0, 10) < today ? String(r.rackedAt).slice(0, 10) : null };
  return { ...p, status: "blocked", reason: !ready ? "Not ready" : r.rack ? `Ready, on ${r.rack}` : "Ready, not racked" };
}

const ORDER = { blocked: 0, held: 1, wf: 2, van: 3 };
export const sortRows = rows => rows.sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (a.status === "held" ? (a.noted - b.noted) : 0)
  || String(a.orderNo).localeCompare(String(b.orderNo)) || String(a.line ?? "").localeCompare(String(b.line ?? ""), undefined, { numeric: true }));

/**
 * Where a row not on VAN is in production (Neal, Oct 20: tiles for Detailed, In Assembly, Ready for Shuttle):
 *   detailed   items not through assembly yet (and orders not detailed yet)
 *   assembly   tickets of an order still being assembled
 *   ready      tickets ready for the shuttle, and finished items not in a ticket, not on VAN yet
 * Returns counts per stage: { detailed: {items, tickets}, ... }. Held-over, W&F and VAN rows aren't counted here.
 */
export function stagesOf(r, transit) {
  const out = {};
  const add = (st, k, n = 1) => { const x = out[st] || (out[st] = { items: 0, tickets: 0 }); x[k] += n; };
  if (r.status !== "blocked") return out;
  if (r.kind === "ticket") add(r.prod === "In Assembly" ? "assembly" : "ready", "tickets");
  else if (r.kind === "order") add("detailed", "items", r.pieces || 0);
  else for (const d of r.details || []) { if (d.location && transit && transit.test(d.location)) continue; add(d.ready ? "ready" : "detailed", "items"); }
  return out;
}

function summarize(rows) {
  const s = { pieces: 0, van: 0, blocked: 0, notReady: 0, held: 0, heldNoNote: 0, vanEarlier: 0, wf: 0, vanTickets: 0, blockedTickets: 0,
    stages: { detailed: { items: 0, tickets: 0 }, assembly: { items: 0, tickets: 0 }, ready: { items: 0, tickets: 0 } } };
  for (const r of rows) for (const [st, c] of Object.entries(r.stages || {})) { s.stages[st].items += c.items; s.stages[st].tickets += c.tickets; }
  for (const r of rows) {
    if (r.status === "van") { s.van += r.pieces || 1; s.pieces += r.pieces || 1; if (r.vanSince) s.vanEarlier++; if (r.kind === "ticket") s.vanTickets++; }
    else if (r.status === "blocked") { s.blocked += r.pieces; s.pieces += r.pieces + (r.vanPart || 0); s.van += r.vanPart || 0; s.notReady += r.notReady ?? (r.ready ? 0 : r.pieces); if (r.kind === "ticket") s.blockedTickets++; }
    else if (r.status === "wf") { s.wf++; s.pieces++; }
    else if (r.status === "held") { s.held += r.pieces; if (!r.noted) s.heldNoNote += r.pieces; }
  }
  // OK to leave = everything due is on VAN. A held-over order without a note still needs one, but it doesn't hold
  // the van (Neal, Oct 19): the page shows it in yellow, not red.
  s.ok = s.blocked === 0;
  s.nothing = s.pieces === 0 && s.held === 0;
  return s;
}

async function freshness(db) {
  const last = await db.prepare(`SELECT finished_at AS at, message FROM int_sync_runs WHERE integration_id='smrt' AND status='ok'
      AND (message LIKE 'live%' OR message LIKE 'check now%' OR message LIKE 'racks%') ORDER BY finished_at DESC LIMIT 1`).first();
  const running = await db.prepare(`SELECT started_at AS at, message FROM int_sync_runs WHERE integration_id='smrt' AND status='running' AND started_at>=?
      ORDER BY started_at DESC LIMIT 1`).bind(new Date(Date.now() - 4 * 60e3).toISOString()).first();
  return { asOf: last ? last.at : null, how: last ? (/^(check|racks \(check)/.test(last.message) ? "check" : /^racks/.test(last.message) ? "scans" : "sync") : null, checking: running && /^(check|racks \(check)/.test(running.message) ? running.at : null };
}

/** All rows: each order's item rows grouped and turned into ticket / item rows. */
export function buildRows(due, held, tickets, transit, today) {
  const byOrder = (rows) => { const m = new Map(); for (const r of rows) (m.get(r.oid) || m.set(r.oid, []).get(r.oid)).push(r); return m; };
  const out = [];
  for (const [, rows] of byOrder(due)) out.push(...orderRows(rows, tickets.get(String(rows[0].no)), transit, today));
  for (const [, rows] of byOrder(held)) out.push(...orderRows(rows, tickets.get(String(rows[0].no)), transit, today, { held: true }));
  return out;
}

/** Every shuttle store's totals, and the full list for one store (`storeId`). */
export async function shuttleView(db, env, { storeId = null, at = new Date() } = {}) {
  const today = localNow(env.TIMEZONE, at).day;
  const groups = await loadGroups(db, env.ORG_ID);
  const transitName = String(groups.smrt.transitRack || "Van").trim() || "Van";
  const transit = new RegExp(`^\\s*${transitName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const stores = await shuttleStores(db, env.ORG_ID);
  if (storeId && !stores.some(s => s.id === storeId)) throw new HttpError(404, "That store isn't on a shuttle run (Settings › Shuttle runs).");
  const { due, held, tickets } = await loadRows(db, env.ORG_ID, stores.map(s => s.id), today);
  const all = buildRows(due, held, tickets, transit, today).map(r => ({ ...r, stages: stagesOf(r, transit) }));
  const rowsOf = id => sortRows(all.filter(r => r.store === id));
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
  // ticket scans are read first by netex-sync (seconds); only orders still holding up the run without ticket scans need their
  // created days re-read (items not ready, orders not detailed), plus today
  const { due, held, tickets } = await loadRows(db, env.ORG_ID, [store.id], today);
  const open = buildRows(due, held, tickets, transit, today).filter(c => c.kind !== "ticket" && (c.status === "blocked" || (c.status === "held" && !c.noted)));
  const days = [...new Set(open.map(c => c.created).filter(Boolean))].sort();
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
