// Live "wrong store" text (Neal, Oct 18 2026): when someone on the clock right now has done most of their SMRT work in
// the last hour at a different store than the one Rippling has them clocked in at, text the retail manager (Karla) so
// she can fix the work location in Rippling. Runs from the Worker's 10-minute cron; one text per person per day.
import { loadSettings } from "./settings.js";
import { matchStaff } from "./counter.js";
import { addDays, localToday } from "./snapshot.js";

const t12 = iso => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
const all = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;

/** Who looks to be working at a different store than their punch, right now. Pure of sending; for the Counter page and tests. */
export async function wrongStoreNow(db, env, { now = Date.now(), s } = {}) {
  s = s || await loadSettings(db, env);
  const c = s.counter, org = env.ORG_ID, tz = env.TIMEZONE || "America/Chicago";
  const today = localToday(tz, new Date(now)), since = now - c.alertLookbackMin * 6e4;
  const locs = new Map((await all(db, "SELECT id, name, kind FROM core_locations WHERE org_id=?", org)).map(l => [l.id, l]));
  const hidden = new Set(s.hidden.map(h => h.toLowerCase()));
  // the store a location's work belongs to (Winnsboro -> Sulphur Springs); null for plants, hidden and unknown places
  const storeOf = id => { const l = locs.get(id); if (!l || l.kind !== "store" || hidden.has(l.name.toLowerCase())) return null; return s.rollup[l.name] || l.name; };

  const punches = (await all(db, `SELECT c.person_id AS pid, c.location_id AS loc, c.clock_in AS cin, COALESCE(p.display_name, p.first_name || ' ' || p.last_name) AS name
      FROM labor_clock_today c JOIN core_people p ON p.id=c.person_id WHERE p.org_id=? AND c.clock_out IS NULL`, org))
    .filter(p => localToday(tz, new Date(Date.parse(p.cin))) === today && storeOf(p.loc));
  if (!punches.length) return [];

  const sinceIso = new Date(since).toISOString();
  // SMRT stamps are local with offset, so compare as times, not strings: pull today's and filter
  const created = await all(db, `SELECT o.drop_location_id AS loc, o.smrt_created_at AS at, o.created_by_staff_id AS sid FROM pos_orders o
     WHERE o.org_id=? AND o.smrt_created_at >= ? AND o.smrt_deleted_at IS NULL`, org, today);
  const pieces = await all(db, `SELECT o.drop_location_id AS loc, i.detailed_at AS at, i.detailed_by_staff_id AS sid FROM pos_orders o JOIN pos_items i ON i.order_id=o.id
     WHERE o.org_id=? AND o.smrt_created_at >= ? AND o.smrt_deleted_at IS NULL AND i.removed_at IS NULL AND i.detailed_at >= ?`, org, addDays(today, -14), today);
  const staff = await all(db, "SELECT id, smrt_name AS name, person_id AS pid FROM pos_staff WHERE org_id=?", org);
  const people = await all(db, "SELECT id, first_name AS f, last_name AS l, COALESCE(display_name, first_name || ' ' || last_name) AS name FROM core_people WHERE org_id=? AND deleted_at IS NULL", org);
  const who = matchStaff(staff, people, c.salaried);

  const work = new Map();   // pid -> Map(store -> {n, first, last})
  for (const e of [...created, ...pieces]) {
    const t = Date.parse(e.at); if (!(t >= since && t <= now)) continue;
    const x = who.get(e.sid), st = storeOf(e.loc); if (!x || !x.pid || !st) continue;
    const m = work.get(x.pid) || work.set(x.pid, new Map()).get(x.pid);
    const w = m.get(st) || m.set(st, { n: 0, first: e.at, last: e.at }).get(st);
    w.n++; if (Date.parse(e.at) < Date.parse(w.first)) w.first = e.at; if (Date.parse(e.at) > Date.parse(w.last)) w.last = e.at;
  }
  const out = [];
  const seen = new Set();
  for (const p of punches) {
    if (seen.has(p.pid)) continue; seen.add(p.pid);
    const m = work.get(p.pid); if (!m) continue;
    const clocked = storeOf(p.loc), total = [...m.values()].reduce((a, w) => a + w.n, 0);
    const [store, w] = [...m.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    if (store === clocked || w.n < c.alertMin || w.n < total / 2) continue;
    out.push({ personId: p.pid, person: p.name, clockedAt: clocked, clockedIn: p.cin, workingAt: store, actions: w.n, first: w.first, last: w.last, day: today });
  }
  return out;
}

/** Cron: text the people in Settings › Counter about anyone working at another store than their punch. */
export async function wrongStoreAlerts(env, { now = Date.now() } = {}) {
  const db = env.DB, s = await loadSettings(db, env), c = s.counter;
  if (!c.alertOn || !c.alertTo.length) return { status: "off" };
  if (!env.TEXTS) return { status: "no texts binding" };
  const found = await wrongStoreNow(db, env, { now, s });
  if (!found.length) return { status: "none" };
  const to = (await all(db, `SELECT email, phone, display_name AS name FROM core_users WHERE org_id=? AND phone IS NOT NULL AND lower(email) IN (${c.alertTo.map(() => "?").join(",")})`,
    env.ORG_ID, ...c.alertTo.map(e => e.toLowerCase())));
  if (!to.length) return { status: "nobody to text", found: found.length };
  const sent = [];
  for (const f of found) {
    const ref = `wrongstore:${f.day}:${f.personId}`;
    const already = await db.prepare("SELECT 1 FROM sms_messages WHERE org_id=? AND app_id='retail' AND direction='out' AND ref=? LIMIT 1").bind(env.ORG_ID, ref).first();
    if (already) continue;
    const body = `Clock check: ${f.person} is clocked in at ${f.clockedAt} (since ${t12(f.clockedIn)}) but did ${f.actions} SMRT tickets/pieces at ${f.workingAt} since ${t12(f.first)}. `
      + `If they're working at ${f.workingAt}, please fix the work location in Rippling. retailview.netexcleaners.com/#/counter`;
    for (const u of to) {
      try { await env.TEXTS.send({ app: "retail", to: u.phone, body, ref }); sent.push({ to: u.email, person: f.person }); }
      catch (e) { console.log(JSON.stringify({ job: "wrong-store-text", error: String(e.message || e), to: u.email })); }
    }
  }
  return { status: sent.length ? "sent" : "already sent", found: found.length, sent };
}
