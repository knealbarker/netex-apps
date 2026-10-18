// Retail Snapshot settings (core_settings, app 'retail', key 'snapshot'). Admins and the Owner change them.
import { HttpError, audit } from "../../planner/src/util.js";
import { requireRole } from "../../planner/src/auth.js";
import { assemblerPlants, addDays, localToday } from "./snapshot.js";

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
  summary: { enabled: false, to: [], hour: 7, days: [1, 2, 3, 4, 5, 6] },
  // which plant does the work for each SMRT financial department; its pieces' value is that plant's production value
  assemblers: { Conveyor: "Workshop" },   // SMRT 'Assembled by' name -> plant ("department" = use the department map)
  plantWork: {
    "Dry Cleaning Tops": "Workshop", "Dry Cleaning Bottoms": "Workshop", "Laundry Tops": "Workshop", "Laundry Bottoms": "Workshop",
    "Household": "Workshop", "Wash & Fold": "Laundry Hub",
  },   // daily email: local hour, days of week it goes out (0 = Sunday)
  // Counter tab (Neal, Oct 18): a gap of gapSec or more between two detailed pieces is a distraction gap, left out of
  // detailing speed; a salaried person gets pickupMin for each pickup while they're at the counter; one customer's
  // tickets and pickups within visitWindowMin are one visit; clock check allows graceMin around punches and needs
  // minEvents SMRT actions before it flags anything. salaried = SMRT/Rippling names of people paid a salary.
  // alertOn/alertTo: text these users (by email; their mobile number from Users & access) when someone on the clock has
  // done at least alertMin SMRT actions in the last alertLookbackMin minutes, most of them at another store (Neal: Karla)
  counter: { gapSec: 90, pickupMin: 2, visitWindowMin: 20, graceMin: 15, minEvents: 3, salaried: ["Karla Velasquez", "Debra Norton"],
    alertOn: true, alertTo: ["karla@towncountryclean.com"], alertMin: 5, alertLookbackMin: 60 },
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
  return { ...DEFAULTS, ...s, avgRates: { ...DEFAULTS.avgRates, ...(s.avgRates || {}) }, rollup: s.rollup || DEFAULTS.rollup, hidden: s.hidden || [], summary: { ...DEFAULTS.summary, ...(s.summary || {}) }, counter: { ...DEFAULTS.counter, ...(s.counter || {}) }, plantWork: s.plantWork || DEFAULTS.plantWork, assemblers: s.assemblers || DEFAULTS.assemblers };
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

function cleanEmails(v, what) {
  const list = [...new Set((Array.isArray(v) ? v : String(v || "").split(/[\s,;]+/)).map(e => String(e).trim().toLowerCase()).filter(Boolean))];
  const bad = list.find(e => !EMAIL.test(e));
  if (bad) throw new HttpError(400, `“${bad}” isn't an email address.`);
  if (list.length > 5) throw new HttpError(400, `Send the ${what} to 5 people at most.`);
  return list;
}

function cleanCounter(v = {}) {
  const d = DEFAULTS.counter;
  const names = (Array.isArray(v.salaried) ? v.salaried : String(v.salaried ?? d.salaried.join("\n")).split(/[\n,;]+/)).map(name).filter(Boolean);
  if (names.length > 30) throw new HttpError(400, "List 30 salaried people at most.");
  return {
    gapSec: Math.round(num(v.gapSec ?? d.gapSec, 15, 900, "Distraction gap")),
    pickupMin: num(v.pickupMin ?? d.pickupMin, 0, 30, "Time per pickup"),
    visitWindowMin: Math.round(num(v.visitWindowMin ?? d.visitWindowMin, 1, 120, "Same visit within")),
    graceMin: Math.round(num(v.graceMin ?? d.graceMin, 0, 120, "Clock check grace")),
    minEvents: Math.round(num(v.minEvents ?? d.minEvents, 1, 50, "Clock check minimum")),
    salaried: [...new Set(names)],
    alertOn: v.alertOn === undefined ? d.alertOn : !!v.alertOn,
    alertTo: cleanEmails(v.alertTo ?? d.alertTo, "text"),
    alertMin: Math.round(num(v.alertMin ?? d.alertMin, 1, 100, "Text after")),
    alertLookbackMin: Math.round(num(v.alertLookbackMin ?? d.alertLookbackMin, 10, 240, "Look back")),
  };
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
    counter: cleanCounter(b.counter),
    plantWork: {}, assemblers: {},
  };
  for (const [k, v] of Object.entries(b.plantWork || {})) { const d = name(k), pl = name(v); if (d && pl) out.plantWork[d] = pl; }
  for (const [k, v] of Object.entries(b.assemblers || {})) { const a = String(k).trim().slice(0, 60), pl = name(v); if (a && pl) out.assemblers[a] = pl; }
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
  const posDepartments = (await db.prepare("SELECT name FROM pos_departments WHERE org_id=? AND deleted_at IS NULL ORDER BY name").bind(env.ORG_ID).all()).results.map(d => d.name);
  const rates = await db.prepare(`SELECT COUNT(DISTINCT h.person_id) AS people, COUNT(DISTINCT r.person_id) AS withRate
      FROM labor_daily_hours h LEFT JOIN labor_pay_rates r ON r.person_id=h.person_id AND r.deleted_at IS NULL
      WHERE h.work_date >= date('now','-35 days') AND h.deleted_at IS NULL`).first();
  const last = await db.prepare("SELECT value_json FROM core_settings WHERE org_id=? AND app_id='core' AND key='rippling_last'").bind(env.ORG_ID).first();
  // who assembled pieces in the last 60 days, and which plant their work counts for
  const today = localToday(env.TIMEZONE);
  const asm = (await db.prepare(`SELECT st.smrt_name AS name, COUNT(*) AS pieces FROM pos_items i JOIN pos_staff st ON st.id=i.assembled_by_staff_id JOIN pos_orders o ON o.id=i.order_id
      WHERE o.org_id=? AND i.assembled_at >= ? AND i.removed_at IS NULL GROUP BY st.smrt_name ORDER BY pieces DESC LIMIT 60`).bind(env.ORG_ID, addDays(today, -60)).all()).results;
  const s = await loadSettings(db, env);
  const auto = await assemblerPlants(db, env, asm.map(a => a.name), { ...s, assemblers: {} }, today);
  const assemblers = asm.map(a => ({ ...a, auto: auto.get(a.name) || null, set: s.assemblers[a.name] || "" }));
  return { locations, departments, posDepartments, assemblers, rates, rippling: last ? JSON.parse(last.value_json) : null };
}
