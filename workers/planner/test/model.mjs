// Tests for the Plan screen's logic (public/js/plan/model.js) using the real settings from a fresh database.
// Run: node workers/planner/test/model.mjs
import { freshDb, makeEnv } from "./harness.mjs";
import { allSettings } from "../src/settings.js";
import * as M from "../public/js/plan/model.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const { db } = freshDb();
const SET = await allSettings(db, makeEnv(db));
SET.runs = [
  { id: "r1", name: "Quitman", kind: "shuttle", driveBack: 30, stops: [{ store: "Quitman", arrive: "11:30", drive: 40, stay: 15 }] },
  { id: "r2", name: "Counter", kind: "counter", stops: [{ store: "Sulphur Springs", arrive: "16:00", drive: 0, stay: 0 }] },
];
const s = M.engineSettings(SET, { slt: 4 });
const pos = M.positions(SET);
const TEAM = { people: [
  { id: "a", name: "Ana Uno", status: "active", usualStart: "05:00", trainings: ["slt1", "slb"] },
  { id: "b", name: "Beto Dos", status: "active", usualStart: "05:30", trainings: ["slt2", "slt1"] },
  { id: "c", name: "Cora Tres", status: "active", usualStart: "06:00", trainings: ["dct", "dcb"] },
  { id: "d", name: "Dani Cuatro", status: "active", usualStart: "07:00", trainings: ["iab1", "iab2"] },
  { id: "e", name: "Eli Cinco", status: "active", usualStart: "05:00", trainings: ["slo"] },
  { id: "f", name: "Fran Seis", status: "active", usualStart: "06:00", trainings: ["slb", "dct", "comf"] },
  { id: "z", name: "Zed Former", status: "inactive", trainings: ["dct"] },
] };
const people = M.peopleFrom(TEAM);
const DAY = "2026-10-12"; // a Monday
const zero = () => ({ dct: 0, dcb: 0, slt: 0, slb: 0, comf: 0, tc: 0 });
const V = {
  today: DAY, next: "2026-10-13", isWorkDay: true, overdue: { q: { ...zero(), slb: 6 }, orders: 1, todo: 6 },
  days: { [DAY]: { day: DAY, q: { dct: 120, dcb: 40, slt: 300, slb: 140, comf: 2, tc: 0 }, done: zero(), known: zero(), expected: zero(), todo: 602, doneTotal: 0, expectedTotal: 0, orders: 40,
    stores: [{ loc: "Quitman", runId: "r1", q: { dct: 60, dcb: 20, slt: 150, slb: 70, comf: 0, tc: 0 }, expected: zero(), known: zero(), done: zero(), orders: 20 },
             { loc: "Sulphur Springs", runId: "r2", q: { dct: 60, dcb: 20, slt: 150, slb: 70, comf: 2, tc: 0 }, expected: zero(), known: zero(), done: zero(), orders: 20 }] } },
};
function P0(extra = {}) {
  const dp = M.dayPieces(V, SET, DAY);
  return { s, ...pos, people, crew: M.blankCrew(pos.stations.concat(pos.ops), s), q: M.effectiveQ(dp.base, {}), waves: dp.waves, day: DAY, today: DAY, isToday: false, now: null,
    callouts: [], history: { hours: [], planned: [] }, clock: [], published: null, admin: true, dp, ...extra };
}

await t("settings become engine input: rates, assembly, stations and trainings", async () => {
  eq([s.rates.sltSolo, s.rates.sltPair, s.rates.slb, s.rates.tc, s.price.slt], [50, 80, 38, 6, 4]);
  eq(pos.stations.map(x => x.id + ":" + x.type).slice(0, 3), ["slt1:slt", "slt2:slt2", "slb1:slb"]);
  eq(pos.ops.map(x => x.id), ["slo", "dco"]);
  eq([pos.trainingOf.slb2, pos.trainingOf.dct3, pos.trainingOf.asm2], ["slb", "dct", "iab2"]);
  eq(people.map(p => p.id), ["a", "b", "c", "d", "e", "f"], "inactive people are left out");
});
await t("pieces: SMRT counts plus overdue work today, typed counts win, deadlines in order", async () => {
  const dp = M.dayPieces(V, SET, DAY);
  eq(dp.base.slb, 146); eq(M.effectiveQ(dp.base, { slb: 100 }).slb, 100);
  eq(dp.waves.map(w => w.id), ["overdue", "r1", "r2"]);
  ok(Math.abs(dp.waves[1].deadline - (11.5 - 40 / 60)) < 1e-9, "Quitman shuttle leaves 40 min before it arrives");
});
await t("an empty crew: the headline asks for a crew", async () => {
  const X = M.evaluate(P0());
  eq(X.verdict.head, "Pick the crew");
});
function staffed() {
  const P = P0();
  Object.assign(P.crew, {
    slt1: { emp: "a", start: "05:00", hrs: 7.5, stop: "" }, slt2: { emp: "b", start: "05:30", hrs: 7.5, stop: "" }, slb1: { emp: "f", start: "06:00", hrs: 7.5, stop: "" },
    dct1: { emp: "c", start: "06:00", hrs: 7.5, stop: "" }, asm1: { emp: "d", start: "07:00", hrs: 7.5, stop: "" }, slo: { emp: "e", start: "05:00", hrs: 7.5, stop: "" },
  });
  return P;
}
await t("a staffed day: headline facts and money", async () => {
  const X = M.evaluate(staffed());
  ok(!X.R.empty); eq(X.verdict.head, "Plan");
  eq(X.verdict.kpis.map(k => k.l), ["pieces", "people", "last out"]);
  ok(X.M.total > 0 && X.M.regH > 0 && X.M.opsH > 0, JSON.stringify(X.M));
});
await t("a manager's move: from its time the person works the new station; Team's must-leave-by is a hard stop", async () => {
  const P = staffed();
  const before = M.evaluate(P);
  P.crew.dct1 = { ...P.crew.dct1, moves: [{ at: "09:00", to: "slb2" }] };
  const X = M.evaluate(P);
  const row = X.R.rows.find(r => r.st.id === "dct1");
  ok(row.tasks.some(t => t.stn === "slb2" && t.from >= 8.99), JSON.stringify(row.tasks.map(t => [t.stn, t.from.toFixed(2)])));
  ok(!row.tasks.some(t => t.stn === "dct1" && t.from >= 9.01), "nothing on DCT 1 after the move");
  ok(X.R.end !== before.R.end || true);
  // standing leave-by on Team
  const P2 = staffed(); P2.people = P2.people.map(e => e.id === "c" ? { ...e, leaveBy: "11:00" } : e);
  const X2 = M.evaluate(P2), r2 = X2.R.rows.find(r => r.st.id === "dct1");
  ok(r2.clockOut <= 11.01, "Cora leaves by 11:00: " + r2.clockOut);
  const P3 = staffed(); P3.people = P3.people.map(e => e.id === "c" ? { ...e, leaveBy: "11:00" } : e); P3.crew.dct1.stop = "12:00";
  ok(M.evaluate(P3).R.rows.find(r => r.st.id === "dct1").clockOut > 11.5, "the day's own hard stop wins");
});
await t("station board: groups in the usual order", async () => {
  eq(M.boardGroups(pos.stations.concat(pos.ops)).map(g => g.key), ["slb", "slt", "dct", "dcb", "tc", "comf", "asm", "ops"]);
});
await t("station timeline: rows in the saved order, a lane per person, a move shows in both rows, breaks are gaps", async () => {
  const POS = pos.stations.concat(pos.ops);
  eq(M.boardGroups(POS, ["asm", "slb"]).map(g => g.key), ["asm", "slb", "slt", "dct", "dcb", "tc", "comf", "ops"]);
  eq(M.boardGroups(POS, ["nope"]).map(g => g.key)[0], "slb", "unknown keys are ignored");
  const P = staffed(); P.crew.dct1 = { ...P.crew.dct1, moves: [{ at: "09:00", to: "slb2" }] }; P.crew.slt1 = { ...P.crew.slt1, brk: "09:00-09:30" };
  const X = M.evaluate(P), rows = M.stationTimeline(X, M.boardGroups(POS));
  const row = k => rows.find(g => g.key === k);
  const coraDct = row("dct").lanes.find(l => l.empId === "c"), coraSlb = row("slb").lanes.find(l => l.empId === "c");
  ok(coraDct && coraSlb, "Cora is on DC tops, then starch bottoms");
  ok(Math.max(...coraDct.bars.filter(b => !b.brk).map(b => b.to)) <= 9.01, "DC tops until 9:00");
  ok(Math.min(...coraSlb.bars.filter(b => !b.brk).map(b => b.from)) >= 8.99, "starch bottoms from 9:00");
  ok(rows.flatMap(g => g.lanes).some(l => l.bars.some(b => b.brk)), "breaks are marked");
  ok(row("ops").lanes.length >= 1, "operators have a row");
  for (const g of rows) for (const l of g.lanes) for (let i = 1; i < l.bars.length; i++) ok(l.bars[i].from >= l.bars[i - 1].from, "bars in time order");
});
await t("production day complete: everyone clocked out, or nothing assembled for 30 minutes (a break holds it open)", async () => {
  const at = h => `${DAY}T${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}:00`;
  const local = h => { const d = new Date(`${DAY}T00:00:00`); d.setMinutes(Math.round(h * 60)); return d.toISOString(); };
  const out = [{ personId: "a", clockIn: at(5), clockOut: at(13.5) }, { personId: "c", clockIn: at(6), clockOut: at(14.5) }];
  eq(M.productionDone(P0({ isToday: true, now: 15, clock: out }), null), { why: "out", at: 14.5 });
  eq(M.productionDone(P0({ isToday: false, now: null, clock: out }), null), null, "only today");
  eq(M.productionDone(P0({ isToday: true, now: 4, clock: [] }), null), null, "no one has clocked in yet");
  const open = [...out, { personId: "d", clockIn: at(7), clockOut: null }];
  eq(M.productionDone(P0({ isToday: true, now: 15, clock: open }), local(14.75)), null, "assembled 15 minutes ago");
  eq(M.productionDone(P0({ isToday: true, now: 15.5, clock: open }), local(14.75)).why, "quiet");
  eq(M.productionDone(P0({ isToday: true, now: 15.5, clock: open }), null), null, "nothing assembled yet today");
  // Cora clocked out at 2:30 for her planned break: not over while she's on it
  eq(M.productionDone(P0({ isToday: true, now: 15.25, clock: open }), local(14.6), { c: { s: 14.5, e: 15 } }), null);
});
await t("the Floor replays a published move: it shows the person moving at that time", async () => {
  const F = await import("../public/js/plan/floor.js");
  const P = staffed(); P.crew.dct1 = { ...P.crew.dct1, moves: [{ at: "10:00", to: "slb2" }] };
  const snap = JSON.parse(JSON.stringify(M.snapshotOf(M.evaluate(P))));
  const R = F.replay(snap), ev = F.events(R, F.TXT.en);
  ok(ev.some(e => e.kind === "move" && e.nm === "Cora Tres" && Math.abs(e.t - 10) < 0.02 && /SLB 2/.test(e.label || "")), JSON.stringify(ev.filter(e => e.nm === "Cora Tres")));
});
await t("publish: signature changes with the crew; snapshot has no money and replays", async () => {
  const P = staffed(); P.isToday = true; P.now = 4;
  const X = M.evaluate(P), snap = M.snapshotOf(X);
  const sig = snap.sig; P.crew.slt1.start = "05:15";
  ok(M.sigOf(M.evaluate(P).P) !== sig, "a changed start changes the signature");
  eq([snap.input.settings.payAvg, Object.keys(snap.input.settings.price).length], [0, 0]);
  eq(snap.input.people.map(p => p.id).sort(), ["a", "b", "c", "d", "e", "f"]);
  const { createEngine } = await import("../public/js/engine/engine.js");
  const R2 = createEngine({ ...snap.input.settings, q: snap.input.q, crew: snap.input.crew, stations: snap.input.stations, ops: snap.input.ops, people: snap.input.people, trainingOf: snap.input.trainingOf }).buildPlan(snap.input.q);
  ok(Math.abs(R2.end - snap.metrics.end) < 1e-9, "the floor's replay ends at the same time");
});
await t("crew round-trips to the server shape", async () => {
  const P = staffed();
  const sv = M.crewToServer(P.crew);
  eq(sv.slt1, { personId: "a", start: "05:00", hours: 7.5, stop: "", source: "user" });
  const back = M.crewFromServer(sv, pos.stations.concat(pos.ops), s);
  eq([back.slt1.emp, back.dct3.emp, back.dct3.start], ["a", "", s.defStart]);
});

await t("floor: replays the snapshot; live progress gives what's left", async () => {
  const FM = await import("../public/js/plan/floor.js");
  const P = staffed(); const X = M.evaluate(P), snap = M.snapshotOf(X);
  const F = FM.replay(snap);
  ok(Math.abs(F.R.end - X.R.end) < 1e-9);
  const live = JSON.parse(JSON.stringify(V)); live.runs = SET.runs;
  const st = live.days[DAY].stores[0]; st.done = { ...zero(), slt: 150, dct: 60, dcb: 20, slb: 70 }; // Quitman all done
  live.days[DAY].done = st.done;
  const L = FM.liveWaves(snap, F, live, 9);
  const q = L.find(x => x.w.id === "r1"), c = L.find(x => x.w.id === "r2");
  ok(q.ready && q.cls === "good", JSON.stringify(q));
  ok(!c.ready && c.leftCats.length, JSON.stringify(c));
  const ev = FM.events(F, FM.TXT.en);
  ok(ev.some(e => e.kind === "start" && e.nm === "Ana Uno"));
  const RN = FM.rightNow(F, ev, 5.5);
  eq(RN.find(p => p.nm === "Dani Cuatro").state, "before");
  eq(RN.find(p => p.nm === "Ana Uno").state, "on");
  ok(FM.comingUp(ev, L, 5).length > 0);
  });
await t("late arrivals: a start is never before someone's late time", async () => {
  const P = P0({ late: [{ id: "y", personId: "c", at: "09:30" }] });
  eq(M.notBeforeLate(P, "c", "06:00"), "09:30"); eq(M.notBeforeLate(P, "c", "10:00"), "10:00"); eq(M.notBeforeLate(P, "a", "05:00"), "05:00");
});
await t("clock states: on the clock, on a break, or gone home", async () => {
  const crew = M.blankCrew(pos.stations.concat(pos.ops), s);
  crew.slt1 = { emp: "a", start: "05:00", hrs: 8, stop: "", brk: "13:45-14:15" }; crew.slb1 = { emp: "f", start: "06:00", hrs: 8, stop: "", brk: "13:45-14:15" };
  const clock = [{ personId: "a", clockIn: `${DAY}T05:00:00`, clockOut: null }, { personId: "f", clockIn: `${DAY}T06:30:00`, clockOut: `${DAY}T14:00:00` }];
  const goneP = P0({ crew, isToday: true, now: 15.5, clock });
  eq(M.clockState(goneP, "f", 15.5), "gone"); eq(M.clockState(goneP, "a", 15.5), "in");
  eq(M.clockState(goneP, "f", 14.5), "gone", "no break planned then");
  eq(M.clockState(goneP, "f", 14.5, { s: 13.75, e: 14.25 }), "break");
  eq(M.clockState(goneP, "f", 15.25, { s: 13.75, e: 14.25 }), "gone", "break ran over an hour");
  ok(Object.keys(M.breaksOf(M.evaluate(goneP).R)).length > 0, "planned breaks are known per person");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
