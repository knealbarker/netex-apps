-- Claude connector (Neal, Oct 15): a read-only MCP server at mcp.netexcleaners.com so Claude (web, desktop, phone, Claude Code)
-- can answer questions from this database and from SMRT. Claude signs in with OAuth; the person approves it once on a page
-- behind the same Cloudflare Access sign-in as the other apps. Access is a role in app 'claude', like the planner and retail.
-- Only hashes of codes and tokens are stored, never the codes or tokens themselves.
INSERT INTO core_apps(id, name, subdomain) VALUES ('claude', 'Claude connector', 'mcp');
INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at)
SELECT id, 'claude', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM core_users WHERE lower(email) = 'neal@towncountryclean.com';

-- Apps Claude registered itself as (OAuth dynamic client registration). Redirects are limited to Claude's own callback and
-- loopback addresses (Claude Code), so a registration from anywhere else is refused.
CREATE TABLE mcp_clients (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  redirect_uris_json  TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  last_used_at        TEXT
);

-- One-time sign-in codes (10 minutes, PKCE S256)
CREATE TABLE mcp_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES mcp_clients(id),
  user_id         TEXT NOT NULL REFERENCES core_users(id),
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  scope           TEXT,
  expires_at      TEXT NOT NULL,
  used_at         TEXT
);

-- Access tokens (1 hour) and refresh tokens (30 days, a new one each use). family_id ties a chain of refreshes together,
-- so a refresh token used twice (a sign it was copied) turns off the whole chain.
CREATE TABLE mcp_tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id   TEXT NOT NULL REFERENCES mcp_clients(id),
  user_id     TEXT NOT NULL REFERENCES core_users(id),
  family_id   TEXT NOT NULL,
  scope       TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  revoked_at  TEXT
);
CREATE INDEX ix_mcp_tokens_family ON mcp_tokens(family_id);

-- Every tool call: who, what, where the answer came from (d1 / smrt / planner / retail). Shows which questions keep going to
-- live SMRT, so those can become a table here instead (Neal's rule).
CREATE TABLE mcp_tool_log (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES core_organizations(id),
  user_id   TEXT REFERENCES core_users(id),
  at        TEXT NOT NULL,
  tool      TEXT NOT NULL,
  source    TEXT NOT NULL,
  topic     TEXT,              -- for live SMRT: what was asked for (report name and columns, or 'order'), to spot repeats
  args_json TEXT,
  ms        INTEGER,
  rows      INTEGER,
  error     TEXT
);
CREATE INDEX ix_mcp_tool_log ON mcp_tool_log(org_id, source, at);
