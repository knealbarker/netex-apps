// Shuttle status (/shuttlestatus): which pieces due at a store aren't on VAN yet, held-over pieces and their notes,
// Check now (through the SYNC service binding), and the page itself in headless Chromium (desktop and phone).
// Orders go in through netex-sync's own ingest code, the same path live SMRT data takes. Run: node workers/planner/test/shuttle.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, fakeAccess, makeEnv, serve } from "./harness.mjs";
import { handle } from "../src/index.js";
import { ingestDay } from "../../sync/src/ingest.js";
import { runsStmts } from "../src/settings.js";
import { localNow, addDays } from "../src/pieces.js";
import { shuttleView, dayStartUtc } from "../src/shuttle.js";

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require("playwright")); } catch { try { ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright")); } catch { /* no browser tests */ } }
const SHOTS = process.env.SHOTS || join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const TODAY = localNow("America/Chicago").day, YDAY = addDays(TODAY, -1), TMRW = addDays(TODAY, 1);
const ts = (day, hm = "10:00") => `${day}T${hm}:00-05:00`;
const A = await fakeAccess();
const { db, sqlite } = freshDb();
let syncCalls = [];
const SYNC = { fetch: async (url, init) => { syncCalls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ status: "ok", at: new Date().toISOString(), calls: 4 }), { headers: { "content-type": "application/json" } }); } };
const env = makeEnv(db, { TIMEZONE: "America/Chicago", SYNC });
const call = async (method, path, { body, as = "neal@towncountryclean.com", e = env } = {}) => {
  const h = new Headers({ "cf-access-jwt-assertion": await A.token({ email: as }) }); if (body) h.set("content-type", "application/json");
  const r = await handle(new Request(`https://x.test${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), e, { fetchImpl: A.fetchImpl });
  const type = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, body: type.includes("json") ? await r.json() : await r.text() };
};

sqlite.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,finished_at,status,message) VALUES('r1','smrt',?,?,'ok','live: test')").run(new Date(Date.now() - 3 * 60e3).toISOString(), new Date(Date.now() - 2 * 60e3).toISOString());
await db.batch(await runsStmts(db, "tcc", null, [
  { name: "Winnsboro + Quitman", kind: "shuttle", driveBack: 30, stops: [{ store: "Winnsboro", arrive: "11:30", drive: 30, stay: 15, cutoff: "11:00" }, { store: "Quitman", arrive: "12:00", drive: 15, stay: 15, cutoff: "11:30" }] },
  { name: "Emory", kind: "shuttle", driveBack: 30, stops: [{ store: "Emory", arrive: "13:30", drive: 30, stay: 15, cutoff: "13:00" }] },
  { name: "Greenville", kind: "shuttle", driveBack: 30, stops: [{ store: "Greenville", arrive: "14:30", drive: 30, stay: 15, cutoff: "14:30" }] },
  { name: "Sulphur Springs store", kind: "counter", stops: [{ store: "Sulphur Springs", arrive: "16:00", drive: 0, stay: 0, cutoff: "18:00" }] },
]));

// ---- SMRT rows (the real column names), one created day per group
const days = new Map();
let n = 0;
function order(created, { due, store = "TCC Quitman", status = "processing", pieces = [], count, route = false, picked = null, note = null, type = "Dry Cleaning" }) {
  const id = `2629${String(++n).padStart(5, "0")}`;
  const d = days.get(created) || days.set(created, { orders: [], items: [] }).get(created);
  d.orders.push({ "ID": id, "Customer Id": "C" + n, "Customer Name": store === "TCC Greenville" ? `Pat Customer${n}` : null, "Status": status, "Due date": due, "Created": ts(created), "Piece Count": String(count ?? pieces.length), "Return Location": store, "Agent": store,
    "Is Route Delivery": route ? "true" : "", "Order Type": type, "Financial department(s)": type === "Wash & Fold" ? "Wash & Fold" : "Dry Cleaning Tops" });
  pieces.forEach((p, i) => d.items.push({ "Sale Id": id, "Customer Internal ID": "cust" + n, "Barcode": `${id}${i}`, "Item Status": p.status || "detailed", "Financial department": "Dry Cleaning Tops",
    "Item Type": p.type || "Shirt L", "Colors": p.colors || "blue", "Created": ts(created), "Item assembly date": p.asm || null, "Lot status": p.lot || null, "Picked up date": picked,
    "Item return date": p.ret || null, "Last Rack Location": p.rack || null, "Last racked store": p.rackStore || null, "Last racked on date": p.rackedAt || null,
    "Last racked by": p.rack ? "Larry N" : null, "Item Notes": p.note || null, "Order Notes": note }));
  return id;
}
const VAN = (day = TODAY) => ({ status: "racked", asm: ts(day, "08:00"), rack: "VAN", rackStore: "TCC Sulphur Springs", rackedAt: ts(day, "10:40") });
// Quitman
const a = order(YDAY, { due: ts(TODAY, "12:00"), pieces: [VAN(), { status: "assembled", asm: ts(TODAY, "09:00"), rack: "PH84", rackStore: "TCC Sulphur Springs", rackedAt: ts(TODAY, "09:05") }, { lot: "Washing" }] });
const b = order(addDays(TODAY, -3), { due: ts(YDAY, "12:00"), pieces: [{ status: "racked", asm: ts(YDAY, "08:00"), rack: "Q153", rackStore: "TCC Quitman", rackedAt: ts(YDAY, "12:20") }, VAN(addDays(TODAY, -2))] });
order(YDAY, { due: ts(TODAY, "12:00"), pieces: [{ status: "customer", rack: "RETURNED", rackStore: "TCC Quitman", ret: ts(TODAY, "09:00") }] });       // back with the customer
order(YDAY, { due: ts(TODAY, "12:00"), status: "pickedUp", picked: ts(TODAY, "08:00"), pieces: [{ status: "customer" }] });                        // picked up
order(YDAY, { due: ts(TODAY, "08:00"), route: true, pieces: [{ status: "assembled", asm: ts(YDAY, "15:00"), rack: "PH01", rackStore: "TCC Sulphur Springs" }] }); // route delivery
const f = order(TODAY, { due: ts(TODAY, "12:00"), status: "undetailed", count: 3 });                                                                // not detailed
const g = order(YDAY, { due: ts(TODAY, "12:00"), pieces: [{ lot: "Washing" }] });                                                                    // will be held over, no note
const h = order(YDAY, { due: ts(TODAY, "12:00"), pieces: [{ status: "to pre-spot", note: "Stain on collar, second treatment" }] });                  // held over, noted
order(YDAY, { due: ts(TMRW, "12:00"), pieces: [{}] });                                                                                               // due tomorrow
order(addDays(TODAY, -50), { due: ts(addDays(TODAY, -49), "12:00"), pieces: [{}] });                                                                 // too old
// Greenville: all on the van (one taken early, already at the store)
order(YDAY, { due: ts(TODAY, "14:00"), store: "TCC Greenville", pieces: [VAN(), VAN(), { status: "racked", asm: ts(YDAY, "09:00"), rack: "G LONG", rackStore: "TCC Greenville" }] });
// Winnsboro: Wash & Fold orders (SMRT's items report never lists the bag): one ready, one still washing
const wfReady = order(YDAY, { due: ts(TODAY, "11:30"), store: "TCC Winnsboro", type: "Wash & Fold", status: "assembled", count: 1 });
const wfWashing = order(YDAY, { due: ts(TODAY, "11:30"), store: "TCC Winnsboro", type: "Wash & Fold", status: "processing", count: 1 });
// Emory: nothing due; Winnsboro: one deleted order
order(YDAY, { due: ts(TODAY, "12:00"), store: "TCC Winnsboro", status: "deleted", pieces: [{}] });

const load = async (mode = "live") => { for (const [day, d] of [...days].sort()) await ingestDay(db, { orgId: "tcc", runId: null, mode, day }, d.orders, d.items); };
await load("backfill");
// later: g and h moved to tomorrow in SMRT
for (const d of days.values()) for (const o of d.orders) if (o.ID === g || o.ID === h) o["Due date"] = ts(TMRW, "12:00");
await load("live");
const stores = Object.fromEntries((await db.prepare("SELECT name, id FROM core_locations").all()).results.map(r => [r.name, r.id]));

await t("stores come from the shuttle runs, with when the van leaves", async () => {
  const v = await shuttleView(db, env, {});
  eq(v.stores.map(s => [s.name, s.leaves]), [["Winnsboro", "11:00"], ["Quitman", "11:00"], ["Emory", "13:00"], ["Greenville", "14:00"]]);
});
let q;
await t("Quitman: what's counted and what's left out", async () => {
  q = await shuttleView(db, env, { storeId: stores.Quitman });
  const byOrder = no => q.rows.filter(r => r.orderNo === no).map(r => r.status);
  eq(byOrder(a), ["blocked", "blocked", "van"], "order a");
  eq(byOrder(b), ["van"], "order b (one piece already at Quitman)");
  eq(byOrder(f), ["blocked"], "undetailed order");
  eq(byOrder(g), ["held"]); eq(byOrder(h), ["held"]);
  eq(q.rows.length, 7, "returned, picked up, route, due tomorrow and old orders left out");
});
await t("rows: not on VAN first, held over without a note next, then noted, then on VAN", async () => {
  eq(q.rows.map(r => r.status), ["blocked", "blocked", "blocked", "held", "held", "van", "van"]);
  eq(q.rows[3].orderNo, g, "the one without a note first");
});
await t("reasons: not ready, ready on a plant rack, not detailed", async () => {
  const r = Object.fromEntries(q.rows.filter(x => x.status === "blocked").map(x => [x.kind === "order" ? "order" : x.rack || "none", x.reason]));
  eq(Object.entries(r).sort(), [["PH84", "Ready, on PH84"], ["none", "Not ready"], ["order", "Not detailed yet"]]);
});
await t("Quitman totals: 2 on VAN, 5 not (3 pieces of an undetailed order), 2 held, 1 needs a note", async () => {
  const s = q.stores.find(x => x.id === stores.Quitman);
  eq([s.van, s.blocked, s.notReady, s.held, s.heldNoNote, s.ok], [2, 5, 4, 2, 1, false]);
});
await t("a piece on VAN since an earlier day is flagged", async () => {
  const r = q.rows.find(x => x.orderNo === b);
  eq(r.vanSince, addDays(TODAY, -2));
});
await t("held over: shows the old due date and the note", async () => {
  const hr = q.rows.find(x => x.orderNo === h);
  ok(hr.noted && /collar/.test(hr.note) && hr.heldFrom.startsWith(TODAY), JSON.stringify(hr));
});
await t("SMRT link opens the order", async () => {
  ok(/clothestracker\/cust1\/\?saleId=2629/.test(q.rows.find(x => x.orderNo === a).link));
});
await t("Greenville is OK to leave; Emory has nothing due; a deleted order doesn't count", async () => {
  const v = await shuttleView(db, env, {});
  const s = Object.fromEntries(v.stores.map(x => [x.name, x]));
  eq([s.Greenville.ok, s.Greenville.van, s.Greenville.pieces], [true, 2, 2]);
  eq(s.Emory.nothing, true);
});
await t("Wash & Fold: a ready bag is listed to check by hand and doesn't hold up the run; one not ready does", async () => {
  const v = await shuttleView(db, env, { storeId: stores.Winnsboro });
  const by = no => v.rows.find(r => r.orderNo === no);
  eq([by(wfReady).status, by(wfReady).item, by(wfWashing).status, by(wfWashing).reason], ["wf", "Wash & Fold bag", "blocked", "Wash & Fold not ready"]);
  const s = v.stores.find(x => x.id === stores.Winnsboro);
  eq([s.wf, s.blocked, s.ok], [1, 1, false]);
  sqlite.prepare("UPDATE pos_orders SET status_id=(SELECT status_id FROM pos_orders WHERE smrt_order_no=?) WHERE smrt_order_no=?").run(wfReady, wfWashing);
  const s2 = (await shuttleView(db, env, {})).stores.find(x => x.id === stores.Winnsboro);
  eq([s2.wf, s2.blocked, s2.ok], [2, 0, true], "both ready: OK to leave, 2 bags to check");
});
await t("a piece read before rack stores were kept counts as at the store when its rack is that store's (G18), not when the rack is shared (LONG)", async () => {
  const gv = stores.Greenville;
  // two Greenville pieces with the store blanked (as read before Oct 18): one on G LONG (only ever Greenville's), one on LONG (shared)
  const ids = sqlite.prepare("SELECT i.id FROM pos_items i JOIN pos_orders o ON o.id=i.order_id WHERE o.return_location_id=? AND i.last_rack_location='VAN' ORDER BY i.id").all(gv).map(r => r.id);
  sqlite.prepare("UPDATE pos_items SET last_rack_location='G LONG', last_rack_store_id=NULL WHERE id=?").run(ids[0]);
  sqlite.prepare("UPDATE pos_items SET last_rack_location='LONG', last_rack_store_id=NULL WHERE id=?").run(ids[1]);
  // other pieces show LONG at two stores
  sqlite.prepare("UPDATE pos_items SET last_rack_location='LONG', last_rack_store_id=? WHERE id IN (SELECT i.id FROM pos_items i JOIN pos_orders o ON o.id=i.order_id WHERE o.smrt_order_no=? LIMIT 1)").run(stores["Sulphur Springs"], h);
  sqlite.prepare("UPDATE pos_items SET assembled_at=? WHERE last_rack_location IN ('G LONG','LONG')").run(ts(YDAY, "09:00"));
  sqlite.prepare("INSERT INTO pos_items(id, order_id, barcode, line_no, item_type_id, department_id, last_rack_location, last_rack_store_id, assembled_at, smrt_created_at, row_hash) SELECT 'xlong', order_id, 'x1', 99, item_type_id, department_id, 'LONG', ?, ?, smrt_created_at, 'x' FROM pos_items WHERE id=?").run(gv, ts(YDAY, "09:00"), ids[0]);
  sqlite.prepare("UPDATE pos_items SET removed_at=? WHERE id='xlong'").run(ts(YDAY));
  const v = await shuttleView(db, env, { storeId: gv });
  eq(v.rows.filter(r => r.status === "blocked").map(r => r.rack), ["LONG"], "G LONG left out (Greenville's rack); LONG still listed");
  // a numbered rack never seen with a store: its letters decide (G77 -> Greenville, like G LONG... and the known G racks)
  sqlite.prepare("UPDATE pos_items SET last_rack_location='G30', last_rack_store_id=? WHERE id='xlong'").run(gv);
  sqlite.prepare("UPDATE pos_items SET last_rack_location='G77' WHERE id=?").run(ids[1]);
  const v2 = await shuttleView(db, env, { storeId: gv });
  eq(v2.rows.filter(r => r.status === "blocked").length, 0, "G77 taken as Greenville's (G30 is)");
  // put the test data back for the rest of the suite
  sqlite.prepare("UPDATE pos_items SET last_rack_location='VAN', last_rack_store_id=? WHERE id IN (?, ?)").run(stores["Sulphur Springs"], ids[0], ids[1]);
  sqlite.prepare("UPDATE pos_items SET last_rack_location=NULL, last_rack_store_id=NULL WHERE last_rack_location='LONG' AND id<>'xlong'").run();
});
await t("tickets: an order with ticket scans is listed ticket by ticket (+ its items not ready); at the store = left out", async () => {
  const tk = (id, loc, store, hhmm = "11:30", name = "MIKE FOUNTAIN") => sqlite.prepare("INSERT INTO pos_tickets(org_id,ticket_id,order_no,letter,location,store_id,at,racked_by,customer_name,first_at) VALUES('tcc',?,?,?,?,?,?,?,?,?)")
    .run(`${a.slice(0, 5)}-${a.slice(5)}-${id}`.replace(a.slice(0, 5) + "-" + a.slice(5), id.includes("|") ? "" : `${a.slice(0, 5)}-${a.slice(5)}`), a, id, loc, store, ts(TODAY, hhmm), "Larry N", name, ts(TODAY, "09:00"));
  tk("A", "VAN", stores["Sulphur Springs"]); tk("B", "Bagging", stores["Sulphur Springs"], "11:00");
  // order b: its ticket was scanned at Quitman (taken earlier) -> nothing left for this run
  sqlite.prepare("INSERT INTO pos_tickets(org_id,ticket_id,order_no,letter,location,store_id,at,racked_by,first_at) VALUES('tcc',?,?,'A','Q12',?,?,'Kay Q',?)").run(`${b.slice(0, 5)}-${b.slice(5)}-A`, b, stores.Quitman, ts(YDAY, "12:20"), ts(YDAY, "09:00"));
  // the W&F order still washing at Winnsboro has a ticket on VAN -> on VAN like everything else
  sqlite.prepare("INSERT INTO pos_tickets(org_id,ticket_id,order_no,letter,location,store_id,at,racked_by,first_at) VALUES('tcc',?,?,'A','VAN',?,?,'Larry N',?)").run(`${wfWashing.slice(0, 5)}-${wfWashing.slice(5)}-A`, wfWashing, stores["Sulphur Springs"], ts(TODAY, "11:33"), ts(TODAY, "09:00"));
  try {
    const v = await shuttleView(db, env, { storeId: stores.Quitman });
    const ra = v.rows.filter(r => r.orderNo === a).map(r => [r.kind, r.status, r.tag || r.item, r.reason || ""]);
    eq(ra, [["items", "blocked", "1 item not in a ticket yet", "Not ready"], ["ticket", "blocked", `${a.slice(0, 5)}-${a.slice(5)}-B`, "Ticket at Bagging"], ["ticket", "van", `${a.slice(0, 5)}-${a.slice(5)}-A`, ""]]);
    eq(v.rows.filter(r => r.orderNo === b).length, 0, "order b's ticket is at Quitman");
    eq(v.rows.find(r => r.kind === "ticket").customer, "MIKE FOUNTAIN");
    const s = v.stores.find(x => x.id === stores.Quitman);
    ok(s.vanTickets === 1 && s.blockedTickets === 1, JSON.stringify(s));
    const w = await shuttleView(db, env, { storeId: stores.Winnsboro });
    eq(w.rows.find(r => r.orderNo === wfWashing).status, "van", "W&F ticket on VAN");
  } finally { sqlite.prepare("DELETE FROM pos_tickets").run(); }
});
await t("API: GET /api/shuttle with a store, any signed-in role", async () => {
  const u = await call("POST", "/api/users", { body: { name: "Larry N", email: "larry@example.com", role: "viewer" } });
  ok(u.status === 201, JSON.stringify(u.body));
  const r = await call("GET", `/api/shuttle?store=${stores.Greenville}`, { as: "larry@example.com" });
  eq(r.status, 200); eq(r.body.rows.length, 2); ok(r.body.asOf && r.body.sync === true);
  eq((await call("GET", `/api/shuttle?store=${stores["Sulphur Springs"]}`)).status, 404, "not a shuttle store");
  ok(/^Pat Customer\d+$/.test(r.body.rows[0].customer), "name from the report's Customer Name column");
  eq(q.rows[0].customer, "C1", "no name column: the SMRT customer id");
});
await t("Check now sends only the created days of orders still holding up the run, then answers with the fresh view", async () => {
  syncCalls = [];
  const r = await call("POST", "/api/shuttle/check", { body: { store: stores.Quitman }, as: "larry@example.com" });
  eq(r.status, 200); eq(r.body.check.status, "ok"); eq(r.body.rows.length, 7);
  eq(syncCalls.length, 1); eq(syncCalls[0].label, "Quitman");
  eq(syncCalls[0].days, [YDAY, TODAY], "order b (all on VAN or at the store) isn't re-read");
});
await t("Check now without the SYNC binding says so", async () => {
  const r = await call("POST", "/api/shuttle/check", { body: { store: stores.Quitman }, e: makeEnv(db, { TIMEZONE: "America/Chicago" }) });
  eq(r.status, 503); ok(/SYNC/.test(r.body.error));
});
await t("Check now when netex-sync fails still shows the last copy", async () => {
  const e = makeEnv(db, { TIMEZONE: "America/Chicago", SYNC: { fetch: async () => new Response(JSON.stringify({ status: "error", error: "SMRT rejected the API key" }), { status: 502 }) } });
  const r = await call("POST", "/api/shuttle/check", { body: { store: stores.Quitman }, e });
  eq(r.status, 200); eq(r.body.check.status, "error"); eq(r.body.rows.length, 7);
});
await t("/shuttlestatus redirects to the page; the page needs a sign-in", async () => {
  const r = await call("GET", "/shuttlestatus");
  eq(r.status, 302); ok(r.headers.get("location").endsWith("/shuttlestatus/"));
  const page = await handle(new Request("https://x.test/shuttlestatus/"), env, { fetchImpl: A.fetchImpl });
  ok(page.status >= 400, "no Access token, no page");
});
await t("day start in UTC follows Central time", async () => {
  eq(dayStartUtc("2026-10-18"), "2026-10-18T05:00:00.000Z"); eq(dayStartUtc("2026-12-01"), "2026-12-01T06:00:00.000Z");
});

// ---- the page in Chromium
if (!chromium) console.log("  (browser part skipped: Playwright not found)");
else {
  const { server, url } = await serve(env, { fetchImpl: A.fetchImpl, token: A.token, who: () => "larry@example.com" });
  const browser = await chromium.launch();
  const errors = [];
  const open = async (viewport, scheme = "dark") => {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme });
    const p = await ctx.newPage();
    p.on("pageerror", e => errors.push(e.message)); p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    return p;
  };
  try {
    const p = await open({ width: 1366, height: 900 });
    await t("page: opens on the first store that isn't ready, with the answer at the top", async () => {
      await p.goto(`${url}/shuttlestatus`);
      await p.waitForSelector(".sh-banner");
      const h1 = await p.textContent(".sh-banner h1");
      ok(/Not yet — 5 items aren't on VAN/.test(h1), h1);
      ok((await p.getAttribute('.sh-tab[aria-pressed="true"]', "data-id")) === stores.Quitman);
      ok(p.url().endsWith("#quitman"));
      await p.screenshot({ path: join(SHOTS, "shuttle-desktop.png"), fullPage: true });
    });
    await t("page: not on VAN rows first; sorting by Rack and back", async () => {
      const first = await p.$$eval(".sh-table tbody tr", rs => rs.map(r => r.className));
      eq(first.slice(0, 3), ["r-blocked", "r-blocked", "r-blocked"]);
      await p.click('th[data-key="rack"] button');
      eq(await p.getAttribute('th[data-key="rack"]', "aria-sort"), "ascending");
      await p.click('th[data-key="rack"] button');
      eq(await p.getAttribute('th[data-key="rack"]', "aria-sort"), "descending");
      const racks = await p.$$eval(".sh-table tbody tr td:nth-child(3)", ts => ts.map(t => t.textContent.trim()));
      ok(racks[0].startsWith("VAN"), racks.join());
    });
    await t("page: held over without a note says to add one in SMRT", async () => {
      ok(await p.isVisible("text=Add a note in SMRT"));
    });
    await t("page: Check now", async () => {
      syncCalls = [];
      await p.click("#sh-check");
      await p.waitForSelector("text=Checked SMRT just now.");
      eq(syncCalls.length, 1);
    });
    await t("page: Greenville shows OK to leave", async () => {
      await p.click(`.sh-tab[data-id="${stores.Greenville}"]`);
      await p.waitForFunction(() => /OK to leave for Greenville/.test(document.querySelector(".sh-banner h1")?.textContent || ""));
      await p.screenshot({ path: join(SHOTS, "shuttle-ok.png"), fullPage: true });
    });
    await t("page: the planner's tabs link both ways (Shuttles tab in the planner, Plan tab here)", async () => {
      eq(await p.getAttribute('#nav a[data-view="shuttles"]', "aria-current"), "page");
      await p.click('#nav a[data-view="plan"]');
      await p.waitForSelector("#shuttleTab");
      ok(/\/#\/plan$/.test(p.url()), p.url());
      ok((await p.getAttribute("#shuttleTab", "href")).startsWith("/shuttlestatus/"));
      await p.click("#shuttleTab");
      await p.waitForSelector(".sh-banner");
    });
    const m = await open({ width: 390, height: 844 }, "light");
    await t("page: phone width, no sideways page scroll (the table scrolls in its box)", async () => {
      await m.goto(`${url}/shuttlestatus/#quitman`);
      await m.waitForSelector(".sh-banner");
      const w = await m.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      ok(w[0] <= w[1], JSON.stringify(w));
      await m.screenshot({ path: join(SHOTS, "shuttle-phone.png"), fullPage: true });
    });
    await t("page: no script errors", async () => { eq(errors, []); });
  } finally { await browser.close(); server.close(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
