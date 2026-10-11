// Browser test: the real pages, served through the Worker code, in headless Chromium.
// Run: node workers/planner/test/browser.mjs   (screenshots go to $SHOTS or ./test/shots)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, fakeAccess, makeEnv, serve } from "./harness.mjs";

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
await t("no page errors", async () => { ok(!errors.length, errors.join("\n")); });

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
