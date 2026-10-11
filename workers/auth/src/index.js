// netex-auth — "Text me a code" sign-in for the netexcleaners.com apps (auth.netexcleaners.com).
//
// Cloudflare Access stays the gatekeeper for every app. This Worker is an extra sign-in method inside Access
// (an OpenID Connect provider): Access sends the person here, they type their mobile number, Twilio Verify texts
// them a code, and once the code checks out we send them back to Access with a signed token saying who they are.
//
// Rules
//  - Only numbers on the user list (core_users.phone, active) get a text. Anyone else sees the same "code sent"
//    page, so the list can't be probed, but nothing is sent.
//  - Limits: 5 texts per number per hour, 30 per network address per hour; 8 wrong codes per number per hour.
//  - The token's email is the person's email, or '<digits>@phone.netexcleaners.com' if they have none, so the apps
//    and the Access "Netex users" group work the same for everyone.
//
// Secrets (Workers > netex-auth > Settings > Variables and Secrets — entered by Neal, never in GitHub):
//   TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET  restricted key: Verify verification + verification-check create only
//   OIDC_CLIENT_SECRET                          the same value goes into the Access login method
import { page, phonePage, codePage, errorPage } from "./pages.js";

const SEND_PER_PHONE = 5, SEND_PER_IP = 30, BAD_PER_PHONE = 8, HOUR = 3600e3;
const REQUEST_TTL = 15 * 60e3, CODE_TTL = 2 * 60e3, TOKEN_TTL = 5 * 60;

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uStr = s => b64u(enc.encode(s));
const rand = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const SECURITY = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self' https://*.cloudflareaccess.com; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};
const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY } });

/** US numbers to +1XXXXXXXXXX; anything else that already starts with + and has 8-15 digits is kept. */
export function normalizePhone(v) {
  const s = String(v || "").trim();
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+") && !s.startsWith("+1")) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}
export const phoneAlias = phone => `${phone.replace(/\D/g, "")}@phone.netexcleaners.com`;
const masked = phone => `(•••) •••-${phone.slice(-4)}`;

// ---------------------------------------------------------------- signing key
async function signingKey(db) {
  let row = await db.prepare("SELECT kid, private_jwk, public_jwk FROM auth_keys ORDER BY created_at DESC LIMIT 1").first();
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const kid = rand(9);
    const priv = await crypto.subtle.exportKey("jwk", kp.privateKey), pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
    await db.prepare("INSERT OR IGNORE INTO auth_keys(kid, private_jwk, public_jwk, created_at) VALUES(?,?,?,?)").bind(kid, JSON.stringify(priv), JSON.stringify({ kty: pub.kty, n: pub.n, e: pub.e }), iso()).run();
    row = await db.prepare("SELECT kid, private_jwk, public_jwk FROM auth_keys ORDER BY created_at DESC LIMIT 1").first();
  }
  return row;
}
async function signJwt(db, claims) {
  const k = await signingKey(db);
  const key = await crypto.subtle.importKey("jwk", JSON.parse(k.private_jwk), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = b64uStr(JSON.stringify({ alg: "RS256", typ: "JWT", kid: k.kid })), body = b64uStr(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

// ---------------------------------------------------------------- Twilio Verify
async function twilio(env, path, form, fetchImpl) {
  const r = await fetchImpl(`https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SID}/${path}`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  let data = {}; try { data = await r.json(); } catch { /* empty */ }
  return { ok: r.ok, status: r.status, data };
}

// ---------------------------------------------------------------- helpers
const issuer = env => env.ISSUER || "https://auth.netexcleaners.com";
const ipOf = req => req.headers.get("cf-connecting-ip") || "unknown";
async function count(db, kind, col, val, sinceMs) {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM auth_events WHERE kind IN (${kind.map(() => "?").join(",")}) AND ${col}=? AND at>=?`).bind(...kind, val, iso(Date.now() - sinceMs)).first();
  return r.n;
}
const event = (db, kind, phone, ip) => db.prepare("INSERT INTO auth_events(id, kind, phone, ip, at) VALUES(?,?,?,?,?)").bind(rand(12), kind, phone, ip, iso()).run();
async function loadRequest(db, id) {
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;
  const r = await db.prepare("SELECT * FROM auth_requests WHERE id=?").bind(id).first();
  return r && r.expires_at > iso() ? r : null;
}
async function findUser(db, env, phone) {
  return db.prepare(`SELECT u.id, u.email, u.display_name AS name FROM core_users u WHERE u.org_id=? AND u.phone=? AND u.status='active' AND u.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM core_user_app_roles r WHERE r.user_id=u.id)`).bind(env.ORG_ID, phone).first();
}
const allowedRedirect = (env, uri) => (env.REDIRECT_URIS || "").split(",").map(s => s.trim()).filter(Boolean).includes(uri);

// ---------------------------------------------------------------- endpoints
async function authorize(req, env) {
  const u = new URL(req.url), q = u.searchParams;
  const clientId = q.get("client_id"), redirect = q.get("redirect_uri");
  if (clientId !== env.OIDC_CLIENT_ID || !allowedRedirect(env, redirect)) return html(errorPage("This sign-in link isn't valid. Go back to the app and try again."), 400);
  if (q.get("response_type") !== "code") return html(errorPage("This sign-in link isn't valid (response type)."), 400);
  const id = rand(24);
  await env.DB.prepare("INSERT INTO auth_requests(id, client_id, redirect_uri, state, nonce, code_challenge, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id, clientId, redirect, q.get("state"), q.get("nonce"), q.get("code_challenge_method") === "S256" ? q.get("code_challenge") : null, iso(), iso(Date.now() + REQUEST_TTL)).run();
  return html(phonePage({ rid: id }));
}

async function sendCode(req, env, form, fetchImpl) {
  const r = await loadRequest(env.DB, form.get("rid"));
  if (!r) return html(errorPage("This sign-in page timed out. Go back to the app and start again."), 400);
  const phone = normalizePhone(form.get("phone"));
  if (!phone) return html(phonePage({ rid: r.id, error: "Type your 10-digit mobile number.", value: form.get("phone") }), 400);
  const ip = ipOf(req);
  if (await count(env.DB, ["send", "unknown_number"], "ip", ip, HOUR) >= SEND_PER_IP) return html(phonePage({ rid: r.id, error: "Too many tries from this network. Wait an hour, or use email instead." }), 429);
  if (await count(env.DB, ["send"], "phone", phone, HOUR) >= SEND_PER_PHONE) return html(phonePage({ rid: r.id, error: "Too many codes sent to this number. Wait an hour, or use email instead." }), 429);
  const user = await findUser(env.DB, env, phone);
  if (!user) {
    await event(env.DB, "unknown_number", phone, ip);
  } else {
    const t = await twilio(env, "Verifications", { To: phone, Channel: "sms" }, fetchImpl);
    if (!t.ok) return html(phonePage({ rid: r.id, error: "The text couldn't be sent just now. Try again in a minute, or use email instead." }), 502);
    await event(env.DB, "send", phone, ip);
  }
  await env.DB.prepare("UPDATE auth_requests SET phone=?, user_id=? WHERE id=?").bind(phone, user ? user.id : null, r.id).run();
  return html(codePage({ rid: r.id, masked: masked(phone) }));
}

async function checkCode(req, env, form, fetchImpl) {
  const r = await loadRequest(env.DB, form.get("rid"));
  if (!r || !r.phone) return html(errorPage("This sign-in page timed out. Go back to the app and start again."), 400);
  const code = String(form.get("code") || "").replace(/\D/g, "");
  if (code.length < 4 || code.length > 10) return html(codePage({ rid: r.id, masked: masked(r.phone), error: "Type the code from the text." }), 400);
  const ip = ipOf(req);
  if (await count(env.DB, ["check_bad"], "phone", r.phone, HOUR) >= BAD_PER_PHONE) return html(codePage({ rid: r.id, masked: masked(r.phone), error: "Too many wrong codes. Wait an hour, or use email instead." }), 429);
  let ok = false;
  if (r.user_id) {
    const t = await twilio(env, "VerificationCheck", { To: r.phone, Code: code }, fetchImpl);
    ok = t.ok && t.data.status === "approved";
  }
  if (!ok) {
    await event(env.DB, "check_bad", r.phone, ip);
    return html(codePage({ rid: r.id, masked: masked(r.phone), error: "That code isn't right, or it has expired. Check the text and try again." }), 400);
  }
  await event(env.DB, "check_ok", r.phone, ip);
  const authCode = rand(32);
  await env.DB.prepare("INSERT INTO auth_codes(code_hash, request_id, user_id, expires_at) VALUES(?,?,?,?)").bind(await sha256(authCode), r.id, r.user_id, iso(Date.now() + CODE_TTL)).run();
  const back = new URL(r.redirect_uri);
  back.searchParams.set("code", authCode);
  if (r.state) back.searchParams.set("state", r.state);
  return new Response(null, { status: 303, headers: { location: back.toString(), ...SECURITY } });
}

function clientAuth(req, form) {
  const h = req.headers.get("authorization") || "";
  if (h.startsWith("Basic ")) {
    try { const [id, ...rest] = atob(h.slice(6)).split(":"); return { id: decodeURIComponent(id), secret: decodeURIComponent(rest.join(":")) }; } catch { return {}; }
  }
  return { id: form.get("client_id"), secret: form.get("client_secret") };
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(String(a || "")), sha256(String(b || ""))]);
  let d = x.length ^ y.length; for (let i = 0; i < Math.min(x.length, y.length); i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0 && !!b;
}

async function token(req, env, form) {
  const c = clientAuth(req, form);
  if (c.id !== env.OIDC_CLIENT_ID || !(await safeEqual(c.secret, env.OIDC_CLIENT_SECRET))) return json({ error: "invalid_client" }, 401);
  if (form.get("grant_type") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);
  const hash = await sha256(String(form.get("code") || ""));
  const row = await env.DB.prepare("SELECT c.*, r.redirect_uri, r.nonce, r.code_challenge, r.client_id AS rclient FROM auth_codes c JOIN auth_requests r ON r.id=c.request_id WHERE c.code_hash=?").bind(hash).first();
  if (!row || row.used_at || row.expires_at < iso() || row.rclient !== c.id) return json({ error: "invalid_grant" }, 400);
  if (form.get("redirect_uri") && form.get("redirect_uri") !== row.redirect_uri) return json({ error: "invalid_grant" }, 400);
  if (row.code_challenge) {
    const v = form.get("code_verifier") || "";
    if (b64u(await crypto.subtle.digest("SHA-256", enc.encode(v))) !== row.code_challenge) return json({ error: "invalid_grant" }, 400);
  }
  const used = await env.DB.prepare("UPDATE auth_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL").bind(iso(), hash).run();
  if (!used.meta || used.meta.changes !== 1) return json({ error: "invalid_grant" }, 400);
  const u = await env.DB.prepare("SELECT id, email, display_name AS name, phone, status FROM core_users WHERE id=?").bind(row.user_id).first();
  if (!u || u.status !== "active") return json({ error: "invalid_grant" }, 400);
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer(env), aud: c.id, sub: u.id, email: String(u.email).toLowerCase(), email_verified: true, name: u.name, phone_number: u.phone, phone_number_verified: true, iat: now, exp: now + TOKEN_TTL, ...(row.nonce ? { nonce: row.nonce } : {}) };
  const idToken = await signJwt(env.DB, claims);
  const accessToken = await signJwt(env.DB, { iss: issuer(env), aud: issuer(env) + "/userinfo", sub: u.id, iat: now, exp: now + TOKEN_TTL });
  return json({ access_token: accessToken, token_type: "Bearer", expires_in: TOKEN_TTL, id_token: idToken, scope: "openid email profile phone" }, 200, { pragma: "no-cache" });
}

async function verifyOwnJwt(db, tok) {
  const bits = String(tok || "").split("."); if (bits.length !== 3) return null;
  const k = await signingKey(db);
  const key = await crypto.subtle.importKey("jwk", { ...JSON.parse(k.public_jwk), alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const dec = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), ch => ch.charCodeAt(0));
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, dec(bits[2]), enc.encode(`${bits[0]}.${bits[1]}`)))) return null;
  const c = JSON.parse(new TextDecoder().decode(dec(bits[1])));
  return c.exp > Math.floor(Date.now() / 1000) ? c : null;
}
async function userinfo(req, env) {
  const c = await verifyOwnJwt(env.DB, (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!c || c.aud !== issuer(env) + "/userinfo") return json({ error: "invalid_token" }, 401);
  const u = await env.DB.prepare("SELECT id, email, display_name AS name, phone FROM core_users WHERE id=? AND status='active'").bind(c.sub).first();
  if (!u) return json({ error: "invalid_token" }, 401);
  return json({ sub: u.id, email: String(u.email).toLowerCase(), email_verified: true, name: u.name, phone_number: u.phone, phone_number_verified: true });
}

function discovery(env) {
  const i = issuer(env);
  return json({ issuer: i, authorization_endpoint: `${i}/authorize`, token_endpoint: `${i}/token`, userinfo_endpoint: `${i}/userinfo`, jwks_uri: `${i}/jwks`,
    response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], grant_types_supported: ["authorization_code"],
    scopes_supported: ["openid", "email", "profile", "phone"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    claims_supported: ["sub", "email", "email_verified", "name", "phone_number"], code_challenge_methods_supported: ["S256"] }, 200, { "cache-control": "max-age=300" });
}

export async function handle(req, env, { fetchImpl = fetch } = {}) {
  const u = new URL(req.url), path = u.pathname;
  try {
    if (req.method === "GET" && path === "/.well-known/openid-configuration") return discovery(env);
    if (req.method === "GET" && path === "/jwks") { const k = await signingKey(env.DB); return json({ keys: [{ ...JSON.parse(k.public_jwk), kid: k.kid, alg: "RS256", use: "sig" }] }, 200, { "cache-control": "max-age=300" }); }
    if (req.method === "GET" && path === "/authorize") return authorize(req, env);
    if (req.method === "POST" && path === "/token") return token(req, env, await req.formData());
    if ((req.method === "GET" || req.method === "POST") && path === "/userinfo") return userinfo(req, env);
    if (req.method === "POST" && (path === "/send" || path === "/check")) {
      // form posts only from our own pages
      const origin = req.headers.get("origin");
      if (origin && origin !== u.origin) return html(errorPage("This request came from somewhere else."), 403);
      const form = await req.formData();
      return path === "/send" ? sendCode(req, env, form, fetchImpl) : checkCode(req, env, form, fetchImpl);
    }
    if (req.method === "GET" && path === "/") return html(page("Town & Country Cleaners", '<p class="lead">Sign in from the app you want to open.</p>'));
    return html(errorPage("Page not found."), 404);
  } catch (e) {
    console.error(e);
    return html(errorPage("Something went wrong. Try again in a minute, or use email instead."), 500);
  }
}

export default {
  fetch: (req, env) => handle(req, env),
  // clear old sign-in state once a day
  async scheduled(event, env) {
    const cut = iso(Date.now() - 7 * 864e5);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_codes WHERE expires_at < ?").bind(iso(Date.now() - 864e5)),
      env.DB.prepare("DELETE FROM auth_requests WHERE expires_at < ? AND id NOT IN (SELECT request_id FROM auth_codes)").bind(iso(Date.now() - 864e5)),
      env.DB.prepare("DELETE FROM auth_events WHERE at < ?").bind(cut),
    ]);
  },
};
