// Server tests for the planner web app: sign-in checks, the user list rules, and the Access group sync.
// Run: node workers/planner/test/run.mjs
import { freshDb, fakeAccess, makeEnv, TEAM, AUD } from "./harness.mjs";
import { handle } from "../src/index.js";
import { verifyAccessJwt, _resetCertCache } from "../src/auth.js";
import { syncAccessGroup } from "../src/users.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const A = await fakeAccess();
const NEAL = "neal@towncountryclean.com";

function app() {
  const { db, sqlite } = freshDb();
  const env = makeEnv(db);
  const call = async (method, path, { as = NEAL, body, token } = {}) => {
    const headers = new Headers();
    if (token !== undefined) { if (token) headers.set("cf-access-jwt-assertion", token); }
    else if (as) headers.set("cf-access-jwt-assertion", await A.token({ email: as }));
    if (body) headers.set("content-type", "application/json");
    const r = await handle(new Request(`https://prodplanner.netexcleaners.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
    const type = r.headers.get("content-type") || "";
    return { status: r.status, body: type.includes("json") ? await r.json() : await r.text() };
  };
  return { db, sqlite, env, call };
}

console.log("sign-in");
await t("Neal (seeded Owner) gets /api/me", async () => {
  const { call } = app();
  const r = await call("GET", "/api/me");
  eq(r.status, 200); eq(r.body.user.email, NEAL); eq(r.body.user.role, "owner"); eq(r.body.user.roles.core, "owner");
});
await t("email case doesn't matter", async () => {
  const { call } = app(); eq((await call("GET", "/api/me", { as: "Neal@TownCountryClean.com" })).body.user.role, "owner");
});
await t("no token -> 401, for pages too", async () => {
  const { call } = app();
  eq((await call("GET", "/api/me", { token: "" })).status, 401);
  eq((await call("GET", "/", { token: "" })).status, 401);
});
await t("token for another app (aud) is refused", async () => {
  const { call } = app();
  const r = await call("GET", "/api/me", { token: await A.token({ aud: ["someone-else"] }) });
  eq(r.status, 401); ok(/different application/.test(r.body.error));
});
await t("expired, wrong issuer, forged signature, unknown key are refused", async () => {
  const { call } = app();
  eq((await call("GET", "/api/me", { token: await A.token({ exp: Math.floor(Date.now() / 1000) - 10 }) })).status, 401);
  eq((await call("GET", "/api/me", { token: await A.token({ iss: "https://evil.cloudflareaccess.com" }) })).status, 401);
  eq((await call("GET", "/api/me", { token: await A.token({}, { key: A.otherKey }) })).status, 401);
  eq((await call("GET", "/api/me", { token: await A.token({}, { kid: "nope" }) })).status, 401);
  eq((await call("GET", "/api/me", { token: "abc.def" })).status, 401);
});
await t("signing keys are cached, and refetched when a new key id shows up", async () => {
  _resetCertCache();
  const before = A.certCalls();
  for (let i = 0; i < 3; i++) await verifyAccessJwt(await A.token(), { teamDomain: TEAM, aud: AUD, fetchImpl: A.fetchImpl });
  eq(A.certCalls() - before, 1, "one fetch for three checks");
  await verifyAccessJwt(await A.token({}, { kid: "rotated" }), { teamDomain: TEAM, aud: AUD, fetchImpl: A.fetchImpl }).catch(() => {});
  eq(A.certCalls() - before, 2, "refetched for unknown kid");
});
await t("signed in but not on the list -> 403 not_listed; page still loads", async () => {
  const { call } = app();
  const r = await call("GET", "/api/me", { as: "stranger@gmail.com" });
  eq(r.status, 403); eq(r.body.reason, "not_listed"); eq(r.body.email, "stranger@gmail.com");
  const page = await call("GET", "/", { as: "stranger@gmail.com" });
  eq(page.status, 200); ok(page.body.includes("Production Planner"));
});
await t("last_seen_at is recorded", async () => {
  const { call, sqlite } = app(); await call("GET", "/api/me");
  ok(sqlite.prepare("SELECT last_seen_at FROM core_users WHERE email=?").get(NEAL).last_seen_at);
});
await t("DEV_EMAIL only works on localhost", async () => {
  const { db } = freshDb(); const env = makeEnv(db, { DEV_EMAIL: NEAL });
  const local = await handle(new Request("http://localhost:8787/api/me"), env, { fetchImpl: A.fetchImpl });
  eq(local.status, 200);
  const prod = await handle(new Request("https://prodplanner.netexcleaners.com/api/me"), env, { fetchImpl: A.fetchImpl });
  eq(prod.status, 401);
});
await t("unknown API path 404, wrong method 405", async () => {
  const { call } = app();
  eq((await call("GET", "/api/nope")).status, 404);
  eq((await call("DELETE", "/api/users")).status, 405);
});

console.log("user list");
await t("Owner adds an Admin, Admin adds a Manager; list is ordered by role", async () => {
  const { call } = app();
  eq((await call("POST", "/api/users", { body: { name: "Ana Admin", email: "Ana@Example.com ", role: "admin" } })).status, 201);
  eq((await call("POST", "/api/users", { as: "ana@example.com", body: { name: "Mo Manager", email: "mo@example.com", role: "manager" } })).status, 201);
  const r = await call("GET", "/api/users");
  eq(r.body.users.map(u => u.role), ["owner", "admin", "manager"]);
  eq(r.body.users[1].email, "ana@example.com");
  eq(r.body.groupSync, false);
});
await t("Admin can't give Admin or Owner, and can't edit another Admin or the Owner", async () => {
  const { call, sqlite } = app();
  await call("POST", "/api/users", { body: { name: "Ana", email: "ana@example.com", role: "admin" } });
  await call("POST", "/api/users", { body: { name: "Al", email: "al@example.com", role: "admin" } });
  eq((await call("POST", "/api/users", { as: "ana@example.com", body: { name: "X", email: "x@example.com", role: "admin" } })).status, 403);
  const al = sqlite.prepare("SELECT id FROM core_users WHERE email='al@example.com'").get().id;
  const neal = sqlite.prepare("SELECT id FROM core_users WHERE email=?").get(NEAL).id;
  eq((await call("PATCH", `/api/users/${al}`, { as: "ana@example.com", body: { role: "viewer" } })).status, 403);
  eq((await call("PATCH", `/api/users/${neal}`, { as: "ana@example.com", body: { status: "disabled" } })).status, 403);
  const list = (await call("GET", "/api/users", { as: "ana@example.com" })).body.users;
  eq(list.find(u => u.email === NEAL).canEdit, false); eq(list.find(u => u.email === "al@example.com").canEdit, false);
});
await t("Managers and Viewers can't see the list", async () => {
  const { call } = app();
  await call("POST", "/api/users", { body: { name: "Mo", email: "mo@example.com", role: "manager" } });
  eq((await call("GET", "/api/users", { as: "mo@example.com" })).status, 403);
  eq((await call("POST", "/api/users", { as: "mo@example.com", body: { name: "V", email: "v@example.com", role: "viewer" } })).status, 403);
});
await t("duplicate email 409; bad email / blank name 400", async () => {
  const { call } = app();
  eq((await call("POST", "/api/users", { body: { name: "Neal 2", email: NEAL.toUpperCase(), role: "viewer" } })).status, 409);
  eq((await call("POST", "/api/users", { body: { name: "X", email: "not-an-email", role: "viewer" } })).status, 400);
  eq((await call("POST", "/api/users", { body: { name: "  ", email: "a@b.co", role: "viewer" } })).status, 400);
  eq((await call("POST", "/api/users", { body: { name: "X", email: "a@b.co", role: "boss" } })).status, 400);
});
await t("the last Owner can't be demoted or turned off; with a second Owner it's allowed", async () => {
  const { call, sqlite } = app();
  const neal = sqlite.prepare("SELECT id FROM core_users WHERE email=?").get(NEAL).id;
  eq((await call("PATCH", `/api/users/${neal}`, { body: { role: "admin" } })).status, 409);
  await call("POST", "/api/users", { body: { name: "Shannon", email: "shannon@example.com", role: "owner" } });
  eq((await call("PATCH", `/api/users/${neal}`, { body: { role: "admin" } })).status, 200);
  eq((await call("GET", "/api/me")).body.user.role, "admin");
});
await t("turning someone off blocks them; turning back on restores", async () => {
  const { call, sqlite } = app();
  await call("POST", "/api/users", { body: { name: "Vi", email: "vi@example.com", role: "viewer" } });
  const vi = sqlite.prepare("SELECT id FROM core_users WHERE email='vi@example.com'").get().id;
  eq((await call("GET", "/api/me", { as: "vi@example.com" })).status, 200);
  eq((await call("PATCH", `/api/users/${vi}`, { body: { status: "disabled" } })).body.changed, true);
  const r = await call("GET", "/api/me", { as: "vi@example.com" }); eq(r.status, 403); eq(r.body.reason, "disabled");
  await call("PATCH", `/api/users/${vi}`, { body: { status: "active" } });
  eq((await call("GET", "/api/me", { as: "vi@example.com" })).status, 200);
});
await t("'No access' removes the planner role; changes are audited", async () => {
  const { call, sqlite } = app();
  await call("POST", "/api/users", { body: { name: "Vi", email: "vi@example.com", role: "viewer" } });
  const vi = sqlite.prepare("SELECT id FROM core_users WHERE email='vi@example.com'").get().id;
  await call("PATCH", `/api/users/${vi}`, { body: { role: null } });
  eq((await call("GET", "/api/me", { as: "vi@example.com" })).body.reason, "no_role");
  const log = sqlite.prepare("SELECT action, changes_json FROM core_audit_log WHERE entity_id=? ORDER BY at").all(vi);
  eq(log.map(l => l.action), ["create", "update"]); eq(JSON.parse(log[1].changes_json).role, ["viewer", null]);
});
await t("saving with nothing changed is a no-op", async () => {
  const { call, sqlite } = app();
  const neal = sqlite.prepare("SELECT id FROM core_users WHERE email=?").get(NEAL).id;
  const r = await call("PATCH", `/api/users/${neal}`, { body: { name: "Neal Barker", role: "owner" } });
  eq(r.body.changed, false);
});

console.log("Access group sync");
await t("not configured -> says so, list still saved", async () => {
  const { call } = app();
  const r = await call("POST", "/api/users", { body: { name: "Vi", email: "vi@example.com", role: "viewer" } });
  eq(r.status, 201); eq(r.body.access, { synced: false, reason: "not_configured" });
});
await t("configured -> group gets every active user with a role, nobody else", async () => {
  const { db, sqlite } = freshDb();
  sqlite.prepare("INSERT INTO core_users(id,org_id,email,display_name) VALUES('01AAAAAAAAAAAAAAAAAAAAAAAA','tcc','vi@example.com','Vi')").run();
  sqlite.prepare("INSERT INTO core_user_app_roles(user_id,app_id,role_id,granted_at) VALUES('01AAAAAAAAAAAAAAAAAAAAAAAA','planner','viewer','x')").run();
  sqlite.prepare("INSERT INTO core_users(id,org_id,email,display_name,status) VALUES('01BBBBBBBBBBBBBBBBBBBBBBBB','tcc','gone@example.com','Gone','disabled')").run();
  sqlite.prepare("INSERT INTO core_user_app_roles(user_id,app_id,role_id,granted_at) VALUES('01BBBBBBBBBBBBBBBBBBBBBBBB','planner','viewer','x')").run();
  const sent = [];
  const fakeCf = async (url, init = {}) => {
    sent.push({ url, method: init.method || "GET", body: init.body && JSON.parse(init.body), auth: init.headers.authorization });
    return new Response(JSON.stringify({ success: true, result: { name: "Netex users" } }));
  };
  const r = await syncAccessGroup(db, makeEnv(db, { CF_API_TOKEN: "tok", ACCESS_GROUP_ID: "g1" }), fakeCf);
  eq(r, { synced: true, count: 2 });
  eq(sent[1].method, "PUT"); eq(sent[1].url, "https://api.cloudflare.com/client/v4/accounts/acct/access/groups/g1");
  eq(sent[1].body, { name: "Netex users", include: [{ email: { email: NEAL } }, { email: { email: "vi@example.com" } }] });
  eq(sent[1].auth, "Bearer tok");
});
await t("Cloudflare error is reported, not thrown", async () => {
  const { db } = freshDb();
  const r = await syncAccessGroup(db, makeEnv(db, { CF_API_TOKEN: "tok", ACCESS_GROUP_ID: "g1" }), async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 }));
  eq(r, { synced: false, reason: "cloudflare_error", detail: "Authentication error" });
});

console.log("pages and status");
await t("static files are served after the sign-in check", async () => {
  const { call } = app();
  const css = await call("GET", "/app.css"); eq(css.status, 200); ok(css.body.includes("--accent"));
  eq((await call("GET", "/js/app.js")).status, 200);
});
await t("/api/system reports SMRT history progress", async () => {
  const { call, sqlite } = app();
  sqlite.exec("INSERT INTO int_backfill_days(integration_id,day,status,orders,items,attempts,loaded_at) VALUES('smrt','2026-10-09','done',120,600,1,'x'),('smrt','2026-10-08','done',100,500,1,'x')");
  const r = await call("GET", "/api/system");
  eq(r.body.smrtHistory.days, 2); eq(r.body.smrtHistory.oldest, "2026-10-08"); eq(r.body.smrtHistory.items, 1100);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
