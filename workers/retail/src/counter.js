// Counter (#/counter): what happens at the store counters, from SMRT's own timestamps, checked against Rippling.
// Neal, Oct 18 2026:
//   Visits      = customers walking in. Staff create the SMRT ticket when the customer walks in, so a drop-off is the
//                 ticket's Created time; a pickup is the order's Picked up time. One customer's drop-offs and pickups at
//                 one store on one day, each within `visitWindowMin` of the one before, are one visit: drop-off only,
//                 pickup only, or both. Route pickups/deliveries, deleted tickets and stores with nobody on the clock
//                 (Winnsboro) are left out.
//   Detailing   = SMRT stamps every piece as it's detailed (to the second). The gap between two pieces of one order,
//                 by the same person, is the time that piece took. A gap of `gapSec` (90 s) or more is a
//                 "distraction gap" (a customer walked in, the phone rang): it's counted on its own and left out of the
//                 speed metric. Seconds per piece = the other gaps' average.
//   Salaried    = people paid a salary (Karla, Debra) have no Rippling punches. Their counter hours = their detailing
//                 time (each order's gaps under `gapSec`, plus one typical piece) + `pickupMin` (2 min, the measured
//                 median) for each pickup at their store while they were there, split among everyone at the counter.
//   Visits per labor hour = visits ÷ (Rippling hours at the store + salaried hours there).
//   Clock check = each person-day's SMRT work against Rippling: work at a store Rippling doesn't have them at, work with
//                 no punch at all, work outside their punched hours (beyond `graceMin`). Fix it in Rippling and the flag
//                 clears with the next sync; a Manager can also mark one OK with a note.
import { HttpError, audit } from "../../planner/src/util.js";
import { requireRole } from "../../planner/src/auth.js";
import { loadSettings } from "./settings.js";
import { addDays, localToday, nameMatches } from "./snapshot.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_DAYS = 31;
const span = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5) + 1;
const r1 = n => Math.round(n * 10) / 10, r2 = n => Math.round(n * 100) / 100;
const ms = s => Date.parse(s);
/** 'HH:MM' local time of an SMRT stamp ('2026-10-15T09:13:57-05:00'). */
const hhmm = s => String(s).slice(11, 16);
const mins = t => (t && /^\d{1,2}:\d{2}/.test(t) ? +t.split(":")[0] * 60 + +t.split(":")[1].slice(0, 2) : null);
const norm = v => String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const nameKey = n => { const a = norm(n).split(" "); return a[0] ? `n:${a[0]}${a[1] ? " " + a[1][0] : ""}` : null; };

/** Visits from drop-off and pickup events: [{store, cust, at, kind:'D'|'P'}]. Pure, for tests. */
export function countVisits(events, windowMin = 20) {
  const groups = new Map();
  for (const e of events) {
    const k = `${e.store}|${e.cust}|${String(e.at).slice(0, 10)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(e);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => ms(a.at) - ms(b.at));
    let cur = null, last = 0;
    for (const e of list) {
      const t = ms(e.at);
      if (!cur || t - last > windowMin * 6e4) { cur = { store: e.store, day: String(e.at).slice(0, 10), at: e.at, d: 0, p: 0 }; out.push(cur); }
      cur[e.kind === "D" ? "d" : "p"]++; last = t;
    }
  }
  return out.map(v => ({ ...v, type: v.d && v.p ? "both" : v.d ? "drop" : "pickup" }));
}

/**
 * Detailing per order: pieces [{at, who}] sorted by time. Gaps between consecutive pieces by the same person;
 * under gapSec = work, gapSec or more = a distraction gap. Pure, for tests.
 */
export function detailGaps(pieces, gapSec = 90) {
  const list = [...pieces].sort((a, b) => ms(a.at) - ms(b.at));
  const res = [];
  for (let i = 1; i < list.length; i++) {
    if (list[i].who !== list[i - 1].who) continue;
    const g = (ms(list[i].at) - ms(list[i - 1].at)) / 1000;
    res.push({ who: list[i].who, sec: g, from: list[i - 1].at, to: list[i].at, distraction: g >= gapSec });
  }
  return res;
}

/**
 * Who is who: SMRT staff names ("Ashton D", "Ashton Davis") -> one Rippling person, or a name key when there's none.
 * Returns Map(staff id -> {key, pid, smrt, name, salaried}).
 */
export function matchStaff(staff, people, salaried = []) {
  const personName = new Map(people.map(p => [p.id, p.name]));
  const salariedKeys = new Set(salaried.map(nameKey).filter(Boolean));
  const out = new Map();
  for (const st of staff) {
    let pid = st.pid;
    if (!pid) { const hits = people.filter(p => nameMatches(st.name, p.f, p.l)); if (hits.length === 1) pid = hits[0].id; }
    const key = pid || nameKey(st.name);
    out.set(st.id, { key, pid, smrt: st.name, name: pid ? personName.get(pid) : st.name,
      salaried: salariedKeys.has(nameKey(pid ? personName.get(pid) : st.name)) || salariedKeys.has(nameKey(st.name)) });
  }
  return out;
}

async function all(db, sql, ...b) { return (await db.prepare(sql).bind(...b).all()).results; }

async function gather(db, env, from, to) {
  const org = env.ORG_ID, end = addDays(to, 1);
  const locs = await all(db, "SELECT id, name, kind FROM core_locations WHERE org_id=?", org);
  // tickets created in the range (drop-offs and "who created it")
  const created = await all(db, `SELECT o.id, o.drop_location_id AS loc, o.smrt_created_at AS at, COALESCE(o.customer_ref, 'anon-' || o.id) AS cust,
        o.created_by_staff_id AS sid, o.is_route_pickup AS route
      FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id
     WHERE o.org_id=? AND o.smrt_created_at >= ? AND o.smrt_created_at < ? AND s.is_void=0 AND o.smrt_deleted_at IS NULL AND o.deleted_at IS NULL`, org, from, end);
  // pickups in the range; the created-date bound keeps the scan on an index (an order is picked up within months)
  const pickups = await all(db, `SELECT o.id, o.return_location_id AS loc, o.picked_up_at AS at, COALESCE(o.customer_ref, 'anon-' || o.id) AS cust
      FROM pos_orders o WHERE o.org_id=? AND o.smrt_created_at >= ? AND o.smrt_created_at < ? AND o.picked_up_at >= ? AND o.picked_up_at < ?
       AND o.is_route_delivery=0 AND o.smrt_deleted_at IS NULL AND o.deleted_at IS NULL`, org, addDays(from, -180), end, from, end);
  // pieces detailed in the range (orders created up to two weeks before it)
  const pieces = await all(db, `SELECT i.order_id AS oid, o.drop_location_id AS loc, i.detailed_at AS at, i.detailed_by_staff_id AS sid, o.is_route_pickup AS route
      FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id JOIN pos_items i ON i.order_id=o.id
     WHERE o.org_id=? AND o.smrt_created_at >= ? AND o.smrt_created_at < ? AND s.is_void=0 AND o.smrt_deleted_at IS NULL AND o.deleted_at IS NULL
       AND i.removed_at IS NULL AND i.detailed_at >= ? AND i.detailed_at < ?`, org, addDays(from, -14), end, from, end);
  const staff = await all(db, "SELECT id, smrt_name AS name, person_id AS pid FROM pos_staff WHERE org_id=?", org);
  const people = await all(db, `SELECT id, first_name AS f, last_name AS l, COALESCE(display_name, first_name || ' ' || last_name) AS name FROM core_people WHERE org_id=? AND deleted_at IS NULL`, org);
  const hours = await all(db, `SELECT h.person_id AS pid, h.work_date AS day, h.location_id AS loc, d.name AS dept, h.hours, h.first_in AS fin, h.last_out AS lout
      FROM labor_daily_hours h JOIN core_people p ON p.id=h.person_id LEFT JOIN core_departments d ON d.id=h.department_id
     WHERE p.org_id=? AND h.work_date BETWEEN ? AND ? AND h.deleted_at IS NULL`, org, from, to);
  const okRow = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='retail' AND key='clock_ok'").bind(org).first();
  return { locs, created, pickups, pieces, staff, people, hours, oks: okRow ? JSON.parse(okRow.value_json) : {} };
}

export async function counter(db, env, me, from, to, { now = Date.now() } = {}) {
  if (!DAY.test(from || "") || !DAY.test(to || "")) throw new HttpError(400, "Use dates like 2026-10-12.");
  if (to < from) throw new HttpError(400, "The end date is before the start date.");
  if (span(from, to) > MAX_DAYS) throw new HttpError(400, `Pick ${MAX_DAYS} days or fewer for the Counter.`);
  const s = await loadSettings(db, env), c = s.counter;
  const today = localToday(env.TIMEZONE, new Date(now));
  const g = await gather(db, env, from, to);
  const loc = new Map(g.locs.map(l => [l.id, l]));
  const hidden = new Set(s.hidden.map(h => h.toLowerCase()));

  const staffOf = matchStaff(g.staff, g.people, c.salaried);
  const who = sid => staffOf.get(sid) || null;
  // keep the longest SMRT spelling as the display name for people Rippling doesn't know
  const display = new Map();
  for (const x of staffOf.values()) if (!x.pid && (!display.has(x.key) || x.smrt.length > display.get(x.key).length)) display.set(x.key, x.smrt);
  const nameOf = x => (x.pid ? x.name : display.get(x.key) || x.smrt);

  // ---- stores: SMRT store locations, minus hidden ones and ones rolled into another (no staff of their own)
  const storeName = id => { const l = loc.get(id); if (!l || l.kind !== "store" || hidden.has(l.name.toLowerCase()) || s.rollup[l.name]) return null; return l.name; };
  // Rippling hours at stores, and who was on the clock when (for splitting pickups)
  const ripByStore = new Map(), onClock = new Map(), ripDay = new Map();
  for (const h of g.hours) {
    const pd = `${h.pid}|${h.day}`;
    const R = ripDay.get(pd) || ripDay.set(pd, { stores: new Set(), locs: new Set(), fin: null, lout: null, hours: 0 }).get(pd);
    const l = loc.get(h.loc); R.locs.add(l ? l.name : "?"); R.hours += h.hours;
    const fi = mins(h.fin), lo = mins(h.lout);
    if (fi != null && (R.fin == null || fi < R.fin)) R.fin = fi;
    if (lo != null && (R.lout == null || lo > R.lout)) R.lout = lo;
    const sn = storeName(h.loc);
    if (!sn) continue;
    R.stores.add(sn);
    ripByStore.set(sn, (ripByStore.get(sn) || 0) + h.hours);
    const k = `${sn}|${h.day}`;
    (onClock.get(k) || onClock.set(k, []).get(k)).push({ key: h.pid, a: fi, b: lo });
  }
  const staffed = new Set(ripByStore.keys());

  // ---- visits
  const events = [];
  for (const o of g.created) { const sn = storeName(o.loc); if (sn && staffed.has(sn) && !o.route) events.push({ store: sn, cust: o.cust, at: o.at, kind: "D" }); }
  for (const o of g.pickups) { const sn = storeName(o.loc); if (sn && staffed.has(sn)) events.push({ store: sn, cust: o.cust, at: o.at, kind: "P" }); }
  const visits = countVisits(events, c.visitWindowMin);

  // ---- SMRT activity per person-day (for the clock check and salaried presence)
  const act = new Map();   // key|day -> {who, day, byStore: Map(store -> {n, first, last, created, pieces})}
  const note = (x, at, sn, kind) => {
    if (!x || !sn) return;
    const day = String(at).slice(0, 10), k = `${x.key}|${day}`;
    const A = act.get(k) || act.set(k, { x, day, byStore: new Map(), n: 0 }).get(k);
    const B = A.byStore.get(sn) || A.byStore.set(sn, { n: 0, first: at, last: at, created: 0, pieces: 0, times: [] }).get(sn);
    B.n++; A.n++; B[kind]++; B.times.push(mins(hhmm(at)));
    if (ms(at) < ms(B.first)) B.first = at; if (ms(at) > ms(B.last)) B.last = at;
  };
  // a route ticket or a rolled-up location (Winnsboro) is still work done at the store it belongs to
  const workStore = id => { const l = loc.get(id); if (!l) return null; if (s.rollup[l.name]) return s.rollup[l.name]; return storeName(id); };
  for (const o of g.created) note(who(o.sid), o.at, workStore(o.loc), "created");
  for (const p of g.pieces) note(who(p.sid), p.at, workStore(p.loc), "pieces");

  // ---- detailing speed (store = the order's store; route tickets and Winnsboro count where they're worked)
  const byOrder = new Map();
  for (const p of g.pieces) { const x = who(p.sid); if (!x) continue; (byOrder.get(p.oid) || byOrder.set(p.oid, { loc: p.loc, list: [] }).get(p.oid)).list.push({ at: p.at, who: x.key }); }
  const per = new Map(), stDet = new Map();
  const P = (key, sn) => { const k = `${sn}|${key}`; return per.get(k) || per.set(k, { store: sn, key, orders: 0, pieces: 0, workSec: 0, workGaps: 0, gaps: 0, gapSec: 0, salariedSec: 0, pickupSec: 0 }).get(k); };
  const S = sn => stDet.get(sn) || stDet.set(sn, { pieces: 0, workSec: 0, workGaps: 0, gaps: 0, salariedSec: 0, pickupSec: 0 }).get(sn);
  const salariedOrders = [];
  for (const [, o] of byOrder) {
    const sn = workStore(o.loc); if (!sn) continue;
    const byWho = new Map(); for (const p of o.list) byWho.set(p.who, (byWho.get(p.who) || 0) + 1);
    for (const [k, n] of byWho) { const row = P(k, sn); row.orders++; row.pieces += n; S(sn).pieces += n; }
    for (const gp of detailGaps(o.list, c.gapSec)) {
      const row = P(gp.who, sn), st = S(sn);
      if (gp.distraction) { row.gaps++; row.gapSec += gp.sec; st.gaps++; }
      else { row.workSec += gp.sec; row.workGaps++; st.workSec += gp.sec; st.workGaps++; }
    }
    salariedOrders.push({ sn, o });
  }
  // salaried detailing time: each order's work gaps + one typical piece (their own average, else the store's, else 30 s)
  const keyInfo = new Map([...staffOf.values()].map(x => [x.key, x]));
  for (const { sn, o } of salariedOrders) {
    const keys = new Set(o.list.map(p => p.who));
    for (const k of keys) {
      const x = keyInfo.get(k); if (!x || !x.salaried) continue;
      const row = P(k, sn), st = S(sn);
      const typical = row.workGaps ? row.workSec / row.workGaps : st.workGaps ? st.workSec / st.workGaps : 30;
      const work = detailGaps(o.list.filter(p => p.who === k), c.gapSec).filter(x2 => !x2.distraction).reduce((t, x2) => t + x2.sec, 0);
      row.salariedSec += work + typical; st.salariedSec += work + typical;
    }
  }
  // salaried pickups: pickupMin per pickup at their store while they were working (first to last SMRT activity, ± grace),
  // split among everyone at the counter then (Rippling punches + salaried people working)
  const salariedSpans = new Map();   // store|day -> [{key, a, b}]
  for (const A of act.values()) {
    if (!A.x.salaried) continue;
    for (const [sn, B] of A.byStore) {
      const k = `${sn}|${A.day}`;
      (salariedSpans.get(k) || salariedSpans.set(k, []).get(k)).push({ key: A.x.key, a: mins(hhmm(B.first)) - c.graceMin, b: mins(hhmm(B.last)) + c.graceMin });
    }
  }
  for (const o of g.pickups) {
    const sn = storeName(o.loc); if (!sn) continue;
    const k = `${sn}|${String(o.at).slice(0, 10)}`, t = mins(hhmm(o.at));
    const sal = (salariedSpans.get(k) || []).filter(x => t >= x.a && t <= x.b);
    if (!sal.length) continue;
    const clocked = (onClock.get(k) || []).filter(x => x.a != null && t >= x.a && (x.b == null || t <= x.b));
    const share = c.pickupMin * 60 / (sal.length + clocked.length);
    for (const x of sal) { P(x.key, sn).pickupSec += share; S(sn).pickupSec += share; }
  }

  // ---- stores
  const storeNames = [...new Set([...staffed, ...[...stDet.keys()].filter(n => staffed.has(n))])].sort();
  const stores = storeNames.map(sn => {
    const v = visits.filter(x => x.store === sn), d = S(sn);
    const salariedHours = (d.salariedSec + d.pickupSec) / 3600, rip = ripByStore.get(sn) || 0, hrs = rip + salariedHours;
    return { name: sn, visits: v.length, dropOnly: v.filter(x => x.type === "drop").length, pickupOnly: v.filter(x => x.type === "pickup").length, both: v.filter(x => x.type === "both").length,
      ripplingHours: r2(rip), salariedHours: r2(salariedHours), hours: r2(hrs), visitsPerHour: hrs > 0 ? r2(v.length / hrs) : null,
      pieces: d.pieces, secPerPiece: d.workGaps ? r1(d.workSec / d.workGaps) : null, gaps: d.gaps, gapsPer100: d.pieces ? r1(d.gaps / d.pieces * 100) : null };
  });
  const tot = stores.reduce((t, x) => { for (const k of ["visits", "dropOnly", "pickupOnly", "both", "ripplingHours", "salariedHours", "hours", "pieces", "gaps"]) t[k] += x[k]; return t; },
    { visits: 0, dropOnly: 0, pickupOnly: 0, both: 0, ripplingHours: 0, salariedHours: 0, hours: 0, pieces: 0, gaps: 0 });
  const allDet = storeNames.map(S).reduce((t, d) => ({ w: t.w + d.workSec, n: t.n + d.workGaps }), { w: 0, n: 0 });
  const totals = { ...tot, ripplingHours: r2(tot.ripplingHours), salariedHours: r2(tot.salariedHours), hours: r2(tot.hours), visitsPerHour: tot.hours > 0 ? r2(tot.visits / tot.hours) : null,
    secPerPiece: allDet.n ? r1(allDet.w / allDet.n) : null, gapsPer100: tot.pieces ? r1(tot.gaps / tot.pieces * 100) : null };

  const people = [...per.values()].filter(r => staffed.has(r.store) && r.pieces > 0).map(r => {
    const x = keyInfo.get(r.key) || { key: r.key, smrt: r.key, salaried: false };
    return { store: r.store, name: nameOf(x), salaried: !!x.salaried, orders: r.orders, pieces: r.pieces, secPerPiece: r.workGaps ? r1(r.workSec / r.workGaps) : null,
      gaps: r.gaps, gapsPer100: r.pieces ? r1(r.gaps / r.pieces * 100) : null, gapMin: r1(r.gapSec / 60),
      salariedHours: x.salaried ? r2((r.salariedSec + r.pickupSec) / 3600) : null };
  }).sort((a, b) => a.store.localeCompare(b.store) || b.pieces - a.pieces);

  // ---- clock check (finished days only: today's punches are still coming in)
  const checks = [];
  const fmt = m => (m == null ? "?" : `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m >= 720 ? "PM" : "AM"}`);
  for (const A of act.values()) {
    if (A.day >= today || A.n < c.minEvents) continue;
    const x = A.x, R = x.pid ? ripDay.get(`${x.pid}|${A.day}`) : null;
    const smrt = [...A.byStore.entries()].map(([store, B]) => ({ store, events: B.n, created: B.created, pieces: B.pieces, first: hhmm(B.first), last: hhmm(B.last) })).sort((a, b) => b.events - a.events);
    const base = { day: A.day, person: nameOf(x), personId: x.pid || null, smrtName: x.smrt, smrt,
      rippling: R ? { locations: [...R.locs], hours: r2(R.hours), firstIn: R.fin != null ? fmt(R.fin) : null, lastOut: R.lout != null ? fmt(R.lout) : null } : null };
    const push = (kind, text, extra = {}) => {
      const key = `${A.day}|${x.key}|${kind}${extra.store ? "|" + extra.store : ""}`;
      checks.push({ key, kind, text, ...base, ...extra, ok: g.oks[key] || null });
    };
    if (!R) {
      if (!x.salaried) push("no_punch", `SMRT work at ${smrt.map(m => m.store).join(", ")} but no Rippling punch that day`);
      continue;
    }
    for (const m of smrt) {
      if (m.events < c.minEvents || R.stores.has(m.store) || !staffed.has(m.store)) continue;
      if (m.events / A.n < 0.2) continue;   // a few tickets for another store isn't a wrong clock-in
      push("wrong_store", `Worked at ${m.store} in SMRT; Rippling has them at ${[...R.locs].join(", ")}`, { store: m.store });
    }
    if (R.fin != null && R.lout != null) {
      const times = [...A.byStore.values()].flatMap(B => B.times).filter(t => t != null);
      const early = times.filter(t => t < R.fin - c.graceMin), late = times.filter(t => t > R.lout + c.graceMin);
      if (early.length + late.length >= c.minEvents) {
        const parts = [];
        if (early.length) parts.push(`${early.length} before clock-in (from ${fmt(Math.min(...early))})`);
        if (late.length) parts.push(`${late.length} after clock-out (until ${fmt(Math.max(...late))})`);
        push("outside_hours", `SMRT work outside punched hours: ${parts.join(", ")}`);
      }
    }
  }
  checks.sort((a, b) => (a.ok ? 1 : 0) - (b.ok ? 1 : 0) || b.day.localeCompare(a.day) || a.person.localeCompare(b.person));

  return { from, to, today, settings: c, stores, totals, people, checks, checkedThrough: addDays(today < addDays(to, 1) ? today : addDays(to, 1), -1) };
}

/** Marks a clock-check flag OK (or reopens it). Managers and up. Kept in core_settings retail/clock_ok, last 120 days. */
export async function markCheck(db, env, me, body) {
  requireRole(me, "manager");
  const key = String(body.key || "");
  if (!/^\d{4}-\d{2}-\d{2}\|[^|]{1,80}\|(no_punch|wrong_store|outside_hours)(\|[^|]{1,60})?$/.test(key)) throw new HttpError(400, "That isn't a clock-check flag.");
  const row = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='retail' AND key='clock_ok'").bind(env.ORG_ID).first();
  const oks = row ? JSON.parse(row.value_json) : {};
  const cutoff = addDays(localToday(env.TIMEZONE), -120);
  for (const k of Object.keys(oks)) if (k.slice(0, 10) < cutoff) delete oks[k];
  if (body.ok === false) delete oks[key];
  else {
    const noteText = String(body.note || "").trim().slice(0, 200);
    if (!noteText) throw new HttpError(400, "Say why it's OK (for example: worked Greenville tickets from Sulphur Springs).");
    oks[key] = { by: me.name || me.email, at: new Date().toISOString(), note: noteText };
  }
  await db.prepare(`INSERT INTO core_settings(org_id, app_id, key, value_json, updated_by) VALUES(?, 'retail', 'clock_ok', ?, ?)
    ON CONFLICT(org_id, app_id, key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), rev=rev+1`)
    .bind(env.ORG_ID, JSON.stringify(oks), me.id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_settings", entityId: "retail.clock_ok", action: "update", changes: { key, ok: body.ok !== false, note: oks[key]?.note } });
  return { key, ok: oks[key] || null };
}
