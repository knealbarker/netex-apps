// Browser test for the Plan screen: suggestion, editing the crew, autosave, typed counts, fixes, dragging,
// call-outs, publishing, two PCs saving at once, a Viewer, phone width and the light theme.
// Run: node workers/planner/test/plan-ui.mjs   (screenshots go to $SHOTS or ./test/shots)
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
const NEAL = "neal@towncountryclean.com";
let who = NEAL;
const { server, url } = await serve(makeEnv(db), { fetchImpl: A.fetchImpl, token: A.token, who: () => who });
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n").slice(0, 3).join("\n       ")); } };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

// ---- data: team with trainings, users, runs, and orders through the SMRT ingest
const apiAs = async (email, method, path, body) => {
  const { handle } = await import("../src/index.js");
  const headers = new Headers({ "cf-access-jwt-assertion": await A.token({ email }) });
  if (body) headers.set("content-type", "application/json");
  const r = await handle(new Request(`https://prodplanner.netexcleaners.com/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), makeEnv(db), { fetchImpl: A.fetchImpl });
  return { status: r.status, body: await r.json() };
};
const api = (m, p, b) => apiAs(NEAL, m, p, b);
const team = [
  ["Ana", "Uno", "05:00", ["slt1", "slb"]], ["Beto", "Dos", "05:30", ["slt2", "slt1"]], ["Cora", "Tres", "06:00", ["dct", "dcb"]],
  ["Dani", "Cuatro", "07:00", ["iab1", "iab2"]], ["Eli", "Cinco", "05:00", ["slo"]], ["Fran", "Seis", "06:00", ["slb", "dct"]],
  ["Gus", "Siete", "06:30", ["dcb", "dct"]], ["Hilda", "Ocho", "06:00", ["dct", "iab2"]],
];
const ids = {};
for (const [f, l, start, tr] of team) {
  const r = await api("POST", "/team", { firstName: f, lastName: l, usualStart: start });
  ids[f] = r.body.id; await api("PUT", `/team/${r.body.id}/trainings`, { trainings: tr });
}
await api("POST", "/users", { name: "Mo Manager", email: "mo@example.com", role: "manager" });
await api("POST", "/users", { name: "Vi Viewer", email: "vi@example.com", role: "viewer" });
await api("PUT", "/settings/runs", { runs: [
  { name: "Quitman run", kind: "shuttle", driveBack: 40, stops: [{ store: "Quitman", arrive: "11:30", drive: 40, stay: 15 }, { store: "Winnsboro", arrive: "12:20", drive: 25, stay: 15 }] },
  { name: "Sulphur Springs counter", kind: "counter", stops: [{ store: "Sulphur Springs", arrive: "16:00", drive: 0, stay: 0 }] },
] });
const today = localNow("America/Chicago").day, next = nextWorkDay(today, [1, 2, 3, 4, 5]);
const wd = new Date(today + "T12:00:00Z").getUTCDay(), isWorkDay = wd >= 1 && wd <= 5;
const DAY = isWorkDay ? today : next; // the first tab
{
  const ts = (d, hm = "10:00") => `${d}T${hm}:00-05:00`;
  const orders = [], items = []; let k = 0;
  const add = (store, due, deps) => { const id = `2799${String(++k).padStart(5, "0")}`;
    orders.push({ "ID": id, "Status": "processing", "Due date": due, "Created": ts(addDays(today, -3)), "Piece Count": String(deps.length), "Return Location": `TCC ${store}`, "Customer Id": "c1" });
    deps.forEach((d, i) => items.push({ "Sale Id": id, "Barcode": `${id}${i}`, "Item Status": "detailed", "Financial department": d, "Item Type": "Shirt", "Created": ts(addDays(today, -3)) })); };
  for (const d of new Set([today, next])) {
    for (let i = 0; i < 40; i++) add("Quitman", ts(d, "12:00"), ["Dry Cleaning Tops", "Laundry Tops", "Laundry Tops", "Laundry Bottoms"]);
    for (let i = 0; i < 30; i++) add("Sulphur Springs", ts(d, "16:00"), ["Laundry Tops", "Laundry Bottoms", "Dry Cleaning Bottoms", "Dry Cleaning Tops"]);
  }
  await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,finished_at,status,message) VALUES('lv','smrt',?,?,'ok','live: test')").bind(new Date().toISOString(), new Date().toISOString()).run();
  await ingestDay(db, { orgId: "tcc", runId: "lv", mode: "backfill", day: addDays(today, -3) }, orders, items);
}

const browser = await chromium.launch();
const errors = [];
async function page(viewport = { width: 1440, height: 900 }, scheme = "dark") {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on("pageerror", e => errors.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error" && !/status of (4\d\d)/.test(m.text())) errors.push("console: " + m.text()); });
  return p;
}
const plan = async () => (await api("GET", `/plan/${DAY}`)).body;
const saved = p => p.waitForFunction(() => /^Saved/.test(document.getElementById("pl-save")?.textContent || ""), null, { timeout: 8000 });

const p = await page();
await t("a new day opens with a crew suggested from the team, nothing saved yet", async () => {
  await p.goto(url + "/#/plan");
  await p.waitForSelector("#pl-crew .cr-row");
  ok(await p.isVisible('#pl-note:has-text("Suggested from history")'), "suggestion banner");
  ok(/not saved/i.test(await p.textContent("#pl-save")), await p.textContent("#pl-save"));
  ok((await p.inputValue("#who-slt1")) === ids.Ana, "Ana on SLT 1 (her first training)");
  ok((await p.inputValue("#who-slo")) === ids.Eli, "Eli runs the laundry");
  ok((await plan()).rev === 0);
  ok(await p.isVisible("#pl-verdict .v-k"), "verdict numbers");
  ok(await p.locator("#pl-gantt .gb").count() > 5, "timeline bars");
  ok(await p.isVisible('#pl-waves .wv:has-text("Quitman run")'));
  await p.screenshot({ path: join(SHOTS, "20-plan-suggested.png"), fullPage: true });
});
await t("Keep this crew saves it", async () => {
  await p.click("#pl-keep");
  await saved(p);
  const P = await plan(); ok(P.rev === 1 && P.crew.slt1.personId === ids.Ana && P.crew.slt1.source === "suggested", JSON.stringify(P.crew.slt1));
});
await t("moving a person to another station empties the old one and saves on its own", async () => {
  const fromCode = await p.evaluate(id => [...document.querySelectorAll("#pl-crew select")].find(s => s.value === id)?.id.slice(4), ids.Gus);
  await p.selectOption("#who-dct3", ids.Gus);
  await saved(p);
  const P = await plan();
  ok(P.crew.dct3.personId === ids.Gus, "Gus on DCT 3");
  if (fromCode && fromCode !== "dct3") ok(!P.crew[fromCode], `${fromCode} emptied`);
  ok(P.rev === 2, "rev " + P.rev);
});
await t("changing hours and a hard stop updates the clock-out and saves", async () => {
  const before = await p.textContent("#out-dct3");
  await p.fill("#hrs-dct3", "5");
  await p.press("#hrs-dct3", "Tab");
  await p.fill("#stop-dct3", "11:30"); await p.press("#stop-dct3", "Tab");
  await saved(p);
  const P = await plan(); ok(P.crew.dct3.hours === 5 && P.crew.dct3.stop === "11:30", JSON.stringify(P.crew.dct3));
  ok((await p.textContent("#out-dct3")) !== before, "clock-out changed");
});
await t("Undo puts the previous hard stop back", async () => {
  await p.click("#pl-undo"); await saved(p);
  ok((await plan()).crew.dct3.stop === "", "stop removed");
});
await t("typing a piece count over SMRT's keeps it for the day and shows it", async () => {
  await p.click('#pl-tiles [data-cat="comf"]');
  await p.fill("dialog input[name=n]", "12");
  await p.click('dialog button[type="submit"]');
  await p.waitForSelector('#pl-tiles .tile.typed:has-text("Comforters")');
  await saved(p);
  ok((await plan()).overrides.comf === 12);
  await p.click('#pl-tiles [data-cat="comf"]'); await p.click("dialog [data-reset]"); await saved(p);
  ok((await plan()).overrides.comf === undefined, "back to SMRT's number");
});
await t("checks show, and a one-click fix changes the plan", async () => {
  ok(await p.locator("#pl-checks .chk").count() > 0);
  // start the laundry late so a shuttle is late, then use the fix
  await p.fill("#start-slt1", "10:30"); await p.press("#start-slt1", "Tab");
  await p.fill("#start-slt2", "10:30"); await p.press("#start-slt2", "Tab");
  await saved(p);
  await p.screenshot({ path: join(SHOTS, "21-plan-late.png"), fullPage: true });
  const fix = p.locator("#pl-checks [data-fix]").first();
  ok(await fix.count(), "a fix button");
  const rev = (await plan()).rev;
  await fix.click(); await saved(p);
  ok((await plan()).rev > rev, "fix saved");
});
await t("dragging a timeline bar moves that person's clock-in", async () => {
  const bar = p.locator('#pl-gantt .gb[data-code="slo"]').first();
  await bar.scrollIntoViewIfNeeded();
  const box = await bar.boundingBox();
  const before = (await plan()).crew.slo.start;
  await p.mouse.move(box.x + 10, box.y + box.height / 2); await p.mouse.down();
  await p.mouse.move(box.x + 70, box.y + box.height / 2, { steps: 6 }); await p.mouse.up();
  await saved(p);
  const after = (await plan()).crew.slo.start;
  ok(after > before, `${before} -> ${after}`);
});
await t("a call-out takes the person off and the check offers cover", async () => {
  await p.click('#pl-crew [data-out="dct1"]');
  await p.fill("dialog input[name=note]", "sick");
  await p.click('dialog button[type="submit"]');
  await p.waitForSelector("#pl-callouts .chip.off");
  await saved(p);
  const P = await plan();
  ok(!P.crew.dct1 && P.callouts.length === 1 && P.callouts[0].note === "sick", JSON.stringify(P.callouts));
  ok(await p.isVisible('#pl-checks .chk:has-text("called out")'), "call-out check");
});
await t("publish: dialog, then the button shows published and the floor can read it", async () => {
  await p.click("#pl-pub");
  await p.waitForSelector("dialog .pub-sum");
  await p.screenshot({ path: join(SHOTS, "22-publish.png") });
  await p.click('dialog button[type="submit"]');
  await p.waitForSelector("#pl-pub.published");
  const f = await apiAs("vi@example.com", "GET", `/floor/${DAY}`);
  ok(f.body.published.snapshot.input.crew.slt1.emp === ids.Ana, "snapshot crew");
  ok(!JSON.stringify(f.body.published.snapshot).includes("payAvg\":13"), "no pay in the snapshot");
  // a change makes it "Publish changes"
  await p.fill("#hrs-asm1", "6"); await p.press("#hrs-asm1", "Tab"); await saved(p);
  ok(/Publish changes/.test(await p.textContent("#pl-pub")));
});
await t("another PC saved in between: this one gets their plan and a message", async () => {
  const P = await plan();
  const crew = Object.fromEntries(Object.entries(P.crew).map(([k, c]) => [k, { personId: c.personId, start: c.start, hours: c.hours, stop: c.stop }]));
  crew.asm1.hours = 4;
  ok((await apiAs("mo@example.com", "PUT", `/plan/${DAY}`, { rev: P.rev, crew, overrides: {} })).status === 200);
  await p.fill("#hrs-asm1", "7"); await p.press("#hrs-asm1", "Tab");
  await p.waitForSelector(".toast:has-text('changed this plan')");
  await p.waitForFunction(() => document.getElementById("hrs-asm1").value === "4");
  ok((await plan()).crew.asm1.hours === 4, "their save stands");
});
await t("Labor and revenue card is there for the Owner", async () => {
  ok(await p.isVisible("#pl-money .m-big"));
});
await t("a Viewer sees the plan but can't change it", async () => {
  who = "vi@example.com";
  const q = await page();
  await q.goto(url + "/#/plan"); await q.waitForSelector("#pl-crew .cr-row");
  ok(await q.isDisabled("#who-slt1")); ok(!(await q.$("#pl-pub"))); ok(!(await q.$("#pl-money")));
  ok(!(await q.$("#pl-tiles button")), "tiles aren't buttons");
  ok(!(await q.$("[data-fix]")), "no fix buttons");
  who = NEAL;
});
await t("phone: crew rows stack, the timeline scrolls inside its card", async () => {
  const q = await page({ width: 390, height: 844 });
  await q.goto(url + "/#/plan"); await q.waitForSelector("#pl-crew .cr-row");
  ok(!(await q.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), "no sideways page scroll");
  await q.screenshot({ path: join(SHOTS, "23-plan-phone.png"), fullPage: true });
});
await t("light theme", async () => {
  const q = await page({ width: 1440, height: 900 }, "light");
  await q.goto(url + "/#/plan"); await q.waitForSelector("#pl-gantt .gb");
  await q.screenshot({ path: join(SHOTS, "24-plan-light.png"), fullPage: true });
});
await t("Floor: shows the published plan, people and deadlines; switches to Spanish", async () => {
  who = "vi@example.com";
  const q = await page({ width: 1920, height: 1080 });
  await q.goto(url + "/#/floor"); await q.waitForSelector("#fl-root .f-band");
  ok(await q.locator(".f-now").count() >= 4, "people listed");
  ok(await q.isVisible('.f-wave:has-text("Quitman run")'), "deadline listed");
  await q.screenshot({ path: join(SHOTS, "25-floor.png") });
  await q.click("#fl-lang"); await q.waitForSelector('#fl-root[lang="es"]');
  ok(/Entregas|Ahora/.test(await q.textContent("#fl-root")));
  await q.screenshot({ path: join(SHOTS, "26-floor-es.png") });
  await q.reload(); await q.waitForSelector('#fl-root[lang="es"]'); // remembered on this screen
  await q.goto(url + "/#/floor?tv"); await q.waitForSelector("#fl-root");
  ok(!(await q.isVisible("header.top")), "tv mode hides the header");
  await q.goto(url + "/#/team"); await q.waitForSelector(".team-list");
  ok(await q.isVisible("header.top"), "header back after leaving");
  who = NEAL;
});
await t("Floor on a phone: no sideways scroll", async () => {
  const q = await page({ width: 390, height: 844 });
  await q.goto(url + "/#/floor"); await q.waitForSelector("#fl-root .f-band");
  ok(!(await q.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  await q.screenshot({ path: join(SHOTS, "27-floor-phone.png"), fullPage: true });
});
await t("leaving the Plan stops its listeners (no errors on other screens)", async () => {
  await p.goto(url + "/#/plan"); await p.waitForSelector("#pl-crew .cr-row");
  await p.click('#nav a[data-view="team"]'); await p.waitForSelector(".team-list");
  await p.mouse.move(300, 300); await p.mouse.down(); await p.mouse.up();
  await p.keyboard.press("Control+z");
});
await t("no page errors", async () => { ok(!errors.length, errors.join("\n")); });

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
