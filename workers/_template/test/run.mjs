// Tests for the starter app: sign-in, roles, users, example data, page protection.
// Run: node workers/<name>/test/run.mjs   (Node 22; Node's SQLite stands in for D1, a fake Access signs people in)
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { freshDb, fakeAccess, TEAM, AUD } from "../../planner/test/harness.mjs";
import { seed } from "../../retail/test/seed.mjs";
import { handle } from "../src/index.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const here = dirname(fileURLToPath(import.meta.url)), PUBLIC = join(here, "../public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
const assets = { async fetch(req) { let p = new URL(req.url).pathname; if (p.endsWith("/")) p += "index.html"; const f = join(PUBLIC, p);
  return f.startsWith(PUBLIC) && existsSync(f) ? new Response(readFileSync(f), { headers: { "content-type": TYPES[extname(f)] || "application/octet-stream" } }) : new Response("Not found", { status: 404 }); } };

const A = await fakeAccess();
const { db, sqlite } = freshDb();
const APP = "example";
// what the new app's migration would do: its core_apps row (Neal's role is added below)
sqlite.prepare("INSERT OR IGNORE INTO core_apps(id, name, subdomain) VALUES(?,?,?)").run(APP, "Example", "example");
await seed(db, { last: "2026-10-09", days: 3, today: "2026-10-10" });
const env = { DB: db, ASSETS: assets, ORG_ID: "tcc", APP_ID: APP, APP_NAME: "Example", TIMEZONE: "America/Chicago", TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

const addUser = (email, roles) => {
  let id = sqlite.prepare("SELECT id FROM core_users WHERE email=?").get(email)?.id;
  if (!id) { id = "01" + Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(24, "0");
    sqlite.prepare("INSERT INTO core_users(id, org_id, email, display_name) VALUES(?,?,?,?)").run(id, "tcc", email, email.split("@")[0]); }
  for (const [app, role] of Object.entries(roles)) sqlite.prepare("INSERT OR REPLACE INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES(?,?,?,?)").run(id, app, role, "x");
  return id;
};
const NEAL = "neal@towncountryclean.com";
addUser(NEAL, { [APP]: "owner" });
addUser("viewer@x.com", { [APP]: "viewer" });
addUser("planner-only@x.com", { planner: "manager" });

const call = async (method, path, { as = NEAL, body } = {}) => {
  const h = new Headers();
  if (as) h.set("cf-access-jwt-assertion", await A.token({ email: as }));
  if (body) h.set("content-type", "application/json");
  const r = await handle(new Request(`https://example.netexcleaners.com${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { fetchImpl: A.fetchImpl });
  const type = r.headers.get("content-type") || "";
  return { status: r.status, body: type.includes("json") ? await r.json() : await r.text() };
};

console.log("starter app");
await t("not signed in: 401 for data and for the page", async () => {
  eq((await call("GET", "/api/me", { as: null })).status, 401);
  eq((await call("GET", "/", { as: null })).status, 401);
});
await t("signed in but no role in this app: 403", async () => {
  const r = await call("GET", "/api/me", { as: "planner-only@x.com" });
  eq(r.status, 403); eq(r.body.reason, "no_role");
});
await t("signed in with a role: me, page, example data", async () => {
  const me = await call("GET", "/api/me");
  eq(me.status, 200); eq(me.body.user.role, "owner"); eq(me.body.app.id, APP);
  const page = await call("GET", "/");
  eq(page.status, 200); ok(page.body.includes("<title>Example</title>"));
  const o = await call("GET", "/api/orders-today?day=2026-10-09");
  eq(o.status, 200); ok(o.body.stores.length > 0, "orders seeded for that day");
  eq((await call("GET", "/api/orders-today?day=nope")).status, 400);
});
await t("roles: viewer can't list users or pass the admin check; owner can", async () => {
  eq((await call("GET", "/api/users", { as: "viewer@x.com" })).status, 403);
  eq((await call("GET", "/api/admin-check", { as: "viewer@x.com" })).status, 403);
  const u = await call("GET", "/api/users");
  eq(u.status, 200); ok(u.body.users.some(x => x.email === "viewer@x.com"));
});
await t("owner adds someone to this app only", async () => {
  const r = await call("POST", "/api/users", { body: { email: "new@x.com", name: "New Person", role: "manager" } });
  eq(r.status, 201, JSON.stringify(r.body));
  const row = sqlite.prepare("SELECT r.app_id, r.role_id FROM core_user_app_roles r JOIN core_users u ON u.id=r.user_id WHERE u.email='new@x.com'").all();
  eq(row.map(x => [x.app_id, x.role_id]), [[APP, "manager"]]);
  eq((await call("GET", "/api/me", { as: "new@x.com" })).status, 200);
});
await t("unknown route 404", async () => { eq((await call("GET", "/api/nope")).status, 404); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
