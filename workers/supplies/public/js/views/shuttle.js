// Shuttle: each store's open list (from its latest count), ready to adjust, print and mark sent.
import { api } from "../api.js";
import { html, raw, toast, ago, openDialog, listen } from "../ui.js";
import { fmt, plural } from "/count/form.js";
import { printShuttle } from "../print.js";

const day = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const PRINT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V4h10v5M7 17H5v-6h14v6h-2M8 14h8v6H8z"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

let state = null, catalog = null;

export async function render(main, ctx) {
  const [sh, ov] = await Promise.all([api("/shuttle"), api("/overview")]);
  state = sh;
  const stores = ov.locations.filter(l => l.role === "store");
  main.innerHTML = html`
    <div class="page-head"><div><h1>Shuttle</h1><p>What each location asked for in its latest count. Adjust what you're sending, print the slip to go with the items, then mark it sent. Next run: <b>${day(sh.nextShuttle)}</b>.</p></div>
      <div class="head-actions">${sh.open.length ? raw(`<button class="btn" id="printAll">${PRINT}Print all slips</button>`) : ""}
        ${ctx.canEdit ? raw(`<button class="btn" id="addList">${PLUS}Start a list</button>`) : ""}</div></div>
    <div class="loc-strip">${stores.map(l => raw(html`<a class="loc-tile ${l.openShipment ? "has" : ""} ${l.request ? "asked" : ""}" href="#/counts" ${raw(l.openShipment ? html`data-jump="${l.openShipment.id}"` : "")}>
      <b>${l.label}</b><span>${l.openShipment ? `${l.openShipment.lines} item${l.openShipment.lines === 1 ? "" : "s"} to send` : "Nothing waiting"}</span>
      <small>${l.request ? "Count requested" : l.lastCount ? `Counted ${ago(l.lastCount)}` : "Never counted"}</small></a>`))}</div>
    ${sh.open.length ? raw(sh.open.map(s => card(s, ctx)).join("")) : raw(html`<div class="card empty"><div class="ico"><svg viewBox="0 0 24 24"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/></svg></div><h2>No shuttle lists waiting</h2>
      <p>A list appears here as soon as a store or the Laundry Hub sends a count with something short. Use <b>Counts › Request counts</b> to ask them to count.</p></div>`)}
    ${sh.sent.length ? raw(html`<h2 class="sec-h">Sent in the last 7 days</h2><div class="card list sent-list">${sh.sent.map(s => raw(html`
      <div class="srow"><div><b>${s.location}</b><small>${s.lines.filter(l => Number(l.send) > 0).length} items · sent ${ago(s.sentAt)}${s.sentBy ? ` by ${s.sentBy}` : ""}</small></div>
        <div class="row-actions"><button class="btn ghost" data-print="${s.id}">${raw(PRINT)}Slip</button>${ctx.canEdit ? raw(html`<button class="btn ghost" data-reopen="${s.id}">Reopen</button>`) : ""}</div></div>`))}</div>`) : ""}`;
  wire(main, ctx, listen(main));
}

function card(s, ctx) {
  const ro = ctx.canEdit ? "" : "disabled";
  return html`<section class="card ship" id="ship-${s.id}" data-ship="${s.id}">
    <header class="ship-head"><div><h2>${s.location}</h2>
      <p>${s.countedBy ? `Counted by ${s.countedBy}, ${ago(s.countedAt)}` : "Started by the supply manager"} · goes ${raw(html`<input class="input mini" type="date" data-shipon value="${s.shipOn || ""}" ${raw(ro)} aria-label="Shuttle day">`)}</p></div>
      <div class="head-actions"><button class="btn" data-print="${s.id}">${raw(PRINT)}Print slip</button>
        ${ctx.canEdit ? raw(html`<button class="btn primary" data-sent="${s.id}">Mark sent</button>`) : ""}</div></header>
    ${s.note ? raw(html`<p class="store-note"><b>Note from the store:</b> ${s.note}</p>`) : ""}
    <table class="tbl"><thead><tr><th>Item</th><th class="n">Asked for</th><th class="n">Sending</th><th class="hide-sm">Workshop stock</th><th></th></tr></thead>
      <tbody>${s.lines.map(l => raw(html`<tr data-line="${l.id}">
        <td><b>${l.name}</b>${l.item ? "" : raw(' <span class="chip">write-in</span>')}</td>
        <td class="n muted">${l.need ? plural(l.need, l.unit || "") : "—"}</td>
        <td class="n"><span class="inwrap"><input class="input qty" inputmode="decimal" data-send value="${fmt(l.send)}" ${raw(ro)} aria-label="Sending: ${l.name}"><small>${l.unit || ""}</small></span></td>
        <td class="hide-sm muted">${l.workshop ? `${plural(l.workshop.qty, l.workshop.unit)} (${ago(l.workshop.at)})` : ""}</td>
        <td class="n">${ctx.canEdit ? raw(html`<button class="icon-btn" data-del title="Remove" aria-label="Remove ${l.name}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`) : ""}</td></tr>`))}</tbody></table>
    ${ctx.canEdit ? raw(html`<div class="ship-foot"><button class="btn ghost" data-add="${s.id}">${raw(PLUS)}Add an item</button><button class="btn ghost danger" data-drop="${s.id}">Drop this list</button></div>`) : ""}
  </section>`;
}

const find = id => [...state.open, ...state.sent].find(s => s.id === id);
function linesFrom(sec) {
  return [...sec.querySelectorAll("tr[data-line]")].map(tr => {
    const l = find(sec.dataset.ship).lines.find(x => x.id === tr.dataset.line);
    return { id: l.id, item: l.item, label: l.label, send: tr.querySelector("[data-send]").value };
  });
}
const timers = new Map();
function saveSoon(sec, extra = {}) {
  clearTimeout(timers.get(sec.dataset.ship));
  timers.set(sec.dataset.ship, setTimeout(async () => {
    try {
      await api(`/shuttle/${sec.dataset.ship}`, { method: "PUT", body: { lines: linesFrom(sec), ...extra } });
      const s = find(sec.dataset.ship);
      for (const ln of linesFrom(sec)) { const l = s.lines.find(x => x.id === ln.id); if (l) l.send = ln.send; }
    } catch (e) { toast(e.message, "bad"); }
  }, 500));
}

async function addItem(main, ctx, id) {
  catalog = catalog || await api("/catalog");
  const s = find(id);
  const loc = catalog.locations.find(l => l.id === s.locationId);
  const opts = catalog.items.filter(i => i.active).sort((a, b) => (b.pars[loc.id] ? 1 : 0) - (a.pars[loc.id] ? 1 : 0) || a.name.localeCompare(b.name));
  openDialog({
    title: `Add to ${s.location}`, submitLabel: "Add",
    body: html`<label class="field"><span>Item</span><select class="input" name="pick"><option value="">Write in something not on the list…</option>
        ${opts.map(i => raw(html`<option value="${i.id}">${i.name} (${i.unit})</option>`))}</select></label>
      <label class="field" data-label><span>Write-in</span><input class="input" name="label" maxlength="120" placeholder="e.g. New stapler"></label>
      <label class="field"><span>How many</span><input class="input" name="send" inputmode="decimal" value="1"></label>`,
    onOpen: f => { const sync = () => (f.querySelector("[data-label]").hidden = !!f.elements.pick.value); f.elements.pick.addEventListener("change", sync); sync(); f.elements.pick.focus(); },
    async onSubmit(f) {
      const sec = main.querySelector(`[data-ship="${id}"]`);
      const lines = [...linesFrom(sec), { item: f.elements.pick.value || null, label: f.elements.label.value, send: f.elements.send.value }];
      await api(`/shuttle/${id}`, { method: "PUT", body: { lines } });
      await render(main, ctx);
    },
  });
}

function wire(main, ctx, signal) {
  main.querySelector("#printAll")?.addEventListener("click", () => printShuttle(state.open.map(fresh)));
  main.querySelector("#addList")?.addEventListener("click", async () => {
    catalog = catalog || await api("/catalog");
    const stores = catalog.locations.filter(l => l.role === "store" && l.active);
    openDialog({
      title: "Start a shuttle list", submitLabel: "Start",
      body: html`<p class="dlg-lead">For sending something without waiting for a count. If the location already has an open list, you'll add to that one.</p>
        <label class="field"><span>Location</span><select class="input" name="loc">${stores.map(l => raw(html`<option value="${l.id}">${l.label}</option>`))}</select></label>`,
      async onSubmit(f) { const r = await api("/shuttle", { method: "POST", body: { locationId: f.elements.loc.value } }); await render(main, ctx); addItem(main, ctx, r.id); },
    });
  });
  main.addEventListener("input", e => {
    const sec = e.target.closest("[data-ship]");
    if (sec && e.target.matches("[data-send]")) { e.target.value = e.target.value.replace(/[^\d.]/g, ""); saveSoon(sec); }
  }, { signal });
  main.addEventListener("change", e => {
    const sec = e.target.closest("[data-ship]");
    if (sec && e.target.matches("[data-shipon]") && e.target.value) { find(sec.dataset.ship).shipOn = e.target.value; saveSoon(sec, { shipOn: e.target.value }); }
  }, { signal });
  main.addEventListener("click", async e => {
    const jump = e.target.closest("[data-jump]");
    if (jump) { e.preventDefault(); main.querySelector(`[data-ship="${jump.dataset.jump}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const b = e.target.closest("button"); if (!b) return;
    const sec = b.closest("[data-ship]");
    try {
      if (b.dataset.print) printShuttle([fresh(find(b.dataset.print))]);
      else if (b.dataset.sent) {
        clearTimeout(timers.get(b.dataset.sent));
        await api(`/shuttle/${b.dataset.sent}`, { method: "PUT", body: { lines: linesFrom(sec) } });
        await api(`/shuttle/${b.dataset.sent}/sent`, { method: "POST" });
        toast(`${find(b.dataset.sent).location} marked sent.`); await render(main, ctx);
      } else if (b.dataset.reopen) { await api(`/shuttle/${b.dataset.reopen}/reopen`, { method: "POST" }); await render(main, ctx); }
      else if (b.dataset.drop) {
        if (!confirmDrop(b)) return;
        await api(`/shuttle/${b.dataset.drop}/drop`, { method: "POST" }); toast("List dropped."); await render(main, ctx);
      } else if (b.dataset.add) addItem(main, ctx, b.dataset.add);
      else if (b.hasAttribute("data-del")) { b.closest("tr").remove(); saveSoon(sec); }
    } catch (x) { toast(x.message, "bad"); }
  }, { signal });
}
// two-tap confirm (no browser dialogs)
function confirmDrop(b) {
  if (b.dataset.armed) return true;
  b.dataset.armed = "1"; const t = b.textContent; b.textContent = "Tap again to drop";
  setTimeout(() => { delete b.dataset.armed; b.textContent = t; }, 3000);
  return false;
}
// the slip uses what's on screen right now
function fresh(s) {
  const sec = document.querySelector(`[data-ship="${s.id}"]`);
  if (!sec) return s;
  const vals = new Map(linesFrom(sec).map(l => [l.id, l.send]));
  return { ...s, shipOn: sec.querySelector("[data-shipon]")?.value || s.shipOn, lines: s.lines.filter(l => vals.has(l.id)).map(l => ({ ...l, send: vals.get(l.id) })) };
}
