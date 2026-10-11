// Tests for netex-auth (text-a-code sign-in). Run: node workers/auth/test/run.mjs
import { freshDb } from "../../planner/test/harness.mjs";
import { handle, normalizePhone, phoneAlias } from "../src/index.js";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.stack || e).split("\n").slice(0, 3).join("\n       ")); } };
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };

const CALLBACK = "https://netexcleaners.cloudflareaccess.com/cdn-cgi/access/callback";
function setup() {
  const { db, sqlite } = freshDb();
  const env = { DB: db, ORG_ID: "tcc", ISSUER: "https://auth.netexcleaners.com", OIDC_CLIENT_ID: "cloudflare-access", OIDC_CLIENT_SECRET: "s3cret-value-for-tests",
    REDIRECT_URIS: CALLBACK, TWILIO_VERIFY_SID: "VAtest", TWILIO_API_KEY_SID: "SKtest", TWILIO_API_KEY_SECRET: "keysecret" };
  // a manager with a phone and no email; a viewer with both; a turned-off user
  sqlite.exec(`INSERT INTO core_users(id, org_id, email, display_name, phone) VALUES
    ('U1','tcc','${phoneAlias("+19035550101")}','Maria Phone','+19035550101'),
    ('U2','tcc','both@example.com','Both Ways','+19035550102'),
    ('U3','tcc','off@example.com','Turned Off','+19035550103');
    UPDATE core_users SET status='disabled' WHERE id='U3';
    INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES('U1','planner','manager','2026-10-11'),('U2','planner','viewer','2026-10-11'),('U3','planner','viewer','2026-10-11');`);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url: String(url), body, auth: init.headers.authorization });
    if (String(url).endsWith("/Verifications")) return new Response(JSON.stringify({ status: "pending" }), { status: 201 });
    if (String(url).endsWith("/VerificationCheck")) return new Response(JSON.stringify({ status: body.Code === "123456" ? "approved" : "pending" }), { status: 200 });
    throw new Error("unexpected " + url);
  };
  const req = (method, path, { form, headers = {} } = {}) => handle(new Request(`https://auth.netexcleaners.com${path}`, {
    method, headers: { "cf-connecting-ip": "1.2.3.4", ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...headers },
    body: form ? new URLSearchParams(form) : undefined, redirect: "manual" }), env, { fetchImpl });
  return { db, sqlite, env, calls, req };
}
const ridOf = async res => (await res.text()).match(/name="rid" value="([^"]+)"/)[1];
const start = async (A, extra = "") => ridOf(await A.req("GET", `/authorize?client_id=cloudflare-access&response_type=code&redirect_uri=${encodeURIComponent(CALLBACK)}&state=st8&nonce=n0nce&scope=openid%20email${extra}`));
const b64 = s => JSON.parse(Buffer.from(s, "base64url").toString());
async function tokenFor(A, code, { secret = A.env.OIDC_CLIENT_SECRET, verifier } = {}) {
  return A.req("POST", "/token", { form: { grant_type: "authorization_code", code, redirect_uri: CALLBACK, ...(verifier ? { code_verifier: verifier } : {}) },
    headers: { authorization: "Basic " + Buffer.from(`cloudflare-access:${secret}`).toString("base64") } });
}
async function signIn(A, phone = "(903) 555-0101", extra = "") {
  const rid = await start(A, extra);
  await A.req("POST", "/send", { form: { rid, phone } });
  const r = await A.req("POST", "/check", { form: { rid, code: "123 456" } });
  return r;
}

await t("phone numbers: US formats become +1XXXXXXXXXX", async () => {
  eq([normalizePhone("(903) 555-0101"), normalizePhone("903.555.0101"), normalizePhone("1-903-555-0101"), normalizePhone("+44 20 7946 0958"), normalizePhone("555-0101")],
    ["+19035550101", "+19035550101", "+19035550101", "+442079460958", null]);
  eq(phoneAlias("+19035550101"), "19035550101@phone.netexcleaners.com");
});
await t("discovery document and signing keys", async () => {
  const A = setup();
  const d = await (await A.req("GET", "/.well-known/openid-configuration")).json();
  eq([d.issuer, d.token_endpoint, d.jwks_uri], ["https://auth.netexcleaners.com", "https://auth.netexcleaners.com/token", "https://auth.netexcleaners.com/jwks"]);
  const k = await (await A.req("GET", "/jwks")).json();
  eq([k.keys.length, k.keys[0].alg, !!k.keys[0].d], [1, "RS256", false], "public key only");
  const k2 = await (await A.req("GET", "/jwks")).json(); eq(k2.keys[0].kid, k.keys[0].kid, "same key next time");
});
await t("only Cloudflare Access's own callback is accepted", async () => {
  const A = setup();
  eq((await A.req("GET", `/authorize?client_id=cloudflare-access&response_type=code&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`)).status, 400);
  eq((await A.req("GET", `/authorize?client_id=someone-else&response_type=code&redirect_uri=${encodeURIComponent(CALLBACK)}`)).status, 400);
});
await t("full sign-in: text sent, code checked, token with the person's stand-in email, nonce and phone", async () => {
  const A = setup();
  const r = await signIn(A);
  eq(r.status, 303);
  const loc = new URL(r.headers.get("location"));
  eq([loc.origin + loc.pathname, loc.searchParams.get("state")], [CALLBACK, "st8"]);
  eq(A.calls.map(c => [c.url.split("/").pop(), c.body.To]), [["Verifications", "+19035550101"], ["VerificationCheck", "+19035550101"]]);
  eq(A.calls[0].body.Channel, "sms"); eq(A.calls[0].auth, "Basic " + btoa("SKtest:keysecret"));
  const tok = await (await tokenFor(A, loc.searchParams.get("code"))).json();
  const claims = b64(tok.id_token.split(".")[1]);
  eq([claims.email, claims.sub, claims.nonce, claims.aud, claims.phone_number, claims.name], ["19035550101@phone.netexcleaners.com", "U1", "n0nce", "cloudflare-access", "+19035550101", "Maria Phone"]);
  // the signature checks out against /jwks
  const jwk = (await (await A.req("GET", "/jwks")).json()).keys[0];
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const [h, p, s] = tok.id_token.split(".");
  ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`)), "signature");
  const ui = await (await A.req("GET", "/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  eq(ui.email, "19035550101@phone.netexcleaners.com");
});
await t("someone with both an email and a phone signs in as their email", async () => {
  const A = setup();
  const loc = new URL((await signIn(A, "903-555-0102")).headers.get("location"));
  eq(b64((await (await tokenFor(A, loc.searchParams.get("code"))).json()).id_token.split(".")[1]).email, "both@example.com");
});
await t("a number not on the list (or turned off) sees the same page but no text is sent", async () => {
  const A = setup();
  for (const phone of ["9035559999", "9035550103"]) {
    const rid = await start(A);
    const page = await (await A.req("POST", "/send", { form: { rid, phone } })).text();
    ok(/Enter your code/.test(page) && /0103|9999/.test(page), "code page shown");
    const r = await A.req("POST", "/check", { form: { rid, code: "123456" } });
    eq(r.status, 400, "no sign-in");
  }
  eq(A.calls.length, 0, "Twilio never called");
});
await t("wrong code is refused; the authorization code works once, needs the right client secret and expires", async () => {
  const A = setup();
  const rid = await start(A);
  await A.req("POST", "/send", { form: { rid, phone: "9035550101" } });
  const bad = await A.req("POST", "/check", { form: { rid, code: "000000" } });
  eq(bad.status, 400); ok(/isn&#39;t right/.test(await bad.text()));
  const good = await A.req("POST", "/check", { form: { rid, code: "123456" } });
  const code = new URL(good.headers.get("location")).searchParams.get("code");
  eq((await tokenFor(A, code, { secret: "wrong" })).status, 401);
  eq((await tokenFor(A, code)).status, 200);
  eq((await tokenFor(A, code)).status, 400, "second use refused");
  const loc2 = new URL((await signIn(A)).headers.get("location"));
  A.sqlite.exec("UPDATE auth_codes SET expires_at='2000-01-01T00:00:00.000Z' WHERE used_at IS NULL");
  eq((await tokenFor(A, loc2.searchParams.get("code"))).status, 400, "expired");
});
await t("PKCE: a code_challenge must be matched by the verifier", async () => {
  const A = setup();
  const verifier = "v".repeat(50), challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const code = new URL((await signIn(A, "9035550101", `&code_challenge=${challenge}&code_challenge_method=S256`)).headers.get("location")).searchParams.get("code");
  eq((await tokenFor(A, code, { verifier: "wrong" })).status, 400);
  const code2 = new URL((await signIn(A, "9035550101", `&code_challenge=${challenge}&code_challenge_method=S256`)).headers.get("location")).searchParams.get("code");
  eq((await tokenFor(A, code2, { verifier })).status, 200);
});
await t("limits: 5 texts per number per hour, 8 wrong codes per number per hour", async () => {
  const A = setup();
  for (let i = 0; i < 5; i++) { const rid = await start(A); eq((await A.req("POST", "/send", { form: { rid, phone: "9035550101" } })).status, 200); }
  const rid = await start(A);
  const r = await A.req("POST", "/send", { form: { rid, phone: "9035550101" } });
  eq(r.status, 429); ok(/Too many codes/.test(await r.text()));
  eq(A.calls.length, 5);
  const B = setup(); const rb = await start(B);
  await B.req("POST", "/send", { form: { rid: rb, phone: "9035550101" } });
  for (let i = 0; i < 8; i++) await B.req("POST", "/check", { form: { rid: rb, code: "000000" } });
  const locked = await B.req("POST", "/check", { form: { rid: rb, code: "123456" } });
  eq(locked.status, 429, "locked even with the right code");
});
await t("a timed-out page and posts from other sites are refused; pages have strict headers", async () => {
  const A = setup();
  const rid = await start(A);
  A.sqlite.exec("UPDATE auth_requests SET expires_at='2000-01-01T00:00:00.000Z'");
  eq((await A.req("POST", "/send", { form: { rid, phone: "9035550101" } })).status, 400);
  const rid2 = await start(A);
  eq((await A.req("POST", "/send", { form: { rid: rid2, phone: "9035550101" }, headers: { origin: "https://evil.example" } })).status, 403);
  eq((await A.req("POST", "/send", { form: { rid: rid2, phone: "9035550101" }, headers: { origin: "https://auth.netexcleaners.com" } })).status, 200, "our own page's posts are accepted");
  const pg = await A.req("GET", `/authorize?client_id=cloudflare-access&response_type=code&redirect_uri=${encodeURIComponent(CALLBACK)}`);
  ok(/frame-ancestors 'none'/.test(pg.headers.get("content-security-policy"))); eq(pg.headers.get("referrer-policy"), "same-origin", "so the browser sends our origin with the form"); eq(pg.headers.get("cache-control"), "no-store");
  ok(/autocomplete="tel-national"/.test(await pg.text()));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
