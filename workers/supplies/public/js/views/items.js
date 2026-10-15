// Supply list: every item, its vendor and units, and what each location keeps (par, reorder point, how they answer).
import { api } from "../api.js";
import { html, raw, toast, openDialog, listen } from "../ui.js";
import { fmt } from "/count/form.js";

const MODES = [["count", "Count"], ["level", "Out / Low / OK"], ["check", "Need any?"]];
const MODE_TAG = { count: "", level: "OLK", check: "?" };
let cat = null, filt = { q: "", vendor: "", loc: "", review: false, inactive: false };

export async function render(main, ctx) {
  cat = await api("/catalog");
  const short = l => ({ "Sulphur Springs Workshop": "Workshop", "Sulphur Springs Retail": "SS", "Laundry Hub": "Hub" })[l.label] || l.label.replace(/ Retail$/, "");
  const reviewN = cat.items.filter(i => i.reviewNote && i.active).length;
  main.innerHTML = html`
    <div class="page-head"><div><h1>Supply list</h1><p>${cat.items.filter(i => i.active).length} items. A number is the par (keep this many); <b>OLK</b> = answered Out / Low / OK, <b>?</b> = “Need any?”. Workshop numbers are in the unit you order in.</p></div>
      ${ctx.canEdit ? raw(`<div class="head-actions"><button class="btn primary" id="add">Add an item</button></div>`) : ""}</div>
    ${reviewN ? raw(html`<div class="banner warn"><b>${reviewN} item${reviewN === 1 ? "" : "s"} to check.</b> Questions left from turning the old order sheets into this list (units, case counts, vendors). Open one, fix it, and clear the question. <button class="linkish" id="showReview">Show them</button></div>`) : ""}
    <div class="filters card">
      <input class="input" type="search" id="q" placeholder="Find an item or item #" value="${filt.q}">
      <select class="input" id="vendor"><option value="">All vendors</option>${cat.vendors.map(v => raw(html`<option value="${v.id}" ${raw(filt.vendor === v.id ? "selected" : "")}>${v.name}</option>`))}</select>
      <select class="input" id="loc"><option value="">Every location</option>${cat.locations.map(l => raw(html`<option value="${l.id}" ${raw(filt.loc === l.id ? "selected" : "")}>Kept at ${l.label}</option>`))}</select>
      <label class="check"><input type="checkbox" id="review" ${raw(filt.review ? "checked" : "")}> To check</label>
      <label class="check"><input type="checkbox" id="inactive" ${raw(filt.inactive ? "checked" : "")}> Show removed</label>
    </div>
    <div class="card t-scroll"><table class="tbl items-tbl">
      <thead><tr><th>Item</th><th class="hide-sm">Vendor</th><th class="hide-sm">Unit</th>${cat.locations.map(l => raw(html`<th class="n loc-col" title="${l.label}">${short(l)}</th>`))}</tr></thead>
      <tbody id="rows"></tbody></table></div>`;
  const vname = new Map(cat.vendors.map(v => [v.id, v.name]));
  const paint = () => {
    const q = filt.q.toLowerCase();
    const rows = cat.items.filter(i => (filt.inactive || i.active) && (!q || `${i.name} ${i.sku || ""}`.toLowerCase().includes(q)) && (!filt.vendor || i.vendorId === filt.vendor)
      && (!filt.loc || i.pars[filt.loc]) && (!filt.review || i.reviewNote));
    main.querySelector("#rows").innerHTML = rows.length ? rows.map(i => html`<tr class="${i.active ? "" : "removed"}" data-item="${i.id}" tabindex="0">
      <td><b>${i.name}</b>${i.reviewNote ? raw(' <span class="chip manager">check</span>') : ""}${i.active ? "" : raw(' <span class="chip off">removed</span>')}<small class="sub">${i.category}${i.sku ? ` · #${i.sku}` : ""}</small></td>
      <td class="hide-sm muted">${vname.get(i.vendorId) || "—"}</td>
      <td class="hide-sm muted">${i.unit}${i.bulkUnit ? ` / ${i.bulkUnit}` : ""}</td>
      ${cat.locations.map(l => { const p = i.pars[l.id]; return raw(p ? html`<td class="n par">${p.par == null ? "AN" : fmt(p.par)}${p.mode !== "count" ? raw(html`<i>${MODE_TAG[p.mode]}</i>`) : ""}</td>` : '<td class="n faint">·</td>'); })}
    </tr>`).join("") : html`<tr><td colspan="${3 + cat.locations.length}" class="muted none">No items match.</td></tr>`;
  };
  paint();
  const signal = listen(main);
  const bind = (id, k, ev = "input", get = e => e.target.value) => main.querySelector(id).addEventListener(ev, e => { filt[k] = get(e); paint(); });
  bind("#q", "q"); bind("#vendor", "vendor", "change"); bind("#loc", "loc", "change");
  bind("#review", "review", "change", e => e.target.checked); bind("#inactive", "inactive", "change", e => e.target.checked);
  main.querySelector("#showReview")?.addEventListener("click", () => { filt.review = true; main.querySelector("#review").checked = true; paint(); });
  main.querySelector("#add")?.addEventListener("click", () => edit(main, ctx, null));
  const open = e => { const tr = e.target.closest("tr[data-item]"); if (tr) edit(main, ctx, cat.items.find(i => i.id === tr.dataset.item)); };
  main.addEventListener("click", open, { signal });
  main.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("tr[data-item]")) open(e); }, { signal });
}

function edit(main, ctx, it) {
  const n = it || { name: "", category: "", unit: "each", pars: {}, active: true };
  const cats = [...new Set(cat.items.map(i => i.category))].sort();
  const ro = ctx.canEdit ? "" : "disabled";
  const dlg = openDialog({
    title: it ? it.name : "Add an item", submitLabel: ctx.canEdit ? "Save" : "Close",
    body: html`
      ${n.reviewNote ? raw(html`<div class="banner warn"><b>To check:</b> ${n.reviewNote}<label class="check"><input type="checkbox" name="cleared" ${raw(ro)}> Checked — clear this</label></div>`) : ""}
      <fieldset ${raw(ro)} class="plain">
      <label class="field"><span>Name</span><input class="input" name="name" maxlength="120" value="${n.name}" required></label>
      <div class="two"><label class="field"><span>Vendor</span><select class="input" name="vendor"><option value="">None</option>${cat.vendors.map(v => raw(html`<option value="${v.id}" ${raw(n.vendorId === v.id ? "selected" : "")}>${v.name}</option>`))}</select></label>
        <label class="field"><span>Vendor item #</span><input class="input" name="sku" maxlength="40" value="${n.sku || ""}"></label></div>
      <div class="two"><label class="field"><span>Group</span><input class="input" name="category" list="cats" maxlength="40" value="${n.category}"><datalist id="cats">${cats.map(c => raw(html`<option value="${c}">`))}</datalist></label>
        <label class="field"><span>Cost per order unit <em>(optional)</em></span><input class="input" name="cost" inputmode="decimal" value="${n.unitCost ?? ""}" placeholder="$"></label></div>
      <div class="two"><label class="field"><span>Store unit</span><input class="input" name="unit" maxlength="30" value="${n.unit}" placeholder="roll, bottle, box (1000)"><small>What stores count and what goes on the shuttle.</small></label>
        <label class="field"><span>Workshop / order unit <em>(if different)</em></span><input class="input" name="bulk" maxlength="30" value="${n.bulkUnit || ""}" placeholder="case"><small>What the Workshop counts and you order.</small></label></div>
      <div class="field"><span>Where it's kept</span>
        <div class="par-grid"><div class="pg-head"><span>Location</span><span>Par</span><span>Reorder at</span><span>How they answer</span></div>
        ${cat.locations.map(l => { const p = n.pars[l.id]; return raw(html`<div class="pg-row ${p ? "" : "off"}" data-loc="${l.id}">
          <label class="check"><input type="checkbox" data-kept ${raw(p ? "checked" : "")}> ${l.label}</label>
          <input class="input" data-par inputmode="decimal" placeholder="as needed" value="${p && p.par != null ? p.par : ""}" aria-label="${l.label} par">
          <input class="input" data-reorder inputmode="decimal" placeholder="below par" value="${p && p.reorder != null ? p.reorder : ""}" aria-label="${l.label} reorder at">
          <select class="input" data-mode aria-label="${l.label}: how they answer">${MODES.map(([k, t]) => raw(html`<option value="${k}" ${raw((p?.mode || (l.role === "warehouse" ? "count" : "count")) === k ? "selected" : "")}>${t}</option>`))}</select></div>`); })}
        </div><small>Par = keep this many on hand. Reorder at = only ask once it's down to this (leave blank to ask as soon as it's below par). Out / Low / OK sends a full par for Out and half for Low.</small></div>
      <label class="field"><span>Note shown when counting <em>(optional)</em></span><input class="input" name="notes" maxlength="300" value="${n.notes || ""}"></label>
      ${it ? raw(html`<label class="switch"><div><b>On the list</b><small>Turn off to remove it everywhere (history is kept).</small></div><input type="checkbox" name="active" ${raw(n.active ? "checked" : "")}></label>`) : ""}
      </fieldset>`,
    onOpen: f => {
      f.addEventListener("change", e => { const row = e.target.closest(".pg-row"); if (row && e.target.matches("[data-kept]")) row.classList.toggle("off", !e.target.checked); });
      if (!it) f.elements.name.focus();
    },
    async onSubmit(f) {
      if (!ctx.canEdit) return;
      const pars = {};
      f.querySelectorAll(".pg-row").forEach(r => {
        const kept = r.querySelector("[data-kept]").checked, had = !!n.pars[r.dataset.loc];
        if (!kept) { if (had) pars[r.dataset.loc] = null; return; }
        pars[r.dataset.loc] = { par: r.querySelector("[data-par]").value, reorder: r.querySelector("[data-reorder]").value, mode: r.querySelector("[data-mode]").value };
      });
      const body = { name: f.elements.name.value, vendorId: f.elements.vendor.value || null, sku: f.elements.sku.value, category: f.elements.category.value, unitCost: f.elements.cost.value,
        unit: f.elements.unit.value, bulkUnit: f.elements.bulk.value, notes: f.elements.notes.value, pars };
      if (it) body.active = f.elements.active.checked;
      if (f.elements.cleared?.checked) body.reviewNote = null;
      if (it) await api(`/items/${it.id}`, { method: "PATCH", body }); else await api("/items", { method: "POST", body });
      toast(it ? "Saved." : "Item added."); await render(main, ctx);
    },
  });
  dlg.classList.add("wide");
}
