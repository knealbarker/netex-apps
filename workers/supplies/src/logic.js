// The rules for turning a count into a need. Pure functions (no database), shared by the Worker and the tests.

export const MODES = ["count", "level", "check"];
export const LEVELS = ["out", "low", "ok"];
const r2 = n => Math.round(n * 100) / 100;

/**
 * How many to send (store) or how many short (Workshop) for one answered line.
 * count: a number on hand. Below par -> need par − on hand. With a reorder point, only once at or below it (then back up to par).
 * level: Out -> a full par; Low -> half the par (rounded up, at least 1 when the par is 2 or more); OK -> nothing.
 * check: "Need any?" Yes -> the number they asked for (1 if blank); No -> nothing.
 * Returns null when the line wasn't answered.
 */
export function needOf({ mode, par, reorder_at: reorder }, { qty, level } = {}) {
  const hasPar = par !== null && par !== undefined;
  if (mode === "count") {
    if (qty === null || qty === undefined || qty === "") return null;
    const q = Number(qty);
    if (!hasPar) return 0;
    const short = reorder !== null && reorder !== undefined ? q <= reorder : q < par;
    return short ? Math.max(0, r2(par - q)) : 0;
  }
  if (mode === "level") {
    if (!LEVELS.includes(level)) return null;
    if (level === "ok") return 0;
    if (!hasPar) return 1;
    if (level === "out") return par;
    return par >= 2 ? Math.ceil(par / 2) : par;
  }
  if (mode === "check") {
    if (level === "none") return 0;
    if (level !== "need") return null;
    const q = Number(qty);
    return Number.isFinite(q) && q > 0 ? r2(q) : 1;
  }
  return null;
}

/** Vendor orders are whole units (bulk units): a shortfall of 0.5 bottle orders 1 bottle. */
export const orderQty = need => (need > 0 ? Math.max(1, Math.ceil(need - 1e-9)) : 0);

/** Cleans a number someone typed: up to 2 decimals, 0..99999. Returns null for blank. Throws on nonsense. */
export function cleanQty(v, what = "Count") {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 99999) throw new Error(`${what} must be a number from 0 to 99,999.`);
  return r2(n);
}

/** 'Karla V', 'karlav', 'Karla Velasquez' -> 'karlav'. First word + first letter of the last word, or the typed run as-is. */
export function handleOf(typed) {
  const s = String(typed || "").trim().toLowerCase().replace(/[^a-z\s]/g, "");
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) return words[0];
  return words[0] + words[words.length - 1][0];
}

/** The next shuttle day (Mon–Fri) on or after `day` (YYYY-MM-DD). */
export function nextShuttleDay(day) {
  const d = new Date(day + "T12:00:00Z");
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function addDays(day, n) {
  const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
/** Business days (Mon–Fri) after `day`. */
export function addWorkDays(day, n) {
  let d = day, left = n;
  while (left > 0) { d = addDays(d, 1); const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d;
}

export function localToday(tz = "America/Chicago", at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
