// Read-only access to SMRT's saved reports through its GraphQL API.
// Same rules the desktop planner learned (see claude/smrt-integration.md):
//  - getReport(id, startDate, endDate, limit<=5000); endDate is exclusive
//  - ask for columns and values in separate calls
//  - a call that returns 5,000 rows is split until each part fits
import { addDays } from "./util.js";

export const REPORT_ORDERS = "ebe7b9bb-20b7-472b-9925-2b729fe2a38b"; // TCC All Orders This Year
export const REPORT_ITEMS = "8f6e82e5-8e64-466c-935a-35a22ee5fd01";  // TCC All Items This Year
const LIMIT = 5000;

export class Smrt {
  // fetchImpl is injectable so tests can stand in for SMRT
  // wrapped so Workers never calls the global fetch with the Smrt object as `this` ("Illegal invocation")
  constructor({ url, key, fetchImpl = (...a) => fetch(...a) }) { this.url = url; this.key = key; this.fetch = (...a) => fetchImpl(...a); this.cols = {}; this.calls = 0; }

  async gql(query) {
    this.calls++;
    const r = await this.fetch(this.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` }, body: JSON.stringify({ query }) });
    const txt = await r.text();
    if (r.status === 401 || r.status === 403) throw new Error("SMRT rejected the API key");
    let j; try { j = JSON.parse(txt); } catch { throw new Error(`SMRT answered ${r.status} without data`); }
    if (j.errors && j.errors.length) throw new Error("SMRT: " + j.errors.map(e => e.message).join("; "));
    return j.data && j.data.business;
  }

  async columns(id, day) {
    if (this.cols[id]) return this.cols[id];
    const b = await this.gql(`{ business { getReport(id:"${id}", startDate:"${day}", endDate:"${addDays(day, 1)}", limit:1) { columns { name } } } }`);
    const names = ((b && b.getReport && b.getReport.columns) || []).map(c => String((c && c.name) || ""));
    if (!names.length) throw new Error(`SMRT report ${id.slice(0, 8)}… wasn't found`);
    return (this.cols[id] = names);
  }

  async rows(id, from, to) {
    const b = await this.gql(`{ business { getReport(id:"${id}", startDate:"${from}", endDate:"${to}", limit:${LIMIT}) { values } } }`);
    if (!b || !b.getReport) throw new Error(`SMRT report ${id.slice(0, 8)}… wasn't found`);
    let v = b.getReport.values;
    if (typeof v === "string") v = JSON.parse(v);
    if (v == null) return [];
    return v.map(r => (Array.isArray(r) ? r : r && Array.isArray(r.value) ? r.value : null)).filter(Boolean);
  }

  // every row created on `day`, split into parts of the day if SMRT caps the answer
  async day(id, day) {
    const all = await this.rows(id, day, addDays(day, 1));
    if (all.length < LIMIT) return all;
    const out = [];
    for (const [a, b] of [["00", "08"], ["08", "12"], ["12", "16"], ["16", null]]) {
      const part = await this.rows(id, `${day}T${a}:00:00`, b ? `${day}T${b}:00:00` : addDays(day, 1));
      if (part.length >= LIMIT) throw new Error(`more than ${LIMIT} rows were created in part of ${day}`);
      out.push(...part);
    }
    return out;
  }

  // a report's rows as objects keyed by column name
  async dayObjects(id, day) {
    const cols = await this.columns(id, day);
    return (await this.day(id, day)).map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  }
}
