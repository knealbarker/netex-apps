// Review: how a day actually went, against its plan.
//  - pieces assembled that day (SMRT), through the day, and by kind of work
//  - pieces due that day and how many were finished by the end of it (deadlines only while SHUTTLES is on)
//  - hours from Rippling, pieces per labor hour, and (Admins and the Owner only) labor cost and labor % of revenue
//  - each person's real clock-in, clock-out, break and paid hours; the page lays them against the plan (it replays the
//    plan with the same model as the Plan page: red finish lines, should-leave times, paced labor)
//  - follow-ups: orders whose due date SMRT moved later, with a reason and a note
//  - the last few weeks of work days, for the trend
import { HttpError, nowIso, audit } from "./util.js";
import { requireRole, rank } from "./auth.js";
import { loadGroups, loadRuns } from "./settings.js";
import { productionIds } from "./team.js";
import { payRates, laborCost } from "./pay.js";
import { dayTally } from "./tally.js";
import { firstBreak, minuteOf } from "../public/js/engine/breakpay.js";
import { SHUTTLES } from "./features.js";
import { CATS, categorizer, splitOrders, loadOpen, nextWorkDay, prevWorkDay, addDays, localNow, storeToRun, runDeadline } from "./pieces.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const hmOf = ts => { const m = /[T ](\d\d):(\d\d)/.exec(ts || ""); return m ? +m[1] + +m[2] / 60 : null; };
const toH = t => { const m = /^(\d\d):(\d\d)$/.exec(t || ""); return m ? +m[1] + +m[2] / 60 : null; };
const weekday = day => new Date(day + "T12:00:00Z").getUTCDay();
const cents = it => Math.max(0, (+it.base || 0) + (+it.up || 0) - (+it.disc || 0));

/** Pieces assembled on a day, by kind of work, with their revenue and the running count through the day. */
async function assembled(db, orgId, day, cat, prices) {
  const rows = (await db.prepare(`SELECT i.assembled_at AS asm, t.name AS type, d.name AS dep, i.base_cents AS base, i.upcharge_cents AS up, i.discount_cents AS disc
      FROM pos_items i JOIN pos_orders o ON o.id=i.order_id JOIN pos_order_statuses s ON s.id=o.status_id
      LEFT JOIN pos_item_types t ON t.id=i.item_type_id LEFT JOIN pos_departments d ON d.id=i.department_id
      WHERE o.org_id=? AND s.is_void=0 AND i.removed_at IS NULL AND substr(i.assembled_at,1,10)=?`).bind(orgId, day).all()).results;
  const q = Object.fromEntries(CATS.map(k => [k, 0])); let rev = 0, n = 0;
  const times = [], byHour = {}, byCat = {}; // byCat: minute of the day each piece was assembled, by kind of work // byHour: { "7": {slb: 12, ...} } pieces assembled in each clock hour, by kind of work
  for (const r of rows) {
    const k = cat(r.type, r.dep); if (!k) continue;
    q[k]++; n++;
    rev += r.base != null ? cents(r) / 100 : (+prices[k] || 0);
    const h = hmOf(r.asm); if (h != null) { times.push(h); const hr = Math.floor(h); (byHour[hr] = byHour[hr] || {})[k] = (byHour[hr][k] || 0) + 1; (byCat[k] = byCat[k] || []).push(Math.round(h * 60)); }
  }
  times.sort((a, b) => a - b);
  // running count, one point per 15 minutes that had any pieces
  const curve = []; let c = 0;
  for (const t of times) { c++; const slot = Math.ceil(t * 4) / 4; const last = curve[curve.length - 1]; if (last && last[0] === slot) last[1] = c; else curve.push([slot, c]); }
  for (const k in byCat) byCat[k].sort((a, b) => a - b);
  return { q, pieces: n, revenue: rev, curve, byHour, byCat };
}

/** Hours worked in Production on a day: finished days from Rippling's daily totals; today from the punches so far. */
async function hours(db, env, day, today, departmentId) {
  if (day === today) {
    const rows = (await db.prepare(`SELECT c.person_id AS personId, c.clock_in AS cin, c.clock_out AS cout, p.first_name || ' ' || p.last_name AS name
        FROM labor_clock_today c JOIN core_people p ON p.id=c.person_id WHERE p.org_id=? AND substr(c.clock_in,1,10)=? AND (c.department_id IS NULL OR c.department_id=(SELECT d.id FROM core_departments d WHERE d.org_id=p.org_id AND d.name='Production'))`).bind(env.ORG_ID, day).all()).results;
    const nowH = toH(localNow(env.TIMEZONE).hm);
    const by = new Map(), punches = new Map();
    for (const r of rows) {
      (punches.get(r.personId) || punches.set(r.personId, []).get(r.personId)).push({ i: minuteOf(r.cin), o: r.cout ? minuteOf(r.cout) : null });
      const a = hmOf(r.cin), b = r.cout ? hmOf(r.cout) : nowH;
      const x = by.get(r.personId) || by.set(r.personId, { personId: r.personId, name: r.name, hours: 0, firstIn: null, lastOut: null, open: false }).get(r.personId);
      if (a != null && b != null) x.hours += Math.max(0, b - a);
      if (a != null && (x.firstIn == null || a < x.firstIn)) x.firstIn = a;
      if (!r.cout) x.open = true; else if (x.lastOut == null || b > x.lastOut) x.lastOut = b;
    }
    // the paid break (Neal, Oct 15): the first gap, up to 30 min, none if back after more than 35; a break still going counts while within 35
    for (const x of by.values()) {
      const b = firstBreak(punches.get(x.personId), nowH == null ? null : Math.round(nowH * 60));
      x.breakPaid = b ? b.paid / 60 : 0; x.breakMin = b ? b.gap : null; x.breakOpen = !!(b && b.open); x.hours += x.breakPaid;
    }
    return [...by.values()].map(x => ({ ...x, lastOut: x.open ? null : x.lastOut }));
  }
  // finished days: Rippling's hours already include the paid break (netex-sync)
  return (await db.prepare(`SELECT h.person_id AS personId, h.hours, h.break_paid_hours AS bp, h.first_in AS fi, h.last_out AS lo, p.first_name || ' ' || p.last_name AS name
      FROM labor_daily_hours h JOIN core_people p ON p.id=h.person_id WHERE h.department_id=? AND h.work_date=? AND h.deleted_at IS NULL`).bind(departmentId, day).all()).results
    .map(r => {
      const hours = +r.hours || 0, breakPaid = +r.bp || 0, firstIn = toH(r.fi), lastOut = toH(r.lo);
      // punches aren't kept after the day is added up: time off the clock = first in to last out, less the hours worked
      const offMin = firstIn != null && lastOut != null ? Math.max(0, Math.round((lastOut - firstIn - (hours - breakPaid)) * 60)) : null;
      return { personId: r.personId, name: r.name, hours, breakPaid, offMin, firstIn, lastOut, open: !r.lo };
    });
}

export async function reviewDay(db, env, me, day) {
  if (!DAY.test(day)) throw new HttpError(400, "Use a date like 2026-10-12.");
  const groups = await loadGroups(db, env.ORG_ID), runs = await loadRuns(db, env.ORG_ID);
  const workDays = groups.day.workDays || [1, 2, 3, 4, 5];
  const today = localNow(env.TIMEZONE).day;
  if (day > today) throw new HttpError(400, "That day hasn't happened yet.");
  const money = rank(me.role) >= rank("admin");
  const cat = categorizer(groups.smrt), prices = groups.money.prices;
  const { departmentId, locationId } = await productionIds(db, env.ORG_ID);

  const done = await assembled(db, env.ORG_ID, day, cat, prices);

  // pieces due that day (route orders the work day before their route) and whether they were finished by the end of it
  const routeDay = groups.route?.dayBefore ? nextWorkDay(day, workDays) : day;
  const data = await loadOpen(db, env.ORG_ID, { from: day, to: routeDay, overdueFrom: day });
  const orders = splitOrders(data, cat, addDays(day, 1), groups.smrt.transitRack)
    .map(o => ({ ...o, workDay: o.loc === "Route" && groups.route?.dayBefore ? prevWorkDay(o.dueDay, workDays) : o.dueDay }))
    .filter(o => o.workDay === day);
  const asmByOrder = new Map();
  for (const it of data.items) { const h = it.asm && it.asm.slice(0, 10) <= day ? (it.asm.slice(0, 10) < day ? 0 : hmOf(it.asm)) : null; const cur = asmByOrder.get(it.orderId) || { max: -1, open: 0 };
    if (h == null) cur.open++; else cur.max = Math.max(cur.max, h); asmByOrder.set(it.orderId, cur); }
  const due = { q: Object.fromEntries(CATS.map(k => [k, 0])), done: Object.fromEntries(CATS.map(k => [k, 0])), pieces: 0, finished: 0, orders: orders.length };
  for (const o of orders) for (const [k, p] of Object.entries(o.per)) { due.q[k] += p[0]; due.done[k] += p[2]; due.pieces += p[0]; due.finished += p[2]; }

  // the plan: the latest published copy, else the saved crew
  const pub = await db.prepare(`SELECT p.published_at AS at, u.display_name AS by, p.snapshot_json AS snap FROM plan_publications p JOIN plan_days d ON d.id=p.day_id
      LEFT JOIN core_users u ON u.id=p.published_by WHERE d.location_id=? AND d.work_date=? ORDER BY p.published_at DESC LIMIT 1`).bind(locationId, day).first();
  const snap = pub ? JSON.parse(pub.snap) : null;
  const planned = snap ? { source: "published", at: pub.at, by: pub.by, metrics: snap.metrics, waves: snap.waves || [],
      crew: Object.entries(snap.input.crew).filter(([, c]) => c.emp).map(([code, c]) => ({ code, personId: c.emp, start: c.start, hours: +c.hrs, stop: c.stop || "",
        label: [...snap.input.stations, ...snap.input.ops].find(p => p.id === code)?.label || code })), settings: { breakMin: snap.input.settings.breakMin, breakAfter: snap.input.settings.breakAfter } }
    : await (async () => {
      const rows = (await db.prepare(`SELECT s.code, s.label, a.person_id AS personId, a.starts_at AS start, a.hours, a.hard_stop AS stop FROM plan_assignments a JOIN plan_days d ON d.id=a.day_id
          JOIN plan_stations s ON s.id=a.station_id WHERE d.location_id=? AND d.work_date=? AND a.deleted_at IS NULL AND a.person_id IS NOT NULL ORDER BY s.sort`).bind(locationId, day).all()).results;
      return rows.length ? { source: "saved", metrics: null, waves: [], crew: rows.map(r => ({ ...r, stop: r.stop || "" })), settings: { breakMin: groups.day.breakMin, breakAfter: groups.day.breakAfter } } : null;
    })();

  // deadlines: when each run's pieces were really ready (the last piece assembled), against the deadline and the plan's ready time
  const runOf = storeToRun(runs);
  const waves = new Map();
  for (const o of SHUTTLES ? orders : []) {   // shuttles are switched off (Oct 13): no deadlines
    const r = o.loc === "Route" ? { id: "route", name: "Route deliveries", kind: "route" } : runOf(o.loc) || { id: "other", name: "No run set", kind: "counter" };
    const catPieces = Object.values(o.per).reduce((t, p) => t + p[0], 0); if (!catPieces) continue;
    const dm = r.kind === "route" ? null : runDeadline(r);
    const w = waves.get(r.id) || waves.set(r.id, { id: r.id, name: r.name, kind: r.kind, deadline: dm == null ? null : dm / 60, pieces: 0, left: 0, readyAt: -1, stores: new Set() }).get(r.id);
    const a = asmByOrder.get(o.id) || { max: -1, open: 0 };
    w.pieces += catPieces; w.stores.add(o.loc);
    const leftHere = Math.max(0, catPieces - Object.values(o.per).reduce((t, p) => t + p[2], 0));
    w.left += leftHere;
    if (!leftHere) w.readyAt = Math.max(w.readyAt, a.max);
  }
  const deadlines = [...waves.values()].map(w => {
    const pw = planned?.waves?.find(x => x.id === w.id);
    return { id: w.id, name: w.name, kind: w.kind, deadline: w.deadline, pieces: w.pieces, left: w.left, readyAt: w.left ? null : (w.readyAt >= 0 ? w.readyAt : null), plannedEta: pw ? pw.eta : null, stores: [...w.stores] };
  }).sort((a, b) => (a.deadline ?? 99) - (b.deadline ?? 99));

  const people = await hours(db, env, day, today, departmentId);
  const laborH = people.reduce((t, p) => t + p.hours, 0);
  const rates = money ? await payRates(db, env.ORG_ID) : null;
  const lc = money ? laborCost(people, day, rates, groups.money.payAvg) : null;
  const labor = { hours: laborH, breakPaid: people.reduce((t, p) => t + (p.breakPaid || 0), 0), people: people.length, perHour: laborH > 0 ? done.pieces / laborH : null,
    ...(money ? { cost: lc.cost, avgHours: lc.avgHours, revenue: done.revenue, pct: done.revenue > 0 && laborH > 0 ? lc.cost / done.revenue * 100 : null, target: groups.money.laborTarget, payAvg: groups.money.payAvg } : {}) };

  // plan vs actual, person by person
  const vs = [];
  if (planned) {
    const seen = new Set();
    for (const c of planned.crew) {
      const ps = toH(c.start), pe = ps != null ? ps + c.hours + (c.hours > planned.settings.breakAfter ? planned.settings.breakMin / 60 : 0) : null;
      const a = people.find(p => p.personId === c.personId); if (a) seen.add(a.personId);
      vs.push({ personId: c.personId, name: a?.name || null, station: c.label, plannedIn: ps, plannedOut: c.stop ? Math.min(pe, toH(c.stop)) : pe, plannedHours: c.hours,
        actualIn: a?.firstIn ?? null, actualOut: a?.lastOut ?? null, actualHours: a?.hours ?? null, breakPaid: a?.breakPaid ?? 0, breakMin: a?.breakMin ?? null, breakOpen: !!a?.breakOpen, offMin: a?.offMin ?? null, stillIn: !!a?.open, missing: !a });
    }
    for (const a of people) if (!seen.has(a.personId)) vs.push({ personId: a.personId, name: a.name, station: null, unplanned: true, actualIn: a.firstIn, actualOut: a.lastOut, actualHours: a.hours, breakPaid: a.breakPaid || 0, breakMin: a.breakMin ?? null, breakOpen: !!a.breakOpen, offMin: a.offMin ?? null, stillIn: a.open });
    const names = new Map((await db.prepare("SELECT id, first_name || ' ' || last_name AS n FROM core_people WHERE org_id=?").bind(env.ORG_ID).all()).results.map(r => [r.id, r.n]));
    for (const v of vs) if (!v.name) v.name = names.get(v.personId) || "Someone";
  }

  return { day, today, isToday: day === today, isWorkDay: workDays.includes(weekday(day)), prev: prevWorkDay(day, workDays), next: day < today ? nextWorkDay(day, workDays) : null, nextWork: nextWorkDay(day, workDays),
    done: money ? done : { ...done, revenue: undefined }, due, deadlines, labor, people: vs,
    actual: people.map(a => ({ personId: a.personId, name: a.name, hours: a.hours, breakPaid: a.breakPaid || 0, breakMin: a.breakMin ?? null, breakOpen: !!a.breakOpen,
      offMin: a.offMin ?? null, firstIn: a.firstIn, lastOut: a.lastOut, open: !!a.open })), planned: planned ? { source: planned.source, at: planned.at || null, by: planned.by || null, metrics: planned.metrics } : null,
    tally: await dayTally(db, env, day).catch(e => { console.error(JSON.stringify({ job: "review", tallyError: String(e && e.stack || e) })); return null; }),
    followups: await followups(db, env, day), trend: await trend(db, env, day, workDays, departmentId, cat, prices, money ? { payAvg: groups.money.payAvg, rates } : null), money };
}

async function followups(db, env, day) {
  const rows = (await db.prepare(`SELECT f.id, f.kind, f.status, f.reason_id AS reasonId, f.note, f.created_at AS at, f.noted_at AS notedAt, u.display_name AS notedBy,
      o.smrt_order_no AS no, o.customer_ref AS customer, o.due_at AS due, o.notes AS smrtNote, c.old_value AS oldDue, c.new_value AS newDue, l.name AS loc
      FROM plan_followups f JOIN pos_orders o ON o.id=f.order_id LEFT JOIN pos_changes c ON c.id=f.change_id LEFT JOIN core_users u ON u.id=f.noted_by
      LEFT JOIN core_locations l ON l.id=o.return_location_id
      WHERE o.org_id=? AND f.deleted_at IS NULL AND (f.status<>'resolved' OR substr(f.resolved_at,1,10)>=?) ORDER BY f.status='resolved', f.created_at DESC LIMIT 200`).bind(env.ORG_ID, day).all()).results;
  const reasons = (await db.prepare("SELECT id, name FROM plan_followup_reasons ORDER BY sort").all()).results;
  return { reasons, list: rows.map(r => { const no = String(r.no); return { ...r, no: no.length > 5 ? `${no.slice(0, 5)}-${no.slice(5)}` : no }; }) };
}

/** The last 15 work days up to this one: hours, pieces assembled, pieces per labor hour, and labor % for Admins. */
export async function trend(db, env, day, workDays, departmentId, cat, prices, pay, n = 15) {
  const days = [day]; while (days.length < n) days.unshift(prevWorkDay(days[0], workDays));
  const from = days[0];
  const byDay = new Map();
  for (const r of (await db.prepare(`SELECT work_date AS d, person_id AS personId, SUM(hours) AS hours FROM labor_daily_hours WHERE department_id=? AND work_date BETWEEN ? AND ? AND deleted_at IS NULL GROUP BY work_date, person_id`)
    .bind(departmentId, from, day).all()).results) (byDay.get(r.d) || byDay.set(r.d, []).get(r.d)).push(r);
  const items = (await db.prepare(`SELECT substr(i.assembled_at,1,10) AS d, t.name AS type, dep.name AS dep, i.base_cents AS base, i.upcharge_cents AS up, i.discount_cents AS disc
      FROM pos_items i JOIN pos_orders o ON o.id=i.order_id JOIN pos_order_statuses s ON s.id=o.status_id
      LEFT JOIN pos_item_types t ON t.id=i.item_type_id LEFT JOIN pos_departments dep ON dep.id=i.department_id
      WHERE o.org_id=? AND s.is_void=0 AND i.removed_at IS NULL AND substr(i.assembled_at,1,10) BETWEEN ? AND ?`).bind(env.ORG_ID, from, day).all()).results;
  const per = new Map();
  for (const it of items) { const k = cat(it.type, it.dep); if (!k) continue; const x = per.get(it.d) || per.set(it.d, { pieces: 0, rev: 0 }).get(it.d); x.pieces++; x.rev += it.base != null ? cents(it) / 100 : (+prices[k] || 0); }
  return days.map(d => {
    const rows = byDay.get(d) || [], h = rows.reduce((t, r) => t + (+r.hours || 0), 0), p = per.get(d) || { pieces: 0, rev: 0 };
    const out = { day: d, hours: h, pieces: p.pieces, perHour: h > 0 ? p.pieces / h : null };
    if (pay) out.pct = p.rev > 0 && h > 0 ? laborCost(rows, d, pay.rates, pay.payAvg).cost / p.rev * 100 : null;
    return out;
  });
}

export async function noteFollowup(db, env, me, id, body) {
  requireRole(me, "manager");
  const f = await db.prepare("SELECT f.id, f.status FROM plan_followups f JOIN pos_orders o ON o.id=f.order_id WHERE f.id=? AND o.org_id=?").bind(id, env.ORG_ID).first();
  if (!f) throw new HttpError(404, "That follow-up isn't there any more.");
  const reasons = new Set((await db.prepare("SELECT id FROM plan_followup_reasons").all()).results.map(r => r.id));
  const reasonId = body.reasonId == null || body.reasonId === "" ? null : String(body.reasonId);
  if (reasonId && !reasons.has(reasonId)) throw new HttpError(400, "Pick a reason from the list.");
  const note = String(body.note ?? "").trim().slice(0, 500) || null;
  if (!reasonId && !note && !body.resolved) throw new HttpError(400, "Pick a reason or write a note.");
  const now = nowIso();
  const status = body.resolved ? "resolved" : "noted";
  await db.prepare(`UPDATE plan_followups SET reason_id=COALESCE(?, reason_id), note=COALESCE(?, note), noted_by=CASE WHEN ? THEN ? ELSE noted_by END, noted_at=CASE WHEN ? THEN ? ELSE noted_at END,
      status=?, resolved_by=CASE WHEN ?='resolved' THEN ? ELSE resolved_by END, resolved_at=CASE WHEN ?='resolved' THEN ? ELSE resolved_at END, updated_at=?, updated_by=?, rev=rev+1 WHERE id=?`)
    .bind(reasonId, note, reasonId || note ? 1 : 0, me.id, reasonId || note ? 1 : 0, now, status, status, me.id, status, now, now, me.id, id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_followups", entityId: id, action: "update", changes: { reasonId, note, status } });
  return { id, status };
}

/** Work days in a row (before today) with labor at or under the target — for the Floor screen. Shows no money. */
export async function laborStreak(db, env) {
  const groups = await loadGroups(db, env.ORG_ID), workDays = groups.day.workDays || [1, 2, 3, 4, 5];
  const today = localNow(env.TIMEZONE).day, last = prevWorkDay(today, workDays);
  const { departmentId } = await productionIds(db, env.ORG_ID);
  const T = await trend(db, env, last, workDays, departmentId, categorizer(groups.smrt), groups.money.prices, { payAvg: groups.money.payAvg, rates: await payRates(db, env.ORG_ID) }, 30);
  let n = 0;
  for (let i = T.length - 1; i >= 0; i--) { const p = T[i].pct; if (p == null || p > groups.money.laborTarget) break; n++; }
  return { days: n, target: groups.money.laborTarget };
}
