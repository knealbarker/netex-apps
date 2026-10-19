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
function localDayOf(iso) { const d = new Date(iso); return isNaN(d) ? "" : new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }

export async function render(main, ctx) {
  const can = RANK[ctx.me.role] >= RANK.manager, admin = RANK[ctx.me.role] >= RANK.admin;
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
    const L = D.labor, DP = D.departments, T = DP.total, tgt = DP.target;
    // the goal (Neal, Oct 15): every piece due today processed, at a pace that keeps labor under the target
    const missed = [...T.miss, ...DP.rows.filter(r => r.miss.length).map(r => r.label)];
    const head = D.isToday && !T.miss.length && T.left === 0 ? "So far: every due piece is done" + (T.pct != null ? ` · labor ${T.pct.toFixed(1)}%` : "")
      : T.miss.length ? `${D.isToday ? "So far: " : "Missed: "}${T.miss.join(" · ")}` : `Goal met: every due piece done${T.pct != null ? `, labor ${T.pct.toFixed(1)}% (target ${tgt}%)` : ""}`;
    const cls = T.miss.length ? (D.isToday && !(T.pct > tgt) ? "warn" : "bad") : "ok";
    const deptMiss = DP.rows.filter(r => r.miss.length).map(r => r.label);
    const lastOut = Math.max(-1, ...D.actual.filter(p => p.lastOut != null).map(p => p.lastOut)), stillIn = D.actual.some(p => p.open);
    const tiles = [
      { v: T.due ? fmtN(T.finished) : "—", s: T.due ? `of ${fmtN(T.due)} due, finished` : "pieces due", c: T.left ? "warn" : T.due ? "good" : "" },
      { v: fmtN(T.assembled), s: "pieces assembled" },
      { v: L.hours ? fmtH(L.hours) : "—", s: `paid hours · ${L.people} ${L.people === 1 ? "person" : "people"}`, t: L.breakPaid > 0.01 ? `Includes ${fmtH(L.breakPaid)} of paid breaks (up to 30 min each)` : "" },
      { v: T.perHour != null ? T.perHour.toFixed(1) : "—", s: `pieces per paid hour${T.targetPerHour ? ` · target ${T.targetPerHour.toFixed(1)}` : ""}`, c: T.perHour != null && T.targetPerHour ? (T.perHour >= T.targetPerHour ? "good" : "bad") : "",
        t: T.targetPerHour ? `To keep labor at ${tgt}%: average wage${T.avgWage ? ` ${fmt$(T.avgWage)}/h` : ""} ÷ (${tgt}% × average price per piece${T.avgPrice ? ` ${fmt$(T.avgPrice)}` : ""}). Uses this day's real pay rates and price mix.` : "" },
      ...(D.money ? [{ v: T.cost != null ? fmt$(T.cost) : "—", s: `labor · ${fmt$(T.value || 0)} of sales assembled` },
        { v: T.pct != null ? T.pct.toFixed(1) + "%" : "—", c: T.pct == null ? "" : T.pct <= tgt ? "good" : "bad", s: `labor % · target ${tgt}%` }] : []),
      { v: lastOut >= 0 ? hm(lastOut) : "—", s: `last out${stillIn ? " (some still in)" : ""}` },
    ];
    main.innerHTML = html`<div id="rv-root">
      <div class="page-head"><div><h1>${D.isToday ? "Today" : "Review"}</h1><p>${longDay(D.day)}${D.isToday ? " · so far, live from SMRT and the time clock" : ""}</p></div>
        <div class="head-actions day-nav">
          <button class="icon-btn" id="rv-prev" title="Previous work day" aria-label="Previous work day">‹</button>
          <label class="sr" for="rv-date">Day</label><input class="input" type="date" id="rv-date" value="${D.day}" max="${D.today}">
          <button class="icon-btn" id="rv-next" title="Next work day" aria-label="Next work day" ${D.next ? "" : "disabled"}>›</button>
        </div></div>
      <section class="verdict ${!T.due && !L.hours ? "idle" : cls}"><div class="v-head"><span class="v-ico" aria-hidden="true">${cls === "ok" ? "✓" : "!"}</span><b>${head}</b></div>
        <p class="v-sub muted small">Goal: every piece due ${D.isToday ? "today" : "that day"} finished, with labor at or under ${tgt}% of the sales assembled.${deptMiss.length ? ` Missed in: ${deptMiss.join(", ")}.` : ""}</p></section>
      <section class="tiles rv-tiles">${tiles.map(x => raw(html`<div class="tile"${x.t ? raw(html` title="${x.t}"`) : ""}><b class="t-num ${x.c ? "c-" + x.c : ""}">${x.v}</b><span class="t-sub">${x.s}</span></div>`))}</section>
      ${D.money && L.avgHours > 0.05 ? raw(html`<p class="muted small rv-note">Labor cost uses each person's pay rate from Rippling; ${fmtH(L.avgHours)} of ${fmtH(L.hours)} ${L.avgHours >= L.hours - 0.05 ? "are" : "is"} costed at the average ${fmt$(L.payAvg)}/h because Rippling hasn't sent a rate for ${L.avgHours >= L.hours - 0.05 ? "anyone yet" : "everyone"}.</p>`) : ""}
      <section class="card pl-card rv-depts"><header class="pl-cardhead"><div><h2>By department</h2><p>Pieces due and finished, and the labor that went into each. Hours come from the time clock, split across the stations each person was on in the day's plan${DP.planBasis.startsWith("copied") ? " (none was saved, so the last saved plan)" : DP.planBasis === "none" ? " (no plan was saved, so all hours show as not on the plan)" : ""}. Assembly and the operators work for every department, so they're on their own rows and in the total.</p></div></header>${raw(deptTable())}</section>
      <section class="card pl-card rv-people"><header class="pl-cardhead"><div><h2>People</h2><p>From the time clock. The first gap is the paid break, up to 30 min; back after more than 35 and none of it is paid. Week = paid hours this week, amber from 36, red past 40.</p></div></header>${raw(peopleCard())}</section>
      <div class="rv-grid">
        <section class="card pl-card rv-hours"><header class="pl-cardhead"><div><h2>By the hour</h2><p>Pieces assembled in SMRT each hour${D.isToday ? ", so far" : ""}. Assembly runs behind pressing, so spurts follow batches.</p></div></header>${raw(byHour())}</section>
        ${D.tally && (D.tally.total || D.tally.entries.length || D.isToday) ? raw(html`<section class="card pl-card rv-tally" id="rv-tally"><header class="pl-cardhead"><div><h2>Starch bottoms pressed</h2><p>Counts from the station tablets, checked against SMRT's starch bottoms assembled. Pace is per person on the station, against their SLB goal.</p></div></header>${raw(tallyCard())}</section>`) : ""}
        <section class="card pl-card"><header class="pl-cardhead"><div><h2>Last ${D.trend.length} work days</h2><p>Pieces assembled per paid hour${D.money ? ", and labor % of revenue" : ""}.</p></div></header>${raw(trend())}</section>
      </div>
      ${D.isToday ? raw('<div id="rv-orders"></div>') : ""}
      ${raw(followups())}
    </div>`;
    if (D.isToday) orders();
    main.querySelector("#rv-prev").addEventListener("click", () => go(D.prev));
    main.querySelector("#rv-next").addEventListener("click", () => D.next && go(D.next));
    main.querySelector("#rv-date").addEventListener("change", e => { if (e.target.value && e.target.value <= D.today) go(e.target.value); });
    wireTally();
    main.querySelectorAll("form.rv-mnote").forEach(f => f.addEventListener("submit", async e => {
      e.preventDefault(); const btn = f.querySelector("button"); btn.disabled = true;
      try { await api(`/review/${D.day}/note`, { method: "PUT", body: { dept: f.dataset.dept, text: f.note.value } }); toast(f.note.value.trim() ? "Note saved." : "Note removed."); D = await api(`/review/${pick}`); draw(); }
      catch (x) { toast(x.message, "bad"); btn.disabled = false; }
    }));
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

  // ------------------------------------------------------------ by department, with where the goal was missed
  function deptTable() {
    const DP = D.departments, T = DP.total, tgt = DP.target, money = D.money;
    const pctCls = v => (v == null ? "" : v <= tgt ? "c-good" : v <= tgt + 2 ? "c-warn" : "c-bad");
    const note = key => {
      const n = DP.notes[key];
      if (can) return raw(html`<form class="rv-mnote" data-dept="${key}"><input class="input" name="note" maxlength="500" placeholder="Why was it missed? (shows here for everyone)" aria-label="Note" value="${n ? n.text : ""}"><button class="btn small">Save</button></form>${n ? raw(html`<small class="muted">${n.by || ""}</small>`) : ""}`);
      return n ? raw(html`<p class="rv-ntext">${n.text}${n.by ? raw(html` <small class="muted">· ${n.by}</small>`) : ""}</p>`) : "";
    };
    const cols = 6 + (money ? 2 : 0);
    const missRow = () => "";   // Neal, Oct 15: no missed line or notes for now
    const dept = r => raw(html`<tr><td><b>${r.label}</b>${r.people.length ? raw(html`<small>${r.people.join(", ")}</small>`) : ""}</td>
      <td class="num">${fmtN(r.due)}</td><td class="num ${r.left ? "c-bad" : r.due ? "c-good" : ""}">${fmtN(r.finished)}${raw(finSub(r))}</td>
      <td class="num">${fmtN(r.assembled)}${raw(asmSub(r))}</td><td class="num">${r.hours > 0.05 ? fmtH(r.hours) : "—"}</td>
      <td class="num ${r.perHour != null && r.goal && r.perHour < r.goal * 0.9 ? "c-bad" : ""}">${r.perHour != null ? r.perHour.toFixed(1) : "—"}${r.goal ? raw(html`<small>goal ${r.goal}</small>`) : ""}</td>
      ${money ? raw(html`<td class="num">${r.cost != null && r.hours > 0.05 ? fmt$(r.cost) : "—"}</td>`) : ""}</tr>${missRow(r)}`);
    const shared = r => raw(html`<tr class="rv-shared"><td><b>${r.label}</b>${r.people.length ? raw(html`<small>${r.people.join(", ")}</small>`) : ""}</td><td colspan="3" class="muted small">${r.key === "none" ? "clocked in, not on any station in the plan" : "works for every department"}</td>
      <td class="num">${fmtH(r.hours)}</td><td></td>${money ? raw(html`<td class="num">${fmt$(r.cost)}</td>`) : ""}</tr>`);
    // Finished = pieces due this day that are done, whenever they were done; Assembled = pieces assembled this day,
    // whatever day they're due. The small lines show how the two overlap (Neal, Oct 15: "326 finished but 309 assembled?")
    const d0 = D.isToday ? "today" : "that day";
    function finSub(r) {
      const b = [];
      if (r.left) b.push(`<span class="c-bad">${fmtN(r.left)} left</span>`);
      if (r.earlier) b.push(`${fmtN(r.earlier)} done ahead`);
      if (r.noScan) b.push(`${fmtN(r.noScan)} no scan`);
      return b.length ? `<small>${b.join(" · ")}</small>` : "";
    }
    function asmSub(r) {
      const f = r.asmFor; if (!f || (!f.ahead && !f.overdue)) return "";
      const b = [`${fmtN(f.today)} due ${d0}`]; if (f.ahead) b.push(`${fmtN(f.ahead)} ahead`); if (f.overdue) b.push(`${fmtN(f.overdue)} past due`);
      return `<small>${b.join(" · ")}</small>`;
    }
    const rows = DP.rows.filter(r => !r.shared), sh = DP.rows.filter(r => r.shared);
    if (!rows.length && !sh.length) return html`<p class="muted pad">Nothing due, assembled or clocked this day.</p>`;
    return html`<div class="t-scroll"><table class="rt rv-dept"><thead><tr><th>Department</th><th class="num">Due</th><th class="num">Finished</th><th class="num">Assembled</th><th class="num">Hours</th><th class="num">Per hour</th>${money ? raw('<th class="num">Labor</th>') : ""}</tr></thead><tbody>
      ${rows.map(dept)}${sh.map(shared)}
      <tr class="rv-total"><td><b>Total</b></td><td class="num"><b>${fmtN(T.due)}</b></td><td class="num ${T.left ? "c-bad" : "c-good"}"><b>${fmtN(T.finished)}</b>${raw(finSub(T))}</td>
        <td class="num"><b>${fmtN(T.assembled)}</b>${raw(asmSub(T))}</td><td class="num"><b>${fmtH(T.hours)}</b></td><td class="num"><b>${T.perHour != null ? T.perHour.toFixed(1) : "—"}</b>${T.targetPerHour ? raw(html`<small>target ${T.targetPerHour.toFixed(1)}</small>`) : ""}</td>
        ${money ? raw(html`<td class="num"><b>${fmt$(T.cost)}</b><small class="${pctCls(T.pct)}">${T.pct != null ? T.pct.toFixed(1) + "% · target " + tgt + "%" : ""}</small></td>`) : ""}</tr>
      </tbody></table></div>
      <p class="muted small"><b>Finished</b> = pieces due ${d0} that are done, whenever they were done (done ahead = assembled on an earlier day; no scan = SMRT has the order assembled or ready but the piece was never scanned). <b>Assembled</b> = pieces assembled ${d0}, whatever day they're due (ahead = due later, past due = catching up). Labor % is for the whole day only (total row). Per hour = pieces assembled ÷ hours on its stations, against Settings › Rates.${D.isToday ? " Today's numbers are so far." : ""}</p>`;
  }

  // ------------------------------------------------------------ people: the time clock, breaks and the week
  function peopleCard() {
    const A = D.actual.slice().sort((a, b) => (a.firstIn ?? 99) - (b.firstIn ?? 99));
    if (!A.length) return html`<p class="muted pad">${D.isToday ? "No one has clocked in yet." : "No time clock for this day."}</p>`;
    const brk = a => {
      if (D.isToday) {
        if (a.breakMin == null) return { t: a.open ? "not yet" : "—", c: "muted" };
        if (a.breakOpen) return a.breakMin <= 35 ? { t: `on break ${a.breakMin} min`, c: a.breakMin > 30 ? "warn" : "" } : { t: `out since ${hm(a.lastOut)}`, c: "muted" };
        return a.breakPaid > 0 ? { t: `${a.breakMin} min · paid` } : { t: `${a.breakMin} min · unpaid`, c: "bad" };
      }
      if (a.breakPaid > 0) return { t: `${Math.round(a.breakPaid * 60)} min paid` };
      return a.offMin > 2 ? { t: `off ${a.offMin} min · unpaid`, c: a.offMin > 35 ? "bad" : "" } : { t: "none", c: "muted" };
    };
    const wk = h => (h == null ? "—" : raw(html`<span class="${h > 40 ? "c-bad" : h >= 36 ? "c-warn" : ""}">${fmtH(h)}</span>`));
    return html`<div class="t-scroll"><table class="rt"><thead><tr><th>Person</th><th>In–out</th><th>Break</th><th class="num">Paid</th><th class="num">Week</th></tr></thead><tbody>
      ${A.map(a => { const b = brk(a); return raw(html`<tr><td><b>${a.name}</b></td><td>${a.firstIn != null ? hm(a.firstIn) : "?"}–${a.lastOut != null ? hm(a.lastOut) : "…"}</td>
        <td class="${b.c ? "c-" + b.c : ""}">${b.t}</td><td class="num">${fmtH(a.hours)}</td><td class="num">${wk(weekOf(a.personId, a.hours))}</td></tr>`); })}
      </tbody></table></div>`;
  }
  // the week so far for one person: Rippling's finished days before this one (paid hours) plus this day's
  function weekOf(id, todayH) {
    const H = R0?.P?.history?.hours; if (!H) return null;
    const ws = BASE?.SET?.groups?.day?.weekStart ?? 1, dow = new Date(D.day + "T12:00:00").getDay(), back = (dow - ws + 7) % 7;
    const start = new Date(Date.parse(D.day + "T12:00:00Z") - back * 864e5).toISOString().slice(0, 10);
    const before = H.filter(h => h.personId === id && h.day >= start && h.day < D.day).reduce((t, h) => t + (+h.hours || 0), 0);
    return before + (todayH || 0);
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
        ${T.stations.map(s => raw(html`<tr class="rt-sub"><td><b>${s.label}</b></td><td class="muted">whole station</td><td class="num"><b>${fmtN(s.station.count)}</b></td><td class="num">${s.station.minutes ? fmtH(s.station.minutes / 60) : "—"}${s.station.estimated ? raw(' <small class="c-warn" title="Not on the time clock yet: hours come from the plan until the punches arrive">plan</small>') : ""}</td>
          <td class="num c-${tc(s.station.color)}">${r1(s.station.perHour)}</td><td class="num">${g1(s.station.goal)}</td></tr>
          ${s.people.filter(p => p.count > 0).map(p => raw(html`<tr><td></td><td>${p.name}</td><td class="num">${fmtN(p.count)}</td><td class="num">${p.minutes ? fmtH(p.minutes / 60) : "—"}${p.estimated ? raw(' <small class="c-warn" title="Not on the time clock yet: hours come from the plan until the punches arrive">plan</small>') : ""}</td>
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
      const dueToday = o => localDayOf(o.due) === D.day;   // today's orders only, not ones left from earlier days
      const late = (V.late || []).filter(o => !o.overdue && dueToday(o) && Date.parse(o.due) <= Date.now()), nr = (V.notReady || []).filter(dueToday);
      box.innerHTML = lateCard(late) + (nr.length ? notReadyCard(nr) : "");
    } catch { /* optional */ }
  }
  function trend() {
    const T = D.trend, vals = T.map(x => x.perHour).filter(v => v != null);
    if (vals.length < 2) return html`<p class="muted pad">Builds up as days come in from SMRT and Rippling.</p>`;
    // each bar carries its number (Neal, Oct 15: "just put the number in the bar so I can see it")
    const bars = (key, max, fmt, cls, target, tlabel) => {
      const Wd = 560, H = 150, n = T.length, slot = (Wd - 10) / n, bw = Math.min(46, slot - 8), base = H - 30, Y = v => base - v / max * (base - 18);
      let g = target != null ? `<line class="c-target" x1="0" y1="${Y(target)}" x2="${Wd}" y2="${Y(target)}"/>` : "";
      T.forEach((x, i) => {
        const v = x[key], cx = 6 + i * slot + (slot - bw) / 2, d = new Date(x.day + "T12:00:00");
        g += `<g class="c-bar ${x.day === D.day ? "on" : ""}"><title>${shortDay(x.day)}: ${v == null ? "no data" : fmt(v)}</title>`;
        if (v != null) {
          const y = Y(v), h = Math.max(1, base - y), inside = h >= 18;
          g += `<rect class="${cls(v)}" x="${cx}" y="${y}" width="${bw}" height="${h}" rx="3"/>`;
          g += `<text class="c-bv ${inside ? "in" : ""}" x="${cx + bw / 2}" y="${inside ? y + 13 : y - 4}" text-anchor="middle">${fmt(v)}</text>`;
        }
        g += `<text class="c-lbl" x="${cx + bw / 2}" y="${H - 14}" text-anchor="middle">${d.toLocaleDateString(undefined, { weekday: "short" })}</text><text class="c-lbl" x="${cx + bw / 2}" y="${H - 2}" text-anchor="middle">${d.getMonth() + 1}/${d.getDate()}</text></g>`;
      });
      return `<svg class="rv-bars" viewBox="0 0 ${Wd} ${H}">${g}</svg>`;
    };
    const tph = D.departments?.total?.targetPerHour;
    const pmax = Math.max(...vals, tph || 0) * 1.15;
    let out = `<h3 class="rv-h3">Pieces per paid hour${tph ? ` · <span class="c-warn">target ${tph.toFixed(1)}</span> (dashed line)` : ""}</h3>` + bars("perHour", pmax, v => v.toFixed(1), v => (tph ? (v >= tph ? "b-good" : "b-bad") : "b-info"), tph || null, tph ? `${tph.toFixed(1)} target` : "");
    if (D.money) {
      const pv = T.map(x => x.pct).filter(v => v != null), t = D.labor.target;
      if (pv.length) out += `<h3 class="rv-h3">Labor % of revenue · <span class="c-warn">target ${t}%</span> (dashed line)</h3>` + bars("pct", Math.max(t * 1.4, ...pv), v => v.toFixed(1) + "%", v => (v > t ? "b-bad" : "b-good"), t, `${t}% target`);
    }
    return out;
  }

  // this day's only: follow-ups opened that day (Neal, Oct 15: "this is a Review for today")
  function followups() {
    const F = D.followups, list = F.list.filter(f => localDayOf(f.at) === D.day);
    if (!list.length) return "";
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
