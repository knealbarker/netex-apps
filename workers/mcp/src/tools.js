// The connector's tools. All read-only. Roles are the same as in the apps:
//   query_db / describe_data: role in app 'claude' (pay rates for Admin and Owner only)
//   production_day: the person's planner role (labor $ for Admin and Owner, as in Review)
//   store_snapshot: the person's retail role (labor shown as the Retail Snapshot shows it)
// Every call is written to mcp_tool_log. Live SMRT calls carry a "topic", so questions that keep needing live SMRT show up
// and can be moved into a D1 table instead (Neal, Oct 15).
import { runSql, SqlRefused, SECRET_TABLES } from "./sql.js";
import { Smrt, REPORT_ORDERS, REPORT_ITEMS } from "../../sync/src/smrt.js";
import { reviewDay } from "../../planner/src/review.js";
import { snapshot } from "../../retail/src/snapshot.js";
import { rank } from "../../planner/src/auth.js";
import { HttpError, ulid, nowIso } from "../../planner/src/util.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const MAX_TEXT = 60000;
const REPEAT_HINT = 3;     // live SMRT asked the same kind of thing this many times in 30 days → suggest a D1 table

// One-line notes for describe_data. The CREATE statements (with their comments) come from the database itself.
export const TABLE_NOTES = {
  core_locations: "Stores, plants and route. kind plant/store/route; pos_name is SMRT's name ('TCC Quitman').",
  core_departments: "Payroll departments (Production, Retail, Laundry Hub…).",
  core_people: "Employees (Rippling). payroll_id = Rippling employee number.",
  core_users: "People who can sign in to the apps (email, status).",
  core_user_app_roles: "Role per person per app (planner, retail, claude): owner/admin/manager/viewer.",
  core_settings: "App settings as JSON (app_id + key), e.g. planner prices, rates, work days; retail targets.",
  core_audit_log: "Who changed what in the apps.",
  int_sync_runs: "Every SMRT / Rippling sync: when, ok/error, rows read/changed, message.",
  int_backfill_days: "SMRT history loaded one created-day at a time; shows how far back pos_ data goes.",
  pos_orders: "Every SMRT order (one row per order). Times are Central local with offset ('2026-10-15T12:00:00-05:00'): substr(x,1,10) = local day.",
  pos_items: "Every SMRT piece. order_id → pos_orders.id. removed_at set = taken off the order (leave out of counts).",
  pos_order_statuses: "Order statuses as SMRT spells them, with is_done / is_closed / is_void flags.",
  pos_item_statuses: "Piece statuses; is_assembled = complete for production.",
  pos_departments: "SMRT financial departments (Dry Cleaning Tops, Laundry Bottoms, Wash & Fold…).",
  pos_item_types: "SMRT item types (Shirt L, Comforter, Bedspread, Tablecloth…).",
  pos_order_departments: "Which departments each order has.",
  pos_staff: "Names as SMRT shows them ('Maria C'), matched to core_people when known.",
  pos_changes: "What changed in SMRT between syncs: due date moved, notes, pieces moved/added/removed, status, deleted.",
  labor_daily_hours: "PAID hours per person per day per department and location (Rippling), incl. the paid break (break_paid_hours).",
  labor_clock_today: "Punches from the latest Rippling report (about a month). clock_out empty = still clocked in.",
  labor_punch_log: "Punch history: new clock-ins/outs, edits and removals as each Rippling report arrived.",
  labor_pay_rates: "Hourly pay in cents from a date on (Admins and the Owner only).",
  plan_days: "Planner: one row per planned day.",
  plan_assignments: "Planner: who is on which station that day (start, stop, break, moves_json).",
  plan_publications: "Planner: frozen snapshot of each published plan.",
  plan_events: "Planner: Changes today, accepted/dismissed suggestions, Review notes (key review:<dept>).",
  plan_time_off: "Out (from_day..to_day) or late (arrival time) per person.",
  plan_trainings: "Planner stations/trainings (SLB 1, DCT 1, IAB 1, Comforters…).",
  plan_person_trainings: "Who is trained where; depth = place on that station's depth chart (1 = first choice).",
  plan_person_prefs: "Usual days/clock-in/hours, must-leave-by, SLB goal per person.",
  plan_station_tally: "Starch-bottoms pairs counted on the station tablets (SLB 1 / SLB 2).",
  plan_followups: "Follow-ups the planner asked for (due date moved, piece moved, overdue) and their reasons.",
  supply_locations: "Supplies: the 7 places that keep supplies; role warehouse (Workshop) or store (restocked by the shuttle).",
  supply_vendors: "Supplies: vendors, how ordered, lead_days (business days), min_order_cents.",
  supply_items: "Supplies: every supply item. unit = what stores count/receive; bulk_unit = what the Workshop counts and orders. unit_cost_cents per bulk unit.",
  supply_pars: "Supplies: item kept at a location: par (keep this many), reorder_at, mode count/level (Out/Low/OK)/check (Need any?).",
  supply_counters: "Supplies: people approved to send counts (first name + last initial).",
  supply_requests: "Supplies: the supply manager asking a location to count; done_at when a count came in.",
  supply_counts: "Supplies: each count sent from a location (who, when, items answered, items short).",
  supply_count_lines: "Supplies: one answer per item per count: qty or level, the par then, and need (how many short).",
  supply_shipments: "Supplies: shuttle lists per store; status open/sent/replaced (a newer count came in)/cancelled.",
  supply_shipment_lines: "Supplies: items on a shuttle list: need (asked for) and send_qty (what was sent; null = the need).",
  supply_orders: "Supplies: vendor orders placed by the supply manager; status ordered/received/cancelled, expected_on.",
  supply_order_lines: "Supplies: items and quantities (bulk units) on a vendor order.",
  mcp_tool_log: "This connector's own call log: which tools, which live SMRT topics, how often.",
};

const tool = (name, description, properties, required = []) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: name.startsWith("smrt_") } });

export const TOOLS = [
  tool("describe_data", "Lists the Netex database tables with what each holds, or shows one table's columns with their comments. Use before writing SQL against a table you haven't looked at. Also returns how fresh the SMRT and Rippling copies are.",
    { table: { type: "string", description: "A table name, e.g. pos_orders. Leave out for the list." } }),
  tool("query_db", "Runs one read-only SQL query (SQLite / Cloudflare D1) on the Netex database: SMRT orders and pieces (pos_), Rippling hours (labor_), planner (plan_). SELECT or WITH only. POS and Rippling times are Central local time with offset, so substr(col,1,10) is the local day.",
    { sql: { type: "string", description: "One SELECT or WITH … SELECT statement." },
      max_rows: { type: "integer", description: "Rows to return, 1-1000 (default 200). Aggregate in SQL instead of pulling many rows." } }, ["sql"]),
  tool("production_day", "The planner's Review for one work day, computed exactly as the Review page does: pieces due and finished, by department (starch bottoms, starch tops, DC tops, DC bottoms, comforters, tablecloths), paid hours, pieces per hour, labor $ and % (Admins), misses and notes, late orders, people and their hours.",
    { day: { type: "string", description: "YYYY-MM-DD, today or earlier." } }, ["day"]),
  tool("store_snapshot", "The Retail Snapshot for a date range, computed as retailview.netexcleaners.com does: sales (detailed), revenue (paid), collected %, hours, labor $ and % by store, Workshop and Laundry Hub production value, company total, previous-period comparison.",
    { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD (inclusive)" } }, ["from", "to"]),
  tool("smrt_order", "Reads one order live from SMRT: status, due date, pieces, stores, and order/piece notes (notes are not copied into the database). Use for notes or for an order changed in the last few minutes; otherwise prefer query_db. Accepts 262871234 or 26287-1234.",
    { order: { type: "string", description: "SMRT order number." } }, ["order"]),
  tool("smrt_report", "Reads rows live from one of SMRT's saved reports (orders or items, filtered by created date). Spends SMRT API calls and is slower; use only for columns the database doesn't keep or data newer than the last sync (every 10 min on work days).",
    { report: { type: "string", description: "'orders', 'items', or a saved report id." },
      from: { type: "string", description: "First created day, YYYY-MM-DD." },
      to: { type: "string", description: "Last created day, YYYY-MM-DD (inclusive; at most 31 days after from)." },
      columns: { type: "array", items: { type: "string" }, description: "Columns to return (exact SMRT names). Leave out to get the column list and a few rows." },
      where: { type: "object", additionalProperties: { type: "string" }, description: "Keep rows where each column equals this value (case-insensitive)." },
      max_rows: { type: "integer", description: "1-500 (default 100)." } }, ["report", "from", "to"]),
  tool("smrt_usage", "How often live SMRT tools were used in recent days, grouped by what was asked. Use when deciding whether a kind of SMRT data should be copied into the database.",
    { days: { type: "integer", description: "Look back this many days (default 30)." } }),
];

// ---------- helpers
const text = (obj) => {
  let t = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + `\n… cut at ${MAX_TEXT} characters; ask for less (a narrower range or a query_db aggregate).`;
  return { content: [{ type: "text", text: t }] };
};
const fail = msg => ({ content: [{ type: "text", text: msg }], isError: true });
const asUser = (me, app) => ({ id: me.id, email: me.email, name: me.name, role: me.roles[app] || me.role, roles: me.roles });

async function log(env, me, rec) {
  try {
    await env.DB.prepare("INSERT INTO mcp_tool_log(id, org_id, user_id, at, tool, source, topic, args_json, ms, rows, error) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(ulid(), env.ORG_ID, me.id, nowIso(), rec.tool, rec.source, rec.topic || null, JSON.stringify(rec.args || {}).slice(0, 2000), rec.ms ?? null, rec.rows ?? null, rec.error || null).run();
  } catch { /* the log never stops an answer */ }
}

async function repeatNote(env, topic) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_tool_log WHERE org_id=? AND source='smrt' AND topic=? AND at>=? AND error IS NULL").bind(env.ORG_ID, topic, since).first();
  const n = r ? r.n : 0;
  return n >= REPEAT_HINT
    ? `\n\n[connector note] Live SMRT has been asked for "${topic}" ${n} times in 30 days. Suggest to Neal adding this to the Netex database (a column or table filled by netex-sync), so it's instant and doesn't spend SMRT calls.`
    : `\n\n[connector note] Answered from live SMRT ("${topic}", ${n} time(s) in 30 days).`;
}

export function smrtClient(env, opts = {}) {
  if (!env.SMRT_KEY) throw new HttpError(503, "The SMRT key isn't set on the connector (secret SMRT_KEY on netex-mcp).");
  return new Smrt({ url: env.SMRT_URL, key: env.SMRT_KEY, fetchImpl: opts.fetchImpl });
}

// GraphQL selection for one order. SMRT has no introspection, so unknown fields are dropped and the query retried.
const ORDER_FIELDS = ["id", "status", "date", "dueDate", "readyDate", "returnedDate", "pieceCount", "rush", "isDelivery", "customerId",
  "pickupStore { name }", "dropStore { name }", "financialDepartments { id name }",
  "items { id barcode name pieces itemStatus { name isReady } type { name departmentId } }",
  "orderNotes { id message itemId status closed dueDate lastUpdated }"];

export async function readOrder(smrt, orderNo) {
  let fields = ORDER_FIELDS.slice(), dropped = [];
  for (let i = 0; i < 12; i++) {
    try {
      const b = await smrt.gql(`{ business { getOrder(id:"${orderNo}") { ${fields.join(" ")} } } }`);
      return { order: b && b.getOrder, dropped };
    } catch (e) {
      const m = /Cannot query field "(\w+)"/.exec(e.message || "");
      if (!m) throw e;
      const bad = m[1], before = JSON.stringify(fields);
      // drop a top-level field, or the bad sub-field inside a nested selection
      fields = fields.map(f => {
        if (f === bad || f.startsWith(bad + " ")) return null;
        if (f.includes("{")) {
          const open = f.indexOf("{");
          const inner = f.slice(open).replace(new RegExp(`\\s${bad}(\\s*\\{[^}]*\\})?(?=\\s)`), "");
          return /\{\s*\}/.test(inner) ? null : f.slice(0, open) + inner;
        }
        return f;
      }).filter(Boolean);
      if (JSON.stringify(fields) === before || !fields.length) throw e;
      dropped.push(bad);
    }
  }
  throw new Error("SMRT kept refusing the order query.");
}

// ---------- the calls
export async function callTool(env, me, name, args = {}, opts = {}) {
  const t0 = Date.now();
  const done = (source, extra = {}) => log(env, me, { tool: name, source, args, ms: Date.now() - t0, ...extra });
  try {
    switch (name) {
      case "describe_data": return await describeData(env, args, done);
      case "query_db": {
        const money = rank(me.role) >= rank("admin");
        const r = await runSql(env.DB, args.sql, { money, maxRows: args.max_rows });
        await done("d1", { rows: r.rows.length });
        return text({ columns: r.columns, rows: r.rows, ...(r.truncated ? { note: `More rows exist; only the first ${r.rows.length} are shown. Aggregate or filter in SQL.` } : {}) });
      }
      case "production_day": {
        const u = asUser(me, "planner");
        const r = await reviewDay(env.DB, env, u, String(args.day || ""));
        await done("planner");
        return text(r);
      }
      case "store_snapshot": {
        const u = asUser(me, "retail");
        const r = await snapshot(env.DB, env, u, String(args.from || ""), String(args.to || ""), { now: opts.now || Date.now() });
        await done("retail");
        return text(r);
      }
      case "smrt_order": {
        const no = String(args.order || "").replace(/\D/g, "");
        if (no.length < 6) return fail("Give an SMRT order number like 262871234 or 26287-1234.");
        const smrt = smrtClient(env, opts);
        const { order, dropped } = await readOrder(smrt, no);
        const topic = "order";
        await done("smrt", { topic, rows: order ? 1 : 0 });
        if (!order) return text(`SMRT has no order ${no}.` + await repeatNote(env, topic));
        const link = order.customerId ? `https://towncountryclean.smrtapp.com/posx/dash/customer/clothestracker/${order.customerId}/?saleId=${no}` : null;
        return text(JSON.stringify({ order, ...(link ? { open_in_smrt: link } : {}), ...(dropped.length ? { fields_smrt_does_not_have: dropped } : {}) }) + await repeatNote(env, topic));
      }
      case "smrt_report": return await smrtReport(env, me, args, done, opts);
      case "smrt_usage": {
        const days = Math.max(1, Math.min(365, args.days | 0 || 30));
        const since = new Date(Date.now() - days * 864e5).toISOString();
        const { results } = await env.DB.prepare(`SELECT topic, COUNT(*) AS calls, MAX(at) AS last, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
            FROM mcp_tool_log WHERE org_id=? AND source='smrt' AND at>=? GROUP BY topic ORDER BY calls DESC LIMIT 50`).bind(env.ORG_ID, since).all();
        const all = await env.DB.prepare("SELECT source, COUNT(*) AS calls FROM mcp_tool_log WHERE org_id=? AND at>=? GROUP BY source").bind(env.ORG_ID, since).all();
        await done("d1");
        return text({ days, live_smrt_by_topic: results, all_calls_by_source: all.results, suggest_d1_when_calls_at_least: REPEAT_HINT });
      }
      default: return fail(`Unknown tool ${name}.`);
    }
  } catch (e) {
    const msg = e instanceof SqlRefused || e instanceof HttpError ? e.message : `Something went wrong: ${String(e && e.message || e).slice(0, 300)}`;
    await done(name.startsWith("smrt_") ? "smrt" : "d1", { error: msg.slice(0, 500), topic: name === "smrt_order" ? "order" : undefined });
    return fail(msg);
  }
}

async function describeData(env, args, done) {
  const { results } = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").all();
  const visible = results.filter(t => !SECRET_TABLES.includes(t.name));
  if (args.table) {
    const t = visible.find(x => x.name === String(args.table).trim());
    await done("d1");
    if (!t) return fail(`No table ${args.table}. Leave out "table" to see the list.`);
    const idx = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").bind(t.name).all();
    return text(`${t.name}: ${TABLE_NOTES[t.name] || ""}\n\n${t.sql}\n\nIndexes:\n${idx.results.map(i => i.sql).join("\n") || "(none)"}`);
  }
  const fresh = await freshness(env);
  await done("d1");
  return text({ tables: visible.map(t => ({ name: t.name, about: TABLE_NOTES[t.name] || null })), freshness: fresh,
    conventions: "Money is integer cents. POS and Rippling times are Central local ISO with offset; substr(x,1,10) is the local day, substr(x,12,5) the local HH:MM. created_at/updated_at are UTC. Soft-deleted rows have deleted_at set." });
}

export async function freshness(env) {
  const runs = (await env.DB.prepare(`SELECT i.kind, r.status, r.started_at, r.finished_at, r.rows_read, r.message
      FROM int_integrations i JOIN int_sync_runs r ON r.integration_id=i.id
     WHERE i.org_id=? AND r.started_at = (SELECT MAX(started_at) FROM int_sync_runs WHERE integration_id=i.id)`).bind(env.ORG_ID).all()).results;
  const back = await env.DB.prepare(`SELECT MIN(day) AS oldest, MAX(day) AS newest, COUNT(*) AS days FROM int_backfill_days b JOIN int_integrations i ON i.id=b.integration_id
     WHERE i.org_id=? AND b.status IN ('done','empty')`).bind(env.ORG_ID).first();
  const hours = await env.DB.prepare("SELECT MIN(work_date) AS oldest, MAX(work_date) AS newest FROM labor_daily_hours").first();
  return { last_sync: runs, smrt_history_created_days: back, rippling_daily_hours: hours };
}

async function smrtReport(env, me, args, done, opts) {
  const which = String(args.report || "").trim().toLowerCase();
  const id = which === "orders" ? REPORT_ORDERS : which === "items" ? REPORT_ITEMS : /^[0-9a-f-]{36}$/.test(which) ? which : null;
  if (!id) return fail("report must be 'orders', 'items' or a saved report id.");
  const from = String(args.from || ""), to = String(args.to || "");
  if (!DAY.test(from) || !DAY.test(to) || to < from) return fail("Use from/to dates like 2026-10-01 (to on or after from).");
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 31) return fail("At most 31 days per call. Use query_db for longer ranges.");
  const smrt = smrtClient(env, opts);
  const cols = await smrt.columns(id, from);
  const want = Array.isArray(args.columns) ? args.columns.map(String) : null;
  const unknown = (want || []).concat(Object.keys(args.where || {})).filter(c => !cols.includes(c));
  if (unknown.length) return fail(`SMRT's ${which} report has no column ${unknown.map(c => `"${c}"`).join(", ")}. Columns: ${cols.join(", ")}`);
  const rows = await smrt.range(id, from, addDays(to, 1)); // SMRT's end date is exclusive
  const where = Object.entries(args.where || {}).map(([c, v]) => [cols.indexOf(c), String(v).toLowerCase()]);
  const keep = rows.filter(r => where.every(([i, v]) => String(r[i] ?? "").toLowerCase() === v));
  const max = Math.max(1, Math.min(500, args.max_rows | 0 || 100));
  const pick = want ? want.map(c => cols.indexOf(c)) : cols.map((_, i) => i);
  const out = keep.slice(0, want ? max : Math.min(max, 5)).map(r => pick.map(i => { const v = r[i]; return typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v; }));
  const topic = `${which === "orders" || which === "items" ? which : "report " + id.slice(0, 8)}: ${(want || ["(columns)"]).slice().sort().join(", ")}`.slice(0, 300);
  await done("smrt", { topic, rows: keep.length });
  return text(JSON.stringify({ report: which, created: { from, to }, smrt_calls: smrt.calls, matched_rows: keep.length, columns: want || cols, rows: out,
    ...(keep.length > out.length ? { note: want ? `Showing ${out.length} of ${keep.length}.` : "No columns asked for: here are all columns and 5 sample rows." } : {}) }) + await repeatNote(env, topic));
}
