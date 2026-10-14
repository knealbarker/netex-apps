// Settings: one card per topic, each with its own Save button (enabled once something changes).
// Admins and the Owner can edit; everyone else sees the values read-only.
import { api } from "../api.js";
import { html, raw, toast, RANK, openDialog } from "../ui.js";
import { notifyState, askNotify } from "../alerts.js";
import { SHUTTLES } from "../features.js";

const CAT_NAMES = { dct: "DC tops", dcb: "DC bottoms", slt: "Starch tops", slb: "Starch bottoms", comf: "Comforters", tc: "Tablecloths" };
const CATS = Object.keys(CAT_NAMES);

// [key, label, kind, help, extra]
const GROUPS = [
  { id: "day", title: "Working day", lead: "Work days and the shape of a normal shift.", fields: [
    ["workDays", "Work days", "days", "Plans, due dates and the daily summary skip the other days. SMRT history loads all day on days off."],
    ["defStart", "Default clock-in", "time", "Used when someone has no usual clock-in."],
    ["fullDay", "Full-day working hours", "num", "Hours of work in a full shift, not counting the break.", { step: 0.25, min: 1, max: 14, unit: "h" }],
    ["breakMin", "Paid break", "int", "", { min: 0, max: 120, unit: "min" }],
    ["breakAfter", "Break after", "num", "Hours worked before the break is due.", { step: 0.5, min: 0, max: 12, unit: "h" }],
    ["staggerBreaks", "Stagger breaks", "bool", "So a station is never empty for everyone's break at once."],
    ["spread", "Max finish spread", "int", "How far apart people's finish times may be before the plan rebalances.", { min: 0, max: 240, unit: "min" }],
  ] },
  { id: "staffing", title: "Overtime & moves", lead: "What the plan may do when work runs long or short. Regular time is always used before overtime. Tablecloths are pressed on any open DCT or DCB press.", fields: [
    ["allowOT", "Allow overtime", "bool", ""],
    ["otMax", "Max overtime per person", "num", "", { step: 0.25, min: 0, max: 8, unit: "h" }],
    ["otMult", "Overtime pay multiplier", "num", "", { step: 0.05, min: 1, max: 3, unit: "×" }],
    ["allowMoves", "Move people to other stations", "bool", "When their station's work is done, move them to the busiest station they're trained on."],
    ["allowClockOut", "Clock out when no work is left", "bool", ""],
    ["minPaid", "Minimum paid hours before clock-out", "num", "", { step: 0.25, min: 0, max: 12, unit: "h" }],
    ["comfMax", "People on comforters at once", "num", "Comforters are folded and packaged on one table.", { step: 1, min: 1, max: 4, unit: "people" }],
    ["comfExtra", "Each extra person on comforters adds", "num", "Of one person's speed: 20% means two people do 1.2× as many.", { step: 5, min: 0, max: 100, unit: "%" }],
  ] },
  { id: "money", title: "Labor & prices", lead: "Used for labor as a share of revenue. Prices are updated from SMRT's averages when SMRT is connected.", fields: [
    ["payAvg", "Average hourly pay", "num", "", { step: 0.25, min: 0, max: 200, unit: "$/h" }],
    ["laborTarget", "Labor target", "num", "Labor cost as a percent of the day's revenue.", { step: 0.5, min: 0, max: 100, unit: "%" }],
    ["pdfMoney", "Show revenue & labor on the printed plan", "bool", ""],
    ["prices", "Average price per piece", "perCat", "", { step: 0.01, min: 0, max: 1000, unit: "$" }],
  ] },
  { id: "wash", title: "Washers", lead: "Starch laundry, comforters and tablecloths go through the washers before pressing.", fields: [
    ["on", "Plan around the washers", "bool", ""],
    ["washers", "Number of washers", "int", "", { min: 0, max: 20 }],
    ["delay", "First load ready after", "int", "Minutes after the first clock-in until pressing can start.", { min: 0, max: 240, unit: "min" }],
  ] },
  { id: "route", title: "Route deliveries", lead: "Route orders are due by early morning on the route day, so they're normally finished the work day before.", fields: [
    ["dayBefore", "Plan route orders the work day before they're due", "bool", "Turn off to plan them on their due day like store orders."],
    ["readyBy", "Ready by, on the route day", "time", ""],
  ] },
  { id: "alerts", title: SHUTTLES ? "Shuttle alerts" : "Work week", lead: SHUTTLES ? "Warnings on the floor screen before a shuttle leaves with work still unfinished." : "", fields: [
    ...(SHUTTLES ? [["warnFirst", "First warning", "int", "", { min: 0, max: 240, unit: "min before" }],
    ["warnSecond", "Second warning", "int", "", { min: 0, max: 240, unit: "min before" }],
    ["notify", "Show shuttle alerts", "bool", ""]] : []),
    ["weekStart", "Week starts on", "select", "", { options: [[0, "Sunday"], [1, "Monday"], [6, "Saturday"]] }],
  ] },
  { id: "smrt", title: "SMRT mapping", lead: "Which SMRT departments and item types count toward each kind of work. Item types win over departments (a comforter is a comforter whatever its department).", fields: [
    ["overdue", "Count overdue pieces in today's work", "bool", ""],
    ["transitRack", "Rack location for orders on the van", "text", "Finished orders racked here and not yet racked at the store are listed as \"not checked in at the store\"."],
    ["departments", "SMRT department", "perCatText", "", { placeholder: "none" }],
    ["itemTypes", "SMRT item types (comma-separated)", "perCatText", "", { placeholder: "none" }],
  ] },
  { id: "rippling", title: "Rippling", lead: "Which hours from the Rippling time-clock report belong to production.", fields: [
    ["departments", "Rippling departments", "listText", "Comma-separated, as Rippling spells them."],
    ["useTimes", "Use actual clock-in times", "bool", "Updates the plan with when people really clocked in."],
  ] },
  { id: "summary", title: "Daily summary email", lead: "An end-of-day email: how today went against the plan, the crew from the time clock, and the next work day's pieces, crew and projection.", fields: [
    ["on", "Send the daily summary", "bool", "On work days, once, after the time below."],
    ["to", "Send to", "listText", "Comma-separated. Each address must be verified in Cloudflare (Email Routing › Destination addresses) before it can receive mail."],
    ["at", "Send after", "time", "Central time. Pick a time after the plant has gone home."],
  ] },
  { id: "tally", title: "Station tablets", lead: "A tablet at each starch bottoms press. The manager enters the pairs in each batch taken to IAB; counts go to whoever the plan has on that station. Review checks the day's total against SMRT's assembly.", fields: [
    ["goal", "Station goal", "num", "Pairs per hour for each SLB press. People without their own SLB goal on Team get this one too. Green within 10% of it, yellow 10–20% under, red more than 20% under; it pulses more than 10% over. (Planning speeds are under Stations & speeds.)", { step: 0.5, min: 1, max: 200, unit: "pairs/h" }],
    ["photos", "Take a photo with each count", "bool", "The tablet's front camera, one small picture per count. Admins see them in Review. Tell the pressers before turning it on."],
    ["keepDays", "Keep photos for", "int", "", { min: 1, max: 365, unit: "days" }],
  ] },
  { id: "business", title: "Business", lead: "", fields: [["name", "Business name", "text", "Printed at the top of the plan."]] },
];

const SECTIONS = [["day", "Working day"], ["staffing", "Overtime & moves"], ["money", "Labor & prices"], ["stations", "Stations & speeds"], ["wash", "Washers"], ...(SHUTTLES ? [["runs", "Shuttle runs"]] : []), ["route", "Route deliveries"], ["alerts", SHUTTLES ? "Shuttle alerts" : "Work week"], ["summary", "Daily summary email"], ["tally", "Station tablets"], ["smrt", "SMRT mapping"], ["rippling", "Rippling"], ["business", "Business"], ["import", "Import"]];

export async function render(main, ctx) {
  const { me } = ctx;
  const canEdit = RANK[me.role] >= RANK.admin, isOwner = me.role === "owner";
  main.innerHTML = html`<div class="loading"><span class="spin"></span>Loading settings…</div>`;
  let S = await api("/settings");
  const dis = raw(canEdit ? "" : "disabled");

  const fieldHtml = (g, [key, label, kind, help, x = {}]) => {
    const v = S.groups[g][key], id = `${g}-${key}`;
    const unit = x.unit ? raw(html`<span class="unit">${x.unit}</span>`) : "";
    if (kind === "bool") return html`<label class="switch"><div><b>${label}</b>${help ? raw(html`<small>${help}</small>`) : ""}</div><input type="checkbox" role="switch" name="${key}" ${raw(v ? "checked" : "")} ${dis}></label>`;
    if (kind === "days") {
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], order = [1, 2, 3, 4, 5, 6, 0];
      return html`<fieldset class="field days-field"><legend>${label}</legend>${help ? raw(html`<small>${help}</small>`) : ""}<div class="day-chips">${order.map(d => raw(html`
        <label class="day-chip"><input type="checkbox" name="${key}.${d}" ${raw(v.includes(d) ? "checked" : "")} ${dis}><span>${names[d]}</span></label>`))}</div></fieldset>`;
    }
    if (kind === "perCat" || kind === "perCatText") {
      const textual = kind === "perCatText";
      return html`<fieldset class="field percat"><legend>${label}</legend>${CATS.map(c => raw(html`
        <label><span>${CAT_NAMES[c]}</span><span class="inwrap">${textual ? "" : unit}<input class="input" name="${key}.${c}" ${raw(textual ? 'type="text"' : `type="number" step="${x.step}" min="${x.min}" max="${x.max}"`)}
          value="${v[c] ?? ""}" placeholder="${x.placeholder || ""}" ${dis}></span></label>`))}</fieldset>`;
    }
    const input = kind === "select"
      ? html`<select class="input" name="${key}" id="${id}" ${dis}>${x.options.map(([val, l]) => raw(html`<option value="${val}" ${raw(+v === val ? "selected" : "")}>${l}</option>`))}</select>`
      : html`<input class="input" id="${id}" name="${key}" ${raw(kind === "time" ? 'type="time"' : kind === "text" || kind === "listText" ? 'type="text"' : `type="number" step="${x.step || 1}" min="${x.min}" max="${x.max}"`)}
          value="${kind === "listText" ? v.join(", ") : v}" ${dis}>`;
    return html`<label class="field row-field" for="${id}"><span>${label}${help ? raw(html`<small>${help}</small>`) : ""}</span><span class="inwrap">${raw(input)}${unit}</span></label>`;
  };

  const extras = {
    alerts: () => SHUTTLES ? html`<div class="sum-status" id="notifyLine"></div>` : "",
    summary: () => canEdit ? html`<div class="sum-status" id="sumStatus">${raw(summaryStatus())}</div>
      <div class="set-actions"><button type="button" class="btn small" id="sumPreview">Preview today's email</button><button type="button" class="btn small" id="sumTest">Send a test now</button></div>` : "",
    rippling: () => canEdit ? html`<div class="sum-status">${raw(ripStatus())}</div>` : "",
    money: () => canEdit && S.status ? html`<div class="sum-status">${raw(payLine())}</div>` : "",
    tally: () => canEdit ? html`<div id="tabList" class="tab-list"><p class="muted small">Loading tablets…</p></div>` : "",
  };
  const fmtWhen = iso => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  function summaryStatus() {
    const st = S.status || {}, L = st.summary, T = st.summaryTest;
    const parts = [];
    if (!st.emailReady) parts.push('<span class="bad">●</span> Email sending isn\'t switched on for the planner yet.');
    if (L) parts.push(L.sent?.length ? html`<span class="ok">●</span> Last sent ${fmtWhen(L.at)} to ${L.sent.join(", ")}${L.failed?.length ? ` · not delivered to ${L.failed.map(f => f.to).join(", ")}` : ""}` : html`<span class="bad">●</span> ${fmtWhen(L.at)}: couldn't send — ${L.failed?.[0]?.error || "unknown error"}`);
    else parts.push("Not sent yet.");
    if (T) parts.push(html`Last test ${fmtWhen(T.at)}: ${T.sent?.length ? `sent to ${T.sent.join(", ")}` : `failed — ${T.failed?.[0]?.error || ""}`}`);
    return parts.join("<br>");
  }
  function ripStatus() {
    const r = S.status?.rippling, p = S.status?.payRates;
    if (!r) return "No time clock report from Rippling yet.";
    return html`Last report ${fmtWhen(r.at)} (${r.rows} rows). ${r.rateColumn ? raw(html`<span class="ok">●</span> Pay rates read from the “${r.rateColumn}” column`) : raw('<span class="bad">●</span> The report has no pay rate column yet — add “Pay rate” to the Rippling report to cost labor per person')}${p ? ` · ${p.withRate} of ${p.people} people on the team have a rate.` : "."}`;
  }
  function payLine() {
    const p = S.status.payRates;
    return p.withRate ? html`Labor is costed with each person's pay rate from Rippling (${p.withRate} of ${p.people} people have one); the average below is used for anyone without one.` : "Rippling hasn't sent pay rates yet, so labor is costed at the average below.";
  }
  const groupCard = g => html`<section class="card set-card" id="sec-${g.id}" data-group="${g.id}">
      <header><h2>${g.title}</h2>${g.lead ? raw(html`<p>${g.lead}</p>`) : ""}</header>${raw(extras[g.id] ? extras[g.id]() : "")}
      <form class="set-form" novalidate>${g.fields.map(f => raw(fieldHtml(g.id, f)))}
        ${canEdit ? raw('<div class="set-foot"><span class="saved-note" aria-live="polite"></span><button class="btn primary" type="submit" disabled>Save</button></div>') : ""}</form></section>`;

  function readGroup(g, form) {
    const out = {};
    for (const [key, , kind] of g.fields) {
      const el = form.elements;
      if (kind === "bool") out[key] = el[key].checked;
      else if (kind === "days") out[key] = [0, 1, 2, 3, 4, 5, 6].filter(d => el[`${key}.${d}`].checked);
      else if (kind === "perCat") out[key] = Object.fromEntries(CATS.map(c => [c, +el[`${key}.${c}`].value]));
      else if (kind === "perCatText") out[key] = Object.fromEntries(CATS.map(c => [c, el[`${key}.${c}`].value]));
      else if (kind === "num" || kind === "int" || kind === "select") out[key] = el[key].value === "" ? null : +el[key].value;
      else if (kind === "listText") out[key] = el[key].value.split(",").map(s => s.trim()).filter(Boolean);
      else out[key] = el[key].value;
    }
    return out;
  }

  // ---------- stations & speeds ----------
  const rate = (type, cat) => S.rates.find(r => r.type === type && r.category === cat)?.perHour ?? "";
  const SPEEDS = [["slt", "slt", "Starch tops press, alone"], ["slt_helper", "slt", "Starch tops press with a helper (pair total)"], ["slb", "slb", "Starch bottoms press"],
    ["dct", "dct", "Dry cleaning tops press"], ["dcb", "dcb", "Dry cleaning bottoms press"], ["tc", "tc", "Tablecloths, per person"],
    ["asm", "*", "Assembly (IAB), items"], ["comf", "comf", "Comforters, per person"]];
  const stationsCard = () => html`<section class="card set-card" id="sec-stations">
      <header><h2>Stations & speeds</h2><p>Pieces per hour at a steady pace. Max hours limits how long a station may run in a day (blank = no limit).</p></header>
      <form class="set-form" novalidate data-kind="production">
        <fieldset class="field"><legend>Speeds</legend><div class="speed-list">${SPEEDS.map(([t, c, l]) => raw(html`
          <label class="row-field"><span>${l}</span><span class="inwrap"><input class="input" type="number" min="0.1" step="0.5" name="rate.${t}.${c}" value="${rate(t, c === "*" ? "dct" : c)}" ${dis}><span class="unit">/h</span></span></label>`))}</div></fieldset>
        <fieldset class="field"><legend>Stations</legend>
          <div class="st-table"><div class="st-head"><span>Station</span><span>Max hours</span><span>In use</span></div>
          ${S.stations.map(s => raw(html`<div class="st-row"><input class="input" name="label.${s.code}" value="${s.label}" maxlength="40" aria-label="Name for ${s.code}" ${dis}>
            <input class="input" type="number" min="0.5" max="24" step="0.5" name="max.${s.code}" value="${s.maxHours ?? ""}" placeholder="no limit" aria-label="Max hours for ${s.label}" ${dis}>
            <input type="checkbox" name="active.${s.code}" ${raw(s.active ? "checked" : "")} aria-label="${s.label} in use" ${dis}></div>`))}</div></fieldset>
        <fieldset class="field"><legend>Goes through assembly</legend><div class="checks">${S.categories.map(c => raw(html`
          <label class="check"><input type="checkbox" name="asm.${c.id}" ${raw(c.needsAssembly ? "checked" : "")} ${dis}> ${c.name}</label>`))}</div></fieldset>
        <fieldset class="field"><legend>Wash programs</legend><div class="wash-table"><div class="st-head"><span>Kind</span><span>Pieces per load</span><span>Cycle</span></div>
          ${S.wash.map(w => raw(html`<div class="st-row"><span>${CAT_NAMES[w.category]}</span>
            <span class="inwrap"><input class="input" type="number" min="1" name="load.${w.category}" value="${w.perLoad}" ${dis}></span>
            <span class="inwrap"><input class="input" type="number" min="1" name="cycle.${w.category}" value="${w.cycleMin}" ${dis}><span class="unit">min</span></span></div>`))}</div></fieldset>
        ${canEdit ? raw('<div class="set-foot"><span class="saved-note" aria-live="polite"></span><button class="btn primary" type="submit" disabled>Save</button></div>') : ""}
      </form></section>`;
  function readProduction(form) {
    const el = form.elements, v = n => el[n]?.value;
    const rates = [];
    for (const [t, c] of SPEEDS) for (const cat of c === "*" ? CATS : [c]) rates.push({ type: t, category: cat, perHour: +v(`rate.${t}.${c}`) });
    return {
      rates,
      stations: S.stations.map(s => ({ code: s.code, label: v(`label.${s.code}`), maxHours: v(`max.${s.code}`) === "" ? null : +v(`max.${s.code}`), active: el[`active.${s.code}`].checked })),
      categories: S.categories.map(c => ({ id: c.id, needsAssembly: el[`asm.${c.id}`].checked })),
      wash: S.wash.map(w => ({ category: w.category, perLoad: +v(`load.${w.category}`), cycleMin: +v(`cycle.${w.category}`) })),
    };
  }

  // ---------- shuttle runs ----------
  let runs = structuredClone(S.runs);
  const runsCard = () => html`<section class="card set-card" id="sec-runs">
      <header><h2>Shuttle runs</h2><p>When work has to be done for each store. Pieces dropped off before a store's cutoff are due back on the next run.</p></header>
      <form class="set-form" novalidate data-kind="runs"><div id="runList">${runs.map((r, i) => raw(runHtml(r, i)))}</div>
        ${canEdit ? raw(html`<button type="button" class="btn ghost add-run">+ Add a run</button>
          <div class="set-foot"><span class="saved-note" aria-live="polite"></span><button class="btn primary" type="submit" disabled>Save</button></div>`) : ""}</form></section>`;
  const runHtml = (r, i) => html`<div class="run" data-i="${i}">
      <div class="run-head"><input class="input run-name" name="name" value="${r.name}" placeholder="Run name" aria-label="Run name" ${dis}>
        <select class="input" name="kind" aria-label="Kind" ${dis}><option value="shuttle" ${raw(r.kind === "shuttle" ? "selected" : "")}>Shuttle</option><option value="counter" ${raw(r.kind === "counter" ? "selected" : "")}>Store counter</option></select>
        <span class="inwrap" title="Minutes to drive back to the workshop"><input class="input" type="number" min="0" name="driveBack" value="${r.driveBack ?? ""}" aria-label="Drive back minutes" ${dis}><span class="unit">min back</span></span>
        ${canEdit ? raw('<button type="button" class="btn ghost danger del-run" aria-label="Remove run">Remove</button>') : ""}</div>
      <div class="stops"><div class="stop st-head"><span>Store</span><span>Drop-off cutoff</span><span>${r.kind === "counter" ? "Ready by" : "Arrives"}</span><span>Drive</span><span>Stop</span><span></span></div>
      ${r.stops.map((s, j) => raw(html`<div class="stop" data-j="${j}"><input class="input" name="store" value="${s.store}" aria-label="Store" ${dis}>
        <input class="input" type="time" name="cutoff" value="${s.cutoff || ""}" aria-label="Drop-off cutoff" ${dis}>
        <input class="input" type="time" name="arrive" value="${s.arrive}" aria-label="Arrives" ${dis}>
        <span class="inwrap"><input class="input" type="number" min="0" name="drive" value="${s.drive}" aria-label="Drive minutes" ${dis}><span class="unit">min</span></span>
        <span class="inwrap"><input class="input" type="number" min="0" name="stay" value="${s.stay}" aria-label="Stop minutes" ${dis}><span class="unit">min</span></span>
        ${canEdit ? raw('<button type="button" class="btn ghost del-stop" aria-label="Remove stop">×</button>') : "<span></span>"}</div>`))}</div>
      ${canEdit ? raw('<button type="button" class="btn ghost add-stop">+ Add stop</button>') : ""}</div>`;
  function readRuns(form) {
    return [...form.querySelectorAll(".run")].map(el => {
      const r = runs[+el.dataset.i], q = n => el.querySelector(`.run-head [name="${n}"]`).value;
      return { id: r.id, name: q("name"), kind: q("kind"), driveBack: q("driveBack") === "" ? null : +q("driveBack"),
        stops: [...el.querySelectorAll(".stop[data-j]")].map(s => { const g = n => s.querySelector(`[name="${n}"]`).value; return { store: g("store"), cutoff: g("cutoff") || null, arrive: g("arrive"), drive: +g("drive") || 0, stay: +g("stay") || 0 }; }) };
    });
  }

  const importCard = () => !isOwner ? "" : html`<section class="card set-card" id="sec-import">
      <header><h2>Import from the desktop planner</h2><p>Brings over the team, trainings, settings and plan history. Safe to run again: it updates the same people and days instead of adding copies.</p></header>
      <form class="set-form" novalidate data-kind="import">
        <label class="field"><span>planner-data.json</span><input class="input" type="file" name="data" accept=".json,application/json"><small>On the office PC: %APPDATA%\\Production Planner\\planner-data.json</small></label>
        <label class="field"><span>Plan History files <em>(optional)</em></span><input class="input" type="file" name="history" accept=".json,application/json" multiple><small>Documents\\Production Planner\\Plan History — select them all.</small></label>
        <div class="import-result" hidden></div>
        <div class="set-foot"><span class="saved-note" aria-live="polite"></span><button class="btn primary" type="submit" disabled>Import</button></div>
      </form></section>`;

  main.innerHTML = html`
    <div class="page-head"><div><h1>Settings</h1><p>${canEdit ? "Changes apply to every PC as soon as you save." : "Only Admins can change settings."}</p></div></div>
    <div class="settings-layout">
      <nav class="set-nav" aria-label="Settings sections">${SECTIONS.filter(([id]) => id !== "import" || isOwner).map(([id, l]) => raw(html`<a href="#/settings" data-jump="sec-${id}">${l}</a>`))}</nav>
      <div class="set-cards">
        ${["day", "staffing", "money"].map(id => raw(groupCard(GROUPS.find(g => g.id === id))))}${raw(stationsCard())}${raw(groupCard(GROUPS.find(g => g.id === "wash")))}
        ${SHUTTLES ? raw(runsCard()) : ""}${["route", "alerts", "summary", "tally", "smrt", "rippling", "business"].map(id => raw(groupCard(GROUPS.find(g => g.id === id))))}${raw(importCard())}
      </div>
    </div>`;

  // this PC's pop-up notifications for shuttle alerts
  function drawNotify() {
    const el = main.querySelector("#notifyLine"); if (!el) return;
    const s2 = notifyState();
    el.innerHTML = s2 === "granted" ? '<span class="ok">●</span> Pop-up notifications are on for this PC.'
      : s2 === "denied" ? '<span class="bad">●</span> Notifications are blocked for this site in this browser. Allow them in the browser\'s site settings to get pop-ups.'
      : s2 === "unsupported" ? "This browser can't show pop-up notifications; alerts show inside the planner."
      : html`Alerts show inside the planner. ${raw('<button type="button" class="linkish" id="notifyOn">Also show Windows pop-ups on this PC</button>')}`;
    el.querySelector("#notifyOn")?.addEventListener("click", async () => { await askNotify(); drawNotify(); });
  }
  drawNotify();
  main.querySelector("#sumPreview")?.addEventListener("click", async e => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const m = await api("/summary/preview");
      const dlg = openDialog({ title: m.subject, submitLabel: "Close", body: html`<div class="sum-preview">${raw(m.html.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, ""))}</div>`, onSubmit: () => {} });
      dlg.classList.add("wide"); dlg.querySelector("[data-close]").hidden = true;
    } catch (x) { toast(x.message, "bad"); } finally { b.disabled = false; }
  });
  main.querySelector("#sumTest")?.addEventListener("click", () => openDialog({
    title: "Send a test summary now?", submitLabel: "Send",
    body: html`<p class="dlg-lead">Today's summary, as it stands right now.</p><label class="field"><span>Send to</span><input class="input" name="to" type="email" value="${S.groups.summary.to[0] || ""}" required>
      <small>Must be verified in Cloudflare › Email Routing › Destination addresses.</small></label>`,
    async onSubmit(form) {
      const r = await api("/summary/send", { method: "POST", body: { to: form.to.value } });
      S = await api("/settings"); const st = main.querySelector("#sumStatus"); if (st) st.innerHTML = summaryStatus();
      if (!r.sent.length) throw new Error(r.failed[0]?.error || "Not sent.");
      toast(`Sent to ${r.sent.join(", ")}.`);
    },
  }));

  main.querySelectorAll("[data-jump]").forEach(a => a.addEventListener("click", e => {
    e.preventDefault(); const t = document.getElementById(a.dataset.jump);
    t.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    t.querySelector("input:not([disabled]),select:not([disabled])")?.focus({ preventScroll: true });
  }));

  // ---------- station tablets (Admins): pair with a code once; the tablet stays signed in until removed here ----------
  async function drawTablets() {
    const box = main.querySelector("#tabList"); if (!box) return;
    let D;
    try { D = await api("/station-devices"); } catch (x) { box.innerHTML = html`<p class="muted small">${x.message}</p>`; return; }
    const seen = d => d.lastSeen ? `seen ${new Date(d.lastSeen).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "not seen yet";
    box.innerHTML = html`${D.devices.length ? raw(html`<div class="tab-rows">${D.devices.map(d => raw(html`<div class="tab-row">
        <span class="chip">${d.label}</span><b>${d.name}</b>
        <span class="muted small">${d.codeUntil ? `waiting for its code (until ${new Date(d.codeUntil).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })})` : d.paired ? `paired · ${seen(d)}` : "not paired"}</span>
        <span class="tab-act"><button type="button" class="btn ghost small" data-tcode="${d.id}">New code</button><button type="button" class="btn ghost small danger" data-tdel="${d.id}">Remove</button></span></div>`))}</div>`)
      : raw('<p class="muted small">No tablets yet.</p>')}
      <div class="set-actions"><button type="button" class="btn small" id="tabAdd">Add a tablet</button></div>
      <p class="muted small">On the tablet, open <b>prodplanner.netexcleaners.com/station</b> in Fully Kiosk Browser and enter the code. Cloudflare Access must let /station through (a Bypass application); the tablet's own pairing keeps the data private.</p>`;
    const showCode = (r, label) => openDialog({ title: `Pairing code for ${label}`, submitLabel: "Done",
      body: html`<p class="dlg-lead">Enter this on the tablet within 15 minutes. It works once.</p><div class="pair-code">${r.code.slice(0, 3)} ${r.code.slice(3)}</div>`, onSubmit: () => drawTablets() });
    box.querySelector("#tabAdd").addEventListener("click", () => openDialog({
      title: "Add a station tablet", submitLabel: "Get a code",
      body: html`<label class="field"><span>Station</span><select class="input" name="station">${D.stations.map(s => raw(html`<option value="${s.code}">${s.label}</option>`))}</select></label>
        <label class="field"><span>Name <em>(optional)</em></span><input class="input" name="name" maxlength="40" placeholder="SLB 1 tablet"></label>`,
      async onSubmit(f) { const r = await api("/station-devices", { method: "POST", body: { station: f.station.value, name: f.name.value } }); setTimeout(() => showCode(r, D.stations.find(s => s.code === f.station.value)?.label || ""), 0); },
    }));
    box.querySelectorAll("[data-tcode]").forEach(b => b.addEventListener("click", async () => {
      const d = D.devices.find(x => x.id === b.dataset.tcode);
      try { showCode(await api(`/station-devices/${d.id}/code`, { method: "POST" }), d.label); } catch (x) { toast(x.message, "bad"); }
    }));
    box.querySelectorAll("[data-tdel]").forEach(b => b.addEventListener("click", () => {
      const d = D.devices.find(x => x.id === b.dataset.tdel);
      openDialog({ title: `Remove ${d.name}?`, submitLabel: "Remove", body: html`<p class="dlg-lead">The tablet stops working right away. Its counts stay. To use it again, add it and pair it with a new code.</p>`,
        async onSubmit() { await api(`/station-devices/${d.id}`, { method: "DELETE" }); toast("Tablet removed."); drawTablets(); } });
    }));
  }
  drawTablets();

  // dirty tracking + save, per card
  main.querySelectorAll(".set-form").forEach(form => {
    const btn = form.querySelector('button[type="submit"]'), note = form.querySelector(".saved-note");
    const mark = () => { if (btn) { btn.disabled = false; note.textContent = "Unsaved changes"; note.className = "saved-note dirty"; } };
    form.addEventListener("input", mark); form.addEventListener("change", mark);
    form.addEventListener("submit", async e => {
      e.preventDefault(); if (!btn || btn.disabled) return;
      btn.disabled = true; note.textContent = "Saving…"; note.className = "saved-note";
      const kind = form.dataset.kind, g = form.closest("[data-group]")?.dataset.group;
      try {
        if (kind === "production") { Object.assign(S, await api("/settings/production", { method: "PUT", body: readProduction(form) })); }
        else if (kind === "runs") { const r = await api("/settings/runs", { method: "PUT", body: { runs: readRuns(form) } }); S.runs = r.runs; runs = structuredClone(r.runs); form.querySelector("#runList").innerHTML = runs.map((x, i) => runHtml(x, i)).join(""); }
        else if (kind === "import") { await doImport(form); }
        else { const r = await api(`/settings/${g}`, { method: "PUT", body: readGroup(GROUPS.find(x => x.id === g), form) }); S.groups[g] = r[g]; }
        note.textContent = kind === "import" ? "Imported" : "Saved"; note.className = "saved-note ok";
        if (kind !== "import") toast("Saved.");
      } catch (x) { btn.disabled = false; note.textContent = x.message; note.className = "saved-note bad"; }
    });
  });

  // run editor buttons
  const runForm = main.querySelector('[data-kind="runs"]');
  runForm?.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || b.type === "submit") return;
    runs = readRuns(runForm);
    const i = +b.closest(".run")?.dataset.i;
    if (b.classList.contains("add-run")) runs.push({ name: "", kind: "shuttle", driveBack: 30, stops: [{ store: "", cutoff: null, arrive: "12:00", drive: 30, stay: 15 }] });
    else if (b.classList.contains("del-run")) runs.splice(i, 1);
    else if (b.classList.contains("add-stop")) runs[i].stops.push({ store: "", cutoff: null, arrive: "12:00", drive: 15, stay: 15 });
    else if (b.classList.contains("del-stop")) runs[i].stops.splice(+b.closest(".stop").dataset.j, 1);
    else return;
    runForm.querySelector("#runList").innerHTML = runs.map((x, k) => runHtml(x, k)).join("");
    runForm.dispatchEvent(new Event("change"));
  });

  async function doImport(form) {
    const dataFile = form.elements.data.files[0];
    if (!dataFile) throw new Error("Choose planner-data.json first.");
    const readJson = async f => { try { return JSON.parse(await f.text()); } catch { throw new Error(`${f.name} isn't a valid JSON file.`); } };
    const data = await readJson(dataFile);
    const history = await Promise.all([...form.elements.history.files].map(readJson));
    const r = await api("/import/desktop", { method: "POST", body: { data, history } });
    const box = form.querySelector(".import-result");
    box.hidden = false;
    box.innerHTML = html`<b>Imported.</b> ${r.peopleAdded} people added, ${r.peopleUpdated} updated, ${r.trainings} trainings, ${r.settings} settings groups, ${r.runs} runs,
      ${r.planDays} past plans and ${r.hoursRows} days of hours.${r.skipped.length ? raw(html`<br><small>Skipped: ${r.skipped.join("; ")}</small>`) : ""}`;
    S = await api("/settings");
    toast("Import finished. Check the Team page.");
  }
}
