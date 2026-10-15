# netex-apps — read this first

Business apps for **Town & Country Cleaners** (Sulphur Springs, TX; owner Neal Barker), hosted on **netexcleaners.com**.
One app per subdomain, all on Cloudflare, one shared database, one sign-in.

| Read | When |
|---|---|
| `docs/platform.md` | How netexcleaners.com is set up: Cloudflare, sign-in, database, email, secrets, every Worker |
| `docs/new-app.md` | Adding a new subdomain app, step by step (code + Cloudflare dashboard) |
| `workers/_template/` | A working starter app with sign-in, roles and a test; copy it to `workers/<name>` |
| `docs/business-rules.md` | Neal's definitions (sales, revenue, labor %, assembled = complete, categories) |
| `workers/<name>/README.md` | Each app's own details |
| `db/migrations/` | The database schema; comments in the SQL explain each table |

## The apps (all Workers in `workers/`, deployed by Cloudflare Workers Builds on every push to `main`)
| Worker | Address | What |
|---|---|---|
| `planner` (netex-prodplanner) | prodplanner.netexcleaners.com | Production Planner: Plan, Floor, Review, Team, station tablets |
| `retail` (netex-retailview) | retailview.netexcleaners.com | Retail Snapshot: sales, revenue, hours, labor % by store |
| `sync` (netex-sync) | none (cron + email only) | Copies SMRT (POS) and Rippling (time clock) into the database |
| `auth` (netex-auth) | auth.netexcleaners.com | "Text me a code" sign-in (an OIDC provider inside Cloudflare Access) |
| `mcp` (netex-mcp) | mcp.netexcleaners.com/mcp | Read-only Claude connector (OAuth) over the database and SMRT |

## Rules that are easy to break
- **Never put secrets in GitHub.** Keys go in Workers › Settings › Variables and Secrets, entered by Neal. Code reads `env.X`.
- **Every request is checked in the Worker**, even behind Cloudflare Access: reuse `workers/planner/src/auth.js` (`currentUser`,
  `verifyAccessJwt`, `requireRole`). Roles are per app in `core_user_app_roles` (owner > admin > manager > viewer).
- **One database for everything** (D1 `netex-apps`). New tables get a new numbered file in `db/migrations/`; never edit an applied one.
  Money is integer cents; SMRT/Rippling times are Central local with offset (`substr(x,1,10)` = local day); app timestamps are UTC.
- **Only `workers/planner` should apply migrations** (its deploy command runs `wrangler d1 migrations apply`). New apps deploy with
  plain `npx wrangler deploy` (retail, sync, auth and mcp all do, since Oct 15, after two Workers applying the same migration at
  once failed a build).
- **Share code by relative import** (`../../planner/src/...`); Workers Builds clones the whole repo, so this bundles fine. Don't copy.
- **Tests run in Node 22** with Node's SQLite standing in for D1 and a fake Access (`workers/planner/test/harness.mjs`).
  Run the suites of any Worker whose code you touched. No network from tests.
- **Plain language** in anything people see. Neal prefers short, direct UI text and answers.
- Neal decides product questions; ask when a choice changes what people see or what the business numbers mean.

## Before you finish a change
1. Tests pass (`node workers/<name>/test/run.mjs`, plus any suite touching shared code).
2. `cd workers/<name> && npx wrangler deploy --dry-run` bundles.
3. Commit to `main` with a message that says what changed and why; the push deploys.
4. If the change needs something in the Cloudflare dashboard, list it for Neal as numbered steps.
