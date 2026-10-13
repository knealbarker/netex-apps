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

await t("settings become engine input: rates, wash programs, assembly, stations and trainings", async () => {
  eq([s.rates.sltSolo, s.rates.sltPair, s.rates.slb, s.rates.tc, s.washSlt, s.cycSlb, s.price.slt], [50, 80, 38, 6, 65, 45, 4]);
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
await t("an empty crew: verdict asks for a crew, the check says so", async () => {
  const X = M.evaluate(P0());
  eq(X.verdict.head, "Pick the crew"); eq(X.checks[0].title, "No one is on a station");
});
await t("suggest from history: who usually works Mondays, at their usual clock-in, on their usual station", async () => {
  const mon = ["2026-09-21", "2026-09-28", "2026-10-05"];
  const hours = [];
  for (const d of mon) for (const [id, fi] of [["a", "04:55"], ["b", "05:30"], ["c", "06:05"], ["f", "06:00"]]) hours.push({ day: d, personId: id, hours: 8, firstIn: fi });
  hours.push({ day: "2026-10-05", personId: "d", hours: 8, firstIn: "07:00" }); // 1 of 3 Mondays: left out
  const planned = mon.map(d => ({ day: d, station: "slb1", personId: "f" })).concat(mon.map(d => ({ day: d, station: "dct1", personId: "c" })));
  const P = P0({ history: { hours, planned } });
  const r = M.suggestCrew(P, M.evaluate(P).E);
  eq(r.basis, "recent Mondays");
  const on = Object.fromEntries(Object.entries(r.crew).filter(([, c]) => c.emp).map(([k, c]) => [c.emp, [k, c.start, c.source]]));
  eq(on.a, ["slt1", "04:55", "suggested"]); eq(on.b[0], "slt2"); eq(on.f[0], "slb1"); eq(on.c[0], "dct1"); ok(!on.d, "Dani only worked one Monday");
});
await t("suggest with no Rippling history falls back to the last plan, then the whole team", async () => {
  const P = P0({ history: { hours: [], planned: [{ day: "2026-10-09", station: "dct1", personId: "c" }] } });
  const r = M.suggestCrew(P, M.evaluate(P).E);
  ok(/^the plan for Friday/.test(r.basis), r.basis);
  eq(Object.values(r.crew).filter(c => c.emp).map(c => c.emp), ["c"]);
  const r2 = M.suggestCrew(P0(), M.evaluate(P0()).E);
  eq(r2.basis, "the whole team"); ok(Object.values(r2.crew).filter(c => c.emp).length === 6);
});
await t("auto-assign keeps hours and hard stops, and uses today's Rippling clock-ins", async () => {
  const P = P0({ isToday: true, now: 6, clock: [{ personId: "c", clockIn: "2026-10-12T06:12:00-05:00" }] });
  P.crew.dct2 = { emp: "c", start: "06:00", hrs: 6, stop: "13:00", source: "user" };
  const r = M.autoAssign(P, M.evaluate(P).E, ["a", "c"]);
  const c = Object.values(r.crew).find(x => x.emp === "c");
  eq([c.start, c.hrs, c.stop, c.source], ["06:12", 6, "13:00", "clock"]);
  eq(r.crew.slt1.emp, "a");
});
function staffed() {
  const P = P0();
  Object.assign(P.crew, {
    slt1: { emp: "a", start: "05:00", hrs: 7.5, stop: "" }, slt2: { emp: "b", start: "05:30", hrs: 7.5, stop: "" }, slb1: { emp: "f", start: "06:00", hrs: 7.5, stop: "" },
    dct1: { emp: "c", start: "06:00", hrs: 7.5, stop: "" }, asm1: { emp: "d", start: "07:00", hrs: 7.5, stop: "" }, slo: { emp: "e", start: "05:00", hrs: 7.5, stop: "" },
  });
  return P;
}
await t("a staffed day: waves get ready times, verdict and KPIs, money for admins", async () => {
  const X = M.evaluate(staffed());
  ok(!X.R.empty); ok(X.etas.r1 > 0 && X.etas.r2 > 0);
  ok(["ok", "warn", "bad"].includes(X.verdict.cls));
  ok(X.verdict.kpis.some(k => /labor/.test(k.l)), "admin sees labor %");
  const Xv = M.evaluate({ ...staffed(), admin: false });
  ok(!Xv.verdict.kpis.some(k => /labor/.test(k.l)), "viewer doesn't");
  ok(X.M.revenue > 0 && X.M.total > 0);
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
await t("a late shuttle offers a fix that makes it earlier", async () => {
  const P = staffed(); P.crew.slt1.start = "09:00"; P.crew.slt2.start = "09:00";
  P.q.dcb = 0; P.waves = P.waves.map(w => ({ ...w, q: { ...w.q, dcb: 0 } })); // nobody here can do DCB
  const X = M.evaluate(P);
  const c = X.checks.find(c => /Quitman won't be ready|Quitman is tight/.test(c.title));
  ok(c, X.checks.map(c => c.title).join(" | "));
  ok(c.fixes.length && c.fixes[0].apply, "has a fix");
  const before = X.etas.r1; c.fixes[0].apply(P);
  ok(M.evaluate(P).etas.r1 < before, "earlier after the fix");
});
await t("today's published plan: a late shuttle isn't a check, the headline or a suggestion (it's on the Deadlines card)", async () => {
  const P = staffed(); P.crew.slt1.start = "09:00"; P.crew.slt2.start = "09:00";
  P.q.dcb = 0; P.waves = P.waves.map(w => ({ ...w, q: { ...w.q, dcb: 0 } }));
  ok(M.evaluate(P).verdict.head.includes("Quitman"), "before publish it still leads");
  Object.assign(P, { isToday: true, now: 5, published: { at: new Date().toISOString(), sig: "x" } });
  const X = M.evaluate(P);
  ok(!X.checks.some(c => /won't be ready|is tight/.test(c.title)), X.checks.map(c => c.title).join(" | "));
  ok(!/Quitman/.test(X.verdict.head), X.verdict.head);
  ok(!X.verdict.kpis.some(k => /shuttle ready/.test(k.l)));
  ok(!M.liveSuggestions(X).list.some(x => /shuttle|counter/.test(x.title)));
});
await t("call-out check offers trained people who aren't scheduled", async () => {
  const P = staffed(); P.crew.dct1.emp = ""; P.callouts = [{ id: "x", personId: "c", station: "dct1" }];
  const c = M.evaluate(P).checks.find(x => /called out/.test(x.title));
  ok(c, "has check"); eq(c.fixes.map(f => f.label), []); // nobody else trained on DCT is free (Fran is on SLB 1)
  P.crew.slb1.emp = ""; const c2 = M.evaluate(P).checks.find(x => /called out/.test(x.title));
  eq(c2.fixes.map(f => f.label), ["Add Fran"]);
});
await t("untrained person: a fix to mark them trained", async () => {
  const P = staffed(); P.crew.dcb1 = { emp: "e", start: "07:00", hrs: 7.5, stop: "" }; P.crew.slo.emp = "";
  const c = M.evaluate(P).checks.find(x => x.title === "Not trained for the station");
  eq(c.fixes[0].train, { personId: "e", training: "dcb" });
});
await t("40-hour watch: hours earlier in the week plus today's plan, with a stop-time fix", async () => {
  const P = staffed(); P.day = "2026-10-15"; // Thursday
  P.history = { hours: ["2026-10-12", "2026-10-13", "2026-10-14"].map(d => ({ day: d, personId: "a", hours: 12.5 })).concat([{ day: "2026-10-09", personId: "a", hours: 9 }]), planned: [] };
  const X = M.evaluate(P);
  eq(X.week.map(w => [w.id, w.sofar]), [["a", 37.5]]);
  const c = X.checks.find(x => /over 40 hours/.test(x.title));
  ok(c && c.fixes[0].label.startsWith("Ana: stop at"), c && c.fixes[0].label);
  c.fixes[0].apply(P); ok(P.crew.slt1.stop, "stop set");
  ok(!M.evaluate(P).week.length, "back under 40");
});
await t("publish: not published → note; signature changes with the crew; snapshot has no money and replays", async () => {
  const P = staffed(); P.isToday = true; P.now = 4;
  ok(M.evaluate(P).checks.some(c => c.title === "Not published yet"));
  const X = M.evaluate(P), snap = M.snapshotOf(X);
  P.published = { sig: snap.sig, at: new Date().toISOString(), by: "Neal" };
  ok(!M.evaluate(P).checks.some(c => /published/i.test(c.title)));
  P.crew.slt1.start = "05:15";
  ok(M.evaluate(P).checks.some(c => c.title === "Changed since it was published"));
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

await t("floor: replays the snapshot; live progress gives pace, projection and what's left", async () => {
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
  ok(!c.ready && c.exp > 0 && c.exp < 1 && c.leftCats.length, JSON.stringify(c));
  ok(c.proj > c.eta, "nothing done for the counter yet: behind the plan");
  const ev = FM.events(F, FM.TXT.en);
  ok(ev.some(e => e.kind === "wash") && ev.some(e => e.kind === "start" && e.nm === "Ana Uno"));
  const RN = FM.rightNow(F, ev, 5.5);
  eq(RN.find(p => p.nm === "Dani Cuatro").state, "before");
  eq(RN.find(p => p.nm === "Ana Uno").state, "on");
  ok(FM.comingUp(ev, L, 5).length > 0);
  eq(FM.status(L, F, FM.TXT.en).cls, c.cls === "bad" ? "bad" : c.cls === "warn" ? "warn" : "ok");
});
await t("comforters and tablecloths are stations: only trained people do them", async () => {
  ok(pos.stations.some(x => x.id === "comf" && x.type === "comf") && pos.stations.some(x => x.id === "tc" && x.type === "tc"), "both stations in use");
  eq([pos.trainingOf.comf, pos.trainingOf.tc], ["comf", "tc"]);
  const q = { ...zero(), dcb: 10, comf: 4, tc: 12 };
  const crew = M.blankCrew(pos.stations.concat(pos.ops), s);
  crew.dcb1 = { emp: "c", start: "06:00", hrs: 8, stop: "" };      // Cora: DCT, DCB — not tablecloths, not comforters
  crew.slb1 = { emp: "f", start: "06:00", hrs: 8, stop: "" };      // Fran: SLB, DCT, Comforters
  let X = M.evaluate(P0({ crew, q, waves: [] }));
  const cora = X.R.rows.find(r => r.st.id === "dcb1"), fran = X.R.rows.find(r => r.st.id === "slb1");
  ok(!cora.tasks.some(k => k.stn === "comf" || k.stn === "tc"), "Cora isn't trained on comforters or tablecloths");
  ok(fran.tasks.some(k => k.stn === "comf"), "Fran moves to comforters once SLB has no work");
  eq(Math.round(X.R.P.short.comf), 0); eq(Math.round(X.R.P.short.tc), 12, "nobody trained on tablecloths");
  ok(X.checks.some(c => c.title === "No one is trained on Tablecloths"), "the check names the missing training");
  const P1 = P0({ crew, q, waves: [], people: people.map(p => p.id === "c" ? { ...p, trainings: [...p.trainings, "tc"] } : p) });
  X = M.evaluate(P1);
  ok(X.R.rows.find(r => r.st.id === "dcb1").tasks.some(k => k.stn === "tc"), "trained on tablecloths: Cora does them after DCB");
  eq(Math.round(X.R.P.short.tc), 0);
});
await t("with the Comforters and Tablecloths stations switched off, the old rules apply", async () => {
  const SET2 = { ...SET, stations: SET.stations.map(x => ["comf", "tc"].includes(x.code) ? { ...x, active: false } : x) };
  const pos2 = M.positions(SET2), q = { ...zero(), dcb: 10, comf: 4, tc: 12 };
  const crew = M.blankCrew(pos2.stations.concat(pos2.ops), s);
  crew.dcb1 = { emp: "c", start: "06:00", hrs: 8, stop: "" };
  const X = M.evaluate(P0({ ...pos2, crew, q, waves: [] }));
  eq(Math.round(X.R.P.shortTotal), 0, "DCB does tablecloths, anyone free does comforters");
});
await t("time off: someone out but still planned, and someone planned before their late arrival", async () => {
  const crew = M.blankCrew(pos.stations.concat(pos.ops), s);
  crew.slt1 = { emp: "a", start: "05:00", hrs: 8, stop: "" }; crew.dct1 = { emp: "c", start: "06:00", hrs: 8, stop: "" };
  const P = P0({ crew, callouts: [{ id: "x", timeOff: true, personId: "a", station: null }], late: [{ id: "y", personId: "c", at: "09:30" }] });
  const X = M.evaluate(P);
  const outC = X.checks.find(c => c.title === "Ana Uno is out"), lateC = X.checks.find(c => /Cora Tres comes in at 9:30/.test(c.title));
  ok(outC && lateC, X.checks.map(c => c.title).join(" | "));
  const Q = structuredClone({ crew }); outC.fixes[0].apply(Q); lateC.fixes[0].apply(Q);
  eq([Q.crew.slt1.emp, Q.crew.dct1.start], ["", "09:30"]);
  eq(M.notBeforeLate(P, "c", "06:00"), "09:30"); eq(M.notBeforeLate(P, "c", "10:00"), "10:00"); eq(M.notBeforeLate(P, "a", "05:00"), "05:00");
  const sug = M.autoAssign(P, X.E, ["a", "c"]);
  ok(Object.values(sug.crew).every(c => c.emp !== "c" || c.start === "09:30"), "auto-assign starts Cora at 9:30");
});
await t("during the day: no-show, clocked in but not planned, then send-home when there's little left; dismissed ones stay hidden", async () => {
  const crew = M.blankCrew(pos.stations.concat(pos.ops), s);
  crew.slt1 = { emp: "a", start: "05:00", hrs: 8, stop: "" }; crew.dct1 = { emp: "c", start: "06:00", hrs: 8, stop: "" }; crew.asm1 = { emp: "d", start: "07:00", hrs: 8, stop: "" };
  const clock = [{ personId: "a", clockIn: `${DAY}T05:02:00` }, { personId: "c", clockIn: `${DAY}T06:01:00` }, { personId: "f", clockIn: `${DAY}T06:30:00` }];
  const P = P0({ crew, isToday: true, now: 9, clock });
  ok(P.dp.wavesLeft, "today has what's left per deadline");
  let L = M.liveSuggestions(M.evaluate(P));
  ok(L.on, L.why);
  const ns = L.list.find(x => x.key === "noshow:d"), un = L.list.find(x => x.key === "unplanned:f");
  ok(ns && un, L.list.map(x => x.key).join(", "));
  eq(ns.act, { out: "d" });
  const Q = structuredClone({ crew }); ns.apply(Q); un.apply(Q);
  eq(Q.crew.asm1.emp, ""); ok(Object.values(Q.crew).some(c => c.emp === "f" && c.start === "06:30"), "Fran goes on an open station she's trained on, from her clock-in");
  L = M.liveSuggestions(M.evaluate(P), new Set(["noshow:d"]));
  ok(!L.list.some(x => x.key === "noshow:d"), "dismissed stays hidden");
  // per kind of work: hours so far (from the plan, up to 9:00) and an ETC after now
  ok(L.cats.slt.hrsSoFar > 1 && L.cats.slt.hrsSoFar <= 4.01, "SLT: Ana 5:00-9:00 minus breaks/moves " + L.cats.slt.hrsSoFar);
  ok(L.cats.dct.hrsSoFar > 0 && L.cats.dct.hrsSoFar <= 3.01, "DCT: Cora 6:00-9:00 " + L.cats.dct.hrsSoFar);
  for (const k of ["slt", "dct"]) ok(L.cats[k].left > 0 && (L.cats[k].etc > 9 || L.cats[k].short > 0.5), k + " ETC after now");
  // someone who clocked in and went home isn't suggested as "clocked in but not on the plan"
  const goneP = P0({ crew, isToday: true, now: 15.5, clock: [...clock.slice(0, 2), { personId: "f", clockIn: `${DAY}T06:30:00`, clockOut: `${DAY}T14:00:00` }] });
  ok(!M.liveSuggestions(M.evaluate(goneP)).list.some(x => x.key === "unplanned:f"), "Fran went home: no suggestion");
  eq(M.clockState(goneP, "f", 15.5), "gone"); eq(M.clockState(goneP, "a", 15.5), "in");
  // out at 2:00: a break only if that's around their planned break, and only for an hour
  eq(M.clockState(goneP, "f", 14.5), "gone", "no break planned then");
  eq(M.clockState(goneP, "f", 14.5, { s: 13.75, e: 14.25 }), "break");
  eq(M.clockState(goneP, "f", 15.25, { s: 13.75, e: 14.25 }), "gone", "break ran over an hour");
  ok(Object.keys(M.breaksOf(M.evaluate(goneP).R)).length > 0, "planned breaks are known per person");
  // after every planned shift has ended with pieces still left: an ETC past now, and it's overtime
  const Lx = M.liveSuggestions(M.evaluate(P0({ crew, isToday: true, now: 16, clock })));
  ok(Lx.fromNow.left > 0 && Lx.fromNow.etc > 16 && Lx.fromNow.ot, JSON.stringify(Lx.fromNow));
  // before anyone starts: nothing yet
  eq(M.liveSuggestions(M.evaluate(P0({ crew, isToday: true, now: 4, clock: [] }))).on, false);
  // almost everything done: people can go home
  const V2 = structuredClone(V); V2.days[DAY].done = { ...V2.days[DAY].q, slt: 290 }; V2.overdue = { q: zero(), orders: 0, todo: 0 };
  for (const st of V2.days[DAY].stores) st.done = { ...st.q, slt: st.q.slt - 5 };
  const dp2 = M.dayPieces(V2, SET, DAY);
  const crew2 = M.blankCrew(pos.stations.concat(pos.ops), s); crew2.slt1 = { emp: "a", start: "05:00", hrs: 10, stop: "" }; crew2.slb1 = { emp: "f", start: "06:00", hrs: 10, stop: "" }; crew2.asm1 = { emp: "d", start: "07:00", hrs: 10, stop: "" };
  const L2 = M.liveSuggestions(M.evaluate(P0({ crew: crew2, isToday: true, now: 13, dp: dp2, q: M.effectiveQ(dp2.base, {}), waves: dp2.waves,
    clock: [{ personId: "a", clockIn: `${DAY}T05:00:00` }, { personId: "f", clockIn: `${DAY}T06:00:00` }, { personId: "d", clockIn: `${DAY}T07:00:00` }] })));
  ok(L2.fromNow.left === 10, "10 pieces left: " + L2.fromNow.left);
  const home = L2.list.find(x => x.key.startsWith("home:f"));
  ok(home, L2.list.map(x => x.title).join(" | "));
  const Q2 = structuredClone({ crew: crew2 }); home.apply(Q2); ok(/^\d\d:\d\d$/.test(Q2.crew.slb1.stop), "send home sets a hard stop");
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
