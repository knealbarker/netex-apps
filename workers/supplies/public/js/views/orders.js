// Orders: what the Workshop is short on, grouped by vendor (lead time, minimum, how to order), and the orders already placed.
import { api } from "../api.js";
import { html, raw, toast, ago, openDialog, listen } from "../ui.js";
import { fmt, plural } from "/count/form.js";
import { printOrders } from "../print.js";

const day = d => (d ? new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "");
const money = n => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PRINT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V4h10v5M7 17H5v-6h14v6h-2M8 14h8v6H8z"/></svg>';
let data = null;

export async function render(main, ctx) {
  data = await api("/orders");
  const open = data.placed.filter(o => o.status === "ordered"), done = data.placed.filter(o => o.status !== "ordered");
  main.innerHTML = html`
    <div class="page-head"><div><h1>Orders</h1>
      <p>Items the Workshop is short on, from its latest counts${data.lastWorkshopCount ? ` (last counted ${ago(data.lastWorkshopCount)})` : ""}. Order by phone or web, then mark it ordered so it isn't suggested again.</p></div>
      <div class="head-actions">${data.groups.length ? raw(`<button class="btn" id="printAll">${PRINT}Print all</button>`) : ""}
        ${ctx.canEdit && data.workshopId ? raw(html`<a class="btn primary" href="#/count/${data.workshopId}">Enter Workshop count</a>`) : ""}</div></div>
    ${data.groups.length ? raw(data.groups.map((g, k) => group(g, k, ctx)).join("")) : raw(html`<div class="card empty"><div class="ico"><svg viewBox="0 0 24 24"><path d="M4 5h2l2 10h10l2-7H7"/></svg></div>
      <h2>Nothing to order</h2><p>${data.lastWorkshopCount ? "Everything the Workshop counted is at or above its par, or already on order." : "The Workshop hasn't been counted yet. Request a count, or enter one yourself."}</p></div>`)}
    ${data.onOrder.length ? raw(html`<p class="muted small on-order-note">${data.onOrder.length} short item${data.onOrder.length === 1 ? " is" : "s are"} already on an open order: ${data.onOrder.map(o => o.name).join(", ")}.</p>`) : ""}
    <h2 class="sec-h">On order</h2>
    ${open.length ? raw(html`<div class="card list">${open.map(o => raw(placed(o, ctx)))}</div>`) : raw('<p class="muted">No open orders.</p>')}
    ${done.length ? raw(html`<details class="past"><summary>Received or cancelled in the last 30 days (${done.length})</summary><div class="card list">${done.map(o => raw(placed(o, ctx)))}</div></details>`) : ""}`;
  wire(main, ctx, listen(main));
}

function group(g, k, ctx) {
  const v = g.vendor, ro = ctx.canEdit ? "" : "disabled";
  const how = [v.orderMethod, v.phone, v.website].filter(Boolean).join(" · ");
  const facts = [g.arrives ? `Arrives about ${day(g.arrives)}` : v.id ? "Lead time not set" : "", v.minAmount ? `Minimum ${money(v.minAmount)}` : "", v.minNote || ""].filter(Boolean);
  return html`<section class="card ship" data-group="${k}">
    <header class="ship-head"><div><h2>${v.name}</h2><p>${how || (v.id ? "How to order: not set (Setup › Vendors)" : "Set a vendor on these items in the Supply list")}</p>
      ${facts.length ? raw(html`<p class="facts">${facts.map(f => raw(html`<span>${f}</span>`))}</p>`) : ""}</div>
      <div class="head-actions"><button class="btn" data-print="${k}">${raw(PRINT)}Print</button>${ctx.canEdit && v.id ? raw(html`<button class="btn primary" data-order="${k}">Mark ordered</button>`) : ""}</div></header>
    <table class="tbl"><thead><tr><th class="ck"><span class="sr">Include</span></th><th>Item</th><th class="hide-sm">Item #</th><th class="n">On hand / par</th><th class="n">Order</th></tr></thead>
      <tbody>${g.lines.map((l, i) => raw(html`<tr data-i="${i}">
        <td class="ck"><input type="checkbox" data-inc checked ${raw(ro)} aria-label="Include ${l.name}"></td>
        <td><b>${l.name}</b><small class="sub">${l.category}</small></td><td class="hide-sm muted">${l.sku || ""}</td>
        <td class="n muted">${l.level === "need" ? "asked for" : `${fmt(l.onHand)} / ${l.par == null ? "as needed" : fmt(l.par)}`}</td>
        <td class="n"><span class="inwrap"><input class="input qty" inputmode="decimal" data-qty value="${l.qty}" ${raw(ro)} aria-label="Order: ${l.name}"><small>${l.unit}</small></span></td></tr>`))}</tbody></table>
    ${g.total != null ? raw(html`<p class="group-total" data-total>Estimated ${money(g.total)}${v.minAmount && g.total < v.minAmount ? raw(html` — <b class="warn-txt">under the ${money(v.minAmount)} minimum</b>`) : ""}</p>`) : ""}
  </section>`;
}

function placed(o, ctx) {
  const n = o.lines.length;
  return html`<div class="srow ${o.late ? "late" : ""}"><div><b>${o.vendor || "No vendor"}</b>
      <small>${n} item${n === 1 ? "" : "s"} · ordered ${ago(o.orderedAt)}${o.orderedBy ? ` by ${o.orderedBy}` : ""}${o.reference ? ` · #${o.reference}` : ""}
        ${o.status === "ordered" ? (o.expectedOn ? ` · ${o.late ? "was due" : "due"} ${day(o.expectedOn)}` : "") : o.status === "received" ? ` · received ${ago(o.receivedAt)}` : " · cancelled"}</small>
      <small class="muted">${o.lines.map(l => `${l.name} × ${fmt(l.qty)}`).join(" · ")}</small></div>
    ${ctx.canEdit && o.status === "ordered" ? raw(html`<div class="row-actions"><button class="btn" data-recv="${o.id}">Received</button><button class="btn ghost" data-cancel="${o.id}">Cancel</button></div>`) : ""}</div>`;
}

function chosen(main, k) {
  const g = data.groups[k], sec = main.querySelector(`[data-group="${k}"]`);
  return { ...g, lines: g.lines.map((l, i) => { const tr = sec.querySelector(`tr[data-i="${i}"]`); return tr.querySelector("[data-inc]").checked ? { ...l, qty: Number(tr.querySelector("[data-qty]").value) || 0 } : null; }).filter(l => l && l.qty > 0) };
}

function wire(main, ctx, signal) {
  main.querySelector("#printAll")?.addEventListener("click", () => printOrders(data.groups.map((_, k) => chosen(main, k)).filter(g => g.lines.length), data.today));
  main.addEventListener("input", e => {
    if (!e.target.matches("[data-qty]")) return;
    e.target.value = e.target.value.replace(/[^\d.]/g, "");
    const k = e.target.closest("[data-group]").dataset.group, g = chosen(main, k), tot = main.querySelector(`[data-group="${k}"] [data-total]`);
    if (tot && g.lines.every(l => l.unitCost != null)) {
      const t = g.lines.reduce((s, l) => s + l.qty * l.unitCost, 0), min = g.vendor.minAmount;
      tot.innerHTML = html`Estimated ${money(t)}${min && t < min ? raw(html` — <b class="warn-txt">under the ${money(min)} minimum</b>`) : ""}`;
    }
  }, { signal });
  main.addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.print) printOrders([chosen(main, b.dataset.print)], data.today);
      else if (b.dataset.order) {
        const g = chosen(main, b.dataset.order);
        if (!g.lines.length) return toast("Tick at least one item.", "warn");
        openDialog({
          title: `Ordered from ${g.vendor.name}`, submitLabel: "Mark ordered",
          body: html`<p class="dlg-lead">${g.lines.length} item${g.lines.length === 1 ? "" : "s"}: ${g.lines.map(l => `${l.name} × ${plural(l.qty, l.unit)}`).join(", ")}.</p>
            <div class="two"><label class="field"><span>Confirmation / PO # <em>(optional)</em></span><input class="input" name="ref" maxlength="60"></label>
            <label class="field"><span>Expected</span><input class="input" type="date" name="exp" value="${g.arrives || ""}"></label></div>
            <label class="field"><span>Note <em>(optional)</em></span><input class="input" name="note" maxlength="300"></label>`,
          async onSubmit(f) {
            await api("/orders", { method: "POST", body: { vendorId: g.vendor.id, reference: f.elements.ref.value, expectedOn: f.elements.exp.value || null, note: f.elements.note.value, lines: g.lines.map(l => ({ item: l.item, qty: l.qty })) } });
            toast(`Order from ${g.vendor.name} saved.`); await render(main, ctx);
          },
        });
      } else if (b.dataset.recv) { await api(`/orders/${b.dataset.recv}`, { method: "PATCH", body: { status: "received" } }); toast("Marked received."); await render(main, ctx); }
      else if (b.dataset.cancel) {
        if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to cancel"; setTimeout(() => { delete b.dataset.armed; b.textContent = "Cancel"; }, 3000); return; }
        await api(`/orders/${b.dataset.cancel}`, { method: "PATCH", body: { status: "cancelled" } }); toast("Order cancelled — its items will be suggested again."); await render(main, ctx);
      }
    } catch (x) { toast(x.message, "bad"); }
  }, { signal });
}
