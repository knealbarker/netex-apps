// Tests for the SMRT history backfill and order/piece storage.
// Uses Node's built-in SQLite in place of D1 and a fake SMRT with the real report columns (made-up values).
// Run: node workers/sync/test/run.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Smrt } from "../src/smrt.js";
import { runBackfill, backfillProgress } from "../src/backfill.js";
import { ingestDay } from "../src/ingest.js";
import { addDays, ulid } from "../src/util.js";
import { backfillAllowed, liveAllowed, fromRippling } from "../src/index.js";
import { runLive, dayRanges } from "../src/live.js";
import { ingestRippling, parseCsv, ripTime } from "../src/rippling.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = join(here, "../../../db/migrations");

// ---- D1-shaped adapter over node:sqlite
function d1(sqlite) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    _exec: () => sqlite.prepare(sql).run(...args),
  });
  return {
    prepare: sql => wrap(sql),
    batch: async stmts => { sqlite.exec("BEGIN"); try { for (const s of stmts) s._exec(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; },
  };
}
function freshDb() {
  const s = new DatabaseSync(":memory:"); s.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync(MIG).filter(f => f.endsWith(".sql")).sort()) s.exec(readFileSync(join(MIG, f), "utf8"));
  return { sqlite: s, db: d1(s) };
}

// ---- fake SMRT: the real column names of both saved reports
const ORDER_COLS = ["ID","Customer Id","Agent","Payment Setting","Created by","Detailed by","Return Location","Returned by","Status","Order Type","Piece Count","Original Piece Count","Weight In","Weight Out","Price","Paid amount (inc. deposits)","Is Paid","Is Pre Paid","Weight","Discounted Amount","Before Discount Amount","Total Tax","Taxable Amount","Created","Due date","Detailed date","Assembled by","Is Route Delivery","Is Route Pickup","Assembly date","Returned date","Ready date","Paid date","Deleted date","Payment Method","Paid by","Promotion","Promotion applied date","Financial department(s)","Surcharge Amount"];
const ITEM_COLS = ["Sale Id","Customer ID","Customer Internal ID","Status","Assembled by","Lot status","Item Status","Price","Discounted amount","Item base price","Up Charge Amount","Created","Detailed date","Order Assembly date","Returned date","Ready date","Paid date","Delivered date","Picked up date","Order Type","Classification","Last Assembly Location","Item Type","Item Type Alias","Brand","Item Description","Special cares","Colors","Fabrics","Detailed by","Pattern","Returned by","Financial department","Barcode","Category","Item assembly date","Item removal date","Item detail date","Item return date","Last Rack Location","Last racked by","Last racked store","Last racked on date","Surcharge name","Order Notes","Item Notes"];

class FakeSmrt {
  constructor() { this.days = new Map(); this.calls = 0; this.failOnce = new Set(); this.ranges = []; }
  addOrder(day, no, { status = "pickedUp", due, pieces = 2, store = "TCC Quitman", orderNote = "", itemNotes = [], barcodes } = {}) {
    const d = this.days.get(day) || this.days.set(day, { orders: [], items: [] }).get(day);
    const o = Object.fromEntries(ORDER_COLS.map(c => [c, null]));
    Object.assign(o, { "ID": no, "Customer Id": "cust" + no.slice(-3), "Agent": store, "Return Location": store, "Status": status, "Order Type": "Dry Cleaning",
      "Piece Count": String(pieces), "Price": String(pieces * 850), "Created": `${day}T10:00:00-05:00`, "Due date": due || `${addDays(day, 1)}T12:00:00-05:00`,
      "Created by": "Counter A", "Financial department(s)": "Dry Cleaning Tops, Laundry Bottoms" });
    d.orders.push(o);
    for (let i = 0; i < pieces; i++) {
      const it = Object.fromEntries(ITEM_COLS.map(c => [c, null]));
      Object.assign(it, { "Sale Id": no, "Item Status": status === "pickedUp" ? "customer" : "detailed", "Item base price": "850", "Price": "850", "Created": `${day}T10:00:00-05:00`,
        "Item Type": i % 2 ? "Pants" : "Blouse", "Financial department": i % 2 ? "Laundry Bottoms" : "Dry Cleaning Tops", "Barcode": (barcodes && barcodes[i]) || `${no}${i}`,
        "Assembled by": "Maria C", "Item assembly date": status === "pickedUp" ? `${addDays(day, 1)}T09:00:00-05:00` : null,
        "Picked up date": status === "pickedUp" ? `${addDays(day, 2)}T15:00:00-05:00` : null, "Order Notes": orderNote || null, "Item Notes": itemNotes[i] || null });
      d.items.push(it);
    }
    return o;
  }
  fetchImpl = async (url, init) => {
    this.calls++;
    const q = JSON.parse(init.body).query;
    const id = /getReport\(id:"([^"]+)"/.exec(q)[1], start = /startDate:"([^"]+)"/.exec(q)[1], endD = /endDate:"([^"]+)"/.exec(q)[1];
    const day = start.slice(0, 10);
    this.ranges.push([id.slice(0, 4), start, endD]);
    if (this.failOnce.has(day + id)) { this.failOnce.delete(day + id); return new Response("oops", { status: 502 }); }
    const isOrders = id.startsWith("ebe7");
    const cols = isOrders ? ORDER_COLS : ITEM_COLS;
    let body;
    if (q.includes("columns")) body = { data: { business: { getReport: { columns: cols.map(name => ({ name })) } } } };
    else { const rows = [];
      for (const [dd, d] of this.days) if (dd >= day && dd < endD.slice(0, 10)) rows.push(...(isOrders ? d.orders : d.items).map(r => ({ value: cols.map(c => r[c]) })));
      body = { data: { business: { getReport: { values: rows } } } }; }
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

let failures = 0;
const ok = (name, cond, info) => { console.log((cond ? "PASS " : "FAIL ") + name + (info !== undefined ? " — " + JSON.stringify(info) : "")); if (!cond) failures++; };
const one = (s, sql, ...a) => s.prepare(sql).get(...a);

// ============ tests
const TODAY = "2026-10-10";
const { sqlite, db } = freshDb();
const fake = new FakeSmrt();
// history: Oct 9 back to Sep 25 has orders; nothing before
for (let d = addDays(TODAY, -1), n = 0; d >= "2026-09-25"; d = addDays(d, -1), n++) {
  fake.addOrder(d, `26${String(n).padStart(3, "0")}1001`, { pieces: 3 });
  fake.addOrder(d, `26${String(n).padStart(3, "0")}1002`, { pieces: 2, store: "TCC Winnsboro" });
}
const smrt = new Smrt({ url: "https://x/graphql", key: "k", fetchImpl: fake.fetchImpl });
const opts = { orgId: "tcc", integrationId: "smrt", today: TODAY, daysPerRun: 2, stopAfterEmptyDays: 3 };

// 1. first night run: 2 newest days
let r = await runBackfill(db, smrt, opts);
ok("first run loads the 2 newest days", r.status === "ok" && r.loaded.map(x => x.day).join() === "2026-10-09,2026-10-08", r.loaded);
ok("orders and pieces stored", one(sqlite, "SELECT COUNT(*) n FROM pos_orders").n === 4 && one(sqlite, "SELECT COUNT(*) n FROM pos_items").n === 10);
ok("lookups created (statuses, departments, stores, staff)", one(sqlite, "SELECT COUNT(*) n FROM core_locations WHERE kind='store'").n === 2 && one(sqlite, "SELECT COUNT(*) n FROM pos_staff").n === 2 && one(sqlite, "SELECT COUNT(*) n FROM pos_order_departments").n === 8);
ok("pickedUp counts as done and closed", one(sqlite, "SELECT is_done, is_closed FROM pos_order_statuses WHERE name='pickedUp'").is_closed === 1);
ok("picked-up time comes from the items report", !!one(sqlite, "SELECT picked_up_at FROM pos_orders LIMIT 1").picked_up_at);
ok("history load logs no changes and opens no follow-ups", one(sqlite, "SELECT COUNT(*) n FROM pos_changes").n === 0 && one(sqlite, "SELECT COUNT(*) n FROM plan_followups").n === 0);

// 2. a failed SMRT call: that day is retried next run, nothing skipped
fake.failOnce.add("2026-10-07ebe7b9bb-20b7-472b-9925-2b729fe2a38b");
r = await runBackfill(db, smrt, opts);
ok("SMRT error stops the run without losing the day", r.status === "error" && r.state.next === "2026-10-07", r.error);
r = await runBackfill(db, smrt, opts);
ok("next run retries the same day", r.loaded[0] && r.loaded[0].day === "2026-10-07", r.loaded);

// 3. keep going until 3 empty days in a row, then stop for good
let runs = 0; while (r.status !== "finished" && runs++ < 30) r = await runBackfill(db, smrt, opts);
ok("history finishes after the empty days before Sep 25", r.status === "finished" && /no orders for 3 days before 2026-09-25/.test(r.state.reason), r.state);
const prog = await backfillProgress(db, "tcc", "smrt");
ok("progress: 15 loaded days + 3 empty, oldest Sep 22", prog.days === 18 && prog.orders === 30 && prog.oldest === "2026-09-22", prog);
r = await runBackfill(db, smrt, opts);
ok("a finished backfill does nothing", r.status === "finished" && r.loaded.length === 0);

// 4. re-reading a day changes nothing (fingerprints match)
const before = one(sqlite, "SELECT SUM(rev) r FROM pos_orders").r;
const ctx = { orgId: "tcc", runId: null, mode: "live", day: "2026-10-09" };
const ordersReport = (await smrt.dayObjects("ebe7b9bb-20b7-472b-9925-2b729fe2a38b", "2026-10-09"));
const itemsReport = (await smrt.dayObjects("8f6e82e5-8e64-466c-935a-35a22ee5fd01", "2026-10-09"));
let st = await ingestDay(db, ctx, ordersReport, itemsReport);
ok("unchanged day: no orders or pieces rewritten", st.ordersWritten === 0 && st.itemsWritten === 0 && one(sqlite, "SELECT SUM(rev) r FROM pos_orders").r === before, st);

// 5. a live order's due date moves later with no note -> change logged + follow-up needs a note
fake.addOrder(TODAY, "262831500", { status: "detailed", pieces: 2, due: "2026-10-11T12:00:00-05:00" });
const live = { orgId: "tcc", runId: null, mode: "live", day: TODAY };
const pull = async () => [await smrt.dayObjects("ebe7b9bb-20b7-472b-9925-2b729fe2a38b", TODAY), await smrt.dayObjects("8f6e82e5-8e64-466c-935a-35a22ee5fd01", TODAY)];
await ingestDay(db, live, ...(await pull()));
fake.days.get(TODAY).orders.at(-1)["Due date"] = "2026-10-14T12:00:00-05:00";
st = await ingestDay(db, live, ...(await pull()));
const ch = one(sqlite, "SELECT kind, old_value, new_value FROM pos_changes WHERE kind='due_changed'");
ok("due date change logged with old and new", ch && ch.old_value.startsWith("2026-10-11") && ch.new_value.startsWith("2026-10-14"), ch);
ok("follow-up opened asking for a note", one(sqlite, "SELECT status FROM plan_followups WHERE kind='due_moved'").status === "needs_note");

// 6. the counter adds an item note in SMRT -> logged; next move opens as already noted
fake.days.get(TODAY).items.filter(i => i["Sale Id"] === "262831500")[0]["Item Notes"] = "Stain on left sleeve - second treatment";
fake.days.get(TODAY).orders.at(-1)["Due date"] = "2026-10-15T12:00:00-05:00";
st = await ingestDay(db, live, ...(await pull()));
ok("item note change logged", one(sqlite, "SELECT new_value FROM pos_changes WHERE kind='item_note'").new_value.startsWith("Stain"));
ok("second move opens as noted (SMRT has a note)", one(sqlite, "SELECT COUNT(*) n FROM plan_followups WHERE status='noted'").n === 1);

// 7. split: unfinished piece moved to a new order (same barcode) -> one row, moved
const bc = "262831500" + "1";
fake.days.get(TODAY).items = fake.days.get(TODAY).items.filter(i => i["Barcode"] !== bc);
fake.addOrder(TODAY, "262831501", { status: "detailed", pieces: 1, due: "2026-10-16T12:00:00-05:00", barcodes: [bc] });
st = await ingestDay(db, live, ...(await pull()));
const mv = one(sqlite, "SELECT COUNT(*) n FROM pos_items WHERE barcode=?", bc).n;
ok("split piece keeps one row and is logged as moved", mv === 1 && one(sqlite, "SELECT COUNT(*) n FROM pos_changes WHERE kind='item_moved'").n === 1);

// 8. status change logged; deleted order logged as deleted
fake.days.get(TODAY).orders.find(o => o.ID === "262831501")["Status"] = "deleted";
await ingestDay(db, live, ...(await pull()));
ok("deleted order logged", one(sqlite, "SELECT COUNT(*) n FROM pos_changes WHERE kind='order_deleted'").n === 1);

// 9. foreign keys still hold
ok("foreign keys clean", sqlite.prepare("PRAGMA foreign_key_check").all().length === 0);
// ---- the real fetch must not be called as a method (Workers throws "Illegal invocation")
{
  const strict = function (url) { if (this !== undefined && this !== globalThis) throw new Error("Illegal invocation"); return Promise.resolve(new Response(JSON.stringify({ data: { business: { getReport: { columns: [] } } } }))); };
  const s2 = new Smrt({ url: "https://x", key: "k", fetchImpl: strict });
  let err = null; try { await s2.gql("{ x }"); } catch (e) { err = e; }
  ok("SMRT client calls fetch as a plain function", !err || !/Illegal invocation/.test(err.message), err && err.message);
}

// ---- when the history load may run (2026-10-10 is a Saturday, 10-12 a Monday)
ok("weekend: runs at 10 am", backfillAllowed({ day: "2026-10-10", hour: 10 }));
ok("weekend: runs on Sunday afternoon", backfillAllowed({ day: "2026-10-11", hour: 15 }));
ok("work day: waits at 10 am", !backfillAllowed({ day: "2026-10-12", hour: 10 }));
ok("work day: runs at 9 pm and 3 am", backfillAllowed({ day: "2026-10-12", hour: 21 }) && backfillAllowed({ day: "2026-10-13", hour: 3 }));
ok("work day: stops at 5 am", !backfillAllowed({ day: "2026-10-13", hour: 5 }));
ok("custom work days: Saturday as a work day waits", !backfillAllowed({ day: "2026-10-10", hour: 10, workDays: [1, 2, 3, 4, 5, 6] }));

// ================= live sync
{
  const { sqlite: L, db: ldb } = freshDb();
  const f = new FakeSmrt();
  const T = "2026-10-12"; // a Monday
  f.addOrder(T, "262850001", { status: "processing", due: `${addDays(T, 1)}T12:00:00-05:00` });
  f.addOrder(addDays(T, -2), "262830001", { status: "processing", due: `${T}T12:00:00-05:00` });
  f.addOrder(addDays(T, -10), "262750001", { status: "processing", due: `${addDays(T, -3)}T12:00:00-05:00` });   // overdue, open
  f.addOrder(addDays(T, -20), "262650001", { status: "processing", due: `${addDays(T, 20)}T12:00:00-05:00` });   // alteration due later
  f.addOrder(addDays(T, -30), "262550001", { status: "pickedUp" });                                              // finished
  // the history backfill already stored the older days
  L.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status) VALUES('bf','smrt','x','ok')").run();
  for (const d of [-10, -20, -30]) { const day = addDays(T, d); const o = await f.days.get(day); await ingestDay(ldb, { orgId: "tcc", runId: "bf", mode: "backfill", day }, o.orders, o.items); }
  const smrt1 = new Smrt({ url: "https://x/graphql", key: "k", fetchImpl: f.fetchImpl });
  f.ranges = [];
  const r1 = await runLive(ldb, smrt1, { orgId: "tcc", integrationId: "smrt", today: T });
  ok("live: first run of the day is a full refresh", r1.status === "ok" && r1.full, r1);
  ok("live: first run re-reads both older days with open orders", r1.olderDays === 2, r1.olderDays);
  ok("live: orders stored", one(L, "SELECT COUNT(*) n FROM pos_orders").n === 5);
  ok("live: recent week read in one orders call", f.ranges.filter(x => x[0] === "ebe7" && x[1] === addDays(T, -6) && x[2] === addDays(T, 1)).length === 1, f.ranges);
  f.ranges = [];
  const smrt2 = new Smrt({ url: "https://x/graphql", key: "k", fetchImpl: f.fetchImpl });
  // the order due today moves to tomorrow without a note -> follow-up
  f.days.get(addDays(T, -2)).orders[0]["Due date"] = `${addDays(T, 1)}T12:00:00-05:00`;
  const r2 = await runLive(ldb, smrt2, { orgId: "tcc", integrationId: "smrt", today: T });
  ok("live: later runs only re-read older days with orders due soon or overdue", !r2.full && r2.olderDays === 1, r2);
  ok("live: later run uses few SMRT calls", r2.calls <= 8, r2.calls);
  ok("live: first run made a modest number of calls", r1.calls <= 10, r1.calls);
  ok("live: a due date moved later opens a follow-up", one(L, "SELECT COUNT(*) n FROM plan_followups WHERE kind='due_moved' AND status='needs_note'").n === 1);
  ok("live: unchanged rows aren't rewritten", r2.ordersWritten === 1, r2.ordersWritten);
  ok("live: run logged", /live: \d+ orders/.test(one(L, "SELECT message FROM int_sync_runs WHERE message LIKE 'live:%' ORDER BY started_at DESC LIMIT 1").message));
  ok("dayRanges groups consecutive days", JSON.stringify(dayRanges(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-07"], 2)) === JSON.stringify([["2026-10-01", "2026-10-03"], ["2026-10-03", "2026-10-04"], ["2026-10-07", "2026-10-08"]]));
  ok("live window: Monday 10 am yes, 9 pm no, Saturday no", liveAllowed({ day: T, hour: 10 }) && !liveAllowed({ day: T, hour: 21 }) && !liveAllowed({ day: "2026-10-10", hour: 10 }));
}

// ================= Rippling
{
  const { sqlite: R, db: rdb } = freshDb();
  const dep = one(R, "SELECT id FROM core_departments WHERE name='Production'").id;
  R.prepare("INSERT INTO core_people(id,org_id,department_id,first_name,last_name,payroll_id) VALUES('PR40','tcc',?,'Roderick','Williams','40')").run(dep);
  const csv = [
    "\uFEFFtime_entry_id,employee_name,employee_number,title,department_path,work_location,time_entry_date,clock_in_local,clock_out_local,duration_hours,timezone,status,clock_in_source,clock_out_source",
    "a1,Roderick Williams,40,Production Technician,Production,TCC SS Workshop,10/09/2026,10/09/2026 03:50 AM CDT,10/09/2026 08:00 AM CDT,4.17,America/Chicago,PAID,Web,Web",
    "a2,Roderick Williams,40,Production Technician,Production,TCC SS Workshop,10/09/2026,10/09/2026 08:30 AM CDT,10/09/2026 12:21 PM CDT,3.85,America/Chicago,PAID,Web,Web",
    "a3,New Person,99,Production Technician,Production,TCC SS Workshop,10/09/2026,10/09/2026 05:30 AM CDT,10/09/2026 02:00 PM CDT,8.5,America/Chicago,PAID,Web,Web",
    "a4,Counter Clerk,70,Clerk,Retail,TCC SS Store,10/09/2026,10/09/2026 07:00 AM CDT,10/09/2026 03:00 PM CDT,8,America/Chicago,PAID,Web,Web",
    "a5,Roderick Williams,40,Production Technician,Production,TCC SS Workshop,10/12/2026,10/12/2026 03:45 AM CDT,,,America/Chicago,OPEN,Web,",
    '"a6","Name, With Comma",41,Production Technician,Production,TCC SS Workshop,10/12/2026,10/12/2026 12:05 PM CDT,10/12/2026 01:10 PM CDT,1.08,America/Chicago,PAID,Web,Web',
  ].join("\r\n");
  const res = await ingestRippling(rdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", csv });
  ok("rippling: production rows used, others skipped", res.used === 5 && res.skipped === 1, res);
  const h = one(R, "SELECT hours, first_in, last_out FROM labor_daily_hours WHERE person_id='PR40' AND work_date='2026-10-09'");
  ok("rippling: split shift added up into one day", h && h.hours === 8.02 && h.first_in === "03:50" && h.last_out === "12:21", h);
  ok("rippling: new Production employee added to the team", one(R, "SELECT COUNT(*) n FROM core_people WHERE payroll_id='99' AND status='active'").n === 1 && res.added.includes("New Person"));
  const today = R.prepare("SELECT p.payroll_id, c.clock_in, c.clock_out FROM labor_clock_today c JOIN core_people p ON p.id=c.person_id ORDER BY c.clock_in").all();
  ok("rippling: today's punches kept for the live view, open shift has no clock-out", today.length === 2 && today[0].clock_in === "2026-10-12T03:45:00-05:00" && today[0].clock_out === null, today);
  ok("rippling: quoted name with a comma parsed", one(R, "SELECT first_name || ' ' || last_name AS n FROM core_people WHERE payroll_id='41'").n === "Name, With Comma");
  await ingestRippling(rdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", csv });
  ok("rippling: same email twice changes nothing", one(R, "SELECT COUNT(*) n FROM labor_daily_hours").n === 2 && one(R, "SELECT COUNT(*) n FROM labor_clock_today").n === 2);
  ok("rippling: 12 PM and 12 AM", ripTime("10/12/2026 12:05 PM CDT").hm === "12:05" && ripTime("10/12/2026 12:05 AM CST").iso === "2026-10-12T00:05:00-06:00");
  let bad = null; try { await ingestRippling(rdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", csv: "a,b\n1,2" }); } catch (e) { bad = e.message; }
  ok("rippling: wrong file refused with a clear message", /missing/.test(bad || ""), bad);
  const H = o => ({ get: k => o[k.toLowerCase()] ?? null });
  ok("rippling sender: DKIM pass for rippling.com accepted", fromRippling("no-reply@rippling.com", H({ "authentication-results": "mx.cloudflare.net; dkim=pass header.d=rippling.com header.s=s1; spf=pass" })).ok);
  ok("rippling sender: no authentication refused", !fromRippling("no-reply@rippling.com", H({})).ok);
  ok("rippling sender: other domain refused", !fromRippling("no-reply@rippling.com.evil.io", H({ "authentication-results": "dkim=pass header.d=rippling.com" })).ok);
  ok("rippling sender: DKIM for another domain refused", !fromRippling("no-reply@rippling.com", H({ "authentication-results": "dkim=pass header.d=evil.com" })).ok);
}

console.log(`\nSMRT calls made by the fake: ${fake.calls}`);
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
