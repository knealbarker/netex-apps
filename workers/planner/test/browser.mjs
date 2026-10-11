// Browser test: the real pages, served through the Worker code, in headless Chromium.
// Run: node workers/planner/test/browser.mjs   (screenshots go to $SHOTS or ./test/shots)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, fakeAccess, makeEnv, serve } from "./harness.mjs";
import { ingestDay } from "../../sync/src/ingest.js";
import { nextWorkDay, localNow, addDays } from "../src/pieces.js";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright")); }
const SHOTS = process.env.SHOTS || join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });

const A = await fakeAccess();
const { db } = freshDb();
let who = "neal@towncountryclean.com";
const { server, url } = await serve(makeEnv(db), { fetchImpl: A.fetchImpl, token: A.token, who: () => who });

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n")[0]); } };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const browser = await chromium.launch();
const errors = [];
async function page(viewport = { width: 1360, height: 860 }, scheme = "dark") {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on("pageerror", e => errors.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push("console: " + m.text()); });
  return p;
}

const p = await page();
await t("shell loads for the Owner with name, role and Plan selected", async () => {
  await p.goto(url + "/");
  await p.waitForSelector("#meBtn:not(:empty)");
  ok((await p.textContent("#meBtn")) === "NB");
  ok((await p.getAttribute('#nav a[data-view="plan"]', "aria-current")) === "page");
  ok((await p.textContent("main h1")) === "Plan");
  await p.screenshot({ path: join(SHOTS, "1-plan.png") });
});
await t("account menu opens, shows Users link, closes on Escape", async () => {
  await p.click("#meBtn");
  ok(await p.isVisible("#meMenu")); ok(await p.isVisible("#usersLink"));
  ok((await p.textContent("#meRole")) === "Owner");
  await p.screenshot({ path: join(SHOTS, "2-menu.png") });
  await p.keyboard.press("Escape"); ok(!(await p.isVisible("#meMenu")));
});
await t("tabs switch sections and update the title", async () => {
  for (const v of ["floor", "review", "team", "settings"]) {
    await p.click(`#nav a[data-view="${v}"]`);
    await p.waitForFunction(v => document.querySelector(`#nav a[data-view="${v}"]`).getAttribute("aria-current") === "page", v);
  }
  ok((await p.title()).startsWith("Settings"));
});
await t("Users: add a Manager through the dialog", async () => {
  await p.goto(url + "/#/users");
  await p.waitForSelector(".urow");
  await p.click("#addUser");
  await p.fill('dialog input[name="name"]', "Maria Castillo");
  await p.fill('dialog input[name="email"]', "maria@example.com");
  await p.check('dialog input[name="role"][value="manager"]');
  await p.screenshot({ path: join(SHOTS, "3-add.png") });
  await p.click('dialog button[type="submit"]');
  await p.waitForSelector("text=maria@example.com");
  ok(await p.isVisible(".toast"));
  await p.screenshot({ path: join(SHOTS, "4-users.png") });
});
await t("Users: a duplicate email shows the error inside the dialog", async () => {
  await p.click("#addUser");
  await p.fill('dialog input[name="name"]', "Maria Again");
  await p.fill('dialog input[name="email"]', "MARIA@example.com");
  await p.click('dialog button[type="submit"]');
  await p.waitForSelector("dialog .form-error:not([hidden])");
  ok(/already on the list/.test(await p.textContent("dialog .form-error")));
  await p.click("dialog [data-close]");
});
await t("Users: edit — change role to Viewer and turn off", async () => {
  await p.click('.urow:has-text("Maria Castillo")');
  await p.check('dialog input[name="role"][value="viewer"]');
  await p.click('dialog input[name="active"]');
  await p.screenshot({ path: join(SHOTS, "5-edit.png") });
  await p.click('dialog button[type="submit"]');
  await p.waitForSelector('.urow.inactive:has-text("Maria Castillo")');
});
await t("Owner's own row: can't turn yourself off", async () => {
  await p.click('.urow:has-text("(you)")');
  ok(await p.isDisabled('dialog input[name="active"]'));
  await p.click("dialog [data-close]");
});
await t("someone not on the list sees a clear message, no tabs", async () => {
  who = "stranger@gmail.com";
  const q = await page();
  await q.goto(url + "/");
  await q.waitForSelector(".blocked h2");
  ok(/not on the planner's user list/.test(await q.textContent(".blocked h2")));
  ok(/stranger@gmail.com/.test(await q.textContent(".blocked p")));
  ok(!(await q.isVisible("#nav")));
  await q.screenshot({ path: join(SHOTS, "6-not-listed.png") });
  who = "neal@towncountryclean.com";
});
await t("a Viewer has no Users link and gets 'Admins only' on #/users", async () => {
  await db.prepare("UPDATE core_users SET status='active' WHERE email='maria@example.com'").run();
  who = "maria@example.com";
  const q = await page();
  await q.goto(url + "/#/users");
  await q.waitForSelector(".blocked h2");
  ok((await q.textContent(".blocked h2")) === "Admins only");
  await q.click("#meBtn"); ok(!(await q.isVisible("#usersLink")));
  who = "neal@towncountryclean.com";
});
await t("phone width: tabs become a bottom bar, list still readable", async () => {
  const q = await page({ width: 390, height: 844 });
  await q.goto(url + "/#/users");
  await q.waitForSelector(".urow");
  const nav = await q.$eval("#nav", el => getComputedStyle(el).position);
  ok(nav === "fixed", "nav fixed at bottom");
  const overflow = await q.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok(!overflow, "no sideways scroll");
  await q.screenshot({ path: join(SHOTS, "7-phone.png") });
});
await t("light theme renders", async () => {
  const q = await page({ width: 1360, height: 860 }, "light");
  await q.goto(url + "/#/users");
  await q.waitForSelector(".urow");
  const bg = await q.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(bg === "rgb(244, 246, 250)", bg);
  await q.screenshot({ path: join(SHOTS, "8-light.png") });
});
// ---------- stage 2: import, team grid, settings ----------
const DESK = {
  biz: "Town & Country Cleaners", defStart: "07:00", fullDay: 7.5, breakMin: 30, washOn: true, washers: 3, washSlt: 65, washSlb: 25, washComf: 2, washTc: 10, cycLaundry: 45, cycComf: 60, cycTc: 40,
  employees: [
    { id: "a", name: "Ana Uno", start: "05:00", skills: { slt1: true, slb1: 3, dco: 2, asm1: 2 }, rip: "38", ripName: "Ana Uno" },
    { id: "b", name: "Beto Dos", start: "07:30", skills: { dct1: 1, dct2: 2, dct3: 3, dcb1: 1 }, rip: "40", ripName: "Beto Dos" },
    { id: "c", name: "Cora Tres", start: "05:35", skills: { slt2: 1, slb1: 1, slb2: 2, asm2: 1 }, rip: "41", ripName: "Cora Tres" },
  ],
  price: { dct: 6.79, dcb: 7.53, slt: 3.84, slb: 6.91, comf: 35.7, tc: 14.04 }, payAvg: 13, laborTarget: 17,
  rates: { slb: 20, sltSolo: 50, sltPair: 80, dct: 25, dcb: 25, tc: 6, asm: 100, comf: 3 },
  shuttles: { runs: [{ id: "wq", name: "Winnsboro + Quitman", back: 30, stops: [{ store: "Winnsboro", cutoff: "11:00", arrive: "11:30", drive: 30, stay: 15 }, { store: "Quitman", cutoff: "11:30", arrive: "12:00", drive: 15, stay: 15 }] }],
    counter: { name: "Sulphur Springs store", store: "Sulphur Springs", ready: "16:00", cutoff: "18:00" }, warn: [45, 15] },
};
const HIST = { v: 1, day: "2026-09-08", actual: { people: [{ rip: "40", name: "Beto Dos", in: 3.83, out: 12.35, hours: 8.52 }] } };
await t("Settings › Import: the Owner imports the desktop files", async () => {
  await p.goto(url + "/#/settings");
  await p.waitForSelector("#sec-import");
  await p.setInputFiles('#sec-import input[name="data"]', { name: "planner-data.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(DESK)) });
  await p.setInputFiles('#sec-import input[name="history"]', [{ name: "2026-09-08.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(HIST)) }]);
  await p.click('#sec-import button[type="submit"]');
  await p.waitForSelector("#sec-import .import-result:not([hidden])");
  ok(/3 people added/.test(await p.textContent("#sec-import .import-result")), await p.textContent("#sec-import .import-result"));
});
await t("Team: each person shows trainings in order; DCT 1-3 count as one", async () => {
  await p.goto(url + "/#/team");
  await p.waitForSelector(".team-list");
  const beto = await p.locator('.trow:has-text("Beto Dos") .tchip').allTextContents();
  ok(JSON.stringify(beto) === JSON.stringify(["1DCT", "2DCB"]), JSON.stringify(beto));
  await p.screenshot({ path: join(SHOTS, "9-team.png") });
});
await t("Team: trainings editor reorders, removes and adds, then saves", async () => {
  await p.click('.trow:has-text("Ana Uno") [data-train]');
  await p.waitForSelector("dialog .tlist");
  await p.click('dialog [data-down="0"]');               // SLT 1 below IAB 1
  await p.click('dialog .tadd [data-add="dct"]');        // add DCT at the end
  await p.locator("dialog").screenshot({ path: join(SHOTS, "9b-trainings.png") });
  await p.click('dialog button[type="submit"]');
  await p.waitForSelector("dialog", { state: "detached" });
  const team = await (await p.request.get(url + "/api/team")).json();
  const ana = team.people.find(x => x.name === "Ana Uno").trainings;
  ok(JSON.stringify(ana) === JSON.stringify(["iab1", "slt1", "dco", "slb", "dct"]), JSON.stringify(ana));
});
await t("Team: picking a training in the strip sorts people by who runs it best", async () => {
  await p.click('[data-focus="slb"]');
  const first = await p.locator(".trow .who-txt b").first().textContent();
  ok(first === "Cora Tres", first);
  await p.click('[data-focus="slb"]');
});
await t("Team: thin coverage banner names stations with fewer than 2 trained", async () => {
  ok(/Thin coverage/.test(await p.textContent(".banner.warn")));
});
await t("Team: add a person through the dialog", async () => {
  await p.click("#addPerson");
  await p.fill('dialog input[name="firstName"]', "Dee");
  await p.fill('dialog input[name="lastName"]', "Cuatro");
  await p.fill('dialog input[name="usualStart"]', "06:15");
  await p.click('dialog button[type="submit"]');
  await p.waitForSelector('.trow:has-text("Dee Cuatro")');
});
await t("Settings: change a value, Save lights up, value persists", async () => {
  await p.goto(url + "/#/settings");
  await p.waitForSelector("#sec-day");
  ok(await p.isDisabled('#sec-day button[type="submit"]'));
  await p.fill('#sec-day input[name="fullDay"]', "8");
  ok(!(await p.isDisabled('#sec-day button[type="submit"]')));
  await p.click('#sec-day button[type="submit"]');
  await p.waitForSelector("#sec-day .saved-note.ok");
  const s = await (await p.request.get(url + "/api/settings")).json();
  ok(s.groups.day.fullDay === 8);
  ok((await p.inputValue('#sec-money input[name="prices.comf"]')) === "35.7");
  await p.screenshot({ path: join(SHOTS, "10-settings.png"), fullPage: true });
});
await t("Settings: work days show Mon–Fri on, and toggling Saturday saves", async () => {
  ok(await p.isChecked('#sec-day input[name="workDays.1"]') && !(await p.isChecked('#sec-day input[name="workDays.6"]')));
  await p.click('#sec-day label.day-chip:has(input[name="workDays.6"])');
  await p.click('#sec-day button[type="submit"]');
  await p.waitForSelector("#sec-day .saved-note.ok");
  const s = await (await p.request.get(url + "/api/settings")).json();
  ok(JSON.stringify(s.groups.day.workDays) === "[1,2,3,4,5,6]", JSON.stringify(s.groups.day.workDays));
  await p.click('#sec-day label.day-chip:has(input[name="workDays.6"])');
  await p.click('#sec-day button[type="submit"]');
  await p.waitForSelector("#sec-day .saved-note.ok");
  await p.locator("#sec-day").screenshot({ path: join(SHOTS, "13-workdays.png") });
});
await t("Settings: a bad value shows the server's message on the card", async () => {
  await p.fill('#sec-day input[name="fullDay"]', "40");
  await p.click('#sec-day button[type="submit"]');
  await p.waitForSelector("#sec-day .saved-note.bad");
  ok(/between/.test(await p.textContent("#sec-day .saved-note")));
});
await t("Settings: runs editor adds a stop and saves", async () => {
  await p.click('#sec-runs .run[data-i="0"] .add-stop');
  await p.fill('#sec-runs .run[data-i="0"] .stop[data-j="2"] input[name="store"]', "Mineola");
  await p.fill('#sec-runs .run[data-i="0"] .stop[data-j="2"] input[name="arrive"]', "12:40");
  await p.click('#sec-runs button[type="submit"]');
  await p.waitForSelector("#sec-runs .saved-note.ok");
  const s = await (await p.request.get(url + "/api/settings")).json();
  ok(s.runs[0].stops.map(x => x.store).join() === "Winnsboro,Quitman,Mineola", JSON.stringify(s.runs[0].stops));
});
await t("Settings: a Viewer sees values but can't edit", async () => {
  who = "maria@example.com";
  const q = await page();
  await q.goto(url + "/#/settings");
  await q.waitForSelector("#sec-day");
  ok(await q.isDisabled('#sec-day input[name="fullDay"]'));
  ok(!(await q.$('#sec-day button[type="submit"]')));
  ok(!(await q.$("#sec-import")));
  await q.goto(url + "/#/team"); await q.waitForSelector(".team-list");
  ok(!(await q.$("[data-train]")), "viewer has no Trainings button");
  who = "neal@towncountryclean.com";
});
await t("phone: team grid scrolls inside its card, settings stack", async () => {
  const q = await page({ width: 390, height: 844 });
  await q.goto(url + "/#/team"); await q.waitForSelector(".team-list");
  ok(!(await q.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), "no page-level sideways scroll on team");
  await q.screenshot({ path: join(SHOTS, "11-team-phone.png") });
  await q.goto(url + "/#/settings"); await q.waitForSelector("#sec-runs");
  ok(!(await q.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), "no sideways scroll on settings");
  await q.screenshot({ path: join(SHOTS, "12-settings-phone.png"), fullPage: true });
});
await t("Plan: pieces for the next work day, by store, with a late list", async () => {
  // a few orders due on the next work day and one overdue, through the same ingest live SMRT data uses
  const today = localNow("America/Chicago").day, next = nextWorkDay(today, [1, 2, 3, 4, 5]);
  const ts = (d, hm = "10:00") => `${d}T${hm}:00-05:00`;
  const orders = [], items = []; let k = 0;
  const add = (store, due, deps) => { const id = `2699${String(++k).padStart(5, "0")}`;
    orders.push({ "ID": id, "Status": "processing", "Due date": due, "Created": ts(addDays(today, -3)), "Piece Count": String(deps.length), "Return Location": `TCC ${store}`, "Customer Id": "c1" });
    deps.forEach((d, i) => items.push({ "Sale Id": id, "Barcode": `${id}${i}`, "Item Status": "detailed", "Financial department": d, "Item Type": "Shirt", "Created": ts(addDays(today, -3)) })); };
  for (let i = 0; i < 12; i++) add("Quitman", ts(next, "12:00"), ["Dry Cleaning Tops", "Laundry Tops", "Laundry Tops"]);
  for (let i = 0; i < 8; i++) add("Sulphur Springs", ts(next, "16:00"), ["Laundry Bottoms", "Dry Cleaning Bottoms"]);
  add("Emory", ts(addDays(today, -4), "13:00"), ["Laundry Bottoms", "Laundry Bottoms"]);
  await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,finished_at,status,message) VALUES('lv','smrt',?,?,'ok','live: test')").bind(new Date().toISOString(), new Date().toISOString()).run();
  await ingestDay(db, { orgId: "tcc", runId: "lv", mode: "backfill", day: addDays(today, -3) }, orders, items);
  await p.goto(url + "/#/plan");
  await p.waitForSelector(".tiles");
  const tiles = await p.locator(".tile .t-num").allTextContents();
  ok(tiles.length === 7, JSON.stringify(tiles));
  ok(await p.isVisible('.dl-row:has-text("Quitman")'), "Quitman row");
  await p.screenshot({ path: join(SHOTS, "14-plan.png"), fullPage: true });
});
await t("no page errors", async () => { ok(!errors.length, errors.join("\n")); });

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
