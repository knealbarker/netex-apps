# netex-retailview

The Retail Snapshot at **https://retailview.netexcleaners.com**: store and company sales, revenue, labor hours, labor cost
and labor % (Cloudflare Worker + static files + the shared `netex-apps` D1 database).

## Sign-in
Same as the planner: the Cloudflare Access application "Netex apps" (*.netexcleaners.com) emails or texts a one-time code,
this Worker re-checks Access's token (`../planner/src/auth.js`), then looks the person up in `core_users`. The role comes from
`core_user_app_roles` for app **retail** — separate from the planner, so a store manager can have the Snapshot without the planner.
Users & access (Admins and the Owner) is the same screen and code as the planner's (`../planner/src/users.js`).

| Role | Sees |
|---|---|
| Owner | everything, Settings, Users, loading a Rippling CSV |
| Admin | everything, Settings, Users |
| Manager / Viewer | sales, revenue, collected %, hours. Labor $ and labor % only if Settings › "Managers and Viewers see labor" is on |

## How the numbers are made (Neal, Oct 11 2026)
- **Sales**: orders *detailed* in the range (SMRT "Detailed date"), before tax (price − tax).
- **Revenue**: orders *paid* in the range (SMRT "Paid date"), before tax.
- **Store credit**: the store the order was detailed into (SMRT "Agent").
- **Collected %**: of the range's sales, the share already paid.
- **Hours**: Rippling time clock by work location (TCC SS Retail → Sulphur Springs, TCC SS Workshop → Workshop, TCC Laundry Hub → Laundry Hub).
  Finished days from `labor_daily_hours`; today from today's punches.
- **Labor $**: hours × the person's pay rate (`labor_pay_rates`, read from a pay-rate column in the Rippling report once it has one),
  or the department's average rate (Settings) until then, plus the payroll burden %.
- **Labor %**: labor $ ÷ revenue for the same days. Store target 17%. Workshop + Laundry Hub are shown against company revenue.
- **Winnsboro** has no staff; Settings › Stores rolls it into Sulphur Springs (its own line, counted in SS's totals).
- Deleted orders are left out. Each range is compared with the same number of days just before it.
- Not yet: overtime premium (hours are costed at straight time), ADP history before Rippling.

## Data it relies on (netex-sync)
- Rippling: every department and work location is stored (migration 0007; before, only Production was kept).
- SMRT: once a day the live sync re-reads the orders report alone for the last 62 days so payments made after pickup
  (statements, AutoPay) are picked up.

## Deploying
Cloudflare Workers Builds, root directory `workers/retail`. Deploy command:
`npx wrangler d1 migrations apply netex-apps --remote && npx wrangler deploy`.
The custom domain `retailview.netexcleaners.com` is created by the deploy. Optional secret: `CF_API_TOKEN` (same as the planner's).

## Tests
- `node workers/retail/test/run.mjs` — sign-in and roles, every number above against made-up data, settings, the CSV import.
- `node workers/retail/test/browser.mjs` — the real pages in headless Chromium (dark, light, phone, Manager view); screenshots in `test/shots`.
