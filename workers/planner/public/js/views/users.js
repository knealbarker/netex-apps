// Users & access: who can sign in to the planner and what they can do.
import { api } from "../api.js";
import { html, raw, toast, initials, ago, ROLES, RANK, roleName, openDialog } from "../ui.js";

const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const INFO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';

function roleChoices(me, current, { allowNone = true, name = "role" } = {}) {
  const allowed = r => me.role === "owner" || RANK[r] < RANK[me.role];
  return html`<div class="roles" role="radiogroup">${ROLES.map(r => raw(html`
    <label class="role-opt"><input type="radio" name="${name}" value="${r.id}" ${raw(r.id === current ? "checked" : "")} ${raw(allowed(r.id) ? "" : "disabled")}>
      <b>${r.name}</b><small>${r.does}</small></label>`))}
    ${raw(allowNone ? html`<label class="role-opt"><input type="radio" name="${name}" value="" ${raw(current ? "" : "checked")}>
      <b>No access to the planner</b><small>Keeps them on the list (for other apps) but they can't open the planner.</small></label>` : "")}
  </div>`;
}

function accessNote(access) {
  if (!access) return;
  if (access.synced) return toast("Sign-in list in Cloudflare updated.");
  if (access.reason === "not_configured") return toast("Saved. Until the Cloudflare link is set up, also add them to the “Netex users” group in Cloudflare so they can sign in.", "warn", 9000);
  if (access.reason !== "unchanged") toast(`Saved, but Cloudflare's sign-in list wasn't updated${access.detail ? `: ${access.detail}` : ""}.`, "bad", 9000);
}

export async function render(main, ctx) {
  const { me } = ctx;
  if (RANK[me.role] < RANK.admin) {
    main.innerHTML = html`<div class="card empty blocked"><h2>Admins only</h2><p>Ask an Admin or the Owner if someone needs access.</p></div>`;
    return;
  }
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Loading users…</div>`;
  const { users, groupSync } = await api("/users");
  const active = users.filter(u => u.status === "active" && u.role).length;

  main.innerHTML = html`
    <div class="page-head">
      <div><h1>Users &amp; access</h1><p>${active} ${active === 1 ? "person" : "people"} can open the planner. People sign in with their email and a one-time code — no passwords.</p></div>
      <button class="btn primary" id="addUser">${raw(PLUS)}Add person</button>
    </div>
    <div class="card list" role="list">
      <div class="list-head" aria-hidden="true"><span>Person</span><span>Role</span><span>Last signed in</span><span></span></div>
      ${users.map(u => raw(html`
        <button class="urow ${u.status === "active" ? "" : "inactive"}" role="listitem" data-id="${u.id}" ${raw(u.canEdit ? "" : "disabled")}
          aria-label="${u.name}, ${u.status === "active" ? roleName(u.role) : "turned off"}${u.canEdit ? ", edit" : ""}">
          <span class="who"><span class="avatar" aria-hidden="true">${initials(u.name)}</span><div><b>${u.name}${u.id === me.id ? " (you)" : ""}</b><span>${u.email}</span></div></span>
          <span>${u.status === "active" ? raw(html`<span class="chip ${u.role || ""}">${roleName(u.role)}</span>`) : raw('<span class="chip off">Turned off</span>')}</span>
          <span class="seen">${ago(u.lastSeen)}</span>
          ${raw(u.canEdit ? CHEV : "<span></span>")}
        </button>`))}
    </div>
    ${groupSync ? "" : raw(html`<p class="list-note">${raw(INFO)}<span>Cloudflare isn't linked yet, so after adding someone here also add their email to the “Netex users” group in Cloudflare (Access controls › Policies › Rule groups). Once linked, this list does it for you.</span></p>`)}`;

  main.querySelector("#addUser").addEventListener("click", () => addDialog(ctx, () => render(main, ctx)));
  main.querySelectorAll(".urow:not([disabled])").forEach(b => b.addEventListener("click", () => {
    const u = users.find(x => x.id === b.dataset.id);
    editDialog(ctx, u, () => render(main, ctx));
  }));
}

function addDialog({ me }, done) {
  openDialog({
    title: "Add a person",
    submitLabel: "Add person",
    body: html`
      <label class="field"><span>Name</span><input class="input" name="name" autocomplete="off" required maxlength="80" placeholder="e.g. Maria Castillo"></label>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="off" required placeholder="name@example.com">
        <small>They'll sign in with this address; a code is emailed to it each time.</small></label>
      <div class="field"><span>Role in the planner</span>${raw(roleChoices(me, "viewer", { allowNone: false }))}</div>`,
    onOpen: f => f.elements.name.focus(),
    async onSubmit(f) {
      const role = f.elements.role.value || null;
      const r = await api("/users", { method: "POST", body: { name: f.elements.name.value, email: f.elements.email.value, role } });
      toast(`${f.elements.name.value.trim()} added.`);
      accessNote(r.access);
      done();
    },
  });
}

function editDialog({ me }, u, done) {
  const self = u.id === me.id;
  openDialog({
    title: u.name,
    body: html`
      <label class="field"><span>Name</span><input class="input" name="name" required maxlength="80" value="${u.name}"></label>
      <div class="field"><span>Email</span><div>${u.email}</div><small>To change an email, turn this person off and add them again with the new address.</small></div>
      <label class="switch"><div><b>Can sign in</b><small>${self ? "You can't turn yourself off." : "Turn off when someone leaves; their history stays."}</small></div>
        <input type="checkbox" name="active" role="switch" ${raw(u.status === "active" ? "checked" : "")} ${raw(self ? "disabled" : "")}></label>
      <div class="field"><span>Role in the planner</span>${raw(roleChoices(me, u.role))}</div>`,
    async onSubmit(f) {
      const body = { name: f.elements.name.value, role: f.elements.role.value || null };
      if (!self) body.status = f.elements.active.checked ? "active" : "disabled";
      const r = await api(`/users/${u.id}`, { method: "PATCH", body });
      if (r.changed) { toast("Saved."); accessNote(r.access); done(); }
    },
  });
}
