// Plan: pieces from SMRT, the crew on each station, the day simulated minute by minute, deadlines, checks, and publishing.
// Changes save on their own (a second PC that saved in between wins and this one is refreshed with its plan).
import { api } from "../api.js";
import { html, raw, ago, toast, openDialog, RANK } from "../ui.js";
import { CATS, CAT_FULL, CAT_LABEL, parseTime, hhmm, fmtClock, hm, fmtH, fmtN, fmt$, stepsOf, outInfo } from "../engine/engine.js";
import * as M from "../plan/model.js";

const TILE = { dct: "DC tops", dcb: "DC bottoms", slt: "Starch tops", slb: "Starch bottoms", comf: "Comforters", tc: "Tablecloths" };
const TYPE_DESC = { slt: "Starch tops press", slt2: "Helps on SLT 1", slb: "Starch bottoms press", dct: "Dry cleaning tops", dcb: "Dry cleaning bottoms", comf: "Comforters, trained people only", tc: "Tablecloths, trained people only", asm: "Inspect, assemble, bag", ops: "Runs the machines" };
const COLOR = { slt: "#4f8ff7", slt2: "#7aa9fa", slb: "#8b7cf6", dct: "#f59e4b", dcb: "#e2609b", asm: "#22c38e", ops: "#7c879c", comf: "#14b8a6", tc: "#c084fc", wash: "#5b6b84" };
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
  suggest: { title: "Suggest from history", body: `<p>Builds a whole crew for this day from what usually happens on this weekday:</p>
    <ul><li><b>Who:</b> people who worked at least half of the last 8 same weekdays (from Rippling; falls back to the last two weeks).</li>
    <li><b>When:</b> each person's usual clock-in for that weekday. Anyone marked late on Team starts at their late time.</li>
    <li><b>Where:</b> the stations they're usually on, balanced against where today's pieces are.</li>
    <li>People marked <b>out</b> on Team are left off.</li></ul>
    <p><b>It replaces the crew</b> for this day, including changes you made by hand. Undo (Ctrl+Z) brings the old crew back. Nothing reaches the floor until you Publish.</p>
    <p>Best for starting a day. To change one or two things, edit the crew directly.</p>` },
  undo: { title: "Undo", body: `<p>Takes back the last change to the crew or the piece counts on this screen (also Ctrl+Z). It goes back up to 60 steps, until you leave the Plan.</p>
    <p>It doesn't undo time off, call-outs or publishing.</p>` },
  print: { title: "Print", body: `<p>Prints the plan on one page: crew with times, each person's moves and breaks, and when each shuttle's pieces should be ready. Choose "Save as PDF" in the print window to keep a copy.</p>` },
  publish: { title: "Publish", body: `<p>Sends this plan to the <b>Floor</b> screens. Until you publish, the floor keeps showing the last published plan.</p>
    <p>You can keep changing the plan; a check reminds you when it has changed since it was published, so you can publish again.</p>` },
  live: { title: "Suggestions right now", body: `<p>On today's plan, the planner re-plans <b>the rest of the day from now</b> every minute, using:</p>
    <ul><li><b>Pieces still left</b> (SMRT, as pieces are assembled), including overdue work.</li>
    <li><b>Who's actually here</b> (Rippling clock-ins) and the hours each person has left.</li>
    <li>Time off and late arrivals from Team.</li></ul>
    <p>When something should change, it shows a suggestion: someone hasn't clocked in, someone clocked in who isn't planned, pieces that won't get done, or people who can go home early. The card only appears when there's a suggestion; click its title to collapse or open it. Whether each shuttle is on track is on the <b>Deadlines</b> card.</p>
    <p><b>Accept</b> makes the change to the plan (Undo works). <b>Dismiss</b> hides it for the rest of the day on every PC. Both are listed under Changes today. Publish afterwards so the floor sees it.</p>` },
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
  let AX = null, D = null, saveT = null, chgBusy = false; // timeline axis, the bar being dragged, the pending save, the changes list loading
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
        <div class="pv-board-head"><h2>Stations</h2><span class="muted small">${can ? "Tap a person to move them" : ""}</span></div>
        <div class="sb-grid" id="pl-board"></div>
        <div class="pv-away" id="pl-away"></div>
      </section>
      <section class="card pl-card"><details id="pl-day-box"><summary class="pl-cardhead"><div><h2>The day, minute by minute</h2><p>Each person's work and moves. ${can ? "On a computer, drag a bar sideways to change when that person starts." : ""}</p></div></summary><div id="pl-gantt"></div></details></section>
      <section class="card pl-card"><details id="pl-chg-box"><summary class="pl-cardhead"><div><h2>Changes today <span class="count soft" id="pl-chg-n"></span></h2><p>Who changed what, and the shuttle alerts.</p></div></summary><div id="pl-chg"></div></details></section>
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
    for (const [id, key, load] of [["pl-chg-box", "pl-chg-open", true], ["pl-day-box", "pl-day-open", false]]) {
      const box = main.querySelector("#" + id);
      box.open = store.get(key) === "1";
      box.addEventListener("toggle", () => { store.set(key, box.open ? "1" : "0"); if (box.open && load) loadChanges(); if (box.open && !load && st.X) drawGantt(st.X); });
    }
    if (can) {
      main.querySelector("#pl-undo").addEventListener("click", undo);
      main.querySelector("#pl-suggest").addEventListener("click", () => openDialog({
        title: "Suggest a crew from history?", submitLabel: "Replace the crew",
        body: html`<p class="dlg-lead">Replaces the crew for ${longDay(pick)} with the people who usually work ${M.WD[M.weekday(pick)]}s (Team's usual days count too), at their usual clock-in, on the stations they're usually on. You can undo it.</p>`,
        onSubmit: () => edit(() => suggest("button"), { keepNote: true }),
      }));
      main.querySelector("#pl-pub").addEventListener("click", publishDialog);
      main.querySelector("#pl-replan")?.addEventListener("click", replanSheet);
    }
    main.querySelector("#pl-board").addEventListener("click", ev => {
      const b = ev.target.closest("[data-emp],[data-add]"); if (!b || !can) return;
      if (b.dataset.add) addSheet(b.dataset.add); else personSheet(b.dataset.emp);
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
    el.innerHTML = html`<div class="banner info"><b>Suggested from history.</b> Who usually works ${M.WD[M.weekday(pick)]}s (from ${st.note.basis}), at their usual clock-in, on the stations they're usually on.${st.note.left.length ? ` Not placed: ${st.note.left.join(", ")}.` : ""}
      ${can && !st.rev ? raw(html` <button class="linkish" id="pl-keep">Keep this crew</button>`) : ""}</div>`;
    el.querySelector("#pl-keep")?.addEventListener("click", () => { st.dirty = true; save(); st.note = null; drawNote(); });
  }

  /** Runs the plan and redraws everything that depends on it. */
  function update() {
    if (!alive()) return;
    const X = st.X = M.evaluate(makeP());
    const L = st.L = X.P.isToday ? M.liveSuggestions(X, new Set(st.plan.hidden || [])) : null;
    drawNote(); drawStatus(X, L); drawNeck(X, L); drawWork(X, L); drawBoard(X, L); drawAway(X.P);
    if (document.getElementById("pl-day-box")?.open) drawGantt(X);
    drawPub(X); saveStatus();
  }

  // ---- one line: how the day goes (today: re-planned from now with who's here)
  function drawStatus(X, L) {
    const el = document.getElementById("pl-status"); if (!el) return;
    const P = X.P, tot = CATS.reduce((t, k) => t + (P.q[k] || 0), 0);
    let txt, cls = "";
    if (X.R.empty) txt = X.R.noCrew ? "No one is on a station yet — tap + Add on a station, or Suggest." : "Nothing to plan yet.";
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

  // ---- the bottleneck: starch bottoms (Neal: the main reason for the planner)
  function drawNeck(X, L) {
    const el = document.getElementById("pl-neck"); if (!el) return;
    const B = M.bottleneck(X, L);
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
    const P = X.P, D = P.dp.D, live = P.isToday && L && L.on && L.cats, ends = M.catEnds(X.E, X.R), neck = M.bottleneck(X, L)?.k;
    const cells = CATS.filter(k => k !== neck && (P.q[k] || 0) > 0.5).map(k => {
      const left = live ? Math.round(L.cats[k].left) : Math.round(P.q[k]), etc = live ? L.cats[k].etc : ends[k], ot = live ? L.cats[k].ot : M.catOvertime(X.E, X.R, k);
      const over = st.overrides[k] != null;
      const line = left <= 0 ? raw('<span class="good-txt">done</span>') : raw(html`<span class="${ot ? "bad-txt" : live ? "warn-txt" : ""}">${fmtN(left)}${etc != null ? ` by ${hmShort(etc)}` : ""}</span>`);
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
  function drawBoard(X, L) {
    const el = document.getElementById("pl-board"); if (!el) return;
    const P = X.P, groups = M.boardGroups(POS), ends = M.catEnds(X.E, X.R), live = P.isToday && L && L.on && L.cats;
    const typeOf = code => groupOf(POS.find(p => p.id === code)?.type);
    const html2 = groups.map(g => {
      const mine = g.codes.map(code => personInfo(X, code)).filter(Boolean);
      const incoming = Object.keys(st.crew).filter(code => !g.codes.includes(code)).map(code => personInfo(X, code)).filter(Boolean)
        .flatMap(pi => pi.moves.filter(m => typeOf(m.to) === g.key).map(m => ({ ...pi, at: m.at })));
      const k = g.cat || (g.key === "asm" ? "asm" : null);
      let status = "";
      if (k && k !== "asm" && (P.q[k] || 0) > 0.5) {
        const left = live ? Math.round(L.cats[k].left) : Math.round(P.q[k]), etc = live ? L.cats[k].etc : ends[k], ot = live ? L.cats[k].ot : M.catOvertime(X.E, X.R, k);
        status = left <= 0 ? html`<span class="good-txt">done</span>` : html`<span class="${ot ? "bad-txt" : "good-txt"}">${fmtN(left)} · ${etc != null ? `done ${hm(etc)}` : "no one on it"}</span>`;
      } else if (k === "asm" && ends.asm) status = html`<span class="muted">done ${hm(ends.asm)}</span>`;
      const chip = pi => {
        const times = pi.state === "gone" ? `out ${fmtClock(pi.outAt)}` : pi.state === "break" ? "on break" : pi.state === "missing" ? "not clocked in" : `${hmShort(pi.startH)}–${hmShort(pi.end)}`;
        return html`<button type="button" class="pchip ${pi.state}" data-emp="${pi.id}" aria-label="${pi.name}, ${times}"><i class="pc-dot" aria-hidden="true"></i><b>${pi.first}</b><span>${times}</span>${pi.standing ? raw('<em title="Standing must-leave-by on Team">⏱</em>') : ""}</button>`;
      };
      const moveLines = mine.flatMap(pi => pi.moves.filter(m => typeOf(m.to) !== g.key).map(m => html`<li><time>${hmShort(parseTime(m.at))}</time> ${pi.first} → ${M.GROUP_LABEL[typeOf(m.to)] || m.to}</li>`));
      const free = g.codes.some(code => !st.crew[code].emp);
      return html`<article class="sb ${g.key === "slb" ? "neck" : ""}" data-g="${g.key}">
        <header><i class="sw" style="--c:${COLOR[g.key] || COLOR.ops}"></i><h3>${g.label}</h3><span class="sb-st">${raw(status)}</span></header>
        <div class="sb-people">${mine.map(pi => raw(chip(pi)))}${incoming.map(pi => raw(html`<button type="button" class="pchip incoming" data-emp="${pi.id}"><b>${pi.first}</b><span>from ${hmShort(parseTime(pi.at))}</span></button>`))}
          ${can && free ? raw(html`<button type="button" class="pchip add" data-add="${g.key}" aria-label="Add someone to ${g.label}">+ Add</button>`) : ""}
          ${!mine.length && !incoming.length && !can ? raw('<span class="muted small">No one</span>') : ""}</div>
        ${moveLines.length ? raw(html`<ul class="sb-moves">${moveLines.map(x => raw(x))}</ul>`) : ""}
      </article>`;
    });
    el.innerHTML = html2.join("");
  }
  function drawAway(P) {
    const el = document.getElementById("pl-away"); if (!el) return;
    const out = P.callouts || [], late = P.late || [];
    el.innerHTML = html`${out.length ? raw(html`<span>Out: ${out.map(c => M.nameOf(P, c.personId)).join(", ")}</span>`) : ""}
      ${late.length ? raw(html`<span>In late: ${late.map(l => `${M.nameOf(P, l.personId)} ${fmtClock(parseTime(l.at))}`).join(", ")}</span>`) : ""}
      ${can ? raw('<button class="linkish" id="pl-away-btn">Out or late…</button>') : ""}<a class="linkish" href="#/team">Team</a>`;
    el.querySelector("#pl-away-btn")?.addEventListener("click", () => awayDialog(makeP()));
  }

  // ---- move a person: where, from when, and what changes
  function timeChoices(P, startH) {
    if (P.isToday && P.now != null) { const n = Math.ceil(P.now * 12) / 12; return [["Now", hhmm(n)], ...[0.5, 1, 2].map(d => { const t = Math.ceil((P.now + d) * 2) / 2; return [hm(t), hhmm(t)]; })]; }
    return [["All day", hhmm(startH)], ...[9, 10.5, 12].filter(t => t > startH + 0.25).map(t => [hm(t), hhmm(t)])];
  }
  function personSheet(empId) {
    const X = st.X, P = X.P, code = Object.keys(st.crew).find(k => st.crew[k].emp === empId); if (!code) return;
    const pi = personInfo(X, code), e = people.find(p => p.id === empId), groups = M.boardGroups(POS).filter(g => g.key !== "ops" || g.codes.includes(code));
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
          <button type="button" class="btn small ghost" data-act="off">Off the plan</button><button type="button" class="btn small ghost" data-act="away">Out or late…</button></div>`,
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
    const X = st.X, P = X.P, g = M.boardGroups(POS).find(x => x.key === key); if (!g) return;
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
      title: fixedId ? `${M.nameOf(P, fixedId)}: out or late?` : "Who's out or late?", submitLabel: "Save",
      body: html`<p class="dlg-lead">For ${longDay(pick)}. Out takes them off the plan; late keeps them on but they don't start before their time. For other days or several days, use Team › Time off.</p>
        <label class="field"><span>Person</span><select class="input" name="who" required ${fixedId ? "disabled" : ""}><option value="">— Pick someone —</option>
          ${list.map(e => raw(html`<option value="${e.id}" ${e.id === fixedId ? "selected" : ""}>${e.name}${stOf[e.id] ? ` · on ${label(stOf[e.id])}` : ""}</option>`))}</select></label>
        <div class="field"><span>What</span><div class="kindrow"><label><input type="radio" name="kind" value="out" checked> Out today</label><label><input type="radio" name="kind" value="late"> In late at</label>
          <input class="input" type="time" step="300" name="at" aria-label="Arrival time"></div></div>
        <label class="field"><span>Note <em>(optional)</em></span><input class="input" name="note" maxlength="300" placeholder="Sick, appointment, no call…"></label>`,
      onSubmit: async form => {
        const id = fixedId || form.who.value; if (!id) throw new Error("Pick who it is.");
        const kind = form.kind.value, at = form.at.value;
        if (kind === "late" && !at) throw new Error("Pick the time they'll come in.");
        const code = stOf[id] || null, name = M.nameOf(makeP(), id), note = form.note.value || null;
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

  // ---- the day, minute by minute
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
      const att = row.staffed ? M.attendanceOf(P, st.crew[p.id].emp, st.crew[p.id].start) : null, gone = att && att.state === "missing";
      let bars = "";
      if (row.staffed) {
        const steps = stepsOf(row), b0 = row.brkTaken > 0 ? row.brkS : null, b1 = b0 != null ? row.brkS + row.brkTaken : null;
        if (!steps.length) bars += html`<div class="gb idle" data-code="${p.id}" style="left:${pct(row.x.start)};width:${wid(row.x.start, Math.max(row.clockOut, row.x.start + 0.5))}" title="${name}: not needed">${first(name)} <small>not needed</small></div>`;
        steps.forEach((sp, i) => {
          const ot = sp.to > row.x.schedEnd + 0.02, col = COLOR[sp.stn === "comf" ? "comf" : E.TYPE_OF[sp.stn]] || COLOR.ops;
          const label = i === 0 ? html`${first(name)} <small>${gone ? "not clocked in" : `${hm(row.x.start)}–${hm(row.clockOut)}`}</small>` : html`→ ${lbl(sp.stn)}`;
          let parts = [[sp.from, sp.to]];
          if (b0 != null && b1 > sp.from + 0.01 && b0 < sp.to - 0.01) parts = [[sp.from, b0], [b1, sp.to]].filter(x => x[1] - x[0] > 0.01);
          const big = parts.reduce((m, x, j) => x[1] - x[0] > parts[m][1] - parts[m][0] ? j : m, 0);
          parts.forEach((x, j) => { bars += html`<div class="gb ${ot ? "ot" : ""} ${gone ? "noshow" : ""}" data-code="${p.id}" style="left:${pct(x[0])};width:${wid(x[0], x[1])};--c:${col}" title="${name}: ${lbl(sp.stn)} ${fmtClock(sp.from)}–${fmtClock(sp.to)}${ot ? " (overtime)" : ""}${gone ? " — planned; not clocked in" : ""}">${j === big ? raw(label) : ""}</div>`; });
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
      <div class="g-legend"><span><i class="k-dl"></i>shuttle must be ready</span><span><i class="k-win"></i>finish window (${s.spread} min)</span><span><i class="k-brk"></i>break</span><span><i class="k-ot"></i>overtime</span>${P.isToday ? raw('<span><i class="k-noshow"></i>planned, not clocked in</span>') : ""}</div>`;
  }
  // drag a bar to move that person's planned start, in 5-minute steps
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
      edit(() => { st.crew[d.code] = { ...st.crew[d.code], start: hhmm(t), source: "user" }; }, { msg: `${first(M.nameOf(makeP(), st.crew[d.code].emp))} starts at ${fmtClock(t)}` });
    } else main.querySelectorAll(`.gb[data-code="${d.code}"]`).forEach(x => { x.style.transform = ""; });
  };
  main.addEventListener("pointerup", dragEnd, on); main.addEventListener("pointercancel", dragEnd, on);

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
    const a = Math.floor(Math.min(...rows.map(r => r.start))), b = Math.ceil(Math.max(...rows.map(r => r.done), ...X.waves.filter(w => w.deadline != null && w.deadline < 24).map(w => w.deadline)));
    const pct = h => ((h - a) / (b - a) * 100).toFixed(2) + "%", wid = (p, q) => ((q - p) / (b - a) * 100).toFixed(2) + "%";
    const lbl = c => c === "comf" ? "Comforters" : c === "slo" ? "Laundry operator" : c === "dco" ? "DC operator" : POS.find(p => p.id === c)?.label || c;
    const col = c => c === "comf" ? COLOR.comf : COLOR[E.TYPE_OF[c]] || COLOR.ops;
    const ticks = [], hrs = []; for (let t = a; t <= b; t++) { ticks.push(html`<span style="left:${pct(t)}">${hm(t)}</span>`); hrs.push(`<i class="ps-hr" style="left:${pct(t)}"></i>`); }
    const W = X.waves.filter(w => (w.kind === "shuttle" || w.kind === "counter") && w.todo > 0 && w.deadline != null && w.deadline < 24);
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
