// Tests for netex-mcp: OAuth (registration, approve page, PKCE, refresh rotation), MCP protocol, read-only SQL, tools.
// Run: node workers/mcp/test/run.mjs   (Node 22; Node's SQLite stands in for D1, a fake Access signs people in, a fake SMRT answers)
import { freshDb, fakeAccess, TEAM, AUD } from "../../planner/test/harness.mjs";
import { seed } from "../../retail/test/seed.mjs";
import { handle } from "../src/index.js";
import { checkSql, SqlRefused } from "../src/sql.js";
import { sha256 } from "../src/oauth.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const A = await fakeAccess();
const { db, sqlite } = freshDb();
const LAST = "2026-10-09", TODAY = "2026-10-10";
await seed(db, { last: LAST, days: 7, today: TODAY });

// a fake SMRT: reports + getOrder (with one field SMRT doesn't have, to test the retry)
const smrtCalls = [];
const SMRT_COLS = ["ID", "Status", "Agent", "Created"];
const smrtRows = [["262831001", "processing", "TCC Quitman", "2026-10-08T09:00:00-05:00"], ["262831002", "ready", "TCC Emory", "2026-10-08T10:00:00-05:00"]];
const smrtFetch = async (url, init) => {
  if (String(url).startsWith(TEAM)) return A.fetchImpl(url);
  const q = JSON.parse(init.body).query; smrtCalls.push(q);
  const reply = data => new Response(JSON.stringify({ data: { business: data } }), { headers: { "content-type": "application/json" } });
  if (q.includes("getOrder")) {
    if (q.includes("readyDate")) return new Response(JSON.stringify({ errors: [{ message: 'Cannot query field "readyDate" on type "Order".' }] }));
    return reply({ getOrder: { id: "262831001", status: "processing", customerId: "c42", orderNotes: [{ id: "n1", message: "Spot on left sleeve", itemId: "3212887", closed: false }] } });
  }
  if (q.includes("columns")) return reply({ getReport: { columns: SMRT_COLS.map(name => ({ name })) } });
  return reply({ getReport: { values: smrtRows } });
};
const env = { DB: db, ORG_ID: "tcc", APP_ID: "claude", TIMEZONE: "America/Chicago", TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, PUBLIC_ORIGIN: "https://mcp.netexcleaners.com",
  SMRT_URL: "https://smrt.test/graphql", SMRT_KEY: "k" };
const opts = { fetchImpl: smrtFetch, now: Date.parse("2026-10-10T12:00:00-05:00") };

const addUser = (email, roles) => {
  let id = sqlite.prepare("SELECT id FROM core_users WHERE email=?").get(email)?.id;
  if (!id) { id = "01" + Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(24, "0");
    sqlite.prepare("INSERT INTO core_users(id, org_id, email, display_name) VALUES(?,?,?,?)").run(id, "tcc", email, email.split("@")[0]); }
  for (const [app, role] of Object.entries(roles)) sqlite.prepare("INSERT OR REPLACE INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES(?,?,?,?)").run(id, app, role, "x");
  return id;
};
const NEAL = "neal@towncountryclean.com";
const nealId = addUser(NEAL, { claude: "owner", planner: "owner", retail: "owner" });
addUser("viewer@x.com", { claude: "viewer", planner: "viewer" });
addUser("nobody@x.com", { planner: "manager" });

const O = "https://mcp.netexcleaners.com";
const req = async (method, path, { body, form, headers = {}, as } = {}) => {
  const h = new Headers(headers);
  if (as) h.set("cf-access-jwt-assertion", await A.token({ email: as }));
  let b;
  if (form) { h.set("content-type", "application/x-www-form-urlencoded"); b = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { h.set("content-type", "application/json"); b = JSON.stringify(body); }
  const r = await handle(new Request(O + path, { method, headers: h, body: b, redirect: "manual" }), env, opts);
  const type = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, body: type.includes("json") ? await r.json() : await r.text() };
};
const b64u = buf => Buffer.from(buf).toString("base64url");
const pkce = async () => { const verifier = b64u(crypto.getRandomValues(new Uint8Array(32))); return { verifier, challenge: b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) }; };
const CB = "https://claude.ai/api/mcp/auth_callback";

// full sign-in: register, approve, exchange. Returns tokens.
async function signIn(as = NEAL, redirect = CB) {
  const reg = await req("POST", "/register", { body: { client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none" } });
  const { verifier, challenge } = await pkce();
  const q = { response_type: "code", client_id: reg.body.client_id, redirect_uri: redirect, state: "s1", code_challenge: challenge, code_challenge_method: "S256", scope: "netex.read", resource: O + "/mcp" };
  const page = await req("GET", "/authorize?" + new URLSearchParams(q), { as });
  const csrf = (/name="csrf" value="([^"]+)"/.exec(page.body) || [])[1];
  const post = await req("POST", "/authorize", { as, form: { ...q, csrf, decision: "allow" } });
  const loc = new URL(post.headers.get("location"));
  const tok = await req("POST", "/token", { form: { grant_type: "authorization_code", code: loc.searchParams.get("code"), code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: redirect } });
  return { reg, page, post, loc, tok, verifier, q };
}
const rpc = async (token, method, params, id = 1) => (await req("POST", "/mcp", { headers: { authorization: "Bearer " + token }, body: { jsonrpc: "2.0", id, method, params } })).body;
const call = async (token, name, args) => { const r = await rpc(token, "tools/call", { name, arguments: args }); return r.result; };

console.log("netex-mcp");

await t("discovery: 401 with resource_metadata, both metadata documents", async () => {
  const r = await req("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
  eq(r.status, 401);
  ok(r.headers.get("www-authenticate").includes(`resource_metadata="${O}/.well-known/oauth-protected-resource"`));
  const pr = await req("GET", "/.well-known/oauth-protected-resource");
  eq(pr.body.resource, O + "/mcp"); eq(pr.body.authorization_servers, [O]);
  const as = await req("GET", "/.well-known/oauth-authorization-server");
  eq(as.body.code_challenge_methods_supported, ["S256"]); eq(as.body.registration_endpoint, O + "/register");
  ok(as.body.token_endpoint_auth_methods_supported.includes("none"));
});

await t("registration only takes Claude's callback or loopback", async () => {
  eq((await req("POST", "/register", { body: { redirect_uris: ["https://evil.example/cb"] } })).status, 400);
  eq((await req("POST", "/register", { body: { redirect_uris: [CB] } })).status, 201);
  eq((await req("POST", "/register", { body: { redirect_uris: ["http://localhost/callback"] } })).status, 201);
});

let T;
await t("sign-in: approve page, code, tokens; initialize and tools/list", async () => {
  const s = await signIn();
  ok(s.page.body.includes("Allow Claude to read Netex data?") && s.page.body.includes("claude.ai"), "approve page");
  eq(s.post.status, 302); eq(s.loc.origin + s.loc.pathname, CB); eq(s.loc.searchParams.get("state"), "s1");
  eq(s.tok.status, 200); ok(s.tok.body.access_token && s.tok.body.refresh_token); eq(s.tok.body.token_type, "Bearer");
  T = s;
  const init = await rpc(s.tok.body.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  eq(init.result.protocolVersion, "2025-06-18"); ok(init.result.capabilities.tools); ok(init.result.instructions.includes("read-only") || init.result.instructions.includes("Read-only"));
  const note = await req("POST", "/mcp", { headers: { authorization: "Bearer " + s.tok.body.access_token }, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  eq(note.status, 202);
  const list = await rpc(s.tok.body.access_token, "tools/list", {});
  eq(list.result.tools.map(x => x.name), ["describe_data", "query_db", "production_day", "store_snapshot", "smrt_order", "smrt_report", "smrt_usage"]);
  ok(list.result.tools.every(x => x.annotations.readOnlyHint));
});

await t("only hashes are stored; the code works once; wrong PKCE fails", async () => {
  const raw = T.tok.body.access_token;
  ok(!sqlite.prepare("SELECT 1 FROM mcp_tokens WHERE token_hash=?").get(raw), "raw token not stored");
  ok(sqlite.prepare("SELECT 1 FROM mcp_tokens WHERE token_hash=?").get(await sha256(raw)), "hash stored");
  const again = await req("POST", "/token", { form: { grant_type: "authorization_code", code: T.loc.searchParams.get("code"), code_verifier: T.verifier, client_id: T.reg.body.client_id } });
  eq(again.status, 400); eq(again.body.error, "invalid_grant");
  const s = await signIn();
  const { verifier: wrong } = await pkce();
  // a fresh code with the wrong verifier
  const q = { ...s.q, client_id: s.reg.body.client_id };
  const page = await req("GET", "/authorize?" + new URLSearchParams(q), { as: NEAL });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
  const post = await req("POST", "/authorize", { as: NEAL, form: { ...q, csrf, decision: "allow" } });
  const code = new URL(post.headers.get("location")).searchParams.get("code");
  const bad = await req("POST", "/token", { form: { grant_type: "authorization_code", code, code_verifier: wrong, client_id: q.client_id } });
  eq(bad.body.error, "invalid_grant");
});

await t("approve page: needs Access sign-in, a claude role, the right csrf; cancel returns access_denied", async () => {
  const reg = await req("POST", "/register", { body: { redirect_uris: [CB] } });
  const { challenge } = await pkce();
  const q = { response_type: "code", client_id: reg.body.client_id, redirect_uri: CB, state: "x", code_challenge: challenge, code_challenge_method: "S256" };
  eq((await req("GET", "/authorize?" + new URLSearchParams(q))).status, 401);
  const nob = await req("GET", "/authorize?" + new URLSearchParams(q), { as: "nobody@x.com" });
  eq(nob.status, 403); ok(nob.body.includes("No access"));
  eq((await req("GET", "/authorize?" + new URLSearchParams({ ...q, redirect_uri: "https://evil.example/cb" }), { as: NEAL })).status, 400);
  eq((await req("POST", "/authorize", { as: NEAL, form: { ...q, csrf: "forged", decision: "allow" } })).status, 400);
  const page = await req("GET", "/authorize?" + new URLSearchParams(q), { as: NEAL });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
  const no = await req("POST", "/authorize", { as: NEAL, form: { ...q, csrf, decision: "deny" } });
  eq(new URL(no.headers.get("location")).searchParams.get("error"), "access_denied");
  const nopkce = await req("GET", "/authorize?" + new URLSearchParams({ ...q, code_challenge: "" }), { as: NEAL });
  eq(new URL(nopkce.headers.get("location")).searchParams.get("error"), "invalid_request");
});

await t("loopback redirect (Claude Code) matches any port", async () => {
  const reg = await req("POST", "/register", { body: { redirect_uris: ["http://localhost/callback"] } });
  const { challenge } = await pkce();
  const q = { response_type: "code", client_id: reg.body.client_id, redirect_uri: "http://localhost:3118/callback", code_challenge: challenge, code_challenge_method: "S256" };
  const page = await req("GET", "/authorize?" + new URLSearchParams(q), { as: NEAL });
  eq(page.status, 200); ok(page.body.includes("Claude Code"));
});

await t("refresh: new pair each time; reusing an old refresh token turns off the chain", async () => {
  const s = await signIn();
  const r1 = await req("POST", "/token", { form: { grant_type: "refresh_token", refresh_token: s.tok.body.refresh_token, client_id: s.reg.body.client_id } });
  eq(r1.status, 200); ok(r1.body.refresh_token !== s.tok.body.refresh_token);
  ok((await rpc(r1.body.access_token, "tools/list", {})).result, "new access token works");
  const reuse = await req("POST", "/token", { form: { grant_type: "refresh_token", refresh_token: s.tok.body.refresh_token, client_id: s.reg.body.client_id } });
  eq(reuse.body.error, "invalid_grant");
  eq((await req("POST", "/mcp", { headers: { authorization: "Bearer " + r1.body.access_token }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 401, "chain revoked");
});

await t("taking away the role stops the token at once", async () => {
  const id = addUser("temp@x.com", { claude: "viewer" });
  const s = await signIn("temp@x.com");
  ok((await rpc(s.tok.body.access_token, "tools/list", {})).result);
  sqlite.prepare("DELETE FROM core_user_app_roles WHERE user_id=? AND app_id='claude'").run(id);
  eq((await req("POST", "/mcp", { headers: { authorization: "Bearer " + s.tok.body.access_token }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 401);
});

await t("read-only SQL check", async () => {
  const refused = (q, money) => { try { checkSql(q, { money }); return false; } catch (e) { return e instanceof SqlRefused; } };
  ok(!refused("SELECT 1"), "select"); ok(!refused("with a as (select 1 x) select x from a;"), "with + trailing ;");
  ok(!refused("SELECT replace(name,'TCC ','') FROM core_locations"), "replace() allowed");
  ok(!refused("SELECT 'delete from x; drop table y' AS s"), "words inside strings are fine");
  ok(!refused("SELECT updated_at, deleted_at, created_at FROM pos_orders"), "column names");
  for (const q of ["DELETE FROM pos_orders", "SELECT 1; DELETE FROM pos_orders", "WITH x AS (SELECT 1) DELETE FROM pos_orders", "WITH x AS (SELECT 1) REPLACE INTO a VALUES(1)",
    "PRAGMA table_info(pos_orders)", "SELECT * FROM mcp_tokens", 'SELECT * FROM "auth_keys"', "SELECT pin_hash FROM core_users", "ATTACH 'x' AS y", "SELECT 1 /* unclosed", "update pos_orders set notes=1"])
    ok(refused(q), "should refuse: " + q);
  ok(refused("SELECT * FROM labor_pay_rates", false), "pay rates need admin"); ok(!refused("SELECT * FROM labor_pay_rates", true));
});

await t("query_db returns rows; viewer can't see pay rates; nothing is written", async () => {
  const tok = T.tok.body.access_token;
  const r = await call(tok, "query_db", { sql: "SELECT substr(detailed_at,1,10) AS day, COUNT(*) AS orders FROM pos_orders GROUP BY 1 ORDER BY 1" });
  ok(!r.isError, r.content[0].text); const j = JSON.parse(r.content[0].text);
  eq(j.columns, ["day", "orders"]); ok(j.rows.length >= 5, "days");
  const cap = JSON.parse((await call(tok, "query_db", { sql: "SELECT id FROM pos_items", max_rows: 3 })).content[0].text);
  eq(cap.rows.length, 3); ok(cap.note);
  const before = sqlite.prepare("SELECT COUNT(*) n FROM pos_orders").get().n;
  const w = await call(tok, "query_db", { sql: "DELETE FROM pos_orders" }); ok(w.isError);
  eq(sqlite.prepare("SELECT COUNT(*) n FROM pos_orders").get().n, before);
  const v = await signIn("viewer@x.com");
  const pay = await call(v.tok.body.access_token, "query_db", { sql: "SELECT * FROM labor_pay_rates" });
  ok(pay.isError && pay.content[0].text.includes("Admins"));
  ok(!(await call(tok, "query_db", { sql: "SELECT COUNT(*) FROM labor_pay_rates" })).isError, "owner can");
  const bad = await call(tok, "query_db", { sql: "SELECT nope FROM pos_orders" }); ok(bad.isError && bad.content[0].text.includes("database answered"));
});

await t("describe_data: list without secret tables, one table with its comments, freshness", async () => {
  const tok = T.tok.body.access_token;
  const all = JSON.parse((await call(tok, "describe_data", {})).content[0].text);
  const names = all.tables.map(x => x.name);
  ok(names.includes("pos_orders") && names.includes("labor_daily_hours"));
  ok(!names.includes("mcp_tokens") && !names.includes("auth_keys") && !names.includes("plan_station_devices"), "secrets hidden");
  ok(all.freshness && all.conventions.includes("cents"));
  const one = (await call(tok, "describe_data", { table: "pos_items" })).content[0].text;
  ok(one.includes("assembled_at") && one.includes("ix_items_assembled"));
  ok((await call(tok, "describe_data", { table: "mcp_tokens" })).isError);
});

await t("store_snapshot and production_day use the apps' own code and roles", async () => {
  const tok = T.tok.body.access_token;
  const s = await call(tok, "store_snapshot", { from: "2026-10-03", to: LAST });
  ok(!s.isError, s.content[0].text); const j = JSON.parse(s.content[0].text);
  ok(JSON.stringify(j).includes("Quitman"), "stores in the snapshot");
  const p = await call(tok, "production_day", { day: LAST });
  ok(!p.isError, p.content[0].text); ok(JSON.parse(p.content[0].text).due, "review has due");
  const bad = await call(tok, "production_day", { day: "2099-01-01" }); ok(bad.isError);
  const v = await signIn("viewer@x.com");
  const rv = await call(v.tok.body.access_token, "store_snapshot", { from: "2026-10-03", to: LAST });
  ok(!rv.isError, "viewer with no retail role falls back to the claude role");
});

await t("smrt_order: live read, unknown field dropped and retried, link, logged", async () => {
  const tok = T.tok.body.access_token;
  smrtCalls.length = 0;
  const r = await call(tok, "smrt_order", { order: "26283-1001" });
  ok(!r.isError, r.content[0].text);
  ok(r.content[0].text.includes("Spot on left sleeve") && r.content[0].text.includes("clothestracker/c42/?saleId=262831001"));
  ok(r.content[0].text.includes('"readyDate"'), "says which field SMRT lacks"); eq(smrtCalls.length, 2);
  ok(smrtCalls[0].includes('getOrder(id:"262831001")'));
  ok(r.content[0].text.includes("[connector note]"));
});

await t("smrt_report: columns, where, exclusive end date; repeats suggest a D1 table", async () => {
  const tok = T.tok.body.access_token;
  smrtCalls.length = 0;
  const r = await call(tok, "smrt_report", { report: "orders", from: "2026-10-08", to: "2026-10-08", columns: ["ID", "Agent"], where: { Status: "ready" } });
  ok(!r.isError, r.content[0].text);
  const j = JSON.parse(r.content[0].text.split("\n\n[connector note]")[0]);
  eq(j.rows, [["262831002", "TCC Emory"]]);
  ok(smrtCalls.some(q => q.includes('startDate:"2026-10-08", endDate:"2026-10-09"')), "end date +1");
  ok((await call(tok, "smrt_report", { report: "orders", from: "2026-10-08", to: "2026-10-08", columns: ["Nope"] })).isError);
  ok((await call(tok, "smrt_report", { report: "orders", from: "2026-08-01", to: "2026-10-08" })).isError, "31-day cap");
  await call(tok, "smrt_report", { report: "orders", from: "2026-10-08", to: "2026-10-08", columns: ["Agent", "ID"] });
  const third = await call(tok, "smrt_report", { report: "orders", from: "2026-10-07", to: "2026-10-08", columns: ["ID", "Agent"] });
  ok(third.content[0].text.includes("Suggest to Neal adding this"), third.content[0].text.slice(-300));
  const u = JSON.parse((await call(tok, "smrt_usage", {})).content[0].text);
  ok(u.live_smrt_by_topic.some(x => x.topic === "orders: Agent, ID" && x.calls === 3), JSON.stringify(u.live_smrt_by_topic));
});

await t("no SMRT key: a plain message, not a crash", async () => {
  const k = env.SMRT_KEY; delete env.SMRT_KEY;
  const r = await call(T.tok.body.access_token, "smrt_order", { order: "262831001" });
  env.SMRT_KEY = k;
  ok(r.isError && r.content[0].text.includes("SMRT_KEY"));
});

await t("protocol: unknown method, batch, GET", async () => {
  const tok = T.tok.body.access_token;
  eq((await rpc(tok, "nope/x", {})).error.code, -32601);
  const b = await req("POST", "/mcp", { headers: { authorization: "Bearer " + tok }, body: [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }] });
  eq(b.body.length, 2);
  eq((await req("GET", "/mcp", { headers: { authorization: "Bearer " + tok } })).status, 405);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
