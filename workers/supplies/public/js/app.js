// App shell: who's signed in, the header, the theme and the section router.
import { api } from "./api.js";
import { html, initials, roleName, RANK, toast, listen } from "./ui.js";
import * as users from "./views/users.js";
import * as shuttle from "./views/shuttle.js";
import * as orders from "./views/orders.js";
import * as counts from "./views/counts.js";
import * as items from "./views/items.js";
import * as setup from "./views/setup.js";

const $ = s => document.querySelector(s);
const main = $("#main");
const ctx = { me: null, today: null, canEdit: false };
const VIEWS = {
  shuttle: (m, a) => shuttle.render(m, ctx, a), orders: (m, a) => orders.render(m, ctx, a), counts: (m, a) => counts.render(m, ctx, a),
  count: (m, a) => counts.renderEntry(m, ctx, a), items: (m, a) => items.render(m, ctx, a), setup: (m, a) => setup.render(m, ctx, a), users: m => users.render(m, ctx),
};
const TITLES = { shuttle: "Shuttle", orders: "Orders", counts: "Counts", count: "Enter a count", items: "Supply list", setup: "Setup", users: "Users & access" };
const TAB = { count: "counts" };

const THEMES = ["system", "dark", "light"];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
function applyTheme(t) { if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; $("#themeName").textContent = t[0].toUpperCase() + t.slice(1); }
let theme = store.get("theme") || "system";
applyTheme(theme);
$("#themeBtn").addEventListener("click", () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set("theme", theme); applyTheme(theme); });

const meBtn = $("#meBtn"), meMenu = $("#meMenu");
function setMenu(open) { meMenu.hidden = !open; meBtn.setAttribute("aria-expanded", String(open)); if (open) meMenu.querySelector("[role=menuitem]:not([hidden])")?.focus(); }
meBtn.addEventListener("click", e => { e.stopPropagation(); setMenu(meMenu.hidden); });
document.addEventListener("click", e => { if (!meMenu.hidden && !meMenu.contains(e.target)) setMenu(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !meMenu.hidden) { setMenu(false); meBtn.focus(); } });
meMenu.addEventListener("click", e => { if (e.target.closest("a,button")) setMenu(false); });
$("#today").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

export async function route() {
  const [, view, arg] = location.hash.match(/^#\/(\w+)(?:\/([\w-]+))?/) || [];
  const show = VIEWS[view] ? view : "shuttle";
  const tab = TAB[show] || show;
  document.querySelectorAll("#nav a").forEach(a => (a.dataset.view === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.title = `${TITLES[show]} · Supplies`;
  listen(main);
  try { await VIEWS[show](main, arg); }
  catch (e) {
    main.innerHTML = html`<div class="card empty"><h2>Couldn't load this</h2><p>${e.message}</p><button class="btn" id="retry">Try again</button></div>`;
    $("#retry").addEventListener("click", route);
  }
}

function blocked(e) {
  $("#nav").hidden = true; meBtn.hidden = true;
  const notListed = e.body?.reason === "not_listed" || e.body?.reason === "no_role";
  main.innerHTML = html`<div class="card empty blocked">
    <h2>${notListed ? "You don't have access to Supplies yet" : e.body?.reason === "disabled" ? "Your access has been turned off" : "Can't open Supplies"}</h2>
    <p>${notListed ? `You signed in as ${e.body.email}. Ask Neal or an Admin to give you a Supplies role under Users & access.` : e.message}</p>
    <p class="muted small">Counting supplies at a store? Use the count page on the store's device instead: <a href="/count/">supplies.netexcleaners.com/count</a></p>
    <a class="btn" href="/cdn-cgi/access/logout">Sign in with a different email</a></div>`;
}

async function start() {
  try {
    const { user, today } = await api("/me");
    ctx.me = user; ctx.today = today; ctx.canEdit = RANK[user.role] >= RANK.manager;
    meBtn.textContent = initials(user.name);
    meBtn.setAttribute("aria-label", `Account: ${user.name}`);
    $("#meName").textContent = user.name; $("#meEmail").textContent = /@phone\.netexcleaners\.com$/.test(user.email) ? "Signs in by text message" : user.email;
    const chip = $("#meRole"); chip.textContent = roleName(user.role); chip.className = `chip ${user.role}`;
    $("#usersLink").hidden = RANK[user.role] < RANK.admin;
  } catch (e) {
    if (e.status === 403) return blocked(e);
    main.innerHTML = html`<div class="card empty blocked"><h2>Can't open Supplies</h2><p>${e.message}</p><button class="btn" id="reload">Reload</button></div>`;
    $("#reload").addEventListener("click", () => location.reload());
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}
start();
window.addEventListener("unhandledrejection", e => toast(e.reason?.message || "Something went wrong.", "bad"));
