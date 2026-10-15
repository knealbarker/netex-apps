# Adding a new app at <name>.netexcleaners.com

About 30 minutes of work before the app's own features. The starter in `workers/_template` already signs people in,
checks roles, has Users & access, reads the shared database, and has passing tests.
Example below: an app called **Route Board** at **routes.netexcleaners.com**, app id `routes`.

## 1. Code (Claude can do all of this)
1. **Copy the starter:** `cp -r workers/_template workers/routes`.
2. **Rename** in `workers/routes/wrangler.toml`:
   - `name = "netex-routes"`
   - `routes = [{ pattern = "routes.netexcleaners.com", custom_domain = true }]`
   - `APP_ID = "routes"`, `APP_NAME = "Route Board"`
   - Uncomment `[[send_email]]` or `[triggers]` only if the app sends email or runs on a schedule.
   In `test/run.mjs` set `APP = "routes"`, and in `public/index.html` the `<title>`.
3. **Migration** `db/migrations/00NN_routes_app.sql` (next free number): the app's row and Neal as Owner, plus any new tables.
   ```sql
   -- Route Board (Neal, <date>): <one line on what it's for>
   INSERT INTO core_apps(id, name, subdomain) VALUES ('routes', 'Route Board', 'routes');
   INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at)
   SELECT id, 'routes', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM core_users WHERE lower(email) = 'neal@towncountryclean.com';
   -- New tables: prefix with the app (route_...), org_id TEXT NOT NULL REFERENCES core_organizations(id),
   -- ids TEXT (ulid()), money INTEGER cents, created_at/updated_at TEXT UTC, a comment on every non-obvious column.
   ```
   `core_apps.subdomain` is UNIQUE; check the existing ones (`grep -h "INSERT INTO core_apps" db/migrations/*.sql`).
   In the test, remove the `INSERT OR IGNORE INTO core_apps` line once the migration does it.
4. **Build the features:** add routes to the `routes` array in `src/index.js` (each gets `me` with `role`), pages in `public/`.
   Reuse instead of copying:
   | Need | Use |
   |---|---|
   | sign-in, roles | `../../planner/src/auth.js`: `currentUser`, `requireRole`, `rank` |
   | users of this app | `../../planner/src/users.js`: `listUsers`, `createUser`, `updateUser`, `syncAccessGroup` |
   | ids, errors, JSON, audit log | `../../planner/src/util.js`: `ulid`, `HttpError`, `json`, `readJson`, `audit` |
   | email (MIME + send) | `workers/retail/src/summary.js`: `mime`, `deliver` |
   | pay rates, labor $ | `../../planner/src/pay.js`: `payRates`, `rateOn`, `laborCost` (Admin/Owner only) |
   | sales/revenue/labor by store | `../../retail/src/snapshot.js`: `snapshot(db, env, me, from, to)` |
   | a production day | `../../planner/src/review.js`: `reviewDay(db, env, me, day)` |
   | SMRT live (rarely; prefer the D1 copy) | `../../sync/src/smrt.js`: `Smrt` (needs secret `SMRT_KEY`) |
   | Users & access screen (front end) | copy `workers/retail/public/js/views/users.js` (and `api.js`, `ui.js`) |
5. **Test:** `node workers/routes/test/run.mjs`; if you touched shared code, also the planner, retail, sync and mcp suites.
6. **Check it bundles:** `cd workers/routes && npx wrangler deploy --dry-run`.
7. **Commit and push to `main`.** The planner's build applies the migration. The new Worker doesn't deploy until step 2 below.

## 2. Cloudflare (Neal, once, ~5 minutes)
1. **Workers & Pages › Create application › Continue with GitHub › `knealbarker/netex-apps`.**
   - Project name: `netex-routes` (must match `name` in wrangler.toml)
   - Deploy command: `npx wrangler deploy` (no migrations; the planner applies them)
   - Advanced settings › Path: `/workers/routes`
   - Preview builds: off. "Protect with Cloudflare Access": off (the wildcard app already covers it).
   - API token: "netex-sync build". Deploy.
   The deploy creates `routes.netexcleaners.com` (DNS + certificate).
2. **Secrets** if the app needs any (Settings › Variables and Secrets, type Secret): `CF_API_TOKEN` so its Users screen keeps the
   "Netex users" group in step; `SMRT_KEY` only if it calls SMRT live.
3. **Nothing to do in Access**: "Netex apps" covers `*.netexcleaners.com`. Only if machines (not people) must call some paths,
   add a Self-hosted app for exactly those paths with the existing **Netex sign-in (public)** Bypass policy, and make the
   Worker check those paths itself (as `/station` and the MCP endpoints do).
4. **Email:** if it sends mail, verify each recipient under Email Routing › Destination addresses.
5. Open `https://routes.netexcleaners.com`, sign in, and give other people a role on the app's Users screen.

## 3. Checklist
- [ ] Every `/api` route goes through `currentUser`; anything money-related checks `requireRole(me, "admin")`.
- [ ] No secrets in the repo; no `localStorage` for anything that must be shared or kept.
- [ ] Times shown in Central; SMRT/Rippling stamps are already Central local (`substr(x,1,10)` = day).
- [ ] Business numbers follow `docs/business-rules.md`; if a new definition was needed, Neal confirmed it.
- [ ] README in `workers/routes/` says what it is, who sees what, how it's deployed, which secrets.
- [ ] Add the app to the table in `CLAUDE.md` and `docs/platform.md`.
- [ ] If the Claude connector should answer about the new data, add a note for the table to `TABLE_NOTES` in `workers/mcp/src/tools.js`.

## Things that went wrong before
- **Two Workers applied the same migration at once** (Oct 15): one build failed with `UNIQUE constraint failed`. Only the planner
  should run `wrangler d1 migrations apply`.
- **Cloudflare project name must be lowercase with dashes**, and match `name` in wrangler.toml.
- **Access sends an HTML sign-in page** (not JSON) when a session expires; the page script must treat non-JSON as "sign in again"
  (see `public/app.js`).
- **CSP `form-action`** must allow every host a form redirects to (the text sign-in needed `*.netexcleaners.com`).
- **Pages served from `public/` need `run_worker_first = true`**, or files are served without the sign-in check.
