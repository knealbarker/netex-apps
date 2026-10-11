// Daily summary email: yesterday's sales, revenue, hours and labor % by store, plus week-to-date and month-to-date.
// Sent by this Worker's hourly cron at Settings › Daily summary's hour (Central time), on the chosen days, once a day.
// Mail goes out through Cloudflare Email Routing's send_email binding (SEND_EMAIL) from reports@netexcleaners.com.
// Cloudflare only delivers to addresses verified under Email Routing › Destination addresses.
import { snapshot, addDays, localToday, weekStartOf } from "./snapshot.js";
import { loadSettings } from "./settings.js";

const FROM = "reports@netexcleaners.com";
const APP_URL = "https://retailview.netexcleaners.com";
const OWNER = { role: "owner" };   // the email always carries labor numbers; who receives it is set by an Admin

const usd = v => (v == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v));
const pct = v => (v == null ? "—" : `${v.toFixed(1)}%`);
const hrs = v => (v == null ? "—" : v.toFixed(1));
const esc = v => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const longDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
const shortDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

/** Builds the email for `day` (normally yesterday). */
export async function buildSummary(db, env, day, { now = Date.now() } = {}) {
  const s = await loadSettings(db, env);
  const y = await snapshot(db, env, OWNER, day, day, { now });
  const wFrom = weekStartOf(day, s.weekStart), mFrom = day.slice(0, 8) + "01";
  const w = await snapshot(db, env, OWNER, wFrom, day, { now });
  const m = await snapshot(db, env, OWNER, mFrom, day, { now });
  const tr = s.targetRetail;
  const R = y.totals.retail, C = y.totals.company;
  const flag = v => (v == null ? "" : v <= tr ? "✓" : "▲");
  const color = v => (v == null ? "#5d6779" : v <= tr ? "#12a36b" : v <= tr + 3 ? "#b77806" : "#d83347");

  const subject = `Retail snapshot · ${shortDay(day)} · sales ${usd(C.sales)} · store labor ${pct(R.laborPct)}`;
  const td = (v, opts = "") => `<td style="padding:7px 10px;border-bottom:1px solid #e1e6ef;text-align:right;${opts}">${v}</td>`;
  const th = v => `<th style="padding:7px 10px;border-bottom:2px solid #d3dae6;text-align:right;font-size:12px;color:#5d6779;text-transform:uppercase;letter-spacing:.04em">${v}</th>`;
  const storeRow = (l, bold = false) => `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid #e1e6ef;${bold ? "font-weight:700" : ""}">${esc(l.name)}${l.parts?.length ? `<div style="font-size:12px;color:#8a93a5">incl. ${esc(l.parts.filter(p => p.name !== l.name).map(p => p.name).join(", "))}</div>` : ""}</td>
      ${td(usd(l.sales), bold ? "font-weight:700" : "")}${td(usd(l.revenue), bold ? "font-weight:700" : "")}${td(hrs(l.hours))}${td(usd(l.cost))}
      ${td(`${pct(l.laborPct)} ${flag(l.laborPct)}`, `font-weight:700;color:${color(l.laborPct)}`)}</tr>`;
  const plantRow = p => `<tr><td style="padding:7px 10px;border-bottom:1px solid #e1e6ef;color:#5d6779">${esc(p.name)} <span style="font-size:12px">production</span></td>
      ${td("")}${td("")}${td(hrs(p.hours))}${td(usd(p.cost))}${td(`${pct(p.laborPct)}`, "color:#5d6779")}</tr>`;
  const period = (label, x) => `<tr><td style="padding:7px 10px;border-bottom:1px solid #e1e6ef;font-weight:600">${label}<div style="font-size:12px;color:#8a93a5">${shortDay(x.from)} – ${shortDay(x.to)}</div></td>
      ${td(usd(x.totals.company.sales))}${td(usd(x.totals.company.revenue))}${td(pct(x.totals.company.collectedPct))}
      ${td(`${pct(x.totals.retail.laborPct)} ${flag(x.totals.retail.laborPct)}`, `font-weight:700;color:${color(x.totals.retail.laborPct)}`)}${td(pct(x.totals.company.laborPct))}</tr>`;
  const notes = [];
  if (C.estPct) notes.push(`${C.estPct}% of yesterday's hours are costed at an average rate (no pay rate from Rippling yet).`);
  if (!y.freshness?.hoursFrom) notes.push("No store hours from Rippling yet.");
  if (R.otHours) notes.push(`${hrs(R.otHours)} store hours yesterday were overtime.`);

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#141b2b">
  <div style="max-width:720px;margin:0 auto;padding:24px 16px">
    <div style="font-size:13px;color:#5d6779">Retail Snapshot · Town &amp; Country Cleaners</div>
    <h1 style="margin:4px 0 16px;font-size:22px">${longDay(day)}</h1>
    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 -8px 16px"><tr>
      ${[["Sales", usd(C.sales), `${C.orders} orders detailed`], ["Revenue", usd(C.revenue), "paid yesterday"],
         ["Store labor", `<span style="color:${color(R.laborPct)}">${pct(R.laborPct)} ${flag(R.laborPct)}</span>`, `target ${tr}% · ${usd(R.cost)}`],
         ["Total labor", pct(C.laborPct), `stores + production · ${usd(C.cost)}`]]
        .map(([l, v, sub]) => `<td style="background:#fff;border:1px solid #e1e6ef;border-radius:12px;padding:12px 14px;vertical-align:top;width:25%">
          <div style="font-size:12px;color:#5d6779;font-weight:600">${l}</div><div style="font-size:22px;font-weight:800;margin:2px 0">${v}</div><div style="font-size:12px;color:#5d6779">${sub}</div></td>`).join("")}
    </tr></table>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e1e6ef;border-radius:12px;font-size:14px">
      <tr><th style="padding:7px 10px;border-bottom:2px solid #d3dae6;text-align:left;font-size:12px;color:#5d6779;text-transform:uppercase;letter-spacing:.04em">Store</th>${th("Sales")}${th("Revenue")}${th("Hours")}${th("Labor $")}${th("Labor %")}</tr>
      ${y.stores.map(l => storeRow(l)).join("")}
      ${storeRow({ ...R, name: "All stores" }, true)}
      ${y.plants.map(plantRow).join("")}
    </table>
    <h2 style="font-size:16px;margin:22px 0 8px">So far</h2>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e1e6ef;border-radius:12px;font-size:14px">
      <tr><th style="padding:7px 10px;border-bottom:2px solid #d3dae6;text-align:left;font-size:12px;color:#5d6779;text-transform:uppercase;letter-spacing:.04em">Period</th>${th("Sales")}${th("Revenue")}${th("Collected")}${th("Store labor")}${th("Total labor")}</tr>
      ${period("Week to date", w)}${period("Month to date", m)}
    </table>
    ${notes.length ? `<p style="font-size:13px;color:#5d6779;margin:14px 0 0">${notes.map(esc).join("<br>")}</p>` : ""}
    <p style="font-size:13px;margin:18px 0 0"><a href="${APP_URL}/#/snapshot?p=yesterday" style="color:#2f6fdb">Open the Retail Snapshot</a></p>
    <p style="font-size:12px;color:#8a93a5;margin:14px 0 0">Sales = orders detailed; revenue = orders paid; both before tax, credited to the store the order was detailed into.
      ${s.overtime ? `Overtime (over ${s.overtimeAfter} h a week) at ${s.overtimeMultiplier}×.` : ""}${s.burdenPct ? ` Labor $ includes ${s.burdenPct}% payroll burden.` : ""}</p>
  </div></body></html>`;

  const text = [`Retail snapshot — ${longDay(day)}`, "",
    `Sales ${usd(C.sales)} (${C.orders} orders) · Revenue ${usd(C.revenue)} · Store labor ${pct(R.laborPct)} (target ${tr}%) · Total labor ${pct(C.laborPct)}`, "",
    ...y.stores.map(l => `${l.name}: sales ${usd(l.sales)}, revenue ${usd(l.revenue)}, ${hrs(l.hours)} h, labor ${pct(l.laborPct)}`),
    ...y.plants.map(p => `${p.name}: ${hrs(p.hours)} h, ${usd(p.cost)} (${pct(p.laborPct)} of revenue)`), "",
    `Week to date: sales ${usd(w.totals.company.sales)}, revenue ${usd(w.totals.company.revenue)}, store labor ${pct(w.totals.retail.laborPct)}, total ${pct(w.totals.company.laborPct)}`,
    `Month to date: sales ${usd(m.totals.company.sales)}, revenue ${usd(m.totals.company.revenue)}, store labor ${pct(m.totals.retail.laborPct)}, total ${pct(m.totals.company.laborPct)}`,
    ...(notes.length ? ["", ...notes] : []), "", `${APP_URL}/#/snapshot?p=yesterday`].join("\n");
  return { subject, html, text, day };
}

// ---------- MIME (no library needed: two base64 parts) ----------
const b64 = str => { const bytes = new TextEncoder().encode(str); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/.{76}/g, "$&\r\n"); };
const encWord = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s).replace(/\r\n/g, "")}?=`);
export function mime({ from, to, subject, html, text, now = Date.now() }) {
  const boundary = "b" + crypto.randomUUID().replace(/-/g, "");
  return [
    `From: Retail Snapshot <${from}>`, `To: ${to}`, `Subject: ${encWord(subject)}`, `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@netexcleaners.com>`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(text), "",
    `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(html), "",
    `--${boundary}--`, "",
  ].join("\r\n");
}

/** Sends one message per recipient. `send(from, to, raw)` is injected in tests; in Cloudflare it wraps SEND_EMAIL. */
export async function deliver(env, msg, to, { send } = {}) {
  if (!send) {
    if (!env.SEND_EMAIL) throw new Error("Email sending isn't set up on this Worker (the SEND_EMAIL binding is missing).");
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

const hourIn = (tz, at) => +new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(at);

/** Hourly cron: sends yesterday's summary at the set hour on the set days, once a day. */
export async function scheduledSummary(env, { now = Date.now(), send } = {}) {
  const db = env.DB, tz = env.TIMEZONE || "America/Chicago";
  const s = await loadSettings(db, env);
  const sum = s.summary;
  if (!sum.enabled || !sum.to.length) return { status: "off" };
  const today = localToday(tz, new Date(now));
  if (hourIn(tz, new Date(now)) < sum.hour) return { status: "not yet" };
  if (!sum.days.includes(new Date(today + "T12:00:00Z").getUTCDay())) return { status: "not a send day" };
  const last = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='retail' AND key='summary_last'").bind(env.ORG_ID).first();
  if (last && JSON.parse(last.value_json).day === today) return { status: "already sent" };
  const day = addDays(today, -1);
  const msg = await buildSummary(db, env, day, { now });
  const res = await deliver(env, msg, sum.to, { send });
  await db.prepare(`INSERT INTO core_settings(org_id, app_id, key, value_json) VALUES(?, 'retail', 'summary_last', ?)
    ON CONFLICT(org_id, app_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), rev=rev+1`)
    .bind(env.ORG_ID, JSON.stringify({ day: today, for: day, at: new Date(now).toISOString(), ...res })).run();
  return { status: res.sent.length ? "sent" : "failed", for: day, ...res };
}
