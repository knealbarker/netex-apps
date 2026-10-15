// Read-only SQL for Claude. D1 has no read-only connection, so a query is checked before it runs:
//  - one statement, starting with SELECT or WITH
//  - none of the words that change data or the database (checked outside quotes and comments)
//  - no secret tables; pay rates only for Admins and the Owner
// Then it runs wrapped as SELECT * FROM (...) LIMIT n, which SQLite only accepts around a query.

const WRITE_WORDS = ["insert", "update", "delete", "drop", "alter", "create", "attach", "detach", "pragma",
  "vacuum", "reindex", "analyze", "begin", "commit", "rollback", "savepoint", "release", "load_extension"];

// tables that hold sign-in secrets, device secrets or photos: never readable here
export const SECRET_TABLES = ["mcp_clients", "mcp_codes", "mcp_tokens", "auth_requests", "auth_codes", "auth_events", "auth_keys",
  "plan_station_devices", "plan_station_photos", "supply_devices", "_cf_kv", "d1_migrations"];
export const SECRET_COLUMNS = ["pin_hash"];
// readable only by Admins and the Owner (same as the apps)
export const MONEY_TABLES = ["labor_pay_rates"];

export class SqlRefused extends Error {}

/** SQL with string literals, quoted identifiers' insides and comments blanked out, lower-cased. Quoted identifiers keep their name. */
export function skeleton(sql) {
  let out = "", i = 0;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === "-" && n === "-") { const j = s.indexOf("\n", i); i = j < 0 ? s.length : j; out += " "; continue; }
    if (c === "/" && n === "*") { const j = s.indexOf("*/", i + 2); if (j < 0) throw new SqlRefused("A comment isn't closed."); i = j + 2; out += " "; continue; }
    if (c === "'") { // string literal: '' is an escaped quote
      let j = i + 1; for (;;) { if (j >= s.length) throw new SqlRefused("A quote isn't closed."); if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out += "''"; i = j + 1; continue;
    }
    if (c === '"' || c === "`" || c === "[") { // quoted identifier: keep the name so table checks still see it
      const close = c === "[" ? "]" : c; const j = s.indexOf(close, i + 1);
      if (j < 0) throw new SqlRefused("A quoted name isn't closed.");
      out += " " + s.slice(i + 1, j).toLowerCase() + " "; i = j + 1; continue;
    }
    out += c.toLowerCase(); i++;
  }
  return out;
}

/** Throws SqlRefused with a plain reason, or returns the cleaned query (no trailing semicolon). */
export function checkSql(sql, { money = false } = {}) {
  let q = String(sql || "").trim();
  if (!q) throw new SqlRefused("The query is empty.");
  if (q.length > 20000) throw new SqlRefused("The query is too long.");
  let sk = skeleton(q).trim();
  while (sk.endsWith(";")) { sk = sk.slice(0, -1).trimEnd(); q = q.replace(/;\s*$/, ""); }
  if (sk.includes(";")) throw new SqlRefused("Only one statement at a time.");
  if (!/^(select|with)\b/.test(sk)) throw new SqlRefused("Only SELECT (or WITH … SELECT) queries are allowed. This connector is read-only.");
  const words = new Set(sk.match(/[a-z_][a-z0-9_$]*/g) || []);
  const bad = WRITE_WORDS.find(w => words.has(w)) || (/\breplace\s+into\b/.test(sk) ? "replace into" : null); // replace() the function is fine
  if (bad) throw new SqlRefused(`"${bad.toUpperCase()}" isn't allowed. This connector is read-only.`);
  const secret = SECRET_TABLES.find(t => words.has(t)) || SECRET_COLUMNS.find(t => words.has(t));
  if (secret) throw new SqlRefused(`${secret} holds sign-in secrets and can't be read here.`);
  if (!money) { const m = MONEY_TABLES.find(t => words.has(t)); if (m) throw new SqlRefused(`${m} (pay rates) is for Admins and the Owner only.`); }
  return q;
}

const cell = (v, max) => (typeof v === "string" && v.length > max ? v.slice(0, max) + `… (${v.length} chars)` : v);

/** Runs a checked query. Returns { columns, rows (arrays), truncated }. */
export async function runSql(db, sql, { money = false, maxRows = 200, maxCell = 400 } = {}) {
  const q = checkSql(sql, { money });
  const limit = Math.max(1, Math.min(1000, maxRows | 0 || 200));
  let res;
  try {
    res = await db.prepare(`SELECT * FROM (${q}\n) LIMIT ${limit + 1}`).all();
  } catch (e) {
    throw new SqlRefused("The database answered: " + String(e && e.message || e).replace(/^D1_ERROR:\s*/, "").slice(0, 300));
  }
  const list = res.results || [];
  const columns = list.length ? Object.keys(list[0]) : [];
  const truncated = list.length > limit;
  const rows = list.slice(0, limit).map(r => columns.map(c => cell(r[c], maxCell)));
  return { columns, rows, truncated };
}
