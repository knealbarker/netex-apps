// Planned start vs. clocked in (Neal, Oct 13): the plan's start is only a plan; 15 minutes after it, someone with no
// punch is written down once as "not clocked in", and a late clock-in is written down too. Rippling edits and removals
// of punches show in Changes today. Run: node workers/planner/test/attendance.mjs
import { freshDb, fakeAccess, makeEnv } from "./harness.mjs";
import { handle } from "../src/index.js";
import { localNow } from "../src/pieces.js";
import { checkAttendance } from "../src/attendance.js";
import * as M from "../public/js/plan/model.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 4).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const A = await fakeAccess();
const { db, sqlite } = freshDb();
const env = makeEnv(db, { TIMEZONE: "America/Chicago" });
const call = async (method, path, { body } = {}) => {
  const headers = new Headers({ "cf-access-jwt-assertion": await A.token({ email: "neal@towncountryclean.com" }) });
  if (body) headers.set("content-type", "application/json");
  const r = await handle(new Request(`https://prodplanner.netexcleaners.com/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
  return { status: r.status, body: await r.json() };
};

const today = localNow("America/Chicago").day;
const off = new Date(`${today}T12:00:00Z`).toLocaleString("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" }).match(/GMT([+-]\d+)/)[1];
const tzs = `${off[0]}${off.slice(1).padStart(2, "0")}:00`;
const at = hm => Date.parse(`${today}T${hm}:00${tzs}`);
const iso = hm => `${today}T${hm}:00${tzs}`;

const P = {};
for (const f of ["Lupe", "Rosa", "Max", "Kim", "Dan", "Sue"]) P[f] = (await call("POST", "/team", { body: { firstName: f, lastName: "Test", usualStart: "06:00" } })).body.id;
const dep = sqlite.prepare("SELECT id FROM core_departments WHERE name='Production'").get().id;
const punch = (pid, hm) => sqlite.prepare("INSERT INTO labor_clock_today(id, person_id, department_id, clock_in) VALUES(?,?,?,?)").run(pid + hm, pid, dep, iso(hm));
const asOf = hm => sqlite.prepare(`INSERT INTO core_settings(org_id,app_id,key,value_json) VALUES('tcc','core','rippling_last',?) ON CONFLICT(org_id,app_id,key) DO UPDATE SET value_json=excluded.value_json`)
  .run(JSON.stringify({ at: new Date(at(hm)).toISOString(), rows: 1 }));
const events = () => sqlite.prepare("SELECT key, kind, text FROM plan_events WHERE day=? ORDER BY key").all(today);

await t("before a plan is saved, nothing is written", async () => {
  asOf("06:28"); const r = await checkAttendance(env, { now: at("06:30") });
  eq(r.status, "no saved plan");
});

const crew = {
  slt1: { personId: P.Lupe, start: "06:10", hours: 7.5 },     // not in
  slt2: { personId: P.Rosa, start: "04:40", hours: 7.5 },     // in at 4:48 (8 min: not late)
  slb1: { personId: P.Max, start: "10:00", hours: 4 },        // planned for later in the day
  dct1: { personId: P.Kim, start: "06:00", hours: 7.5 },      // in late at 7:00 (Team)
  dct2: { personId: P.Dan, start: "06:00", hours: 7.5 },      // in at 6:40: 40 min late
  asm1: { personId: P.Sue, start: "06:00", hours: 7.5 },      // out sick
};
const saved = await call("PUT", `/plan/${today}`, { body: { rev: 0, crew, overrides: {} } });
await call("POST", "/timeoff", { body: { personId: P.Kim, kind: "late", fromDay: today, toDay: today, at: "07:00", note: "dentist" } });
await call("POST", "/timeoff", { body: { personId: P.Sue, kind: "out", fromDay: today, toDay: today, note: "Sick" } });
punch(P.Rosa, "04:48");

await t("plan saved; the plan carries when the time clock was last heard from", async () => {
  eq(saved.status, 200, JSON.stringify(saved.body));
  const p = (await call("GET", `/plan/${today}`)).body;
  ok(p.clockAsOf, "clockAsOf missing");
});

await t("6:22: Dan (planned 6:00) written down as not clocked in; Lupe's 6:10 isn't 15 minutes past yet", async () => {
  asOf("06:21"); const r = await checkAttendance(env, { now: at("06:22") });
  eq(r.events.map(e => e.key), [`clock-noshow:${P.Dan}`], JSON.stringify(r));
});

await t("6:30 but the last time clock report is from 6:20: not judged yet (Rippling delay)", async () => {
  asOf("06:20"); const r = await checkAttendance(env, { now: at("06:30") });
  eq(r.events.length, 0, JSON.stringify(r));
});

await t("6:30 with a 6:28 report: Lupe written down as not clocked in, nobody else", async () => {
  asOf("06:28"); const r = await checkAttendance(env, { now: at("06:30") });
  eq(r.events.map(e => e.key), [`clock-noshow:${P.Lupe}`]);
  ok(/Lupe Test wasn't clocked in by 6:25 AM — planned on .+ from 6:10 AM/.test(r.events[0].text), r.events[0].text);
});

await t("the same check again doesn't write it twice", async () => {
  const r = await checkAttendance(env, { now: at("06:35") });
  eq(r.events.length, 0);
});

await t("Dan clocks in at 6:40: also written down, as 40 min late; Kim (in late at 7:00) isn't judged before 7:15", async () => {
  punch(P.Dan, "06:40"); asOf("06:48"); const r = await checkAttendance(env, { now: at("06:50") });
  eq(r.events.map(e => e.key), [`clock-late:${P.Dan}`]);
  ok(/clocked in at 6:40 AM, 40 min after the planned start \(6:00 AM/.test(r.events[0].text), r.events[0].text);
});

await t("7:20: Kim, due at her late time 7:00, isn't in — written down; Max (10:00) and Sue (out) never are", async () => {
  asOf("07:18"); const r = await checkAttendance(env, { now: at("07:20") });
  eq(r.events.map(e => e.key), [`clock-noshow:${P.Kim}`]);
  ok(/by 7:15 AM — planned on .+ from 7:00 AM/.test(r.events[0].text), r.events[0].text);
});

await t("Changes today lists the warnings", async () => {
  const ch = (await call("GET", `/changes/${today}`)).body.list.map(x => x.text);
  ok(ch.some(x => x.startsWith("Lupe Test wasn't clocked in")) && ch.some(x => x.startsWith("Dan Test clocked in at 6:40")), ch.join(" | "));
});

await t("Changes today shows a punch removed or edited in Rippling", async () => {
  const seen = new Date(at("06:30")).toISOString();
  sqlite.prepare(`INSERT INTO labor_punch_log(id, org_id, person_id, day, department_id, change, clock_in, clock_out, was_in, was_out, seen_at) VALUES
    ('pl1','tcc',?,?,?,'removed',?,NULL,NULL,NULL,?), ('pl2','tcc',?,?,?,'changed',?,NULL,?,NULL,?), ('pl3','tcc',?,?,?,'in',?,NULL,NULL,NULL,?)`)
    .run(P.Lupe, today, dep, iso("06:12"), seen, P.Rosa, today, dep, iso("04:40"), iso("04:48"), seen, P.Dan, today, dep, iso("06:40"), seen);
  const list = (await call("GET", `/changes/${today}`)).body.list.filter(x => x.tag === "clock").map(x => x.text);
  eq(list.length, 2, list.join(" | "));
  ok(list.includes("Time clock: Lupe Test's punch 6:12 AM was removed in Rippling"), list.join(" | "));
  ok(list.includes("Time clock: Rosa Test's punch changed in Rippling, 4:48 AM → 4:40 AM"), list.join(" | "));
});

await t("Plan screen model: planned start and clocked in are told apart", async () => {
  const p = (await call("GET", `/plan/${today}`)).body;
  const Pm = { isToday: true, now: 7 + 20 / 60, clock: p.clock, late: p.late };
  eq(M.attendanceOf(Pm, P.Lupe, "06:10"), { state: "missing", due: 6 + 10 / 60 });
  eq(M.attendanceOf(Pm, P.Max, "10:00").state, "upcoming");
  const d = M.attendanceOf(Pm, P.Dan, "06:00"); eq([d.state, d.lateMin], ["in", 40]);
  const r = M.attendanceOf(Pm, P.Rosa, "04:40"); eq([r.state, r.lateMin], ["in", 0]);
  eq(M.attendanceOf({ ...Pm, isToday: false }, P.Lupe, "06:10"), null, "other days: no attendance");
  eq(M.attendanceOf({ ...Pm, clock: [] }, P.Lupe, "06:10"), null, "no time clock yet: can't tell");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
