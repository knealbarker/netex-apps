// Station tablets (Neal, Oct 14; pace simplified Oct 21): counts of pairs pressed at the starch bottoms presses, entered on a
// tablet at each press.
//  - Pace is the STATION's (Neal, Oct 21): all pairs entered today ÷ hours from the press's start to the last entry.
//    No credit per person and no breaks: the manager keeps someone on the press all day, and counts weren't being entered
//    exactly when people changed over, so per-person numbers weren't reliable.
//  - The press's start = the first person planned on it, at their planned clock-in + Settings' start delay (10 min).
//    Someone at the tablet can set the start by hand; a photo of whoever made the change is kept with it.
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

/**
 * When the press started: a start set on the tablet; else the first person planned on it (moves included) at their planned
 * clock-in + `delay` minutes; else the first count (nothing planned there).
 */
export function pressStart(segs, code, manual, delay, entries = []) {
  if (manual && manual.minute != null) return { min: manual.minute, source: "manual", setAt: manual.at };
  const here = segs.filter(s => s.code === code);
  if (here.length) {
    const s0 = here.reduce((x, y) => (y.from < x.from ? y : x));
    return { min: Math.min(1439, s0.from + delay), source: "plan", personId: s0.personId, clockIn: s0.from, delay };
  }
  if (entries.length) return { min: entries[0].minute, source: "first" };
  return { min: null, source: "none" };
}

/** The station's running pace: every pair entered today ÷ the hours from the press's start to the last entry. */
export function pace(entries, start, goal) {
  const count = entries.reduce((t, e) => t + e.count, 0);
  if (!entries.length) return { count: 0, minutes: 0, perHour: null, lastMin: null, goal, ...judge(null, goal) };
  const T = entries[entries.length - 1].minute;
  const minutes = start == null ? 0 : Math.max(0, T - start);
  const perHour = minutes >= 10 ? count / (minutes / 60) : null;
  return { count, minutes, perHour, lastMin: T, goal, ...judge(perHour, goal) };
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

/** One station's day: its start, the pairs and pace, and who the plan has on it now (shown for reference only). */
function stationDay(code, entries, ctx) {
  const { segs, names, goal, now, starts, delay } = ctx;
  const mine = entries.filter(e => e.code === code);
  const st = pressStart(segs, code, starts.get(code), delay, mine);
  if (st.personId) st.name = (names.get(st.personId) || {}).name || "Someone";
  const occ = occupantAt(segs, code, now);
  return { code, label: ctx.labels.get(code)?.label || code.toUpperCase(), start: st, station: pace(mine, st.min, goal),
    current: occ ? { ...occ, name: (names.get(occ.personId) || {}).name || "Someone" } : null };
}

/** Start-time changes for a day, oldest first: [{id, code, minute, at, deviceId, userId, hasPhoto}]. */
async function startsFor(db, orgId, day, code = null) {
  return (await db.prepare(`SELECT id, station_code AS code, minute, at, device_id AS deviceId, user_id AS userId, jpeg IS NOT NULL AS hasPhoto
      FROM plan_station_starts WHERE org_id=? AND day=? AND deleted_at IS NULL ${code ? "AND station_code=?" : ""} ORDER BY at`).bind(...[orgId, day, ...(code ? [code] : [])]).all()).results
    .map(r => ({ ...r, hasPhoto: !!r.hasPhoto }));
}
const latestByCode = rows => { const m = new Map(); for (const r of rows) m.set(r.code, r); return m; };

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
  const [set, codes, names, labels, entries, startRows] = await Promise.all([tallySettings(db, env.ORG_ID), slbCodes(db, env.ORG_ID), peopleNames(db, env.ORG_ID), stationLabels(db, env.ORG_ID), entriesFor(db, env.ORG_ID, day), startsFor(db, env.ORG_ID, day)]);
  const { crew, source } = await crewFor(db, env, day);
  const ctx = { segs: segmentsOf(crew), names, goal: set.goal, now, labels, starts: latestByCode(startRows), delay: set.startDelay };
  const stations = codes.map(c => stationDay(c, entries, ctx));
  const byHour = {};
  for (const e of entries) { const h = Math.floor(e.minute / 60); (byHour[e.code] = byHour[e.code] || {})[h] = (byHour[e.code][h] || 0) + e.count; }
  return { day, isToday, now, goal: set.goal, startDelay: set.startDelay, photos: set.photos, planSource: source, total: entries.reduce((t, e) => t + e.count, 0), stations, byHour,
    startChanges: startRows.map(r => ({ ...r, label: labels.get(r.code)?.label || r.code })),
    ...(withEntries ? { entries: entries.map(e => ({ ...e, hasPhoto: !!e.hasPhoto, label: labels.get(e.code)?.label || e.code })) } : {}) };
}

// ------------------------------------------------------------ the tablet
/** The paired tablet making this request, or null. Also notes when it was last seen (at most once a minute). */
export async function deviceOf(db, env, req) {
  const tok = cookieOf(req); if (!tok) return null;
  const d = await db.prepare(`SELECT id, station_code AS code, name, last_seen_at AS seen, client_json AS client FROM plan_station_devices WHERE org_id=? AND token_hash=? AND revoked_at IS NULL`)
    .bind(env.ORG_ID, await sha256(tok)).first();
  if (!d) return null;
  // how the tablet is running, as its page reports it (?cam=&mode=&wake=), for Settings › Station tablets
  const q = new URL(req.url).searchParams, pick = (k, ok) => (ok.includes(q.get(k)) ? q.get(k) : null);
  const info = { cam: pick("cam", ["on", "off", "denied", "none"]), mode: pick("mode", ["fullscreen", "standalone", "browser"]), wake: pick("wake", ["on", "off"]) };
  const client = info.cam || info.mode ? JSON.stringify(info) : d.client;
  if (!d.seen || Date.now() - Date.parse(d.seen) > 60000 || client !== d.client)
    await db.prepare("UPDATE plan_station_devices SET last_seen_at=?, client_json=? WHERE id=?").bind(nowIso(), client, d.id).run();
  return { id: d.id, code: d.code, name: d.name, token: tok };
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
  const [set, names, labels, entries, startRows, { crew, source }] = await Promise.all([tallySettings(db, env.ORG_ID), peopleNames(db, env.ORG_ID), stationLabels(db, env.ORG_ID),
    entriesFor(db, env.ORG_ID, day, dev.code), startsFor(db, env.ORG_ID, day, dev.code), crewFor(db, env, day)]);
  const S = stationDay(dev.code, entries, { segs: segmentsOf(crew), names, goal: set.goal, now, labels, starts: latestByCode(startRows), delay: set.startDelay });
  const undoFrom = Date.now() - UNDO_MIN * 60000;
  return {
    paired: true, device: { name: dev.name }, day, now, station: { code: dev.code, label: S.label },
    start: S.start, planSource: source, totals: S.station,
    entries: entries.slice(-6).reverse().map(e => ({ id: e.id, count: e.count, minute: e.minute,
      undo: e.deviceId === dev.id && e.source === "tablet" && Date.parse(e.at) >= undoFrom })),
    photos: !!set.photos,
  };
}

/** The press's start set by hand on the tablet ({at: "HH:MM"}), or back to the plan ({at: null}). Logged in Changes today. */
export async function tabletStart(db, env, dev, body) {
  const tz = env.TIMEZONE || "America/Chicago", L = localMin(tz);
  const at = body.at == null || body.at === "" ? null : String(body.at);
  if (at != null && !TIME.test(at)) throw new HttpError(400, "Enter the start time like 6:05.");
  const minute = at == null ? null : toMin(at);
  if (minute != null && minute > L.min) throw new HttpError(400, "The start can't be later than now.");
  const id = ulid(), label = (await stationLabels(db, env.ORG_ID)).get(dev.code)?.label || dev.code;
  const clock = m => { let h = Math.floor(m / 60); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m % 60).padStart(2, "0")} ${ap}`; };
  await db.batch([
    db.prepare("INSERT INTO plan_station_starts(id, org_id, day, station_code, minute, at, device_id) VALUES(?,?,?,?,?,?,?)").bind(id, env.ORG_ID, L.day, dev.code, minute, nowIso(), dev.id),
    db.prepare("INSERT INTO plan_events(id, org_id, day, key, kind, text, at, user_id) VALUES(?,?,?,?,?,?,?,NULL)")
      .bind(ulid(), env.ORG_ID, L.day, `tally-start:${dev.code}:${id}`, "note", minute == null ? `${label} press start set back to the plan on the tablet` : `${label} press start set to ${clock(minute)} on the tablet`, nowIso()),
  ]);
  return { id, state: await tabletState(db, env, dev) };
}
/** The photo of whoever changed the start (front camera), sent right after the change. Kept even with count photos off. */
export async function tabletStartPhoto(db, env, dev, id, bytes) {
  const e = await db.prepare("SELECT id, at, device_id AS d FROM plan_station_starts WHERE id=? AND org_id=? AND deleted_at IS NULL").bind(id, env.ORG_ID).first();
  if (!e || e.d !== dev.id) throw new HttpError(404, "That change isn't there any more.");
  if (Date.now() - Date.parse(e.at) > 5 * 60000) throw new HttpError(409, "Too late for a photo of that change.");
  const b = new Uint8Array(bytes);
  if (b.length < 200 || b.length > 300000 || b[0] !== 0xff || b[1] !== 0xd8) throw new HttpError(400, "The photo must be a JPEG under 300 KB.");
  await db.prepare("UPDATE plan_station_starts SET jpeg=? WHERE id=? AND jpeg IS NULL").bind(b, id).run();
  return { ok: true };
}

/** A count from the tablet. The person the plan has on the press is noted for history only; pace is the station's. */
export async function tabletCount(db, env, dev, body) {
  const n = Math.round(+body.count);
  if (!(n >= 1 && n <= 999)) throw new HttpError(400, "Enter how many pairs (1 or more).");
  const tz = env.TIMEZONE || "America/Chicago", L = localMin(tz), id = ulid();
  const occ = occupantAt(segmentsOf((await crewFor(db, env, L.day)).crew), dev.code, L.min);
  const S = { current: occ && occ.status === "on" ? occ : null };
  await db.prepare(`INSERT INTO plan_station_tally(id, org_id, day, station_code, person_id, count, at, minute, source, device_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, env.ORG_ID, L.day, dev.code, S.current ? S.current.personId : null, n, nowIso(), L.min, body.source === "button" ? "button" : "tablet", dev.id).run();
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
/** The photo taken with a start-time change, for Admins and the Owner. */
export async function startPhotoOf(db, env, me, id) {
  requireRole(me, "admin");
  const r = await db.prepare("SELECT jpeg FROM plan_station_starts WHERE id=? AND org_id=? AND jpeg IS NOT NULL").bind(id, env.ORG_ID).first();
  if (!r) throw new HttpError(404, "No photo for that change.");
  return new Response(r.jpeg instanceof Uint8Array ? r.jpeg : new Uint8Array(r.jpeg), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
}
/** Photos older than Settings' "keep photos" days are deleted (from the cron). */
export async function cleanupPhotos(env) {
  const set = await tallySettings(env.DB, env.ORG_ID);
  const cut = new Date(Date.now() - set.keepDays * 864e5).toISOString().slice(0, 10);
  const r = await env.DB.prepare("DELETE FROM plan_station_photos WHERE org_id=? AND day < ?").bind(env.ORG_ID, cut).run();
  const s = await env.DB.prepare("UPDATE plan_station_starts SET jpeg=NULL WHERE org_id=? AND day < ? AND jpeg IS NOT NULL").bind(env.ORG_ID, cut).run();
  return { deleted: (r?.meta?.changes || 0) + (s?.meta?.changes || 0) };
}

// ------------------------------------------------------------ Admins: the tablets
export async function listDevices(db, env, me) {
  requireRole(me, "admin");
  const now = nowIso();
  const rows = (await db.prepare(`SELECT id, station_code AS station, name, paired_at AS pairedAt, last_seen_at AS lastSeen, created_at AS createdAt, client_json AS client,
      CASE WHEN pair_code_hash IS NOT NULL AND pair_expires_at > ? THEN pair_expires_at END AS codeUntil, token_hash IS NOT NULL AS paired
      FROM plan_station_devices WHERE org_id=? AND revoked_at IS NULL ORDER BY station_code, created_at`).bind(now, env.ORG_ID).all()).results;
  const labels = await stationLabels(db, env.ORG_ID), codes = await slbCodes(db, env.ORG_ID);
  const parse = j => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
  return { devices: rows.map(r => ({ ...r, client: parse(r.client), paired: !!r.paired, label: labels.get(r.station)?.label || r.station })), stations: codes.map(c => ({ code: c, label: labels.get(c)?.label || c })) };
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
