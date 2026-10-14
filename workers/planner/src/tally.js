// Station tablets (Neal, Oct 14): counts of pairs pressed at the starch bottoms presses, entered on a tablet at each press.
//  - Who gets the credit: whoever today's plan has on that station at the moment of the entry (moves included).
//  - Hours on the station come from the plan (when they were there) and the time clock (when they were clocked in), so a
//    break or a move doesn't count against anyone.
//  - Rates are worked out as of the last entry: counts come in batches, so measuring to "now" would turn the tile red
//    every time the manager is a few minutes from walking over.
//  - Colors (Neal): green within 10% of the goal, yellow 10-20% under, red more than 20% under; more than 10% over and
//    the numbers pulse, faster and bigger the further over they are.
//  - Tablets have no user account. An Admin pairs each one once with a 6-digit code from Settings; the tablet keeps a
//    long-lived secret in a cookie (only its hash is stored), so nobody signs in each morning.
import { HttpError, ulid, nowIso, audit } from "./util.js";
import { requireRole } from "./auth.js";
import { localNow } from "./pieces.js";
import { loadGroups, allSettings } from "./settings.js";
import { productionIds, listTeam } from "./team.js";
import { timeOffBetween } from "./timeoff.js";

export const COOKIE = "netex_station";
export const UNDO_MIN = 2;               // the tablet can take back its own count for this long
export const PAIR_MIN = 15;              // a pairing code works for this long
const PAIR_TRIES = 10;                   // wrong codes before every pending code is cancelled
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = hm => { const m = /(\d\d):(\d\d)/.exec(hm || ""); return m ? +m[1] * 60 + +m[2] : null; };

// ------------------------------------------------------------ small helpers
async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() { const b = new Uint8Array(32); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); }
function sixDigits() { const b = new Uint32Array(1); crypto.getRandomValues(b); return String(b[0] % 1000000).padStart(6, "0"); }
const localMin = (tz, at = new Date()) => { const l = localNow(tz, at); return { day: l.day, min: toMin(l.hm) }; };
const minOfIso = (tz, iso) => toMin(localNow(tz, new Date(iso)).hm);

export function cookieOf(req) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return m ? m[1] : null;
}
export const setCookie = token => `${COOKIE}=${token}; Path=/station; Max-Age=34560000; HttpOnly; Secure; SameSite=Strict`;
export const clearCookie = () => `${COOKIE}=; Path=/station; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/** Tablet settings: the station goal (pairs per hour), photos on/off, and how long photos are kept. */
export async function tallySettings(db, orgId) { return (await loadGroups(db, orgId)).tally; }

/** Green / yellow / red against the goal, and how hard to pulse when well over it. */
export function judge(perHour, goal) {
  if (perHour == null || !(goal > 0)) return { pct: null, color: "none", boost: 0 };
  const pct = perHour / goal;
  return { pct, color: pct < 0.8 ? "red" : pct < 0.9 ? "yellow" : "green", boost: pct > 1.1 ? Math.min(1, (pct - 1.1) / 0.3) : 0 };
}

// ------------------------------------------------------------ the plan: who is on which station when
/**
 * Time on each station from a crew {code: {personId, start, moves}}: [{personId, code, from, to}] in minutes.
 * A person starts on their own station at their start time and moves at each move's time. Segments run to midnight;
 * the time clock decides when they really worked.
 */
export function segmentsOf(crew) {
  const out = [];
  for (const [code, c] of Object.entries(crew || {})) {
    if (!c || !c.personId) continue;
    let cur = code, t = toMin(c.start) ?? 0;
    for (const m of (c.moves || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
      const at = toMin(m.at); if (at == null) continue;
      if (at <= t) { cur = m.to; continue; }
      out.push({ personId: c.personId, code: cur, from: t, to: at });
      cur = m.to; t = at;
    }
    out.push({ personId: c.personId, code: cur, from: t, to: 1440 });
  }
  return out;
}
/** The person on a station at minute `now`: who's there; else who's coming next; else who was there last. */
export function occupantAt(segs, code, now) {
  const here = segs.filter(s => s.code === code);
  const cover = here.filter(s => s.from <= now && now < s.to).sort((a, b) => b.from - a.from)[0];
  if (cover) return { personId: cover.personId, status: "on", from: cover.from };
  const next = here.filter(s => s.from > now).sort((a, b) => a.from - b.from)[0];
  if (next) return { personId: next.personId, status: "upcoming", from: next.from };
  const last = here.filter(s => s.to <= now).sort((a, b) => b.to - a.to)[0];
  if (last) return { personId: last.personId, status: "left", from: last.from, to: last.to };
  return null;
}

/** Today's crew: the saved plan; with nothing saved, the planner's own suggestion (as the Plan page shows it). */
const suggestCache = new Map();
async function crewFor(db, env, day) {
  const { locationId } = await productionIds(db, env.ORG_ID);
  const rows = (await db.prepare(`SELECT s.code, a.person_id AS personId, a.starts_at AS start, a.moves_json AS moves FROM plan_assignments a
      JOIN plan_days d ON d.id=a.day_id JOIN plan_stations s ON s.id=a.station_id WHERE d.location_id=? AND d.work_date=? AND a.deleted_at IS NULL AND a.person_id IS NOT NULL`)
    .bind(locationId, day).all()).results;
  // people out today (Team › Time off, or a call-out on the plan) aren't on any station
  const out = new Set((await timeOffBetween(db, env.ORG_ID, day, day)).filter(t => t.kind === "out").map(t => t.personId));
  for (const c of (await db.prepare(`SELECT c.person_id AS p FROM plan_callouts c JOIN plan_days d ON d.id=c.day_id WHERE d.location_id=? AND d.work_date=? AND c.deleted_at IS NULL`)
    .bind(locationId, day).all()).results) out.add(c.p);
  const keep = c => !out.has(c.personId);
  if (rows.length) {
    const crew = {};
    for (const r of rows) { let moves = []; try { moves = JSON.parse(r.moves || "[]") || []; } catch {} if (keep(r)) crew[r.code] = { personId: r.personId, start: r.start, moves }; }
    return { crew, source: "saved" };
  }
  const hit = suggestCache.get(day);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.v;
  let v = { crew: {}, source: "none" };
  try {
    const [{ projectDay }, { piecesView }, { loadPlan }] = await Promise.all([import("../public/js/plan/model.js"), import("./pieces.js"), import("./plan.js")]);
    const [SET, TEAM, V, plan] = await Promise.all([allSettings(db, env), listTeam(db, env), piecesView(db, env, { day }), loadPlan(db, env, day)]);
    const N = projectDay({ SET, TEAM, V, plan, day });
    if (N) {
      const crew = {};
      for (const [code, c] of Object.entries(N.P.crew)) if (c.emp && keep({ personId: c.emp })) crew[code] = { personId: c.emp, start: c.start, moves: c.moves || [] };
      v = { crew, source: "suggested" };
    }
  } catch (e) { console.error(JSON.stringify({ job: "tally", suggestError: String(e && e.stack || e) })); }
  suggestCache.set(day, { at: Date.now(), v });
  return v;
}

/** Today's punches: {personId: [[inMin, outMin|null], ...]} (Production, or no department). */
async function punchesFor(db, env, day) {
  const rows = (await db.prepare(`SELECT c.person_id AS p, c.clock_in AS i, c.clock_out AS o FROM labor_clock_today c JOIN core_people p ON p.id=c.person_id
      WHERE p.org_id=? AND substr(c.clock_in,1,10)=? AND (c.department_id IS NULL OR c.department_id=(SELECT d.id FROM core_departments d WHERE d.org_id=p.org_id AND d.name='Production'))`)
    .bind(env.ORG_ID, day).all()).results;
  const out = {};
  for (const r of rows) (out[r.p] = out[r.p] || []).push([toMin(String(r.i).slice(11, 16)), r.o ? toMin(String(r.o).slice(11, 16)) : null]);
  return out;
}

/** Minutes a person worked on a station between a and b: their time there (plan) that they were clocked in. */
export function workedMin(segs, punches, personId, code, a, b, now) {
  const mine = segs.filter(s => s.personId === personId && s.code === code);
  const P = punches[personId];
  const clock = P && P.length ? P.map(([i, o]) => [i, o == null ? now : o]) : [[0, 1440]]; // no punches (time clock down): trust the plan
  let t = 0;
  for (const s of mine) for (const [i, o] of clock) {
    const lo = Math.max(s.from, i, a), hi = Math.min(s.to, o, b);
    if (hi > lo) t += hi - lo;
  }
  return t;
}

/**
 * Pace for a list of entries (sorted by minute), as of the last one. `who` = the people whose hours count.
 * lastHour: the entries in the hour up to the last one, over the time since the entry before them.
 */
export function pace(entries, segs, punches, who, code, goal, now) {
  const count = entries.reduce((t, e) => t + e.count, 0);
  if (!entries.length) return { count: 0, minutes: 0, perHour: null, lastMin: null, goal, ...judge(null, goal), lastHour: null };
  const T = entries[entries.length - 1].minute;
  const hrs = (a, b) => who.reduce((t, p) => t + workedMin(segs, punches, p, code, a, b, now), 0);
  const minutes = hrs(0, T);
  const perHour = minutes >= 10 ? count / (minutes / 60) : null;
  const k = entries.findIndex(e => e.minute > T - 60);
  const from = k > 0 ? entries[k - 1].minute : 0, lhCount = entries.slice(k).reduce((t, e) => t + e.count, 0), lhMin = hrs(from, T);
  const lastHour = k > 0 && lhMin >= 15 ? { count: lhCount, minutes: lhMin, perHour: lhCount / (lhMin / 60), ...judge(lhCount / (lhMin / 60), goal) } : null;
  return { count, minutes, perHour, lastMin: T, goal, ...judge(perHour, goal), lastHour };
}

async function peopleNames(db, orgId) {
  return new Map((await db.prepare(`SELECT p.id, COALESCE(p.display_name, p.first_name || ' ' || p.last_name) AS n, pp.slb_rate AS rate FROM core_people p
      LEFT JOIN plan_person_prefs pp ON pp.person_id=p.id WHERE p.org_id=?`).bind(orgId).all()).results.map(r => [r.id, { name: r.n, rate: r.rate > 0 ? +r.rate : null }]));
}
async function stationLabels(db, orgId) {
  return new Map((await db.prepare(`SELECT s.code, s.label, s.station_type_id AS type FROM plan_stations s JOIN core_locations l ON l.id=s.location_id
      WHERE l.org_id=? AND s.deleted_at IS NULL`).bind(orgId).all()).results.map(r => [r.code, { label: r.label, type: r.type }]));
}
async function entriesFor(db, orgId, day, code = null) {
  return (await db.prepare(`SELECT id, station_code AS code, person_id AS personId, count, at, minute, source, device_id AS deviceId, has_photo AS hasPhoto, note
      FROM plan_station_tally WHERE org_id=? AND day=? AND deleted_at IS NULL ${code ? "AND station_code=?" : ""} ORDER BY minute, at`).bind(...[orgId, day, ...(code ? [code] : [])]).all()).results;
}

/**
 * One station's day: totals and pace for the station and for each person who pressed there, and who's on it now.
 * ctx = { segs, punches, names, goal, now, labels }
 */
function stationDay(code, entries, ctx) {
  const { segs, punches, names, goal, now } = ctx;
  const mine = entries.filter(e => e.code === code);
  const occupants = [...new Set(segs.filter(s => s.code === code).map(s => s.personId))];
  const credited = [...new Set(mine.map(e => e.personId).filter(Boolean))];
  const station = pace(mine, segs, punches, occupants, code, goal, now);
  const people = [...new Set([...credited, ...occupants])].map(pid => {
    const n = names.get(pid) || { name: "Someone", rate: null }, g = n.rate || goal;
    const e = mine.filter(x => x.personId === pid);
    return { personId: pid, name: n.name, ownGoal: !!n.rate, ...pace(e, segs, punches, [pid], code, g, now) };
  }).filter(p => p.count > 0 || occupants.includes(p.personId));
  const occ = occupantAt(segs, code, now);
  return { code, label: ctx.labels.get(code)?.label || code.toUpperCase(), station, people,
    current: occ ? { ...occ, name: (names.get(occ.personId) || {}).name || "Someone", goal: (names.get(occ.personId) || {}).rate || goal } : null };
}

/** The SLB stations in use (codes with the slb type), in order. */
async function slbCodes(db, orgId) {
  return (await db.prepare(`SELECT s.code FROM plan_stations s JOIN core_locations l ON l.id=s.location_id
      WHERE l.org_id=? AND s.deleted_at IS NULL AND s.is_active=1 AND s.station_type_id='slb' ORDER BY s.sort`).bind(orgId).all()).results.map(r => r.code);
}

// ------------------------------------------------------------ everyone signed in: a day's counts (Plan tiles, Review)
export async function dayTally(db, env, day, { withEntries = true } = {}) {
  if (!DAY.test(day)) throw new HttpError(400, "Use a date like 2026-10-14.");
  const tz = env.TIMEZONE || "America/Chicago", L = localMin(tz), isToday = day === L.day;
  const now = isToday ? L.min : 1440;
  const [set, codes, names, labels, entries] = await Promise.all([tallySettings(db, env.ORG_ID), slbCodes(db, env.ORG_ID), peopleNames(db, env.ORG_ID), stationLabels(db, env.ORG_ID), entriesFor(db, env.ORG_ID, day)]);
  const { crew, source } = await crewFor(db, env, day);
  const segs = segmentsOf(crew);
  const punches = isToday ? await punchesFor(db, env, day) : await pastPunches(db, env, day);
  const ctx = { segs, punches, names, goal: set.goal, now, labels };
  const stations = codes.map(c => stationDay(c, entries, ctx));
  const byHour = {};
  for (const e of entries) { const h = Math.floor(e.minute / 60); (byHour[e.code] = byHour[e.code] || {})[h] = (byHour[e.code][h] || 0) + e.count; }
  return { day, isToday, now, goal: set.goal, photos: set.photos, planSource: source, total: entries.reduce((t, e) => t + e.count, 0), stations, byHour,
    ...(withEntries ? { entries: entries.map(e => ({ ...e, hasPhoto: !!e.hasPhoto, name: e.personId ? (names.get(e.personId) || {}).name || "Someone" : null, label: labels.get(e.code)?.label || e.code })) } : {}) };
}
/** A past day has no punch list, only first in / last out: good enough for hours on the station. */
async function pastPunches(db, env, day) {
  const rows = (await db.prepare(`SELECT h.person_id AS p, h.first_in AS i, h.last_out AS o FROM labor_daily_hours h JOIN core_people p ON p.id=h.person_id
      WHERE p.org_id=? AND h.work_date=? AND h.deleted_at IS NULL`).bind(env.ORG_ID, day).all()).results;
  const out = {};
  for (const r of rows) { const i = toMin(r.i), o = toMin(r.o); if (i != null) (out[r.p] = out[r.p] || []).push([i, o ?? 1440]); }
  return out;
}

// ------------------------------------------------------------ the tablet
/** The paired tablet making this request, or null. Also notes when it was last seen (at most once a minute). */
export async function deviceOf(db, env, req) {
  const tok = cookieOf(req); if (!tok) return null;
  const d = await db.prepare(`SELECT id, station_code AS code, name, last_seen_at AS seen FROM plan_station_devices WHERE org_id=? AND token_hash=? AND revoked_at IS NULL`)
    .bind(env.ORG_ID, await sha256(tok)).first();
  if (d && (!d.seen || Date.now() - Date.parse(d.seen) > 60000)) await db.prepare("UPDATE plan_station_devices SET last_seen_at=? WHERE id=?").bind(nowIso(), d.id).run();
  return d ? { ...d, token: tok } : null;
}

/** Pairs a tablet with a code from Settings. Returns the new secret (goes into the tablet's cookie). */
export async function pairTablet(db, env, code) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6) throw new HttpError(400, "Enter the 6-digit code from Settings › Station tablets.");
  const now = nowIso(), h = await sha256(`${env.ORG_ID}:${c}`);
  const d = await db.prepare(`SELECT id, station_code AS code, name FROM plan_station_devices WHERE org_id=? AND pair_code_hash=? AND pair_expires_at > ? AND revoked_at IS NULL AND pair_failures < ?`)
    .bind(env.ORG_ID, h, now, PAIR_TRIES).first();
  if (!d) {
    // every wrong code counts against all the codes waiting, so guessing runs out fast
    await db.prepare("UPDATE plan_station_devices SET pair_failures=pair_failures+1 WHERE org_id=? AND pair_code_hash IS NOT NULL").bind(env.ORG_ID).run();
    await db.prepare("UPDATE plan_station_devices SET pair_code_hash=NULL, pair_expires_at=NULL WHERE org_id=? AND pair_failures >= ?").bind(env.ORG_ID, PAIR_TRIES).run();
    throw new HttpError(403, "That code didn't work. Codes last 15 minutes; make a new one in Settings › Station tablets.");
  }
  const token = randomToken();
  await db.prepare(`UPDATE plan_station_devices SET token_hash=?, pair_code_hash=NULL, pair_expires_at=NULL, pair_failures=0, paired_at=?, last_seen_at=? WHERE id=?`)
    .bind(await sha256(token), now, now, d.id).run();
  await audit(db, { orgId: env.ORG_ID, userId: null, appId: env.APP_ID, entity: "plan_station_devices", entityId: d.id, action: "sign_in", changes: { station: d.code, name: d.name } });
  return { token, device: d };
}

/** What the tablet shows. */
export async function tabletState(db, env, dev) {
  const tz = env.TIMEZONE || "America/Chicago", L = localMin(tz), day = L.day, now = L.min;
  const [set, names, labels, entries, { crew, source }, punches] = await Promise.all([tallySettings(db, env.ORG_ID), peopleNames(db, env.ORG_ID), stationLabels(db, env.ORG_ID),
    entriesFor(db, env.ORG_ID, day, dev.code), crewFor(db, env, day), punchesFor(db, env, day)]);
  const segs = segmentsOf(crew);
  const S = stationDay(dev.code, entries, { segs, punches, names, goal: set.goal, now, labels });
  const cur = S.current;
  const opened = await openedFor(db, env, day, dev.code);
  const ins = cur ? punches[cur.personId] || [] : [];
  const clockedIn = ins.length > 0;
  const firstIn = clockedIn ? Math.min(...ins.map(x => x[0])) : null;
  const onNow = clockedIn && ins.some(x => x[1] == null);
  const locked = !(clockedIn || opened.has(cur ? cur.personId : "none"));
  const me = cur ? S.people.find(p => p.personId === cur.personId) : null;
  // the person's own line shows when someone else has pressed on this station today too
  const showPerson = !!(me && me.count > 0 && me.count !== S.station.count);
  const asOf = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='rippling_last'").bind(env.ORG_ID).first();
  let clockAsOf = null; try { clockAsOf = asOf ? JSON.parse(asOf.value_json).at || null : null; } catch {}
  const undoFrom = Date.now() - UNDO_MIN * 60000;
  return {
    paired: true, device: { name: dev.name }, day, now, station: { code: dev.code, label: S.label },
    person: cur ? { id: cur.personId, name: cur.name, status: cur.status, from: cur.from, to: cur.to ?? null, goal: cur.goal, ownGoal: !!(names.get(cur.personId) || {}).rate,
      clockedIn, onNow, firstIn } : null,
    locked, opened: !clockedIn && !locked, planSource: source, clockAsOf,
    totals: S.station, mine: showPerson ? me : null,
    entries: entries.slice(-6).reverse().map(e => ({ id: e.id, count: e.count, minute: e.minute, name: e.personId ? (names.get(e.personId) || {}).name || "Someone" : null,
      undo: e.deviceId === dev.id && e.source === "tablet" && Date.parse(e.at) >= undoFrom })),
    photos: !!set.photos,
  };
}
async function openedFor(db, env, day, code) {
  const r = (await db.prepare("SELECT key FROM plan_events WHERE org_id=? AND day=? AND key LIKE ?").bind(env.ORG_ID, day, `tally-open:${code}:%`).all()).results;
  return new Set(r.map(x => x.key.split(":")[2]));
}

/** "They're clocked in": opens counting for today's person before the time clock shows them (logged in Changes today). */
export async function openTablet(db, env, dev) {
  const tz = env.TIMEZONE || "America/Chicago", L = localMin(tz);
  const S = await tabletState(db, env, dev);
  const pid = S.person ? S.person.id : "none";
  await db.prepare("INSERT INTO plan_events(id, org_id, day, key, kind, text, at, user_id) VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(org_id, day, key) DO NOTHING")
    .bind(ulid(), env.ORG_ID, L.day, `tally-open:${dev.code}:${pid}`, "note",
      `${S.station.label} tablet opened for counts ${S.person ? `for ${S.person.name} before the time clock showed them clocked in` : "with no one on the station in the plan"}`, nowIso()).run();
  return tabletState(db, env, dev);
}

/** A count from the tablet, credited to whoever the plan has on the station now. */
export async function tabletCount(db, env, dev, body) {
  const n = Math.round(+body.count);
  if (!(n >= 1 && n <= 999)) throw new HttpError(400, "Enter how many pairs (1 or more).");
  const S = await tabletState(db, env, dev);
  if (S.locked) throw new HttpError(409, S.person ? `${S.person.name} isn't clocked in yet.` : "No one is on this station in the plan.");
  const tz = env.TIMEZONE || "America/Chicago", L = localMin(tz), id = ulid();
  await db.prepare(`INSERT INTO plan_station_tally(id, org_id, day, station_code, person_id, count, at, minute, source, device_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, env.ORG_ID, L.day, dev.code, S.person ? S.person.id : null, n, nowIso(), L.min, body.source === "button" ? "button" : "tablet", dev.id).run();
  return { id, state: await tabletState(db, env, dev) };
}
export async function tabletUndo(db, env, dev, id) {
  const e = await db.prepare("SELECT id, at, device_id AS d FROM plan_station_tally WHERE id=? AND org_id=? AND deleted_at IS NULL").bind(id, env.ORG_ID).first();
  if (!e || e.d !== dev.id) throw new HttpError(404, "That count isn't there any more.");
  if (Date.now() - Date.parse(e.at) > UNDO_MIN * 60000) throw new HttpError(409, `A count can only be taken back on the tablet for ${UNDO_MIN} minutes. A manager can fix it in Review.`);
  await db.batch([db.prepare("UPDATE plan_station_tally SET deleted_at=?, deleted_by=? WHERE id=?").bind(nowIso(), `device:${dev.id}`, id),
    db.prepare("DELETE FROM plan_station_photos WHERE tally_id=?").bind(id)]);
  return tabletState(db, env, dev);
}
/** The photo taken with a count (front camera, small JPEG), sent right after it. */
export async function tabletPhoto(db, env, dev, id, bytes) {
  const set = await tallySettings(db, env.ORG_ID);
  if (!set.photos) throw new HttpError(409, "Photos are turned off in Settings.");
  const e = await db.prepare("SELECT id, day, at, device_id AS d FROM plan_station_tally WHERE id=? AND org_id=? AND deleted_at IS NULL").bind(id, env.ORG_ID).first();
  if (!e || e.d !== dev.id) throw new HttpError(404, "That count isn't there any more.");
  if (Date.now() - Date.parse(e.at) > 5 * 60000) throw new HttpError(409, "Too late for a photo of that count.");
  const b = new Uint8Array(bytes);
  if (b.length < 200 || b.length > 300000 || b[0] !== 0xff || b[1] !== 0xd8) throw new HttpError(400, "The photo must be a JPEG under 300 KB.");
  await db.batch([db.prepare("INSERT INTO plan_station_photos(tally_id, org_id, day, jpeg, taken_at) VALUES(?,?,?,?,?) ON CONFLICT(tally_id) DO NOTHING").bind(id, env.ORG_ID, e.day, b, nowIso()),
    db.prepare("UPDATE plan_station_tally SET has_photo=1 WHERE id=?").bind(id)]);
  return { ok: true };
}

// ------------------------------------------------------------ managers: fixing counts in Review
export async function addCount(db, env, me, body) {
  requireRole(me, "manager");
  const day = String(body.day || ""), code = String(body.station || "");
  if (!DAY.test(day)) throw new HttpError(400, "Pick a day.");
  const today = localNow(env.TIMEZONE || "America/Chicago").day; if (day > today) throw new HttpError(400, "That day hasn't happened yet.");
  if (!(await slbCodes(db, env.ORG_ID)).includes(code)) throw new HttpError(400, "Pick SLB 1 or SLB 2.");
  const n = Math.round(+body.count); if (!(n >= 1 && n <= 999)) throw new HttpError(400, "Enter how many pairs (1 or more).");
  if (!TIME.test(body.at || "")) throw new HttpError(400, "Enter the time it was pressed by, like 10:30.");
  const minute = toMin(body.at);
  let personId = body.personId || null;
  if (personId) { if (!(await db.prepare("SELECT id FROM core_people WHERE id=? AND org_id=?").bind(personId, env.ORG_ID).first())) throw new HttpError(400, "That person isn't on the team."); }
  else { const occ = occupantAt(segmentsOf((await crewFor(db, env, day)).crew), code, minute); personId = occ ? occ.personId : null; }
  const id = ulid(), note = String(body.note || "").trim().slice(0, 200) || null;
  await db.prepare(`INSERT INTO plan_station_tally(id, org_id, day, station_code, person_id, count, at, minute, source, user_id, note) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, env.ORG_ID, day, code, personId, n, nowIso(), minute, "manager", me.id, note).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_station_tally", entityId: id, action: "create", changes: { day, station: code, count: n, at: body.at, personId, note } });
  return { id };
}
export async function removeCount(db, env, me, id) {
  requireRole(me, "manager");
  const e = await db.prepare("SELECT id, day, station_code AS code, count, minute FROM plan_station_tally WHERE id=? AND org_id=? AND deleted_at IS NULL").bind(id, env.ORG_ID).first();
  if (!e) throw new HttpError(404, "That count isn't there any more.");
  await db.batch([db.prepare("UPDATE plan_station_tally SET deleted_at=?, deleted_by=? WHERE id=?").bind(nowIso(), me.id, id), db.prepare("DELETE FROM plan_station_photos WHERE tally_id=?").bind(id)]);
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_station_tally", entityId: id, action: "delete", changes: e });
  return { id };
}
/** A count's photo, for Admins and the Owner. */
export async function photoOf(db, env, me, id) {
  requireRole(me, "admin");
  const r = await db.prepare("SELECT jpeg FROM plan_station_photos WHERE tally_id=? AND org_id=?").bind(id, env.ORG_ID).first();
  if (!r) throw new HttpError(404, "No photo for that count.");
  return new Response(r.jpeg instanceof Uint8Array ? r.jpeg : new Uint8Array(r.jpeg), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
}
/** Photos older than Settings' "keep photos" days are deleted (from the cron). */
export async function cleanupPhotos(env) {
  const set = await tallySettings(env.DB, env.ORG_ID);
  const cut = new Date(Date.now() - set.keepDays * 864e5).toISOString().slice(0, 10);
  const r = await env.DB.prepare("DELETE FROM plan_station_photos WHERE org_id=? AND day < ?").bind(env.ORG_ID, cut).run();
  return { deleted: r?.meta?.changes || 0 };
}

// ------------------------------------------------------------ Admins: the tablets
export async function listDevices(db, env, me) {
  requireRole(me, "admin");
  const now = nowIso();
  const rows = (await db.prepare(`SELECT id, station_code AS station, name, paired_at AS pairedAt, last_seen_at AS lastSeen, created_at AS createdAt,
      CASE WHEN pair_code_hash IS NOT NULL AND pair_expires_at > ? THEN pair_expires_at END AS codeUntil, token_hash IS NOT NULL AS paired
      FROM plan_station_devices WHERE org_id=? AND revoked_at IS NULL ORDER BY station_code, created_at`).bind(now, env.ORG_ID).all()).results;
  const labels = await stationLabels(db, env.ORG_ID), codes = await slbCodes(db, env.ORG_ID);
  return { devices: rows.map(r => ({ ...r, paired: !!r.paired, label: labels.get(r.station)?.label || r.station })), stations: codes.map(c => ({ code: c, label: labels.get(c)?.label || c })) };
}
async function newCodeStmt(db, env, id) {
  const code = sixDigits(), until = new Date(Date.now() + PAIR_MIN * 60000).toISOString();
  return { code, until, stmt: db.prepare("UPDATE plan_station_devices SET pair_code_hash=?, pair_expires_at=?, pair_failures=0 WHERE id=?").bind(await sha256(`${env.ORG_ID}:${code}`), until, id) };
}
export async function createDevice(db, env, me, body) {
  requireRole(me, "admin");
  const code = String(body.station || "");
  if (!(await slbCodes(db, env.ORG_ID)).includes(code)) throw new HttpError(400, "Pick the station this tablet sits at.");
  const name = String(body.name || "").trim().slice(0, 40) || `${(await stationLabels(db, env.ORG_ID)).get(code)?.label || code} tablet`;
  const id = ulid();
  await db.prepare("INSERT INTO plan_station_devices(id, org_id, station_code, name, created_by) VALUES(?,?,?,?,?)").bind(id, env.ORG_ID, code, name, me.id).run();
  const c = await newCodeStmt(db, env, id); await c.stmt.run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_station_devices", entityId: id, action: "create", changes: { station: code, name } });
  return { id, code: c.code, until: c.until };
}
/** A new pairing code. The tablet keeps working until it's paired again with the new code. */
export async function deviceCode(db, env, me, id) {
  requireRole(me, "admin");
  const d = await db.prepare("SELECT id FROM plan_station_devices WHERE id=? AND org_id=? AND revoked_at IS NULL").bind(id, env.ORG_ID).first();
  if (!d) throw new HttpError(404, "That tablet isn't on the list.");
  const c = await newCodeStmt(db, env, id); await c.stmt.run();
  return { id, code: c.code, until: c.until };
}
export async function updateDevice(db, env, me, id, body) {
  requireRole(me, "admin");
  const d = await db.prepare("SELECT id, station_code AS station, name FROM plan_station_devices WHERE id=? AND org_id=? AND revoked_at IS NULL").bind(id, env.ORG_ID).first();
  if (!d) throw new HttpError(404, "That tablet isn't on the list.");
  const station = body.station !== undefined ? String(body.station) : d.station;
  if (!(await slbCodes(db, env.ORG_ID)).includes(station)) throw new HttpError(400, "Pick the station this tablet sits at.");
  const name = body.name !== undefined ? (String(body.name).trim().slice(0, 40) || d.name) : d.name;
  await db.prepare("UPDATE plan_station_devices SET station_code=?, name=? WHERE id=?").bind(station, name, id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_station_devices", entityId: id, action: "update", changes: { station, name } });
  return { id, station, name };
}
export async function removeDevice(db, env, me, id) {
  requireRole(me, "admin");
  const r = await db.prepare("UPDATE plan_station_devices SET revoked_at=?, token_hash=NULL, pair_code_hash=NULL WHERE id=? AND org_id=? AND revoked_at IS NULL").bind(nowIso(), id, env.ORG_ID).run();
  if (!r?.meta?.changes) throw new HttpError(404, "That tablet isn't on the list.");
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "plan_station_devices", entityId: id, action: "delete", changes: null });
  return { id };
}
