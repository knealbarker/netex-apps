// Shuttle status: before the van leaves, is every piece due at the store on VAN?
// Data: GET /api/shuttle[?store=id] (the planner's copy of SMRT, updated every 10 minutes on work days);
// "Check now": POST /api/shuttle/check {store} re-reads that store from SMRT first (about 10–40 seconds).
import { api } from "/js/api.js";
import { html, raw, toast } from "/js/ui.js";

const TZ = "America/Chicago";
const POLL_MS = 60e3, STALE_MIN = 5;
const $ = id => document.getElementById(id);
const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } } };

let data = null, sel = null, sort = { key: null, dir: 1 }, checking = false, timer = null;

// ---------- formatting (Central time)
const fmt = (iso, o) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...o }).format(new Date(iso)) : "");
const time = iso => fmt(iso, { hour: "numeric", minute: "2-digit" });
const dayOf = iso => (iso ? String(iso).slice(0, 10) : "");
const shortDay = day => (day ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "numeric", day: "numeric" }).format(new Date(day + "T12:00:00Z")) : "");
const when = iso => (!iso ? "" : dayOf(iso) === data.day ? time(iso) : `${shortDay(dayOf(iso))} ${time(iso)}`);
const clock = t => { const m = /^(\d\d):(\d\d)$/.exec(t || ""); if (!m) return ""; const h = +m[1]; return `${h % 12 || 12}:${m[2]} ${h >= 12 ? "PM" : "AM"}`; };
const ago = iso => { if (!iso) return "never"; const m = Math.round((Date.now() - Date.parse(iso)) / 60e3); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const n = (k, one, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const ICON = {
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
  idle: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
  sync: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.6L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.6L20 16m0 4v-4h-4"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4M12 17v.01"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

// ---------- loading
async function load({ quiet = false } = {}) {
  try {
    const q = sel ? `?store=${encodeURIComponent(sel)}` : "";
    const d = await api(`/shuttle${q}`);
    data = d;
    if (!sel && d.stores.length) { pick(chooseStore(d.stores)); render(); return; }
    render();
  } catch (e) {
    if (!quiet || !data) showError(e.message);
    else toast(e.message, "bad");
  }
}
function chooseStore(stores) {
  const h = location.hash.slice(1);
  const byHash = stores.find(s => slug(s.name) === h);
  if (byHash) return byHash.id;
  const saved = store.get("sh-store");
  if (stores.some(s => s.id === saved)) return saved;
  return (stores.find(s => !s.ok && !s.nothing) || stores[0]).id;
}
function pick(id, { fetch = true } = {}) {
  sel = id; store.set("sh-store", id);
  sort = { key: null, dir: 1 };
  const s = (data?.stores || []).find(x => x.id === id);
  if (s && location.hash.slice(1) !== slug(s.name)) history.replaceState(null, "", "#" + slug(s.name));
  if (fetch) load();
}
async function checkNow() {
  if (!sel || checking) return;
  checking = true; render();
  try {
    const d = await api("/shuttle/check", { method: "POST", body: { store: sel } });
    data = d;
    const c = d.check || {};
    if (c.status === "ok") toast(`Checked SMRT just now.`, "ok");
    else if (c.status === "recent") toast("Already checked in the last minute. Showing that.", "ok");
    else if (c.status === "busy") toast("SMRT is being read right now. Showing the latest; try again in a minute.", "warn", 6000);
    else toast(`Couldn't check SMRT${c.error ? `: ${c.error}` : ""}. Showing the last copy.`, "bad", 8000);
  } catch (e) { toast(e.message, "bad", 8000); }
  checking = false; render();
}
function showError(msg) {
  $("sh-stores").innerHTML = html`<div class="sh-error card"><b>Can't load shuttle status.</b><span>${msg}</span><button class="btn" type="button" id="sh-retry">Try again</button></div>`;
  $("sh-retry").onclick = () => load();
}

// ---------- rendering
// ok = all on VAN; warn = OK to leave, but something still needs doing (a held-over order without a note); stop = not yet
const statusOf = s => (s.nothing ? "idle" : !s.ok ? "stop" : s.heldNoNote ? "warn" : "ok");
// "3 tickets and 2 items" (tickets are counted as tickets; items not in a ticket yet as items)
const units = (total, tickets = 0) => [tickets ? n(tickets, "ticket") : "", total - tickets ? n(total - tickets, "item") : ""].filter(Boolean).join(" and ") || "0";
function storeLine(s) {
  if (s.nothing) return "Nothing due";
  if (s.ok) return `OK to leave · ${s.heldNoNote ? `${s.heldNoNote} need${s.heldNoNote === 1 ? "s" : ""} a note` : `${units(s.van, s.vanTickets)} on VAN`}${s.wf ? ` · ${s.wf} W&F to check` : ""}`;
  const parts = [];
  if (s.blocked) parts.push(`${units(s.blocked, s.blockedTickets)} not on VAN`);
  if (s.heldNoNote) parts.push(`${s.heldNoNote} need${s.heldNoNote === 1 ? "s" : ""} a note`);
  return parts.join(" · ");
}
function render() {
  if (!data) return;
  $("sh-day").textContent = `Shuttle status · ${shortDay(data.day).replace(",", "")}`;
  const stale = !data.asOf || (Date.now() - Date.parse(data.asOf)) / 60e3 > STALE_MIN;
  $("sh-fresh").innerHTML = html`<span class="sync ${stale ? "warn" : "ok"}"><i></i>SMRT as of ${data.asOf ? time(data.asOf) : "—"} (${ago(data.asOf)})</span>`;

  if (!data.stores.length) {
    $("sh-stores").innerHTML = html`<div class="sh-error card"><b>No shuttle runs set up.</b><span>Add them in the planner under Settings › Shuttle runs.</span></div>`;
    $("sh-store").hidden = true; return;
  }
  $("sh-stores").innerHTML = data.stores.map(s => html`<button type="button" class="sh-tab ${statusOf(s)}" data-id="${s.id}" aria-pressed="${s.id === sel}">
      <span class="sh-tab-ico">${raw(ICON[statusOf(s)])}</span>
      <span class="sh-tab-text"><b>${s.name}</b><small>${s.leaves ? `Leaves ${clock(s.leaves)}` : s.run}</small><em>${storeLine(s)}</em></span>
    </button>`).join("");
  for (const b of $("sh-stores").querySelectorAll(".sh-tab")) b.onclick = () => { if (b.dataset.id !== sel) pick(b.dataset.id); };

  const s = data.stores.find(x => x.id === sel), sec = $("sh-store");
  if (!s || !data.rows) { sec.hidden = true; return; }
  sec.hidden = false;
  sec.innerHTML = banner(s, stale) + counts(s) + table(s);
  sec.querySelector("#sh-check").onclick = checkNow;
  for (const th of sec.querySelectorAll("th[data-key] button")) th.onclick = () => {
    const k = th.closest("th").dataset.key;
    sort = sort.key === k ? { key: k, dir: -sort.dir } : { key: k, dir: 1 };
    render();
  };
}

function banner(s, stale) {
  const st = statusOf(s);
  let head, sub = [];
  if (st === "idle") { head = `Nothing due at ${s.name} today`; sub.push("No open tickets or items due today or earlier."); }
  else if (st === "ok" || st === "warn") {
    head = `OK to leave for ${s.name}`;
    if (s.heldNoNote) sub.push(`${s.heldNoNote} held over ${s.heldNoNote === 1 ? "needs" : "need"} a note in SMRT`);
    if (s.van) sub.push(`All ${units(s.van, s.vanTickets)} due ${s.van === 1 ? "is" : "are"} on ${data.transitRack.toUpperCase()}.`);
    if (s.held - s.heldNoNote) sub.push(`${s.held - s.heldNoNote} held over, with a note.`);
    if (s.wf) sub.push(`Grab ${n(s.wf, "Wash & Fold bag")}: SMRT doesn't show where they're racked, so check by hand.`);
  } else {
    head = `Not yet — ${units(s.blocked, s.blockedTickets)} ${s.blocked === 1 ? "isn't" : "aren't"} on ${data.transitRack.toUpperCase()}`;
    if (s.blocked) {
      const ready = s.blocked - s.notReady;
      if (ready) sub.push(`${units(ready, s.blockedTickets)} ready but not on ${data.transitRack.toUpperCase()}`);
      if (s.notReady) sub.push(`${n(s.notReady, "item")} not ready`);
    }
    if (s.blocked && s.heldNoNote) sub.push(`${s.heldNoNote} held over without a note`);
  }
  const checkLabel = checking ? "Checking SMRT…" : "Check now";
  const hint = checking ? "Reading the newest scans from SMRT…"
    : stale ? `This is SMRT as of ${ago(data.asOf)}. Press Check now before you leave.`
      : data.how === "check" ? `Checked SMRT ${ago(data.asOf)}.` : data.how === "scans" ? `Scans read ${ago(data.asOf)} (every 2 minutes on work days).` : `SMRT copied ${ago(data.asOf)}.`;
  return html`<div class="sh-banner ${st}" role="status">
      <span class="sh-banner-ico">${raw(ICON[st])}</span>
      <div class="sh-banner-text"><h1>${head}</h1>${sub.length ? raw(html`<p>${sub.join(" · ")}</p>`) : ""}
        <small>${s.run}${s.leaves ? ` · van leaves ${clock(s.leaves)}` : ""}</small></div>
      <div class="sh-banner-act">
        <button class="btn ${stale || st === "stop" ? "primary" : ""}" type="button" id="sh-check" ${checking || !data.sync ? "disabled" : ""} aria-busy="${checking}">
          ${raw(checking ? '<span class="spin"></span>' : ICON.sync)}<span>${checkLabel}</span></button>
        <small class="${stale && !checking ? "warn" : ""}">${data.sync ? hint : "Check now isn't connected yet."}</small>
      </div>
    </div>`;
}

function counts(s) {
  const c = (k, label, cls) => html`<div class="sh-count ${cls}"><b>${k}</b><span>${label}</span></div>`;
  return `<div class="sh-counts">${[
    c(s.van, `on ${data.transitRack.toUpperCase()}`, "ok"),
    c(s.blocked, `not on ${data.transitRack.toUpperCase()}`, s.blocked ? "stop" : ""),
    c(s.held, "held over", s.heldNoNote ? "warn" : ""),
    ...(s.wf ? [c(s.wf, "W&F to check by hand", "warn")] : []),
  ].join("")}</div>`;
}

// ---------- the piece table
const RANK = { blocked: 0, held: 1, wf: 2, van: 3 };
const COLS = [
  { key: "status", label: "Status", val: r => RANK[r.status] * 10 + (r.status === "held" && !r.noted ? 0 : 1) },
  { key: "order", label: "Order", val: r => r.orderNo },
  { key: "rack", label: "Location", val: r => r.rack || "" },
  { key: "item", label: "Items", val: r => r.item },
  { key: "tag", label: "Ticket / tag", val: r => r.tag || "" },
  { key: "prod", label: "Production", val: r => r.prod },
  { key: "customer", label: "Customer", val: r => r.customer },
  { key: "racked", label: "Scanned", val: r => r.rackedAt || "" },
  { key: "due", label: "Due", val: r => r.due || "" },
  { key: "note", label: "Note", val: r => r.note || "" },
];
function sorted(rows) {
  if (!sort.key) return rows; // the server's order: not on VAN first, then held over, then on VAN
  const col = COLS.find(c => c.key === sort.key);
  return rows.map((r, i) => [r, i]).sort((a, b) => {
    const x = col.val(a[0]), y = col.val(b[0]);
    const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return d * sort.dir || a[1] - b[1];
  }).map(x => x[0]);
}
function statusCell(r) {
  const T = data.transitRack.toUpperCase();
  if (r.status === "van") return html`<span class="sp ok">${raw(ICON.ok)}On ${T}</span>${r.vanSince ? raw(html`<small class="warn">since ${shortDay(r.vanSince)}</small>`) : ""}`;
  if (r.status === "wf") return html`<span class="sp warn">W&amp;F bag</span><small>check by hand</small>`;
  if (r.status === "held") return html`<span class="sp ${r.noted ? "info" : "warn"}">Held over</span><small>${r.noted ? `due ${shortDay(dayOf(r.due))}` : "needs a note"}</small>`;
  return html`<span class="sp stop">Not on ${T}</span><small>${r.reason}</small>`;
}
function table(s) {
  const rows = sorted(data.rows);
  if (!rows.length) return `<p class="sh-empty">Nothing due for ${html`${s.name}`} today or earlier.</p>`;
  const head = COLS.map(c => {
    const on = sort.key === c.key, aria = on ? (sort.dir > 0 ? "ascending" : "descending") : "none";
    return html`<th scope="col" data-key="${c.key}" aria-sort="${aria}"><button type="button">${c.label}<i aria-hidden="true">${on ? (sort.dir > 0 ? "▲" : "▼") : ""}</i></button></th>`;
  }).join("");
  const body = rows.map(r => {
    const late = r.status !== "held" && dayOf(r.due) && dayOf(r.due) < data.day;
    const order = r.link ? html`<a href="${r.link}" target="_blank" rel="noopener" title="Open in SMRT">${r.order}${raw(ICON.out)}</a>` : html`${r.order}`;
    const rack = r.rack ? html`<b>${r.rack}</b>${r.rackStore && r.status === "blocked" ? raw(html`<small>${r.rackStore}</small>`) : ""}` : html`<span class="faint">—</span>`;
    const due = r.status === "held"
      ? html`<span>${shortDay(dayOf(r.due))}</span><small>was ${shortDay(dayOf(r.heldFrom))}</small>`
      : html`<span>${shortDay(dayOf(r.due))}</span>${late ? raw('<small class="warn">late</small>') : raw(html`<small>${time(r.due)}</small>`)}`;
    const note = r.status === "held" && !r.noted ? html`<span class="warn">Add a note in SMRT</span>` : r.note ? html`<span class="sh-note">${r.note}</span>` : html`<span class="faint">—</span>`;
    return html`<tr class="r-${r.status}">
      <td class="st">${raw(statusCell(r))}</td>
      <td class="mono">${raw(order)}</td>
      <td>${raw(rack)}</td>
      <td>${r.item}${r.brand ? raw(html`<small>${r.brand}</small>`) : ""}</td>
      <td class="mono">${r.tag || "—"}</td>
      <td>${r.prod}</td>
      <td>${r.customer}</td>
      <td>${r.rackedAt ? raw(html`<span>${when(r.rackedAt)}</span><small>${r.rackedBy || ""}</small>`) : raw('<span class="faint">—</span>')}</td>
      <td>${raw(due)}</td>
      <td>${raw(note)}</td>
    </tr>`;
  }).join("");
  return `<div class="sh-table-wrap card"><table class="sh-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="sh-foot">${html`Orders due at ${s.name} today or up to ${data.lookbackDays} days before, one row per ticket; an order with no ticket scanned yet is one row for its items. Left out: tickets and items already at ${s.name} or DELIVERED, back with the customer, or on route deliveries. To hold something over, move its order's due date in SMRT (split the order first if only part stays) and add a note saying why.`}</p>`;
}

// ---------- start
window.addEventListener("hashchange", () => { if (!data) return; const id = chooseStore(data.stores); if (id !== sel) pick(id); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load({ quiet: true }); });
timer = setInterval(() => { if (!checking && document.visibilityState === "visible") load({ quiet: true }); }, POLL_MS);
setInterval(() => { if (data && !checking) render(); }, 30e3); // keep "x min ago" current
load();
