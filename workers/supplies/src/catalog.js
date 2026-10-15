// The supply list: locations, vendors, items and what each location keeps (pars), plus who may count.
import { HttpError, ulid, nowIso, audit } from "../../planner/src/util.js";
import { requireRole } from "../../planner/src/auth.js";
import { MODES, cleanQty, handleOf } from "./logic.js";

const text = (v, max = 120) => { const s = String(v ?? "").trim().replace(/\s+/g, " "); return s ? s.slice(0, max) : null; };
const need = (v, what, max) => { const s = text(v, max); if (!s) throw new HttpError(400, `${what} is required.`); return s; };
const qty = (v, what) => { try { return cleanQty(v, what); } catch (e) { throw new HttpError(400, e.message); } };
const intOrNull = (v, what, max = 365) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, `${what} must be a whole number from 0 to ${max}.`);
  return n;
};
const money = (v, what) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, "")); if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new HttpError(400, `${what} must be a dollar amount.`);
  return Math.round(n * 100) / 100;
};

export async function locations(db, env, { all = false } = {}) {
  return (await db.prepare(`SELECT l.id, l.name, COALESCE(sl.label, l.name) AS label, sl.role, sl.sort, sl.is_active AS active
      FROM supply_locations sl JOIN core_locations l ON l.id = sl.location_id
      WHERE sl.org_id = ? ${all ? "" : "AND sl.is_active = 1"} ORDER BY sl.sort, l.name`).bind(env.ORG_ID).all()).results
    .map(r => ({ ...r, active: !!r.active }));
}
export async function locationOf(db, env, id) {
  const l = (await locations(db, env, { all: true })).find(x => x.id === id);
  if (!l) throw new HttpError(404, "That location isn't on the supplies list.");
  return l;
}

export async function vendors(db, env) {
  return (await db.prepare(`SELECT id, name, order_method AS orderMethod, phone, website, account_no AS accountNo, contact, lead_days AS leadDays,
      min_order_amount AS minAmount, min_order_note AS minNote, notes, sort, is_active AS active FROM supply_vendors WHERE org_id = ? ORDER BY sort, name`)
    .bind(env.ORG_ID).all()).results.map(v => ({ ...v, active: !!v.active }));
}

/** Every active item (or all) with its pars by location id. */
export async function items(db, env, { all = false } = {}) {
  const rows = (await db.prepare(`SELECT id, name, vendor_id AS vendorId, vendor_sku AS sku, category, unit, bulk_unit AS bulkUnit, unit_cost AS unitCost,
      notes, review_note AS reviewNote, sort, is_active AS active FROM supply_items WHERE org_id = ? ${all ? "" : "AND is_active = 1"} ORDER BY sort, name`)
    .bind(env.ORG_ID).all()).results;
  const pars = (await db.prepare(`SELECT p.item_id, p.location_id, p.par, p.reorder_at, p.mode FROM supply_pars p JOIN supply_items i ON i.id = p.item_id WHERE i.org_id = ?`)
    .bind(env.ORG_ID).all()).results;
  const by = new Map(rows.map(r => [r.id, { ...r, active: !!r.active, pars: {} }]));
  for (const p of pars) { const it = by.get(p.item_id); if (it) it.pars[p.location_id] = { par: p.par, reorder: p.reorder_at, mode: p.mode }; }
  return [...by.values()];
}

export async function catalog(db, env) {
  return { locations: await locations(db, env, { all: true }), vendors: await vendors(db, env), items: await items(db, env, { all: true }) };
}

async function readItem(db, env, body, old = {}) {
  const pick = (k, f) => (body[k] !== undefined ? f(body[k]) : old[k] ?? null);
  const vendorId = pick("vendorId", v => text(v, 60));
  if (vendorId && !(await db.prepare("SELECT 1 FROM supply_vendors WHERE id=? AND org_id=?").bind(vendorId, env.ORG_ID).first())) throw new HttpError(400, "Pick a vendor from the list.");
  return {
    name: pick("name", v => need(v, "Item name", 120)),
    vendorId,
    sku: pick("sku", v => text(v, 40)),
    category: pick("category", v => text(v, 40) || "Other"),
    unit: pick("unit", v => need(v, "Unit", 30)),
    bulkUnit: pick("bulkUnit", v => text(v, 30)),
    unitCost: pick("unitCost", v => money(v, "Cost")),
    notes: pick("notes", v => text(v, 300)),
    reviewNote: pick("reviewNote", v => text(v, 300)),
    sort: pick("sort", v => intOrNull(v, "Sort", 1e6) ?? 0),
    active: pick("active", v => (v ? 1 : 0)),
  };
}

function parStmts(db, env, itemId, pars, locIds) {
  const out = [];
  for (const [loc, p] of Object.entries(pars || {})) {
    if (!locIds.has(loc)) throw new HttpError(400, "One of the locations isn't on the supplies list.");
    if (p === null || p === false) { out.push(db.prepare("DELETE FROM supply_pars WHERE item_id=? AND location_id=?").bind(itemId, loc)); continue; }
    const mode = p.mode || "count";
    if (!MODES.includes(mode)) throw new HttpError(400, "How they answer must be count, Out/Low/OK, or Need any?");
    const par = qty(p.par, "Par"), reorder = qty(p.reorder, "Reorder point");
    if (reorder !== null && par !== null && reorder >= par) throw new HttpError(400, "The reorder point has to be below the par.");
    out.push(db.prepare(`INSERT INTO supply_pars(item_id, location_id, par, reorder_at, mode) VALUES(?,?,?,?,?)
      ON CONFLICT(item_id, location_id) DO UPDATE SET par=excluded.par, reorder_at=excluded.reorder_at, mode=excluded.mode`).bind(itemId, loc, par, reorder, mode));
  }
  return out;
}

export async function createItem(db, env, me, body) {
  requireRole(me, "manager");
  const it = await readItem(db, env, body, { category: "Other", sort: 0, active: 1 });
  if (!it.unit) throw new HttpError(400, "Unit is required.");
  const id = ulid();
  const locIds = new Set((await locations(db, env, { all: true })).map(l => l.id));
  const sort = it.sort || ((await db.prepare("SELECT COALESCE(MAX(sort),0)+10 AS s FROM supply_items WHERE org_id=?").bind(env.ORG_ID).first()).s);
  await db.batch([
    db.prepare(`INSERT INTO supply_items(id, org_id, name, vendor_id, vendor_sku, category, unit, bulk_unit, unit_cost, notes, review_note, sort, is_active, updated_at, updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, env.ORG_ID, it.name, it.vendorId, it.sku, it.category, it.unit, it.bulkUnit, it.unitCost, it.notes, it.reviewNote, sort, it.active, nowIso(), me.id),
    ...parStmts(db, env, id, body.pars, locIds),
  ]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_items", entityId: id, action: "create", changes: { ...it, pars: body.pars } });
  return { id };
}

export async function updateItem(db, env, me, id, body) {
  requireRole(me, "manager");
  const old = await db.prepare(`SELECT name, vendor_id AS vendorId, vendor_sku AS sku, category, unit, bulk_unit AS bulkUnit, unit_cost AS unitCost, notes,
      review_note AS reviewNote, sort, is_active AS active FROM supply_items WHERE id=? AND org_id=?`).bind(id, env.ORG_ID).first();
  if (!old) throw new HttpError(404, "That item isn't on the list.");
  const it = await readItem(db, env, body, old);
  const locIds = new Set((await locations(db, env, { all: true })).map(l => l.id));
  await db.batch([
    db.prepare(`UPDATE supply_items SET name=?, vendor_id=?, vendor_sku=?, category=?, unit=?, bulk_unit=?, unit_cost=?, notes=?, review_note=?, sort=?, is_active=?, updated_at=?, updated_by=? WHERE id=?`)
      .bind(it.name, it.vendorId, it.sku, it.category, it.unit, it.bulkUnit, it.unitCost, it.notes, it.reviewNote, it.sort, it.active, nowIso(), me.id, id),
    ...parStmts(db, env, id, body.pars, locIds),
  ]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_items", entityId: id, action: "update", changes: body });
  return { id };
}

export async function saveVendor(db, env, me, id, body) {
  requireRole(me, "manager");
  const old = id ? await db.prepare("SELECT * FROM supply_vendors WHERE id=? AND org_id=?").bind(id, env.ORG_ID).first() : null;
  if (id && !old) throw new HttpError(404, "That vendor isn't on the list.");
  const pick = (k, col, f) => (body[k] !== undefined ? f(body[k]) : old ? old[col] : null);
  const v = {
    name: pick("name", "name", x => need(x, "Vendor name", 80)),
    orderMethod: pick("orderMethod", "order_method", x => text(x, 80)),
    phone: pick("phone", "phone", x => text(x, 40)),
    website: pick("website", "website", x => text(x, 200)),
    accountNo: pick("accountNo", "account_no", x => text(x, 60)),
    contact: pick("contact", "contact", x => text(x, 120)),
    leadDays: pick("leadDays", "lead_days", x => intOrNull(x, "Lead time")),
    minAmount: pick("minAmount", "min_order_amount", x => money(x, "Minimum order")),
    minNote: pick("minNote", "min_order_note", x => text(x, 200)),
    notes: pick("notes", "notes", x => text(x, 400)),
    active: body.active !== undefined ? (body.active ? 1 : 0) : old ? old.is_active : 1,
  };
  if (!v.name) throw new HttpError(400, "Vendor name is required.");
  const vid = id || ulid();
  if (old) await db.prepare(`UPDATE supply_vendors SET name=?, order_method=?, phone=?, website=?, account_no=?, contact=?, lead_days=?, min_order_amount=?, min_order_note=?, notes=?, is_active=?, updated_at=?, updated_by=? WHERE id=?`)
    .bind(v.name, v.orderMethod, v.phone, v.website, v.accountNo, v.contact, v.leadDays, v.minAmount, v.minNote, v.notes, v.active, nowIso(), me.id, vid).run();
  else {
    const sort = (await db.prepare("SELECT COALESCE(MAX(sort),0)+10 AS s FROM supply_vendors WHERE org_id=?").bind(env.ORG_ID).first()).s;
    await db.prepare(`INSERT INTO supply_vendors(id, org_id, name, order_method, phone, website, account_no, contact, lead_days, min_order_amount, min_order_note, notes, sort, is_active, updated_at, updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(vid, env.ORG_ID, v.name, v.orderMethod, v.phone, v.website, v.accountNo, v.contact, v.leadDays, v.minAmount, v.minNote, v.notes, sort, v.active, nowIso(), me.id).run();
  }
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_vendors", entityId: vid, action: old ? "update" : "create", changes: v });
  return { id: vid };
}

export async function updateLocation(db, env, me, id, body) {
  requireRole(me, "manager");
  await locationOf(db, env, id);
  const label = body.label !== undefined ? need(body.label, "Name", 60) : undefined;
  if (label !== undefined) await db.prepare("UPDATE supply_locations SET label=? WHERE location_id=?").bind(label, id).run();
  if (body.active !== undefined) await db.prepare("UPDATE supply_locations SET is_active=? WHERE location_id=?").bind(body.active ? 1 : 0, id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_locations", entityId: id, action: "update", changes: body });
  return { id };
}

// ------------------------------------------------------------ approved counters
const display = c => `${c.first_name} ${c.last_initial}`;
export async function counters(db, env) {
  return (await db.prepare(`SELECT c.id, c.first_name AS firstName, c.last_initial AS lastInitial, c.handle, c.location_id AS locationId, c.is_active AS active,
      (SELECT MAX(submitted_at) FROM supply_counts s WHERE s.counter_id = c.id) AS lastCount
      FROM supply_counters c WHERE c.org_id=? ORDER BY c.is_active DESC, c.first_name, c.last_initial`).bind(env.ORG_ID).all()).results
    .map(c => ({ ...c, active: !!c.active, name: `${c.firstName} ${c.lastInitial}` }));
}
export async function saveCounter(db, env, me, id, body) {
  requireRole(me, "manager");
  const old = id ? await db.prepare("SELECT * FROM supply_counters WHERE id=? AND org_id=?").bind(id, env.ORG_ID).first() : null;
  if (id && !old) throw new HttpError(404, "That person isn't on the list.");
  const first = body.firstName !== undefined ? need(body.firstName, "First name", 30) : old.first_name;
  const li = body.lastInitial !== undefined ? String(body.lastInitial || "").trim().replace(/[^A-Za-z]/g, "").slice(0, 1).toUpperCase() : old.last_initial;
  if (!li) throw new HttpError(400, "Last initial is required.");
  const firstClean = first.replace(/[^A-Za-z' -]/g, "").trim();
  if (!firstClean) throw new HttpError(400, "First name needs letters.");
  const handle = handleOf(`${firstClean.replace(/\s+/g, "")} ${li}`);
  const loc = body.locationId !== undefined ? (body.locationId || null) : old ? old.location_id : null;
  if (loc) await locationOf(db, env, loc);
  const active = body.active !== undefined ? (body.active ? 1 : 0) : old ? old.is_active : 1;
  const clash = await db.prepare("SELECT id FROM supply_counters WHERE org_id=? AND handle=? AND id<>?").bind(env.ORG_ID, handle, id || "").first();
  if (clash) throw new HttpError(409, `${firstClean} ${li} is already on the list. Two people with the same first name and last initial need different entries — add a letter to one first name (e.g. "MariaG" and "MariaGo").`);
  const cid = id || ulid();
  if (old) await db.prepare("UPDATE supply_counters SET first_name=?, last_initial=?, handle=?, location_id=?, is_active=? WHERE id=?").bind(firstClean, li, handle, loc, active, cid).run();
  else await db.prepare("INSERT INTO supply_counters(id, org_id, first_name, last_initial, handle, location_id, is_active, created_by) VALUES(?,?,?,?,?,?,?,?)")
    .bind(cid, env.ORG_ID, firstClean, li, handle, loc, active, me.id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_counters", entityId: cid, action: old ? "update" : "create", changes: { first: firstClean, li, loc, active } });
  return { id: cid, handle };
}
/** Who typed this name at this location? Throws a friendly 403 when they're not on the list. */
export async function counterFor(db, env, typed, locationId) {
  const h = handleOf(typed);
  if (!h) throw new HttpError(400, "Type your first name and last initial, like KarlaV.");
  const c = await db.prepare("SELECT id, first_name, last_initial, location_id FROM supply_counters WHERE org_id=? AND handle=? AND is_active=1").bind(env.ORG_ID, h).first();
  if (!c) throw new HttpError(403, `"${String(typed).trim()}" isn't on the approved list. Check the spelling (first name + last initial, like KarlaV) or ask the supply manager to add you.`, { reason: "not_approved" });
  if (c.location_id && c.location_id !== locationId) throw new HttpError(403, `${display(c)} is set up to count at a different location. Ask the supply manager if that should change.`, { reason: "wrong_location" });
  return { id: c.id, name: display(c) };
}
