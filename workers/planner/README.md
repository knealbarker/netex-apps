# netex-prodplanner

The Production Planner web app at **https://prodplanner.netexcleaners.com** (Cloudflare Worker + static files + the shared `netex-apps` D1 database).

## How sign-in works
1. Cloudflare Access ("Netex apps" application, covering netexcleaners.com and every subdomain) asks for an email and
   emails a one-time code. Only addresses in the Access rule group **Netex users** get a code.
2. Every request then reaches this Worker, which checks Access's signed token itself (signature, audience tag, issuer,
   expiry — `src/auth.js`) before serving anything.
3. The email is looked up in `core_users`; the role for this app comes from `core_user_app_roles` (Owner, Admin,
   Manager, Viewer). Not on the list, turned off, or no role → a clear message, no data.

The **Users & access** screen (Admins and the Owner) adds people, sets roles and turns people off. When the
`CF_API_TOKEN` secret is set, it also keeps the Netex users group in Cloudflare in step; until then, add new emails
to that group by hand (Access controls › Policies › Rule groups).

## Layout
- `src/index.js` — routes and security headers; every path goes through the sign-in check (`run_worker_first`).
- `src/auth.js` — Access token check and the signed-in user.
- `src/users.js` — user list rules and the Access group sync.
- `public/` — the app (no build step): `index.html`, `app.css` (design tokens, dark and light), `js/app.js` (shell and
  router), `js/views/*` (one file per section).

## Deploying
Connected to Cloudflare Workers Builds with root directory `workers/planner`. Deploy command:
`npx wrangler d1 migrations apply netex-apps --remote && npx wrangler deploy`.
The custom domain `prodplanner.netexcleaners.com` is created by the deploy (see `routes` in `wrangler.toml`).

Optional secret (Workers › netex-prodplanner › Settings › Variables and Secrets): `CF_API_TOKEN`, a Cloudflare API
token with **Account › Access: Organizations, Identity Providers, and Groups › Edit**. Never commit it.

## Tests
- `node workers/planner/test/run.mjs` — sign-in checks, user list rules, group sync (Node's SQLite stands in for D1).
- `node workers/planner/test/browser.mjs` — the real pages in headless Chromium through the Worker code; screenshots in `test/shots`.
