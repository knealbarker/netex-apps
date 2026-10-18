// Counter tests: visits, detailing speed with the distraction gap, salaried hours, visits per labor hour, clock check.
// Run: node workers/retail/test/counter.mjs
import { freshDb, fakeAccess, makeEnv } from "./harness.mjs";
import { handle } from "../src/index.js";
import { order, items, entry } from "./seed.mjs";
import { countVisits, detailGaps } from "../src/counter.js";
import { ingestDay } from "../../sync/src/ingest.js";
import { ingestRippling } from "../../sync/src/rippling.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const near = (a, b, m = "", tol = 0.011) => { if (a == null || Math.abs(a - b) > tol) throw new Error(`${m} expected ${b} got ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

console.log("pure rules");
await t("visits: a drop-off and a pickup 5 minutes apart are one visit; 40 minutes apart are two", async () => {
  const v = countVisits([
    { store: "S", cust: "a", at: "2026-10-15T09:00:00-05:00", kind: "D" }, { store: "S", cust: "a", at: "2026-10-15T09:05:00-05:00", kind: "P" },
    { store: "S", cust: "b", at: "2026-10-15T09:00:00-05:00", kind: "D" }, { store: "S", cust: "b", at: "2026-10-15T09:40:00-05:00", kind: "P" },
    { store: "S", cust: "c", at: "2026-10-15T10:00:00-05:00", kind: "P" }, { store: "S", cust: "c", at: "2026-10-15T10:01:00-05:00", kind: "P" },
  ], 20);
  eq(v.map(x => x.type).sort(), ["both", "drop", "pickup", "pickup"]);
});
await t("detail gaps: under 90 s is work, 90 s or more a distraction gap; a different person's piece breaks the chain", async () => {
  const at = s => `2026-10-15T09:${s}-05:00`;
  const g = detailGaps([{ at: at("00:00"), who: "a" }, { at: at("00:30"), who: "a" }, { at: at("02:00"), who: "a" }, { at: at("02:20"), who: "b" }, { at: at("02:40"), who: "b" }], 90);
  eq(g.map(x => [x.sec, x.distraction]), [[30, false], [90, true], [20, false]]);
});

// ---------- one made-up day (Thu Oct 15) ----------
const DAY = "2026-10-15", TODAY = "2026-10-16";
const A = await fakeAccess();
const { db, sqlite } = freshDb();
const env = makeEnv(db, { NOW: `${TODAY}T12:00:00-05:00` });
await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status) VALUES('seed','smrt','2026-10-01T00:00:00Z','ok')").run();
const T = hm => `${DAY}T${hm}:00-05:00`;
let n = 262880000;
const orders = [], its = [];
/** A ticket created at `created` by `by`, its pieces detailed at `times` by `det`; picked up at `pickup` (or not). */
function ticket({ store = "TCC Sulphur Springs", cust, created, by, det = by, times, pickup = null, day = DAY }) {
  const o = order(++n, { store, day, net: 10 * times.length, pieces: times.length });
  Object.assign(o, { "Customer Id": cust || "c" + n, "Created": created, "Created by": by, "Detailed by": det, "Detailed date": times.at(-1) });
  const list = items(o, times.map(() => ["Dry Cleaning Tops", false]), 10, day);
  list.forEach((it, i) => Object.assign(it, { "Item detail date": times[i], "Detailed by": det, "Picked up date": pickup }));
  orders.push(o); its.push(...list);
  return o;
}
// Sam (Rippling: Sulphur Springs 8:00–16:00): 5 pieces, gaps 30, 30, 180 (a customer), 30 s
ticket({ cust: "walk1", created: T("09:00"), by: "Sam C", det: "Sam Counter", times: [T("09:01:00"), T("09:01:30"), T("09:02:00"), T("09:05:00"), T("09:05:30")].map(x => x.replace(/:00-05:00$/, "-05:00")) });
// the customer who interrupted Sam: picked up an older order at 9:03 (counts as a pickup visit)
ticket({ cust: "walk2", created: `2026-10-13T10:00:00-05:00`, day: "2026-10-13", by: "Sam C", det: "Sam Counter", times: ["2026-10-13T10:01:00-05:00"], pickup: T("09:03") });
// walk1 also picked up an older order 4 minutes after dropping off: one visit, both
ticket({ cust: "walk1", created: `2026-10-13T11:00:00-05:00`, day: "2026-10-13", by: "Sam C", det: "Sam Counter", times: ["2026-10-13T11:01:00-05:00"], pickup: T("09:04") });
// Sam after clock-out: 3 pieces at 4:40 PM (25 min after 4:00 + 15 grace)
ticket({ created: T("16:39"), by: "Sam C", det: "Sam Counter", times: [T("16:40"), T("16:40").replace(":00-05:00", ":20-05:00"), T("16:40").replace(":00-05:00", ":40-05:00")] });
// Ash (Rippling says Sulphur Springs) works Greenville all day: 4 tickets
for (const hm of ["08:10", "10:10", "12:10", "14:10"]) ticket({ store: "TCC Greenville", created: T(hm), by: "Ash D", det: "Ash Davis", times: [T(hm).replace(":00-05:00", ":30-05:00"), T(hm).replace(":00-05:00", ":50-05:00")] });
// Karla (salaried, not in Rippling) details at Sulphur Springs 1:00–1:02 PM; a pickup at 1:01 while she and Sam are there
ticket({ created: T("13:00"), by: "Karla V", det: "Karla Velasquez", times: [T("13:00").replace(":00-05:00", ":20-05:00"), T("13:00").replace(":00-05:00", ":50-05:00"), T("13:01").replace(":00-05:00", ":20-05:00"), T("13:02")] });
ticket({ cust: "walk3", created: `2026-10-13T12:00:00-05:00`, day: "2026-10-13", by: "Sam C", det: "Sam Counter", times: ["2026-10-13T12:01:00-05:00"], pickup: T("13:01") });
// Pat: SMRT work, no Rippling punch, not salaried
ticket({ created: T("11:00"), by: "Pat Q", det: "Pat Quill", times: [T("11:01"), T("11:02"), T("11:03")] });
// Greenville's own person on the clock: Gail (Rippling Greenville 8–12)
ticket({ store: "TCC Greenville", created: T("09:30"), by: "Gail S", det: "Gail Store", times: [T("09:31")] });
// a Winnsboro drop (no staff of its own): not a Sulphur Springs visit, but Sam's detailing of it counts as SS work
ticket({ store: "TCC Winnsboro", created: T("10:30"), by: "Sam C", det: "Sam Counter", times: [T("10:31")] });

for (const day of ["2026-10-13", DAY]) {
  const ctx = { orgId: "tcc", runId: "seed", mode: "backfill", day };
  await ingestDay(db, ctx, orders.filter(o => o.Created.startsWith(day)), its.filter(i => orders.find(o => o.ID === i["Sale Id"]).Created.startsWith(day)));
}
const HDR = "time_entry_id,employee_name,employee_number,title,department_path,work_location,time_entry_date,clock_in_local,clock_out_local,duration_hours,timezone,status,clock_in_source,clock_out_source,pay_rate";
await ingestRippling(db, { orgId: "tcc", integrationId: "rippling", today: TODAY, csv: [HDR,
  entry("e1", "Sam Counter", "501", "Retail", "TCC SS Retail", DAY, 8, "15", { start: 8 }),
  entry("e2", "Ash Davis", "502", "Retail", "TCC SS Retail", DAY, 8, "15", { start: 8 }),
  entry("e3", "Gail Store", "503", "Retail", "TCC Greenville Retail", DAY, 4, "15", { start: 8 }),
].join("\n") });

const call = async (method, path, { as = "neal@towncountryclean.com", body } = {}) => {
  const headers = new Headers();
  if (as) headers.set("cf-access-jwt-assertion", await A.token({ email: as }));
  if (body) headers.set("content-type", "application/json");
  const r = await handle(new Request(`https://retailview.netexcleaners.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
  return { status: r.status, body: await r.json() };
};
const id = "01VIEW0000000000000000000A";
sqlite.prepare("INSERT INTO core_users(id, org_id, email, display_name) VALUES(?,?,?,?)").run(id, "tcc", "view@x.com", "Viewer");
sqlite.prepare("INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES(?,?,?,?)").run(id, "retail", "viewer", "x");

console.log("counter numbers");
const r = await call("GET", `/api/counter?from=${DAY}&to=${DAY}`);
await t("answers", async () => { eq(r.status, 200, JSON.stringify(r.body)); });
const d = r.body, store = nm => d.stores.find(s => s.name === nm), person = nm => d.people.find(p => p.name === nm);
await t("stores with someone on the clock only (Winnsboro rolls in, so it isn't its own store)", async () => {
  eq(d.stores.map(s => s.name), ["Greenville", "Sulphur Springs"]);
});
await t("visits: walk1 drop + pickup = both; walk2 and walk3 pickups; other tickets drop-offs; Winnsboro left out", async () => {
  const ss = store("Sulphur Springs");
  eq([ss.dropOnly, ss.pickupOnly, ss.both], [3, 2, 1]);   // Sam's 4:39, Karla's, Pat's tickets; walk2, walk3; walk1
  eq(store("Greenville").visits, 5);
});
await t("Sam: 30 s a piece; the 3-minute gap is a distraction gap, not speed", async () => {
  const s = person("Sam Counter");
  near(s.secPerPiece, 26, "sec/piece", 0.1);   // gaps 30,30,30,20,20 under 90 s (incl. the 4:40 order); 180 s left out
  eq(s.gaps, 1);
});
await t("SMRT's two spellings (Ash D created, Ash Davis detailed) are one person, matched to Rippling", async () => {
  const c = d.checks.filter(x => x.person === "Ash Davis");
  eq(c.map(x => x.kind), ["wrong_store"]); eq(c[0].store, "Greenville");
  ok(c[0].rippling.locations.includes("Sulphur Springs"), JSON.stringify(c[0].rippling));
});
await t("clock check: Pat has SMRT work and no punch; Sam worked after clock-out; Karla (salaried) isn't flagged", async () => {
  eq(d.checks.filter(x => x.person === "Pat Quill").map(x => x.kind), ["no_punch"]);
  const sam = d.checks.filter(x => x.person === "Sam Counter");
  eq(sam.map(x => x.kind), ["outside_hours"]); ok(/after clock-out/.test(sam[0].text), sam[0].text);
  eq(d.checks.filter(x => /Karla/.test(x.person)).length, 0);
});
await t("Karla's salaried hours: detailing time plus her share of the pickup while she was there", async () => {
  const k = person("Karla Velasquez");
  ok(k && k.salaried, JSON.stringify(d.people.map(p => p.name)));
  // gaps 30, 30, 40 = 100 s + one typical piece (her average 33.3 s) = 133.3 s; pickup at 1:01 split between Karla and Sam = 60 s
  near(k.salariedHours, (133.33 + 60) / 3600, "hours (2 decimals)", 0.006);
});
await t("visits per labor hour = visits / (Rippling + salaried hours)", async () => {
  const ss = store("Sulphur Springs");
  near(ss.ripplingHours, 16); near(ss.hours, 16 + (133.33 + 60) / 3600, "", 0.01);
  near(ss.visitsPerHour, ss.visits / ss.hours, "", 0.01);
});

console.log("resolving flags");
await t("a Viewer can't mark a flag OK; a Manager-level user can, with a note; reopen works", async () => {
  const key = d.checks.find(x => x.kind === "no_punch").key;
  eq((await call("POST", "/api/counter/check", { as: "view@x.com", body: { key, note: "x" } })).status, 403);
  eq((await call("POST", "/api/counter/check", { body: { key } })).status, 400);
  eq((await call("POST", "/api/counter/check", { body: { key, note: "Pat is training, not paid" } })).status, 200);
  let c = (await call("GET", `/api/counter?from=${DAY}&to=${DAY}`)).body.checks.find(x => x.key === key);
  eq(c.ok.note, "Pat is training, not paid");
  await call("POST", "/api/counter/check", { body: { key, ok: false } });
  c = (await call("GET", `/api/counter?from=${DAY}&to=${DAY}`)).body.checks.find(x => x.key === key);
  eq(c.ok, null);
});
await t("fixing Rippling clears the flag: Ash moved to Greenville", async () => {
  await ingestRippling(db, { orgId: "tcc", integrationId: "rippling", today: TODAY, csv: [HDR, entry("e2", "Ash Davis", "502", "Retail", "TCC Greenville Retail", DAY, 8, "15", { start: 8 })].join("\n") });
  sqlite.prepare("DELETE FROM labor_daily_hours WHERE person_id=(SELECT id FROM core_people WHERE first_name='Ash') AND location_id=(SELECT id FROM core_locations WHERE name='Sulphur Springs')").run();
  const c = (await call("GET", `/api/counter?from=${DAY}&to=${DAY}`)).body;
  eq(c.checks.filter(x => x.person === "Ash Davis").length, 0);
  near(c.stores.find(s => s.name === "Greenville").ripplingHours, 12);
});

console.log("settings");
await t("the distraction gap is a setting: at 200 s, Sam's 3-minute pause counts as work", async () => {
  const cur = (await call("GET", "/api/settings")).body.settings;
  eq(cur.counter.gapSec, 90); eq(cur.counter.pickupMin, 2);
  eq((await call("PUT", "/api/settings", { body: { ...cur, counter: { ...cur.counter, gapSec: 200 } } })).status, 200);
  const s = (await call("GET", `/api/counter?from=${DAY}&to=${DAY}`)).body.people.find(p => p.name === "Sam Counter");
  eq(s.gaps, 0);
  await call("PUT", "/api/settings", { body: cur });
});
await t("bad counter settings refused; ranges over 31 days refused", async () => {
  const cur = (await call("GET", "/api/settings")).body.settings;
  const bad = await call("PUT", "/api/settings", { body: { ...cur, counter: { ...cur.counter, gapSec: 5 } } });
  eq(bad.status, 400); ok(/Distraction gap/.test(bad.body.error));
  eq((await call("GET", "/api/counter?from=2026-08-01&to=2026-10-15")).status, 400);
});
await t("Viewers see the Counter", async () => { eq((await call("GET", `/api/counter?from=${DAY}&to=${DAY}`, { as: "view@x.com" })).status, 200); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
