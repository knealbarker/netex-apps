// The Plan screen's logic, kept apart from the page so it can be tested in Node:
//  - turns settings, the team and the saved plan into the engine's input
//  - pieces to plan (SMRT, plus counts typed over it) and the deadlines
//  - the headline and the snapshot stored when a plan is published
import { createEngine, buildWaves, stepsOf, CATS, parseTime, hhmm, fmtClock, hm, fmtN } from "../engine/engine.js";
import { firstBreak, paidBreakH } from "../engine/breakpay.js";

export const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekday = day => new Date(day + "T12:00:00Z").getUTCDay();
export const addDays = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// ---------------------------------------------------------------- engine input
/** Flat engine settings from the Settings screen's groups and tables (and SMRT's average prices when known). */
export function engineSettings(SET, smrtPrices = {}) {
  const g = SET.groups, rate = (type, cat) => (SET.rates.find(r => r.type === type && r.category === cat) || {}).perHour;
  const asmRate = rate("asm", "dct") || (SET.rates.find(r => r.type === "asm") || {}).perHour || 100;
  return {
    defStart: g.day.defStart, breakMin: g.day.breakMin, breakAfter: g.day.breakAfter,
    rates: { sltSolo: rate("slt", "slt") || 50, sltPair: rate("slt_helper", "slt") || 80, slb: rate("slb", "slb") || 38, dct: rate("dct", "dct") || 25,
      dcb: rate("dcb", "dcb") || 25, tc: rate("tc", "tc") || rate("dcb", "tc") || 6, asm: asmRate, comf: rate("comf", "comf") || 3 },
    asmInclude: Object.fromEntries(CATS.map(k => [k, !!(SET.categories.find(c => c.id === k) || {}).needsAssembly])),
    price: { ...g.money.prices, ...smrtPrices }, payAvg: g.money.payAvg, laborTarget: g.money.laborTarget,
    weekStart: g.alerts.weekStart,
  };
}

/** Stations in use, in order. The engine's types: slt | slt2 (helper) | slb | dct | dcb | asm, plus operator positions. */
export function positions(SET) {
  const on = SET.stations.filter(s => s.active).sort((a, b) => a.sort - b.sort);
  const stations = on.filter(s => s.type !== "ops").map(s => ({ id: s.code, type: s.type === "slt_helper" ? "slt2" : s.type, label: s.label, training: s.training }));
  const ops = on.filter(s => s.type === "ops").map(s => ({ id: s.code, type: "ops", label: s.label, training: s.training }));
  const trainingOf = Object.fromEntries(stations.concat(ops).filter(s => s.training).map(s => [s.id, s.training]));
  return { stations, ops, trainingOf };
}

/** Active people for the engine. `rate` (Rippling's hourly pay) is only there for Admins and the Owner; the engine uses the average without it. */
export const peopleFrom = TEAM => TEAM.people.filter(p => p.status === "active").map(p => ({ id: p.id, name: p.name, trainings: p.trainings || [], depth: p.depth || null, start: p.usualStart || null,
  hours: p.usualHours > 0 ? +p.usualHours : null, days: p.usualDays || null, leaveBy: p.leaveBy || null, leaveNote: p.leaveNote || null, ...(p.rate > 0 ? { rate: p.rate } : {}) }));

export function blankCrew(POS, s) { return Object.fromEntries(POS.map(p => [p.id, { emp: "", start: s.defStart, hrs: SHIFT_H - (s.breakMin || 0) / 60, stop: "", source: "" }])); }
export function crewFromServer(serverCrew, POS, s) {
  const crew = blankCrew(POS, s);
  for (const [code, c] of Object.entries(serverCrew || {})) if (crew[code]) crew[code] = { emp: c.personId, start: c.start, hrs: c.hours, stop: c.stop || "", source: c.source || "user", moves: c.moves || [], brk: c.brk || "" };
  return crew;
}
export function crewToServer(crew) {
  const out = {};
  for (const [code, c] of Object.entries(crew)) if (c.emp) out[code] = { personId: c.emp, start: c.start, hours: +c.hrs || 0, stop: c.stop || "", source: c.source === "suggested" ? "suggested" : c.source === "clock" ? "clock" : "user",
    ...(c.moves && c.moves.length ? { moves: c.moves } : {}), ...(c.brk ? { brk: c.brk } : {}) };
  return out;
}

// ---------------------------------------------------------------- pieces and deadlines
/** Pieces for a day from the pieces view: SMRT's counts (expected ones for the next day), open overdue work, and the deadlines. */
export function dayPieces(V, SET, day) {
  const D = V.days[day];
  if (!D) return null;
  const isToday = day === V.today && V.isWorkDay;
  const withOverdue = isToday || (!V.isWorkDay && day === V.next); // on a day off the next work day is the next "today"
  const expected = !isToday && D.expectedTotal > D.todo + 2;
  const base = Object.fromEntries(CATS.map(k => [k, (expected ? D.expected[k] : D.q[k]) + (withOverdue ? V.overdue.q[k] : 0)]));
  const waves = buildWaves({ ...D, isToday }, SET.runs, { overdue: withOverdue ? V.overdue : null });
  return { D, isToday, withOverdue, expected, base, waves };
}
export const effectiveQ = (base, overrides) => Object.fromEntries(CATS.map(k => [k, overrides && overrides[k] != null ? +overrides[k] : base[k]]));

// ---------------------------------------------------------------- running a plan
/**
 * Everything the screen shows for one state of the plan.
 * P = { s, stations, ops, trainingOf, people, crew, q, waves, day, isToday, now, callouts, history, published, admin }
 */
/** The crew the engine sees: a standing "must leave by" on Team is a hard stop unless the plan sets one for the day. */
export function effectiveCrew(P) {
  const out = {};
  for (const [code, c] of Object.entries(P.crew)) {
    const e = c.emp && P.people.find(p => p.id === c.emp);
    out[code] = e && e.leaveBy && !c.stop ? { ...c, stop: e.leaveBy, standingStop: true } : c;
  }
  return out;
}
export function evaluate(P0) {
  const P = { ...P0, crew: effectiveCrew(P0) };
  const E = createEngine({ ...P.s, q: P.q, crew: P.crew, stations: P.stations, ops: P.ops, people: P.people, trainingOf: P.trainingOf });
  const R = E.buildPlan(P.q);
  const M = R.empty ? null : E.money(R);
  const waves = (P.waves || []).filter(w => w.todo > 0 || w.kind === "overdue");
  const X = { P, E, R, M, waves };
  X.verdict = verdict(X);
  return X;
}

export const nameOf = (P, id) => (P.people.find(p => p.id === id) || {}).name || "Someone";
const onCrew = P => new Set(Object.values(P.crew).map(c => c.emp).filter(Boolean));
/** People coming in late on this day: {personId: "HH:MM"} (Team screen › Time off). */
export const lateOf = P => Object.fromEntries((P.late || []).map(l => [l.personId, l.at]));
/** A start time no earlier than the person's late arrival. */
export const notBeforeLate = (P, id, start) => { const l = lateOf(P)[id]; return l && (!start || start < l) ? l : start; };

export function verdict(X) {
  const { P, R, E } = X;
  if (R.empty) return { cls: "idle", head: R.noCrew ? "Pick the crew" : "Nothing to plan yet", kpis: [] };
  const tot = CATS.reduce((t, k) => t + (P.q[k] || 0), 0), people = R.rows.filter(r => r.staffed).length + E.opsInfo().filter(x => x.on).length;
  return { cls: "ok", head: "Plan", kpis: [{ v: (P.expected ? "~" : "") + fmtN(tot), l: P.expected ? "pieces expected" : "pieces" }, { v: String(people), l: "people" }, { v: hm(R.end), l: "last out" }] };
}

/**
 * Today's attendance for one person on the plan, against the time clock (Neal, Oct 13). The plan's start is only a plan:
 * someone can be put on a station from any time. Returns null when there's nothing to say (not today, no time clock yet).
 *   { state: "in", inAt, due, lateMin }      clocked in (lateMin > 0 when that was 10+ minutes after the planned start)
 *   { state: "missing", due }                 15+ minutes past the planned start (or late-arrival time) with no punch
 *   { state: "upcoming", due }                not in yet, and the planned start isn't 15 minutes past
 *   { state: "break" | "gone", inAt, outAt }  clocked out (see clockState)
 */
export const GRACE_H = 0.25, LATE_H = 10 / 60;
export function attendanceOf(P, personId, start, brk) {
  if (!P.isToday || !personId || P.now == null) return null;
  const clock = clockInOf(P), late = lateOf(P);
  const due = Math.max(parseTime(start) ?? 0, parseTime(late[personId]) ?? 0);
  if (clock[personId]) {
    const inAt = parseTime(clock[personId]), m = Math.round((inAt - due) * 60), lateMin = inAt - due >= LATE_H - 1e-9 ? m : 0;
    const cs = clockState(P, personId, P.now, brk);
    if (cs === "gone" || cs === "break") return { state: cs, inAt, due, lateMin, outAt: lastOutOf(P, personId) };
    return { state: "in", inAt, due, lateMin };
  }
  if (!(P.clock || []).length) return null;    // no time clock report today: can't tell
  return P.now >= due + GRACE_H ? { state: "missing", due } : { state: "upcoming", due };
}
/** Today's first clock-in per person (HH:MM, local), from Rippling. */
/**
 * Today's Rippling punches for one person at hour `now` (Neal, Oct 13):
 *   "in"    an open punch
 *   "break" clocked out around their planned break (brk = {s, e}, ±30 min) and not yet an hour ago
 *   "gone"  clocked out at any other time, or a break that ran over an hour: gone for the day (a new punch brings them back)
 *   null    no punches today
 */
export function clockState(P, id, now, brk) {
  const rows = (P.clock || []).filter(c => c.personId === id); if (!rows.length) return null;
  if (rows.some(c => !c.clockOut)) return "in";
  const L = lastOutOf(P, id), atBreak = brk && brk.s != null && L >= brk.s - 0.5 && L <= (brk.e ?? brk.s) + 0.5;
  return atBreak && now - L <= 1 ? "break" : "gone";
}
/** Hour of a person's latest clock-out today, or null. */
export function lastOutOf(P, id) {
  const outs = (P.clock || []).filter(c => c.personId === id && c.clockOut).map(c => { const t = String(c.clockOut).slice(11, 16).split(":"); return +t[0] + (+t[1] || 0) / 60; });
  return outs.length ? Math.max(...outs) : null;
}
/** Each person's planned break window today, from a simulated plan: { personId: {s, e} }. */
export function breaksOf(R) {
  const out = {}; if (!R || R.empty) return out;
  for (const r of R.rows) if (r.staffed && r.brkS != null && r.emp) out[r.emp.empId] = { s: r.brkS, e: r.brkS + (r.x.b || 0) };
  return out;
}
/** A person's latest time-clock punch on the plan's day: { kind: "in" | "out", h }, or null (Neal, Oct 15). */
export function lastPunchOf(P, id) {
  let best = null;
  for (const c of P.clock || []) {
    if (c.personId !== id) continue;
    for (const [kind, t] of [["in", c.clockIn], ["out", c.clockOut]]) {
      const s = String(t || "").slice(0, 16); if (s.length < 16) continue;
      if (!best || s > best.s || (s === best.s && kind === "out")) best = { kind, s };
    }
  }
  if (!best) return null;
  const [H, Mi] = best.s.slice(11, 16).split(":");
  return { kind: best.kind, h: +H + (+Mi || 0) / 60 };
}
/** Paid hours a person has on the plan's day: closed punches, plus an open one up to now (today only), plus the paid
 *  break (the first gap, up to 30 min, none if back after more than 35 — Neal, Oct 15). Null without punches. */
export function clockedHoursOf(P, id) {
  const h = t => { const x = String(t || "").slice(11, 16).split(":"); return x.length < 2 ? null : +x[0] + (+x[1] || 0) / 60; };
  let sum = 0, any = false; const pun = [];
  for (const c of P.clock || []) {
    if (c.personId !== id) continue;
    const i = h(c.clockIn); if (i == null) continue;
    const o = c.clockOut ? h(c.clockOut) : P.isToday && P.now != null ? P.now : null;
    any = true; if (o != null && o > i) sum += o - i;
    pun.push({ i: Math.round(i * 60), o: c.clockOut ? Math.round(h(c.clockOut) * 60) : null });
  }
  if (!any) return null;
  const b = firstBreak(pun, P.isToday && P.now != null ? Math.round(P.now * 60) : null);
  return sum + (b ? b.paid / 60 : 0);
}
/** The day's break from the time clock: { gap, paid, open } in minutes, or null (Neal, Oct 15). */
export function clockBreakOf(P, id) {
  const h = t => { const x = String(t || "").slice(11, 16).split(":"); return x.length < 2 ? null : Math.round((+x[0] + (+x[1] || 0) / 60) * 60); };
  const pun = (P.clock || []).filter(c => c.personId === id && h(c.clockIn) != null).map(c => ({ i: h(c.clockIn), o: c.clockOut ? h(c.clockOut) : null }));
  return pun.length ? firstBreak(pun, P.isToday && P.now != null ? Math.round(P.now * 60) : null) : null;
}
/** A person's workweek so far (Neal, Oct 15): finished days from Rippling (history) plus today's time on the clock.
 *  { days: [{ day, h, today, future }] for the 5 work days from the week's start, total }, or null with no hours this week. */
export function weekHoursOf(P, id) {
  if (!P.history) return null;
  const back = (weekday(P.day) - (P.s.weekStart ?? 1) + 7) % 7, start = addDays(P.day, -back), by = {};
  for (const h of P.history.hours || []) if (h.personId === id && h.day >= start && h.day < P.day) by[h.day] = (by[h.day] || 0) + (+h.hours || 0);
  const todayH = P.isToday ? clockedHoursOf(P, id) || 0 : 0;
  const days = []; for (let i = 0; i < 5; i++) { const d = addDays(start, i); days.push({ day: d, h: d === P.day ? todayH : by[d] || 0, today: d === P.day, future: d > P.day }); }
  const total = Object.values(by).reduce((a, h) => a + h, 0) + todayH;
  return total > 0 ? { days, total } : null;
}
export function clockInOf(P) {
  const out = {};
  if (!P.isToday) return out;
  for (const c of P.clock || []) { const t = String(c.clockIn).slice(11, 16); if (!out[c.personId] || t < out[c.personId]) out[c.personId] = t; }
  return out;
}

// ---------------------------------------------------------------- publishing
export function sigOf(P) {
  const crew = Object.entries(P.crew).filter(([, c]) => c.emp).sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => [k, c.emp, c.start, +c.hrs, c.stop || "", ...(c.moves && c.moves.length ? [c.moves.map(m => m.at + ">" + m.to).join(",")] : []), ...(c.brk ? ["b" + c.brk] : [])]);
  const s = JSON.stringify([crew, CATS.map(k => Math.round(P.q[k] || 0))]);
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
/** The frozen copy the Floor screens and Review read: the engine input (so they can replay it) and the headline numbers. No money. */
export function snapshotOf(X) {
  const { P, R, waves } = X;
  const { price, payAvg, laborTarget, ...s } = P.s;
  const used = onCrew(P);
  return {
    sig: sigOf(P), day: P.day,
    input: { q: P.q, crew: P.crew, stations: P.stations, ops: P.ops, trainingOf: P.trainingOf, settings: { ...s, price: {}, payAvg: 0, laborTarget: 0, manual: true /* for a Floor screen still running the older page */ },
      people: P.people.filter(p => used.has(p.id)).map(p => ({ id: p.id, name: p.name, trainings: p.trainings, depth: p.depth || null, start: p.start })) },
    waves: waves.map(w => ({ id: w.id, name: w.name, kind: w.kind, deadline: w.deadline, back: w.back ?? null, q: w.q, todo: w.todo, stores: w.stores || [] })),
    metrics: R.empty ? { empty: true } : { end: R.end, firstStart: R.firstStart, pieces: R.totalPieces, short: R.P.shortTotal, otH: R.otTotal, laborH: R.labor, people: R.rows.filter(r => r.staffed).length },
  };
}

// ---------------------------------------------------------------- a whole day from saved data (Review's next day, the summary email)
/**
 * A day from what's stored: its saved crew, or a copy of the last saved plan.
 * V = pieces view that includes `day`; plan = GET /api/plan/:day. Returns null when there are no pieces for the day.
 */
export function projectDay({ SET, TEAM, V, plan, day, admin = false, now = null }) {
  // a day's plan as entered (Neal, Oct 14: plans are manual): the saved crew, else a copy of the last saved plan
  // (as the Plan page would make it), worked out with the same arithmetic as the Plan page: red finish lines per kind
  // of work and labor at the planned pace. No suggestions, no simulation.
  const s = engineSettings(SET, V.prices || {}), pos = positions(SET), POS = pos.stations.concat(pos.ops);
  const dp = dayPieces(V, SET, day); if (!dp) return null;
  const overrides = plan.overrides || {};
  const P = { s, ...pos, people: peopleFrom(TEAM), crew: crewFromServer(plan.crew, POS, s), q: effectiveQ(dp.base, overrides), waves: dp.waves, day, today: V.today,
    isToday: dp.isToday, now: dp.isToday ? now : null, callouts: plan.callouts || [], late: plan.late || [], history: plan.history || { hours: [], planned: [] }, clock: plan.clock || [], published: plan.published || null, admin,
    expected: dp.expected && !Object.keys(overrides).length, dp };
  let basis = plan.published ? "the published plan" : "the plan saved for that day", copied = null;
  if (!Object.keys(plan.crew || {}).length) {
    if (plan.prev && Object.keys(plan.prev.crew || {}).length) {
      P.crew = copyCrew(plan.prev.crew, POS, s, new Set((plan.callouts || []).map(c => c.personId)));
      copied = plan.prev.day; basis = `copied from ${new Date(plan.prev.day + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}'s plan`;
    } else basis = "no plan saved yet";
  }
  const X = evaluate(P);
  const label = id => (POS.find(p => p.id === id) || {}).label || id;
  const crew = POS.filter(p => P.crew[p.id].emp).map(p => { const c = P.crew[p.id];
    return { code: p.id, station: p.label, name: nameOf(P, c.emp), personId: c.emp, start: c.start, stop: c.stop || "", brk: c.brk || "", hours: +c.hrs || 0,
      moves: (c.moves || []).filter(m => m.at && m.to).map(m => ({ at: m.at, to: m.to, label: label(m.to) })) }; });
  const pieces = CATS.reduce((t, k) => t + (P.q[k] || 0), 0);
  const FIN = X.R.empty ? {} : finishLines(X), fins = Object.values(FIN).filter(f => f.pieces > 0);
  const short = fins.reduce((t, f) => t + (f.short || 0), 0);
  const end = fins.length && fins.every(f => f.finish != null) ? Math.max(...fins.map(f => f.finish)) : fins.some(f => f.finish != null) ? Math.max(...fins.filter(f => f.finish != null).map(f => f.finish)) : null;
  const PL = !X.R.empty && X.M ? paceLabor(X) : null;
  const laborH = PL ? Object.values(PL.people).reduce((t, p) => t + p.paid, 0) : 0;
  return { X, P, FIN, PL, basis, suggested: false, copied, crew, pieces, q: P.q, expected: P.expected, known: dp.D.todo,
    end, lastOut: X.R.empty ? null : X.R.end, firstIn: X.R.empty ? null : X.R.firstStart, short,
    laborH, cost: PL ? PL.total : null, pct: PL ? PL.pct : null, sales: PL ? PL.sales : null,
    schedCost: X.M ? X.M.total : null, schedPct: PL ? PL.schedPct : null, otH: 0, verdict: X.verdict };
}

// ---------------------------------------------------------------- Team: training order from history
/**
 * Suggested training order per person from the last weeks of plans: where they actually worked most comes first
 * (only days they clocked in, when the time clock has that day), then trainings they have but haven't worked, in their
 * current order. A training they were planned on and worked, but don't have yet, is added. Needs 3+ days per person.
 * H = { planned: [{day, personId, station}], worked: [{day, personId}] }; trainingOf = station code -> training id.
 */
export function rankingSuggestions(TEAM, trainingOf, H, minDays = 3) {
  const worked = new Set(H.worked.map(w => `${w.day}|${w.personId}`)), clockDays = new Set(H.worked.map(w => w.day));
  const cnt = new Map();
  for (const p of H.planned) {
    if (clockDays.has(p.day) && !worked.has(`${p.day}|${p.personId}`)) continue; // planned but didn't come in
    const t = trainingOf[p.station]; if (!t) continue;
    const m = cnt.get(p.personId) || cnt.set(p.personId, { _days: new Set(), by: {} }).get(p.personId);
    m._days.add(p.day); m.by[t] = (m.by[t] || 0) + 1;
  }
  const out = [];
  for (const person of TEAM.people.filter(p => p.status === "active")) {
    const m = cnt.get(person.id); if (!m || m._days.size < minDays) continue;
    const cur = person.trainings || [], total = Object.values(m.by).reduce((a, b) => a + b, 0);
    const workedT = Object.keys(m.by).sort((a, b) => m.by[b] - m.by[a] || (cur.indexOf(a) + 1 || 99) - (cur.indexOf(b) + 1 || 99));
    const next = [...workedT, ...cur.filter(t => !m.by[t])];
    if (next.join() === cur.join()) continue;
    out.push({ personId: person.id, name: person.name, days: m._days.size, from: cur, to: next, share: Object.fromEntries(workedT.map(t => [t, m.by[t] / total])), added: workedT.filter(t => !cur.includes(t)) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- the station board (Plan redesign, Oct 13)
/** Station groups in board order, starch bottoms first: [{key, label, codes, cat}] — key is the kind of work (slt covers SLT 1 and the helper). */
export const GROUP_LABEL = { slb: "Starch bottoms", slt: "Starch tops", dct: "Dry cleaning tops", dcb: "Dry cleaning bottoms", comf: "Comforters", tc: "Tablecloths", asm: "Inspect, assemble, bag", ops: "Machine operators" };
export const groupOf = type => (type === "slt2" ? "slt" : type);
export const BOARD_ORDER = ["slb", "slt", "dct", "dcb", "tc", "comf", "asm", "ops"];
/** `order`: the saved screen order (Settings › boardOrder); kinds it leaves out follow in the usual order. */
export function boardGroups(POS, saved) {
  const order = [...new Set([...(saved || []).filter(k => BOARD_ORDER.includes(k)), ...BOARD_ORDER])], out = [];
  for (const key of order) {
    const codes = POS.filter(p => groupOf(p.type) === key).map(p => p.id);
    if (codes.length) out.push({ key, label: GROUP_LABEL[key], codes, cat: CATS.includes(key) ? key : null });
  }
  return out;
}

// ---------------------------------------------------------------- manual plans (Neal, Oct 14)
export const SHIFT_H = 8;   // "assume everyone clocks in and works 8 hours"
/** One person's break as [start, end] hours, from "HH:MM-HH:MM" (or "HH:MM" plus breakMin). */
export function breakOf(c, breakMin = 30) {
  const m = String((c && c.brk) || "").match(/^(\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))?$/); if (!m) return null;
  const a = parseTime(m[1]), b = m[2] ? parseTime(m[2]) : a + breakMin / 60;
  return b > a ? [a, b] : null;
}
/** Clock-in and clock-out of a crew entry (clock-out = its stop, or start + hours + break). */
export function shiftOf(c, breakMin = 30) {
  const start = parseTime(c.start) ?? 7, br = breakOf(c, breakMin), bl = br ? br[1] - br[0] : 0;
  let end = parseTime(c.stop); if (end == null || end <= start) end = start + SHIFT_H;   // 8-hour day unless a clock-out is entered
  return { start, end, brk: br };
}
/** A person's stations in time order: [{ i, stn, from, to }] (the break isn't cut out). */
export function segmentsOf(c, code, breakMin = 30) {
  const { start, end } = shiftOf(c, breakMin);
  const all = (c.moves || []).map(m => ({ at: parseTime(m.at), to: m.to })).filter(m => m.at != null).sort((a, b) => a.at - b.at);
  const first = all.filter(m => m.at <= start + 1e-6).pop();   // a move at clock-in: that's where they start
  const mv = all.filter(m => m.at > start + 1e-6 && m.at < end - 1e-6);
  const cuts = [{ at: start, to: first ? first.to : code }, ...mv];
  return cuts.map((v, i) => ({ i, stn: v.to, from: v.at, to: i + 1 < cuts.length ? cuts[i + 1].at : end }));
}
/** Hours worked = clock-out − clock-in − break; kept in step whenever times change. */
function withHours(c, breakMin) {
  const { start, end, brk } = shiftOf(c, breakMin);
  return { ...c, stop: hhmm(end), hrs: Math.round((end - start - (brk ? brk[1] - brk[0] : 0)) * 100) / 100 };
}
/**
 * Sets the times of one of a person's stations (the clicked bar): segment i runs from..to.
 * The first station's start is their clock-in, the last one's end is their clock-out; in between, the times are moves.
 * Returns a new crew; throws an Error with a plain message when the times don't fit.
 */
export function setSegment(crew, code, i, from, to, breakMin = 30) {
  const C = JSON.parse(JSON.stringify(crew)), c = C[code]; if (!c || !c.emp) return C;
  const segs = segmentsOf(c, code, breakMin), sg = segs[i]; if (!sg) return C;
  if (!(to > from + 1 / 12)) throw new Error("The end has to be after the start.");
  const prev = segs[i - 1], next = segs[i + 1];
  if (prev && from <= prev.from + 1 / 12) throw new Error(`It can't start before ${fmtClock(prev.from + 1 / 12)} (they're on the station before until then).`);
  if (next && to >= next.to - 1 / 12) throw new Error(`It has to end before ${fmtClock(next.to - 1 / 12)} (their next station).`);
  const moves = segs.slice(1).map(x => ({ at: x.from, to: x.stn }));
  if (i === 0) c.start = hhmm(from); else moves[i - 1].at = from;
  if (next) moves[i].at = to; else c.stop = hhmm(to);
  const lead = segs[0].stn !== code ? [{ at: c.start, to: segs[0].stn }] : [];   // starts away from their own station
  c.moves = [...lead, ...moves.map(m => ({ at: hhmm(m.at), to: m.to }))];
  const br = breakOf(c, breakMin), sh = shiftOf(c, breakMin);
  if (br && (br[0] < sh.start || br[1] > sh.end)) c.brk = "";   // a break outside the new shift goes
  C[code] = { ...withHours(c, breakMin), source: "user" };
  return C;
}
/** Sets (or with null clears) a person's break, from–to hours. */
export function setBreak(crew, code, from, to, breakMin = 30) {
  const C = JSON.parse(JSON.stringify(crew)), c = C[code]; if (!c || !c.emp) return C;
  const sh = shiftOf(c, breakMin);
  if (from == null) { C[code] = { ...withHours({ ...c, stop: hhmm(sh.end), brk: "" }, breakMin), source: "user" }; return C; }
  if (!(to > from)) throw new Error("The break has to end after it starts.");
  if (from < sh.start || to > sh.end) throw new Error(`Pick a break between ${fmtClock(sh.start)} and ${fmtClock(sh.end)}.`);
  C[code] = { ...withHours({ ...c, stop: hhmm(sh.end), brk: `${hhmm(from)}-${hhmm(to)}` }, breakMin), source: "user" };
  return C;
}
/** Moves a person to another station from hour `at` (their later moves are dropped). */
export function moveAt(crew, code, toCode, at, breakMin = 30) {
  const C = JSON.parse(JSON.stringify(crew)), c = C[code]; if (!c || !c.emp) return C;
  const { start, end } = shiftOf(c, breakMin);
  if (at <= start + 1e-6) { // from clock-in: they simply start there
    if (toCode === code) { C[code] = { ...c, moves: [], source: "user" }; return C; }
    // Station already has its own person: still allowed (Neal, Oct 16) — they start there as a move at clock-in,
    // and the board shades any overlap red so the manager sees it.
    if (C[toCode] && C[toCode].emp) { C[code] = { ...withHours(c, breakMin), moves: [{ at: hhmm(start), to: toCode }], source: "user" }; return C; }
    C[toCode] = { ...withHours(c, breakMin), moves: [], source: "user" }; C[code] = { emp: "", start: c.start, hrs: c.hrs, stop: "", source: "", moves: [], brk: "" };
    return C;
  }
  if (at >= end - 1 / 12) throw new Error(`${fmtClock(at)} is after they clock out (${fmtClock(end)}).`);
  const keep = (c.moves || []).filter(m => (parseTime(m.at) ?? 0) < at - 1e-6);
  c.moves = [...keep, { at: hhmm(at), to: toCode }];
  C[code] = { ...withHours(c, breakMin), source: "user" };
  return C;
}
/** Takes away one of a person's later stations (the time goes to the station before it). */
export function dropSegment(crew, code, i, breakMin = 30) {
  const C = JSON.parse(JSON.stringify(crew)), c = C[code]; if (!c || !c.emp || i < 1) return C;
  const segs = segmentsOf(c, code, breakMin);
  const lead = segs[0].stn !== code ? [{ at: c.start, to: segs[0].stn }] : [];
  c.moves = [...lead, ...segs.slice(1).filter(x => x.i !== i).map(x => ({ at: hhmm(x.from), to: x.stn }))];
  C[code] = { ...c, source: "user" };
  return C;
}
/**
 * A new day starts as a copy of the last saved plan (Neal, Oct 14: "The plan should repeat for the next day").
 * People who are out that day are left off. The copy has the same people, stations, times, moves and breaks.
 */
export function copyCrew(prevServerCrew, POS, s, outIds = new Set()) {
  const crew = crewFromServer(prevServerCrew, POS, s);
  for (const [code, c] of Object.entries(crew)) {
    if (!c.emp) continue;
    if (outIds.has(c.emp)) { crew[code] = { emp: "", start: c.start, hrs: c.hrs, stop: "", source: "", moves: [], brk: "" }; continue; }
    crew[code] = { ...withHours(c, s.breakMin), source: "user" };
  }
  return crew;
}

/**
 * Where each kind of work should be finished (Neal, Oct 14: "show a red line where they SHOULD be finishing up for the
 * day based on counts and expected pieces per hour"). Plain arithmetic on the plan as entered, no simulation:
 * the pieces (today: the ones left, from now) are worked off at each planned person's pieces-per-hour (Settings ›
 * Rates; the SLT 2 helper adds the pair rate minus the solo rate), minute by minute through their time on that station
 * (breaks are gaps). The line is where the pieces run out. Washers and moves people might make aren't guessed.
 *   { slb: { k, pieces, finish (hours) | null, short (pieces not covered by the plan), people, rate (pieces/hr at full staffing) }, ... }
 */
/**
 * When each person should leave at the planned pace, and the labor that comes to (Neal, Oct 15).
 * A person is needed on a station until that kind of work's red finish line (or their own time there ends, if sooner);
 * they should leave when the last of their stations is done. Short on hours = needed to the end of their time there;
 * work already done (or none) = not needed. Operators keep their scheduled hours.
 * Today: someone still clocked in past their leave time counts up to now; someone clocked out counts to their real clock-out.
 * Returns { people: { empId: { start, leave, end, paid, rate, cost, over, kind } }, total, sched, sales, pct, schedPct, over: [empIds] }.
 */
export function paceLabor(X) {
  const { P, E, R, M } = X, FIN = finishLines(X), people = {};
  if (!R || R.empty) return null;
  const D = P.dp && P.dp.D, live = P.isToday && P.now != null && D, now = P.isToday && P.now != null ? P.now : null;
  const kindOf = stn => (stn === "comf" ? "comf" : groupOf(E.TYPE_OF[stn]));
  const hasWork = new Set([...CATS, "asm"]);
  const rateOf = id => { const e = E.empById(id); return e && +e.rate > 0 ? +e.rate : +P.s.payAvg || 0; };
  const one = (id, code, start, sched, segs, brk) => {
    let leave = start, kind = null;
    for (const g of segs) {
      const k = kindOf(g.stn), f = FIN[k];
      const until = !hasWork.has(k) ? g.to : f ? (f.finish == null ? g.to : f.finish) : live ? Math.max(g.from, Math.min(g.to, now)) : g.from;
      const u = Math.min(g.to, Math.max(g.from, until));
      if (kind == null || u > leave) { leave = Math.max(leave, u); kind = k; }
    }
    leave = Math.min(leave, sched);
    let end = leave;
    if (now != null && (P.clock || []).some(c => c.personId === id)) {
      const st = clockState(P, id, now, brk ? { s: brk[0], e: brk[1] } : null);
      if (st === "gone") end = lastOutOf(P, id) ?? leave; else if (now > leave) end = now;
    }
    const b = brk ? Math.max(0, Math.min(end, brk[1]) - Math.max(start, brk[0])) : 0;
    const unpaid = brk ? Math.max(0, b - paidBreakH(brk[1] - brk[0])) : 0;   // up to 30 min of the break is paid (Neal, Oct 15)
    const paid = Math.max(0, end - start - unpaid), rate = rateOf(id);
    people[id] = { code, start, leave, end, paid, rate, cost: paid * rate, over: end > leave + 1 / 60, kind };
  };
  for (const row of R.rows) if (row.staffed) {
    const id = (P.crew[row.st.id] || {}).emp || row.emp?.empId; if (!id) continue;
    one(id, row.st.id, row.x.start, row.clockOut ?? row.x.start, row.segs, row.brkTaken > 0 ? [row.brkS, row.brkS + row.brkTaken] : null);
  }
  for (const x of E.opsInfo()) if (x.on) {
    const id = (P.crew[x.o.id] || {}).emp; if (!id) continue;
    one(id, x.o.id, x.start, x.end, [{ stn: x.o.id, from: x.start, to: x.end }], x.b ? [x.brkS, x.brkS + x.b] : null);
  }
  const total = Object.values(people).reduce((a, p) => a + p.cost, 0), sales = M ? M.committed : 0, sched = M ? M.total : null;
  return { people, total, sched, sales, pct: sales > 0 ? total / sales * 100 : null, schedPct: sales > 0 && sched != null ? sched / sales * 100 : null,
    over: Object.keys(people).filter(id => people[id].over) };
}
export function finishLines(X) {
  const { P, E, R } = X, out = {};
  if (!R || R.empty) return out;
  const r = P.s.rates, D = P.dp && P.dp.D, live = P.isToday && P.now != null && D;
  const rateOf = stn => { const ty = stn === "comf" ? "comf" : E.TYPE_OF[stn]; return ty === "slt" ? r.sltSolo : ty === "slt2" ? r.sltPair - r.sltSolo : ty === "asm" ? r.asm : r[ty] || 0; };
  const kindOf = stn => (stn === "comf" ? "comf" : groupOf(E.TYPE_OF[stn]));
  const need = {};
  for (const k of CATS) need[k] = Math.max(0, (P.q[k] || 0) - (live ? D.done?.[k] || 0 : 0));
  need.asm = CATS.reduce((t, k) => t + (P.s.asmInclude[k] ? need[k] : 0), 0);
  const segs = {};
  for (const row of R.rows) if (row.staffed) for (const g of row.segs) { const k = kindOf(g.stn); if (k in need) (segs[k] = segs[k] || []).push({ from: g.from, to: g.to, rate: rateOf(g.stn), who: row.emp.empId }); }
  for (const k of Object.keys(need)) {
    const L = segs[k] || [], pieces = need[k];
    if (!(pieces > 0.5)) continue;
    const t0 = Math.max(live ? P.now : -Infinity, Math.min(...L.map(g => g.from), Infinity));
    let cum = 0, finish = null;
    if (L.length && isFinite(t0)) {
      const tEnd = Math.max(...L.map(g => g.to)), dt = 1 / 60;
      for (let t = t0; t < tEnd - 1e-9; t += dt) {
        const rate = L.reduce((a, g) => a + (t >= g.from - 1e-9 && t < g.to - 1e-9 ? g.rate : 0), 0);
        if (cum + rate * dt >= pieces - 1e-6) { finish = t + (rate > 0 ? (pieces - cum) / rate : 0); cum = pieces; break; }
        cum += rate * dt;
      }
    }
    out[k] = { k, pieces, finish, short: finish == null ? Math.max(0, Math.round(pieces - cum)) : 0, people: new Set(L.map(g => g.who)).size, from: isFinite(t0) ? t0 : null };
  }
  return out;
}

/**
 * The station timeline (Neal, Oct 13): one row per kind of work, top to bottom in `groups` order, and in each row a lane
 * per person who works there at some point of the day, with bars for when. Moves show as the person's bar leaving one
 * row and starting in another. Breaks are gaps (with a "brk" bar). Only the plan: who's clocked in is added by the screen.
 *   [{ key, label, codes, cat, lanes: [{ empId, code, bars: [{ from, to, ot?, idle?, brk? }] }] }]
 */
export function stationTimeline(X, groups) {
  const { P, E, R } = X;
  const rows = groups.map(g => ({ ...g, lanes: [] })), byKey = new Map(rows.map(g => [g.key, g]));
  const laneOf = (key, empId, code) => {
    const g = byKey.get(key); if (!g || !empId) return null;
    let l = g.lanes.find(x => x.empId === empId); if (!l) g.lanes.push(l = { empId, code, bars: [] });
    return l;
  };
  const keyOf = stn => (stn === "comf" ? "comf" : groupOf(E.TYPE_OF[stn]));
  if (!R.empty) for (const row of R.rows) {
    if (!row.staffed) continue;
    const code = row.st.id, empId = (P.crew[code] || {}).emp || row.emp?.empId, steps = stepsOf(row);
    const b0 = row.brkTaken > 0 ? row.brkS : null, b1 = b0 != null ? b0 + row.brkTaken : null;
    if (!steps.length) { laneOf(keyOf(code), empId, code)?.bars.push({ from: row.x.start, to: Math.max(row.clockOut || 0, row.x.start + 0.5), idle: true }); continue; }
    let brkDone = b0 == null;
    for (const sp of steps) {
      const l = laneOf(keyOf(sp.stn), empId, code); if (!l) continue;
      let parts = [[sp.from, sp.to]];
      if (!brkDone && b1 > sp.from + 0.01 && b0 < sp.to - 0.01) { parts = [[sp.from, b0], [b1, sp.to]].filter(x => x[1] - x[0] > 0.01); l.bars.push({ from: b0, to: b1, brk: true }); brkDone = true; }
      for (const [from, to] of parts) l.bars.push({ from, to, ot: to > row.x.schedEnd + 0.02 });
    }
    if (!brkDone) { // between two steps (or after the last): on the row they were working just before it
      const prev = steps.filter(sp => sp.from < b0 + 0.01).pop() || steps[0];
      laneOf(keyOf(prev.stn), empId, code)?.bars.push({ from: b0, to: b1, brk: true });
    }
  }
  for (const x of E.opsInfo()) {
    if (!x.on) continue;
    const l = laneOf("ops", (P.crew[x.o.id] || {}).emp, x.o.id); if (!l) continue;
    if (x.b) { l.bars.push({ from: x.start, to: x.brkS }, { from: x.brkS, to: x.brkS + x.b, brk: true }, { from: x.brkS + x.b, to: x.end }); }
    else l.bars.push({ from: x.start, to: x.end });
  }
  for (const g of rows) for (const l of g.lanes) l.bars.sort((a, b) => a.from - b.from);
  return rows;
}

/**
 * The board by person (Neal, Oct 14: "jump over to an Employee view to see who is doing what when"): one line per person,
 * in the order of their own station on the station board, each bar colored and labeled by the station they're on then.
 *   [{ key (their own kind of work), code, empId, label, first, lanes: [{ empId, code, lane: 0, bars: [{ from, to, key, stn, label, ot?, idle?, brk? }] }], nLanes: 1 }]
 */
export function personRows(X, groups) {
  const { P, E, R } = X;
  const stRows = stationRows(X, groups), labelOf = new Map(stRows.map(r => [r.code, r.label])), order = stRows.map(r => r.code);
  const keyOf = stn => (stn === "comf" ? "comf" : groupOf(E.TYPE_OF[stn]) || "ops");
  const out = [];
  const add = (code, empId, bars) => {
    if (!empId) return;
    bars.sort((a, b) => a.from - b.from);
    out.push({ key: keyOf(code), code, empId, label: nameOf(P, empId).split(/\s+/)[0], name: nameOf(P, empId), first: false, lanes: [{ empId, code, lane: 0, bars }], nLanes: 1 });
  };
  // overlapping time someone shares a station with another person (flagged on the station board)
  const dupOf = new Map();
  for (const r of stRows) for (const l of r.lanes) for (const x of l.bars) if (x.dup) { const k = `${l.empId}|${r.code}`; if (!dupOf.has(k)) dupOf.set(k, []); dupOf.get(k).push(x); }
  const flag = (empId, list) => list.flatMap(x => {
    const d = !x.brk && dupOf.get(`${empId}|${x.stn}`); if (!d) return [x];
    return splitDup(x, d.map(y => ({ from: y.from, to: y.to, empId: y.dupWith[0] }))).map(y => y.dup ? { ...y, dupWith: [...new Set(d.filter(z => z.from < y.to - 0.01 && z.to > y.from + 0.01).flatMap(z => z.dupWith))] } : y);
  });
  if (!R.empty) for (const row of R.rows) {
    if (!row.staffed) continue;
    const code = row.st.id, empId = (P.crew[code] || {}).emp || row.emp?.empId, steps = stepsOf(row), bars = [];
    const b0 = row.brkTaken > 0 ? row.brkS : null, b1 = b0 != null ? b0 + row.brkTaken : null;
    const bar = (stn, from, to, extra = {}) => bars.push({ from, to, key: keyOf(stn), stn, label: labelOf.get(stn) || stn, ot: to > row.x.schedEnd + 0.02, ...extra });
    if (!steps.length) bar(code, row.x.start, Math.max(row.clockOut || 0, row.x.start + 0.5), { idle: true, ot: false });
    for (const sp of steps) {
      if (b0 != null && b1 > sp.from + 0.01 && b0 < sp.to - 0.01) { if (b0 - sp.from > 0.01) bar(sp.stn, sp.from, b0); if (sp.to - b1 > 0.01) bar(sp.stn, b1, sp.to); }
      else bar(sp.stn, sp.from, sp.to);
    }
    if (b0 != null) bars.push({ from: b0, to: b1, brk: true, key: keyOf(code), stn: code, label: "" });
    add(code, empId, flag(empId, bars));
  }
  for (const x of E.opsInfo()) {
    if (!x.on) continue;
    const code = x.o.id, lab = labelOf.get(code) || x.o.label, k = "ops";
    const bars = x.b ? [{ from: x.start, to: x.brkS, key: k, stn: code, label: lab }, { from: x.brkS, to: x.brkS + x.b, brk: true, key: k, stn: code, label: "" }, { from: x.brkS + x.b, to: x.end, key: k, stn: code, label: lab }]
      : [{ from: x.start, to: x.end, key: k, stn: code, label: lab }];
    add(code, (P.crew[code] || {}).emp, bars);
  }
  out.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
  out.forEach((r, i) => { r.first = i === 0 || out[i - 1].key !== r.key; });
  return out;
}

/**
 * The same board with one row per station (Neal, Oct 14: "I liked it better when I could see the individual stations"):
 * SLB 1, SLB 2, DCT 1, ... in `groups` order (kinds of work stay together; the first row of each kind has `first`).
 * People who don't overlap share a lane (Maria on SLB 2 until 7:30, then Diana), so a station is one line most of the day.
 *   [{ key, code, label, cat, first, codes: [code], lanes: [{ empId, code, lane, bars }], nLanes }]
 */
export function stationRows(X, groups) {
  const { P, E, R } = X;
  const short = (p) => p.type === "ops" ? p.label.replace(/Starch Laundry/i, "SL").replace(/Dry Cleaning/i, "DC") : p.label.replace(/\s*\(helper\)/i, " helper");
  const rows = [], byCode = new Map();
  for (const g of groups) g.codes.forEach((code, i) => {
    const p = E.POS.find(x => x.id === code) || { id: code, label: code, type: g.key };
    const r = { key: g.key, code, label: short(p), cat: g.cat, first: i === 0, codes: [code], lanes: [], nLanes: 1 };
    rows.push(r); byCode.set(code, r);
  });
  const laneOf = (code, empId, home) => {
    const r = byCode.get(code); if (!r || !empId) return null;
    let l = r.lanes.find(x => x.empId === empId); if (!l) r.lanes.push(l = { empId, code: home, bars: [] });
    return l;
  };
  if (!R.empty) for (const row of R.rows) {
    if (!row.staffed) continue;
    const code = row.st.id, empId = (P.crew[code] || {}).emp || row.emp?.empId, steps = stepsOf(row);
    const b0 = row.brkTaken > 0 ? row.brkS : null, b1 = b0 != null ? b0 + row.brkTaken : null;
    if (!steps.length) { laneOf(code, empId, code)?.bars.push({ from: row.x.start, to: Math.max(row.clockOut || 0, row.x.start + 0.5), idle: true }); continue; }
    let brkDone = b0 == null;
    for (const sp of steps) {
      const l = laneOf(sp.stn, empId, code); if (!l) continue;
      let parts = [[sp.from, sp.to]];
      if (!brkDone && b1 > sp.from + 0.01 && b0 < sp.to - 0.01) { parts = [[sp.from, b0], [b1, sp.to]].filter(x => x[1] - x[0] > 0.01); l.bars.push({ from: b0, to: b1, brk: true }); brkDone = true; }
      for (const [from, to] of parts) l.bars.push({ from, to, ot: to > row.x.schedEnd + 0.02 });
    }
    if (!brkDone) { const prev = steps.filter(sp => sp.from < b0 + 0.01).pop() || steps[0]; laneOf(prev.stn, empId, code)?.bars.push({ from: b0, to: b1, brk: true }); }
  }
  for (const x of E.opsInfo()) {
    if (!x.on) continue;
    const l = laneOf(x.o.id, (P.crew[x.o.id] || {}).emp, x.o.id); if (!l) continue;
    if (x.b) l.bars.push({ from: x.start, to: x.brkS }, { from: x.brkS, to: x.brkS + x.b, brk: true }, { from: x.brkS + x.b, to: x.end });
    else l.bars.push({ from: x.start, to: x.end });
  }
  // pack: the station's own person first, then the rest by start; each goes in the first lane they don't overlap
  for (const r of rows) {
    for (const l of r.lanes) { l.bars.sort((a, b) => a.from - b.from); l.from = l.bars.length ? l.bars[0].from : 0; l.to = Math.max(0, ...l.bars.map(x => x.to)); }
    r.lanes.sort((a, b) => ((a.code !== r.code) - (b.code !== r.code)) || a.from - b.from);
    const ends = [];
    for (const l of r.lanes) {
      const free = l.bars.filter(x => !x.brk);
      let i = ends.findIndex(seg => seg.every(([f, t]) => free.every(x => x.to <= f + 0.01 || x.from >= t - 0.01)));
      if (i < 0) { i = ends.length; ends.push([]); }
      ends[i].push(...free.map(x => [x.from, x.to])); l.lane = i;
    }
    // someone filling in during the owner's break shows in the gap instead of the break stripes
    for (const l of r.lanes) l.bars = l.bars.filter(x => !x.brk || !r.lanes.some(o => o !== l && o.lane === l.lane && o.bars.some(y => !y.brk && y.from < x.to - 0.01 && y.to > x.from + 0.01)));
    r.nLanes = Math.max(1, ends.length);
    // two people on one station at once: the later one's overlapping time is flagged (Neal, Oct 15)
    r.lanes.forEach((l, k) => {
      const before = r.lanes.slice(0, k).flatMap(o => o.bars.filter(x => !x.brk && !x.idle).map(x => ({ ...x, empId: o.empId })));
      if (before.length) l.bars = l.bars.flatMap(x => x.brk || x.idle ? [x] : splitDup(x, before));
    });
  }
  return rows;
}
/** Cuts a bar where it overlaps any of `others` (bars with empId); the overlapping pieces get dup: true and dupWith: [empId]. */
function splitDup(bar, others) {
  const hits = others.filter(o => o.from < bar.to - 0.01 && o.to > bar.from + 0.01);
  if (!hits.length) return [bar];
  const cuts = [...new Set([bar.from, bar.to, ...hits.flatMap(o => [o.from, o.to]).filter(t => t > bar.from && t < bar.to)])].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const f = cuts[i], t = cuts[i + 1]; if (t - f < 0.01) continue;
    const w = hits.filter(o => o.from < t - 0.01 && o.to > f + 0.01).map(o => o.empId);
    const piece = { ...bar, from: f, to: t, dup: w.length > 0, dupWith: [...new Set(w)] };
    const prev = out[out.length - 1];
    if (prev && prev.dup === piece.dup && String(prev.dupWith) === String(piece.dupWith) && Math.abs(prev.to - f) < 0.01) prev.to = t; else out.push(piece);
  }
  return out;
}

/**
 * Is today's production over? (Neal, Oct 13: "Once all production employees clock out or we have not seen an item assembled
 * for 30 minutes it is clear the production day is complete." Anything still left is waiting for later or for a manager.)
 *   { why: "out" | "quiet", at }  or null
 * Someone out on their break (clocked out near their planned break, under an hour ago) holds it open either way, so a
 * lunch gap doesn't end the day. `lastAsm` is the latest assembly today (ISO time from SMRT).
 */
export function productionDone(P, lastAsm, brks = {}) {
  if (!P.isToday || P.now == null) return null;
  const ids = [...new Set((P.clock || []).map(c => c.personId))]; if (!ids.length) return null;
  const states = ids.map(id => clockState(P, id, P.now, brks[id]));
  if (states.includes("break")) return null;
  if (!states.includes("in")) return { why: "out", at: Math.max(...ids.map(id => lastOutOf(P, id) ?? 0)) };
  if (!lastAsm) return null;
  const d = new Date(lastAsm); if (isNaN(d)) return null;
  const at = d.getHours() + d.getMinutes() / 60;
  return P.now - at >= 0.5 ? { why: "quiet", at } : null;
}
