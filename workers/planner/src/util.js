// Small helpers for the planner web app's server side. Runs in Cloudflare Workers and in Node 22 (tests).

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// ULID: sortable by time, made where the row is created (an offline PC never clashes)
export function ulid(now = Date.now()) {
  let t = now, time = "";
  for (let i = 0; i < 10; i++) { time = ENC[t % 32] + time; t = Math.floor(t / 32); }
  const r = new Uint8Array(16); crypto.getRandomValues(r);
  let rand = ""; for (let i = 0; i < 16; i++) rand += ENC[r[i] % 32];
  return time + rand;
}

export const nowIso = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export async function readJson(req) {
  try { return await req.json(); } catch { throw new HttpError(400, "The request wasn't valid JSON."); }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const cleanEmail = v => {
  const e = String(v ?? "").trim().toLowerCase();
  if (!EMAIL.test(e)) throw new HttpError(400, "Enter a valid email address.");
  return e;
};
/** Mobile numbers: US numbers to +1XXXXXXXXXX (same rules as netex-auth); "" or null = no phone. */
export const PHONE_EMAIL_DOMAIN = "phone.netexcleaners.com";
export const phoneAlias = phone => `${phone.replace(/\D/g, "")}@${PHONE_EMAIL_DOMAIN}`;
export const isPhoneAlias = email => String(email || "").toLowerCase().endsWith("@" + PHONE_EMAIL_DOMAIN);
export const cleanPhone = v => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+") && !s.startsWith("+1") && d.length >= 8 && d.length <= 15) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  throw new HttpError(400, "Enter a 10-digit mobile number, like (903) 555-0123.");
};
export const cleanName = (v, what = "Name") => {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!s) throw new HttpError(400, `${what} is required.`);
  if (s.length > 80) throw new HttpError(400, `${what} is too long.`);
  return s;
};

export async function audit(db, { orgId, userId, appId, entity, entityId, action, changes }) {
  await db.prepare("INSERT INTO core_audit_log(id,org_id,at,user_id,app_id,entity,entity_id,action,changes_json) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(ulid(), orgId, nowIso(), userId || null, appId || null, entity, entityId, action, changes ? JSON.stringify(changes) : null).run();
}
