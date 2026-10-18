// App shell: who's signed in, the header, the theme and the section router (#/plan, #/users, ...).
import { api, net } from "./api.js";
import { startAlerts } from "./alerts.js";
import { html, initials, roleName, RANK, toast } from "./ui.js";
import * as users from "./views/users.js";
import * as team from "./views/team.js";
import * as plan from "./views/plan.js";
import * as floor from "./views/floor.js";
import * as review from "./views/review.js";
import * as settings from "./views/settings.js";

const $ = s => document.querySelector(s);
const main = $("#main");
const VIEWS = {
  plan: m => plan.render(m, ctx), floor: m => floor.render(m, ctx), review: m => review.render(m, ctx),
  team: m => team.render(m, ctx), settings: m => settings.render(m, ctx),
  users: m => users.render(m, ctx),
};
const TITLES = { plan: "Plan", floor: "Floor", review: "Review", team: "Team", settings: "Settings", users: "Users & access" };
const ctx = { me: null };
Object.defineProperty(ctx, "offline", { get: () => net.offline }); // screens go read-only while offline

// ---------- theme (per PC; the dark default matches the desktop app) ----------
const THEMES = ["system", "dark", "light"];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
function applyTheme(t) {
  if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $("#themeName").textContent = t[0].toUpperCase() + t.slice(1);
}
let theme = store.get("theme") || "system";
applyTheme(theme);
$("#themeBtn").addEventListener("click", () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set("theme", theme); applyTheme(theme); });

// ---------- account menu ----------
const meBtn = $("#meBtn"), meMenu = $("#meMenu");
function setMenu(open) { meMenu.hidden = !open; meBtn.setAttribute("aria-expanded", String(open)); if (open) meMenu.querySelector("[role=menuitem]:not([hidden])")?.focus(); }
meBtn.addEventListener("click", e => { e.stopPropagation(); setMenu(meMenu.hidden); });
document.addEventListener("click", e => { if (!meMenu.hidden && !meMenu.contains(e.target)) setMenu(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !meMenu.hidden) { setMenu(false); meBtn.focus(); } });
meMenu.addEventListener("click", e => { if (e.target.closest("a")) setMenu(false); });

$("#today").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

// ---------- router ----------
async function route() {
  const view = (location.hash.match(/^#\/(\w+)/) || [])[1] || "plan";
  const show = VIEWS[view] ? view : "plan";
  document.querySelectorAll("#nav a").forEach(a => (a.dataset.view === show ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.title = `${TITLES[show]} · Production Planner`;
  try { await VIEWS[show](main); }
  catch (e) {
    main.innerHTML = html`<div class="card empty"><h2>Couldn't load this</h2><p>${e.message}</p><button class="btn" id="retry">Try again</button></div>`;
    $("#retry").addEventListener("click", route);
  }
  main.focus({ preventScroll: true });
}

function blocked(e) {
  $("#nav").hidden = true; meBtn.hidden = true;
  const notListed = e.body?.reason === "not_listed" || e.body?.reason === "no_role";
  main.innerHTML = html`<div class="card empty blocked">
    <h2>${notListed ? "You're not on the planner's user list yet" : e.body?.reason === "disabled" ? "Your access has been turned off" : "Can't open the planner"}</h2>
    <p>${notListed ? `You signed in as ${e.body.email}. Ask Neal or an Admin to add this email under Users & access.` : e.message}</p>
    <a class="btn" href="/cdn-cgi/access/logout">Sign in with a different email</a></div>`;
}

async function syncStatus() {
  try {
    const s = await api("/system");
    const el = $("#sync"), h = s.smrtHistory;
    if (!h || !h.days) { el.hidden = true; return; }
    const oldest = new Date(h.oldest + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    el.className = `sync ${s.lastSync?.status === "error" ? "warn" : "ok"}`;
    el.innerHTML = html`<i></i>SMRT history ${h.finished ? "complete" : "loading"} · back to ${oldest}`;
    el.title = `${(h.orders || 0).toLocaleString()} orders and ${(h.items || 0).toLocaleString()} pieces stored`;
    el.hidden = false;
  } catch { /* the header line is optional */ }
}

// ---------- offline: a bar while the planner is showing what this PC saved; screens refresh when it changes ----------
const bar = document.createElement("div");
bar.className = "offline-bar"; bar.hidden = true; bar.setAttribute("role", "status");
$(".top").after(bar);
let wasOffline = false, rerouted = 0;
window.addEventListener("pp-net", e => {
  const { offline, savedAt } = e.detail;
  bar.hidden = !offline;
  if (offline) bar.textContent = `Offline — showing what this PC saved${savedAt ? ` at ${new Date(savedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}${new Date(savedAt).toDateString() === new Date().toDateString() ? "" : ` on ${new Date(savedAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`}` : ""}. Nothing can be changed until the connection is back.`;
  // redraw once when it changes (at most every 10 s, so a flaky connection can't make the screen flicker)
  if (offline !== wasOffline) { wasOffline = offline; if (ctx.me && Date.now() - rerouted > 10000) { rerouted = Date.now(); setTimeout(route, 0); } }
});
window.addEventListener("online", () => { if (net.offline && ctx.me) route(); });

// keep a fresh copy of today's and the next work day's plan on this PC (for when the internet is down)
async function warm() {
  try {
    const V = await api("/pieces");
    await Promise.all([api("/settings"), api("/team"), ...[V.isWorkDay ? V.today : null, V.next].filter(Boolean).flatMap(d => [api(`/plan/${d}`), api(`/floor/${d}`)])]);
  } catch { /* next time */ }
}
function offlineReady() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").then(() => setTimeout(warm, 15000)).catch(() => {});
  setInterval(warm, 15 * 60 * 1000);
  document.querySelector('a[href="/cdn-cgi/access/logout"]')?.addEventListener("click", () => { try { navigator.serviceWorker.controller?.postMessage("forget"); } catch {} });
}

async function start() {
  try {
    const { user } = await api("/me");
    ctx.me = user;
    meBtn.textContent = initials(user.name);
    meBtn.setAttribute("aria-label", `Account: ${user.name}`);
    $("#meName").textContent = user.name; $("#meEmail").textContent = /@phone\.netexcleaners\.com$/.test(user.email) ? "Signs in by text message" : user.email;
    const chip = $("#meRole"); chip.textContent = roleName(user.role); chip.className = `chip ${user.role}`;
    $("#usersLink").hidden = RANK[user.role] < RANK.admin;
  } catch (e) {
    if (e.status === 403) return blocked(e);
    main.innerHTML = html`<div class="card empty blocked"><h2>Can't open the planner</h2><p>${e.message}</p><button class="btn" id="reload">Reload</button></div>`;
    $("#reload").addEventListener("click", () => location.reload());
    return;
  }
  window.addEventListener("hashchange", route);
  route();
  syncStatus();
  startAlerts();
  offlineReady();
  setInterval(syncStatus, 5 * 60 * 1000);
}
start();
window.addEventListener("unhandledrejection", e => toast(e.reason?.message || "Something went wrong.", "bad"));

// ---------- Shuttles tab: red dot when a van leaves within the hour and that store isn't all on VAN ----------
// (the page itself is /shuttlestatus; this only reads its totals, every 2 minutes while the planner is showing)
async function shuttleDot() {
  const tab = document.getElementById("shuttleTab"); if (!tab || document.visibilityState !== "visible") return;
  try {
    const v = await api("/shuttle");
    const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
    const toMin = t => { const m = /^(\d\d):(\d\d)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
    const soon = v.stores.filter(s => { const l = toMin(s.leaves); return l != null && !s.ok && !s.nothing && l - mins <= 60 && l - mins >= -15; })
      .sort((a, b) => toMin(a.leaves) - toMin(b.leaves));
    const dot = tab.querySelector(".tab-dot");
    dot.hidden = !soon.length;
    const slug = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    tab.href = soon.length ? `/shuttlestatus/#${slug(soon[0].name)}` : "/shuttlestatus/";
    tab.title = soon.length ? soon.map(s => `${s.name}: ${s.blocked} not on VAN${s.heldNoNote ? `, ${s.heldNoNote} need a note` : ""}`).join(" · ") : "Is everything due at each store on the van?";
  } catch { /* offline or no access: no dot */ }
}
setTimeout(shuttleDot, 4000);
setInterval(shuttleDot, 2 * 60 * 1000);
document.addEventListener("visibilitychange", shuttleDot);
