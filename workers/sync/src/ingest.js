// Stores one SMRT created-day: its orders and every piece, matched to what's already stored.
// - Unchanged rows (same fingerprint) are skipped, so re-reading a day costs almost no writes.
// - Changes to existing orders/pieces are logged in pos_changes with old and new values:
//   due date, order note, item note, status, piece moved to another order, piece added or removed.
// - In 'live' mode a due date moved later opens a follow-up (noted if SMRT already has a note).
//   'backfill' mode loads history quietly: no follow-ups.
import { ulid, sha1, nowIso, text, int, num, bool, stamp, storeName } from "./util.js";

const norm = s => String(s || "").toLowerCase().replace(/[\s_\-]/g, "");
const DONE = new Set(["ready", "complete", "completed", "pickedup", "delivered", "paid", "returned", "collected", "closed", "finished"]);
const CLOSED = new Set(["pickedup", "delivered", "returned", "collected", "closed", "deleted", "disabled", "voided", "void", "cancelled", "canceled"]);
const VOID = new Set(["deleted", "disabled", "voided", "void", "cancelled", "canceled"]);
const ASSEMBLED = new Set(["assembled", "racked", "customer"]);
const CHUNK = 90;            // ids per IN (...) lookup (D1 allows 100 bound values)
const BATCH = 100;           // statements per D1 batch
const BARCODE_DAYS = 180;    // a barcode seen within this many days is the same piece
// Bumped when a new piece column is stored, so every piece is rewritten once the next time its day is read
// (v2, Oct 18: last racked store, item return date).
const ITEM_HASH = "v2|";

/** The customer's name from whichever name column the report has (SMRT lets the report's columns be chosen). */
export function customerName(...rows) {
  for (const r of rows) {
    if (!r) continue;
    for (const k of ["Customer Name", "Customer name", "Customer Full Name", "Customer", "Name", "Full Name"]) { const v = text(r[k]); if (v) return v.slice(0, 80); }
    const first = text(r["First Name"] ?? r["Customer First Name"] ?? r["First name"]), last = text(r["Last Name"] ?? r["Customer Last Name"] ?? r["Last name"]);
    if (first || last) return [first, last].filter(Boolean).join(" ").slice(0, 80);
  }
  return null;
}

const chunks = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const orderNo = v => String(v ?? "").replace(/\D/g, "");

// lookup tables (statuses, departments, item types, staff, locations), created on first sight
export class Lookups {
  constructor(db, orgId) { this.db = db; this.org = orgId; this.maps = {}; this.pending = []; }
  async load() {
    const q = async (sql) => (await this.db.prepare(sql).bind(this.org).all()).results;
    this.maps.os = new Map((await q("SELECT id, name, is_done, is_closed, is_void FROM pos_order_statuses WHERE org_id=?")).map(r => [r.name, r]));
    this.maps.is = new Map((await q("SELECT id, name, is_assembled FROM pos_item_statuses WHERE org_id=?")).map(r => [r.name, r]));
    this.maps.dep = new Map((await q("SELECT id, name FROM pos_departments WHERE org_id=?")).map(r => [r.name, r.id]));
    this.maps.type = new Map((await q("SELECT id, name FROM pos_item_types WHERE org_id=?")).map(r => [r.name, r.id]));
    this.maps.staff = new Map((await q("SELECT id, smrt_name FROM pos_staff WHERE org_id=?")).map(r => [r.smrt_name, r.id]));
    this.maps.loc = new Map((await q("SELECT id, name FROM core_locations WHERE org_id=?")).map(r => [r.name, r.id]));
    return this;
  }
  _add(sql, ...args) { this.pending.push(this.db.prepare(sql).bind(...args)); }
  orderStatus(name) {
    name = text(name) || "unknown"; let r = this.maps.os.get(name);
    if (!r) { const n = norm(name); r = { id: ulid(), name, is_done: +DONE.has(n), is_closed: +CLOSED.has(n), is_void: +VOID.has(n) }; this.maps.os.set(name, r);
      this._add("INSERT INTO pos_order_statuses(id,org_id,name,is_done,is_closed,is_void) VALUES(?,?,?,?,?,?)", r.id, this.org, name, r.is_done, r.is_closed, r.is_void); }
    return r;
  }
  itemStatus(name) {
    name = text(name); if (!name) return null; let r = this.maps.is.get(name);
    if (!r) { r = { id: ulid(), name, is_assembled: +ASSEMBLED.has(norm(name)) }; this.maps.is.set(name, r);
      this._add("INSERT INTO pos_item_statuses(id,org_id,name,is_assembled) VALUES(?,?,?,?)", r.id, this.org, name, r.is_assembled); }
    return r;
  }
  _simple(map, table, col, name) {
    let id = this.maps[map].get(name);
    if (!id) { id = ulid(); this.maps[map].set(name, id); this._add(`INSERT INTO ${table}(id,org_id,${col}) VALUES(?,?,?)`, id, this.org, name); }
    return id;
  }
  department(name) { return this._simple("dep", "pos_departments", "name", text(name) || "Other"); }
  itemType(name) { return this._simple("type", "pos_item_types", "name", text(name) || "Item"); }
  staff(name) { name = text(name); return name ? this._simple("staff", "pos_staff", "smrt_name", name) : null; }
  location(raw) {
    const name = storeName(raw); if (!name) return null; let id = this.maps.loc.get(name);
    if (!id) { id = ulid(); this.maps.loc.set(name, id); this._add("INSERT INTO core_locations(id,org_id,name,kind,pos_name) VALUES(?,?,?,?,?)", id, this.org, name, "store", text(raw)); }
    return id;
  }
  take() { const p = this.pending; this.pending = []; return p; }
}

async function runBatches(db, stmts) { for (const c of chunks(stmts, BATCH)) if (c.length) await db.batch(c); }

async function existingOrders(db, orgId, nos) {
  const out = new Map();
  for (const c of chunks(nos, CHUNK)) {
    const r = await db.prepare(`SELECT o.id, o.smrt_order_no, o.row_hash, o.due_at, o.notes, o.status_id, s.name AS status_name, s.is_done
      FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id WHERE o.org_id=? AND o.smrt_order_no IN (${c.map(() => "?").join(",")})`).bind(orgId, ...c).all();
    for (const x of r.results) out.set(x.smrt_order_no, x);
  }
  return out;
}
/**
 * Which stored row is this piece? Tags are reused: a customer's jeans keep the same barcode visit after visit (Neal, Oct 13:
 * the day's starch bottoms count jumped 324 → 354 → 336 as rows flipped between last week's order and today's). So:
 *  - a row on the same order is this piece;
 *  - a row on another order is the same piece moved there (SMRT's Split) only when it was created within a day of this one;
 *  - otherwise it's an earlier visit with the same tag, and this piece gets its own row.
 * When a piece is moved to another order, SMRT's report keeps BOTH rows: the old order's (with a removal date) and the new
 * order's (Neal, Oct 18: dress 4409995 on 26281-2845 removed and 26281-3166 racked G LONG). Each report row keeps its own
 * stored row: a stored row is never matched twice in one read (`claimed`), and a row on an order the report still lists
 * with this tag isn't taken as "moved" (`stillThere`). Before this, the two rows took turns owning one stored row every sync.
 */
function samePiece(rows, orderId, createdAt, { claimed = new Set(), stillThere = () => false } = {}) {
  if (!rows || !rows.length) return null;
  const free = rows.filter(x => !claimed.has(x.id));
  const same = free.find(x => x.order_id === orderId); if (same) return same;
  const t = Date.parse(createdAt);
  const near = free.filter(x => isFinite(t) && Math.abs(Date.parse(x.smrt_created_at) - t) < 864e5 && !stillThere(x));
  return near.length ? near[near.length - 1] : null;
}
async function existingItems(db, orgId, barcodes, sinceIso) {
  const out = new Map();
  for (const c of chunks(barcodes, CHUNK)) {
    const r = await db.prepare(`SELECT i.id, i.barcode, i.order_id, i.row_hash, i.notes, i.removed_at, i.smrt_created_at FROM pos_items i JOIN pos_orders o ON o.id=i.order_id
      WHERE o.org_id=? AND i.smrt_created_at >= ? AND i.barcode IN (${c.map(() => "?").join(",")}) ORDER BY i.smrt_created_at`).bind(orgId, sinceIso, ...c).all();
    for (const x of r.results) (out.get(x.barcode) || out.set(x.barcode, []).get(x.barcode)).push(x); // every row with that tag, oldest first
  }
  return out;
}

/** Stored lines with no barcode on these orders, grouped by order | item type | created time, in the order they were stored. */
async function blankItems(db, orderIds) {
  const out = new Map();
  for (const c of chunks(orderIds, CHUNK)) {
    const r = await db.prepare(`SELECT id, order_id, item_type_id, line_no, row_hash, notes, removed_at, smrt_created_at FROM pos_items
      WHERE COALESCE(barcode,'')='' AND order_id IN (${c.map(() => "?").join(",")}) ORDER BY rowid`).bind(...c).all();
    for (const x of r.results) { const k = `${x.order_id}|${x.item_type_id}|${x.smrt_created_at}`; (out.get(k) || out.set(k, []).get(k)).push(x); }
  }
  return out;
}

/**
 * @param db      D1 database (or the test adapter)
 * @param ctx     { orgId, runId, mode: 'live' | 'backfill', userId? }
 * @param orders  rows of the orders report for one created day (objects keyed by column name)
 * @param items   rows of the items report for the same created day
 */
export async function ingestDay(db, ctx, orders, items) {
  const L = ctx.lookups || (ctx.lookups = await new Lookups(db, ctx.orgId).load());
  const now = nowIso(), stats = { orders: 0, items: 0, ordersWritten: 0, itemsWritten: 0, changes: 0, followups: 0 };
  const writes = [];
  const change = (orderId, itemId, kind, oldV, newV) => {
    const id = ulid(); stats.changes++;
    writes.push(db.prepare("INSERT INTO pos_changes(id,order_id,item_id,kind,old_value,new_value,detected_at,sync_run_id) VALUES(?,?,?,?,?,?,?,?)")
      .bind(id, orderId, itemId, kind, oldV ?? null, newV ?? null, now, ctx.runId)); return id;
  };

  // pieces grouped by order; order-level facts that only the items report carries
  const bySale = new Map();
  for (const r of items) { const no = orderNo(r["Sale Id"]); if (!no) continue; (bySale.get(no) || bySale.set(no, []).get(no)).push(r); }
  const firstOf = (rows, col) => { for (const r of rows || []) { const v = stamp(r[col]); if (v) return v; } return null; };

  const nos = [...new Set(orders.map(r => orderNo(r["ID"])).filter(Boolean))];
  const known = await existingOrders(db, ctx.orgId, nos);
  const orderIds = new Map();

  for (const r of orders) {
    const no = orderNo(r["ID"]); if (!no) continue; stats.orders++;
    const its = bySale.get(no) || [];
    const st = L.orderStatus(r["Status"]);
    const deps = String(r["Financial department(s)"] || "").split(",").map(s => s.trim()).filter(Boolean);
    const v = {
      status_id: st.id, order_type: text(r["Order Type"]), customer_ref: text(r["Customer Id"]),
      return_location_id: L.location(r["Return Location"]), drop_location_id: L.location(r["Agent"]),
      is_route_delivery: bool(r["Is Route Delivery"]), is_route_pickup: bool(r["Is Route Pickup"]),
      piece_count: int(r["Piece Count"]), original_piece_count: int(r["Original Piece Count"]),
      weight_in_lbs: num(r["Weight In"]), weight_out_lbs: num(r["Weight Out"]),
      notes: firstOf(its, "Order Notes"), customer_internal_id: firstOf(its, "Customer Internal ID"),
      customer_name: customerName(r, ...its),
      before_discount_cents: int(r["Before Discount Amount"]), discount_cents: int(r["Discounted Amount"]), surcharge_cents: int(r["Surcharge Amount"]),
      taxable_cents: int(r["Taxable Amount"]), tax_cents: int(r["Total Tax"]), price_cents: int(r["Price"]), paid_cents: int(r["Paid amount (inc. deposits)"]),
      payment_setting: text(r["Payment Setting"]), promotion: text(r["Promotion"]),
      created_by_staff_id: L.staff(r["Created by"]), detailed_by_staff_id: L.staff(r["Detailed by"]),
      smrt_created_at: stamp(r["Created"]) || ctx.day, detailed_at: stamp(r["Detailed date"]), due_at: stamp(r["Due date"]),
      assembled_at: stamp(r["Assembly date"]), ready_at: stamp(r["Ready date"]) || firstOf(its, "Ready date"),
      returned_at: stamp(r["Returned date"]) || firstOf(its, "Returned date"), picked_up_at: firstOf(its, "Picked up date"),
      delivered_at: firstOf(its, "Delivered date"), paid_at: stamp(r["Paid date"]), smrt_deleted_at: stamp(r["Deleted date"]),
    };
    const hash = await sha1(JSON.stringify([r, v.notes, v.picked_up_at, v.delivered_at, v.customer_internal_id, v.customer_name]));
    const old = known.get(no);
    if (old) {
      orderIds.set(no, { id: old.id, existed: true });
      if (old.row_hash === hash) continue;
      if ((old.due_at || "") !== (v.due_at || "")) {
        const cid = change(old.id, null, "due_changed", old.due_at, v.due_at);
        if (ctx.mode === "live" && v.due_at && old.due_at && v.due_at > old.due_at && !st.is_done && !st.is_void) {
          const noted = !!(v.notes || its.some(x => text(x["Item Notes"])));
          writes.push(db.prepare("INSERT INTO plan_followups(id,order_id,kind,change_id,status) VALUES(?,?,?,?,?)").bind(ulid(), old.id, "due_moved", cid, noted ? "noted" : "needs_note"));
          stats.followups++;
        }
      }
      if ((old.notes || "") !== (v.notes || "")) change(old.id, null, "order_note", old.notes, v.notes);
      if (old.status_id !== st.id) change(old.id, null, st.is_void ? "order_deleted" : "status_changed", old.status_name, st.name);
      const cols = Object.keys(v);
      writes.push(db.prepare(`UPDATE pos_orders SET ${cols.map(c => c + "=?").join(",")}, extra_json=?, row_hash=?, last_sync_id=?, updated_at=?, rev=rev+1 WHERE id=?`)
        .bind(...cols.map(c => v[c]), null, hash, ctx.runId, now, old.id));
    } else {
      const id = ulid(); orderIds.set(no, { id, existed: false });
      const cols = Object.keys(v);
      writes.push(db.prepare(`INSERT INTO pos_orders(id,org_id,smrt_order_no,${cols.join(",")},row_hash,first_sync_id,last_sync_id) VALUES(?,?,?,${cols.map(() => "?").join(",")},?,?,?)`)
        .bind(id, ctx.orgId, no, ...cols.map(c => v[c]), hash, ctx.runId, ctx.runId));
    }
    stats.ordersWritten++;
    const oid = orderIds.get(no).id;
    writes.push(db.prepare("DELETE FROM pos_order_departments WHERE order_id=?").bind(oid));
    for (const d of new Set(deps)) writes.push(db.prepare("INSERT INTO pos_order_departments(order_id,department_id) VALUES(?,?)").bind(oid, L.department(d)));
  }

  // pieces: matched by barcode (a piece moved to another order keeps its row)
  const since = new Date(Date.parse((ctx.day || now.slice(0, 10)) + "T00:00:00Z") - BARCODE_DAYS * 864e5).toISOString().slice(0, 10);
  const barcodes = [...new Set(items.map(r => text(r["Barcode"])).filter(Boolean))];
  const knownItems = await existingItems(db, ctx.orgId, barcodes, since);
  const lineNo = new Map();
  // every piece's order first, so "is this tag still on that order in the report?" can be answered for any stored row
  const orderOf = new Map();
  for (const r of items) {
    const no = orderNo(r["Sale Id"]); if (orderOf.has(no)) continue;
    let o = orderIds.get(no);
    if (!o) { // piece whose order row is on another created day: look it up
      const ex = (await existingOrders(db, ctx.orgId, [no])).get(no);
      if (ex) { o = { id: ex.id, existed: true }; orderIds.set(no, o); }
    }
    orderOf.set(no, o || null);
  }
  const inReport = new Set();
  for (const r of items) { const o = orderOf.get(orderNo(r["Sale Id"])); const b = text(r["Barcode"]); if (o && b) inReport.add(`${b}|${o.id}`); }
  const claimed = new Set();
  const stillThere = x => inReport.has(`${x.barcode}|${x.order_id}`);
  // Lines with no tag number ("Describe and Price" placeholders, employee discounts, retail bags) can't be matched by
  // barcode. They're matched on the same order by item type and created time, same line first. Before Oct 22 they
  // weren't matched at all, so every sync added another copy (26289-6547 had 385 phantom DC tops).
  const blankRows = await blankItems(db, [...new Set([...orderOf.values()].filter(o => o && o.existed).map(o => o.id))]);
  const blankKey = (orderId, typeId, created) => `${orderId}|${typeId}|${created}`;
  const blankFree = (orderId, typeId, created, ln) => {
    const rows = (blankRows.get(blankKey(orderId, typeId, created)) || []).filter(x => !claimed.has(x.id));
    return rows.find(x => x.line_no === ln) || rows[0] || null;
  };
  for (const r of items) {
    const no = orderNo(r["Sale Id"]); const o = orderOf.get(no);
    if (!o) continue;
    stats.items++;
    const ln = (lineNo.get(no) || 0) + 1; lineNo.set(no, ln);
    const ist = L.itemStatus(r["Item Status"]);
    const v = {
      order_id: o.id, barcode: text(r["Barcode"]), line_no: ln, item_type_id: L.itemType(r["Item Type"]), department_id: L.department(r["Financial department"]),
      status_id: ist ? ist.id : null, lot_status: text(r["Lot status"]), category: text(r["Category"]), classification: text(r["Classification"]),
      description: text(r["Item Description"]), notes: text(r["Item Notes"]), special_cares: text(r["Special cares"]), brand: text(r["Brand"]),
      colors: text(r["Colors"]), fabrics: text(r["Fabrics"]), pattern: text(r["Pattern"]),
      detailed_by_staff_id: L.staff(r["Detailed by"]), assembled_by_staff_id: L.staff(r["Assembled by"]), racked_by_staff_id: L.staff(r["Last racked by"]),
      last_rack_location: text(r["Last Rack Location"]), smrt_created_at: stamp(r["Created"]) || ctx.day, detailed_at: stamp(r["Item detail date"]) || stamp(r["Detailed date"]),
      assembled_at: stamp(r["Item assembly date"]), racked_at: stamp(r["Last racked on date"]), removed_at: stamp(r["Item removal date"]),
      last_rack_store_id: L.location(r["Last racked store"]), returned_at: stamp(r["Item return date"]),
      base_cents: int(r["Item base price"]), upcharge_cents: int(r["Up Charge Amount"]), discount_cents: int(r["Discounted amount"]), price_cents: int(r["Price"]),
    };
    const hash = await sha1(ITEM_HASH + JSON.stringify(r));
    const old = v.barcode ? samePiece(knownItems.get(v.barcode), o.id, v.smrt_created_at, { claimed, stillThere })
      : blankFree(o.id, v.item_type_id, v.smrt_created_at, ln);
    if (old) claimed.add(old.id);
    const cols = Object.keys(v);
    if (old) {
      if (old.row_hash === hash && old.order_id === o.id) continue;
      if (old.order_id !== o.id) change(o.id, old.id, "item_moved", old.order_id, o.id);
      if ((old.notes || "") !== (v.notes || "")) change(o.id, old.id, "item_note", old.notes, v.notes);
      if (!old.removed_at && v.removed_at) change(o.id, old.id, "item_removed", null, v.removed_at);
      writes.push(db.prepare(`UPDATE pos_items SET ${cols.map(c => c + "=?").join(",")}, row_hash=?, last_sync_id=?, updated_at=?, rev=rev+1 WHERE id=?`)
        .bind(...cols.map(c => v[c]), hash, ctx.runId, now, old.id));
    } else {
      const id = ulid();
      writes.push(db.prepare(`INSERT INTO pos_items(id,${cols.join(",")},row_hash,last_sync_id) VALUES(?,${cols.map(() => "?").join(",")},?,?)`)
        .bind(id, ...cols.map(c => v[c]), hash, ctx.runId));
      if (o.existed && ctx.mode === "live") change(o.id, id, "item_added", null, v.barcode);
      if (v.barcode) (knownItems.get(v.barcode) || knownItems.set(v.barcode, []).get(v.barcode)).push({ id, barcode: v.barcode, order_id: o.id, row_hash: hash, notes: v.notes, removed_at: v.removed_at, smrt_created_at: v.smrt_created_at });
      claimed.add(id);
    }
    stats.itemsWritten++;
  }

  // Extra copies of an untagged line: a stored row nobody claimed, when another row with the same order, item type and
  // created time was claimed in this read. Removed with the "piece added" changes they made.
  for (const rows of blankRows.values()) {
    if (!rows.some(x => claimed.has(x.id))) continue; // that line wasn't in this read; leave it
    for (const x of rows) {
      if (claimed.has(x.id)) continue;
      writes.push(db.prepare("DELETE FROM plan_followups WHERE item_id=? OR change_id IN (SELECT id FROM pos_changes WHERE item_id=?)").bind(x.id, x.id));
      writes.push(db.prepare("DELETE FROM pos_changes WHERE item_id=?").bind(x.id));
      writes.push(db.prepare("DELETE FROM pos_items WHERE id=?").bind(x.id));
      stats.duplicatesRemoved = (stats.duplicatesRemoved || 0) + 1;
    }
  }

  // new lookup rows first (orders reference them), then everything else
  await runBatches(db, [...L.take(), ...writes]);
  return stats;
}

/**
 * Payments only. A picked-up order is never read again by the normal sync, but statement and AutoPay customers often
 * pay after pickup. Once a day the live sync re-reads the orders report (orders only, no pieces) for the last
 * PAYMENT_LOOKBACK_DAYS and updates what was paid, when, and the order's price, tax and status. Nothing else is touched,
 * so notes, due dates and pieces keep their full change history from the normal sync.
 */
export const PAYMENT_LOOKBACK_DAYS = 62;
export async function refreshPayments(db, ctx, orders) {
  const L = ctx.lookups || (ctx.lookups = await new Lookups(db, ctx.orgId).load());
  const nos = [...new Set(orders.map(r => orderNo(r["ID"])).filter(Boolean))];
  const known = new Map();
  for (const c of chunks(nos, CHUNK)) {
    const r = await db.prepare(`SELECT id, smrt_order_no AS no, status_id, price_cents, tax_cents, taxable_cents, paid_cents, paid_at, smrt_deleted_at
      FROM pos_orders WHERE org_id=? AND smrt_order_no IN (${c.map(() => "?").join(",")})`).bind(ctx.orgId, ...c).all();
    for (const x of r.results) known.set(x.no, x);
  }
  const now = nowIso(), writes = []; let changed = 0;
  for (const r of orders) {
    const old = known.get(orderNo(r["ID"])); if (!old) continue;   // not stored yet: the normal sync or history will bring it in
    const v = { status_id: L.orderStatus(r["Status"]).id, price_cents: int(r["Price"]), tax_cents: int(r["Total Tax"]), taxable_cents: int(r["Taxable Amount"]),
      paid_cents: int(r["Paid amount (inc. deposits)"]), paid_at: stamp(r["Paid date"]), smrt_deleted_at: stamp(r["Deleted date"]) };
    const cols = Object.keys(v).filter(k => (old[k] ?? null) !== (v[k] ?? null));
    if (!cols.length) continue;
    changed++;
    writes.push(db.prepare(`UPDATE pos_orders SET ${cols.map(c => c + "=?").join(",")}, last_sync_id=?, updated_at=?, rev=rev+1 WHERE id=?`)
      .bind(...cols.map(c => v[c]), ctx.runId, now, old.id));
  }
  await runBatches(db, [...L.take(), ...writes]);
  return { read: orders.length, changed };
}
