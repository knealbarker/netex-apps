// Pieces to plan, worked out from the orders and pieces netex-sync keeps current from SMRT.
// Same rules as the desktop planner 1.9.0 (claude/smrt-integration.md):
//  - An order is done when its status says so (ready, complete, picked up ...) or it has a ready/returned/picked-up/delivered date.
//  - A piece is complete ("assembled = complete for production") when it's assembled/racked/with the customer,
//    has an assembly date, or its order is done. Removed pieces don't count; deleted orders don't count.
//  - Kind of work: the item type is matched first (comforters, tablecloths), then the financial department.
//  - Today = pieces due today, less what was finished before today, plus open pieces from overdue orders (last 14 days).
//  - Next work day = pieces due that day, less what's already finished (work done ahead), scaled store by store
//    to what usually still comes in by each store's drop-off cutoff (from the order history).
import { loadGroups, loadRuns } from "./settings.js";

export const CATS = ["dct", "dcb", "slt", "slb", "comf", "tc"];
const OVERDUE_DAYS = 14, FORECAST_WEEKS = 6;
const zero = () => Object.fromEntries(CATS.map(k => [k, 0]));

export function addDays(day, n) { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const weekday = day => new Date(day + "T12:00:00Z").getUTCDay();
export function nextWorkDay(day, workDays) { let d = day; for (let i = 0; i < 14; i++) { d = addDays(d, 1); if (workDays.includes(weekday(d))) return d; } return addDays(day, 1); }
export function prevWorkDay(day, workDays) { let d = day; for (let i = 0; i < 14; i++) { d = addDays(d, -1); if (workDays.includes(weekday(d))) return d; } return addDays(day, -1); }
export function localNow(tz = "America/Chicago", at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(at).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
const normStore = s => String(s || "").toLowerCase().replace(/^tcc\s+/, "").replace(/\s+/g, " ").trim();
const list = s => String(s || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

/** Category of a piece: item type keywords first, then the department name. */
export function categorizer(smrt) {
  const types = CATS.map(k => [k, list(smrt.itemTypes?.[k])]).filter(x => x[1].length);
  const deps = new Map(); for (const k of CATS) for (const d of list(smrt.departments?.[k])) deps.set(d, k);
  return (type, dep) => {
    const t = String(type || "").toLowerCase();
    const hit = types.find(([, keys]) => keys.some(w => t.includes(w)));
    if (hit) return hit[0];
    return deps.get(String(dep || "").toLowerCase().trim()) || null;
  };
}

const toMin = t => { const m = /^(\d\d):(\d\d)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
/** When a run's pieces must be ready: the shuttle's departure (first stop's arrival less the drive), or the counter's ready time. */
export function runDeadline(run) {
  if (!run || !run.stops?.length) return null;
  const a = toMin(run.stops[0].arrive); if (a == null) return null;
  return run.kind === "counter" ? a : a - (+run.stops[0].drive || 0);
}

/** Which deadline (shuttle run or the plant counter) a store's pieces belong to. */
export function storeToRun(runs) {
  const counter = runs.find(r => r.kind === "counter");
  return loc => {
    const n = normStore(loc);
    const r = runs.find(x => x.kind === "shuttle" && x.stops.some(s => { const k = normStore(s.store); return n === k || (k.length > 3 && n.includes(k)); }));
    return r || counter || null;
  };
}
function cutoffOf(runs, loc) {
  const n = normStore(loc);
  for (const r of runs) for (const s of r.stops) { const k = normStore(s.store); if (n === k || (k.length > 3 && n.includes(k))) return s.cutoff || null; }
  return runs.find(r => r.kind === "counter")?.stops[0]?.cutoff || null;
}

const doneSql = "(s.is_done=1 OR o.ready_at IS NOT NULL OR o.returned_at IS NOT NULL OR o.picked_up_at IS NOT NULL OR o.delivered_at IS NOT NULL)";

async function loadOpen(db, orgId, { from, to, overdueFrom }) {
  const where = `o.org_id=? AND s.is_void=0 AND o.smrt_deleted_at IS NULL AND (
      substr(o.due_at,1,10) BETWEEN ? AND ?
      OR (substr(o.due_at,1,10) >= ? AND substr(o.due_at,1,10) < ? AND NOT ${doneSql}))`;
  const args = [orgId, from, to, overdueFrom, from];
  const orders = (await db.prepare(`SELECT o.id, o.smrt_order_no AS no, o.due_at AS due, o.piece_count AS pieces, o.is_route_delivery AS route, o.notes,
      o.customer_ref AS customer, o.ready_at, o.returned_at, o.picked_up_at, o.delivered_at, s.name AS status, s.is_done, rl.name AS loc
      FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id LEFT JOIN core_locations rl ON rl.id=o.return_location_id WHERE ${where}`).bind(...args).all()).results;
  const items = (await db.prepare(`SELECT i.order_id AS orderId, i.assembled_at AS asm, i.lot_status AS lot, i.notes, i.base_cents AS base, i.upcharge_cents AS up, i.discount_cents AS disc,
      t.name AS type, d.name AS dep, st.name AS istatus, COALESCE(st.is_assembled,0) AS isAsm
      FROM pos_items i JOIN pos_orders o ON o.id=i.order_id JOIN pos_order_statuses s ON s.id=o.status_id
      LEFT JOIN pos_item_types t ON t.id=i.item_type_id LEFT JOIN pos_departments d ON d.id=i.department_id LEFT JOIN pos_item_statuses st ON st.id=i.status_id
      WHERE i.removed_at IS NULL AND ${where}`).bind(...args).all()).results;
  const deps = (await db.prepare(`SELECT od.order_id AS orderId, d.name FROM pos_order_departments od JOIN pos_departments d ON d.id=od.department_id
      JOIN pos_orders o ON o.id=od.order_id JOIN pos_order_statuses s ON s.id=o.status_id WHERE ${where}`).bind(...args).all()).results;
  return { orders, items, deps };
}

/** Each order with its pieces split by kind of work: per category [pieces, complete, finished before today, finished today, priced cents, priced pieces]. */
export function splitOrders({ orders, items, deps }, cat, today) {
  const byOrder = new Map(); for (const it of items) (byOrder.get(it.orderId) || byOrder.set(it.orderId, []).get(it.orderId)).push(it);
  const depsOf = new Map(); for (const d of deps) (depsOf.get(d.orderId) || depsOf.set(d.orderId, []).get(d.orderId)).push(d.name);
  return orders.map(o => {
    const finishedAt = [o.ready_at, o.returned_at, o.picked_up_at, o.delivered_at].filter(Boolean).sort()[0] || null;
    const done = !!o.is_done || !!finishedAt;
    const when = d => (d ? (d < today ? "b" : d === today ? "t" : "") : "");
    const per = {}, open = {}, other = {};
    let pieces = 0, complete = 0, washing = 0, noteCount = o.notes ? 1 : 0;
    const add = (k, p, c, b, t, cents, pp) => { const a = per[k] = per[k] || [0, 0, 0, 0, 0, 0]; a[0] += p; a[1] += c; a[2] += b; a[3] += t; a[4] += cents; a[5] += pp; };
    const its = byOrder.get(o.id) || [];
    for (const it of its) {
      const isC = done || !!it.isAsm || !!it.asm;
      const w = isC ? when((it.asm || "").slice(0, 10) || (done ? (finishedAt || "").slice(0, 10) : "")) : "";
      const priced = it.base != null;
      const cents = priced ? Math.max(0, (+it.base || 0) + (+it.up || 0) - (+it.disc || 0)) : 0;
      const k = cat(it.type, it.dep);
      pieces++; if (isC) complete++;
      if (it.notes) noteCount++;
      if (k) add(k, 1, isC ? 1 : 0, w === "b" ? 1 : 0, w === "t" ? 1 : 0, cents, priced ? 1 : 0);
      else other[it.dep || "Other"] = (other[it.dep || "Other"] || 0) + 1;
      if (!isC) {
        const lot = String(it.lot || "").trim(); if (/wash/i.test(lot)) washing++;
        const key = (it.istatus || "not scanned") + (lot && !/^completed?$/i.test(lot) ? ` (${lot.toLowerCase()})` : "");
        open[key] = (open[key] || 0) + 1;
      }
    }
    if (!its.length && o.pieces) { // not detailed yet: the order's piece count, in its department if it has just one
      const ds = depsOf.get(o.id) || [];
      const k = ds.length === 1 ? cat("", ds[0]) : null;
      const w = done ? when((finishedAt || "").slice(0, 10)) : "";
      pieces = o.pieces; complete = done ? pieces : 0;
      if (k) add(k, pieces, complete, w === "b" ? pieces : 0, w === "t" ? pieces : 0, 0, 0); else other[ds[0] || "Not detailed"] = pieces;
      if (!done) open["not detailed"] = pieces;
    }
    const no = String(o.no);
    return { id: o.id, no: no.length > 5 ? `${no.slice(0, 5)}-${no.slice(5)}` : no, due: o.due, dueDay: String(o.due || "").slice(0, 10), status: o.status,
      loc: o.route ? "Route" : o.loc || "Route", customer: o.customer, done, pieces, complete, washing, per, open, other, notes: noteCount };
  });
}

/** How many more pieces usually come in for a day after a given time on the work day before (median of recent days). */
export async function forecastRatios(db, orgId, { today, next, hm, workDays, runs }) {
  // compare with the same moment the same number of days before each past due day (Friday 10 am for a Monday, from Friday 10 am)
  const lead = Math.round((Date.parse(next) - Date.parse(today)) / 864e5);
  const from = addDays(today, -7 * FORECAST_WEEKS);
  const rows = (await db.prepare(`SELECT substr(o.due_at,1,10) AS d, o.smrt_created_at AS created, o.piece_count AS pieces, o.is_route_delivery AS route, rl.name AS loc
      FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id LEFT JOIN core_locations rl ON rl.id=o.return_location_id
      WHERE o.org_id=? AND s.is_void=0 AND substr(o.due_at,1,10) >= ? AND substr(o.due_at,1,10) < ?`).bind(orgId, from, today).all()).results;
  const byDay = new Map();
  for (const r of rows) { if (!workDays.includes(weekday(r.d))) continue; (byDay.get(r.d) || byDay.set(r.d, []).get(r.d)).push({ ...r, loc: r.route ? "Route" : r.loc || "Route" }); }
  const wd = weekday(next);
  const ratio = (filter, sameWeekday) => {
    const out = [];
    for (const [d, list] of byDay) {
      if (sameWeekday && weekday(d) !== wd) continue;
      const l = list.filter(filter); if (!l.length) continue;
      const cut = `${addDays(d, -lead)}T${hm}`;
      const fin = l.reduce((t, o) => t + (+o.pieces || 0), 0), known = l.filter(o => String(o.created || "").slice(0, 16) < cut).reduce((t, o) => t + (+o.pieces || 0), 0);
      if (known >= 30 && fin > 0) out.push(fin / known);
    }
    out.sort((a, b) => a - b);
    return out.length ? { ratio: Math.min(3, Math.max(1, out[Math.floor(out.length / 2)])), n: out.length } : null;
  };
  const all = ratio(() => true, true) || ratio(() => true, false) || { ratio: 1, n: 0 };
  const locs = [...new Set(rows.map(r => (r.route ? "Route" : r.loc || "Route")))];
  const byLoc = {};
  for (const loc of locs) { const r = ratio(o => o.loc === loc, true) || ratio(o => o.loc === loc, false); if (r) byLoc[loc] = r; }
  return { all, byLoc, cutoffs: Object.fromEntries(locs.map(l => [l, cutoffOf(runs, l)])) };
}

/** Everything the Plan and Floor screens need about pieces for today and the next work day. */
export async function piecesView(db, env, { at = new Date() } = {}) {
  const groups = await loadGroups(db, env.ORG_ID);
  const runs = await loadRuns(db, env.ORG_ID);
  const workDays = groups.day.workDays || [1, 2, 3, 4, 5];
  const { day: today, hm } = localNow(env.TIMEZONE, at);
  const isWorkDay = workDays.includes(weekday(today));
  const next = nextWorkDay(today, workDays);
  const cat = categorizer(groups.smrt), runOf = storeToRun(runs);
  const data = await loadOpen(db, env.ORG_ID, { from: today, to: next, overdueFrom: addDays(today, -OVERDUE_DAYS) });
  const orders = splitOrders(data, cat, today);

  const fc = await forecastRatios(db, env.ORG_ID, { today, next, hm, workDays, runs });
  const mk = () => ({ q: zero(), done: zero(), known: zero(), expected: zero(), pieces: 0, orders: 0, openOrders: 0 });
  const dayView = (d, isToday) => {
    const total = mk(), stores = new Map();
    for (const o of orders) {
      if (o.dueDay !== d) continue;
      const r = runOf(o.loc);
      const st = stores.get(o.loc) || stores.set(o.loc, { loc: o.loc, run: r?.name || null, runId: r?.id || null, deadline: runDeadline(r), ...mk() }).get(o.loc);
      for (const [k, p] of Object.entries(o.per)) {
        // today: due today less finished before today (finished today is today's work); later day: less anything finished
        const todo = isToday ? Math.max(0, p[0] - p[2]) : Math.max(0, p[0] - p[1]);
        const done = isToday ? Math.max(0, Math.min(todo, p[1] - p[2])) : 0;
        for (const T of [total, st]) { T.q[k] += todo; T.known[k] += todo; T.done[k] += done; }
      }
      for (const T of [total, st]) { T.pieces += o.pieces; T.orders++; if (!o.done) T.openOrders++; }
    }
    // forecast: only for the next work day, and only before that day starts
    const beforeDay = today < d;
    for (const st of stores.values()) {
      const cut = fc.cutoffs[st.loc], final = !isToday && beforeDay && cut && hm >= cut;
      st.ratio = isToday || final ? 1 : (fc.byLoc[st.loc]?.ratio || fc.all.ratio);
      st.final = isToday ? true : !!final;
      for (const k of CATS) { st.expected[k] = Math.round(st.q[k] * st.ratio); total.expected[k] += st.expected[k]; }
    }
    const sum = o => CATS.reduce((t, k) => t + o[k], 0);
    const ahead = isToday ? null : orders.filter(o => o.dueDay === d).reduce((t, o) => t + Object.values(o.per).reduce((a, p) => a + p[3], 0), 0);
    return {
      day: d, isToday, ...total, todo: sum(total.q), doneTotal: sum(total.done), expectedTotal: sum(total.expected), aheadToday: ahead,
      stores: [...stores.values()].sort((a, b) => (a.deadline ?? 9999) - (b.deadline ?? 9999) || a.loc.localeCompare(b.loc)),
    };
  };
  const overdueOrders = groups.smrt.overdue ? orders.filter(o => o.dueDay < today && !o.done) : [];
  const overdue = { q: zero(), orders: overdueOrders.length };
  for (const o of overdueOrders) for (const [k, p] of Object.entries(o.per)) overdue.q[k] += Math.max(0, p[0] - p[1]);
  overdue.todo = CATS.reduce((t, k) => t + overdue.q[k], 0);

  // average price per piece from SMRT (before tax), when at least 15 priced pieces back it up
  const pr = {}; for (const o of orders) for (const [k, p] of Object.entries(o.per)) { const a = pr[k] = pr[k] || [0, 0]; a[0] += p[4]; a[1] += p[5]; }
  const prices = Object.fromEntries(Object.entries(pr).filter(([, a]) => a[1] >= 15).map(([k, a]) => [k, Math.round(a[0] / a[1]) / 100]));

  const late = orders.filter(o => !o.done && (o.dueDay < today || (o.dueDay === today && isWorkDay)))
    .map(o => ({ no: o.no, due: o.due, status: o.status, loc: o.loc, pieces: o.pieces, left: o.pieces - o.complete, washing: o.washing, open: o.open,
      cats: Object.entries(o.per).filter(([, p]) => p[0] > p[1]).map(([k]) => k), notes: o.notes, customer: o.customer, overdue: o.dueDay < today }))
    .sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  const unmapped = {}; for (const o of orders) if (o.dueDay >= today) for (const [d, n] of Object.entries(o.other)) unmapped[d] = (unmapped[d] || 0) + n;

  const live = await db.prepare("SELECT started_at AS at, finished_at AS done, status, message FROM int_sync_runs WHERE integration_id='smrt' AND message LIKE 'live%' ORDER BY started_at DESC LIMIT 1").first();
  const lastOk = await db.prepare("SELECT finished_at AS at FROM int_sync_runs WHERE integration_id='smrt' AND message LIKE 'live%' AND status='ok' ORDER BY started_at DESC LIMIT 1").first();
  return {
    today, next, now: hm, isWorkDay,
    days: { [today]: isWorkDay ? dayView(today, true) : null, [next]: dayView(next, false) },
    overdue, late, prices, unmapped,
    forecast: { ratio: fc.all.ratio, basedOn: fc.all.n },
    smrt: { lastRun: live || null, lastOk: lastOk?.at || null },
  };
}
