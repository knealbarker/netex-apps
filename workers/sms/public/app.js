// Texts page. All data comes from /api, which checks the sign-in and this app's role (Admins and the Owner).
async function api(path, opts = {}) {
  let res;
  try { res = await fetch(`/api${path}`, { credentials: "same-origin", ...opts, headers: opts.body ? { "content-type": "application/json" } : {} }); }
  catch { throw new Error("Can't reach the app. Check the internet connection."); }
  if (!(res.headers.get("content-type") || "").includes("application/json")) throw new Error("Your sign-in has expired. Reload the page to sign in again.");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pretty = p => { const d = String(p || "").replace(/\D/g, ""); return d.length === 11 && d[0] === "1" ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : p; };
const when = iso => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ERR = { 30034: "number not registered yet", 30007: "blocked by the carrier", 30003: "phone off or unreachable", 30005: "unknown number", 30006: "landline", 21610: "they texted STOP", 21211: "not a valid number" };

let phone = null, oldest = null, opted = new Set();

function row(m) {
  const who = m.name ? `${m.name} · ${pretty(m.phone)}` : pretty(m.phone);
  const tags = [];
  if (m.direction === "out") {
    tags.push(`<span class="tag">${esc(m.app_name || m.app_id)}${m.sent_by_name ? " · " + esc(m.sent_by_name) : ""}</span>`);
    const bad = ["failed", "undelivered"].includes(m.status);
    tags.push(`<span class="tag${bad ? " bad" : ""}">${esc(m.status || "?")}${m.error_code ? " · " + esc(ERR[m.error_code] || "error " + m.error_code) : ""}</span>`);
  } else {
    if (m.keyword) tags.push(`<span class="tag${m.keyword === "STOP" ? " bad" : ""}">${esc(m.keyword)}</span>`);
    tags.push(`<span class="tag">${m.route === "reply" ? "reply to " + esc(m.app_name || m.app_id) : m.route === "unrouted" ? "not a reply" : "keyword"}</span>`);
    if (!m.handled_at) tags.push(`<span class="tag new">new</span>`);
    if (m.media_count) tags.push(`<span class="tag">${m.media_count} picture${m.media_count > 1 ? "s" : ""}</span>`);
  }
  if (opted.has(m.phone) && m.direction === "in" && m.keyword === "STOP") tags.push(`<span class="tag bad">opted out</span>`);
  const done = m.direction === "in" && !m.handled_at ? `<button class="done" data-id="${m.id}">Mark done</button>` : "";
  return `<li class="${m.direction}"><span class="dir">${m.direction === "in" ? "←" : "→"}</span>
    <div class="head"><a href="#" data-phone="${esc(m.phone)}">${esc(who)}</a><span>${when(m.created_at)}</span>${tags.join("")}${done}</div>
    <div class="text">${esc(m.body) || "<i class=muted>(no text)</i>"}</div></li>`;
}

async function load(append = false) {
  const q = new URLSearchParams();
  if (phone) q.set("phone", phone);
  if (append && oldest) q.set("before", oldest);
  const r = await api(`/messages?${q}`);
  opted = new Set(r.optedOut);
  const html = r.messages.map(row).join("");
  $("msgs").innerHTML = append ? $("msgs").innerHTML + html : (html || `<li class="muted">No texts yet.</li>`);
  oldest = r.messages.length ? r.messages[r.messages.length - 1].created_at : oldest;
  $("more").hidden = r.messages.length < 100;
  $("filter").hidden = !phone;
  $("listTitle").textContent = phone ? "Conversation" : "All texts";
  if (phone) $("filterLabel").textContent = pretty(phone) + (opted.has(phone) ? " · opted out" : "");
}

try {
  const me = await api("/me");
  $("who").textContent = `${me.user.name} · ${me.user.role}`;
  if (!["admin", "owner"].includes(me.user.role)) throw new Error("Texts are for Admins and the Owner.");
  $("number").textContent = me.number ? `from ${me.number}` : "";
  $("status").textContent = me.ready ? "" : "Twilio isn't connected yet: sending and receiving won't work until the settings are entered.";
  $("send").hidden = false; $("list").hidden = false;
  await load();
  setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 30000);
} catch (e) { $("status").textContent = e.message; }

$("msgs").addEventListener("click", async e => {
  const a = e.target.closest("a[data-phone]");
  if (a) { e.preventDefault(); phone = a.dataset.phone; $("to").value = pretty(phone); oldest = null; await load(); return; }
  const b = e.target.closest("button.done");
  if (b) { b.disabled = true; try { await api(`/messages/${b.dataset.id}/handled`, { method: "POST" }); await load(); } catch (err) { alert(err.message); b.disabled = false; } }
});
$("clearFilter").addEventListener("click", async e => { e.preventDefault(); phone = null; oldest = null; await load(); });
$("more").addEventListener("click", () => load(true));
$("sendForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button"); btn.disabled = true; $("sendMsg").textContent = "Sending…";
  try {
    const r = await api("/send", { method: "POST", body: JSON.stringify({ to: $("to").value, body: $("body").value }) });
    $("sendMsg").textContent = r.ok ? "Sent." : `Not sent: ${r.error}`;
    if (r.ok) $("body").value = "";
    await load();
  } catch (err) { $("sendMsg").textContent = err.message; }
  btn.disabled = false;
});
