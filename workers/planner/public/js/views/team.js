// Team: who's on the production team and what each person is trained on, in order
// (1 = where they belong first, then the next best place, and so on).
// Training is per kind of work: SLB 1/2 share one training, as do DCT 1-3.
import { api } from "../api.js";
import { html, raw, toast, initials, RANK, openDialog } from "../ui.js";
import { rankingSuggestions } from "../plan/model.js";

const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4m6-4v4"/></svg>';
const shortDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const clock12 = t => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };
/** "Out today", "Out Tue Oct 14 – Thu Oct 16", "In 9:30 AM Wed Oct 15" */
export function awayText(t, today) {
  const when = d => d === today ? "today" : shortDay(d);
  if (t.kind === "late") return `In ${clock12(t.at)} ${when(t.fromDay)}`;
  if (t.fromDay === t.toDay) return `Out ${when(t.fromDay)}`;
  return `Out ${t.fromDay <= today ? "until" : `${shortDay(t.fromDay)} –`} ${shortDay(t.toDay)}`;
}
const CLK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
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
    const T = data.today, todayAway = active.flatMap(p => (p.away || []).filter(t => t.fromDay <= T && t.toDay >= T).map(t => ({ p, t })));
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
      <div class="banner ${todayAway.length ? "warn" : "info"} away-today"><b>Today:</b>${todayAway.length
        ? raw(todayAway.map(({ p, t }) => html`<span class="chip ${t.kind === "late" ? "late" : "off"}" title="${t.note || ""}">${p.name} · ${t.kind === "late" ? `in ${clock12(t.at)}` : "out"}</span>`).join(""))
        : "everyone is expected in."}${canTrain ? raw(html` <button class="btn small" id="awayAny">${raw(CAL)}Out or late…</button>`) : ""}</div>
      ${thin.length ? raw(html`<div class="banner warn"><b>Thin coverage:</b> ${thin.map(c => `${c.t.short} (${c.trained})`).join(" · ")} — one sick day leaves these without a trained person.</div>`) : ""}
      ${focus ? raw(html`<p class="focus-note">Sorted by who runs <b>${tName(focus).name}</b> best. <button class="linkish" id="clearFocus">Show everyone A–Z</button></p>`) : ""}
      <div class="card list team-list" role="list">
        ${people.map(p => raw(html`<div class="trow ${p.status === "active" ? "" : "former"}" role="listitem">
          ${canEdit ? raw(html`<button class="who-btn" data-edit="${p.id}" aria-label="Edit ${p.name}">`) : raw('<div class="who-btn">')}
            <span class="avatar" aria-hidden="true">${initials(p.name)}</span>
            <span class="who-txt"><b>${p.name}</b>${(p.away || []).length && p.status === "active" ? raw(html`<span class="away-chips">${p.away.slice(0, 3).map(t => raw(html`<span class="chip ${t.kind === "late" ? "late" : "off"}" title="${t.note || ""}">${awayText(t, T)}</span>`))}${p.away.length > 3 ? raw(html`<span class="chip">+${p.away.length - 3} more</span>`) : ""}</span>`) : ""}<small>${[schedText(p), p.payrollId ? `Rippling #${p.payrollId}` : "", "rate" in p ? (p.rate ? `$${p.rate.toFixed(2)}/h` : "no pay rate yet") : "", p.status === "active" ? "" : "Former"].filter(Boolean).join(" · ")}</small></span>
          ${raw(canEdit ? "</button>" : "</div>")}
          <ol class="tchips" aria-label="Trainings in order">
            ${p.trainings.length ? p.trainings.map((t, i) => raw(html`<li class="tchip ${focus === t ? "hit" : ""} ${i === 0 ? "first" : ""}" title="${tName(t)?.name || t}"><i>${i + 1}</i>${tName(t)?.short || t}</li>`))
              : raw('<li class="tnone">No trainings yet</li>')}
          </ol>
          ${canTrain && p.status === "active" ? raw(html`<span class="trow-act"><button class="btn ghost small" data-sched="${p.id}">${raw(CLK)}Schedule</button><button class="btn ghost small" data-away="${p.id}">${raw(CAL)}Time off</button><button class="btn ghost small" data-train="${p.id}">${raw(PEN)}Trainings</button></span>`) : raw("<span></span>")}
        </div>`))}
        ${people.length ? "" : raw('<div class="empty-row">No one on the team yet.</div>')}
      </div>`;

    main.querySelector("#former")?.addEventListener("change", e => { showFormer = e.target.checked; draw(); });
    main.querySelector("#addPerson")?.addEventListener("click", () => personDialog(null, reload));
    main.querySelector("#fromHistory")?.addEventListener("click", () => historyDialog(data, reload));
    main.querySelector("#clearFocus")?.addEventListener("click", () => { focus = null; draw(); });
    main.querySelectorAll("[data-focus]").forEach(b => b.addEventListener("click", () => { focus = focus === b.dataset.focus ? null : b.dataset.focus; draw(); main.querySelector(`[data-focus="${b.dataset.focus}"]`)?.focus(); }));
    main.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => personDialog(data.people.find(p => p.id === b.dataset.edit), reload)));
    main.querySelectorAll("[data-sched]").forEach(b => b.addEventListener("click", () => scheduleDialog(data.people.find(p => p.id === b.dataset.sched), reload)));
    main.querySelectorAll("[data-away]").forEach(b => b.addEventListener("click", () => awayDialog(data.people.find(p => p.id === b.dataset.away), data, reload)));
    main.querySelector("#awayAny")?.addEventListener("click", () => awayDialog(null, data, reload));
    main.querySelectorAll("[data-train]").forEach(b => b.addEventListener("click", () => trainingsDialog(data.people.find(p => p.id === b.dataset.train), data.trainings, reload)));
  }
  async function reload() { Object.assign(data, await api("/team")); draw(); }
  draw();
}

// The standing schedule (Neal, Oct 13): every plan starts from it; a one-day change (stay late, send home) is made on the Plan.
const DAYS = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["0", "Sun"]];
function schedText(p) {
  const d = p.usualDays ? (p.usualDays === "12345" ? "Mon–Fri" : DAYS.filter(([k]) => p.usualDays.includes(k)).map(([, l]) => l).join(" ")) : "";
  return [d, p.usualStart ? `in ${clock12(p.usualStart)}` : "", p.usualHours ? `${p.usualHours}h` : "", p.leaveBy ? `leaves by ${clock12(p.leaveBy)}${p.leaveNote ? ` (${p.leaveNote})` : ""}` : ""].filter(Boolean).join(" · ");
}
function scheduleDialog(p, done) {
  const days = p.usualDays || "";
  openDialog({
    title: `${p.name}: usual schedule`, submitLabel: "Save",
    body: html`<p class="dlg-lead">Every plan starts from this. A one-day change, like staying late or going home early, is made on the Plan.</p>
      <fieldset class="ms-times sched-days"><legend>Usual days</legend>${DAYS.map(([k, l]) => raw(html`<label class="ms-time"><input type="checkbox" name="d${k}" ${days.includes(k) ? "checked" : ""}><span>${l}</span></label>`))}</fieldset>
      <div class="two"><label class="field"><span>Usual clock-in</span><input class="input" name="usualStart" type="time" step="300" value="${p.usualStart || ""}"></label>
        <label class="field"><span>Usual hours</span><input class="input" name="usualHours" type="number" min="1" max="16" step="0.25" inputmode="decimal" value="${p.usualHours ?? ""}" placeholder="Settings' full day"></label></div>
      <div class="two"><label class="field"><span>Must leave by <em>(optional)</em></span><input class="input" name="leaveBy" type="time" step="300" value="${p.leaveBy || ""}"></label>
        <label class="field"><span>Why <em>(managers see this)</em></span><input class="input" name="leaveNote" maxlength="120" value="${p.leaveNote || ""}" placeholder="School pickup"></label></div>`,
    onOpen: (f, d) => d.classList.add("sheet"),
    async onSubmit(f) {
      const e = f.elements;
      const body = { usualDays: DAYS.filter(([k]) => e["d" + k].checked).map(([k]) => k).join(""), usualStart: e.usualStart.value || null,
        usualHours: e.usualHours.value === "" ? null : +e.usualHours.value, leaveBy: e.leaveBy.value || null, leaveNote: e.leaveNote.value };
      await api(`/team/${p.id}`, { method: "PATCH", body }); toast("Schedule saved."); done();
    },
  });
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

// Time off: out for one or more days, or in late at a time on one day. Shows what's already set, each with Remove.
function awayDialog(p, data, done) {
  const T = data.today, active = data.people.filter(x => x.status === "active");
  const existing = () => (p ? p.away || [] : []);
  openDialog({
    title: p ? `Time off · ${p.name}` : "Out or late", submitLabel: "Add",
    body: html`${p ? "" : raw(html`<label class="field"><span>Person</span><select class="input" name="who" required><option value="">— Pick someone —</option>
        ${active.map(x => raw(html`<option value="${x.id}">${x.name}</option>`))}</select></label>`)}
      ${existing().length ? raw(html`<div class="field"><span>Already set</span><ul class="away-list">${existing().map(t => raw(html`<li><span><b>${awayText(t, T)}</b>${t.note ? raw(html` <small>— ${t.note}</small>`) : ""}${t.by ? raw(html`<br><small>by ${t.by}</small>`) : ""}</span>
          <button type="button" class="btn ghost small" data-rm="${t.id}">Remove</button></li>`))}</ul></div>`) : ""}
      <div class="field"><span>What</span><div class="kindrow"><label><input type="radio" name="kind" value="out" checked> Out</label><label><input type="radio" name="kind" value="late"> In late</label></div></div>
      <div class="kindrow">
        <label class="field"><span data-l="from">From</span><input class="input" type="date" name="from" value="${T}" min="${T}" required></label>
        <label class="field" data-only="out"><span>Through</span><input class="input" type="date" name="to" value="${T}" min="${T}"></label>
        <label class="field" data-only="late" hidden><span>Comes in at</span><input class="input" type="time" step="300" name="at"></label>
      </div>
      <label class="field"><span>Note <em>(optional)</em></span><input class="input" name="note" maxlength="300" placeholder="Sick, vacation, appointment…"></label>`,
    onOpen: dlg => {
      const f = dlg.querySelector("form") || dlg;
      const sync = () => { const late = f.querySelector('[name="kind"]:checked').value === "late";
        f.querySelector('[data-only="out"]').hidden = late; f.querySelector('[data-only="late"]').hidden = !late; f.querySelector('[data-l="from"]').textContent = late ? "Day" : "From"; };
      f.querySelectorAll('[name="kind"]').forEach(r => r.addEventListener("change", sync));
      f.querySelector('[name="from"]').addEventListener("change", e => { const to = f.querySelector('[name="to"]'); to.min = e.target.value; if (to.value < e.target.value) to.value = e.target.value; });
      f.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", async () => {
        b.disabled = true;
        try { await api(`/timeoff/${b.dataset.rm}`, { method: "DELETE" }); p.away = p.away.filter(t => t.id !== b.dataset.rm); b.closest("li").remove(); toast("Removed."); done(); }
        catch (e) { b.disabled = false; toast(e.message, "warn"); }
      }));
    },
    onSubmit: async form => {
      const personId = p ? p.id : form.who.value; if (!personId) throw new Error("Pick who it is.");
      const kind = form.kind.value, fromDay = form.from.value, toDay = kind === "late" ? fromDay : form.to.value || fromDay, at = form.at.value;
      if (!fromDay) throw new Error("Pick a date.");
      if (kind === "late" && !at) throw new Error("Pick the time they'll come in.");
      await api("/timeoff", { method: "POST", body: { personId, kind, fromDay, toDay, at, note: form.note.value } });
      const who = p || active.find(x => x.id === personId);
      toast(`${who.name}: ${awayText({ kind, fromDay, toDay, at }, T)}. The plan for those days picks it up.`);
      await done();
    },
  });
}
