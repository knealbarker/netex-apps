// Small UI helpers: safe HTML, toasts, dialogs, dates.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ESC[c]);
// html`...${value}...` escapes every value unless it is wrapped with raw()
const RAW = Symbol("raw");
export const raw = s => ({ [RAW]: String(s) });
export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = vals[i - 1];
    const piece = Array.isArray(v) ? v.map(x => (x && x[RAW] !== undefined ? x[RAW] : esc(x))).join("") : v && v[RAW] !== undefined ? v[RAW] : esc(v);
    return out + piece + s;
  }, "");
}

export function toast(message, kind = "ok", ms = 4200) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = html`<i></i><span>${message}</span>`;
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove(); // keep the stack short
  setTimeout(() => el.remove(), ms);
}

export const initials = name => String(name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();

export function ago(iso) {
  if (!iso) return "Never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "Just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  if (d < 14) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export const ROLES = [
  { id: "owner", name: "Owner", does: "Everything, including other Owners." },
  { id: "admin", name: "Admin", does: "Everything a supply manager does, plus who can sign in (Users & access)." },
  { id: "manager", name: "Supply manager", does: "Shuttle lists, vendor orders, count requests, the supply list, counters and devices." },
  { id: "viewer", name: "Viewer", does: "Sees the lists and orders. Can't change anything." },
];
export const roleName = id => ROLES.find(r => r.id === id)?.name || "No access";
export const RANK = { owner: 40, admin: 30, manager: 20, viewer: 10 };

/** Opens a <dialog> built from HTML. onSubmit(form, dialog) may throw to show an error in the dialog. */
export function openDialog({ title, body, submitLabel = "Save", extraFoot = "", onSubmit, onOpen }) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = html`<form method="dialog" novalidate>
      <div class="dlg-head"><h2>${title}</h2></div>
      <div class="dlg-body"><div class="form-error" hidden></div>${raw(body)}</div>
      <div class="dlg-foot">${raw(extraFoot)}<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${submitLabel}</button></div>
    </form>`;
  document.body.append(dlg);
  const form = dlg.querySelector("form"), err = dlg.querySelector(".form-error"), submit = form.querySelector('[type="submit"]');
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  form.addEventListener("submit", async e => {
    e.preventDefault();
    err.hidden = true; submit.disabled = true;
    try { if ((await onSubmit(form, dlg)) !== false) dlg.close(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { submit.disabled = false; }
  });
  dlg.showModal();
  onOpen && onOpen(form, dlg);
  return dlg;
}

/** A fresh AbortSignal for a view's listeners on <main>: re-rendering (or leaving) drops the old ones. */
export function listen(main) { main._ac?.abort(); main._ac = new AbortController(); return main._ac.signal; }
