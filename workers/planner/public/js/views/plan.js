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

  // ------------------------------------------------------------ the page
  function drawPage() {
    const P = makeP();
    main.innerHTML = html`<div id="pl-root">
      <div class="plan-bar plan-head">
        <h1 class="sr">Plan</h1>
        <div class="seg" role="tablist" aria-label="Day">${days().map(d => raw(html`<button role="tab" aria-selected="${d === pick}" data-day="${d}">${fmtDay(d, st.V.today)}</button>`))}
          ${days().includes(pick) ? "" : raw(html`<button role="tab" aria-selected="true" data-day="${pick}" class="custom">${fmtDay(pick, st.V.today)}</button>`)}</div>
        <label class="date-pick" title="Plan another day"><span class="sr">Plan another day</span><input class="input" type="date" id="pl-date" value="${pick}"></label>
        <span id="pl-pill"></span>
        <div class="head-actions">
          <span class="saved-note" id="pl-save" aria-live="polite"></span>
          ${can ? raw(html`<button class="btn ghost small" id="pl-undo" title="Undo (Ctrl+Z)" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>Undo</button>
            <span class="hbtn"><button class="btn small" id="pl-suggest" title="Who usually works this weekday, on their usual stations">Suggest from history</button>${raw(helpBtn("suggest"))}</span>`) : ""}
          <span class="hbtn"><button class="btn small" id="pl-print" title="Print the plan, or save it as a PDF"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/></svg>Print</button>${raw(helpBtn("print"))}</span>
          ${can ? raw(html`<span class="hbtn"><button class="btn primary small" id="pl-pub"></button>${raw(helpBtn("publish"))}</span>`) : ""}
        </div>
      </div>
      ${isPast() ? raw(html`<div class="banner info"><b>This day is over.</b> The plan is shown as it was saved (read-only). <a href="#/review?day=${pick}">See how it went in Review</a>.</div>`) : ""}
      <div id="pl-note"></div>
      <section class="verdict" id="pl-verdict" aria-live="polite"></section>
      <section class="card pl-card live-card" id="pl-live" hidden></section>
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
          <section class="card pl-card" id="pl-wash-card"><header class="pl-cardhead"><div><h2>Washers</h2><p>Each load in order, on whichever washer frees up first.</p></div></header><div id="pl-wash"></div></section>
          <section class="card pl-card"><details id="pl-chg-box"><summary class="pl-cardhead"><div><h2>Changes today <span class="count soft" id="pl-chg-n"></span></h2><p>Who changed what, and the shuttle alerts.</p></div></summary><div id="pl-chg"></div></details></section>
        </aside>
      </div>
      <div id="pl-orders"></div>
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
        title: "Suggest a crew from history?", submitLabel: "Replace the crew",
        body: html`<p class="dlg-lead">Replaces the crew for ${longDay(pick)} with the people who usually work ${M.WD[M.weekday(pick)]}s, at their usual clock-in, on the stations they're usually on. You can undo it.</p>`,
        onSubmit: () => edit(() => suggest("button"), { keepNote: true }),
      }));
      main.querySelector("#pl-pub").addEventListener("click", publishDialog);
    }
    drawHeadPill(); drawOrders(); update({ table: true });
  }

  function drawHeadPill() {
    const el = document.getElementById("pl-pill"); if (!el) return;
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

  /** Runs the plan and redraws everything that depends on it. The crew table is only rebuilt when asked, so typing isn't interrupted. */
  function update({ table }) {
    if (!alive()) return;
    const X = st.X = M.evaluate(makeP());
    const L = X.P.isToday ? M.liveSuggestions(X, new Set(st.plan.hidden || [])) : null;
    drawNote(); drawVerdict(X); drawLive(X, L); drawTiles(X, L); drawChecks(X); drawWaves(X); drawGantt(X); drawWash(X); if (admin) drawMoney(X);
    if (table) drawCrew(X); else crewOutcomes(X);
    drawPub(X); saveStatus();
  }

  // ---- suggestions during the day (re-planned from now, every minute)
  function drawLive(X, L) {
    const el = document.getElementById("pl-live"); if (!el) return;
    if (!X.P.isToday || !L) { el.hidden = true; return; }
    // only when there's something to suggest (Neal, Oct 13); open or collapsed is remembered on this PC
    if (!(L.on && L.list.length)) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const f = L.fromNow, nowTxt = fmtClock(X.P.now), open = store.get("pl-live-open") !== "0";
    el.innerHTML = html`<details id="pl-live-box" ${open ? "open" : ""}><summary class="pl-cardhead"><div><h2>Suggestions right now <span class="count soft">${L.list.length}</span> ${raw(helpBtn("live"))}</h2>
        <p>From ${nowTxt}: <b>${fmtN(f.left)}</b> pieces left, ${f.people} ${f.people === 1 ? "person" : "people"} working${f.end != null && f.left ? raw(html`, done about <b>${hm(f.end)}</b>`) : ""}${f.short > 0.5 ? raw(html` · <span class="bad-txt">${fmtN(f.short)} won't get done</span>`) : ""}.</p></div></summary>
      <ul class="sugg">${L.list.map((x, i) => raw(html`<li class="chk ${x.cls}"><i aria-hidden="true"></i><div><b>${x.title}</b><p>${x.text}</p>
          ${can ? raw(html`<div class="fx">${x.accept && (x.apply || x.act) ? raw(html`<button class="btn small primary" data-acc="${i}">${x.accept}</button>`) : ""}<button class="btn small ghost" data-dis="${i}">Dismiss</button></div>`) : ""}</div></li>`))}</ul></details>`;
    const box = el.querySelector("#pl-live-box");
    box.addEventListener("toggle", () => store.set("pl-live-open", box.open ? "1" : "0"));
    el.querySelector("[data-help]")?.addEventListener("click", ev => { ev.preventDefault(); ev.stopPropagation(); showHelp("live"); });
    el.querySelectorAll("[data-acc]").forEach(b => b.addEventListener("click", async () => {
      const x = L.list[+b.dataset.acc]; b.disabled = true;
      try {
        if (x.act?.out) {
          if (st.dirty) await save();
          const r = await api("/timeoff", { method: "POST", body: { personId: x.act.out, kind: "out", fromDay: pick, toDay: pick, note: "No clock-in" } });
          st.plan.callouts = [...(st.plan.callouts || []), { id: r.id, timeOff: true, personId: x.act.out, station: null, note: "No clock-in", fromDay: pick, toDay: pick }];
        }
        hideSugg(x, "accept");
        if (x.apply) edit(() => x.apply(st), { msg: `${x.accept}. Publish when you're ready.` }); else update({ table: true });
      } catch (e) { b.disabled = false; toast(e.message, "bad"); }
    }));
    el.querySelectorAll("[data-dis]").forEach(b => b.addEventListener("click", () => { hideSugg(L.list[+b.dataset.dis], "dismiss"); update({ table: false }); }));
  }
  function hideSugg(x, how) {
    st.plan.hidden = [...(st.plan.hidden || []), x.key];
    api("/events", { method: "POST", body: { day: pick, key: `${how}:${x.key}`, kind: "note", text: how === "accept" ? `Suggestion accepted: ${x.accept}` : `Suggestion dismissed: ${x.title}` } })
      .then(() => loadChanges()).catch(() => { /* still hidden on this PC */ });
  }
  function showHelp(id) {
    const h = HELP[id]; if (!h) return;
    openDialog({ title: h.title, body: h.body.replace("${FULL}", fmtH(s.fullDay)), submitLabel: "Got it", onOpen: (form, dlg) => { dlg.querySelector("[data-close]").hidden = true; dlg.classList.add("help-dlg"); }, onSubmit: () => {} });
  }

  function drawVerdict(X) {
    const v = X.verdict, el = document.getElementById("pl-verdict");
    el.className = `verdict ${v.cls}`;
    el.innerHTML = html`<div class="v-head"><span class="v-ico" aria-hidden="true">${v.cls === "ok" ? "✓" : v.cls === "idle" ? "…" : "!"}</span><b>${v.head}</b></div>
      <div class="v-kpis">${v.kpis.map(k => raw(html`<div class="v-k"><b class="${k.cls || ""}">${k.v}</b><span>${k.l}</span></div>`))}</div>`;
  }

  // today: "185 done in 6.2 hrs" and "120 left · ETC 2:35 PM" (hours from the plan's station times so far; ETC from the re-plan from now)
  function tileLive(k, done, L) {
    const c = L && L.on && L.cats && L.cats[k]; if (!c) return "";
    const hrs = c.hrsSoFar >= 0.05 ? ` in ${c.hrsSoFar.toFixed(1)} hrs` : "";
    const left = Math.round(c.left);
    const etc = left > 0 && c.etc != null ? ` · ETC ${hm(c.etc)}` : "";
    return { done: hrs, left: left > 0 ? `<span class="t-sub t-left">${fmtN(left)} left${etc}</span>` : "" };
  }
  function totalHrs(L) { if (!L?.on || !L.cats) return ""; const h = CATS.reduce((t, k) => t + L.cats[k].hrsSoFar, 0); return h >= 0.05 ? ` in ${h.toFixed(1)} hrs` : ""; }
  function totalLeft(L) {
    if (!L?.on || !L.fromNow) return ""; const f = L.fromNow, n = Math.round(f.left); if (n <= 0) return "";
    return html`<span class="t-sub t-left">${fmtN(n)} left${f.etc != null ? ` · ETC ${hm(f.etc)}` : ""}</span>`;
  }
  function drawTiles(X, L) {
    const P = X.P, D = P.dp.D, el = document.getElementById("pl-tiles");
    el.innerHTML = CATS.map(k => {
      const over = st.overrides[k] != null, smrt = P.dp.base[k], v = P.q[k];
      const done = P.isToday ? D.done[k] : 0;
      const lv = P.isToday ? tileLive(k, done, L) : "";
      const sub = over ? `typed · SMRT says ${fmtN(smrt)}` : P.isToday ? `${fmtN(done)} done${lv.done || ""}` : P.dp.expected && D.expected[k] > D.q[k] ? `expected · ${fmtN(D.q[k])} in so far` : "due";
      return html`<${can ? "button" : "div"} class="tile ${v ? "" : "zero"} ${over ? "typed" : ""}" ${can ? raw(`type="button" data-cat="${k}" title="Change the number to plan with.${P.isToday ? " Hours: time the plan has had people on this work so far today. ETC: when it should be finished, re-planned from now with who's here." : ""}"`) : ""}>
        <span class="t-label"><i class="sw" style="--c:${CAT_COLOR[k]}"></i>${TILE[k]}</span><b class="t-num">${fmtN(v)}</b><span class="t-sub">${sub}</span>${raw(lv && lv.left || "")}
        ${P.isToday && v ? raw(html`<span class="bar" aria-hidden="true"><i style="width:${Math.min(100, Math.round(done / v * 100))}%"></i></span>`) : ""}</${can ? "button" : "div"}>`;
    }).join("") + html`<div class="tile total"><span class="t-label">All pieces</span><b class="t-num">${P.expected ? "~" : ""}${fmtN(CATS.reduce((t, k) => t + P.q[k], 0))}</b>
      <span class="t-sub">${P.isToday ? `${fmtN(D.doneTotal)} done${totalHrs(L)} · ${fmtN(D.orders)} orders` : `${fmtN(D.orders)} orders so far`}</span>${raw(P.isToday ? totalLeft(L) : "")}</div>`;
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
    const out = new Set((P.callouts || []).map(c => c.personId)), late = M.lateOf(P);
    const cur = st.crew[code].emp, label = c => POS.find(p => p.id === c)?.label || c;
    const trained = people.filter(e => E.rankOf(e, code)).sort((a, b) => E.rankOf(a, code) - E.rankOf(b, code) || a.name.localeCompare(b.name));
    const other = people.filter(e => !E.rankOf(e, code)).sort((a, b) => a.name.localeCompare(b.name));
    const opt = (e, rk) => html`<option value="${e.id}" ${e.id === cur ? "selected" : ""}>${e.name}${rk ? ` · ${ORD(rk)}` : ""}${used[e.id] && used[e.id] !== code ? ` · on ${label(used[e.id])}` : ""}${out.has(e.id) ? " · OUT" : late[e.id] ? ` · in at ${fmtClock(parseTime(late[e.id]))}` : ""}</option>`;
    const curGone = cur && !people.some(e => e.id === cur);
    return html`<option value="">— Nobody —</option>${curGone ? raw(html`<option value="${cur}" selected>${M.nameOf({ people: [] }, cur)} (not on the team list)</option>`) : ""}
      ${trained.length ? raw(html`<optgroup label="Trained · best first">${trained.map(e => raw(opt(e, E.rankOf(e, code))))}</optgroup>`) : ""}
      ${other.length ? raw(html`<optgroup label="Not trained here">${other.map(e => raw(opt(e, 0)))}</optgroup>`) : ""}`;
  }
  // under the person's name: what the time clock says, never the plan (the plan's start is in its own column)
  function attLine(P, c) {
    const a = c.emp ? M.attendanceOf(P, c.emp, c.start) : null;
    if (!a) return "";
    if (a.state === "in") return html`<small class="${a.lateMin ? "warn-txt" : "good-txt"}">Clocked in ${fmtClock(a.inAt)}${a.lateMin ? ` · ${a.lateMin} min late` : ""}</small>`;
    if (a.state === "missing") return html`<small class="bad-txt">Not clocked in · due ${fmtClock(a.due)}</small>`;
    return a.due > P.now ? html`<small class="muted">Not in yet · starts ${fmtClock(a.due)}</small>` : html`<small class="muted">Not clocked in yet</small>`;
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
          ${c.emp && !rk ? raw('<small class="warn-txt">Not trained here</small>') : raw(attLine(P, c))}</label>
        <label class="cr-f"><span>Planned start</span><input class="input" type="time" step="300" id="start-${p.id}" data-f="start" value="${c.start}" ${c.emp ? "" : "disabled"} ${dis}></label>
        <label class="cr-f"><span>Hours</span><input class="input" type="number" min="0" max="16" step="0.25" id="hrs-${p.id}" data-f="hrs" value="${c.hrs}" ${c.emp ? "" : "disabled"} ${dis}></label>
        <label class="cr-f"><span>Hard stop</span><input class="input" type="time" step="300" id="stop-${p.id}" data-f="stop" value="${c.stop || ""}" ${c.emp ? "" : "disabled"} ${dis}></label>
        <div class="cr-out" id="out-${p.id}"></div>
        <div class="cr-act">${can && c.emp ? raw(html`<button class="icon-btn" data-out="${p.id}" title="${first(M.nameOf(P, c.emp))} out or late" aria-label="${M.nameOf(P, c.emp)} out or late"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="3.2"/><path d="M4 19c.6-3.2 2.9-5 6-5 1.4 0 2.6.4 3.6 1"/><path d="m16 15 5 5m0-5-5 5"/></svg></button>`) : ""}</div>
      </div>`;
    };
    const asOf = P.isToday ? (P.clockAsOf ? `Time clock (Rippling) as of ${new Date(P.clockAsOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. Start and end times below are the plan.` : "No time clock report from Rippling yet today. Start and end times below are the plan.") : "";
    el.innerHTML = html`${asOf ? raw(html`<p class="cr-asof muted small">${asOf}</p>`) : ""}<div class="cr-head" aria-hidden="true"><span>Station</span><span>Person</span><span>Planned start</span><span>Hours</span><span>Hard stop</span><span>Planned end</span><span></span></div>
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
      let start = c.emp ? c.start : clock[id] || M.notBeforeLate(makeP(), id, e?.start || s.defStart), hrs = c.emp ? c.hrs : s.fullDay, stop = c.emp ? c.stop : "";
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
    el.innerHTML = html`<div class="callouts">${can ? raw('<button class="btn small" id="pl-callout-any" title="Mark someone out or coming in late for this day">Out or late</button>') : ""}
      ${list.length ? raw(html`<span>Out:</span>${list.map(c => raw(html`<span class="chip off" title="${c.note || ""}">${M.nameOf(P, c.personId)}${c.station ? ` · ${POS.find(p => p.id === c.station)?.label || ""}` : ""}${can ? raw(html`<button class="x" data-unout="${c.id}" data-kind="${c.timeOff ? "t" : "c"}" aria-label="Undo: ${M.nameOf(P, c.personId)} is not out" title="Not out after all (doesn't put them back on a station)">×</button>`) : ""}</span>`))}`) : ""}
      ${(P.late || []).length ? raw(html`<span>In late:</span>${P.late.map(l => raw(html`<span class="chip late" title="${l.note || ""}">${M.nameOf(P, l.personId)} · ${fmtClock(parseTime(l.at))}${can ? raw(html`<button class="x" data-unlate="${l.id}" aria-label="Undo late arrival for ${M.nameOf(P, l.personId)}">×</button>`) : ""}</span>`))}`) : ""}
      <a class="linkish small" href="#/team">Time off on Team</a></div>`;
    document.getElementById("pl-callout-any")?.addEventListener("click", () => calloutAnyDialog(P));
    el.querySelectorAll("[data-unout]").forEach(b => b.addEventListener("click", async () => {
      const c = st.plan.callouts.find(x => x.id === b.dataset.unout);
      if (c?.timeOff && c.fromDay !== c.toDay && !confirm(`${M.nameOf(P, c.personId)} is out ${c.fromDay} to ${c.toDay}. Remove the whole time off? (To change only some days, use the Team screen.)`)) return;
      await api(b.dataset.kind === "t" ? `/timeoff/${b.dataset.unout}` : `/plan/${pick}/callouts/${b.dataset.unout}`, { method: "DELETE" });
      st.plan.callouts = st.plan.callouts.filter(c => c.id !== b.dataset.unout); update({ table: true });
    }));
    el.querySelectorAll("[data-unlate]").forEach(b => b.addEventListener("click", async () => {
      await api(`/timeoff/${b.dataset.unlate}`, { method: "DELETE" });
      st.plan.late = (st.plan.late || []).filter(l => l.id !== b.dataset.unlate); update({ table: true });
    }));
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
  const calloutAnyDialog = P => awayDialog(P);
  const calloutDialog = code => awayDialog(makeP(), st.crew[code].emp);

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
        ${P.isToday ? raw(waveProgress(w)) : ""}
      </div>`;
    }).join("") + html`<div class="mix-key">${CATS.map(k => raw(html`<span><i style="background:${CAT_COLOR[k]}"></i>${CAT_LABEL[k]}</span>`))}</div>`;
  }

  // today: what's assembled so far (SMRT), the pace in the last hour, and what's left by kind of work
  function waveProgress(w) {
    const over = w.kind === "overdue";
    const left = Object.fromEntries(CATS.map(k => [k, over ? (w.q[k] || 0) : Math.max(0, (w.q[k] || 0) - (w.doneQ?.[k] || 0))]));
    const nLeft = CATS.reduce((t, k) => t + left[k], 0), done = over ? 0 : Math.min(w.todo, w.done || 0);
    const leftTxt = CATS.filter(k => left[k] > 0).sort((a, b) => left[b] - left[a]).map(k => raw(html`<span class="wl-cat"><i style="background:${CAT_COLOR[k]}"></i><b>${fmtN(left[k])}</b> ${TILE[k]}</span>`));
    const pace = !over && (w.recent || w.lastAsm) ? html`${w.recent ? `${fmtN(w.recent)} assembled in the last hour` : "none assembled in the last hour"}${w.lastAsm ? ` · last at ${fmtClock(clockOf(w.lastAsm))}` : ""}` : "";
    return html`<div class="wv-prog">
      ${over ? "" : raw(html`<div class="wv-bar" role="img" aria-label="${fmtN(done)} of ${fmtN(w.todo)} assembled"><i style="width:${w.todo ? Math.round(done / w.todo * 100) : 100}%"></i></div>
        <div class="wv-line"><b>${fmtN(done)}</b> of ${fmtN(w.todo)} assembled${pace ? raw(html` <small>· ${pace}</small>`) : ""}</div>`)}
      <div class="wv-left">${nLeft ? raw(html`<span class="muted">Left:</span>${leftTxt}`) : raw('<span class="good-txt">All assembled</span>')}</div></div>`;
  }
  function clockOf(iso) { const d = new Date(iso); return d.getHours() + d.getMinutes() / 60; }

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

  // ---- washers: each load, by washer
  function drawWash(X) {
    const card = document.getElementById("pl-wash-card"), el = document.getElementById("pl-wash"); if (!el) return;
    const W = X.R.empty ? null : X.R.W;
    card.hidden = !s.washOn;
    if (!W || !W.loads.length) { el.innerHTML = html`<p class="muted pad">${X.R.empty ? "Shows once there's a crew and pieces." : "Nothing to wash."}</p>`; return; }
    const nm = { slt: "Starch tops", slb: "Starch bottoms", tc: "Tablecloths", comf: "Comforters" }, col = { slt: CAT_COLOR.slt, slb: CAT_COLOR.slb, tc: CAT_COLOR.tc, comf: CAT_COLOR.comf };
    const ws = [...new Set(W.loads.map(l => l.w))].sort((a, b) => a - b);
    el.innerHTML = html`<div class="wash-sum"><span>Washing starts <b>${fmtClock(W.start)}</b>${W.staffedLo ? "" : raw(' <span class="warn-txt">· no laundry operator on the plan</span>')}</span>
        ${W.laundryDone ? raw(html`<span>Starch laundry washed by <b>${fmtClock(W.laundryDone)}</b></span>`) : ""}${W.tcDone ? raw(html`<span>Tablecloths by <b>${fmtClock(W.tcDone)}</b></span>`) : ""}${W.comfDone ? raw(html`<span>Comforters by <b>${fmtClock(W.comfDone)}</b></span>`) : ""}</div>
      ${ws.map(w => raw(html`<div class="wash-row"><b>Washer ${w}</b><div>${W.loads.filter(l => l.w === w).map(l => raw(html`<span class="wl" style="--c:${col[l.type]}" title="${nm[l.type]}: ${Math.round(l.n)} pieces, ${fmtClock(l.from)}–${fmtClock(l.to)}">${nm[l.type]} ${Math.round(l.n)}<small>${hm(l.from)}–${hm(l.to)}</small></span>`))}</div></div>`))}`;
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
