// The plan engine: turns a day's plan, as the manager entered it, into each person's day and its labor cost.
// Plans are made by hand (Neal, Oct 14: "remove all predictive planning ... let the user manually create a plan").
// Pure functions, no page access: runs in the browser and in Node.
//
// createEngine(S) takes one plain object describing the day:
//   q          {dct, dcb, slt, slb, comf, tc}      pieces to plan
//   crew       {stationCode: {emp, start, stop, brk, moves}}   emp = person id or ""
//   stations   [{id, type, label}]  production stations; type is slt | slt2 | slb | dct | dcb | asm | comf | tc
//   ops        [{id, label}]        operator positions (slo, dco)
//   people     [{id, name, trainings: [trainingId, ...] (in priority order), start}]
//   trainingOf {stationCode: trainingId}
//   settings:  defStart, breakMin, breakAfter, rates {sltSolo, sltPair, slb, dct, dcb, tc, asm, comf}, asmInclude {cat: bool}, price {cat: $}, payAvg, laborTarget
import { paidBreakH } from "./breakpay.js";

export const EPS = 1e-6;
export const CATS = ["dct", "dcb", "slt", "slb", "comf", "tc"];
export const CAT_LABEL = { dct: "DCT", dcb: "DCB", slt: "SLT", slb: "SLB", comf: "Comforters", tc: "Tablecloths" };
export const CAT_FULL = { dct: "Dry Cleaning Tops", dcb: "Dry Cleaning Bottoms", slt: "Starch Laundry Tops", slb: "Starch Laundry Bottoms", comf: "Comforters", tc: "Tablecloths" };

export function parseTime(t) { if (!t || !/^\d{1,2}:\d{2}/.test(t)) return null; const [h, m] = t.split(":").map(Number); return h + m / 60; }
export function hhmm(h) { let m = Math.round(h * 60 / 5) * 5; m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }
export function fmtClock(h) { if (h == null || !isFinite(h)) return "—"; let m = Math.round(h * 60 / 5) * 5; m = ((m % 1440) + 1440) % 1440; let hh = Math.floor(m / 60); const mm = m % 60; const ap = hh >= 12 ? "PM" : "AM"; hh = hh % 12 || 12; return `${hh}:${String(mm).padStart(2, "0")} ${ap}`; }
export const hm = h => fmtClock(h).replace(":00 ", " ");
export function fmtH(h) { if (h <= EPS) return "0m"; const m = Math.round(h * 60 / 5) * 5; if (m === 0) return "<5m"; const hh = Math.floor(m / 60), mm = m % 60; return hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm}m`; }
export const fmtN = n => Math.round(n).toLocaleString();
export const fmt$ = n => "$" + Math.round(n).toLocaleString();

export function createEngine(S) {
  const STATIONS = S.stations, OPS = S.ops || [], POS = STATIONS.concat(OPS);
  const peopleById = new Map((S.people || []).map(p => [p.id, p]));
  const empById = id => peopleById.get(id) || null;
  // rank = position in the person's ordered training list (1 = first choice), 0 = not trained
  // (S.rankOf can replace this, e.g. to replay the desktop's per-station ranks in the parity tests)
  // Station depth chart (Neal, Oct 13): each training (SLB, DCT, IAB 1, ...) has ONE ordered list of people: #1, #2, #3.
  // rank = the person's place on that list (0 = not trained). People's `depth` {training: rank} comes from the Team
  // screen; without it (old data, tests) the list is ordered by each person's own training order.
  const DEPTH = {};
  (S.people || []).forEach((p, i) => (p.trainings || []).forEach((t, k) => (DEPTH[t] = DEPTH[t] || []).push({ id: p.id, k: p.depth && p.depth[t] ? p.depth[t] : 1000 + k, i })));
  for (const t of Object.keys(DEPTH)) DEPTH[t] = DEPTH[t].sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.id);
  const rankOf = S.rankOf || ((e, stId) => { if (!e || !e.trainings) return 0; const t = S.trainingOf[stId]; if (!t || !e.trainings.includes(t)) return 0; const i = (DEPTH[t] || []).indexOf(e.id); return i < 0 ? e.trainings.indexOf(t) + 1 : i + 1; });
  const TYPE_OF = Object.fromEntries(STATIONS.map(x => [x.id, x.type]));
  const s = S;

  // ---------- manual plans (Neal, Oct 14: "remove all predictive planning ... let the user manually create a plan")
  // The plan is exactly what the manager entered: each position's clock-in (start), clock-out (stop), station moves and
  // one break ("HH:MM-HH:MM", or "HH:MM" for a break of s.breakMin). Nothing is simulated.
  const SHIFT_H = 8;
  function manualTimes(id) {
    const c = s.crew[id] || {}, start = parseTime(c.start) ?? parseTime(s.defStart) ?? 7;
    const bm = String(c.brk || "").match(/^(\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))?$/);
    let brk = null;
    if (bm) { const b0 = parseTime(bm[1]), b1 = bm[2] ? parseTime(bm[2]) : b0 + (s.breakMin || 0) / 60; if (b1 > b0) brk = [b0, b1]; }
    const bl = brk ? brk[1] - brk[0] : 0;
    // no clock-out entered: an 8-hour day from clock-in (Neal, Oct 14: "assume everyone clocks in and works 8 hours")
    let end = parseTime(c.stop); if (end == null || end <= start) end = start + SHIFT_H;
    return { start, end, brk, bl, work: Math.max(0, end - start - bl) };
  }
  function stationInfo() {
    const out = {};
    for (const st of STATIONS) {
      const m = manualTimes(st.id), on = !!(s.crew[st.id] || {}).emp;
      out[st.id] = { ...st, a: on ? m.work : 0, start: m.start, b: m.bl, ot: 0, stop: m.end, off: m.start, schedEnd: m.end, brkS: m.brk ? m.brk[0] : null };
    }
    return out;
  }

  // the day as entered: each person on their station from clock-in, moving at each move's time, out at clock-out
  function buildPlan(q) {
    const I = stationInfo(), rows = [], totalPieces = CATS.reduce((t, k) => t + (q[k] || 0), 0);
    for (const st of STATIONS) {
      const x = I[st.id], c = s.crew[st.id] || {};
      if (!c.emp || !(x.schedEnd > x.start)) { rows.push({ st, x, staffed: false, segs: [], tasks: [], work: 0, comf: 0, active: 0, finish: null, clockOut: null, ot: 0, idle: 0, regPaid: 0, early: 0, moved: false }); continue; }
      const m = manualTimes(st.id);
      const all = (c.moves || []).map(v => ({ at: parseTime(v.at), to: v.to })).filter(v => v.at != null && TYPE_OF[v.to]).sort((a, b) => a.at - b.at);
      const first = all.filter(v => v.at <= m.start + EPS).pop();   // a move at clock-in: that's where they start
      const moves = all.filter(v => v.at > m.start + EPS && v.at < m.end - EPS);
      const cuts = [{ at: m.start, to: first ? first.to : st.id }, ...moves], segs = [];
      cuts.forEach((v, i) => {
        const from = v.at, to = i + 1 < cuts.length ? cuts[i + 1].at : m.end;
        const parts = m.brk && m.brk[1] > from && m.brk[0] < to ? [[from, m.brk[0]], [m.brk[1], to]] : [[from, to]];
        for (const [f, t] of parts) if (t - f > EPS) segs.push({ stn: v.to, from: f, to: t, pcs: 0 });
      });
      const tasks = segs.map(g => ({ stn: g.stn, from: g.from, to: g.to, hours: g.to - g.from, pcs: 0 }));
      const work = segs.reduce((a, g) => a + g.to - g.from, 0);
      rows.push({ st, x, staffed: true, emp: { empId: c.emp, pos0: st.id }, segs, brkS: m.brk ? m.brk[0] : null, brkE: m.brk ? m.brk[1] : null, brkTaken: m.bl, tasks, work, comf: 0, active: work,
        finish: m.end, clockOut: m.end, ot: 0, idle: 0, regPaid: work + paidBreakH(m.bl), paid: work + paidBreakH(m.bl), early: 0, moved: segs.some(g => g.stn !== st.id), gap: 0 });
    }
    const st2 = rows.filter(r => r.staffed), opsOn = opsInfo().filter(o => o.on);
    if (!st2.length && !opsOn.length) return { empty: true, I, noCrew: totalPieces > 0 };
    const starts = [...st2.map(r => r.x.start), ...opsOn.map(o => o.start)], ends = [...st2.map(r => r.clockOut), ...opsOn.map(o => o.end)];
    const cover = {}; for (const st of STATIONS) cover[st.id] = [];
    for (const rw of st2) for (const tk of rw.tasks) if (cover[tk.stn]) cover[tk.stn].push({ row: rw, hours: tk.hours, pcs: 0, from: tk.from });
    const short = { slt: 0, slb: 0, dct: 0, dcb: 0, tc: 0, comf: 0, asm: 0 };
    return { P: { short, shortTotal: 0, A: 0 }, I, rows, end: Math.max(...ends), firstStart: Math.min(...starts), done: totalPieces,
      labor: st2.reduce((a, r) => a + r.work, 0), otTotal: 0, totalPieces, staffedN: st2.length, cover };
  }
  const payRate = posId => { const e = empById((s.crew[posId] || {}).emp); return (e && +e.rate > 0) ? +e.rate : s.payAvg; };
  function opsInfo() {
    return OPS.map(o => {
      const c = s.crew[o.id] || {}, m = manualTimes(o.id), on = !!c.emp && m.end > m.start;
      return { o, on, hrs: on ? m.work : 0, start: m.start, b: m.bl, end: m.end, brkS: m.brk ? m.brk[0] : null };
    });
  }
  function money(R) {
    const revCat = {}; let revenue = 0, committed = 0;
    for (const k of CATS) { const d = Math.max(0, (s.q[k] || 0) - (R && R.P ? (R.P.short[k] || 0) : 0)); revCat[k] = { done: d, rev: d * (s.price[k] || 0) }; revenue += revCat[k].rev; committed += (s.q[k] || 0) * (s.price[k] || 0); }
    let regH = 0, regC = 0, opsH = 0, opsC = 0;
    if (R && R.rows) for (const r of R.rows) {
      if (!r.staffed) continue; const rate = payRate(r.st.id);
      regH += r.regPaid; regC += r.regPaid * rate;
    }
    for (const x of opsInfo()) if (x.on) { const rate = payRate(x.o.id), paid = x.hrs + paidBreakH(x.b); /* hrs is clock-in to out less the break; up to 30 min of it is paid (Neal, Oct 15) */ opsH += paid; opsC += paid * rate; }
    const total = regC + opsC, pct = revenue > 0 ? total / revenue * 100 : null;
    const budget = revenue * s.laborTarget / 100;
    return { revCat, revenue, committed, regH, regC, opsH, opsC, total, pct, budget };
  }
  return { STATIONS, OPS, POS, TYPE_OF, empById, rankOf, stationInfo, buildPlan, opsInfo, money };
}

// ---------- deadlines (independent of the crew) ----------
// Shuttle times: when it reaches each store; work back with the drive time to when pieces must be ready.
export function runTimes(run) {
  const st = (run && run.stops) || []; if (!st.length) return null;
  const a0 = parseTime(st[0].arrive); if (a0 == null) return null;
  const depart = a0 - (+st[0].drive || 0) / 60, stops = []; let t = a0;
  st.forEach((x, i) => {
    if (i === 0) { stops.push({ ...x, at: a0, exp: a0, late: false }); return; }
    const exp = t + (+st[i - 1].stay || 0) / 60 + (+x.drive || 0) / 60, set = parseTime(x.arrive);
    t = set != null ? Math.max(set, exp) : exp; stops.push({ ...x, at: t, exp, late: set != null && exp > set + 1 / 120 });
  });
  const last = stops[stops.length - 1];
  return { depart, stops, back: last.at + (+last.stay || 0) / 60 + (+run.driveBack || 0) / 60 };
}

/** Waves (deadlines) with their pieces: from the pieces view's stores and the shuttle runs. */
export function buildWaves(dayView, runs, { overdue = null } = {}) {
  const byRun = new Map();
  const defs = runs.map(r => {
    const T = runTimes(r);
    const deadline = r.kind === "counter" ? (parseTime(r.stops[0]?.arrive) ?? 16) : T ? T.depart : null;
    return { id: r.id, name: r.name, kind: r.kind, deadline, back: r.kind === "shuttle" && T ? T.back : null, T };
  });
  for (const d of defs) byRun.set(d.id, d);
  const out = new Map();
  const mk = d => ({ ...d, q: Object.fromEntries(CATS.map(k => [k, 0])), doneQ: Object.fromEntries(CATS.map(k => [k, 0])), known: 0, done: 0, todo: 0, orders: 0, stores: [], recent: 0, lastAsm: null });
  for (const st of dayView?.stores || []) {
    let d = st.runId && byRun.get(st.runId);
    if (!d) d = st.runId === "route" ? { id: "route", name: st.run, kind: "route", deadline: 24, back: null } : { id: "other", name: "No run set", kind: "counter", deadline: 24, back: null };
    const w = out.get(d.id) || out.set(d.id, mk(d)).get(d.id);
    const q = dayView.isToday ? st.q : st.expected;
    for (const k of CATS) { w.q[k] += q[k] || 0; w.known += st.known?.[k] || 0; w.done += st.done?.[k] || 0; w.doneQ[k] += st.done?.[k] || 0; }
    w.orders += st.orders; w.stores.push(st.loc); w.recent += st.recent || 0; if (st.lastAsm && (!w.lastAsm || st.lastAsm > w.lastAsm)) w.lastAsm = st.lastAsm;
  }
  const list = [...out.values()];
  for (const w of list) { w.todo = CATS.reduce((t, k) => t + w.q[k], 0); w.leftTodo = Math.max(0, w.todo - w.done); w.expected = !dayView.isToday && w.todo > w.known + 2; }
  list.sort((a, b) => (a.deadline ?? 99) - (b.deadline ?? 99));
  if (overdue && overdue.todo > 0) list.unshift({ id: "overdue", name: "Overdue from earlier days", kind: "overdue", deadline: null, q: { ...overdue.q }, todo: overdue.todo, leftTodo: overdue.todo, done: 0, orders: overdue.orders, stores: [] });
  return list;
}

// each person's day as simple steps (fragments under 6 minutes are dropped)
export function stepsOf(row) {
  const out = [];
  for (const tk of row.tasks) {
    if (tk.hours < 0.1) continue; const lt = out[out.length - 1];
    if (lt && lt.stn === tk.stn) { lt.to = tk.to; continue; }
    out.push({ stn: tk.stn, from: tk.from, to: tk.to, rotFrom: tk.rotFrom, back: !!lt && tk.stn === row.st.id });
  }
  return out;
}
export function outInfo(row) { return { cls: "norm", txt: fmtClock(row.clockOut), sub: "end of shift" }; }
