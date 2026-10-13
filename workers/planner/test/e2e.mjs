// End-to-end: the whole planner in a real browser, as people use it — sign-in, users (phone-only manager), team and
// training order from history, settings (summary email, pay rates), planning a day (suggest, edit, all full day, another
// date, washers, changes today, print), publishing, the Floor (with the labor streak), Review with the next day, the
// shuttle alert logic, offline (read-only from what the PC saved), and a Viewer who sees no money.
// Run: node workers/planner/test/e2e.mjs   (screenshots go to $SHOTS or ./test/shots)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, fakeAccess, makeEnv, serve } from "./harness.mjs";
import { ingestDay } from "../../sync/src/ingest.js";
import { nextWorkDay, prevWorkDay, localNow, addDays } from "../src/pieces.js";
import { dueAlerts } from "../public/js/alerts.js";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright")); }
const SHOTS = process.env.SHOTS || join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });

const A = await fakeAccess();
const { db, sqlite } = freshDb();
const NEAL = "neal@towncountryclean.com";
let who = NEAL, down = false;
const env = makeEnv(db, { TIMEZONE: "America/Chicago" });
const { server, url } = await serve(env, { fetchImpl: A.fetchImpl, token: A.token, who: () => who, down: () => down });
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n").slice(0, 4).join("\n       ")); } };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };
const shot = (p, n, full = true) => p.screenshot({ path: join(SHOTS, n), fullPage: full });

// ---------- data
const apiAs = async (email, method, path, body) => {
  const { handle } = await import("../src/index.js");
  const headers = new Headers({ "cf-access-jwt-assertion": await A.token({ email }) });
  if (body) headers.set("content-type", "application/json");
  const r = await handle(new Request(`https://prodplanner.netexcleaners.com/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
  return { status: r.status, body: await r.json() };
};
const api = (m, p, b) => apiAs(NEAL, m, p, b);
const WD = [1, 2, 3, 4, 5];
const today = localNow("America/Chicago").day, next = nextWorkDay(today, WD), later = nextWorkDay(next, WD);
const isWorkDay = WD.includes(new Date(today + "T12:00:00Z").getUTCDay());
const DAY = isWorkDay ? today : next, LAST = prevWorkDay(today, WD);
const team = [["Ana", "05:00", ["slt1", "slb"]], ["Beto", "05:30", ["slt2", "slt1"]], ["Cora", "06:00", ["dct", "dcb"]], ["Dani", "07:00", ["iab1", "iab2"]],
  ["Eli", "05:00", ["slo"]], ["Fran", "06:00", ["slb", "dct"]], ["Gus", "06:30", ["dcb", "dct"]], ["Hilda", "06:00", ["dct", "iab2"]]];
const ids = {};
for (const [f, start, tr] of team) {
  const r = await api("POST", "/team", { firstName: f, lastName: "Test", usualStart: start, payrollId: String(100 + Object.keys(ids).length) });
  ids[f] = r.body.id; await api("PUT", `/team/${r.body.id}/trainings`, { trainings: tr });
}
await api("POST", "/users", { name: "Vi Viewer", email: "vi@example.com", role: "viewer" });
await api("PUT", "/settings/runs", { runs: [
  { name: "Quitman run", kind: "shuttle", driveBack: 40, stops: [{ store: "Quitman", arrive: "11:30", drive: 40, stay: 15 }] },
  { name: "Sulphur Springs counter", kind: "counter", stops: [{ store: "Sulphur Springs", arrive: "16:00", drive: 0, stay: 0 }] },
] });
await api("PUT", "/settings/money", { payAvg: 15, laborTarget: 25 });
const dep = sqlite.prepare("SELECT id FROM core_departments WHERE name='Production'").get().id;
const plant = sqlite.prepare("SELECT id FROM core_locations WHERE kind='plant' ORDER BY created_at LIMIT 1").get().id;
// Rippling: pay rates for most people; 3 weeks of hours (Gus works DCT, not his first-choice DCB)
for (const [i, f] of ["Ana", "Beto", "Cora", "Dani", "Eli", "Fran", "Gus"].entries()) sqlite.prepare("INSERT INTO labor_pay_rates(id, person_id, effective_on, hourly_cents) VALUES(?,?,?,?)").run("r" + i, ids[f], "2026-01-01", 1500 + i * 50);
sqlite.prepare("INSERT INTO core_settings(org_id, app_id, key, value_json) VALUES('tcc','core','rippling_last',?)").run(JSON.stringify({ at: new Date().toISOString(), rows: 120, rateColumn: "Pay Rate" }));
const ts = (d, hm = "10:00") => `${d}T${hm}:00-05:00`;
{
  const orders = [], items = []; let k = 0;
  const add = (store, due, deps, asmDay = null) => { const id = `2799${String(++k).padStart(5, "0")}`;
    orders.push({ "ID": id, "Status": "processing", "Due date": due, "Created": ts(addDays(today, -30)), "Piece Count": String(deps.length), "Return Location": `TCC ${store}`, "Customer Id": "c1" });
    deps.forEach((d, i) => items.push({ "Sale Id": id, "Barcode": `${id}${i}`, "Item Status": asmDay ? "assembled" : "detailed", "Financial department": d, "Item Type": "Shirt", "Created": ts(addDays(today, -30)),
      "Item assembly date": asmDay ? ts(asmDay, "11:00") : "", "Base price": "6" })); };
  for (const d of new Set([today, next, later])) {
    for (let i = 0; i < 40; i++) add("Quitman", ts(d, "12:00"), ["Dry Cleaning Tops", "Laundry Tops", "Laundry Tops", "Laundry Bottoms"]);
    for (let i = 0; i < 30; i++) add("Sulphur Springs", ts(d, "16:00"), ["Laundry Tops", "Laundry Bottoms", "Dry Cleaning Bottoms", "Dry Cleaning Tops"]);
  }
  // the last 15 work days: plans, hours and assembled pieces (labor well under target -> a streak on the Floor)
  let d = LAST;
  for (let n = 0; n < 15; n++, d = prevWorkDay(d, WD)) {
    for (let i = 0; i < 30; i++) add("Quitman", ts(d, "12:00"), ["Laundry Tops", "Laundry Tops", "Laundry Bottoms", "Dry Cleaning Tops"], d);
    const dayId = "pd" + n;
    sqlite.prepare("INSERT INTO plan_days(id, location_id, work_date, status, rev) VALUES(?,?,?,'draft',1)").run(dayId, plant, d);
    for (const [f, code] of [["Ana", "slt1"], ["Beto", "slt2"], ["Cora", "dct1"], ["Gus", "dct2"], ["Eli", "slo"]]) {
      sqlite.prepare("INSERT INTO plan_assignments(id, day_id, station_id, person_id, starts_at, hours) VALUES(?,?,(SELECT id FROM plan_stations WHERE code=?),?,?,?)").run(dayId + f, dayId, code, ids[f], "06:00", 7.5);
      sqlite.prepare("INSERT INTO labor_daily_hours(person_id, work_date, department_id, location_id, hours, first_in, last_out) VALUES(?,?,?,?,?,?,?)").run(ids[f], d, dep, plant, 1.2, "06:00", "07:12");
    }
  }
  await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,finished_at,status,message) VALUES('lv','smrt',?,?,'ok','live: test')").bind(new Date().toISOString(), new Date().toISOString()).run();
  await ingestDay(db, { orgId: "tcc", runId: "lv", mode: "backfill", day: addDays(today, -30) }, orders, items);
}

const browser = await chromium.launch();
const errors = [];
async function page(viewport = { width: 1440, height: 900 }, scheme = "dark") {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on("pageerror", e => errors.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error" && !/status of (4\d\d|503)|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text())) errors.push("console: " + m.text()); });
  return { p, ctx };
}
const { p, ctx } = await page();
const saved = () => p.waitForFunction(() => /^Saved/.test(document.getElementById("pl-save")?.textContent || ""), null, { timeout: 8000 });

await t("Users: add a manager who signs in with a phone number only", async () => {
  await p.goto(url + "/#/users");
  await p.click("#addUser");
  await p.fill('dialog [name="name"]', "Pat Phone");
  await p.fill('dialog [name="phone"]', "(903) 555-0142");
  await p.check('dialog input[value="manager"]').catch(() => p.selectOption('dialog [name="role"]', "manager"));
  await p.click('dialog button[type="submit"]');
  await p.waitForSelector('.urow:has-text("Pat Phone")');
  ok(await p.isVisible('.urow:has-text("Pat Phone"):has-text("(903) 555-0142")'), "phone shown");
});
await t("Team: pay rates shown to the Owner; Order from history puts Gus on DCT first", async () => {
  await p.goto(url + "/#/team"); await p.waitForSelector(".trow");
  ok(await p.isVisible('.trow:has-text("Ana Test") >> text=$15.00/h'), "Ana's rate");
  ok(await p.isVisible('.trow:has-text("Hilda Test") >> text=no pay rate yet'));
  await p.click("#fromHistory"); await p.waitForSelector("dialog .aa");
  ok(await p.isVisible('dialog .aa:has-text("Gus Test")'), "Gus suggested");
  await shot(p, "e1-order-from-history.png", false);
  await p.click('dialog button[type="submit"]');
  await p.waitForFunction(() => !document.querySelector("dialog"));
  const g = (await api("GET", "/team")).body.people.find(x => x.id === ids.Gus);
  ok(g.trainings[0] === "dct", JSON.stringify(g.trainings));
});
await t("Settings: summary email card with recipients, preview, Rippling pay-rate status, notifications", async () => {
  await p.goto(url + "/#/settings"); await p.waitForSelector("#sec-summary");
  ok(await p.isVisible('#sec-rippling >> text=Pay rates read from the “Pay Rate” column'), "rippling status");
  ok(await p.isVisible('#sec-money >> text=7 of 8 people'), "pay line");
  await p.fill('#sec-summary [name="to"]', "neal@towncountryclean.com, james@towncountryclean.com");
  await p.click('#sec-summary button[type="submit"]');
  await p.waitForSelector('#sec-summary .saved-note.ok');
  ok((await api("GET", "/settings")).body.groups.summary.to.length === 2);
  await p.click("#sumPreview"); await p.waitForSelector("dialog .sum-preview h1");
  ok(await p.isVisible('dialog .sum-preview >> text=Next work day'), "preview content");
  await shot(p, "e2-summary-preview.png", false);
  await p.click('dialog button[type="submit"]');
  ok(await p.isVisible("#notifyLine"), "notification line");
});
await t("Plan: suggested crew, keep it, washers and Changes today", async () => {
  await p.goto(url + "/#/plan"); await p.waitForSelector("#pl-crew .cr-row");
  await p.click("#pl-keep"); await saved();
  await p.fill("#hrs-dct1", "5"); await p.press("#hrs-dct1", "Tab"); await saved();
  ok(!(await p.isVisible("#pl-full")) && !(await p.isVisible("#pl-auto")), "Auto-assign and All full day are gone");
  for (const id of ["#pl-checks", "#pl-waves", "#pl-money", "#pl-wash"]) ok(!(await p.$(id)), id + " is off the Plan");
  await p.click("#pl-chg-box summary"); await p.waitForSelector("#pl-chg .chg-list li");
  ok(await p.isVisible('#pl-chg >> text=hours 7h 30m → 5h'), "change logged");
  ok(await p.isVisible('#pl-chg >> text=Neal Barker'), "who");
  await shot(p, "e3-plan.png");
});
await t("Plan: each top button has a ? that explains it; today shows Suggestions right now", async () => {
  for (const id of ["suggest", "print", "publish"]) {
    await p.click(`.plan-head [data-help="${id}"]`);
    await p.waitForSelector("dialog.help-dlg");
    if (id === "suggest") await p.locator("dialog").screenshot({ path: join(SHOTS, "e3b-help.png") });
    ok(await p.locator("dialog.help-dlg li, dialog.help-dlg p").count() >= 1, id);
    await p.click('dialog.help-dlg button[type="submit"]');
    await p.waitForSelector("dialog", { state: "detached" });
  }
  if (isWorkDay) {
    const n = await p.locator("#pl-live .sugg li").count();
    ok((await p.isVisible("#pl-live")) === n > 0, "suggestions card only when there are suggestions");
    if (n) { ok(/Suggestions right now/.test(await p.textContent("#pl-live")));
      await p.locator("#pl-live").screenshot({ path: join(SHOTS, "e3c-live.png") });
      await p.click("#pl-live-box > summary"); ok(!(await p.isVisible("#pl-live .sugg")), "collapses");
      await p.click("#pl-live-box > summary"); ok(await p.isVisible("#pl-live .sugg"), "opens again"); } }
});
await t("Plan: Print builds a one-page timeline", async () => {
  await p.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await p.click("#pl-print");
  await p.waitForFunction(() => window.__printed);
  ok(await p.locator("#pl-print-sheet .ps-row").count() >= 4, "rows");
  await p.evaluate(() => document.body.classList.add("printing"));
  await p.emulateMedia({ media: "print" });
  await p.pdf({ path: join(SHOTS, "e4-printed-plan.pdf"), landscape: true, format: "Letter", printBackground: true });
  await p.setViewportSize({ width: 1056, height: 816 }); await shot(p, "e4-print.png", false);
  await p.emulateMedia({ media: "screen" }); await p.evaluate(() => document.body.classList.remove("printing")); await p.setViewportSize({ width: 1440, height: 900 });
});
await t("Plan: another date from the picker gets its own tab and saves on its own", async () => {
  await p.fill("#pl-date", later); await p.dispatchEvent("#pl-date", "change");
  await p.waitForSelector(`[data-day="${later}"].custom[aria-selected="true"]`);
  await p.waitForSelector("#pl-crew .cr-row");
  await p.click("#pl-keep"); await saved();
  ok((await api("GET", `/plan/${later}`)).body.rev === 1, "saved for the later day");
  await p.goto(url + `/#/plan?day=${LAST}`); await p.waitForSelector("#pl-crew .cr-row");
  ok(await p.isVisible("text=This day is over"), "past day banner"); ok(!(await p.isVisible("#pl-pub")), "read-only");
  ok(await p.isDisabled(`#who-slt1`), "pickers disabled");
});
await t("Publish, then the Floor shows the plan and the labor streak", async () => {
  await p.goto(url + `/#/plan?day=${DAY}`); await p.waitForSelector("#pl-pub");
  await p.click("#pl-pub"); await p.click('dialog button[type="submit"]');
  await p.waitForFunction(() => /Published/.test(document.getElementById("pl-pub")?.textContent || ""));
  await p.goto(url + "/#/floor"); await p.waitForSelector(".f-band");
  ok(await p.isVisible(".f-streak"), "streak"); ok(/work days in a row/.test(await p.textContent(".f-streak")), await p.textContent(".f-streak"));
  await shot(p, "e5-floor.png", false);
});
await t("Review: the next work day's projection and a link to its plan", async () => {
  await p.goto(url + `/#/review?day=${LAST}`); await p.waitForSelector("#rv-nextday .rv-next");
  ok(/pieces to plan for/.test(await p.textContent("#rv-nextday")), "projection: " + await p.textContent("#rv-nextday"));
  ok(await p.isVisible('#rv-nextday >> text=projected labor'), "owner sees labor");
  await shot(p, "e6-review.png");
  await p.click("#rv-nextday a.btn"); await p.waitForSelector("#pl-crew");
  ok(await p.evaluate(d => document.querySelector(`[data-day="${d}"]`)?.getAttribute("aria-selected") === "true", nextWorkDay(LAST, WD)), "opened that day's plan");
});
await t("Shuttle alerts: ready and both warnings, the right number of minutes before", async () => {
  const V = { isWorkDay: true, today, overdue: { q: {}, todo: 0, orders: 0 }, days: { [today]: { stores: [
    { loc: "Quitman", runId: null, q: { dct: 10, dcb: 0, slt: 20, slb: 5, comf: 0, tc: 0 }, done: { dct: 4, dcb: 0, slt: 20, slb: 5, comf: 0, tc: 0 }, known: {}, expected: {}, orders: 9 },
    { loc: "Sulphur Springs", runId: null, q: { dct: 3, dcb: 0, slt: 0, slb: 0, comf: 0, tc: 0 }, done: { dct: 3, dcb: 0, slt: 0, slb: 0, comf: 0, tc: 0 }, known: {}, expected: {}, orders: 2 }] } } };
  const S = (await api("GET", "/settings")).body;
  const runId = S.runs.find(r => r.kind === "shuttle").id, ctrId = S.runs.find(r => r.kind === "counter").id;
  V.days[today].stores[0].runId = runId; V.days[today].stores[1].runId = ctrId;
  const A0 = S.groups.alerts, dl = 10 + 50 / 60;
  const at = mins => dueAlerts(V, S.runs, A0, dl - mins / 60);
  ok(at(44).some(a => a.key === `warn45:${runId}` && /6 DCT/.test(a.text)), JSON.stringify(at(44)));
  ok(at(14).some(a => a.key === `warn15:${runId}`) && !at(30).some(a => a.kind === "warn"), "second warning only near 15");
  ok(at(30).some(a => a.key === `ready:${ctrId}`), "counter ready");
  ok(!dueAlerts({ ...V, isWorkDay: false }, S.runs, A0, 9).length, "nothing on a day off");
});
await t("Offline: the plan still opens from what this PC saved, read-only, and comes back online", async () => {
  await p.goto(url + `/#/plan?day=${DAY}`); await p.waitForSelector("#pl-crew .cr-row");
  await p.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated", null, { timeout: 15000 });
  await p.reload(); await p.waitForSelector("#pl-crew .cr-row"); // now under the service worker
  await p.waitForTimeout(500);
  down = true; await ctx.setOffline(true); // Playwright's offline mode doesn't reach the service worker, so the server drops connections too
  await p.reload();
  await p.waitForSelector("#pl-crew .cr-row", { timeout: 15000 });
  await p.waitForSelector(".offline-bar:not([hidden])");
  ok(/Offline — showing what this PC saved/.test(await p.textContent(".offline-bar")));
  ok(!(await p.isVisible("#pl-pub")) && await p.isDisabled("#who-slt1"), "read-only");
  await shot(p, "e7-offline.png", false);
  await p.goto(url + "/#/floor"); await p.waitForSelector(".f-band", { timeout: 15000 });
  ok(!(await p.isVisible("text=NO PLAN PUBLISHED")), "floor shows the saved published plan");
  down = false; await ctx.setOffline(false);
  await p.goto(url + `/#/plan?day=${DAY}`); await p.waitForSelector("#pl-pub", { timeout: 15000 });
  ok(await p.isHidden(".offline-bar"), "bar gone");
});
await t("Viewer: no pay rates, no labor money, can't edit", async () => {
  who = "vi@example.com";
  const v = await page();
  await v.p.goto(url + "/#/team"); await v.p.waitForSelector(".trow");
  ok(!(await v.p.isVisible("text=/h")), "no rates");
  await v.p.goto(url + `/#/review?day=${LAST}`); await v.p.waitForSelector("#rv-nextday .rv-next");
  ok(!(await v.p.isVisible("text=projected labor")), "no money");
  await v.p.goto(url + "/#/plan"); await v.p.waitForSelector("#pl-crew");
  ok(!(await v.p.isVisible("#pl-suggest")) && !(await v.p.isVisible("#pl-pub")), "no editing");
  await v.ctx.close(); who = NEAL;
});
await t("Phone width: plan and settings fit", async () => {
  const m = await page({ width: 390, height: 844 });
  await m.p.goto(url + "/#/plan"); await m.p.waitForSelector("#pl-crew .cr-row");
  ok(await m.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll");
  await shot(m.p, "e8-plan-phone.png");
  await m.p.goto(url + "/#/settings"); await m.p.waitForSelector("#sec-summary");
  ok(await m.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "settings fit");
  await m.ctx.close();
});
await t("no page errors", async () => { ok(!errors.length, errors.join("\n")); });

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
