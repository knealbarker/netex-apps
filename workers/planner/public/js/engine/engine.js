// The planning engine, ported from the desktop planner 1.9.0 with the same rules and numbers.
// Pure functions, no page access: runs in the browser and in Node (tests compare it with the desktop code).
//
// createEngine(S) takes one plain object describing the day:
//   q          {dct, dcb, slt, slb, comf, tc}      pieces to plan
//   crew       {stationCode: {emp, start, hrs, stop}}   emp = person id or ""
//   stations   [{id, type, label}]  production stations; type is slt | slt2 | slb | dct | dcb | asm | comf | tc
//   ops        [{id, label}]        operator positions (slo, dco)
//   people     [{id, name, trainings: [trainingId, ...] (in priority order), start}]
//   trainingOf {stationCode: trainingId}
//   settings (flat, desktop names): defStart, fullDay, breakMin, breakAfter, spread, staggerBreaks, allowOT, otMax, otMult,
//     allowMoves, allowClockOut, minPaid, washOn, washers, washDelay, washSlt, washSlb, washComf, washTc, cycSlt, cycSlb, cycComf, cycTc,
//     rates {sltSolo, sltPair, slb, dct, dcb, tc, asm, comf}, asmInclude {cat: bool}, stationMax {code: hours}, price {cat: $}, payAvg, laborTarget
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
export const median = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor((b.length - 1) / 2)]; };

// Hungarian algorithm (min cost) for an n x n matrix
export function hungarian(cost) {
  const n = cost.length, INF = 1e15, u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = Array(n + 1).fill(INF), used = Array(n + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) { const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]; if (cur < minv[j]) { minv[j] = cur; way[j] = j0; } if (minv[j] < delta) { delta = minv[j]; j1 = j; } }
      for (let j = 0; j <= n; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = Array(n).fill(-1); for (let j = 1; j <= n; j++) if (p[j]) res[p[j] - 1] = j - 1; return res;
}

export function createEngine(S) {
  const STATIONS = S.stations, OPS = S.ops || [], POS = STATIONS.concat(OPS);
  const peopleById = new Map((S.people || []).map(p => [p.id, p]));
  const empById = id => peopleById.get(id) || null;
  // rank = position in the person's ordered training list (1 = first choice), 0 = not trained
  // (S.rankOf can replace this, e.g. to replay the desktop's per-station ranks in the parity tests)
  const rankOf = S.rankOf || ((e, stId) => { if (!e || !e.trainings) return 0; const t = S.trainingOf[stId]; const i = t ? e.trainings.indexOf(t) : -1; return i < 0 ? 0 : i + 1; });
  const trained = (empId, stId) => rankOf(empById(empId), stId) > 0;
  const TYPE_OF = Object.fromEntries(STATIONS.map(x => [x.id, x.type]));
  const POOL_OF = t => (t === "slt2" ? "slt" : t);
  // Comforters and Tablecloths as stations of their own (only trained people work them). Without those stations the
  // desktop rules apply: comforters are done by anyone free, tablecloths on the DCB press.
  const HAS_COMF = STATIONS.some(x => x.type === "comf"), HAS_TC = STATIONS.some(x => x.type === "tc");
  const s = S;

  // Washer schedule: starch laundry first (SLT and SLB loads interleaved so both lines stay fed),
  // then tablecloths, then comforters, each load on whichever washer frees up first.
  function washPlan(q) {
    if (!s.washOn) return null;
    const hasLo = POS.some(p => p.id === "slo");
    const lo = hasLo ? crewTimes("slo") : { a: 0 }, staffedLo = hasLo && !!(s.crew.slo || {}).emp && lo.a > 0;
    let first = Infinity; for (const p of POS) { if ((s.crew[p.id] || {}).emp) { const c = crewTimes(p.id); if (c.a > 0) first = Math.min(first, c.start); } }
    const start = (staffedLo ? lo.start : (isFinite(first) ? first : 7)) + s.washDelay / 60;
    const mk = (type, total, per) => { const L = []; let left = total; if (!(per > 0)) return L; while (left > 0) { L.push({ type, n: Math.min(per, left) }); left -= per; } return L; };
    const T = mk("slt", q.slt, s.washSlt), B = mk("slb", q.slb, s.washSlb), seq = [];
    let i = 0, j = 0; while (i < T.length || j < B.length) { if (j >= B.length || (i < T.length && i / T.length <= j / B.length)) seq.push(T[i++]); else seq.push(B[j++]); }
    seq.push(...mk("tc", q.tc, s.washTc), ...mk("comf", q.comf, s.washComf));
    const cyc = { slt: s.cycSlt, slb: s.cycSlb, tc: s.cycTc, comf: s.cycComf };
    const free = Array.from({ length: Math.max(1, Math.round(s.washers)) }, () => start), loads = [];
    for (const L of seq) {
      let w = 0; for (let k = 1; k < free.length; k++) if (free[k] < free[w] - 1e-9) w = k;
      const from = free[w], to = from + cyc[L.type] / 60; free[w] = to; loads.push({ ...L, w: w + 1, from, to });
    }
    const lastOf = ty => { const l = loads.filter(x => ty.includes(x.type)); return l.length ? Math.max(...l.map(x => x.to)) : null; };
    return { start, staffedLo, loads, laundryDone: lastOf(["slt", "slb"]), tcDone: lastOf(["tc"]), comfDone: lastOf(["comf"]),
      ready: (ty, t) => { let n = 0; for (const x of loads) if (x.type === ty && x.to <= t + 1e-9) n += x.n; return n; } };
  }
  // clock-in, working hours (after any hard stop) and hard stop for one position
  function crewTimes(id) {
    const c = s.crew[id] || {}; const start = parseTime(c.start) ?? parseTime(s.defStart) ?? 7;
    let a = c.emp ? Math.max(0, +c.hrs || 0) : 0; const stop = parseTime(c.stop);
    if (stop != null && stop > start) { const el = stop - start, b = s.breakMin / 60; const fit = el - b > s.breakAfter + EPS ? el - b : (el > s.breakAfter + EPS ? Math.min(el, s.breakAfter) : el); a = Math.min(a, Math.max(0, fit)); }
    return { start, a, stop: (stop != null && stop > start) ? stop : null };
  }
  // Stagger paid breaks so stations keep running: each break goes in the slot (at least 2h after clock-in and 2h before
  // scheduled out) that the fewest co-workers are using, especially people on the same kind of station.
  function breakPlan() {
    const ppl = [];
    for (const p of POS) {
      const c = s.crew[p.id] || {}; if (!c.emp) continue; const { start, a } = crewTimes(p.id); if (!(a > s.breakAfter + EPS)) continue;
      const b = s.breakMin / 60; if (b <= 0) continue;
      const ty = p.type === "slt2" ? "slt" : p.type || "ops"; ppl.push({ id: p.id, start, a, b, ty, mid: start + a / 2 });
    }
    const out = {};
    if (!s.staggerBreaks) { for (const x of ppl) out[x.id] = x.mid; return out; }
    const step = 0.25;
    for (const x of ppl) { x.lo = x.start + Math.min(2, x.a / 2); x.hi = Math.max(x.lo, x.start + x.a - Math.min(2, x.a / 2)); }
    ppl.sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo) || a.mid - b.mid);
    const done = [];
    for (const x of ppl) {
      let best = x.mid, bc = Infinity;
      for (let t = Math.ceil(x.lo / step) * step; t <= x.hi + 1e-9; t += step) {
        let c = 0;
        for (const d of done) { const ov = Math.max(0, Math.min(t + x.b, d.t + d.b) - Math.max(t, d.t)); if (ov > EPS) c += (d.ty === x.ty ? 4 : 1) * ov / x.b; }
        c += Math.abs(t + x.b / 2 - x.mid) * 0.05;
        if (c < bc - 1e-9) { bc = c; best = t; }
      }
      out[x.id] = best; done.push({ t: best, b: x.b, ty: x.ty });
    }
    return out;
  }
  function stationInfo() {
    const out = {}, BP = breakPlan();
    for (const st of STATIONS) {
      const { start, a, stop } = crewTimes(st.id);
      const b = a > s.breakAfter + EPS ? s.breakMin / 60 : 0;
      let ot = (s.allowOT && a >= s.fullDay - EPS) ? s.otMax : 0;
      if (stop != null) ot = Math.max(0, Math.min(ot, stop - (start + b + a)));
      out[st.id] = { ...st, a, start, b, ot, stop, off: start + b, schedEnd: start + b + a, brkS: b > 0 ? (BP[st.id] ?? start + a / 2) : null };
    }
    return out;
  }

  // Minute-by-minute simulation of the day. Everyone starts on their assigned station. When a station type has no work
  // left, its person moves to the busiest station they're trained on that's free (or comforters). When nothing they can
  // do is left, they clock out.
  //  - Regular time before overtime (Neal, Oct 13): people still in their regular hours pick work first; someone already
  //    in overtime only keeps working what no one on regular time can take over.
  //  - Tablecloths are pressed on any DCT or DCB press nobody is using, so several trained people can do them at once
  //    (as many as there are open presses). Comforters are folded on one table: up to s.comfMax people, each extra
  //    person adding s.comfExtra (a share of one person's speed).
  function simulate(q) {
    const I = stationInfo(), r = s.rates, dt = 1 / 60;
    const A = CATS.reduce((t, k) => t + (s.asmInclude[k] ? (q[k] || 0) : 0), 0);
    const pool = { slt: q.slt, slb: q.slb, dct: q.dct, dcb: q.dcb, tc: q.tc, asm: A, comf: q.comf };
    const init = { ...pool };
    const perHr = { slt: r.sltSolo, slb: r.slb, dct: r.dct, dcb: r.dcb, tc: r.tc, asm: r.asm, comf: r.comf };
    const WP = washPlan(q), WASHED = { slt: 1, slb: 1, tc: 1, comf: 1 };
    let tNow = 0;
    const avl = k => (WP && WASHED[k]) ? Math.max(0, Math.min(pool[k], WP.ready(k, tNow) - (init[k] - pool[k]))) : pool[k];
    const emps = STATIONS.filter(st => I[st.id].a > EPS).map(st => {
      const x = I[st.id]; const brkS = x.b > 0 ? x.brkS : null;
      // a manager's moves: from each move's time the person works the station they were moved to (Neal, Oct 13)
      const moves = (s.crew[st.id].moves || []).map(m => ({ at: parseTime(m.at), to: m.to })).filter(m => m.at != null && TYPE_OF[m.to]).sort((a, b) => a.at - b.at);
      return { pos: st.id, pos0: st.id, home: st.id, empId: s.crew[st.id].emp, x, brkS, brkE: brkS != null ? brkS + x.b : null, segs: [], work: {}, pcs: {}, last: null, otUsed: 0, rotated: false, moves, mv: -1 };
    });
    if (!emps.length) return null;
    const mx = id => { const v = +((s.stationMax || {})[id]); return v > 0 ? v : Infinity; };
    const under = (e, id) => (e.work[id] || 0) < mx(id) - 1e-6;
    const qual = (e, stId) => e.pos === stId || trained(e.empId, stId);
    const can = (e, stId) => e.pos === stId || ((s.allowMoves || e.rotated) && trained(e.empId, stId));
    const avail = (e, t) => {
      const x = e.x; if (t < x.start - EPS) return false;
      if (e.brkS != null && t >= e.brkS - EPS && t < e.brkE - EPS) return false;
      if (t < x.schedEnd - EPS) return true;
      return x.ot > 0 && t < x.schedEnd + x.ot - EPS;
    };
    // tablecloths and comforters take more than one person; the rest are one person per station
    const PRESSES = STATIONS.filter(x => x.type === "dct" || x.type === "dcb").map(x => x.id);
    const COMF_MAX = Math.max(1, Math.round(+s.comfMax || 2)), COMF_EXTRA = Math.max(0, +(s.comfExtra ?? 0.2));
    const multi = id => (HAS_TC && TYPE_OF[id] === "tc") || (HAS_COMF && TYPE_OF[id] === "comf");
    const has = t => { const k = POOL_OF(t); return k === "dcb" && !HAS_TC ? (avl("dcb") > 1e-4 || avl("tc") > 1e-4) : avl(k) > 1e-4; };
    const remH = t => { const k = POOL_OF(t); return k === "slt" ? pool.slt / r.sltSolo : k === "dcb" ? pool.dcb / r.dcb + (HAS_TC ? 0 : pool.tc / r.tc) : pool[k] / perHr[k]; };
    const tStart = Math.min(...emps.map(e => e.x.start)), tMax = Math.max(...emps.map(e => e.x.schedEnd + e.x.ot)) + dt;
    let t = tStart;
    const done = k => init[k] - pool[k];
    const TL = [[tStart, 0, 0, 0, 0, 0, 0, 0]]; // [time, slt, slb, dct, dcb, tc, comf, asm] finished so far
    const record = (e, stn, frac, pcs) => {
      const from = t, to = t + dt * frac;
      const last = e.segs[e.segs.length - 1];
      if (last && last.stn === stn && Math.abs(last.to - from) < 1e-6) { last.to = to; last.pcs += pcs; } else e.segs.push({ stn, from, to, pcs });
      e.work[stn] = (e.work[stn] || 0) + dt * frac; e.pcs[stn] = (e.pcs[stn] || 0) + pcs; e.last = to;
      if (t >= e.x.schedEnd - EPS) e.otUsed += dt * frac;
    };
    while (t < tMax) {
      const left = Object.keys(pool).some(k => pool[k] > 1e-4);
      if (!left) break;
      tNow = t;
      for (const e of emps) {
        if (!e.moves.length) continue;
        let i = -1; for (let j = 0; j < e.moves.length; j++) if (e.moves[j].at <= t + EPS) i = j;
        if (i !== e.mv && i >= 0) { e.mv = i; e.pos = e.moves[i].to; e.home = e.pos; e.swapped = false; }
      }
      const occ = {}, asg = new Map(), many = {};   // many: how many people are on tablecloths / comforters this minute
      const avAll = emps.filter(e => avail(e, t));
      if (!avAll.length) { t += dt; continue; }
      // a press is free when no one is on it and it isn't being used for tablecloths
      const pressFree = () => PRESSES.filter(id => !occ[id]).length - (many.tc || 0) > 0;
      const room = id => {
        const ty = TYPE_OF[id];
        if (multi(id)) return ty === "tc" ? pressFree() : (many.comf || 0) < COMF_MAX;
        if (occ[id]) return false;
        return !(HAS_TC && (ty === "dct" || ty === "dcb")) || pressFree();
      };
      const take = (e, id) => { if (multi(id)) many[TYPE_OF[id]] = (many[TYPE_OF[id]] || 0) + 1; else occ[id] = e; asg.set(e, id); };
      const okAt = (e, id) => room(id) && can(e, id) && under(e, id) && has(TYPE_OF[id]) && (TYPE_OF[id] !== "slt2" || occ.slt1);
      const inOT = e => t >= e.x.schedEnd - EPS;
      const reg = avAll.filter(e => !inOT(e)), late = avAll.filter(inOT);
      // 1) everyone on regular time stays on their current station (station owners first, then tablecloths/comforters,
      //    the helper station last)
      const order = (a, b) => ((a.pos === "slt2") - (b.pos === "slt2")) || (multi(a.pos) - multi(b.pos)) || ((a.home === "slt2") - (b.home === "slt2"));
      reg.sort(order);
      for (const e of reg) { if (!e.swapped && okAt(e, e.pos)) { take(e, e.pos); e.home = e.pos; } }
      for (const e of reg.slice().sort((a, b) => ((a.home === "slt2") - (b.home === "slt2")) || (multi(a.home || "") - multi(b.home || "")))) { if (asg.has(e)) continue; const h = e.home; if (h && okAt(e, h)) take(e, h); }
      const av = reg;
      // 2) rotation: someone who reached a station's max hours swaps with a qualified co-worker
      for (const e of av) {
        if (asg.has(e)) continue; const X = e.home;
        if (!X || !has(TYPE_OF[X]) || under(e, X)) continue;
        e.rotated = true;
        if (occ[X] || multi(X)) { e.home = null; continue; }
        let swap = null;
        for (const [f, Y] of asg) {
          if (f === e || Y === X || (Y === "comf" && !HAS_COMF)) continue;
          if (qual(f, X) && under(f, X) && qual(e, Y) && under(e, Y) && (TYPE_OF[X] !== "slt2" || occ.slt1)) { swap = [f, Y]; break; }
        }
        if (swap) { const [f, Y] = swap; occ[X] = f; asg.set(f, X); f.home = X; f.rotated = true; f.swapped = true; if (multi(Y)) asg.set(e, Y); else { occ[Y] = e; asg.set(e, Y); } e.home = Y; }
        else e.home = null;
      }
      // 3) anyone free moves to the busiest open station they're qualified for: first those on regular time, then those
      //    already in overtime (who keep their own station when it's still open)
      const pick = (e, allowHelper) => {
        let best = null, bs = -1;
        for (const st of STATIONS) {
          if (!room(st.id) || !can(e, st.id) || !under(e, st.id) || !has(st.type)) continue;
          if (st.type === "slt2" && (!allowHelper || !occ.slt1)) continue;
          const busy = multi(st.id) ? (many[st.type] || 0) : STATIONS.filter(x => POOL_OF(x.type) === POOL_OF(st.type) && occ[x.id]).length;
          const rkx = rankOf(empById(e.empId), st.id), sc = remH(st.type) / (busy + 1) * (rkx === 2 ? 0.9 : rkx >= 3 ? 0.8 : 1);
          if (sc > bs) { bs = sc; best = st.id; }
        }
        return best;
      };
      let free = av.filter(e => !asg.has(e));
      for (const e of free) { const p = pick(e, false); if (p) { take(e, p); e.home = p; } }
      for (const e of free) { if (asg.has(e)) continue; const p = pick(e, true); if (p) { take(e, p); e.home = p; } }
      // overtime only for work the people on regular time can't finish in the regular hours they have left
      const regCap = k => { let h = 0; for (const [f, id] of asg) if (!inOT(f) && POOL_OF(TYPE_OF[id] || id) === k) h += Math.max(0, f.x.schedEnd - t) * (k === "slt" ? r.sltSolo : perHr[k]); return h; };
      const needOT = id => { const k = id === "comf" ? "comf" : POOL_OF(TYPE_OF[id]); return pool[k] > regCap(k) + 1e-4; };
      const okLate = (e, id) => okAt(e, id) && needOT(id);
      late.sort(order);
      for (const e of late) { if (!e.swapped && okLate(e, e.pos)) take(e, e.pos); else if (e.home && okLate(e, e.home)) take(e, e.home); }
      for (const e of late) {
        if (asg.has(e)) continue;
        let p = pick(e, false) || pick(e, true);
        if (p && !needOT(p)) p = null;
        if (p) { take(e, p); e.home = p; }
      }
      free = avAll.filter(e => !asg.has(e));
      // 4) comforters for anyone still free
      if (!HAS_COMF) for (const e of free) { if (!asg.has(e) && avl("comf") > 1e-4) asg.set(e, "comf"); }
      // produce
      const byPool = {};
      const nComf = HAS_COMF ? [...asg.values()].filter(x => TYPE_OF[x] === "comf").length : 0;
      const comfEach = nComf > 1 ? (1 + COMF_EXTRA * (nComf - 1)) / nComf : 1;   // two at the table: each at 60% with +20%
      for (const [e, stn] of asg) {
        let ty = stn === "comf" ? "comf" : POOL_OF(TYPE_OF[stn]); if (ty === "dcb" && !HAS_TC && avl("dcb") <= 1e-4) ty = "tc";
        const out = stn === "comf" ? r.comf * dt * (HAS_COMF && TYPE_OF.comf === "comf" ? comfEach : 1) : (stn === "slt1" ? r.sltSolo * dt : stn === "slt2" ? (r.sltPair - r.sltSolo) * dt : perHr[ty] * dt);
        (byPool[ty] = byPool[ty] || []).push({ e, stn, out });
      }
      for (const k in byPool) {
        const list = byPool[k], tot = list.reduce((a, x) => a + x.out, 0); const f = Math.min(1, avl(k) / tot);
        for (const x of list) record(x.e, x.stn, f, x.out * f);
        pool[k] = Math.max(0, pool[k] - tot * f);
      }
      t += dt;
      if (Math.round(t * 60) % 5 === 0) TL.push([t, done("slt"), done("slb"), done("dct"), done("dcb"), done("tc"), done("comf"), done("asm")]);
    }
    TL.push([t, done("slt"), done("slb"), done("dct"), done("dcb"), done("tc"), done("comf"), done("asm")]);
    return { I, emps, pool, init, A, WP, TL };
  }

  function buildPlan(q) {
    const I = stationInfo();
    const staffed = Object.values(I).filter(x => x.a > EPS);
    const totalPieces = q.dct + q.dcb + q.slt + q.slb + q.comf + q.tc;
    if (totalPieces <= 0 || !staffed.length) return { empty: true, I, noCrew: !staffed.length && totalPieces > 0 };
    const sim = simulate(q);
    const short = { slt: sim.pool.slt, slb: sim.pool.slb, dct: sim.pool.dct, dcb: sim.pool.dcb, tc: sim.pool.tc, comf: sim.pool.comf, asm: sim.pool.asm };
    for (const k in short) if (short[k] < 0.5) short[k] = 0;
    const shortTotal = CATS.reduce((a, k) => a + short[k], 0);
    const firstStart = Math.min(...staffed.map(x => x.start));
    const byPos = Object.fromEntries(sim.emps.map(e => [e.pos0, e]));
    const rows = STATIONS.map(st => {
      const x = I[st.id], e = byPos[st.id];
      if (!e) return { st, x, staffed: false, segs: [], tasks: [], work: 0, comf: 0, active: 0, finish: null, clockOut: null, ot: 0, idle: 0, regPaid: 0, early: 0, moved: false };
      const work = Object.entries(e.work).filter(([k]) => HAS_COMF || k !== "comf").reduce((a, [, v]) => a + v, 0), comf = HAS_COMF ? 0 : e.work.comf || 0;
      const last = e.last;
      let out;
      if (last == null) out = s.allowClockOut ? Math.min(x.schedEnd, x.start + s.minPaid) : x.schedEnd;
      else if (last >= x.schedEnd - EPS) out = last;
      else if (s.allowClockOut) { let minEnd = x.start + s.minPaid; if (e.brkS != null && minEnd > e.brkS) minEnd += x.b; out = Math.max(last, Math.min(x.schedEnd, minEnd)); }
      else out = x.schedEnd;
      const brkTaken = last == null ? 0 : (e.brkS != null && out > e.brkS + EPS ? Math.min(x.b, out - e.brkS) : 0);
      const paid = out - x.start, ot = Math.max(0, out - x.schedEnd), regPaid = paid - ot;
      const idle = Math.max(0, paid - work - comf - brkTaken);
      const tasks = [], cum = {};
      for (const sg of e.segs) {
        const lt = tasks[tasks.length - 1];
        if (lt && lt.stn === sg.stn) { lt.hours += sg.to - sg.from; lt.pcs += sg.pcs; lt.to = sg.to; }
        else {
          const tk = { stn: sg.stn, from: sg.from, to: sg.to, hours: sg.to - sg.from, pcs: sg.pcs };
          if (lt && lt.stn !== "comf") { const v = +((s.stationMax || {})[lt.stn]); if (v > 0 && (cum[lt.stn] || 0) >= v - 0.02) tk.rotFrom = lt.stn; }
          tasks.push(tk);
        }
        cum[sg.stn] = (cum[sg.stn] || 0) + (sg.to - sg.from);
      }
      const moved = tasks.some(tk => tk.stn !== st.id && (HAS_COMF || tk.stn !== "comf"));
      return { st, x, staffed: true, emp: e, segs: e.segs, brkS: e.brkS, brkE: e.brkE, brkTaken, tasks, work, comf, active: work + comf, finish: last, clockOut: out, ot, idle, regPaid, paid, early: Math.max(0, x.schedEnd - out), moved };
    });
    const st2 = rows.filter(r => r.staffed);
    const end = Math.max(firstStart, ...st2.map(r => r.finish ?? r.x.start));
    st2.forEach(r => { r.gap = Math.max(0, Math.min(r.x.schedEnd, end) - (r.finish ?? r.x.start)); });
    const spread = st2.length ? Math.max(...st2.map(r => r.gap)) : 0;
    const done = totalPieces - shortTotal;
    const labor = st2.reduce((a, r) => a + r.active, 0);
    const otTotal = st2.reduce((a, r) => a + r.ot, 0);
    const cover = {}; for (const st of STATIONS) cover[st.id] = [];
    for (const rw of st2) for (const tk of rw.tasks) if (cover[tk.stn]) cover[tk.stn].push({ row: rw, hours: tk.hours, pcs: tk.pcs, from: tk.from });
    return { P: { short, shortTotal, A: sim.A }, I, rows, end, firstStart, spread, done, labor, otTotal, totalPieces, staffedN: staffed.length, cover, W: sim.WP, TL: sim.TL };
  }

  const payRate = posId => { const e = empById((s.crew[posId] || {}).emp); return (e && +e.rate > 0) ? +e.rate : s.payAvg; };
  function opsInfo() {
    const BP = breakPlan();
    return OPS.map(o => {
      const c = s.crew[o.id] || {}; const ct = crewTimes(o.id); const on = !!c.emp && ct.a > 0; const hrs = on ? ct.a : 0;
      const start = ct.start; const b = hrs > s.breakAfter + EPS ? s.breakMin / 60 : 0;
      return { o, on, hrs, start, b, end: start + hrs + b, brkS: b ? (BP[o.id] ?? start + hrs / 2) : null };
    });
  }
  function money(R) {
    const revCat = {}; let revenue = 0, committed = 0;
    for (const k of CATS) { const d = Math.max(0, (s.q[k] || 0) - (R && R.P ? (R.P.short[k] || 0) : 0)); revCat[k] = { done: d, rev: d * (s.price[k] || 0) }; revenue += revCat[k].rev; committed += (s.q[k] || 0) * (s.price[k] || 0); }
    let regH = 0, regC = 0, otH = 0, otC = 0, opsH = 0, opsC = 0, idleH = 0, idleC = 0;
    if (R && R.rows) for (const r of R.rows) {
      if (!r.staffed) continue; const rate = payRate(r.st.id);
      regH += r.regPaid; regC += r.regPaid * rate; otH += r.ot; otC += r.ot * rate * s.otMult; idleH += r.idle; idleC += r.idle * rate;
    }
    for (const x of opsInfo()) if (x.on) { const rate = payRate(x.o.id), paid = x.hrs + x.b; opsH += paid; opsC += paid * rate; }
    const total = regC + otC + opsC, pct = revenue > 0 ? total / revenue * 100 : null;
    const budget = revenue * s.laborTarget / 100;
    return { revCat, revenue, committed, regH, regC, otH, otC, opsH, opsC, idleH, idleC, total, pct, budget, pctIfHome: revenue > 0 ? (total - idleC) / revenue * 100 : null };
  }
  // how much each station is needed (hours of work it would carry)
  function stationNeed(q = s.q) {
    const r = s.rates, day = s.fullDay || 7.5, need = {};
    const spread = (type, hours) => { let left = hours; STATIONS.filter(x => x.type === type).forEach(x => { need[x.id] = Math.max(0, Math.min(day, left)); left -= day; }); };
    const sltH = q.slt / r.sltSolo;
    for (const st of STATIONS) if (st.type === "slt") need[st.id] = Math.min(day, sltH);
    for (const st of STATIONS) if (st.type === "slt2") need[st.id] = q.slt > 0 ? Math.max(0.5, Math.min(day, (q.slt - r.sltSolo * day) / (r.sltPair - r.sltSolo))) : 0;
    spread("slb", q.slb / r.slb); spread("dct", q.dct / r.dct);
    for (const st of STATIONS) if (st.type === "dcb") need[st.id] = Math.min(day, q.dcb / r.dcb + (HAS_TC ? 0 : q.tc / r.tc));
    spread("comf", (q.comf || 0) / r.comf); spread("tc", (q.tc || 0) / r.tc);
    const A = CATS.reduce((t, k) => t + (s.asmInclude[k] ? (q[k] || 0) : 0), 0); spread("asm", A / r.asm);
    for (const o of OPS) need[o.id] = 100; // operators always staffed when someone can run them
    return need;
  }
  /** Puts people on stations: highest-ranked first, busiest stations first (optionally favouring who usually works where). */
  function assign(people, { q = s.q, share = null, startOf = null } = {}) {
    const need = stationNeed(q), posts = POS, n = people.length + posts.length, BIG = 1e9, cost = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < n; j++) {
        if (i >= people.length || j >= posts.length) { row.push(0); continue; }
        const e = people[i], rk = rankOf(e, posts[j].id);
        if (!rk) { row.push(BIG); continue; }
        const w = need[posts[j].id] || 0, h = share ? share(e, posts[j].id) : 0, r3 = Math.min(rk, 3);
        const deep = Math.max(0, rk - 3) * 0.5; // 4th, 5th ... choices rank just below 3rd
        row.push(w <= 0.01 ? -1 + r3 * 0.1 - h * 0.5 + deep * 0.1 : -(w * 10 + (4 - r3) * 12 + h * 25) + deep);
      }
      cost.push(row);
    }
    const pick = people.length ? hungarian(cost) : [];
    const crew = Object.fromEntries(POS.map(p => [p.id, { emp: "", hrs: s.fullDay, start: s.defStart, stop: "" }])), placed = [], left = [];
    people.forEach((e, i) => {
      const j = pick[i];
      if (j == null || j < 0 || j >= posts.length || cost[i][j] >= BIG || ((need[posts[j].id] || 0) <= 0.01 && cost[i][j] > -1 + 0.5)) { left.push(e); return; }
      crew[posts[j].id] = { emp: e.id, start: (startOf && startOf(e)) || e.start || s.defStart, hrs: s.fullDay, stop: "" };
      placed.push({ e, st: posts[j], rk: rankOf(e, posts[j].id) });
    });
    return { crew, placed, left };
  }

  // ---------- deadlines: shuttles and the counter ----------
  return { STATIONS, OPS, POS, TYPE_OF, HAS_COMF, HAS_TC, POOL_OF, empById, rankOf, trained, crewTimes, breakPlan, stationInfo, washPlan, simulate, buildPlan, opsInfo, money, stationNeed, assign };
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

/** When each deadline's pieces are ready, from the simulation timeline (the floor works in deadline order). */
export function waveEtas(R, waves, q, asmInclude) {
  const out = {}; if (!R || R.empty || !R.TL || !waves || !waves.length) return out;
  const cats = ["slt", "slb", "dct", "dcb", "tc", "comf"], col = { slt: 1, slb: 2, dct: 3, dcb: 4, tc: 5, comf: 6 };
  const tot = {}; cats.forEach(k => { tot[k] = waves.reduce((t, w) => t + (w.q[k] || 0), 0); });
  const scale = k => (tot[k] > 0 ? Math.min(1, (q[k] || 0) / tot[k]) : 1); // a number typed by hand that's lower than SMRT's
  const cum = {}; cats.forEach(k => { cum[k] = 0; }); let cumA = 0;
  const first = (i, need) => { for (const s of R.TL) if (s[i] >= need - 0.5) return s[0]; return Infinity; };
  for (const w of waves) {
    let press = null, na = 0;
    for (const k of cats) { const n = (w.q[k] || 0) * scale(k); if (n < 0.5) continue; cum[k] += n; const t = first(col[k], cum[k]); press = press == null ? t : Math.max(press, t); if (asmInclude[k]) na += n; }
    if (press == null) { out[w.id] = null; continue; }
    let eta = press + (na > 0 ? 10 / 60 : 0); // last pieces still have to be assembled and bagged
    if (na > 0) { cumA += na; eta = Math.max(eta, first(7, cumA)); }
    out[w.id] = eta;
  }
  return out;
}
const slackTxt = m => (m >= 60 ? fmtH(m / 60) : `${Math.round(m)} min`);
export function waveState(w, eta) {
  if (w.kind === "overdue") return eta == null ? { cls: "", txt: "" } : { cls: isFinite(eta) ? "warn" : "bad", txt: isFinite(eta) ? `done by ${hm(eta)} — do these first` : "won't get done today" };
  if (eta == null) return { cls: "", txt: "" };
  if (!isFinite(eta)) return { cls: "bad", txt: "won't be ready — not enough hours planned", late: true };
  if (w.deadline == null || w.kind === "route") return { cls: "good", txt: `ready about ${hm(eta)}`, slack: Infinity };
  const slack = (w.deadline - eta) * 60;
  if (slack < 0) return { cls: "bad", txt: `ready about ${hm(eta)} · ${slackTxt(-slack)} late`, late: true, slack };
  if (slack < 15) return { cls: "warn", txt: `ready about ${hm(eta)} · only ${slackTxt(slack)} spare`, tight: true, slack };
  return { cls: "good", txt: `ready about ${hm(eta)} · ${slackTxt(slack)} spare`, slack };
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
export function outInfo(row) {
  if (row.ot > 0.04) return { cls: "ot", txt: fmtClock(row.clockOut), sub: `+${fmtH(row.ot)} overtime` };
  if (row.early >= 0.25) return { cls: "home", txt: fmtClock(row.clockOut), sub: `send home · ${fmtH(row.early)} early` };
  if (row.early > 0.04) return { cls: "norm", txt: fmtClock(row.clockOut), sub: "work done" };
  return { cls: "norm", txt: fmtClock(row.clockOut), sub: "end of shift" };
}
