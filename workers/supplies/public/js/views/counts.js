// Counts: ask locations to count, see every count that came in, and enter a count yourself (e.g. the Workshop).
import { api } from "../api.js";
import { html, raw, toast, ago, openDialog, listen } from "../ui.js";
import { fmt, plural, renderSheet } from "/count/form.js";

const day = d => (d ? new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "");
const when = d => new Date(d).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ANSWER = { out: "Out", low: "Low", ok: "OK", need: "Needed", none: "Didn't need" };

export async function render(main, ctx) {
  const [ov, h] = await Promise.all([api("/overview"), api("/counts")]);
  const locs = new Map(ov.locations.map(l => [l.id, l]));
  main.innerHTML = html`
    <div class="page-head"><div><h1>Counts</h1><p>Ask a location to count and it shows on their count page until a count comes in. Stores count on their own device at <b>supplies.netexcleaners.com/count</b>.</p></div>
      ${ctx.canEdit ? raw(`<div class="head-actions"><button class="btn" id="enter">Enter a count</button><button class="btn primary" id="ask">Request counts</button></div>`) : ""}</div>
    <div class="card list">
      <div class="list-head lrow"><span>Location</span><span>Last count</span><span>Request</span><span>Devices</span></div>
      ${ov.locations.map(l => raw(html`<div class="lrow"><b>${l.label}</b><span>${l.lastCount ? ago(l.lastCount) : "Never"}</span>
        <span>${l.request ? raw(html`<span class="chip manager">Asked${l.request.dueOn ? ` · due ${day(l.request.dueOn)}` : ""}</span>${ctx.canEdit ? raw(html` <button class="linkish" data-cancel="${l.request.id}">cancel</button>`) : ""}`) : raw('<span class="muted">—</span>')}</span>
        <span>${l.devices ? `${l.devices} set up` : raw('<a href="#/setup">Set one up</a>')}</span></div>`))}
    </div>
    <h2 class="sec-h">Recent counts</h2>
    ${h.counts.length ? raw(html`<div class="card list">${h.counts.map(c => raw(html`<button class="srow as-btn" data-count="${c.id}">
        <div><b>${locs.get(c.locationId)?.label || "?"}</b><small>${when(c.at)} · ${c.countedBy}${c.device ? ` on ${c.device}` : ""}</small>${c.note ? raw(html`<small class="muted">“${c.note}”</small>`) : ""}</div>
        <div class="count-nums"><span>${c.items} counted</span><span class="${c.needs ? "warn-txt" : "muted"}">${c.needs} short</span></div></button>`))}</div>`)
      : raw('<p class="muted">No counts yet.</p>')}`;
  const signal = listen(main);
  main.querySelector("#ask")?.addEventListener("click", () => ask(main, ctx, ov.locations));
  main.querySelector("#enter")?.addEventListener("click", () => openDialog({
    title: "Enter a count", submitLabel: "Start",
    body: html`<p class="dlg-lead">For counting from this screen — the Workshop, or a store that called it in.</p>
      <label class="field"><span>Location</span><select class="input" name="loc">${ov.locations.map(l => raw(html`<option value="${l.id}">${l.label}</option>`))}</select></label>`,
    onSubmit(f) { location.hash = `#/count/${f.elements.loc.value}`; },
  }));
  main.addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.cancel) { await api(`/requests/${b.dataset.cancel}`, { method: "DELETE" }); toast("Request cancelled."); await render(main, ctx); }
      else if (b.dataset.count) showCount(await api(`/counts/${b.dataset.count}`));
    } catch (x) { toast(x.message, "bad"); }
  }, { signal });
}

function ask(main, ctx, locations) {
  openDialog({
    title: "Request counts", submitLabel: "Send request",
    body: html`<div class="field"><span>Where</span><div class="checks-grid">${locations.map(l => raw(html`<label class="check"><input type="checkbox" name="loc" value="${l.id}" ${raw(l.role === "store" ? "checked" : "")}> ${l.label}</label>`))}</div></div>
      <div class="two"><label class="field"><span>Due <em>(optional)</em></span><input class="input" type="date" name="due" value="${ctx.today}"></label>
      <label class="field"><span>Note <em>(optional)</em></span><input class="input" name="note" maxlength="200" placeholder="e.g. Before Monday's shuttle"></label></div>
      <p class="field-help">The request shows at the top of each location's count page until they send a count.</p>`,
    async onSubmit(f) {
      const ids = [...f.querySelectorAll("[name=loc]:checked")].map(i => i.value);
      if (!ids.length) throw new Error("Pick at least one location.");
      await api("/requests", { method: "POST", body: { locationIds: ids, dueOn: f.elements.due.value || null, note: f.elements.note.value } });
      toast(`Requested from ${ids.length} location${ids.length === 1 ? "" : "s"}.`); await render(main, ctx);
    },
  });
}

function showCount(c) {
  const short = c.lines.filter(l => l.need > 0);
  const dlg = openDialog({
    title: `${c.location} · ${when(c.at)}`, submitLabel: "Close",
    body: html`<p class="dlg-lead">Counted by ${c.countedBy}. ${c.lines.length} items answered, ${short.length} short.</p>
      ${c.note ? raw(html`<p class="store-note"><b>Note:</b> ${c.note}</p>`) : ""}
      <div class="count-detail"><table class="tbl"><thead><tr><th>Item</th><th class="n">Answer</th><th class="n">Par</th><th class="n">Short</th></tr></thead>
      <tbody>${c.lines.map(l => raw(html`<tr class="${l.need > 0 ? "is-short" : ""}"><td>${l.name}</td>
        <td class="n">${l.mode === "count" ? plural(l.qty, l.unit) : ANSWER[l.level] + (l.mode === "check" && l.qty ? ` (${fmt(l.qty)})` : "")}</td>
        <td class="n muted">${l.par == null ? "—" : fmt(l.par)}</td><td class="n">${l.need > 0 ? fmt(l.need) : ""}</td></tr>`))}</tbody></table></div>`,
    onSubmit() {},
  });
  dlg.classList.add("wide");
  dlg.querySelector("[data-close]").hidden = true;
}

/** #/count/<locationId>: the count sheet on this screen. */
export async function renderEntry(main, ctx, locationId) {
  if (!locationId) { location.hash = "#/counts"; return; }
  const { location: loc, items } = await api(`/sheet/${locationId}`);
  const KEY = `supplies-entry-${loc.id}`;
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  const warehouse = loc.role === "warehouse";
  main.innerHTML = html`
    <div class="page-head"><div><a class="back" href="#/counts">← Counts</a><h1>${warehouse ? "Workshop count" : `Count for ${loc.label}`}</h1>
      <p>${warehouse ? "Count in the unit shown (what you order in). Only answered items are saved, so you can count one vendor or shelf at a time." : "Enter what the store has on hand. Only answered items are saved."}</p></div></div>
    <div id="sheet" class="entry-sheet"></div>
    <div class="entry-bar card"><span id="prog"></span><label class="entry-note"><span class="sr">Note</span><input class="input" id="note" maxlength="1000" placeholder="Note (optional)"></label>
      <button class="btn ghost" id="clear" type="button">Clear</button><button class="btn primary" id="save" type="button">Save count</button></div>`;
  const prog = () => { const p = sheet.progress(); main.querySelector("#prog").innerHTML = html`<b>${p.done}</b> of ${p.total} answered · <b class="warn-txt">${sheet.lines().filter(l => l.need > 0).length}</b> short`; };
  const sheet = renderSheet(main.querySelector("#sheet"), { items, warehouse, answers: saved, onChange: A => { try { localStorage.setItem(KEY, JSON.stringify(A)); } catch {} prog(); } });
  prog();
  main.querySelector("#clear").addEventListener("click", () => { try { localStorage.removeItem(KEY); } catch {} renderEntry(main, ctx, locationId); });
  main.querySelector("#save").addEventListener("click", async e => {
    const lines = sheet.lines();
    if (!lines.length) return toast("Answer at least one item.", "warn");
    e.target.disabled = true;
    try {
      const r = await api("/counts", { method: "POST", body: { locationId: loc.id, note: main.querySelector("#note").value, lines: lines.map(({ item, qty, level }) => ({ item, qty, level })) } });
      try { localStorage.removeItem(KEY); } catch {}
      toast(`Saved: ${r.counted} counted, ${r.needs.length} short.`);
      location.hash = warehouse ? "#/orders" : "#/shuttle";
    } catch (x) { toast(x.message, "bad"); e.target.disabled = false; }
  });
}
