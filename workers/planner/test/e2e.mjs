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
await t("Team: pay rates shown to the Owner; the station depth chart sets Gus as DCT #1", async () => {
  await p.goto(url + "/#/team"); await p.waitForSelector(".trow");
  ok(await p.isVisible('.trow:has-text("Ana Test") >> text=$15.00/h'), "Ana's rate");
  ok(await p.isVisible('.trow:has-text("Hilda Test") >> text=no pay rate yet'));
  const g0 = (await api("GET", "/team")).body.people.find(x => x.id === ids.Gus);
  if (!g0.trainings.includes("dct")) await api("PUT", `/team/${ids.Gus}/trainings`, { trainings: [...g0.trainings, "dct"] });
  await p.goto(url + "/#/team"); await p.waitForSelector(`#dc-dct-${ids.Gus}`);
  await p.selectOption(`#dc-dct-${ids.Gus}`, "1");
  await p.waitForFunction(i => document.querySelector(`#dc-dct-${i}`)?.classList.contains("r1"), ids.Gus);
  await shot(p, "e1-depth-chart.png", false);
  const g = (await api("GET", "/team")).body.people.find(x => x.id === ids.Gus);
  ok(g.depth.dct === 1, JSON.stringify(g.depth));
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
  ok(!(await p.isVisible("#notifyLine")), "no shuttle alert settings while shuttles are off");
});
await t("Plan (manual, Oct 14): a new day copies the last plan; tap a bar to set times, a break and a move", async () => {
  await p.goto(url + "/#/plan"); await p.waitForSelector("#pl-board .tl-row");
  await p.waitForSelector("#pl-note >> text=Copied from"); await saved();
  for (const id of ["#pl-suggest", "#pl-neck", "#pl-replan"]) ok(!(await p.$(id)), id + " is gone (no predictions)");
  ok(!/done about/.test(await p.textContent("#pl-status")), "no predicted finish in the status line");
  // Cora on DCT 1: 6:30–14:00, break 9:00–9:30, then SLB 1 from 11:00
  await p.click('#pl-board .tl-row[data-g="dct"] .tl-bar[data-emp="' + ids.Cora + '"] >> nth=0');
  await p.waitForSelector('dialog.sheet input[name="from"]');
  await p.fill('dialog.sheet input[name="from"]', "06:30"); await p.fill('dialog.sheet input[name="to"]', "14:00");
  await p.fill('dialog.sheet input[name="b0"]', "09:00"); await p.dispatchEvent('dialog.sheet input[name="b0"]', "change");
  ok(await p.inputValue('dialog.sheet input[name="b1"]') === "09:30", "break end fills in");
  await p.selectOption('dialog.sheet select[name="mv"]', "slb1"); await p.fill('dialog.sheet input[name="mvat"]', "11:00");
  await p.click('dialog.sheet button[type="submit"]'); await p.waitForSelector("dialog", { state: "detached" }); await saved();
  const cora = Object.values((await api("GET", `/plan/${DAY}`)).body.crew).find(c => c.personId === ids.Cora);
  ok(cora.start === "06:30" && cora.stop === "14:00" && cora.brk === "09:00-09:30" && cora.moves.some(m => m.to === "slb1" && m.at === "11:00"), JSON.stringify(cora));
  ok(await p.locator('#pl-board .tl-row[data-g="slb"] .tl-bar[data-emp]').count() >= 1, "now on starch bottoms too");
  ok(await p.locator("#pl-board .tl-brk").count() >= 1, "break shows");
  ok(!(await p.isVisible("#pl-full")) && !(await p.isVisible("#pl-auto")), "Auto-assign and All full day are gone");
  for (const id of ["#pl-checks", "#pl-waves", "#pl-money", "#pl-wash"]) ok(!(await p.$(id)), id + " is off the Plan");
  // stations top to bottom: Reorder moves a row, saved for everyone
  ok((await p.locator("#pl-board .tl-row").first().getAttribute("data-g")) === "slb", "starch bottoms on top");
  await p.click("#pl-reorder"); await p.click('#pl-board [data-down="slb"]');
  for (let i = 0; i < 40 && (await api("GET", "/settings")).body.boardOrder[1] !== "slb"; i++) await p.waitForTimeout(100);
  ok((await api("GET", "/settings")).body.boardOrder[1] === "slb", "saved order");
  ok((await p.locator("#pl-board .tl-row.first").nth(1).getAttribute("data-g")) === "slb", "second kind of work now");
  await p.click('#pl-board [data-up="slb"]'); await p.click("#pl-reorder");
  for (let i = 0; i < 40 && (await api("GET", "/settings")).body.boardOrder[0] !== "slb"; i++) await p.waitForTimeout(100);
  ok(await p.locator("#pl-board .tl-axis span").count() >= 6, "hours across");
  // Out, late or hard stop: a hard stop for today sets that person's stop time on the plan
  await p.click("#pl-away-btn"); await p.waitForSelector('dialog input[value="stop"]');
  const who = await p.$eval('dialog select[name="who"]', s => [...s.options].find(o => / · on /.test(o.textContent)).value);
  await p.selectOption('dialog select[name="who"]', who); await p.check('dialog input[value="stop"]'); await p.fill('dialog input[name="at"]', "12:30");
  await p.click('dialog button[type="submit"]'); await p.waitForSelector("dialog", { state: "detached" }); await saved();
  ok(Object.values((await api("GET", `/plan/${DAY}`)).body.crew).some(c => c.personId === who && c.stop === "12:30"), "hard stop saved");
  await p.click("#pl-chg-box summary"); await p.waitForSelector("#pl-chg .chg-list li");
  ok(await p.isVisible('#pl-chg >> text=/moved from|moves to|break/'), "change logged");
  ok(await p.isVisible('#pl-chg >> text=Neal Barker'), "who");
  await shot(p, "e3-plan.png");
});
await t("Plan: Publish has a ? that explains it; no bottleneck card", async () => {
  for (const id of ["publish"]) {
    await p.click(`.pv-foot [data-help="${id}"]`);
    await p.waitForSelector("dialog.help-dlg");
    if (id === "publish") await p.locator("dialog").screenshot({ path: join(SHOTS, "e3b-help.png") });
    ok(await p.locator("dialog.help-dlg li, dialog.help-dlg p").count() >= 1, id);
    await p.click('dialog.help-dlg button[type="submit"]');
    await p.waitForSelector("dialog", { state: "detached" });
  }
  ok(!(await p.$("#pl-neck")), "no bottleneck card");
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
  await p.waitForSelector("#pl-board .tl-row"); await saved();
  ok((await api("GET", `/plan/${later}`)).body.rev >= 1, "copied and saved for the later day");
  await p.goto(url + `/#/plan?day=${LAST}`); await p.waitForSelector("#pl-board .tl-row");
  ok(await p.isVisible("text=This day is over"), "past day banner"); ok(!(await p.isVisible("#pl-pub")), "read-only");
  ok(!(await p.$("#pl-board .tl-lab[data-add]")), "no adding on a past day");
});
await t("Publish, then the Floor shows the plan and the labor streak", async () => {
  await p.goto(url + `/#/plan?day=${DAY}`); await p.waitForSelector("#pl-pub");
  await p.click("#pl-pub"); await p.click('dialog button[type="submit"]');
  await p.waitForFunction(() => /Published/.test(document.getElementById("pl-pub")?.textContent || ""));
  await p.goto(url + "/#/floor"); await p.waitForSelector(".f-band");
  ok(await p.isVisible(".f-streak"), "streak"); ok(/work days in a row/.test(await p.textContent(".f-streak")), await p.textContent(".f-streak"));
  await shot(p, "e5-floor.png", false);
});
await t("Review: by department, no next work day", async () => {
  await p.goto(url + `/#/review?day=${LAST}`); await p.waitForSelector("#rv-root .rv-dept");
  ok(!(await p.$("#rv-nextday")), "no next work day on Review");
  ok(await p.isVisible('.tile:has-text("labor %")'), "owner sees labor");
  await shot(p, "e6-review.png");
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
  await p.goto(url + `/#/plan?day=${DAY}`); await p.waitForSelector("#pl-board .tl-row");
  await p.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated", null, { timeout: 15000 });
  await p.reload(); await p.waitForSelector("#pl-board .tl-row"); // now under the service worker
  await p.waitForTimeout(500);
  down = true; await ctx.setOffline(true); // Playwright's offline mode doesn't reach the service worker, so the server drops connections too
  await p.reload();
  await p.waitForSelector("#pl-board .tl-row", { timeout: 15000 });
  await p.waitForSelector(".offline-bar:not([hidden])");
  ok(/Offline — showing what this PC saved/.test(await p.textContent(".offline-bar")));
  ok(!(await p.isVisible("#pl-pub")) && !(await p.$("#pl-board .tl-lab[data-add]")), "read-only");
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
  await v.p.goto(url + `/#/review?day=${LAST}`); await v.p.waitForSelector("#rv-root .rv-dept");
  ok(!(await v.p.isVisible('.tile:has-text("labor %")')), "no money");
  await v.p.goto(url + "/#/plan"); await v.p.waitForSelector("#pl-board .tl-row");
  ok(!(await v.p.isVisible("#pl-suggest")) && !(await v.p.isVisible("#pl-pub")), "no editing");
  ok(!/labor \$/.test(await v.p.textContent("#pl-status")), "no labor $ in the status line");
  await v.ctx.close(); who = NEAL;
});
await t("Phone width: plan and settings fit", async () => {
  const m = await page({ width: 390, height: 844 });
  await m.p.goto(url + "/#/plan"); await m.p.waitForSelector("#pl-board .tl-row");
  ok(await m.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll");
  await shot(m.p, "e8-plan-phone.png");
  await m.p.goto(url + "/#/settings"); await m.p.waitForSelector("#sec-summary");
  ok(await m.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "settings fit");
  await m.ctx.close();
});
await t("Team: a manager sets someone's usual schedule and must-leave-by", async () => {
  await p.goto(url + "/#/team"); await p.waitForSelector("[data-sched]");
  await p.click("[data-sched]"); await p.waitForSelector("dialog.sheet");
  for (const k of ["1", "2", "3", "4", "5"]) await p.check(`dialog input[name="d${k}"]`, { force: true });
  await p.fill('dialog input[name="usualHours"]', "7"); await p.fill('dialog input[name="leaveBy"]', "14:45"); await p.fill('dialog input[name="leaveNote"]', "School pickup");
  await p.screenshot({ path: join(SHOTS, "e10-schedule.png") });
  await p.click('dialog button[type="submit"]'); await p.waitForSelector("dialog", { state: "detached" });
  ok(await p.isVisible("text=/Mon–Fri.*leaves by 2:45 PM \\(School pickup\\)/"), "summary on the row");
});
await t("Plan board: each person's last time-clock punch, green in / red out, by station and by person", async () => {
  if (DAY !== today) return;   // punches only exist for today
  const punch = (pid, i, o) => sqlite.prepare("INSERT INTO labor_clock_today(id, person_id, clock_in, clock_out) VALUES(?,?,?,?)").run(Math.random().toString(36).slice(2), pid, `${DAY}T${i}:00`, o ? `${DAY}T${o}:00` : null);
  punch(ids.Ana, "05:02", "08:00"); punch(ids.Ana, "08:30", null);    // back from break: in 8:30
  punch(ids.Beto, "05:31", "10:15");                                   // gone: out 10:15
  const m = await page({ width: 1194, height: 834 });
  await m.p.goto(url + "/#/plan"); await m.p.waitForSelector("#pl-board .tl-bar");
  const tags = await m.p.$$eval("#pl-board .tl-bar .tl-punch", els => els.map(e => e.className + " " + e.textContent));
  ok(tags.some(x => /in 8:30/.test(x)) && tags.some(x => /out 10:15/.test(x)), `bar tags: ${tags.join(", ")}`);
  const tip = await m.p.$eval(`#pl-board .tl-bar[data-emp="${ids.Beto}"]`, e => e.title);
  ok(/last punch: clocked out 10:15 AM/.test(tip), `hover: ${tip}`);
  const stat = await m.p.textContent("#pl-status");
  ok(/labor \$[\d,]+ = \d+\.\d%/.test(stat), `status line labor: ${stat}`);
  ok(await m.p.$eval("#pl-status .pv-pct", e => /good-txt|warn-txt|bad-txt/.test(e.className)), "percent colored by the target");
  await m.p.locator("#pl-status").screenshot({ path: join(SHOTS, "e11c-status-labor.png") });
  await m.p.locator(".pv-board").screenshot({ path: join(SHOTS, "e11-punch-stations.png") });
  await m.p.click('.tl-view button:has-text("People")'); await m.p.waitForSelector(".tl-lab .tl-punch");
  const labs = await m.p.$$eval("#pl-board .tl-lab .tl-punch", els => els.map(e => e.className + " " + e.textContent));
  ok(labs.some(x => /in 8:30/.test(x)) && labs.some(x => /out 10:15/.test(x)), `name tags: ${labs.join(", ")}`);
  const beto = await m.p.$eval(`#pl-board .tl-lab[data-emp="${ids.Beto}"] .tl-worked`, e => e.textContent);
  ok(/4h 44m/.test(beto), `Beto's time on the clock: ${beto}`);   // 5:31–10:15
  const wk = await m.p.$$eval("#pl-board .tl-lab .tl-week", els => els.map(e => e.textContent + " | " + e.title));
  ok(wk.length && wk.every(x => /\d+h \d\dm \| This week: /.test(x)), `week totals: ${wk.join(" / ")}`);
  const hts = await m.p.$$eval("#pl-board .tl-row", rows => rows.map(r => [r.querySelector(".tl-lab").offsetHeight, r.querySelector(".tl-bar")?.offsetHeight || 0]));
  ok(hts.every(([lab, bar]) => !bar || bar >= lab - 14), `bars fill the row: ${JSON.stringify(hts)}`);
  await m.p.locator(".pv-board").screenshot({ path: join(SHOTS, "e11b-punch-people.png") });
  await m.p.click('.tl-view button:has-text("Stations")'); await m.p.waitForSelector("#pl-board .tl-bar");
  // Gus moves onto DCT 1 at 7:00 while Cora's there: his time there is shaded red (Neal, Oct 15)
  await m.p.click(`#pl-board .tl-bar[data-emp="${ids.Gus}"]`); await m.p.waitForSelector('dialog select[name="mv"]');
  await m.p.selectOption('dialog select[name="mv"]', "dct1"); await m.p.fill('dialog input[name="mvat"]', "07:00");
  await m.p.click('dialog button[type="submit"]'); await m.p.waitForSelector("dialog", { state: "detached" });
  await m.p.waitForSelector(`#pl-board .tl-row[data-code="dct1"] .tl-bar.dup[data-emp="${ids.Gus}"]`);
  ok(!(await m.p.$(`#pl-board .tl-bar.dup[data-emp="${ids.Cora}"]`)), "Cora, there first, isn't shaded");
  ok(/2 people on DCT 1/.test(await m.p.$eval(`#pl-board .tl-bar.dup[data-emp="${ids.Gus}"]`, e => e.title)), "hover says why");
  await m.p.locator(".pv-board").screenshot({ path: join(SHOTS, "e11d-two-on-station.png") });
  await m.ctx.close();
});
await t("Tablet: the plan fits, and a person's sheet opens with their times", async () => {
  const m = await page({ width: 1194, height: 834 });
  await m.p.goto(url + "/#/plan"); await m.p.waitForSelector("#pl-board .tl-row");
  ok(await m.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll");
  await m.p.screenshot({ path: join(SHOTS, "e9-plan-tablet.png") });
  await m.p.click("#pl-board .tl-bar[data-emp]"); await m.p.waitForSelector('dialog.sheet input[name="from"]');
  await m.p.screenshot({ path: join(SHOTS, "e9b-move-sheet.png") });
  await m.p.keyboard.press("Escape"); await m.p.waitForSelector("dialog", { state: "detached" });
  await m.p.goto(url + `/#/plan?day=${later}`); await m.p.waitForSelector("#pl-board .tl-bar");
  await m.p.locator(".pv-board").screenshot({ path: join(SHOTS, "e9d-stations-tablet.png") });
  await m.ctx.close();
  const ph = await page({ width: 390, height: 844 });
  await ph.p.goto(url + "/#/plan"); await ph.p.waitForSelector("#pl-board .tl-row");
  await ph.p.click("#pl-board .tl-bar[data-emp]"); await ph.p.waitForSelector('dialog.sheet input[name="from"]');
  await ph.p.screenshot({ path: join(SHOTS, "e9c-move-phone.png") });
  await ph.p.keyboard.press("Escape"); await ph.p.waitForSelector("dialog", { state: "detached" });
  await ph.p.goto(url + `/#/plan?day=${later}`); await ph.p.waitForSelector("#pl-board .tl-bar");
  await ph.p.locator(".pv-board").screenshot({ path: join(SHOTS, "e9e-stations-phone.png") });
  await ph.ctx.close();
});
await t("no page errors", async () => { ok(!errors.length, errors.join("\n")); });

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
