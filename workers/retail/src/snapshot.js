// The Retail Snapshot numbers for a date range, by store and for the company.
//   Sales    = orders DETAILED in the range (SMRT 'Detailed date'), pre-tax: price - tax. Credited to the store the
//              order was detailed into (SMRT 'Agent' = pos_orders.drop_location_id). (Neal, Oct 11)
//   Revenue  = orders PAID in the range (SMRT 'Paid date'), pre-tax, credited the same way.
//   Collected = of the range's sales, the share already paid (how much of what was written up has turned into revenue).
//   Hours    = Rippling hours at each work location (finished days from labor_daily_hours, today from today's punches).
//   Labor $  = hours x the person's pay rate on that day (labor_pay_rates, from the Rippling report) or, until a rate is
//              known, the average rate for their department (Settings); plus the payroll burden %.
//   Overtime = hours over 40 in a person's work week (all locations together; the week starts on Settings' week start)
//              cost time and a half. The hours past 40 fall on the last days of the week, in order. (Settings: on/off,
//              threshold, multiplier.) Weeks that began before the range still count their earlier days toward the 40.
//   Labor %  = labor $ / revenue for the same days. Target 17% (Settings).
//   Production value (Workshop, Laundry Hub) = pre-tax value of the pieces they finished: each piece's SMRT financial
//              department says which plant does the work (Settings › Production work). A piece counts on the day it was
//              assembled; work that's never assembled (wash & fold) counts on the day its order was ready. Value =
//              base + upcharge - discount. A plant's labor % = its labor $ / its production value (Neal, Oct 11).
// Locations listed under Settings > Rolled into (Winnsboro -> Sulphur Springs) are shown on their own line but counted
// in the store they roll into. Deleted orders are left out everywhere.
import { HttpError } from "../../planner/src/util.js";
import { rank } from "../../planner/src/auth.js";
import { loadSettings } from "./settings.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;
export const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const span = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
export function localToday(tz = "America/Chicago", at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const KEYS = ["orders", "pieces", "sales", "collected", "revenue", "hours", "cost", "estHours", "otHours", "work", "workPieces"];
const blank = () => Object.fromEntries(KEYS.map(k => [k, 0]));
const add = (t, s) => { for (const k of KEYS) t[k] += s[k] || 0; return t; };
const r2 = n => Math.round(n * 100) / 100;

/** Raw sums for a range: per day, per location id. */
export const weekStartOf = (d, weekStart = 1) => addDays(d, -((new Date(d + "T12:00:00Z").getUTCDay() - weekStart + 7) % 7));

/** Marks each person-day row with otHours: the part past `after` hours in that person's work week, latest days last. */
export function markOvertime(rows, { weekStart = 1, after = 40 } = {}) {
  const byWeek = new Map();
  for (const h of rows) { const k = `${h.pid}|${weekStartOf(h.day, weekStart)}`; (byWeek.get(k) || byWeek.set(k, []).get(k)).push(h); }
  for (const list of byWeek.values()) {
    list.sort((a, b) => a.day.localeCompare(b.day) || String(a.loc).localeCompare(String(b.loc)));
    let run = 0;
    for (const h of list) { const before = run; run += h.hours; h.otHours = r2(Math.max(0, run - Math.max(after, before))); }
  }
  return rows;
}

async function gather(db, env, from, to, { s = {}, now = Date.now() } = {}) {
  const end = addDays(to, 1), org = env.ORG_ID;
  const hoursFrom = s.overtime === false ? from : weekStartOf(from, s.weekStart ?? 1);   // earlier days of the first week count toward 40
  // finished orders were obviously detailed; fall back to the created date if SMRT left 'Detailed date' blank
  const salesSql = `SELECT substr(COALESCE(o.detailed_at, CASE WHEN s.is_done=1 OR s.is_closed=1 THEN o.smrt_created_at END),1,10) AS day,
        o.drop_location_id AS loc, COUNT(*) AS orders, SUM(COALESCE(o.piece_count,0)) AS pieces,
        SUM(COALESCE(o.price_cents,0) - COALESCE(o.tax_cents,0)) AS sales,
        SUM(CASE WHEN o.paid_at IS NOT NULL THEN COALESCE(o.price_cents,0) - COALESCE(o.tax_cents,0) ELSE 0 END) AS collected
      FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id
     WHERE o.org_id=? AND s.is_void=0 AND o.smrt_deleted_at IS NULL AND o.deleted_at IS NULL
       AND COALESCE(o.detailed_at, CASE WHEN s.is_done=1 OR s.is_closed=1 THEN o.smrt_created_at END) >= ?
       AND COALESCE(o.detailed_at, CASE WHEN s.is_done=1 OR s.is_closed=1 THEN o.smrt_created_at END) < ?
     GROUP BY 1, 2`;
  const sales = (await db.prepare(salesSql).bind(org, from, end).all()).results;
  const revenue = (await db.prepare(`SELECT substr(o.paid_at,1,10) AS day, o.drop_location_id AS loc, SUM(COALESCE(o.price_cents,0) - COALESCE(o.tax_cents,0)) AS revenue, COUNT(*) AS n
      FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id
     WHERE o.org_id=? AND s.is_void=0 AND o.smrt_deleted_at IS NULL AND o.deleted_at IS NULL AND o.paid_at >= ? AND o.paid_at < ?
     GROUP BY 1, 2`).bind(org, from, end).all()).results;

  // hours: one row per person, day, department, location
  const hours = (await db.prepare(`SELECT h.work_date AS day, h.location_id AS loc, h.person_id AS pid, d.name AS dept, h.hours,
        COALESCE(p.display_name, p.first_name || ' ' || p.last_name) AS name
      FROM labor_daily_hours h JOIN core_people p ON p.id=h.person_id LEFT JOIN core_departments d ON d.id=h.department_id
     WHERE p.org_id=? AND h.work_date BETWEEN ? AND ? AND h.deleted_at IS NULL`).bind(org, hoursFrom, to).all()).results;
  const today = localToday(env.TIMEZONE, new Date(now));
  if (today >= from && today <= to) {
    const punches = (await db.prepare(`SELECT c.location_id AS loc, c.person_id AS pid, d.name AS dept, c.clock_in AS cin, c.clock_out AS cout,
          COALESCE(p.display_name, p.first_name || ' ' || p.last_name) AS name, p.home_location_id AS home
        FROM labor_clock_today c JOIN core_people p ON p.id=c.person_id LEFT JOIN core_departments d ON d.id=c.department_id WHERE p.org_id=?`).bind(org).all()).results;
    const by = new Map();
    for (const c of punches) {
      const a = Date.parse(c.cin), b = c.cout ? Date.parse(c.cout) : now;
      if (!(a > 0) || localToday(env.TIMEZONE, new Date(a)) !== today) continue;
      const k = `${c.pid}|${c.loc || c.home}|${c.dept}`;
      const x = by.get(k) || by.set(k, { day: today, loc: c.loc || c.home, pid: c.pid, dept: c.dept, name: c.name, hours: 0 }).get(k);
      x.hours += Math.max(0, Math.min(b, now) - a) / 36e5;
    }
    hours.push(...[...by.values()].map(x => ({ ...x, hours: r2(x.hours), live: true })));
  }
  if (s.overtime !== false) markOvertime(hours, { weekStart: s.weekStart ?? 1, after: s.overtimeAfter ?? 40 });
  const inRange = hours.filter(h => h.day >= from);
  hours.length = 0; hours.push(...inRange);
  // production value: finished pieces by department (assembled pieces, plus never-assembled pieces of orders ready that day)
  const valueSql = "SUM(COALESCE(i.base_cents,0) + COALESCE(i.upcharge_cents,0) - COALESCE(i.discount_cents,0))";
  const work = [
    ...(await db.prepare(`SELECT substr(i.assembled_at,1,10) AS day, d.name AS dept, COUNT(*) AS pieces, ${valueSql} AS value
        FROM pos_items i JOIN pos_orders o ON o.id=i.order_id JOIN pos_order_statuses s ON s.id=o.status_id LEFT JOIN pos_departments d ON d.id=i.department_id
       WHERE o.org_id=? AND s.is_void=0 AND o.smrt_deleted_at IS NULL AND i.removed_at IS NULL AND i.assembled_at >= ? AND i.assembled_at < ?
       GROUP BY 1, 2`).bind(org, from, end).all()).results,
    ...(await db.prepare(`SELECT substr(o.ready_at,1,10) AS day, d.name AS dept, COUNT(*) AS pieces, ${valueSql} AS value
        FROM pos_orders o JOIN pos_order_statuses s ON s.id=o.status_id JOIN pos_items i ON i.order_id=o.id LEFT JOIN pos_departments d ON d.id=i.department_id
       WHERE o.org_id=? AND s.is_void=0 AND o.smrt_deleted_at IS NULL AND i.removed_at IS NULL AND i.assembled_at IS NULL AND o.ready_at >= ? AND o.ready_at < ?
       GROUP BY 1, 2`).bind(org, from, end).all()).results,
  ];
  const pids = [...new Set(hours.map(h => h.pid))];
  const rates = new Map();
  for (let i = 0; i < pids.length; i += 90) {
    const c = pids.slice(i, i + 90);
    const rs = (await db.prepare(`SELECT person_id AS pid, effective_on AS on_, hourly_cents AS c FROM labor_pay_rates WHERE deleted_at IS NULL AND person_id IN (${c.map(() => "?").join(",")}) ORDER BY effective_on`).bind(...c).all()).results;
    for (const r of rs) (rates.get(r.pid) || rates.set(r.pid, []).get(r.pid)).push(r);
  }
  return { sales, revenue, hours, rates, today, work };
}

/** Wage cost of one person-day row, and whether it used an average rate. */
function costOf(h, rates, s) {
  const list = rates.get(h.pid);
  let cents = null;
  if (list && list.length) { cents = list[0].c; for (const r of list) if (r.on_ <= h.day) cents = r.c; }   // before the first known rate: the first rate
  const est = cents == null;
  const perHour = est ? (s.avgRates[h.dept] ?? s.defaultRate) : cents / 100;
  const premium = (h.otHours || 0) * perHour * ((s.overtimeMultiplier ?? 1.5) - 1);
  return { cost: (h.hours * perHour + premium) * (1 + s.burdenPct / 100), est };
}

export async function snapshot(db, env, me, from, to, { now = Date.now() } = {}) {
  if (!DAY.test(from || "") || !DAY.test(to || "")) throw new HttpError(400, "Use dates like 2026-10-12.");
  if (to < from) throw new HttpError(400, "The end date is before the start date.");
  if (span(from, to) > MAX_DAYS) throw new HttpError(400, `Pick ${MAX_DAYS} days or fewer.`);
  const s = await loadSettings(db, env);
  const labor = rank(me.role) >= rank("admin") || s.managersSeeLabor;
  const locs = new Map((await db.prepare("SELECT id, name, kind FROM core_locations WHERE org_id=?").bind(env.ORG_ID).all()).results.map(l => [l.id, l]));
  const hidden = new Set(s.hidden.map(h => h.toLowerCase()));
  // which line a location's numbers land on
  const where = id => {
    const l = locs.get(id);
    if (!l) return { line: "Unassigned", part: "Unassigned", plant: false };
    if (l.kind === "plant") return { line: l.name, part: l.name, plant: true };
    if (hidden.has(l.name.toLowerCase())) return { line: "Other", part: l.name, plant: false };
    return { line: s.rollup[l.name] || l.name, part: l.name, plant: false };
  };

  const shape = (g, { detail }) => {
    const lines = new Map(), daily = new Map(), people = new Map();
    const line = (w) => {
      const map = w.plant ? "plant" : "store";
      const L = lines.get(w.line) || lines.set(w.line, { name: w.line, kind: map, ...blank(), parts: new Map() }).get(w.line);
      if (!L.parts.has(w.part)) L.parts.set(w.part, { name: w.part, ...blank() });
      return [L, L.parts.get(w.part)];
    };
    const dayRow = (d, w) => {
      const D = daily.get(d) || daily.set(d, { day: d, lines: {} }).get(d);
      return D.lines[w.line] || (D.lines[w.line] = blank());
    };
    for (const r of g.sales) { if (!r.day) continue; const w = where(r.loc); const v = { orders: r.orders, pieces: r.pieces, sales: r.sales / 100, collected: r.collected / 100 };
      for (const t of line(w)) add(t, v); if (detail) add(dayRow(r.day, w), v); }
    for (const r of g.revenue) { const w = where(r.loc); const v = { revenue: r.revenue / 100 };
      for (const t of line(w)) add(t, v); if (detail) add(dayRow(r.day, w), v); }
    const unmapped = new Map();
    for (const r of g.work) {
      const plantName = s.plantWork[r.dept || ""];
      if (!plantName) { unmapped.set(r.dept || "(none)", (unmapped.get(r.dept || "(none)") || 0) + r.pieces); continue; }
      const w = { line: plantName, part: plantName, plant: true };
      const v = { work: (r.value || 0) / 100, workPieces: r.pieces };
      for (const t of line(w)) add(t, v); if (detail) add(dayRow(r.day, w), v);
    }
    for (const h of g.hours) {
      const w = where(h.loc); const { cost, est } = costOf(h, g.rates, s);
      const v = { hours: h.hours, cost, estHours: est ? h.hours : 0, otHours: h.otHours || 0 };
      for (const t of line(w)) add(t, v);
      if (detail) {
        add(dayRow(h.day, w), v);
        const k = `${w.line}|${h.pid}`;
        const P = people.get(k) || people.set(k, { line: w.line, personId: h.pid, name: h.name, depts: new Set(), days: {}, hours: 0, otHours: 0, live: false }).get(k);
        P.days[h.day] = r2((P.days[h.day] || 0) + h.hours); P.hours += h.hours; P.otHours += h.otHours || 0; P.depts.add(h.dept || "—"); if (h.live) P.live = true;
      }
    }
    const stores = [...lines.values()].filter(l => l.kind === "store"), plants = [...lines.values()].filter(l => l.kind === "plant");
    const order = l => (l.name === "Unassigned" || l.name === "Other" ? 1 : 0);
    stores.sort((a, b) => order(a) - order(b) || b.sales - a.sales || a.name.localeCompare(b.name));
    plants.sort((a, b) => a.name.localeCompare(b.name));
    const retail = stores.reduce((t, l) => add(t, l), blank());
    const plant = plants.reduce((t, l) => add(t, l), blank());
    const company = add(add(blank(), retail), plant);
    return { stores, plants, retail, plant, company, daily, people, unmapped };
  };

  const cur = shape(await gather(db, env, from, to, { s, now }), { detail: true });
  const n = span(from, to), pFrom = addDays(from, -n), pTo = addDays(from, -1);
  const prev = shape(await gather(db, env, pFrom, pTo, { s, now }), { detail: false });

  const pct = (cost, rev) => (rev > 0 ? r2(cost / rev * 100) : null);
  const money = v => r2(v);
  const out = (l, revenueBase) => {
    const o = { name: l.name, orders: l.orders, pieces: l.pieces, sales: money(l.sales), collected: money(l.collected), revenue: money(l.revenue),
      collectedPct: l.sales > 0 ? r2(l.collected / l.sales * 100) : null, hours: r2(l.hours), otHours: r2(l.otHours),
      salesPerHour: l.hours > 0 ? money(l.sales / l.hours) : null, revenuePerHour: l.hours > 0 ? money(l.revenue / l.hours) : null };
    if (l.kind === "plant" || revenueBase === "work") Object.assign(o, { work: money(l.work), workPieces: l.workPieces, workPerHour: l.hours > 0 ? money(l.work / l.hours) : null,
      piecesPerHour: l.hours > 0 ? r2(l.workPieces / l.hours) : null });
    if (labor) Object.assign(o, { cost: money(l.cost), laborPct: pct(l.cost, revenueBase === "work" ? l.work : revenueBase ?? l.revenue), estPct: l.hours > 0 ? Math.round(l.estHours / l.hours * 100) : 0 });
    return o;
  };
  const lineOut = (l, base) => ({ ...out(l, base), kind: l.kind, parts: l.parts.size > 1 ? [...l.parts.values()].map(p => out(p, base)) : [] });
  const prevByName = new Map([...prev.stores, ...prev.plants].map(l => [l.name, l]));
  const prevOut = (l, base) => l ? { sales: money(l.sales), revenue: money(l.revenue), work: money(l.work), hours: r2(l.hours), ...(labor ? { laborPct: pct(l.cost, base === "work" ? l.work : l.revenue) } : {}) } : null;

  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const lineNames = [...cur.stores, ...cur.plants].map(l => l.name);
  const daily = days.map(d => {
    const D = cur.daily.get(d) || { lines: {} };
    const tot = { retail: blank(), plant: blank() };
    for (const l of [...cur.stores, ...cur.plants]) if (D.lines[l.name]) add(l.kind === "plant" ? tot.plant : tot.retail, D.lines[l.name]);
    const comp = add(add(blank(), tot.retail), tot.plant);
    const row = (x, plant) => ({ orders: x.orders, sales: money(x.sales), revenue: money(x.revenue), work: money(x.work), workPieces: x.workPieces, hours: r2(x.hours), otHours: r2(x.otHours),
      ...(labor ? { cost: money(x.cost), laborPct: pct(x.cost, plant ? x.work : x.revenue) } : {}) });
    const plantNames = new Set(cur.plants.map(l => l.name));
    return { day: d, lines: Object.fromEntries(lineNames.map(n => [n, row(D.lines[n] || blank(), plantNames.has(n))])), retail: row(tot.retail), plant: row(tot.plant, true),
      company: { ...row(comp), ...(labor ? { laborPct: pct(comp.cost, comp.revenue), plantPct: pct(tot.plant.cost, comp.revenue) } : {}) } };
  });

  const freshness = {
    smrt: (await db.prepare("SELECT finished_at AS at, status FROM int_sync_runs WHERE integration_id='smrt' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1").first()) || null,
    rippling: (await db.prepare("SELECT finished_at AS at, status FROM int_sync_runs WHERE integration_id='rippling' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1").first()) || null,
    hoursThrough: (await db.prepare("SELECT MAX(work_date) AS d FROM labor_daily_hours WHERE deleted_at IS NULL").first())?.d || null,
    hoursFrom: (await db.prepare("SELECT MIN(h.work_date) AS d FROM labor_daily_hours h JOIN core_locations l ON l.id=h.location_id WHERE l.kind='store' AND h.deleted_at IS NULL").first())?.d || null,
  };

  return {
    from, to, days, today: localToday(env.TIMEZONE, new Date(now)), labor,
    targets: { retail: s.targetRetail, plant: s.targetPlant }, burdenPct: s.burdenPct,
    overtime: s.overtime ? { after: s.overtimeAfter, multiplier: s.overtimeMultiplier } : null,
    stores: cur.stores.map(l => ({ ...lineOut(l), prev: prevOut(prevByName.get(l.name)) })),
    plants: cur.plants.map(l => ({ ...lineOut(l, "work"), revenueSharePct: labor ? pct(l.cost, cur.company.revenue) : undefined, prev: prevOut(prevByName.get(l.name), "work") })),
    totals: {
      retail: { ...out(cur.retail), prev: prevOut(prev.retail) },
      plant: { hours: r2(cur.plant.hours), otHours: r2(cur.plant.otHours), work: money(cur.plant.work), workPieces: cur.plant.workPieces,
        ...(labor ? { cost: money(cur.plant.cost), laborPct: pct(cur.plant.cost, cur.plant.work), revenueSharePct: pct(cur.plant.cost, cur.company.revenue),
          estPct: cur.plant.hours > 0 ? Math.round(cur.plant.estHours / cur.plant.hours * 100) : 0 } : {}), prev: prevOut(prev.plant, "work") },
      company: { ...out(cur.company), prev: prevOut(prev.company) },
    },
    prevRange: { from: pFrom, to: pTo },
    unmappedWork: [...cur.unmapped.entries()].map(([dept, pieces]) => ({ dept, pieces })).sort((a, b) => b.pieces - a.pieces),
    daily,
    people: [...cur.people.values()].map(p => ({ line: p.line, personId: p.personId, name: p.name, depts: [...p.depts], days: p.days, hours: r2(p.hours), otHours: r2(p.otHours), live: p.live }))
      .sort((a, b) => a.line.localeCompare(b.line) || b.hours - a.hours),
    freshness,
  };
}
