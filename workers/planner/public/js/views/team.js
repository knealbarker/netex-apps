// Team: who's on the production team and what each person is trained on, in order
// (1 = where they belong first, then the next best place, and so on).
// Training is per kind of work: SLB 1/2 share one training, as do DCT 1-3.
import { api } from "../api.js";
import { html, raw, toast, initials, RANK, openDialog } from "../ui.js";
import { rankingSuggestions } from "../plan/model.js";

const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>';

export async function render(main, ctx) {
  const { me } = ctx;
  const canTrain = RANK[me.role] >= RANK.manager, canEdit = RANK[me.role] >= RANK.admin;
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Loading team…</div>`;
  const data = await api("/team");
  let showFormer = false, focus = null; // focus = training id picked in the coverage strip
  const tName = id => data.trainings.find(t => t.id === id);

  function draw() {
    const active = data.people.filter(p => p.status === "active");
    const cov = data.trainings.map(t => ({ t, trained: active.filter(p => p.trainings.includes(t.id)).length, first: active.filter(p => p.trainings[0] === t.id).length }));
    let people = data.people.filter(p => showFormer || p.status === "active");
    if (focus) { // who can run this, best first
      const pos = p => { const i = p.trainings.indexOf(focus); return i < 0 ? 99 : i; };
      people = [...people].sort((a, b) => pos(a) - pos(b) || a.name.localeCompare(b.name));
    }
    const thin = cov.filter(c => c.trained < 2);
    const former = data.people.length - active.length;
    main.innerHTML = html`
      <div class="page-head">
        <div><h1>Team</h1><p>${active.length} people on the production team. Each person's trainings are listed in order: 1 is where they belong first.</p></div>
        <div class="head-actions">
          ${former ? raw(html`<label class="check"><input type="checkbox" id="former" ${raw(showFormer ? "checked" : "")}> Show former (${former})</label>`) : ""}
          ${canTrain ? raw(html`<button class="btn" id="fromHistory" title="Reorder trainings by where people have actually worked">Order from history</button>`) : ""}
          ${canEdit ? raw(html`<button class="btn primary" id="addPerson">${raw(PLUS)}Add person</button>`) : ""}
        </div>
      </div>
      <div class="cov" role="group" aria-label="Who can run each kind of work. Pick one to sort the team by it.">
        ${cov.map(c => raw(html`<button class="cov-tile ${c.trained < 2 ? "thin" : ""} ${focus === c.t.id ? "on" : ""}" data-focus="${c.t.id}" aria-pressed="${focus === c.t.id}"
            title="${c.t.name}${c.t.stations.length > 1 ? ` — covers ${c.t.stations.join(", ")}` : ""}">
          <b>${c.t.short}</b><span>${c.trained} trained</span><small>${c.first} first choice</small></button>`))}
      </div>
      ${thin.length ? raw(html`<div class="banner warn"><b>Thin coverage:</b> ${thin.map(c => `${c.t.short} (${c.trained})`).join(" · ")} — one sick day leaves these without a trained person.</div>`) : ""}
      ${focus ? raw(html`<p class="focus-note">Sorted by who runs <b>${tName(focus).name}</b> best. <button class="linkish" id="clearFocus">Show everyone A–Z</button></p>`) : ""}
      <div class="card list team-list" role="list">
        ${people.map(p => raw(html`<div class="trow ${p.status === "active" ? "" : "former"}" role="listitem">
          ${canEdit ? raw(html`<button class="who-btn" data-edit="${p.id}" aria-label="Edit ${p.name}">`) : raw('<div class="who-btn">')}
            <span class="avatar" aria-hidden="true">${initials(p.name)}</span>
            <span class="who-txt"><b>${p.name}</b><small>${[p.usualStart ? `In ${p.usualStart}` : "", p.payrollId ? `Rippling #${p.payrollId}` : "", "rate" in p ? (p.rate ? `$${p.rate.toFixed(2)}/h` : "no pay rate yet") : "", p.status === "active" ? "" : "Former"].filter(Boolean).join(" · ")}</small></span>
          ${raw(canEdit ? "</button>" : "</div>")}
          <ol class="tchips" aria-label="Trainings in order">
            ${p.trainings.length ? p.trainings.map((t, i) => raw(html`<li class="tchip ${focus === t ? "hit" : ""} ${i === 0 ? "first" : ""}" title="${tName(t)?.name || t}"><i>${i + 1}</i>${tName(t)?.short || t}</li>`))
              : raw('<li class="tnone">No trainings yet</li>')}
          </ol>
          ${canTrain && p.status === "active" ? raw(html`<button class="btn ghost small" data-train="${p.id}">${raw(PEN)}Trainings</button>`) : raw("<span></span>")}
        </div>`))}
        ${people.length ? "" : raw('<div class="empty-row">No one on the team yet.</div>')}
      </div>`;

    main.querySelector("#former")?.addEventListener("change", e => { showFormer = e.target.checked; draw(); });
    main.querySelector("#addPerson")?.addEventListener("click", () => personDialog(null, reload));
    main.querySelector("#fromHistory")?.addEventListener("click", () => historyDialog(data, reload));
    main.querySelector("#clearFocus")?.addEventListener("click", () => { focus = null; draw(); });
    main.querySelectorAll("[data-focus]").forEach(b => b.addEventListener("click", () => { focus = focus === b.dataset.focus ? null : b.dataset.focus; draw(); main.querySelector(`[data-focus="${b.dataset.focus}"]`)?.focus(); }));
    main.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => personDialog(data.people.find(p => p.id === b.dataset.edit), reload)));
    main.querySelectorAll("[data-train]").forEach(b => b.addEventListener("click", () => trainingsDialog(data.people.find(p => p.id === b.dataset.train), data.trainings, reload)));
  }
  async function reload() { Object.assign(data, await api("/team")); draw(); }
  draw();
}

// "Order from history": where each person actually worked most comes first (from saved plans and the time clock).
async function historyDialog(data, done) {
  const H = await api("/team/history");
  const list = rankingSuggestions(data, H.trainingOf, H);
  const short = id => data.trainings.find(t => t.id === id)?.short || id;
  const days = new Set(H.planned.map(p => p.day)).size;
  if (!list.length) {
    toast(days < 5 ? `Not enough saved plans yet (${days} day${days === 1 ? "" : "s"}). This needs at least 3 worked days per person — try again in a week or two.` : "Nothing to change: the training order already matches where people have worked.", "ok", 9000);
    return;
  }
  openDialog({
    title: "Training order from history", submitLabel: "Apply checked",
    body: html`<p class="dlg-lead">From ${days} days of plans over the last 90 days, counting only days the person clocked in. Where someone works most becomes 1st; trainings they have but haven't worked move to the end. Untick anyone you don't want changed.</p>
      <div class="aa-list">${list.map((x, i) => raw(html`<label class="aa"><input type="checkbox" name="s" value="${i}" checked>
        <span><b>${x.name}</b> <small>${x.days} days</small><small class="ord">${x.from.length ? x.from.map(short).join(" › ") : "none"} <b>→</b> ${x.to.map(t => `${short(t)}${x.share[t] ? ` (${Math.round(x.share[t] * 100)}%)` : ""}`).join(" › ")}${x.added.length ? ` · adds ${x.added.map(short).join(", ")}` : ""}</small></span></label>`))}</div>`,
    onOpen: (form, dlg) => dlg.classList.add("wide"),
    async onSubmit(form) {
      const pick = [...form.querySelectorAll("[name=s]:checked")].map(x => list[+x.value]);
      if (!pick.length) throw new Error("Check at least one person.");
      for (const x of pick) await api(`/team/${x.personId}/trainings`, { method: "PUT", body: { trainings: x.to } });
      toast(`Updated the training order for ${pick.length} ${pick.length === 1 ? "person" : "people"}.`);
      done();
    },
  });
}

// Ordered list editor: move up/down, remove, add from what's left.
function trainingsDialog(p, trainings, done) {
  let list = [...p.trainings];
  const byId = Object.fromEntries(trainings.map(t => [t.id, t]));
  const body = () => html`
    <p class="dlg-lead">Put them in order: 1 is where ${p.firstName} belongs first, then the next best place. The plan fills stations in this order.</p>
    <ol class="tlist" aria-label="Trainings in order">${list.map((t, i) => raw(html`
      <li><i>${i + 1}</i><span><b>${byId[t]?.short || t}</b><small>${byId[t]?.name || ""}${byId[t]?.stations.length > 1 ? ` · ${byId[t].stations.join(", ")}` : ""}</small></span>
        <button type="button" class="icon-btn" data-up="${i}" aria-label="Move ${byId[t]?.short} up" ${raw(i === 0 ? "disabled" : "")}>↑</button>
        <button type="button" class="icon-btn" data-down="${i}" aria-label="Move ${byId[t]?.short} down" ${raw(i === list.length - 1 ? "disabled" : "")}>↓</button>
        <button type="button" class="icon-btn" data-del="${i}" aria-label="Remove ${byId[t]?.short}">×</button></li>`))}
      ${list.length ? "" : raw('<li class="tnone">Not trained on anything yet. Add below.</li>')}</ol>
    ${trainings.length > list.length ? raw(html`<div class="field"><span>Add a training</span><div class="tadd">${trainings.filter(t => !list.includes(t.id)).map(t => raw(html`
      <button type="button" class="btn small" data-add="${t.id}" title="${t.name}">+ ${t.short}</button>`))}</div></div>`) : ""}`;
  const dlg = openDialog({
    title: `Trainings — ${p.name}`,
    body: `<div class="tedit">${body()}</div>`,
    async onSubmit() {
      await api(`/team/${p.id}/trainings`, { method: "PUT", body: { trainings: list } });
      toast(`Saved ${p.firstName}'s trainings.`);
      done();
    },
  });
  const box = dlg.querySelector(".tedit");
  box.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const d = b.dataset; let focusSel = null;
    if (d.up) { const i = +d.up; [list[i - 1], list[i]] = [list[i], list[i - 1]]; focusSel = i - 1 > 0 ? `[data-up="${i - 1}"]` : `[data-down="${i - 1}"]`; }
    else if (d.down) { const i = +d.down; [list[i + 1], list[i]] = [list[i], list[i + 1]]; focusSel = i + 1 < list.length - 1 ? `[data-down="${i + 1}"]` : `[data-up="${i + 1}"]`; }
    else if (d.del) { list.splice(+d.del, 1); focusSel = ".tadd button"; }
    else if (d.add) { list.push(d.add); focusSel = `[data-up="${list.length - 1}"]`; }
    else return;
    box.innerHTML = body();
    (box.querySelector(focusSel) || box.querySelector("button"))?.focus();
  });
}

function personDialog(p, done) {
  const isNew = !p;
  openDialog({
    title: isNew ? "Add to the team" : p.name,
    submitLabel: isNew ? "Add person" : "Save",
    body: html`
      <div class="two"><label class="field"><span>First name</span><input class="input" name="firstName" required maxlength="80" value="${p?.firstName || ""}"></label>
        <label class="field"><span>Last name</span><input class="input" name="lastName" maxlength="80" value="${p?.lastName || ""}"></label></div>
      <label class="field"><span>Name on the plan <em>(optional)</em></span><input class="input" name="displayName" maxlength="80" value="${p?.displayName || ""}" placeholder="Leave blank to use the full name">
        <small>What the floor screen shows, e.g. a nickname.</small></label>
      <div class="two"><label class="field"><span>Usual clock-in</span><input class="input" name="usualStart" type="time" value="${p?.usualStart || ""}"></label>
        <label class="field"><span>Rippling employee #</span><input class="input" name="payrollId" inputmode="numeric" maxlength="40" value="${p?.payrollId || ""}">
          <small>Links their hours from Rippling.</small></label></div>
      <label class="field"><span>Note <em>(optional)</em></span><textarea class="input" name="note" rows="2" maxlength="500">${p?.note || ""}</textarea></label>
      ${isNew ? "" : raw(html`<label class="switch"><div><b>On the team</b><small>Turn off when someone leaves; their history stays.</small></div>
        <input type="checkbox" name="active" role="switch" ${raw(p.status === "active" ? "checked" : "")}></label>`)}`,
    onOpen: f => f.elements.firstName.focus(),
    async onSubmit(f) {
      const e = f.elements;
      const body = { firstName: e.firstName.value, lastName: e.lastName.value, displayName: e.displayName.value, usualStart: e.usualStart.value || null, payrollId: e.payrollId.value, note: e.note.value };
      if (isNew) { await api("/team", { method: "POST", body }); toast(`${body.firstName} added. Add their trainings next.`); }
      else { body.status = e.active.checked ? "active" : "inactive"; await api(`/team/${p.id}`, { method: "PATCH", body }); toast("Saved."); }
      done();
    },
  });
}
