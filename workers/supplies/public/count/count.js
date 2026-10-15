// The count page on a store / Laundry Hub / Workshop device: pair once with a code, then
// name (first name + last initial) -> count -> review -> send. Answers are kept on the device while counting,
// so a reload or a dead battery doesn't lose them.
import { esc, plural, renderSheet } from "./form.js";

const $ = s => document.querySelector(s);
const main = $("#main");
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};
let S = null;            // device state from the server
let who = null;          // { name } once checked
let sheet = null;

class ApiError extends Error { constructor(status, body) { super(body?.error || `Request failed (${status}).`); this.status = status; this.body = body || {}; } }
async function api(path, { method = "GET", body } = {}) {
  let res;
  try { res = await fetch(`/count/api${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" }); }
  catch { throw new ApiError(0, { error: "Can't reach the internet. Your answers are saved on this device — try again in a minute." }); }
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : {};
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
function toast(msg, kind = "ok") {
  const el = document.createElement("div"); el.className = `toast ${kind}`; el.innerHTML = `<i></i><span>${esc(msg)}</span>`;
  $("#toasts").append(el); setTimeout(() => el.remove(), 5000);
}
const day = iso => new Date(iso.length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const draftKey = () => `supplies-draft-${S.location.id}`;
const warehouse = () => S.location.role === "warehouse";

// ------------------------------------------------------------ screens
function pairScreen(err = "") {
  $("#locName").textContent = "Set up this device"; $("#sub").textContent = "Supply count · Town & Country Cleaners";
  main.innerHTML = `<form class="ct-card" id="pair" novalidate>
      <h1>Set up this device for supply counts</h1>
      <p>Ask the supply manager for a 6-digit code (Supplies › Setup › Counting devices). You only do this once per device.</p>
      <label class="field"><span>Code</span><input class="input big" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" required></label>
      <p class="form-error" ${err ? "" : "hidden"}>${esc(err)}</p>
      <button class="btn primary wide" type="submit">Set up</button>
    </form>`;
  const f = $("#pair"); f.elements.code.focus();
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = f.querySelector("button"); btn.disabled = true;
    try { S = await api("/pair", { method: "POST", body: { code: f.elements.code.value } }); toast(`This device now counts for ${S.location.label}.`); whoScreen(); }
    catch (x) { pairScreen(x.message); }
  });
}

function header() {
  $("#locName").textContent = S.location.label;
  $("#sub").textContent = warehouse() ? "Workshop inventory" : "Supply count";
  document.title = `${S.location.label} · Supply count`;
}

function requestBanner() {
  const r = S.requests[0];
  if (!r) return "";
  return `<div class="ct-banner"><b>Count requested${r.requestedBy ? ` by ${esc(r.requestedBy.split(" ")[0])}` : ""}</b>
    ${r.dueOn ? `<span>Due ${esc(day(r.dueOn))}</span>` : ""}${r.note ? `<span>${esc(r.note)}</span>` : ""}</div>`;
}

function whoScreen(err = "") {
  header();
  if (!S.location.active) { main.innerHTML = `<div class="ct-card"><h1>Counting is turned off here</h1><p>The supply manager has turned off supply counts for ${esc(S.location.label)}.</p></div>`; return; }
  const draft = store.get(draftKey());
  const fresh = draft && Date.now() - draft.at < 36 * 3600e3 && Object.keys(draft.answers || {}).length;
  main.innerHTML = `${requestBanner()}
    <form class="ct-card" id="who" novalidate>
      <h1>${warehouse() ? "Workshop inventory" : "Supply count"}</h1>
      <p>${S.items.length} items · takes a few minutes. ${S.lastCount ? `Last count ${esc(day(S.lastCount.at))} by ${esc(S.lastCount.who)}.` : "No counts yet."}</p>
      <label class="field"><span>Your name</span>
        <input class="input big" name="name" autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="First name + last initial, like KarlaV" value="${esc(fresh ? draft.name : "")}" required>
      </label>
      <p class="form-error" ${err ? "" : "hidden"}>${esc(err)}</p>
      <button class="btn primary wide" type="submit">${fresh ? `Keep going (${Object.keys(draft.answers).length} answered)` : "Start counting"}</button>
      ${fresh ? `<button class="btn ghost wide" type="button" id="discard">Start over instead</button>` : ""}
    </form>`;
  const f = $("#who");
  if (!f.elements.name.value) f.elements.name.focus();
  $("#discard")?.addEventListener("click", () => { store.del(draftKey()); whoScreen(); });
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    try { who = await api("/who", { method: "POST", body: { name: f.elements.name.value } }); countScreen(fresh ? draft.answers : {}); }
    catch (x) { if (x.status === 401) return pairScreen(x.message); whoScreen(x.message); $("#who").elements.name.value = f.elements.name.value; }
  });
}

function countScreen(answers) {
  header();
  main.innerHTML = `${requestBanner()}
    <div class="ct-hello">Counting as <b>${esc(who.name)}</b> · <button class="linkish" id="notme" type="button">Not you?</button></div>
    <p class="ct-howto">${warehouse()
      ? "Count what's on the shelf in the unit shown. Skip anything you're not counting today — only answered items are saved."
      : "Count what's on hand. For <b>Out / Low / OK</b> items just tap one. Anything you skip isn't asked for."}</p>
    <div id="sheet"></div>
    <div class="ct-bar"><span id="prog"></span><button class="btn primary" id="review" type="button">Review &amp; send</button></div>`;
  const save = A => { store.set(draftKey(), { name: who.name, answers: A, at: Date.now() }); paintProgress(); };
  sheet = renderSheet($("#sheet"), { items: S.items, warehouse: warehouse(), answers, onChange: save });
  const paintProgress = () => { const p = sheet.progress(); $("#prog").innerHTML = `<b>${p.done}</b> of ${p.total} answered`; };
  paintProgress();
  $("#notme").addEventListener("click", () => { who = null; whoScreen(); });
  $("#review").addEventListener("click", () => reviewScreen());
}

function reviewScreen(err = "") {
  const lines = sheet.lines(), needs = lines.filter(l => l.need > 0), draft = store.get(draftKey()) || {};
  main.innerHTML = `<div class="ct-card">
      <h1>${warehouse() ? "Check and send" : "Check your list"}</h1>
      <p>${lines.length} of ${S.items.length} items answered.
        ${warehouse() ? "The supply manager gets the items that are short for ordering." : `These go on the shuttle list for <b>${esc(S.location.label)}</b>.`}</p>
      ${needs.length ? `<ul class="ct-needs">${needs.map(n => `<li><span>${esc(n.name)}</span><b>${esc(plural(n.need, n.unit))}</b></li>`).join("")}</ul>`
        : `<p class="ct-ok">Nothing is short — everything answered is at or above its par.</p>`}
      <label class="field"><span>Anything else you need? <em>(optional)</em></span>
        <textarea class="input" id="note" rows="3" maxlength="1000" placeholder="Items not on the list, broken equipment, notes for the supply manager">${esc(draft.note || "")}</textarea></label>
      <p class="form-error" ${err ? "" : "hidden"}>${esc(err)}</p>
      <div class="ct-actions"><button class="btn ghost" id="back" type="button">Back to the count</button><button class="btn primary" id="send" type="button">Send</button></div>
    </div>`;
  main.focus();
  $("#note").addEventListener("input", e => store.set(draftKey(), { ...(store.get(draftKey()) || {}), note: e.target.value, at: Date.now() }));
  $("#back").addEventListener("click", () => countScreen(sheet.answers()));
  $("#send").addEventListener("click", async () => {
    $("#send").disabled = true;
    try {
      const r = await api("/submit", { method: "POST", body: { name: who.name, note: $("#note").value, lines: lines.map(({ item, qty, level }) => ({ item, qty, level })) } });
      store.del(draftKey()); doneScreen(r);
    } catch (x) { if (x.status === 401) return pairScreen(x.message); reviewScreen(x.message); }
  });
}

async function doneScreen(r) {
  main.innerHTML = `<div class="ct-card ct-done">
      <div class="ct-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <h1>Sent — thank you, ${esc(who.name.split(" ")[0])}!</h1>
      <p>${r.counted} item${r.counted === 1 ? "" : "s"} counted.
        ${r.role === "warehouse" ? (r.needs.length ? `${r.needs.length} item${r.needs.length === 1 ? " is" : "s are"} short and go to the supply manager's order list.` : "Nothing is short.")
          : (r.needs.length ? `${r.needs.length} item${r.needs.length === 1 ? "" : "s"} will be packed for the shuttle.` : "Nothing needed this time.")}</p>
      <button class="btn primary wide" id="again" type="button">Done</button>
    </div>`;
  who = null;
  $("#again").addEventListener("click", load);
}

async function load() {
  try {
    S = await api("/state");
    if (!S.paired) return pairScreen();
    whoScreen();
  } catch (x) {
    main.innerHTML = `<div class="ct-card"><h1>Can't load the count</h1><p>${esc(x.message)}</p><button class="btn primary wide" id="retry" type="button">Try again</button></div>`;
    $("#retry").addEventListener("click", load);
  }
}
load();
window.addEventListener("unhandledrejection", e => toast(e.reason?.message || "Something went wrong.", "bad"));
