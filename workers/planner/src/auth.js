// Who is asking? Cloudflare Access signs everyone in (email one-time PIN) before a request reaches this Worker
// and adds a signed token (JWT). We check that token ourselves, then look the email up in core_users.
// Checking here as well means a mistake in the Access settings can't open the app to strangers.
import { HttpError, nowIso } from "./util.js";

const ROLE_RANK = { viewer: 10, manager: 20, admin: 30, owner: 40 };
export const rank = role => ROLE_RANK[role] || 0;

let certCache = { at: 0, url: "", keys: [] };
const CERT_TTL_MS = 60 * 60 * 1000;

async function accessKeys(teamDomain, fetchImpl, force = false) {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  if (!force && certCache.url === url && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const r = await fetchImpl(url);
  if (!r.ok) throw new HttpError(503, "Couldn't reach the sign-in service to check your login. Try again in a minute.");
  const { keys = [] } = await r.json();
  certCache = { at: Date.now(), url, keys };
  return keys;
}
export const _resetCertCache = () => { certCache = { at: 0, url: "", keys: [] }; };

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
const part = s => JSON.parse(new TextDecoder().decode(b64url(s)));

/** Checks a Cloudflare Access token. Returns its claims, or throws 401. */
export async function verifyAccessJwt(token, { teamDomain, aud, fetchImpl = fetch, now = Date.now() }) {
  if (!token) throw new HttpError(401, "Not signed in.");
  const bits = token.split(".");
  if (bits.length !== 3) throw new HttpError(401, "Sign-in token is malformed.");
  let header, claims;
  try { header = part(bits[0]); claims = part(bits[1]); } catch { throw new HttpError(401, "Sign-in token is malformed."); }
  if (header.alg !== "RS256") throw new HttpError(401, "Sign-in token uses an unexpected algorithm.");

  let keys = await accessKeys(teamDomain, fetchImpl);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { keys = await accessKeys(teamDomain, fetchImpl, true); jwk = keys.find(k => k.kid === header.kid); } // keys rotate
  if (!jwk) throw new HttpError(401, "Sign-in token was signed by an unknown key.");

  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(bits[2]), new TextEncoder().encode(`${bits[0]}.${bits[1]}`));
  if (!ok) throw new HttpError(401, "Sign-in token signature doesn't match.");

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new HttpError(401, "Sign-in token is for a different application.");
  if (claims.iss !== teamDomain) throw new HttpError(401, "Sign-in token came from a different sign-in service.");
  const sec = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp < sec) throw new HttpError(401, "Your sign-in has expired. Reload the page to sign in again.");
  if (typeof claims.nbf === "number" && claims.nbf > sec + 60) throw new HttpError(401, "Sign-in token isn't valid yet.");
  return claims;
}

const cookie = (req, name) => {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
};

/**
 * Signed-in user for this request: { id, email, name, role, roles:{app:role} }.
 * Throws 401 (no valid token) or 403 (valid token, but not on the user list / disabled / no role in this app).
 */
export async function currentUser(req, env, { fetchImpl = fetch } = {}) {
  let email;
  const url = new URL(req.url);
  if (env.DEV_EMAIL && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    email = env.DEV_EMAIL; // local development only; never set in Cloudflare
  } else {
    const token = req.headers.get("cf-access-jwt-assertion") || cookie(req, "CF_Authorization");
    const claims = await verifyAccessJwt(token, { teamDomain: env.TEAM_DOMAIN, aud: env.ACCESS_AUD, fetchImpl });
    email = claims.email;
    if (!email) throw new HttpError(403, "This sign-in has no email address.");
  }
  email = String(email).toLowerCase();

  const db = env.DB;
  const u = await db.prepare("SELECT id, email, display_name AS name, status FROM core_users WHERE org_id=? AND lower(email)=? AND deleted_at IS NULL")
    .bind(env.ORG_ID, email).first();
  if (!u) throw new HttpError(403, "You're signed in, but you're not on this app's user list yet.", { email, reason: "not_listed" });
  if (u.status !== "active") throw new HttpError(403, "Your account has been turned off.", { email, reason: "disabled" });

  const { results } = await db.prepare("SELECT app_id, role_id FROM core_user_app_roles WHERE user_id=?").bind(u.id).all();
  const roles = Object.fromEntries(results.map(r => [r.app_id, r.role_id]));
  const role = roles[env.APP_ID];
  if (!role) throw new HttpError(403, "You don't have access to this app yet.", { email, reason: "no_role" });

  // last seen, at most once every 5 minutes
  await db.prepare("UPDATE core_users SET last_seen_at=? WHERE id=? AND (last_seen_at IS NULL OR last_seen_at < ?)")
    .bind(nowIso(), u.id, new Date(Date.now() - 5 * 60 * 1000).toISOString()).run();
  return { id: u.id, email: u.email, name: u.name, role, roles };
}

export function requireRole(user, min) {
  if (rank(user.role) < rank(min)) throw new HttpError(403, `This needs ${min} access or higher.`);
}
