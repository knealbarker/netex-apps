// The Retail Snapshot numbers for a date range, by store and for the company.
//   Sales    = orders DETAILED in the range (SMRT 'Detailed date'), pre-tax: price - tax. Credited to the store the
//              order was detailed into (SMRT 'Agent' = pos_orders.drop_location_id). (Neal, Oct 11)
//   Revenue  = orders PAID in the range (SMRT 'Paid date'), pre-tax, credited the same way.
//   Collected = of the range's sales, the share already paid (how much of what was written up has turned into revenue).
//   Hours    = Rippling hours at each work location (finished days from labor_daily_hours, today from today's punches).
//   Labor $  = hours x the person's pay rate on that day (labor_pay_rates, from the Rippling report) or, until a rate is
//              known, the average rate for their department (Settings); plus the payroll burden %.
//   Labor %  = labor $ / revenue for the same days. Target 17% (Settings).
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
const KEYS = ["orders", "pieces", "sales", "collected", "revenue", "hours", "cost", "estHours"];
const blank = () => Object.fromEntries(KEYS.map(k => [k, 0]));
const add = (t, s) => { for (const k of KEYS) t[k] += s[k] || 0; return t; };
const r2 = n => Math.round(n * 100) / 100;

/** Raw sums for a range: per day, per location id. */
async function gather(db, env, from, to, { withPeople = false, now = Date.now() } = {}) {
  const end = addDays(to, 1), org = env.ORG_ID;
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
     WHERE p.org_id=? AND h.work_date BETWEEN ? AND ? AND h.deleted_at IS NULL`).bind(org, from, to).all()).results;
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
  const pids = [...new Set(hours.map(h => h.pid))];
  const rates = new Map();
  for (let i = 0; i < pids.length; i += 90) {
    const c = pids.slice(i, i + 90);
    const rs = (await db.prepare(`SELECT person_id AS pid, effective_on AS on_, hourly_cents AS c FROM labor_pay_rates WHERE deleted_at IS NULL AND person_id IN (${c.map(() => "?").join(",")}) ORDER BY effective_on`).bind(...c).all()).results;
    for (const r of rs) (rates.get(r.pid) || rates.set(r.pid, []).get(r.pid)).push(r);
  }
  return { sales, revenue, hours, rates, today };
}

/** Wage cost of one person-day row, and whether it used an average rate. */
function costOf(h, rates, s) {
  const list = rates.get(h.pid);
  let cents = null;
  if (list && list.length) { cents = list[0].c; for (const r of list) if (r.on_ <= h.day) cents = r.c; }   // before the first known rate: the first rate
  const est = cents == null;
  const perHour = est ? (s.avgRates[h.dept] ?? s.defaultRate) : cents / 100;
  return { cost: h.hours * perHour * (1 + s.burdenPct / 100), est };
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
    for (const h of g.hours) {
      const w = where(h.loc); const { cost, est } = costOf(h, g.rates, s);
      const v = { hours: h.hours, cost, estHours: est ? h.hours : 0 };
      for (const t of line(w)) add(t, v);
      if (detail) {
        add(dayRow(h.day, w), v);
        const k = `${w.line}|${h.pid}`;
        const P = people.get(k) || people.set(k, { line: w.line, personId: h.pid, name: h.name, depts: new Set(), days: {}, hours: 0, live: false }).get(k);
        P.days[h.day] = r2((P.days[h.day] || 0) + h.hours); P.hours += h.hours; P.depts.add(h.dept || "—"); if (h.live) P.live = true;
      }
    }
    const stores = [...lines.values()].filter(l => l.kind === "store"), plants = [...lines.values()].filter(l => l.kind === "plant");
    const order = l => (l.name === "Unassigned" || l.name === "Other" ? 1 : 0);
    stores.sort((a, b) => order(a) - order(b) || b.sales - a.sales || a.name.localeCompare(b.name));
    plants.sort((a, b) => a.name.localeCompare(b.name));
    const retail = stores.reduce((t, l) => add(t, l), blank());
    const plant = plants.reduce((t, l) => add(t, l), blank());
    const company = add(add(blank(), retail), plant);
    return { stores, plants, retail, plant, company, daily, people };
  };

  const cur = shape(await gather(db, env, from, to, { withPeople: true, now }), { detail: true });
  const n = span(from, to), pFrom = addDays(from, -n), pTo = addDays(from, -1);
  const prev = shape(await gather(db, env, pFrom, pTo, { now }), { detail: false });

  const pct = (cost, rev) => (rev > 0 ? r2(cost / rev * 100) : null);
  const money = v => r2(v);
  const out = (l, revenueBase) => {
    const o = { name: l.name, orders: l.orders, pieces: l.pieces, sales: money(l.sales), collected: money(l.collected), revenue: money(l.revenue),
      collectedPct: l.sales > 0 ? r2(l.collected / l.sales * 100) : null, hours: r2(l.hours),
      salesPerHour: l.hours > 0 ? money(l.sales / l.hours) : null, revenuePerHour: l.hours > 0 ? money(l.revenue / l.hours) : null };
    if (labor) Object.assign(o, { cost: money(l.cost), laborPct: pct(l.cost, revenueBase ?? l.revenue), estPct: l.hours > 0 ? Math.round(l.estHours / l.hours * 100) : 0 });
    return o;
  };
  const lineOut = (l, base) => ({ ...out(l, base), kind: l.kind, parts: l.parts.size > 1 ? [...l.parts.values()].map(p => out(p, base)) : [] });
  const prevByName = new Map([...prev.stores, ...prev.plants].map(l => [l.name, l]));
  const prevOut = l => l ? { sales: money(l.sales), revenue: money(l.revenue), hours: r2(l.hours), ...(labor ? { laborPct: pct(l.cost, l.revenue) } : {}) } : null;

  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const lineNames = [...cur.stores, ...cur.plants].map(l => l.name);
  const daily = days.map(d => {
    const D = cur.daily.get(d) || { lines: {} };
    const tot = { retail: blank(), plant: blank() };
    for (const l of [...cur.stores, ...cur.plants]) if (D.lines[l.name]) add(l.kind === "plant" ? tot.plant : tot.retail, D.lines[l.name]);
    const comp = add(add(blank(), tot.retail), tot.plant);
    const row = x => ({ orders: x.orders, sales: money(x.sales), revenue: money(x.revenue), hours: r2(x.hours), ...(labor ? { cost: money(x.cost), laborPct: pct(x.cost, x.revenue) } : {}) });
    return { day: d, lines: Object.fromEntries(lineNames.map(n => [n, row(D.lines[n] || blank())])), retail: row(tot.retail),
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
    stores: cur.stores.map(l => ({ ...lineOut(l), prev: prevOut(prevByName.get(l.name)) })),
    plants: cur.plants.map(l => ({ ...lineOut(l, cur.company.revenue), prev: null })),
    totals: {
      retail: { ...out(cur.retail), prev: prevOut(prev.retail) },
      plant: { hours: r2(cur.plant.hours), ...(labor ? { cost: money(cur.plant.cost), laborPct: pct(cur.plant.cost, cur.company.revenue), estPct: cur.plant.hours > 0 ? Math.round(cur.plant.estHours / cur.plant.hours * 100) : 0 } : {}) },
      company: { ...out(cur.company), prev: prevOut(prev.company) },
    },
    prevRange: { from: pFrom, to: pTo },
    daily,
    people: [...cur.people.values()].map(p => ({ line: p.line, personId: p.personId, name: p.name, depts: [...p.depts], days: p.days, hours: r2(p.hours), live: p.live }))
      .sort((a, b) => a.line.localeCompare(b.line) || b.hours - a.hours),
    freshness,
  };
}
