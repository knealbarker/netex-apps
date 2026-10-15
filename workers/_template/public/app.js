// Page script. All data comes from /api, which checks the sign-in and this app's role.
async function api(path) {
  let res;
  try { res = await fetch(`/api${path}`, { credentials: "same-origin" }); }
  catch { throw new Error("Can't reach the app. Check the internet connection."); }
  // Access answers with an HTML sign-in page when the session has run out
  if (!(res.headers.get("content-type") || "").includes("application/json")) throw new Error("Your sign-in has expired. Reload the page to sign in again.");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

try {
  const me = await api("/me");
  $("appName").textContent = document.title = me.app.name;
  $("who").textContent = `${me.user.name} · ${me.user.role}`;
  const o = await api("/orders-today");
  $("orders").querySelector("tbody").innerHTML = o.stores.map(s => `<tr><td>${esc(s.store)}</td><td>${s.orders}</td></tr>`).join("") || `<tr><td colspan="2">None yet today.</td></tr>`;
  $("orders").hidden = false;
  $("status").textContent = `Today is ${me.today}.`;
} catch (e) {
  $("status").textContent = e.message;
}
