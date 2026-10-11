// App shell: who's signed in, the header, the theme and the section router (#/plan, #/users, ...).
import { api } from "./api.js";
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

async function start() {
  try {
    const { user } = await api("/me");
    ctx.me = user;
    meBtn.textContent = initials(user.name);
    meBtn.setAttribute("aria-label", `Account: ${user.name}`);
    $("#meName").textContent = user.name; $("#meEmail").textContent = user.email;
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
  setInterval(syncStatus, 5 * 60 * 1000);
}
start();
window.addEventListener("unhandledrejection", e => toast(e.reason?.message || "Something went wrong.", "bad"));
