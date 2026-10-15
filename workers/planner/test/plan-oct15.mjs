// Manual plans (Neal, Oct 14: "remove all predictive planning ... let the user manually create a plan. The plan should
// repeat for the next day ... click on an employee and set their start or end time for the clicked position, including
// setting breaks"). Uses Thursday Oct 15's crew with production's settings.
// Run: node workers/planner/test/plan-oct15.mjs
import { freshDb, makeEnv } from "./harness.mjs";
import { allSettings } from "../src/settings.js";
import * as M from "../public/js/plan/model.js";
import * as F from "../public/js/plan/floor.js";
import { parseTime } from "../public/js/engine/engine.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };
const near = (a, b, m) => ok(Math.abs(a - b) < 1 / 60, `${m}: ${a} vs ${b}`);

const { db } = freshDb();
const SET = await allSettings(db, makeEnv(db));
SET.rates.find(r => r.type === "slb").perHour = 20;
const s = M.engineSettings(SET), pos = M.positions(SET), POS = pos.stations.concat(pos.ops);

const P_ = (id, name, trainings, depth) => ({ id, name, status: "active", trainings, depth });
const TEAM = { people: [
  P_("betty", "Betty", ["dct", "dcb", "tc", "comf", "slb", "iab2"], { dct: 2, dcb: 2, tc: 2, comf: 3, slb: 4, iab2: 6 }),
  P_("carnell", "Carnell", ["slb"], { slb: 1 }),
  P_("diana", "Diana", ["slb", "slt2", "dcb", "comf", "dct"], { slb: 2, slt2: 3, dcb: 3, comf: 4, dct: 5 }),
  P_("gabriel", "Gabriel", ["dco"], { dco: 1 }),
  P_("gaby", "Gaby", ["dcb", "tc", "comf", "dct"], { dcb: 1, tc: 1, comf: 5, dct: 6 }),
  P_("isela", "Isela", ["iab1", "iab2", "slt1"], { iab1: 1, iab2: 2, slt1: 3 }),
  P_("kosi", "Kosi", ["iab2", "iab1", "comf"], { iab2: 1, iab1: 2, comf: 6 }),
  P_("maria", "Maria", ["slt2", "comf", "slt1", "slb", "iab2", "dct"], { slt2: 1, comf: 1, slt1: 2, slb: 3, iab2: 3, dct: 4 }),
  P_("marina", "Marina", ["dct", "comf", "iab2"], { dct: 1, comf: 2, iab2: 5 }),
  P_("roderick", "Roderick", ["slo", "iab2"], { slo: 1, iab2: 4 }),
  P_("rosenda", "Rosenda", ["slt1", "comf"], { slt1: 1, comf: 7 }),
] };
const C = (personId, start, extra = {}) => ({ personId, start, hours: 7.5, stop: "", source: "suggested", ...extra });
const serverCrew = {
  slt1: C("rosenda", "04:50"), slt2: C("maria", "05:40", { moves: [{ at: "05:40", to: "slb2" }, { at: "07:30", to: "slt2" }] }),
  slb1: C("carnell", "05:40"), slb2: C("diana", "07:30"), dct1: C("marina", "05:40"), dct2: C("betty", "06:00"), dcb1: C("gaby", "05:30"),
  asm1: C("isela", "07:50"), asm2: C("kosi", "07:30"), slo: C("roderick", "03:50"), dco: C("gabriel", "05:50"),
};
const P0 = crew => ({ s, ...pos, people: M.peopleFrom(TEAM), crew, q: { dct: 266, dcb: 119, slt: 200, slb: 300, comf: 6, tc: 12 },
  waves: [], day: "2026-10-15", today: "2026-10-14", isToday: false, now: null, callouts: [], late: [], history: { hours: [], planned: [] }, clock: [], published: null, admin: false });
const crew0 = M.crewFromServer(serverCrew, POS, s);
const X = M.evaluate(P0(crew0)), R = X.R;
const row = code => R.rows.find(r => r.st.id === code);
const segs = code => row(code).segs.map(g => `${g.stn} ${g.from.toFixed(2)}-${g.to.toFixed(2)}`);

await t("the plan is what was entered: no simulation, no predicted finish times, no automatic breaks", () => {
  ok(R.manual, "manual plan");
  eq(segs("slb1"), ["slb1 5.67-13.67"], "Carnell 5:40 for 8 hours (no clock-out entered)");
  eq(segs("slt2"), ["slb2 5.67-7.50", "slt2 7.50-13.67"], "Maria starts on SLB 2 (move at clock-in), then SLT 2");
  ok(R.rows.every(r => !r.staffed || r.brkS == null), "no break unless one is set");
  eq(M.catEnds(X.E, R), {}, "no finish times per kind of work");
  ok(X.checks.length === 0 && X.verdict.head === "Plan", "no warnings or suggestions");
  ok(X.E.opsInfo().every(o => !o.on || o.brkS == null), "operators: no automatic break either");
});
await t("tap a bar: set the start and end of that station; first = clock-in, last = clock-out, middle = move times", () => {
  let c = M.setSegment(crew0, "slb1", 0, 5.5, 13.5, s.breakMin);
  eq([c.slb1.start, c.slb1.stop, c.slb1.hrs], ["05:30", "13:30", 8]);
  c = M.setSegment(crew0, "slt2", 0, 5.5, 8, s.breakMin);   // Maria's SLB 2 stint, longer
  eq([c.slt2.start, c.slt2.moves], ["05:30", [{ at: "05:30", to: "slb2" }, { at: "08:00", to: "slt2" }]]);
  c = M.setSegment(crew0, "slt2", 1, 9, 12, s.breakMin);    // her SLT 2 stint: moves at 9, clocks out at 12
  eq([c.slt2.moves, c.slt2.stop], [[{ at: "05:40", to: "slb2" }, { at: "09:00", to: "slt2" }], "12:00"]);
  let threw = false; try { M.setSegment(crew0, "slt2", 1, 5, 12, s.breakMin); } catch { threw = true; }
  ok(threw, "a station can't start before the one before it");
});
await t("breaks: set from–to (the bar shows the gap), change, or clear; hours follow", () => {
  let c = M.setBreak(crew0, "slb1", 9, 9.5, s.breakMin);
  eq([c.slb1.brk, c.slb1.stop, c.slb1.hrs], ["09:00-09:30", "13:40", 7.5]);
  const r = M.evaluate(P0(c)).R.rows.find(x => x.st.id === "slb1");
  eq(r.segs.map(g => [g.from, g.to]), [[parseTime("05:40"), 9], [9.5, parseTime("13:40")]]);
  near(r.brkS, 9, "break start"); near(r.brkTaken, 0.5, "break length");
  c = M.setBreak(c, "slb1", null, null, s.breakMin); eq([c.slb1.brk, c.slb1.hrs], ["", 8]);
  let threw = false; try { M.setBreak(crew0, "slb1", 15, 15.5, s.breakMin); } catch { threw = true; }
  ok(threw, "a break outside the shift is refused");
  // the server form: a start only means a break of the setting's length
  eq(M.breakOf({ brk: "09:00" }, 30), [9, 9.5]); eq(M.breakOf({ brk: "09:00-09:45" }, 30), [9, 9.75]);
});
await t("move someone to another station at a time; remove a later station", () => {
  let c = M.moveAt(crew0, "dct2", "slb1", 9, s.breakMin);
  eq(c.dct2.moves, [{ at: "09:00", to: "slb1" }]);
  eq(M.evaluate(P0(c)).R.rows.find(x => x.st.id === "dct2").segs.map(g => g.stn), ["dct2", "slb1"]);
  c = M.dropSegment(c, "dct2", 1, s.breakMin); eq(c.dct2.moves, []);
  c = M.dropSegment(crew0, "slt2", 1, s.breakMin);   // Maria: drop SLT 2, stays on SLB 2
  eq(M.segmentsOf(c.slt2, "slt2", 30).map(g => g.stn), ["slb2"]);
});
await t("a new day copies the last saved plan, without anyone who's out", () => {
  const c1 = M.setBreak(crew0, "slb1", 9, 9.5, s.breakMin);
  const copy = M.copyCrew(M.crewToServer(c1), POS, s, new Set(["kosi"]));
  eq([copy.slb1.emp, copy.slb1.start, copy.slb1.brk, copy.slb1.stop], ["carnell", "05:40", "09:00-09:30", "13:40"]);
  eq(copy.slt2.moves, crew0.slt2.moves, "moves come along");
  eq(copy.asm2.emp, "", "Kosi is out: left off");
});
await t("the Floor shows the published manual plan as entered (starts, moves, breaks, clock-outs)", () => {
  const c = M.setBreak(crew0, "slb1", 9, 9.5, s.breakMin), X2 = M.evaluate(P0(c));
  const snap = JSON.parse(JSON.stringify(M.snapshotOf(X2)));
  const FR = F.replay(snap), ev = F.events(FR, F.TXT.en);
  ok(FR.R.manual, "the Floor replays it as a manual plan");
  const carnell = ev.filter(e => e.nm === "Carnell").map(e => `${e.kind}@${e.t.toFixed(2)}`);
  eq(carnell, ["start@5.67", "brk@9.00", "end@13.67"]);
  const maria = ev.filter(e => e.nm === "Maria").map(e => `${e.kind}@${e.t.toFixed(2)}`);
  eq(maria, ["start@5.67", "move@7.50", "end@13.67"]);
  const now = F.rightNow(FR, ev, 9.1).find(p => p.nm === "Carnell");
  eq([now.state, now.brkEnd], ["break", 9.5]);
});
await t("boards: by station and by person, straight from the entered times", () => {
  const rows = M.stationRows(X, M.boardGroups(POS));
  const slb2 = rows.find(r => r.code === "slb2");
  ok(slb2.nLanes === 1 && slb2.lanes.map(l => l.empId).sort().join() === "diana,maria", "Maria then Diana share SLB 2's line");
  const pr = M.personRows(X, M.boardGroups(POS)).find(r => r.empId === "maria");
  eq(pr.lanes[0].bars.map(b => b.label), ["SLB 2", "SLT 2 helper"]);
});

await t("two people on one station at once: the second one's overlapping time is flagged, on both boards", () => {
  const no = M.stationRows(X, M.boardGroups(POS)).flatMap(r => r.lanes.flatMap(l => l.bars)).filter(b => b.dup);
  eq(no.length, 0, "Thursday's plan has no double-ups (Maria → Diana on SLB 2 is a hand-off, a break cover sits in the gap)");
  const c = M.moveAt(crew0, "dct2", "slb2", 9, s.breakMin), X2 = M.evaluate(P0(c));   // Betty onto SLB 2 at 9 while Diana's there
  const slb2 = M.stationRows(X2, M.boardGroups(POS)).find(r => r.code === "slb2");
  const betty = slb2.lanes.find(l => l.empId === "betty"), diana = slb2.lanes.find(l => l.empId === "diana");
  ok(diana.bars.every(b => !b.dup), "Diana (there first) isn't flagged");
  const d = betty.bars.filter(b => b.dup);
  ok(d.length && Math.abs(d[0].from - 9) < 0.01 && d[0].dupWith.join() === "diana", `Betty flagged from 9:00 with Diana: ${JSON.stringify(d)}`);
  const pb = M.personRows(X2, M.boardGroups(POS)).find(r => r.empId === "betty").lanes[0].bars;
  ok(pb.some(b => b.dup && b.stn === "slb2") && pb.every(b => !b.dup || b.stn === "slb2"), "People view: only Betty's SLB 2 time is flagged");
});

await t("no clock-out entered = an 8-hour day; red finish lines are pieces ÷ pieces-per-hour over the planned people", () => {
  eq(segs("slb1"), ["slb1 5.67-13.67"], "Carnell 5:40 + 8 hours");
  const f = M.finishLines(X);
  // SLB: 300 pairs at 20/hr. 5:40–7:30 Carnell + Maria (73.3), then Carnell + Diana at 40/hr → 226.7 / 40 = 5.67 h → 1:10 PM
  near(f.slb.finish, 7.5 + (300 - 2 * 20 * (7.5 - parseTime("05:40"))) / 40, "SLB done");
  eq(f.slb.people, 3);
  // SLT: 200 at 50/hr solo from 4:50, helper adds 30/hr from 7:30 (Maria back on SLT 2)
  const slt = (() => { let cum = 50 * (7.5 - parseTime("04:50")); return 7.5 + (200 - cum) / 80; })();
  near(f.slt.finish, slt, "SLT done");
  ok(f.comf && f.comf.finish == null && f.comf.people === 0, "comforters: no one planned → no line");
  // a break is a gap: Carnell's 9:00–9:30 break pushes SLB later by 30 min × 20/hr ÷ 40/hr = 15 min
  const f2 = M.finishLines(M.evaluate(P0(M.setBreak(crew0, "slb1", 9, 9.5, s.breakMin))));
  near(f2.slb.finish - f.slb.finish, 0.25, "break moves the line");
});

await t("labor at the planned pace: each person leaves at their work's red line; staying past it raises labor", () => {
  const F = M.finishLines(X), L = M.paceLabor(X), p = L.people;
  near(p.carnell.leave, F.slb.finish, "Carnell leaves when starch bottoms are done");
  near(p.diana.leave, F.slb.finish, "so does Diana");
  near(p.rosenda.leave, F.slt.finish, "Rosenda at the starch tops line");
  near(p.maria.leave, F.slt.finish, "Maria's last station is SLT 2 → starch tops line");
  near(p.roderick.leave, row("slb1") ? M.shiftOf(crew0.slo, s.breakMin).end : 0, "operators keep their scheduled clock-out");
  ok(L.total < L.sched - 1, `paced labor ${L.total.toFixed(0)} under scheduled ${L.sched.toFixed(0)}`);
  ok(L.pct < L.schedPct && L.sales > 0, "and so is the percent");
  // today, 2:00 PM: Carnell still clocked in 50 min past his line; Diana clocked out at 1:00
  const now = 14, P1 = { ...P0(crew0), isToday: true, now, day: "2026-10-15", today: "2026-10-15", dp: { D: { done: {} } },
    clock: [{ personId: "carnell", clockIn: "2026-10-15T05:40:00", clockOut: null }, { personId: "diana", clockIn: "2026-10-15T07:30:00", clockOut: "2026-10-15T13:00:00" }] };
  const X1 = M.evaluate(P1), L1 = M.paceLabor(X1), c = L1.people.carnell;
  ok(c.over && Math.abs(c.end - now) < 1e-6, "Carnell counts up to now");
  near(L1.people.diana.end, 13, "Diana counts to her real clock-out");
  const L2 = M.paceLabor(M.evaluate({ ...P1, now: 14.5 }));
  ok(L2.total > L1.total && L2.pct > L1.pct, "half an hour later the labor % is higher");
  eq(L1.over, ["carnell"], "who's past their line");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
