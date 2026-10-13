// Floor: the TV on the plant floor. Shows the published plan replayed minute by minute, live progress from SMRT,
// who should be where right now and what's coming up. English or Spanish (remembered on each screen). Read-only.
// #/floor?tv hides the header for a screen that only ever shows this.
import { api } from "../api.js";
import { html, raw } from "../ui.js";
import * as FM from "../plan/floor.js";
import { CATS } from "../engine/engine.js";
import { SHUTTLES } from "../features.js";

const COLOR = { slt: "#4f8ff7", slt2: "#7aa9fa", slb: "#8b7cf6", dct: "#f59e4b", dcb: "#e2609b", asm: "#22c38e", ops: "#7c879c", comf: "#14b8a6", tc: "#c084fc" };
const CAT_COLOR = { dct: COLOR.dct, dcb: COLOR.dcb, slt: COLOR.slt, slb: COLOR.slb, comf: COLOR.comf, tc: COLOR.tc };
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const nowH = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };
const shortLabel = (l, t) => !l ? l : /starch laundry operator/i.test(l) ? t.opLaundry : /dry cleaning operator/i.test(l) ? t.opDc : l.replace(" (helper)", "");
const first = n => String(n || "").split(" ")[0];

export async function render(main) {
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Loading the floor…</div>`;
  const tvOnly = /[?&]tv\b/.test(location.hash);
  const ac = new AbortController(), on = { signal: ac.signal };
  const root = Symbol("floor"); main._floor = root;
  const alive = () => main._floor === root && document.getElementById("fl-root");
  let lang = store.get("floorLang") === "es" ? "es" : "en";
  let V, SET, pub, day, F = null, seenReady = new Map(), streak = null, streakAt = 0;

  async function load() {
    [V, SET] = await Promise.all([api("/pieces"), SET ? Promise.resolve(SET) : api("/settings")]);
    V.runs = SET.runs;
    day = V.isWorkDay ? V.today : V.next;
    const wantStreak = Date.now() - streakAt > 30 * 60 * 1000;
    const r = await api(`/floor/${day}${wantStreak ? "?streak" : ""}`);
    if (wantStreak) { streak = r.streak || null; streakAt = Date.now(); }
    const sig = r.published?.snapshot?.sig;
    if (!pub || sig !== pub.snapshot?.sig || r.published?.at !== pub.at) { pub = r.published; F = pub ? FM.replay(pub.snapshot) : null; }
  }
  await load();
  if (tvOnly) document.body.classList.add("tv");
  draw();
  const timers = [setInterval(() => { if (!alive()) return stop(); draw(); }, 20 * 1000), setInterval(async () => { if (!alive()) return stop(); try { await load(); draw(); } catch { /* keep showing the last read */ } }, 60 * 1000)];
  function stop() { timers.forEach(clearInterval); ac.abort(); document.body.classList.remove("tv"); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  window.addEventListener("hashchange", () => setTimeout(() => { if (!alive() || !/^#\/floor/.test(location.hash)) { main._floor = null; stop(); } }, 0), on);
  document.addEventListener("fullscreenchange", () => { if (!tvOnly) document.body.classList.toggle("tv", !!document.fullscreenElement); draw(); }, on);

  function draw() {
    if (!document.body.contains(main)) return;
    const t = FM.TXT[lang], now = nowH();
    const clock = new Date().toLocaleTimeString(lang === "es" ? "es-MX" : "en-US", { hour: "numeric", minute: "2-digit" });
    const dayName = new Date(day + "T12:00:00").toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { weekday: "long", month: "long", day: "numeric" });
    const tools = html`<div class="f-tools">${tvOnly ? "" : raw(html`<a class="btn small" href="#/plan">${t.plan}</a>`)}<button class="btn small" id="fl-full">${document.fullscreenElement ? t.exit : t.full}</button><button class="btn small" id="fl-lang" lang="${lang === "es" ? "en" : "es"}">${t.lang}</button></div>`;
    if (!F) {
      main.innerHTML = html`<div id="fl-root" class="floor"><div class="f-band idle"><div class="f-stat">${t.noplan}</div><div class="f-sp"></div><div class="f-clock">${clock}</div>${raw(tools)}</div>
        <div class="f-empty"><h2>${dayName}</h2><p>${t.notPublished}</p></div></div>`;
      wire(); return;
    }
    const isToday = V.isWorkDay && day === V.today;
    const ev = FM.events(F, t), L = SHUTTLES ? FM.liveWaves(pub.snapshot, F, V, now) : [];
    // without shuttles (Neal, Oct 13): the band shows the day, and the panel shows each kind of work
    const st = SHUTTLES ? FM.status(L, F, t) : { cls: "", txt: dayName };
    const Dd = V.days[day] || null, Q = Dd ? (pub.snapshot.input?.q || Dd.q) : null;
    // note when each deadline became ready while this screen was open
    for (const x of L) if (x.ready && !seenReady.has(x.w.id)) seenReady.set(x.w.id, now);
    const live = L.filter(x => x.w.kind !== "overdue");
    const ontime = live.filter(x => x.ready || x.cls !== "bad").length;
    const done = SHUTTLES ? L.reduce((s, x) => s + x.done, 0) : (Dd && isToday ? CATS.reduce((s, k) => s + Math.min(Q[k] || 0, Dd.done?.[k] || 0), 0) : 0), todo = SHUTTLES ? L.reduce((s, x) => s + x.w.todo, 0) : (Q ? CATS.reduce((s, k) => s + (Q[k] || 0), 0) : 0);
    const label = x => x.w.kind === "overdue" ? t.overdue : x.w.name;
    const leftTxt = x => x.leftCats.slice(0, 3).map(([k, v]) => `${FM.fmtN(v)} ${t.cats[k] || k}`).join(" · ");
    // alert: the next deadline within 45 minutes that isn't ready, or one that just became ready
    let alert = "";
    if (isToday && SHUTTLES) {
      const soon = L.filter(x => !x.ready && x.w.kind === "shuttle" && x.w.deadline - now <= 0.75 && x.w.deadline - now > -0.25).sort((a, b) => a.w.deadline - b.w.deadline)[0];
      const just = L.filter(x => x.ready && x.w.kind === "shuttle" && now <= x.w.deadline + 0.25 && now - (seenReady.get(x.w.id) ?? -9) < 1)[0];
      if (soon) { const mins = Math.round((soon.w.deadline - now) * 60);
        alert = html`<div class="f-alert ${mins <= 15 ? "bad" : "warn"}"><span class="f-ck">!</span><b>${label(soon)}: ${FM.fmtN(soon.left)} ${t.notready}</b><span>${t.shuttleWord} ${t.leaves} ${FM.hm(soon.w.deadline)}${mins > 0 ? ` (${mins} ${t.min})` : ""}${leftTxt(soon) ? " · " + leftTxt(soon) : ""}</span></div>`; }
      else if (just) alert = html`<div class="f-alert good"><span class="f-ck">✓</span><b>${label(just)} — ${t.ready}</b><span>${FM.fmtN(just.w.todo)} ${t.pieces} · ${t.okload} ${FM.hm(just.w.deadline)} ${t.shuttleWord}</span></div>`;
    }
    const waves = L.map(x => {
      const w = x.w, tot = CATS.reduce((s, k) => s + (w.q[k] || 0), 0) || 1;
      const whenCls = x.ready ? "good" : x.cls;
      const when = w.kind === "overdue" ? html`<div class="f-when bad">${t.overdue}</div>`
        : html`<div class="f-when ${whenCls}">${w.kind === "route" ? t.route : FM.fmtClock(w.deadline).replace(/ [AP]M/, "")}<small>${w.kind === "shuttle" ? t.shuttle : w.kind === "route" ? "" : t.counter}</small></div>`;
      const em = x.ready ? html`<em class="good">${t.ready}</em>` : w.kind === "overdue" ? html`<em class="warn">${t.first}</em>` : x.passed ? html`<em class="bad">${t.missed}</em>`
        : x.proj != null && isFinite(x.proj) ? html`<em class="${x.cls === "good" ? "" : x.cls}">${x.behindMin >= 5 ? `${Math.round(x.behindMin)} ${t.min} ${t.behind} · ` : ""}${t.readyAbout} ${FM.hm(x.proj)}</em>` : "";
      const fill = x.ready ? html`<div class="f-fill" style="width:100%"><i style="width:100%;background:var(--good)"></i></div>`
        : html`<div class="f-fill" style="width:${(x.frac * 100).toFixed(1)}%">${CATS.filter(k => w.q[k]).map(k => raw(html`<i style="width:${(w.q[k] / tot * 100).toFixed(1)}%;background:${CAT_COLOR[k]}"></i>`))}</div>`;
      const pace = !x.ready && x.exp != null ? html`<div class="f-pace" style="left:${(x.exp * 100).toFixed(1)}%"></div>` : "";
      return html`<div class="f-wave">${raw(when)}<div class="f-wmid"><div class="f-wn">${label(x)} ${raw(em)}</div><div class="f-bar">${raw(fill)}${raw(pace)}</div>
          ${!x.ready && x.leftCats.length ? raw(html`<div class="f-left">${FM.fmtN(x.left)} ${t.left}: ${leftTxt(x)}</div>`) : ""}</div>
        ${isToday ? raw(html`<div class="f-count ${whenCls}">${x.ready ? t.ready : FM.fmtN(x.done)}<small>${t.of} ${FM.fmtN(w.todo)}</small></div>`) : raw(html`<div class="f-count">${FM.fmtN(w.todo)}<small>${t.pieces}</small></div>`)}</div>`;
    }).join("");
    const RN = FM.rightNow(F, ev, isToday ? now : -1); // another day: the opening line-up
    const nextTxt = p => {
      if (p.state === "before") return html`${t.starts} ${FM.hm(p.start)}`;
      if (p.state === "break") return html`${t.brk} → ${FM.hm(p.brkEnd)}`;
      if (p.state === "off") return "";
      const n = p.next; if (!n) return "";
      if (n.kind === "move") return html`<b>${t.to} ${n.label || t.comf} ${FM.hm(n.t)}</b>`;
      if (n.kind === "brk") return html`${t.brk} ${FM.hm(n.t)}`;
      if (n.kind === "home") return html`<b>${t.home} ${FM.hm(n.t)}</b>`;
      if (n.kind === "otx") return html`<b>OT → ${FM.hm(n.t)}</b>`;
      return html`${t.clock} ${FM.hm(n.t)}`;
    };
    const people = RN.map(p => html`<div class="f-now ${p.state}"><div class="f-stn"><i style="background:${COLOR[p.type] || COLOR.ops}"></i>${shortLabel(p.label, t) || t.comf}</div><div class="f-who">${p.nm}</div><div class="f-nx">${raw(nextTxt(p))}</div></div>`).join("");
    const CU = isToday ? FM.comingUp(ev, L, now) : [];
    const work = Q ? CATS.filter(k => (Q[k] || 0) > 0.5).map(k => { const q = Q[k], d = isToday ? Math.min(q, Dd.done?.[k] || 0) : 0, ok = isToday && d >= q - 0.5;
      return html`<div class="f-wave"><div class="f-when ${ok ? "good" : ""}"><i class="f-sw" style="background:${CAT_COLOR[k]}"></i></div><div class="f-wmid"><div class="f-wn">${t.cats[k]} ${ok ? raw(html`<em class="good">${t.ready}</em>`) : ""}</div>
        <div class="f-bar"><div class="f-fill" style="width:${isToday ? (d / q * 100).toFixed(1) : 0}%"><i style="width:100%;background:${CAT_COLOR[k]}"></i></div></div>${isToday && !ok ? raw(html`<div class="f-left">${FM.fmtN(q - d)} ${t.left}</div>`) : ""}</div>
        ${isToday ? raw(html`<div class="f-count ${ok ? "good" : ""}">${FM.fmtN(d)}<small>${t.of} ${FM.fmtN(q)}</small></div>`) : raw(html`<div class="f-count">${FM.fmtN(q)}<small>${t.pieces}</small></div>`)}</div>`; }).join("") : "";
    const evTxt = e => e.kind === "move" ? `${first(e.nm)} ${t.to} ${e.label || t.comf}${e.rot ? ` (${t.rotation})` : ""}` : e.kind === "brk" ? `${first(e.nm)} ${t.brk}` : e.kind === "home" ? `${first(e.nm)} ${t.home}`
      : e.kind === "start" ? `${first(e.nm)} ${t.starts}` : e.kind === "end" || e.kind === "otx" ? `${first(e.nm)} ${t.clock}` : e.kind === "wash" ? e.txt
      : e.kind === "shuttle" ? `${e.w.name} ${t.leaves}${e.ready ? " ✓" : ""}` : e.kind === "back" ? t.back : "";
    main.innerHTML = html`<div id="fl-root" class="floor" lang="${lang === "es" ? "es" : "en"}">
      <div class="f-band ${st.cls}">
        <div class="f-stat">${st.txt}</div>
        ${isToday && live.length && SHUTTLES ? raw(html`<div class="f-big"><b>${ontime} <small>${t.of} ${live.length}</small></b><span>${t.ontime}</span></div>`) : ""}
        ${F.R.empty ? "" : raw(html`<div class="f-big"><b>${FM.hm(F.R.end)}</b><span>${t.doneby}</span></div>`)}
        ${isToday && todo ? raw(html`<div class="f-big"><b>${FM.fmtN(done)} <small>${t.of} ${FM.fmtN(todo)}</small></b><span>${t.done}</span></div>`) : ""}
        <div class="f-sp"></div>${streak && streak.days >= 2 ? raw(html`<div class="f-streak" title="${t.streakTip}">${streak.days} ${t.streakLab} ${streak.target}%</div>`) : ""}<div class="f-clock">${clock}</div>${raw(tools)}
      </div>
      ${raw(alert)}
      <div class="f-main">
        ${SHUTTLES ? raw(html`<section class="f-panel"><h2>${isToday ? t.deadlines : `${t.deadlinesFor} · ${dayName}`}</h2>${L.length ? raw(waves) : raw(html`<p class="f-note">${t.nothing}</p>`)}
          ${isToday && L.some(x => x.exp != null) ? raw(html`<p class="f-note small">${t.pace}</p>`) : ""}</section>`)
          : raw(html`<section class="f-panel"><h2>${isToday ? t.work : `${t.workFor} · ${dayName}`}</h2>${work ? raw(work) : raw(html`<p class="f-note">${t.nothing}</p>`)}</section>`)}
        <section class="f-panel"><h2>${t.now}</h2>${raw(people || '<p class="f-note">—</p>')}</section>
      </div>
      ${isToday ? raw(html`<div class="f-ticker"><span class="f-lbl">${t.coming}</span>${CU.length ? CU.map(g => raw(html`<span class="f-ev ${g.sh ? "sh" : ""}"><b>${FM.hm(g.t)}</b>${g.items.map(evTxt).join(" · ")}</span>`)) : raw('<span class="f-note">—</span>')}</div>`) : ""}
      <p class="f-foot">${t.publishedAt} ${new Date(pub.at).toLocaleString(lang === "es" ? "es-MX" : "en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}${pub.by ? ` · ${pub.by}` : ""}</p>
    </div>`;
    wire();
  }
  function wire() {
    main.querySelector("#fl-lang")?.addEventListener("click", () => { lang = lang === "es" ? "en" : "es"; store.set("floorLang", lang); draw(); });
    main.querySelector("#fl-full")?.addEventListener("click", () => { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch { /* not allowed here */ } });
  }
}
