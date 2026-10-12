// Browser test: the real pages through the Worker code in headless Chromium. Run: node workers/retail/test/browser.mjs
// Screenshots go to $SHOTS or ./test/shots.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, fakeAccess, makeEnv, serve } from "./harness.mjs";
import { seed } from "./seed.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright")); }
const SHOTS = process.env.SHOTS || join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });

const A = await fakeAccess();
const { db, sqlite } = freshDb();
await seed(db, { last: "2026-10-09", days: 30, today: "2026-10-10" });
sqlite.prepare("INSERT INTO pos_staff(id, org_id, smrt_name) VALUES('STHUB','tcc','Hub T'),('STCONV','tcc','Conveyor')").run();
sqlite.prepare("UPDATE pos_items SET assembled_by_staff_id='STHUB' WHERE assembled_at IS NOT NULL AND department_id=(SELECT id FROM pos_departments WHERE name='Laundry Tops')").run();
sqlite.prepare("UPDATE pos_items SET assembled_by_staff_id='STCONV' WHERE assembled_at IS NOT NULL AND assembled_by_staff_id IS NULL").run();
sqlite.prepare("INSERT INTO core_users(id, org_id, email, display_name) VALUES('01MGR00000000000000000000A','tcc','mgr@x.com','Store Manager')").run();
sqlite.prepare("INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES('01MGR00000000000000000000A','retail','manager','x')").run();
let who = "neal@towncountryclean.com";
const { server, url } = await serve(makeEnv(db, { NOW: "2026-10-10T12:00:00-05:00" }), { fetchImpl: A.fetchImpl, token: A.token, who: () => who });

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n")[0]); } };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };
const browser = await chromium.launch();
const errors = [];
async function page(viewport = { width: 1360, height: 900 }, scheme = "dark") {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on("pageerror", e => errors.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push("console: " + m.text()); });
  return p;
}

const p = await page();
await t("Snapshot opens on the last 7 days with tiles, stores and charts", async () => {
  await p.goto(url + "/");
  await p.waitForSelector(".stable .srow.grand");
  ok((await p.textContent("main h1")) === "Retail Snapshot");
  ok(await p.isVisible('[data-p="last7"][aria-selected="true"]'));
  ok((await p.locator(".kpis .tile").count()) === 7, "7 tiles for the Owner");
  ok((await p.textContent(".stable")).includes("Winnsboro"));
  ok((await p.locator(".charts svg").count()) === 2);
  await p.screenshot({ path: join(SHOTS, "1-snapshot.png"), fullPage: true });
});
await t("chart hover shows the day's numbers", async () => {
  const bar = p.locator(".charts svg .hit").nth(3);
  await bar.hover();
  ok(await p.isVisible(".tip")); ok(/Revenue/.test(await p.textContent(".tip")));
});
await t("picking a store narrows the day-by-day section; link keeps it", async () => {
  await p.selectOption("#pick", "Emory");
  ok(/store=Emory/.test(p.url()));
  ok((await p.textContent(".charts figcaption")).includes("Emory"));
  await p.screenshot({ path: join(SHOTS, "2-emory-daily.png"), fullPage: true });
});
await t("This month preset re-adds everything", async () => {
  await p.click('[data-p="month"]');
  await p.waitForFunction(() => /Oct 1/.test(document.querySelector("#rangeLine").textContent));
  ok(/p=month/.test(p.url()));
});
await t("custom dates work", async () => {
  await p.fill("#from", "2026-09-28"); await p.dispatchEvent("#from", "change");
  await p.waitForFunction(() => /Sep 28/.test(document.querySelector("#rangeLine").textContent));
});
await t("Hours: person-by-day grid per store, today's live punch marked", async () => {
  await p.goto(url + "/#/hours?p=week");
  await p.waitForSelector(".hgrid");
  ok((await p.locator(".hgrid-card").count()) >= 4);
  ok(await p.isVisible(".live"));
  await p.screenshot({ path: join(SHOTS, "3-hours.png"), fullPage: true });
});
await t("Settings: targets, rates, stores and the Rippling import (Owner)", async () => {
  await p.goto(url + "/#/settings");
  await p.waitForSelector("#f");
  ok(await p.isVisible("#csv"));
  ok((await p.inputValue('select[name="roll:Winnsboro"]')) === "Sulphur Springs");
  await p.fill('input[name="burdenPct"]', "8");
  await p.click('#f [type="submit"]');
  await p.waitForSelector(".toast");
  await p.screenshot({ path: join(SHOTS, "4-settings.png"), fullPage: true });
});
await t("Settings: overtime and daily summary controls; email preview renders", async () => {
  ok(await p.isChecked('input[name="overtime"]'));
  await p.check('input[name="sumOn"]'); await p.fill('input[name="sumTo"]', "neal@towncountryclean.com");
  await p.click('#f [type="submit"]');
  await p.waitForFunction(() => [...document.querySelectorAll(".toast")].some(t => /saved/i.test(t.textContent)));
  await p.locator(".set-card").filter({ hasText: "Daily summary" }).screenshot({ path: join(SHOTS, "8-summary-settings.png") });
  const pv = await page({ width: 760, height: 900 }, "light");
  await pv.goto(url + "/api/summary/preview?day=2026-10-09");
  ok((await pv.textContent("h1")).includes("October 9"));
  await pv.screenshot({ path: join(SHOTS, "9-email.png"), fullPage: true });
});
await t("overtime shows in the store table and hours grid (30 days of 7-day weeks)", async () => {
  await p.goto(url + "/#/snapshot?p=last7");
  await p.waitForSelector(".stable .srow.grand");
  ok(await p.locator(".stable .ot").count() > 0);
  await p.goto(url + "/#/hours?p=lastweek");
  await p.waitForSelector(".hgrid");
  ok(await p.locator(".hgrid .ot").count() > 0);
});
const light = await page({ width: 1360, height: 900 }, "light");
await t("Workshop picked: production value and labor % charts; Settings lists production work", async () => {
  await p.goto(url + "/#/snapshot?p=last7&store=Workshop");
  await p.waitForSelector(".stable .srow.grand");
  ok((await p.textContent(".charts figcaption")).includes("Production value"));
  ok((await p.textContent(".stable")).includes("pcs"));
  await p.screenshot({ path: join(SHOTS, "10-workshop.png"), fullPage: true });
  await p.goto(url + "/#/settings");
  await p.waitForSelector('select[name="work:Wash & Fold"]');
  ok((await p.inputValue('select[name="work:Wash & Fold"]')) === "Laundry Hub");
  await p.locator(".set-card").filter({ hasText: "Production work" }).screenshot({ path: join(SHOTS, "11-production-work.png") });
});
await t("light theme", async () => {
  await light.goto(url + "/#/snapshot?p=last7");
  await light.waitForSelector(".stable .srow.grand");
  await light.screenshot({ path: join(SHOTS, "5-light.png"), fullPage: true });
});
const phone = await page({ width: 390, height: 844 });
await t("phone width: no sideways page scroll", async () => {
  await phone.goto(url + "/");
  await phone.waitForSelector(".stable .srow.grand");
  const w = await phone.evaluate(() => document.documentElement.scrollWidth);
  const wide = await phone.evaluate(() => [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > 392).slice(0, 5).map(e => e.tagName + "." + e.className).join(", "));
  ok(w <= 391, `page is ${w}px wide: ${wide}`);
  await phone.screenshot({ path: join(SHOTS, "6-phone.png"), fullPage: true });
});
await t("a Manager sees no labor $ or labor %, and no Settings tab", async () => {
  who = "mgr@x.com";
  const m = await page();
  await m.goto(url + "/");
  await m.waitForSelector(".stable .srow.grand");
  ok((await m.locator(".kpis .tile").count()) === 4);
  ok(!(await m.textContent(".stable")).includes("Labor"));
  ok(!(await m.isVisible("#settingsTab")));
  await m.screenshot({ path: join(SHOTS, "7-manager.png") });
  who = "neal@towncountryclean.com";
});
await t("no browser errors", async () => { ok(!errors.length, errors.join(" | ")); });

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
