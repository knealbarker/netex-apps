// Made-up but realistic data: SMRT orders for five stores (Winnsboro rolls into Sulphur Springs) and Rippling hours
// for the stores, the Workshop and the Laundry Hub. No real customer or employee data.
import { ingestDay } from "../../sync/src/ingest.js";
import { ingestRippling } from "../../sync/src/rippling.js";
import { addDays } from "../src/snapshot.js";

const ORDER_COLS = ["ID","Customer Id","Agent","Payment Setting","Created by","Detailed by","Return Location","Returned by","Status","Order Type","Piece Count","Original Piece Count","Weight In","Weight Out","Price","Paid amount (inc. deposits)","Is Paid","Is Pre Paid","Weight","Discounted Amount","Before Discount Amount","Total Tax","Taxable Amount","Created","Due date","Detailed date","Assembled by","Is Route Delivery","Is Route Pickup","Assembly date","Returned date","Ready date","Paid date","Deleted date","Payment Method","Paid by","Promotion","Promotion applied date","Financial department(s)","Surcharge Amount"];

const ITEM_COLS = ["Sale Id","Item Status","Lot status","Price","Discounted amount","Item base price","Up Charge Amount","Created","Item Type","Financial department","Barcode","Item assembly date","Item removal date","Item Notes","Order Notes"];
/** Pieces for an order: [department, assembled?] per piece, each worth `each` dollars before tax. */
export function items(o, list, each, assembledOn) {
  return list.map(([dept, asm], i) => {
    const it = Object.fromEntries(ITEM_COLS.map(c => [c, null]));
    return Object.assign(it, { "Sale Id": o.ID, "Item Status": asm ? "assembled" : "detailed", "Item base price": String(Math.round(each * 100)), "Price": String(Math.round(each * 108.25)),
      "Created": o.Created, "Item Type": dept === "Wash & Fold" ? "Wash & Fold" : "Shirt", "Financial department": dept, "Barcode": `${o.ID}${i}`,
      "Item assembly date": asm ? `${assembledOn}T10:00:00-05:00` : null });
  });
}

/** One order: pre-tax `net` dollars (tax 8.25% on top), detailed on `day`, paid on `paid` (or not). */
export function order(no, { store = "TCC Sulphur Springs", day, net = 20, paid = null, status = "processing", pieces = 3, deleted = false, detailed = true, ready = null }) {
  const o = Object.fromEntries(ORDER_COLS.map(c => [c, null]));
  const tax = Math.round(net * 100 * 0.0825), cents = Math.round(net * 100);
  Object.assign(o, { "ID": String(no), "Customer Id": "c" + no, "Agent": store, "Return Location": store, "Status": deleted ? "deleted" : status, "Order Type": "Dry Cleaning",
    "Piece Count": String(pieces), "Price": String(cents + tax), "Total Tax": String(tax), "Taxable Amount": String(cents), "Before Discount Amount": String(cents),
    "Created": `${day}T09:15:00-05:00`, "Detailed date": detailed ? `${day}T09:20:00-05:00` : null, "Due date": `${addDays(day, 1)}T16:00:00-05:00`,
    "Paid date": paid ? `${paid}T11:00:00-05:00` : null, "Ready date": ready ? `${ready}T09:00:00-05:00` : null, "Paid amount (inc. deposits)": paid ? String(cents + tax) : "0", "Deleted date": deleted ? `${day}T10:00:00-05:00` : null,
    "Financial department(s)": "Dry Cleaning Tops" });
  return o;
}

const HDR = "time_entry_id,employee_name,employee_number,title,department_path,work_location,time_entry_date,clock_in_local,clock_out_local,duration_hours,timezone,status,clock_in_source,clock_out_source,pay_rate";
const us = d => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
export function entry(id, name, no, dept, loc, day, hours, rate = "", { open = false, start = 8 } = {}) {
  const h = n => { const hh = Math.floor(n), mm = Math.round((n - hh) * 60); const ap = hh >= 12 ? "PM" : "AM"; const h12 = ((hh + 11) % 12) + 1; return `${us(day)} ${String(h12).padStart(2, "0")}:${String(mm).padStart(2, "0")} ${ap} CDT`; };
  return [id, name, no, "Advisor", dept, loc, us(day), h(start), open ? "" : h(start + hours), open ? "" : hours, "America/Chicago", open ? "OPEN" : "PAID", "Web", open ? "" : "Web", rate].join(",");
}

/**
 * Seeds `days` days ending `last` (inclusive). Returns the expected totals the tests check against.
 * Per day: SS 3 orders x $400, Winnsboro 1 x $150, Quitman 2 x $160, Emory 1 x $560, Greenville 2 x $260 (+1 deleted SS order).
 * Paid the next day, except Quitman's (unpaid statements). Hours: SS 16 h ($15 rate), Quitman 8 h (no rate -> average),
 * Emory 6 h ($14), Greenville 8 h ($16), Workshop 40 h ($15), Laundry Hub 8 h ($16).
 */
export async function seed(db, { last, days = 7, today = addDays(last, 1) }) {
  let n = 260000000;
  await db.prepare("INSERT INTO int_sync_runs(id,integration_id,started_at,status) VALUES('seed','smrt','2026-10-01T00:00:00Z','ok')").run();
  const ctx = { orgId: "tcc", runId: "seed", mode: "backfill" };
  const csv = [HDR]; let e = 0;
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(last, -i), next = addDays(day, 1);
    const orders = [], its = [];
    const DC = ["Dry Cleaning Tops", true], LT = ["Laundry Tops", true];
    { const o = order(++n, { day, net: 400, paid: next, pieces: 4, ready: next }); orders.push(o); its.push(...items(o, [DC, LT, DC, ["Wash & Fold", false]], 100, next)); }
    for (let k = 0; k < 2; k++) { const o = order(++n, { day, net: 400, paid: next, pieces: 4 }); orders.push(o); its.push(...items(o, [DC, LT, DC, LT], 100, next)); }
    { const o = order(++n, { store: "TCC Winnsboro", day, net: 150, paid: next }); orders.push(o); its.push(...items(o, [DC, DC, LT], 50, next)); }
    for (let k = 0; k < 2; k++) { const o = order(++n, { store: "TCC Quitman", day, net: 160, pieces: 2 }); orders.push(o); its.push(...items(o, [["Dry Cleaning Tops", false], ["Laundry Tops", false]], 80, next)); }
    { const o = order(++n, { store: "TCC Emory", day, net: 560, paid: next, pieces: 4 }); orders.push(o); its.push(...items(o, [DC, DC, LT, ["Shoe Repair", true]], 140, next)); }
    for (let k = 0; k < 2; k++) { const o = order(++n, { store: "TCC Greenville", day, net: 260, paid: next, pieces: 2 }); orders.push(o); its.push(...items(o, [DC, LT], 130, next)); }
    orders.push(order(++n, { day, net: 500, deleted: true, paid: next }));
    ctx.day = day; await ingestDay(db, ctx, orders, its);
    csv.push(entry(`e${++e}`, "Sam Counter", "501", "Retail", "TCC SS Retail", day, 8, "$15.00"));
    csv.push(entry(`e${++e}`, "Jo Counter", "502", "Retail", "TCC SS Retail", day, 8, "15"));
    csv.push(entry(`e${++e}`, "Quinn Store", "503", "Retail", "TCC Quitman Retail", day, 8, ""));
    csv.push(entry(`e${++e}`, "Em Store", "504", "Retail", "TCC Emory Retail", day, 6, "14.00"));
    csv.push(entry(`e${++e}`, "Gail Store", "505", "Retail", "TCC Greenville Retail", day, 8, "16.00"));
    for (let k = 0; k < 5; k++) csv.push(entry(`e${++e}`, `Press ${k}`, String(600 + k), "Production", "TCC SS Workshop", day, 8, "15.00", { start: 5 }));
    csv.push(entry(`e${++e}`, "Hub Tech", "700", "Laundry Hub", "TCC Laundry Hub", day, 8, "16.00", { start: 6 }));
  }
  // today so far: Sam is on the clock at Sulphur Springs since 8 am
  csv.push(entry(`e${++e}`, "Sam Counter", "501", "Retail", "TCC SS Retail", today, 0, "$15.00", { open: true }));
  const res = await ingestRippling(db, { orgId: "tcc", integrationId: "rippling", today, csv: csv.join("\n") });
  return { rippling: res, days };
}
