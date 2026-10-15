// The count sheet: one row per item, answered the way the supply manager set for this location
// (a number, Out/Low/OK, or "Need any?"). Used by the count page on store devices and by the supply manager's
// "Enter a count" (the Workshop). Self-contained (no imports) because /count is served without a sign-in.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ESC[c]);
export const fmt = n => (n === null || n === undefined || n === "" ? "" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const plural = (n, unit) => {
  if (!unit) return fmt(n);
  const u = String(unit);
  if (Number(n) === 1 || /\)$/.test(u) || /s$/.test(u)) return `${fmt(n)} ${u}`;
  if (/[^aeiou]y$/.test(u)) return `${fmt(n)} ${u.slice(0, -1)}ies`;
  return `${fmt(n)} ${u.replace(/(sh|ch|x)$/, "$1e")}s`;
};
export { plural };

// Same rules as the server (src/logic.js) so the review screen shows what will be asked for. The server decides.
export function needOf(it, a = {}) {
  const par = it.par, hasPar = par !== null && par !== undefined;
  if (it.mode === "count") {
    if (a.qty === undefined || a.qty === null || a.qty === "") return null;
    const q = Number(a.qty); if (!Number.isFinite(q)) return null;
    if (!hasPar) return 0;
    const short = it.reorder !== null && it.reorder !== undefined ? q <= it.reorder : q < par;
    return short ? Math.max(0, Math.round((par - q) * 100) / 100) : 0;
  }
  if (it.mode === "level") {
    if (!["out", "low", "ok"].includes(a.level)) return null;
    if (a.level === "ok") return 0;
    if (!hasPar) return 1;
    return a.level === "out" ? par : par >= 2 ? Math.ceil(par / 2) : par;
  }
  if (a.level === "none") return 0;
  if (a.level !== "need") return null;
  const q = Number(a.qty); return Number.isFinite(q) && q > 0 ? q : 1;
}

const MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';
const SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>';

function parLine(it, warehouse) {
  const bits = [];
  if (it.par === null || it.par === undefined) bits.push("As needed");
  else if (it.reorder !== null && it.reorder !== undefined) bits.push(`Keep ${plural(it.par, it.unit)} · reorder at ${fmt(it.reorder)}`);
  else bits.push(`Keep ${plural(it.par, it.unit)}`);
  if (warehouse && it.vendor) bits.push(it.vendor + (it.sku ? ` #${it.sku}` : ""));
  return bits.join(" · ");
}
function lastLine(it) {
  if (!it.last) return "";
  const d = new Date(it.last.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const v = it.last.qty !== null && it.last.qty !== undefined && it.mode === "count" ? fmt(it.last.qty)
    : { out: "Out", low: "Low", ok: "OK", need: "Needed", none: "Didn't need" }[it.last.level] || "";
  return v ? `Last: ${v} (${d})` : "";
}

function control(it, a) {
  const id = esc(it.id);
  if (it.mode === "count") {
    return `<div class="cf-step" data-step>
      <button type="button" class="cf-pm" data-d="-1" aria-label="One less ${esc(it.name)}">${MINUS}</button>
      <input class="cf-num" type="text" inputmode="decimal" autocomplete="off" aria-label="${esc(it.name)}: how many ${esc(it.unit)} on hand" data-qty="${id}" value="${esc(a.qty ?? "")}" placeholder="–">
      <button type="button" class="cf-pm" data-d="1" aria-label="One more ${esc(it.name)}">${PLUS}</button></div>`;
  }
  if (it.mode === "level") {
    return `<div class="cf-seg" role="radiogroup" aria-label="${esc(it.name)}">${["out", "low", "ok"].map(l =>
      `<button type="button" role="radio" class="lv-${l}" aria-checked="${a.level === l}" data-level="${l}">${{ out: "Out", low: "Low", ok: "OK" }[l]}</button>`).join("")}</div>`;
  }
  return `<div class="cf-check"><div class="cf-seg" role="radiogroup" aria-label="${esc(it.name)}: need any?">
      <button type="button" role="radio" class="lv-ok" aria-checked="${a.level === "none"}" data-level="none">No</button>
      <button type="button" role="radio" class="lv-low" aria-checked="${a.level === "need"}" data-level="need">Need</button></div>
    <input class="cf-num small" type="text" inputmode="decimal" autocomplete="off" aria-label="How many ${esc(it.unit)} needed" data-qty="${id}" value="${esc(a.qty ?? "")}" placeholder="1" ${a.level === "need" ? "" : "hidden"}></div>`;
}

/**
 * Renders the sheet into `root`. opts: { items, warehouse, answers, onChange(answers) }.
 * Returns { answers(), lines(), reset() }.
 */
export function renderSheet(root, { items, warehouse = false, answers = {}, onChange = () => {} }) {
  const A = { ...answers };
  const byId = new Map(items.map(i => [i.id, i]));
  const vendors = [...new Set(items.map(i => i.vendor).filter(Boolean))];
  const cats = [];
  for (const it of items) if (!cats.includes(it.category)) cats.push(it.category);
  const filters = warehouse ? [["all", "All"], ["todo", "Not answered"], ["short", "Short last time"], ...vendors.map(v => ["v:" + v, v])]
    : [["all", "All"], ["todo", "Not answered"]];
  let filter = "all", q = "";

  root.innerHTML = `
    <div class="cf-tools">
      <label class="cf-search">${SEARCH}<input type="search" placeholder="Find an item" aria-label="Find an item" data-search></label>
      <div class="cf-filters" role="tablist" aria-label="Show">${filters.map(([k, l]) => `<button type="button" role="tab" data-filter="${esc(k)}" aria-selected="${k === "all"}">${esc(l)}</button>`).join("")}</div>
    </div>
    <div class="cf-sections">${cats.map(c => `
      <section class="cf-sec" data-cat="${esc(c)}"><h3>${esc(c)} <small data-catcount></small></h3>
        <ul class="cf-list">${items.filter(i => i.category === c).map(it => `
          <li class="cf-row" data-item="${esc(it.id)}">
            <div class="cf-name"><b>${esc(it.name)}</b><small>${esc(parLine(it, warehouse))}</small><small class="cf-last">${esc(lastLine(it))}</small>${it.notes ? `<small class="cf-note">${esc(it.notes)}</small>` : ""}</div>
            <div class="cf-ctl">${control(it, A[it.id] || {})}<span class="cf-unit">${esc(it.mode === "count" ? it.unit : "")}</span></div>
            <div class="cf-need" aria-live="polite"></div>
          </li>`).join("")}</ul>
      </section>`).join("")}
      <p class="cf-none" hidden>Nothing matches.</p>
    </div>`;

  const rowOf = id => root.querySelector(`.cf-row[data-item="${CSS.escape(id)}"]`);
  function paintRow(id) {
    const it = byId.get(id), a = A[id] || {}, row = rowOf(id);
    const n = needOf(it, a);
    row.classList.toggle("done", n !== null);
    row.classList.toggle("short", n > 0);
    row.querySelector(".cf-need").textContent = n > 0 ? `${warehouse ? "Short" : "Send"} ${plural(n, it.unit)}` : "";
    const qi = row.querySelector(".cf-check [data-qty]"); if (qi) qi.hidden = a.level !== "need";
  }
  function applyFilter() {
    let shown = 0;
    root.querySelectorAll(".cf-row").forEach(row => {
      const it = byId.get(row.dataset.item), a = A[it.id] || {};
      let show = !q || (it.name + " " + (it.sku || "") + " " + (it.vendor || "")).toLowerCase().includes(q);
      if (filter === "todo") show = show && needOf(it, a) === null;
      if (filter === "short") show = show && it.last && (needOf(it, { qty: it.last.qty, level: it.last.level }) || 0) > 0;
      if (filter.startsWith("v:")) show = show && it.vendor === filter.slice(2);
      row.hidden = !show; if (show) shown++;
    });
    root.querySelectorAll(".cf-sec").forEach(s => { const vis = s.querySelectorAll(".cf-row:not([hidden])").length; s.hidden = !vis; });
    root.querySelector(".cf-none").hidden = shown > 0;
  }
  const changed = id => { paintRow(id); onChange(A); };
  const setQty = (id, v) => { A[id] = { ...(A[id] || {}), qty: v }; changed(id); };

  root.addEventListener("click", e => {
    const row = e.target.closest(".cf-row");
    const pm = e.target.closest(".cf-pm");
    if (pm && row) {
      const inp = row.querySelector("[data-qty]");
      const cur = inp.value === "" ? (pm.dataset.d > 0 ? 0 : 1) : Number(inp.value) || 0;
      const next = Math.max(0, Math.round((cur + Number(pm.dataset.d)) * 100) / 100);
      inp.value = String(next); setQty(row.dataset.item, inp.value); return;
    }
    const lv = e.target.closest("[data-level]");
    if (lv && row) {
      const id = row.dataset.item, was = (A[id] || {}).level;
      const level = was === lv.dataset.level ? undefined : lv.dataset.level;   // tap again to clear
      A[id] = { ...(A[id] || {}), level };
      lv.parentElement.querySelectorAll("[data-level]").forEach(b => b.setAttribute("aria-checked", String(b.dataset.level === level)));
      changed(id);
      if (level === "need") row.querySelector("[data-qty]")?.focus();
      return;
    }
    const f = e.target.closest("[data-filter]");
    if (f) { filter = f.dataset.filter; root.querySelectorAll("[data-filter]").forEach(b => b.setAttribute("aria-selected", String(b === f))); applyFilter(); }
  });
  root.addEventListener("input", e => {
    if (e.target.matches("[data-search]")) { q = e.target.value.trim().toLowerCase(); applyFilter(); return; }
    const inp = e.target.closest("[data-qty]");
    if (inp) {
      const v = inp.value.replace(/[^\d.]/g, "");
      if (v !== inp.value) inp.value = v;
      setQty(inp.dataset.qty, v);
    }
  });
  // Enter moves to the next number box, like a paper sheet
  root.addEventListener("keydown", e => {
    if (e.key !== "Enter" || !e.target.matches(".cf-num")) return;
    e.preventDefault();
    const all = [...root.querySelectorAll(".cf-row:not([hidden]) .cf-num:not([hidden])")];
    all[all.indexOf(e.target) + 1]?.focus();
  });
  items.forEach(i => paintRow(i.id));

  return {
    answers: () => A,
    lines: () => items.map(it => ({ it, a: A[it.id] || {} })).map(({ it, a }) => ({ it, a, need: needOf(it, a) })).filter(x => x.need !== null)
      .map(x => ({ item: x.it.id, qty: x.a.qty === "" || x.a.qty === undefined ? null : Number(x.a.qty), level: x.a.level ?? null, need: x.need, name: x.it.name, unit: x.it.unit })),
    progress: () => ({ done: items.filter(it => needOf(it, A[it.id] || {}) !== null).length, total: items.length }),
  };
}
