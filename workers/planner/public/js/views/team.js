// Team: who's on the production team and how well they run each station.
// The grid works like the desktop app: click a box to cycle 1st → 2nd → 3rd → not trained.
import { api } from "../api.js";
import { html, raw, toast, initials, RANK, openDialog } from "../ui.js";

const RANK_LABEL = { 1: "1st", 2: "2nd", 3: "3rd" };
const NEXT = { undefined: 1, 1: 2, 2: 3, 3: null };
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const SHORT = { slo: "SL Op", dco: "DC Op" };

export async function render(main, ctx) {
  const { me } = ctx;
  const canRank = RANK[me.role] >= RANK.manager, canEdit = RANK[me.role] >= RANK.admin;
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Loading team…</div>`;
  const data = await api("/team");
  let showFormer = false;

  function coverage() {
    const active = data.people.filter(p => p.status === "active");
    return data.stations.map(s => ({ s, first: active.filter(p => p.skills[s.code] === 1).length, any: active.filter(p => p.skills[s.code]).length }));
  }

  function draw() {
    const people = data.people.filter(p => showFormer || p.status === "active");
    const cov = coverage();
    const thin = cov.filter(c => c.any < 2);
    const former = data.people.filter(p => p.status !== "active").length;
    main.innerHTML = html`
      <div class="page-head">
        <div><h1>Team</h1><p>${data.people.filter(p => p.status === "active").length} people on the production team.
          ${canRank ? "Click a box to rank a station: 1st (best fit) → 2nd (good backup) → 3rd (can fill in) → not trained." : "Station rankings decide who the plan puts where."}</p></div>
        <div class="head-actions">
          ${former ? raw(html`<label class="check"><input type="checkbox" id="former" ${raw(showFormer ? "checked" : "")}> Show former (${former})</label>`) : ""}
          ${canEdit ? raw(html`<button class="btn primary" id="addPerson">${raw(PLUS)}Add person</button>`) : ""}
        </div>
      </div>
      ${thin.length ? raw(html`<div class="banner warn"><b>Thin coverage:</b> ${thin.map(c => `${c.s.label} (${c.any} trained)`).join(" · ")}. One sick day leaves these stations without a trained person.</div>`) : ""}
      <div class="card grid-wrap">
        <table class="rank-grid">
          <thead><tr><th class="who-col" scope="col">Person</th>
            ${data.stations.map(s => raw(html`<th scope="col" title="${s.label}"><span>${SHORT[s.code] || s.label}</span><small>${cov.find(c => c.s.code === s.code).any} trained</small></th>`))}
          </tr></thead>
          <tbody>
          ${people.map(p => raw(html`<tr class="${p.status === "active" ? "" : "former"}" data-id="${p.id}">
            <th scope="row" class="who-col">${canEdit ? raw(html`<button class="who-btn" data-edit="${p.id}">`) : raw('<div class="who-btn">')}
              <span class="avatar" aria-hidden="true">${initials(p.name)}</span>
              <span class="who-txt"><b>${p.name}</b><small>${[p.usualStart ? `In ${p.usualStart}` : "", p.payrollId ? `Rippling #${p.payrollId}` : "", p.status === "active" ? "" : "Former"].filter(Boolean).join(" · ")}</small></span>
            ${raw(canEdit ? "</button>" : "</div>")}</th>
            ${data.stations.map(s => { const r = p.skills[s.code]; return raw(html`<td><button class="rk ${r ? `r${r}` : ""}" data-p="${p.id}" data-s="${s.code}" ${raw(canRank && p.status === "active" ? "" : "disabled")}
              aria-label="${p.name} at ${s.label}: ${r ? RANK_LABEL[r] : "not trained"}">${r ? RANK_LABEL[r] : "–"}</button></td>`); })}
          </tr>`))}
          ${people.length ? "" : raw(`<tr><td colspan="${data.stations.length + 1}" class="empty-row">No one on the team yet.</td></tr>`)}
          </tbody>
        </table>
      </div>
      <p class="legend"><span><i class="rk r1">1st</i> best fit</span><span><i class="rk r2">2nd</i> good backup</span><span><i class="rk r3">3rd</i> can fill in</span><span><i class="rk">–</i> not trained</span></p>`;

    main.querySelector("#former")?.addEventListener("change", e => { showFormer = e.target.checked; draw(); });
    main.querySelector("#addPerson")?.addEventListener("click", () => personDialog(null, reload));
    main.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => personDialog(data.people.find(p => p.id === b.dataset.edit), reload)));
    main.querySelectorAll(".rk[data-p]:not([disabled])").forEach(b => b.addEventListener("click", () => cycle(b)));
  }

  async function cycle(btn) {
    const p = data.people.find(x => x.id === btn.dataset.p), code = btn.dataset.s;
    const before = p.skills[code], next = NEXT[before];
    if (next) p.skills[code] = next; else delete p.skills[code];
    paint(btn, next);
    try { await api(`/team/${p.id}/skills/${code}`, { method: "PUT", body: { rank: next } }); }
    catch (e) {
      if (before) p.skills[code] = before; else delete p.skills[code];
      paint(btn, before);
      toast(e.message, "bad");
    }
    // update the counts in the header and the coverage banner without redrawing (keeps focus on the box)
    clearTimeout(cycle.t); cycle.t = setTimeout(() => { const f = document.activeElement?.dataset; draw(); if (f?.p) main.querySelector(`.rk[data-p="${f.p}"][data-s="${f.s}"]`)?.focus(); }, 900);
  }
  function paint(btn, r) {
    btn.className = `rk ${r ? `r${r}` : ""}`;
    btn.textContent = r ? RANK_LABEL[r] : "–";
    const p = data.people.find(x => x.id === btn.dataset.p), s = data.stations.find(x => x.code === btn.dataset.s);
    btn.setAttribute("aria-label", `${p.name} at ${s.label}: ${r ? RANK_LABEL[r] : "not trained"}`);
  }
  async function reload() { Object.assign(data, await api("/team")); draw(); }
  draw();
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
      if (isNew) { await api("/team", { method: "POST", body }); toast(`${body.firstName} added. Rank their stations in the grid.`); }
      else { body.status = e.active.checked ? "active" : "inactive"; await api(`/team/${p.id}`, { method: "PATCH", body }); toast("Saved."); }
      done();
    },
  });
}
