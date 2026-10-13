// Daily summary email (as the desktop planner sent it): how today went against the plan, and the next work day.
//  - Today: pieces due and finished by kind of work, plan vs. actual (finish, hours, labor $, labor %),
//    the crew from the time clock, who was planned but didn't clock in, and work done ahead for the next day.
//  - Next work day: pieces to plan for (with what usually still comes in), the crew (saved, or suggested from history),
//    and the projection: when everyone's done, hours, labor $ and %, overtime, pieces that wouldn't get done.
// Sent by this Worker's cron after Settings › Daily summary email's time on work days, once a day, through Cloudflare
// Email Routing (send_email binding SEND_EMAIL) from reports@netexcleaners.com. Cloudflare only delivers to addresses
// verified under Email Routing › Destination addresses. The email always carries labor numbers; an Admin picks who gets it.
import { reviewDay } from "./review.js";
import { SHUTTLES } from "./features.js";
import { piecesView, nextWorkDay, localNow, CATS } from "./pieces.js";
import { allSettings, loadGroups } from "./settings.js";
import { listTeam } from "./team.js";
import { loadPlan, publishedPlan } from "./plan.js";
import { projectDay, engineSettings, peopleFrom } from "../public/js/plan/model.js";
import { createEngine } from "../public/js/engine/engine.js";
import { ulid, nowIso, HttpError } from "./util.js";

const FROM = "reports@netexcleaners.com";
const APP_URL = "https://prodplanner.netexcleaners.com";
const OWNER = { id: null, role: "owner" };
const CAT_FULL = { dct: "Dry cleaning tops", dcb: "Dry cleaning bottoms", slt: "Starch tops", slb: "Starch bottoms", comf: "Comforters", tc: "Tablecloths" };

const esc = v => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n0 = v => Math.round(v || 0).toLocaleString("en-US");
const usd = v => (v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US"));
const pct = v => (v == null ? "—" : `${v.toFixed(1)}%`);
const clock = h => { if (h == null || !isFinite(h)) return "—"; let m = Math.round(h * 60 / 5) * 5; m = ((m % 1440) + 1440) % 1440; let hh = Math.floor(m / 60); const mm = m % 60, ap = hh >= 12 ? "PM" : "AM"; hh = hh % 12 || 12; return `${hh}:${String(mm).padStart(2, "0")} ${ap}`; };
const hrs = h => { if (!h) return "0h"; const m = Math.round(h * 60 / 5) * 5, a = Math.floor(m / 60), b = m % 60; return a ? (b ? `${a}h ${b}m` : `${a}h`) : `${b}m`; };
const t2h = t => { const m = /^(\d\d):(\d\d)$/.exec(t || ""); return m ? +m[1] + +m[2] / 60 : null; };
const longDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
const shortDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "numeric", day: "numeric" });

/** Builds the summary for `day` (normally today, after the plant has gone home). */
export async function buildSummary(db, env, day, { now = Date.now() } = {}) {
  const R = await reviewDay(db, env, OWNER, day);
  const groups = await loadGroups(db, env.ORG_ID);
  const workDays = groups.day.workDays || [1, 2, 3, 4, 5];
  const next = nextWorkDay(day, workDays);
  const V = await piecesView(db, env, { at: new Date(now), day: next });
  const [SET, TEAM, nplan] = await Promise.all([allSettings(db, env), listTeam(db, env, OWNER), loadPlan(db, env, next)]);
  let N = null; try { N = projectDay({ SET, TEAM, V, plan: nplan, day: next, admin: true }); } catch (e) { console.error(JSON.stringify({ job: "summary", projectError: String(e.stack || e) })); }
  const target = groups.money.laborTarget;
  const L = R.labor, W = R.deadlines.filter(w => w.kind !== "route" && w.deadline != null);
  const onTime = W.filter(w => w.readyAt != null && w.readyAt <= w.deadline + 1 / 60);
  const lastOut = Math.max(-1, ...R.people.filter(p => p.actualOut != null).map(p => p.actualOut)), stillIn = R.people.some(p => p.stillIn);
  const ahead = V.days[next]?.aheadToday || 0;
  const pm = R.planned?.metrics;
  // the published plan's labor $ and %: replay it with today's pay rates and prices (the snapshot itself carries no money)
  let pmoney = null;
  try {
    const pub = await publishedPlan(db, env, day);
    if (pub) {
      const I = pub.snapshot.input, s = engineSettings(SET, V.prices || {}), rate = new Map(peopleFrom(TEAM).map(x => [x.id, x.rate]));
      const E = createEngine({ ...I.settings, price: s.price, payAvg: s.payAvg, laborTarget: s.laborTarget, q: I.q, crew: I.crew, stations: I.stations, ops: I.ops, trainingOf: I.trainingOf,
        people: I.people.map(x => ({ ...x, ...(rate.get(x.id) ? { rate: rate.get(x.id) } : {}) })) });
      const RR = E.buildPlan(I.q); if (!RR.empty) pmoney = E.money(RR);
    }
  } catch (e) { console.error(JSON.stringify({ job: "summary", replayError: String(e.stack || e) })); }

  const subject = `Production summary ${shortDay(day)}: ${R.due.pieces ? `${n0(R.due.finished)} of ${n0(R.due.pieces)} due pieces done` : `${n0(R.done.pieces)} pieces assembled`}${W.length ? ` · ${onTime.length} of ${W.length} on time` : ""}${L.pct != null ? ` · labor ${pct(L.pct)}` : ""}`;

  // ---------- HTML (inline styles: email clients ignore style sheets)
  const C = { ink: "#141b2b", mute: "#5d6779", line: "#e1e6ef", good: "#12a36b", warn: "#b77806", bad: "#d83347" };
  const th = (v, al = "left") => `<th style="padding:7px 10px;border-bottom:2px solid #d3dae6;text-align:${al};font-size:12px;color:${C.mute};text-transform:uppercase;letter-spacing:.04em">${v}</th>`;
  const td = (v, al = "left", st = "") => `<td style="padding:7px 10px;border-bottom:1px solid ${C.line};text-align:${al};${st}">${v}</td>`;
  const table = (head, rows) => `<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid ${C.line};border-radius:12px;font-size:14px;margin:0 0 6px"><tr>${head.join("")}</tr>${rows.join("")}</table>`;
  const h2 = t => `<h2 style="font-size:16px;margin:22px 0 8px">${t}</h2>`;
  const p = (t, st = "") => `<p style="font-size:14px;margin:6px 0;${st}">${t}</p>`;
  const tile = (l, v, sub, col = C.ink) => `<td style="background:#fff;border:1px solid ${C.line};border-radius:12px;padding:12px 14px;vertical-align:top">
      <div style="font-size:12px;color:${C.mute};font-weight:600">${l}</div><div style="font-size:22px;font-weight:800;margin:2px 0;color:${col}">${v}</div><div style="font-size:12px;color:${C.mute}">${sub}</div></td>`;
  const T = []; // plain text
  const H = [];

  H.push(`<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink}"><div style="max-width:720px;margin:0 auto;padding:24px 16px">
    <div style="font-size:13px;color:${C.mute}">Production Planner · Town &amp; Country Cleaners</div><h1 style="margin:4px 0 16px;font-size:22px">${esc(longDay(day))}</h1>`);
  T.push(`PRODUCTION SUMMARY - ${longDay(day).toUpperCase()}`, "");
  const lateW = W.filter(w => !(w.readyAt != null && w.readyAt <= w.deadline + 1 / 60));
  H.push(`<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 -8px 8px"><tr>
    ${SHUTTLES ? tile("Shuttles", W.length ? `${onTime.length} of ${W.length}` : "—", W.length ? (lateW.length ? `late: ${esc(lateW.map(w => w.name).join(", "))}` : "ready on time") : "no deadlines today", W.length ? (lateW.length ? C.bad : C.good) : C.ink) : ""}
    ${tile("Due pieces done", R.due.pieces ? `${n0(R.due.finished)}` : "—", R.due.pieces ? `of ${n0(R.due.pieces)} due today` : "nothing due", R.due.pieces && R.due.finished < R.due.pieces ? C.warn : C.ink)}
    ${tile("Assembled", n0(R.done.pieces), `${L.perHour != null ? `${L.perHour.toFixed(1)} per labor hour` : "pieces"}`)}
    ${tile("Labor", pct(L.pct), `${usd(L.cost)} · target ${target}%`, L.pct == null ? C.ink : L.pct <= target ? C.good : C.bad)}
  </tr></table>`);

  // pieces by kind of work
  const pr = CATS.filter(k => R.due.q[k]).map(k => [CAT_FULL[k], R.due.q[k], R.due.done[k]]);
  if (pr.length) {
    H.push(h2("Today: pieces due"), table([th("Kind of work"), th("Due", "right"), th("Done", "right"), th("Left", "right")],
      [...pr.map(([n, d, f]) => `<tr>${td(esc(n))}${td(n0(d), "right")}${td(n0(f), "right")}${td(n0(d - f), "right", d - f > 0 ? `color:${C.warn};font-weight:700` : "")}</tr>`),
        `<tr>${td("<b>Total</b>")}${td(`<b>${n0(R.due.pieces)}</b>`, "right")}${td(`<b>${n0(R.due.finished)}</b>`, "right")}${td(`<b>${n0(R.due.pieces - R.due.finished)}</b>`, "right")}</tr>`]));
    T.push("TODAY - PIECES DUE", ...pr.map(([n, d, f]) => `  ${n.padEnd(22)} due ${n0(d).padStart(5)}  done ${n0(f).padStart(5)}  left ${n0(d - f).padStart(5)}`),
      `  Total due ${n0(R.due.pieces)}, done ${n0(R.due.finished)}`, "");
  }
  if (day === V.today && V.late?.length) { const over = V.late.filter(o => o.overdue).length; const t = `Orders still open past their due time: ${V.late.length}${over ? ` (${over} from earlier days)` : ""}.`; H.push(p(esc(t))); T.push(t, ""); }

  // shuttles and deadlines
  if (SHUTTLES && R.deadlines.length) {
    H.push(h2("Today: shuttles and deadlines"), table([th("Deadline"), th("Run"), th("Ready at"), th("Plan said"), th("Pieces", "right")], R.deadlines.map(w => {
      const sl = w.readyAt != null && w.deadline != null ? Math.round((w.deadline - w.readyAt) * 60) : null;
      const col = w.readyAt == null ? C.bad : sl == null ? C.good : sl < 0 ? C.bad : sl < 15 ? C.warn : C.good;
      const ready = w.readyAt == null ? `${n0(w.left)} not finished` : `${clock(w.readyAt)}${sl != null ? (sl < 0 ? ` · ${-sl} min late` : ` · ${sl} min spare`) : ""}`;
      return `<tr>${td(w.kind === "route" ? "Route" : w.deadline != null ? clock(w.deadline) : "—")}${td(`${esc(w.name)}<div style="font-size:12px;color:${C.mute}">${esc(w.stores.join(", "))}</div>`)}${td(ready, "left", `color:${col};font-weight:700`)}${td(w.plannedEta != null && isFinite(w.plannedEta) ? clock(w.plannedEta) : "—")}${td(n0(w.pieces), "right")}</tr>`;
    })));
    T.push("TODAY - SHUTTLES AND DEADLINES", ...R.deadlines.map(w => `  ${(w.kind === "route" ? "Route" : clock(w.deadline)).padEnd(9)} ${w.name.padEnd(28)} ${w.readyAt != null ? "ready " + clock(w.readyAt) : "not ready (" + n0(w.left) + " left)"}  ${n0(w.pieces)} pcs`), "");
  }
  if (ahead) { const t = `Worked ahead: ${n0(ahead)} of ${longDay(next)}'s pieces were finished today.`; H.push(p(esc(t))); T.push(t, ""); }

  // plan vs actual
  const pva = [
    ["Everyone done", pm?.end != null ? clock(pm.end) : "—", lastOut >= 0 ? `last clock-out ${clock(lastOut)}${stillIn ? " (some still clocked in)" : ""}` : "—"],
    ["Production hours", pm?.laborH != null ? hrs(pm.laborH) : "—", L.hours ? `${hrs(L.hours)} (${L.people} people)` : "—"],
    ["Pieces", pm?.pieces != null ? n0(pm.pieces) : "—", `${n0(R.done.pieces)} assembled`],
    ["Labor $", pmoney ? usd(pmoney.total) : "—", usd(L.cost)],
    ["Labor % of revenue", pmoney ? pct(pmoney.pct) : "—", `${pct(L.pct)} of ${usd(L.revenue)} assembled (target ${target}%)`],
  ];
  H.push(h2("Today: plan vs. actual"), table([th(""), th("Plan"), th("Actual")], pva.map(r => `<tr>${td(`<b>${r[0]}</b>`)}${td(esc(r[1]))}${td(esc(r[2]))}</tr>`)));
  if (!R.planned) H.push(p("No plan was saved for today.", `color:${C.mute}`));
  else H.push(p(`Plan: ${R.planned.source === "published" ? `published${R.planned.by ? ` by ${esc(R.planned.by)}` : ""}` : "saved, not published"}. Actual times and hours from Rippling.`, `color:${C.mute};font-size:12px`));
  T.push("TODAY - PLAN VS. ACTUAL", ...pva.map(r => `  ${r[0].padEnd(20)} plan: ${r[1]}   actual: ${r[2]}`), "");
  if (L.avgHours > 0.05) { const t = `${hrs(L.avgHours)} of today's hours are costed at the average rate ($${groups.money.payAvg}/h) — no pay rate from Rippling for them yet.`; H.push(p(esc(t), `color:${C.mute};font-size:12px`)); T.push(t, ""); }

  // crew
  const crew = R.people.filter(x => !x.missing);
  const noShow = R.people.filter(x => x.missing);
  H.push(h2("Today: crew"));
  if (crew.length) {
    H.push(table([th("Person"), th("Planned station"), th("In"), th("Out"), th("Hours", "right")], crew.map(x => `<tr>${td(`<b>${esc(x.name)}</b>`)}${td(esc(x.station || "not in the plan"), "left", x.unplanned ? `color:${C.warn}` : "")}${td(clock(x.actualIn))}${td(x.actualOut != null ? clock(x.actualOut) : "still in")}${td(hrs(x.actualHours || 0), "right")}</tr>`)));
    T.push("TODAY - CREW (Rippling)", ...crew.map(x => `  ${x.name.padEnd(22)} ${(x.station || "not in the plan").padEnd(22)} ${clock(x.actualIn)} - ${x.actualOut != null ? clock(x.actualOut) : "still in"}  ${hrs(x.actualHours || 0)}`));
  } else { H.push(p("No production clock-ins from Rippling today.", `color:${C.mute}`)); T.push("TODAY - CREW", "  No production clock-ins from Rippling today."); }
  if (noShow.length) { const t = `In the plan but didn't clock in: ${noShow.map(x => `${x.name} (${x.station})`).join(", ")}.`; H.push(p(esc(t), `color:${C.bad}`)); T.push("  " + t); }
  T.push("");

  // next work day
  H.push(h2(`Next work day: ${esc(longDay(next))}`)); T.push(`NEXT WORK DAY - ${longDay(next).toUpperCase()}`);
  if (!N) { H.push(p("No pieces are due that day yet.", `color:${C.mute}`)); T.push("  No pieces are due that day yet."); }
  else {
    const qtxt = N.expected ? `SMRT has ${n0(N.known)} pieces due so far; with what usually still comes in, the plan is for about ${n0(N.pieces)}.` : `${n0(N.pieces)} pieces to plan for.`;
    H.push(p(esc(qtxt))); T.push("  " + qtxt);
    const nq = CATS.filter(k => N.q[k] > 0);
    if (nq.length) H.push(p(nq.map(k => `${CAT_FULL[k]} <b>${n0(N.q[k])}</b>`).join(" · "), `color:${C.mute}`));
    H.push(p(`<b>Crew</b> (${esc(N.basis)}):`)); T.push(`  Crew (${N.basis}):`);
    if (N.crew.length) {
      H.push(table([th("Station"), th("Person"), th("Clock-in"), th("Hours", "right")], N.crew.map(c => `<tr>${td(esc(c.station))}${td(`<b>${esc(c.name)}</b>`)}${td(clock(t2h(c.start)))}${td(hrs(c.hours), "right")}</tr>`)));
      T.push(...N.crew.map(c => `  ${c.station.padEnd(22)} ${c.name.padEnd(22)} ${clock(t2h(c.start))}  ${hrs(c.hours)}`));
    } else { H.push(p("No one placed yet.")); T.push("  No one placed yet."); }
    if (N.end != null) {
      const proj = `Projected: everyone done about ${clock(N.end)}, ${hrs(N.laborH)} of labor (${usd(N.cost)}), ${pct(N.pct)} of revenue${N.otH > 0.04 ? `, ${hrs(N.otH)} overtime` : ", no overtime"}${N.short > 0.5 ? `, ${n0(N.short)} pieces wouldn't get done` : ""}.`;
      H.push(p(esc(proj), `font-weight:600;color:${N.short > 0.5 || (N.pct != null && N.pct > target) ? C.bad : C.ink}`)); T.push("  " + proj);
    }
  }
  H.push(`<p style="font-size:13px;margin:18px 0 0"><a href="${APP_URL}/#/plan?day=${next}" style="color:#2f6fdb">Open ${esc(longDay(next).split(",")[0])}'s plan</a> · <a href="${APP_URL}/#/review?day=${day}" style="color:#2f6fdb">Review today</a></p>
    <p style="font-size:12px;color:#8a93a5;margin:14px 0 0">Pieces and ready times from SMRT; hours from Rippling. Labor % = labor cost ÷ the value of the pieces assembled today.</p></div></body></html>`);
  T.push("", `Open the plan: ${APP_URL}/#/plan?day=${next}`, "- Production Planner");
  return { day, next, subject, html: H.join(""), text: T.join("\n") };
}

// ---------- MIME: plain text and HTML, both base64 ----------
const b64 = str => { const bytes = new TextEncoder().encode(str); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/.{76}/g, "$&\r\n"); };
const encWord = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s).replace(/\r\n/g, "")}?=`);
export function mime({ from, to, subject, html, text, now = Date.now() }) {
  const boundary = "b" + crypto.randomUUID().replace(/-/g, "");
  return [`From: Production Planner <${from}>`, `To: ${to}`, `Subject: ${encWord(subject)}`, `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@netexcleaners.com>`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(text), "",
    `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(html), "",
    `--${boundary}--`, ""].join("\r\n");
}

/** One message per recipient. `send(from, to, raw)` is injected in tests; in Cloudflare it wraps SEND_EMAIL. */
export async function deliver(env, msg, to, { send } = {}) {
  if (!send) {
    if (!env.SEND_EMAIL) return { sent: [], failed: to.map(rcpt => ({ to: rcpt, error: "Email sending isn't set up on the planner yet (the SEND_EMAIL binding is missing)." })) };
    const { EmailMessage } = await import("cloudflare:email");
    send = (from, rcpt, raw) => env.SEND_EMAIL.send(new EmailMessage(from, rcpt, raw));
  }
  const sent = [], failed = [];
  for (const rcpt of to) {
    try { await send(FROM, rcpt, mime({ from: FROM, to: rcpt, ...msg })); sent.push(rcpt); }
    catch (e) { failed.push({ to: rcpt, error: String(e.message || e) }); }
  }
  return { sent, failed };
}

async function record(db, env, today, msg, res, { test = false, userId = null } = {}) {
  // a test send is kept apart, so it never stops (or repeats) the day's real one
  await db.prepare(`INSERT INTO core_settings(org_id, app_id, key, value_json) VALUES(?, 'planner', ?, ?)
    ON CONFLICT(org_id, app_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), rev=rev+1`)
    .bind(env.ORG_ID, test ? "summary_test" : "summary_last", JSON.stringify({ day: today, for: msg.day, at: nowIso(), subject: msg.subject, sent: res.sent, failed: res.failed, test })).run();
  const text = (test ? "Test: " : "") + (res.sent.length ? `Daily summary emailed to ${res.sent.join(", ")}${res.failed.length ? ` (not delivered to ${res.failed.map(f => f.to).join(", ")})` : ""}` : `Daily summary couldn't be sent: ${res.failed.map(f => f.error).join("; ")}`);
  await db.prepare("INSERT INTO plan_events(id, org_id, day, key, kind, text, at, user_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(org_id, day, key) DO UPDATE SET text=excluded.text, at=excluded.at")
    .bind(ulid(), env.ORG_ID, today, test ? `summary-test-${Date.now()}` : "summary", "summary", text.slice(0, 300), nowIso(), userId).run();
}

/** Cron: after the set time on a work day, once a day, today's summary. */
export async function scheduledSummary(env, { now = Date.now(), send } = {}) {
  const db = env.DB, tz = env.TIMEZONE || "America/Chicago";
  const g = await loadGroups(db, env.ORG_ID), sum = g.summary;
  if (!sum.on || !sum.to.length) return { status: "off" };
  const { day: today, hm } = localNow(tz, new Date(now));
  if (!(g.day.workDays || [1, 2, 3, 4, 5]).includes(new Date(today + "T12:00:00Z").getUTCDay())) return { status: "not a work day" };
  if (hm < sum.at) return { status: "not yet" };
  const last = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='planner' AND key='summary_last'").bind(env.ORG_ID).first();
  const L = last ? JSON.parse(last.value_json) : null;
  if (L && L.day === today && L.sent?.length) return { status: "already sent" };
  if (L && L.day === today && (L.tries || 0) >= 3) return { status: "gave up" };
  const msg = await buildSummary(db, env, today, { now });
  const res = await deliver(env, msg, sum.to, { send });
  await record(db, env, today, msg, res);
  if (!res.sent.length) await db.prepare("UPDATE core_settings SET value_json=json_set(value_json, '$.tries', ?) WHERE org_id=? AND app_id='planner' AND key='summary_last'").bind((L && L.day === today ? L.tries || 0 : 0) + 1, env.ORG_ID).run();
  return { status: res.sent.length ? "sent" : "failed", ...res };
}

/** Settings › Send a test now: today's summary (or the last work day's) to the saved recipients or one address. */
export async function sendNow(db, env, me, { to = null, day = null } = {}, { send } = {}) {
  const g = await loadGroups(db, env.ORG_ID), today = localNow(env.TIMEZONE).day;
  const rcpt = to ? [String(to).trim().toLowerCase()] : g.summary.to;
  if (!rcpt.length) throw new HttpError(400, "Add someone to send it to first.");
  if (day && day > today) throw new HttpError(400, "That day hasn't happened yet.");
  const msg = await buildSummary(db, env, day || today);
  const res = await deliver(env, msg, rcpt, { send });
  await record(db, env, today, msg, res, { test: true, userId: me.id || null });
  return { subject: msg.subject, ...res };
}
