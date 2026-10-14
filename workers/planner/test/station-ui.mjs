// Browser test: the station tablet page in headless Chromium (fake camera), served through the Worker code.
// Run: node workers/planner/test/station-ui.mjs   (screenshots go to $SHOTS or ./test/shots)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, fakeAccess, makeEnv, serve } from "./harness.mjs";
import { handle } from "../src/index.js";
import { localNow } from "../src/pieces.js";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright")); }
const SHOTS = process.env.SHOTS || join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 2).join("\n       ")); } };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const L = localNow("America/Chicago"), NOW = +L.hm.slice(0, 2) * 60 + +L.hm.slice(3);
if (NOW < 200) { console.log("  (skipped: needs to be after 3:20 AM Central)"); process.exit(0); }
const hm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const A = await fakeAccess();
const { db, sqlite } = freshDb();
const env = makeEnv(db, { TIMEZONE: "America/Chicago" });
const api = async (method, path, body) => {
  const h = new Headers({ "cf-access-jwt-assertion": await A.token({ email: "neal@towncountryclean.com" }) }); if (body) h.set("content-type", "application/json");
  const r = await handle(new Request(`https://x.test/api${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
  return r.json();
};
const carnell = (await api("POST", "/team", { firstName: "Carnell", lastName: "Jones" })).id;
const maria = (await api("POST", "/team", { firstName: "Maria", lastName: "Lopez" })).id;
const diana = (await api("POST", "/team", { firstName: "Diana", lastName: "Vergara" })).id;
await api("PUT", `/plan/${L.day}`, { rev: 0, crew: {
  slb1: { personId: carnell, start: hm(NOW - 180), hours: 8, moves: [{ at: hm(NOW - 60), to: "slt1" }] },
  slt1: { personId: maria, start: hm(NOW - 180), hours: 8, moves: [{ at: hm(NOW - 60), to: "slb1" }] },
  slb2: { personId: diana, start: hm(NOW - 120), hours: 8 } } });
const clockIn = (pid, at) => sqlite.prepare("INSERT INTO labor_clock_today(id, person_id, clock_in) VALUES(?,?,?)").run(Math.random().toString(36).slice(2), pid, `${L.day}T${hm(at)}:00`);
const add = (station, count, at) => api("POST", "/tally", { day: L.day, station, count, at: hm(at) });

if (process.env.DEBUG) console.log("setup done");
const { server, url } = await serve(env, { fetchImpl: A.fetchImpl, token: A.token, who: () => "neal@towncountryclean.com" }); // tablets ignore Access; the office pages need it
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const errors = [];
async function tablet(viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport, colorScheme: "dark", permissions: ["camera"] });
  const p = await ctx.newPage();
  p.on("pageerror", e => errors.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push("console: " + m.text()); });
  return p;
}
const tap = async (p, keys) => { for (const k of String(keys)) await p.click(`[data-k="${k}"]`); };

if (process.env.DEBUG) console.log("browser up", url);
const p1 = await tablet();
if (process.env.DEBUG) console.log("tablet up");
await t("pairing: the code from Settings pairs the tablet as SLB 1", async () => {
  await p1.goto(url + "/station/");
  if (process.env.DEBUG) console.log(await p1.evaluate(() => document.body.innerHTML.slice(0, 300)));
  await p1.waitForSelector(".pair");
  await p1.screenshot({ path: join(SHOTS, "station-1-pair.png") });
  const c = await api("POST", "/station-devices", { station: "slb1", name: "SLB 1 tablet" });
  for (const d of c.code) await p1.click(`[data-p="${d}"]`);
  await p1.click('[data-p="go"]');
  await p1.waitForSelector(".st-chip");
  ok((await p1.textContent(".st-chip")) === "SLB 1");
  ok((await p1.textContent(".who b")) === "Maria Lopez", "the plan moved Maria onto SLB 1 an hour ago");
});
await t("installable as a full-screen app (manifest + service worker)", async () => {
  const m = await p1.evaluate(async () => { const r = await fetch("/station/manifest.webmanifest"); return r.ok ? r.json() : null; });
  ok(m && m.display === "fullscreen" && m.start_url === "/station/" && m.icons.length === 2, JSON.stringify(m));
  ok(await p1.evaluate(async () => !!(await navigator.serviceWorker.getRegistration("/station/"))), "service worker registered");
});
await t("locked until clocked in; the camera turns on", async () => {
  await p1.waitForSelector(".lock");
  await p1.waitForSelector("#cam.on", { timeout: 5000 });
  await p1.screenshot({ path: join(SHOTS, "station-2-locked.png") });
  clockIn(carnell, NOW - 182); clockIn(maria, NOW - 178);
  await p1.reload(); await p1.waitForSelector(".st-chip");
  ok(!(await p1.$(".lock")), "opens once Maria is clocked in");
});
await t("a count saves with a photo; the person's own line shows next to the station's", async () => {
  await add("slb1", 41, NOW - 61); // Carnell's batch before the move
  await tap(p1, "21"); await p1.click('[data-k="save"]');
  await p1.waitForFunction(() => document.querySelector(".big")?.textContent === "62");
  ok(await p1.$(".mine"), "Maria's own line");
  await p1.waitForTimeout(800);
  const d = await api("GET", `/tally/${L.day}`);
  ok(d.entries.some(e => e.count === 21 && e.hasPhoto && e.name === "Maria Lopez"), "photo stored, credited to Maria");
  await p1.screenshot({ path: join(SHOTS, "station-3-counted.png") });
});
await t("a big batch asks once more; undo takes it back", async () => {
  await tap(p1, "48"); await p1.click('[data-k="save"]');
  ok(/Yes, 48/.test(await p1.textContent('[data-k="save"]')));
  await p1.click('[data-k="save"]');
  await p1.waitForFunction(() => document.querySelector(".big")?.textContent === "110");
  await p1.screenshot({ path: join(SHOTS, "station-4-pulse.png") });
  ok(await p1.$(".tile.boost"), "well over the goal: pulsing");
  await p1.click(".undo");
  await p1.waitForFunction(() => document.querySelector(".big")?.textContent === "62");
});
const p2 = await tablet({ width: 800, height: 1280 });
await t("SLB 2 upright: red when well under the goal", async () => {
  const c = await api("POST", "/station-devices", { station: "slb2" });
  await p2.goto(url + "/station/"); await p2.waitForSelector(".pair");
  for (const d of c.code) await p2.click(`[data-p="${d}"]`);
  await p2.click('[data-p="go"]'); await p2.waitForSelector(".st-chip");
  clockIn(diana, NOW - 120);
  await p2.reload(); await p2.waitForSelector(".st-chip");
  await tap(p2, "25"); await p2.click('[data-k="save"]');
  await p2.waitForSelector(".tile.red");
  await p2.screenshot({ path: join(SHOTS, "station-5-portrait-red.png") });
});
// ---------------------------------------------------------------- the office side
const pc = await tablet({ width: 1360, height: 900 });
await t("Plan shows SLB 1 and SLB 2 with their pace", async () => {
  await pc.goto(url + "/#/plan"); await pc.waitForSelector("#pl-presses .pr-card", { timeout: 15000 });
  const txt = await pc.textContent("#pl-presses");
  ok(/SLB 1/.test(txt) && /SLB 2/.test(txt) && /Maria/.test(txt), txt);
  ok(await pc.$("#pl-presses .pr-card.red"), "SLB 2 is red");
  await (await pc.$("#pl-presses")).screenshot({ path: join(SHOTS, "station-6-plan-tiles.png") });
});
await t("Review: pressed vs assembled, every count with its photo, add a count", async () => {
  await pc.goto(url + "/#/review"); await pc.waitForSelector("#rv-tally");
  ok(/62/.test(await pc.textContent("#rv-tally")) || /87/.test(await pc.textContent("#rv-tally")));
  await pc.waitForSelector("#rv-tally .tc-ph img");
  await pc.fill("#tc-add [name=count]", "7"); await pc.fill("#tc-add [name=at]", hm(NOW - 30));
  await pc.click("#tc-add button");
  await pc.waitForFunction(() => /94/.test(document.querySelector("#rv-tally .rv-next")?.textContent || ""));
  await (await pc.$("#rv-tally")).screenshot({ path: join(SHOTS, "station-7-review.png") });
});
await t("Settings lists the tablets; Team takes a person's SLB goal", async () => {
  await pc.goto(url + "/#/settings"); await pc.waitForSelector("#tabList .tab-row");
  ok((await pc.$$("#tabList .tab-row")).length === 2);
  await (await pc.$("#sec-tally")).screenshot({ path: join(SHOTS, "station-8-settings.png") });
  sqlite.prepare("INSERT INTO plan_person_trainings(person_id, training_id, priority, depth) VALUES(?, 'slb', 1, 1)").run(carnell);
  await pc.goto(url + "/#/team"); await pc.waitForSelector(`[data-sched="${carnell}"]`);
  await pc.click(`[data-sched="${carnell}"]`); await pc.fill("dialog [name=slbRate]", "22");
  await pc.screenshot({ path: join(SHOTS, "station-9-team.png") });
  await pc.click("dialog [type=submit]"); await pc.waitForTimeout(500);
  ok((await api("GET", "/team")).people.find(p => p.id === carnell).slbRate === 22);
});
await t("no page errors", async () => { ok(!errors.length, errors.join("\n")); });

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
