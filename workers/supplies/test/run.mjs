// Server tests for Supplies. Run: node workers/supplies/test/run.mjs
import { freshDb, fakeAccess, makeEnv } from "./harness.mjs";
import { handle } from "../src/index.js";
import { needOf, orderQty, handleOf, nextShuttleDay, addWorkDays } from "../src/logic.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const A = await fakeAccess();
const NEAL = "neal@towncountryclean.com";
const { db, sqlite } = freshDb();
sqlite.prepare("INSERT INTO core_users(id, org_id, email, display_name) VALUES('01KARLA000000000000000000A','tcc','karla@x.com','Karla Velasquez')").run();
sqlite.prepare("INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES('01KARLA000000000000000000A','supplies','manager','x')").run();
sqlite.prepare("INSERT INTO core_users(id, org_id, email, display_name) VALUES('01VIEW0000000000000000000A','tcc','view@x.com','Viewer')").run();
sqlite.prepare("INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES('01VIEW0000000000000000000A','supplies','viewer','x')").run();
const env = makeEnv(db, { NOW: "2026-10-16T10:00:00-05:00" });   // a Friday

let cookie = null;
const call = async (method, path, { as = "karla@x.com", body, dev = false, origin } = {}) => {
  const headers = new Headers();
  if (as && !dev) headers.set("cf-access-jwt-assertion", await A.token({ email: as }));
  if (dev && cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  if (body) headers.set("content-type", "application/json");
  const r = await handle(new Request(`https://supplies.netexcleaners.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
  const sc = r.headers.get("set-cookie"); if (dev && sc) cookie = sc.split(";")[0];
  const type = r.headers.get("content-type") || "";
  return { status: r.status, body: type.includes("json") ? await r.json() : await r.text(), setCookie: sc };
};
const locId = name => sqlite.prepare("SELECT id FROM core_locations WHERE name=?").get(name).id;

console.log("rules");
await t("count below par -> back up to par; at/above par -> nothing", () => {
  eq(needOf({ mode: "count", par: 6 }, { qty: 2 }), 4); eq(needOf({ mode: "count", par: 6 }, { qty: 6 }), 0); eq(needOf({ mode: "count", par: 6 }, { qty: "" }), null);
});
await t("reorder point: half bottle", () => {
  const p = { mode: "count", par: 1, reorder_at: 0.5 };
  eq(needOf(p, { qty: 0.75 }), 0); eq(needOf(p, { qty: 0.5 }), 0.5); eq(orderQty(0.5), 1); eq(orderQty(3.2), 4);
});
await t("Out/Low/OK and Need any?", () => {
  const p = { mode: "level", par: 100 };
  eq(needOf(p, { level: "out" }), 100); eq(needOf(p, { level: "low" }), 50); eq(needOf(p, { level: "ok" }), 0); eq(needOf({ mode: "level", par: 0.5 }, { level: "low" }), 0.5);
  eq(needOf({ mode: "check", par: null }, { level: "need" }), 1); eq(needOf({ mode: "check", par: null }, { level: "need", qty: 3 }), 3); eq(needOf({ mode: "check" }, {}), null);
});
await t("names: KarlaV / Karla V / Karla Velasquez all match", () => { eq(handleOf("KarlaV"), "karlav"); eq(handleOf(" karla v "), "karlav"); eq(handleOf("Karla Velasquez"), "karlav"); });
await t("shuttle days Mon–Fri; lead time in work days", () => { eq(nextShuttleDay("2026-10-17"), "2026-10-19"); eq(nextShuttleDay("2026-10-16"), "2026-10-16"); eq(addWorkDays("2026-10-16", 3), "2026-10-21"); });

console.log("catalog seeded from the order sheets");
await t("7 locations, 129 items, 6 vendors", async () => {
  const r = await call("GET", "/api/catalog"); eq(r.status, 200);
  eq(r.body.locations.map(l => l.label), ["Sulphur Springs Workshop", "Sulphur Springs Retail", "Greenville Retail", "Emory Retail", "Winnsboro Retail", "Quitman Retail", "Laundry Hub"]);
  eq(r.body.items.length, 129); eq(r.body.vendors.length, 6);
  const tp = r.body.items.find(i => i.name === "Toilet paper");
  eq(tp.pars[locId("Quitman")], { par: 6, reorder: null, mode: "count" }); eq(tp.bulkUnit, "case");
  eq(r.body.items.find(i => i.name === "Safe and Secure bags").pars[locId("Emory")].mode, "level");
});

console.log("sign-in and roles");
await t("no sign-in -> 401 on the manager screens", async () => { eq((await call("GET", "/api/catalog", { as: null })).status, 401); eq((await call("GET", "/", { as: null })).status, 401); });
await t("Neal is Owner (migration 0020)", async () => eq((await call("GET", "/api/me", { as: NEAL })).body.user.role, "owner"));
await t("a Viewer can't change things", async () => eq((await call("POST", "/api/counters", { as: "view@x.com", body: { firstName: "X", lastInitial: "Y" } })).status, 403));
await t("another site can't post", async () => eq((await call("POST", "/api/counters", { body: { firstName: "X", lastInitial: "Y" }, origin: "https://evil.example" })).status, 403));

console.log("devices and counting");
let code;
await t("count page loads without a sign-in; data needs pairing", async () => {
  eq((await call("GET", "/count/", { dev: true })).status, 200);
  eq((await call("GET", "/count/api/state", { dev: true })).body, { paired: false });
  eq((await call("POST", "/count/api/submit", { dev: true, body: {} })).status, 401);
});
await t("Karla adds a Quitman device; wrong code refused; right code pairs", async () => {
  const r = await call("POST", "/api/devices", { body: { locationId: locId("Quitman") } }); eq(r.status, 201); code = r.body.code;
  eq((await call("POST", "/count/api/pair", { dev: true, body: { code: "000000" === code ? "111111" : "000000" } })).status, 403);
  const p = await call("POST", "/count/api/pair", { dev: true, body: { code } });
  eq(p.status, 200); ok(p.setCookie.includes("HttpOnly") && p.setCookie.includes("Path=/count"));
  eq(p.body.location.label, "Quitman Retail"); eq(p.body.items.length, 44);
  eq((await call("POST", "/count/api/pair", { dev: true, body: { code } })).status, 403, "code works once");
});
await t("only approved names can count", async () => {
  eq((await call("POST", "/count/api/who", { dev: true, body: { name: "MariaG" } })).status, 403);
  eq((await call("POST", "/api/counters", { body: { firstName: "Maria", lastInitial: "g" } })).status, 201);
  eq((await call("POST", "/count/api/who", { dev: true, body: { name: "mariag" } })).body, { name: "Maria G" });
  eq((await call("POST", "/api/counters", { body: { firstName: "Maria", lastInitial: "G" } })).status, 409);
});
await t("a counter limited to Emory can't count at Quitman", async () => {
  await call("POST", "/api/counters", { body: { firstName: "Ed", lastInitial: "E", locationId: locId("Emory") } });
  eq((await call("POST", "/count/api/who", { dev: true, body: { name: "EdE" } })).body.reason, "wrong_location");
});
const item = name => sqlite.prepare("SELECT id FROM supply_items WHERE name=?").get(name).id;
let ship1;
await t("Karla requests counts; Quitman sees it", async () => {
  eq((await call("POST", "/api/requests", { body: { locationIds: [locId("Quitman"), locId("Workshop")], dueOn: "2026-10-19", note: "Before Monday's shuttle" } })).status, 201);
  const s = (await call("GET", "/count/api/state", { dev: true })).body; eq(s.requests.length, 1); eq(s.requests[0].note, "Before Monday's shuttle");
});
await t("Quitman submits a count -> shuttle list with the needs, request done", async () => {
  const r = await call("POST", "/count/api/submit", { dev: true, body: { name: "Maria G", note: "Stapler is broken", lines: [
    { item: item("Toilet paper"), qty: 2 }, { item: item("Receipt paper"), qty: 25 }, { item: item("Safe and Secure bags"), level: "low" },
    { item: item("AA batteries"), level: "need", qty: 4 }, { item: item("Candy"), qty: 0 }, { item: item("Collar Styx"), qty: 0 } ] } });
  eq(r.status, 201); ship1 = r.body.shipmentId; ok(ship1);
  eq(r.body.needs.map(n => [n.name, n.need]), [["Toilet paper", 4], ["Safe and Secure bags", 50], ["AA batteries", 4], ["Candy", 2]]);
  eq(r.body.counted, 5, "Collar Styx isn't kept at stores, skipped");
  eq((await call("GET", "/count/api/state", { dev: true })).body.requests.length, 0);
});
await t("a newer count replaces the open list", async () => {
  const r = await call("POST", "/count/api/submit", { dev: true, body: { name: "MariaG", lines: [{ item: item("Toilet paper"), qty: 1 }] } });
  const sh = (await call("GET", "/api/shuttle")).body;
  eq(sh.open.length, 1); eq(sh.open[0].id, r.body.shipmentId); eq(sh.open[0].lines.map(l => [l.name, l.need]), [["Toilet paper", 5]]);
  eq(sqlite.prepare("SELECT status FROM supply_shipments WHERE id=?").get(ship1).status, "replaced");
  ship1 = r.body.shipmentId;
});
await t("Karla edits quantities, adds a write-in, marks sent", async () => {
  const sh = (await call("GET", "/api/shuttle")).body.open[0];
  eq((await call("PUT", `/api/shuttle/${ship1}`, { body: { lines: [{ id: sh.lines[0].id, send: 6 }, { item: item("Laundry pen"), send: 2 }, { label: "New stapler", send: 1 }] } })).status, 200);
  const after = (await call("GET", "/api/shuttle")).body.open[0];
  eq(after.lines.map(l => [l.name, l.need, l.send]), [["Toilet paper", 5, 6], ["Laundry pen", 2, 2], ["New stapler", 1, 1]]);
  eq((await call("POST", `/api/shuttle/${ship1}/sent`)).status, 200);
  const s2 = (await call("GET", "/api/shuttle")).body; eq(s2.open.length, 0); eq(s2.sent.length, 1); eq(s2.sent[0].sentBy, "Karla Velasquez");
  eq((await call("PUT", `/api/shuttle/${ship1}`, { body: { lines: [] } })).status, 409);
});

console.log("Workshop counts and vendor orders");
await t("Workshop count (entered by Karla) -> order suggestions by vendor", async () => {
  await call("PATCH", "/api/vendors/fabriclean", { body: { leadDays: 3, minAmount: 250, phone: "800-555-0100" } });
  await call("PATCH", `/api/items/${item("Bongo 12 oz")}`, { body: { unitCost: 12.5 } });
  const r = await call("POST", "/api/counts", { body: { locationId: locId("Workshop"), lines: [
    { item: item("Bongo 12 oz"), qty: 0.5 }, { item: item("EasyGo gallon"), qty: 0.75 }, { item: item("Jeans strut hanger (black/pink box)"), qty: 5 },
    { item: item("Toilet paper"), qty: 0 }, { item: item("Dry clean filter — carbon split"), level: "need", qty: 2 } ] } });
  eq(r.status, 201); eq(r.body.shipmentId, null);
  const o = (await call("GET", "/api/orders")).body;
  const fab = o.groups.find(g => g.vendor.id === "fabriclean");
  eq(Object.fromEntries(fab.lines.map(l => [l.name, l.qty])), { "Dry clean filter — carbon split": 2, "Jeans strut hanger (black/pink box)": 3, "Bongo 12 oz": 1 }); eq(fab.arrives, "2026-10-21"); eq(fab.total, null, "not every line has a cost");
  eq(o.groups.find(g => g.vendor.id === "janitorial").lines[0].qty, 1);
  // the Workshop request is done
  eq((await call("GET", "/api/overview")).body.locations.find(l => l.name === "Workshop").request, null);
});
await t("placing an order takes the lines off the suggestions; a received order stays off until the next count", async () => {
  const o = (await call("GET", "/api/orders")).body, fab = o.groups.find(g => g.vendor.id === "fabriclean");
  const r = await call("POST", "/api/orders", { body: { vendorId: "fabriclean", reference: "W12345", lines: fab.lines.map(l => ({ item: l.item, qty: l.qty })) } });
  eq(r.status, 201); eq(r.body.expectedOn, "2026-10-21");
  const o2 = (await call("GET", "/api/orders")).body;
  ok(!o2.groups.some(g => g.vendor.id === "fabriclean")); eq(o2.onOrder.length, 3); eq(o2.placed[0].lines.length, 3);
  eq((await call("PATCH", `/api/orders/${r.body.id}`, { body: { status: "received" } })).status, 200);
  const o3 = (await call("GET", "/api/orders")).body; ok(!o3.groups.some(g => g.vendor.id === "fabriclean")); eq(o3.onOrder.length, 0);
});

console.log("supply list edits");
await t("change how Quitman answers an item, and its par", async () => {
  const id = item("Receipt paper");
  eq((await call("PATCH", `/api/items/${id}`, { body: { pars: { [locId("Quitman")]: { par: 12, mode: "level" } } } })).status, 200);
  const s = (await call("GET", "/count/api/state", { dev: true })).body.items.find(i => i.id === id);
  eq([s.par, s.mode], [12, "level"]);
  eq((await call("PATCH", `/api/items/${id}`, { body: { pars: { [locId("Quitman")]: { par: 2, reorder: 3 } } } })).status, 400);
});
await t("new item kept only at the Hub; removing from a location", async () => {
  const r = await call("POST", "/api/items", { body: { name: "Mesh laundry bags", vendorId: "other", unit: "bag", category: "Laundry Hub", pars: { [locId("Laundry Hub")]: { par: 10 } } } });
  eq(r.status, 201);
  eq((await call("PATCH", `/api/items/${r.body.id}`, { body: { pars: { [locId("Laundry Hub")]: null } } })).status, 200);
  eq(sqlite.prepare("SELECT COUNT(*) n FROM supply_pars WHERE item_id=?").get(r.body.id).n, 0);
});
await t("removing a device cuts it off", async () => {
  const d = (await call("GET", "/api/devices")).body.devices[0];
  eq((await call("DELETE", `/api/devices/${d.id}`)).status, 200);
  eq((await call("GET", "/count/api/state", { dev: true })).body, { paired: false });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
