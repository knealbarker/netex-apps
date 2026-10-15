// Thu Oct 15, 2026 plan (Neal's review, Oct 14): the suggested crew as saved, with production's settings.
// Checks: break cover on SLT 1, breaks not pushed past ~3.5 h, and no "move to starch bottoms" when both presses are staffed.
// Run: node workers/planner/test/plan-oct15.mjs   (VERBOSE=1 prints each person's day)
import { freshDb, makeEnv } from "./harness.mjs";
import { allSettings } from "../src/settings.js";
import * as M from "../public/js/plan/model.js";
import { hm, stepsOf, parseTime } from "../public/js/engine/engine.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const { db } = freshDb();
const SET = await allSettings(db, makeEnv(db));
// production settings that differ from a fresh database (Oct 14)
SET.rates.find(r => r.type === "slb").perHour = 20;
SET.groups.day.breakAfter = 3;
SET.groups.wash.delay = 40;
for (const w of SET.wash) w.cycleMin = 45;
const s = M.engineSettings(SET), pos = M.positions(SET);

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
const POS = pos.stations.concat(pos.ops);
const P = { s, ...pos, people: M.peopleFrom(TEAM), crew: M.crewFromServer(serverCrew, POS, s), q: { dct: 266, dcb: 119, slt: 200, slb: 300, comf: 6, tc: 12 },
  waves: [], day: "2026-10-15", today: "2026-10-14", isToday: false, now: null, callouts: [], late: [], history: { hours: [], planned: [] }, clock: [], published: null, admin: false };
const X = M.evaluate(P), R = X.R;
const rowOf = code => R.rows.find(r => r.st.id === code);
// the same day without the Oct 14 evening rules (no minimum time on a station, breaks any time after 3 hours)
const Xold = M.evaluate({ ...P, s: { ...s, minStint: 0, breakEarliest: "" } }), Rold = Xold.R;
const oldRow = code => Rold.rows.find(r => r.st.id === code);

if (process.env.COMPARE) {
  const ends = sX => { const e = M.catEnds(sX.E, sX.R); return `SLB done ${hm(e.slb)} · SLT ${hm(e.slt)} · DCT ${hm(e.dct)} · everyone done ${hm(sX.R.end)} · OT ${sX.R.otTotal.toFixed(2)}h`; };
  console.log("NEW:", ends(X)); console.log("OLD:", ends(Xold));
  const moves = R2 => R2.rows.filter(r => r.staffed).map(r => `${P.crew[r.st.id].emp} ${stepsOf(r).length - 1}`).join(", ");
  console.log("moves NEW:", moves(R)); console.log("moves OLD:", moves(Rold));
}
if (process.env.VERBOSE) {
  for (const r of R.rows.filter(r => r.staffed)) console.log(`  ${r.st.id.padEnd(5)} ${P.crew[r.st.id].emp.padEnd(9)} in ${hm(r.x.start).padEnd(8)} break ${(r.brkS != null ? hm(r.brkS) : "-").padEnd(8)} out ${hm(r.clockOut).padEnd(8)} ${stepsOf(r).map(sp => `${sp.stn} ${hm(sp.from)}-${hm(sp.to)}`).join(", ")}`);
  for (const o of X.E.opsInfo().filter(o => o.on)) console.log(`  ${o.o.id.padEnd(5)} ${P.crew[o.o.id].emp.padEnd(9)} break ${hm(o.brkS)}`);
  console.log("  bottleneck moves:", JSON.stringify(M.bottleneckMoves(X, null, { max: 3 }).map(m => `${m.name} ${m.at} → ${hm(m.kAfter)}`)));
}

await t("SLT 1 keeps pressing while Rosenda is on break when there's a helper (rules off: Maria steps up from SLT 2)", () => {
  const ro = oldRow("slt1"), b0 = ro.brkS, b1 = ro.brkS + ro.x.b;
  const onSlt1 = Rold.rows.filter(r => r.staffed && r.st.id !== "slt1").flatMap(r => r.segs.filter(sg => sg.stn === "slt1"));
  const covered = onSlt1.filter(sg => sg.from < b1 - 0.01 && sg.to > b0 + 0.01).reduce((a, sg) => a + Math.min(sg.to, b1) - Math.max(sg.from, b0), 0);
  ok(covered >= ro.x.b - 0.05, `SLT 1 covered ${Math.round(covered * 60)} of ${Math.round(ro.x.b * 60)} min of Rosenda's ${hm(b0)} break`);
});
await t("SLT 2's helper doesn't wander off to DC tops while SLT 1 is empty", () => {
  const ma = oldRow("slt2"), ro = oldRow("slt1");
  const bad = ma.segs.filter(sg => sg.stn.startsWith("dct") && sg.from < ro.brkS + ro.x.b - 0.01 && sg.to > ro.brkS + 0.01);
  ok(!bad.length, `Maria on ${bad.map(sg => `${sg.stn} ${hm(sg.from)}`).join(", ")}`);
});
await t("rules off: nobody's break starts later than 3½ hours after clocking in", () => {
  const late = Rold.rows.filter(r => r.staffed && r.brkS != null && r.brkS - r.x.start > 3.5 + 1e-6).map(r => `${P.crew[r.st.id].emp} ${hm(r.brkS)} (in ${hm(r.x.start)})`);
  ok(!late.length, late.join(", "));
});
await t("no breaks before 9:00", () => {
  const early = R.rows.filter(r => r.staffed && r.brkS != null && r.brkS < 9 - 1e-6).map(r => `${P.crew[r.st.id].emp} ${hm(r.brkS)}`);
  ok(!early.length, early.join(", "));
  ok(X.E.opsInfo().every(o => !o.on || o.brkS >= 9 - 1e-6), "operators too");
});
await t("Neal's chain: Maria keeps SLB 2 past 7:30, Diana starts elsewhere for 2 hours, then takes SLB 2 over full", () => {
  const ma = rowOf("slt2").segs.filter(sg => sg.stn === "slb2"), di = rowOf("slb2");
  const mariaEnd = Math.max(...ma.filter(sg => sg.from < 7).map(sg => sg.to));
  ok(mariaEnd >= 9 - 1e-6, `Maria on SLB 2 until ${hm(mariaEnd)}`);
  const first = di.segs[0];
  ok(first.stn !== "slb2" && di.segs.filter(sg => sg.stn === first.stn).reduce((a, sg) => a + sg.to - sg.from, 0) >= 2 - 0.02, `Diana starts on ${first.stn} ${hm(first.from)}–${hm(first.to)}`);
  const diSlb = di.segs.find(sg => sg.stn === "slb2");
  ok(diSlb && Math.abs(diSlb.from - mariaEnd) < 2 / 60, `Diana takes SLB 2 at ${diSlb && hm(diSlb.from)}, Maria left at ${hm(mariaEnd)}`);
});
await t("Maria moves at most 3 times (was 7)", () => {
  const n = stepsOf(rowOf("slt2")).length - 1;
  ok(n <= 3, stepsOf(rowOf("slt2")).map(sp => `${sp.stn} ${hm(sp.from)}`).join(", "));
});
await t("a station's own person gets it back after their break (no one locked out by the minimum time)", () => {
  for (const code of ["asm1", "asm2", "dct2"]) {
    const r = rowOf(code), after = r.segs.filter(sg => sg.from >= r.brkS + r.x.b - 1e-6 && sg.from < r.brkS + r.x.b + 0.1);
    ok(after.some(sg => sg.stn === code), `${code}: after break ${after.map(sg => sg.stn)}`);
  }
});
await t("the two starch bottoms presses never break at the same time", () => {
  const a = rowOf("slb1"), b = rowOf("slb2");
  ok(Math.abs(a.brkS - b.brkS) >= 0.5 - 1e-6, `${hm(a.brkS)} and ${hm(b.brkS)}`);
});
await t("SLT 1 and its helper don't break at the same time", () => {
  const a = rowOf("slt1"), b = rowOf("slt2");
  ok(Math.abs(a.brkS - b.brkS) >= 0.5 - 1e-6, `${hm(a.brkS)} and ${hm(b.brkS)}`);
});
await t("no 'move to starch bottoms' while both presses are staffed", () => {
  const mv = M.bottleneckMoves(X, null, { max: 3 });
  for (const m of mv) {
    const at = parseTime(m.at);
    const busy = ["slb1", "slb2"].every(code => Object.entries(P.crew).some(([c, x]) => x.emp && M.stationAt(x, c, at) === code && at >= parseTime(x.start) - 1e-6 && at < parseTime(x.start) + 8));
    ok(!busy, `suggested ${m.name} to starch bottoms at ${hm(at)} with both presses staffed`);
  }
});

await t("each SLB press stays full through its presser's break (someone SLB-trained steps in)", () => {
  for (const code of ["slb1", "slb2"]) {
    const o = rowOf(code), b0 = o.brkS, b1 = o.brkS + o.x.b;
    const cov = R.rows.filter(r => r.staffed && r.st.id !== code).flatMap(r => r.segs.filter(sg => sg.stn === code && sg.from < b1 - 0.01 && sg.to > b0 + 0.01))
      .reduce((a, sg) => a + Math.min(sg.to, b1) - Math.max(sg.from, b0), 0);
    ok(cov >= o.x.b - 0.05, `${code}: ${Math.round(cov * 60)} of ${Math.round(o.x.b * 60)} min covered`);
  }
});
await t("an SLB press starting from empty loses its start-up minutes; a full hand-off loses nothing", () => {
  const slbDone = sX => { let n = 0; for (const r of sX.R.rows) if (r.staffed) for (const sg of r.segs) if (sg.stn.startsWith("slb")) n += sg.pcs; return n; };
  // starch bottoms done by hour h (all presses), from the simulation's 5-minute timeline
  const by = (sX, h) => { let v = 0; for (const row of sX.R.TL) if (row[0] <= h + 1e-6) v = row[2]; return v; };
  const X0 = M.evaluate({ ...P, s: { ...s, slbPrime: 0 } });
  // Carnell (SLB 1) and Maria (SLB 2) both start at 5:40: 20 min start-up each, then 20/hr
  ok(Math.abs(by(X, parseTime("06:40")) - 2 * 20 * 40 / 60) < 1, `first hour: ${by(X, parseTime("06:40")).toFixed(1)} pairs on two presses (expected ~26.7)`);
  ok(Math.abs(by(X0, parseTime("06:40")) - 40) < 1, `no start-up setting: ${by(X0, parseTime("06:40")).toFixed(1)} in the first hour (expected 40)`);
  // Maria hands SLB 2 to Diana at 7:30 with the press full: no start-up then
  const d = by(X, parseTime("07:45")) - by(X, parseTime("07:30")), d0 = by(X0, parseTime("07:45")) - by(X0, parseTime("07:30"));
  ok(Math.abs(d - d0) < 0.5, `7:30–7:45: ${d.toFixed(1)} pairs with start-up vs ${d0.toFixed(1)} without`);
  ok(slbDone(X0) >= slbDone(X) - 0.5, "start-up never adds pieces");
});

await t("board: one row per station, Maria then Diana on one SLB 2 line, Betty in Carnell's break gap", () => {
  const rows = M.stationRows(X, M.boardGroups(POS));
  const codes = rows.map(r => r.code);
  ok(["slb1", "slb2", "slt1", "slt2", "dct1", "dct2", "dct3", "dcb1", "asm1", "asm2", "slo", "dco"].every(c => codes.includes(c)), codes.join(","));
  ok(codes.indexOf("slb1") === 0 && codes.indexOf("slb2") === 1, "starch bottoms on top");
  ok(rows.filter(r => r.first).map(r => r.key).join() === "slb,slt,dct,dcb,tc,comf,asm,ops", "first row of each kind");
  const r = c => rows.find(x => x.code === c);
  ok(r("slb2").nLanes === 1 && r("slb2").lanes.map(l => l.empId).sort().join() === "diana,maria", `SLB 2: ${r("slb2").lanes.map(l => `${l.empId}@${l.lane}`)}`);
  const s1 = r("slb1"), betty = s1.lanes.find(l => l.empId === "betty"), carn = s1.lanes.find(l => l.empId === "carnell");
  ok(betty && betty.lane === carn.lane && s1.nLanes === 1, `SLB 1 lanes: ${s1.lanes.map(l => `${l.empId}@${l.lane}`)}`);
  ok(!carn.bars.some(b => b.brk), "Carnell's break isn't striped under Betty");
  ok(r("dct3").lanes.length > 0 && r("slo").label === "SL Operator" && r("slt2").label === "SLT 2 helper", `${r("slo").label} / ${r("slt2").label}`);
});

await t("people board: one line per person in station order, bars labeled with the station they're on", () => {
  const rows = M.personRows(X, M.boardGroups(POS));
  ok(rows.length === 11 && rows[0].empId === "carnell" && rows[1].empId === "diana", rows.map(r => r.empId).join(","));
  const maria = rows.find(r => r.empId === "maria"), labs = maria.lanes[0].bars.filter(b => !b.brk).map(b => b.label);
  ok(labs[0] === "SLB 2" && labs.includes("Comforters"), labs.join(","));
  ok(maria.lanes[0].bars.some(b => b.brk), "Maria's break shows");
  const betty = rows.find(r => r.empId === "betty").lanes[0].bars.filter(b => !b.brk).map(b => b.label);
  ok(betty.includes("SLB 1") && betty.includes("DCT 2"), betty.join(","));
  ok(rows.find(r => r.empId === "diana").lanes[0].bars.filter(b => !b.brk).map(b => b.label).join() .startsWith("DCT 3,SLB 2"), "Diana: DCT 3 then SLB 2");
  ok(rows.find(r => r.empId === "roderick").lanes[0].bars[0].label === "SL Operator");
  ok(rows.filter(r => r.first).map(r => r.key).join() === "slb,slt,dct,dcb,asm,ops", rows.filter(r => r.first).map(r => r.key).join());
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
