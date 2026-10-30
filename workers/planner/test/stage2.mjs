// Tests for team, settings and the desktop import. Run: node workers/planner/test/stage2.mjs
import { readFileSync, readdirSync } from "node:fs";
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
await t("Manager sets a person's trainings; duplicates and unknowns refused; empty clears", async () => {
  const { call } = app();
  const { id } = (await call("POST", "/api/team", { body: { firstName: "Cara" } })).body;
  await withRole(call, "manager", "m@example.com");
  eq((await call("PUT", `/api/team/${id}/trainings`, { as: "m@example.com", body: { trainings: ["dcb", "slb", "iab1"] } })).status, 200);
  eq((await call("GET", "/api/team")).body.people[0].trainings.slice().sort(), ["dcb", "iab1", "slb"]);
  eq((await call("PUT", `/api/team/${id}/trainings`, { body: { trainings: ["slb", "slb"] } })).status, 400);
  eq((await call("PUT", `/api/team/${id}/trainings`, { body: { trainings: ["slb1"] } })).status, 400);
  await call("PUT", `/api/team/${id}/trainings`, { body: { trainings: [] } });
  eq((await call("GET", "/api/team")).body.people[0].trainings, []);
  await withRole(call, "viewer", "v@example.com");
  eq((await call("PUT", `/api/team/${id}/trainings`, { as: "v@example.com", body: { trainings: ["slb"] } })).status, 403);
  eq((await call("PATCH", `/api/team/${id}`, { as: "m@example.com", body: { firstName: "Z" } })).status, 403);
});
await t("station depth chart: one #1, #2 ... per station; new trainings go to the bottom; removing closes the gap", async () => {
  const { call } = app();
  const a = (await call("POST", "/api/team", { body: { firstName: "Ana" } })).body.id;
  const b = (await call("POST", "/api/team", { body: { firstName: "Beto" } })).body.id;
  const c = (await call("POST", "/api/team", { body: { firstName: "Cora" } })).body.id;
  await withRole(call, "manager", "m@example.com");
  eq((await call("PUT", "/api/team/chart/dct", { as: "m@example.com", body: { people: [b, a] } })).status, 200);
  const team = async () => Object.fromEntries((await call("GET", "/api/team")).body.people.map(p => [p.firstName, p.depth]));
  eq([(await team()).Beto.dct, (await team()).Ana.dct], [1, 2]);
  await call("PUT", `/api/team/${c}/trainings`, { body: { trainings: ["dct", "slb"] } });   // Cora joins DCT at the bottom
  eq([(await team()).Cora.dct, (await team()).Cora.slb], [3, 1]);
  await call("PUT", "/api/team/chart/dct", { body: { people: [c, b] } });                    // Ana off, Cora to #1
  const T = await team();
  eq([T.Cora.dct, T.Beto.dct, T.Ana.dct], [1, 2, undefined]);
  eq((await call("PUT", "/api/team/chart/dct", { body: { people: [a, a] } })).status, 400);
  eq((await call("PUT", "/api/team/chart/nope", { body: { people: [a] } })).status, 404);
  await withRole(call, "viewer", "v@example.com");
  eq((await call("PUT", "/api/team/chart/dct", { as: "v@example.com", body: { people: [a] } })).status, 403);
  ok((await call("GET", "/api/changes/" + new Date().toISOString().slice(0, 10))).body.list.length >= 0);
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
  eq(s.groups.day.defStart, "07:00"); eq(s.stations.length, 14); eq(s.categories.length, 6);
});
await t("saving a group validates every value", async () => {
  const { call } = app();
  eq((await call("PUT", "/api/settings/day", { body: { breakMin: 45, defStart: "06:30" } })).body.day.breakMin, 45);
  eq((await call("PUT", "/api/settings/day", { body: { breakMin: 300 } })).status, 400);
  eq((await call("PUT", "/api/settings/day", { body: { fullDay: 8 } })).status, 400, "a setting that's gone");
  eq((await call("PUT", "/api/settings/wash", { body: { on: true } })).status, 404, "a group that's gone");
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
  eq((await call("PUT", "/api/settings/day", { as: "m@example.com", body: { breakMin: 45 } })).status, 403);
  eq((await call("GET", "/api/settings", { as: "m@example.com" })).status, 200);
});
await t("speeds and stations save; bad numbers refused", async () => {
  const { call } = app();
  const r = await call("PUT", "/api/settings/production", { body: { rates: [{ type: "slb", category: "slb", perHour: 42 }], stations: [{ code: "dct3", active: false, maxHours: 5 }] } });
  eq(r.status, 200);
  eq(r.body.rates.find(x => x.type === "slb").perHour, 42);
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
