// Review: how a day went against its plan — pieces, hours, people, follow-ups, and the trend.
import { api } from "../api.js";
import { html, raw, toast, RANK } from "../ui.js";
import { fmtClock, hm, fmtH, fmtN, fmt$ } from "../engine/engine.js";
import * as M from "../plan/model.js";

const SMRT_ORDER = (customer, no) => `https://towncountryclean.smrtapp.com/posx/dash/customer/clothestracker/${encodeURIComponent(customer)}/?saleId=${String(no).replace(/\D/g, "")}`;
const longDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const shortDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const stamp = s => { if (!s) return "—"; const m = /^(\d{4}-\d{2}-\d{2})[T ](\d\d):(\d\d)/.exec(s); return m ? `${shortDay(m[1])} ${fmtClock(+m[2] + +m[3] / 60)}` : s; };
let pick = null;

export async function render(main, ctx) {
  const can = RANK[ctx.me.role] >= RANK.manager, admin = RANK[ctx.me.role] >= RANK.admin;
  let NX = null;          // the next work day's projection, kept while moving between days
  let BASE = null;        // settings and team, read once
  let R0 = null;          // the reviewed day's plan, worked out the same way as the Plan page (manual plan, finish lines, pace)
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Adding up the day…</div>`;
  const asked = (location.hash.match(/[?&]day=(\d{4}-\d{2}-\d{2})/) || [])[1];
  if (asked) pick = asked;
  const nowH = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
  // first visit: today once the day has started, otherwise the last work day
  const d0 = new Date(), localDay = new Date(d0.getTime() - d0.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  let D = await api(`/review/${pick && pick <= localDay ? pick : localDay}`);
  if (!pick && (!D.isWorkDay || (D.labor.hours === 0 && D.done.pieces === 0))) D = await api(`/review/${D.prev}`);
  pick = D.day;
  await planOf(D.day);
  draw();
  // today: refresh every 2 minutes while this page is open (not while someone is typing a follow-up note)
  const me = Symbol("review"); main._rv = me;
  const timer = setInterval(async () => {
    if (main._rv !== me || !document.getElementById("rv-root")) return clearInterval(timer);
    if (!D.isToday || main.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    try { D = await api(`/review/${pick}`); await planOf(pick); draw(); } catch { /* next time */ }
  }, 120000);

  async function go(day) { main.querySelector("#rv-root")?.classList.add("busy"); pick = day; D = await api(`/review/${day}`); await planOf(day); draw(); }

  // the day's plan as the Plan page shows it: the saved crew (or the last saved plan copied in), red finish lines,
  // each person's should-leave time and labor at that pace (Neal, Oct 14–15). Today counts from now on pieces left.
  async function planOf(day) {
    try {
      if (!BASE) { const [SET, TEAM] = await Promise.all([api("/settings"), api("/team")]); BASE = { SET, TEAM }; }
      const [V, plan] = await Promise.all([api(`/pieces?day=${day}`), api(`/plan/${day}`)]);
      R0 = M.projectDay({ ...BASE, V, plan, day, admin, now: D.isToday ? nowH() : null });
      if (R0) R0.plan = plan;
    } catch (e) { R0 = null; console.warn("review plan", e); }
  }

  function draw() {
    const L = D.labor, pct = L.pct, now = nowH();
    const rows = planRows();
    const pastLine = rows.filter(r => r.past > 1 / 6);
    const bits = [];
    if (D.due.pieces) bits.push(`${fmtN(D.due.finished)} of ${fmtN(D.due.pieces)} due pieces finished`);
    if (pastLine.length) bits.push(`${pastLine.length} ${pastLine.length === 1 ? "person" : "people"} past their line`);
    if (pct != null) bits.push(pct <= L.target ? `labor ${pct.toFixed(1)}%, under target` : `labor ${pct.toFixed(1)}%`);
    const good = D.due.finished >= D.due.pieces && !pastLine.length && (pct == null || pct <= L.target);
    const head = bits.length ? `${D.isToday ? "So far: " : ""}${bits.join(" · ")}` : "No pieces or hours recorded for this day";
    const lastOut = Math.max(-1, ...D.actual.filter(p => p.lastOut != null).map(p => p.lastOut)), stillIn = D.actual.some(p => p.open);
    const tiles = [
      { v: fmtN(D.done.pieces), s: "pieces assembled" },
      { v: D.due.pieces ? `${fmtN(D.due.finished)}` : "—", s: D.due.pieces ? `of ${fmtN(D.due.pieces)} due, finished` : "pieces due", c: D.due.pieces && D.due.finished < D.due.pieces ? "warn" : "" },
      { v: L.hours ? fmtH(L.hours) : "—", s: `paid hours · ${L.people} ${L.people === 1 ? "person" : "people"}`, t: L.breakPaid > 0.01 ? `Includes ${fmtH(L.breakPaid)} of paid breaks (up to 30 min each, Production and Laundry Hub)` : "" },
      { v: L.perHour != null ? L.perHour.toFixed(1) : "—", s: "pieces per paid hour" },
      ...(D.money ? [{ v: pct != null ? pct.toFixed(1) + "%" : "—", c: pct == null ? "" : pct <= L.target ? "good" : "bad", s: `labor of revenue · target ${L.target}%` }] : []),
      { v: lastOut >= 0 ? hm(lastOut) : "—", s: `last out${stillIn ? " (some still in)" : ""}${R0 && R0.lastOut != null ? ` · plan ${hm(R0.lastOut)}` : ""}` },
    ];
    main.innerHTML = html`<div id="rv-root">
      <div class="page-head"><div><h1>${D.isToday ? "Today" : "Review"}</h1><p>${longDay(D.day)}${D.isToday ? " · so far, live from SMRT and the time clock" : ""}</p></div>
        <div class="head-actions day-nav">
          <button class="icon-btn" id="rv-prev" title="Previous work day" aria-label="Previous work day">‹</button>
          <label class="sr" for="rv-date">Day</label><input class="input" type="date" id="rv-date" value="${D.day}" max="${D.today}">
          <button class="icon-btn" id="rv-next" title="Next work day" aria-label="Next work day" ${D.next ? "" : "disabled"}>›</button>
        </div></div>
      <section class="verdict ${!bits.length ? "idle" : good ? "ok" : pct != null && pct > L.target ? "bad" : "warn"}"><div class="v-head"><span class="v-ico" aria-hidden="true">${!bits.length ? "…" : good ? "✓" : "!"}</span><b>${head[0].toUpperCase() + head.slice(1)}</b></div></section>
      <section class="tiles rv-tiles">${tiles.map(x => raw(html`<div class="tile"${x.t ? raw(html` title="${x.t}"`) : ""}><b class="t-num ${x.c ? "c-" + x.c : ""}">${x.v}</b><span class="t-sub">${x.s}</span></div>`))}</section>
      ${D.money && L.avgHours > 0.05 ? raw(html`<p class="muted small rv-note">Labor cost uses each person's pay rate from Rippling; ${fmtH(L.avgHours)} of ${fmtH(L.hours)} ${L.avgHours >= L.hours - 0.05 ? "are" : "is"} costed at the average ${fmt$(L.payAvg)}/h because Rippling hasn't sent a rate for ${L.avgHours >= L.hours - 0.05 ? "anyone yet" : "everyone"}.</p>`) : ""}
      <section class="card pl-card rv-people"><header class="pl-cardhead"><div><h2>Plan vs. actual</h2><p>${R0 && R0.crew.length ? `${R0.copied ? `No plan was saved for this day; this is ${R0.basis}` : R0.plan?.published ? `The published plan${R0.plan.published.by ? ` (${R0.plan.published.by})` : ""}` : "The plan as saved"} against Rippling. Line = when they're needed until at the planned pace (the Plan's red mark). Breaks: the first gap is the paid break, up to 30 min; back after more than 35 and none of it is paid.` : "No plan was saved for this day, so only the time clock is shown."}</p></div></header>${raw(peopleTable(rows))}</section>
      <div class="rv-grid">
        ${raw(laborCard(rows))}
        <section class="card pl-card rv-hours"><header class="pl-cardhead"><div><h2>By the hour</h2><p>Pieces assembled in SMRT each hour${D.isToday ? ", so far" : ""}. Assembly runs behind pressing, so spurts follow batches.</p></div></header>${raw(byHour())}</section>
        ${D.tally && (D.tally.total || D.tally.entries.length || D.isToday) ? raw(html`<section class="card pl-card rv-tally" id="rv-tally"><header class="pl-cardhead"><div><h2>Starch bottoms pressed</h2><p>Counts from the station tablets, checked against SMRT's starch bottoms assembled. Pace is per person on the station, against their SLB goal.</p></div></header>${raw(tallyCard())}</section>`) : ""}
        <section class="card pl-card"><header class="pl-cardhead"><div><h2>Pieces through the day</h2><p>Assembled in SMRT, counted as they happened${R0 && R0.end != null ? `, against when the plan says the work should be done (${hm(R0.end)})` : ""}.</p></div></header>${raw(chart())}</section>
        <section class="card pl-card" id="rv-nextday"><header class="pl-cardhead"><div><h2>Next work day · ${shortDay(D.nextWork)}</h2><p>Pieces to plan for, the crew and when the work should be done.</p></div>
          <a class="btn small primary" href="#/plan?day=${D.nextWork}">Open ${new Date(D.nextWork + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" })}'s plan</a></header><div id="rv-nextday-body"><p class="muted pad">Working it out…</p></div></section>
        <section class="card pl-card"><header class="pl-cardhead"><div><h2>Last ${D.trend.length} work days</h2><p>Pieces assembled per paid hour${D.money ? ", and labor % of revenue" : ""}.</p></div></header>${raw(trend())}</section>
      </div>
      ${D.isToday ? raw('<div id="rv-orders"></div>') : ""}
      ${raw(followups())}
    </div>`;
    nextDay();
    if (D.isToday) orders();
    main.querySelector("#rv-prev").addEventListener("click", () => go(D.prev));
    main.querySelector("#rv-next").addEventListener("click", () => D.next && go(D.next));
    main.querySelector("#rv-date").addEventListener("change", e => { if (e.target.value && e.target.value <= D.today) go(e.target.value); });
    main.querySelectorAll("[data-trend]").forEach(b => { b.addEventListener("click", () => go(b.dataset.trend)); b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(b.dataset.trend); } }); });
    wireTally();
    main.querySelectorAll("form.fu").forEach(f => f.addEventListener("submit", async e => {
      e.preventDefault();
      const resolved = e.submitter?.value === "resolve";
      const btns = f.querySelectorAll("button"); btns.forEach(b => { b.disabled = true; });
      try {
        await api(`/followups/${f.dataset.id}`, { method: "PATCH", body: { reasonId: f.reason.value, note: f.note.value, resolved } });
        toast(resolved ? "Marked done." : "Saved."); D = await api(`/review/${pick}`); draw();
      } catch (x) { toast(x.message, "bad"); btns.forEach(b => { b.disabled = false; }); }
    }));
  }

  // ------------------------------------------------------------ plan vs. actual, person by person
  // One row per person who was planned or clocked in: stations (moves), planned in/out and break, their line (should
  // leave at the planned pace), actual in/out, the break as taken (paid or not), paid hours, the week so far, and flags.
  function planRows() {
    const now = nowH(), live = D.isToday;
    const act = new Map(D.actual.map(a => [a.personId, a]));
    const PL = R0?.PL?.people || {};
    const toH = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] + +m[2] / 60 : null; };
    const out = [], seen = new Set();
    for (const c of R0?.crew || []) {
      if (seen.has(c.personId)) continue; seen.add(c.personId);
      const a = act.get(c.personId) || null, pl = PL[c.personId] || null;
      const pin = toH(c.start), pout = toH(c.stop) ?? (pin != null ? pin + 8 : null);
      const bk = /^(\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))?$/.exec(c.brk || "");
      const end = a ? (a.lastOut ?? (live ? now : null)) : null;
      const past = pl && end != null && a ? Math.max(0, end - pl.leave) : 0;
      out.push({ id: c.personId, name: c.name, planned: true, stations: [c.station, ...c.moves.map(m => `${m.label} ${hm(toH(m.at))}`)], pin, pout,
        pbrk: bk ? [toH(bk[1]), bk[2] ? toH(bk[2]) : toH(bk[1]) + 0.5] : null, leave: pl ? pl.leave : null, a, past, rate: pl ? pl.rate : null });
    }
    for (const a of D.actual) if (!seen.has(a.personId)) out.push({ id: a.personId, name: a.name, planned: false, stations: [], a, past: 0 });
    // who shared a station at the same time in the plan, and both clocked in that day (Neal, Oct 15)
    if (R0 && !R0.X.R.empty) {
      try {
        const SR = M.stationRows(R0.X, M.boardGroups(R0.X.E.POS, BASE.SET.boardOrder));
        for (const r of SR) for (const l of r.lanes) for (const b of l.bars) if (b.dup && act.has(l.empId) && b.dupWith.some(id => act.has(id))) {
          const row = out.find(x => x.id === l.empId); if (row) (row.dup = row.dup || []).push(`2 on ${r.label} ${hm(b.from)}–${hm(b.to)}`);
        }
      } catch { /* the board is optional here */ }
    }
    return out.sort((x, y) => (x.planned === y.planned ? 0 : x.planned ? -1 : 1) || (x.pin ?? x.a?.firstIn ?? 99) - (y.pin ?? y.a?.firstIn ?? 99));
  }
  // the week so far for one person: Rippling's finished days before this one (paid hours) plus this day's
  function weekOf(id, todayH) {
    const H = R0?.P?.history?.hours; if (!H) return null;
    const ws = BASE?.SET?.groups?.day?.weekStart ?? 1, dow = new Date(D.day + "T12:00:00").getDay(), back = (dow - ws + 7) % 7;
    const start = new Date(Date.parse(D.day + "T12:00:00Z") - back * 864e5).toISOString().slice(0, 10);
    const before = H.filter(h => h.personId === id && h.day >= start && h.day < D.day).reduce((t, h) => t + (+h.hours || 0), 0);
    return before + (todayH || 0);
  }
  function peopleTable(rows) {
    if (!rows.length) return html`<p class="muted pad">${D.isToday ? "No one has clocked in yet." : "No plan and no time clock for this day."}</p>`;
    const now = nowH();
    const brkTxt = a => {
      if (!a) return { t: "—", c: "" };
      if (D.isToday) {
        if (a.breakMin == null) return { t: a.open ? "not yet" : "—", c: "muted" };
        if (a.breakOpen) return { t: `on break ${a.breakMin} min`, c: a.breakMin > 35 ? "bad" : a.breakMin > 30 ? "warn" : "" };
        return a.breakPaid > 0 ? { t: `${a.breakMin} min · paid` } : { t: `${a.breakMin} min · unpaid`, c: "bad" };
      }
      if (a.breakPaid > 0) return { t: `${Math.round(a.breakPaid * 60)} min paid${a.offMin > Math.round(a.breakPaid * 60) + 2 ? ` · off ${a.offMin} min in all` : ""}` };
      return a.offMin > 2 ? { t: `off ${a.offMin} min · unpaid`, c: a.offMin > 35 ? "bad" : "" } : { t: "none", c: "muted" };
    };
    const flags = r => {
      const f = [], a = r.a;
      if (!r.planned) f.push(["warn", "Not in the plan"]);
      else if (!a) f.push(D.isToday && r.pin != null && now < r.pin + 0.25 ? ["", "Not in yet"] : ["bad", "Didn't clock in"]);
      if (r.planned && a) {
        const dIn = Math.round((a.firstIn - r.pin) * 60);
        if (dIn >= 10) f.push(["warn", `In ${dIn} min late`]); else if (dIn <= -10) f.push(["", `In ${-dIn} min early`]);
        if (a.lastOut != null && r.pout != null && Math.round((r.pout - a.lastOut) * 60) >= 10 && !(r.leave != null && a.lastOut >= r.leave - 1 / 6)) f.push(["warn", `Out ${Math.round((r.pout - a.lastOut) * 60)} min early`]);
        if (r.past > 1 / 6) f.push(["bad", `${a.lastOut == null ? "On the clock" : "Stayed"} ${fmtH(r.past)} past the line${admin && r.rate ? ` · ${fmt$(r.past * r.rate)}` : ""}`]);
      }
      if (a && !a.breakOpen && a.breakMin != null && a.breakPaid === 0) f.push(["bad", "Break over 35 min · unpaid"]);
      for (const d of r.dup || []) f.push(["warn", d]);
      return f;
    };
    const wk = h => h == null ? "—" : raw(html`<span class="${h > 40 ? "c-bad" : h >= 36 ? "c-warn" : ""}">${fmtH(h)}</span>`);
    return html`<div class="t-scroll"><table class="rt rv-pva"><thead><tr><th>Person</th><th>Planned</th><th>Line</th><th>Actual</th><th>Break</th><th class="num">Paid</th><th class="num">Week</th><th></th></tr></thead><tbody>
      ${rows.map(r => { const a = r.a, b = brkTxt(a), fl = flags(r);
        return raw(html`<tr><td><b>${r.name}</b><small>${r.stations.join(" → ") || "—"}</small></td>
          <td>${r.planned ? `${hm(r.pin)}–${hm(r.pout)}` : "—"}${r.pbrk ? raw(html`<small>break ${hm(r.pbrk[0])}–${hm(r.pbrk[1])}</small>`) : ""}</td>
          <td>${r.leave != null ? hm(r.leave) : "—"}</td>
          <td>${a ? `${a.firstIn != null ? hm(a.firstIn) : "?"}–${a.lastOut != null ? hm(a.lastOut) : "…"}` : "—"}</td>
          <td class="${b.c ? "c-" + b.c : ""}">${b.t}</td>
          <td class="num">${a ? fmtH(a.hours) : "—"}</td>
          <td class="num">${wk(a || r.planned ? weekOf(r.id, a ? a.hours : 0) : null)}</td>
          <td class="rv-flags">${fl.map(([c, t]) => raw(html`<span class="chip ${c === "bad" ? "off" : c === "warn" ? "manager" : ""}">${t}</span>`))}</td></tr>`); })}
      </tbody></table></div>`;
  }

  // ------------------------------------------------------------ labor: plan vs. actual, on the same sales
  // Scheduled (everyone to their planned clock-out), at the planned pace (each person to their line), and actual
  // (Rippling paid hours, breaks paid up to 30 min) — all as % of the sales value of the plan's pieces, like the Plan's
  // status line. Labor % of revenue (the tile) divides by what was assembled instead.
  function laborCard(rows) {
    if (!R0 || !R0.crew.length) return "";
    const L = D.labor, sales = R0.sales, money = D.money && L.cost != null;
    const pc = c => (sales > 0 && c != null ? `${(c / sales * 100).toFixed(1)}%` : "—");
    const cls = c => (sales > 0 && c != null ? (c / sales * 100 <= L.target ? "c-good" : c / sales * 100 <= L.target + 2 ? "c-warn" : "c-bad") : "");
    const schedH = R0.X.M ? R0.X.M.regH + R0.X.M.otH + R0.X.M.opsH : null;
    const past = rows.filter(r => r.past > 1 / 6), pastH = past.reduce((t, r) => t + r.past, 0), pastC = past.reduce((t, r) => t + r.past * (r.rate || 0), 0);
    const line = (label, h, c, note) => raw(html`<tr><td><b>${label}</b>${note ? raw(html`<small>${note}</small>`) : ""}</td><td class="num">${h != null ? fmtH(h) : "—"}</td>${money ? raw(html`<td class="num">${c != null ? fmt$(c) : "—"}</td><td class="num ${cls(c)}">${pc(c)}</td>`) : ""}</tr>`);
    return html`<section class="card pl-card"><header class="pl-cardhead"><div><h2>Labor: plan vs. actual</h2><p>${money ? `As a share of the plan's pieces' sales (${fmt$(sales)}), like the Plan's status line; target ${L.target}%.` : "Paid hours planned and worked."} Paid breaks count, up to 30 min a person.</p></div></header>
      <div class="t-scroll"><table class="rt"><thead><tr><th></th><th class="num">Hours</th>${money ? raw("<th class=\"num\">Cost</th><th class=\"num\">% of sales</th>") : ""}</tr></thead><tbody>
        ${line("Scheduled", schedH, R0.schedCost, "everyone to their planned clock-out")}
        ${line("At the planned pace", R0.laborH, R0.cost, "each person to their line")}
        ${line(D.isToday ? "Actual so far" : "Actual", L.hours, money ? L.cost : null, L.breakPaid > 0.01 ? `Rippling; ${fmtH(L.breakPaid)} of it paid breaks` : "Rippling")}
      </tbody></table></div>
      ${past.length ? raw(html`<p class="small c-bad">${past.length} ${past.length === 1 ? "person" : "people"} ${D.isToday ? "on the clock" : "stayed"} past their line: ${fmtH(pastH)}${admin ? ` · ${fmt$(pastC)}` : ""}.</p>`) : raw('<p class="small muted">No one stayed past their line by more than 10 minutes.</p>')}</section>`;
  }

  // the next work day: its saved plan (or the last one copied in, as the Plan page will), with the pieces known now
  async function nextDay() {
    const day = D.nextWork, el = () => main.querySelector("#rv-nextday-body");
    try {
      if (!NX || NX.day !== day) {
        if (!BASE) { const [SET, TEAM] = await Promise.all([api("/settings"), api("/team")]); BASE = { SET, TEAM }; }
        const [V, plan] = await Promise.all([api(`/pieces?day=${day}`), api(`/plan/${day}`)]);
        NX = { day, N: M.projectDay({ ...BASE, V, plan, day, admin }), target: BASE.SET.groups.money.laborTarget };
      }
      const N = NX.N, box = el(); if (!box || D.nextWork !== day) return;
      if (!N) { box.innerHTML = html`<p class="muted pad">No pieces due that day yet.</p>`; return; }
      const people = new Set(N.crew.map(c => c.personId)).size;
      box.innerHTML = html`<div class="rv-next">
          <div><b>${N.expected ? "~" : ""}${fmtN(N.pieces)}</b><span>${N.pieces === 1 ? "piece" : "pieces"} to plan for${N.expected ? ` · ${fmtN(N.known)} known now` : ""}</span></div>
          <div><b>${people || "—"}</b><span>people · ${N.copied ? "copied plan" : people ? "planned" : "no plan yet"}</span></div>
          <div><b class="${N.short > 0.5 ? "c-bad" : ""}">${N.end != null ? hm(N.end) : "—"}</b><span>work should be done by${N.lastOut != null ? ` · last out ${hm(N.lastOut)}` : ""}</span></div>
          ${admin ? raw(html`<div><b class="${N.pct == null ? "" : N.pct <= NX.target ? "c-good" : N.pct <= NX.target + 2 ? "c-warn" : "c-bad"}">${N.pct != null ? N.pct.toFixed(1) + "%" : "—"}</b><span>labor at the planned pace</span></div>`) : ""}
        </div>
        <p class="muted small">Crew: ${N.basis}.${N.short > 0.5 ? ` ${fmtN(N.short)} pieces aren't covered by the planned hours.` : ""}</p>`;
    } catch (e) { const box = el(); if (box) box.innerHTML = html`<p class="muted pad">Couldn't work out the next day: ${e.message}</p>`; }
  }

  // the station tablets (Neal, Oct 14): pressed vs. SMRT's assembled, pace per person, every count (photos for Admins)
  function tallyCard() {
    const T = D.tally, asm = D.done.q?.slb || 0, diff = T.total - asm, pct = asm ? Math.abs(diff) / asm : null;
    const r1 = v => (v == null ? "—" : v.toFixed(1)), g1 = v => (Number.isInteger(+v) ? String(v) : (+v).toFixed(1));
    const check = !T.total ? { c: "", t: D.isToday ? "No counts yet today." : "No counts were entered this day." }
      : D.isToday ? { c: "", t: diff > 0 ? `${fmtN(diff)} pressed and not assembled yet (at IAB, or done ahead)` : diff < 0 ? `${fmtN(-diff)} more assembled than counted — counts may be missing` : "Every pressed pair is assembled" }
      : pct <= 0.05 ? { c: "good", t: `Counts match SMRT within ${Math.max(1, Math.round(pct * 100))}%` } : { c: "warn", t: `Counts are ${diff > 0 ? "over" : "under"} SMRT by ${fmtN(Math.abs(diff))} (${Math.round(pct * 100)}%) — a missed or doubled count, or pairs pressed one day and assembled the next` };
    const rows = T.stations.flatMap(s => s.people.filter(p => p.count > 0).map(p => ({ s, p })));
    const E = T.entries.slice().reverse();
    return html`<div class="rv-next">
        <div><b>${fmtN(T.total)}</b><span>pairs pressed · tablets</span></div>
        <div><b>${fmtN(asm)}</b><span>starch bottoms assembled · SMRT</span></div>
        <div><b class="${check.c ? "c-" + check.c : ""}">${T.total ? (diff > 0 ? "+" : "") + fmtN(diff) : "—"}</b><span>difference</span></div>
      </div>
      <p class="small ${check.c ? "c-" + check.c : "muted"}">${check.t}</p>
      ${rows.length ? raw(html`<div class="t-scroll"><table class="rt"><thead><tr><th>Station</th><th>Person</th><th class="num">Pairs</th><th class="num">Hours</th><th class="num">Per hour</th><th class="num">Goal</th></tr></thead><tbody>
        ${T.stations.map(s => raw(html`<tr class="rt-sub"><td><b>${s.label}</b></td><td class="muted">whole station</td><td class="num"><b>${fmtN(s.station.count)}</b></td><td class="num">${s.station.minutes ? fmtH(s.station.minutes / 60) : "—"}</td>
          <td class="num c-${tc(s.station.color)}">${r1(s.station.perHour)}</td><td class="num">${g1(s.station.goal)}</td></tr>
          ${s.people.filter(p => p.count > 0).map(p => raw(html`<tr><td></td><td>${p.name}</td><td class="num">${fmtN(p.count)}</td><td class="num">${p.minutes ? fmtH(p.minutes / 60) : "—"}</td>
            <td class="num c-${tc(p.color)}">${r1(p.perHour)}${p.pct != null ? raw(html` <small>${Math.round(p.pct * 100)}%</small>`) : ""}</td><td class="num">${g1(p.goal)}${p.ownGoal ? "" : raw(' <small class="muted">station</small>')}</td></tr>`))}`))}
        </tbody></table></div>`) : ""}
      ${E.length || can ? raw(html`<details class="rv-counts"${E.length && E.length <= 8 ? " open" : ""}><summary>Every count (${E.length})${can ? " · add or remove" : ""}</summary>
        <div class="tc-list">${E.map(e => raw(html`<div class="tc-row">
          ${admin && e.hasPhoto ? raw(html`<a href="/api/tally/photo/${e.id}" target="_blank" rel="noopener" class="tc-ph" title="Photo taken with this count"><img src="/api/tally/photo/${e.id}" alt="Photo at ${hm(e.minute / 60)}" loading="lazy"></a>`) : raw('<span class="tc-ph none"></span>')}
          <span class="tc-t">${hm(e.minute / 60)}</span><span class="chip">${e.label}</span><b>${e.count}</b><span class="tc-who">${e.name || "No one planned"}${e.source === "manager" ? raw(html` <small class="muted">· added in Review${e.note ? `: ${e.note}` : ""}</small>`) : ""}</span>
          ${can ? raw(html`<button type="button" class="btn ghost small danger" data-tdel="${e.id}" aria-label="Remove this count">Remove</button>`) : ""}</div>`))}</div>
        ${can && D.day <= D.today ? raw(html`<form class="tc-add" id="tc-add"><select class="input" name="station" aria-label="Station">${T.stations.map(s => raw(html`<option value="${s.code}">${s.label}</option>`))}</select>
          <input class="input" type="time" name="at" required aria-label="Pressed by" value="${D.isToday ? new Date().toTimeString().slice(0, 5) : "16:00"}"><input class="input" type="number" name="count" min="1" max="999" required placeholder="Pairs" aria-label="Pairs">
          <input class="input" name="note" maxlength="200" placeholder="Why (optional)" aria-label="Why"><button class="btn small">Add a count</button></form>
          <p class="muted small">A count added here goes to whoever the plan had on that station at that time.</p>`) : ""}</details>`) : ""}`;
  }
  function tc(c) { return c === "green" ? "good" : c === "yellow" ? "warn" : c === "red" ? "bad" : "none"; }
  function wireTally() {
    main.querySelectorAll("[data-tdel]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Remove this count?")) return;
      try { await api(`/tally/${b.dataset.tdel}`, { method: "DELETE" }); toast("Count removed."); D = await api(`/review/${pick}`); draw(); } catch (x) { toast(x.message, "bad"); }
    }));
    main.querySelector("#tc-add")?.addEventListener("submit", async e => {
      e.preventDefault(); const f = e.currentTarget;
      try { await api("/tally", { method: "POST", body: { day: D.day, station: f.station.value, at: f.at.value, count: +f.count.value, note: f.note.value } }); toast("Count added."); D = await api(`/review/${pick}`); draw(); }
      catch (x) { toast(x.message, "bad"); }
    });
  }

  function chart() {
    const C = D.done.curve;
    if (C.length < 2) return html`<p class="muted pad">${D.isToday ? "Fills in as pieces are assembled." : "No pieces were assembled this day."}</p>`;
    const last = C[C.length - 1];
    // where the plan says the work should be done (the Plan's red finish lines): past days from the first clock-in to
    // the last finish line with all the plan's pieces; today from now and what's done to the finish of what's left
    let pl = null;
    if (R0 && R0.end != null && R0.pieces) {
      const left = Object.values(R0.FIN).reduce((t, f) => t + (f.pieces || 0), 0);
      pl = D.isToday ? { a: [Math.max(last[0], nowH()), last[1]], b: [R0.end, last[1] + left] } : { a: [R0.firstIn ?? C[0][0], 0], b: [R0.end, R0.pieces] };
      if (!(pl.b[0] > pl.a[0])) pl = null;
    }
    const total = Math.max(last[1], pl ? pl.b[1] : 0, D.due.pieces || 0, 1), top = total * 1.06;
    const t0 = Math.floor(Math.min(C[0][0], pl ? pl.a[0] : 24)), t1 = Math.ceil(Math.max(last[0], pl ? pl.b[0] : 0, t0 + 6));
    const Wd = 560, Ht = 260, L = 44, R = 548, T = 14, B = 232, X = t => L + (t - t0) / (t1 - t0) * (R - L), Y = v => B - v / top * (B - T);
    const step = top > 1500 ? 500 : top > 600 ? 200 : top > 200 ? 100 : top > 60 ? 20 : 5;
    let g = "";
    for (let v = 0; v <= top; v += step) g += `<line class="c-grid" x1="${L}" y1="${Y(v)}" x2="${R}" y2="${Y(v)}"/><text class="c-lbl" x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${fmtN(v)}</text>`;
    for (let t = t0; t <= t1; t += 2) g += `<text class="c-lbl" x="${X(t)}" y="${B + 18}" text-anchor="middle">${hm(t)}</text>`;
    if (D.due.pieces) g += `<line class="c-due" x1="${L}" y1="${Y(D.due.pieces)}" x2="${R}" y2="${Y(D.due.pieces)}"/><text class="c-lbl" x="${L + 4}" y="${Y(D.due.pieces) - 5}">${fmtN(D.due.pieces)} due</text>`;
    if (pl) g += `<polyline class="c-plan" points="${X(pl.a[0])},${Y(pl.a[1])} ${X(pl.b[0])},${Y(pl.b[1])}"/><text class="c-lbl" x="${X(pl.b[0]) > R - 90 ? X(pl.b[0]) - 6 : X(pl.b[0]) + 6}" y="${Math.min(B - 4, Y(pl.b[1]) + 16)}" text-anchor="${X(pl.b[0]) > R - 90 ? "end" : "start"}">done by ${hm(pl.b[0])}</text>`;
    const pts = [[C[0][0] - 0.25, 0], ...C].map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    g += `<polyline class="c-done" points="${pts}"/><circle class="c-dot" cx="${X(last[0])}" cy="${Y(last[1])}" r="4.5"/>`;
    g += `<text class="c-end" x="${Math.min(X(last[0]), R - 4)}" y="${Math.max(T + 12, Y(last[1]) - 10)}" text-anchor="end">${fmtN(last[1])} by ${hm(last[0])}</text>`;
    return `<svg class="rv-chart" viewBox="0 0 ${Wd} ${Ht}" role="img" aria-label="${fmtN(last[1])} pieces assembled by ${hm(last[0])}">${g}</svg>
      <div class="g-legend"><span><i class="k-done"></i>Assembled</span>${pl ? `<span><i class="k-plan"></i>${D.isToday ? "Plan's pace for what's left" : "Plan's pace"}</span>` : ""}${D.due.pieces ? '<span><i class="k-due"></i>Due this day</span>' : ""}</div>`;
  }

  // pieces assembled per clock hour, starch bottoms first (Neal, Oct 13: watch the bottleneck through the day)
  function byHour() {
    const H = D.done.byHour || {}, TB = D.tally?.byHour || {};
    const pressed = h => Object.values(TB).reduce((t, x) => t + (x[h] || 0), 0), hasPressed = !!D.tally?.total;
    const hours = [...new Set([...Object.keys(H), ...Object.values(TB).flatMap(x => Object.keys(x))].map(Number))].sort((a, b) => a - b);
    if (!hours.length) return html`<p class="muted pad">${D.isToday ? "Fills in as pieces are assembled." : "No pieces were assembled this day."}</p>`;
    const cols = [["slb", "Starch bottoms"], ["slt", "Starch tops"], ["dct", "DC tops"], ["dcb", "DC bottoms"], ["other", "Other"]];
    const v = (h, k) => k === "other" ? (H[h].comf || 0) + (H[h].tc || 0) : (H[h][k] || 0);
    const all = []; for (let h = hours[0]; h <= hours[hours.length - 1]; h++) all.push(h);
    const top = Math.max(1, ...all.map(h => (H[h] ? v(h, "slb") : 0)));
    const sum = k => all.reduce((t, h) => t + (H[h] ? v(h, k) : 0), 0);
    const nowH = new Date().getHours();
    return html`<div class="hr-scroll"><table class="hr-tbl"><thead><tr><th>Hour</th>${hasPressed ? raw('<th class="neck" title="Pairs pressed, from the station tablets">SLB pressed</th>') : ""}${cols.map(([, l], i) => raw(html`<th class="${i === 0 ? "neck" : ""}">${i === 0 && hasPressed ? "SLB assembled" : l}</th>`))}<th>All</th></tr></thead><tbody>
      ${all.map(h => { const row = H[h] || {}; const tot = Object.values(row).reduce((a, b) => a + b, 0), slb = H[h] ? v(h, "slb") : 0;
        return raw(html`<tr class="${D.isToday && h === nowH ? "now" : ""}"><th>${hm(h)}–${hm(h + 1).replace(/ [AP]M/, "")}</th>
          ${hasPressed ? raw(html`<td class="neck"><b>${pressed(h) || "·"}</b></td>`) : ""}<td class="neck"><span class="hr-bar" style="--w:${Math.round(slb / top * 100)}%"></span><b>${slb || "·"}</b></td>${cols.slice(1).map(([k]) => raw(html`<td>${(H[h] ? v(h, k) : 0) || "·"}</td>`))}<td>${tot || "·"}</td></tr>`); })}
      </tbody><tfoot><tr><th>Total</th>${hasPressed ? raw(html`<td class="neck"><b>${fmtN(D.tally.total)}</b></td>`) : ""}${cols.map(([k], i) => raw(html`<td class="${i === 0 ? "neck" : ""}"><b>${fmtN(sum(k))}</b></td>`))}<td><b>${fmtN(D.done.pieces)}</b></td></tr></tfoot></table></div>`;
  }
  // today: orders past their due time, and finished orders not marked ready (moved here from the Plan, Oct 13)
  async function orders() {
    const el = () => main.querySelector("#rv-orders");
    try {
      const V = await api("/pieces"); const box = el(); if (!box || !D.isToday) return;
      const late = (V.late || []).filter(o => o.overdue || Date.parse(o.due) <= Date.now());
      box.innerHTML = lateCard(late) + (V.notReady?.length ? notReadyCard(V.notReady) : "");
    } catch { /* optional */ }
  }
  function trend() {
    const T = D.trend, vals = T.map(x => x.perHour).filter(v => v != null);
    if (vals.length < 2) return html`<p class="muted pad">Builds up as days come in from SMRT and Rippling.</p>`;
    const bars = (key, max, fmt, cls, target) => {
      const Wd = 560, H = 120, n = T.length, bw = Math.min(26, (Wd - 10) / n - 6), Y = v => H - 16 - v / max * (H - 30);
      let g = target != null ? `<line class="c-target" x1="0" y1="${Y(target)}" x2="${Wd}" y2="${Y(target)}"/><text class="c-tlbl" x="${Wd - 2}" y="${Y(target) - 4}" text-anchor="end">${target}% target</text>` : "";
      T.forEach((x, i) => {
        const v = x[key], cx = 6 + i * ((Wd - 10) / n);
        g += `<g class="c-bar ${x.day === D.day ? "on" : ""}" data-trend="${x.day}" tabindex="0" role="button" aria-label="${shortDay(x.day)}: ${v == null ? "no data" : fmt(v)}"><title>${shortDay(x.day)}: ${v == null ? "no data" : fmt(v)}</title>`;
        if (v != null) g += `<rect class="${cls(v)}" x="${cx}" y="${Y(v)}" width="${bw}" height="${Math.max(1, H - 16 - Y(v))}" rx="3"/>`;
        g += `<rect x="${cx}" y="0" width="${bw}" height="${H}" fill="transparent"/><text class="c-lbl" x="${cx + bw / 2}" y="${H - 2}" text-anchor="middle">${new Date(x.day + "T12:00:00").getDate()}</text></g>`;
      });
      return `<svg class="rv-bars" viewBox="0 0 ${Wd} ${H}">${g}</svg>`;
    };
    const pmax = Math.max(...vals) * 1.15;
    let out = `<h3 class="rv-h3">Pieces per labor hour</h3>` + bars("perHour", pmax, v => v.toFixed(1), () => "b-info");
    if (D.money) {
      const pv = T.map(x => x.pct).filter(v => v != null), t = D.labor.target;
      if (pv.length) out += `<h3 class="rv-h3">Labor % of revenue</h3>` + bars("pct", Math.max(t * 1.4, ...pv), v => v.toFixed(1) + "%", v => v > t ? "b-bad" : "b-good", t);
    }
    return out + `<p class="muted small">Click a day to review it.</p>`;
  }

  function followups() {
    const F = D.followups, list = F.list;
    const open = list.filter(f => f.status !== "resolved");
    const reasonName = id => F.reasons.find(r => r.id === id)?.name || "";
    return html`<section class="card set-card"><header><h2>Follow-ups ${open.filter(f => f.status === "needs_note").length ? raw(html`<span class="count">${open.filter(f => f.status === "needs_note").length}</span>`) : ""}</h2>
        <p>Orders whose due date SMRT moved later while they were in production. Say why, so the store can tell the customer. Notes stay here; SMRT's own notes are shown as they are.</p></header>
      ${list.length ? raw(html`<div class="fu-list">${list.map(f => raw(html`<div class="fu-row ${f.status}">
        <div class="fu-main"><a class="l-no" href="${f.customer ? SMRT_ORDER(f.customer, f.no) : "#"}" target="_blank" rel="noopener" title="Open in SMRT">${f.no}</a>
          <span class="chip ${f.status === "needs_note" ? "off" : f.status === "noted" ? "manager" : "owner"}">${f.status === "needs_note" ? "Needs a reason" : f.status === "noted" ? "Noted" : "Done"}</span>
          <span class="muted small">${f.loc || ""} · due moved ${stamp(f.oldDue)} → ${stamp(f.newDue)}</span></div>
        ${f.smrtNote ? raw(html`<p class="fu-smrt"><b>SMRT note:</b> ${f.smrtNote}</p>`) : ""}
        ${f.note || f.reasonId ? raw(html`<p class="fu-note">${reasonName(f.reasonId)}${f.reasonId && f.note ? " — " : ""}${f.note || ""}${f.notedBy ? raw(html` <span class="muted small">· ${f.notedBy}</span>`) : ""}</p>`) : ""}
        ${can && f.status !== "resolved" ? raw(html`<form class="fu" data-id="${f.id}"><select class="input" name="reason" aria-label="Reason"><option value="">Reason…</option>${F.reasons.map(r => raw(html`<option value="${r.id}" ${r.id === f.reasonId ? "selected" : ""}>${r.name}</option>`))}</select>
          <input class="input" name="note" maxlength="500" placeholder="Note (optional)" aria-label="Note" value="${f.note || ""}"><button class="btn small" value="save">Save</button><button class="btn small ghost" value="resolve" title="The order is finished or the new date was met">Done</button></form>`) : ""}
      </div>`))}</div>`) : raw('<p class="muted">Nothing to follow up.</p>')}</section>`;
  }
}

function lateCard(rows) {
  if (!rows.length) return html`<section class="card set-card"><header><h2>Late orders</h2><p>None right now — nothing is past its due time.</p></header></section>`;
  return html`<section class="card set-card"><details data-k="late"><summary><h2>Late orders <span class="count">${rows.length}</span></h2>
      <p>Orders past their due time that aren't finished. Where the pieces are comes from SMRT's item and lot status.</p></summary>
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
        <span class="chip ${o.onVan ? "admin" : ""}">${o.onVan ? "On the van · not checked in" : "Assembled · not racked as ready"}</span></div>
      <div class="l-meta"><span>${o.loc}</span><span>Due ${new Date(o.due).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span><span>${o.pieces} pieces</span><span>${o.status}</span></div>
    </div>`))}</div></details></section>`;
}
