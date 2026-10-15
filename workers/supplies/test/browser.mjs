// Browser test: the real pages through the Worker code in headless Chromium. Run: node workers/supplies/test/browser.mjs
// A store device pairs and counts; Karla works the shuttle list, the Workshop count, vendor orders, the supply list and setup.
// Screenshots go to $SHOTS or ./test/shots.
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
const { db, sqlite } = freshDb();
sqlite.prepare("INSERT INTO core_users(id, org_id, email, display_name) VALUES('01KARLA000000000000000000A','tcc','karla@x.com','Karla Velasquez')").run();
sqlite.prepare("INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES('01KARLA000000000000000000A','supplies','manager','x')").run();
let who = "karla@x.com";
const { server, url } = await serve(makeEnv(db), { fetchImpl: A.fetchImpl, token: A.token, who: () => who });

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
const shot = (p, name, full = true) => p.screenshot({ path: join(SHOTS, name + ".png"), fullPage: full });

// ---- Karla sets up a person and a Quitman device
const k = await page();
let code;
await t("Setup: add a counter and a device, get a code", async () => {
  await k.goto(url + "/#/setup"); await k.waitForSelector("#vendors");
  await k.click('[data-counter=""]'); await k.fill("dialog [name=first]", "Maria"); await k.fill("dialog [name=li]", "g"); await k.click("dialog [type=submit]");
  await k.waitForSelector("text=Types “MariaG”");
  await k.click("#addDevice"); await k.selectOption("dialog [name=loc]", { label: "Quitman Retail" }); await k.click("dialog [type=submit]");
  await k.waitForSelector(".big-code"); code = (await k.textContent(".big-code")).replace(/\D/g, "");
  ok(code.length === 6); await shot(k, "setup-code", false);
  await k.click("dialog [type=submit]"); await k.waitForSelector("text=waiting for its code");
  await shot(k, "setup");
});

// ---- the Quitman phone
const s = await page({ width: 390, height: 844 }, "light");
await t("Count page: pair, name, count, review, send (phone)", async () => {
  await s.goto(url + "/count/"); await s.waitForSelector("#pair"); await shot(s, "count-1-pair");
  await s.fill("[name=code]", code); await s.click("#pair button");
  await s.waitForSelector("#who"); ok((await s.textContent("#locName")) === "Quitman Retail");
  await s.fill("[name=name]", "Bob Z"); await s.click("#who [type=submit]"); await s.waitForSelector("text=isn't on the approved list");
  await s.fill("[name=name]", "mariag"); await s.click("#who [type=submit]"); await s.waitForSelector(".cf-row");
  await shot(s, "count-2-sheet", false);
  const row = name => s.locator(".cf-row", { hasText: name }).first();
  await row("Toilet paper").locator("[data-qty]").fill("2");
  await row("Receipt paper").locator("[data-qty]").fill("25");
  await row("Safe and Secure bags").locator("[data-level=low]").click();
  await row("Candy").locator('[data-d="1"]').click();
  await row("AA batteries").locator("[data-level=need]").click(); await row("AA batteries").locator("[data-qty]").fill("4");
  ok((await row("Toilet paper").textContent()).includes("Send 4 rolls"));
  await s.reload(); await s.waitForSelector("#who"); ok((await s.textContent("#who [type=submit]")).includes("5 answered"), "draft kept");
  await s.click("#who [type=submit]"); await s.waitForSelector(".cf-row");
  await row("Safe and Secure bags").scrollIntoViewIfNeeded(); await shot(s, "count-3-answered", false);
  await s.click("#review"); await s.waitForSelector(".ct-needs");
  await s.fill("#note", "Stapler is broken"); await shot(s, "count-4-review");
  await s.click("#send"); await s.waitForSelector(".ct-done"); await shot(s, "count-5-done");
});

// ---- Karla: shuttle
await t("Shuttle: list shows, edit, add write-in, print, mark sent", async () => {
  await k.goto(url + "/#/shuttle"); await k.waitForSelector(".ship");
  ok((await k.textContent(".ship")).includes("Stapler is broken"));
  await k.locator("tr", { hasText: "Toilet paper" }).locator("[data-send]").fill("6");
  await k.click("[data-add]"); await k.fill("dialog [name=label]", "New stapler"); await k.click("dialog [type=submit]");
  await k.waitForSelector("text=write-in"); await shot(k, "shuttle");
  await k.locator("tr", { hasText: "Toilet paper" }).locator("[data-send]").fill("6"); await k.waitForTimeout(700);
  await k.evaluate(() => { window.print = () => {}; });
  await k.click(".ship [data-print]");
  await k.emulateMedia({ media: "print" }); await shot(k, "print-shuttle-slip");
  ok((await k.textContent("#print")).includes("New stapler"));
  await k.emulateMedia({ media: "screen" });
  await k.click("[data-sent]"); await k.waitForSelector("text=Sent in the last 7 days");
});

await t("Counts: request, Workshop count entry", async () => {
  await k.goto(url + "/#/counts"); await k.waitForSelector(".lrow");
  await k.click("#ask"); await k.click("dialog [type=submit]"); await k.waitForSelector("text=Asked");
  await shot(k, "counts");
  await k.goto(url + "/#/orders"); await k.click("text=Enter Workshop count"); await k.waitForSelector(".cf-row");
  const row = name => k.locator(".cf-row", { hasText: name }).first();
  await row("Bongo 12 oz").locator("[data-qty]").fill(".5");
  await row("Jeans strut hanger").locator("[data-qty]").fill("5");
  await row("Toilet paper").locator("[data-qty]").fill("0");
  await row("Receipt paper").locator("[data-qty]").fill("2");
  await k.click('[data-filter="v:Fabriclean Supply"]'); await shot(k, "workshop-count", false);
  await k.click("#save"); await k.waitForSelector("h1:has-text('Orders')");
});

await t("Orders: grouped by vendor, print, mark ordered", async () => {
  await k.waitForSelector(".ship"); await shot(k, "orders");
  await k.evaluate(() => { window.print = () => {}; });
  await k.click('.ship [data-print="0"]'); ok((await k.textContent("#print")).includes("Bongo"));
  await k.emulateMedia({ media: "print" }); await shot(k, "print-order-sheet"); await k.emulateMedia({ media: "screen" });
  await k.click('[data-order="0"]'); await k.fill("dialog [name=ref]", "W12345"); await k.click("dialog [type=submit]");
  await k.waitForSelector("text=#W12345");
});

await t("Supply list: filter, edit an item's pars and answer mode", async () => {
  await k.goto(url + "/#/items"); await k.waitForSelector("#rows tr"); await shot(k, "items", false);
  await k.click("#showReview"); await k.click("tr:has-text('Receipt paper')"); await k.waitForSelector("dialog .par-grid");
  await shot(k, "item-edit", false);
  const q = k.locator("dialog .pg-row", { hasText: "Quitman" });
  await q.locator("[data-mode]").selectOption("level"); await q.locator("[data-par]").fill("12");
  await k.check("dialog [name=cleared]"); await k.click("dialog [type=submit]"); await k.waitForSelector("dialog", { state: "detached" });
  const r = sqlite.prepare("SELECT p.par, p.mode, i.review_note FROM supply_pars p JOIN supply_items i ON i.id=p.item_id JOIN core_locations l ON l.id=p.location_id WHERE i.name='Receipt paper' AND l.name='Quitman'").get();
  ok(r.par === 12 && r.mode === "level" && r.review_note === null, JSON.stringify(r));
});

await t("Vendor: lead time and minimum", async () => {
  await k.goto(url + "/#/setup"); await k.click('[data-vendor="janitorial"]');
  await k.fill("dialog [name=leadDays]", "2"); await k.fill("dialog [name=minAmount]", "150"); await k.click("dialog [type=submit]");
  await k.waitForSelector("text=2 day lead");
});

await t("phone + light: manager screens", async () => {
  const m = await page({ width: 390, height: 844 }, "light");
  for (const v of ["shuttle", "orders", "counts", "items"]) { await m.goto(url + "/#/" + v); await m.waitForSelector(".page-head"); await m.waitForTimeout(150); await shot(m, "phone-" + v); }
  const w = await m.evaluate(() => document.documentElement.scrollWidth); ok(w <= 392, "no sideways scroll on phone: " + w);
});

await t("no page errors", async () => { ok(!errors.length, errors.join(" | ")); });
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
