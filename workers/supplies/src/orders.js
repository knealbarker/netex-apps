// Vendor orders: what the Workshop is short on (from its latest counts), grouped by vendor with lead time and minimum,
// and the orders the supply manager has placed by phone or web.
import { HttpError, ulid, nowIso, audit } from "../../planner/src/util.js";
import { requireRole } from "../../planner/src/auth.js";
import { orderQty, cleanQty, localToday, addWorkDays } from "./logic.js";
import { locations, vendors, items as allItems } from "./catalog.js";
import { latestLines } from "./counts.js";

const today = env => localToday(env.TIMEZONE, env.NOW ? new Date(env.NOW) : new Date());

async function orderLines(db, ids) {
  if (!ids.length) return new Map();
  const rows = (await db.prepare(`SELECT l.id, l.order_id, l.item_id AS item, COALESCE(i.name, l.label) AS name, i.vendor_sku AS sku, COALESCE(i.bulk_unit, i.unit) AS unit,
      l.qty, l.unit_cost_cents / 100.0 AS unitCost FROM supply_order_lines l LEFT JOIN supply_items i ON i.id = l.item_id
      WHERE l.order_id IN (${ids.map(() => "?").join(",")}) ORDER BY l.sort`).bind(...ids).all()).results;
  const by = new Map(ids.map(id => [id, []]));
  for (const r of rows) by.get(r.order_id).push(r);
  return by;
}

/** When each item was last put on an order (not cancelled), and whether that order is still open. */
async function lastOrdered(db, env) {
  return new Map((await db.prepare(`SELECT l.item_id, MAX(o.ordered_at) AS at, MAX(CASE WHEN o.status='ordered' THEN 1 ELSE 0 END) AS open
      FROM supply_order_lines l JOIN supply_orders o ON o.id = l.order_id WHERE o.org_id=? AND o.status <> 'cancelled' AND l.item_id IS NOT NULL GROUP BY l.item_id`)
    .bind(env.ORG_ID).all()).results.map(r => [r.item_id, r]));
}

export async function orders(db, env, { days = 30 } = {}) {
  const ws = (await locations(db, env, { all: true })).find(l => l.role === "warehouse");
  const vs = await vendors(db, env), its = await allItems(db, env);
  const latest = ws ? await latestLines(db, env, ws.id) : new Map();
  const ordered = await lastOrdered(db, env);
  const t = today(env);

  // suggestions: Workshop items whose latest count is short, unless ordered since that count
  const suggest = [], onOrder = [];
  for (const it of its) {
    const p = ws && it.pars[ws.id]; if (!p) continue;
    const l = latest.get(it.id); if (!l || !(l.need > 0)) continue;
    const o = ordered.get(it.id);
    const row = { item: it.id, name: it.name, sku: it.sku, unit: it.bulkUnit || it.unit, vendorId: it.vendorId, category: it.category,
      onHand: l.qty, level: l.level, par: p.par, reorder: p.reorder, need: l.need, qty: orderQty(l.need), unitCost: it.unitCost, countedAt: l.at };
    if (o && o.at >= l.at) { if (o.open) onOrder.push({ ...row, orderedAt: o.at }); continue; }
    suggest.push(row);
  }
  const groups = vs.map(v => ({
    vendor: v, lines: suggest.filter(s => s.vendorId === v.id),
    orderBy: null,
  })).filter(g => g.lines.length);
  const noVendor = suggest.filter(s => !s.vendorId || !vs.some(v => v.id === s.vendorId));
  if (noVendor.length) groups.push({ vendor: { id: null, name: "No vendor set" }, lines: noVendor });
  for (const g of groups) {
    g.total = g.lines.every(l => l.unitCost != null) ? Math.round(g.lines.reduce((s, l) => s + l.qty * l.unitCost, 0) * 100) / 100 : null;
    g.arrives = g.vendor.leadDays != null ? addWorkDays(t, g.vendor.leadDays) : null;
  }

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = (await db.prepare(`SELECT o.id, o.vendor_id AS vendorId, v.name AS vendor, o.status, o.ordered_at AS orderedAt, o.expected_on AS expectedOn, o.received_at AS receivedAt,
      o.reference, o.note, u.display_name AS orderedBy FROM supply_orders o LEFT JOIN supply_vendors v ON v.id = o.vendor_id LEFT JOIN core_users u ON u.id = o.ordered_by
      WHERE o.org_id=? AND (o.status='ordered' OR o.ordered_at >= ?) ORDER BY o.status='ordered' DESC, o.ordered_at DESC`).bind(env.ORG_ID, since).all()).results;
  const lines = await orderLines(db, rows.map(r => r.id));
  const placed = rows.map(r => ({ ...r, late: r.status === "ordered" && r.expectedOn && r.expectedOn < t, lines: lines.get(r.id) }));
  return { today: t, workshopId: ws?.id || null, groups, onOrder, placed, lastWorkshopCount: [...latest.values()].reduce((m, l) => (l.at > m ? l.at : m), "") || null };
}

export async function placeOrder(db, env, me, body) {
  requireRole(me, "manager");
  const vendorId = body.vendorId || null;
  const v = vendorId ? (await vendors(db, env)).find(x => x.id === vendorId) : null;
  if (vendorId && !v) throw new HttpError(400, "Pick a vendor from the list.");
  const its = new Map((await allItems(db, env, { all: true })).map(i => [i.id, i]));
  const lines = [];
  for (const l of Array.isArray(body.lines) ? body.lines : []) {
    let q; try { q = cleanQty(l.qty, "Quantity"); } catch (e) { throw new HttpError(400, e.message); }
    if (!q) continue;
    if (l.item && !its.has(l.item)) throw new HttpError(400, "One of the items isn't on the supply list.");
    const label = l.item ? null : String(l.label || "").trim().slice(0, 120);
    if (!l.item && !label) throw new HttpError(400, "A write-in line needs a description.");
    const c = l.item ? its.get(l.item).unitCost : null;
    lines.push({ item: l.item || null, label, qty: q, unitCostCents: c == null ? null : Math.round(c * 100) });
  }
  if (!lines.length) throw new HttpError(400, "Nothing to order — every quantity is 0.");
  const t = today(env);
  let expected = body.expectedOn || (v && v.leadDays != null ? addWorkDays(t, v.leadDays) : null);
  if (expected && !/^\d{4}-\d{2}-\d{2}$/.test(expected)) throw new HttpError(400, "Use a date like 2026-10-19.");
  const id = ulid();
  await db.batch([
    db.prepare("INSERT INTO supply_orders(id, org_id, vendor_id, status, ordered_at, ordered_by, expected_on, reference, note) VALUES(?,?,?,'ordered',?,?,?,?,?)")
      .bind(id, env.ORG_ID, vendorId, nowIso(), me.id, expected, String(body.reference || "").trim().slice(0, 60) || null, String(body.note || "").trim().slice(0, 300) || null),
    ...lines.map((l, k) => db.prepare("INSERT INTO supply_order_lines(id, order_id, item_id, label, qty, unit_cost_cents, sort) VALUES(?,?,?,?,?,?,?)").bind(ulid(), id, l.item, l.label, l.qty, l.unitCostCents, k)),
  ]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_orders", entityId: id, action: "create", changes: { vendorId, lines: lines.length, expected } });
  return { id, expectedOn: expected };
}

export async function updateOrder(db, env, me, id, body) {
  requireRole(me, "manager");
  const o = await db.prepare("SELECT id, status FROM supply_orders WHERE id=? AND org_id=?").bind(id, env.ORG_ID).first();
  if (!o) throw new HttpError(404, "That order isn't on file.");
  const sets = [], args = [];
  if (body.status !== undefined) {
    if (!["ordered", "received", "cancelled"].includes(body.status)) throw new HttpError(400, "Unknown status.");
    sets.push("status=?", "received_at=?"); args.push(body.status, body.status === "received" ? nowIso() : null);
  }
  if (body.expectedOn !== undefined) {
    if (body.expectedOn && !/^\d{4}-\d{2}-\d{2}$/.test(body.expectedOn)) throw new HttpError(400, "Use a date like 2026-10-19.");
    sets.push("expected_on=?"); args.push(body.expectedOn || null);
  }
  if (body.reference !== undefined) { sets.push("reference=?"); args.push(String(body.reference || "").trim().slice(0, 60) || null); }
  if (body.note !== undefined) { sets.push("note=?"); args.push(String(body.note || "").trim().slice(0, 300) || null); }
  if (!sets.length) return { id };
  await db.prepare(`UPDATE supply_orders SET ${sets.join(", ")} WHERE id=?`).bind(...args, id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_orders", entityId: id, action: "update", changes: body });
  return { id };
}
