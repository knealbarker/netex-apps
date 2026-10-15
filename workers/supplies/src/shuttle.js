// Shuttle lists: what each store or the Laundry Hub needs sent from the Workshop. One open list per location;
// the supply manager adjusts quantities, prints the slip (it rides back on the shuttle with the items) and marks it sent.
import { HttpError, ulid, nowIso, audit } from "../../planner/src/util.js";
import { requireRole } from "../../planner/src/auth.js";
import { cleanQty, localToday, nextShuttleDay } from "./logic.js";
import { locations, locationOf } from "./catalog.js";
import { latestLines } from "./counts.js";

const today = env => localToday(env.TIMEZONE, env.NOW ? new Date(env.NOW) : new Date());

async function linesOf(db, ids) {
  if (!ids.length) return new Map();
  const rows = (await db.prepare(`SELECT l.id, l.shipment_id, l.item_id AS item, COALESCE(i.name, l.label) AS name, l.label, i.category, i.unit, i.bulk_unit AS bulkUnit,
      l.need, l.send_qty AS sendQty, l.sort FROM supply_shipment_lines l LEFT JOIN supply_items i ON i.id = l.item_id
      WHERE l.shipment_id IN (${ids.map(() => "?").join(",")}) ORDER BY COALESCE(i.sort, 1e9), l.sort`).bind(...ids).all()).results;
  const by = new Map(ids.map(id => [id, []]));
  for (const r of rows) by.get(r.shipment_id).push({ ...r, send: r.sendQty ?? r.need });
  return by;
}

export async function shuttle(db, env, { days = 7 } = {}) {
  const locs = new Map((await locations(db, env, { all: true })).map(l => [l.id, l]));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = (await db.prepare(`SELECT s.id, s.location_id AS locationId, s.status, s.created_at AS createdAt, s.sent_at AS sentAt, s.ship_on AS shipOn, s.note,
      c.counted_by AS countedBy, c.submitted_at AS countedAt, u.display_name AS sentBy
      FROM supply_shipments s LEFT JOIN supply_counts c ON c.id = s.count_id LEFT JOIN core_users u ON u.id = s.sent_by
      WHERE s.org_id=? AND (s.status='open' OR (s.status='sent' AND s.sent_at >= ?)) ORDER BY s.status, s.created_at DESC`).bind(env.ORG_ID, since).all()).results;
  const lines = await linesOf(db, rows.map(r => r.id));
  const ws = [...locs.values()].find(l => l.role === "warehouse");
  const stock = ws ? await latestLines(db, env, ws.id) : new Map();
  const sortKey = id => locs.get(id)?.sort ?? 999;
  const out = rows.map(r => ({
    ...r, location: locs.get(r.locationId)?.label || "?",
    lines: lines.get(r.id).map(l => {
      const s = l.item ? stock.get(l.item) : null;
      return { ...l, workshop: s && s.qty !== null ? { qty: s.qty, unit: l.bulkUnit || l.unit, at: s.at } : null };
    }),
  }));
  return {
    today: today(env), nextShuttle: nextShuttleDay(today(env)),
    open: out.filter(s => s.status === "open").sort((a, b) => sortKey(a.locationId) - sortKey(b.locationId)),
    sent: out.filter(s => s.status === "sent"),
  };
}

async function shipmentOf(db, env, id) {
  const s = await db.prepare("SELECT id, location_id AS locationId, status FROM supply_shipments WHERE id=? AND org_id=?").bind(id, env.ORG_ID).first();
  if (!s) throw new HttpError(404, "That shuttle list isn't on file.");
  return s;
}

/** A blank list for a location (the supply manager adds what's going). Reuses the open one if there is one. */
export async function createShipment(db, env, me, body) {
  requireRole(me, "manager");
  const loc = await locationOf(db, env, String(body.locationId || ""));
  if (loc.role !== "store") throw new HttpError(400, "The Workshop restocks through vendor orders, not the shuttle.");
  const open = await db.prepare("SELECT id FROM supply_shipments WHERE org_id=? AND location_id=? AND status='open'").bind(env.ORG_ID, loc.id).first();
  if (open) return { id: open.id };
  const id = ulid();
  await db.prepare("INSERT INTO supply_shipments(id, org_id, location_id, status, created_at, ship_on) VALUES(?,?,?,'open',?,?)").bind(id, env.ORG_ID, loc.id, nowIso(), nextShuttleDay(today(env))).run();
  return { id };
}

/** Replaces the list's lines: [{ id?, item?, label?, need?, send }] — send 0 keeps the line (shows "not sending"). */
export async function saveShipment(db, env, me, id, body) {
  requireRole(me, "manager");
  const s = await shipmentOf(db, env, id);
  if (s.status !== "open") throw new HttpError(409, "This list was already sent. Reopen it first to change it.");
  const old = new Map(((await linesOf(db, [id])).get(id) || []).map(l => [l.id, l]));
  const stmts = [db.prepare("DELETE FROM supply_shipment_lines WHERE shipment_id=?").bind(id)];
  const its = new Set((await db.prepare("SELECT id FROM supply_items WHERE org_id=?").bind(env.ORG_ID).all()).results.map(r => r.id));
  (Array.isArray(body.lines) ? body.lines : []).forEach((l, k) => {
    const prev = l.id ? old.get(l.id) : null;
    const item = prev ? prev.item : l.item || null;
    const label = item ? null : String((prev ? prev.label : l.label) || "").trim().slice(0, 120);
    if (item && !its.has(item)) throw new HttpError(400, "One of the items isn't on the supply list.");
    if (!item && !label) throw new HttpError(400, "A write-in line needs a description.");
    let send;
    try { send = cleanQty(l.send, "Send"); } catch (e) { throw new HttpError(400, e.message); }
    const need = prev ? prev.need : send ?? 0;
    stmts.push(db.prepare("INSERT INTO supply_shipment_lines(id, shipment_id, item_id, label, need, send_qty, sort) VALUES(?,?,?,?,?,?,?)")
      .bind(prev ? prev.id : ulid(), id, item, label, need, send, k));
  });
  if (body.shipOn !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.shipOn))) throw new HttpError(400, "Use a date like 2026-10-19.");
    stmts.push(db.prepare("UPDATE supply_shipments SET ship_on=? WHERE id=?").bind(body.shipOn, id));
  }
  await db.batch(stmts);
  return { id };
}

export async function setShipmentStatus(db, env, me, id, status) {
  requireRole(me, "manager");
  const s = await shipmentOf(db, env, id);
  if (status === "sent") {
    if (s.status !== "open") throw new HttpError(409, "Only an open list can be marked sent.");
    await db.prepare("UPDATE supply_shipments SET status='sent', sent_at=?, sent_by=? WHERE id=?").bind(nowIso(), me.id, id).run();
  } else if (status === "open") {
    if (s.status !== "sent") throw new HttpError(409, "Only a sent list can be reopened.");
    const other = await db.prepare("SELECT id FROM supply_shipments WHERE org_id=? AND location_id=? AND status='open'").bind(env.ORG_ID, s.locationId).first();
    if (other) throw new HttpError(409, "That location already has an open list (a newer count came in). Add to that one instead.");
    await db.prepare("UPDATE supply_shipments SET status='open', sent_at=NULL, sent_by=NULL WHERE id=?").bind(id).run();
  } else if (status === "cancelled") {
    if (s.status !== "open") throw new HttpError(409, "Only an open list can be dropped.");
    await db.prepare("UPDATE supply_shipments SET status='cancelled' WHERE id=?").bind(id).run();
  } else throw new HttpError(400, "Unknown status.");
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_shipments", entityId: id, action: "update", changes: { status } });
  return { id, status };
}
