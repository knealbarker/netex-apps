// The Plan screen's logic, kept apart from the page so it can be tested in Node:
//  - turns settings, the team and the saved plan into the engine's input
//  - pieces to plan (SMRT, plus counts typed over it), deadlines and when each will be ready
//  - "suggest from history", auto-assign, the 40-hour watch
//  - the checks shown before publishing, each with one-click fixes
//  - the verdict line and the snapshot stored when a plan is published
import { createEngine, buildWaves, waveEtas, waveState, stepsOf, CATS, CAT_FULL, CAT_LABEL, parseTime, hhmm, fmtClock, hm, fmtH, fmtN, fmt$, median } from "../engine/engine.js";
import { firstBreak, paidBreakH } from "../engine/breakpay.js";

export const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekday = day => new Date(day + "T12:00:00Z").getUTCDay();
export const addDays = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const TYPE_LABEL = { slt: "SLT", slb: "SLB", dct: "DCT", dcb: "DCB", asm: "IAB", comf: "Comforters", tc: "Tablecloths" };
const first = name => String(name || "").split(" ")[0];

// ---------------------------------------------------------------- engine input
/** Flat engine settings from the Settings screen's groups and tables (and SMRT's average prices when known). */
export function engineSettings(SET, smrtPrices = {}) {
  const g = SET.groups, rate = (type, cat) => (SET.rates.find(r => r.type === type && r.category === cat) || {}).perHour;
  const wash = cat => SET.wash.find(w => w.category === cat) || {};
  const asmRate = rate("asm", "dct") || (SET.rates.find(r => r.type === "asm") || {}).perHour || 100;
  return {
    defStart: g.day.defStart, fullDay: g.day.fullDay, breakMin: g.day.breakMin, breakAfter: g.day.breakAfter, spread: g.day.spread, staggerBreaks: g.day.staggerBreaks,
    allowOT: g.staffing.allowOT, otMax: g.staffing.otMax, otMult: g.staffing.otMult, allowMoves: g.staffing.allowMoves, allowClockOut: g.staffing.allowClockOut, minPaid: g.staffing.minPaid,
    comfMax: g.staffing.comfMax ?? 2, comfExtra: (g.staffing.comfExtra ?? 20) / 100, slbPrime: g.staffing.slbPrime ?? 20, slbCover: g.staffing.slbCover ?? true,
    washOn: g.wash.on && g.wash.washers > 0, washers: g.wash.washers, washDelay: g.wash.delay,
    washSlt: wash("slt").perLoad || 65, washSlb: wash("slb").perLoad || 25, washComf: wash("comf").perLoad || 2, washTc: wash("tc").perLoad || 10,
    cycSlt: wash("slt").cycleMin || 45, cycSlb: wash("slb").cycleMin || 45, cycComf: wash("comf").cycleMin || 60, cycTc: wash("tc").cycleMin || 40,
    rates: { sltSolo: rate("slt", "slt") || 50, sltPair: rate("slt_helper", "slt") || 80, slb: rate("slb", "slb") || 38, dct: rate("dct", "dct") || 25,
      dcb: rate("dcb", "dcb") || 25, tc: rate("tc", "tc") || rate("dcb", "tc") || 6, asm: asmRate, comf: rate("comf", "comf") || 3 },
    asmInclude: Object.fromEntries(CATS.map(k => [k, !!(SET.categories.find(c => c.id === k) || {}).needsAssembly])),
    stationMax: Object.fromEntries(SET.stations.filter(s => s.maxHours > 0).map(s => [s.code, s.maxHours])),
    price: { ...g.money.prices, ...smrtPrices }, payAvg: g.money.payAvg, laborTarget: g.money.laborTarget,
    weekStart: g.alerts.weekStart,
    manual: true,   // Neal, Oct 14: plans are made by hand; the engine draws exactly what was entered
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

export function blankCrew(POS, s) { return Object.fromEntries(POS.map(p => [p.id, { emp: "", start: s.defStart, hrs: s.fullDay, stop: "", source: "" }])); }
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
  // today, what's still left at each deadline right now (for the suggestions during the day)
  const zero = () => Object.fromEntries(CATS.map(k => [k, 0]));
  const wavesLeft = isToday ? buildWaves({ ...D, isToday, stores: (D.stores || []).map(x => ({ ...x, q: Object.fromEntries(CATS.map(k => [k, Math.max(0, (x.q[k] || 0) - (x.done?.[k] || 0))])), done: zero() })) },
    SET.runs, { overdue: withOverdue ? V.overdue : null }) : null;
  return { D, isToday, withOverdue, expected, base, waves, wavesLeft };
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
  const etas = R.empty || R.manual ? {} : waveEtas(R, waves, P.q, P.s.asmInclude);
  const states = Object.fromEntries(waves.map(w => { const st = waveState(w, etas[w.id]); st.eta = etas[w.id]; return [w.id, st]; }));
  const X = { P, E, R, M, waves, etas, states };
  // a manual plan (Neal, Oct 14) has no predictions to check: no deadline fixes, no warnings
  X.week = R.manual ? null : weekWatch(X);
  X.checks = R.manual ? [] : buildChecks(X);
  X.verdict = verdict(X);
  return X;
}

export const nameOf = (P, id) => (P.people.find(p => p.id === id) || {}).name || "Someone";
const whoAt = (P, code) => nameOf(P, (P.crew[code] || {}).emp);
const onCrew = P => new Set(Object.values(P.crew).map(c => c.emp).filter(Boolean));
const calledOut = P => new Set((P.callouts || []).map(c => c.personId));
/** People coming in late on this day: {personId: "HH:MM"} (Team screen › Time off). */
export const lateOf = P => Object.fromEntries((P.late || []).map(l => [l.personId, l.at]));
/** A start time no earlier than the person's late arrival. */
export const notBeforeLate = (P, id, start) => { const l = lateOf(P)[id]; return l && (!start || start < l) ? l : start; };
const live = (X, w) => !(X.P.isToday && X.P.now != null && w.kind !== "overdue" && w.deadline != null && X.P.now > w.deadline);

/** Hours this workweek (finished days, from Rippling) plus today's plan, for people who'd pass 40. */
export function weekWatch(X) {
  const { P, R, E } = X, out = [];
  if (R.empty || !P.history) return out;
  const back = (weekday(P.day) - (P.s.weekStart ?? 1) + 7) % 7, start = addDays(P.day, -back);
  const sofar = {};
  for (const h of P.history.hours) if (h.day >= start && h.day < P.day) sofar[h.personId] = (sofar[h.personId] || 0) + (+h.hours || 0);
  const one = (id, code, startH, paid) => {
    const before = sofar[id] || 0, total = before + paid;
    if (!(before > 0 && total > 40.01)) return;
    const budget = 40 - before;
    const reached = budget > 0 ? startH + budget + (budget > P.s.breakAfter ? P.s.breakMin / 60 : 0) : null;
    const w = { id, name: nameOf(P, id), sofar: before, today: paid, total, code, reached };
    if (reached != null && (!P.isToday || reached > (P.now ?? 0) + 0.25)) w.stopAt = Math.round(reached * 12) / 12;
    else if (!P.isToday && budget > 0) w.keep = Math.max(0, budget);
    out.push(w);
  };
  for (const row of R.rows) if (row.staffed) one(P.crew[row.st.id].emp, row.st.id, row.x.start, row.paid || 0);
  for (const x of E.opsInfo()) if (x.on) one(P.crew[x.o.id].emp, x.o.id, x.start, x.hrs + x.b);
  return out.sort((a, b) => b.total - a.total);
}

// The deadline that's late: start the person on the station that finishes last earlier, or add someone free.
function bottleneckFix(X, w, eta) {
  const { P, R, E } = X;
  const cats = ["dct", "dcb", "slt", "slb", "tc", "comf"].filter(k => (w.q[k] || 0) > 0.5);
  if (!cats.length || !R.TL || !R.TL.length) return null;
  const TL = R.TL, col = { slt: 1, slb: 2, dct: 3, dcb: 4, tc: 5, comf: 6 }, last = TL[TL.length - 1];
  let worst = null, wt = -1;
  for (const k of cats) { const t = (TL.find(s => s[col[k]] >= Math.min(w.q[k], last[col[k]]) - 0.5) || last)[0]; if (t > wt) { wt = t; worst = k; } }
  const type = worst === "tc" && !E.HAS_TC ? "dcb" : worst;
  const rows = R.rows.filter(r => r.staffed && E.POOL_OF(r.st.type) === type).sort((a, b) => b.x.start - a.x.start);
  const late = Math.max(0.25, Math.min(1, (isFinite(eta) ? eta - w.deadline : 1) + 0.25)), now = P.isToday ? (P.now ?? -1) : -1;
  if (rows.length && rows[0].x.start - late > now + 0.1) {
    const r = rows[0], ns = Math.max(3, r.x.start - Math.ceil(late * 12) / 12);
    return { label: `Start ${first(whoAt(P, r.st.id))} at ${hm(ns)}`, why: `${CAT_FULL[worst]} finish last`, apply: Q => { Q.crew[r.st.id].start = hhmm(ns); } };
  }
  const st = E.STATIONS.find(s => E.POOL_OF(s.type) === type && !P.crew[s.id].emp);
  const used = onCrew(P), out = calledOut(P);
  const e = st && P.people.filter(x => !used.has(x.id) && !out.has(x.id) && E.rankOf(x, st.id)).sort((a, b) => E.rankOf(a, st.id) - E.rankOf(b, st.id))[0];
  if (st && e) {
    const at = now > 0 ? Math.max(now + 0.25, parseTime(e.start || P.s.defStart) || 0) : parseTime(e.start || P.s.defStart) || 7;
    const t = hhmm(Math.ceil(at * 12) / 12);
    return { label: `Add ${first(e.name)} on ${st.label}${now > 0 ? ` at ${hm(parseTime(t))}` : ""}`, why: `${CAT_FULL[worst]} finish last`, apply: Q => { Q.crew[st.id] = { emp: e.id, start: t, hrs: P.s.fullDay, stop: "", source: "user" }; } };
  }
  return { why: `${CAT_FULL[worst]} finish last — move someone trained on it from a station that's ahead` };
}

/** Checks before publishing. cls: b (problem), w (warning), i (note), g (good). fixes: [{label, apply(P)} | {label, train:{personId, training}} | {label, action}] */
export function buildChecks(X) {
  const { P, R, E, M, waves, states } = X, C = [];
  const add = (cls, title, text, fixes = [], extra = {}) => C.push({ cls, title, text, fixes: fixes.filter(f => f && (f.apply || f.train || f.action)), ...extra });
  if (R.empty) {
    add("i", R.noCrew ? "No one is on a station" : "Nothing to plan yet", R.noCrew ? "Pick people for the stations, or use Suggest from history." : "No pieces are due for this day yet.");
    return C;
  }
  const tol = P.s.spread / 60, used = onCrew(P), out = calledOut(P);
  // once today's plan is published the day is running: each store's status is on the Deadlines card, not a check
  const running = P.isToday && !!P.published;
  for (const w of running ? [] : waves) {
    if (!w.todo || w.kind === "overdue" || !live(X, w)) continue;
    const st = states[w.id], eta = st.eta; if (eta == null) continue;
    if (P.isToday && w.leftTodo === 0) continue;
    const what = w.kind === "shuttle" ? `${hm(w.deadline)} shuttle` : w.kind === "route" ? "Route deliveries" : "Counter";
    if (st.cls === "good") { add("g", `${what} ready by ${hm(eta)}`, `${w.name}: ${fmtN(w.todo)} pieces${isFinite(st.slack) ? `, ${st.slack >= 60 ? fmtH(st.slack / 60) : Math.round(st.slack) + " min"} to spare` : ""}.`); continue; }
    const fix = bottleneckFix(X, w, eta);
    add(st.late ? "b" : "w", `${w.name} ${st.late ? "won't be ready" : "is tight"} at ${hm(w.deadline)}`,
      `${isFinite(eta) ? `Ready about ${fmtClock(eta)}` : "Not enough hours planned to finish it"}${fix && fix.why ? ` — ${fix.why}` : ""}.`, fix && fix.apply ? [fix] : []);
  }
  if (R.I.slt2 && R.I.slt2.a > 0 && !(R.I.slt1 && R.I.slt1.a > 0) && P.q.slt > 0)
    add("b", "SLT 2 is only a helper station", `No one is on SLT 1. Put ${whoAt(P, "slt2")} on SLT 1.`, [{ label: `Move ${first(whoAt(P, "slt2"))} to SLT 1`, apply: Q => { Q.crew.slt1 = { ...Q.crew.slt2 }; Q.crew.slt2 = { ...Q.crew.slt2, emp: "", stop: "" }; } }]);
  if (R.P.shortTotal > 0.5) {
    const items = Object.entries(R.P.short).filter(([k, v]) => v > 0.5 && k !== "asm");
    add("b", `${fmtN(R.P.shortTotal)} pieces won't get done`, `Even ${P.s.allowOT ? `with up to ${fmtH(P.s.otMax)} overtime each` : "in the scheduled hours (overtime is off)"}: ${items.map(([k, v]) => `${CAT_LABEL[k]} ${fmtN(v)}`).join(", ")}.`);
  }
  // Comforters / Tablecloths need someone trained on them
  for (const [k, has] of [["comf", E.HAS_COMF], ["tc", E.HAS_TC]]) {
    if (!has || !((P.q[k] || 0) > 0.5)) continue;
    const st = E.STATIONS.find(x => x.type === k);
    if (!P.people.some(e => !out.has(e.id) && E.rankOf(e, st.id))) add("b", `No one is trained on ${st.label}`, `${fmtN(P.q[k])} ${CAT_FULL[k].toLowerCase()} can't be planned. Add the ${st.label} training to the people who can do them (Team screen).`);
  }
  // on the crew but out (Team › Time off, or a call-out), or planned before their late arrival
  const clock = clockInOf(P), late = lateOf(P);
  for (const pos of E.POS) {
    const c = P.crew[pos.id], id = c.emp; if (!id) continue;
    if (out.has(id)) {
      const co = (P.callouts || []).find(x => x.personId === id);
      add("b", `${nameOf(P, id)} is out`, `Still on ${pos.label}${co && co.note ? ` (${co.note})` : ""}.`, [{ label: `Take ${first(nameOf(P, id))} off ${pos.label}`, apply: Q => { Q.crew[pos.id] = { ...Q.crew[pos.id], emp: "", stop: "" }; } }]);
    } else if (late[id] && !clock[id] && c.start < late[id]) {
      add("w", `${nameOf(P, id)} comes in at ${hm(parseTime(late[id]))}`, `Planned on ${pos.label} from ${hm(parseTime(c.start))}.`, [{ label: `Start ${first(nameOf(P, id))} at ${hm(parseTime(late[id]))}`, apply: Q => { Q.crew[pos.id].start = late[id]; } }]);
    }
  }
  // called out, station left empty
  for (const c of P.callouts || []) {
    const pos = E.POS.find(p => p.id === c.station); if (!pos || P.crew[pos.id].emp) continue;
    const bench = P.people.filter(e => !used.has(e.id) && !out.has(e.id) && E.rankOf(e, pos.id)).sort((a, b) => E.rankOf(a, pos.id) - E.rankOf(b, pos.id)).slice(0, 2);
    add("b", `${nameOf(P, c.personId)} called out`, `${pos.label} is empty.${bench.length ? " Trained and not scheduled:" : " No one else trained on it is free."}`,
      bench.map(e => ({ label: `Add ${first(e.name)}`, apply: Q => { Q.crew[pos.id] = { emp: e.id, start: e.start || P.s.defStart, hrs: P.s.fullDay, stop: "", source: "user" }; } })));
  }
  // waiting on the washers
  if (R.W) for (const r of R.rows) {
    if (!r.staffed || !r.segs.length || !["slt", "slt2", "slb"].includes(r.st.type)) continue;
    const f = (r.segs.find(sg => sg.stn !== "comf") || r.segs[0]).from;
    if (P.isToday && P.now != null && f <= P.now) continue;
    if (f - r.x.start >= 0.25) add("w", `${whoAt(P, r.st.id)} would wait ${fmtH(f - r.x.start)}`, `Nothing to press on ${r.st.label} until the washer is done at ${fmtClock(f)}.`,
      [{ label: `Start ${first(whoAt(P, r.st.id))} at ${hm(f)}`, apply: Q => { Q.crew[r.st.id].start = hhmm(f); } }]);
  }
  const otP = R.rows.filter(r => r.staffed && r.ot > 0.04);
  if (otP.length) add("w", `${fmtH(R.otTotal)} of overtime`, `${P.isToday && P.now > R.firstStart ? "Approve or adjust" : "Approve before the day starts"}.`, [], { list: otP.map(r => `${whoAt(P, r.st.id)} +${fmtH(r.ot)}, until ${fmtClock(r.clockOut)}`) });
  if (X.week.length) {
    const fx = [];
    for (const w of X.week) {
      if (fx.length >= 3) break;
      if (w.stopAt != null) fx.push({ label: `${first(w.name)}: stop at ${hm(w.stopAt)}`, apply: Q => { Q.crew[w.code].stop = hhmm(w.stopAt); } });
      else if (w.keep != null) fx.push({ label: `${first(w.name)}: ${fmtH(w.keep)} today`, apply: Q => { Q.crew[w.code].hrs = Math.max(0, Math.round(w.keep * 4) / 4); } });
    }
    add("w", `${X.week.length} ${X.week.length === 1 ? "person goes" : "people go"} over 40 hours this week`, "Hours this week with this plan (overtime pay after 40):", fx,
      { list: X.week.map(w => `${w.name}: ${fmtH(w.total)} (${fmtH(w.sofar)} before today${w.reached != null ? ` · reaches 40 at ${hm(w.reached)}` : " · already past 40"})`) });
  }
  const idle = R.rows.filter(r => r.staffed && !stepsOf(r).length);
  if (idle.length) add("i", `${idle.length === 1 ? whoAt(P, idle[0].st.id) + " isn't" : idle.length + " people aren't"} needed`, `No work left for ${idle.map(r => whoAt(P, r.st.id)).join(", ")} on the stations they're trained for.`,
    idle.slice(0, 3).map(r => ({ label: `Take ${first(whoAt(P, r.st.id))} off`, apply: Q => { Q.crew[r.st.id] = { ...Q.crew[r.st.id], emp: "", stop: "" }; } })));
  const untr = E.POS.filter(p => P.crew[p.id].emp && +P.crew[p.id].hrs > 0 && !E.trained(P.crew[p.id].emp, p.id));
  if (untr.length) add("w", "Not trained for the station", `${untr.map(p => `${whoAt(P, p.id)} on ${p.label}`).join(", ")}. Expect less than planned.`,
    untr.slice(0, 2).filter(p => P.trainingOf[p.id]).map(p => ({ label: `${first(whoAt(P, p.id))} is trained on ${p.label}`, train: { personId: P.crew[p.id].emp, training: P.trainingOf[p.id] } })));
  if (R.P.shortTotal > 0.5 || otP.length || waves.some(w => live(X, w) && states[w.id].late)) {
    const need = E.stationNeed(P.q);
    for (const st of E.STATIONS) {
      if (P.crew[st.id].emp || R.cover[st.id].length || (need[st.id] || 0) < 0.5) continue;
      const spare = P.people.filter(e => !used.has(e.id) && !out.has(e.id) && E.rankOf(e, st.id)).sort((a, b) => E.rankOf(a, st.id) - E.rankOf(b, st.id)).slice(0, 2);
      if (spare.length) add("i", `${st.label} is empty`, `Trained and not scheduled: ${spare.map(e => e.name).join(", ")}.`,
        spare.map(e => ({ label: `Add ${first(e.name)}`, apply: Q => { Q.crew[st.id] = { emp: e.id, start: e.start || P.s.defStart, hrs: P.s.fullDay, stop: "", source: "user" }; } })));
    }
  }
  if (R.spread > tol + 1e-3) {
    const early = R.rows.filter(x => x.staffed && x.gap > tol && stepsOf(x).length).sort((a, b) => b.gap - a.gap);
    if (early.length) {
      // the stations that run late, and who finishes early without being trained on them
      const lateT = new Set();
      for (const rw of R.rows) if (rw.staffed) for (const sg of rw.segs) if ((E.HAS_COMF || sg.stn !== "comf") && sg.to >= R.end - 0.05) lateT.add(E.POOL_OF(E.TYPE_OF[sg.stn]));
      const miss = [...lateT].filter(t => early.some(rw => !E.STATIONS.some(x => E.POOL_OF(x.type) === t && E.trained(P.crew[rw.st.id].emp, x.id)))).map(t => TYPE_LABEL[t]).filter(Boolean);
      add("w", `Not everyone finishes within ${P.s.spread} min`, `${early.map(x => `${whoAt(P, x.st.id)} (${fmtH(x.gap)} early)`).join(", ")} run out of work they're trained for.${miss.length ? ` Cross-training on ${miss.join(", ")} would let them help.` : ""}`);
    }
  }
  const lateNow = waves.some(w => live(X, w) && states[w.id].late) || R.P.shortTotal > 0.5;
  const homeEarly = R.rows.filter(r => r.staffed && r.early >= 0.5);
  if (!lateNow && P.isToday && homeEarly.length) {
    const hrs = homeEarly.reduce((t, r) => t + r.early, 0), from = Math.min(...homeEarly.map(r => r.clockOut));
    add("i", "Room to get ahead", `About ${fmtH(hrs)} of crew time is free after ${hm(from)} (${homeEarly.map(r => first(whoAt(P, r.st.id))).join(", ")}). Pieces finished ahead come off the next day's plan.`);
  }
  if (P.admin && M && M.pct != null && M.pct > P.s.laborTarget) add("b", `Labor ${M.pct.toFixed(1)}% of revenue`, `Above the ${P.s.laborTarget}% target by ${fmt$(M.total - M.budget)}.`, [], { money: true });
  if (!C.some(c => c.cls === "b" || c.cls === "w")) add("g", `Everyone finishes by ${hm(R.end)}`, `Within ${P.s.spread} minutes of each other, ${otP.length ? "" : "no overtime, "}nothing left undone.`);
  const sig = sigOf(P);
  if (!P.published) { if (P.isToday || P.day > (P.today || "")) add("i", "Not published yet", "The Floor screens show this plan once it's published.", [{ label: "Publish", action: "publish" }]); }
  else if (P.published.sig !== sig) add("i", "Changed since it was published", `Published at ${fmtClock(clockOf(P.published.at))} by ${P.published.by || "someone"}. Publish again so the floor sees the changes.`, [{ label: "Publish again", action: "publish" }]);
  const order = { b: 0, w: 1, i: 2, g: 3 };
  return C.sort((a, b) => order[a.cls] - order[b.cls]);
}
const clockOf = iso => { const d = new Date(iso); return d.getHours() + d.getMinutes() / 60; };

export function verdict(X) {
  const { P, R, M, waves, states, E } = X;
  if (R.empty) return { cls: "idle", head: R.noCrew ? "Pick the crew" : "Nothing to plan yet", kpis: [] };
  if (R.manual) {   // a plan entered by hand: facts only
    const tot = CATS.reduce((t, k) => t + (P.q[k] || 0), 0), people = R.rows.filter(r => r.staffed).length + E.opsInfo().filter(x => x.on).length;
    return { cls: "ok", head: "Plan", kpis: [{ v: (P.expected ? "~" : "") + fmtN(tot), l: P.expected ? "pieces expected" : "pieces" }, { v: String(people), l: "people" }, { v: hm(R.end), l: "last out" }] };
  }
  // once today's plan is published, deadlines don't drive the headline (Neal: nothing to act on; the Deadlines card shows each store)
  const running = P.isToday && !!P.published;
  const W = running ? [] : waves.filter(w => w.todo > 0 && w.kind !== "overdue" && live(X, w) && !(P.isToday && w.leftTodo === 0));
  const late = W.filter(w => states[w.id].late), tight = W.filter(w => states[w.id].tight);
  const short = R.P.shortTotal > 0.5, ot = R.otTotal > 0.04;
  let cls = "ok", head = running ? "On plan" : "This plan works";
  if (W.length) head = late.length ? `${late.map(w => w.name).join(", ")} won't make it` : tight.length ? `${tight.map(w => w.name).join(", ")} ${tight.length === 1 ? "is" : "are"} tight` : `${W.length === 1 ? "The deadline makes" : `All ${W.length} deadlines make`} it`;
  if (late.length || short) { cls = "bad"; if (!late.length) head = `${fmtN(R.P.shortTotal)} pieces won't get done`; }
  else if (tight.length || ot) { cls = "warn"; if (!tight.length && ot) head = `Needs ${fmtH(R.otTotal)} overtime`; }
  const tot = CATS.reduce((t, k) => t + (P.q[k] || 0), 0);
  const ops = E.opsInfo().filter(x => x.on);
  const people = R.rows.filter(r => r.staffed).length + ops.length, hrs = M ? M.regH + M.otH + M.opsH : 0;
  const k = [];
  const firstW = W.find(w => w.kind === "shuttle") || W[0];
  if (firstW && states[firstW.id].eta != null && isFinite(states[firstW.id].eta)) {
    const s = states[firstW.id];
    k.push({ v: hm(s.eta), cls: s.cls, l: `${firstW.kind === "shuttle" ? hm(firstW.deadline) + " shuttle ready" : firstW.kind === "route" ? "route ready" : "counter ready"}` });
  }
  k.push({ v: (P.expected ? "~" : "") + fmtN(tot), l: P.expected ? "pieces expected" : "pieces" });
  k.push({ v: hm(R.end), l: "everyone done" });
  k.push({ v: String(people), l: `people · ${fmtH(hrs)}` });
  if (P.admin && M && M.pct != null) k.push({ v: `${M.pct.toFixed(1)}%`, cls: M.pct <= P.s.laborTarget ? "good" : "bad", l: `labor · target ${P.s.laborTarget}%` });
  k.push({ v: ot ? fmtH(R.otTotal) : "None", cls: ot ? "warn" : "", l: "overtime" });
  return { cls, head, kpis: k };
}

// ---------------------------------------------------------------- suggest and assign
/** Who usually works this weekday (Rippling hours), at their usual clock-in, on the stations they're usually planned on. */
export function suggestCrew(P, E) {
  // Who: everyone on the team who isn't out that day, unless Team's usual days leave the day out (Neal, Oct 13: keep the
  // stations full — history used to leave out people who hadn't worked most recent same weekdays, like new hires).
  // History still gives each person's usual clock-in (same weekday first) and the stations they're usually on.
  const H = P.history || { hours: [], planned: [] }, wd = weekday(P.day);
  const byDay = new Map();
  for (const h of H.hours) { if (!(+h.hours > 0)) continue; (byDay.get(h.day) || byDay.set(h.day, new Map()).get(h.day)).set(h.personId, h); }
  const sameWd = [...byDay.keys()].filter(d => weekday(d) === wd), recent = [...byDay.keys()].filter(d => d >= addDays(P.day, -21));
  const startOf = new Map(), basis = "everyone who isn't out";
  const out2 = calledOut(P), people = P.people.filter(e => !out2.has(e.id) && !(e.days && !e.days.includes(String(wd))));
  for (const e of people) {
    const ins = d => d.map(x => byDay.get(x).get(e.id)).filter(Boolean).map(h => parseTime(h.firstIn)).filter(v => v != null);
    const a = ins(sameWd), b = a.length ? a : ins(recent);
    startOf.set(e.id, b.length ? hhmm(median(b)) : (e.start || P.s.defStart));
  }
  const days = sameWd;
  // how often each person was planned on each station (same weekday counts double)
  const cnt = {};
  for (const p of H.planned) { const w = weekday(p.day) === wd ? 2 : 1; const m = cnt[p.personId] = cnt[p.personId] || { _t: 0 }; m[p.station] = (m[p.station] || 0) + w; m._t += w; }
  const share = (e, st) => { const m = cnt[e.id]; return m && m._t ? (m[st] || 0) / m._t : 0; };
  const r = E.assign(people, { q: P.q, share, startOf: e => notBeforeLate(P, e.id, startOf.get(e.id)) });
  for (const c of Object.values(r.crew)) { c.source = c.emp ? "suggested" : ""; const e = c.emp && P.people.find(x => x.id === c.emp); if (e && e.hours) c.hrs = e.hours; }
  return { crew: r.crew, left: r.left, basis, days: days.length };
}

/** Auto-assign the people checked in the dialog. Keeps each person's hours and stop from the current plan; today, uses Rippling clock-ins. */
export function autoAssign(P, E, ids) {
  const people = P.people.filter(e => ids.includes(e.id));
  const prev = {}; for (const c of Object.values(P.crew)) if (c.emp) prev[c.emp] = c;
  const clock = clockInOf(P);
  const r = E.assign(people, { q: P.q, startOf: e => clock[e.id] || notBeforeLate(P, e.id, (prev[e.id] && prev[e.id].start) || e.start || P.s.defStart) });
  for (const c of Object.values(r.crew)) if (c.emp) { const p = prev[c.emp]; if (p) { c.hrs = p.hrs; c.stop = p.stop; } c.source = clock[c.emp] ? "clock" : "user"; }
  return r;
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
  const { P, R, waves, etas } = X;
  const { price, payAvg, laborTarget, ...s } = P.s;
  const used = onCrew(P);
  return {
    sig: sigOf(P), day: P.day,
    input: { q: P.q, crew: P.crew, stations: P.stations, ops: P.ops, trainingOf: P.trainingOf, settings: { ...s, price: {}, payAvg: 0, laborTarget: 0 },
      people: P.people.filter(p => used.has(p.id)).map(p => ({ id: p.id, name: p.name, trainings: p.trainings, depth: p.depth || null, start: p.start })) },
    waves: waves.map(w => ({ id: w.id, name: w.name, kind: w.kind, deadline: w.deadline, back: w.back ?? null, q: w.q, todo: w.todo, stores: w.stores || [], eta: etas[w.id] ?? null })),
    metrics: R.empty ? { empty: true } : { end: R.end, firstStart: R.firstStart, pieces: R.totalPieces, short: R.P.shortTotal, otH: R.otTotal, laborH: R.labor, people: R.rows.filter(r => r.staffed).length },
  };
}

// ---------------------------------------------------------------- a whole day from saved data (Review's next day, the summary email)
/**
 * Plans a day from what's stored: its saved crew, or a crew suggested from history when nothing is saved yet.
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

// ---------------------------------------------------------------- during the day: suggestions from where things stand now
/**
 * Re-plans the rest of today from now: pieces still left (SMRT), each person's remaining hours from now, Rippling clock-ins.
 * Returns { on, fromNow: {end, left, short}, list: [{ key, cls, title, text, accept, apply?(Q), act? }] }.
 * `apply` changes the plan (Q = { crew }); `act` = { out: personId } marks someone out first. `hidden` = keys already
 * accepted or dismissed today.
 */
/** Which kind of work (dct, dcb, slt, slb, comf, tc) a station's time counts toward; null for assembly and the rest. */
export function catOfStation(E, stn) {
  if (stn === "comf") return E.HAS_COMF ? "comf" : null;
  const t = E.TYPE_OF[stn]; if (!t) return null;
  const k = E.POOL_OF(t); return CATS.includes(k) ? k : null;
}
export function liveSuggestions(X, hidden = new Set()) {
  const { P, E } = X, now = P.now;
  if (!P.isToday || now == null || !P.dp || !P.dp.wavesLeft) return { on: false, why: "Suggestions show on today's plan during the work day." };
  const crewStarts = Object.values(P.crew).filter(c => c.emp).map(c => parseTime(c.start)).filter(v => v != null);
  if (!crewStarts.length) return { on: false, why: "Pick the crew first." };
  if (now < Math.min(...crewStarts) - 0.25) return { on: false, why: `Suggestions start once the first person clocks in (${hm(Math.min(...crewStarts))}).` };
  const D = P.dp.D, clock = clockInOf(P), out = calledOut(P), late = lateOf(P), haveClock = (P.clock || []).length > 0;
  const q2 = Object.fromEntries(CATS.map(k => [k, Math.max(0, (P.q[k] || 0) - (D.done?.[k] || 0))]));
  const leftTotal = CATS.reduce((t, k) => t + q2[k], 0);
  const list = [], add = x => { if (!hidden.has(x.key)) list.push(x); };
  const at5 = h => hhmm(Math.ceil(h * 12) / 12);

  // the crew from now on: remaining hours; people who should be in by now but haven't clocked in are left out
  const crew2 = {}, noShow = [], brks = breaksOf(X.R);
  for (const [code, c] of Object.entries(P.crew)) {
    crew2[code] = { ...c };
    if (!c.emp) continue;
    const start = parseTime(c.start) ?? 7, due = Math.max(start, parseTime(late[c.emp]) ?? 0);
    if (out.has(c.emp)) { crew2[code] = { ...c, emp: "" }; continue; }
    if (haveClock && !clock[c.emp] && now >= due + GRACE_H) { noShow.push({ code, c, due }); crew2[code] = { ...c, emp: "" }; continue; }
    // Rippling decides who's really here: clocked out for good (no open punch for over an hour) = gone;
    // still on the clock after their planned hours = keeps working (re-checked every minute)
    const st = clockState(P, c.emp, now, brks[c.emp]);
    if (haveClock && st === "gone") { crew2[code] = { ...c, emp: "" }; continue; }
    const worked = Math.max(0, now - start); let rem = Math.max(0, (+c.hrs || 0) - worked);
    if (haveClock && st === "in" && rem <= 0.05) rem = 0.5;
    if (rem <= 0.05) { crew2[code] = { ...c, emp: "" }; continue; }
    // on break: no work until they're expected back
    const from = st === "break" ? Math.max(now, lastOutOf(P, c.emp) + Math.max(0.25, (brks[c.emp]?.e ?? 0) - (brks[c.emp]?.s ?? 0) || 0.5)) : Math.max(start, now);
    crew2[code] = { ...c, start: hhmm(Math.min(23.9, from)), hrs: Math.round(rem * 12) / 12 };
  }
  // nobody already on today's crew (finished, not in yet, out) is offered again as "free"
  const notFree = Object.values(P.crew).map(c => c.emp).filter(id => id && !Object.values(crew2).some(c => c.emp === id));
  const P2 = { ...P, crew: crew2, q: q2, waves: P.dp.wavesLeft, callouts: [...(P.callouts || []), ...notFree.map(id => ({ personId: id }))] };
  // what's left has been through the washers once the morning's loads are done (else the re-plan would wash it again)
  const W = X.R && !X.R.empty ? X.R.W : null, washedAll = W && [W.laundryDone, W.tcDone, W.comfDone].every(t => t == null || t <= now);
  const E2 = createEngine({ ...P.s, washOn: P.s.washOn && !washedAll, q: q2, crew: crew2, stations: P.stations, ops: P.ops, people: P.people, trainingOf: P.trainingOf });
  const R2 = leftTotal > 0 ? E2.buildPlan(q2) : { empty: true };
  const waves2 = (P.dp.wavesLeft || []).filter(w => w.todo > 0 && (w.kind === "overdue" || w.deadline == null || w.deadline > now));
  const etas = R2.empty ? {} : waveEtas(R2, waves2, q2, P.s.asmInclude);
  const X2 = { P: P2, E: E2, R: R2 };
  const onCrewNow = new Set(Object.values(crew2).map(c => c.emp).filter(Boolean));

  // 1) planned but not clocked in
  for (const n of noShow) {
    const nm = nameOf(P, n.c.emp);
    add({ key: `noshow:${n.c.emp}`, cls: "b", title: `${nm} hasn't clocked in`, text: `Planned on ${posLabel(E, n.code)} from ${hm(n.due)}. Until they're in, the rest of the day is planned without them.`,
      accept: `Mark ${first(nm)} out today`, act: { out: n.c.emp }, apply: Q => { Q.crew[n.code] = { ...Q.crew[n.code], emp: "", stop: "" }; } });
  }
  // 2) clocked in but not on the plan
  const need = E2.stationNeed(q2);
  for (const [id, t] of Object.entries(clock)) {
    if (onCrewNow.has(id) || out.has(id) || Object.values(P.crew).some(c => c.emp === id)) continue;
    if (clockState(P, id, now, brks[id]) !== "in") continue; // only people on the clock right now (not someone who went home)
    const e = P.people.find(x => x.id === id); if (!e) continue;
    const st = E.POS.filter(p => !P.crew[p.id].emp && E.rankOf(e, p.id)).sort((a, b) => (need[b.id] || 0) - (need[a.id] || 0) || E.rankOf(e, a.id) - E.rankOf(e, b.id))[0];
    add({ key: `unplanned:${id}`, cls: "w", title: `${e.name} clocked in at ${hm(parseTime(t))} but isn't on the plan`,
      text: st ? `${posLabel(E, st.id)} is open and they're trained on it.` : "No open station they're trained on — put them somewhere by hand or send them home.",
      ...(st ? { accept: `Put ${first(e.name)} on ${posLabel(E, st.id)}`, apply: Q => { Q.crew[st.id] = { emp: id, start: t, hrs: P.s.fullDay, stop: "", source: "clock" }; } } : {}) });
  }
  // 3) a deadline that won't make it at the pace planned from here
  let risk = false;
  for (const w of waves2) {
    if (w.kind === "overdue" || w.kind === "route" || w.deadline == null) continue;
    const eta = etas[w.id]; if (eta === undefined) continue;
    const stt = waveState(w, eta); if (!stt.late && !stt.tight) continue;
    risk = risk || !!stt.late;
    // not shown as a suggestion (Neal, Oct 13): the Deadlines card shows each store's status; this only holds back "send home"
  }
  // 4) pieces that won't get done by the end of the shifts: keep the person on the slowest station longer (when overtime is off)
  const short = R2.empty ? 0 : R2.P.shortTotal;
  if (short > 0.5 && !P.s.allowOT) {
    const worst = Object.entries(R2.P.short).filter(([k]) => k !== "asm").sort((a, b) => b[1] - a[1])[0];
    const type = worst && (worst[0] === "tc" && !E.HAS_TC ? "dcb" : worst[0]);
    const row = type && R2.rows.filter(r => r.staffed && E.POOL_OF(r.st.type) === type).sort((a, b) => (a.x.stop ?? 99) - (b.x.stop ?? 99))[0];
    if (row) {
      const extra = Math.min(2, Math.ceil(worst[1] / Math.max(1, (P.s.rates[type === "slt" ? "sltSolo" : type] || 20)) * 4) / 4), id = P.crew[row.st.id].emp;
      add({ key: `longer:${id}`, cls: "w", title: `${fmtN(short)} pieces won't get done by the end of the shifts`, text: `Mostly ${CAT_FULL[worst[0]].toLowerCase()}. Overtime is off in Settings.`,
        accept: `Keep ${first(nameOf(P, id))} ${fmtH(extra)} longer`, apply: Q => { Q.crew[row.st.id] = { ...Q.crew[row.st.id], hrs: Math.min(16, (+Q.crew[row.st.id].hrs || 0) + extra), stop: "", source: "user" }; } });
    }
  }
  // 5) nothing at risk: people who run out of work well before their shift ends can go home
  if (!risk && short <= 0.5 && !R2.empty) {
    // when they run out of work (with "send people home" off in Settings the engine keeps them to the end of the shift)
    const leave = r => Math.max(r.finish ?? now, now + 0.25);
    for (const r of R2.rows.filter(r => r.staffed && r.x.schedEnd - leave(r) >= 0.5).sort((a, b) => leave(a) - leave(b)).slice(0, 3)) {
      const id = P.crew[r.st.id].emp, t = at5(leave(r));
      add({ key: `home:${id}:${t}`, cls: "i", title: `${nameOf(P, id)} runs out of work about ${hm(parseTime(t))}`, text: `${fmtH(r.x.schedEnd - leave(r))} before the end of their shift, with every deadline still on time.`,
        accept: `Send ${first(nameOf(P, id))} home at ${hm(parseTime(t))}`, apply: Q => { Q.crew[r.st.id] = { ...Q.crew[r.st.id], stop: t, source: "user" }; } });
    }
  }
  const order = { b: 0, w: 1, i: 2 };
  list.sort((a, b) => order[a.cls] - order[b.cls]);
  // per kind of work: planned hours so far (today's plan, up to now) and when the re-plan from now finishes it
  const cats = {};
  for (const k of CATS) cats[k] = { hrsSoFar: 0, left: q2[k], etc: null, ot: false, short: R2.empty ? 0 : (R2.P.short[k] || 0) };
  if (X.R && !X.R.empty) for (const rw of X.R.rows) if (rw.staffed) for (const sg of rw.segs) {
    const k = catOfStation(E, sg.stn); if (k && sg.from < now) cats[k].hrsSoFar += Math.min(sg.to, now) - sg.from;
  }
  const pcsH = Object.fromEntries(CATS.map(k => [k, { pcs: 0, h: 0 }]));
  if (!R2.empty) for (const rw of R2.rows) if (rw.staffed) for (const sg of rw.segs) {
    const k = catOfStation(E2, sg.stn); if (!k || !(sg.pcs > 0)) continue;
    cats[k].etc = Math.max(cats[k].etc ?? 0, sg.to); pcsH[k].pcs += sg.pcs; pcsH[k].h += sg.to - sg.from;
    if (sg.to > rw.x.schedEnd + 0.02) cats[k].ot = true;
  }
  // pieces left that nobody in the re-plan works on (e.g. everyone's planned hours are used up): all of it is past the shifts
  for (const k of CATS) { const c = cats[k]; if (c.left > 0.5 && c.etc == null && !(c.short > 0.5)) c.short = c.left; }
  let extraH = 0;
  // more than fits in the shifts: we always finish, so the ETC runs on at the same pace (Neal, Oct 13)
  for (const k of CATS) {
    const c = cats[k]; if (!(c.short > 0.5)) continue;
    const rate = pcsH[k].h > 0 ? pcsH[k].pcs / pcsH[k].h : +(P.s.rates?.[k === "slt" ? "sltSolo" : k]) || 0;
    c.ot = true; if (rate > 0) { c.etc = Math.max(c.etc ?? now, now) + c.short / rate; extraH += c.short / rate; }
  }
  const lastEtc = Math.max(R2.empty ? 0 : R2.end, ...CATS.map(k => cats[k].etc ?? 0));
  return { on: true, list, cats, fromNow: { left: leftTotal, end: R2.empty ? null : R2.end, etc: lastEtc || null, ot: CATS.some(k => cats[k].ot), otH: (R2.empty ? 0 : R2.otTotal || 0) + extraH, short, people: onCrewNow.size, noShow: noShow.length } };
}
const posLabel = (E, code) => (E.POS.find(p => p.id === code) || {}).label || code;

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

/** When each kind of work is finished in a simulated plan (last minute anyone works on it), plus assembly. */
export function catEnds(E, R) {
  const out = {}; if (!R || R.empty) return out;
  for (const rw of R.rows) if (rw.staffed) for (const sg of rw.segs) {
    if (!(sg.pcs > 0)) continue;
    const k = catOfStation(E, sg.stn) || (E.TYPE_OF[sg.stn] === "asm" ? "asm" : null);
    if (k) out[k] = Math.max(out[k] ?? 0, sg.to);
  }
  return out;
}

/** Does work of kind k run past someone's scheduled shift in this plan? */
export function catOvertime(E, R, k) {
  if (!R || R.empty) return false;
  return R.rows.some(rw => rw.staffed && rw.segs.some(sg => sg.pcs > 0 && sg.to > rw.x.schedEnd + 0.02 && (catOfStation(E, sg.stn) || (E.TYPE_OF[sg.stn] === "asm" ? "asm" : null)) === k));
}

/**
 * Move a person to another kind of work from a time (a crew copy comes back; the input isn't changed).
 *  - from their start (or before): they're simply planned on that station, in an empty spot of it when there is one
 *  - later in the day: a move is added (later moves of theirs are replaced) to an empty spot, else the first one
 */
export function applyMove(crew, POS, empId, toKey, at, toCode = null) {
  const C = JSON.parse(JSON.stringify(crew));
  const code = Object.keys(C).find(k => C[k].emp === empId); if (!code) return C;
  const c = C[code], targets = POS.filter(p => groupOf(p.type) === toKey).map(p => p.id);
  if (!targets.length) return C;
  const empty = toCode && targets.includes(toCode) ? toCode : targets.find(t => t !== code && !C[t].emp);
  const startH = parseTime(c.start) ?? 0, atH = parseTime(at) ?? startH;
  if (atH <= startH + 1e-6 && empty && !C[empty].emp) {
    C[empty] = { ...c, moves: [] }; C[code] = { emp: "", start: c.start, hrs: c.hrs, stop: "", source: "" };
    return C;
  }
  if (targets.includes(code) && atH <= startH + 1e-6) { c.moves = []; return C; }
  const keep = (c.moves || []).filter(m => (parseTime(m.at) ?? 0) < atH - 1e-6);
  c.moves = [...keep, { at: hhmm(Math.max(atH, startH)), to: empty || targets[0] }];
  c.source = "user";
  return C;
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

/** Where a person is (which code) at hour t after their moves: the station code they work then. */
export function stationAt(c, code, t) {
  let cur = code;
  for (const m of (c.moves || []).slice().sort((a, b) => a.at.localeCompare(b.at))) if ((parseTime(m.at) ?? 99) <= t + 1e-6) cur = m.to;
  return cur;
}

/**
 * The bottleneck card: starch bottoms when there are any (Neal: the reason for the planner), else whatever finishes last.
 * Today it uses the re-plan from now (L); other days the plan itself.
 */
export function bottleneck(X, L) {
  const { P, E, R } = X;
  if (R.empty) return null;
  const ends = catEnds(E, R), live = P.isToday && L && L.on && L.cats;
  let k = (P.q.slb || 0) > 0.5 ? "slb" : CATS.filter(c => (P.q[c] || 0) > 0.5).sort((a, b) => (ends[b] ?? 0) - (ends[a] ?? 0))[0];
  if (!k) return null;
  const total = P.q[k] || 0, done = live ? Math.max(0, total - L.cats[k].left) : 0, left = live ? L.cats[k].left : total;
  const etc = live ? L.cats[k].etc : ends[k] ?? null, ot = live ? !!L.cats[k].ot : catOvertime(E, R, k);
  // presses on it: people whose own station is this kind of work (now, today), and when their shifts end
  const t0 = P.isToday && P.now != null ? P.now : Math.min(...R.rows.filter(r => r.staffed).map(r => r.x.start));
  const on = R.rows.filter(rw => rw.staffed && groupOf(E.TYPE_OF[stationAt(P.crew[rw.st.id], rw.st.id, t0)]) === k);
  const shiftEnd = on.length ? Math.max(...on.map(r => r.x.schedEnd)) : null;
  const perPress = k === "slt" ? P.s.rates.sltSolo : P.s.rates[k] || 0;
  // the shifts on it are already over (people staying late): no "needed" rate to show
  const hoursLeft = shiftEnd != null && shiftEnd > t0 + 0.1 ? shiftEnd - t0 : null;
  return { k, total, done, left, etc, ot, presses: on.length, perPress, expected: on.length * perPress, shiftEnd,
    needed: hoursLeft && left > 0.5 ? left / hoursLeft : 0 };
}

/**
 * Moves that would finish the bottleneck sooner: someone from another kind of work, trained for it, moved at one of
 * `times` (default: today = now; another day = 9:00, 10:30 and 12:00). Each is tried on the whole plan; kept when the
 * bottleneck finishes at least 10 minutes sooner and the day doesn't end later. Best first, at most `max`.
 */
export function bottleneckMoves(X, L, { max = 2, times } = {}) {
  const { P, E } = X, B = bottleneck(X, L); if (!B || B.left < 0.5) return [];
  const groups = boardGroups(E.POS), target = groups.find(g => g.key === B.k); if (!target) return [];
  const live = P.isToday && P.now != null;
  const ts = times || (live ? [Math.ceil(P.now * 12) / 12] : [9, 10.5, 12]);
  const score = crew => {
    const X2 = evaluate({ ...P, crew });
    if (live) { const L2 = liveSuggestions(X2, new Set()); return L2.on ? { k: L2.cats[B.k].etc ?? 0, end: L2.fromNow.etc ?? 0 } : null; }
    const e = catEnds(X2.E, X2.R); return { k: e[B.k] ?? 0, end: X2.R.end ?? 0 };
  };
  const base = { k: B.etc ?? 0, end: live ? (L.fromNow.etc ?? 0) : (X.R.end ?? 0) };
  const out = [], brks = breaksOf(X.R);
  // a station of that kind nobody is planned on at hour t (people on shift, after their moves; today: not gone home)
  const freeAt = t => {
    const busy = new Set();
    for (const [cd, x] of Object.entries(P.crew)) {
      if (!x.emp) continue;
      const s0 = parseTime(x.start) ?? 0, s1 = parseTime(x.stop) ?? s0 + (+x.hrs || 0) + 0.5;
      if (t < s0 - 1e-6 || t >= s1 - 1e-6) continue;
      if (live && clockState(P, x.emp, P.now, brks[x.emp]) === "gone") continue;
      busy.add(stationAt(x, cd, t));
    }
    return target.codes.find(cd => !busy.has(cd)) || null;
  };
  for (const [code, c] of Object.entries(P.crew)) {
    if (!c.emp || target.codes.includes(code)) continue;
    const type = E.TYPE_OF[code]; if (!type || type === "asm" && false) continue;
    const e = P.people.find(p => p.id === c.emp); if (!e) continue;
    const rk = Math.min(...target.codes.map(t => E.rankOf(e, t) || 99)); if (rk >= 99) continue;
    if (live && clockState(P, c.emp, P.now, brks[c.emp]) === "gone") continue;
    const start = parseTime(c.start) ?? 0, end = start + (+c.hrs || 0) + 0.5;
    for (const t of ts) {
      if (t < start - 1e-6 || t > end - 1) continue;
      if (groupOf(E.TYPE_OF[stationAt(c, code, t)]) === B.k) continue;
      // only onto a press no one is on at that time (Neal, Oct 14: "move Maria to starch bottoms at 9" with both SLB presses staffed)
      const free = freeAt(t); if (!free) continue;
      const crew = applyMove(P.crew, E.POS, c.emp, B.k, hhmm(t), free), sc = score(crew); if (!sc) continue;
      if (sc.k <= base.k - 1 / 6 && sc.end <= base.end + 1 / 12) out.push({ empId: c.emp, name: e.name, from: groupOf(type), at: hhmm(t), rank: rk, k: B.k, kBefore: base.k, kAfter: sc.k, endBefore: base.end, endAfter: sc.end, crew });
    }
  }
  out.sort((a, b) => a.kAfter - b.kAfter || a.endAfter - b.endAfter || a.rank - b.rank);
  const seen = new Set(), best = [];
  for (const m of out) { if (seen.has(m.empId)) continue; seen.add(m.empId); best.push(m); if (best.length >= max) break; }
  return best;
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
