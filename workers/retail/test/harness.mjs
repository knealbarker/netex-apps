// Test harness for the Retail Snapshot: the planner's D1 stand-in and fake Access, this app's Worker and files.
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { createServer } from "node:http";
import { handle } from "../src/index.js";
export { freshDb, fakeAccess, d1, TEAM, AUD } from "../../planner/test/harness.mjs";
import { TEAM, AUD } from "../../planner/test/harness.mjs";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "../public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
export const assets = {
  async fetch(req) {
    let p = new URL(req.url).pathname; if (p.endsWith("/")) p += "index.html";
    const file = join(PUBLIC, p);
    if (!file.startsWith(PUBLIC) || !existsSync(file) || statSync(file).isDirectory()) return new Response("Not found", { status: 404 });
    return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] || "application/octet-stream" } });
  },
};
export const makeEnv = (db, extra = {}) => ({ DB: db, ASSETS: assets, ORG_ID: "tcc", APP_ID: "retail", TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, TIMEZONE: "America/Chicago", ...extra });

export function serve(env, { fetchImpl, token, who }) {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const email = who(); if (email) headers.set("cf-access-jwt-assertion", await token({ email }));
    const r = new Request(`http://app.test${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = await handle(r, env, { fetchImpl });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise(ok => server.listen(0, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
