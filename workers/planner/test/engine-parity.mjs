// Parity test: the ported engine must plan exactly like the desktop planner 1.9.0.
// Runs the desktop's own engine code (from its index.html) and the port on the same days and compares the results.
// Run: node workers/planner/test/engine-parity.mjs   (DESKTOP_HTML / DESKTOP_DATA point at the desktop files; skipped if absent)
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { createEngine } from "../public/js/engine/engine.js";

const HTML = process.env.DESKTOP_HTML || "/home/claude/pp/new/app/index.html";
const DATA = process.env.DESKTOP_DATA || "/mnt/user-data/uploads/Production Planner/planner-data.json";
if (!existsSync(HTML)) { console.log("desktop source not found; parity test skipped"); process.exit(0); }

const src = readFileSync(HTML, "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("marker not found: " + a); return src.slice(i, j); };
const engineSrc = cut("/* ================= planning engine ================= */", "// Ideas the plan can't do on its own");
const moneySrc = cut("function opsInfo(){", "const fmt$=n=>");

const STATIONS = [
  { id: "slt1", type: "slt", label: "SLT 1" }, { id: "slt2", type: "slt2", label: "SLT 2 (helper)" },
  { id: "slb1", type: "slb", label: "SLB 1" }, { id: "slb2", type: "slb", label: "SLB 2" },
  { id: "dct1", type: "dct", label: "DCT 1" }, { id: "dct2", type: "dct", label: "DCT 2" }, { id: "dct3", type: "dct", label: "DCT 3" },
  { id: "dcb1", type: "dcb", label: "DCB" }, { id: "asm1", type: "asm", label: "IAB 1" }, { id: "asm2", type: "asm", label: "IAB 2" },
];
const OPS = [{ id: "slo", type: "ops", label: "Starch Laundry Operator" }, { id: "dco", type: "ops", label: "Dry Cleaning Operator" }];

// a deterministic random source so failures can be replayed
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const desk = existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : null;
const employees = desk ? desk.employees : [
  { id: "a", name: "A", start: "05:00", skills: { slt1: 1, slt2: 2, slb1: 3, dct1: 2 } }, { id: "b", name: "B", start: "05:30", skills: { slb1: 1, slb2: 1, dct2: 2 } },
  { id: "c", name: "C", start: "06:00", skills: { dct1: 1, dct2: 1, dct3: 1, dcb1: 2 } }, { id: "d", name: "D", start: "07:00", skills: { dcb1: 1, asm1: 2, slo: 1 } },
  { id: "e", name: "E", start: "05:35", skills: { asm1: 1, asm2: 1, slt2: 3 } }, { id: "f", name: "F", start: "07:00", skills: { dco: 1, dct3: 3, slb2: 2 } },
];
const base = {
  defStart: "07:00", fullDay: 7.5, breakMin: 30, breakAfter: 4, spread: 30, allowOT: true, otMax: 2, allowMoves: true, allowClockOut: true, minPaid: 4, staggerBreaks: true,
  washOn: true, washers: 3, washSlt: 65, washSlb: 25, washComf: 2, washTc: 10, cycLaundry: 45, cycComf: 60, cycTc: 40, washDelay: 20, stationMax: {},
  rates: { slb: 20, sltSolo: 50, sltPair: 80, dct: 25, dcb: 25, tc: 6, asm: 100, comf: 3 },
  asmInclude: { dct: true, dcb: true, slt: true, slb: true, comf: true, tc: true },
  price: { dct: 6.79, dcb: 7.53, slt: 3.84, slb: 6.91, comf: 35.7, tc: 14.04 }, payAvg: 13, otMult: 1.5, laborTarget: 17,
  ...(desk ? Object.fromEntries(["defStart", "fullDay", "breakMin", "breakAfter", "spread", "allowOT", "otMax", "allowMoves", "allowClockOut", "minPaid", "staggerBreaks",
    "washOn", "washers", "washSlt", "washSlb", "washComf", "washTc", "cycLaundry", "cycComf", "cycTc", "washDelay", "rates", "asmInclude", "price", "payAvg", "otMult", "laborTarget"].filter(k => desk[k] !== undefined).map(k => [k, desk[k]])) : {}),
};

function desktopRun(S) {
  const ctx = { S, STATIONS, OPS, POS: STATIONS.concat(OPS), Math, Object, Array, Infinity, isFinite, JSON, Number, String, Map, Set };
  vm.createContext(ctx);
  vm.runInContext(`
    const EPS=1e-6; const CAT_FULL={dct:1,dcb:1,slt:1,slb:1,comf:1,tc:1};
    const empById=id=>S.employees.find(e=>e.id===id)||null;
    const trained=(empId,stId)=>{const e=empById(empId); return !!(e&&e.skills&&e.skills[stId]);};
    const rankOf=(e,stId)=>{ if(!e||!e.skills) return 0; const v=e.skills[stId]; return v===true?1:(+v||0); };
    const payRate=posId=>{const e=empById(S.crew[posId].emp); return (e&&+e.rate>0)?+e.rate:S.payAvg;};
    function parseTime(t){ if(!t||!/^\\d{1,2}:\\d{2}/.test(t)) return null; const [h,m]=t.split(":").map(Number); return h+m/60; }
    ${engineSrc}
    ${moneySrc}
    globalThis.__R = buildPlan(S.q, S); globalThis.__M = __R.empty ? null : money(__R);`, ctx);
  return { R: ctx.__R, M: ctx.__M };
}

function portRun(S) {
  const E = createEngine({
    ...S, cycSlt: S.cycLaundry, cycSlb: S.cycLaundry, stations: STATIONS, ops: OPS, trainingOf: Object.fromEntries(STATIONS.concat(OPS).map(x => [x.id, x.id])),
    people: S.employees.map(e => ({ id: e.id, name: e.name, start: e.start })),
    rankOf: (e, stId) => { const d = S.employees.find(x => x.id === (e && e.id)); if (!d || !d.skills) return 0; const v = d.skills[stId]; return v === true ? 1 : (+v || 0); },
  });
  const R = E.buildPlan(S.q);
  return { R, M: R.empty ? null : E.money(R) };
}

const close = (a, b, tol = 1e-6) => (a == null && b == null) || (a === Infinity && b === Infinity) || Math.abs(a - b) <= tol;
function compare(a, b) {
  const diffs = [];
  const chk = (name, x, y) => { if (!close(x, y)) diffs.push(`${name}: desktop ${x} port ${y}`); };
  if (!!a.R.empty !== !!b.R.empty) return [`empty: desktop ${a.R.empty} port ${b.R.empty}`];
  if (a.R.empty) return diffs;
  chk("end", a.R.end, b.R.end); chk("otTotal", a.R.otTotal, b.R.otTotal); chk("short", a.R.P.shortTotal, b.R.P.shortTotal); chk("spread", a.R.spread, b.R.spread);
  a.R.rows.forEach((r, i) => { const p = b.R.rows[i]; for (const k of ["clockOut", "finish", "ot", "brkS", "work", "comf", "idle"]) chk(`${r.st.id}.${k}`, r[k], p[k]);
    if (r.tasks.length !== p.tasks.length) diffs.push(`${r.st.id}.tasks: ${r.tasks.length} vs ${p.tasks.length}`); });
  const la = a.R.TL[a.R.TL.length - 1], lb = b.R.TL[b.R.TL.length - 1]; la.forEach((v, i) => chk(`TL.last[${i}]`, v, lb[i]));
  chk("TL.length", a.R.TL.length, b.R.TL.length);
  chk("money.total", a.M.total, b.M.total); chk("money.revenue", a.M.revenue, b.M.revenue);
  return diffs;
}

function scenario(i) {
  const q = { dct: Math.round(rnd() * 420), dcb: Math.round(rnd() * 160), slt: Math.round(rnd() * 420), slb: Math.round(rnd() * 380), comf: Math.round(rnd() * 16), tc: Math.round(rnd() * 20) };
  const crew = Object.fromEntries(STATIONS.concat(OPS).map(p => [p.id, { emp: "", hrs: base.fullDay, start: base.defStart, stop: "" }]));
  const pool = employees.slice().sort(() => rnd() - 0.5);
  const n = Math.max(2, Math.floor(rnd() * pool.length) + 1);
  for (const e of pool.slice(0, n)) {
    const spots = STATIONS.concat(OPS).filter(p => !crew[p.id].emp && (rnd() < 0.85 ? e.skills && e.skills[p.id] : true));
    if (!spots.length) continue;
    const p = spots[Math.floor(rnd() * spots.length)];
    const hrs = rnd() < 0.8 ? base.fullDay : Math.round((4 + rnd() * 5) * 4) / 4;
    const start = rnd() < 0.7 ? (e.start || base.defStart) : `0${3 + Math.floor(rnd() * 5)}:${["00", "15", "30", "45"][Math.floor(rnd() * 4)]}`;
    const stop = rnd() < 0.1 ? `1${2 + Math.floor(rnd() * 3)}:00` : "";
    crew[p.id] = { emp: e.id, start, hrs, stop };
  }
  const S = JSON.parse(JSON.stringify({ ...base, q, crew, employees }));
  if (i % 5 === 1) S.allowMoves = false;
  if (i % 7 === 2) S.allowOT = false;
  if (i % 6 === 3) S.stationMax = { dct1: 3, slb1: 4 };
  if (i % 9 === 4) S.washOn = false;
  if (i % 4 === 0) S.staggerBreaks = false;
  return S;
}

let fail = 0;
const N = +(process.env.PARITY_N || 60);
for (let i = 0; i < N; i++) {
  const S = scenario(i);
  const d = compare(desktopRun(JSON.parse(JSON.stringify(S))), portRun(JSON.parse(JSON.stringify(S))));
  if (d.length) { fail++; console.log(`  FAIL scenario ${i}: ${d.slice(0, 6).join("; ")}`); }
}
console.log(`${N - fail} of ${N} scenarios plan identically${desk ? " (real team and settings)" : ""}`);
process.exit(fail ? 1 : 0);
