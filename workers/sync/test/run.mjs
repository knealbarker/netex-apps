// Tests for the SMRT history backfill and order/piece storage.
// Uses Node's built-in SQLite in place of D1 and a fake SMRT with the real report columns (made-up values).
// Run: node workers/sync/test/run.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Smrt } from "../src/smrt.js";
import { runBackfill, backfillProgress } from "../src/backfill.js";
import { ingestDay } from "../src/ingest.js";
import { addDays, ulid } from "../src/util.js";
import { backfillAllowed } from "../src/index.js";

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
  s.exec(readFileSync(join(MIG, "0001_initial.sql"), "utf8")); s.exec(readFileSync(join(MIG, "0002_seed.sql"), "utf8"));
  return { sqlite: s, db: d1(s) };
}

// ---- fake SMRT: the real column names of both saved reports
const ORDER_COLS = ["ID","Customer Id","Agent","Payment Setting","Created by","Detailed by","Return Location","Returned by","Status","Order Type","Piece Count","Original Piece Count","Weight In","Weight Out","Price","Paid amount (inc. deposits)","Is Paid","Is Pre Paid","Weight","Discounted Amount","Before Discount Amount","Total Tax","Taxable Amount","Created","Due date","Detailed date","Assembled by","Is Route Delivery","Is Route Pickup","Assembly date","Returned date","Ready date","Paid date","Deleted date","Payment Method","Paid by","Promotion","Promotion applied date","Financial department(s)","Surcharge Amount"];
const ITEM_COLS = ["Sale Id","Customer ID","Customer Internal ID","Status","Assembled by","Lot status","Item Status","Price","Discounted amount","Item base price","Up Charge Amount","Created","Detailed date","Order Assembly date","Returned date","Ready date","Paid date","Delivered date","Picked up date","Order Type","Classification","Last Assembly Location","Item Type","Item Type Alias","Brand","Item Description","Special cares","Colors","Fabrics","Detailed by","Pattern","Returned by","Financial department","Barcode","Category","Item assembly date","Item removal date","Item detail date","Item return date","Last Rack Location","Last racked by","Last racked store","Last racked on date","Surcharge name","Order Notes","Item Notes"];

class FakeSmrt {
  constructor() { this.days = new Map(); this.calls = 0; this.failOnce = new Set(); }
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
    const id = /getReport\(id:"([^"]+)"/.exec(q)[1], start = /startDate:"([^"]+)"/.exec(q)[1];
    const day = start.slice(0, 10);
    if (this.failOnce.has(day + id)) { this.failOnce.delete(day + id); return new Response("oops", { status: 502 }); }
    const isOrders = id.startsWith("ebe7");
    const cols = isOrders ? ORDER_COLS : ITEM_COLS;
    let body;
    if (q.includes("columns")) body = { data: { business: { getReport: { columns: cols.map(name => ({ name })) } } } };
    else { const d = this.days.get(day) || { orders: [], items: [] }; const rows = (isOrders ? d.orders : d.items).map(r => ({ value: cols.map(c => r[c]) }));
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
ok("lookups created (statuses, departments, stores, staff)", one(sqlite, "SELECT COUNT(*) n FROM core_locations").n === 2 && one(sqlite, "SELECT COUNT(*) n FROM pos_staff").n === 2 && one(sqlite, "SELECT COUNT(*) n FROM pos_order_departments").n === 8);
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
// ---- when the history load may run (2026-10-10 is a Saturday, 10-12 a Monday)
ok("weekend: runs at 10 am", backfillAllowed({ day: "2026-10-10", hour: 10 }));
ok("weekend: runs on Sunday afternoon", backfillAllowed({ day: "2026-10-11", hour: 15 }));
ok("work day: waits at 10 am", !backfillAllowed({ day: "2026-10-12", hour: 10 }));
ok("work day: runs at 9 pm and 3 am", backfillAllowed({ day: "2026-10-12", hour: 21 }) && backfillAllowed({ day: "2026-10-13", hour: 3 }));
ok("work day: stops at 5 am", !backfillAllowed({ day: "2026-10-13", hour: 5 }));
ok("custom work days: Saturday as a work day waits", !backfillAllowed({ day: "2026-10-10", hour: 10, workDays: [1, 2, 3, 4, 5, 6] }));

console.log(`\nSMRT calls made by the fake: ${fake.calls}`);
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
