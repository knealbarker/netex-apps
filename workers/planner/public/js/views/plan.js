// Plan: pieces from SMRT, the crew on each station as the manager enters it (no predictions, Neal Oct 14), and publishing.
// Changes save on their own (a second PC that saved in between wins and this one is refreshed with its plan).
import { api } from "../api.js";
import { html, raw, ago, toast, openDialog, RANK } from "../ui.js";
import { CATS, CAT_FULL, CAT_LABEL, parseTime, hhmm, fmtClock, hm, fmtH, fmtN, fmt$, stepsOf, outInfo } from "../engine/engine.js";
import * as M from "../plan/model.js";
import { SHUTTLES } from "../features.js";

const TILE = { dct: "DC tops", dcb: "DC bottoms", slt: "Starch tops", slb: "Starch bottoms", comf: "Comforters", tc: "Tablecloths" };
const TYPE_DESC = { slt: "Starch tops press", slt2: "Helps on SLT 1", slb: "Starch bottoms press", dct: "Dry cleaning tops", dcb: "Dry cleaning bottoms", comf: "Comforters, trained people only", tc: "Tablecloths, trained people only", asm: "Inspect, assemble, bag", ops: "Runs the machines" };
const COLOR = { slt: "#4f8ff7", slt2: "#7aa9fa", slb: "#8b7cf6", dct: "#f59e4b", dcb: "#e2609b", asm: "#22c38e", ops: "#7c879c", comf: "#14b8a6", tc: "#c084fc", wash: "#5b6b84" };
const ROW_LABEL = { slb: "Starch bottoms", slt: "Starch tops", dct: "DC tops", dcb: "DC bottoms", tc: "Tablecloths", comf: "Comforters", asm: "Assembly", ops: "Operators" };
const CAT_COLOR = { dct: COLOR.dct, dcb: COLOR.dcb, slt: COLOR.slt, slb: COLOR.slb, comf: COLOR.comf, tc: COLOR.tc };
const SMRT_ORDER = (customer, no) => `https://towncountryclean.smrtapp.com/posx/dash/customer/clothestracker/${encodeURIComponent(customer)}/?saleId=${String(no).replace(/\D/g, "")}`;
const ORD = n => ["", "1st", "2nd", "3rd"][n] || `${n}th`;
const fmtDay = (d, today) => { const s = new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); return d === today ? `Today · ${s}` : s; };
const longDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const nowH = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
const first = n => String(n || "").split(" ")[0];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const groupOf = M.groupOf;
let pick = null; // the day being looked at, kept while moving between sections

// What each button at the top of the Plan does (the "?" next to it opens this).
const HELP = {
  undo: { title: "Undo", body: `<p>Takes back the last change to the crew or the piece counts on this screen (also Ctrl+Z). It goes back up to 60 steps, until you leave the Plan.</p>
    <p>It doesn't undo time off, call-outs or publishing.</p>` },
  print: { title: "Print", body: `<p>Prints the plan on one page: crew with times, and each person's moves and breaks. Choose "Save as PDF" in the print window to keep a copy.</p>` },
  publish: { title: "Publish", body: `<p>Sends this plan to the <b>Floor</b> screens. Until you publish, the floor keeps showing the last published plan.</p>
    <p>You can keep changing the plan; a check reminds you when it has changed since it was published, so you can publish again.</p>` },
};

const helpBtn = id => `<button type="button" class="help-i" data-help="${id}" aria-label="What does this do?" title="What does this do?">?</button>`;
export async function render(main, ctx) {
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Reading pieces and the crew…</div>`;
  const asked = (location.hash.match(/[?&]day=(\d{4}-\d{2}-\d{2})/) || [])[1];
  if (asked) pick = asked;
  const [V0, SET, TEAM] = await Promise.all([api(pick ? `/pieces?day=${pick}` : "/pieces"), api("/settings"), api("/team")]);
  const canRole = RANK[ctx.me.role] >= RANK.manager, admin = RANK[ctx.me.role] >= RANK.admin;
  let can = canRole; // false on a day that has passed (and when offline)
  const st = { V: V0, SET, TEAM, plan: null, crew: null, overrides: {}, rev: 0, dirty: false, saving: null, undo: [], note: null, X: null };
  const s = M.engineSettings(SET, V0.prices);
  const pos = M.positions(SET);
  const POS = pos.stations.concat(pos.ops);
  let people = M.peopleFrom(TEAM);
  const days = () => [st.V.isWorkDay ? st.V.today : null, st.V.next].filter(Boolean);
  if (!pick || (!days().includes(pick) && !st.V.days[pick])) pick = days()[0];
  let saveT = null, chgBusy = false, reorder = false; // the pending save, the changes list loading, moving station rows up and down
  // the board by station or by person (Neal, Oct 14); remembered on this device
  let boardView = "stations"; try { if (localStorage.getItem("pl-board-view") === "people") boardView = "people"; } catch { /* private window */ }
  const order = () => SET.boardOrder || M.BOARD_ORDER;
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
    if (!st.V.days[day]) st.V = await api(`/pieces?day=${day}`);
    const plan = await api(`/plan/${day}`);
    can = canRole && !isPast() && !ctx.offline;
    adopt(plan);
    st.undo = [];
    if (!plan.rev && !Object.keys(plan.crew).length && !isPast()) await copyPrev();
    drawPage();
    loadChanges();
    st.tally = null; loadTally();
  }
  // the station tablets at the SLB presses (Neal, Oct 14): pairs pressed today, per press and per person
  async function loadTally() {
    if (!P0isToday()) { st.tally = null; return drawPresses(); }
    try { st.tally = await api(`/tally/${pick}`); } catch { /* keep the last */ }
    drawPresses();
  }
  function isPast() { return pick < st.V.today; }
  function adopt(plan) {
    st.plan = plan; st.rev = plan.rev; st.overrides = { ...plan.overrides }; st.crew = M.crewFromServer(plan.crew, POS, s); st.dirty = false; st.note = null;
  }
  function makeP() {
    const dp = M.dayPieces(st.V, st.SET, pick);
    const q = M.effectiveQ(dp.base, st.overrides);
    return { s, ...pos, people, crew: st.crew, q, waves: dp.waves, day: pick, today: st.V.today, isToday: dp.isToday, now: dp.isToday ? nowH() : null,
      callouts: st.plan.callouts, late: st.plan.late || [], history: st.plan.history, clock: st.plan.clock, clockAsOf: st.plan.clockAsOf || null, published: st.plan.published, admin, expected: dp.expected && !Object.keys(st.overrides).length, dp };
  }
  // a new day starts as a copy of the last saved plan (Neal, Oct 14), without anyone who's out that day
  async function copyPrev() {
    for (let k = 1; k <= 10; k++) {
      const d = new Date(Date.parse(pick + "T12:00:00Z") - k * 864e5).toISOString().slice(0, 10);
      let p; try { p = await api(`/plan/${d}`); } catch { continue; }
      if (!p || !p.rev || !Object.keys(p.crew || {}).length) continue;
      const out = new Set((st.plan.callouts || []).map(c => c.personId));
      st.crew = M.copyCrew(p.crew, POS, s, out);
      st.note = { copied: d, left: [...out].filter(id => Object.values(p.crew).some(c => c.personId === id)).map(id => M.nameOf({ people }, id)) };
      if (can) { st.dirty = true; setTimeout(save, 0); }
      return;
    }
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
      saveStatus(); loadChanges();
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
    loadTally();
    if (!st.dirty && !st.saving) {
      try {
        const p = await api(`/plan/${pick}`);
        if (p.rev !== st.rev) { adopt(p); toast(`${p.updatedBy || "Someone"} changed this plan. Showing their version.`, "warn", 6000); drawPage(); return; }
        st.plan.callouts = p.callouts; st.plan.late = p.late || []; st.plan.hidden = p.hidden || []; st.plan.clock = p.clock; st.plan.clockAsOf = p.clockAsOf || null; st.plan.published = p.published;
      } catch { /* try again next minute */ }
    }
    update({ table: false });
  }
  async function refreshPieces() {
    if (!alive()) return stop();
    try {
      const custom = !days().includes(pick);
      st.V = await api(custom ? `/pieces?day=${pick}` : "/pieces");
      if (!st.V.days[pick]) return openDay(days()[0]);
      update({ table: false }); drawHeadPill(); loadChanges();
    } catch { /* keep the last counts */ }
  }

  // ------------------------------------------------------------ the page (Plan redesign, Neal Oct 13: who goes where, and when)
  function drawPage() {
    main.innerHTML = html`<div id="pl-root" class="pv">
      <div class="pv-head">
        <h1 class="sr">Plan</h1>
        <div class="seg" role="tablist" aria-label="Day">${days().map(d => raw(html`<button role="tab" aria-selected="${d === pick}" data-day="${d}">${fmtDay(d, st.V.today)}</button>`))}
          ${days().includes(pick) ? "" : raw(html`<button role="tab" aria-selected="true" data-day="${pick}" class="custom">${fmtDay(pick, st.V.today)}</button>`)}</div>
        <label class="date-pick" title="Plan another day"><span class="sr">Plan another day</span><input class="input" type="date" id="pl-date" value="${pick}"></label>
        <div class="pv-tools">
          <span class="saved-note" id="pl-save" aria-live="polite"></span>
          ${can ? raw(html`<button class="btn ghost small pv-tool" id="pl-undo" title="Undo (Ctrl+Z)" aria-label="Undo" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg><span>Undo</span></button>
`) : ""}
          <button class="btn ghost small pv-tool" id="pl-print" title="Print the plan, or save it as a PDF" aria-label="Print"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/></svg><span>Print</span></button>
        </div>
      </div>
      <div class="pv-status" id="pl-status" aria-live="polite"></div>
      ${isPast() ? raw(html`<div class="banner info"><b>This day is over.</b> The plan is shown as it was saved (read-only). <a href="#/review?day=${pick}">See how it went in Review</a>.</div>`) : ""}
      <div id="pl-note"></div>
      <section class="pv-presses" id="pl-presses" aria-label="Starch bottoms presses" hidden></section>
      <section class="pv-work" id="pl-work" aria-label="The rest of the work"></section>
      <section class="pv-board" aria-label="Stations">
        <div class="pv-board-head"><div class="seg tl-view" role="tablist" aria-label="Show the day by"><button type="button" role="tab" data-view="stations" aria-selected="${boardView === "stations"}">Stations</button><button type="button" role="tab" data-view="people" aria-selected="${boardView === "people"}">People</button></div>
          <span class="muted small" id="pl-board-hint"></span>
          ${canRole ? raw(`<button type="button" class="btn ghost small" id="pl-reorder" aria-pressed="false" ${boardView === "people" ? "hidden" : ""}>Reorder</button>`) : ""}</div>
        <div class="tl-scroll" id="pl-board"></div>
        <div class="pv-away" id="pl-away"></div>
      </section>
      <section class="card pl-card"><details id="pl-chg-box"><summary class="pl-cardhead"><div><h2>Changes today <span class="count soft" id="pl-chg-n"></span></h2><p>Who changed what.</p></div></summary><div id="pl-chg"></div></details></section>
      ${can ? raw(html`<div class="pv-foot"><button class="btn primary" id="pl-pub"></button>${raw(helpBtn("publish"))}</div>`) : ""}
    </div><div id="pl-print-sheet" class="print-sheet" aria-hidden="true"></div>`;
    main.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", async () => {
      if (b.dataset.day === pick) return;
      if (st.dirty) await save();
      main.querySelectorAll("[data-day]").forEach(x => x.setAttribute("aria-selected", String(x === b)));
      await openDay(b.dataset.day);
      main.querySelector(`[data-day="${pick}"]`)?.focus();
    }));
    main.querySelector("#pl-date").addEventListener("change", async e => {
      const d = e.target.value; if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d === pick) return;
      if (st.dirty) await save();
      main.querySelector("#pl-root")?.classList.add("busy");
      try { await openDay(d); } catch (x) { toast(x.message, "bad"); main.querySelector("#pl-root")?.classList.remove("busy"); }
    });
    main.querySelector("#pl-print").addEventListener("click", printPlan);
    main.querySelectorAll("[data-help]").forEach(b => b.addEventListener("click", () => showHelp(b.dataset.help)));
    const chg = main.querySelector("#pl-chg-box");
    chg.open = store.get("pl-chg-open") === "1";
    chg.addEventListener("toggle", () => { store.set("pl-chg-open", chg.open ? "1" : "0"); if (chg.open) loadChanges(); });
    if (can) {
      main.querySelector("#pl-undo").addEventListener("click", undo);
      main.querySelector("#pl-pub").addEventListener("click", publishDialog);
    }
    main.querySelector("#pl-board").addEventListener("click", ev => {
      const up = ev.target.closest("[data-up],[data-down]");
      if (up) return moveRow(up.dataset.up || up.dataset.down, up.dataset.up ? -1 : 1);
      const b = ev.target.closest("[data-emp],[data-add]"); if (!b || !can || reorder) return;
      if (b.dataset.add) addSheet(b.dataset.add, b.dataset.code); else personSheet(b.dataset.emp, b.dataset.stn || null, b.dataset.at != null ? +b.dataset.at : null);
    });
    main.querySelector("#pl-reorder")?.addEventListener("click", e => {
      reorder = !reorder; e.currentTarget.setAttribute("aria-pressed", String(reorder)); e.currentTarget.textContent = reorder ? "Done" : "Reorder";
      boardHint(); if (st.X) drawBoard(st.X, st.L);
    });
    main.querySelectorAll(".tl-view [data-view]").forEach(b => b.addEventListener("click", () => {
      if (boardView === b.dataset.view) return;
      boardView = b.dataset.view; try { localStorage.setItem("pl-board-view", boardView); } catch { /* private window */ }
      main.querySelectorAll(".tl-view [data-view]").forEach(x => x.setAttribute("aria-selected", String(x.dataset.view === boardView)));
      if (reorder) { reorder = false; const r = main.querySelector("#pl-reorder"); if (r) { r.setAttribute("aria-pressed", "false"); r.textContent = "Reorder"; } }
      const r = main.querySelector("#pl-reorder"); if (r) r.hidden = boardView === "people";
      const el = document.getElementById("pl-board"); if (el) delete el.dataset.scrolled;
      boardHint(); if (st.X) drawBoard(st.X, st.L);
    }));
    boardHint();
    drawHeadPill(); update({ table: true });
  }
  function P0isToday() { return pick === st.V.today && st.V.isWorkDay; }

  function drawHeadPill() {
    const el = document.getElementById("pl-smrt"); if (!el) return;
    const last = st.V.smrt.lastOk, run = st.V.smrt.lastRun;
    if (!last && !run) { el.innerHTML = html`<span class="pill">SMRT updates start next work day</span>`; return; }
    const mins = last ? (Date.now() - Date.parse(last)) / 60000 : Infinity, err = run && run.status === "error", stale = st.V.isWorkDay && mins > 30;
    el.innerHTML = html`<span class="pill ${err || stale ? "warn" : "ok"}" title="${run?.message || ""}"><i></i>${err ? "SMRT update failed · " : ""}SMRT · ${last ? ago(last).toLowerCase() : "—"}</span>`;
  }
  function drawNote() {
    const el = document.getElementById("pl-note"); if (!el) return;
    if (!st.note || !st.note.copied) { el.innerHTML = ""; return; }
    el.innerHTML = html`<div class="banner info"><b>Copied from ${longDay(st.note.copied)}.</b> Same people, stations, times and breaks — change anything by tapping it.${st.note.left.length ? ` Left off (out today): ${st.note.left.join(", ")}.` : ""}</div>`;
  }

  /** Runs the plan and redraws everything that depends on it. */
  function update() {
    if (!alive()) return;
    const X = st.X = M.evaluate(makeP());
    const L = st.L = null;   // no predictions (Neal, Oct 14)
    // the production day is over: what's left waits for later or for a manager, so nothing more is planned (Neal, Oct 13)
    st.over = M.productionDone(X.P, X.P.dp?.D?.lastAsm, M.breaksOf(X.R));
    drawNote(); drawStatus(X, L); drawPresses(); drawWork(X, L); drawBoard(X, L); drawAway(X.P);
    drawPub(X); saveStatus();
  }

  // ---- one line: how the day goes (today: re-planned from now with who's here)
  function drawStatus(X, L) {
    const el = document.getElementById("pl-status"); if (!el) return;
    const P = X.P, tot = CATS.reduce((t, k) => t + (P.q[k] || 0), 0);
    let txt, cls = "";
    if (st.over) {
      const left = leftovers(P), n = left.reduce((t, x) => t + x.n, 0);
      cls = "good done";
      txt = raw(html`<b>Production day complete</b> · ${st.over.why === "out" ? `everyone clocked out by ${hm(st.over.at)}` : `nothing assembled since ${hm(st.over.at)}`}${n ? ` · ${fmtN(n)} ${n === 1 ? "piece" : "pieces"} left for later` : " · everything's done"}`);
    } else if (X.R.empty) txt = "No one is on a station yet — tap a station to add someone.";
    else {
      // facts only (Neal, Oct 14): pieces (left today), people, and the planned hours
      const people = X.R.rows.filter(r => r.staffed).length + X.E.opsInfo().filter(x => x.on).length;
      const hrs = X.R.rows.filter(r => r.staffed).reduce((a, r) => a + r.work, 0) + X.E.opsInfo().filter(x => x.on).reduce((a, x) => a + x.hrs, 0);
      const D = P.dp?.D, left = P.isToday && D ? leftovers(P).reduce((t, x) => t + x.n, 0) : null;
      cls = "good";
      txt = raw(html`${left != null ? raw(html`<b>${fmtN(left)}</b> of ${fmtN(tot)} pieces left`) : raw(html`<b>${P.expected ? "~" : ""}${fmtN(tot)}</b> pieces`)} · ${people} people · ${fmtH(hrs)} planned · in ${hm(X.R.firstStart)}–${hm(X.R.end)}`);
    }
    el.className = `pv-status ${cls}`;
    el.innerHTML = html`<span class="pv-dot" aria-hidden="true"></span><span>${txt}</span><span id="pl-smrt"></span>`;
    drawHeadPill();
  }

  /** Pieces still not finished today, by kind of work (biggest first). */
  function leftovers(P) {
    const D = P.dp?.D || { done: {} };
    return CATS.map(k => ({ k, n: Math.max(0, Math.round((P.q[k] || 0) - (D.done?.[k] || 0))) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n);
  }

  // ---- SLB 1 and SLB 2 from the station tablets: green within 10% of the goal, yellow 10-20% under, red past 20% under
  function drawPresses() {
    const el = document.getElementById("pl-presses"); if (!el) return;
    const T = st.tally;
    if (!T || !P0isToday() || !T.stations.length) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const r1 = v => (v == null ? "—" : v.toFixed(1)), g1 = v => (Number.isInteger(+v) ? String(v) : (+v).toFixed(1));
    const ago = m => (m == null ? "" : T.now - m < 2 ? "just now" : `${T.now - m} min ago`);
    el.innerHTML = html`<div class="pr-head"><h2>Starch bottoms presses</h2><span class="muted small">From the station tablets · goal ${g1(T.goal)}/hr${T.total ? ` · ${fmtN(T.total)} pairs pressed today` : ""}</span></div>
      <div class="pr-grid">${T.stations.map(s => { const S = s.station, others = s.people.filter(p => p.count > 0);
        return raw(html`<div class="pr-card ${S.color}">
          <div class="pr-top"><b>${s.label}</b><span>${s.current ? `${s.current.name}${s.current.status === "upcoming" ? ` · from ${hm(s.current.from / 60)}` : ""}` : "No one planned"}</span></div>
          <div class="pr-nums"><div><b>${fmtN(S.count)}</b><span>pairs</span></div><div><b class="pr-rate">${r1(S.perHour)}</b><span>per hour${S.pct != null ? ` · ${Math.round(S.pct * 100)}%` : ""}</span></div>
            <div><b class="pr-hr ${S.lastHour ? S.lastHour.color : ""}">${S.lastHour ? r1(S.lastHour.perHour) : "—"}</b><span>last hour</span></div></div>
          <p class="pr-foot">${S.lastMin == null ? "No counts yet today." : `Last count ${hm(S.lastMin / 60)} · ${ago(S.lastMin)}`}${others.length > 1 ? raw(html`<br>${others.map(p => raw(html`<span class="pr-who c-${p.color}">${first(p.name)} ${p.count} · ${r1(p.perHour)}/hr${p.ownGoal ? ` (goal ${g1(p.goal)})` : ""}</span>`))}`) : ""}</p>
        </div>`); })}</div>`;
  }

  // ---- the work: pieces due and (today) done, by kind of work. Counts only — no finish times (Neal, Oct 14)
  function drawWork(X) {
    const el = document.getElementById("pl-work"); if (!el) return;
    const P = X.P, D = P.dp.D, live = P.isToday && D;
    const cells = CATS.filter(k => (P.q[k] || 0) > 0.5).map(k => {
      const left = live ? Math.max(0, Math.round(P.q[k] - (D.done[k] || 0))) : Math.round(P.q[k]);
      const over = st.overrides[k] != null;
      const line = left <= 0 ? raw('<span class="good-txt">done</span>') : st.over ? raw(html`<span class="muted">${fmtN(left)} for later</span>`)
        : raw(html`<span>${fmtN(left)} ${live ? "left" : "to do"}</span>`);
      return html`<${can ? "button" : "div"} class="wk ${over ? "typed" : ""}" ${can ? raw(`type="button" data-cat="${k}" title="Change the number to plan with"`) : ""}><span class="wk-l"><i class="sw" style="--c:${CAT_COLOR[k]}"></i>${TILE[k]}</span>
        <span class="wk-n">${live ? `${fmtN(D.done[k] || 0)} of ${fmtN(P.q[k])}` : `${P.expected ? "~" : ""}${fmtN(P.q[k])}`}${over ? " · typed" : ""}</span><span class="wk-t">${line}</span></${can ? "button" : "div"}>`;
    });
    el.innerHTML = cells.length ? cells.join("") : "";
    el.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => countDialog(b.dataset.cat)));
  }
  function hmShort(h) { const m = Math.round(h * 60) % 1440, H = Math.floor(m / 60) % 12 || 12; return `${H}:${String(m % 60).padStart(2, "0")}`; }

  // ---- station board
  function personInfo(X, code) {
    const P = X.P, c = st.crew[code], id = c.emp; if (!id) return null;
    const row = X.R.empty ? null : X.R.rows.find(r => r.st.id === code), op = X.E.opsInfo().find(x => x.o.id === code);
    const startH = parseTime(c.start) ?? 0, end = row?.staffed ? row.clockOut : op?.on ? op.end : startH + (+c.hrs || 0);
    const brk = M.breaksOf(X.R)[id], cs = P.isToday && P.now != null ? M.clockState(P, id, P.now, brk) : null;
    const att = P.isToday ? M.attendanceOf(P, id, c.start, brk) : null;
    const state = cs === "gone" ? "gone" : cs === "break" ? "break" : att?.state === "missing" ? "missing" : cs === "in" ? "in" : "";
    return { id, code, name: M.nameOf(P, id), first: first(M.nameOf(P, id)), startH, end, state, outAt: M.lastOutOf(P, id), moves: (c.moves || []).slice().sort((a, b) => a.at.localeCompare(b.at)), standing: !c.stop && P.people.find(p => p.id === id)?.leaveBy };
  }
  // ---- stations, top to bottom (order set with Reorder), and the whole day across in 15-minute steps (Neal, Oct 13)
  function boardHint() {
    const h = document.getElementById("pl-board-hint"); if (!h) return;
    h.textContent = reorder ? "Move a station up or down. Everyone sees the same order." : !can ? "" : boardView === "people" ? "Each bar is the station they're on · tap one to set times, a break or a move" : "Tap a person to set their times, break or a move · tap a station to add someone";
  }
  function drawBoard(X, L) {
    const el = document.getElementById("pl-board"); if (!el) return;
    const P = X.P, groups = M.boardGroups(POS, order()), people = boardView === "people", rows = people ? M.personRows(X, groups) : M.stationRows(X, groups), ends = M.catEnds(X.E, X.R), live = P.isToday && L && L.on && L.cats;
    const now = P.isToday && P.now != null ? P.now : null;
    // people: clocked out (gray from then on), not clocked in yet, on break
    const info = {}; for (const code of Object.keys(st.crew)) { const pi = personInfo(X, code); if (pi) info[pi.id] = pi; }
    // 5 AM to 4 PM, wider only for real production clock time today: an earlier clock-in, or someone still on (or out) later (Neal, Oct 13)
    let a = 5, b = 16;
    if (P.isToday) for (const c of P.clock || []) {
      const h = x => { const t = String(x).slice(11, 16).split(":"); return +t[0] + (+t[1] || 0) / 60; };
      a = Math.min(a, Math.floor(h(c.clockIn)));
      const end = c.clockOut ? h(c.clockOut) : now; if (end != null) b = Math.max(b, Math.ceil(end + 0.01));
    }
    rows.forEach(g => g.lanes.forEach(l => { l.bars = l.bars.map(x => ({ ...x, from: Math.max(a, x.from), to: Math.min(b, x.to) })).filter(x => x.to > x.from + 0.01); }));
    const q = h => Math.round(h * 4) / 4; // bars land on the 15-minute grid
    const pct = h => ((h - a) / (b - a) * 100).toFixed(3) + "%", wid = (f, t) => ((t - f) / (b - a) * 100).toFixed(3) + "%";
    const ticks = []; for (let t = a; t < b; t++) ticks.push(html`<span style="left:${pct(t)}">${(t % 12) || 12}${t === 12 ? raw("<small>PM</small>") : t === a ? raw(`<small>${t < 12 ? "AM" : "PM"}</small>`) : ""}</span>`);
    const nowLine = now != null && now > a && now < b ? html`<i class="tl-now" style="left:${pct(now)}" aria-hidden="true"></i>` : "";
    // red line: where each kind of work should be finished, from its pieces and pieces-per-hour (Neal, Oct 14)
    const FIN = M.finishLines(X), RATE = { slb: `${s.rates.slb}/hr per press`, slt: `${s.rates.sltSolo}/hr on SLT 1, +${s.rates.sltPair - s.rates.sltSolo} with the helper`, dct: `${s.rates.dct}/hr per press`, dcb: `${s.rates.dcb}/hr`, tc: `${s.rates.tc}/hr`, comf: `${s.rates.comf}/hr`, asm: `${s.rates.asm}/hr per person` };
    const finTip = f => `${M.GROUP_LABEL[f.k] || f.k}: ${fmtN(f.pieces)} ${P.isToday ? "pieces left" : "pieces"} at ${RATE[f.k] || ""} with ${f.people} ${f.people === 1 ? "person" : "people"} planned → ${f.finish != null ? `done about ${hmShort(f.finish)} ${f.finish < 12 ? "AM" : "PM"}` : `${fmtN(f.short)} not covered by the planned hours`}`;
    const finLine = k => { const f = st.over ? null : FIN[k]; if (!f || f.finish == null || f.finish <= a || f.finish >= b) return ""; return html`<i class="tl-fin" style="left:${pct(f.finish)}" title="${finTip(f)}"><span>${hmShort(f.finish)}</span></i>`; };
    const statusOf = g => {   // pieces of that kind still to do (today: left), and when the plan should finish them
      const k = g.cat || (g.key === "asm" ? "asm" : null), f = k && !st.over ? FIN[k] : null;   // the day is over: no finish times
      if (k === "asm") return f ? html`<span class="${f.finish == null ? "bad-txt" : ""}" title="${finTip(f)}">${f.finish != null ? `by ${hmShort(f.finish)}` : f.people ? `${fmtN(f.short)} short` : ""}</span>` : "";
      if (!k || !((P.q[k] || 0) > 0.5)) return "";
      const D = P.dp?.D, left = P.isToday && D ? Math.max(0, Math.round(P.q[k] - (D.done?.[k] || 0))) : Math.round(P.q[k]);
      const when = f ? (f.finish != null ? ` · by ${hmShort(f.finish)}` : f.people ? ` · ${fmtN(f.short)} short` : " · no one") : "";
      if (left > 0 && st.over) return html`<span class="muted">${fmtN(left)} for later</span>`;
      return left <= 0 ? html`<span class="good-txt">done</span>` : html`<span class="${f && f.finish == null ? "bad-txt" : ""}" title="${f ? finTip(f) : ""}">${fmtN(left)} ${P.isToday ? "left" : "to do"}${when}</span>`;
    };
    const barHtml = (g, l, lane = l.lane) => {
      const pi = info[l.empId], nm = pi ? pi.first : first(M.nameOf(P, l.empId));
      const cut = pi && pi.state === "gone" && pi.outAt != null ? pi.outAt : null, noshow = pi && pi.state === "missing";
      const out = [];
      l.bars.forEach((x, i) => {
        let f = q(x.from), t = Math.max(q(x.to), f + 0.25);
        const parts = cut == null || t <= cut ? [[f, t, false]] : f >= cut ? [[f, t, true]] : [[f, q(cut), false], [q(cut), t, true]].filter(p => p[1] > p[0]);
        for (const [pf, pt, gone] of parts) {
          if (x.brk) { out.push(html`<i class="tl-brk" style="left:${pct(pf)};width:${wid(pf, pt)};top:${lane * 32 + 6}px" title="${nm}: break ${fmtClock(x.from)}–${fmtClock(x.to)}"></i>`); continue; }
          const label = people ? x.label : nm;
          const tip = people ? `${pi?.name || nm}: ${x.label} ${fmtClock(x.from)}–${fmtClock(x.to)}${x.ot ? " (overtime)" : ""}${gone ? ` — clocked out ${fmtClock(cut)}` : noshow ? " — not clocked in" : x.idle ? " — nothing to do" : ""}`
            : `${pi?.name || nm}: ${g.label}${l.code !== g.code && g.code ? ` (from ${(POS.find(p => p.id === l.code) || {}).label || l.code})` : ""} ${fmtClock(x.from)}–${fmtClock(x.to)}${x.ot ? " (overtime)" : ""}${gone ? ` — clocked out ${fmtClock(cut)}` : noshow ? " — not clocked in" : x.idle ? " — nothing to do" : ""}`;
          out.push(html`<button type="button" class="tl-bar ${x.ot ? "ot" : ""} ${gone ? "gone" : ""} ${noshow ? "noshow" : ""} ${x.idle ? "idle" : ""}" data-emp="${l.empId}" data-stn="${people ? x.stn : g.code}" data-at="${x.from}" style="left:${pct(pf)};width:${wid(pf, pt)};top:${lane * 32 + 6}px;--c:${COLOR[x.key || g.key] || COLOR.ops}" title="${tip}" aria-label="${tip}">${label ? raw(html`<b>${label}</b>`) : ""}</button>`);
        }
      });
      return out.join("");
    };
    el.innerHTML = html`<div class="tl" style="--hrs:${b - a}">
      <div class="tl-axis"><div class="tl-lab"></div><div class="tl-track">${raw(ticks.join(""))}</div></div>
      ${rows.map(g => {
        // one row per station (Neal, Oct 14); the kind of work's count and finish show on its first station
        const gi = groups.findIndex(x => x.key === g.key), lastG = groups.length - 1;
        const free = !people && !st.crew[g.code].emp, lanes = g.nLanes, add = can && free && !reorder;
        if (people) {   // a person's line: their name, their own station and hours; tap = the move sheet
          const pi = info[g.empId], sub = `${((POS.find(p => p.id === g.code) || {}).label || g.code).replace(/Starch Laundry/i, "SL").replace(/Dry Cleaning/i, "DC")}${pi ? ` · ${hmShort(pi.startH)}–${hmShort(pi.end)}` : ""}`;
          const plab = html`<i class="sw" style="--c:${COLOR[g.key] || COLOR.ops}"></i><span class="tl-name"><b>${g.label}</b><small>${sub}</small></span>`;
          return raw(html`<div class="tl-row ${g.first ? "first" : "sub"}" data-g="${g.key}" data-code="${g.code}">
            ${can ? raw(html`<button type="button" class="tl-lab" data-emp="${g.empId}" aria-label="Move ${g.name}" title="${g.name}">${raw(plab)}</button>`) : raw(html`<div class="tl-lab">${raw(plab)}</div>`)}
            <div class="tl-track" style="height:32px">${raw(g.lanes.map(l => barHtml(g, l)).join(""))}${raw(nowLine)}${raw(finLine(g.key))}</div>
          </div>`);
        }
        const lab = html`<i class="sw" style="--c:${COLOR[g.key] || COLOR.ops}"></i><span class="tl-name"><b>${g.label}</b><small>${raw(g.first ? statusOf(g) : "")}</small></span>${add ? raw('<span class="tl-plus" aria-hidden="true">+</span>') : ""}`;
        const ord = reorder && g.first ? raw(html`<span class="tl-ord"><button type="button" class="btn ghost small" data-up="${g.key}" aria-label="Move ${M.GROUP_LABEL[g.key]} up" ${gi === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn ghost small" data-down="${g.key}" aria-label="Move ${M.GROUP_LABEL[g.key]} down" ${gi === lastG ? "disabled" : ""}>↓</button></span>`) : "";
        return raw(html`<div class="tl-row ${g.key === "slb" ? "neck" : ""} ${g.first ? "first" : "sub"}" data-g="${g.key}" data-code="${g.code}">
          ${reorder ? raw(html`<div class="tl-lab">${raw(lab)}${ord}</div>`)
            : add ? raw(html`<button type="button" class="tl-lab" data-add="${g.key}" data-code="${g.code}" aria-label="Add someone to ${g.label}">${raw(lab)}</button>`) : raw(html`<div class="tl-lab">${raw(lab)}</div>`)}
          <div class="tl-track" style="height:${lanes * 32}px">${g.lanes.length ? raw(g.lanes.map(l => barHtml(g, l)).join("")) : raw('<span class="tl-none">No one</span>')}${raw(nowLine)}${raw(finLine(g.key))}</div>
        </div>`);
      })}
    </div>`;
    // start scrolled so "now" is in view on a phone
    if (now != null && !el.dataset.scrolled) { el.dataset.scrolled = "1"; const tr = el.querySelector(".tl-track"); if (tr) el.scrollLeft = Math.max(0, (now - a) / (b - a) * tr.offsetWidth - el.clientWidth / 3); }
  }
  async function moveRow(key, dir) {
    const cur = M.boardGroups(POS, order()).map(g => g.key), i = cur.indexOf(key), j = i + dir;
    if (i < 0 || j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]];
    const before = SET.boardOrder; SET.boardOrder = [...cur, ...M.BOARD_ORDER.filter(k => !cur.includes(k))];
    if (st.X) drawBoard(st.X, st.L);
    main.querySelector(`[data-${dir < 0 ? "up" : "down"}="${key}"]:not([disabled])`)?.focus();
    try { const r = await api("/settings/board-order", { method: "PUT", body: { order: SET.boardOrder } }); SET.boardOrder = r.boardOrder; }
    catch (e) { SET.boardOrder = before; if (st.X) drawBoard(st.X, st.L); toast(`Not saved: ${e.message}`, "bad"); }
  }
  function drawAway(P) {
    const el = document.getElementById("pl-away"); if (!el) return;
    const out = P.callouts || [], late = P.late || [];
    el.innerHTML = html`${out.length ? raw(html`<span>Out: ${out.map(c => M.nameOf(P, c.personId)).join(", ")}</span>`) : ""}
      ${late.length ? raw(html`<span>In late: ${late.map(l => `${M.nameOf(P, l.personId)} ${fmtClock(parseTime(l.at))}`).join(", ")}</span>`) : ""}
      ${can ? raw('<button class="linkish" id="pl-away-btn">Out or late…</button>') : ""}<a class="linkish" href="#/team">Team</a>`;
    el.querySelector("#pl-away-btn")?.addEventListener("click", () => awayDialog(makeP()));
  }

  // ---- a person on the plan (Neal, Oct 14): tap a bar to set when they're on that station, their break, or move them
  const posLabel = code => code === "comf" ? "Comforters" : (POS.find(p => p.id === code) || {}).label || code;
  const tIn = (name, h, extra = "") => `<input class="input" type="time" step="300" name="${name}" value="${h != null ? hhmm(h) : ""}" ${extra}>`;
  function personSheet(empId, stn = null, at = null) {
    const X = st.X, P = X.P, code = Object.keys(st.crew).find(k => st.crew[k].emp === empId); if (!code) return;
    const c = st.crew[code], name = M.nameOf(P, empId), fn = first(name), e = people.find(p => p.id === empId);
    const segs = M.segmentsOf(c, code, s.breakMin), sh = M.shiftOf(c, s.breakMin);
    const near = t => segs.findIndex(g => t >= g.from - 1e-6 && t < g.to - 1e-6);
    let i = stn != null && at != null ? segs.findIndex(g => g.stn === stn && at >= g.from - 0.02 && at < g.to + 0.02) : -1;
    if (i < 0 && P.isToday && P.now != null) i = near(P.now);
    if (i < 0) i = 0;
    const sg = segs[i], last = i === segs.length - 1;
    const pi = personInfo(X, code);
    const stateTxt = pi && pi.state === "gone" ? ` · clocked out ${fmtClock(pi.outAt)}` : pi && pi.state === "break" ? " · on break" : pi && pi.state === "missing" ? " · not clocked in yet" : pi && pi.state === "in" ? " · on the clock" : "";
    const trainedTxt = id => (X.E.rankOf(e, id) ? "" : " (not trained)");
    const others = POS.filter(p => p.id !== sg.stn && (p.type === "ops") === (POS.find(x => x.id === code)?.type === "ops"));
    const dayTxt = P.isToday ? "today" : new Date(pick + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
    openDialog({
      title: `${name} · ${posLabel(sg.stn)}`, submitLabel: "Save",
      body: html`<p class="dlg-lead">In ${fmtClock(sh.start)} · out ${fmtClock(sh.end)}${sh.brk ? ` · break ${fmtClock(sh.brk[0])}–${fmtClock(sh.brk[1])}` : " · no break set"}${stateTxt}${segs.length > 1 ? ` · ${segs.map(g => posLabel(g.stn)).join(" → ")}` : ""}</p>
        <fieldset class="pe-edit"><legend>On ${posLabel(sg.stn)}</legend>
          <div class="pe-times"><label class="field"><span>${i === 0 ? "Clock in" : "From"}</span>${raw(tIn("from", sg.from, "required"))}</label>
          <label class="field"><span>${last ? "Clock out" : "Until"}</span>${raw(tIn("to", sg.to, "required"))}</label></div></fieldset>
        <fieldset class="pe-edit"><legend>Break</legend>
          <div class="pe-times"><label class="field"><span>Starts</span>${raw(tIn("b0", sh.brk ? sh.brk[0] : null))}</label>
          <label class="field"><span>Ends</span>${raw(tIn("b1", sh.brk ? sh.brk[1] : null))}</label></div>
          <p class="muted small">Leave both empty for no break. Ends fills in ${s.breakMin} minutes after it starts.</p></fieldset>
        <fieldset class="pe-edit"><legend>Move to another station <em>(optional)</em></legend>
          <div class="pe-times"><label class="field"><span>Station</span><select class="input" name="mv"><option value="">— Stay here —</option>
            ${others.map(p => raw(html`<option value="${p.id}">${posLabel(p.id)}${trainedTxt(p.id)}</option>`))}</select></label>
          <label class="field"><span>At</span>${raw(tIn("mvat", null))}</label></div></fieldset>
        <div class="ms-more"><span class="muted small">${dayTxt} only:</span>
          ${i > 0 ? raw('<button type="button" class="btn small ghost" data-act="drop">Remove this station</button>') : ""}
          <button type="button" class="btn small ghost" data-act="off">Off the plan</button><button type="button" class="btn small ghost" data-act="away">Out or late…</button></div>`,
      onOpen: (form, d) => {
        d.classList.add("sheet");
        form.b0.addEventListener("change", () => { const h = parseTime(form.b0.value); if (h != null && !form.b1.value) form.b1.value = hhmm(h + s.breakMin / 60); });
        form.mv.addEventListener("change", () => { if (form.mv.value && !form.mvat.value) form.mvat.value = hhmm(P.isToday && P.now != null ? Math.max(sg.from, Math.ceil(P.now * 4) / 4) : Math.min(sg.to - 0.25, sg.from + 2)); });
        d.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => {
          const act = b.dataset.act; d.close();
          if (act === "drop") return edit(() => { st.crew = M.dropSegment(st.crew, code, i, s.breakMin); }, { msg: `${fn} is off ${posLabel(sg.stn)}.` });
          if (act === "off") return edit(() => { st.crew[code] = { ...st.crew[code], emp: "", stop: "", moves: [], brk: "", source: "" }; }, { msg: `${fn} is off the plan.` });
          if (act === "away") return awayDialog(makeP(), empId);
        }));
      },
      onSubmit: form => {
        const from = parseTime(form.from.value), to = parseTime(form.to.value);
        if (from == null || to == null) throw new Error("Fill in both times.");
        let C = st.crew; const done = [];
        if (Math.abs(from - sg.from) > 1e-6 || Math.abs(to - sg.to) > 1e-6) { C = M.setSegment(C, code, i, from, to, s.breakMin); done.push(`${posLabel(sg.stn)} ${hm(from)}–${hm(to)}`); }
        const b0 = parseTime(form.b0.value), b1 = parseTime(form.b1.value) ?? (b0 != null ? b0 + s.breakMin / 60 : null);
        const had = M.breakOf(C[code], s.breakMin);
        if (b0 == null && had) { C = M.setBreak(C, code, null, null, s.breakMin); done.push("no break"); }
        else if (b0 != null && (!had || Math.abs(had[0] - b0) > 1e-6 || Math.abs(had[1] - b1) > 1e-6)) { C = M.setBreak(C, code, b0, b1, s.breakMin); done.push(`break ${hm(b0)}–${hm(b1)}`); }
        if (form.mv.value) {
          const mat = parseTime(form.mvat.value); if (mat == null) throw new Error("Pick the time they move.");
          const code2 = Object.keys(C).find(k => C[k].emp === empId) || code;
          C = M.moveAt(C, code2, form.mv.value, mat, s.breakMin); done.push(`→ ${posLabel(form.mv.value)} at ${hm(mat)}`);
        }
        if (!done.length) return;
        edit(() => { st.crew = C; }, { msg: `${fn}: ${done.join(" · ")}` });
      },
    });
  }
  // ---- add someone to a station: people not on the plan (with their times), or someone on the plan moving over
  function addSheet(key, code = null) {
    const X = st.X, P = X.P, g0 = M.boardGroups(POS, order()).find(x => x.key === key); if (!g0) return;
    const one = code && g0.codes.includes(code) ? code : null;
    const g = one ? { ...g0, codes: [one], label: posLabel(one) } : g0;
    const out = new Set((P.callouts || []).map(c => c.personId)), onCrew = new Map(Object.entries(st.crew).filter(([, c]) => c.emp).map(([cd, c]) => [c.emp, cd]));
    const rk = e => Math.min(...g.codes.map(c => X.E.rankOf(e, c) || 99));
    const list = people.filter(e => !out.has(e.id) && !g.codes.includes(onCrew.get(e.id)))
      .sort((a, b) => (onCrew.has(a.id) - onCrew.has(b.id)) || rk(a) - rk(b) || a.name.localeCompare(b.name));
    if (!list.length) return toast("Everyone available is already here.", "warn");
    const d0 = list[0], u0 = parseTime(M.notBeforeLate(P, d0.id, d0.start || s.defStart)) ?? 7;
    openDialog({
      title: `Add to ${g.label}`, submitLabel: "Add",
      body: html`<label class="field"><span>Who</span><select class="input" name="who" required>${list.map(e => raw(html`<option value="${e.id}">${e.name}${rk(e) < 99 ? "" : " (not trained)"}${onCrew.has(e.id) ? ` · now on ${posLabel(onCrew.get(e.id))}` : ""}</option>`))}</select></label>
        <div class="pe-times"><label class="field"><span id="ad-l0">Clock in</span>${raw(tIn("t0", u0, "required"))}</label><label class="field"><span id="ad-l1">Clock out</span>${raw(tIn("t1", u0 + M.SHIFT_H))}</label></div>
        <p class="muted small" id="ad-hint">Someone already on the plan moves here at the first time and stays until they clock out (or their next move).</p>`,
      onOpen: (form, d) => {
        d.classList.add("sheet");
        const sync = () => {
          const e = people.find(p => p.id === form.who.value), on = onCrew.has(e.id);
          d.querySelector("#ad-l0").textContent = on ? "Moves here at" : "Clock in"; d.querySelector("#ad-l1").parentElement.hidden = on;
          if (on) { const t = P.isToday && P.now != null ? Math.ceil(P.now * 4) / 4 : 9; form.t0.value = hhmm(t); }
          else { const u = parseTime(M.notBeforeLate(P, e.id, e.start || s.defStart)) ?? 7; form.t0.value = hhmm(u); form.t1.value = hhmm(u + M.SHIFT_H); }
        };
        form.who.addEventListener("change", sync); sync();
      },
      onSubmit: form => {
        const id = form.who.value, e = people.find(p => p.id === id), fn = first(e.name), t0 = parseTime(form.t0.value);
        if (t0 == null) throw new Error("Pick a time.");
        if (onCrew.has(id)) {
          const from = onCrew.get(id), target = g.codes.find(c => !st.crew[c].emp || c === one) || g.codes[0];
          const C = M.moveAt(st.crew, from, target, t0, s.breakMin);
          edit(() => { st.crew = C; }, { msg: `${fn} → ${posLabel(target)} at ${hm(t0)}.` }); return;
        }
        const spot = g.codes.find(c => !st.crew[c].emp); if (!spot) throw new Error(`Every ${g.label} spot is taken. Move someone off first.`);
        const t1 = parseTime(form.t1.value); if (t1 == null || t1 <= t0 + 0.25) throw new Error("Clock out has to be after clock in.");
        edit(() => { st.crew[spot] = { emp: id, start: hhmm(t0), stop: hhmm(t1), hrs: Math.round((t1 - t0) * 100) / 100, brk: "", source: "user", moves: [] }; }, { msg: `${fn} on ${posLabel(spot)} ${hm(t0)}–${hm(t1)}. Tap their bar to set a break.` });
      },
    });
  }
  function showHelp(id) {
    const h = HELP[id]; if (!h) return;
    openDialog({ title: h.title, body: h.body.replace("${FULL}", fmtH(s.fullDay)), submitLabel: "Got it", onOpen: (form, dlg) => { dlg.querySelector("[data-close]").hidden = true; dlg.classList.add("help-dlg"); }, onSubmit: () => {} });
  }

  // ---- typed piece counts
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

  // Out or in late for this day: saved as time off (the same list the Team screen shows), for anyone on the team.
  function awayDialog(P, fixedId = null) {
    const out = new Set((P.callouts || []).map(c => c.personId));
    const stOf = {}; for (const [code, c] of Object.entries(st.crew)) if (c.emp) stOf[c.emp] = code;
    const label = code => POS.find(p => p.id === code)?.label || code;
    const list = people.filter(e => !out.has(e.id) || e.id === fixedId).sort((a, b) => (!stOf[a.id]) - (!stOf[b.id]) || a.name.localeCompare(b.name));
    if (!list.length) return toast("Everyone on the team is already marked out.", "warn");
    openDialog({
      title: fixedId ? `${M.nameOf(P, fixedId)}: out, late or hard stop?` : "Out, late or hard stop", submitLabel: "Save",
      body: html`<p class="dlg-lead">For ${longDay(pick)}. Out takes them off the plan; late keeps them on but they don't start before their time; a hard stop means they leave at that time no matter what's left. For other days, use Team (time off, or must leave by).</p>
        <label class="field"><span>Person</span><select class="input" name="who" required ${fixedId ? "disabled" : ""}><option value="">— Pick someone —</option>
          ${list.map(e => raw(html`<option value="${e.id}" ${e.id === fixedId ? "selected" : ""}>${e.name}${stOf[e.id] ? ` · on ${label(stOf[e.id])}` : ""}</option>`))}</select></label>
        <div class="field"><span>What</span><div class="kindrow"><label><input type="radio" name="kind" value="out" checked> Out today</label><label><input type="radio" name="kind" value="late"> In late at</label><label><input type="radio" name="kind" value="stop"> Hard stop at</label>
          <input class="input" type="time" step="300" name="at" aria-label="Time"></div></div>
        <label class="field"><span>Note <em>(optional)</em></span><input class="input" name="note" maxlength="300" placeholder="Sick, appointment, no call…"></label>`,
      onSubmit: async form => {
        const id = fixedId || form.who.value; if (!id) throw new Error("Pick who it is.");
        const kind = form.kind.value, at = form.at.value;
        if (kind === "late" && !at) throw new Error("Pick the time they'll come in.");
        const code = stOf[id] || null, name = M.nameOf(makeP(), id), note = form.note.value || null;
        if (kind === "stop") {
          if (!at) throw new Error("Pick the time they have to leave.");
          if (!code) throw new Error(`${name} isn't on the plan for ${longDay(pick)}. Add them to a station first.`);
          edit(() => { st.crew[code] = { ...st.crew[code], stop: at, source: "user" }; }, { msg: `${name} leaves at ${fmtClock(parseTime(at))} (hard stop).` });
          return;
        }
        if (st.dirty) await save();
        const r = await api("/timeoff", { method: "POST", body: { personId: id, kind, fromDay: pick, toDay: pick, at, note } });
        const gone = new Set(r.replaced || []);
        st.plan.late = (st.plan.late || []).filter(l => !gone.has(l.id) && l.personId !== id);
        if (kind === "out") {
          st.plan.callouts = [...(st.plan.callouts || []), { id: r.id, timeOff: true, personId: id, station: code, note, fromDay: pick, toDay: pick }];
          if (code) edit(() => { st.crew[code] = { ...st.crew[code], emp: "", stop: "", source: "" }; }, { msg: `${name} is out — off ${label(code)}.` });
          else { update({ table: true }); toast(`${name} is marked out.`); }
        } else {
          st.plan.late = [...st.plan.late, { id: r.id, personId: id, at, note }];
          if (code && st.crew[code].start < at) edit(() => { st.crew[code] = { ...st.crew[code], start: at, source: "user" }; }, { msg: `${name} starts at ${fmtClock(parseTime(at))}.` });
          else { update({ table: true }); toast(`${name} comes in at ${fmtClock(parseTime(at))}.`); }
        }
      },
    });
  }

  // ---- publishing
  function drawPub(X) {
    const b = document.getElementById("pl-pub"); if (!b) return;
    const pub = st.plan.published, sig = M.sigOf(X.P);
    if (!pub) { b.textContent = "Not published · Publish"; b.className = "btn primary small"; b.title = "The floor isn't showing this plan yet. Click to show it on the Floor screens."; }
    else if (pub.sig !== sig) { b.textContent = "Changed · Publish again"; b.className = "btn primary small"; b.title = `Published ${ago(pub.at).toLowerCase()} by ${pub.by}; changed since`; }
    else { b.textContent = `Published ${new Date(pub.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`; b.className = "btn small published"; b.title = `Published by ${pub.by}. The floor shows this plan.`; }
    b.disabled = X.R.empty;
  }

  function publishDialog() {
    const X = st.X; if (!X || X.R.empty) return toast("Add the crew first.", "warn");
    const people = X.R.rows.filter(r => r.staffed).length + X.E.opsInfo().filter(x => x.on).length;
    openDialog({
      title: `Publish the plan for ${longDay(pick)}?`, submitLabel: st.plan.published ? "Publish changes" : "Publish",
      body: html`<p class="dlg-lead">The Floor screens show it right away. You can keep changing the plan and publish again.</p>
        <div class="pub-sum"><div><b>${people}</b><span>people</span></div><div><b>${hm(X.R.firstStart)}</b><span>first in</span></div><div><b>${hm(X.R.end)}</b><span>last out</span></div></div>
`,
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


  // ---- changes today
  async function loadChanges() {
    const box = document.getElementById("pl-chg-box"); if (!box || chgBusy) return;
    chgBusy = true;
    try {
      const r = await api(`/changes/${st.V.today}`);
      const n = document.getElementById("pl-chg-n"); if (n) n.textContent = r.list.length ? String(r.list.length) : "";
      const el = document.getElementById("pl-chg"); if (!el) return;
      el.innerHTML = r.list.length ? html`<ol class="chg-list">${r.list.slice(0, 150).map(x => raw(html`<li class="${x.tag}"><time>${new Date(x.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time><span>${x.text}${x.who ? raw(html` <small>· ${x.who}</small>`) : ""}</span></li>`))}</ol>`
        : html`<p class="muted pad">No changes yet today.</p>`;
    } catch { /* optional */ } finally { chgBusy = false; }
  }

  // ---- print: a one-page, landscape timeline (Save as PDF in the print dialog)
  function printPlan() {
    const X = st.X || M.evaluate(makeP()), { R, E, P } = X;
    if (R.empty) return toast("Add the crew and pieces before printing.", "warn");
    const rows = [];
    for (const row of R.rows) { if (!row.staffed) continue; const o = outInfo(row);
      rows.push({ name: M.nameOf(P, st.crew[row.st.id].emp), start: row.x.start, steps: stepsOf(row).map(x => ({ stn: x.stn, from: x.from, to: x.to, rot: !!x.rotFrom })),
        brk: row.brkTaken > 0 ? [row.brkS, row.brkS + row.brkTaken] : null, done: row.clockOut, cls: o.cls, ot: row.ot }); }
    for (const x of E.opsInfo()) if (x.on) rows.push({ name: M.nameOf(P, st.crew[x.o.id].emp), start: x.start, steps: [{ stn: x.o.id, from: x.start, to: x.end }], brk: x.b ? [x.brkS, x.brkS + x.b] : null, done: x.end, cls: "norm", ot: 0 });
    const a = Math.floor(Math.min(...rows.map(r => r.start))), b = Math.ceil(Math.max(...rows.map(r => r.done), ...(SHUTTLES ? X.waves.filter(w => w.deadline != null && w.deadline < 24).map(w => w.deadline) : [])));
    const pct = h => ((h - a) / (b - a) * 100).toFixed(2) + "%", wid = (p, q) => ((q - p) / (b - a) * 100).toFixed(2) + "%";
    const lbl = c => c === "comf" ? "Comforters" : c === "slo" ? "Laundry operator" : c === "dco" ? "DC operator" : POS.find(p => p.id === c)?.label || c;
    const col = c => c === "comf" ? COLOR.comf : COLOR[E.TYPE_OF[c]] || COLOR.ops;
    const ticks = [], hrs = []; for (let t = a; t <= b; t++) { ticks.push(html`<span style="left:${pct(t)}">${hm(t)}</span>`); hrs.push(`<i class="ps-hr" style="left:${pct(t)}"></i>`); }
    const W = SHUTTLES ? X.waves.filter(w => (w.kind === "shuttle" || w.kind === "counter") && w.todo > 0 && w.deadline != null && w.deadline < 24) : [];
    const money = admin && SET.groups.money.pdfMoney && X.M ? html`<span>Labor ${X.M.pct != null ? X.M.pct.toFixed(1) + "%" : "—"} · ${fmt$(X.M.total)} of ${fmt$(X.M.revenue)}</span>` : "";
    const sheet = document.getElementById("pl-print-sheet");
    sheet.innerHTML = html`<header class="ps-head"><div><b>${SET.groups.business.name || "Production plan"}</b><span>Production plan · ${longDay(pick)}</span></div>
        <div class="ps-kpi"><span>In ${fmtClock(R.firstStart)} · last out <b>${fmtClock(R.end)}</b></span><span>${fmtN(CATS.reduce((t, k) => t + P.q[k], 0))} pieces</span>${raw(money)}</div></header>
      <div class="ps-grid"><div class="ps-axis"><div>Person</div><div class="ps-ticks">${raw(ticks.join(""))}</div><div>Out</div></div>
        ${rows.map(r => raw(html`<div class="ps-row"><div class="ps-name"><b>${r.name}</b><small>in ${fmtClock(r.start)}</small></div>
          <div class="ps-track">${raw(hrs.join(""))}${W.map(w => raw(html`<i class="ps-dl" style="left:${pct(w.deadline)}"></i>`))}${r.steps.map(x => raw(html`<span class="ps-bar" style="left:${pct(x.from)};width:${wid(x.from, x.to)};--c:${col(x.stn)}">${lbl(x.stn)}${x.rot ? " (rot.)" : ""}</span>`))}
            ${r.brk ? raw(html`<span class="ps-brk" style="left:${pct(r.brk[0])};width:${wid(r.brk[0], r.brk[1])}">Break</span>`) : ""}</div>
          <div class="ps-done ${r.cls}"><b>${fmtClock(r.done)}</b>${r.cls === "home" ? raw("<small>send home</small>") : r.cls === "ot" ? raw(html`<small>+${fmtH(r.ot)} overtime</small>`) : ""}</div></div>`))}</div>
      ${W.length ? raw(html`<div class="ps-waves">${W.map(w => { const st2 = X.states[w.id] || {}; return raw(html`<span><b>${hm(w.deadline)}</b> ${w.name} · ${fmtN(w.todo)} pieces${st2.eta != null && isFinite(st2.eta) ? ` · ready about ${hm(st2.eta)}` : ""}</span>`); })}</div>`) : ""}
      <footer class="ps-foot">Printed ${new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} by ${ctx.me.name}${st.plan.published ? ` · published ${new Date(st.plan.published.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : " · not published"}</footer>`;
    sheet.style.setProperty("--rh", `${Math.max(30, Math.min(54, Math.floor(520 / rows.length)))}px`);
    document.body.classList.add("printing");
    const done = () => { document.body.classList.remove("printing"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => { window.print(); setTimeout(done, 1500); }, 50);
  }

}
