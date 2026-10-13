// Review: how a day went against its plan — pieces, hours, people, follow-ups, and the trend.
import { api } from "../api.js";
import { html, raw, toast, RANK } from "../ui.js";
import { fmtClock, hm, fmtH, fmtN, fmt$ } from "../engine/engine.js";
import * as M from "../plan/model.js";
import { SHUTTLES } from "../features.js";

const SMRT_ORDER = (customer, no) => `https://towncountryclean.smrtapp.com/posx/dash/customer/clothestracker/${encodeURIComponent(customer)}/?saleId=${String(no).replace(/\D/g, "")}`;
const longDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const shortDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const stamp = s => { if (!s) return "—"; const m = /^(\d{4}-\d{2}-\d{2})[T ](\d\d):(\d\d)/.exec(s); return m ? `${shortDay(m[1])} ${fmtClock(+m[2] + +m[3] / 60)}` : s; };
const mins = h => Math.round(h * 60);
let pick = null;

export async function render(main, ctx) {
  const can = RANK[ctx.me.role] >= RANK.manager, admin = RANK[ctx.me.role] >= RANK.admin;
  let NX = null; // the next work day's projection, kept while moving between days
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Adding up the day…</div>`;
  const asked = (location.hash.match(/[?&]day=(\d{4}-\d{2}-\d{2})/) || [])[1];
  if (asked) pick = asked;
  // first visit: today once the day has started, otherwise the last work day
  const d0 = new Date(), localDay = new Date(d0.getTime() - d0.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  let D = await api(`/review/${pick && pick <= localDay ? pick : localDay}`);
  if (!pick && (!D.isWorkDay || (D.labor.hours === 0 && D.done.pieces === 0))) D = await api(`/review/${D.prev}`);
  pick = D.day;
  draw();
  // today: refresh every 2 minutes while this page is open (not while someone is typing a follow-up note)
  const me = Symbol("review"); main._rv = me;
  const timer = setInterval(async () => {
    if (main._rv !== me || !document.getElementById("rv-root")) return clearInterval(timer);
    if (!D.isToday || main.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    try { D = await api(`/review/${pick}`); draw(); } catch { /* next time */ }
  }, 120000);

  async function go(day) { main.querySelector("#rv-root")?.classList.add("busy"); pick = day; D = await api(`/review/${day}`); draw(); }

  function draw() {
    const W = SHUTTLES ? D.deadlines.filter(w => w.kind !== "route" && w.deadline != null) : [], nowH = (() => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; })();
    const pending = w => D.isToday && w.readyAt == null && nowH < w.deadline;
    const onTime = W.filter(w => w.readyAt != null && w.readyAt <= w.deadline + 1 / 60);
    const late = W.filter(w => !(w.readyAt != null && w.readyAt <= w.deadline + 1 / 60) && !pending(w));
    const L = D.labor, pct = L.pct;
    const bits = [];
    if (W.length) bits.push(late.length ? `${late.map(w => w.name).join(", ")} ${late.length === 1 ? "was" : "were"} late` : W.some(pending) ? `${onTime.length} of ${W.length} deadlines met so far` : "every deadline met");
    if (D.due.pieces) bits.push(`${fmtN(D.due.finished)} of ${fmtN(D.due.pieces)} due pieces finished`);
    if (pct != null) bits.push(pct <= L.target ? `labor ${pct.toFixed(1)}%, under target` : `labor ${pct.toFixed(1)}%`);
    const good = !late.length && D.due.finished >= D.due.pieces && (pct == null || pct <= L.target);
    const head = bits.length ? `${D.isToday ? "So far: " : ""}${bits.join(" · ")}` : "No pieces or hours recorded for this day";
    const lastOut = Math.max(-1, ...D.people.filter(p => p.actualOut != null).map(p => p.actualOut)), stillIn = D.people.some(p => p.stillIn);
    const tiles = [
      ...(SHUTTLES ? [{ v: W.length ? `${onTime.length} of ${W.length}` : "—", c: W.length && !late.length ? "good" : late.length ? "bad" : "", s: "deadlines ready on time" }] : []),
      { v: fmtN(D.done.pieces), s: "pieces assembled" },
      { v: D.due.pieces ? `${fmtN(D.due.finished)}` : "—", s: D.due.pieces ? `of ${fmtN(D.due.pieces)} due, finished` : "pieces due", c: D.due.pieces && D.due.finished < D.due.pieces ? "warn" : "" },
      { v: L.hours ? fmtH(L.hours) : "—", s: `labor · ${L.people} ${L.people === 1 ? "person" : "people"}` },
      { v: L.perHour != null ? L.perHour.toFixed(1) : "—", s: "pieces per labor hour" },
      ...(D.money ? [{ v: pct != null ? pct.toFixed(1) + "%" : "—", c: pct == null ? "" : pct <= L.target ? "good" : "bad", s: `labor of revenue · target ${L.target}%` }] : []),
      { v: lastOut >= 0 ? hm(lastOut) : "—", s: `last out${stillIn ? " (some still in)" : ""}${D.planned?.metrics?.end != null ? ` · plan ${hm(D.planned.metrics.end)}` : ""}` },
    ];
    main.innerHTML = html`<div id="rv-root">
      <div class="page-head"><div><h1>${D.isToday ? "Today" : "Review"}</h1><p>${longDay(D.day)}${D.isToday ? " · so far, live from SMRT and the time clock" : ""}</p></div>
        <div class="head-actions day-nav">
          <button class="icon-btn" id="rv-prev" title="Previous work day" aria-label="Previous work day">‹</button>
          <label class="sr" for="rv-date">Day</label><input class="input" type="date" id="rv-date" value="${D.day}" max="${D.today}">
          <button class="icon-btn" id="rv-next" title="Next work day" aria-label="Next work day" ${D.next ? "" : "disabled"}>›</button>
        </div></div>
      <section class="verdict ${!bits.length ? "idle" : good ? "ok" : late.length || (pct != null && pct > L.target) ? "bad" : "warn"}"><div class="v-head"><span class="v-ico" aria-hidden="true">${!bits.length ? "…" : good ? "✓" : "!"}</span><b>${head[0].toUpperCase() + head.slice(1)}</b></div></section>
      <section class="tiles rv-tiles">${tiles.map(x => raw(html`<div class="tile"><b class="t-num ${x.c ? "c-" + x.c : ""}">${x.v}</b><span class="t-sub">${x.s}</span></div>`))}</section>
      ${D.money && L.avgHours > 0.05 ? raw(html`<p class="muted small rv-note">Labor cost uses each person's pay rate from Rippling; ${fmtH(L.avgHours)} of ${fmtH(L.hours)} ${L.avgHours >= L.hours - 0.05 ? "are" : "is"} costed at the average ${fmt$(L.payAvg)}/h because Rippling hasn't sent a rate for ${L.avgHours >= L.hours - 0.05 ? "anyone yet" : "everyone"}.</p>`) : ""}
      <div class="rv-grid">
        <section class="card pl-card rv-hours"><header class="pl-cardhead"><div><h2>By the hour</h2><p>Pieces assembled in SMRT each hour${D.isToday ? ", so far" : ""}. Assembly runs behind pressing, so spurts follow batches.</p></div></header>${raw(byHour())}</section>
        <section class="card pl-card"><header class="pl-cardhead"><div><h2>Pieces through the day</h2><p>Assembled in SMRT, counted as they happened${D.planned?.metrics?.end != null ? ", against the published plan's pace" : ""}.</p></div></header>${raw(chart())}</section>
        ${SHUTTLES ? raw(html`<section class="card pl-card"><header class="pl-cardhead"><div><h2>Deadlines</h2><p>When the last piece for each was assembled.</p></div></header>${raw(deadlines())}</section>`) : ""}
        <section class="card pl-card"><header class="pl-cardhead"><div><h2>Plan vs. actual</h2><p>${D.planned ? `${D.planned.source === "published" ? `Published${D.planned.by ? ` by ${D.planned.by}` : ""}` : "Saved, not published"}; actual times from Rippling. Differences of 10 minutes or more are shown.` : "No plan was saved for this day."}</p></div></header>${raw(people())}</section>
        <section class="card pl-card" id="rv-nextday"><header class="pl-cardhead"><div><h2>Next work day · ${shortDay(D.nextWork)}</h2><p>Pieces to plan for, the crew and the projection.</p></div>
          <a class="btn small primary" href="#/plan?day=${D.nextWork}">Open ${new Date(D.nextWork + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" })}'s plan</a></header><div id="rv-nextday-body"><p class="muted pad">Working it out…</p></div></section>
        <section class="card pl-card"><header class="pl-cardhead"><div><h2>Last ${D.trend.length} work days</h2><p>Pieces assembled per labor hour${D.money ? ", and labor % of revenue" : ""}.</p></div></header>${raw(trend())}</section>
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

  // the next work day: its saved crew (or a suggestion from history) planned with the pieces known now
  async function nextDay() {
    const day = D.nextWork, el = () => main.querySelector("#rv-nextday-body");
    try {
      if (!NX || NX.day !== day) {
        const [V, SET, TEAM, plan] = await Promise.all([api(`/pieces?day=${day}`), api("/settings"), api("/team"), api(`/plan/${day}`)]);
        NX = { day, N: M.projectDay({ SET, TEAM, V, plan, day, admin }), target: SET.groups.money.laborTarget };
      }
      const N = NX.N, box = el(); if (!box || D.nextWork !== day) return;
      if (!N) { box.innerHTML = html`<p class="muted pad">No pieces due that day yet.</p>`; return; }
      box.innerHTML = html`<div class="rv-next">
          <div><b>${N.expected ? "~" : ""}${fmtN(N.pieces)}</b><span>pieces to plan for${N.expected ? ` · ${fmtN(N.known)} known now` : ""}</span></div>
          <div><b>${N.crew.length}</b><span>people · ${N.suggested ? "suggested" : "planned"}</span></div>
          <div><b class="${N.short > 0.5 ? "c-bad" : ""}">${N.end != null ? hm(N.end) : "—"}</b><span>projected done by</span></div>
          ${admin ? raw(html`<div><b class="${N.pct == null ? "" : N.pct <= NX.target ? "c-good" : "c-bad"}">${N.pct != null ? N.pct.toFixed(1) + "%" : "—"}</b><span>projected labor</span></div>`) : ""}
        </div>
        <p class="muted small">Crew: ${N.basis}.${N.otH > 0.04 ? ` ${fmtH(N.otH)} overtime.` : ""}${N.short > 0.5 ? ` ${fmtN(N.short)} pieces wouldn't get done.` : ""}</p>`;
    } catch (e) { const box = el(); if (box) box.innerHTML = html`<p class="muted pad">Couldn't work out the next day: ${e.message}</p>`; }
  }

  function chart() {
    const C = D.done.curve;
    if (C.length < 2) return html`<p class="muted pad">${D.isToday ? "Fills in as pieces are assembled." : "No pieces were assembled this day."}</p>`;
    const m = D.planned?.metrics, total = Math.max(C[C.length - 1][1], m?.pieces || 0, D.due.pieces || 0, 1), top = total * 1.06;
    const t0 = Math.floor(Math.min(C[0][0], m?.firstStart ?? 24)), t1 = Math.ceil(Math.max(C[C.length - 1][0], m?.end ?? 0, t0 + 6));
    const Wd = 560, Ht = 260, L = 44, R = 548, T = 14, B = 232, X = t => L + (t - t0) / (t1 - t0) * (R - L), Y = v => B - v / top * (B - T);
    const step = top > 1500 ? 500 : top > 600 ? 200 : top > 200 ? 100 : top > 60 ? 20 : 5;
    let g = "";
    for (let v = 0; v <= top; v += step) g += `<line class="c-grid" x1="${L}" y1="${Y(v)}" x2="${R}" y2="${Y(v)}"/><text class="c-lbl" x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${fmtN(v)}</text>`;
    for (let t = t0; t <= t1; t += 2) g += `<text class="c-lbl" x="${X(t)}" y="${B + 18}" text-anchor="middle">${hm(t)}</text>`;
    if (D.due.pieces) g += `<line class="c-due" x1="${L}" y1="${Y(D.due.pieces)}" x2="${R}" y2="${Y(D.due.pieces)}"/><text class="c-lbl" x="${L + 4}" y="${Y(D.due.pieces) - 5}">${fmtN(D.due.pieces)} due</text>`;
    if (m && m.firstStart != null && m.end != null && m.pieces) g += `<polyline class="c-plan" points="${X(m.firstStart)},${Y(0)} ${X(m.end)},${Y(m.pieces)}"/>`;
    const pts = [[C[0][0] - 0.25, 0], ...C].map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(" "), last = C[C.length - 1];
    g += `<polyline class="c-done" points="${pts}"/><circle class="c-dot" cx="${X(last[0])}" cy="${Y(last[1])}" r="4.5"/>`;
    g += `<text class="c-end" x="${Math.min(X(last[0]), R - 4)}" y="${Math.max(T + 12, Y(last[1]) - 10)}" text-anchor="end">${fmtN(last[1])} by ${hm(last[0])}</text>`;
    return `<svg class="rv-chart" viewBox="0 0 ${Wd} ${Ht}" role="img" aria-label="${fmtN(last[1])} pieces assembled by ${hm(last[0])}">${g}</svg>
      <div class="g-legend"><span><i class="k-done"></i>Assembled</span>${m && m.end != null ? '<span><i class="k-plan"></i>Plan pace</span>' : ""}${D.due.pieces ? '<span><i class="k-due"></i>Due this day</span>' : ""}</div>`;
  }

  // pieces assembled per clock hour, starch bottoms first (Neal, Oct 13: watch the bottleneck through the day)
  function byHour() {
    const H = D.done.byHour || {}, hours = Object.keys(H).map(Number).sort((a, b) => a - b);
    if (!hours.length) return html`<p class="muted pad">${D.isToday ? "Fills in as pieces are assembled." : "No pieces were assembled this day."}</p>`;
    const cols = [["slb", "Starch bottoms"], ["slt", "Starch tops"], ["dct", "DC tops"], ["dcb", "DC bottoms"], ["other", "Other"]];
    const v = (h, k) => k === "other" ? (H[h].comf || 0) + (H[h].tc || 0) : (H[h][k] || 0);
    const all = []; for (let h = hours[0]; h <= hours[hours.length - 1]; h++) all.push(h);
    const top = Math.max(1, ...all.map(h => (H[h] ? v(h, "slb") : 0)));
    const sum = k => all.reduce((t, h) => t + (H[h] ? v(h, k) : 0), 0);
    const nowH = new Date().getHours();
    return html`<div class="hr-scroll"><table class="hr-tbl"><thead><tr><th>Hour</th>${cols.map(([, l], i) => raw(html`<th class="${i === 0 ? "neck" : ""}">${l}</th>`))}<th>All</th></tr></thead><tbody>
      ${all.map(h => { const row = H[h] || {}; const tot = Object.values(row).reduce((a, b) => a + b, 0), slb = H[h] ? v(h, "slb") : 0;
        return raw(html`<tr class="${D.isToday && h === nowH ? "now" : ""}"><th>${hm(h)}–${hm(h + 1).replace(/ [AP]M/, "")}</th>
          <td class="neck"><span class="hr-bar" style="--w:${Math.round(slb / top * 100)}%"></span><b>${slb || "·"}</b></td>${cols.slice(1).map(([k]) => raw(html`<td>${(H[h] ? v(h, k) : 0) || "·"}</td>`))}<td>${tot || "·"}</td></tr>`); })}
      </tbody><tfoot><tr><th>Total</th>${cols.map(([k], i) => raw(html`<td class="${i === 0 ? "neck" : ""}"><b>${fmtN(sum(k))}</b></td>`))}<td><b>${fmtN(D.done.pieces)}</b></td></tr></tfoot></table></div>`;
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
  function deadlines() {
    if (!D.deadlines.length) return html`<p class="muted pad">No orders were due this day.</p>`;
    const rows = D.deadlines.map(w => {
      const pend = D.isToday && w.readyAt == null && w.deadline != null && (() => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; })() < w.deadline;
      const sl = w.readyAt != null && w.deadline != null ? mins(w.deadline - w.readyAt) : null;
      const cls = w.readyAt == null ? (pend ? "" : "bad") : w.deadline == null ? "good" : sl < 0 ? "bad" : sl < 15 ? "warn" : "good";
      const txt = w.readyAt == null ? (pend ? `${fmtN(w.left)} left` : `${fmtN(w.left)} not finished`) : `${fmtClock(w.readyAt)}${sl != null ? (sl < 0 ? ` · ${-sl} min late` : ` · ${sl} min spare`) : ""}`;
      return html`<tr><td>${w.kind === "route" ? "Route" : w.deadline != null ? hm(w.deadline) : "—"}</td><td><b>${w.name}</b><small>${w.stores.join(", ")}</small></td>
        <td class="c-${cls}">${txt}</td><td class="muted">${w.plannedEta != null && isFinite(w.plannedEta) ? hm(w.plannedEta) : "—"}</td><td class="num">${fmtN(w.pieces)}</td></tr>`;
    }).join("");
    return html`<div class="t-scroll"><table class="rt"><thead><tr><th>Due</th><th>Run</th><th>Ready</th><th>Plan said</th><th class="num">Pieces</th></tr></thead><tbody>${raw(rows)}</tbody></table></div>`;
  }

  function people() {
    if (!D.planned && !D.people.length) return "";
    const diff = p => {
      if (p.unplanned) return { cls: "warn", txt: "Not in the plan" };
      if (p.missing) return D.isToday && p.plannedIn != null && (() => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; })() < p.plannedIn + 0.25 ? { cls: "", txt: "Not in yet" } : { cls: "bad", txt: "Didn't clock in" };
      const a = [], dIn = mins(p.actualIn - p.plannedIn), dOut = p.actualOut != null && p.plannedOut != null ? mins(p.actualOut - p.plannedOut) : 0;
      if (dIn >= 10) a.push(`in ${dIn} min late`); else if (dIn <= -10) a.push(`in ${-dIn} min early`);
      if (dOut >= 10) a.push(`out ${dOut} min late`); else if (dOut <= -10) a.push(`out ${-dOut} min early`);
      return a.length ? { cls: "warn", txt: a.join(", ") } : null;
    };
    const rows = D.people.map(p => ({ p, d: diff(p) })), shown = rows.filter(r => r.d), same = rows.length - shown.length;
    if (!shown.length) return html`<p class="muted pad">Everyone matched the plan within 10 minutes.</p>`;
    return html`<div class="t-scroll"><table class="rt"><thead><tr><th>Person</th><th>Planned</th><th>Actual</th><th></th></tr></thead><tbody>
      ${shown.map(({ p, d }) => raw(html`<tr><td><b>${p.name}</b><small>${p.station || ""}</small></td>
        <td>${p.plannedIn != null ? `${hm(p.plannedIn)}–${hm(p.plannedOut)}` : "—"}</td>
        <td>${p.actualIn != null ? `${hm(p.actualIn)}–${p.actualOut != null ? hm(p.actualOut) : "…"}` : "—"}${p.actualHours ? raw(html`<small>${fmtH(p.actualHours)}</small>`) : ""}</td>
        <td class="c-${d.cls}">${d.txt}</td></tr>`))}</tbody></table></div>${same ? raw(html`<p class="muted small">${same} more matched the plan within 10 minutes.</p>`) : ""}`;
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
        <span class="chip ${o.onVan ? "admin" : ""}">${o.onVan ? "On the van · not checked in" : o.shuttle && SHUTTLES ? "Assembled · still at the plant, next shuttle" : "Assembled · not racked as ready"}</span></div>
      <div class="l-meta"><span>${o.loc}</span><span>Due ${new Date(o.due).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span><span>${o.pieces} pieces</span><span>${o.status}</span></div>
    </div>`))}</div></details></section>`;
}
