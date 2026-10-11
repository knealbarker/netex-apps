// Test harness: the real Worker code over Node's built-in SQLite (in place of D1), a fake Access
// sign-in service with its own RSA key, and a local HTTP server for browser tests.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { createServer } from "node:http";
import { handle } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = join(here, "../../../db/migrations");
const PUBLIC = join(here, "../public");

export function d1(sqlite) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    _exec: () => sqlite.prepare(sql).run(...args),
  });
  return {
    prepare: sql => wrap(sql),
    batch: async stmts => { sqlite.exec("BEGIN"); const out = []; try { for (const s of stmts) out.push({ meta: { changes: s._exec().changes } }); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return out; },
  };
}

export function freshDb() {
  const s = new DatabaseSync(":memory:"); s.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync(MIG).filter(f => f.endsWith(".sql")).sort()) s.exec(readFileSync(join(MIG, f), "utf8"));
  return { sqlite: s, db: d1(s) };
}

// ---- fake Cloudflare Access: signs tokens like Access does and serves the matching public key
export const TEAM = "https://netexcleaners.cloudflareaccess.com";
export const AUD = "test-aud-0123456789";
const b64u = buf => Buffer.from(buf).toString("base64url");
export async function fakeAccess() {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  let certCalls = 0;
  const fetchImpl = async url => {
    if (String(url) === `${TEAM}/cdn-cgi/access/certs`) { certCalls++; return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } }); }
    throw new Error("unexpected fetch " + url);
  };
  async function token(claims = {}, { kid = "k1", key = kp.privateKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const p = b64u(JSON.stringify({ aud: [AUD], iss: TEAM, email: "neal@towncountryclean.com", iat: now, nbf: now, exp: now + 3600, ...claims }));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64u(sig)}`;
  }
  return { fetchImpl, token, otherKey: other.privateKey, certCalls: () => certCalls };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json" };
export const assets = {
  async fetch(req) {
    let p = new URL(req.url).pathname;
    if (p.endsWith("/")) p += "index.html";
    const file = join(PUBLIC, p);
    if (!file.startsWith(PUBLIC) || !existsSync(file) || statSync(file).isDirectory()) return new Response("Not found", { status: 404 });
    return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] || "application/octet-stream" } });
  },
};

export function makeEnv(db, extra = {}) {
  return { DB: db, ASSETS: assets, ORG_ID: "tcc", APP_ID: "planner", TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCOUNT_ID: "acct", ...extra };
}

// Local server that runs requests through the Worker (for the browser test). Signs in as whoever `who()` returns.
export function serve(env, { fetchImpl, token, who }) {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const email = who();
    if (email) headers.set("cf-access-jwt-assertion", await token({ email }));
    const r = new Request(`http://app.test${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = await handle(r, env, { fetchImpl });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise(ok => server.listen(0, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
