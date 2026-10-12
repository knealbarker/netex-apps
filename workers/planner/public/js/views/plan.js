// Plan: pieces from SMRT, the crew on each station, the day simulated minute by minute, deadlines, checks, and publishing.
// Changes save on their own (a second PC that saved in between wins and this one is refreshed with its plan).
import { api } from "../api.js";
import { html, raw, ago, toast, openDialog, RANK } from "../ui.js";
import { CATS, CAT_FULL, CAT_LABEL, parseTime, hhmm, fmtClock, hm, fmtH, fmtN, fmt$, stepsOf, outInfo } from "../engine/engine.js";
import * as M from "../plan/model.js";

const TILE = { dct: "DC tops", dcb: "DC bottoms", slt: "Starch tops", slb: "Starch bottoms", comf: "Comforters", tc: "Tablecloths" };
const TYPE_DESC = { slt: "Starch tops press", slt2: "Helps on SLT 1", slb: "Starch bottoms press", dct: "Dry cleaning tops", dcb: "Dry cleaning bottoms, tablecloths", asm: "Inspect, assemble, bag", ops: "Runs the machines" };
const COLOR = { slt: "#4f8ff7", slt2: "#7aa9fa", slb: "#8b7cf6", dct: "#f59e4b", dcb: "#e2609b", asm: "#22c38e", ops: "#7c879c", comf: "#14b8a6", wash: "#5b6b84" };
const CAT_COLOR = { dct: COLOR.dct, dcb: COLOR.dcb, slt: COLOR.slt, slb: COLOR.slb, comf: COLOR.comf, tc: "#c084fc" };
const SMRT_ORDER = (customer, no) => `https://towncountryclean.smrtapp.com/posx/dash/customer/clothestracker/${encodeURIComponent(customer)}/?saleId=${String(no).replace(/\D/g, "")}`;
const ORD = n => ["", "1st", "2nd", "3rd"][n] || `${n}th`;
const fmtDay = (d, today) => { const s = new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); return d === today ? `Today · ${s}` : s; };
const longDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const nowH = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
const first = n => String(n || "").split(" ")[0];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let pick = null; // the day being looked at, kept while moving between sections

export async function render(main, ctx) {
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Reading pieces and the crew…</div>`;
  const [V0, SET, TEAM] = await Promise.all([api("/pieces"), api("/settings"), api("/team")]);
  const can = RANK[ctx.me.role] >= RANK.manager, admin = RANK[ctx.me.role] >= RANK.admin;
  const st = { V: V0, SET, TEAM, plan: null, crew: null, overrides: {}, rev: 0, dirty: false, saving: null, undo: [], note: null, X: null };
  const s = M.engineSettings(SET, V0.prices);
  const pos = M.positions(SET);
  const POS = pos.stations.concat(pos.ops);
  let people = M.peopleFrom(TEAM);
  const days = () => [st.V.isWorkDay ? st.V.today : null, st.V.next].filter(Boolean);
  if (!days().includes(pick)) pick = days()[0];
  let AX = null, D = null, saveT = null; // timeline axis, the bar being dragged, the pending save
  const root = Symbol("plan"); main._plan = root;
  const alive = () => main._plan === root && document.getElementById("pl-root");

  // listeners and timers end when the planner moves to another section
  const ac = new AbortController(), on = { signal: ac.signal };
  await openDay(pick);
  const timers = [setInterval(() => tick(), 60 * 1000), setInterval(() => refreshPieces(), 5 * 60 * 1000)];
  const stop = () => { if (!alive()) { timers.forEach(clearInterval); ac.abort(); } };
  const leave = () => { if (st.dirty) save(); setTimeout(stop, 0); };
  window.addEventListener("hashchange", leave, on);
  document.addEventListener("keydown", onKey, on);

  // ------------------------------------------------------------ loading a day
  async function openDay(day) {
    pick = day;
    const plan = await api(`/plan/${day}`);
    adopt(plan);
    st.undo = [];
    if (!plan.rev && !Object.keys(plan.crew).length) suggest("open");
    drawPage();
  }
  function adopt(plan) {
    st.plan = plan; st.rev = plan.rev; st.overrides = { ...plan.overrides }; st.crew = M.crewFromServer(plan.crew, POS, s); st.dirty = false; st.note = null;
  }
  function makeP() {
    const dp = M.dayPieces(st.V, st.SET, pick);
    const q = M.effectiveQ(dp.base, st.overrides);
    return { s, ...pos, people, crew: st.crew, q, waves: dp.waves, day: pick, today: st.V.today, isToday: dp.isToday, now: dp.isToday ? nowH() : null,
      callouts: st.plan.callouts, history: st.plan.history, clock: st.plan.clock, published: st.plan.published, admin, expected: dp.expected && !Object.keys(st.overrides).length, dp };
  }
  function suggest(why) {
    const P = makeP(), E = M.evaluate(P).E;
    const r = M.suggestCrew(P, E);
    st.crew = r.crew;
    st.note = { basis: r.basis, left: r.left.map(e => e.name), why };
  }

  // ------------------------------------------------------------ editing, undo and saving
  function snap() { return JSON.stringify({ crew: st.crew, overrides: st.overrides }); }
  function edit(fn, { table = true, msg, keepNote = false } = {}) {
    if (!can) return;
    st.undo.push(snap()); if (st.undo.length > 60) st.undo.shift();
    fn();
    if (!keepNote) st.note = null;
    dirty();
    update({ table });
    if (msg) toast(msg, "ok", 2600);
  }
  function undo() {
    if (!can || !st.undo.length) return;
    const prev = JSON.parse(st.undo.pop()); st.crew = prev.crew; st.overrides = prev.overrides;
    dirty(); update({ table: true }); toast("Undone.", "ok", 1800);
  }
  function onKey(e) {
    if (!alive()) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) { e.preventDefault(); undo(); }
  }
  function dirty() { st.dirty = true; saveStatus(); clearTimeout(saveT); saveT = setTimeout(save, 1200); }
  async function save() {
    clearTimeout(saveT);
    if (!can || !st.dirty) return;
    if (st.saving) { await st.saving; return save(); }
    st.dirty = false; saveStatus("saving");
    const body = { rev: st.rev, crew: M.crewToServer(st.crew), overrides: st.overrides };
    st.saving = api(`/plan/${pick}`, { method: "PUT", body }).then(r => {
      st.rev = r.rev; st.plan.rev = r.rev; st.plan.updatedBy = ctx.me.name; st.plan.updatedAt = new Date().toISOString(); if (st.plan.status === "new") st.plan.status = "draft";
      for (const c of Object.values(st.crew)) if (c.emp && !c.source) c.source = "user";
      saveStatus();
    }).catch(e => {
      if (e.status === 409 && e.body.latest) {
        adopt(e.body.latest); st.conflict = true; toast(e.message, "warn", 7000); drawPage();
      } else { st.dirty = true; saveStatus("error", e.message); toast(`Not saved: ${e.message}`, "bad", 6000); }
    }).finally(() => { st.saving = null; });
    return st.saving;
  }
  function saveStatus(state, msg) {
    const el = document.getElementById("pl-save"); if (!el) return;
    if (!can) { el.textContent = st.plan.updatedBy ? `Saved by ${st.plan.updatedBy} ${ago(st.plan.updatedAt).toLowerCase()}` : ""; return; }
    if (state === "saving") { el.className = "saved-note"; el.textContent = "Saving…"; return; }
    if (state === "error") { el.className = "saved-note bad"; el.textContent = "Not saved"; el.title = msg || ""; return; }
    if (st.dirty) { el.className = "saved-note dirty"; el.textContent = "Unsaved changes"; return; }
    if (!st.rev) { el.className = "saved-note"; el.textContent = st.note ? "Suggested · not saved yet" : "Not saved yet"; return; }
    el.className = "saved-note ok"; el.textContent = `Saved${st.plan.updatedBy && st.plan.updatedBy !== ctx.me.name ? ` by ${st.plan.updatedBy}` : ""} ${ago(st.plan.updatedAt).toLowerCase()}`;
    const u = document.getElementById("pl-undo"); if (u) u.disabled = !st.undo.length;
  }

  // ------------------------------------------------------------ background refresh
  async function tick() {
    if (!alive()) return stop();
    if (!st.dirty && !st.saving) {
      try {
        const p = await api(`/plan/${pick}`);
        if (p.rev !== st.rev) { adopt(p); toast(`${p.updatedBy || "Someone"} changed this plan. Showing their version.`, "warn", 6000); drawPage(); return; }
        st.plan.callouts = p.callouts; st.plan.clock = p.clock; st.plan.published = p.published;
      } catch { /* try again next minute */ }
    }
    update({ table: false });
  }
  async function refreshPieces() {
    if (!alive()) return stop();
    try { st.V = await api("/pieces"); if (!days().includes(pick)) return openDay(days()[0]); update({ table: false }); drawHeadPill(); } catch { /* keep the last counts */ }
  }

  // ------------------------------------------------------------ the page
  function drawPage() {
    const P = makeP();
    main.innerHTML = html`<div id="pl-root">
      <div class="page-head plan-head">
        <div><h1>Plan</h1><p>${longDay(pick)}${P.isToday ? "" : P.dp.expected ? " · pieces include what usually still comes in" : ""}</p></div>
        <div class="head-actions">
          <span class="saved-note" id="pl-save" aria-live="polite"></span>
          ${can ? raw(html`<button class="btn ghost small" id="pl-undo" title="Undo (Ctrl+Z)" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>Undo</button>
            <button class="btn small" id="pl-suggest" title="Who usually works this weekday, on their usual stations">Suggest from history</button>
            <button class="btn small" id="pl-auto" title="Pick who's working; the planner places them">Auto-assign</button>
            <button class="btn primary small" id="pl-pub"></button>`) : ""}
        </div>
      </div>
      <div class="plan-bar">
        <div class="seg" role="tablist" aria-label="Day">${days().map(d => raw(html`<button role="tab" aria-selected="${d === pick}" data-day="${d}">${fmtDay(d, st.V.today)}</button>`))}</div>
        <span id="pl-pill"></span>
      </div>
      <div id="pl-note"></div>
      <section class="verdict" id="pl-verdict" aria-live="polite"></section>
      <section class="tiles plan-tiles" id="pl-tiles" aria-label="Pieces by kind of work"></section>
      <div class="plan-grid">
        <div class="pg-main">
          <section class="card pl-card" id="pl-crew-card">
            <header class="pl-cardhead"><div><h2>Crew</h2><p>Who's on each station, from when, and for how long. ${can ? "Changes save on their own." : ""}</p></div><div id="pl-callouts"></div></header>
            <div id="pl-crew"></div>
          </section>
          <section class="card pl-card">
            <header class="pl-cardhead"><div><h2>The day</h2><p>Each person's work, minute by minute. ${can ? "Drag a bar sideways to change when that person starts." : ""}</p></div></header>
            <div id="pl-gantt"></div>
          </section>
        </div>
        <aside class="pg-side">
          <section class="card pl-card"><header class="pl-cardhead"><div><h2>Check before you publish</h2></div></header><div id="pl-checks" class="checks-list"></div></section>
          <section class="card pl-card"><header class="pl-cardhead"><div><h2>Deadlines</h2><p>When each shuttle's pieces will be ready, in the order they're due.</p></div></header><div id="pl-waves"></div></section>
          ${admin ? raw('<section class="card pl-card"><header class="pl-cardhead"><div><h2>Labor and revenue</h2><p>Admins and the Owner see this.</p></div></header><div id="pl-money"></div></section>') : ""}
        </aside>
      </div>
      <div id="pl-orders"></div>
    </div>`;
    main.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", async () => {
      if (b.dataset.day === pick) return;
      if (st.dirty) await save();
      main.querySelectorAll("[data-day]").forEach(x => x.setAttribute("aria-selected", String(x === b)));
      await openDay(b.dataset.day);
      main.querySelector(`[data-day="${pick}"]`)?.focus();
    }));
    if (can) {
      main.querySelector("#pl-undo").addEventListener("click", undo);
      main.querySelector("#pl-suggest").addEventListener("click", () => openDialog({
        title: "Suggest a crew from history?", submitLabel: "Replace the crew",
        body: html`<p class="dlg-lead">Replaces the crew for ${longDay(pick)} with the people who usually work ${M.WD[M.weekday(pick)]}s, at their usual clock-in, on the stations they're usually on. You can undo it.</p>`,
        onSubmit: () => edit(() => suggest("button"), { keepNote: true }),
      }));
      main.querySelector("#pl-auto").addEventListener("click", autoDialog);
      main.querySelector("#pl-pub").addEventListener("click", publishDialog);
    }
    drawHeadPill(); drawOrders(); update({ table: true });
  }

  function drawHeadPill() {
    const el = document.getElementById("pl-pill"); if (!el) return;
    const last = st.V.smrt.lastOk, run = st.V.smrt.lastRun;
    if (!last && !run) { el.innerHTML = html`<span class="pill">SMRT live updates start on the next work day</span>`; return; }
    const mins = last ? (Date.now() - Date.parse(last)) / 60000 : Infinity, err = run && run.status === "error", stale = st.V.isWorkDay && mins > 30;
    el.innerHTML = html`<span class="pill ${err || stale ? "warn" : "ok"}" title="${run?.message || ""}"><i></i>${err ? "SMRT update failed · " : ""}Pieces from SMRT, updated ${last ? ago(last).toLowerCase() : "—"}</span>`;
  }
  function drawNote() {
    const el = document.getElementById("pl-note"); if (!el) return;
    if (!st.note) { el.innerHTML = ""; return; }
    el.innerHTML = html`<div class="banner info"><b>Suggested from history.</b> Who usually works ${M.WD[M.weekday(pick)]}s (from ${st.note.basis}), at their usual clock-in, on the stations they're usually on.${st.note.left.length ? ` Not placed: ${st.note.left.join(", ")}.` : ""}
      ${can && !st.rev ? raw(html` <button class="linkish" id="pl-keep">Keep this crew</button>`) : ""}</div>`;
    el.querySelector("#pl-keep")?.addEventListener("click", () => { st.dirty = true; save(); st.note = null; drawNote(); });
  }

  /** Runs the plan and redraws everything that depends on it. The crew table is only rebuilt when asked, so typing isn't interrupted. */
  function update({ table }) {
    if (!alive()) return;
    const X = st.X = M.evaluate(makeP());
    drawNote(); drawVerdict(X); drawTiles(X); drawChecks(X); drawWaves(X); drawGantt(X); if (admin) drawMoney(X);
    if (table) drawCrew(X); else crewOutcomes(X);
    drawPub(X); saveStatus();
  }

  function drawVerdict(X) {
    const v = X.verdict, el = document.getElementById("pl-verdict");
    el.className = `verdict ${v.cls}`;
    el.innerHTML = html`<div class="v-head"><span class="v-ico" aria-hidden="true">${v.cls === "ok" ? "✓" : v.cls === "idle" ? "…" : "!"}</span><b>${v.head}</b></div>
      <div class="v-kpis">${v.kpis.map(k => raw(html`<div class="v-k"><b class="${k.cls || ""}">${k.v}</b><span>${k.l}</span></div>`))}</div>`;
  }

  function drawTiles(X) {
    const P = X.P, D = P.dp.D, el = document.getElementById("pl-tiles");
    el.innerHTML = CATS.map(k => {
      const over = st.overrides[k] != null, smrt = P.dp.base[k], v = P.q[k];
      const done = P.isToday ? D.done[k] : 0;
      const sub = over ? `typed · SMRT says ${fmtN(smrt)}` : P.isToday ? `${fmtN(done)} done${P.dp.withOverdue && st.V.overdue.q[k] ? ` · incl. ${fmtN(st.V.overdue.q[k])} overdue` : ""}` : P.dp.expected && D.expected[k] > D.q[k] ? `expected · ${fmtN(D.q[k])} in so far` : "due";
      return html`<${can ? "button" : "div"} class="tile ${v ? "" : "zero"} ${over ? "typed" : ""}" ${can ? raw(`type="button" data-cat="${k}" title="Change the number to plan with"`) : ""}>
        <span class="t-label"><i class="sw" style="--c:${CAT_COLOR[k]}"></i>${TILE[k]}</span><b class="t-num">${fmtN(v)}</b><span class="t-sub">${sub}</span>
        ${P.isToday && v ? raw(html`<span class="bar" aria-hidden="true"><i style="width:${Math.min(100, Math.round(done / v * 100))}%"></i></span>`) : ""}</${can ? "button" : "div"}>`;
    }).join("") + html`<div class="tile total"><span class="t-label">All pieces</span><b class="t-num">${P.expected ? "~" : ""}${fmtN(CATS.reduce((t, k) => t + P.q[k], 0))}</b>
      <span class="t-sub">${P.isToday ? `${fmtN(D.doneTotal)} done · ${fmtN(D.orders)} orders` : `${fmtN(D.orders)} orders so far`}</span></div>`;
    el.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => countDialog(b.dataset.cat)));
  }
  function countDialog(k) {
    const P = makeP(), smrt = P.dp.base[k], cur = st.overrides[k];
    openDialog({
      title: `${CAT_FULL[k]} to plan`, submitLabel: "Use this number",
      body: html`<p class="dlg-lead">SMRT says <b>${fmtN(smrt)}</b>${P.dp.expected ? " (with what usually still comes in)" : ""}. Type a different number if you know better — it's kept for this day only.</p>
        <label class="field"><span>Pieces</span><input class="input" name="n" type="number" min="0" max="20000" step="1" inputmode="numeric" value="${cur ?? smrt}" required></label>`,
      extraFoot: cur != null ? html`<button type="button" class="btn ghost left" data-reset>Use SMRT's number</button>` : "",
      onOpen: (form, dlg) => { form.n.select(); dlg.querySelector("[data-reset]")?.addEventListener("click", () => { edit(() => { delete st.overrides[k]; }, { table: false }); dlg.close(); }); },
      onSubmit: form => {
        const n = Math.round(+form.n.value);
        if (!(n >= 0 && n <= 20000) || form.n.value === "") throw new Error("Type a number of pieces.");
        edit(() => { if (n === smrt) delete st.overrides[k]; else st.overrides[k] = n; }, { table: false });
      },
    });
  }

  // ---- crew table
  function personOptions(P, E, code) {
    const used = {}; for (const [c, x] of Object.entries(st.crew)) if (x.emp) used[x.emp] = c;
    const out = new Set((P.callouts || []).map(c => c.personId));
    const cur = st.crew[code].emp, label = c => POS.find(p => p.id === c)?.label || c;
    const trained = people.filter(e => E.rankOf(e, code)).sort((a, b) => E.rankOf(a, code) - E.rankOf(b, code) || a.name.localeCompare(b.name));
    const other = people.filter(e => !E.rankOf(e, code)).sort((a, b) => a.name.localeCompare(b.name));
    const opt = (e, rk) => html`<option value="${e.id}" ${e.id === cur ? "selected" : ""}>${e.name}${rk ? ` · ${ORD(rk)}` : ""}${used[e.id] && used[e.id] !== code ? ` · on ${label(used[e.id])}` : ""}${out.has(e.id) ? " · called out" : ""}</option>`;
    const curGone = cur && !people.some(e => e.id === cur);
    return html`<option value="">— Nobody —</option>${curGone ? raw(html`<option value="${cur}" selected>${M.nameOf({ people: [] }, cur)} (not on the team list)</option>`) : ""}
      ${trained.length ? raw(html`<optgroup label="Trained · best first">${trained.map(e => raw(opt(e, E.rankOf(e, code))))}</optgroup>`) : ""}
      ${other.length ? raw(html`<optgroup label="Not trained here">${other.map(e => raw(opt(e, 0)))}</optgroup>`) : ""}`;
  }
  function drawCrew(X) {
    const P = X.P, E = X.E, el = document.getElementById("pl-crew");
    const keep = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    const clock = M.clockInOf(P);
    const row = (p, isOps) => {
      const c = st.crew[p.id], dis = can ? "" : "disabled";
      const rk = c.emp ? E.rankOf(E.empById(c.emp), p.id) : 0;
      return html`<div class="cr-row ${c.emp ? "" : "vacant"}" data-code="${p.id}">
        <div class="cr-st"><i class="sw" style="--c:${COLOR[isOps ? "ops" : p.type]}"></i><span><b>${p.label}</b><small>${TYPE_DESC[isOps ? "ops" : p.type] || ""}</small></span></div>
        <label class="cr-who"><span class="sr">Person on ${p.label}</span><select class="input" id="who-${p.id}" data-f="emp" ${dis}>${raw(personOptions(P, E, p.id))}</select>
          ${c.emp && !rk ? raw('<small class="warn-txt">Not trained here</small>') : c.emp && clock[c.emp] ? raw(html`<small class="good-txt">Clocked in ${fmtClock(parseTime(clock[c.emp]))}</small>`) : c.emp && P.isToday && P.now > parseTime(c.start) + 0.25 && P.clock?.length ? raw('<small class="warn-txt">Not clocked in yet</small>') : ""}</label>
        <label class="cr-f"><span>Clock-in</span><input class="input" type="time" step="300" id="start-${p.id}" data-f="start" value="${c.start}" ${c.emp ? "" : "disabled"} ${dis}></label>
        <label class="cr-f"><span>Hours</span><input class="input" type="number" min="0" max="16" step="0.25" id="hrs-${p.id}" data-f="hrs" value="${c.hrs}" ${c.emp ? "" : "disabled"} ${dis}></label>
        <label class="cr-f"><span>Hard stop</span><input class="input" type="time" step="300" id="stop-${p.id}" data-f="stop" value="${c.stop || ""}" ${c.emp ? "" : "disabled"} ${dis}></label>
        <div class="cr-out" id="out-${p.id}"></div>
        <div class="cr-act">${can && c.emp ? raw(html`<button class="icon-btn" data-out="${p.id}" title="${first(M.nameOf(P, c.emp))} called out" aria-label="${M.nameOf(P, c.emp)} called out"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="3.2"/><path d="M4 19c.6-3.2 2.9-5 6-5 1.4 0 2.6.4 3.6 1"/><path d="m16 15 5 5m0-5-5 5"/></svg></button>`) : ""}</div>
      </div>`;
    };
    el.innerHTML = html`<div class="cr-head" aria-hidden="true"><span>Station</span><span>Person</span><span>Clock-in</span><span>Hours</span><span>Hard stop</span><span>Clock-out</span><span></span></div>
      ${pos.stations.map(p => raw(row(p, false)))}
      ${pos.ops.length ? raw(html`<div class="cr-sub">Operators</div>${pos.ops.map(p => raw(row(p, true)))}`) : ""}`;
    crewOutcomes(X);
    el.querySelectorAll("select[data-f]").forEach(sel => sel.addEventListener("change", () => setPerson(sel.closest("[data-code]").dataset.code, sel.value)));
    el.querySelectorAll("input[data-f]").forEach(inp => inp.addEventListener("change", () => setField(inp)));
    el.querySelectorAll("[data-out]").forEach(b => b.addEventListener("click", () => calloutDialog(b.dataset.out)));
    if (keep) document.getElementById(keep)?.focus();
    drawCallouts(P);
  }
  function crewOutcomes(X) {
    const { R, E, P } = X;
    const byCode = R.empty ? {} : Object.fromEntries(R.rows.map(r => [r.st.id, r]));
    const ops = Object.fromEntries(E.opsInfo().map(x => [x.o.id, x]));
    for (const p of POS) {
      const el = document.getElementById(`out-${p.id}`); if (!el) continue;
      const c = st.crew[p.id];
      if (!c.emp) { el.innerHTML = html`<span class="warn-txt small">${R.empty ? "" : (E.stationNeed(P.q)[p.id] || 0) >= 0.5 && p.type !== "ops" ? "Work waiting here" : ""}</span>`; el.className = "cr-out"; continue; }
      if (ops[p.id]) { const o = ops[p.id]; el.className = "cr-out"; el.innerHTML = html`<b>${fmtClock(o.end)}</b><small>${fmtH(o.hrs)} + break</small>`; continue; }
      const r = byCode[p.id];
      if (!r || !r.staffed) { el.className = "cr-out"; el.innerHTML = html`<span class="muted">0 hours</span>`; continue; }
      const o = outInfo(r), moved = stepsOf(r).filter(s => s.stn !== p.id).map(s => s.stn === "comf" ? "Comforters" : POS.find(x => x.id === s.stn)?.label).filter(Boolean);
      el.className = `cr-out ${o.cls}`;
      el.innerHTML = html`<b>${o.txt}</b><small>${o.sub}${moved.length ? ` · then ${[...new Set(moved)].join(", ")}` : ""}</small>`;
    }
  }
  function setPerson(code, id) {
    edit(() => {
      const c = st.crew[code];
      if (!id) { st.crew[code] = { ...c, emp: "", stop: "", source: "" }; return; }
      const from = Object.keys(st.crew).find(k => k !== code && st.crew[k].emp === id);
      const e = people.find(x => x.id === id), clock = M.clockInOf(makeP());
      let start = c.emp ? c.start : clock[id] || e?.start || s.defStart, hrs = c.emp ? c.hrs : s.fullDay, stop = c.emp ? c.stop : "";
      if (from) { const f = st.crew[from]; start = f.start; hrs = f.hrs; stop = f.stop; st.crew[from] = { ...f, emp: "", stop: "", source: "" }; }
      st.crew[code] = { emp: id, start, hrs, stop, source: clock[id] && !from && !c.emp ? "clock" : "user" };
    });
    const sel = document.getElementById(`who-${code}`); sel?.focus();
  }
  function setField(inp) {
    const code = inp.closest("[data-code]").dataset.code, f = inp.dataset.f;
    let v = inp.value;
    if (f === "start" && !/^\d{2}:\d{2}$/.test(v)) { inp.value = st.crew[code].start; return toast("Clock-in needs a time.", "warn"); }
    if (f === "hrs") { v = Math.max(0, Math.min(16, Math.round((+v || 0) * 4) / 4)); inp.value = v; }
    edit(() => { st.crew[code] = { ...st.crew[code], [f]: v, source: "user" }; }, { table: false });
  }
  function drawCallouts(P) {
    const el = document.getElementById("pl-callouts"); if (!el) return;
    const list = P.callouts || [];
    el.innerHTML = list.length ? html`<div class="callouts"><span>Called out:</span>${list.map(c => raw(html`<span class="chip off">${M.nameOf(P, c.personId)}${c.station ? ` · ${POS.find(p => p.id === c.station)?.label || ""}` : ""}${can ? raw(html`<button class="x" data-unout="${c.id}" aria-label="Undo call-out for ${M.nameOf(P, c.personId)}" title="Undo (doesn't put them back on a station)">×</button>`) : ""}</span>`))}</div>` : "";
    el.querySelectorAll("[data-unout]").forEach(b => b.addEventListener("click", async () => {
      await api(`/plan/${pick}/callouts/${b.dataset.unout}`, { method: "DELETE" });
      st.plan.callouts = st.plan.callouts.filter(c => c.id !== b.dataset.unout); update({ table: true });
    }));
  }
  function calloutDialog(code) {
    const c = st.crew[code], name = M.nameOf(makeP(), c.emp), label = POS.find(p => p.id === code).label;
    openDialog({
      title: `${name} called out?`, submitLabel: "Take off today's plan",
      body: html`<p class="dlg-lead">${first(name)} comes off ${label} for ${longDay(pick)}. The checks will show who's trained and free to cover.</p>
        <label class="field"><span>Note <em>(optional)</em></span><input class="input" name="note" maxlength="300" placeholder="Sick, appointment, no call…"></label>`,
      onSubmit: async form => {
        if (st.dirty) await save();
        const r = await api(`/plan/${pick}/callouts`, { method: "POST", body: { personId: c.emp, station: code, note: form.note.value } });
        st.plan.callouts = [...(st.plan.callouts || []), { id: r.id, personId: c.emp, station: code, note: form.note.value || null }];
        edit(() => { st.crew[code] = { ...st.crew[code], emp: "", stop: "", source: "" }; }, { msg: `${name} is off today's plan.` });
      },
    });
  }

  // ---- checks
  function drawChecks(X) {
    const el = document.getElementById("pl-checks");
    const list = X.checks.filter(c => !c.money || admin);
    el.innerHTML = list.map((c, i) => html`<div class="chk ${c.cls}"><i aria-hidden="true"></i><div><b>${c.title}</b><p>${c.text}</p>
        ${c.list ? raw(html`<ul>${c.list.map(x => raw(html`<li>${x}</li>`))}</ul>`) : ""}
        ${can && c.fixes.length ? raw(html`<div class="fx">${c.fixes.map((f, j) => raw(html`<button class="btn small" data-fix="${i}:${j}">${f.label}</button>`))}</div>`) : ""}</div></div>`).join("");
    el.querySelectorAll("[data-fix]").forEach(b => b.addEventListener("click", async () => {
      const [i, j] = b.dataset.fix.split(":").map(Number), f = list[i].fixes[j];
      if (f.action === "publish") return publishDialog();
      if (f.train) {
        const p = TEAM.people.find(x => x.id === f.train.personId); if (!p) return;
        const next = [...p.trainings.filter(t => t !== f.train.training), f.train.training];
        b.disabled = true;
        try { await api(`/team/${p.id}/trainings`, { method: "PUT", body: { trainings: next } }); p.trainings = next; people = M.peopleFrom(TEAM); update({ table: true }); toast(`${p.name} is now trained on ${f.label.split(" trained on ")[1] || "it"} (last in their list; reorder it on Team).`); }
        finally { b.disabled = false; }
        return;
      }
      edit(() => f.apply(st), { msg: f.label });
    }));
  }

  // ---- deadlines
  function drawWaves(X) {
    const el = document.getElementById("pl-waves"), P = X.P;
    const W = X.waves.filter(w => w.todo > 0);
    if (!W.length) { el.innerHTML = html`<p class="muted pad">Nothing due ${P.isToday ? "today" : "yet"}.</p>`; return; }
    el.innerHTML = W.map(w => {
      const s = X.states[w.id] || {}, gone = P.isToday && w.kind === "shuttle" && P.now > w.deadline;
      const time = w.kind === "overdue" ? "Late" : w.kind === "route" ? "Route" : w.deadline != null && w.deadline < 24 ? hm(w.deadline) : "—";
      const tip = w.kind === "shuttle" ? `Must be ready by ${fmtClock(w.deadline)}, when the shuttle leaves.${w.back ? ` Back about ${fmtClock(w.back)}.` : ""}` : w.kind === "counter" ? `Ready at the counter by ${fmtClock(w.deadline)}.` : w.kind === "route" ? "Route orders are finished the work day before the route." : "Past their due date and not ready yet.";
      const tot = CATS.reduce((t, k) => t + (w.q[k] || 0), 0);
      return html`<div class="wv ${s.late && !gone ? "late" : ""}" title="${tip}">
        <div class="wv-top"><span class="wv-time">${time}</span><b class="wv-name">${w.name}</b><span class="wv-n">${w.expected ? "~" : ""}${fmtN(w.todo)}</span></div>
        <div class="mix" aria-hidden="true">${CATS.filter(k => w.q[k]).map(k => raw(html`<i style="width:${(w.q[k] / tot * 100).toFixed(1)}%;background:${CAT_COLOR[k]}"></i>`))}</div>
        <div class="wv-sub">${gone ? raw('<span class="muted">Shuttle time passed</span>') : raw(html`<span class="${s.cls || ""}">${s.txt || `${w.orders} orders`}</span>`)}${w.stores?.length ? raw(html`<small> · ${w.stores.join(", ")}</small>`) : ""}</div>
      </div>`;
    }).join("") + html`<div class="mix-key">${CATS.map(k => raw(html`<span><i style="background:${CAT_COLOR[k]}"></i>${CAT_LABEL[k]}</span>`))}</div>`;
  }

  // ---- timeline
  function drawGantt(X) {
    const el = document.getElementById("pl-gantt"), { R, E, P } = X;
    if (R.empty) { AX = null; el.innerHTML = html`<p class="muted pad">${R.noCrew ? "No one is on a station yet. Pick people in the crew above, or use Suggest from history." : "Nothing to plan yet."}</p>`; return; }
    const OI = E.opsInfo().filter(x => x.on), sr = R.rows.filter(r => r.staffed);
    const W = X.waves.filter(w => w.kind === "shuttle" || w.kind === "counter").filter(w => w.todo > 0 && w.deadline != null && w.deadline < 24);
    let a = Math.floor(Math.min(...sr.map(r => r.x.start), ...OI.map(x => x.start), R.firstStart));
    let b = Math.ceil(Math.max(R.end, ...sr.map(r => Math.max(r.x.schedEnd, r.clockOut || 0)), ...OI.map(x => x.end), ...W.map(w => w.deadline)));
    if (b - a < 6) b = a + 6; AX = { a, b };
    const pct = h => ((h - a) / (b - a) * 100).toFixed(2) + "%", wid = (p, q) => ((q - p) / (b - a) * 100).toFixed(2) + "%";
    const ticks = []; for (let t = a; t <= b; t++) ticks.push(html`<span style="left:${pct(t)}">${t === a || t === 12 ? hm(t) : hm(t).replace(/ [AP]M/, "")}</span>`);
    const lbl = c => c === "comf" ? "Comforters" : POS.find(p => p.id === c)?.label || c;
    let rows = "";
    for (const row of R.rows) {
      const p = row.st, name = row.staffed ? M.nameOf(P, st.crew[p.id].emp) : "";
      let bars = "";
      if (row.staffed) {
        const steps = stepsOf(row), b0 = row.brkTaken > 0 ? row.brkS : null, b1 = b0 != null ? row.brkS + row.brkTaken : null;
        if (!steps.length) bars += html`<div class="gb idle" data-code="${p.id}" style="left:${pct(row.x.start)};width:${wid(row.x.start, Math.max(row.clockOut, row.x.start + 0.5))}" title="${name}: not needed">${first(name)} <small>not needed</small></div>`;
        steps.forEach((sp, i) => {
          const ot = sp.to > row.x.schedEnd + 0.02, col = COLOR[sp.stn === "comf" ? "comf" : E.TYPE_OF[sp.stn]] || COLOR.ops;
          const label = i === 0 ? html`${first(name)} <small>${hm(row.x.start)}–${hm(row.clockOut)}</small>` : html`→ ${lbl(sp.stn)}`;
          let parts = [[sp.from, sp.to]];
          if (b0 != null && b1 > sp.from + 0.01 && b0 < sp.to - 0.01) parts = [[sp.from, b0], [b1, sp.to]].filter(x => x[1] - x[0] > 0.01);
          const big = parts.reduce((m, x, j) => x[1] - x[0] > parts[m][1] - parts[m][0] ? j : m, 0);
          parts.forEach((x, j) => { bars += html`<div class="gb ${ot ? "ot" : ""}" data-code="${p.id}" style="left:${pct(x[0])};width:${wid(x[0], x[1])};--c:${col}" title="${name}: ${lbl(sp.stn)} ${fmtClock(sp.from)}–${fmtClock(sp.to)}${ot ? " (overtime)" : ""}">${j === big ? raw(label) : ""}</div>`; });
        });
        if (row.brkTaken > 0) bars += html`<div class="gb brk" style="left:${pct(row.brkS)};width:${wid(row.brkS, row.brkS + row.brkTaken)}" title="Break ${fmtClock(row.brkS)}–${fmtClock(row.brkS + row.brkTaken)}"></div>`;
      }
      rows += html`<div class="g-row"><div class="g-st"><i class="sw" style="--c:${COLOR[p.type]}"></i>${p.label}</div><div class="g-tr">${raw(bars || '<span class="g-none">Not staffed</span>')}</div></div>`;
    }
    for (const x of OI) {
      const name = M.nameOf(P, st.crew[x.o.id].emp);
      rows += html`<div class="g-row"><div class="g-st"><i class="sw" style="--c:${COLOR.ops}"></i>${x.o.label.replace("Starch Laundry Operator", "Laundry operator").replace("Dry Cleaning Operator", "DC operator")}</div><div class="g-tr">
        <div class="gb" data-code="${x.o.id}" style="left:${pct(x.start)};width:${wid(x.start, x.end)};--c:${COLOR.ops}" title="${name}: ${fmtClock(x.start)}–${fmtClock(x.end)}">${first(name)} <small>${hm(x.start)}–${hm(x.end)}</small></div>
        ${x.b ? raw(html`<div class="gb brk" style="left:${pct(x.brkS)};width:${wid(x.brkS, x.brkS + x.b)}"></div>`) : ""}</div></div>`;
    }
    if (R.W && R.W.loads.length) {
      const lo = Math.min(...R.W.loads.map(l => l.from)), hi = Math.max(...R.W.loads.map(l => l.to));
      rows += html`<div class="g-row"><div class="g-st"><i class="sw" style="--c:${COLOR.wash}"></i>Washers</div><div class="g-tr"><div class="gb wash" style="left:${pct(lo)};width:${wid(lo, hi)};--c:${COLOR.wash}" title="${R.W.loads.length} loads on ${s.washers} washers">Wash <small>${R.W.loads.length} loads · ${hm(lo)}–${hm(hi)}</small></div></div></div>`;
    }
    let lines = "";
    for (const w of W) { const ok = (X.states[w.id] || {}).cls === "good"; lines += html`<div class="g-dl ${ok ? "ok" : ""}" style="--x:${((w.deadline - a) / (b - a)).toFixed(4)}" title="${w.name}: ready by ${fmtClock(w.deadline)}"><span>${hm(w.deadline).replace(/ [AP]M/, "")}</span></div>`; }
    const fins = sr.filter(r => r.finish != null).map(r => r.finish);
    if (fins.length > 1) { const lo = Math.min(...fins.filter(f => f >= R.end - s.spread / 60 - 1e-6)), hi = R.end; if (hi - lo > 0.02) lines += html`<div class="g-win" style="--x:${((lo - a) / (b - a)).toFixed(4)};--w:${((hi - lo) / (b - a)).toFixed(4)}" title="Everyone finishes between ${fmtClock(lo)} and ${fmtClock(hi)}"></div>`; }
    if (P.isToday && P.now > a && P.now < b) lines += html`<div class="g-now" style="--x:${((P.now - a) / (b - a)).toFixed(4)}" title="Now"></div>`;
    el.innerHTML = html`<div class="g-scroll"><div class="gantt"><div class="g-axis"><div></div><div class="g-ticks">${raw(ticks.join(""))}</div></div><div class="g-body">${raw(lines)}${raw(rows)}</div></div></div>
      <div class="g-legend"><span><i class="k-dl"></i>shuttle must be ready</span><span><i class="k-win"></i>finish window (${s.spread} min)</span><span><i class="k-brk"></i>break</span><span><i class="k-ot"></i>overtime</span></div>`;
  }
  // drag a bar to move that person's clock-in, in 5-minute steps
  main.addEventListener("pointerdown", ev => {
    if (!alive()) return;
    const b = ev.target.closest?.(".gb[data-code]"); if (!b || !AX || !can) return;
    const c = st.crew[b.dataset.code]; if (!c || !c.emp) return;
    const tr = b.parentElement.getBoundingClientRect();
    D = { b, code: b.dataset.code, x0: ev.clientX, w: tr.width, start: parseTime(c.start) ?? 7, step: 0, moved: false };
    b.classList.add("drag"); try { b.setPointerCapture(ev.pointerId); } catch {}
  }, on);
  main.addEventListener("pointermove", ev => {
    if (!D) return;
    const dh = (ev.clientX - D.x0) / D.w * (AX.b - AX.a), step = Math.round(dh * 12) / 12;
    if (Math.abs(ev.clientX - D.x0) > 3) D.moved = true;
    D.step = step;
    main.querySelectorAll(`.gb[data-code="${D.code}"]`).forEach(x => { x.style.transform = `translateX(${(step / (AX.b - AX.a)) * D.w}px)`; });
    D.b.title = `Clock-in ${fmtClock(D.start + step)}`;
  }, on);
  const dragEnd = () => {
    if (!D) return; const d = D; D = null; d.b.classList.remove("drag");
    if (d.moved && d.step) {
      const t = Math.max(0, Math.min(23.9, d.start + d.step));
      edit(() => { st.crew[d.code] = { ...st.crew[d.code], start: hhmm(t), source: "user" }; }, { msg: `${first(M.nameOf(makeP(), st.crew[d.code].emp))} clocks in at ${fmtClock(t)}` });
    } else main.querySelectorAll(`.gb[data-code="${d.code}"]`).forEach(x => { x.style.transform = ""; });
  };
  main.addEventListener("pointerup", dragEnd, on); main.addEventListener("pointercancel", dragEnd, on);

  // ---- money
  function drawMoney(X) {
    const el = document.getElementById("pl-money"), Mo = X.M, P = X.P;
    if (!Mo) { el.innerHTML = html`<p class="muted pad">Shows once there's a crew and pieces.</p>`; return; }
    const pct = Mo.pct, good = pct != null && pct <= P.s.laborTarget;
    el.innerHTML = html`<div class="money">
      <div class="m-big"><b class="${pct == null ? "" : good ? "good" : "bad"}">${pct == null ? "—" : pct.toFixed(1) + "%"}</b><span>labor of revenue · target ${P.s.laborTarget}%</span></div>
      <dl>
        <div><dt>Revenue from these pieces</dt><dd>${fmt$(Mo.revenue)}</dd></div>
        <div><dt>Labor</dt><dd>${fmt$(Mo.total)}</dd></div>
        <div><dt>Regular · ${fmtH(Mo.regH)}</dt><dd>${fmt$(Mo.regC)}</dd></div>
        ${Mo.otH > 0.01 ? raw(html`<div><dt>Overtime · ${fmtH(Mo.otH)}</dt><dd class="warn-txt">${fmt$(Mo.otC)}</dd></div>`) : ""}
        ${Mo.opsH > 0.01 ? raw(html`<div><dt>Operators · ${fmtH(Mo.opsH)}</dt><dd>${fmt$(Mo.opsC)}</dd></div>`) : ""}
        ${Mo.idleH > 0.05 ? raw(html`<div><dt>Paid but idle · ${fmtH(Mo.idleH)}</dt><dd class="warn-txt">${fmt$(Mo.idleC)}</dd></div>`) : ""}
        <div><dt>Budget at ${P.s.laborTarget}%</dt><dd>${fmt$(Mo.budget)}</dd></div>
      </dl>
      <p class="muted small">${payNote(P)}; overtime ×${P.s.otMult}. Prices are SMRT's averages where there are enough pieces.</p></div>`;
  }
  function payNote(P) {
    const on = [...new Set(Object.values(P.crew).map(c => c.emp).filter(Boolean))], withRate = on.filter(id => people.find(e => e.id === id)?.rate > 0).length;
    if (!on.length) return `Pay uses each person's rate from Rippling, or ${fmt$(P.s.payAvg)}/h when there's none`;
    if (withRate === on.length) return "Pay uses each person's hourly rate from Rippling";
    if (!withRate) return `Pay uses the average rate in Settings (${fmt$(P.s.payAvg)}/h) — Rippling hasn't sent pay rates yet`;
    return `Pay uses each person's rate from Rippling; ${on.length - withRate} without one at the average ${fmt$(P.s.payAvg)}/h`;
  }

  // ---- publish
  function drawPub(X) {
    const b = document.getElementById("pl-pub"); if (!b) return;
    const pub = st.plan.published, sig = M.sigOf(X.P);
    if (!pub) { b.textContent = "Publish"; b.className = "btn primary small"; b.title = "Show this plan on the Floor screens"; }
    else if (pub.sig !== sig) { b.textContent = "Publish changes"; b.className = "btn primary small"; b.title = `Published ${ago(pub.at).toLowerCase()} by ${pub.by}; changed since`; }
    else { b.textContent = `Published ${new Date(pub.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`; b.className = "btn small published"; b.title = `Published by ${pub.by}. The floor shows this plan.`; }
    b.disabled = X.R.empty;
  }
  function publishDialog() {
    const X = st.X; if (!X || X.R.empty) return toast("Add the crew first.", "warn");
    const bad = X.checks.filter(c => c.cls === "b" && (!c.money || admin));
    openDialog({
      title: `Publish the plan for ${longDay(pick)}?`, submitLabel: st.plan.published ? "Publish changes" : "Publish",
      body: html`<p class="dlg-lead">The Floor screens show it right away. You can keep changing the plan and publish again.</p>
        <div class="pub-sum"><div><b>${hm(X.R.end)}</b><span>everyone done</span></div><div><b>${X.verdict.kpis.find(k => k.l.startsWith("people"))?.v || "—"}</b><span>people</span></div><div><b>${X.R.otTotal > 0.04 ? fmtH(X.R.otTotal) : "None"}</b><span>overtime</span></div></div>
        ${bad.length ? raw(html`<div class="banner warn"><b>Still open:</b> ${bad.map(c => c.title).join(" · ")}</div>`) : ""}`,
      onSubmit: async () => {
        st.conflict = false;
        if (st.dirty || st.saving || !st.rev) { st.dirty = true; await save(); }
        if (st.conflict) throw new Error("Someone else changed this plan at the same time. Check their version, then publish.");
        if (st.dirty) throw new Error("The plan couldn't be saved, so it wasn't published.");
        const X2 = M.evaluate(makeP());
        try {
          const r = await api(`/plan/${pick}/publish`, { method: "POST", body: { rev: st.rev, snapshot: M.snapshotOf(X2) } });
          st.plan.published = r.published; st.plan.status = "published"; update({ table: false });
          toast("Published. The floor shows this plan.");
        } catch (e) { if (e.status === 409 && e.body.latest) { adopt(e.body.latest); drawPage(); } throw e; }
      },
    });
  }

  // ---- who's working: auto-assign
  function autoDialog() {
    const P = makeP(), clock = M.clockInOf(P), out = new Set((P.callouts || []).map(c => c.personId));
    const on = new Set(Object.values(st.crew).map(c => c.emp).filter(Boolean));
    const pre = Object.keys(clock).length ? new Set(Object.keys(clock)) : on.size ? on : new Set(people.map(p => p.id));
    const E = M.evaluate(P).E;
    const top = e => POS.filter(p => E.rankOf(e, p.id)).sort((a, b) => E.rankOf(e, a.id) - E.rankOf(e, b.id)).slice(0, 3).map(p => p.label).join(" · ") || "No trainings yet";
    openDialog({
      title: "Who's working?", submitLabel: "Assign stations",
      body: html`<p class="dlg-lead">Each person goes where they rank highest, busiest stations first. You can change anything afterwards.${Object.keys(clock).length ? " Checked: everyone clocked in today — their clock-in times are used." : ""}</p>
        <div class="aa-tools"><button type="button" class="linkish" data-all>Everyone</button> · <button type="button" class="linkish" data-none>Nobody</button></div>
        <div class="aa-list">${people.slice().sort((a, b) => a.name.localeCompare(b.name)).map(e => raw(html`<label class="aa"><input type="checkbox" name="p" value="${e.id}" ${pre.has(e.id) && !out.has(e.id) ? "checked" : ""}>
          <span><b>${e.name}</b><small>${out.has(e.id) ? "Called out · " : ""}${clock[e.id] ? `In at ${fmtClock(parseTime(clock[e.id]))} · ` : ""}${top(e)}</small></span></label>`))}</div>`,
      onOpen: (form, dlg) => {
        dlg.classList.add("wide");
        dlg.querySelector("[data-all]").addEventListener("click", () => form.querySelectorAll("[name=p]").forEach(x => { x.checked = true; }));
        dlg.querySelector("[data-none]").addEventListener("click", () => form.querySelectorAll("[name=p]").forEach(x => { x.checked = false; }));
      },
      onSubmit: form => {
        const ids = [...form.querySelectorAll("[name=p]:checked")].map(x => x.value);
        if (!ids.length) throw new Error("Check at least one person.");
        let r;
        edit(() => { r = M.autoAssign(makeP(), E, ids); st.crew = r.crew; });
        const notFirst = r.placed.filter(x => x.rk > 1).length;
        toast(`Placed ${r.placed.length} ${r.placed.length === 1 ? "person" : "people"}${notFirst ? ` (${notFirst} on a 2nd-or-later choice)` : ""}.${r.left.length ? ` Not placed: ${r.left.map(e => e.name).join(", ")}.` : ""}`, "ok", 8000);
      },
    });
  }

  // ---- orders that need attention (from SMRT)
  function drawOrders() {
    const el = document.getElementById("pl-orders"), P = makeP();
    if (!P.dp.withOverdue) { el.innerHTML = ""; return; }
    el.innerHTML = lateCard(st.V.late) + (st.V.notReady?.length ? notReadyCard(st.V.notReady) : "");
    const k = "pl-orders-open";
    el.querySelectorAll("details").forEach(d => { d.open = store.get(k + d.dataset.k) !== "0"; d.addEventListener("toggle", () => store.set(k + d.dataset.k, d.open ? "1" : "0")); });
  }
}

function lateCard(rows) {
  if (!rows.length) return html`<section class="card set-card"><header><h2>Late &amp; overdue orders</h2><p>None right now.</p></header></section>`;
  return html`<section class="card set-card"><details data-k="late"><summary><h2>Late &amp; overdue orders <span class="count">${rows.length}</span></h2>
      <p>Orders due today or earlier that aren't finished. Where the pieces are comes from SMRT's item and lot status.</p></summary>
    <div class="late-list">${rows.slice(0, 60).map(o => raw(html`<div class="late ${o.overdue ? "over" : ""}">
      <div class="l-main"><a href="${o.customer ? SMRT_ORDER(o.customer, o.no) : "#"}" target="_blank" rel="noopener" class="l-no" title="Open in SMRT">${o.no}</a>
        <span class="chip ${o.overdue ? "off" : "manager"}">${o.overdue ? `Overdue · due ${new Date(o.due).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : `Due ${new Date(o.due).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}</span>
        ${o.notes ? raw(html`<span class="chip" title="This order or one of its pieces has a note in SMRT">Note</span>`) : ""}</div>
      <div class="l-meta"><span>${o.loc}</span><span>${o.left} of ${o.pieces} pieces left</span><span>${o.status}</span></div>
      <div class="l-where">${Object.entries(o.open).map(([k, c]) => raw(html`<span>${c} ${k}</span>`))}</div>
    </div>`))}</div>${rows.length > 60 ? raw(html`<p class="muted">…and ${rows.length - 60} more.</p>`) : ""}</details></section>`;
}
function notReadyCard(rows) {
  const van = rows.filter(o => o.onVan).length;
  return html`<section class="card set-card"><details data-k="ready"><summary><h2>Finished, but not ready in SMRT <span class="count soft">${rows.length}</span></h2>
      <p>Every piece is assembled, but the order isn't marked ready.${van ? ` ${van} went out on the van and weren't racked at the store.` : ""} These are for the stores, not production.</p></summary>
    <div class="late-list">${rows.slice(0, 60).map(o => raw(html`<div class="late">
      <div class="l-main"><a href="${o.customer ? SMRT_ORDER(o.customer, o.no) : "#"}" target="_blank" rel="noopener" class="l-no" title="Open in SMRT">${o.no}</a>
        <span class="chip ${o.onVan ? "admin" : ""}">${o.onVan ? "On the van · not checked in" : o.shuttle ? "Assembled · still at the plant, next shuttle" : "Assembled · not racked as ready"}</span></div>
      <div class="l-meta"><span>${o.loc}</span><span>Due ${new Date(o.due).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span><span>${o.pieces} pieces</span><span>${o.status}</span></div>
    </div>`))}</div></details></section>`;
}
