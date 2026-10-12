// The Plan screen's logic, kept apart from the page so it can be tested in Node:
//  - turns settings, the team and the saved plan into the engine's input
//  - pieces to plan (SMRT, plus counts typed over it), deadlines and when each will be ready
//  - "suggest from history", auto-assign, the 40-hour watch
//  - the checks shown before publishing, each with one-click fixes
//  - the verdict line and the snapshot stored when a plan is published
import { createEngine, buildWaves, waveEtas, waveState, stepsOf, CATS, CAT_FULL, CAT_LABEL, parseTime, hhmm, fmtClock, hm, fmtH, fmtN, fmt$, median } from "../engine/engine.js";

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
    washOn: g.wash.on && g.wash.washers > 0, washers: g.wash.washers, washDelay: g.wash.delay,
    washSlt: wash("slt").perLoad || 65, washSlb: wash("slb").perLoad || 25, washComf: wash("comf").perLoad || 2, washTc: wash("tc").perLoad || 10,
    cycSlt: wash("slt").cycleMin || 45, cycSlb: wash("slb").cycleMin || 45, cycComf: wash("comf").cycleMin || 60, cycTc: wash("tc").cycleMin || 40,
    rates: { sltSolo: rate("slt", "slt") || 50, sltPair: rate("slt_helper", "slt") || 80, slb: rate("slb", "slb") || 38, dct: rate("dct", "dct") || 25,
      dcb: rate("dcb", "dcb") || 25, tc: rate("tc", "tc") || rate("dcb", "tc") || 6, asm: asmRate, comf: rate("comf", "comf") || 3 },
    asmInclude: Object.fromEntries(CATS.map(k => [k, !!(SET.categories.find(c => c.id === k) || {}).needsAssembly])),
    stationMax: Object.fromEntries(SET.stations.filter(s => s.maxHours > 0).map(s => [s.code, s.maxHours])),
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
export const peopleFrom = TEAM => TEAM.people.filter(p => p.status === "active").map(p => ({ id: p.id, name: p.name, trainings: p.trainings || [], start: p.usualStart || null, ...(p.rate > 0 ? { rate: p.rate } : {}) }));

export function blankCrew(POS, s) { return Object.fromEntries(POS.map(p => [p.id, { emp: "", start: s.defStart, hrs: s.fullDay, stop: "", source: "" }])); }
export function crewFromServer(serverCrew, POS, s) {
  const crew = blankCrew(POS, s);
  for (const [code, c] of Object.entries(serverCrew || {})) if (crew[code]) crew[code] = { emp: c.personId, start: c.start, hrs: c.hours, stop: c.stop || "", source: c.source || "user" };
  return crew;
}
export function crewToServer(crew) {
  const out = {};
  for (const [code, c] of Object.entries(crew)) if (c.emp) out[code] = { personId: c.emp, start: c.start, hours: +c.hrs || 0, stop: c.stop || "", source: c.source === "suggested" ? "suggested" : c.source === "clock" ? "clock" : "user" };
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
export function evaluate(P) {
  const E = createEngine({ ...P.s, q: P.q, crew: P.crew, stations: P.stations, ops: P.ops, people: P.people, trainingOf: P.trainingOf });
  const R = E.buildPlan(P.q);
  const M = R.empty ? null : E.money(R);
  const waves = (P.waves || []).filter(w => w.todo > 0 || w.kind === "overdue");
  const etas = R.empty ? {} : waveEtas(R, waves, P.q, P.s.asmInclude);
  const states = Object.fromEntries(waves.map(w => { const st = waveState(w, etas[w.id]); st.eta = etas[w.id]; return [w.id, st]; }));
  const X = { P, E, R, M, waves, etas, states };
  X.week = weekWatch(X);
  X.checks = buildChecks(X);
  X.verdict = verdict(X);
  return X;
}

export const nameOf = (P, id) => (P.people.find(p => p.id === id) || {}).name || "Someone";
const whoAt = (P, code) => nameOf(P, (P.crew[code] || {}).emp);
const onCrew = P => new Set(Object.values(P.crew).map(c => c.emp).filter(Boolean));
const calledOut = P => new Set((P.callouts || []).map(c => c.personId));
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
  if (!cats.length || !R.TL) return null;
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
  for (const w of waves) {
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
  const W = waves.filter(w => w.todo > 0 && w.kind !== "overdue" && live(X, w) && !(P.isToday && w.leftTodo === 0));
  const late = W.filter(w => states[w.id].late), tight = W.filter(w => states[w.id].tight);
  const short = R.P.shortTotal > 0.5, ot = R.otTotal > 0.04;
  let cls = "ok", head = "This plan works";
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
  const H = P.history || { hours: [], planned: [] }, wd = weekday(P.day);
  const byDay = new Map();
  for (const h of H.hours) { if (!(+h.hours > 0)) continue; (byDay.get(h.day) || byDay.set(h.day, new Map()).get(h.day)).set(h.personId, h); }
  let days = [...byDay.keys()].filter(d => weekday(d) === wd), basis = `recent ${WD[wd]}s`;
  if (days.length < 2) { const from = addDays(P.day, -14); days = [...byDay.keys()].filter(d => d >= from); basis = "the last two weeks"; }
  const sameWd = [...byDay.keys()].filter(d => weekday(d) === wd);
  const out = [], startOf = new Map();
  if (days.length) for (const e of P.people) {
    const hits = days.filter(d => byDay.get(d).has(e.id));
    if (hits.length / days.length < 0.5) continue;
    const ins = (sameWd.some(d => byDay.get(d).has(e.id)) ? sameWd : hits).map(d => byDay.get(d).get(e.id)).filter(Boolean).map(h => parseTime(h.firstIn)).filter(v => v != null);
    out.push(e); startOf.set(e.id, ins.length ? hhmm(median(ins)) : (e.start || P.s.defStart));
  }
  if (!out.length) {
    const lastDay = H.planned.map(p => p.day).sort().pop();
    const ids = lastDay ? new Set(H.planned.filter(p => p.day === lastDay).map(p => p.personId)) : null;
    for (const e of P.people) if (!ids || ids.has(e.id)) { out.push(e); startOf.set(e.id, e.start || P.s.defStart); }
    basis = lastDay ? `the plan for ${new Date(lastDay + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}` : "the whole team";
  }
  const out2 = calledOut(P), people = out.filter(e => !out2.has(e.id));
  // how often each person was planned on each station (same weekday counts double)
  const cnt = {};
  for (const p of H.planned) { const w = weekday(p.day) === wd ? 2 : 1; const m = cnt[p.personId] = cnt[p.personId] || { _t: 0 }; m[p.station] = (m[p.station] || 0) + w; m._t += w; }
  const share = (e, st) => { const m = cnt[e.id]; return m && m._t ? (m[st] || 0) / m._t : 0; };
  const r = E.assign(people, { q: P.q, share, startOf: e => startOf.get(e.id) });
  for (const c of Object.values(r.crew)) { c.source = c.emp ? "suggested" : ""; }
  return { crew: r.crew, left: r.left, basis, days: days.length };
}

/** Auto-assign the people checked in the dialog. Keeps each person's hours and stop from the current plan; today, uses Rippling clock-ins. */
export function autoAssign(P, E, ids) {
  const people = P.people.filter(e => ids.includes(e.id));
  const prev = {}; for (const c of Object.values(P.crew)) if (c.emp) prev[c.emp] = c;
  const clock = clockInOf(P);
  const r = E.assign(people, { q: P.q, startOf: e => clock[e.id] || (prev[e.id] && prev[e.id].start) || e.start || P.s.defStart });
  for (const c of Object.values(r.crew)) if (c.emp) { const p = prev[c.emp]; if (p) { c.hrs = p.hrs; c.stop = p.stop; } c.source = clock[c.emp] ? "clock" : "user"; }
  return r;
}
/** Today's first clock-in per person (HH:MM, local), from Rippling. */
export function clockInOf(P) {
  const out = {};
  if (!P.isToday) return out;
  for (const c of P.clock || []) { const t = String(c.clockIn).slice(11, 16); if (!out[c.personId] || t < out[c.personId]) out[c.personId] = t; }
  return out;
}

// ---------------------------------------------------------------- publishing
export function sigOf(P) {
  const crew = Object.entries(P.crew).filter(([, c]) => c.emp).sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => [k, c.emp, c.start, +c.hrs, c.stop || ""]);
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
      people: P.people.filter(p => used.has(p.id)).map(p => ({ id: p.id, name: p.name, trainings: p.trainings, start: p.start })) },
    waves: waves.map(w => ({ id: w.id, name: w.name, kind: w.kind, deadline: w.deadline, back: w.back ?? null, q: w.q, todo: w.todo, stores: w.stores || [], eta: etas[w.id] ?? null })),
    metrics: R.empty ? { empty: true } : { end: R.end, firstStart: R.firstStart, pieces: R.totalPieces, short: R.P.shortTotal, otH: R.otTotal, laborH: R.labor, people: R.rows.filter(r => r.staffed).length },
  };
}

// ---------------------------------------------------------------- a whole day from saved data (Review's next day, the summary email)
/**
 * Plans a day from what's stored: its saved crew, or a crew suggested from history when nothing is saved yet.
 * V = pieces view that includes `day`; plan = GET /api/plan/:day. Returns null when there are no pieces for the day.
 */
export function projectDay({ SET, TEAM, V, plan, day, admin = false }) {
  const s = engineSettings(SET, V.prices || {}), pos = positions(SET), POS = pos.stations.concat(pos.ops);
  const dp = dayPieces(V, SET, day); if (!dp) return null;
  const overrides = plan.overrides || {};
  const P = { s, ...pos, people: peopleFrom(TEAM), crew: crewFromServer(plan.crew, POS, s), q: effectiveQ(dp.base, overrides), waves: dp.waves, day, today: V.today,
    isToday: dp.isToday, now: null, callouts: plan.callouts || [], history: plan.history || { hours: [], planned: [] }, clock: [], published: plan.published || null, admin,
    expected: dp.expected && !Object.keys(overrides).length, dp };
  let basis = plan.published ? "the published plan" : "the plan saved for that day", suggested = false;
  if (!Object.keys(plan.crew || {}).length) { const r = suggestCrew(P, evaluate(P).E); P.crew = r.crew; basis = `suggested from ${r.basis}`; suggested = true; }
  const X = evaluate(P);
  const crew = POS.filter(p => P.crew[p.id].emp).map(p => ({ code: p.id, station: p.label, name: nameOf(P, P.crew[p.id].emp), start: P.crew[p.id].start, hours: +P.crew[p.id].hrs || 0 }));
  const pieces = CATS.reduce((t, k) => t + (P.q[k] || 0), 0);
  return { X, P, basis, suggested, crew, pieces, q: P.q, expected: P.expected, known: dp.D.todo,
    end: X.R.empty ? null : X.R.end, laborH: X.M ? X.M.regH + X.M.otH + X.M.opsH : 0, cost: X.M ? X.M.total : null, pct: X.M ? X.M.pct : null,
    otH: X.R.empty ? 0 : X.R.otTotal, short: X.R.empty ? 0 : X.R.P.shortTotal, verdict: X.verdict };
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
