// Retail Snapshot settings (core_settings, app 'retail', key 'snapshot'). Admins and the Owner change them.
import { HttpError, audit } from "../../planner/src/util.js";
import { requireRole } from "../../planner/src/auth.js";

export const DEFAULTS = {
  targetRetail: 17,            // store labor cost / store revenue, %
  targetPlant: 17,             // Workshop + Laundry Hub labor cost / company revenue, %
  burdenPct: 0,                // payroll taxes etc. added on top of wages, %
  avgRates: { Retail: 15, Production: 15, "Laundry Hub": 15 },   // $/hour when a person has no pay rate yet
  defaultRate: 15,
  rollup: { Winnsboro: "Sulphur Springs" },  // shown on its own line but counted in this store (Neal, Oct 11)
  hidden: [],                  // SMRT locations that aren't stores (e.g. "Van")
  managersSeeLabor: false,     // Managers/Viewers see labor cost and labor %
  weekStart: 1,                // 1 = Monday; also the overtime work week
  overtime: true,              // hours past overtimeAfter in a work week cost overtimeMultiplier x
  overtimeAfter: 40,
  overtimeMultiplier: 1.5,
  summary: { enabled: false, to: [], hour: 7, days: [1, 2, 3, 4, 5, 6] },   // daily email: local hour, days of week it goes out (0 = Sunday)
};

const num = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${what} must be a number from ${min} to ${max}.`);
  return Math.round(n * 100) / 100;
};
const name = v => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 60);

export async function loadSettings(db, env) {
  const r = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='retail' AND key='snapshot'").bind(env.ORG_ID).first();
  const s = r ? JSON.parse(r.value_json) : {};
  return { ...DEFAULTS, ...s, avgRates: { ...DEFAULTS.avgRates, ...(s.avgRates || {}) }, rollup: s.rollup || DEFAULTS.rollup, hidden: s.hidden || [], summary: { ...DEFAULTS.summary, ...(s.summary || {}) } };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cleanSummary(v = {}) {
  const to = [...new Set((Array.isArray(v.to) ? v.to : String(v.to || "").split(/[\s,;]+/)).map(e => String(e).trim().toLowerCase()).filter(Boolean))];
  const bad = to.find(e => !EMAIL.test(e));
  if (bad) throw new HttpError(400, `“${bad}” isn't an email address.`);
  if (to.length > 10) throw new HttpError(400, "Send the summary to 10 people at most.");
  const hour = Math.round(num(v.hour ?? 7, 0, 23, "Send time"));
  const days = [...new Set((Array.isArray(v.days) ? v.days : [1, 2, 3, 4, 5, 6]).map(Number).filter(d => d >= 0 && d <= 6))].sort();
  if (v.enabled && !to.length) throw new HttpError(400, "Add at least one email address for the daily summary.");
  return { enabled: !!v.enabled, to, hour, days };
}

export function cleanSettings(b) {
  const out = {
    targetRetail: num(b.targetRetail, 0, 100, "Store labor target"),
    targetPlant: num(b.targetPlant, 0, 100, "Production labor target"),
    burdenPct: num(b.burdenPct, 0, 60, "Payroll burden"),
    defaultRate: num(b.defaultRate, 0, 200, "Default hourly rate"),
    avgRates: {}, rollup: {}, hidden: [],
    managersSeeLabor: !!b.managersSeeLabor,
    weekStart: [0, 1].includes(+b.weekStart) ? +b.weekStart : 1,
    overtime: b.overtime === undefined ? true : !!b.overtime,
    overtimeAfter: num(b.overtimeAfter ?? 40, 0, 80, "Overtime after"),
    overtimeMultiplier: num(b.overtimeMultiplier ?? 1.5, 1, 3, "Overtime rate"),
    summary: cleanSummary(b.summary),
  };
  for (const [k, v] of Object.entries(b.avgRates || {})) { const n = name(k); if (n) out.avgRates[n] = num(v, 0, 200, `Hourly rate for ${n}`); }
  for (const [k, v] of Object.entries(b.rollup || {})) { const a = name(k), t = name(v); if (a && t && a !== t) out.rollup[a] = t; }
  for (const h of b.hidden || []) { const n = name(h); if (n && !out.hidden.includes(n)) out.hidden.push(n); }
  return out;
}

export async function saveSettings(db, env, me, body) {
  requireRole(me, "admin");
  const s = cleanSettings(body || {});
  await db.prepare(`INSERT INTO core_settings(org_id, app_id, key, value_json, updated_by) VALUES(?, 'retail', 'snapshot', ?, ?)
    ON CONFLICT(org_id, app_id, key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), rev=rev+1`)
    .bind(env.ORG_ID, JSON.stringify(s), me.id).run();
  await audit(db, { orgId: env.ORG_ID, userId: me.id, appId: env.APP_ID, entity: "core_settings", entityId: "retail.snapshot", action: "update", changes: s });
  return loadSettings(db, env);
}

/** What the Settings screen needs besides the settings: locations, departments, and pay-rate coverage. */
export async function settingsContext(db, env) {
  const locations = (await db.prepare("SELECT name, kind FROM core_locations WHERE org_id=? AND deleted_at IS NULL ORDER BY kind DESC, name").bind(env.ORG_ID).all()).results;
  const departments = (await db.prepare("SELECT name FROM core_departments WHERE org_id=? AND deleted_at IS NULL ORDER BY name").bind(env.ORG_ID).all()).results.map(d => d.name);
  const rates = await db.prepare(`SELECT COUNT(DISTINCT h.person_id) AS people, COUNT(DISTINCT r.person_id) AS withRate
      FROM labor_daily_hours h LEFT JOIN labor_pay_rates r ON r.person_id=h.person_id AND r.deleted_at IS NULL
      WHERE h.work_date >= date('now','-35 days') AND h.deleted_at IS NULL`).first();
  const last = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='rippling_last'").bind(env.ORG_ID).first();
  return { locations, departments, rates, rippling: last ? JSON.parse(last.value_json) : null };
}
