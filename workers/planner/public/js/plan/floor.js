// The Floor screen's logic: replays the published plan and compares it with live progress from SMRT.
import { createEngine, buildWaves, stepsOf, outInfo, CATS, fmtClock, fmtH, fmtN, hm } from "../engine/engine.js";

export const TXT = {
  en: { ontrack: "ON TRACK", slipping: "SLIPPING", atrisk: "AT RISK", noplan: "NO PLAN PUBLISHED", deadlines: "Deadlines today", deadlinesFor: "Deadlines", now: "Right now", coming: "Coming up",
    done: "pieces done today", of: "of", ontime: "deadlines on time", doneby: "everyone done by", ready: "READY", readyAbout: "ready about", behind: "behind",
    left: "left", shuttle: "shuttle", counter: "counter", route: "route", overdue: "Overdue", leaves: "leaves", notready: "not ready", okload: "OK to load the", shuttleWord: "shuttle",
    pieces: "pieces", orders: "orders", starts: "starts", brk: "break", home: "home", to: "→", missed: "MISSED", back: "Shuttle back", nothing: "Nothing due today",
    plan: "Plan", full: "Full screen", exit: "Exit full screen", lang: "Español", min: "min", clock: "clocks out", pace: "White line = where we should be by now", first: "do these first",
    washStart: "Washers start", washDone: "Laundry wash done", comfDone: "Last comforters out of the washer", rotation: "rotation", publishedAt: "Plan published",
    notPublished: "A manager publishes the plan from the Plan screen. It shows here right away.", nextDay: "Plan for", changed: "The plan changed since it was published",
    work: "Work today", workFor: "Work", cats: { dct: "DC tops", dcb: "DC bottoms", slt: "Laundry tops", slb: "Laundry bottoms", comf: "Comforters", tc: "Tablecloths" }, comf: "Comforters", opLaundry: "Laundry operator", opDc: "DC operator",
    streakLab: "work days in a row with labor under", streakTip: "Labor cost as a share of the value of the pieces finished" },
  es: { ontrack: "A TIEMPO", slipping: "ATRASÁNDOSE", atrisk: "EN RIESGO", noplan: "SIN PLAN PUBLICADO", deadlines: "Entregas de hoy", deadlinesFor: "Entregas", now: "Ahora", coming: "Próximamente",
    done: "piezas terminadas hoy", of: "de", ontime: "entregas a tiempo", doneby: "todos terminan a las", ready: "LISTO", readyAbout: "listo como a las", behind: "atrasado",
    left: "faltan", shuttle: "camioneta", counter: "mostrador", route: "ruta", overdue: "Atrasadas", leaves: "sale", notready: "sin terminar", okload: "Pueden cargar la", shuttleWord: "camioneta",
    pieces: "piezas", orders: "órdenes", starts: "empieza", brk: "descanso", home: "a casa", to: "→", missed: "PERDIDA", back: "Regresa la camioneta", nothing: "Nada para hoy",
    plan: "Plan", full: "Pantalla completa", exit: "Salir", lang: "English", min: "min", clock: "sale", pace: "Línea blanca = donde deberíamos ir", first: "hacer primero",
    washStart: "Empiezan las lavadoras", washDone: "Termina el lavado de ropa", comfDone: "Salen los últimos edredones", rotation: "rotación", publishedAt: "Plan publicado",
    notPublished: "Un gerente publica el plan desde la pantalla Plan. Aparece aquí de inmediato.", nextDay: "Plan para", changed: "El plan cambió desde que se publicó",
    work: "Trabajo de hoy", workFor: "Trabajo", cats: { dct: "Camisas DC", dcb: "Pantalones DC", slt: "Camisas almidón", slb: "Pantalones almidón", comf: "Edredones", tc: "Manteles" }, comf: "Edredones", opLaundry: "Operador lavandería", opDc: "Operador DC",
    streakLab: "días seguidos con mano de obra bajo", streakTip: "Costo de mano de obra contra el valor de las piezas terminadas" },
};

/** Replays the published plan with the same engine the Plan screen used. */
export function replay(snapshot) {
  const I = snapshot.input;
  const E = createEngine({ ...I.settings, q: I.q, crew: I.crew, stations: I.stations, ops: I.ops, people: I.people, trainingOf: I.trainingOf });
  const R = E.buildPlan(I.q);
  const name = id => (I.people.find(p => p.id === id) || {}).name || "";
  const who = code => name((I.crew[code] || {}).emp);
  const label = code => code === "comf" ? null : ([...I.stations, ...I.ops].find(p => p.id === code) || {}).label || code;
  return { E, R, I, who, label };
}

/** Everything that happens in the day, grouped by time (people starting, moving, breaks, going home; the washers). */
export function events(F, t) {
  const { E, R, who, label } = F, ev = [];
  if (R.empty) return [];
  const L = c => c === "comf" ? t.comf : c === "tc" ? t.cats.tc : label(c);
  for (const row of R.rows) {
    if (!row.staffed) continue;
    const nm = who(row.st.id), st = stepsOf(row);
    ev.push({ t: row.x.start, o: 0, kind: "start", stn: st[0] ? st[0].stn : row.st.id, nm });
    st.slice(1).forEach(x => ev.push({ t: x.from, o: 1, kind: "move", stn: x.stn, nm, rot: !!x.rotFrom }));
    if (row.brkTaken > 0) ev.push({ t: row.brkS, o: 2, kind: "brk", nm, until: row.brkS + row.brkTaken });
    const oi = outInfo(row);
    ev.push({ t: row.clockOut, o: 3, kind: oi.cls === "home" ? "home" : oi.cls === "ot" ? "otx" : "end", nm, ot: row.ot });
  }
  for (const x of E.opsInfo()) if (x.on) {
    const nm = who(x.o.id);
    ev.push({ t: x.start, o: 0, kind: "start", stn: x.o.id, nm });
    if (x.b) ev.push({ t: x.brkS, o: 2, kind: "brk", nm, until: x.brkS + x.b });
    ev.push({ t: x.end, o: 3, kind: "end", nm });
  }
  if (R.W && R.W.loads.length) {
    ev.push({ t: R.W.start, o: 0, kind: "wash", txt: t.washStart });
    if (R.W.laundryDone && (R.W.tcDone || R.W.comfDone)) ev.push({ t: R.W.laundryDone, o: 1, kind: "wash", txt: t.washDone });
    if (R.W.comfDone) ev.push({ t: R.W.comfDone, o: 1, kind: "wash", txt: t.comfDone });
  }
  for (const e of ev) e.label = e.stn ? L(e.stn) : null;
  return ev.sort((a, b) => a.t - b.t || a.o - b.o);
}

/**
 * Each deadline: the published ready time, live progress from SMRT, where we should be by now and the projected ready time.
 * live = the pieces view for today (or null for a later day).
 */
export function liveWaves(snapshot, F, live, now) {
  const D = live && live.days[snapshot.day];
  const isToday = !!(D && live.today === snapshot.day && live.isWorkDay);
  const cur = isToday ? buildWaves({ ...D, isToday: true }, live.runs || [], { overdue: live.overdue }) : [];
  const leftBy = {};
  if (isToday) for (const st of D.stores) { const id = st.runId || "other"; const m = leftBy[id] = leftBy[id] || {}; for (const k of CATS) m[k] = (m[k] || 0) + Math.max(0, (st.q[k] || 0) - (st.done[k] || 0)); }
  if (isToday) leftBy.overdue = { ...live.overdue.q };
  const start = F.R.empty ? now : F.R.firstStart;
  const out = [];
  for (const w0 of snapshot.waves || []) {
    const c = cur.find(x => x.id === w0.id);
    const w = { ...w0, todo: c ? c.todo : w0.todo, q: c ? c.q : w0.q, orders: c ? c.orders : w0.orders };
    if (!w.todo && w.kind !== "overdue") continue;
    let done = 0, left = w.todo;
    if (w.kind === "overdue") { left = isToday ? live.overdue.todo : w0.todo; done = Math.max(0, w0.todo - left); w.todo = Math.max(w0.todo, left); if (!left && !w0.todo) continue; }
    else if (c) { done = c.done; left = c.leftTodo; }
    const eta = w0.eta, frac = w.todo ? Math.min(1, done / w.todo) : 1;
    let exp = null, behindMin = 0, proj = eta;
    if (isToday && eta != null && eta > start && w.kind !== "overdue") {
      exp = Math.max(0, Math.min(1, (now - start) / (eta - start)));
      behindMin = Math.max(0, (exp - frac) * (eta - start) * 60);
      const aheadMin = Math.max(0, (frac - exp) * (eta - start) * 60);
      proj = eta + (behindMin - aheadMin) / 60;
    }
    const ready = isToday && w.kind !== "overdue" && left === 0;
    const passed = isToday && w.kind === "shuttle" && now > w.deadline + 0.02;
    let cls = "good";
    if (!ready && w.kind !== "route" && w.deadline != null) {
      if (passed || proj == null || !isFinite(proj) || proj > w.deadline) cls = proj == null ? "" : "bad";
      else if (proj > w.deadline - 0.25) cls = "warn";
    }
    if (w.kind === "overdue") cls = left ? "warn" : "good";
    const lb = leftBy[w.id] || {};
    const leftCats = Object.entries(lb).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    out.push({ w, done, left, frac, exp, behindMin, proj, eta, ready, passed, cls, leftCats, isToday });
  }
  return out;
}

/** Where each person is at `now`, and what's next for them. */
export function rightNow(F, ev, now) {
  const { R, who, label, E } = F, out = [];
  if (R.empty) return out;
  for (const row of R.rows) {
    if (!row.staffed) continue;
    const nm = who(row.st.id), steps = stepsOf(row);
    const cur = steps.find(s => now >= s.from - 1e-6 && now < s.to - 1e-6);
    const inBrk = row.brkTaken > 0 && now >= row.brkS && now < row.brkS + row.brkTaken;
    const nx = ev.find(e => e.nm === nm && e.t > now + 1 / 120);
    const where = cur ? cur.stn : row.st.id;
    out.push({ stn: where, type: where === "comf" ? "comf" : E.TYPE_OF[where], label: where === "comf" ? null : label(where), nm,
      state: now < row.x.start ? "before" : inBrk ? "break" : now >= row.clockOut ? "off" : "on", brkEnd: inBrk ? row.brkS + row.brkTaken : null, start: row.x.start, next: nx || null });
  }
  for (const x of E.opsInfo()) if (x.on) {
    const nm = who(x.o.id), inBrk = x.b && now >= x.brkS && now < x.brkS + x.b;
    out.push({ stn: x.o.id, type: "ops", label: label(x.o.id), nm, state: now < x.start ? "before" : inBrk ? "break" : now >= x.end ? "off" : "on", brkEnd: inBrk ? x.brkS + x.b : null, start: x.start,
      next: ev.find(e => e.nm === nm && e.t > now + 1 / 120) || null });
  }
  const order = [...F.I.stations, ...F.I.ops].map(p => p.id).concat(F.I.stations.some(p => p.id === "comf") ? [] : ["comf"]);
  return out.sort((a, b) => order.indexOf(a.stn) - order.indexOf(b.stn));
}

/** The next 90 minutes: moves, breaks, people going home, washers; and the shuttles in the next 3 hours. */
export function comingUp(ev, waves, now) {
  const out = [];
  for (const e of ev) if (e.t > now && e.t <= now + 1.5 && e.kind !== "start") out.push(e);
  for (const e of ev) if (e.t > now && e.t <= now + 1.5 && e.kind === "start" && e.nm) out.push(e);
  for (const x of waves) {
    const w = x.w; if (w.kind !== "shuttle") continue;
    if (w.deadline > now && w.deadline <= now + 3) out.push({ t: w.deadline, kind: "shuttle", w, ready: x.ready });
    if (w.back && w.back > now && w.back <= now + 3) out.push({ t: w.back, kind: "back", w });
  }
  const m = new Map();
  for (const e of out.sort((a, b) => a.t - b.t)) { const k = fmtClock(e.t) + (e.kind === "shuttle" ? "s" : ""); (m.get(k) || m.set(k, { t: e.t, sh: e.kind === "shuttle", items: [] }).get(k)).items.push(e); }
  return [...m.values()].slice(0, 6);
}

export function status(L, F, t) {
  const live = L.filter(x => x.w.kind !== "overdue" && x.w.kind !== "route");
  const bad = live.filter(x => x.cls === "bad" && !x.ready).length, warn = live.filter(x => x.cls === "warn" && !x.ready).length;
  if (F.R.empty) return { cls: "idle", txt: t.noplan };
  if (bad) return { cls: "bad", txt: t.atrisk };
  if (warn) return { cls: "warn", txt: t.slipping };
  return { cls: "ok", txt: t.ontrack };
}
export { fmtClock, fmtH, fmtN, hm };
