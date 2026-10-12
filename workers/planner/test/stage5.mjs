// Stage 5 server tests: pay rates from Rippling, any day's pieces, "Changes today", shuttle events, the Floor's labor
// streak and the daily summary email. Run: node workers/planner/test/stage5.mjs
import { freshDb, fakeAccess, makeEnv } from "./harness.mjs";
import { handle } from "../src/index.js";
import { ingestDay } from "../../sync/src/ingest.js";
import { localNow, prevWorkDay, nextWorkDay, addDays } from "../src/pieces.js";
import { buildSummary, scheduledSummary, mime } from "../src/summary.js";
import * as M from "../public/js/plan/model.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 4).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const A = await fakeAccess();
const { db, sqlite } = freshDb();
const sent = [];
const env = makeEnv(db, { TIMEZONE: "America/Chicago" });
const call = async (method, path, { as = "neal@towncountryclean.com", body } = {}) => {
  const headers = new Headers({ "cf-access-jwt-assertion": await A.token({ email: as }) });
  if (body) headers.set("content-type", "application/json");
  const r = await handle(new Request(`https://prodplanner.netexcleaners.com/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
  return { status: r.status, body: await r.json() };
};

const WD = [1, 2, 3, 4, 5];
const today = localNow("America/Chicago").day;
const DAY = prevWorkDay(today, WD), NEXT = nextWorkDay(DAY, WD), LATER = nextWorkDay(nextWorkDay(today, WD), WD);
await call("POST", "/users", { body: { name: "Mo Manager", email: "mo@example.com", role: "manager" } });
await call("POST", "/users", { body: { name: "Al Admin", email: "al@example.com", role: "admin" } });
await call("PUT", "/settings/runs", { body: { runs: [
  { name: "Quitman run", kind: "shuttle", stops: [{ store: "Quitman", arrive: "11:30", drive: 40, stay: 15 }] },
  { name: "Counter", kind: "counter", stops: [{ store: "Sulphur Springs", arrive: "16:00", drive: 0, stay: 0 }] },
] } });
await call("PUT", "/settings/money", { body: { payAvg: 15, laborTarget: 20 } });
const P = {};
for (const [f, tr] of [["Ana", ["slt1", "slb"]], ["Beto", ["dct", "dcb"]], ["Cora", ["iab1"]], ["Dee", ["slo"]]]) {
  P[f] = (await call("POST", "/team", { body: { firstName: f, lastName: "Test", usualStart: "06:00" } })).body.id;
  await call("PUT", `/team/${P[f]}/trainings`, { body: { trainings: tr } });
}
// Rippling rates for Ana and Beto (Beto got a raise today); Cora and Dee have none
const rate = (pid, on, c) => sqlite.prepare("INSERT INTO labor_pay_rates(id, person_id, effective_on, hourly_cents) VALUES(?,?,?,?)").run(pid + on, pid, on, c);
rate(P.Ana, "2026-01-01", 1800); rate(P.Beto, "2026-01-01", 1600); rate(P.Beto, today, 1700);

// orders due DAY (assembled), NEXT and LATER
const ts = (d, hm) => `${d}T${hm}:00-05:00`;
const orders = [], items = []; let k = 0;
const add = (due, store, pieces) => { const id = `2799${String(++k).padStart(5, "0")}`;
  orders.push({ "ID": id, "Status": "processing", "Due date": ts(due, "12:00"), "Created": ts(addDays(DAY, -3), "09:00"), "Piece Count": String(pieces.length), "Return Location": `TCC ${store}`, "Customer Id": "c1" });
  pieces.forEach(([dep, asm], i) => items.push({ "Sale Id": id, "Barcode": `${id}${i}`, "Item Status": asm ? "assembled" : "detailed", "Financial department": dep, "Item Type": "Shirt",
    "Created": ts(addDays(DAY, -3), "09:00"), "Item assembly date": asm ? ts(DAY, asm) : "", "Base price": "5" })); };
for (let i = 0; i < 12; i++) add(DAY, "Quitman", [["Laundry Tops", "09:00"], ["Laundry Bottoms", "09:30"], ["Dry Cleaning Tops", "10:00"]]);
for (let i = 0; i < 8; i++) add(DAY, "Sulphur Springs", [["Laundry Tops", "13:00"], ["Dry Cleaning Bottoms", "14:00"]]);
for (let i = 0; i < 15; i++) add(NEXT, "Quitman", [["Laundry Tops", null], ["Dry Cleaning Tops", null]]);
for (let i = 0; i < 6; i++) add(LATER, "Sulphur Springs", [["Laundry Bottoms", null], ["Laundry Tops", null], ["Laundry Tops", null]]);
await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,finished_at,status,message) VALUES('s5','smrt',?,?,'ok','live: test')").bind(new Date().toISOString(), new Date().toISOString()).run();
await ingestDay(db, { orgId: "tcc", runId: "s5", mode: "backfill", day: addDays(DAY, -3) }, orders, items);
const dep = sqlite.prepare("SELECT id FROM core_departments WHERE name='Production'").get().id;
const hoursRow = (p, d, h, fi, lo) => sqlite.prepare("INSERT INTO labor_daily_hours(person_id, work_date, department_id, location_id, hours, first_in, last_out) VALUES(?,?,?,(SELECT id FROM core_locations WHERE kind='plant' ORDER BY created_at LIMIT 1),?,?,?)").run(p, d, dep, h, fi, lo);
hoursRow(P.Ana, DAY, 8, "06:00", "14:30"); hoursRow(P.Beto, DAY, 6, "06:05", "12:35"); hoursRow(P.Cora, DAY, 4, "07:00", "11:00");

await t("pay rates: Admins and the Owner get each person's current rate; Managers don't", async () => {
  const o = (await call("GET", "/team")).body, m = (await call("GET", "/team", { as: "mo@example.com" })).body;
  eq(o.people.find(x => x.id === P.Beto).rate, 17, "Beto's raise applies today");
  eq(o.people.find(x => x.id === P.Cora).rate, null);
  ok(m.people.every(x => !("rate" in x)) && !m.ratesShown, "no rates for a manager");
  eq(M.peopleFrom(o).find(x => x.id === P.Ana).rate, 18);
});
await t("Review: labor cost uses each person's rate on that day, the average for people without one", async () => {
  const r = (await call("GET", `/review/${DAY}`)).body;
  eq(Math.round(r.labor.cost * 100) / 100, 8 * 18 + 6 * 16 + 4 * 15, "Beto at his old rate, Cora at the average");
  eq(r.labor.avgHours, 4);
  ok(r.trend.find(x => x.day === DAY).pct > 0);
  const m = (await call("GET", `/review/${DAY}`, { as: "mo@example.com" })).body;
  ok(m.labor.cost === undefined && m.labor.avgHours === undefined, "no money for managers");
});
await t("Settings: Admins see Rippling's pay-rate status", async () => {
  sqlite.prepare("INSERT INTO core_settings(org_id, app_id, key, value_json) VALUES('tcc','core','rippling_last',?)").run(JSON.stringify({ at: "2026-10-11T20:00:00Z", rows: 40, rateColumn: "Pay Rate" }));
  const s = (await call("GET", "/settings")).body.status;
  eq(s.rippling.rateColumn, "Pay Rate"); eq(s.payRates, { people: 4, withRate: 2 });
  ok(!(await call("GET", "/settings", { as: "mo@example.com" })).body.status, "managers don't get it");
});
await t("pieces: any day can be added — a later day without forecast, a past day with everything that was due", async () => {
  const v = (await call("GET", `/pieces?day=${LATER}`)).body;
  ok(v.days[LATER] && v.days[LATER].todo === 18 && v.days[LATER].expectedTotal === 18, JSON.stringify(v.days[LATER] && v.days[LATER].todo));
  const p = (await call("GET", `/pieces?day=${DAY}`)).body;
  if (DAY !== p.today) { ok(p.days[DAY].past, "past"); eq(p.days[DAY].todo, 52); eq(p.days[DAY].doneTotal, 52); }
});
await t("Changes today: plan saves are written out in plain words, with who did it", async () => {
  const day = NEXT >= today ? NEXT : nextWorkDay(today, WD);
  let r = await call("PUT", `/plan/${day}`, { as: "mo@example.com", body: { rev: 0, crew: { slt1: { personId: P.Ana, start: "06:00", hours: 7.5 }, dct1: { personId: P.Beto, start: "06:30", hours: 7.5 } }, overrides: {} } });
  eq(r.status, 200);
  r = await call("PUT", `/plan/${day}`, { as: "mo@example.com", body: { rev: 1, crew: { slb1: { personId: P.Ana, start: "05:30", hours: 7.5 }, dct1: { personId: P.Beto, start: "06:30", hours: 6, stop: "12:00" } }, overrides: { slt: 99 } } });
  eq(r.status, 200, JSON.stringify(r.body));
  await call("POST", `/plan/${day}/callouts`, { as: "mo@example.com", body: { personId: P.Cora, note: "sick" } });
  const L = (await call("GET", `/changes/${today}`)).body.list.map(x => x.text);
  const has = s => ok(L.some(x => x.includes(s)), `missing "${s}" in ${JSON.stringify(L)}`);
  has("Ana Test on SLT 1 (in 6:00 AM, 7h 30m)"); has("Ana Test moved from SLT 1 to SLB 1"); has("Ana Test: clock-in 6:00 AM → 5:30 AM");
  has("Beto Test: hours 7h 30m → 6h"); has("Beto Test: hard stop at 12:00 PM"); has("Starch tops: 99 pieces typed in"); has("Cora Test called out — sick");
  ok((await call("GET", `/changes/${today}`)).body.list.find(x => x.text.includes("moved")).who === "Mo Manager");
});
await t("shuttle events: stored once per day and key, whoever reports them", async () => {
  const e = { day: today, key: "ready:q", kind: "ready", text: "Quitman run ready: 36 pieces. OK to load the 10:50 AM shuttle." };
  eq((await call("POST", "/events", { body: e })).body.added, true);
  eq((await call("POST", "/events", { as: "mo@example.com", body: e })).body.added, false);
  eq((await call("POST", "/events", { body: { ...e, kind: "boom" } })).status, 400);
  ok((await call("GET", `/changes/${today}`)).body.list.filter(x => x.tag === "ready").length === 1);
});
await t("Floor: the labor streak counts work days at or under target (no money in it)", async () => {
  const f = (await call("GET", `/floor/${today}?streak`)).body;
  ok(f.streak && f.streak.target === 20 && typeof f.streak.days === "number", JSON.stringify(f.streak));
  ok(!("streak" in (await call("GET", `/floor/${today}`)).body), "only when asked");
});
await t("projectDay: the next day's saved crew, or a suggestion, with the projection", async () => {
  const [SET, TEAM] = [(await call("GET", "/settings")).body, (await call("GET", "/team")).body];
  const V = (await call("GET", `/pieces?day=${LATER}`)).body, plan = (await call("GET", `/plan/${LATER}`)).body;
  const N = M.projectDay({ SET, TEAM, V, plan, day: LATER, admin: true });
  ok(N && N.suggested && N.pieces === 18 && N.crew.length > 0 && N.end > 0 && N.cost > 0, JSON.stringify({ s: N?.suggested, p: N?.pieces, c: N?.crew.length, e: N?.end }));
});
await t("summary: builds today vs. plan and the next day, labor with Rippling rates", async () => {
  // publish a plan for DAY first, so the summary has a plan to compare against
  const [SET, TEAM] = [(await call("GET", "/settings")).body, (await call("GET", "/team")).body];
  const sv = await call("PUT", `/plan/${DAY}`, { body: { crew: { slt1: { personId: P.Ana, start: "06:00", hours: 8 }, dct1: { personId: P.Beto, start: "06:00", hours: 6 }, asm1: { personId: P.Cora, start: "07:00", hours: 4 }, slo: { personId: P.Dee, start: "05:30", hours: 7 } }, overrides: {} } });
  eq(sv.status, 200, JSON.stringify(sv.body));
  const V = (await call("GET", `/pieces?day=${DAY}`)).body, plan = (await call("GET", `/plan/${DAY}`)).body;
  const X = M.projectDay({ SET, TEAM, V, plan, day: DAY, admin: true }).X;
  eq((await call("POST", `/plan/${DAY}/publish`, { body: { rev: plan.rev, snapshot: M.snapshotOf(X) } })).status, 200);
  const m = await buildSummary(db, env, DAY);
  ok(/^Production summary .*: 52 of 52 due pieces done/.test(m.subject), m.subject);
  ok(m.html.includes("Quitman run") && m.html.includes("Next work day") && m.html.includes("Dee Test"), "sections");
  ok(m.html.includes("In the plan but didn&#39;t clock in") || m.html.includes("didn't clock in"), "Dee didn't clock in");
  ok(/Labor \$<\/b><\/td><td[^>]*>\$\d/.test(m.html), "plan labor $ from the replayed snapshot");
  ok(m.text.includes("TODAY - SHUTTLES AND DEADLINES") && m.text.includes("NEXT WORK DAY"), "plain text part");
  if (process.env.SHOTS) (await import("node:fs")).writeFileSync(process.env.SHOTS + "/summary.html", m.html);
  const raw = mime({ from: "reports@netexcleaners.com", to: "neal@towncountryclean.com", ...m });
  ok(raw.includes("multipart/alternative") && raw.includes("Subject: =?UTF-8?B?"), "MIME");
});
await t("summary: the cron sends once, after the set time on a work day, to the saved list", async () => {
  await call("PUT", "/settings/summary", { body: { on: true, to: ["neal@towncountryclean.com", "james@towncountryclean.com"], at: "18:10" } });
  const send = async (from, to, raw) => { sent.push({ from, to, raw }); };
  const at = hm => Date.parse(`${DAY}T${hm}:00-05:00`);
  eq((await scheduledSummary(env, { now: at("17:00"), send })).status, "not yet");
  const r = await scheduledSummary(env, { now: at("18:15"), send });
  eq(r.status, "sent", JSON.stringify(r)); eq(sent.length, 2); eq(sent[0].from, "reports@netexcleaners.com");
  eq((await scheduledSummary(env, { now: at("18:30"), send })).status, "already sent"); eq(sent.length, 2);
  const sat = (() => { let d = DAY; while (new Date(d + "T12:00:00Z").getUTCDay() !== 6) d = addDays(d, 1); return d; })();
  eq((await scheduledSummary(env, { now: Date.parse(`${sat}T19:00:00-05:00`), send })).status, "not a work day");
  ok((await call("GET", `/changes/${DAY}`)).body.list.some(x => x.text.startsWith("Daily summary emailed to neal@")), "logged");
});
await t("summary: a failed send is retried at most 3 times; settings refuse bad addresses", async () => {
  sqlite.prepare("DELETE FROM core_settings WHERE key='summary_last'").run();
  const bad = async () => { throw new Error("destination address not verified"); };
  const at = Date.parse(`${DAY}T18:20:00-05:00`);
  for (let i = 0; i < 3; i++) eq((await scheduledSummary(env, { now: at, send: bad })).status, "failed");
  eq((await scheduledSummary(env, { now: at, send: bad })).status, "gave up");
  eq((await call("PUT", "/settings/summary", { body: { to: ["not an email"] } })).status, 400);
  eq((await call("PUT", "/settings/summary", { as: "mo@example.com", body: { on: false } })).status, 403);
});
await t("summary: preview is for Admins; sending needs the email binding", async () => {
  const p = await call("GET", `/summary/preview?day=${DAY}`);
  eq(p.status, 200); ok(p.body.html.includes("<html"));
  eq((await call("GET", "/summary/preview", { as: "mo@example.com" })).status, 403);
  const s = await call("POST", "/summary/send", { body: { day: DAY, to: "neal@towncountryclean.com" } });
  ok(s.status === 200 && s.body.failed.length === 1 && /SEND_EMAIL/.test(s.body.failed[0].error), JSON.stringify(s));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
