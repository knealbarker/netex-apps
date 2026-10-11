// Settings (#/settings): targets, average pay rates until Rippling sends real ones, which locations roll into which store,
// who sees labor numbers, and (Owner) loading a Rippling CSV by hand.
import { api } from "../api.js";
import { html, raw, toast, RANK } from "../ui.js";

export async function render(main, ctx) {
  if (RANK[ctx.me.role] < RANK.admin) {
    main.innerHTML = html`<div class="card empty blocked"><h2>Admins only</h2><p>Ask an Admin or the Owner to change the Retail Snapshot's settings.</p></div>`;
    return;
  }
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Loading settings…</div>`;
  const { settings: s, locations, departments, rates, rippling } = await api("/settings");
  const stores = locations.filter(l => l.kind === "store").map(l => l.name);
  const depts = [...new Set([...departments, ...Object.keys(s.avgRates)])];
  const owner = ctx.me.role === "owner";

  main.innerHTML = html`
    <div class="page-head"><div><h1>Settings</h1><p>How the Retail Snapshot adds things up. Changes apply to every range, past and future.</p></div></div>
    <form id="f" class="set-grid" novalidate>
      <section class="card set-card">
        <h2>Labor targets</h2>
        <div class="two">
          <label class="field"><span>Store labor target</span><div class="suffix"><input class="input" name="targetRetail" inputmode="decimal" value="${s.targetRetail}"><i>%</i></div><small>Store labor $ ÷ store revenue.</small></label>
          <label class="field"><span>Production labor target</span><div class="suffix"><input class="input" name="targetPlant" inputmode="decimal" value="${s.targetPlant}"><i>%</i></div><small>Workshop + Laundry Hub labor $ ÷ company revenue.</small></label>
        </div>
        <label class="field"><span>Payroll burden</span><div class="suffix"><input class="input" name="burdenPct" inputmode="decimal" value="${s.burdenPct}"><i>%</i></div><small>Added on top of wages for payroll taxes and similar costs. 0 = wages only.</small></label>
        <label class="field"><span>Week starts on</span><select class="input" name="weekStart"><option value="1" ${raw(s.weekStart === 1 ? "selected" : "")}>Monday</option><option value="0" ${raw(s.weekStart === 0 ? "selected" : "")}>Sunday</option></select></label>
      </section>

      <section class="card set-card">
        <h2>Pay rates</h2>
        <p class="dlg-lead">${rates && rates.people ? `${rates.withRate || 0} of ${rates.people} people who worked in the last 5 weeks have a pay rate from Rippling.` : "No hours from Rippling yet."}
          ${rippling && rippling.rateColumn ? ` Rippling's report has a pay rate column (“${rippling.rateColumn}”).` : " Rippling's report doesn't have a pay rate column yet; once it does, rates are read in by themselves."}
          Until a person has a rate, their hours are costed at the average below.</p>
        <div class="rates">
          ${depts.map(d => raw(html`<label class="field"><span>${d}</span><div class="suffix pre"><i>$</i><input class="input" name="rate:${d}" inputmode="decimal" value="${s.avgRates[d] ?? s.defaultRate}"><i>/ hr</i></div></label>`))}
          <label class="field"><span>Anyone else</span><div class="suffix pre"><i>$</i><input class="input" name="defaultRate" inputmode="decimal" value="${s.defaultRate}"><i>/ hr</i></div></label>
        </div>
      </section>

      <section class="card set-card">
        <h2>Stores</h2>
        <p class="dlg-lead">A location rolled into a store keeps its own line but counts in that store's totals and labor % (Winnsboro's orders are detailed by Sulphur Springs staff). Hidden locations count under “Other”.</p>
        <div class="loc-list">
          ${stores.map(n => raw(html`<div class="loc-row">
            <b>${n}</b>
            <label class="inline"><span>Counts in</span><select class="input" name="roll:${n}"><option value="">Itself</option>${stores.filter(x => x !== n).map(x => raw(html`<option ${raw(s.rollup[n] === x ? "selected" : "")}>${x}</option>`))}</select></label>
            <label class="check"><input type="checkbox" name="hide:${n}" ${raw(s.hidden.includes(n) ? "checked" : "")}> Not a store</label>
          </div>`))}
          ${stores.length ? "" : raw(html`<p class="muted">Stores appear here once SMRT orders have been read.</p>`)}
        </div>
      </section>

      <section class="card set-card">
        <h2>Who sees labor cost</h2>
        <label class="switch"><div><b>Managers and Viewers see labor $ and labor %</b><small>Admins and the Owner always do. Nobody sees individual pay rates here.</small></div><input type="checkbox" name="managersSeeLabor" ${raw(s.managersSeeLabor ? "checked" : "")}></label>
      </section>
      <div class="save-bar"><button class="btn primary" type="submit">Save settings</button></div>
    </form>

    ${owner ? raw(html`<section class="card set-card import">
      <h2>Load a Rippling CSV</h2>
      <p class="dlg-lead">Rippling's emailed report already keeps hours up to date. Use this to fill a gap: export <b>All Time Clock Entries</b> from Rippling and choose the file. Days in the file replace what's stored for the same person, day and store; today's live punches are left alone.</p>
      <div class="import-row"><input type="file" id="csv" accept=".csv,text/csv" class="input"><button class="btn" id="load" type="button">Load file</button></div>
      <p class="muted" id="loadMsg" aria-live="polite"></p>
    </section>`) : ""}`;

  const f = main.querySelector("#f");
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const el = f.elements, body = { targetRetail: el.targetRetail.value, targetPlant: el.targetPlant.value, burdenPct: el.burdenPct.value, defaultRate: el.defaultRate.value,
      weekStart: el.weekStart.value, managersSeeLabor: el.managersSeeLabor.checked, avgRates: {}, rollup: {}, hidden: [] };
    for (const i of f.querySelectorAll("[name^='rate:']")) body.avgRates[i.name.slice(5)] = i.value;
    for (const i of f.querySelectorAll("[name^='roll:']")) if (i.value) body.rollup[i.name.slice(5)] = i.value;
    for (const i of f.querySelectorAll("[name^='hide:']")) if (i.checked) body.hidden.push(i.name.slice(5));
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    try { await api("/settings", { method: "PUT", body }); toast("Settings saved."); }
    catch (x) { toast(x.message, "bad", 7000); }
    finally { btn.disabled = false; }
  });

  const load = main.querySelector("#load");
  if (load) load.addEventListener("click", async () => {
    const file = main.querySelector("#csv").files[0], msg = main.querySelector("#loadMsg");
    if (!file) { msg.textContent = "Choose the CSV file first."; return; }
    load.disabled = true; msg.textContent = "Loading…";
    try {
      const r = await api("/import/rippling", { method: "POST", body: { csv: await file.text() } });
      const depts = Object.entries(r.departments || {}).map(([k, v]) => `${k} ${v}`).join(", ");
      msg.textContent = `Loaded ${r.used} time entries: ${r.days} person-days${depts ? ` (${depts})` : ""}${r.added?.length ? `; new people: ${r.added.join(", ")}` : ""}${r.rates ? `; ${r.rates} pay rates` : ""}.`;
      toast("Rippling file loaded.");
    } catch (x) { msg.textContent = x.message; toast(x.message, "bad", 7000); }
    finally { load.disabled = false; }
  });
}
