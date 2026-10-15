// Counting: the paired devices at each location, count requests, and turning a submitted count into needs
// (a store's shuttle list, or the Workshop's numbers that drive vendor orders).
import { HttpError, ulid, nowIso, audit } from "../../planner/src/util.js";
import { requireRole } from "../../planner/src/auth.js";
import { needOf, cleanQty, MODES, localToday, nextShuttleDay } from "./logic.js";
import { locations, locationOf, items as allItems, vendors, counterFor } from "./catalog.js";

export const COOKIE = "netex_supplies";
export const PAIR_MIN = 15;
const PAIR_TRIES = 10;

async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const randomToken = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); };
const sixDigits = () => { const b = new Uint32Array(1); crypto.getRandomValues(b); return String(b[0] % 1000000).padStart(6, "0"); };
const today = env => localToday(env.TIMEZONE, env.NOW ? new Date(env.NOW) : new Date());

export function cookieOf(req) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return m ? m[1] : null;
}
export const setCookie = token => `${COOKIE}=${token}; Path=/count; Max-Age=34560000; HttpOnly; Secure; SameSite=Strict`;
export const clearCookie = () => `${COOKIE}=; Path=/count; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

// ------------------------------------------------------------ devices
export async function deviceOf(db, env, req) {
  const tok = cookieOf(req); if (!tok) return null;
  const d = await db.prepare("SELECT id, name, location_id AS locationId, last_seen_at AS seen FROM supply_devices WHERE org_id=? AND token_hash=? AND revoked_at IS NULL")
    .bind(env.ORG_ID, await sha256(tok)).first();
  if (!d) return null;
  if (!d.seen || Date.now() - Date.parse(d.seen) > 60000) await db.prepare("UPDATE supply_devices SET last_seen_at=? WHERE id=?").bind(nowIso(), d.id).run();
  return { ...d, token: tok };
}

export async function pairDevice(db, env, code) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6) throw new HttpError(400, "Enter the 6-digit code the supply manager gave you.");
  const now = nowIso(), h = await sha256(`${env.ORG_ID}:supplies:${c}`);
  const d = await db.prepare("SELECT id, name, location_id AS locationId FROM supply_devices WHERE org_id=? AND pair_code_hash=? AND pair_expires_at > ? AND revoked_at IS NULL AND pair_failures < ?")
    .bind(env.ORG_ID, h, now, PAIR_TRIES).first();
  if (!d) {
    await db.prepare("UPDATE supply_devices SET pair_failures=pair_failures+1 WHERE org_id=? AND pair_code_hash IS NOT NULL").bind(env.ORG_ID).run();
    await db.prepare("UPDATE supply_devices SET pair_code_hash=NULL, pair_expires_at=NULL WHERE org_id=? AND pair_failures >= ?").bind(env.ORG_ID, PAIR_TRIES).run();
    throw new HttpError(403, "That code didn't work. Codes last 15 minutes — ask the supply manager for a new one.");
  }
  const token = randomToken();
  await db.prepare("UPDATE supply_devices SET token_hash=?, pair_code_hash=NULL, pair_expires_at=NULL, pair_failures=0, paired_at=?, last_seen_at=? WHERE id=?")
    .bind(await sha256(token), now, now, d.id).run();
  await audit(db, { orgId: env.ORG_ID, userId: null, appId: env.APP_ID, entity: "supply_devices", entityId: d.id, action: "sign_in", changes: { name: d.name } });
  return { token, device: { ...d, token } };
}

export async function listDevices(db, env, me) {
  requireRole(me, "manager");
  const now = nowIso();
  return (await db.prepare(`SELECT id, name, location_id AS locationId, paired_at AS pairedAt, last_seen_at AS lastSeen, token_hash IS NOT NULL AS paired,
      CASE WHEN pair_code_hash IS NOT NULL AND pair_expires_at > ? THEN pair_expires_at END AS codeUntil
      FROM supply_devices WHERE org_id=? AND revoked_at IS NULL ORDER BY created_at`).bind(now, env.ORG_ID).all()).results.map(d => ({ ...d, paired: !!d.paired }));
}
async function newCode(db, env, id) {
  const code = sixDigits(), until = new Date(Date.now() + PAIR_MIN * 60000).toISOString();
  await db.prepare("UPDATE supply_devices SET pair_code_hash=?, pair_expires_at=?, pair_failures=0 WHERE id=?").bind(await sha256(`${env.ORG_ID}:supplies:${code}`), until, id).run();
  return { id, code, until };
}
export async function createDevice(db, env, me, body) {
  requireRole(me, "manager");
  const loc = await locationOf(db, env, String(body.locationId || ""));
  const name = String(body.name || "").trim().slice(0, 40) || `${loc.label} counter`;
  const id = ulid();
  await db.prepare("INSERT INTO supply_devices(id, org_id, location_id, name, created_by) VALUES(?,?,?,?,?)").bind(id, env.ORG_ID, loc.id, name, me.id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_devices", entityId: id, action: "create", changes: { location: loc.name, name } });
  return newCode(db, env, id);
}
export async function deviceCode(db, env, me, id) {
  requireRole(me, "manager");
  if (!(await db.prepare("SELECT 1 FROM supply_devices WHERE id=? AND org_id=? AND revoked_at IS NULL").bind(id, env.ORG_ID).first())) throw new HttpError(404, "That device isn't on the list.");
  return newCode(db, env, id);
}
export async function removeDevice(db, env, me, id) {
  requireRole(me, "manager");
  const r = await db.prepare("UPDATE supply_devices SET revoked_at=?, token_hash=NULL, pair_code_hash=NULL WHERE id=? AND org_id=? AND revoked_at IS NULL").bind(nowIso(), id, env.ORG_ID).run();
  if (!r?.meta?.changes) throw new HttpError(404, "That device isn't on the list.");
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_devices", entityId: id, action: "delete", changes: null });
  return { id };
}

// ------------------------------------------------------------ requests
export async function openRequests(db, env, locationId = null) {
  return (await db.prepare(`SELECT r.id, r.location_id AS locationId, r.requested_at AS requestedAt, r.due_on AS dueOn, r.note, u.display_name AS requestedBy
      FROM supply_requests r LEFT JOIN core_users u ON u.id = r.requested_by
      WHERE r.org_id=? AND r.done_at IS NULL AND r.cancelled_at IS NULL ${locationId ? "AND r.location_id=?" : ""} ORDER BY r.requested_at`)
    .bind(...(locationId ? [env.ORG_ID, locationId] : [env.ORG_ID])).all()).results;
}
export async function createRequests(db, env, me, body) {
  requireRole(me, "manager");
  const ids = Array.isArray(body.locationIds) ? body.locationIds : [];
  if (!ids.length) throw new HttpError(400, "Pick at least one location.");
  const due = body.dueOn ? String(body.dueOn) : null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new HttpError(400, "Use a date like 2026-10-19.");
  const note = String(body.note || "").trim().slice(0, 200) || null, now = nowIso(), made = [];
  for (const id of ids) {
    await locationOf(db, env, id);
    // one open request per location: a new one replaces the old
    await db.prepare("UPDATE supply_requests SET cancelled_at=? WHERE org_id=? AND location_id=? AND done_at IS NULL AND cancelled_at IS NULL").bind(now, env.ORG_ID, id).run();
    const rid = ulid();
    await db.prepare("INSERT INTO supply_requests(id, org_id, location_id, requested_by, requested_at, due_on, note) VALUES(?,?,?,?,?,?,?)").bind(rid, env.ORG_ID, id, me.id, now, due, note).run();
    made.push(rid);
  }
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "supply_requests", entityId: made[0], action: "create", changes: { locations: ids, due, note } });
  return { ids: made };
}
export async function cancelRequest(db, env, me, id) {
  requireRole(me, "manager");
  const r = await db.prepare("UPDATE supply_requests SET cancelled_at=? WHERE id=? AND org_id=? AND done_at IS NULL AND cancelled_at IS NULL").bind(nowIso(), id, env.ORG_ID).run();
  if (!r?.meta?.changes) throw new HttpError(404, "That request is already done or cancelled.");
  return { id };
}

// ------------------------------------------------------------ the count sheet
/** Latest answer per item at a location (any count), for "last time" hints and the Workshop's on-hand numbers. */
export async function latestLines(db, env, locationId) {
  return new Map((await db.prepare(`SELECT cl.item_id, cl.qty, cl.level, cl.need, cl.mode, c.submitted_at AS at
      FROM supply_count_lines cl JOIN supply_counts c ON c.id = cl.count_id
      WHERE c.org_id=? AND c.location_id=? AND c.submitted_at = (
        SELECT MAX(c2.submitted_at) FROM supply_count_lines cl2 JOIN supply_counts c2 ON c2.id = cl2.count_id WHERE cl2.item_id = cl.item_id AND c2.location_id = c.location_id)`)
    .bind(env.ORG_ID, locationId).all()).results.map(r => [r.item_id, r]));
}

/** The list a location counts: its items in order, with par, unit (bulk at the Workshop), how to answer, and last time's answer. */
export async function sheetFor(db, env, loc) {
  const [its, vs, last] = [await allItems(db, env), await vendors(db, env), await latestLines(db, env, loc.id)];
  const vname = new Map(vs.map(v => [v.id, v.name]));
  const warehouse = loc.role === "warehouse";
  return its.filter(i => i.pars[loc.id]).map(i => {
    const p = i.pars[loc.id], l = last.get(i.id);
    return {
      id: i.id, name: i.name, category: i.category, vendor: vname.get(i.vendorId) || null, sku: warehouse ? i.sku : null,
      unit: warehouse ? i.bulkUnit || i.unit : i.unit, par: p.par, reorder: p.reorder, mode: p.mode, notes: i.notes,
      last: l ? { qty: l.qty, level: l.level, at: l.at } : null,
    };
  });
}

export async function deviceState(db, env, dev) {
  const loc = await locationOf(db, env, dev.locationId);
  return {
    paired: true, device: { id: dev.id, name: dev.name }, location: { id: loc.id, label: loc.label, role: loc.role, active: loc.active },
    requests: await openRequests(db, env, loc.id), items: loc.active ? await sheetFor(db, env, loc) : [], today: today(env),
    lastCount: await db.prepare("SELECT submitted_at AS at, counted_by AS who FROM supply_counts WHERE org_id=? AND location_id=? ORDER BY submitted_at DESC LIMIT 1").bind(env.ORG_ID, loc.id).first(),
  };
}

/**
 * Saves a count. `who` is { counterId, name } (device) or { userId, name } (a signed-in manager).
 * Store: replaces its open shuttle list with this count's needs. Workshop: the needs feed Orders.
 */
export async function submitCount(db, env, loc, who, body, deviceId = null) {
  if (!loc.active) throw new HttpError(400, "This location is turned off in Supplies.");
  const sheet = new Map((await sheetFor(db, env, loc)).map(i => [i.id, i]));
  const lines = [];
  for (const raw of Array.isArray(body.lines) ? body.lines : []) {
    const it = sheet.get(String(raw.item || ""));
    if (!it) continue; // an item no longer kept here (list changed while counting) is skipped
    let q, level = raw.level ?? null;
    try { q = cleanQty(raw.qty, it.name); } catch (e) { throw new HttpError(400, e.message); }
    if (level !== null && !["out", "low", "ok", "need", "none"].includes(level)) throw new HttpError(400, "Unknown answer.");
    const need = needOf({ mode: it.mode, par: it.par, reorder_at: it.reorder }, { qty: q, level });
    if (need === null) continue; // unanswered
    lines.push({ it, qty: q, level, need });
  }
  const note = String(body.note || "").trim().slice(0, 1000) || null;
  if (!lines.length && !note) throw new HttpError(400, "Nothing was counted. Answer at least one item (or write what you need in the box at the bottom).");

  const id = ulid(), now = nowIso(), needs = lines.filter(l => l.need > 0);
  const stmts = [
    db.prepare(`INSERT INTO supply_counts(id, org_id, location_id, counter_id, counted_by, device_id, user_id, submitted_at, note, items, needs) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, env.ORG_ID, loc.id, who.counterId || null, who.name, deviceId, who.userId || null, now, note, lines.length, needs.length),
    ...lines.map(l => db.prepare("INSERT INTO supply_count_lines(count_id, item_id, mode, qty, level, par, need) VALUES(?,?,?,?,?,?,?)")
      .bind(id, l.it.id, l.it.mode, l.qty, l.level, l.it.par, l.need)),
    db.prepare("UPDATE supply_requests SET done_at=?, done_count_id=? WHERE org_id=? AND location_id=? AND done_at IS NULL AND cancelled_at IS NULL").bind(now, id, env.ORG_ID, loc.id),
  ];
  let shipmentId = null;
  if (loc.role === "store") {
    stmts.push(db.prepare("UPDATE supply_shipments SET status='replaced' WHERE org_id=? AND location_id=? AND status='open'").bind(env.ORG_ID, loc.id));
    if (needs.length || note) {
      shipmentId = ulid();
      stmts.push(db.prepare("INSERT INTO supply_shipments(id, org_id, location_id, count_id, status, created_at, ship_on, note) VALUES(?,?,?,?,'open',?,?,?)")
        .bind(shipmentId, env.ORG_ID, loc.id, id, now, nextShuttleDay(today(env)), note));
      needs.forEach((l, k) => stmts.push(db.prepare("INSERT INTO supply_shipment_lines(id, shipment_id, item_id, need, sort) VALUES(?,?,?,?,?)").bind(ulid(), shipmentId, l.it.id, l.need, k)));
    }
  }
  await db.batch(stmts);
  return {
    id, shipmentId, location: loc.label, role: loc.role, counted: lines.length,
    needs: needs.map(l => ({ item: l.it.id, name: l.it.name, need: l.need, unit: l.it.unit })),
  };
}

export async function deviceSubmit(db, env, dev, body) {
  const loc = await locationOf(db, env, dev.locationId);
  const who = await counterFor(db, env, body.name, loc.id);
  return submitCount(db, env, loc, { counterId: who.id, name: who.name }, body, dev.id);
}
export async function deviceWho(db, env, dev, body) {
  const loc = await locationOf(db, env, dev.locationId);
  return { name: (await counterFor(db, env, body.name, loc.id)).name };
}

export async function managerSubmit(db, env, me, body) {
  requireRole(me, "manager");
  const loc = await locationOf(db, env, String(body.locationId || ""));
  return submitCount(db, env, loc, { userId: me.id, name: me.name }, body);
}

// ------------------------------------------------------------ history and overview
export async function countHistory(db, env, { locationId = null, limit = 50 } = {}) {
  return (await db.prepare(`SELECT c.id, c.location_id AS locationId, c.counted_by AS countedBy, c.submitted_at AS at, c.items, c.needs, c.note, d.name AS device
      FROM supply_counts c LEFT JOIN supply_devices d ON d.id = c.device_id WHERE c.org_id=? ${locationId ? "AND c.location_id=?" : ""}
      ORDER BY c.submitted_at DESC LIMIT ?`).bind(...(locationId ? [env.ORG_ID, locationId, limit] : [env.ORG_ID, limit])).all()).results;
}
export async function countDetail(db, env, id) {
  const c = await db.prepare(`SELECT id, location_id AS locationId, counted_by AS countedBy, submitted_at AS at, note FROM supply_counts WHERE id=? AND org_id=?`).bind(id, env.ORG_ID).first();
  if (!c) throw new HttpError(404, "That count isn't on file.");
  const loc = await locationOf(db, env, c.locationId);
  c.lines = (await db.prepare(`SELECT cl.item_id AS item, i.name, i.category, CASE WHEN ? = 'warehouse' THEN COALESCE(i.bulk_unit, i.unit) ELSE i.unit END AS unit,
      cl.mode, cl.qty, cl.level, cl.par, cl.need FROM supply_count_lines cl JOIN supply_items i ON i.id = cl.item_id WHERE cl.count_id=? ORDER BY i.sort, i.name`)
    .bind(loc.role, id).all()).results;
  c.location = loc.label;
  return c;
}

export async function overview(db, env) {
  const locs = await locations(db, env), reqs = await openRequests(db, env);
  const last = new Map((await db.prepare(`SELECT location_id, MAX(submitted_at) AS at FROM supply_counts WHERE org_id=? GROUP BY location_id`).bind(env.ORG_ID).all()).results.map(r => [r.location_id, r.at]));
  const open = new Map((await db.prepare(`SELECT s.location_id, s.id, COUNT(l.id) AS lines FROM supply_shipments s LEFT JOIN supply_shipment_lines l ON l.shipment_id = s.id
      WHERE s.org_id=? AND s.status='open' GROUP BY s.id`).bind(env.ORG_ID).all()).results.map(r => [r.location_id, r]));
  const devs = (await db.prepare("SELECT location_id, COUNT(*) AS n FROM supply_devices WHERE org_id=? AND revoked_at IS NULL AND token_hash IS NOT NULL GROUP BY location_id").bind(env.ORG_ID).all()).results;
  const devN = new Map(devs.map(d => [d.location_id, d.n]));
  return locs.map(l => ({ ...l, lastCount: last.get(l.id) || null, request: reqs.find(r => r.locationId === l.id) || null, openShipment: open.get(l.id) || null, devices: devN.get(l.id) || 0 }));
}
