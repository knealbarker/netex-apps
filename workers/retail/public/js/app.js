// App shell: who's signed in, the header, the theme and the section router (#/snapshot, #/hours, #/settings, #/users).
import { api } from "./api.js";
import { html, initials, roleName, RANK, toast } from "./ui.js";
import * as users from "./views/users.js";
import * as snap from "./views/snapshot.js";
import * as settings from "./views/settings.js";

const $ = s => document.querySelector(s);
const main = $("#main");
const VIEWS = { snapshot: m => snap.render(m, ctx, "snapshot"), hours: m => snap.render(m, ctx, "hours"), settings: m => settings.render(m, ctx), users: m => users.render(m, ctx) };
const TITLES = { snapshot: "Snapshot", hours: "Hours", settings: "Settings", users: "Users & access" };
const ctx = { me: null, today: null };

const THEMES = ["system", "dark", "light"];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
function applyTheme(t) {
  if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $("#themeName").textContent = t[0].toUpperCase() + t.slice(1);
}
let theme = store.get("theme") || "system";
applyTheme(theme);
$("#themeBtn").addEventListener("click", () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set("theme", theme); applyTheme(theme); });

const meBtn = $("#meBtn"), meMenu = $("#meMenu");
function setMenu(open) { meMenu.hidden = !open; meBtn.setAttribute("aria-expanded", String(open)); if (open) meMenu.querySelector("[role=menuitem]:not([hidden])")?.focus(); }
meBtn.addEventListener("click", e => { e.stopPropagation(); setMenu(meMenu.hidden); });
document.addEventListener("click", e => { if (!meMenu.hidden && !meMenu.contains(e.target)) setMenu(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !meMenu.hidden) { setMenu(false); meBtn.focus(); } });
meMenu.addEventListener("click", e => { if (e.target.closest("a")) setMenu(false); });
$("#today").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

async function route() {
  const view = (location.hash.match(/^#\/(\w+)/) || [])[1] || "snapshot";
  const show = VIEWS[view] ? view : "snapshot";
  document.querySelectorAll("#nav a").forEach(a => (a.dataset.view === show ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.title = `${TITLES[show]} · Retail Snapshot`;
  try { await VIEWS[show](main); }
  catch (e) {
    main.innerHTML = html`<div class="card empty"><h2>Couldn't load this</h2><p>${e.message}</p><button class="btn" id="retry">Try again</button></div>`;
    $("#retry").addEventListener("click", route);
  }
}

function blocked(e) {
  $("#nav").hidden = true; meBtn.hidden = true;
  const notListed = e.body?.reason === "not_listed" || e.body?.reason === "no_role";
  main.innerHTML = html`<div class="card empty blocked">
    <h2>${notListed ? "You don't have access to the Retail Snapshot yet" : e.body?.reason === "disabled" ? "Your access has been turned off" : "Can't open the Retail Snapshot"}</h2>
    <p>${notListed ? `You signed in as ${e.body.email}. Ask Neal or an Admin to give you a Retail Snapshot role under Users & access.` : e.message}</p>
    <a class="btn" href="/cdn-cgi/access/logout">Sign in with a different email</a></div>`;
}

async function start() {
  try {
    const { user, today, weekStart } = await api("/me");
    ctx.me = user; ctx.today = today; ctx.weekStart = weekStart ?? 1;
    meBtn.textContent = initials(user.name);
    meBtn.setAttribute("aria-label", `Account: ${user.name}`);
    $("#meName").textContent = user.name; $("#meEmail").textContent = /@phone\.netexcleaners\.com$/.test(user.email) ? "Signs in by text message" : user.email;
    const chip = $("#meRole"); chip.textContent = roleName(user.role); chip.className = `chip ${user.role}`;
    const admin = RANK[user.role] >= RANK.admin;
    $("#usersLink").hidden = !admin; $("#settingsTab").hidden = !admin;
    $("#plannerLink").hidden = !user.roles?.planner;
  } catch (e) {
    if (e.status === 403) return blocked(e);
    main.innerHTML = html`<div class="card empty blocked"><h2>Can't open the Retail Snapshot</h2><p>${e.message}</p><button class="btn" id="reload">Reload</button></div>`;
    $("#reload").addEventListener("click", () => location.reload());
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}
start();
window.addEventListener("unhandledrejection", e => toast(e.reason?.message || "Something went wrong.", "bad"));
