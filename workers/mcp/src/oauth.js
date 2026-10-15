// OAuth 2.1 for Claude's connector (MCP authorization spec): metadata, dynamic client registration, the approve page and tokens.
// Who the person is comes from Cloudflare Access on /authorize (same sign-in as the other apps, checked again here);
// /token, /register, /mcp and /.well-known are reached by Claude's servers with no Access cookie, so Access bypasses them
// and this file is what guards them.
import { currentUser } from "../../planner/src/auth.js";
import { HttpError, json, ulid, nowIso } from "../../planner/src/util.js";

const CODE_MIN = 10, ACCESS_MIN = 60, REFRESH_DAYS = 30;
export const SCOPE = "netex.read";

const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async s => b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const addMin = (m, now = Date.now()) => new Date(now + m * 60000).toISOString();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const origin = env => env.PUBLIC_ORIGIN || "https://mcp.netexcleaners.com";
export const resourceUrl = env => origin(env) + "/mcp";

export function protectedResourceMetadata(env) {
  return { resource: resourceUrl(env), authorization_servers: [origin(env)], scopes_supported: [SCOPE], bearer_methods_supported: ["header"],
    resource_name: "Town & Country Cleaners data (Netex)" };
}
export function authServerMetadata(env) {
  const o = origin(env);
  return { issuer: o, authorization_endpoint: o + "/authorize", token_endpoint: o + "/token", registration_endpoint: o + "/register",
    revocation_endpoint: o + "/revoke",
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"], scopes_supported: [SCOPE] };
}

/** Redirects Claude may use: the hosted apps' callback, and loopback on any port (Claude Code). Extra exact URIs via ALLOWED_REDIRECTS. */
export function redirectAllowed(uri, env) {
  let u; try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  const extra = String(env.ALLOWED_REDIRECTS || "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback").split(",").map(s => s.trim()).filter(Boolean);
  if (extra.includes(uri)) return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}
// loopback redirects match whatever port Claude Code picked (RFC 8252 7.3)
function sameRedirect(registered, given) {
  if (registered === given) return true;
  try { const a = new URL(registered), b = new URL(given);
    return a.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(a.hostname) && a.hostname === b.hostname && a.protocol === b.protocol && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

const oauthError = (status, error, description) => json({ error, error_description: description }, status);

// ---------- dynamic client registration (RFC 7591)
export async function register(req, env) {
  let body; try { body = await req.json(); } catch { return oauthError(400, "invalid_client_metadata", "Send JSON."); }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10) return oauthError(400, "invalid_redirect_uri", "Give 1 to 10 redirect_uris.");
  const badUri = uris.find(u => !redirectAllowed(u, env));
  if (badUri) return oauthError(400, "invalid_redirect_uri", `Only Claude's own callback or a loopback address can be used, not ${badUri}.`);
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") return oauthError(400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported.");
  const id = "mcp_" + randomToken(18), name = String(body.client_name || "Claude").slice(0, 100);
  await env.DB.prepare("INSERT INTO mcp_clients(id, name, redirect_uris_json, created_at) VALUES(?,?,?,?)").bind(id, name, JSON.stringify(uris), nowIso()).run();
  return json({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
}

async function client(env, id) {
  const c = id && await env.DB.prepare("SELECT id, name, redirect_uris_json FROM mcp_clients WHERE id=?").bind(id).first();
  return c ? { ...c, uris: JSON.parse(c.redirect_uris_json) } : null;
}

// ---------- the approve page (behind Cloudflare Access)
function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#5f5e5a;--line:#dcdad3;--accent:#1f5f8b}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#21211f;--ink:#ecebe6;--muted:#a8a69f;--line:#3a3935;--accent:#6fb0de}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:440px;width:100%}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}b{color:var(--ink)}ul{margin:0 0 16px;padding-left:20px;color:var(--muted)}
.row{display:flex;gap:8px;margin-top:16px}button{flex:1;font:inherit;padding:12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.go{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "referrer-policy": "no-referrer" } });
}

function readAuthorizeParams(p) {
  return { response_type: p.get("response_type"), client_id: p.get("client_id"), redirect_uri: p.get("redirect_uri"), state: p.get("state") || "",
    code_challenge: p.get("code_challenge"), code_challenge_method: p.get("code_challenge_method"), scope: p.get("scope") || SCOPE, resource: p.get("resource") || "" };
}

/** GET shows "Allow Claude to read …?"; POST (the button) issues the code. Both need the Access sign-in and a role in app 'claude'. */
export async function authorize(req, env, opts = {}) {
  const url = new URL(req.url);
  const form = req.method === "POST" ? new URLSearchParams(await req.text()) : url.searchParams;
  const a = readAuthorizeParams(form);
  const c = await client(env, a.client_id);
  // problems with the client or redirect are shown here, never redirected (the redirect can't be trusted yet)
  if (!c) return page("Sign-in problem", `<h1>Sign-in problem</h1><p>Claude's registration wasn't found. Remove the connector in Claude and add it again.</p>`, 400);
  if (!a.redirect_uri || !c.uris.some(u => sameRedirect(u, a.redirect_uri))) return page("Sign-in problem", `<h1>Sign-in problem</h1><p>The return address doesn't match Claude's registration.</p>`, 400);

  const back = (params) => { const r = new URL(a.redirect_uri); for (const [k, v] of Object.entries(params)) r.searchParams.set(k, v); if (a.state) r.searchParams.set("state", a.state); return Response.redirect(r.toString(), 302); };
  if (a.response_type !== "code") return back({ error: "unsupported_response_type" });
  if (!a.code_challenge || a.code_challenge_method !== "S256") return back({ error: "invalid_request", error_description: "PKCE with S256 is required." });
  if (a.resource && a.resource.replace(/\/$/, "") !== resourceUrl(env)) return back({ error: "invalid_target", error_description: "Unknown resource." });

  let me;
  try { me = await currentUser(req, env, opts); }
  catch (e) {
    if (e instanceof HttpError) return page("No access", `<h1>No access yet</h1><p>${esc(e.message)}</p><p>Ask Neal to give you a role in the Claude connector.</p>`, e.status);
    throw e;
  }

  // ties the Allow button to this sign-in, so another site can't post the form for you
  const accessJwt = req.headers.get("cf-access-jwt-assertion") || (/(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("cookie") || "") || [])[1] || env.DEV_EMAIL || "";
  const csrf = await sha256("approve|" + accessJwt + "|" + a.client_id + "|" + a.code_challenge);
  const host = new URL(a.redirect_uri).host;
  if (req.method === "GET") {
    const hidden = Object.entries(a).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
    const loop = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    return page("Allow Claude?", `<h1>Allow Claude to read Netex data?</h1>
<p>Signed in as <b>${esc(me.name)}</b> (${esc(me.email)}), ${esc(me.role)}.</p>
<p><b>${esc(c.name)}</b> will be able to:</p><ul><li>read orders, pieces, hours and plans from the Netex database</li><li>read SMRT reports and orders live</li><li>see pay rates only if you're an Admin or the Owner</li></ul>
<p>It can't change anything. It returns to <b>${esc(host)}</b>.${loop ? " That's a program on this computer (Claude Code); only allow it if you started it." : ""}</p>
<form method="post">${hidden}<input type="hidden" name="csrf" value="${csrf}"><div class="row"><button type="submit" name="decision" value="deny">Cancel</button><button class="go" type="submit" name="decision" value="allow">Allow</button></div></form>`);
  }
  if (form.get("csrf") !== csrf) return page("Sign-in problem", `<h1>Sign-in problem</h1><p>This approval page is out of date. Go back to Claude and connect again.</p>`, 400);
  if (form.get("decision") !== "allow") return back({ error: "access_denied" });
  const code = randomToken(32);
  await env.DB.prepare("INSERT INTO mcp_codes(code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at) VALUES(?,?,?,?,?,?,?)")
    .bind(await sha256(code), c.id, me.id, a.redirect_uri, a.code_challenge, SCOPE, addMin(CODE_MIN)).run();
  return back({ code });
}

// ---------- tokens
async function issue(env, { clientId, userId, familyId }) {
  const access = randomToken(32), refresh = randomToken(32), now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO mcp_tokens(token_hash, kind, client_id, user_id, family_id, scope, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(await sha256(access), "access", clientId, userId, familyId, SCOPE, now, addMin(ACCESS_MIN)),
    env.DB.prepare("INSERT INTO mcp_tokens(token_hash, kind, client_id, user_id, family_id, scope, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(await sha256(refresh), "refresh", clientId, userId, familyId, SCOPE, now, addMin(REFRESH_DAYS * 1440)),
    env.DB.prepare("UPDATE mcp_clients SET last_used_at=? WHERE id=?").bind(now, clientId),
  ]);
  return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_MIN * 60, refresh_token: refresh, scope: SCOPE }, 200, { pragma: "no-cache" });
}

export async function token(req, env) {
  const ct = req.headers.get("content-type") || "";
  let p;
  if (ct.includes("application/json")) { try { p = new URLSearchParams(Object.entries(await req.json()).map(([k, v]) => [k, String(v)])); } catch { return oauthError(400, "invalid_request", "Bad body."); } }
  else p = new URLSearchParams(await req.text());
  const grant = p.get("grant_type"), clientId = p.get("client_id");
  const c = await client(env, clientId);
  if (!c) return oauthError(401, "invalid_client", "Unknown client.");
  const now = nowIso();

  if (grant === "authorization_code") {
    const row = await env.DB.prepare("SELECT * FROM mcp_codes WHERE code_hash=?").bind(await sha256(p.get("code") || "")).first();
    if (!row || row.client_id !== c.id) return oauthError(400, "invalid_grant", "The code isn't valid.");
    // one use only; a second try fails even if the first is still going
    const used = await env.DB.prepare("UPDATE mcp_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL").bind(now, row.code_hash).run();
    if (!used.meta || used.meta.changes !== 1) return oauthError(400, "invalid_grant", "The code was already used.");
    if (row.expires_at < now) return oauthError(400, "invalid_grant", "The code expired.");
    if (p.get("redirect_uri") && p.get("redirect_uri") !== row.redirect_uri) return oauthError(400, "invalid_grant", "redirect_uri doesn't match.");
    if ((await sha256(p.get("code_verifier") || "")) !== row.code_challenge) return oauthError(400, "invalid_grant", "PKCE check failed.");
    if (!(await activeUser(env, row.user_id))) return oauthError(400, "invalid_grant", "This person no longer has access.");
    return issue(env, { clientId: c.id, userId: row.user_id, familyId: ulid() });
  }

  if (grant === "refresh_token") {
    const row = await env.DB.prepare("SELECT * FROM mcp_tokens WHERE token_hash=? AND kind='refresh'").bind(await sha256(p.get("refresh_token") || "")).first();
    if (!row || row.client_id !== c.id) return oauthError(400, "invalid_grant", "The refresh token isn't valid.");
    if (row.revoked_at || row.expires_at < now) return oauthError(400, "invalid_grant", "The refresh token is no longer valid.");
    const used = await env.DB.prepare("UPDATE mcp_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL").bind(now, row.token_hash).run();
    if (!used.meta || used.meta.changes !== 1) { // used twice: someone has a copy. Turn off the whole chain.
      await env.DB.prepare("UPDATE mcp_tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL").bind(now, row.family_id).run();
      return oauthError(400, "invalid_grant", "The refresh token was already used.");
    }
    if (!(await activeUser(env, row.user_id))) return oauthError(400, "invalid_grant", "This person no longer has access.");
    return issue(env, { clientId: c.id, userId: row.user_id, familyId: row.family_id });
  }
  return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/** RFC 7009: always 200. Revokes the token's whole chain. */
export async function revoke(req, env) {
  const p = new URLSearchParams(await req.text());
  const row = await env.DB.prepare("SELECT family_id FROM mcp_tokens WHERE token_hash=?").bind(await sha256(p.get("token") || "")).first();
  if (row) await env.DB.prepare("UPDATE mcp_tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL").bind(nowIso(), row.family_id).run();
  return new Response(null, { status: 200 });
}

async function activeUser(env, userId) {
  return env.DB.prepare(`SELECT u.id, u.email, u.display_name AS name, r.role_id AS role FROM core_users u
      JOIN core_user_app_roles r ON r.user_id=u.id AND r.app_id=?
     WHERE u.id=? AND u.org_id=? AND u.status='active' AND u.deleted_at IS NULL`).bind(env.APP_ID, userId, env.ORG_ID).first();
}

/** The person behind a Bearer token on /mcp, with their role in each app, or null (→ 401). Checked on every call, so taking away
 *  someone's role or turning off their account stops Claude at once. */
export async function bearerUser(req, env) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) return null;
  const row = await env.DB.prepare("SELECT user_id, expires_at, revoked_at FROM mcp_tokens WHERE token_hash=? AND kind='access'").bind(await sha256(m[1])).first();
  if (!row || row.revoked_at || row.expires_at < nowIso()) return null;
  const u = await activeUser(env, row.user_id);
  if (!u) return null;
  const { results } = await env.DB.prepare("SELECT app_id, role_id FROM core_user_app_roles WHERE user_id=?").bind(u.id).all();
  return { ...u, roles: Object.fromEntries(results.map(r => [r.app_id, r.role_id])) };
}

export function unauthorized(env, why = "Sign in to use this connector.") {
  return new Response(JSON.stringify({ error: "invalid_token", error_description: why }), { status: 401, headers: {
    "content-type": "application/json", "cache-control": "no-store",
    "www-authenticate": `Bearer resource_metadata="${origin(env)}/.well-known/oauth-protected-resource", scope="${SCOPE}"` } });
}
