// Tests for the station tablets (SLB 1 / SLB 2 counts). Run: node workers/planner/test/tally.mjs
import { freshDb, fakeAccess, makeEnv } from "./harness.mjs";
import { handle } from "../src/index.js";
import { segmentsOf, occupantAt, pace, pressStart, judge, cleanupPhotos } from "../src/tally.js";
import { localNow } from "../src/pieces.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };
const near = (a, b, m = "") => { if (Math.abs(a - b) > 0.05) throw new Error(`${m} expected ~${b} got ${a}`); };

// ---------------------------------------------------------------- pure logic
await t("colors: green within 10%, yellow 10-20% under, red past 20% under; pulse past 10% over", async () => {
  eq(judge(20, 20).color, "green"); eq(judge(18.2, 20).color, "green"); eq(judge(17.9, 20).color, "yellow");
  eq(judge(16.1, 20).color, "yellow"); eq(judge(15.9, 20).color, "red"); eq(judge(null, 20).color, "none");
  eq(judge(22, 20).boost, 0); ok(judge(23, 20).boost > 0 && judge(23, 20).boost < 1); eq(judge(40, 20).boost, 1);
});
await t("segments follow moves; who's on a station now, next, or last", async () => {
  const S = segmentsOf({ slb1: { personId: "A", start: "07:00", moves: [{ at: "10:00", to: "slt1" }] }, slt1: { personId: "B", start: "07:00", moves: [{ at: "10:00", to: "slb1" }] }, slb2: { personId: "C", start: "08:00" } });
  eq(occupantAt(S, "slb1", 9 * 60).personId, "A"); eq(occupantAt(S, "slb1", 10 * 60).personId, "B");
  eq(occupantAt(S, "slb2", 6 * 60), { personId: "C", status: "upcoming", from: 480 });
  eq(occupantAt(S, "slb3", 600), null);
});
await t("press start: first person planned on it + the delay; a hand-set start wins; else the first count", async () => {
  // Maria covers SLB 2 from 5:40 (a move at her clock-in), Diana takes it at 7:30
  const S = segmentsOf({ slt2: { personId: "M", start: "05:40", moves: [{ at: "05:40", to: "slb2" }, { at: "07:30", to: "slt2" }] }, slb2: { personId: "D", start: "07:30" } });
  eq(pressStart(S, "slb2", null, 10), { min: 350, source: "plan", personId: "M", clockIn: 340, delay: 10 });
  eq(pressStart(S, "slb2", { minute: 365, at: "x" }, 10).min, 365);
  eq(pressStart(S, "slb2", { minute: null, at: "x" }, 10).source, "plan", "set back to the plan");
  eq(pressStart(S, "slb1", null, 10, [{ minute: 500, count: 3 }]), { min: 500, source: "first" });
  eq(pressStart(S, "slb1", null, 10), { min: null, source: "none" });
});
await t("pace = all pairs ÷ hours from the start to the last count (no breaks, no people)", async () => {
  const E = [{ minute: 480, count: 20 }, { minute: 540, count: 18 }, { minute: 570, count: 12 }]; // 50 pairs by 9:30
  const r = pace(E, 420, 20);                // started 7:00 → 2.5 h
  eq([r.count, r.minutes, r.lastMin], [50, 150, 570]); near(r.perHour, 20); eq(r.color, "green");
  eq(pace(E, null, 20).perHour, null, "no start: no pace");
  eq(pace([{ minute: 425, count: 4 }], 420, 20).perHour, null, "under 10 minutes: too soon to say");
  eq(pace([], 420, 20).count, 0);
});
await t("goals color the station", async () => {
  const E = [{ minute: 480, count: 25 }]; // 25 in an hour
  eq(pace(E, 420, 20).color, "green"); ok(pace(E, 420, 20).boost > 0, "25/hr is 25% over 20 → pulses");
  eq(pace(E, 420, 30).color, "yellow"); eq(pace(E, 420, 32).color, "red");
});

// ---------------------------------------------------------------- the API
const A = await fakeAccess();
const NEAL = "neal@towncountryclean.com";
const L = localNow("America/Chicago"), NOW = +L.hm.slice(0, 2) * 60 + +L.hm.slice(3);
const hm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
function app() {
  const { db, sqlite } = freshDb();
  const env = makeEnv(db, { TIMEZONE: "America/Chicago" });
  const call = async (method, path, { as = NEAL, body } = {}) => {
    const headers = new Headers({ "cf-access-jwt-assertion": await A.token({ email: as }) });
    if (body) headers.set("content-type", "application/json");
    const r = await handle(new Request(`https://prodplanner.netexcleaners.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
    return { status: r.status, body: (r.headers.get("content-type") || "").includes("json") ? await r.json() : await r.arrayBuffer(), headers: r.headers };
  };
  // the tablet: no Access token, only its cookie
  let jar = "";
  const tab = async (method, path, { body, raw, type } = {}) => {
    const headers = new Headers(); if (jar) headers.set("cookie", jar);
    if (body) headers.set("content-type", "application/json"); if (raw) headers.set("content-type", type || "image/jpeg");
    const r = await handle(new Request(`https://prodplanner.netexcleaners.com/station/api${path}`, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) }), env, { fetchImpl: A.fetchImpl });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/netex_station=([^;]*)/); jar = m && m[1] ? `netex_station=${m[1]}` : ""; }
    return { status: r.status, body: await r.json(), setCookie: sc };
  };
  return { db, sqlite, env, call, tab, jar: () => jar, setJar: v => { jar = v; } };
}
async function setup() {
  const a = app();
  const carnell = (await a.call("POST", "/api/team", { body: { firstName: "Carnell", lastName: "Jones" } })).body.id;
  const diana = (await a.call("POST", "/api/team", { body: { firstName: "Diana", lastName: "Vergara" } })).body.id;
  const maria = (await a.call("POST", "/api/team", { body: { firstName: "Maria", lastName: "Lopez" } })).body.id;
  await a.call("POST", "/api/users", { body: { name: "Mo", email: "mo@example.com", role: "manager" } });
  await a.call("POST", "/api/users", { body: { name: "Vi", email: "vi@example.com", role: "viewer" } });
  return { ...a, carnell, diana, maria };
}
const clockIn = (sqlite, pid, at, out = null) => sqlite.prepare("INSERT INTO labor_clock_today(id, person_id, clock_in, clock_out) VALUES(?,?,?,?)")
  .run(Math.random().toString(36).slice(2), pid, `${L.day}T${hm(at)}:00`, out == null ? null : `${L.day}T${hm(out)}:00`);
async function pairNew(a, station = "slb1") {
  const c = await a.call("POST", "/api/station-devices", { body: { station, name: `${station} tablet` } });
  eq(c.status, 201, JSON.stringify(c.body));
  const p = await a.tab("POST", "/pair", { body: { code: c.body.code } });
  eq(p.status, 200, JSON.stringify(p.body));
  return c.body.id;
}

if (NOW < 200) console.log("  (skipping the live-day tests: they need it to be after 3:20 AM Central)");
else {
  await t("a tablet pairs with a code from Settings; no code, wrong code and old cookies get nothing", async () => {
    const a = await setup();
    eq((await a.tab("GET", "/state")).body, { paired: false });
    eq((await a.tab("POST", "/count", { body: { count: 5 } })).status, 401);
    eq((await a.call("POST", "/api/station-devices", { as: "mo@example.com", body: { station: "slb1" } })).status, 403, "Admins only");
    const c = await a.call("POST", "/api/station-devices", { body: { station: "slb1" } });
    ok(/^\d{6}$/.test(c.body.code));
    const wrong = c.body.code === "000000" ? "111111" : "000000";
    eq((await a.tab("POST", "/pair", { body: { code: wrong } })).status, 403);
    const p = await a.tab("POST", "/pair", { body: { code: c.body.code } });
    eq(p.status, 200); ok(/HttpOnly/.test(p.setCookie) && /Path=\/station/.test(p.setCookie) && /SameSite=Strict/.test(p.setCookie));
    eq(p.body.station.code, "slb1");
    eq((await a.tab("POST", "/pair", { body: { code: c.body.code } })).status, 403, "a code works once");
    const list = (await a.call("GET", "/api/station-devices")).body.devices;
    eq([list.length, list[0].paired, list[0].codeUntil], [1, true, null]);
    // Access isn't trusted on /station: an Access sign-in without the tablet cookie still gets nothing
    a.setJar(""); eq((await a.tab("GET", "/state")).body.paired, false);
  });
  await t("ten wrong codes cancel every waiting code", async () => {
    const a = await setup();
    const c = await a.call("POST", "/api/station-devices", { body: { station: "slb2" } });
    for (let i = 0; i < 10; i++) await a.tab("POST", "/pair", { body: { code: String(100000 + i) === c.body.code ? "999999" : String(100000 + i) } });
    eq((await a.tab("POST", "/pair", { body: { code: c.body.code } })).status, 403);
    const n = await a.call("POST", `/api/station-devices/${c.body.id}/code`);
    eq((await a.tab("POST", "/pair", { body: { code: n.body.code } })).status, 200, "a new code works");
  });
  await t("the station's pace starts 10 minutes after the first planned clock-in; punches don't matter", async () => {
    const a = await setup();
    await a.call("PUT", `/api/plan/${L.day}`, { body: { rev: 0, crew: { slb1: { personId: a.carnell, start: hm(NOW - 130), hours: 8 }, slb2: { personId: a.diana, start: hm(NOW - 150), hours: 8 } } } });
    await pairNew(a);
    let s = (await a.tab("GET", "/state")).body;
    eq([s.start.min, s.start.source, s.start.name, s.planSource], [NOW - 120, "plan", "Carnell Jones", "saved"]);
    const r = await a.tab("POST", "/count", { body: { count: 40 } });
    eq(r.status, 201);
    eq([r.body.state.totals.count, r.body.state.totals.minutes, r.body.state.entries[0].undo], [40, 120, true]);
    near(r.body.state.totals.perHour, 20, "40 pairs over the 2 hours since the press started");
    clockIn(a.sqlite, a.carnell, NOW - 60, NOW - 30); // a break on the time clock changes nothing
    s = (await a.tab("GET", "/state")).body; near(s.totals.perHour, 20);
    const u = await a.tab("DELETE", `/count/${r.body.id}`);
    eq([u.status, u.body.totals.count], [200, 0]);
  });
  await t("no one planned on the press: counts are taken; the first count is the start", async () => {
    const a = await setup();
    await pairNew(a, "slb2");
    const r = await a.tab("POST", "/count", { body: { count: 9 } });
    eq([r.status, r.body.state.totals.count, r.body.state.start.source], [201, 9, "first"]);
  });
  await t("a plan change of who's on the press doesn't split the pace; all counts are the station's", async () => {
    const a = await setup();
    await a.call("PUT", `/api/plan/${L.day}`, { body: { rev: 0, crew: { slb1: { personId: a.carnell, start: hm(NOW - 190), hours: 8, moves: [{ at: hm(NOW - 60), to: "slt1" }] },
      slt1: { personId: a.maria, start: hm(NOW - 180), hours: 8, moves: [{ at: hm(NOW - 60), to: "slb1" }] } } } });
    await pairNew(a);
    eq((await a.call("POST", "/api/tally", { as: "mo@example.com", body: { day: L.day, station: "slb1", count: 38, at: hm(NOW - 61) } })).status, 201);
    const s = (await a.tab("POST", "/count", { body: { count: 22 } })).body.state;
    eq([s.totals.count, s.totals.minutes, s.start.name], [60, 180, "Carnell Jones"]); near(s.totals.perHour, 20);
    eq(s.person, undefined, "no person on the tablet any more");
    const d = (await a.call("GET", `/api/tally/${L.day}`, { as: "vi@example.com" })).body;
    eq([d.total, d.stations.find(x => x.code === "slb1").people], [60, undefined]);
    eq((await a.call("POST", "/api/tally", { as: "vi@example.com", body: { day: L.day, station: "slb1", count: 3, at: "08:00" } })).status, 403, "viewers can't add");
  });
  await t("the start can be set on the tablet with a photo of who did it; back to the plan; logged in Changes today", async () => {
    const a = await setup();
    await a.call("PUT", `/api/plan/${L.day}`, { body: { rev: 0, crew: { slb1: { personId: a.carnell, start: hm(NOW - 130), hours: 8 } } } });
    await pairNew(a);
    await a.tab("POST", "/count", { body: { count: 30 } });
    eq((await a.tab("POST", "/start", { body: { at: "25:00" } })).status, 400);
    if (NOW < 1439) eq((await a.tab("POST", "/start", { body: { at: hm(NOW + 1) } })).status, 400, "not later than now");
    const r = await a.tab("POST", "/start", { body: { at: hm(NOW - 90) } });
    eq([r.status, r.body.state.start.source, r.body.state.start.min, r.body.state.totals.minutes], [201, "manual", NOW - 90, 90]);
    near(r.body.state.totals.perHour, 20);
    const jpeg = new Uint8Array(400); jpeg[0] = 0xff; jpeg[1] = 0xd8;
    eq((await a.tab("POST", `/start/${r.body.id}/photo`, { raw: jpeg })).status, 200);
    const d = (await a.call("GET", `/api/tally/${L.day}`)).body;
    eq([d.startChanges.length, d.startChanges[0].hasPhoto, d.startChanges[0].minute], [1, true, NOW - 90]);
    eq((await a.call("GET", `/api/tally/start-photo/${r.body.id}`, { as: "mo@example.com" })).status, 403, "Admins only");
    eq((await a.call("GET", `/api/tally/start-photo/${r.body.id}`)).status, 200);
    const back = await a.tab("POST", "/start", { body: { at: null } });
    eq([back.body.state.start.source, back.body.state.start.min], ["plan", NOW - 120]);
    const ev = a.sqlite.prepare("SELECT text FROM plan_events WHERE key LIKE 'tally-start:%' ORDER BY at").all().map(x => x.text);
    eq(ev.length, 2); ok(/set to/.test(ev[0]) && /back to the plan/.test(ev[1]));
    a.sqlite.prepare("UPDATE plan_station_starts SET day='2020-01-01'").run();
    eq((await cleanupPhotos(a.env)).deleted, 1);
  });
  await t("photos: stored with the count, only Admins see them, removed with the count and after Settings' days", async () => {
    const a = await setup();
    await a.call("PUT", `/api/plan/${L.day}`, { body: { rev: 0, crew: { slb1: { personId: a.carnell, start: hm(NOW - 60), hours: 8 } } } });
    clockIn(a.sqlite, a.carnell, NOW - 60);
    await pairNew(a);
    const r = await a.tab("POST", "/count", { body: { count: 15 } });
    const jpeg = new Uint8Array(400); jpeg[0] = 0xff; jpeg[1] = 0xd8;
    eq((await a.tab("POST", `/count/${r.body.id}/photo`, { raw: new Uint8Array(400) })).status, 400, "not a JPEG");
    eq((await a.tab("POST", `/count/${r.body.id}/photo`, { raw: jpeg })).status, 200);
    eq((await a.call("GET", `/api/tally/photo/${r.body.id}`, { as: "mo@example.com" })).status, 403);
    const ph = await a.call("GET", `/api/tally/photo/${r.body.id}`);
    eq([ph.status, ph.headers.get("content-type"), ph.body.byteLength], [200, "image/jpeg", 400]);
    ok((await a.call("GET", `/api/tally/${L.day}`)).body.entries[0].hasPhoto);
    a.sqlite.prepare("UPDATE plan_station_photos SET day='2020-01-01'").run();
    eq((await cleanupPhotos(a.env)).deleted, 1);
    // a manager removes a count
    const r2 = await a.tab("POST", "/count", { body: { count: 5 } });
    eq((await a.call("DELETE", `/api/tally/${r2.body.id}`, { as: "mo@example.com" })).status, 200);
    eq((await a.call("GET", `/api/tally/${L.day}`)).body.total, 15);
  });
  await t("the tablet reports camera and full-screen status to Settings", async () => {
    const a = await setup();
    await pairNew(a);
    await a.tab("GET", "/state?mode=fullscreen&cam=on&wake=on");
    let d = (await a.call("GET", "/api/station-devices")).body.devices[0];
    eq(d.client, { cam: "on", mode: "fullscreen", wake: "on" });
    await a.tab("GET", "/state?mode=browser&cam=denied&wake=off&mode=bogus");
    d = (await a.call("GET", "/api/station-devices")).body.devices[0];
    eq([d.client.mode, d.client.cam], ["browser", "denied"]);
  });
  await t("removing a tablet in Settings cuts it off", async () => {
    const a = await setup();
    const id = await pairNew(a);
    eq((await a.tab("GET", "/state")).body.paired, true);
    eq((await a.call("DELETE", `/api/station-devices/${id}`)).status, 200);
    eq((await a.tab("GET", "/state")).body.paired, false);
  });
  await t("Review carries the counts; settings have the station goal and the start delay", async () => {
    const a = await setup();
    await a.call("PUT", `/api/plan/${L.day}`, { body: { rev: 0, crew: { slb1: { personId: a.carnell, start: hm(NOW - 120), hours: 8 } } } });
    await a.call("POST", "/api/tally", { body: { day: L.day, station: "slb1", count: 30, at: hm(NOW - 10) } });
    const rv = (await a.call("GET", `/api/review/${L.day}`)).body;
    eq([rv.tally.total, rv.tally.stations.length, rv.tally.goal], [30, 2, 20]);
    eq((await a.call("PATCH", `/api/team/${a.carnell}`, { as: "mo@example.com", body: { slbRate: 300 } })).status, 400);
    eq((await a.call("PATCH", `/api/team/${a.carnell}`, { as: "mo@example.com", body: { slbRate: 22 } })).status, 200);
    eq((await a.call("GET", "/api/team")).body.people.find(p => p.id === a.carnell).slbRate, 22);
    eq((await a.call("PUT", "/api/settings/tally", { body: { goal: 21, startDelay: 5, photos: false } })).body.tally, { goal: 21, startDelay: 5, photos: false, keepDays: 30 });
    eq((await a.call("GET", `/api/review/${L.day}`)).body.tally.stations[0].start.min, NOW - 115, "Carnell in 2 h ago + 5 min");
  });
  await t("the tablet page is served without a sign-in, with the camera allowed only there", async () => {
    const a = app();
    const r = await handle(new Request("https://prodplanner.netexcleaners.com/station/"), a.env, { fetchImpl: A.fetchImpl });
    eq(r.status, 200);
    const main = await handle(new Request("https://prodplanner.netexcleaners.com/"), a.env, { fetchImpl: A.fetchImpl });
    eq(main.status, 401, "the planner itself still needs Access");
    const { default: worker } = await import("../src/index.js");
    const h = await worker.fetch(new Request("https://prodplanner.netexcleaners.com/station/"), a.env);
    ok(/camera=\(self\)/.test(h.headers.get("permissions-policy")));
    const h2 = await worker.fetch(new Request("https://prodplanner.netexcleaners.com/api/me"), a.env);
    ok(/camera=\(\)/.test(h2.headers.get("permissions-policy")));
    const x = await handle(new Request("https://prodplanner.netexcleaners.com/station/api/count", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }), a.env);
    eq(x.status, 403);
  });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
