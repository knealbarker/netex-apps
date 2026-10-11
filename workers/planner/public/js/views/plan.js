// Plan: the pieces to plan for today or the next work day, straight from SMRT (via the shared database).
// The crew, station times and publishing are added on top of this in the next stage.
import { api } from "../api.js";
import { html, raw, ago } from "../ui.js";

const CATS = [["dct", "DC tops"], ["dcb", "DC bottoms"], ["slt", "Starch tops"], ["slb", "Starch bottoms"], ["comf", "Comforters"], ["tc", "Tablecloths"]];
const SMRT_ORDER = (customer, no) => `https://towncountryclean.smrtapp.com/posx/dash/customer/clothestracker/${encodeURIComponent(customer)}/?saleId=${String(no).replace(/\D/g, "")}`;
const fmtDay = (d, today) => {
  const s = new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return d === today ? `Today · ${s}` : s;
};
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
const n = v => Math.round(v).toLocaleString();

let pick = null; // the day being looked at (kept while switching tabs)

export async function render(main) {
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Reading pieces…</div>`;
  const V = await api("/pieces");
  const days = [V.isWorkDay ? V.today : null, V.next].filter(Boolean);
  if (!days.includes(pick)) pick = days[0];
  draw();

  function smrtPill() {
    const last = V.smrt.lastOk, run = V.smrt.lastRun;
    if (!last && !run) return html`<span class="pill">SMRT live updates start on the next work day</span>`;
    const mins = last ? (Date.now() - Date.parse(last)) / 60000 : Infinity;
    const stale = V.isWorkDay && mins > 30;
    const err = run && run.status === "error";
    return html`<span class="pill ${err || stale ? "warn" : "ok"}" title="${run?.message || ""}"><i></i>${err ? "SMRT update failed · " : ""}SMRT updated ${last ? ago(last).toLowerCase() : "—"}</span>`;
  }

  function draw() {
    const D = V.days[pick];
    const isNext = pick === V.next && !D.isToday;
    const anyExpected = isNext && D.expectedTotal > D.todo + 2;
    const withOverdue = !isNext || !V.isWorkDay; // on a day off the next work day is the next "today": overdue work belongs to it
    main.innerHTML = html`
      <div class="page-head">
        <div><h1>Plan</h1><p>${isNext ? `Pieces due on the next work day, less anything already finished${withOverdue ? ", plus open pieces from overdue orders" : ""}.` : "Pieces due today, plus open pieces from overdue orders."}</p></div>
        <div class="head-actions">${raw(smrtPill())}</div>
      </div>
      <div class="seg" role="tablist" aria-label="Day">${days.map(d => raw(html`<button role="tab" aria-selected="${d === pick}" data-day="${d}">${fmtDay(d, V.today)}</button>`))}</div>

      <section class="tiles" aria-label="Pieces by kind of work">
        ${CATS.map(([k, label]) => {
          const todo = D.q[k], done = D.done[k], exp = D.expected[k];
          const over = withOverdue ? V.overdue.q[k] : 0;
          const pct = todo ? Math.min(100, Math.round((done / todo) * 100)) : 0;
          return raw(html`<div class="tile ${todo + over ? "" : "zero"}">
            <span class="t-label">${label}</span>
            <b class="t-num">${n(isNext && anyExpected ? exp : todo + over)}</b>
            <span class="t-sub">${isNext ? (anyExpected && exp > todo ? `expected · ${n(todo)} due so far` : "due so far") : `${n(done)} done · ${n(Math.max(0, todo - done) + over)} left`}</span>
            ${!isNext ? raw(html`<span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span>`) : ""}
            ${over ? raw(html`<span class="t-over">incl. ${n(over)} overdue</span>`) : ""}
          </div>`);
        })}
        <div class="tile total"><span class="t-label">All pieces</span>
          <b class="t-num">${n((isNext && anyExpected ? D.expectedTotal : D.todo) + (withOverdue ? V.overdue.todo : 0))}</b>
          <span class="t-sub">${isNext ? (D.aheadToday ? `${n(D.aheadToday)} already done today` : `${n(D.orders)} orders`) : `${n(D.doneTotal)} done today · ${n(D.orders)} orders`}</span></div>
      </section>

      ${anyExpected ? raw(html`<p class="note-line">“Expected” adds what usually still comes in by each store's drop-off cutoff (based on the last ${V.forecast.basedOn || "few"} ${new Date(pick + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" })}s). Stores past their cutoff are final.</p>`) : ""}
      ${V.undetailed?.[pick] ? raw(html`<p class="note-line">${n(V.undetailed[pick])} more pieces are on orders that aren't detailed yet and have several departments; they're counted once SMRT has their pieces.</p>`) : ""}
      ${Object.keys(V.unmapped).length ? raw(html`<div class="banner"><b>Not planned:</b> ${Object.entries(V.unmapped).map(([d, c]) => `${c} in ${d}`).join(" · ")}. <a href="#/settings" class="linkish">Map them in Settings › SMRT mapping</a> if they belong to production.</div>`) : ""}

      <section class="card set-card">
        <header><h2>By deadline</h2><p>${isNext ? "Each shuttle run and the store counter, with expected totals." : "Each shuttle run and the store counter. Work in this order."}</p></header>
        ${D.stores.length ? raw(html`<div class="dl-table" role="table">
          <div class="dl-row dl-head" role="row"><span role="columnheader">Store</span>${CATS.map(([k, l]) => raw(html`<span role="columnheader" class="num">${l}</span>`))}<span role="columnheader" class="num">Total</span></div>
          ${D.stores.map(s => {
            const vals = isNext ? s.expected : s.q, tot = Object.values(vals).reduce((a, b) => a + b, 0);
            return raw(html`<div class="dl-row" role="row"><span role="cell"><b>${s.loc}</b><small>${s.run || "No run set"}${isNext && !s.final && s.ratio > 1 ? ` · ×${s.ratio.toFixed(2)} expected` : isNext && s.final ? " · final" : ""}</small></span>
              ${CATS.map(([k]) => raw(html`<span role="cell" class="num ${vals[k] ? "" : "dim"}">${vals[k] ? n(vals[k]) : "–"}</span>`))}<span role="cell" class="num"><b>${n(tot)}</b></span></div>`);
          })}</div>`) : raw('<p class="muted">Nothing due yet.</p>')}
      </section>

      ${withOverdue ? raw(lateCard()) : ""}

      <section class="card empty next-stage">
        <div class="ico"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.9-5 5.5-5s4.9 1.8 5.5 5"/><path d="M16 8h5M18.5 5.5v5"/></svg></div>
        <h2>Crew, station times and publishing come next</h2>
        <p>These piece counts are what the plan will be built on. Keep using the desktop app to plan the day for now.</p>
      </section>`;
    main.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => { pick = b.dataset.day; draw(); main.querySelector(`[data-day="${pick}"]`)?.focus(); }));
  }

  function lateCard() {
    const rows = V.late;
    if (!rows.length) return html`<section class="card set-card"><header><h2>Late &amp; overdue orders</h2><p>None right now.</p></header></section>`;
    return html`<section class="card set-card"><header><h2>Late &amp; overdue orders <span class="count">${rows.length}</span></h2>
        <p>Orders due today or earlier that aren't finished. Where the pieces are comes from SMRT's item and lot status.</p></header>
      <div class="late-list">${rows.slice(0, 60).map(o => raw(html`<div class="late ${o.overdue ? "over" : ""}">
        <div class="l-main"><a href="${o.customer ? SMRT_ORDER(o.customer, o.no) : "#"}" target="_blank" rel="noopener" class="l-no" title="Open in SMRT">${o.no}</a>
          <span class="chip ${o.overdue ? "off" : "manager"}">${o.overdue ? `Overdue · due ${new Date(o.due).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : `Due ${fmtTime(o.due)}`}</span>
          ${o.notes ? raw(html`<span class="chip" title="This order or one of its pieces has a note in SMRT">Note</span>`) : ""}</div>
        <div class="l-meta"><span>${o.loc}</span><span>${o.left} of ${o.pieces} pieces left</span><span>${o.status}</span></div>
        <div class="l-where">${Object.entries(o.open).map(([k, c]) => raw(html`<span>${c} ${k}</span>`))}</div>
      </div>`))}</div>${rows.length > 60 ? raw(html`<p class="muted">…and ${rows.length - 60} more.</p>`) : ""}</section>`;
  }
}
