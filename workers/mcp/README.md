# netex-mcp — Claude connector

**https://mcp.netexcleaners.com/mcp** — a read-only [MCP](https://modelcontextprotocol.io) server so Claude (claude.ai, desktop, phone,
Claude Code) can answer questions from the `netex-apps` D1 database and from SMRT. Companion Skill: `skills/netex-data/SKILL.md`
(definitions and SQL tips; add it in claude.ai › Settings › Capabilities › Skills).

## Tools (all read-only)
| Tool | Source | Who |
|---|---|---|
| `describe_data` | D1 schema + notes, last syncs | role in app `claude` |
| `query_db` | one SELECT/WITH on D1, ≤1000 rows | `claude` role; `labor_pay_rates` only Admin/Owner; sign-in tables never |
| `production_day` | planner's `reviewDay` (same code as Review) | planner role (labor $ for Admin/Owner) |
| `store_snapshot` | retail's `snapshot` (same code as Retail Snapshot) | retail role (else `claude` role) |
| `smrt_order` | SMRT `getOrder` live (notes, status, link) | `claude` role |
| `smrt_report` | SMRT saved reports live, ≤31 days | `claude` role |
| `smrt_usage` | `mcp_tool_log` | `claude` role |

Every call goes into `mcp_tool_log`. Live SMRT calls carry a topic (`orders: Agent, ID`, `order`, …); after 3 of the same in 30 days the
answer tells Claude to suggest adding that data to D1 (Neal, Oct 15).

## Sign-in (OAuth 2.1, MCP authorization spec)
- Claude registers itself (`/register`, dynamic client registration). Only `https://claude.ai/api/mcp/auth_callback` (and claude.com)
  or a loopback address (Claude Code) are accepted as redirects.
- `/authorize` is behind Cloudflare Access ("Netex apps", same sign-in as the other apps). This Worker re-checks the Access token,
  needs a role in app **claude**, and shows "Allow Claude to read Netex data?". PKCE S256 is required.
- `/token` gives a 1-hour access token and a 30-day refresh token (a new one on each refresh; a reused refresh token turns off the chain).
  Only SHA-256 hashes are stored (`mcp_codes`, `mcp_tokens`).
- Every `/mcp` call re-checks the person: removing their `claude` role or disabling them stops Claude at once.

## Setup (once)
1. **Deploy**: Workers & Pages › Create › Continue with GitHub › `knealbarker/netex-apps`, root directory `workers/mcp`,
   deploy command `npx wrangler deploy`. The planner's deploy applies migration 0019 (this connector's tables and Neal's role).
2. **Secret**: Workers › netex-mcp › Settings › Variables and Secrets › add `SMRT_KEY` (same key as netex-sync).
3. **Access Bypass** (Claude's servers have no Access cookie): Zero Trust › Access › Applications › Add › Self-hosted, name
   "Netex MCP (public endpoints)", destinations `mcp.netexcleaners.com/mcp`, `/token`, `/register`, `/revoke`, `/.well-known`;
   policy action **Bypass**, include Everyone. Leave `/authorize` under "Netex apps".
   (Optional hardening: include only Anthropic's range `160.79.104.0/21` — but that blocks Claude Code on your own PC.)
4. **Claude**: claude.ai › Settings › Connectors › Add custom connector › URL `https://mcp.netexcleaners.com/mcp`. Sign in when asked,
   press Allow. Then add the Skill (zip `skills/netex-data`) under Settings › Capabilities › Skills.

Adding another person: give them a role in app `claude` (D1 console:
`INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at) SELECT id,'claude','viewer',datetime('now') FROM core_users WHERE email='…';`).
They must also be in the "Netex users" Access group (any app's Users screen does that).

## Tests
`node workers/mcp/test/run.mjs` (Node 22; Node's SQLite for D1, fake Access, fake SMRT).
