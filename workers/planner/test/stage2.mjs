// Tests for team, settings and the desktop import. Run: node workers/planner/test/stage2.mjs
// Uses a made-up desktop file (same shape as planner-data.json). Set DESKTOP_DIR to also import a real copy.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freshDb, fakeAccess, makeEnv } from "./harness.mjs";
import { handle } from "../src/index.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const A = await fakeAccess();
const NEAL = "neal@towncountryclean.com";
function app() {
  const { db, sqlite } = freshDb();
  const env = makeEnv(db);
  const call = async (method, path, { as = NEAL, body } = {}) => {
    const headers = new Headers({ "cf-access-jwt-assertion": await A.token({ email: as }) });
    if (body) headers.set("content-type", "application/json");
    const r = await handle(new Request(`https://prodplanner.netexcleaners.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
    return { status: r.status, body: await r.json() };
  };
  return { db, sqlite, env, call };
}
async function withRole(call, role, email) {
  await call("POST", "/api/users", { body: { name: role, email, role } });
}

const DESKTOP = {
  biz: "Town & Country Cleaners", defStart: "07:00", fullDay: 7.5, breakMin: 30, breakAfter: 4, spread: 30, allowOT: true, otMax: 2, allowMoves: true,
  allowClockOut: true, minPaid: 4, staggerBreaks: true, washOn: true, washers: 3, washSlt: 65, washSlb: 25, washComf: 2, washTc: 10, cycLaundry: 45, cycComf: 60, cycTc: 40, washDelay: 20,
  stationMax: { dcb1: 6 },
  employees: [
    { id: "e1", name: "Ana Uno", start: "05:00", skills: { slt1: true, slb1: 3, dco: 2 }, rip: "38", ripName: "Ana Uno" },
    { id: "e2", name: "Beto Dos", start: "07:30", skills: { dct2: 2, dct1: 1, dcb1: 1, nope: 1 }, rip: "40", ripName: "Beto Dos" },
  ],
  users: [{ id: "u", name: "Neal", role: "Owner", pinHash: "x" }],
  price: { dct: 6.79, dcb: 7.53, slt: 3.84, slb: 6.91, comf: 35.7, tc: 14.04 }, payAvg: 13, otMult: 1.5, laborTarget: 17, pdfMoney: false,
  rates: { slb: 20, sltSolo: 50, sltPair: 80, dct: 25, dcb: 25, tc: 6, asm: 100, comf: 3 },
  asmInclude: { dct: true, dcb: true, slt: true, slb: true, comf: false, tc: true },
  csvAliases: { comf: ["Bedspread"] },
  smrtMap: { overdue: true, deps: { dct: "Dry Cleaning Tops", dcb: "Dry Cleaning Bottoms", slt: "Laundry Tops", slb: "Laundry Bottoms", comf: "", tc: "" }, types: { comf: "Comforter", tc: "Tablecloth" } },
  rip: { depts: ["Production"], useTimes: true },
  shuttles: { runs: [{ id: "wq", name: "Winnsboro + Quitman", back: 30, stops: [{ store: "Winnsboro", cutoff: "11:00", arrive: "11:30", drive: 30, stay: 15 }, { store: "Quitman", cutoff: "11:30", arrive: "12:00", drive: 15, stay: 15 }] }],
    counter: { name: "Sulphur Springs store", store: "Sulphur Springs", ready: "16:00", cutoff: "18:00" }, warn: [45, 15], notify: true, weekStart: 1 },
};
const HISTORY = [
  { v: 1, day: "2026-09-08", actual: { people: [{ rip: "40", name: "Beto Dos", in: 3.8333, out: 12.35, hours: 8.52, open: false }, { rip: "99", name: "Gone Person", in: 5.5, out: 14, hours: 8, open: false }] } },
  { v: 1, day: "2026-10-10", plan: { at: 1791656551409, q: { dct: 4 }, price: {}, crew: [{ st: "slt1", rip: "38", name: "Ana Uno", start: "05:00", hrs: 7.5, stop: "" }, { st: "dct1", rip: "40", name: "Beto Dos", start: "07:30", hrs: 7.5, stop: "" }], metrics: { laborH: 15 } } },
];

console.log("desktop import");
await t("imports team, rankings, settings, speeds, wash, runs and history", async () => {
  const { call, sqlite } = app();
  const r = await call("POST", "/api/import/desktop", { body: { data: DESKTOP, history: HISTORY } });
  eq(r.status, 200, JSON.stringify(r.body));
  eq(r.body.peopleAdded, 3); eq(r.body.trainings, 5); eq(r.body.planDays, 1); eq(r.body.hoursRows, 2); eq(r.body.runs, 2);
  ok(r.body.skipped.some(s => s.includes("nope")), "unknown station reported");
  const team = (await call("GET", "/api/team")).body;
  eq(team.people.filter(p => p.status === "active").map(p => p.name), ["Ana Uno", "Beto Dos"]);
  eq(team.people.find(p => p.name === "Ana Uno").trainings, ["slt1", "dco", "slb"], "ordered by rank");
  eq(team.people.find(p => p.name === "Beto Dos").trainings, ["dct", "dcb"], "DCT 1 and 2 collapse into one DCT; ties keep station order");
  eq(team.trainings.find(x => x.id === "dct").stations, ["DCT 1", "DCT 2", "DCT 3"]);
  eq(team.people.find(p => p.name === "Gone Person").status, "inactive");
  eq(team.people.find(p => p.name === "Ana Uno").usualStart, "05:00");
  const s = (await call("GET", "/api/settings")).body;
  eq(s.groups.money.prices.comf, 35.7); eq(s.groups.money.payAvg, 13); eq(s.groups.smrt.itemTypes.comf, "Comforter, Bedspread");
  eq(s.rates.find(x => x.type === "slb" && x.category === "slb").perHour, 20);
  eq(s.categories.find(c => c.id === "comf").needsAssembly, false);
  eq(s.stations.find(x => x.code === "dcb1").maxHours, 6);
  eq(s.runs.map(x => [x.name, x.kind, x.stops.map(y => y.store)]), [["Winnsboro + Quitman", "shuttle", ["Winnsboro", "Quitman"]], ["Sulphur Springs store", "counter", ["Sulphur Springs"]]]);
  eq(s.runs[0].stops[0], { store: "Winnsboro", arrive: "11:30", drive: 30, stay: 15, cutoff: "11:00" });
  const hrs = sqlite.prepare("SELECT hours, first_in, last_out FROM labor_daily_hours h JOIN core_people p ON p.id=h.person_id WHERE p.payroll_id='40'").get();
  eq([hrs.hours, hrs.first_in, hrs.last_out], [8.52, "03:50", "12:21"]);
  const asg = sqlite.prepare("SELECT s.code, a.starts_at FROM plan_assignments a JOIN plan_stations s ON s.id=a.station_id ORDER BY s.sort").all();
  eq(asg.map(a => [a.code, a.starts_at]), [["slt1", "05:00"], ["dct1", "07:30"]]);
  const pub = JSON.parse(sqlite.prepare("SELECT snapshot_json FROM plan_publications").get().snapshot_json);
  eq(pub.source, "desktop"); eq(pub.metrics.laborH, 15);
});
await t("running it twice changes nothing new", async () => {
  const { call, sqlite } = app();
  await call("POST", "/api/import/desktop", { body: { data: DESKTOP, history: HISTORY } });
  const r = await call("POST", "/api/import/desktop", { body: { data: DESKTOP, history: HISTORY } });
  eq(r.body.peopleAdded, 0);
  eq(sqlite.prepare("SELECT COUNT(*) n FROM core_people").get().n, 3);
  eq(sqlite.prepare("SELECT COUNT(*) n FROM plan_publications").get().n, 1);
  eq(sqlite.prepare("SELECT COUNT(*) n FROM plan_person_trainings").get().n, 5);
  eq(sqlite.prepare("SELECT COUNT(*) n FROM plan_runs WHERE is_active=1").get().n, 2);
  eq(sqlite.prepare("SELECT COUNT(*) n FROM core_locations WHERE name='Quitman'").get().n, 1);
});
await t("only the Owner can import; a bad file is refused", async () => {
  const { call } = app();
  await withRole(call, "admin", "ad@example.com");
  eq((await call("POST", "/api/import/desktop", { as: "ad@example.com", body: { data: DESKTOP } })).status, 403);
  eq((await call("POST", "/api/import/desktop", { body: { data: { hello: 1 } } })).status, 400);
});
if (process.env.DESKTOP_DIR && existsSync(join(process.env.DESKTOP_DIR, "planner-data.json"))) {
  await t("real desktop files import cleanly", async () => {
    const { call } = app();
    const data = JSON.parse(readFileSync(join(process.env.DESKTOP_DIR, "planner-data.json"), "utf8"));
    const hdir = process.env.HISTORY_DIR;
    const history = hdir ? readdirSync(hdir).filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(join(hdir, f), "utf8"))) : [];
    const r = await call("POST", "/api/import/desktop", { body: { data, history } });
    eq(r.status, 200, JSON.stringify(r.body));
    console.log("       ", JSON.stringify(r.body));
  });
}

console.log("team");
await t("Admin adds a person; Rippling id must be unique; Viewer can read but not add", async () => {
  const { call } = app();
  const r = await call("POST", "/api/team", { body: { firstName: "Cara", lastName: "Tres", payrollId: "77", usualStart: "06:00" } });
  eq(r.status, 201);
  eq((await call("POST", "/api/team", { body: { firstName: "Dup", payrollId: "77" } })).status, 409);
  eq((await call("POST", "/api/team", { body: { firstName: "Bad", usualStart: "6am" } })).status, 400);
  await withRole(call, "viewer", "v@example.com");
  eq((await call("GET", "/api/team", { as: "v@example.com" })).body.people.length, 1);
  eq((await call("POST", "/api/team", { as: "v@example.com", body: { firstName: "X" } })).status, 403);
});
await t("Manager sets an ordered training list; duplicates and unknowns refused; empty clears", async () => {
  const { call } = app();
  const { id } = (await call("POST", "/api/team", { body: { firstName: "Cara" } })).body;
  await withRole(call, "manager", "m@example.com");
  eq((await call("PUT", `/api/team/${id}/trainings`, { as: "m@example.com", body: { trainings: ["dcb", "slb", "iab1"] } })).status, 200);
  eq((await call("GET", "/api/team")).body.people[0].trainings, ["dcb", "slb", "iab1"]);
  eq((await call("PUT", `/api/team/${id}/trainings`, { body: { trainings: ["slb", "slb"] } })).status, 400);
  eq((await call("PUT", `/api/team/${id}/trainings`, { body: { trainings: ["slb1"] } })).status, 400);
  await call("PUT", `/api/team/${id}/trainings`, { body: { trainings: [] } });
  eq((await call("GET", "/api/team")).body.people[0].trainings, []);
  await withRole(call, "viewer", "v@example.com");
  eq((await call("PUT", `/api/team/${id}/trainings`, { as: "v@example.com", body: { trainings: ["slb"] } })).status, 403);
  eq((await call("PATCH", `/api/team/${id}`, { as: "m@example.com", body: { firstName: "Z" } })).status, 403);
});
await t("migration carries old station ranks into ordered trainings", async () => {
  // replay 0001-0004, add old-style ranks, then run 0005
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const MIG = new URL("../../../db/migrations/", import.meta.url).pathname;
  const files = readdirSync(MIG).filter(f => f.endsWith(".sql")).sort();
  const q = new DatabaseSync(":memory:");
  for (const f of files.filter(f => f < "0005")) q.exec(readFileSync(MIG + f, "utf8"));
  q.exec(`INSERT INTO core_people(id,org_id,first_name,last_name) VALUES('P1','tcc','A','B');
    INSERT INTO plan_skills(person_id,station_id,rank) VALUES('P1','st-slb2',1),('P1','st-slb1',3),('P1','st-dct3',2),('P1','st-dct1',2),('P1','st-dco',2),('P1','st-asm2',3);`);
  for (const f of files.filter(f => f >= "0005")) q.exec(readFileSync(MIG + f, "utf8"));
  eq(q.prepare("SELECT training_id t FROM plan_person_trainings WHERE person_id='P1' ORDER BY priority").all().map(r => r.t), ["slb", "dct", "dco", "iab2"]);
});
await t("turning someone off sets left_on and sorts them last", async () => {
  const { call, sqlite } = app();
  const a = (await call("POST", "/api/team", { body: { firstName: "Aaron" } })).body.id;
  await call("POST", "/api/team", { body: { firstName: "Zed" } });
  eq((await call("PATCH", `/api/team/${a}`, { body: { status: "inactive" } })).status, 200);
  ok(sqlite.prepare("SELECT left_on FROM core_people WHERE id=?").get(a).left_on);
  eq((await call("GET", "/api/team")).body.people.map(p => p.firstName), ["Zed", "Aaron"]);
});

console.log("settings");
await t("defaults come back before anything is saved", async () => {
  const { call } = app();
  const s = (await call("GET", "/api/settings")).body;
  eq(s.groups.day.defStart, "07:00"); eq(s.stations.length, 12); eq(s.categories.length, 6);
});
await t("saving a group validates every value", async () => {
  const { call } = app();
  eq((await call("PUT", "/api/settings/day", { body: { fullDay: 8, defStart: "06:30" } })).body.day.fullDay, 8);
  eq((await call("PUT", "/api/settings/day", { body: { fullDay: 30 } })).status, 400);
  eq((await call("PUT", "/api/settings/day", { body: { defStart: "6:30" } })).status, 400);
  eq((await call("PUT", "/api/settings/day", { body: { bogus: 1 } })).status, 400);
  eq((await call("PUT", "/api/settings/nope", { body: {} })).status, 404);
  eq((await call("PUT", "/api/settings/money", { body: { prices: { dct: 9 } } })).body.money.prices.dcb, 8);
  eq((await call("GET", "/api/settings")).body.groups.day.defStart, "06:30");
});
await t("work days: Mon-Fri by default; must pick at least one valid day", async () => {
  const { call } = app();
  eq((await call("GET", "/api/settings")).body.groups.day.workDays, [1, 2, 3, 4, 5]);
  eq((await call("PUT", "/api/settings/day", { body: { workDays: [6, 1, 1, 2] } })).body.day.workDays, [1, 2, 6]);
  eq((await call("PUT", "/api/settings/day", { body: { workDays: [] } })).status, 400);
  eq((await call("PUT", "/api/settings/day", { body: { workDays: [7] } })).status, 400);
});
await t("Managers can't change settings", async () => {
  const { call } = app();
  await withRole(call, "manager", "m@example.com");
  eq((await call("PUT", "/api/settings/day", { as: "m@example.com", body: { fullDay: 8 } })).status, 403);
  eq((await call("GET", "/api/settings", { as: "m@example.com" })).status, 200);
});
await t("speeds, wash, stations save; bad numbers refused", async () => {
  const { call } = app();
  const r = await call("PUT", "/api/settings/production", { body: { rates: [{ type: "slb", category: "slb", perHour: 42 }], wash: [{ category: "slt", perLoad: 60, cycleMin: 50 }], stations: [{ code: "dct3", active: false, maxHours: 5 }] } });
  eq(r.status, 200);
  eq(r.body.rates.find(x => x.type === "slb").perHour, 42); eq(r.body.wash.find(x => x.category === "slt").cycleMin, 50);
  eq(r.body.stations.find(x => x.code === "dct3").active, false);
  eq((await call("PUT", "/api/settings/production", { body: { rates: [{ type: "slb", category: "slb", perHour: -1 }] } })).status, 400);
  eq((await call("PUT", "/api/settings/production", { body: { rates: [{ type: "nope", category: "slb", perHour: 1 }] } })).status, 400);
  eq((await call("GET", "/api/team")).body.trainings.find(x => x.id === "dct").stations, ["DCT 1", "DCT 2"], "turned-off station no longer listed under DCT");
});
await t("runs: save, edit, remove; bad stops refused", async () => {
  const { call } = app();
  const runs = [{ name: "Emory", kind: "shuttle", driveBack: 30, stops: [{ store: "Emory", arrive: "13:30", drive: 30, stay: 15, cutoff: "13:00" }] },
    { name: "Greenville", kind: "shuttle", driveBack: 30, stops: [{ store: "Greenville", arrive: "14:30", drive: 30, stay: 15 }] }];
  const saved = (await call("PUT", "/api/settings/runs", { body: { runs } })).body.runs;
  eq(saved.length, 2);
  const next = [{ ...saved[1], stops: [{ ...saved[1].stops[0], arrive: "15:00" }] }];
  const after = (await call("PUT", "/api/settings/runs", { body: { runs: next } })).body.runs;
  eq(after.map(r => [r.id, r.stops[0].arrive]), [[saved[1].id, "15:00"]]);
  eq((await call("PUT", "/api/settings/runs", { body: { runs: [{ name: "X", stops: [{ store: "A", arrive: "noon" }] }] } })).status, 400);
  eq((await call("PUT", "/api/settings/runs", { body: { runs: [{ name: "X", stops: [] }] } })).status, 400);
  eq((await call("PUT", "/api/settings/runs", { body: { runs: [{ name: "X", stops: [{ store: "A", arrive: "10:00" }, { store: "a", arrive: "11:00" }] }] } })).status, 400);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
