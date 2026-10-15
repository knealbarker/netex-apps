# How netexcleaners.com is set up

Everything runs on one Cloudflare account (Workers Paid plan):
account ID `61c6ba95bfea0222857214634869b20a`, owner neal@towncountryclean.com. Decided Oct 10, 2026: one subdomain per app,
Cloudflare for domain, DNS, sign-in (Zero Trust Access), hosting (Workers) and database (D1). Supabase was considered and dropped.

```
 browser ──► Cloudflare Access ("Netex apps", *.netexcleaners.com) ──► Worker for that subdomain ──► D1 netex-apps
               │ email code (One-time PIN)                                │ re-checks the Access token
               │ or "Text me a code" (auth.netexcleaners.com → Twilio)    │ looks the person up in core_users
               └─ allowed if in rule group "Netex users"                  └─ role from core_user_app_roles (per app)
 SMRT (POS) ──► netex-sync (cron) ──► D1        Rippling CSV email ──► reports@netexcleaners.com ──► netex-sync ──► D1
 Claude ──► mcp.netexcleaners.com/mcp (OAuth; /authorize behind Access) ──► D1 / SMRT, read-only
```

## Sign-in (one login for every app)
- **Zero Trust team domain:** `netexcleaners.cloudflareaccess.com`.
- **Login methods:** One-time PIN (email) and **Text me a code** (an OIDC provider, id `bec83a25-e963-4a39-9d87-cfea4387fe61`,
  served by `workers/auth` at auth.netexcleaners.com; Twilio Verify sends the code). Phone-only people get a stand-in email
  `<digits>@phone.netexcleaners.com`, so every app sees an email either way.
- **Access applications** (Zero Trust › Access controls › Applications):
  | Application | Destinations | Policy |
  |---|---|---|
  | **Netex apps** | `*.netexcleaners.com` | **Staff** (Allow, rule group "Netex users", 1-month session) |
  | Netex sign-in (public) | `auth.netexcleaners.com` | Netex sign-in (public): Bypass |
  | Station tablets (public) | `prodplanner.netexcleaners.com/station` | Tablets bypass: Bypass (tablets use their own device cookie) |
  | Netex MCP (public endpoints) | `mcp.netexcleaners.com` paths `/mcp`, `/token`, `/register`, `/revoke`, `/.well-known` | Netex sign-in (public): Bypass |
  A more specific application (hostname or path) wins over the wildcard. **A new subdomain is covered by "Netex apps" automatically.**
  Only add a Bypass app for paths that machines call without a person's login, and then the Worker must guard those paths itself.
- **Audience tag** of "Netex apps" (the `aud` in its tokens, not secret):
  `c8867e4f1d945bfb7fc6b393e7f40f0c3bb050846ca416789136186e32e5de57`. Every app behind it uses this `ACCESS_AUD`.
- **Rule group "Netex users"** (ID `2c00c66c-8c20-44bd-95b1-07639add45ab`) is kept in step by the apps: any app's Users & access
  screen rewrites the group to "every active user who has a role in any app" (`syncAccessGroup` in `workers/planner/src/users.js`,
  needs the Worker secret `CF_API_TOKEN`: account token with Access: Organizations, Identity Providers, and Groups › Edit).
  **Don't add people to the group by hand.**
- **In the Worker:** `currentUser(req, env)` (`workers/planner/src/auth.js`) verifies the Access JWT (signature from
  `<team>/cdn-cgi/access/certs`, audience, issuer, expiry), then finds the email in `core_users` (active, not deleted) and the role
  for `env.APP_ID` in `core_user_app_roles`. 401 = not signed in; 403 = signed in but not on the list / no role in this app.
  The check runs even though Access already ran, so a mistake in Access settings can't open an app to strangers.
- **Roles:** `owner` (40) > `admin` (30) > `manager` (20) > `viewer` (10). Convention: Owner/Admin = users, settings, money (pay rates,
  labor $); Manager = runs the day; Viewer = read only. Pay rates are Admin/Owner only everywhere.

## Database: D1 `netex-apps` (ID `1657081e-9193-4636-a12b-88e0f1f86438`)
- One database for every app, binding `DB`. Schema in `db/migrations/*.sql` (comments explain each table). Prefixes:
  `core_` shared (org, locations, departments, people, users, apps, roles, settings, audit log) · `int_` integrations and sync runs ·
  `pos_` full copy of SMRT orders and pieces · `labor_` Rippling hours and pay rates · `plan_` planner · `auth_` text sign-in ·
  `mcp_` Claude connector.
- Org id is `'tcc'` (`env.ORG_ID`). IDs are ULIDs (`ulid()` in `workers/planner/src/util.js`); small lookups use readable ids.
- Each app is a row in `core_apps` (`id`, `name`, `subdomain`); a person's access to it is a row in `core_user_app_roles`.
- Settings per app: `core_settings (org_id, app_id, key, value_json)`. Who changed what: `audit()` → `core_audit_log`.
- **Migrations:** add `db/migrations/00NN_<what>.sql`. The planner's deploy applies them
  (`npx wrangler d1 migrations apply netex-apps --remote && npx wrangler deploy`). Seed a new app's row and Neal's Owner role in
  the same migration (see 0007, 0019).
- Data freshness: SMRT copied every 10 min on work days 4 AM–9 PM, nightly history backfill; Rippling every 10 min (emailed CSV).

## Email
- **Email Routing** on netexcleaners.com: `reports@` → Worker netex-sync (reads Rippling's CSV; anything else is forwarded to Neal).
- **Sending:** a `[[send_email]]` binding named `SEND_EMAIL`, from `reports@netexcleaners.com`. Recipients must be verified under
  Email Routing › Destination addresses. Examples: `workers/planner/src/summary.js`, `workers/retail/src/summary.js` (`mime`, `deliver`).

## Outside services
| Service | Used by | How | Secret (Worker setting, entered by Neal) |
|---|---|---|---|
| SMRT POS GraphQL `towncountryclean.smrtapp.com/graphql` | sync, mcp | saved reports, read-only; key expires ~Jan 2027 | `SMRT_KEY` |
| Rippling time clock | sync | CSV report emailed every 10 min, Mon–Fri 4 AM–6 PM | none |
| Twilio Verify | auth | texts sign-in codes | `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `OIDC_CLIENT_SECRET` |
| Cloudflare API | planner, retail | keeps the "Netex users" group in step | `CF_API_TOKEN` |
SMRT notes: end dates are exclusive; ask for `columns` and `values` in separate calls; 5,000-row cap per call (`workers/sync/src/smrt.js`).

## Hosting and deploys
- Code: private GitHub repo `knealbarker/netex-apps`, branch `main`. Each Worker is connected in Cloudflare
  (Workers & Pages › Create › Continue with GitHub) with **root directory `workers/<name>`**; a push to `main` builds and deploys
  every connected Worker. Build token: "netex-sync build".
- The custom domain comes from `routes = [{ pattern = "<sub>.netexcleaners.com", custom_domain = true }]` in `wrangler.toml`;
  the first deploy creates the DNS record and certificate. `workers_dev = false`, `preview_urls = false`.
- Static files (`public/`) are served through the Worker with `run_worker_first = true`, so no file is served before the sign-in check.
- Each app's Settings › Variables shows the non-secret vars from `wrangler.toml`; secrets survive deploys.
