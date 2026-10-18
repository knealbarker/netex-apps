// Snapshot (#/snapshot) and Hours (#/hours): one data call per date range, two ways to look at it.
//   Snapshot: company tiles, the store table (with Workshop / Laundry Hub and the company total), daily charts and table.
//   Hours:    who worked where, day by day, for one store or all of them.
import { api } from "../api.js";
import { html, raw, esc } from "../ui.js";

export const PRESETS = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["last7", "Last 7 days"], ["week", "This week"],
  ["lastweek", "Last week"], ["month", "This month"], ["lastmonth", "Last month"],
];
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = d => new Date(d + "T12:00:00Z").getUTCDay();
export function presetRange(p, today, weekStart = 1) {
  const monday = d => addDays(d, -((dow(d) - weekStart + 7) % 7));
  const first = d => d.slice(0, 8) + "01";
  switch (p) {
    case "today": return [today, today];
    case "yesterday": return [addDays(today, -1), addDays(today, -1)];
    case "week": return [monday(today), today];
    case "lastweek": { const m = addDays(monday(today), -7); return [m, addDays(m, 6)]; }
    case "month": return [first(today), today];
    case "lastmonth": { const end = addDays(first(today), -1); return [first(end), end]; }
    default: return [addDays(today, -7), addDays(today, -1)];   // last 7 complete days
  }
}

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const $f = v => (v == null ? "—" : Math.abs(v) < 100 ? usd2.format(v) : usd0.format(v));
const hrs = v => (v == null ? "—" : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
const pctTxt = v => (v == null ? "—" : `${v.toFixed(1)}%`);
const intTxt = v => (v == null ? "—" : Math.round(v).toLocaleString());
const nice = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
const niceY = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const wk = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short" });
const rangeTxt = (a, b) => (a === b ? niceY(a) : `${nice(a)} – ${niceY(b)}`);

/** Labor % against target: a word as well as a color, so it never relies on color alone. */
function laborBadge(v, target) {
  if (v == null) return html`<span class="lp none">—</span>`;
  const cls = v <= target ? "good" : v <= target + 3 ? "warn" : "bad";
  const word = v <= target ? "under" : "over";
  return html`<span class="lp ${cls}" title="${word} the ${target}% target"><b>${pctTxt(v)}</b><i aria-hidden="true">${v <= target ? "✓" : "▲"}</i><span class="sr">${word} target</span></span>`;
}
function delta(cur, prev, { kind = "money", lowerIsBetter = false } = {}) {
  if (cur == null || prev == null) return "";
  if (kind === "pct") {
    const d = cur - prev; if (Math.abs(d) < 0.05) return html`<span class="dl flat">same as before</span>`;
    const good = lowerIsBetter ? d < 0 : d > 0;
    return html`<span class="dl ${good ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} pts</span>`;
  }
  if (!prev) return "";
  const d = (cur - prev) / Math.abs(prev) * 100; if (Math.abs(d) < 0.5) return html`<span class="dl flat">same as before</span>`;
  const good = lowerIsBetter ? d < 0 : d > 0;
  return html`<span class="dl ${good ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(0)}%</span>`;
}

// ---------- state: the range lives in the address (#/snapshot?p=last7 or ?from=..&to=..) so a link opens the same view
function readHash() {
  const q = new URLSearchParams((location.hash.split("?")[1]) || "");
  return { p: q.get("p"), from: q.get("from"), to: q.get("to"), store: q.get("store") || "" };
}
function writeHash(view, st) {
  const q = new URLSearchParams();
  if (st.p && st.p !== "custom") q.set("p", st.p); else { q.set("from", st.from); q.set("to", st.to); }
  if (st.store) q.set("store", st.store);
  const h = `#/${view}?${q}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

let tipEl = null;
function tooltip(root) {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tip"; tipEl.hidden = true; document.body.append(tipEl); }
  root.querySelectorAll("[data-tip]").forEach(el => {
    const show = e => {
      tipEl.innerHTML = el.dataset.tip; tipEl.hidden = false;
      const r = tipEl.getBoundingClientRect(), x = (e.clientX ?? el.getBoundingClientRect().x) + 14, y = (e.clientY ?? el.getBoundingClientRect().y) - r.height - 10;
      tipEl.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`; tipEl.style.top = `${Math.max(8, y)}px`;
    };
    el.addEventListener("mousemove", show); el.addEventListener("focus", show);
    el.addEventListener("mouseleave", () => (tipEl.hidden = true)); el.addEventListener("blur", () => (tipEl.hidden = true));
  });
}

// ---------- charts (single series each; one y-axis each) ----------
function niceMax(v) { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); }
function barChart(rows, { value, label, fmt, title }) {
  const W = 760, H = 220, L = 54, R = 10, T = 14, B = 28, n = rows.length;
  const max = niceMax(Math.max(...rows.map(value), 0));
  const bw = (W - L - R) / n, gap = Math.min(6, bw * 0.25);
  const y = v => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.5, 1].map(f => max * f);
  const every = Math.ceil(n / 12);
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
    ${raw(ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`).join(""))}
    ${raw(rows.map((r, i) => {
      const v = value(r), x = L + i * bw + gap / 2, h = Math.max(0, y(0) - y(v)), w = Math.max(1, bw - gap);
      const rr = Math.min(4, w / 2, h);
      const path = h > 0 ? `M${x},${y(0)} V${y(v) + rr} q0,-${rr} ${rr},-${rr} H${x + w - rr} q${rr},0 ${rr},${rr} V${y(0)} Z` : "";
      return `<g class="hit" tabindex="0" data-tip="${esc(label(r))}"><rect class="hitbox" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}"/>${path ? `<path class="bar1" d="${path}"/>` : ""}</g>`
        + (i % every === 0 ? `<text class="ax" x="${L + i * bw + bw / 2}" y="${H - 9}" text-anchor="middle">${esc(n > 14 ? nice(r.day).replace(/^\w+ /, "") : wk(r.day))}</text>` : "");
    }).join(""))}
    <line class="base" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>
  </svg>`;
}
function lineChart(rows, { value, label, target, title }) {
  const W = 760, H = 220, L = 54, R = 10, T = 14, B = 28, n = rows.length;
  const vals = rows.map(value).filter(v => v != null);
  const max = niceMax(Math.max(target * 1.5, ...vals, 1));
  const step = n > 1 ? (W - L - R) / (n - 1) : 0;
  const x = i => (n > 1 ? L + i * step : (L + W - R) / 2), y = v => T + (H - T - B) * (1 - Math.min(v, max) / max);
  const segs = []; let cur = [];
  rows.forEach((r, i) => { const v = value(r); if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
  if (cur.length) segs.push(cur);
  const every = Math.ceil(n / 12), hitW = n > 1 ? step : W - L - R;
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
    ${raw([0, max / 2, max].map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t.toFixed(0)}%</text>`).join(""))}
    <line class="target" x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}"/>
    <text class="ax tgt" x="${W - R}" y="${y(target) - 6}" text-anchor="end">target ${target}%</text>
    ${raw(segs.map(s => `<polyline class="line1" points="${s.map(p => p.join(",")).join(" ")}"/>`).join(""))}
    ${raw(rows.map((r, i) => {
      const v = value(r);
      return `<g class="hit" tabindex="0" data-tip="${esc(label(r))}"><rect class="hitbox" x="${x(i) - hitW / 2}" y="${T}" width="${hitW}" height="${H - T - B}"/>${v != null ? `<circle class="dot1 ${v > target ? "over" : ""}" cx="${x(i)}" cy="${y(v)}" r="4.5"/>` : ""}</g>`
        + (i % every === 0 ? `<text class="ax" x="${x(i)}" y="${H - 9}" text-anchor="middle">${esc(n > 14 ? nice(r.day).replace(/^\w+ /, "") : wk(r.day))}</text>` : "");
    }).join(""))}
  </svg>`;
}

// ---------- page ----------
export async function render(main, ctx, view) {
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  const h = readHash();
  const st = { p: h.p || (h.from && h.to ? "custom" : "last7"), from: h.from, to: h.to, store: h.store };
  if (st.p !== "custom") [st.from, st.to] = presetRange(st.p, today, ctx.weekStart);

  const shell = () => {
    main.innerHTML = html`
      <div class="page-head">
        <div><h1>${view === "hours" ? "Hours by store" : "Retail Snapshot"}</h1><p id="rangeLine">${rangeTxt(st.from, st.to)}</p></div>
        <div class="range">
          <div class="seg presets" role="tablist" aria-label="Date range">
            ${PRESETS.map(([id, name]) => raw(html`<button role="tab" data-p="${id}" aria-selected="${String(st.p === id)}">${name}</button>`))}
          </div>
          <div class="custom">
            <label><span class="sr">From</span><input class="input" type="date" id="from" value="${st.from}" max="${today}"></label>
            <span class="muted">to</span>
            <label><span class="sr">To</span><input class="input" type="date" id="to" value="${st.to}" max="${today}"></label>
          </div>
        </div>
      </div>
      <div id="body"><div class="loading"><span class="spin"></span>Adding up…</div></div>`;
    main.querySelectorAll("[data-p]").forEach(b => b.addEventListener("click", () => { st.p = b.dataset.p; [st.from, st.to] = presetRange(st.p, today, ctx.weekStart); shell(); load(); }));
    const onDate = () => {
      const a = main.querySelector("#from").value, b = main.querySelector("#to").value;
      if (!a || !b) return;
      st.p = "custom"; st.from = a <= b ? a : b; st.to = a <= b ? b : a; shell(); load();
    };
    main.querySelector("#from").addEventListener("change", onDate);
    main.querySelector("#to").addEventListener("change", onDate);
  };

  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    writeHash(view, st);
    const body = main.querySelector("#body");
    let d;
    try { d = await api(`/snapshot?from=${st.from}&to=${st.to}`); }
    catch (e) { if (mine === seq) body.innerHTML = html`<div class="card empty"><h2>Couldn't add this up</h2><p>${e.message}</p></div>`; return; }
    if (mine !== seq) return;
    main.querySelector("#rangeLine").textContent = `${rangeTxt(d.from, d.to)} · compared with ${rangeTxt(d.prevRange.from, d.prevRange.to)}`;
    if (view === "hours") renderHours(body, d, st);
    else renderSnapshot(body, d, st);
    tooltip(body);
  };
  shell();
  await load();
}

function notes(d) {
  const out = [];
  const f = d.freshness || {};
  if (!f.hoursFrom) out.push(html`<div class="banner warn"><b>No store hours yet.</b> Store hours arrive with the next Rippling email (every 10 minutes on work days), or the Owner can load the Rippling CSV under Settings.</div>`);
  else if (f.hoursFrom > d.from) out.push(html`<div class="banner"><b>Store hours start ${niceY(f.hoursFrom)}</b> (when Rippling began). Days before that have sales and revenue but no labor, so labor % for this range reads low.</div>`);
  const est = d.totals.company.estPct;
  if (d.labor && est > 0) out.push(html`<div class="banner"><b>${est}% of hours are costed at an average rate</b> because their pay rate isn't in the Rippling report yet. Rates come in by themselves once the report has a pay rate column; until then the averages are under Settings.</div>`);
  return out.map(raw);
}

function renderSnapshot(body, d, st) {
  const t = d.totals, R = t.retail, C = t.company, P = t.plant, tr = d.targets.retail, tp = d.targets.plant;
  const tiles = [
    { label: "Sales", num: $f(C.sales), sub: html`${intTxt(C.orders)} orders detailed · ${raw(delta(C.sales, C.prev?.sales))}`, tip: "Pre-tax value of orders detailed in this range" },
    { label: "Revenue", num: $f(C.revenue), sub: html`paid in this range · ${raw(delta(C.revenue, C.prev?.revenue))}`, tip: "Pre-tax value of orders paid in this range" },
    { label: "Sales collected", num: pctTxt(C.collectedPct), sub: html`${$f(C.collected)} of this range's sales is paid`, tip: "Of the sales detailed in this range, how much has been paid so far" },
    { label: "Store hours", num: hrs(R.hours), sub: html`${R.salesPerHour != null ? `${$f(R.salesPerHour)} sales per hour` : "no hours yet"}${R.otHours ? ` · ${hrs(R.otHours)} overtime` : ""} · ${raw(delta(R.hours, R.prev?.hours, { lowerIsBetter: true }))}` },
  ];
  if (d.labor) {
    tiles.push({ label: "Store labor %", num: raw(laborBadge(R.laborPct, tr)), sub: html`${$f(R.cost)} store labor · target ${tr}% · ${raw(delta(R.laborPct, R.prev?.laborPct, { kind: "pct", lowerIsBetter: true }))}`, big: true });
    if (d.plants.length) tiles.push({ label: "Production labor %", num: raw(laborBadge(P.laborPct, tp)), sub: html`${$f(P.cost)} labor · ${$f(P.work)} production value · target ${tp}% · ${raw(delta(P.laborPct, P.prev?.laborPct, { kind: "pct", lowerIsBetter: true }))}`, tip: "Workshop + Laundry Hub labor $ divided by the value of the pieces they finished" });
    tiles.push({ label: "Total labor %", num: pctTxt(C.laborPct), sub: html`all labor ${$f(C.cost)} ÷ revenue`, tip: "All labor (stores, Workshop, Laundry Hub) divided by company revenue" });
  }

  const cols = d.labor ? 9 : 7;
  const row = (l, { cls = "", sub = false, plant = false, base = plant ? tp : tr } = {}) => html`
    <div class="srow ${cls} ${sub ? "sub" : ""}" role="row" style="--cols:${cols}">
      <span role="cell" class="nm">${sub ? raw("<i aria-hidden='true'>↳</i>") : ""}${l.name}${plant && !cls.includes("total") ? raw(" <small>production</small>") : ""}</span>
      <span role="cell">${plant ? raw(html`${intTxt(l.workPieces)} <small class="unit">pcs</small>`) : intTxt(l.orders)}</span>
      <span role="cell">${plant ? raw(html`<span title="Value of the pieces finished here">${$f(l.work)}</span> <small class="unit">value</small>`) : $f(l.sales)}</span>
      <span role="cell">${plant ? "" : $f(l.revenue)}</span>
      <span role="cell">${plant ? "" : pctTxt(l.collectedPct)}</span>
      <span role="cell">${hrs(l.hours)}${d.overtime && l.otHours ? raw(html`<small class="ot" title="${hrs(l.otHours)} overtime hours, costed at ${d.overtime.multiplier}×">${hrs(l.otHours)} OT</small>`) : ""}</span>
      <span role="cell">${plant ? $f(l.workPerHour) : $f(l.salesPerHour)}</span>
      ${d.labor ? raw(html`<span role="cell">${$f(l.cost)}${l.estPct ? raw(html` <small class="est" title="${l.estPct}% of these hours use an average rate">est</small>`) : ""}</span>
        <span role="cell">${sub && !l.hours ? raw(html`<span class="lp none" title="Its labor is counted in the store it rolls into">—</span>`) : raw(laborBadge(l.laborPct, base))}</span>`) : ""}
    </div>`;
  const header = raw(html`<div class="srow head" role="row" style="--cols:${cols}">
      <span role="columnheader">Store</span><span role="columnheader">Orders</span><span role="columnheader">Sales</span><span role="columnheader">Revenue</span>
      <span role="columnheader" title="Share of these sales already paid">Collected</span><span role="columnheader">Hours</span><span role="columnheader">Sales / hr</span>
      ${d.labor ? raw(html`<span role="columnheader">Labor $</span><span role="columnheader">Labor %</span>`) : ""}</div>`);

  const lines = [...d.stores.map(s => s.name), ...d.plants.map(p => p.name)];
  const pick = st.store && lines.includes(st.store) ? st.store : "";
  const series = d.daily.map(x => ({ day: x.day, ...(pick ? x.lines[pick] : x.retail), company: x.company }));
  const isPlant = d.plants.some(p => p.name === pick);
  const unmapped = d.unmappedWork || [];

  body.innerHTML = html`
    ${notes(d)}
    <div class="tiles kpis">${tiles.map(k => raw(html`<div class="tile ${k.big ? "accent" : ""}" ${raw(k.tip ? `title="${esc(k.tip)}"` : "")}><span class="t-label">${k.label}</span><span class="t-num">${k.num}</span><span class="t-sub">${raw(k.sub)}</span></div>`))}</div>

    <section class="card stable" role="table" aria-label="Stores">
      ${header}
      ${d.stores.length ? d.stores.map(s => raw([row(s), ...s.parts.map(p => row(p, { sub: true }))].join(""))) : raw(html`<div class="empty-row">No sales or hours in this range.</div>`)}
      ${raw(row({ ...R, name: "All stores" }, { cls: "total" }))}
      ${d.plants.map(p => raw(row(p, { plant: true, cls: "plant" })))}
      ${d.plants.length > 1 ? raw(row({ ...P, name: "All production", workPerHour: P.hours > 0 ? P.work / P.hours : null }, { plant: true, cls: "total" })) : ""}
      ${raw(row({ ...C, name: "Company" }, { cls: "total grand" }))}
    </section>
    <p class="note-line">Sales count when an order is detailed; revenue when it's paid. Both are before tax and go to the store the order was detailed into. Workshop and Laundry Hub are measured on production value: the pre-tax value of the pieces they finished (assembled, or ready for wash &amp; fold).${d.overtime ? ` Hours over ${d.overtime.after} in a work week cost ${d.overtime.multiplier}×.` : ""}${d.labor && d.burdenPct ? ` Labor $ includes ${d.burdenPct}% payroll burden.` : ""}</p>

    <section class="card daily">
      <div class="daily-head">
        <h2>Day by day</h2>
        <label class="inline"><span>Show</span>
          <select class="input" id="pick"><option value="">All stores</option>${lines.map(n => raw(html`<option ${raw(n === pick ? "selected" : "")}>${n}</option>`))}</select></label>
      </div>
      ${d.days.length > 1 ? raw(html`
        <div class="charts">
          ${!isPlant ? raw(html`<figure><figcaption>Revenue by day${pick ? ` · ${pick}` : " · all stores"}</figcaption>
            ${raw(barChart(series, { value: r => r.revenue || 0, fmt: v => usd0.format(v), title: "Revenue by day", label: r => `<b>${wk(r.day)} ${nice(r.day)}</b><br>Revenue ${$f(r.revenue)}<br>Sales ${$f(r.sales)}` }))}</figure>`) : ""}
          ${d.labor && !isPlant ? raw(html`<figure><figcaption>Labor % by day${pick ? ` · ${pick}` : " · all stores"}</figcaption>
            ${raw(lineChart(series, { value: r => r.laborPct, target: tr, title: "Labor percent by day", label: r => `<b>${wk(r.day)} ${nice(r.day)}</b><br>Labor ${r.laborPct == null ? "—" : r.laborPct.toFixed(1) + "%"}<br>${$f(r.cost)} labor · ${$f(r.revenue)} revenue` }))}</figure>`) : ""}
          ${isPlant ? raw(html`<figure><figcaption>Production value by day · ${pick}</figcaption>
            ${raw(barChart(series, { value: r => r.work || 0, fmt: v => usd0.format(v), title: "Production value by day", label: r => `<b>${wk(r.day)} ${nice(r.day)}</b><br>${$f(r.work)} value · ${intTxt(r.workPieces)} pieces<br>${hrs(r.hours)} hours` }))}</figure>`) : ""}
          ${isPlant && d.labor ? raw(html`<figure><figcaption>Labor % of production value · ${pick}</figcaption>
            ${raw(lineChart(series, { value: r => r.laborPct, target: tp, title: "Production labor percent by day", label: r => `<b>${wk(r.day)} ${nice(r.day)}</b><br>Labor ${r.laborPct == null ? "—" : r.laborPct.toFixed(1) + "%"}<br>${$f(r.cost)} labor · ${$f(r.work)} value` }))}</figure>`) : ""}
        </div>`) : ""}
      <div class="dtable" role="table" aria-label="Day by day">
        <div class="drow head" role="row" style="--cols:${d.labor ? 7 : 5}"><span>Day</span>${isPlant ? raw("<span>Pieces</span><span>Value</span><span>Value / hr</span>") : raw("<span>Orders</span><span>Sales</span><span>Revenue</span>")}<span>Hours</span>${d.labor ? raw("<span>Labor $</span><span>Labor %</span>") : ""}</div>
        ${series.slice().reverse().map(r => raw(html`<div class="drow ${r.day === d.today ? "is-today" : ""}" role="row" style="--cols:${d.labor ? 7 : 5}">
          <span>${wk(r.day)} ${nice(r.day)}${r.day === d.today ? raw(" <small class='chip'>so far</small>") : ""}</span><span>${isPlant ? intTxt(r.workPieces) : intTxt(r.orders)}</span><span>${isPlant ? $f(r.work) : $f(r.sales)}</span><span>${isPlant ? $f(r.hours > 0 ? r.work / r.hours : null) : $f(r.revenue)}</span><span>${hrs(r.hours)}</span>
          ${d.labor ? raw(html`<span>${$f(r.cost)}</span><span>${raw(laborBadge(r.laborPct, isPlant ? tp : tr))}</span>`) : ""}</div>`))}
      </div>
    </section>
    ${unmapped.length && d.plants.length ? raw(html`<p class="note-line">Not counted in production value: ${unmapped.map(u => `${u.dept} (${u.pieces} pcs)`).join(", ")}. An Admin can assign these departments under Settings › Production work.</p>`) : ""}
    ${freshLine(d)}`;
  body.querySelector("#pick").addEventListener("change", e => { st.store = e.target.value; writeHash("snapshot", st); renderSnapshot(body, d, st); tooltip(body); });
}

function freshLine(d) {
  const f = d.freshness || {};
  const when = iso => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");
  return raw(html`<p class="fresh">SMRT last read ${when(f.smrt?.at)}${f.smrt?.status === "error" ? " (with an error)" : ""} · Rippling last read ${when(f.rippling?.at)}${f.hoursThrough ? ` · finished days through ${nice(f.hoursThrough)}` : ""}</p>`);
}

function renderHours(body, d, st) {
  const lines = [...d.stores.map(s => s.name), ...d.plants.map(p => p.name)];
  const pick = st.store && lines.includes(st.store) ? st.store : "";
  const people = d.people.filter(p => !pick || p.line === pick);
  const groups = pick ? [pick] : lines.filter(n => people.some(p => p.line === n));
  const many = d.days.length > 31;
  const days = d.days;
  body.innerHTML = html`
    ${notes(d).slice(0, 1)}
    <div class="hours-bar">
      <label class="inline"><span>Store</span>
        <select class="input" id="pick"><option value="">All stores</option>${lines.map(n => raw(html`<option ${raw(n === pick ? "selected" : "")}>${n}</option>`))}</select></label>
      <span class="muted">${people.length} ${people.length === 1 ? "person" : "people"} · ${hrs(people.reduce((t, p) => t + p.hours, 0))} hours</span>
    </div>
    ${many ? raw(html`<div class="banner">That's ${days.length} days — showing totals per person. Pick a shorter range to see each day.</div>`) : ""}
    ${groups.length ? groups.map(g => {
      const ps = people.filter(p => p.line === g);
      const dayTot = days.map(dd => ps.reduce((t, p) => t + (p.days[dd] || 0), 0));
      return raw(html`<section class="card hgrid-card">
        <h2>${g} <small class="muted">${hrs(ps.reduce((t, p) => t + p.hours, 0))} h</small></h2>
        <div class="hgrid" role="table" aria-label="Hours at ${g}" style="--days:${many ? 0 : days.length}">
          <div class="hrow head" role="row"><span role="columnheader">Person</span>${many ? "" : raw(days.map(dd => html`<span role="columnheader" class="${dd === d.today ? "is-today" : ""}">${wk(dd).slice(0, 2)}<br>${nice(dd).replace(/^\w+ /, "")}</span>`).join(""))}<span role="columnheader">Total</span></div>
          ${ps.map(p => raw(html`<div class="hrow" role="row"><span role="cell" class="nm">${p.name}${p.live ? raw(" <i class='live' title='On the clock now'></i>") : ""}<small>${p.depts.join(", ")}</small></span>
            ${many ? "" : raw(days.map(dd => `<span role="cell" class="${p.days[dd] ? "" : "zero"} ${dd === d.today ? "is-today" : ""}">${p.days[dd] ? hrs(p.days[dd]) : "·"}</span>`).join(""))}
            <span role="cell" class="tot">${hrs(p.hours)}${p.otHours ? raw(html`<small class="ot">${hrs(p.otHours)} OT</small>`) : ""}</span></div>`))}
          <div class="hrow total" role="row"><span role="cell">Total</span>${many ? "" : raw(dayTot.map((v, i) => `<span role="cell" class="${days[i] === d.today ? "is-today" : ""}">${v ? hrs(v) : "·"}</span>`).join(""))}<span role="cell" class="tot">${hrs(dayTot.reduce((a, b) => a + b, 0))}</span></div>
        </div></section>`);
    }) : raw(html`<div class="card empty"><h2>No hours in this range</h2><p>Hours come from Rippling's time clock report.</p></div>`)}
    ${freshLine(d)}`;
  body.querySelector("#pick").addEventListener("change", e => { st.store = e.target.value; writeHash("hours", st); renderHours(body, d, st); });
}
