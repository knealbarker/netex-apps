// Tablecloths on any open press, two people at the comforter table, regular time before overtime (Neal, Oct 13).
// Replays the morning of Oct 13: Betty (DCT, trained on Tablecloths) was sent home at 12:33 while Gaby (DCB) pressed
// tablecloths alone into overtime, because Tablecloths was one spot for one person. Run: node workers/planner/test/stations-share.mjs
import { freshDb, makeEnv } from "./harness.mjs";
import { allSettings } from "../src/settings.js";
import * as M from "../public/js/plan/model.js";
import { createEngine } from "../public/js/engine/engine.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const { db } = freshDb();
const SET = await allSettings(db, makeEnv(db));
const s = M.engineSettings(SET, {});
const pos = M.positions(SET);
// Oct 13's rates: DCT/DCB 25/h, tablecloths 6/h, comforters 3/h
s.rates = { ...s.rates, dct: 25, dcb: 25, tc: 6, comf: 3 };
const people = [
  { id: "betty", name: "Betty Cruz", trainings: ["dct", "slb", "tc", "comf"] },
  { id: "marina", name: "Marina Cortes", trainings: ["dct"] },
  { id: "gaby", name: "Gaby Rivera", trainings: ["dcb", "tc", "comf"] },
].map(p => ({ ...p, status: "active", usualStart: "06:00" }));
const PEOPLE = M.peopleFrom({ people });
const crew = (extra = {}) => { const c = M.blankCrew(pos.stations.concat(pos.ops), s);
  Object.assign(c.dct1, { emp: "betty", start: "06:00", hrs: 7.5 }); Object.assign(c.dct2, { emp: "marina", start: "05:40", hrs: 7.5 });
  Object.assign(c.dcb1, { emp: "gaby", start: "05:30", hrs: 7.5 }); for (const [k, v] of Object.entries(extra)) Object.assign(c[k], v); return c; };
const run = (q, cr = crew(), S = s) => {
  const E = createEngine({ ...S, washOn: false, q, crew: cr, stations: pos.stations, ops: pos.ops, people: PEOPLE, trainingOf: pos.trainingOf });
  const R = E.buildPlan(q); const row = id => R.rows.find(r => r.st.id === id);
  return { R, row, ot: R.rows.reduce((a, r) => a + (r.ot || 0), 0) };
};
const Q = { dct: 311 * 0.53, dcb: 122, slt: 0, slb: 0, comf: 0, tc: 24 };   // DC tops split about evenly with Marina

await t("Oct 13: Betty joins Gaby on tablecloths on her open press instead of going home; no overtime", async () => {
  const { row, ot } = run(Q);
  const b = row("dct1"), g = row("dcb1");
  ok(b.segs.some(x => x.stn === "tc" && x.pcs > 1), "Betty presses tablecloths: " + JSON.stringify(b.segs.map(x => [x.stn, +x.from.toFixed(2), +x.to.toFixed(2)])));
  ok(ot < 0.05, `overtime ${ot.toFixed(2)} h`);
  ok(g.segs.some(x => x.stn === "tc"), "Gaby still does tablecloths too");
});

await t("tablecloths only use presses nobody is on: with every DCT/DCB press busy, nobody can press tablecloths", async () => {
  const E = createEngine({ ...s, washOn: false, q: Q, crew: crew(), stations: pos.stations.filter(x => !["dct3"].includes(x.id)), ops: pos.ops, people: PEOPLE, trainingOf: pos.trainingOf });
  const R = E.buildPlan({ ...Q, dct: 400, dcb: 400 });
  // presses: dct1, dct2, dcb1 all have their own work all day, so no tablecloths until one frees up
  const tcBefore = R.rows.flatMap(r => r.segs).filter(x => x.stn === "tc" && x.from < 13);
  ok(!tcBefore.length, "tablecloths pressed while every press was in use: " + JSON.stringify(tcBefore));
});

await t("comforters: two people at the table, together 20% faster than one", async () => {
  const one = run({ dct: 0, dcb: 0, slt: 0, slb: 0, comf: 12, tc: 0 }, crew({ dct2: { emp: "" } }), { ...s, comfMax: 1, breakEarliest: "" });   // speeds only: breaks at the 3-hour mark
  const two = run({ dct: 0, dcb: 0, slt: 0, slb: 0, comf: 12, tc: 0 }, crew({ dct2: { emp: "" } }), { ...s, comfMax: 2, comfExtra: 0.2, breakEarliest: "" });
  const endOf = R => Math.max(...R.rows.flatMap(r => r.segs).filter(x => x.stn === "comf").map(x => x.to));
  const a = endOf(one.R) - 6, b = endOf(two.R) - 6;
  ok(Math.abs(a / b - 1.2) < 0.05, `one person ${a.toFixed(2)} h vs two ${b.toFixed(2)} h`);
  const people2 = new Set(two.R.rows.filter(r => r.segs.some(x => x.stn === "comf")).map(r => r.st.id));
  ok(people2.size === 2, "two people at the table: " + [...people2]);
});

await t("regular time before overtime: someone with regular hours left takes over a one-person press from a co-worker going into overtime", async () => {
  // Ana on the starch tops press 5:00–1:00; Cora (trained on it) finishes starch bottoms at noon with regular hours to 4:00.
  const P2 = M.peopleFrom({ people: [
    { id: "ana", name: "Ana", trainings: ["slt1"] }, { id: "cora", name: "Cora", trainings: ["slb", "slt1"] }].map(p => ({ ...p, status: "active", usualStart: "05:00" })) });
  const c = M.blankCrew(pos.stations.concat(pos.ops), s);
  Object.assign(c.slt1, { emp: "ana", start: "05:00", hrs: 7.5 }); Object.assign(c.slb1, { emp: "cora", start: "08:00", hrs: 7.5 });
  const q = { dct: 0, dcb: 0, slt: 50 * 9, slb: s.rates.slb * 3.5, comf: 0, tc: 0 };
  const E = createEngine({ ...s, washOn: false, q, crew: c, stations: pos.stations, ops: pos.ops, people: P2, trainingOf: pos.trainingOf });
  const R = E.buildPlan(q), a = R.rows.find(r => r.st.id === "slt1"), b = R.rows.find(r => r.st.id === "slb1");
  ok(!(a.ot > 0.05), `Ana's overtime ${a.ot}`);
  ok(b.segs.some(x => x.stn === "slt1" && x.from >= 12.9), "Cora takes over the press: " + JSON.stringify(b.segs.map(x => [x.stn, +x.from.toFixed(2), +x.to.toFixed(2)])));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
