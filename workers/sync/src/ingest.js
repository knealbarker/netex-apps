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
async function existingItems(db, orgId, barcodes, sinceIso) {
  const out = new Map();
  for (const c of chunks(barcodes, CHUNK)) {
    const r = await db.prepare(`SELECT i.id, i.barcode, i.order_id, i.row_hash, i.notes, i.removed_at FROM pos_items i JOIN pos_orders o ON o.id=i.order_id
      WHERE o.org_id=? AND i.smrt_created_at >= ? AND i.barcode IN (${c.map(() => "?").join(",")}) ORDER BY i.smrt_created_at`).bind(orgId, sinceIso, ...c).all();
    for (const x of r.results) out.set(x.barcode, x); // newest wins
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
      notes: firstOf(its, "Order Notes"),
      before_discount_cents: int(r["Before Discount Amount"]), discount_cents: int(r["Discounted Amount"]), surcharge_cents: int(r["Surcharge Amount"]),
      taxable_cents: int(r["Taxable Amount"]), tax_cents: int(r["Total Tax"]), price_cents: int(r["Price"]), paid_cents: int(r["Paid amount (inc. deposits)"]),
      payment_setting: text(r["Payment Setting"]), promotion: text(r["Promotion"]),
      created_by_staff_id: L.staff(r["Created by"]), detailed_by_staff_id: L.staff(r["Detailed by"]),
      smrt_created_at: stamp(r["Created"]) || ctx.day, detailed_at: stamp(r["Detailed date"]), due_at: stamp(r["Due date"]),
      assembled_at: stamp(r["Assembly date"]), ready_at: stamp(r["Ready date"]) || firstOf(its, "Ready date"),
      returned_at: stamp(r["Returned date"]) || firstOf(its, "Returned date"), picked_up_at: firstOf(its, "Picked up date"),
      delivered_at: firstOf(its, "Delivered date"), paid_at: stamp(r["Paid date"]), smrt_deleted_at: stamp(r["Deleted date"]),
    };
    const hash = await sha1(JSON.stringify([r, v.notes, v.picked_up_at, v.delivered_at]));
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
  for (const r of items) {
    const no = orderNo(r["Sale Id"]); let o = orderIds.get(no);
    if (!o) { // piece whose order row is on another created day: look it up
      const ex = (await existingOrders(db, ctx.orgId, [no])).get(no); if (!ex) continue;
      o = { id: ex.id, existed: true }; orderIds.set(no, o);
    }
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
      base_cents: int(r["Item base price"]), upcharge_cents: int(r["Up Charge Amount"]), discount_cents: int(r["Discounted amount"]), price_cents: int(r["Price"]),
    };
    const hash = await sha1(JSON.stringify(r));
    const old = v.barcode ? knownItems.get(v.barcode) : null;
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
      if (v.barcode) knownItems.set(v.barcode, { id, barcode: v.barcode, order_id: o.id, row_hash: hash, notes: v.notes, removed_at: v.removed_at });
    }
    stats.itemsWritten++;
  }

  // new lookup rows first (orders reference them), then everything else
  await runBatches(db, [...L.take(), ...writes]);
  return stats;
}
