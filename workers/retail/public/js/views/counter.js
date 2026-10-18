// Counter (#/counter): customer visits, detailing speed, visits per labor hour, and the clock check
// (SMRT work that doesn't match Rippling punches) for managers to resolve.
import { api } from "../api.js";
import { html, raw, esc, toast, openDialog, RANK } from "../ui.js";
import { PRESETS, presetRange } from "./snapshot.js";

const nice = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
const niceY = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const wk = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short" });
const rangeTxt = (a, b) => (a === b ? niceY(a) : `${nice(a)} – ${niceY(b)}`);
const int = v => (v == null ? "—" : Math.round(v).toLocaleString());
const one = v => (v == null ? "—" : v.toFixed(1));
const hrs = v => (v == null ? "—" : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
const pct = (a, b) => (b ? `${Math.round(a / b * 100)}%` : "—");
const time12 = t => { if (!t) return "?"; const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };
const KIND = { wrong_store: "Wrong store", no_punch: "No punch", outside_hours: "Outside punched hours" };
const FIX = {
  wrong_store: "Change the work location on these Rippling time entries to the store they worked at.",
  no_punch: "Add the missing time entry in Rippling, or mark the person salaried if they don't clock in.",
  outside_hours: "Check the clock-in and clock-out times in Rippling for this day.",
};
const PRE = PRESETS.filter(([id]) => id !== "today");   // today's punches are still coming in

function readHash() {
  const q = new URLSearchParams((location.hash.split("?")[1]) || "");
  return { p: q.get("p"), from: q.get("from"), to: q.get("to") };
}
function writeHash(st) {
  const q = new URLSearchParams();
  if (st.p && st.p !== "custom") q.set("p", st.p); else { q.set("from", st.from); q.set("to", st.to); }
  const h = `#/counter?${q}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

export async function render(main, ctx) {
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  const h = readHash();
  const st = { p: h.p || (h.from && h.to ? "custom" : "lastweek"), from: h.from, to: h.to };
  if (st.p !== "custom") [st.from, st.to] = presetRange(st.p, today, ctx.weekStart);
  const manager = RANK[ctx.me.role] >= RANK.manager, admin = RANK[ctx.me.role] >= RANK.admin;

  const shell = () => {
    main.innerHTML = html`
      <div class="page-head">
        <div><h1>Counter</h1><p id="rangeLine">${rangeTxt(st.from, st.to)}</p></div>
        <div class="range">
          <div class="seg presets" role="tablist" aria-label="Date range">
            ${PRE.map(([id, name]) => raw(html`<button role="tab" data-p="${id}" aria-selected="${String(st.p === id)}">${name}</button>`))}
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
    writeHash(st);
    const body = main.querySelector("#body");
    let d;
    try { d = await api(`/counter?from=${st.from}&to=${st.to}`); }
    catch (e) { if (mine === seq) body.innerHTML = html`<div class="card empty"><h2>Couldn't add this up</h2><p>${e.message}</p></div>`; return; }
    if (mine !== seq) return;
    draw(body, d, { manager, admin, reload: load });
  };
  shell();
  await load();
}

function draw(body, d, { manager, admin, reload }) {
  const T = d.totals, c = d.settings;
  const open = d.checks.filter(x => !x.ok), done = d.checks.filter(x => x.ok);
  const days = new Set(d.checks.map(x => x.day)).size;
  const tiles = [
    { label: "Customer visits", num: int(T.visits), sub: `${pct(T.dropOnly, T.visits)} drop-off · ${pct(T.pickupOnly, T.visits)} pickup · ${pct(T.both, T.visits)} both`,
      tip: `One customer's tickets and pickups at one store within ${c.visitWindowMin} minutes of each other are one visit` },
    { label: "Visits per labor hour", num: T.visitsPerHour == null ? "—" : T.visitsPerHour.toFixed(1), sub: `${hrs(T.hours)} counter hours${T.salariedHours ? ` (${hrs(T.salariedHours)} salaried)` : ""}`,
      tip: "Visits ÷ (Rippling hours at the stores + salaried people's counted time)" },
    { label: "Seconds per piece", num: one(T.secPerPiece), sub: `${int(T.pieces)} pieces detailed · gaps of ${c.gapSec} s or more left out`,
      tip: `Average time between two pieces of one order. A gap of ${c.gapSec} seconds or more is a distraction gap and isn't counted here` },
    { label: "Distraction gaps", num: one(T.gapsPer100), sub: `per 100 pieces · ${int(T.gaps)} in all`, tip: `Pauses of ${c.gapSec} seconds or more while detailing an order` },
    { label: "Clock checks", num: int(open.length), sub: open.length ? "to resolve" : "nothing to resolve", warn: open.length > 0 },
  ];

  body.innerHTML = html`
    ${open.length ? raw(html`<div class="banner warn"><b>${open.length} clock ${open.length === 1 ? "check" : "checks"} to resolve.</b> SMRT shows work that doesn't match Rippling. <a href="#clock" data-jump>See them</a></div>`) : ""}
    <div class="tiles kpis">${tiles.map(k => raw(html`<div class="tile ${k.warn ? "warn" : ""}" ${raw(k.tip ? `title="${esc(k.tip)}"` : "")}><span class="t-label">${k.label}</span><span class="t-num">${k.num}</span><span class="t-sub">${k.sub}</span></div>`))}</div>

    <section class="card stable ctable" role="table" aria-label="Stores">
      <div class="srow head" role="row" style="--cols:9">
        <span role="columnheader">Store</span><span role="columnheader">Visits</span><span role="columnheader">Drop-off</span><span role="columnheader">Pickup</span><span role="columnheader">Both</span>
        <span role="columnheader" title="Rippling hours at the store plus salaried time">Hours</span><span role="columnheader">Visits / hr</span><span role="columnheader">Sec / piece</span><span role="columnheader" title="Distraction gaps per 100 pieces">Gaps / 100</span>
      </div>
      ${d.stores.length ? d.stores.map(s => raw(html`<div class="srow" role="row" style="--cols:9">
        <span role="cell" class="nm">${s.name}</span><span role="cell">${int(s.visits)}</span><span role="cell">${int(s.dropOnly)}</span><span role="cell">${int(s.pickupOnly)}</span><span role="cell">${int(s.both)}</span>
        <span role="cell">${hrs(s.hours)}${s.salariedHours ? raw(html`<small class="ot" title="${hrs(s.salariedHours)} h of salaried time counted">+${hrs(s.salariedHours)} sal.</small>`) : ""}</span>
        <span role="cell"><b>${s.visitsPerHour == null ? "—" : s.visitsPerHour.toFixed(1)}</b></span><span role="cell">${one(s.secPerPiece)}</span><span role="cell">${one(s.gapsPer100)}</span></div>`))
        : raw(html`<div class="empty-row">No store had anyone on the clock in this range.</div>`)}
      <div class="srow total grand" role="row" style="--cols:9">
        <span role="cell" class="nm">All stores</span><span role="cell">${int(T.visits)}</span><span role="cell">${int(T.dropOnly)}</span><span role="cell">${int(T.pickupOnly)}</span><span role="cell">${int(T.both)}</span>
        <span role="cell">${hrs(T.hours)}</span><span role="cell"><b>${T.visitsPerHour == null ? "—" : T.visitsPerHour.toFixed(1)}</b></span><span role="cell">${one(T.secPerPiece)}</span><span role="cell">${one(T.gapsPer100)}</span></div>
    </section>
    <p class="note-line">A visit is one customer's ticket(s) and pickup(s) at one store within ${c.visitWindowMin} minutes of each other. A drop-off counts when the ticket is created, so this depends on staff creating the ticket while the customer is at the counter. Route orders and Winnsboro aren't counted. Salaried staff's hours are their detailing time plus ${c.pickupMin} min per pickup while they're at the counter, shared with whoever else is on the clock.</p>

    <section class="card people-card">
      <div class="daily-head"><h2>Detailing by person</h2><span class="muted">Gaps of ${c.gapSec} s or more are distraction gaps (Settings)</span></div>
      <div class="stable" role="table" aria-label="Detailing by person">
        <div class="srow head" role="row" style="--cols:8">
          <span role="columnheader">Person</span><span role="columnheader">Store</span><span role="columnheader">Orders</span><span role="columnheader">Pieces</span>
          <span role="columnheader">Sec / piece</span><span role="columnheader">Gaps</span><span role="columnheader">Gaps / 100</span><span role="columnheader" title="Time spent in distraction gaps">Gap time</span>
        </div>
        ${d.people.map(p => raw(html`<div class="srow" role="row" style="--cols:8">
          <span role="cell" class="nm">${p.name}${p.salaried ? raw(html` <small class="chip" title="${hrs(p.salariedHours)} h counted">salaried · ${hrs(p.salariedHours)} h</small>`) : ""}</span>
          <span role="cell">${p.store}</span><span role="cell">${int(p.orders)}</span><span role="cell">${int(p.pieces)}</span>
          <span role="cell"><b>${one(p.secPerPiece)}</b></span><span role="cell">${int(p.gaps)}</span><span role="cell">${one(p.gapsPer100)}</span><span role="cell">${p.gapMin ? `${one(p.gapMin)} min` : "—"}</span></div>`))}
        ${d.people.length ? "" : raw(html`<div class="empty-row">No pieces detailed in this range.</div>`)}
      </div>
    </section>

    <section class="card clock-card" id="clock">
      <div class="daily-head"><h2>Clock check</h2><span class="muted">${d.checks.length ? `${open.length} to resolve · ${done.length} marked OK · ${days} day${days === 1 ? "" : "s"}` : "Finished days only"}</span></div>
      <p class="dlg-lead">SMRT work compared with Rippling for each person and day, through ${nice(d.checkedThrough)}. Fix the time entry in Rippling and the flag clears with the next sync (every 10 minutes on work days). If it's right as it is, mark it OK with a note.</p>
      ${open.length || done.length ? "" : raw(html`<div class="empty-row">Everyone's SMRT work matches their punches.</div>`)}
      <div class="checks">${[...open, ...done].map(x => raw(checkRow(x, { manager, admin })))}</div>
    </section>
    <p class="fresh">Seconds per piece = average time between two pieces of the same order by the same person, leaving out gaps of ${c.gapSec} s or more. Settings › Counter changes the gap, the pickup time and the visit window.</p>`;

  body.querySelector("[data-jump]")?.addEventListener("click", e => { e.preventDefault(); body.querySelector("#clock").scrollIntoView({ behavior: "smooth" }); });
  body.querySelectorAll("[data-ok]").forEach(b => b.addEventListener("click", () => {
    const x = d.checks.find(k => k.key === b.dataset.ok);
    openDialog({
      title: "Mark this OK", submitLabel: "Mark OK",
      body: html`<p class="dlg-lead"><b>${x.person}</b>, ${wk(x.day)} ${nice(x.day)}: ${x.text}.</p>
        <label class="field"><span>Why it's right as it is</span><input class="input" name="note" maxlength="200" placeholder="For example: worked Greenville tickets from Sulphur Springs" required></label>`,
      onSubmit: async form => {
        const note = form.elements.note.value.trim();
        if (!note) throw new Error("Say why it's OK.");
        await api("/counter/check", { method: "POST", body: { key: x.key, note } });
        toast("Marked OK."); reload();
      },
      onOpen: form => form.elements.note.focus(),
    });
  }));
  body.querySelectorAll("[data-reopen]").forEach(b => b.addEventListener("click", async () => {
    try { await api("/counter/check", { method: "POST", body: { key: b.dataset.reopen, ok: false } }); toast("Reopened."); reload(); }
    catch (e) { toast(e.message, "bad"); }
  }));
  body.querySelectorAll("[data-salaried]").forEach(b => b.addEventListener("click", async () => {
    const name = b.dataset.salaried;
    b.disabled = true;
    try {
      const { settings } = await api("/settings");
      if (!settings.counter.salaried.includes(name)) settings.counter.salaried.push(name);
      await api("/settings", { method: "PUT", body: settings });
      toast(`${name} is now counted as salaried.`); reload();
    } catch (e) { toast(e.message, "bad", 7000); b.disabled = false; }
  }));
}

function checkRow(x, { manager, admin }) {
  const smrt = x.smrt.map(m => `${m.store}: ${m.created ? `${m.created} ticket${m.created === 1 ? "" : "s"}, ` : ""}${m.pieces} piece${m.pieces === 1 ? "" : "s"}, ${time12(m.first)}–${time12(m.last)}`).join(" · ");
  const rip = x.rippling ? `${x.rippling.locations.join(", ")}, ${x.rippling.firstIn || "?"}–${x.rippling.lastOut || "?"} (${hrs(x.rippling.hours)} h)` : "no time entry";
  return html`<div class="check ${x.ok ? "is-ok" : ""}">
    <div class="check-top">
      <span class="chip ${x.ok ? "" : "manager"}">${KIND[x.kind]}</span>
      <b>${x.person}</b><span class="muted">${wk(x.day)} ${nice(x.day)}</span>
    </div>
    <p class="check-text">${x.text}.</p>
    <dl class="check-facts"><dt>SMRT</dt><dd>${smrt}</dd><dt>Rippling</dt><dd>${rip}</dd></dl>
    ${x.ok
      ? raw(html`<p class="check-ok">OK: “${x.ok.note}” — ${x.ok.by}${manager ? raw(html` <button class="btn small ghost" type="button" data-reopen="${x.key}">Reopen</button>`) : ""}</p>`)
      : raw(html`<p class="check-fix">${FIX[x.kind]}</p>${manager ? raw(html`<div class="check-actions"><button class="btn small" type="button" data-ok="${x.key}">Mark OK…</button>${x.kind === "no_punch" && admin ? raw(html`<button class="btn small ghost" type="button" data-salaried="${x.person}">Salaried — count without punches</button>`) : ""}</div>`) : ""}`)}
  </div>`;
}
