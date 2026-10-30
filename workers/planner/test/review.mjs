// Tests for Review (src/review.js). Run: node workers/planner/test/review.mjs
import { freshDb, fakeAccess, makeEnv } from "./harness.mjs";
import { handle } from "../src/index.js";
import { ingestDay } from "../../sync/src/ingest.js";
import { localNow, prevWorkDay, addDays } from "../src/pieces.js";
import { ulid } from "../src/util.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };
const near = (a, b, m) => ok(Math.abs(a - b) < 1e-6, `${m || ""} expected ${b} got ${a}`);

const A = await fakeAccess();
const { db, sqlite } = freshDb();
const env = makeEnv(db);
const call = async (method, path, { as = "neal@towncountryclean.com", body } = {}) => {
  const headers = new Headers({ "cf-access-jwt-assertion": await A.token({ email: as }) });
  if (body) headers.set("content-type", "application/json");
  const r = await handle(new Request(`https://prodplanner.netexcleaners.com/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
  return { status: r.status, body: await r.json() };
};

const today = localNow("America/Chicago").day;
const DAY = prevWorkDay(today, [1, 2, 3, 4, 5]);
await call("POST", "/users", { body: { name: "Mo", email: "mo@example.com", role: "manager" } });
await call("POST", "/users", { body: { name: "Vi", email: "vi@example.com", role: "viewer" } });
await call("PUT", "/settings/runs", { body: { runs: [
  { name: "Quitman run", kind: "shuttle", stops: [{ store: "Quitman", arrive: "11:30", drive: 40, stay: 15 }] },
  { name: "Counter", kind: "counter", stops: [{ store: "Sulphur Springs", arrive: "16:00", drive: 0, stay: 0 }] },
] } });
await call("PUT", "/settings/money", { body: { payAvg: 15, laborTarget: 20 } });
const ana = (await call("POST", "/team", { body: { firstName: "Ana", lastName: "Uno" } })).body.id;
const beto = (await call("POST", "/team", { body: { firstName: "Beto", lastName: "Dos" } })).body.id;
const cora = (await call("POST", "/team", { body: { firstName: "Cora", lastName: "Tres" } })).body.id;

// orders due DAY: 3 Quitman orders all assembled by 10:20; 2 counter orders, one with a piece still open at the end of the day
const ts = (d, hm) => `${d}T${hm}:00-05:00`;
const orders = [], items = []; let k = 0;
const add = (store, pieces) => { const id = `2799${String(++k).padStart(5, "0")}`;
  orders.push({ "ID": id, "Status": "processing", "Due date": ts(DAY, "12:00"), "Created": ts(addDays(DAY, -2), "09:00"), "Piece Count": String(pieces.length), "Return Location": `TCC ${store}`, "Customer Id": "c1" });
  pieces.forEach(([dep, asm, base], i) => items.push({ "Sale Id": id, "Barcode": `${id}${i}`, "Item Status": asm ? "assembled" : "detailed", "Financial department": dep, "Item Type": "Shirt",
    "Created": ts(addDays(DAY, -2), "09:00"), "Item assembly date": asm ? ts(DAY, asm) : "", "Base price": base != null ? String(base) : "" })); };
add("Quitman", [["Laundry Tops", "08:10", 4], ["Laundry Tops", "09:40", 4]]);
add("Quitman", [["Dry Cleaning Tops", "10:20", 8]]);
add("Quitman", [["Laundry Bottoms", "09:00", 7]]);
add("Sulphur Springs", [["Laundry Tops", "13:00", 4], ["Dry Cleaning Bottoms", "14:30", 9]]);
add("Sulphur Springs", [["Laundry Bottoms", "15:00", 7], ["Laundry Bottoms", "", 7]]);
await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,finished_at,status,message) VALUES('rv','smrt',?,?,'ok','backfill')").bind(new Date().toISOString(), new Date().toISOString()).run();
await ingestDay(db, { orgId: "tcc", runId: "rv", mode: "backfill", day: addDays(DAY, -2) }, orders, items);
const dep = sqlite.prepare("SELECT id FROM core_departments WHERE name='Production'").get().id;
for (const [p, h, fi, lo] of [[ana, 8, "05:05", "13:40"], [beto, 6, "06:20", "12:50"], [cora, 4, "07:00", "11:00"]])
  sqlite.prepare("INSERT INTO labor_daily_hours(person_id, work_date, department_id, location_id, hours, first_in, last_out) VALUES(?,?,?,(SELECT id FROM core_locations WHERE kind='plant' ORDER BY created_at LIMIT 1),?,?,?)").run(p, DAY, dep, h, fi, lo);

await t("pieces assembled that day, by kind, with revenue from SMRT prices and the running count", async () => {
  const r = (await call("GET", `/review/${DAY}`)).body;
  eq(r.done.pieces, 7); eq([r.done.q.slt, r.done.q.slb, r.done.q.dct, r.done.q.dcb], [3, 2, 1, 1]);
  ok(r.done.revenue > 0, "revenue");
  eq(r.done.curve[r.done.curve.length - 1][1], 7); ok(r.done.curve[0][0] <= 8.25, JSON.stringify(r.done.curve[0]));
});
await t("due that day: 8 pieces, 7 finished by the end of it", async () => {
  const r = (await call("GET", `/review/${DAY}`)).body;
  eq([r.due.pieces, r.due.finished, r.due.orders], [8, 7, 5]);
});
await t("no deadlines while shuttles are switched off; every person's actual day is returned", async () => {
  const r = (await call("GET", `/review/${DAY}`)).body;
  eq(r.deadlines.length, 0);
  ok(Array.isArray(r.actual) && r.actual.length > 0 && r.actual.every(a => "breakPaid" in a && "offMin" in a), JSON.stringify(r.actual));
});
await t("labor: hours, pieces per hour; cost and labor % only for Admins and the Owner", async () => {
  const r = (await call("GET", `/review/${DAY}`)).body;
  eq([r.labor.hours, r.labor.people], [18, 3]); near(r.labor.perHour, 7 / 18);
  near(r.labor.cost, 18 * 15); ok(r.labor.pct > 0); eq(r.money, true);
  const v = (await call("GET", `/review/${DAY}`, { as: "vi@example.com" })).body;
  eq([v.labor.cost, v.labor.pct, v.money], [undefined, undefined, false]);
  ok(v.trend.every(d => d.pct === undefined), "no labor % in the trend for viewers");
});
await t("plan vs actual: the published crew against Rippling, plus someone who worked but wasn't planned", async () => {
  const crew = { slt1: { personId: ana, start: "05:00", hours: 7.5 }, dct1: { personId: beto, start: "06:00", hours: 6 } };
  await call("PUT", `/plan/${DAY}`, { body: { rev: 0, crew } });
  const input = { q: {}, crew: { slt1: { emp: ana, start: "05:00", hrs: 7.5, stop: "" }, dct1: { emp: beto, start: "06:00", hrs: 6, stop: "" } },
    stations: [{ id: "slt1", type: "slt", label: "SLT 1" }, { id: "dct1", type: "dct", label: "DCT 1" }], ops: [], people: [], trainingOf: {}, settings: { breakMin: 30, breakAfter: 4 } };
  eq((await call("POST", `/plan/${DAY}/publish`, { body: { rev: 1, snapshot: { sig: "x", input, metrics: { end: 13.5, laborH: 13 }, waves: [] } } })).status, 200);
  const r = (await call("GET", `/review/${DAY}`)).body;
  eq(r.planned.source, "published"); eq(r.planned.metrics.end, 13.5);
  const a = r.people.find(p => p.personId === ana), c = r.people.find(p => p.personId === cora);
  near(a.plannedIn, 5); near(a.plannedOut, 13); near(a.actualIn, 5 + 5 / 60); eq(a.station, "SLT 1");
  ok(c.unplanned && c.name === "Cora Tres", JSON.stringify(c));
});
await t("by department: each person's paid hours on the stations the plan had them on; someone not on the plan on their own row; notes", async () => {
  const r = (await call("GET", `/review/${DAY}`)).body, D = r.departments;
  const row = k => D.rows.find(x => x.key === k);
  ok(row("slt") && row("slt").people.includes("Ana Uno") && row("slt").hours > 7, JSON.stringify(row("slt")));
  ok(row("dct") && row("dct").people.includes("Beto Dos"), JSON.stringify(row("dct")));
  ok(row("none") && row("none").shared && row("none").people.includes("Cora Tres"), JSON.stringify(row("none"))); near(row("none").hours, 4);
  near(D.rows.reduce((t, x) => t + x.hours, 0), r.labor.hours);
  near(D.total.cost, r.labor.cost);
  ok(Array.isArray(D.total.miss) && D.rows.every(x => Array.isArray(x.miss)));
  ok(D.rows.filter(x => !x.shared).every(x => x.earlier + x.onDay + x.noScan === x.finished && x.asmFor.today + x.asmFor.ahead + x.asmFor.overdue === x.assembled), "finished and assembled each add up");
  eq((await call("PUT", `/review/${DAY}/note`, { as: "vi@example.com", body: { dept: "slt", text: "x" } })).status, 403);
  eq((await call("PUT", `/review/${DAY}/note`, { as: "mo@example.com", body: { dept: "slt", text: "Rosenda out sick, tops ran late" } })).status, 200);
  eq((await call("GET", `/review/${DAY}`)).body.departments.notes.slt.text, "Rosenda out sick, tops ran late");
  eq((await call("PUT", `/review/${DAY}/note`, { as: "mo@example.com", body: { dept: "slt", text: "" } })).status, 200);
  ok(!(await call("GET", `/review/${DAY}`)).body.departments.notes.slt);
  const v = (await call("GET", `/review/${DAY}`, { as: "vi@example.com" })).body.departments;
  ok(v.total.cost === undefined && v.rows.every(x => x.cost === undefined && x.pct === undefined), "viewers see no money");
});
await t("follow-ups: an order whose due date moved later; a Manager adds a reason and a note; a Viewer can't", async () => {
  const o = sqlite.prepare("SELECT id FROM pos_orders LIMIT 1").get().id, ch = ulid(), id = ulid();
  sqlite.prepare("INSERT INTO pos_changes(id, order_id, kind, old_value, new_value, detected_at) VALUES(?,?,?,?,?,?)").run(ch, o, "due_changed", ts(DAY, "12:00"), ts(addDays(DAY, 1), "12:00"), new Date().toISOString());
  sqlite.prepare("INSERT INTO plan_followups(id, order_id, kind, change_id, status) VALUES(?,?,?,?,?)").run(id, o, "due_moved", ch, "needs_note");
  let r = (await call("GET", `/review/${DAY}`)).body;
  const f = r.followups.list.find(x => x.id === id);
  ok(f && f.status === "needs_note" && f.newDue.startsWith(addDays(DAY, 1)) && /^\d{5}-/.test(f.no), JSON.stringify(f));
  ok(r.followups.reasons.some(x => x.id === "stain"));
  eq((await call("PATCH", `/followups/${id}`, { as: "vi@example.com", body: { reasonId: "stain" } })).status, 403);
  eq((await call("PATCH", `/followups/${id}`, { as: "mo@example.com", body: { reasonId: "nope" } })).status, 400);
  eq((await call("PATCH", `/followups/${id}`, { as: "mo@example.com", body: { reasonId: "stain", note: "Second treatment" } })).status, 200);
  r = (await call("GET", `/review/${DAY}`)).body;
  const g = r.followups.list.find(x => x.id === id);
  eq([g.status, g.reasonId, g.note, g.notedBy], ["noted", "stain", "Second treatment", "Mo"]);
  await call("PATCH", `/followups/${id}`, { as: "mo@example.com", body: { resolved: true } });
  eq((await call("GET", `/review/${DAY}`)).body.followups.list.find(x => x.id === id).status, "resolved");
});
await t("trend: 10 work days ending on the day, with hours and pieces per hour; target pieces per hour", async () => {
  const r = (await call("GET", `/review/${DAY}`)).body;
  eq(r.trend.length, 10); eq(r.trend[9].day, DAY); eq(r.trend[9].pieces, 7); near(r.trend[9].pct, 18 * 15 / r.done.revenue * 100);
  const T = r.departments.total; near(T.targetPerHour, T.avgWage / (r.labor.target / 100 * T.avgPrice));
  const v = (await call("GET", `/review/${DAY}`, { as: "vi@example.com" })).body.departments.total;
  ok(v.targetPerHour > 0 && v.avgWage === undefined && v.avgPrice === undefined && v.cost === undefined, "viewers get the target, no money");
  ok(r.trend.every(d => ![0, 6].includes(new Date(d.day + "T12:00:00Z").getUTCDay())), "no weekends");
});
await t("someone marked 'not in labor %' (Team Lead): still listed with hours, left out of hours, cost, labor %, departments and the trend", async () => {
  sqlite.prepare("UPDATE core_people SET no_labor=1 WHERE id=?").run(cora);
  try {
    const r = (await call("GET", `/review/${DAY}`)).body;
    eq([r.labor.hours, r.labor.people], [14, 2]); near(r.labor.perHour, 7 / 14); near(r.labor.cost, 14 * 15);
    eq(r.labor.notCounted.map(p => p.name), ["Cora Tres"]); near(r.labor.notCounted[0].hours, 4);
    const c = r.people.find(p => p.personId === cora); ok(c && c.noLabor && c.actualHours > 3.9, JSON.stringify(c));
    ok(r.actual.find(p => p.personId === cora).noLabor, "actual keeps her, flagged");
    ok(!r.departments.rows.find(x => x.key === "none"), "no 'Not on the plan' row for her hours");
    near(r.departments.total.hours, 14); near(r.departments.total.cost, 14 * 15);
    near(r.trend[9].hours, 14); near(r.trend[9].pct, 14 * 15 / r.done.revenue * 100);
  } finally { sqlite.prepare("UPDATE core_people SET no_labor=0 WHERE id=?").run(cora); }
});
await t("bad dates and future days are refused", async () => {
  eq((await call("GET", `/review/${addDays(today, 3)}`)).status, 400);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
