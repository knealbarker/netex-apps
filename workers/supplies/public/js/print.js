// Printable slips. The shuttle slip rides back to the store with the items; the order sheet is what Karla reads from
// when she calls or orders on the web. Rendered into #print, which is the only thing shown when printing.
import { html, raw } from "./ui.js";
import { fmt, plural } from "/count/form.js";

const longDay = d => (d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "");
const time = d => new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function slip(s) {
  const lines = s.lines.filter(l => Number(l.send) > 0);
  return html`<section class="pslip">
    <header><div><small>Town &amp; Country Cleaners · Shuttle slip</small><h1>${s.location}</h1></div>
      <div class="pmeta"><b>${longDay(s.shipOn)}</b>${s.countedBy ? raw(html`<span>Counted by ${s.countedBy}, ${time(s.countedAt)}</span>`) : ""}</div></header>
    <table><thead><tr><th class="ck">Packed</th><th>Item</th><th class="n">Sending</th><th class="ck">Rec'd</th></tr></thead>
      <tbody>${lines.map(l => raw(html`<tr><td class="ck">☐</td><td>${l.name}</td><td class="n">${plural(l.send, l.unit || "")}</td><td class="ck">☐</td></tr>`))}
      ${lines.length ? "" : raw('<tr><td colspan="4" class="none">Nothing to send.</td></tr>')}</tbody></table>
    ${s.lines.some(l => Number(l.send) === 0 && l.need > 0) ? raw(html`<p class="pnote"><b>Not sending this time:</b> ${s.lines.filter(l => Number(l.send) === 0 && l.need > 0).map(l => l.name).join(", ")}</p>`) : ""}
    ${s.note ? raw(html`<p class="pnote"><b>Store note:</b> ${s.note}</p>`) : ""}
    <footer><span>Packed by ____________________</span><span>Received by ____________________</span></footer>
  </section>`;
}

function orderSheet(g, today) {
  const v = g.vendor;
  return html`<section class="pslip">
    <header><div><small>Town &amp; Country Cleaners · Supply order</small><h1>${v.name}</h1></div>
      <div class="pmeta"><b>${longDay(today)}</b>${v.phone ? raw(html`<span>${v.phone}</span>`) : ""}${v.website ? raw(html`<span>${v.website}</span>`) : ""}${v.accountNo ? raw(html`<span>Account ${v.accountNo}</span>`) : ""}</div></header>
    <table><thead><tr><th class="ck">✓</th><th>Item #</th><th>Item</th><th class="n">On hand</th><th class="n">Order</th></tr></thead>
      <tbody>${g.lines.map(l => raw(html`<tr><td class="ck">☐</td><td>${l.sku || ""}</td><td>${l.name}</td><td class="n">${l.onHand ?? (l.level === "need" ? "needed" : "")}</td><td class="n"><b>${plural(l.qty, l.unit)}</b></td></tr>`))}</tbody></table>
    <p class="pnote">${v.leadDays != null ? `Usually arrives in ${v.leadDays} business day${v.leadDays === 1 ? "" : "s"}. ` : ""}${v.minAmount ? `Minimum order $${fmt(v.minAmount)}. ` : ""}${v.minNote || ""}</p>
    <footer><span>Ordered by ____________________</span><span>Confirmation # ____________________</span></footer>
  </section>`;
}

export function printShuttle(list) { go(list.map(slip).join("")); }
export function printOrders(groups, today) { go(groups.map(g => orderSheet(g, today)).join("")); }
function go(markup) {
  const el = document.getElementById("print");
  el.innerHTML = markup;
  window.print();
}
