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
import worker, { backfillAllowed, liveAllowed, fromRippling } from "../src/index.js";
import { runLive, dayRanges, runCheck, CHECK_REPEAT_S } from "../src/live.js";
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
ok("lookups created (statuses, departments, stores, staff)", one(sqlite, "SELECT COUNT(*) n FROM core_locations WHERE kind='store' AND name IN ('Quitman','Winnsboro')").n === 2 && one(sqlite, "SELECT COUNT(*) n FROM pos_staff").n === 2 && one(sqlite, "SELECT COUNT(*) n FROM pos_order_departments").n === 8);
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

// 7b. a reused tag: the same jeans barcode on last week's order and on today's is two pieces, and re-reading either day
//     doesn't move the row back and forth (the 324 → 354 → 336 starch bottoms count, Oct 13)
const tag = "JEANS-TAG-1";
fake.addOrder("2026-10-03", "262761777", { status: "pickedUp", pieces: 1, barcodes: [tag] });
fake.addOrder(TODAY, "262831777", { status: "detailed", pieces: 1, barcodes: [tag] });
for (const d of ["2026-10-03", TODAY, "2026-10-03", TODAY]) {
  const pulled = { orders: fake.days.get(d).orders, items: fake.days.get(d).items };
  await ingestDay(db, { ...live, day: d }, pulled.orders, pulled.items);
}
const rowsT = sqlite.prepare("SELECT o.smrt_order_no AS no, i.assembled_at AS a FROM pos_items i JOIN pos_orders o ON o.id=i.order_id WHERE i.barcode=? ORDER BY o.smrt_order_no").all(tag);
ok("a reused tag keeps one row per visit, each on its own order", rowsT.length === 2 && rowsT[0].no === "262761777" && !!rowsT[0].a && rowsT[1].no === "262831777" && !rowsT[1].a, rowsT);

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
  ok("live: first run made a modest number of calls (incl. the daily payments pass)", r1.calls <= 15, r1.calls);
  ok("live: a due date moved later opens a follow-up", one(L, "SELECT COUNT(*) n FROM plan_followups WHERE kind='due_moved' AND status='needs_note'").n === 1);
  ok("live: unchanged rows aren't rewritten", r2.ordersWritten === 1, r2.ordersWritten);
  {
    // a picked-up order paid later (statement customer): only the daily payments pass sees it
    const o = f.days.get(addDays(T, -30)).orders[0];
    ok("payments: picked-up order starts unpaid", one(L, "SELECT paid_at FROM pos_orders WHERE smrt_order_no='262550001'").paid_at === null);
    Object.assign(o, { "Paid date": `${addDays(T, 1)}T09:30:00-05:00`, "Paid amount (inc. deposits)": o.Price, "Is Paid": "true" });
    const r3 = await runLive(ldb, new Smrt({ url: "https://x/graphql", key: "k", fetchImpl: f.fetchImpl }), { orgId: "tcc", integrationId: "smrt", today: addDays(T, 1) });
    const p = one(L, "SELECT paid_at, paid_cents FROM pos_orders WHERE smrt_order_no='262550001'");
    ok("payments: next day's full run picks up the late payment", r3.full && r3.paymentsChanged >= 1 && p.paid_at === `${addDays(T, 1)}T09:30:00-05:00` && p.paid_cents === 1700, { r3, p });
    ok("payments: nothing else rewritten on that order", one(L, "SELECT COUNT(*) n FROM pos_changes c JOIN pos_orders o ON o.id=c.order_id WHERE o.smrt_order_no='262550001'").n === 0);
  }
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
  ok("rippling: every department used (retail too)", res.used === 6 && res.skipped === 0, res);
  const retail = one(R, `SELECT h.hours, l.name AS loc, d.name AS dep FROM labor_daily_hours h JOIN core_locations l ON l.id=h.location_id JOIN core_departments d ON d.id=h.department_id
      JOIN core_people p ON p.id=h.person_id WHERE p.payroll_id='70'`);
  ok("rippling: retail hours kept at their store, in the Retail department", retail && retail.hours === 8 && retail.loc === "Sulphur Springs" && retail.dep === "Retail", retail);
  ok("rippling: workshop hours stay at the Workshop", one(R, "SELECT l.kind FROM labor_daily_hours h JOIN core_locations l ON l.id=h.location_id WHERE h.person_id='PR40'").kind === "plant");
  ok("rippling: new retail clerk isn't added to the production team", one(R, "SELECT d.name FROM core_people p JOIN core_departments d ON d.id=p.department_id WHERE p.payroll_id='70'").name === "Retail");
  const h = one(R, "SELECT hours, first_in, last_out FROM labor_daily_hours WHERE person_id='PR40' AND work_date='2026-10-09'");
  ok("rippling: split shift added up into one day, with its 30-min break paid", h && h.hours === 8.52 && h.first_in === "03:50" && h.last_out === "12:21", h);
  ok("rippling: the paid break is recorded on its own", one(R, "SELECT break_paid_hours AS b FROM labor_daily_hours WHERE person_id='PR40' AND work_date='2026-10-09'").b === 0.5);
  ok("rippling: new Production employee added to the team", one(R, "SELECT COUNT(*) n FROM core_people WHERE payroll_id='99' AND status='active'").n === 1 && res.added.includes("New Person"));
  const today = R.prepare("SELECT p.payroll_id, c.clock_in, c.clock_out FROM labor_clock_today c JOIN core_people p ON p.id=c.person_id ORDER BY c.clock_in").all();
  ok("rippling: today's punches kept for the live view, open shift has no clock-out", today.length === 2 && today[0].clock_in === "2026-10-12T03:45:00-05:00" && today[0].clock_out === null, today);
  ok("rippling: quoted name with a comma parsed", one(R, "SELECT first_name || ' ' || last_name AS n FROM core_people WHERE payroll_id='41'").n === "Name, With Comma");
  const again = await ingestRippling(rdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", csv });
  ok("rippling: an identical export is skipped without touching the database", again.duplicate === true);
  ok("rippling: same email twice changes nothing", one(R, "SELECT COUNT(*) n FROM labor_daily_hours").n === 3 && one(R, "SELECT COUNT(*) n FROM labor_clock_today").n === 2);
  {
    // paid break policy (Neal, Oct 15): one break, the first gap; up to 30 min paid; back after more than 35 = none; Production and Laundry Hub only
    const H = "time_entry_id,employee_name,employee_number,title,department_path,work_location,time_entry_date,clock_in_local,clock_out_local,duration_hours,timezone,status,clock_in_source,clock_out_source";
    const row = (id, name, no, dep, loc, a, b, h) => `${id},${name},${no},T,${dep},${loc},10/08/2026,10/08/2026 ${a} CDT,10/08/2026 ${b} CDT,${h},America/Chicago,PAID,Web,Web`;
    await ingestRippling(rdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", keepToday: true, csv: [H,
      row("b1", "Brk Ok", 501, "Production", "TCC SS Workshop", "06:00 AM", "10:00 AM", 4), row("b2", "Brk Ok", 501, "Production", "TCC SS Workshop", "10:35 AM", "02:30 PM", 3.92),
      row("b3", "Brk Late", 502, "Production", "TCC SS Workshop", "06:00 AM", "10:00 AM", 4), row("b4", "Brk Late", 502, "Production", "TCC SS Workshop", "10:36 AM", "02:30 PM", 3.9),
      row("b5", "Brk Two", 503, "Production", "TCC SS Workshop", "06:00 AM", "09:00 AM", 3), row("b6", "Brk Two", 503, "Production", "TCC SS Workshop", "09:20 AM", "11:00 AM", 1.67),
      row("b7", "Brk Two", 503, "Production", "TCC SS Workshop", "11:15 AM", "02:00 PM", 2.75),
      row("b8", "Brk Hub", 504, "Laundry Hub", "TCC Laundry Hub", "07:00 AM", "11:00 AM", 4), row("b9", "Brk Hub", 504, "Laundry Hub", "TCC Laundry Hub", "11:30 AM", "03:00 PM", 3.5),
      row("c1", "Brk Store", 505, "Retail", "TCC SS Store", "07:00 AM", "11:00 AM", 4), row("c2", "Brk Store", 505, "Retail", "TCC SS Store", "11:30 AM", "03:00 PM", 3.5),
      row("c3", "Brk Switch", 506, "Production", "TCC SS Workshop", "06:00 AM", "08:00 AM", 2), row("c4", "Brk Switch", 506, "Production", "TCC SS Workshop", "08:01 AM", "10:00 AM", 1.98),
      row("c5", "Brk Switch", 506, "Production", "TCC SS Workshop", "10:30 AM", "02:00 PM", 3.5),
    ].join("\r\n") });
    const hrs = no => one(R, `SELECT SUM(h.hours) AS h, SUM(h.break_paid_hours) AS b FROM labor_daily_hours h JOIN core_people p ON p.id=h.person_id WHERE p.payroll_id='${no}' AND h.work_date='2026-10-08'`);
    ok("paid break: back at 35 minutes, 30 of it paid", hrs(501).h === 8.42 && hrs(501).b === 0.5, hrs(501));
    ok("paid break: back at 36 minutes, none of it paid", hrs(502).h === 7.9 && hrs(502).b === 0, hrs(502));
    ok("paid break: a 20-min first break is paid in full, a second gap isn't", hrs(503).b === 0.33 && hrs(503).h === 7.75, hrs(503));
    ok("paid break: Laundry Hub gets it", hrs(504).b === 0.5 && hrs(504).h === 8, hrs(504));
    ok("paid break: store staff don't", hrs(505).b === 0 && hrs(505).h === 7.5, hrs(505));
    ok("paid break: a 1-minute gap between punches isn't the break", hrs(506).b === 0.5, hrs(506));
  }
  {
    const { sqlite: S, db: sdb } = freshDb();
    const hdr = "time_entry_id,employee_name,employee_number,title,department_path,work_location,time_entry_date,clock_in_local,clock_out_local,duration_hours,timezone,status,clock_in_source,clock_out_source,Pay Rate";
    const two = [hdr,
      "b1,Store Hopper,80,Retail Advisor,Retail,TCC SS Retail,10/09/2026,10/09/2026 07:00 AM CDT,10/09/2026 11:00 AM CDT,4,America/Chicago,PAID,Web,Web,$14.50",
      "b2,Store Hopper,80,Retail Advisor,Retail,TCC Emory Retail,10/09/2026,10/09/2026 12:00 PM CDT,10/09/2026 04:00 PM CDT,4,America/Chicago,PAID,Web,Web,$14.50",
      "b3,Hub Tech,81,Laundry Hub Technician,Laundry Hub,TCC Laundry Hub,10/09/2026,10/09/2026 06:00 AM CDT,10/09/2026 02:00 PM CDT,8,America/Chicago,PAID,Web,Web,16",
      "b4,Store Hopper,80,Retail Advisor,Retail,TCC Greenville Retail,10/12/2026,10/12/2026 07:00 AM CDT,,,America/Chicago,OPEN,Web,,$14.50"].join("\n");
    const r2 = await ingestRippling(sdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", csv: two });
    const rows = S.prepare("SELECT l.name, h.hours FROM labor_daily_hours h JOIN core_locations l ON l.id=h.location_id JOIN core_people p ON p.id=h.person_id WHERE p.payroll_id='80' ORDER BY l.name").all();
    ok("rippling: two stores in one day kept apart", rows.length === 2 && rows[0].name === "Emory" && rows[1].name === "Sulphur Springs" && rows[0].hours === 4, rows);
    ok("rippling: Laundry Hub is its own plant location and department", one(S, "SELECT l.kind, d.name FROM labor_daily_hours h JOIN core_locations l ON l.id=h.location_id JOIN core_departments d ON d.id=h.department_id JOIN core_people p ON p.id=h.person_id WHERE p.payroll_id='81'").kind === "plant");
    ok("rippling: pay rate column read into labor_pay_rates", r2.rates === 2 && one(S, "SELECT hourly_cents c, effective_on e FROM labor_pay_rates r JOIN core_people p ON p.id=r.person_id WHERE p.payroll_id='80'").c === 1450, r2);
    ok("rippling: today's punch remembers its store", one(S, "SELECT l.name FROM labor_clock_today c JOIN core_locations l ON l.id=c.location_id").name === "Greenville");
    const raise = two.replace(/\$14\.50/g, "$15.25").replace("b4,", "b5,");
    await ingestRippling(sdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", csv: raise });
    const rr = S.prepare("SELECT hourly_cents c, effective_on e FROM labor_pay_rates r JOIN core_people p ON p.id=r.person_id WHERE p.payroll_id='80' ORDER BY e").all();
    ok("rippling: a raise starts today, the old rate stays for earlier days", rr.length === 2 && rr[0].c === 1450 && rr[1].c === 1525 && rr[1].e === "2026-10-12", rr);
    {
      const { sqlite: S2, db: d2 } = freshDb();
      const odd = [hdr.replace("Pay Rate", "Employee Hourly Rate (USD)"), "d1,Odd Name,83,Presser,Production,TCC SS Workshop,10/09/2026,10/09/2026 06:00 AM CDT,10/09/2026 02:00 PM CDT,8,America/Chicago,PAID,Web,Web,17.25"].join("\n");
      const r3 = await ingestRippling(d2, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", csv: odd });
      ok("rippling: a rate column with another name is found by its values", r3.rateColumn === "Employee Hourly Rate (USD)" && one(S2, "SELECT hourly_cents c FROM labor_pay_rates").c === 1725, r3);
    }
    const imp = await ingestRippling(sdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", csv: [hdr, "c1,Old Timer,82,Retail Advisor,Retail,TCC Quitman Retail,09/02/2026,09/02/2026 08:00 AM CDT,09/02/2026 01:00 PM CDT,5,America/Chicago,PAID,Web,Web,"].join("\n"), keepToday: true });
    ok("rippling: a hand import leaves today's punches alone", imp.used === 1 && one(S, "SELECT COUNT(*) n FROM labor_clock_today").n === 1);
  }
  {
    // the time clock record: a punch that shows up and is later removed in Rippling leaves a trace (Lupe, Oct 13)
    const { sqlite: T, db: tdb } = freshDb();
    const hdr = "time_entry_id,employee_name,employee_number,title,department_path,work_location,time_entry_date,clock_in_local,clock_out_local,duration_hours,timezone,status,clock_in_source,clock_out_source";
    const row = (id, name, no, inAt, outAt = "") => `${id},${name},${no},Presser,Production,TCC SS Workshop,10/13/2026,10/13/2026 ${inAt} CDT,${outAt ? `10/13/2026 ${outAt} CDT` : ""},,America/Chicago,${outAt ? "PAID" : "OPEN"},Web,${outAt ? "Web" : ""}`;
    const rep = rows => [hdr, ...rows].join("\n");
    const log = () => T.prepare("SELECT p.payroll_id AS no, l.change, substr(l.clock_in,12,5) AS i, substr(l.clock_out,12,5) AS o, substr(l.was_in,12,5) AS wi FROM labor_punch_log l JOIN core_people p ON p.id=l.person_id ORDER BY l.rowid").all();
    const r1 = await ingestRippling(tdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-13", csv: rep([row("e1", "Rosa Uno", 38, "04:48 AM"), row("e2", "Lupe Gallegos", 60, "06:12 AM")]) });
    ok("punch log: first report of the day logs each clock-in", r1.punchChanges === 2 && log().every(x => x.change === "in"), log());
    await ingestRippling(tdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-13", csv: rep([row("e1", "Rosa Uno", 38, "04:48 AM", "09:00 AM")]) });
    const L = log();
    ok("punch log: a clock-out and a removed punch are both recorded", L.length === 4 && L[2].change === "out" && L[2].o === "09:00" && L[3].change === "removed" && L[3].no === "60" && L[3].i === "06:12", L);
    ok("punch log: today's table now matches Rippling (no Lupe)", one(T, "SELECT COUNT(*) n FROM labor_clock_today").n === 1);
    await ingestRippling(tdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-13", csv: rep([row("e1", "Rosa Uno", 38, "04:40 AM", "09:00 AM")]) });
    const c = log().at(-1);
    ok("punch log: an edited punch keeps the time before the edit", c.change === "changed" && c.i === "04:40" && c.wi === "04:48", c);
    const n = log().length;
    await ingestRippling(tdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-13", csv: rep([row("e1", "Rosa Uno", 38, "04:40 AM", "09:00 AM")]) });
    ok("punch log: an identical report adds nothing but moves the 'as of' time", log().length === n && !!JSON.parse(one(T, "SELECT value_json v FROM core_settings WHERE key='rippling_last'").v).at);
  }
  ok("rippling: 12 PM and 12 AM", ripTime("10/12/2026 12:05 PM CDT").hm === "12:05" && ripTime("10/12/2026 12:05 AM CST").iso === "2026-10-12T00:05:00-06:00");
  let bad = null; try { await ingestRippling(rdb, { orgId: "tcc", integrationId: "rippling", today: "2026-10-12", csv: "a,b\n1,2" }); } catch (e) { bad = e.message; }
  ok("rippling: wrong file refused with a clear message", /missing/.test(bad || ""), bad);
  const H = o => ({ get: k => o[k.toLowerCase()] ?? null });
  ok("rippling sender: DKIM pass for rippling.com accepted", fromRippling("no-reply@rippling.com", H({ "authentication-results": "mx.cloudflare.net; dkim=pass header.d=rippling.com header.s=s1; spf=pass" })).ok);
  ok("rippling sender: no authentication refused", !fromRippling("no-reply@rippling.com", H({})).ok);
  ok("rippling sender: other domain refused", !fromRippling("no-reply@rippling.com.evil.io", H({ "authentication-results": "dkim=pass header.d=rippling.com" })).ok);
  ok("rippling sender: DKIM for another domain refused", !fromRippling("no-reply@rippling.com", H({ "authentication-results": "dkim=pass header.d=evil.com" })).ok);
}

// ================= the email handler end to end
{
  const { sqlite: E, db: edb } = freshDb();
  const env = { DB: edb, ORG_ID: "tcc", TIMEZONE: "America/Chicago", RIPPLING_INTEGRATION_ID: "rippling", FORWARD_TO: "neal@example.com" };
  const csv = "time_entry_id,employee_name,employee_number,title,department_path,work_location,time_entry_date,clock_in_local,clock_out_local,duration_hours,timezone,status,clock_in_source,clock_out_source\r\nz1,Pat Doe,77,Tech,Production,Workshop,10/01/2026,10/01/2026 06:00 AM CDT,10/01/2026 02:00 PM CDT,8,America/Chicago,PAID,Web,Web\r\n";
  const mime = (from, withCsv = true) => [
    `From: Rippling <${from}>`, "To: reports@netexcleaners.com", "Subject: Scheduled Report - All Time Clock Entries Export", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="B"', "", "--B", "Content-Type: text/plain", "", "Your report is attached.",
    ...(withCsv ? ["--B", 'Content-Type: text/csv; name="All Time Clock Entries Export.csv"', 'Content-Disposition: attachment; filename="All Time Clock Entries Export.csv"', "Content-Transfer-Encoding: base64", "", Buffer.from(csv).toString("base64")] : []),
    "--B--", ""].join("\r\n");
  const msg = (from, auth, withCsv) => { const fw = []; const raw = mime(from, withCsv);
    return { fw, from, to: "reports@netexcleaners.com", headers: new Headers(auth ? { "authentication-results": auth } : {}), raw: new Blob([raw]).stream(), rawSize: raw.length, forward: async to => fw.push(to) }; };
  const good = msg("no-reply@rippling.com", "mx.cloudflare.net; dkim=pass header.d=rippling.com; spf=pass", true);
  await worker.email(good, env, {});
  ok("email: Rippling export read and NOT forwarded", good.fw.length === 0 && one(E, "SELECT COUNT(*) n FROM labor_daily_hours").n === 1, good.fw);
  const fake = msg("no-reply@rippling.com", null, true);
  await worker.email(fake, env, {});
  ok("email: unverified 'Rippling' email forwarded, not read", fake.fw[0] === "neal@example.com" && one(E, "SELECT COUNT(*) n FROM core_people WHERE payroll_id='77'").n === 1);
  const other = msg("someone@gmail.com", "dkim=pass header.d=gmail.com", true);
  await worker.email(other, env, {});
  ok("email: other senders forwarded", other.fw[0] === "neal@example.com");
  const noCsv = msg("no-reply@rippling.com", "dkim=pass header.d=rippling.com", false);
  await worker.email(noCsv, env, {});
  ok("email: Rippling email without a CSV forwarded", noCsv.fw[0] === "neal@example.com");
}

// ============ Shuttle status: rack store, item return date, SMRT customer id, and "Check now"
{
  const { sqlite: S, db: sdb } = freshDb();
  const f = new FakeSmrt(), T = "2026-10-19";
  const o1 = f.addOrder("2026-10-16", "262891001", { status: "processing", pieces: 3, store: "TCC Greenville", due: `${T}T14:00:00-05:00` });
  const its = f.days.get("2026-10-16").items;
  its.forEach(i => { i["Customer Internal ID"] = "6p9avfo0b"; });
  Object.assign(its[0], { "Last Rack Location": "VAN", "Last racked store": "TCC Sulphur Springs", "Last racked on date": `${T}T13:10:00-05:00`, "Item Status": "racked" });
  Object.assign(its[1], { "Last Rack Location": "G30", "Last racked store": "TCC Greenville", "Item return date": null });
  Object.assign(its[2], { "Last Rack Location": "RETURNED", "Last racked store": "TCC Greenville", "Item return date": `${T}T15:00:00-05:00` });
  const s1 = new Smrt({ url: "https://x/graphql", key: "k", fetchImpl: f.fetchImpl });
  let c = await runCheck(sdb, s1, { orgId: "tcc", integrationId: "smrt", today: T, days: ["2026-10-16", "bad", "2025-01-01", "2026-10-30"], label: "Greenville" });
  ok("check: reads the days sent (+ today), drops bad or far-off days", c.status === "ok" && JSON.stringify(c.ranges) === JSON.stringify([["2026-10-16", "2026-10-17"], [T, "2026-10-20"]]), c);
  ok("check: pieces stored", c.items === 3 && one(S, "SELECT COUNT(*) n FROM pos_items").n === 3, c);
  const p = one(S, `SELECT l.name AS store, i.returned_at FROM pos_items i JOIN core_locations l ON l.id=i.last_rack_store_id WHERE i.last_rack_location='VAN'`);
  ok("rack store stored ('TCC Sulphur Springs' -> Sulphur Springs)", p && p.store === "Sulphur Springs" && p.returned_at === null, p);
  ok("item return date stored", !!one(S, "SELECT returned_at FROM pos_items WHERE last_rack_location='RETURNED'").returned_at);
  ok("SMRT customer id stored on the order", one(S, "SELECT customer_internal_id c FROM pos_orders").c === "6p9avfo0b");
  const run = one(S, "SELECT status, message FROM int_sync_runs ORDER BY started_at DESC LIMIT 1");
  ok("check: logged as a sync run", run.status === "ok" && /^check now Greenville: 1 orders, 3 pieces/.test(run.message), run);
  const calls = f.calls;
  c = await runCheck(sdb, s1, { orgId: "tcc", integrationId: "smrt", today: T, days: ["2026-10-16"] });
  ok(`check: same days again within ${CHECK_REPEAT_S}s doesn't call SMRT`, c.status === "recent" && f.calls === calls, c);
  c = await runCheck(sdb, s1, { orgId: "tcc", integrationId: "smrt", today: T, days: ["2026-10-16"], now: Date.now() + (CHECK_REPEAT_S + 5) * 1000 });
  ok("check: after that it reads again", c.status === "ok" && f.calls > calls, c);
  // a run in progress: Check now waits; the live sync skips while a check runs
  S.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status,message) VALUES('r1','smrt',?,'running','live')").run(new Date().toISOString());
  c = await runCheck(sdb, s1, { orgId: "tcc", integrationId: "smrt", today: T, days: ["2026-10-15"] });
  ok("check: busy while the live sync is reading SMRT", c.status === "busy" && c.what === "sync", c);
  S.prepare("UPDATE int_sync_runs SET message='check now Quitman' WHERE id='r1'").run();
  const lv = await runLive(sdb, s1, { orgId: "tcc", integrationId: "smrt", today: T });
  ok("live sync skips a round while a Check now is running", lv.status === "skipped", lv);
  S.prepare("UPDATE int_sync_runs SET started_at=? WHERE id='r1'").run(new Date(Date.now() - 5 * 60e3).toISOString());
  c = await runCheck(sdb, s1, { orgId: "tcc", integrationId: "smrt", today: T, days: ["2026-10-15"] });
  ok("a run stuck for over 4 minutes no longer blocks", c.status === "ok", c);
  // pieces stored before v2 are rewritten once with the new columns
  S.prepare("UPDATE pos_items SET last_rack_store_id=NULL, row_hash='old'").run();
  const st = await ingestDay(sdb, { orgId: "tcc", runId: null, mode: "live", day: "2026-10-16" }, await s1.dayObjects("ebe7b9bb-20b7-472b-9925-2b729fe2a38b", "2026-10-16"), await s1.dayObjects("8f6e82e5-8e64-466c-935a-35a22ee5fd01", "2026-10-16"));
  ok("older pieces get the rack store on their next read", st.itemsWritten === 3 && one(S, "SELECT COUNT(*) n FROM pos_items WHERE last_rack_store_id IS NOT NULL").n === 3, st);
  // the worker endpoint
  const env = { DB: sdb, ORG_ID: "tcc", SMRT_INTEGRATION_ID: "smrt", TIMEZONE: "America/Chicago", SMRT_URL: "https://x/graphql" };
  let res = await worker.fetch(new Request("https://sync/check", { method: "POST", body: "{}" }), env);
  ok("POST /check without the SMRT key says so", res.status === 503);
}

console.log(`\nSMRT calls made by the fake: ${fake.calls}`);
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
