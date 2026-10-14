// Station tablet: the starch bottoms press's count of pairs, entered each time a batch goes to IAB (Neal, Oct 14).
// The server works everything out (who's on the station from the plan, clock-ins, pace and colors); this page shows it
// and sends the counts. It talks only to /station/api, with the tablet's own paired cookie (no user sign-in).
const $ = s => document.querySelector(s);
const app = $("#app"), cam = $("#cam"), toastEl = $("#toast");
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ESC[c]);
const clock = min => { if (min == null) return "—"; let h = Math.floor(min / 60) % 24; const m = min % 60, ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${ap}`; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const first = n => String(n || "").split(" ")[0];
const rate = v => (v == null ? "—" : v >= 100 ? String(Math.round(v)) : v.toFixed(1));
const goal = v => (v == null ? "—" : Number.isInteger(+v) ? String(v) : (+v).toFixed(1));

let S = null;            // the server's view of this station
let typed = "";          // digits on the display
let confirmBig = false;  // a count over 40 needs a second tap
let padOpen = false, padT = null;   // the number pad shows only while entering a count (Neal: more room for the numbers)
let busy = false, holding = false, offline = false, lastOk = Date.now();
let pairCode = "", pairErr = "";

async function call(path, { method = "GET", body, raw } = {}) {
  const r = await fetch(`/station/api${path}`, { method, credentials: "same-origin", headers: raw ? { "content-type": "image/jpeg" } : body ? { "content-type": "application/json" } : {}, body: raw || (body ? JSON.stringify(body) : undefined) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.reason === "unpaired") { S = { paired: false }; draw(); }
  if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return data;
}
function toast(msg, bad = false, ms = 2600) {
  toastEl.textContent = msg; toastEl.className = `toast${bad ? " bad" : ""}`; toastEl.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { toastEl.hidden = true; }, ms);
}

async function refresh() {
  try {
    const was = S && S.day;
    S = await call(`/state?${clientInfo()}`); offline = false; lastOk = Date.now();
    if (was && S.day && S.day !== was) return location.reload(); // a new day: start fresh (and pick up any new version)
  }
  catch (e) { if (e.status !== 401) offline = true; }
  if (!holding) draw();
  if (S && S.paired && S.photos) startCamera(); else stopCamera();
}

// ------------------------------------------------------------ drawing
function draw() {
  if (!S) return;
  if (!S.paired) return drawPair();
  const T = S.totals, P = S.person, M = S.mine;
  const status = !P ? "No one is on this station in the plan" :
    P.status === "upcoming" && !P.clockedIn ? `Planned from ${clock(P.from)}` :
    !P.clockedIn ? (S.opened ? "Opened for counts before the time clock showed them" : "Not clocked in yet") :
    !P.onNow ? `Clocked out — break or done` : `Clocked in ${clock(P.firstIn)}`;
  const goalTxt = P ? `${P.ownGoal ? "Own goal" : "Goal"} ${goal(P.goal)}/hr` : "";
  const sinceLast = T.lastMin != null ? nowMin() - T.lastMin : null;
  const boostVars = b => b > 0 ? `--dur:${(1.4 - 0.85 * b).toFixed(2)}s;--s0:${(1 + 0.04 * b).toFixed(3)};--s1:${(1.04 + 0.08 * b).toFixed(3)}` : "";
  app.innerHTML = `
    <header class="head">
      <span class="st-chip">${esc(S.station.label)}</span>
      <div class="who"><b>${esc(P ? P.name : "No one planned")}</b><small>${esc(status)}${P && P.clockedIn ? ` · ${esc(goalTxt)}` : ""}${S.planSource === "suggested" ? " · from the suggested plan" : ""}</small></div>
      <div class="clock">${esc(clock(nowMin()))}<small>${S.photos ? `<span class="dot ${cam.classList.contains("on") ? "on" : ""}"></span>${cam.classList.contains("on") ? "Camera on" : "Camera off"} · ` : ""}<span class="dot ${offline ? "bad" : "ok"}"></span>${offline ? "Offline" : "Online"}</small></div>
    </header>
    <main class="main">
      ${offline ? `<div class="banner bad">No connection — counts can't be saved right now. They'll work again as soon as the internet is back.</div>` : ""}
      <div class="tile ${T.color} ${T.boost > 0 ? "boost" : ""}" style="${boostVars(T.boost)}" aria-label="Station today">
        <div class="lbl"><span>${esc(S.station.label)} today</span><span>Goal ${esc(goal(T.goal))}/hr</span></div>
        <div class="nums">
          <div class="big">${T.count}</div>
          <div class="rate">${esc(rate(T.perHour))}<em>/hr</em></div>
          <div class="big-sub">pairs</div>
          <div class="rate-sub">${T.pct != null ? `${Math.round(T.pct * 100)}% of goal` : "per hour"}</div>
        </div>
        <div class="foot">
          ${T.lastHour ? `<span class="hour"><i class="${T.lastHour.color}"></i>Last hour ${esc(rate(T.lastHour.perHour))}/hr</span>` : ""}
          <span class="stale">${T.lastMin == null ? "Starts with the first batch to IAB" : `Last count ${clock(T.lastMin)}${sinceLast > 1 ? ` · ${sinceLast} min ago` : ""}`}</span>
        </div>
      </div>
      <div class="bar">
        ${M ? `<div class="mine ${M.color} ${M.boost > 0 ? "boost" : ""}" style="${boostVars(M.boost)}">
            <div class="m-name">${esc(first(P.name))}'s own<small>since moving here · ${M.ownGoal ? "own goal" : "goal"} ${esc(goal(M.goal))}/hr</small></div>
            <div class="m-num">${M.count}<em>pairs</em></div>
            <div class="m-rate ${M.color}">${esc(rate(M.perHour))}<small>/hr</small></div>
          </div>` : ""}
        <div class="recent">${S.entries.slice(0, M ? 1 : 2).map(e => `<div><span>${esc(clock(e.minute))}</span><b>${e.count}</b><span>${esc(e.name ? first(e.name) : "")}</span>${e.undo ? `<button class="undo" data-undo="${esc(e.id)}">Undo</button>` : "<span></span>"}</div>`).join("")}</div>
        ${S.locked ? `<div class="lockbar"><div><b>${P ? `Waiting for ${esc(first(P.name))} to clock in` : "No one on this station in the plan"}</b>
            <small>${P ? `Counts open when the time clock shows them in${S.clockAsOf ? ` (as of ${esc(clock(new Date(S.clockAsOf).getHours() * 60 + new Date(S.clockAsOf).getMinutes()))})` : ""}` : "Put someone on it in the Plan, or count anyway"}</small></div>
            <button class="hold" id="hold"><i></i><span>${P ? "Hold: they're clocked in" : "Hold: count anyway"}</span></button></div>`
          : `<button class="enter" data-open="1"><span class="plus">+</span>Enter pairs${P ? `<small>for ${esc(first(P.name))}</small>` : ""}</button>`}
      </div>
    </main>
    ${padOpen && !S.locked ? `<div class="pad-wrap" data-close="1"><section class="pad" aria-label="Enter a count">
        <div class="entry-lbl"><span>Pairs going to IAB${P ? ` · ${esc(first(P.name))}` : ""}</span><button class="pad-x" data-close="1" aria-label="Close">✕</button></div>
        <div class="display ${typed ? "" : "empty"} ${confirmBig ? "warn" : ""}" id="disp">${typed || "0"}</div>
        <div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key" data-k="${n}">${n}</button>`).join("")}
          <button class="key back" data-k="back" aria-label="Backspace">⌫</button><button class="key" data-k="0">0</button>
          <button class="key save ${confirmBig ? "confirm" : ""}" data-k="save" ${typed && +typed > 0 && !busy ? "" : "disabled"}>${confirmBig ? `Yes, ${esc(typed)}` : "Save"}</button></div>
      </section></div>` : ""}`;
}
function drawPair() {
  app.innerHTML = `<div class="pair">
      <h1>Pair this tablet</h1>
      <p>On a PC, open the planner › Settings › Station tablets › <b>Add a tablet</b> (or <b>New code</b>), then enter the 6-digit code here. It stays paired; nobody has to sign in each day.</p>
      <section class="right">
        <div class="display ${pairCode ? "" : "empty"}">${esc(pairCode.padEnd(6, "·"))}</div>
        <div class="err">${esc(pairErr)}</div>
        <div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key" data-p="${n}">${n}</button>`).join("")}
          <button class="key back" data-p="back" aria-label="Backspace">⌫</button><button class="key" data-p="0">0</button>
          <button class="key save" data-p="go" ${pairCode.length === 6 && !busy ? "" : "disabled"}>Pair</button></div>
      </section></div>`;
}

// ------------------------------------------------------------ input
app.addEventListener("click", async e => {
  const k = e.target.closest("[data-k]")?.dataset.k, p = e.target.closest("[data-p]")?.dataset.p, u = e.target.closest("[data-undo]")?.dataset.undo;
  if (p) return pairKey(p);
  if (u) return undo(u);
  if (e.target.closest("[data-open]") && S && !S.locked) return openPad();
  if (e.target.closest(".pad-x") || e.target.matches(".pad-wrap")) return closePad();
  if (!k || !S || S.locked) return;
  if (k === "save") return save();
  confirmBig = false; idlePad();
  if (k === "back") typed = typed.slice(0, -1);
  else if (typed.length < 3) typed = (typed + k).replace(/^0+(?=\d)/, "");
  draw();
});
async function pairKey(p) {
  pairErr = "";
  if (p === "back") pairCode = pairCode.slice(0, -1);
  else if (p === "go") {
    busy = true; drawPair();
    try { S = await call("/pair", { method: "POST", body: { code: pairCode } }); pairCode = ""; toast(`Paired as ${S.station.label}`); }
    catch (x) { pairErr = x.message; pairCode = ""; }
    busy = false; draw(); if (S.paired && S.photos) startCamera();
    return;
  } else if (pairCode.length < 6) pairCode += p;
  drawPair();
}
function openPad() { padOpen = true; typed = ""; confirmBig = false; idlePad(); draw(); }
function closePad() { padOpen = false; typed = ""; confirmBig = false; clearTimeout(padT); draw(); }
// an open pad nobody is using closes itself after 45 seconds
function idlePad() { clearTimeout(padT); padT = setTimeout(() => { if (padOpen && !busy) closePad(); }, 45000); }
async function save() {
  const n = +typed; if (!(n > 0) || busy) return;
  if (n > 40 && !confirmBig) { confirmBig = true; draw(); return; } // a big batch: one more tap to be sure
  busy = true; draw();
  try {
    const r = await call("/count", { method: "POST", body: { count: n } });
    S = r.state; typed = ""; confirmBig = false; offline = false; padOpen = false; clearTimeout(padT);
    toast(`Saved ${n} ${n === 1 ? "pair" : "pairs"}${S.person ? ` · ${first(S.person.name)}` : ""}`);
    if (S.photos) photo(r.id);
  } catch (x) { toast(x.status ? x.message : "Not saved — no connection. Try again.", true, 4000); if (!x.status) offline = true; }
  busy = false; draw();
}
async function undo(id) {
  try { S = await call(`/count/${id}`, { method: "DELETE" }); toast("Taken back"); } catch (x) { toast(x.message, true); }
  draw();
}
// "Hold: they're clocked in" — a long press, so it isn't tapped by accident
app.addEventListener("pointerdown", e => {
  const b = e.target.closest("#hold"); if (!b) return;
  holding = true; b.classList.add("go");
  const t = setTimeout(async () => {
    holding = false;
    try { S = await call("/open", { method: "POST" }); toast("Counting is open"); } catch (x) { toast(x.message, true); }
    draw();
  }, 1600);
  const end = () => { clearTimeout(t); holding = false; b.classList.remove("go"); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
});
// a USB keypad or keyboard works too
window.addEventListener("keydown", e => {
  if (!S) return;
  if (!S.paired) { if (/^\d$/.test(e.key)) pairKey(e.key); else if (e.key === "Backspace") pairKey("back"); else if (e.key === "Enter" && pairCode.length === 6) pairKey("go"); return; }
  if (S.locked) return;
  if (/^\d$/.test(e.key) && !padOpen) { padOpen = true; typed = ""; }
  if (e.key === "Escape" && padOpen) return closePad();
  if (/^\d$/.test(e.key) && typed.length < 3) { idlePad(); confirmBig = false; typed = (typed + e.key).replace(/^0+(?=\d)/, ""); draw(); }
  else if (e.key === "Backspace") { confirmBig = false; typed = typed.slice(0, -1); draw(); }
  else if (e.key === "Enter") save();
});

// ------------------------------------------------------------ the front camera: one small photo per count
let stream = null, camTried = 0;
async function startCamera() {
  if (stream || !navigator.mediaDevices?.getUserMedia || Date.now() - camTried < 60000) return;
  camTried = Date.now();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    cam.srcObject = stream; cam.classList.add("on");
    stream.getVideoTracks()[0]?.addEventListener("ended", () => { stream = null; cam.classList.remove("on"); });
  } catch (e) { stream = null; cam.classList.remove("on"); camDenied = e && e.name === "NotAllowedError"; }
  draw();
}
function stopCamera() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; cam.classList.remove("on"); } }
async function photo(id) {
  if (!stream || !cam.videoWidth) return;
  try {
    const w = 480, h = Math.round(w * cam.videoHeight / cam.videoWidth), c = document.createElement("canvas");
    c.width = w; c.height = h; c.getContext("2d").drawImage(cam, 0, 0, w, h);
    const blob = await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.7));
    if (blob) await call(`/count/${id}/photo`, { method: "POST", raw: blob });
  } catch { /* the count is saved either way */ }
}

// how this tablet is running, sent with each check-in so Settings can show "camera on · full screen"
function clientInfo() {
  const mode = matchMedia("(display-mode: fullscreen)").matches ? "fullscreen" : matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser";
  const cam = !S || !S.photos ? "none" : stream ? "on" : camDenied ? "denied" : "off";
  return new URLSearchParams({ mode, cam, wake: wake ? "on" : "off" }).toString();
}
let camDenied = false;

// ------------------------------------------------------------ installed as a full-screen app; screen stays on
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/station/sw.js", { scope: "/station/" }).catch(() => {});
let wake = null;
async function keepAwake() {
  try { if (!wake && navigator.wakeLock && document.visibilityState === "visible") { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } } catch { wake = null; }
}
keepAwake();
document.addEventListener("visibilitychange", keepAwake);
document.addEventListener("pointerdown", keepAwake, { passive: true });

// ------------------------------------------------------------ keep it current
refresh();
setInterval(refresh, 20000);
setInterval(() => { if (!holding && S && S.paired) draw(); }, 30000);                // the clock, and "min ago"
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setInterval(() => { if (Date.now() - lastOk > 6 * 3600e3) location.reload(); }, 600000); // pick up a new version after a long outage
