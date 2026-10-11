// Tests for the pieces view (what's due, done, overdue, done ahead, expected). Run: node workers/planner/test/pieces.mjs
// Orders go in through netex-sync's own ingest code, the same path live SMRT data takes.
import { freshDb, makeEnv } from "./harness.mjs";
import { ingestDay } from "../../sync/src/ingest.js";
import { piecesView, nextWorkDay, categorizer } from "../src/pieces.js";
import { runsStmts } from "../src/settings.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const TODAY = "2026-10-12", NEXT = "2026-10-13";               // Monday, Tuesday
const AT = new Date("2026-10-12T15:00:00Z");                    // 10:00 am Central
const ts = (day, hm = "10:00") => `${day}T${hm}:00-05:00`;

const { db, sqlite } = freshDb();
const env = makeEnv(db, { TIMEZONE: "America/Chicago" });
sqlite.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status,message) VALUES('r1','smrt','2026-10-12T14:50:00Z','ok','live: test')").run();
sqlite.prepare("UPDATE int_sync_runs SET finished_at='2026-10-12T14:51:00Z' WHERE id='r1'").run();
await db.batch(await runsStmts(db, "tcc", null, [
  { name: "Winnsboro + Quitman", kind: "shuttle", driveBack: 30, stops: [{ store: "Winnsboro", arrive: "11:30", drive: 30, stay: 15, cutoff: "11:00" }, { store: "Quitman", arrive: "12:00", drive: 15, stay: 15, cutoff: "11:30" }] },
  { name: "Emory", kind: "shuttle", driveBack: 30, stops: [{ store: "Emory", arrive: "13:30", drive: 30, stay: 15, cutoff: "13:00" }] },
  { name: "Sulphur Springs store", kind: "counter", stops: [{ store: "Sulphur Springs", arrive: "16:00", drive: 0, stay: 0, cutoff: "18:00" }] },
]));

const orders = [], items = [];
let n = 0;
function order(created, { due, store = "TCC Quitman", status = "processing", pieces = [], count, deps }) {
  const id = `2628${String(++n).padStart(5, "0")}`;
  orders.push({ "ID": id, "Status": status, "Due date": due, "Created": created, "Piece Count": String(count ?? pieces.length), "Return Location": store, "Agent": store,
    "Financial department(s)": deps || [...new Set(pieces.map(p => p.dep))].join(", ") });
  pieces.forEach((p, i) => items.push({ "Sale Id": id, "Barcode": `${id}${i}`, "Item Status": p.status || "detailed", "Financial department": p.dep, "Item Type": p.type || "Shirt",
    "Created": created, "Item assembly date": p.asm || null, "Item removal date": p.removed || null, "Lot status": p.lot || null, "Picked up date": p.picked || null,
    "Item base price": p.cents != null ? String(p.cents) : null, "Item Notes": p.note || null }));
  return id;
}
const DCT = "Dry Cleaning Tops", DCB = "Dry Cleaning Bottoms", SLT = "Laundry Tops", SLB = "Laundry Bottoms";
// due today, Quitman: 2 DC tops (one finished Friday), 1 laundry top finished this morning
order(ts("2026-10-09"), { due: ts(TODAY, "12:00"), pieces: [{ dep: DCT, status: "assembled", asm: ts("2026-10-09", "15:00") }, { dep: DCT }, { dep: SLT, status: "assembled", asm: ts(TODAY, "08:00") }] });
// due today, Sulphur Springs: a comforter filed under Laundry Bottoms -> comforter
order(ts("2026-10-09"), { due: ts(TODAY, "17:00"), store: "TCC Sulphur Springs", pieces: [{ dep: SLB, type: "Comforter King" }] });
// overdue (due Friday), still open: 2 laundry bottoms, one in the washer
order(ts("2026-10-08"), { due: ts("2026-10-09", "12:00"), pieces: [{ dep: SLB, lot: "Washing" }, { dep: SLB, status: "to pre-spot" }] });
// overdue but every piece assembled (order status not "ready" yet): done for production, not late
order(ts("2026-10-08"), { due: ts("2026-10-09", "12:00"), status: "assembled", pieces: [{ dep: SLB, status: "assembled", asm: ts("2026-10-09", "09:00") }] });
// due tomorrow, Emory: 4 DC bottoms, one finished today (work done ahead)
order(ts("2026-10-09"), { due: ts(NEXT, "13:00"), store: "TCC Emory", pieces: [{ dep: DCB, status: "assembled", asm: ts(TODAY, "09:00") }, { dep: DCB }, { dep: DCB }, { dep: DCB }] });
// due today, picked up today: all done today
order(ts("2026-10-09"), { due: ts(TODAY, "12:00"), status: "pickedUp", pieces: [{ dep: DCT, picked: ts(TODAY, "09:30") }, { dep: DCT, picked: ts(TODAY, "09:30") }] });
// deleted order: ignored
order(ts("2026-10-09"), { due: ts(TODAY, "12:00"), status: "deleted", pieces: [{ dep: DCT }] });
// wash & fold isn't mapped
order(ts("2026-10-09"), { due: ts(TODAY, "12:00"), pieces: [{ dep: "Wash & Fold" }] });
// a removed piece doesn't count
order(ts("2026-10-09"), { due: ts(TODAY, "12:00"), pieces: [{ dep: SLT }, { dep: SLT, removed: ts(TODAY, "07:00") }] });
// not detailed yet: just a piece count and one department
order(ts(TODAY, "07:00"), { due: ts(TODAY, "16:00"), store: "TCC Sulphur Springs", pieces: [], count: 5, deps: SLT });
// priced laundry tops, for the average price (16 pieces at $3.50, finished last week so they don't change the counts)
order(ts("2026-10-05"), { due: ts(NEXT, "16:00"), store: "TCC Sulphur Springs", status: "ready",
  pieces: Array.from({ length: 16 }, () => ({ dep: SLT, cents: 350, status: "assembled", asm: ts("2026-10-07") })) });
// history for the forecast: past Tuesdays at Emory, 40 pieces known by Monday 10 am, 20 more after
for (const tue of ["2026-10-06", "2026-09-29", "2026-09-22"]) {
  const mon = new Date(Date.parse(tue + "T12:00:00Z") - 864e5).toISOString().slice(0, 10);
  order(ts(mon, "08:00"), { due: ts(tue, "13:00"), store: "TCC Emory", status: "pickedUp", count: 40, deps: DCB });
  order(ts(mon, "14:00"), { due: ts(tue, "13:00"), store: "TCC Emory", status: "pickedUp", count: 20, deps: DCB });
}
await ingestDay(db, { orgId: "tcc", runId: "r1", mode: "backfill", day: "2026-09-21" }, orders, items);

const V = await piecesView(db, env, { at: AT });
const T = V.days[TODAY], N = V.days[NEXT];

console.log("pieces");
await t("today and the next work day", () => { eq([V.today, V.next, V.isWorkDay], [TODAY, NEXT, true]); eq(nextWorkDay("2026-10-09", [1, 2, 3, 4, 5]), "2026-10-12", "Friday -> Monday"); });
await t("today: due less finished before today; finished today still counts", () => {
  eq(T.q, { dct: 1 + 2, dcb: 0, slt: 1 + 1 + 5, slb: 0, comf: 1, tc: 0 });
  eq(T.done, { dct: 2, dcb: 0, slt: 1, slb: 0, comf: 0, tc: 0 });
});
await t("item type wins over department (comforter under Laundry Bottoms)", () => eq(T.q.comf, 1));
await t("deleted orders and removed pieces don't count; unmapped departments are reported", () => { eq(V.unmapped["Wash & Fold"], 1); });
await t("overdue: open pieces from earlier days", () => { eq(V.overdue.q.slb, 2); eq(V.overdue.orders, 1); });
await t("late list shows the overdue order with where its pieces are", () => {
  const o = V.late.find(x => x.overdue);
  ok(o, "overdue order listed"); eq(V.late.filter(x => x.overdue).length, 1, "all-assembled order not listed"); eq(o.left, 2); eq(o.washing, 1); eq(Object.keys(o.open).sort(), ["detailed (washing)", "to pre-spot"]);
});
await t("stores grouped by shuttle run / counter, earliest deadline first", () => {
  eq(T.stores.map(s => [s.loc, s.run, s.deadline]), [["Quitman", "Winnsboro + Quitman", 11 * 60], ["Sulphur Springs", "Sulphur Springs store", 16 * 60]]);
});
await t("next day: less work done ahead; done-ahead count", () => { eq(N.q.dcb, 3); eq(N.aheadToday, 1); });
await t("next day: Emory scaled by its history (60 / 40 = 1.5) until its cutoff", () => {
  const em = N.stores.find(s => s.loc === "Emory");
  eq(em.ratio, 1.5); eq(em.expected.dcb, 5); eq(em.final, false);
});
await t("after the store's drop-off cutoff the count is final", async () => {
  const late = await piecesView(db, env, { at: new Date("2026-10-12T19:30:00Z") }); // 2:30 pm, Emory cutoff 1 pm
  const em = late.days[NEXT].stores.find(s => s.loc === "Emory");
  eq(em.final, true); eq(em.expected.dcb, 3);
});
await t("forecast looks back the same number of days (Saturday for Monday compares with the Saturday before past Mondays)", async () => {
  const { forecastRatios } = await import("../src/pieces.js");
  // past Mondays at Emory: 30 pieces known by the Saturday before at 10 am, 30 more after -> 2.0
  const o2 = [], i2 = [];
  for (const mon of ["2026-10-05", "2026-09-28", "2026-09-21"]) {
    const sat = new Date(Date.parse(mon + "T12:00:00Z") - 2 * 864e5).toISOString().slice(0, 10);
    for (const [c, hm] of [[30, "08:00"], [30, "15:00"]]) o2.push({ "ID": `27${mon.replace(/-/g, "")}${hm.slice(0, 2)}`, "Status": "pickedUp", "Due date": ts(mon, "13:00"), "Created": ts(sat, hm), "Piece Count": String(c), "Return Location": "TCC Winnsboro", "Financial department(s)": DCB });
  }
  await ingestDay(db, { orgId: "tcc", runId: "r1", mode: "backfill", day: "2026-09-19" }, o2, i2);
  const f = await forecastRatios(db, "tcc", { today: "2026-10-10", next: "2026-10-12", hm: "10:00", workDays: [1, 2, 3, 4, 5], runs: [] });
  eq(f.byLoc["Winnsboro"].ratio, 2);
});
await t("average price from SMRT when 15+ priced pieces", () => eq(V.prices.slt, 3.5));
await t("SMRT freshness reported", () => eq(V.smrt.lastOk, "2026-10-12T14:51:00Z"));
await t("weekend: no 'today', plans the next work day", async () => {
  const sat = await piecesView(db, env, { at: new Date("2026-10-10T15:00:00Z") });
  eq([sat.isWorkDay, sat.next, sat.days["2026-10-10"]], [false, "2026-10-12", null]);
});
await t("undetailed order with several departments is reported, not called unmapped", async () => {
  const o3 = [{ "ID": "263000001", "Status": "processing", "Due date": ts(NEXT, "12:00"), "Created": ts(TODAY, "08:00"), "Piece Count": "7", "Return Location": "TCC Quitman", "Financial department(s)": "Dry Cleaning Tops, Laundry Tops" }];
  await ingestDay(db, { orgId: "tcc", runId: "r1", mode: "backfill", day: TODAY }, o3, []);
  const v = await piecesView(db, env, { at: AT });
  eq(v.undetailed[NEXT], 7); ok(!v.unmapped["Dry Cleaning Tops"], JSON.stringify(v.unmapped));
});
await t("categorizer: comma lists, case-insensitive", () => {
  const c = categorizer({ departments: { dct: "Dry Cleaning Tops, DC Tops" }, itemTypes: { tc: "Tablecloth, Table Cloth" } });
  eq([c("Shirt", "dc tops"), c("Round TABLE CLOTH", "Dry Cleaning Bottoms"), c("Shirt", "Alterations")], ["dct", "tc", null]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
