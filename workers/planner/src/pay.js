// Pay rates: each person's hourly rate from the Rippling time clock report (labor_pay_rates, read by netex-sync).
// A rate applies from its effective day; before a person's first known rate, the first rate is used; people with no
// rate yet are costed at Settings › Money › Average hourly pay. Only Admins and the Owner ever receive rates.

/** person id -> [{ on, rate }] (dollars, oldest first) for the given people (all people when ids is omitted). */
export async function payRates(db, orgId, ids = null) {
  const rows = (await db.prepare(`SELECT r.person_id AS pid, r.effective_on AS d, r.hourly_cents AS c FROM labor_pay_rates r JOIN core_people p ON p.id=r.person_id
      WHERE p.org_id=? AND r.deleted_at IS NULL ORDER BY r.effective_on`).bind(orgId).all()).results;
  const want = ids ? new Set(ids) : null, out = new Map();
  for (const r of rows) {
    if (want && !want.has(r.pid)) continue;
    (out.get(r.pid) || out.set(r.pid, []).get(r.pid)).push({ on: r.d, rate: r.c / 100 });
  }
  return out;
}

/** The rate on a day (null when the person has none). */
export function rateOn(list, day) {
  if (!list || !list.length) return null;
  let r = list[0].rate;
  for (const x of list) if (x.on <= day) r = x.rate;
  return r;
}

/** Cost of a list of {personId, hours} on a day; also how many hours fell back to the average rate. */
export function laborCost(rows, day, rates, payAvg) {
  let cost = 0, avgH = 0, hours = 0;
  for (const p of rows) {
    const h = +p.hours || 0, r = rateOn(rates.get(p.personId), day);
    hours += h; if (r == null) avgH += h;
    cost += h * (r ?? payAvg);
  }
  return { cost, hours, avgHours: avgH };
}
