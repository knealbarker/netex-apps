// Tests for the daily limit texts (Settings › Daily limits). Run: node workers/planner/test/limits.mjs
// Orders go in through netex-sync's own ingest code, the same path live SMRT data takes. Texts go to a fake.
import { freshDb, makeEnv } from "./harness.mjs";
import { ingestDay } from "../../sync/src/ingest.js";
import { saveGroup, allSettings, loadGroups } from "../src/settings.js";
import { checkLimits, dueAlerts, alertText, testText } from "../src/limits.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const TODAY = "2026-11-02", NEXT = "2026-11-03";        // Monday, Tuesday
const AT = new Date("2026-11-02T18:00:00Z");             // noon Central
const ts = (day, hm = "10:00") => `${day}T${hm}:00-06:00`;
const ADMIN = { id: null, role: "owner" };

function setup({ texts = [], fail: failing = () => null } = {}) {
  const { db, sqlite } = freshDb();
  const env = makeEnv(db, { TIMEZONE: "America/Chicago", TEXTS: { send: async m => { const f = failing(m); if (f) return { ok: false, error: f }; texts.push(m); return { ok: true }; } } });
  sqlite.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,finished_at,status,message) VALUES('lv','smrt','2026-11-02T17:50:00Z','2026-11-02T17:51:00Z','ok','live: test')").run();
  let seq = 0;
  const add = async (dep, n, due = NEXT) => {
    const id = `2730${String(++seq).padStart(5, "0")}`;
    const orders = [{ "ID": id, "Status": "processing", "Due date": ts(due, "12:00"), "Created": ts("2026-10-30"), "Piece Count": String(n), "Return Location": "TCC Quitman", "Agent": "TCC Quitman", "Financial department(s)": dep }];
    const items = Array.from({ length: n }, (_, i) => ({ "Sale Id": id, "Barcode": `${id}${String(i).padStart(3, "0")}`, "Item Status": "detailed", "Financial department": dep, "Item Type": "Shirt", "Created": ts("2026-10-30") }));
    await ingestDay(db, { orgId: "tcc", runId: "lv", mode: "backfill", day: "2026-10-30" }, orders, items);
  };
  return { db, env, add, texts, set: patch => saveGroup(db, env, ADMIN, "limits", patch).catch(e => { throw e; }) };
}
const LIM = { maxDcb: 0, maxDct: 0, maxSlb: 300, maxSlt: 0, alertPct: 15, phones: ["+19035550123"] };

await t("the alert level: 300 at 15% texts at 255, not 254; over the max is a second stage", () => {
  eq(dueAlerts({ slb: 254 }, LIM), []);
  eq(dueAlerts({ slb: 255 }, LIM).map(a => [a.label, a.stage, a.level]), [["SLB", "near", 255]]);
  eq(dueAlerts({ slb: 300 }, LIM)[0].stage, "near", "at the max is still near");
  eq(dueAlerts({ slb: 301 }, LIM)[0].stage, "over");
});
await t("no repeats: near once, then over once, and nothing after over", () => {
  eq(dueAlerts({ slb: 260 }, LIM, { slb: "near" }), []);
  eq(dueAlerts({ slb: 310 }, LIM, { slb: "near" })[0].stage, "over");
  eq(dueAlerts({ slb: 260 }, LIM, { slb: "over" }), []);
  eq(dueAlerts({ slb: 310 }, LIM, { slb: "over" }), []);
});
await t("0 = no limit; each department has its own max", () => {
  eq(dueAlerts({ dcb: 9999, dct: 9999, slt: 9999 }, LIM), []);
  eq(dueAlerts({ dcb: 90, dct: 10, slb: 0, slt: 90 }, { ...LIM, maxDcb: 100, maxDct: 100, maxSlt: 100 }).map(a => a.label), ["DCB", "SLT"]);
});
await t("the text says the day, the count and the max", () => {
  const m = alertText(dueAlerts({ slb: 260, slt: 500 }, { ...LIM, maxSlt: 400 }), NEXT, 15);
  ok(/Tue, 11\/3|Tue 11\/3/.test(m), m); ok(m.includes("SLB: 260 due, within 15% of the 300 max."), m); ok(m.includes("SLT: 500 due, over the 400 max."), m);
});
await t("a real day: counts tomorrow's pieces, texts at the level, and once only", async () => {
  const { env, add, texts, set } = setup();
  await set(LIM);
  await add("Laundry Bottoms", 254);
  eq((await checkLimits(env, { at: AT })).status, "nothing new");
  await add("Laundry Bottoms", 1);
  const r = await checkLimits(env, { at: AT });
  eq(r.status, "sent", JSON.stringify(r)); eq(r.day, NEXT); eq(texts.length, 1);
  eq([texts[0].app, texts[0].to, texts[0].ref], ["planner", "+19035550123", `limits:${NEXT}`]);
  ok(texts[0].body.includes("SLB: 255 due"), texts[0].body);
  eq((await checkLimits(env, { at: AT })).status, "nothing new"); eq(texts.length, 1, "no repeat");
  await add("Laundry Bottoms", 46);
  eq((await checkLimits(env, { at: AT })).status, "sent"); eq(texts.length, 2); ok(texts[1].body.includes("301 due, over the 300 max"), texts[1].body);
  eq((await checkLimits(env, { at: AT })).status, "nothing new"); eq(texts.length, 2);
});
await t("pieces due today don't count, and other departments don't count toward SLB", async () => {
  const { env, add, texts, set } = setup();
  await set(LIM);
  await add("Laundry Bottoms", 280, TODAY);
  await add("Laundry Tops", 280);
  eq((await checkLimits(env, { at: AT })).status, "nothing new"); eq(texts.length, 0);
});
await t("only work days, 7 AM to 7 PM Central; a level reached overnight waits", async () => {
  const { env, add, texts, set } = setup();
  await set(LIM); await add("Laundry Bottoms", 260);
  eq((await checkLimits(env, { at: new Date("2026-11-02T12:59:00Z") })).status, "outside hours", "6:59 AM");
  eq((await checkLimits(env, { at: new Date("2026-11-03T01:00:00Z") })).status, "outside hours", "7:00 PM");
  eq((await checkLimits(env, { at: new Date("2026-11-01T18:00:00Z") })).status, "outside hours", "Sunday");
  eq(texts.length, 0);
  eq((await checkLimits(env, { at: new Date("2026-11-02T13:00:00Z") })).status, "sent", "7:00 AM");
});
await t("off with no phone or no max; a new day starts fresh", async () => {
  const a = setup(); await a.add("Laundry Bottoms", 260);
  eq((await checkLimits(a.env, { at: AT })).status, "off");
  await a.set({ maxSlb: 300 }); eq((await checkLimits(a.env, { at: AT })).status, "off", "no phone");
  await a.set({ phones: ["(903) 555-0123"] }); eq((await checkLimits(a.env, { at: AT })).status, "sent");
  await a.add("Laundry Bottoms", 260, "2026-11-04");
  const r = await checkLimits(a.env, { at: new Date("2026-11-03T18:00:00Z") });
  eq([r.status, r.day], ["sent", "2026-11-04"], "Tuesday looks at Wednesday");
});
await t("Friday looks at Monday", async () => {
  const { env, add, set } = setup();
  await set(LIM); await add("Laundry Bottoms", 260, "2026-11-09");
  const r = await checkLimits(env, { at: new Date("2026-11-06T18:00:00Z") });
  eq([r.status, r.day], ["sent", "2026-11-09"]);
});
await t("a text that fails isn't marked: the error shows in Settings and the next check tries again", async () => {
  let refuse = true; const texts = [];
  const { env, add, set, db } = setup({ texts, fail: () => (refuse ? "That number texted STOP." : null) });
  await set(LIM); await add("Laundry Bottoms", 260);
  eq((await checkLimits(env, { at: AT })).status, "failed");
  const s = await allSettings(db, env, ADMIN); eq(s.status.limits.error, "+19035550123: That number texted STOP.");
  refuse = false;
  eq((await checkLimits(env, { at: AT })).status, "sent"); eq(texts.length, 1);
  eq((await allSettings(db, env, ADMIN)).status.limits.error, null);
});
await t("Settings: bad phone refused; only Admins see the number; the test text goes to the saved number", async () => {
  const texts = [], { env, db, set } = setup({ texts });
  let e = null; try { await set({ phones: ["(903) 555-0123", "12345"] }); } catch (x) { e = x; } ok(e && e.status === 400 && e.message.includes("12345"), "bad number refused, and named");
  await set({ phones: ["(903) 555-0123", "903-555-0124", "9035550123"] });
  eq((await loadGroups(db, "tcc")).limits.phones, ["+19035550123", "+19035550124"], "tidied, no repeats");
  eq((await allSettings(db, env, ADMIN)).groups.limits.phones, ["+19035550123", "+19035550124"]);
  eq((await allSettings(db, env, { id: null, role: "manager" })).groups.limits.phones, []);
  await testText(env); eq(texts.map(m => m.to), ["+19035550123", "+19035550124"]);
  let many = null; try { await set({ phones: Array.from({ length: 11 }, (_, i) => `90355501${10 + i}`) }); } catch (x) { many = x; } ok(many && many.status === 400, "more than 10 refused");
  let d = null; try { await saveGroup(db, env, { id: null, role: "manager" }, "limits", { maxSlb: 1 }); } catch (x) { d = x; } ok(d && d.status === 403, "Managers can't change it");
});
await t("several numbers: each gets the text; one failing retries alone, without repeating the others", async () => {
  let refuse = true; const texts = [];
  const { env, add, set, db } = setup({ texts, fail: m => (refuse && m.to === "+19035550124" ? "Twilio said no." : null) });
  await set({ ...LIM, phones: ["9035550123", "9035550124"] }); await add("Laundry Bottoms", 260);
  const r = await checkLimits(env, { at: AT });
  eq([r.status, r.error], ["sent", "+19035550124: Twilio said no."]); eq(texts.map(m => m.to), ["+19035550123"]);
  eq((await allSettings(db, env, ADMIN)).status.limits.error, "+19035550124: Twilio said no.");
  refuse = false;
  eq((await checkLimits(env, { at: AT })).status, "sent"); eq(texts.map(m => m.to), ["+19035550123", "+19035550124"], "only the one that failed");
  eq((await allSettings(db, env, ADMIN)).status.limits.error, null);
  eq((await checkLimits(env, { at: AT })).status, "nothing new"); eq(texts.length, 2);
  await add("Laundry Bottoms", 50);
  await checkLimits(env, { at: AT }); eq(texts.slice(2).map(m => m.to), ["+19035550123", "+19035550124"], "both get the over-max text");
});
await t("a number saved before this change still works, and what it was already sent still counts", async () => {
  const texts = [], { env, add, db } = setup({ texts });
  await db.prepare("INSERT INTO core_settings(org_id,app_id,key,value_json) VALUES('tcc','planner','limits',?)").bind(JSON.stringify({ maxSlb: 300, alertPct: 15, phone: "+19035550123" })).run();
  eq((await loadGroups(db, "tcc")).limits.phones, ["+19035550123"]);
  await db.prepare("INSERT INTO core_settings(org_id,app_id,key,value_json) VALUES('tcc','planner','limits_last',?)").bind(JSON.stringify({ day: NEXT, sent: { slb: "near" } })).run();
  await add("Laundry Bottoms", 260);
  eq((await checkLimits(env, { at: AT })).status, "nothing new"); eq(texts.length, 0);
  await add("Laundry Bottoms", 50);
  eq((await checkLimits(env, { at: AT })).status, "sent"); ok(texts[0].body.includes("over the 300 max"), texts[0].body);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
