// Browser test for Review: the day's numbers, plan vs actual, trend, follow-ups, Viewer, phone.
// Run: node workers/planner/test/review-ui.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, fakeAccess, makeEnv, serve } from "./harness.mjs";
import { handle } from "../src/index.js";
import { ingestDay } from "../../sync/src/ingest.js";
import { localNow, prevWorkDay, addDays } from "../src/pieces.js";
import { ulid } from "../src/util.js";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright")); }
const SHOTS = process.env.SHOTS || join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n").slice(0, 3).join("\n       ")); } };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };
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


// a published plan and a follow-up
await call("PUT", `/plan/${DAY}`, { body: { rev: 0, crew: { slt1: { personId: ana, start: "05:00", hours: 7.5 }, dct1: { personId: beto, start: "06:00", hours: 6 } } } });
await call("POST", `/plan/${DAY}/publish`, { body: { rev: 1, snapshot: { sig: "x", metrics: { end: 13.5, firstStart: 5, pieces: 8 }, waves: [],
  input: { q: {}, crew: { slt1: { emp: ana, start: "05:00", hrs: 7.5, stop: "" }, dct1: { emp: beto, start: "06:00", hrs: 6, stop: "" } }, stations: [{ id: "slt1", type: "slt", label: "SLT 1" }, { id: "dct1", type: "dct", label: "DCT 1" }], ops: [], people: [], trainingOf: {}, settings: { breakMin: 30, breakAfter: 4 } } } } });
const o = sqlite.prepare("SELECT id FROM pos_orders LIMIT 1").get().id, ch = ulid(), fid = ulid();
sqlite.prepare("INSERT INTO pos_changes(id, order_id, kind, old_value, new_value, detected_at) VALUES(?,?,?,?,?,?)").run(ch, o, "due_changed", ts(DAY, "12:00"), ts(addDays(DAY, 1), "12:00"), new Date().toISOString());
sqlite.prepare("INSERT INTO plan_followups(id, order_id, kind, change_id, status) VALUES(?,?,?,?,?)").run(fid, o, "due_moved", ch, "needs_note");

let who = "neal@towncountryclean.com";
const { server, url } = await serve(env, { fetchImpl: A.fetchImpl, token: A.token, who: () => who });
const browser = await chromium.launch(), errors = [];
async function page(viewport = { width: 1440, height: 900 }, scheme = "dark") {
  const c = await browser.newContext({ viewport, colorScheme: scheme }); const p = await c.newPage();
  p.on("pageerror", e => errors.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push("console: " + m.text()); });
  return p;
}
const p = await page();
await t("opens on the last work day with numbers, chart, by the hour and plan vs actual (no shuttles)", async () => {
  await p.goto(url + "/#/review"); await p.waitForSelector("#rv-root .rv-tiles");
  ok((await p.inputValue("#rv-date")) === DAY, await p.inputValue("#rv-date"));
  ok(!/late|deadline|shuttle/i.test(await p.textContent(".verdict")), await p.textContent(".verdict"));
  ok(await p.isVisible(".rv-chart .c-done")); ok(!(await p.isVisible('.rt td:has-text("Quitman run")')), "no deadlines card");
  ok(await p.isVisible(".hr-tbl"), "by the hour");
  ok(await p.isVisible('.rv-dept td:has-text("Not on the plan")'), "Cora worked but wasn't planned: her hours on their own row");
  ok(await p.isVisible('.rv-dept td:has-text("Total")'), "department total");
  ok(await p.isVisible('.tile:has-text("labor %")'), "Owner sees labor %");
  await p.screenshot({ path: join(SHOTS, "30-review.png"), fullPage: true });
});
await t("a Manager-level user notes a follow-up", async () => {
  await p.selectOption(`form.fu[data-id="${fid}"] select`, "stain");
  await p.fill(`form.fu[data-id="${fid}"] input[name=note]`, "Second treatment");
  await p.click(`form.fu[data-id="${fid}"] button[value=save]`);
  await p.waitForSelector('.fu-row .chip:has-text("Noted")');
  ok(/Stain treatment — Second treatment/.test(await p.textContent(".fu-note")));
});
await t("previous and next work day buttons move through days", async () => {
  await p.click("#rv-prev"); await p.waitForFunction(d => document.getElementById("rv-date")?.value < d, DAY);
  await p.click("#rv-next"); await p.waitForFunction(d => document.getElementById("rv-date")?.value === d, DAY);
});
await t("a Viewer sees no money and can't edit follow-ups", async () => {
  who = "vi@example.com";
  const q = await page(); await q.goto(url + "/#/review"); await q.waitForSelector("#rv-root .rv-tiles");
  ok(!(await q.isVisible('.tile:has-text("labor %")'))); ok(!(await q.$("form.rv-mnote")), "viewers can't write notes"); ok(!(await q.$("form.fu")));
  who = "neal@towncountryclean.com";
});
await t("phone and light theme", async () => {
  const q = await page({ width: 390, height: 844 }, "light"); await q.goto(url + "/#/review"); await q.waitForSelector("#rv-root .rv-tiles");
  ok(!(await q.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), "no sideways scroll");
  await q.screenshot({ path: join(SHOTS, "31-review-phone.png"), fullPage: true });
});
await t("no page errors", async () => { ok(!errors.length, errors.join("\n")); });
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
