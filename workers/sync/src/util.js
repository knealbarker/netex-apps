// Small helpers shared by the sync jobs. Runs in Cloudflare Workers and in Node 22 (tests).

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// ULID: sortable by time, made where the row is created (offline PCs never clash)
export function ulid(now = Date.now()) {
  let t = now, time = "";
  for (let i = 0; i < 10; i++) { time = ENC[t % 32] + time; t = Math.floor(t / 32); }
  const r = new Uint8Array(16); crypto.getRandomValues(r);
  let rand = ""; for (let i = 0; i < 16; i++) rand += ENC[r[i] % 32];
  return time + rand;
}

export async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export const nowIso = () => new Date().toISOString();

// 'YYYY-MM-DD' arithmetic in plain calendar days
export function addDays(day, n) {
  const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// today's date and hour in the company's time zone
export function localNow(tz = "America/Chicago", at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(at).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

const blank = v => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
export const text = v => (blank(v) ? null : String(v).trim());
export const int = v => (blank(v) || isNaN(+v) ? null : Math.round(+v));
export const num = v => (blank(v) || isNaN(+v) ? null : +v);
export const bool = v => (/^(1|true|yes|y)$/i.test(String(v ?? "").trim()) ? 1 : 0);
// SMRT timestamps come with an offset ('2026-10-08T18:41:30-05:00'); kept as sent
export const stamp = v => text(v);

// SMRT location names look like 'TCC Sulphur Springs'
export const storeName = v => { const s = text(v); return s ? s.replace(/^TCC\s+/i, "").trim() : null; };
