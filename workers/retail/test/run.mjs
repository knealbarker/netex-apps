// Server tests for the Retail Snapshot. Run: node workers/retail/test/run.mjs
import { freshDb, fakeAccess, makeEnv } from "./harness.mjs";
import { handle } from "../src/index.js";
import { seed } from "./seed.mjs";
import { addDays, markOvertime, weekStartOf } from "../src/snapshot.js";
import { buildSummary, scheduledSummary, mime } from "../src/summary.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const near = (a, b, m = "") => { if (a == null || Math.abs(a - b) > 0.011) throw new Error(`${m} expected ${b} got ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const A = await fakeAccess();
const NEAL = "neal@towncountryclean.com";
const LAST = "2026-10-09", TODAY = "2026-10-10", FROM = addDays(LAST, -6);
const NOW = "2026-10-10T12:00:00-05:00";   // Sam clocked in at 8 am -> 4 h so far

const { db, sqlite } = freshDb();
const env = makeEnv(db, { NOW });
const seeded = await seed(db, { last: LAST, days: 7, today: TODAY });
let fakeSend = null;
const call = async (method, path, { as = NEAL, body } = {}) => {
  const headers = new Headers();
  if (as) headers.set("cf-access-jwt-assertion", await A.token({ email: as }));
  if (body) headers.set("content-type", "application/json");
  const r = await handle(new Request(`https://retailview.netexcleaners.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl, send: fakeSend });
  const type = r.headers.get("content-type") || "";
  return { status: r.status, body: type.includes("json") ? await r.json() : await r.text() };
};
const addUser = (email, roles) => {
  const id = "01" + Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(24, "0");
  sqlite.prepare("INSERT INTO core_users(id, org_id, email, display_name) VALUES(?,?,?,?)").run(id, "tcc", email, email.split("@")[0]);
  for (const [app, role] of Object.entries(roles)) sqlite.prepare("INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES(?,?,?,?)").run(id, app, role, "x");
  return id;
};
addUser("pm@x.com", { planner: "manager" });
addUser("admin@x.com", { retail: "admin" });
addUser("mgr@x.com", { retail: "manager" });

console.log("sign-in and roles");
await t("Neal is Owner of the Retail Snapshot (migration 0007)", async () => {
  const r = await call("GET", "/api/me"); eq(r.status, 200); eq(r.body.user.role, "owner"); eq(r.body.today, TODAY); eq(r.body.weekStart, 1);
});
await t("a planner-only user is told they have no Retail Snapshot role", async () => {
  const r = await call("GET", "/api/snapshot?from=2026-10-01&to=2026-10-02", { as: "pm@x.com" }); eq(r.status, 403); eq(r.body.reason, "no_role");
});
await t("no sign-in -> 401, pages too", async () => {
  eq((await call("GET", "/api/me", { as: null })).status, 401); eq((await call("GET", "/", { as: null })).status, 401);
});
await t("page served once signed in", async () => { const r = await call("GET", "/"); eq(r.status, 200); ok(String(r.body).includes("Retail Snapshot")); });

console.log("Rippling: every department, by location");
await t("seed: retail, workshop and hub hours stored with pay rates", async () => {
  eq(seeded.rippling.departments, { Retail: 36, Production: 35, "Laundry Hub": 7 }); ok(seeded.rippling.rates >= 9, seeded.rippling.rates);
});

console.log("snapshot numbers");
const snap = (await call("GET", `/api/snapshot?from=${FROM}&to=${LAST}`)).body;
const store = n => snap.stores.find(s => s.name === n);
await t("stores listed, Winnsboro rolled into Sulphur Springs as its own line", async () => {
  eq(snap.stores.map(s => s.name).sort(), ["Emory", "Greenville", "Quitman", "Sulphur Springs"]);
  eq(store("Sulphur Springs").parts.map(p => p.name).sort(), ["Sulphur Springs", "Winnsboro"]);
  near(store("Sulphur Springs").parts.find(p => p.name === "Winnsboro").sales, 1050);
});
await t("sales = pre-tax value of orders detailed in the range; deleted orders left out", async () => {
  near(store("Sulphur Springs").sales, 9450); near(store("Quitman").sales, 2240); near(store("Emory").sales, 3920); near(store("Greenville").sales, 3640);
  near(snap.totals.retail.sales, 19250); eq(snap.totals.retail.orders, 63);
});
await t("revenue = pre-tax value paid in the range (by paid date)", async () => {
  near(store("Sulphur Springs").revenue, 8100); near(store("Quitman").revenue, 0); near(store("Emory").revenue, 3360); near(snap.totals.retail.revenue, 14580);
});
await t("collected = share of the range's sales already paid", async () => {
  near(snap.totals.retail.collectedPct, 88.36); near(store("Quitman").collectedPct, 0); near(store("Emory").collectedPct, 100);
});
await t("hours by store from Rippling work location", async () => {
  near(store("Sulphur Springs").hours, 112); near(store("Quitman").hours, 56); near(store("Emory").hours, 42); near(store("Greenville").hours, 56); near(snap.totals.retail.hours, 266);
});
await t("labor $ uses each person's rate, the department average when there's none", async () => {
  near(store("Sulphur Springs").cost, 1680); near(store("Quitman").cost, 840); eq(store("Quitman").estPct, 100); eq(store("Emory").estPct, 0);
  near(store("Emory").cost, 588); near(snap.totals.retail.cost, 4004);
});
await t("labor % = labor $ / revenue; none when there's no revenue", async () => {
  near(store("Emory").laborPct, 17.5); near(snap.totals.retail.laborPct, 27.46); eq(store("Quitman").laborPct, null);
});
await t("Workshop and Laundry Hub: hours, labor $ and % of company revenue", async () => {
  const ws = snap.plants.find(p => p.name === "Workshop"), hub = snap.plants.find(p => p.name === "Laundry Hub");
  near(ws.hours, 280); near(ws.cost, 4200); near(hub.cost, 896); near(snap.totals.plant.laborPct, 34.95);
  near(snap.totals.company.cost, 9100); near(snap.totals.company.laborPct, 62.41);
});
await t("daily rows add up to the totals", async () => {
  eq(snap.daily.length, 7);
  near(snap.daily.reduce((t, d) => t + d.retail.sales, 0), 19250);
  near(snap.daily.reduce((t, d) => t + d.lines["Sulphur Springs"].hours, 0), 112);
  eq(snap.daily[0].retail.revenue, 0); near(snap.daily[1].retail.revenue, 2430);
});
await t("people: hours per person per day at each store", async () => {
  const sam = snap.people.find(p => p.name === "Sam Counter");
  eq(sam.line, "Sulphur Springs"); near(sam.hours, 56); eq(sam.days[LAST], 8);
});
await t("previous period of the same length compared (empty here)", async () => {
  eq(snap.prevRange, { from: addDays(FROM, -7), to: addDays(FROM, -1) }); near(snap.totals.company.prev.sales, 0);
});
await t("today: live hours from punches so far", async () => {
  const d = (await call("GET", `/api/snapshot?from=${TODAY}&to=${TODAY}`)).body;
  near(d.stores.find(s => s.name === "Sulphur Springs").hours, 4);
  near(d.stores.find(s => s.name === "Sulphur Springs").revenue, 1350 + 0 * 1);  // yesterday's SS orders paid today
  ok(d.people.find(p => p.name === "Sam Counter").live);
});
await t("bad ranges refused", async () => {
  eq((await call("GET", "/api/snapshot?from=2026-10-09&to=2026-10-01")).status, 400);
  eq((await call("GET", "/api/snapshot?from=2024-01-01&to=2026-10-01")).status, 400);
  eq((await call("GET", "/api/snapshot?from=x&to=y")).status, 400);
});

console.log("who sees labor cost");
await t("Managers see sales, revenue and hours but not labor $ or %", async () => {
  const d = (await call("GET", `/api/snapshot?from=${FROM}&to=${LAST}`, { as: "mgr@x.com" })).body;
  eq(d.labor, false); ok(!("cost" in d.stores[0]) && !("laborPct" in d.totals.retail)); ok(d.stores[0].hours > 0);
  ok(!("cost" in d.daily[1].retail));
});
await t("Settings can let Managers see labor", async () => {
  const cur = (await call("GET", "/api/settings", { as: "admin@x.com" })).body.settings;
  eq((await call("PUT", "/api/settings", { as: "admin@x.com", body: { ...cur, managersSeeLabor: true } })).status, 200);
  const d = (await call("GET", `/api/snapshot?from=${FROM}&to=${LAST}`, { as: "mgr@x.com" })).body;
  eq(d.labor, true); near(d.totals.retail.laborPct, 27.46);
  await call("PUT", "/api/settings", { as: "admin@x.com", body: { ...cur, managersSeeLabor: false } });
});

console.log("settings");
await t("Managers can't open or change settings", async () => {
  eq((await call("GET", "/api/settings", { as: "mgr@x.com" })).status, 403);
  eq((await call("PUT", "/api/settings", { as: "mgr@x.com", body: {} })).status, 403);
});
await t("burden % and average rates change labor $", async () => {
  const cur = (await call("GET", "/api/settings")).body.settings;
  await call("PUT", "/api/settings", { body: { ...cur, burdenPct: 10, avgRates: { ...cur.avgRates, Retail: 12 } } });
  const d = (await call("GET", `/api/snapshot?from=${FROM}&to=${LAST}`)).body;
  near(d.stores.find(s => s.name === "Quitman").cost, 56 * 12 * 1.1); near(d.stores.find(s => s.name === "Emory").cost, 588 * 1.1);
  await call("PUT", "/api/settings", { body: cur });
});
await t("un-rolling Winnsboro makes it its own store", async () => {
  const cur = (await call("GET", "/api/settings")).body.settings;
  await call("PUT", "/api/settings", { body: { ...cur, rollup: {} } });
  const d = (await call("GET", `/api/snapshot?from=${FROM}&to=${LAST}`)).body;
  ok(d.stores.some(s => s.name === "Winnsboro")); near(d.stores.find(s => s.name === "Sulphur Springs").sales, 8400);
  await call("PUT", "/api/settings", { body: cur });
});
await t("bad settings refused with a clear message", async () => {
  const r = await call("PUT", "/api/settings", { body: { targetRetail: 300 } }); eq(r.status, 400); ok(/Store labor target/.test(r.body.error));
});
await t("settings screen data: locations, departments, rate coverage, rate column", async () => {
  const r = (await call("GET", "/api/settings")).body;
  ok(r.locations.some(l => l.name === "Laundry Hub" && l.kind === "plant")); ok(r.departments.includes("Retail")); eq(r.rippling.rateColumn, "pay_rate");
});

console.log("Rippling CSV import");
const IMPORT = ["time_entry_id,employee_name,employee_number,title,department_path,work_location,time_entry_date,clock_in_local,clock_out_local,duration_hours,timezone,status,clock_in_source,clock_out_source",
  "x1,Gap Filler,900,Retail Advisor,Retail,TCC Emory Retail,09/20/2026,09/20/2026 08:00 AM CDT,09/20/2026 02:00 PM CDT,6,America/Chicago,PAID,Web,Web"].join("\n");
await t("Admins can't load a CSV; the Owner can, and today's punches stay", async () => {
  eq((await call("POST", "/api/import/rippling", { as: "admin@x.com", body: { csv: IMPORT } })).status, 403);
  const before = sqlite.prepare("SELECT COUNT(*) n FROM labor_clock_today").get().n;
  const r = await call("POST", "/api/import/rippling", { body: { csv: IMPORT } });
  eq(r.status, 200); eq(r.body.used, 1); eq(sqlite.prepare("SELECT COUNT(*) n FROM labor_clock_today").get().n, before);
  const d = (await call("GET", "/api/snapshot?from=2026-09-20&to=2026-09-20")).body;
  near(d.stores.find(s => s.name === "Emory").hours, 6);
});
await t("a wrong file is refused with the reason", async () => {
  const r = await call("POST", "/api/import/rippling", { body: { csv: "a,b\n1,2" } }); eq(r.status, 400); ok(/missing/.test(r.body.error));
});

console.log("users");
await t("Users & access works per app: roles here are for the Retail Snapshot", async () => {
  const r = await call("GET", "/api/users"); eq(r.status, 200);
  eq(r.body.users.find(u => u.email === "pm@x.com").role, null);
  eq((await call("GET", "/api/users", { as: "mgr@x.com" })).status, 403);
});

console.log("overtime");
await t("hours past 40 in a work week fall on the last days, across stores", async () => {
  const rows = [["2026-10-05", 10, "A"], ["2026-10-06", 10, "A"], ["2026-10-07", 10, "B"], ["2026-10-08", 8, "A"], ["2026-10-09", 6, "B"], ["2026-10-12", 9, "A"]]
    .map(([day, hours, loc]) => ({ pid: "p1", day, hours, loc }));
  markOvertime(rows, { weekStart: 1, after: 40 });
  eq(rows.map(r => r.otHours), [0, 0, 0, 0, 4, 0]);
  eq(weekStartOf("2026-10-11", 1), "2026-10-05"); eq(weekStartOf("2026-10-11", 0), "2026-10-11");
});
await t("a range starting mid-week still counts the week's earlier days", async () => {
  const { db: odb } = freshDb(); const oenv = makeEnv(odb, { NOW });
  await seed(odb, { last: LAST, days: 14, today: TODAY });          // everyone works 7 days x 8 h = 56 h a week
  const call2 = async q => (await handle(new Request(`https://retailview.netexcleaners.com/api/snapshot?${q}`, { headers: { "cf-access-jwt-assertion": await A.token({ email: NEAL }) } }), oenv, { fetchImpl: A.fetchImpl })).json();
  // Fri Oct 9 alone: Sam already has 32 h Mon-Thu, so Fri's 8 h are straight time (40); week of Sep 28: Sat+Sun past 40
  const fri = await call2("from=2026-10-09&to=2026-10-09");
  eq(fri.stores.find(x => x.name === "Sulphur Springs").otHours, 0);
  const sun = await call2("from=2026-10-04&to=2026-10-04");
  const ss = sun.stores.find(x => x.name === "Sulphur Springs");
  eq(ss.otHours, 16);                                               // Sam and Jo: Sunday is hours 49-56 of their week
  near(ss.cost, 16 * 15 * 1.5);
  eq(sun.overtime, { after: 40, multiplier: 1.5 });
  const week = await call2("from=2026-09-28&to=2026-10-04");
  near(week.stores.find(x => x.name === "Emory").otHours, 2);       // 7 x 6 h = 42
});
await t("overtime can be turned off", async () => {
  const cur = (await call("GET", "/api/settings")).body.settings;
  await call("PUT", "/api/settings", { body: { ...cur, overtime: false } });
  const d = (await call("GET", `/api/snapshot?from=${FROM}&to=${LAST}`)).body;
  eq(d.overtime, null); eq(d.totals.retail.otHours, 0);
  await call("PUT", "/api/settings", { body: cur });
});

console.log("daily summary email");
await t("summary: yesterday by store, week and month to date, labor flagged", async () => {
  const m = await buildSummary(db, env, LAST, { now: Date.parse(NOW) });
  ok(/Retail snapshot · Fri, Oct 9/.test(m.subject), m.subject);
  for (const x of ["Sulphur Springs", "Emory", "Greenville", "Quitman", "Workshop", "Week to date", "Month to date", "incl. Winnsboro"]) ok(m.html.includes(x), x);
  ok(/Store labor/.test(m.text) && /Week to date/.test(m.text));
});
await t("MIME: subject encoded, both parts decode back", async () => {
  const raw = mime({ from: "reports@netexcleaners.com", to: "a@b.com", subject: "Snapshot · Fri", html: "<p>héllo</p>", text: "héllo" });
  ok(/Subject: =\?UTF-8\?B\?/.test(raw)); ok(/multipart\/alternative/.test(raw));
  const parts = raw.split(/\r\n\r\n/).slice(1);
  ok(parts.some(p => { try { return new TextDecoder().decode(Uint8Array.from(atob(p.split("\r\n--")[0].replace(/\r\n/g, "")), c => c.charCodeAt(0))) === "héllo"; } catch { return false; } }));
});
await t("scheduled: off until turned on; sends once at the hour on a send day", async () => {
  const sent = []; const send = async (from, to, raw) => sent.push({ from, to, raw });
  const at = h => Date.parse(`2026-10-10T${String(h).padStart(2, "0")}:30:00-05:00`);   // Saturday
  eq((await scheduledSummary(env, { now: at(9), send })).status, "off");
  const cur = (await call("GET", "/api/settings")).body.settings;
  eq((await call("PUT", "/api/settings", { body: { ...cur, summary: { enabled: true, to: [], hour: 7, days: [6] } } })).status, 400);
  await call("PUT", "/api/settings", { body: { ...cur, summary: { enabled: true, to: "neal@towncountryclean.com, mgr@x.com", hour: 7, days: [6] } } });
  eq((await scheduledSummary(env, { now: at(6), send })).status, "not yet");
  const r = await scheduledSummary(env, { now: at(7), send });
  eq(r.status, "sent"); eq(r.for, "2026-10-09"); eq(sent.length, 2); eq(sent[0].from, "reports@netexcleaners.com");
  eq((await scheduledSummary(env, { now: at(8), send })).status, "already sent"); eq(sent.length, 2);
  eq((await scheduledSummary(env, { now: Date.parse("2026-10-11T08:00:00-05:00"), send })).status, "not a send day");
  await call("PUT", "/api/settings", { body: cur });
});
await t("test send and preview: Admins only; a failed address says what to do", async () => {
  eq((await call("POST", "/api/summary/test", { as: "mgr@x.com", body: {} })).status, 403);
  fakeSend = async () => { throw new Error("destination address not verified"); };
  const bad = await call("POST", "/api/summary/test", { body: {} });
  eq(bad.status, 502); ok(/Destination addresses/.test(bad.body.error));
  const got = []; fakeSend = async (f, to) => got.push(to);
  const good = await call("POST", "/api/summary/test", { body: {} });
  eq(good.status, 200); eq(got, [NEAL]);
  fakeSend = null;
  const pv = await call("GET", `/api/summary/preview?day=${LAST}`);
  eq(pv.status, 200); ok(String(pv.body).includes("Month to date"));
  eq((await call("GET", `/api/summary/preview?day=${LAST}`, { as: "mgr@x.com" })).status, 403);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
