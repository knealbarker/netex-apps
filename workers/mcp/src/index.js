// netex-mcp: Claude's connector to the Netex database and SMRT (mcp.netexcleaners.com).
// MCP over Streamable HTTP, stateless (one JSON answer per POST, no sessions), plus the OAuth endpoints in oauth.js.
import * as O from "./oauth.js";
import { TOOLS, callTool } from "./tools.js";
import { json } from "../../planner/src/util.js";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const INSTRUCTIONS = `Read-only data for Town & Country Cleaners (Sulphur Springs, TX): SMRT orders and pieces copied into a database every 10 minutes on work days, Rippling time clock hours, and the production planner.
Prefer production_day and store_snapshot for the daily numbers the apps show (they use the apps' own rules). Use query_db for anything else; call describe_data first for a table you haven't used.
Use smrt_order / smrt_report only for what the database doesn't keep (notes) or for the last few minutes. If a [connector note] says a live SMRT question keeps repeating, suggest adding that data to the database.
Definitions: sales = order detailed date, revenue = paid date, both before tax; a piece is complete when assembled; labor target 17%. Times are Central.`;

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function rpc(env, me, msg, opts) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg && msg.id, -32600, "Invalid request");
  const isNote = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params && msg.params.protocolVersion;
      return rpcResult(msg.id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "netex-data", title: "Netex data (Town & Country Cleaners)", version: "1.0.0" }, instructions: INSTRUCTIONS });
    }
    case "ping": return isNote ? null : rpcResult(msg.id, {});
    case "tools/list": return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call": {
      const p = msg.params || {};
      if (!TOOLS.some(t => t.name === p.name)) return rpcError(msg.id, -32602, `Unknown tool ${p.name}`);
      return rpcResult(msg.id, await callTool(env, me, p.name, p.arguments || {}, opts));
    }
    case "resources/list": return rpcResult(msg.id, { resources: [] });
    case "prompts/list": return rpcResult(msg.id, { prompts: [] });
    default:
      if (isNote || msg.method.startsWith("notifications/")) return null;
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function mcp(req, env, opts) {
  if (req.method === "GET") return new Response("This server doesn't open event streams.", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const me = await O.bearerUser(req, env);
  if (!me) return O.unauthorized(env);
  let body; try { body = await req.json(); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }
  const list = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of list) { const r = await rpc(env, me, m, opts); if (r) out.push(r); }
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
}

export async function handle(req, env, opts = {}) {
  const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (p === "/mcp") return await mcp(req, env, opts);
    if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") return json(O.protectedResourceMetadata(env), 200, { "access-control-allow-origin": "*" });
    if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server/mcp" || p === "/.well-known/openid-configuration")
      return json(O.authServerMetadata(env), 200, { "access-control-allow-origin": "*" });
    if (p === "/register" && req.method === "POST") return await O.register(req, env);
    if (p === "/token" && req.method === "POST") return await O.token(req, env);
    if (p === "/revoke" && req.method === "POST") return await O.revoke(req, env);
    if (p === "/authorize" && (req.method === "GET" || req.method === "POST")) return await O.authorize(req, env, opts);
    if (p === "/") return new Response("Netex data connector for Claude. Add https://mcp.netexcleaners.com/mcp as a custom connector in Claude.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  } catch (e) {
    console.error(e);
    return json({ error: "server_error", error_description: "Something went wrong on the connector." }, 500);
  }
}

export default { fetch: (req, env) => handle(req, env) };
