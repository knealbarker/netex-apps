// Paid break policy (Neal, Oct 15, 2026) — Production and Laundry Hub employees:
//   - One paid break a day: the FIRST gap between a clock-out and the next clock-in that day.
//   - Paid up to 30 minutes. Back within 35 minutes: the break is paid (a 33-minute break pays 30).
//     Back later than 35 minutes: the whole break is unpaid.
//   - Any later gap that day is an unexpected absence: unpaid.
// Rippling punches are to the minute, so "35 minutes" means a gap of 35 minutes or less.
// Gaps shorter than MIN_GAP minutes (switching departments, a double punch) aren't breaks and don't use up the paid break.
// Used by netex-sync (finished days), the planner (today's punches, plans) and the Retail Snapshot (today's punches).

export const BREAK_PAID_MAX = 30;   // minutes paid at most
export const BREAK_LIMIT = 35;      // back after this many minutes: nothing paid
export const MIN_GAP = 3;           // smaller gaps aren't breaks

/** Paid minutes of a break that lasted `min` minutes. */
export function paidBreakMin(min) {
  return min > 0 && min <= BREAK_LIMIT + 1e-6 ? Math.min(min, BREAK_PAID_MAX) : 0;
}
/** Same, in hours (for a plan's break length in hours). */
export const paidBreakH = h => paidBreakMin(Math.round((+h || 0) * 60)) / 60;

/**
 * The day's paid break from its punches.
 * @param punches [{ i: minute of the day clocked in, o: minute clocked out | null, ...anything }]
 * @param nowMin  today's minute: a break still going (clocked out, not back yet) counts while it's within 35 minutes
 * @returns null (no break yet) or { from, to, gap, paid, open, before } — minutes; `before` is the punch the break follows
 */
export function firstBreak(punches, nowMin = null) {
  const P = (punches || []).filter(p => p && p.i != null).slice().sort((a, b) => a.i - b.i);
  let end = null, before = null;   // latest clock-out so far, and its punch
  for (let k = 0; k < P.length; k++) {
    const p = P[k];
    if (end != null && p.i - end >= MIN_GAP) { const gap = p.i - end; return { from: end, to: p.i, gap, paid: paidBreakMin(gap), open: false, before }; }
    if (p.o == null) return null;   // still clocked in, no break yet
    if (end == null || p.o >= end) { end = p.o; before = p; }
  }
  if (end != null && nowMin != null && nowMin - end >= MIN_GAP) { const gap = nowMin - end; return { from: end, to: null, gap, paid: paidBreakMin(gap), open: true, before }; }
  return null;
}

/** "2026-10-15T08:30:00-05:00" or "08:30" -> minute of the day (the local clock time as written). */
export function minuteOf(t) {
  const m = /(?:^|[T ])(\d{1,2}):(\d{2})/.exec(String(t || ""));
  return m ? +m[1] * 60 + +m[2] : null;
}
