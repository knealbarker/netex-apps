// Plan: pieces from SMRT, the crew on each station, the day simulated minute by minute, and publishing.
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
let neckT = null; // the bottleneck card's move search runs just after drawing
let pick = null; // the day being looked at, kept while moving between sections

// What each button at the top of the Plan does (the "?" next to it opens this).
const HELP = {
  suggest: { title: "Suggest from history", body: `<p>Builds a whole crew for this day:</p>
    <ul><li><b>Who:</b> everyone on Team who isn't marked <b>out</b> (and whose usual days include this day).</li>
    <li><b>When:</b> each person's usual clock-in for that weekday. Anyone marked late on Team starts at their late time.</li>
    <li><b>Where:</b> the station depth chart on Team. Operators first; with more starch bottoms than one presser can do, both SLB presses next; then each station with work, busiest first, gets its #1, or the next person down its list.</li>
    <li>Comforters and Tablecloths aren't starting stations; people move there later. SLT 2 opens for heavy starch tops, or for a spare person.</li>
    <li>Someone in early covers a late person's station until they arrive (e.g. Maria on SLB 2 until Diana), shown as moves.</li></ul>
    <p><b>It replaces the crew</b> for this day, including changes you made by hand. Undo (Ctrl+Z) brings the old crew back. Nothing reaches the floor until you Publish.</p>
    <p>Best for starting a day. To change one or two things, edit the crew directly.</p>` },
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
    if (!plan.rev && !Object.keys(plan.crew).length && !isPast()) suggest("open");
    drawPage();
    loadChanges();
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
            <button class="btn ghost small pv-tool" id="pl-suggest" title="Build the crew from who usually works this weekday" aria-label="Suggest from history"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg><span>Suggest</span></button>`) : ""}
          <button class="btn ghost small pv-tool" id="pl-print" title="Print the plan, or save it as a PDF" aria-label="Print"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/></svg><span>Print</span></button>
        </div>
      </div>
      <div class="pv-status" id="pl-status" aria-live="polite"></div>
      ${isPast() ? raw(html`<div class="banner info"><b>This day is over.</b> The plan is shown as it was saved (read-only). <a href="#/review?day=${pick}">See how it went in Review</a>.</div>`) : ""}
      <div id="pl-note"></div>
      <section class="pv-neck" id="pl-neck" aria-label="The bottleneck"></section>
      <section class="pv-work" id="pl-work" aria-label="The rest of the work"></section>
      <section class="pv-board" aria-label="Stations">
        <div class="pv-board-head"><h2>Stations</h2><span class="muted small" id="pl-board-hint">${can ? "Tap a person to move them · tap a station to add someone" : ""}</span>
          ${canRole ? raw('<button type="button" class="btn ghost small" id="pl-reorder" aria-pressed="false">Reorder</button>') : ""}</div>
        <div class="tl-scroll" id="pl-board"></div>
        <div class="pv-away" id="pl-away"></div>
      </section>
      <section class="card pl-card"><details id="pl-chg-box"><summary class="pl-cardhead"><div><h2>Changes today <span class="count soft" id="pl-chg-n"></span></h2><p>Who changed what.</p></div></summary><div id="pl-chg"></div></details></section>
      ${can ? raw(html`<div class="pv-foot">${P0isToday() ? raw('<button class="btn" id="pl-replan">Re-plan from now</button>') : ""}<button class="btn primary" id="pl-pub"></button>${raw(helpBtn("publish"))}</div>`) : ""}
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
      main.querySelector("#pl-suggest").addEventListener("click", () => openDialog({
        title: "Suggest a crew?", submitLabel: "Replace the crew",
        body: html`<p class="dlg-lead">Replaces the crew for ${longDay(pick)} with everyone who isn't out that day (Team's usual days count), at their usual clock-in, on the stations they're usually on. You can undo it.</p>`,
        onSubmit: () => edit(() => suggest("button"), { keepNote: true }),
      }));
      main.querySelector("#pl-pub").addEventListener("click", publishDialog);
      main.querySelector("#pl-replan")?.addEventListener("click", replanSheet);
    }
    main.querySelector("#pl-board").addEventListener("click", ev => {
      const up = ev.target.closest("[data-up],[data-down]");
      if (up) return moveRow(up.dataset.up || up.dataset.down, up.dataset.up ? -1 : 1);
      const b = ev.target.closest("[data-emp],[data-add]"); if (!b || !can || reorder) return;
      if (b.dataset.add) addSheet(b.dataset.add); else personSheet(b.dataset.emp);
    });
    main.querySelector("#pl-reorder")?.addEventListener("click", e => {
      reorder = !reorder; e.currentTarget.setAttribute("aria-pressed", String(reorder)); e.currentTarget.textContent = reorder ? "Done" : "Reorder";
      const h = document.getElementById("pl-board-hint"); if (h) h.textContent = reorder ? "Move a station up or down. Everyone sees the same order." : can ? "Tap a person to move them · tap a station to add someone" : "";
      if (st.X) drawBoard(st.X, st.L);
    });
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
    if (!st.note) { el.innerHTML = ""; return; }
    el.innerHTML = html`<div class="banner info"><b>Suggested crew.</b> Everyone who isn't out (Team's usual days count), at their usual clock-in, on the stations they're usually on — starch bottoms presses first; SLT 2, then the second assembly spot, are the ones left empty when there aren't enough people.${st.note.left.length ? ` Not placed: ${st.note.left.join(", ")}.` : ""}
      ${can && !st.rev ? raw(html` <button class="linkish" id="pl-keep">Keep this crew</button>`) : ""}</div>`;
    el.querySelector("#pl-keep")?.addEventListener("click", () => { st.dirty = true; save(); st.note = null; drawNote(); });
  }

  /** Runs the plan and redraws everything that depends on it. */
  function update() {
    if (!alive()) return;
    const X = st.X = M.evaluate(makeP());
    const L = st.L = X.P.isToday ? M.liveSuggestions(X, new Set(st.plan.hidden || [])) : null;
    // the production day is over: what's left waits for later or for a manager, so nothing more is planned (Neal, Oct 13)
    st.over = M.productionDone(X.P, X.P.dp?.D?.lastAsm, M.breaksOf(X.R));
    drawNote(); drawStatus(X, L); drawNeck(X, L); drawWork(X, L); drawBoard(X, L); drawAway(X.P);
    const rp = document.getElementById("pl-replan"); if (rp) rp.hidden = !!st.over;
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
    } else if (X.R.empty) txt = X.R.noCrew ? "No one is on a station yet — tap + Add on a station, or Suggest." : "Nothing to plan yet.";
    else if (L && L.on && L.fromNow) {
      const f = L.fromNow, left = Math.round(f.left), ot = left > 0 && (f.ot || f.otH > 0.04);
      cls = left <= 0 ? "good" : ot ? "warn" : "good";
      txt = left <= 0 ? raw(html`<b>Everything's done</b> · ${fmtN(tot)} pieces`) : raw(html`<b>${fmtN(left)}</b> pieces left · ${f.people} working · done about <b>${f.etc != null ? hm(f.etc) : "—"}</b>${ot ? ` · ${fmtH(f.otH)} overtime` : ""}`);
    } else {
      const ot = X.R.otTotal > 0.04, people = X.R.rows.filter(r => r.staffed).length + X.E.opsInfo().filter(x => x.on).length;
      cls = ot ? "warn" : "good";
      txt = raw(html`<b>${P.expected ? "~" : ""}${fmtN(tot)}</b> pieces · ${people} people · done about <b>${hm(X.R.end)}</b>${ot ? ` · ${fmtH(X.R.otTotal)} overtime` : ""}`);
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

  // ---- the bottleneck: starch bottoms (Neal: the main reason for the planner)
  function drawNeck(X, L) {
    const el = document.getElementById("pl-neck"); if (!el) return;
    const B = st.over ? null : M.bottleneck(X, L);
    if (!B) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const done = B.left < 0.5, behind = !done && B.expected > 0 && B.needed > 0 && B.needed > B.expected + 0.5;
    el.className = `pv-neck ${done ? "good" : B.ot || behind ? "warn" : ""}`;
    const live = X.P.isToday && L && L.on;
    el.innerHTML = html`<div class="nk-head"><i class="sw" style="--c:${CAT_COLOR[B.k]}"></i><h2>${TILE[B.k]}</h2><span class="nk-tag">${B.k === "slb" ? "The bottleneck" : "Finishes last"}</span></div>
      <div class="nk-nums">
        <div><b>${fmtN(B.left)}</b><span>${live ? "left" : "to do"}${live && B.done ? ` · ${fmtN(B.done)} done` : ""}</span></div>
        <div><b>${done || !B.presses || !B.needed ? "—" : `${Math.round(B.needed)}/hr`}</b><span>${!done && B.presses && B.needed ? `needed by ${hm(B.shiftEnd)}` : !done && B.presses ? "shifts are over" : "needed"}</span></div>
        <div><b class="${behind || (!B.presses && !done) ? "warn-txt" : ""}">${B.presses ? `${Math.round(B.expected)}/hr` : "No one"}</b><span>${B.presses ? `${B.presses} ${B.presses === 1 ? "press" : "presses"} at ${Math.round(B.perPress)}` : "on it right now"}</span></div>
      </div>
      <p class="nk-line">${done ? "All done." : raw(html`At this pace ${TILE[B.k].toLowerCase()} finish about <b class="${B.ot ? "warn-txt" : ""}">${B.etc != null ? hm(B.etc) : "—"}</b>${B.ot ? " — past the end of the shifts" : ""}.`)}</p>
      <div class="nk-fix" id="pl-neck-fix"></div>`;
    clearTimeout(neckT);
    if (!can || done) return;
    // trying moves runs the plan a few times: do it just after the page is drawn
    neckT = setTimeout(() => {
      if (!alive() || st.X !== X) return;
      const mv = M.bottleneckMoves(X, L, { max: 1 })[0], box = document.getElementById("pl-neck-fix"); if (!box) return;
      if (!mv) { box.innerHTML = ""; return; }
      box.innerHTML = html`<button class="btn nk-btn" id="pl-neck-go">Move ${first(mv.name)} to ${TILE[mv.k].toLowerCase()} at ${hm(parseTime(mv.at))} → done ${hm(mv.kAfter)}</button>`;
      box.querySelector("#pl-neck-go").addEventListener("click", () => edit(() => { st.crew = M.applyMove(st.crew, POS, mv.empId, mv.k, mv.at); }, { msg: `${first(mv.name)} moves to ${TILE[mv.k].toLowerCase()} at ${hm(parseTime(mv.at))}. Publish when you're ready.` }));
    }, 60);
  }

  // ---- the rest of the work, small: left (or due) and when it's done
  function drawWork(X, L) {
    const el = document.getElementById("pl-work"); if (!el) return;
    const P = X.P, D = P.dp.D, live = P.isToday && L && L.on && L.cats, ends = M.catEnds(X.E, X.R), neck = st.over ? null : M.bottleneck(X, L)?.k;
    const cells = CATS.filter(k => k !== neck && (P.q[k] || 0) > 0.5).map(k => {
      const left = live ? Math.round(L.cats[k].left) : Math.round(P.q[k]), etc = live ? L.cats[k].etc : ends[k], ot = live ? L.cats[k].ot : M.catOvertime(X.E, X.R, k);
      const over = st.overrides[k] != null;
      const line = left <= 0 ? raw('<span class="good-txt">done</span>') : st.over ? raw(html`<span class="muted">${fmtN(left)} for later</span>`)
        : raw(html`<span class="${ot ? "bad-txt" : live ? "warn-txt" : ""}">${fmtN(left)}${etc != null ? ` by ${hmShort(etc)}` : ""}</span>`);
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
  function drawBoard(X, L) {
    const el = document.getElementById("pl-board"); if (!el) return;
    const P = X.P, groups = M.boardGroups(POS, order()), rows = M.stationTimeline(X, groups), ends = M.catEnds(X.E, X.R), live = P.isToday && L && L.on && L.cats;
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
    const statusOf = g => {
      const k = g.cat;
      if (k && (P.q[k] || 0) > 0.5) {
        const left = live ? Math.round(L.cats[k].left) : Math.round(P.q[k]), etc = live ? L.cats[k].etc : ends[k], ot = live ? L.cats[k].ot : M.catOvertime(X.E, X.R, k);
        if (left <= 0) return html`<span class="good-txt">done</span>`;
        if (st.over) return html`<span class="muted">${fmtN(left)} for later</span>`;
        return html`<span class="${ot ? "bad-txt" : ""}">${fmtN(left)}${etc != null ? ` · ${hmShort(etc)}` : " · no one"}</span>`;
      }
      if (g.key === "asm" && ends.asm) return html`<span class="muted">until ${hmShort(ends.asm)}</span>`;
      return "";
    };
    const barHtml = (g, l, lane) => {
      const pi = info[l.empId], nm = pi ? pi.first : first(M.nameOf(P, l.empId));
      const cut = pi && pi.state === "gone" && pi.outAt != null ? pi.outAt : null, noshow = pi && pi.state === "missing";
      const out = [];
      l.bars.forEach((x, i) => {
        let f = q(x.from), t = Math.max(q(x.to), f + 0.25);
        const parts = cut == null || t <= cut ? [[f, t, false]] : f >= cut ? [[f, t, true]] : [[f, q(cut), false], [q(cut), t, true]].filter(p => p[1] > p[0]);
        for (const [pf, pt, gone] of parts) {
          if (x.brk) { out.push(html`<i class="tl-brk" style="left:${pct(pf)};width:${wid(pf, pt)};top:${lane * 32 + 6}px" title="${nm}: break ${fmtClock(x.from)}–${fmtClock(x.to)}"></i>`); continue; }
          const label = nm;
          const tip = `${pi?.name || nm}: ${g.label} ${fmtClock(x.from)}–${fmtClock(x.to)}${x.ot ? " (overtime)" : ""}${gone ? ` — clocked out ${fmtClock(cut)}` : noshow ? " — not clocked in" : x.idle ? " — nothing to do" : ""}`;
          out.push(html`<button type="button" class="tl-bar ${x.ot ? "ot" : ""} ${gone ? "gone" : ""} ${noshow ? "noshow" : ""} ${x.idle ? "idle" : ""}" data-emp="${l.empId}" style="left:${pct(pf)};width:${wid(pf, pt)};top:${lane * 32 + 6}px;--c:${COLOR[g.key] || COLOR.ops}" title="${tip}" aria-label="${tip}">${label ? raw(html`<b>${label}</b>`) : ""}</button>`);
        }
      });
      return out.join("");
    };
    const last = rows.length - 1;
    el.innerHTML = html`<div class="tl" style="--hrs:${b - a}">
      <div class="tl-axis"><div class="tl-lab"></div><div class="tl-track">${raw(ticks.join(""))}</div></div>
      ${rows.map((g, gi) => {
        const free = g.codes.some(code => !st.crew[code].emp), lanes = Math.max(1, g.lanes.length), add = can && free && !reorder;
        const lab = html`<i class="sw" style="--c:${COLOR[g.key] || COLOR.ops}"></i><span class="tl-name"><b>${ROW_LABEL[g.key] || g.label}</b><small>${raw(statusOf(g))}</small></span>${add ? raw('<span class="tl-plus" aria-hidden="true">+</span>') : ""}`;
        return raw(html`<div class="tl-row ${g.key === "slb" ? "neck" : ""}" data-g="${g.key}">
          ${reorder ? raw(html`<div class="tl-lab">${raw(lab)}<span class="tl-ord"><button type="button" class="btn ghost small" data-up="${g.key}" aria-label="Move ${g.label} up" ${gi === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn ghost small" data-down="${g.key}" aria-label="Move ${g.label} down" ${gi === last ? "disabled" : ""}>↓</button></span></div>`)
            : add ? raw(html`<button type="button" class="tl-lab" data-add="${g.key}" aria-label="Add someone to ${g.label}">${raw(lab)}</button>`) : raw(html`<div class="tl-lab">${raw(lab)}</div>`)}
          <div class="tl-track" style="height:${lanes * 32}px">${g.lanes.length ? raw(g.lanes.map((l, i) => barHtml(g, l, i)).join("")) : raw('<span class="tl-none">No one</span>')}${raw(nowLine)}</div>
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
      ${can ? raw('<button class="linkish" id="pl-away-btn">Out, late or hard stop…</button>') : ""}<a class="linkish" href="#/team">Team</a>`;
    el.querySelector("#pl-away-btn")?.addEventListener("click", () => awayDialog(makeP()));
  }

  // ---- move a person: where, from when, and what changes
  function timeChoices(P, startH) {
    if (P.isToday && P.now != null) { const n = Math.ceil(P.now * 12) / 12; return [["Now", hhmm(n)], ...[0.5, 1, 2].map(d => { const t = Math.ceil((P.now + d) * 2) / 2; return [hm(t), hhmm(t)]; })]; }
    return [["All day", hhmm(startH)], ...[9, 10.5, 12].filter(t => t > startH + 0.25).map(t => [hm(t), hhmm(t)])];
  }
  function personSheet(empId) {
    const X = st.X, P = X.P, code = Object.keys(st.crew).find(k => st.crew[k].emp === empId); if (!code) return;
    const pi = personInfo(X, code), e = people.find(p => p.id === empId), groups = M.boardGroups(POS, order()).filter(g => g.key !== "ops" || g.codes.includes(code));
    const curKey = groupOf(POS.find(p => p.id === M.stationAt(st.crew[code], code, P.isToday && P.now != null ? P.now : pi.startH))?.type);
    const rankIn = g => Math.min(...g.codes.map(c => X.E.rankOf(e, c) || 99));
    const opts = groups.filter(g => g.key !== curKey).sort((a, b) => rankIn(a) - rankIn(b));
    const T = timeChoices(P, pi.startH);
    const state = { to: opts.find(g => rankIn(g) < 99)?.key || opts[0]?.key, at: T[0][1] };
    const stateTxt = pi.state === "gone" ? `Clocked out ${fmtClock(pi.outAt)} · gone for the day` : pi.state === "break" ? `On break since ${fmtClock(pi.outAt)}` : pi.state === "missing" ? "Not clocked in yet" : pi.state === "in" ? "On the clock" : `Planned ${fmtClock(pi.startH)}–${fmtClock(pi.end)}`;
    const dlg = openDialog({
      title: `Move ${pi.name}`, submitLabel: "Move",
      body: html`<p class="dlg-lead">Now on <b>${M.GROUP_LABEL[curKey] || ""}</b> · ${stateTxt}${pi.standing ? ` · must leave by ${fmtClock(parseTime(pi.standing))}` : ""}</p>
        <fieldset class="ms-opts"><legend>To</legend>${opts.map(g => raw(html`<label class="ms-opt"><input type="radio" name="to" value="${g.key}" ${g.key === state.to ? "checked" : ""}>
          <i class="sw" style="--c:${COLOR[g.key] || COLOR.ops}"></i><b>${g.label}</b><small>${rankIn(g) < 99 ? `trained · ${ORD(rankIn(g))}` : "not trained"}</small></label>`))}</fieldset>
        <fieldset class="ms-times"><legend>From</legend>${T.map(([l, v], i) => raw(html`<label class="ms-time"><input type="radio" name="at" value="${v}" ${i === 0 ? "checked" : ""}><span>${l}</span></label>`))}
          <label class="ms-time other"><span class="sr">Another time</span><input class="input" type="time" step="300" name="atx"></label></fieldset>
        <div class="ms-impact" id="ms-impact" aria-live="polite"></div>
        <div class="ms-more"><span class="muted small">Today only:</span>
          <button type="button" class="btn small ghost" data-act="home">Send home…</button><button type="button" class="btn small ghost" data-act="longer">Stay 1 hour longer</button>
          <button type="button" class="btn small ghost" data-act="off">Off the plan</button><button type="button" class="btn small ghost" data-act="away">Out, late or hard stop…</button></div>`,
      onOpen: (form, d) => {
        d.classList.add("sheet");
        const read = () => { state.to = form.to?.value || state.to; state.at = form.atx.value || form.at.value; };
        const show = () => {
          read(); const box = d.querySelector("#ms-impact");
          if (!state.to) { box.innerHTML = ""; return; }
          const crew = M.applyMove(st.crew, POS, empId, state.to, state.at), X2 = M.evaluate({ ...makeP(), crew });
          const live = P.isToday && P.now != null, L2 = live ? M.liveSuggestions(X2, new Set()) : null;
          const endOf = (XX, LL, k) => LL && LL.on ? LL.cats[k]?.etc : M.catEnds(XX.E, XX.R)[k];
          const all = (XX, LL) => LL && LL.on ? LL.fromNow.etc : XX.R.end;
          const rows = [];
          for (const k of [state.to, curKey].filter((k, i, a) => CATS.includes(k) && a.indexOf(k) === i)) {
            const a = endOf(X, st.L, k), b = endOf(X2, L2, k);
            if (a != null || b != null) rows.push([`${TILE[k]} done`, a, b]);
          }
          rows.push(["Everyone done", all(X, st.L), all(X2, L2)]);
          box.innerHTML = html`<b>What changes</b>${rows.map(([l, a, b]) => raw(html`<div><span>${l}</span><span class="${b != null && a != null ? (b < a - 0.05 ? "good-txt" : b > a + 0.05 ? "warn-txt" : "") : ""}">${a != null ? hm(a) : "—"} → ${b != null ? hm(b) : "—"}</span></div>`))}`;
        };
        form.addEventListener("change", show); show();
        d.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => {
          const act = b.dataset.act; d.close();
          if (act === "home") return homeSheet(code);
          if (act === "longer") return edit(() => { st.crew[code] = { ...st.crew[code], hrs: Math.min(16, (+st.crew[code].hrs || 0) + 1), stop: "", source: "user" }; }, { msg: `${pi.first} stays an hour longer.` });
          if (act === "off") return edit(() => { st.crew[code] = { ...st.crew[code], emp: "", stop: "", moves: [], source: "" }; }, { msg: `${pi.first} is off the plan.` });
          if (act === "away") return awayDialog(makeP(), empId);
        }));
      },
      onSubmit: form => {
        const at = form.atx.value || form.at.value, to = form.to?.value;
        if (!to) throw new Error("Pick where they go.");
        edit(() => { st.crew = M.applyMove(st.crew, POS, empId, to, at); }, { msg: `${pi.first} → ${M.GROUP_LABEL[to]} ${parseTime(at) <= pi.startH + 1e-6 ? "for the day" : `at ${hm(parseTime(at))}`}. Publish when you're ready.` });
      },
    });
    return dlg;
  }
  function homeSheet(code) {
    const c = st.crew[code], P = makeP(), name = first(M.nameOf(P, c.emp));
    const n = P.isToday && P.now != null ? Math.ceil(P.now * 4) / 4 : (parseTime(c.start) ?? 7) + 4;
    openDialog({
      title: `Send ${name} home`, submitLabel: "Save",
      body: html`<p class="dlg-lead">For ${longDay(pick)} only. Their usual schedule is on Team.</p><label class="field"><span>Leaves at</span><input class="input" type="time" step="300" name="t" value="${hhmm(n)}" required></label>`,
      onOpen: (form, d) => d.classList.add("sheet"),
      onSubmit: form => { const t = form.t.value; if (!t) throw new Error("Pick a time."); edit(() => { st.crew[code] = { ...st.crew[code], stop: t, source: "user" }; }, { msg: `${name} goes home at ${fmtClock(parseTime(t))}.` }); },
    });
  }
  // ---- add someone to a station: people not on the plan first, then people moving over
  function addSheet(key) {
    const X = st.X, P = X.P, g = M.boardGroups(POS, order()).find(x => x.key === key); if (!g) return;
    const out = new Set((P.callouts || []).map(c => c.personId)), onCrew = new Map(Object.entries(st.crew).filter(([, c]) => c.emp).map(([code, c]) => [c.emp, code]));
    const rk = e => Math.min(...g.codes.map(c => X.E.rankOf(e, c) || 99));
    const brks = M.breaksOf(X.R);
    const list = people.filter(e => !out.has(e.id) && !g.codes.includes(onCrew.get(e.id)) && !(P.isToday && P.now != null && M.clockState(P, e.id, P.now, brks[e.id]) === "gone"))
      .sort((a, b) => (onCrew.has(a.id) - onCrew.has(b.id)) || rk(a) - rk(b) || a.name.localeCompare(b.name));
    if (!list.length) return toast("Everyone available is already here.", "warn");
    const T = timeChoices(P, parseTime(s.defStart) ?? 5);
    openDialog({
      title: `Add to ${g.label}`, submitLabel: "Add",
      body: html`<fieldset class="ms-opts"><legend>Who</legend>${list.map((e, i) => raw(html`<label class="ms-opt"><input type="radio" name="who" value="${e.id}" ${i === 0 ? "checked" : ""}>
          <b>${e.name}</b><small>${rk(e) < 99 ? `trained · ${ORD(rk(e))}` : "not trained"}${onCrew.has(e.id) ? ` · now on ${M.GROUP_LABEL[groupOf(POS.find(p => p.id === onCrew.get(e.id))?.type)] || ""}` : " · not on the plan"}</small></label>`))}</fieldset>
        <fieldset class="ms-times"><legend>From</legend>${T.map(([l, v], i) => raw(html`<label class="ms-time"><input type="radio" name="at" value="${v}" ${i === 0 ? "checked" : ""}><span>${l === "All day" ? "Their usual start" : l}</span></label>`))}</fieldset>`,
      onOpen: (form, d) => d.classList.add("sheet"),
      onSubmit: form => {
        const id = form.who.value, at = form.at.value; if (!id) throw new Error("Pick someone.");
        const e = people.find(p => p.id === id), name = first(e.name);
        if (onCrew.has(id)) { edit(() => { st.crew = M.applyMove(st.crew, POS, id, key, at); }, { msg: `${name} → ${g.label} at ${hm(parseTime(at))}.` }); return; }
        const spot = g.codes.find(c => !st.crew[c].emp); if (!spot) throw new Error(`Every ${g.label.toLowerCase()} spot is taken. Move someone off first.`);
        const usual = M.notBeforeLate(P, id, e.start || s.defStart);
        const start = P.isToday && P.now != null ? (at > usual ? at : usual) : (T[0][1] === at ? usual : at);
        edit(() => { st.crew[spot] = { emp: id, start, hrs: e.hours || s.fullDay, stop: "", source: "user", moves: [] }; }, { msg: `${name} on ${g.label} from ${fmtClock(parseTime(start))}.` });
      },
    });
  }
  // ---- re-plan from now: moves and fixes, checked ones applied together
  function replanSheet() {
    const X = st.X, L = st.L; if (!X || !L || !L.on) return toast(L?.why || "Re-planning starts once the day has started.", "warn");
    const moves = M.bottleneckMoves(X, L, { max: 2 });
    const items = [
      ...moves.map(m => ({ key: `move:${m.empId}:${m.at}`, title: `${m.name} → ${TILE[m.k].toLowerCase()} now`, text: `${TILE[m.k]} done ${hm(m.kBefore)} → ${hm(m.kAfter)}; everyone ${hm(m.endBefore)} → ${hm(m.endAfter)}.`, on: true, run: () => { st.crew = M.applyMove(st.crew, POS, m.empId, m.k, m.at); } })),
      ...L.list.map(x => ({ key: x.key, title: x.title, text: x.text, on: !x.key.startsWith("home:"), sugg: x, run: x.apply ? () => x.apply(st) : null })),
    ];
    const f = L.fromNow;
    openDialog({
      title: `Re-plan from ${fmtClock(X.P.now)}`, submitLabel: items.length ? "Apply and publish" : "Close",
      body: html`<div class="rp-sum"><div><b>${f.people}</b><span>working</span></div><div><b>${fmtN(f.left)}</b><span>pieces left</span></div><div><b class="${f.ot ? "warn-txt" : ""}">${f.etc != null ? hm(f.etc) : "—"}</b><span>done, as is</span></div></div>
        ${items.length ? raw(html`<fieldset class="ms-opts"><legend>Proposed</legend>${items.map((x, i) => raw(html`<label class="ms-opt rp"><input type="checkbox" name="i${i}" ${x.on ? "checked" : ""}><span><b>${x.title}</b><small>${x.text}</small></span></label>`))}</fieldset>`)
        : raw('<p class="muted">Nothing to change right now — the plan still works from here.</p>')}`,
      onOpen: (form, d) => d.classList.add("sheet"),
      onSubmit: async form => {
        if (!items.length) return;
        const chosen = items.filter((x, i) => form[`i${i}`]?.checked); if (!chosen.length) throw new Error("Tick at least one, or Cancel.");
        for (const x of chosen.filter(x => x.sugg?.act?.out)) {
          if (st.dirty) await save();
          const r = await api("/timeoff", { method: "POST", body: { personId: x.sugg.act.out, kind: "out", fromDay: pick, toDay: pick, note: "No clock-in" } });
          st.plan.callouts = [...(st.plan.callouts || []), { id: r.id, timeOff: true, personId: x.sugg.act.out, station: null, note: "No clock-in", fromDay: pick, toDay: pick }];
        }
        for (const x of chosen) if (x.sugg) hideSugg(x.sugg, "accept");
        edit(() => { for (const x of chosen) x.run && x.run(); }, { msg: `${chosen.length} ${chosen.length === 1 ? "change" : "changes"} made.` });
        setTimeout(publishDialog, 50);
      },
    });
  }
  function hideSugg(x, how) {
    st.plan.hidden = [...(st.plan.hidden || []), x.key];
    api("/events", { method: "POST", body: { day: pick, key: `${how}:${x.key}`, kind: "note", text: how === "accept" ? `Suggestion accepted: ${x.accept || x.title}` : `Suggestion dismissed: ${x.title}` } })
      .then(() => loadChanges()).catch(() => { /* still hidden on this PC */ });
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
        <div class="pub-sum"><div><b>${hm(X.R.end)}</b><span>everyone done</span></div><div><b>${people}</b><span>people</span></div><div><b>${X.R.otTotal > 0.04 ? fmtH(X.R.otTotal) : "None"}</b><span>overtime</span></div></div>
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
        <div class="ps-kpi"><span>Everyone done by <b>${fmtClock(R.end)}</b></span><span>${fmtN(CATS.reduce((t, k) => t + P.q[k], 0))} pieces</span>${R.otTotal > 0.04 ? raw(html`<span>${fmtH(R.otTotal)} overtime</span>`) : ""}${raw(money)}</div></header>
      <div class="ps-grid"><div class="ps-axis"><div>Person</div><div class="ps-ticks">${raw(ticks.join(""))}</div><div>Done</div></div>
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
