# netex-prodplanner

The Production Planner web app at **https://prodplanner.netexcleaners.com** (Cloudflare Worker + static files + the shared `netex-apps` D1 database).

## How sign-in works
1. Cloudflare Access ("Netex apps" application, every netexcleaners.com subdomain) asks for an email code (One-time PIN)
   or a texted code ("Text me a code", served by `workers/auth`). Only people in the Access rule group **Netex users** get in.
2. Every request then reaches this Worker, which checks Access's signed token itself (signature, audience tag, issuer,
   expiry — `src/auth.js`) before serving anything.
3. The email is looked up in `core_users` (phone-only people have a stand-in `<digits>@phone.netexcleaners.com`); the role
   for this app comes from `core_user_app_roles` (Owner, Admin, Manager, Viewer).

**Users & access** (Admins and the Owner) adds people by email and/or mobile number, sets roles and turns people off.
With the `CF_API_TOKEN` secret set, every change also rewrites the Netex users group in Cloudflare ("Update it now" forces it).

## What's where
- **Plan** — pieces from SMRT (any day: tabs for today and the next work day, a date picker for others; past days are read-only),
  the crew (suggest from history, auto-assign, all full day, call-outs, typed piece counts), the minute-by-minute timeline,
  deadlines, checks with fixes, labor and revenue (Admins/Owner, with each person's Rippling pay rate), the washer schedule,
  **Changes today**, **Print** (one landscape page; Save as PDF from the print dialog) and publishing.
- **Floor** — the published plan replayed live for the TV (`#/floor?tv`), English/Español, alerts, the labor streak.
- **Review** — any past day against its plan, the 15-day trend, follow-ups, and the next work day's projection.
- **Team** — trainings in order, pay rates (Admins/Owner), **Order from history** (training order from where people worked).
- **Settings** — everything the plan uses, shuttle alerts (and Windows pop-ups per PC), the **daily summary email**,
  Rippling status (whether pay rates are coming through), and the desktop import.
- **Planned start vs. clocked in** (`src/attendance.js`, `attendanceOf` in `js/plan/model.js`): the crew's start and end
  columns are the plan; under each name is what the time clock (Rippling) says, with when it was last heard from. Today,
  15 minutes past someone's planned start (or late-arrival time) with no punch, the row and their timeline bar turn red and
  the cron (every 5 minutes) writes "wasn't clocked in" once to Changes today; a clock-in 10+ minutes late is written too.
  Punches edited or removed in Rippling also show there (from `labor_punch_log`, kept by netex-sync).
- **Shuttle alerts** on every screen (`public/js/alerts.js`): a deadline ready, and the two warnings before a shuttle leaves
  with work unfinished. Logged once in Changes today.
- **Offline** (`public/sw.js`): each PC keeps the app and the plans it has read (today's and the next work day's are fetched
  every 15 minutes). With the internet down, the plan and floor open read-only with an "Offline" bar.
- **Daily summary email** (`src/summary.js`): cron every 15 minutes; after Settings' time on work days it sends today vs. the
  plan and the next work day once, from reports@netexcleaners.com through Email Routing (`SEND_EMAIL` binding).
  Recipients must be verified under Email Routing › Destination addresses.

## Layout
- `src/index.js` routes, security headers and the cron; `src/auth.js` sign-in; `src/users.js` users and the Access group.
- `src/team.js`, `src/settings.js`, `src/import.js`, `src/pieces.js` (SMRT pieces), `src/plan.js` (save/publish),
  `src/review.js`, `src/pay.js` (Rippling pay rates), `src/changes.js` (Changes today, shuttle events), `src/summary.js`.
- `public/` — the app (no build step). `js/engine/engine.js` is the desktop 1.9.0 engine; `js/plan/model.js` the Plan logic
  (also used by the summary email on the server); `js/views/*` one file per section.

## Deploying
Workers Builds, root directory `workers/planner`, deploy command
`npx wrangler d1 migrations apply netex-apps --remote && npx wrangler deploy` (only this Worker applies migrations).
Secret: `CF_API_TOKEN` (Account › Access: Organizations, Identity Providers, and Groups › Edit). Never commit it.

## Tests (Node 22; Node's SQLite stands in for D1, headless Chromium for the pages)
- `test/run.mjs` sign-in and users · `test/stage2.mjs` team, settings, import · `test/pieces.mjs` · `test/plan.mjs` · `test/model.mjs`
- `test/review.mjs` · `test/stage5.mjs` pay rates, any day, changes, events, streak, summary email · `test/engine-parity.mjs`
- Browser: `test/browser.mjs`, `test/review-ui.mjs`, and **`test/e2e.mjs`** — the whole planner end to end,
  offline included. Screenshots (and the printed plan as a PDF) in `test/shots`.
