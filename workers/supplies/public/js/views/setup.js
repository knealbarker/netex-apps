// Setup: vendors (how to order, lead time, minimum), locations, who may count, and the counting devices.
import { api } from "../api.js";
import { html, raw, toast, ago, openDialog, listen } from "../ui.js";

const money = n => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export async function render(main, ctx) {
  const [cat, cn, dv] = await Promise.all([api("/catalog"), api("/counters"), api("/devices").catch(() => ({ devices: [] }))]);
  const locName = id => cat.locations.find(l => l.id === id)?.label || "Any location";
  const ed = ctx.canEdit;
  main.innerHTML = html`
    <div class="page-head"><div><h1>Setup</h1><p>Vendors, who may count, and the devices each location counts on.</p></div></div>
    <nav class="set-jump"><a href="#vendors">Vendors</a><a href="#counters">Who can count</a><a href="#devices">Counting devices</a><a href="#locations">Locations</a></nav>

    <section class="set-card card" id="vendors"><header><h2>Vendors</h2><p>Lead time sets the expected date on orders; the minimum shows against the order total when items have a cost.</p></header>
      <div class="list">${cat.vendors.map(v => raw(html`<button class="srow as-btn" data-vendor="${v.id}" ${raw(ed ? "" : "disabled")}><div><b>${v.name}</b>${v.active ? "" : raw(' <span class="chip off">off</span>')}
        <small>${[v.orderMethod, v.phone, v.website].filter(Boolean).join(" · ") || "How to order: not set"}</small></div>
        <div class="count-nums"><span>${v.leadDays != null ? `${v.leadDays} day lead` : "lead time —"}</span><span class="muted">${v.minAmount ? `min ${money(v.minAmount)}` : v.minNote || "no minimum"}</span></div></button>`))}</div>
      ${ed ? raw('<div class="set-foot"><button class="btn" data-vendor="">Add a vendor</button></div>') : ""}</section>

    <section class="set-card card" id="counters"><header><h2>Who can count</h2><p>People type their first name and last initial (like <b>KarlaV</b>) on the count page. Only names on this list can send a count.</p></header>
      <div class="list">${cn.counters.length ? cn.counters.map(c => raw(html`<button class="srow as-btn" data-counter="${c.id}" ${raw(ed ? "" : "disabled")}><div><b>${c.name}</b>${c.active ? "" : raw(' <span class="chip off">off</span>')}
        <small>Types “${c.firstName}${c.lastInitial}” · ${locName(c.locationId)}</small></div><div class="count-nums"><span class="muted">${c.lastCount ? `last count ${ago(c.lastCount)}` : "no counts yet"}</span></div></button>`)) : raw('<p class="muted pad">Nobody yet — add the people who count at each location.</p>')}</div>
      ${ed ? raw('<div class="set-foot"><button class="btn" data-counter="">Add a person</button></div>') : ""}</section>

    <section class="set-card card" id="devices"><header><h2>Counting devices</h2><p>A store PC, tablet or phone that opens <b>supplies.netexcleaners.com/count</b>. Add it here, then type the 6-digit code on the device (once). No sign-in after that.</p></header>
      <div class="list">${dv.devices.length ? dv.devices.map(d => raw(html`<div class="srow"><div><b>${d.name}</b><small>${locName(d.locationId)} · ${d.paired ? `last used ${ago(d.lastSeen)}` : d.codeUntil ? "waiting for its code" : "not set up yet"}</small></div>
        ${ed ? raw(html`<div class="row-actions"><button class="btn ghost" data-code="${d.id}">New code</button><button class="btn ghost danger" data-unpair="${d.id}">Remove</button></div>`) : ""}</div>`)) : raw('<p class="muted pad">No devices yet.</p>')}</div>
      ${ed ? raw('<div class="set-foot"><button class="btn" id="addDevice">Add a device</button></div>') : ""}</section>

    <section class="set-card card" id="locations"><header><h2>Locations</h2><p>The Workshop is the warehouse (restocked by vendor orders); the rest are restocked by the shuttle.</p></header>
      <div class="list">${cat.locations.map(l => raw(html`<div class="srow"><div><b>${l.label}</b><small>${l.role === "warehouse" ? "Warehouse" : "Shuttle stop"} · ${cat.items.filter(i => i.active && i.pars[l.id]).length} items kept</small></div>
        ${ed ? raw(html`<div class="row-actions"><button class="btn ghost" data-rename="${l.id}">Rename</button><button class="btn ghost" data-toggle="${l.id}">${l.active ? "Turn off" : "Turn on"}</button></div>`) : ""}</div>`))}</div></section>`;

  const signal = listen(main);
  main.addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.vendor !== undefined) vendor(main, ctx, cat.vendors.find(v => v.id === b.dataset.vendor));
      else if (b.dataset.counter !== undefined) counter(main, ctx, cat, cn.counters.find(c => c.id === b.dataset.counter));
      else if (b.id === "addDevice") device(main, ctx, cat);
      else if (b.dataset.code) showCode(main, ctx, await api(`/devices/${b.dataset.code}/code`, { method: "POST" }));
      else if (b.dataset.unpair) {
        if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again"; setTimeout(() => { delete b.dataset.armed; b.textContent = "Remove"; }, 3000); return; }
        await api(`/devices/${b.dataset.unpair}`, { method: "DELETE" }); toast("Device removed — it can't count any more."); await render(main, ctx);
      } else if (b.dataset.toggle) { const l = cat.locations.find(x => x.id === b.dataset.toggle); await api(`/locations/${l.id}`, { method: "PATCH", body: { active: !l.active } }); await render(main, ctx); }
      else if (b.dataset.rename) {
        const l = cat.locations.find(x => x.id === b.dataset.rename);
        openDialog({ title: "Rename", body: html`<label class="field"><span>Name on the count page and slips</span><input class="input" name="label" maxlength="60" value="${l.label}"></label>`,
          async onSubmit(f) { await api(`/locations/${l.id}`, { method: "PATCH", body: { label: f.elements.label.value } }); await render(main, ctx); } });
      }
    } catch (x) { toast(x.message, "bad"); }
  }, { signal });
}

function vendor(main, ctx, v) {
  const n = v || { active: true };
  openDialog({
    title: v ? v.name : "Add a vendor",
    body: html`<label class="field"><span>Name</span><input class="input" name="name" maxlength="80" value="${n.name || ""}" required></label>
      <div class="two"><label class="field"><span>How you order</span><input class="input" name="orderMethod" maxlength="80" value="${n.orderMethod || ""}" placeholder="Phone / web"></label>
        <label class="field"><span>Phone</span><input class="input" name="phone" maxlength="40" value="${n.phone || ""}"></label></div>
      <div class="two"><label class="field"><span>Website</span><input class="input" name="website" maxlength="200" value="${n.website || ""}"></label>
        <label class="field"><span>Account #</span><input class="input" name="accountNo" maxlength="60" value="${n.accountNo || ""}"></label></div>
      <label class="field"><span>Contact</span><input class="input" name="contact" maxlength="120" value="${n.contact || ""}" placeholder="Rep's name, email"></label>
      <div class="two"><label class="field"><span>Lead time (business days)</span><input class="input" name="leadDays" inputmode="numeric" value="${n.leadDays ?? ""}" placeholder="e.g. 3"></label>
        <label class="field"><span>Minimum order ($)</span><input class="input" name="minAmount" inputmode="decimal" value="${n.minAmount ?? ""}" placeholder="none"></label></div>
      <label class="field"><span>Other minimums or freight rules</span><input class="input" name="minNote" maxlength="200" value="${n.minNote || ""}" placeholder="e.g. free freight over $300"></label>
      <label class="field"><span>Notes</span><input class="input" name="notes" maxlength="400" value="${n.notes || ""}"></label>
      ${v ? raw(html`<label class="switch"><div><b>Active</b><small>Turn off a vendor you no longer use.</small></div><input type="checkbox" name="active" ${raw(n.active ? "checked" : "")}></label>`) : ""}`,
    async onSubmit(f) {
      const body = Object.fromEntries(["name", "orderMethod", "phone", "website", "accountNo", "contact", "leadDays", "minAmount", "minNote", "notes"].map(k => [k, f.elements[k].value]));
      if (v) body.active = f.elements.active.checked;
      await api(v ? `/vendors/${v.id}` : "/vendors", { method: v ? "PATCH" : "POST", body });
      toast("Saved."); await render(main, ctx);
    },
  });
}

function counter(main, ctx, cat, c) {
  openDialog({
    title: c ? c.name : "Add a person",
    body: html`<div class="two"><label class="field"><span>First name</span><input class="input" name="first" maxlength="30" value="${c?.firstName || ""}" required></label>
        <label class="field"><span>Last initial</span><input class="input" name="li" maxlength="1" value="${c?.lastInitial || ""}" required></label></div>
      <label class="field"><span>Can count at</span><select class="input" name="loc"><option value="">Any location</option>${cat.locations.map(l => raw(html`<option value="${l.id}" ${raw(c?.locationId === l.id ? "selected" : "")}>${l.label} only</option>`))}</select></label>
      ${c ? raw(html`<label class="switch"><div><b>Can count</b><small>Turn off when someone leaves. Their past counts stay.</small></div><input type="checkbox" name="active" ${raw(c.active ? "checked" : "")}></label>`) : ""}`,
    onOpen: f => f.elements.first.focus(),
    async onSubmit(f) {
      const body = { firstName: f.elements.first.value, lastInitial: f.elements.li.value, locationId: f.elements.loc.value || null };
      if (c) body.active = f.elements.active.checked;
      const r = await api(c ? `/counters/${c.id}` : "/counters", { method: c ? "PATCH" : "POST", body });
      toast(`Saved. They type “${body.firstName.replace(/\s+/g, "")}${body.lastInitial.toUpperCase()}” to count.`); void r; await render(main, ctx);
    },
  });
}

function device(main, ctx, cat) {
  openDialog({
    title: "Add a counting device", submitLabel: "Get a code",
    body: html`<label class="field"><span>Location</span><select class="input" name="loc">${cat.locations.filter(l => l.active).map(l => raw(html`<option value="${l.id}">${l.label}</option>`))}</select></label>
      <label class="field"><span>Name <em>(optional)</em></span><input class="input" name="name" maxlength="40" placeholder="e.g. Front counter PC"></label>`,
    async onSubmit(f) { showCode(main, ctx, await api("/devices", { method: "POST", body: { locationId: f.elements.loc.value, name: f.elements.name.value } })); },
  });
}

function showCode(main, ctx, r) {
  const dlg = openDialog({
    title: "Set up the device", submitLabel: "Done",
    body: html`<ol class="steps"><li>On the device, open <b>supplies.netexcleaners.com/count</b></li><li>Type this code:</li></ol>
      <p class="big-code">${r.code.slice(0, 3)} ${r.code.slice(3)}</p>
      <p class="field-help">Works once, for the next 15 minutes. After that the device stays set up — no sign-in. Tip: add the page to the home screen.</p>`,
    async onSubmit() { await render(main, ctx); },
  });
  dlg.querySelector("[data-close]").hidden = true;
}
