// Tests for saving, loading and publishing a day's plan. Run: node workers/planner/test/plan.mjs
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
async function setup() {
  const a = app();
  const p1 = (await a.call("POST", "/api/team", { body: { firstName: "Ana", lastName: "Uno", usualStart: "05:00" } })).body.id;
  const p2 = (await a.call("POST", "/api/team", { body: { firstName: "Beto", lastName: "Dos" } })).body.id;
  await a.call("POST", "/api/users", { body: { name: "Mo", email: "mo@example.com", role: "manager" } });
  await a.call("POST", "/api/users", { body: { name: "Vi", email: "vi@example.com", role: "viewer" } });
  return { ...a, p1, p2 };
}
const DAY = "2026-10-12";

await t("a new day has no plan, revision 0", async () => {
  const { call } = await setup();
  const r = await call("GET", `/api/plan/${DAY}`);
  eq([r.status, r.body.rev, r.body.status, r.body.crew], [200, 0, "new", {}]);
});
await t("Manager saves crew and piece overrides; they load back", async () => {
  const { call, p1, p2 } = await setup();
  const s = await call("PUT", `/api/plan/${DAY}`, { as: "mo@example.com", body: { rev: 0, crew: { slt1: { personId: p1, start: "05:00", hours: 7.5 }, dct1: { personId: p2, start: "06:30", hours: 6, stop: "13:00" } }, overrides: { comf: 12 } } });
  eq([s.status, s.body.rev], [200, 1]);
  const r = (await call("GET", `/api/plan/${DAY}`)).body;
  eq(r.crew.slt1, { personId: p1, start: "05:00", hours: 7.5, stop: "", source: "user" });
  eq(r.crew.dct1.stop, "13:00"); eq(r.overrides, { comf: 12 }); eq(r.rev, 1); eq(r.status, "draft"); eq(r.updatedBy, "Mo");
});
await t("a save based on an old revision is refused with the newer plan", async () => {
  const { call, p1, p2 } = await setup();
  await call("PUT", `/api/plan/${DAY}`, { body: { rev: 0, crew: { slt1: { personId: p1, start: "05:00", hours: 7.5 } } } });
  const r = await call("PUT", `/api/plan/${DAY}`, { as: "mo@example.com", body: { rev: 0, crew: { slt1: { personId: p2, start: "05:00", hours: 7.5 } } } });
  eq(r.status, 409); eq(r.body.latest.crew.slt1.personId, p1);
  eq((await call("PUT", `/api/plan/${DAY}`, { as: "mo@example.com", body: { rev: 1, crew: { slt1: { personId: p2, start: "05:00", hours: 7.5 } } } })).body.rev, 2);
});
await t("the revision guard holds inside the transaction (no mixed crews)", async () => {
  const { call, sqlite, p1, p2 } = await setup();
  await call("PUT", `/api/plan/${DAY}`, { body: { rev: 0, crew: { slt1: { personId: p1, start: "05:00", hours: 7.5 } } } });
  // simulate another save landing between this save's check and its write
  sqlite.prepare("UPDATE plan_days SET rev=5").run();
  const r = await call("PUT", `/api/plan/${DAY}`, { body: { crew: { dct1: { personId: p2, start: "05:00", hours: 7.5 } } } }); // no rev: checked against the current one
  eq(r.status, 200);
  const rows = sqlite.prepare("SELECT COUNT(*) n FROM plan_assignments").get().n; eq(rows, 1);
});
await t("bad crews are refused: same person twice, unknown station, bad time, viewer", async () => {
  const { call, p1 } = await setup();
  eq((await call("PUT", `/api/plan/${DAY}`, { body: { crew: { slt1: { personId: p1, start: "05:00", hours: 7.5 }, dct1: { personId: p1, start: "05:00", hours: 7.5 } } } })).status, 400);
  eq((await call("PUT", `/api/plan/${DAY}`, { body: { crew: { zz9: { personId: p1, start: "05:00", hours: 7.5 } } } })).status, 400);
  eq((await call("PUT", `/api/plan/${DAY}`, { body: { crew: { slt1: { personId: p1, start: "5am", hours: 7.5 } } } })).status, 400);
  eq((await call("PUT", `/api/plan/${DAY}`, { as: "vi@example.com", body: { crew: {} } })).status, 403);
  eq((await call("PUT", "/api/plan/12-10-2026", { body: { crew: {} } })).status, 404);
});
await t("publish: needs a saved plan, stores the snapshot, Floor reads it", async () => {
  const { call, p1 } = await setup();
  const snap = { sig: "abc", input: { q: { dct: 10 } }, metrics: { end: 13.5, laborH: 8 } };
  eq((await call("POST", `/api/plan/${DAY}/publish`, { body: { snapshot: snap } })).status, 409);
  await call("PUT", `/api/plan/${DAY}`, { body: { rev: 0, crew: { slt1: { personId: p1, start: "05:00", hours: 7.5 } } } });
  eq((await call("POST", `/api/plan/${DAY}/publish`, { body: { rev: 0, snapshot: snap } })).status, 409, "stale rev");
  const r = await call("POST", `/api/plan/${DAY}/publish`, { as: "mo@example.com", body: { rev: 1, snapshot: snap } });
  eq(r.status, 200); eq(r.body.published.sig, "abc");
  const p = (await call("GET", `/api/plan/${DAY}`)).body;
  eq([p.status, p.published.sig, p.published.by], ["published", "abc", "Mo"]);
  const f = (await call("GET", `/api/floor/${DAY}`, { as: "vi@example.com" })).body;
  eq(f.published.snapshot.metrics.end, 13.5); eq(f.published.snapshot.source, "web");
  eq((await call("POST", `/api/plan/${DAY}/publish`, { as: "vi@example.com", body: { snapshot: snap } })).status, 403);
});
await t("call-outs are kept for the day and can be undone", async () => {
  const { call, p1 } = await setup();
  const c = await call("POST", `/api/plan/${DAY}/callouts`, { body: { personId: p1, station: "slt1", note: "sick" } });
  eq(c.status, 201);
  eq((await call("GET", `/api/plan/${DAY}`)).body.callouts.map(x => [x.personId, x.station, x.note]), [[p1, "slt1", "sick"]]);
  await call("DELETE", `/api/plan/${DAY}/callouts/${c.body.id}`);
  eq((await call("GET", `/api/plan/${DAY}`)).body.callouts.length, 0);
});
await t("history: recent hours and planned stations come with the plan", async () => {
  const { call, sqlite, p1 } = await setup();
  const dep = sqlite.prepare("SELECT id FROM core_departments WHERE name='Production'").get().id;
  sqlite.prepare("INSERT INTO labor_daily_hours(person_id, work_date, department_id, location_id, hours, first_in) VALUES(?,?,?,(SELECT id FROM core_locations WHERE kind='plant' ORDER BY created_at LIMIT 1),?,?)").run(p1, "2026-10-05", dep, 8.1, "04:55");
  sqlite.prepare("INSERT INTO labor_daily_hours(person_id, work_date, department_id, location_id, hours, first_in) VALUES(?,?,?,(SELECT id FROM core_locations WHERE kind='plant' ORDER BY created_at LIMIT 1),?,?)").run(p1, "2026-10-12", dep, 3, "05:00"); // the day itself: not history
  await call("PUT", "/api/plan/2026-10-09", { body: { rev: 0, crew: { slb1: { personId: p1, start: "05:00", hours: 7.5 } } } });
  const h = (await call("GET", `/api/plan/${DAY}`)).body.history;
  eq(h.hours.map(x => [x.day, x.hours, x.firstIn]), [["2026-10-05", 8.1, "04:55"]]);
  eq(h.planned.map(x => [x.day, x.station]), [["2026-10-09", "slb1"]]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
