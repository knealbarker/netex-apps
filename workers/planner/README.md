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
  the crew (made by hand, call-outs, typed piece counts), the timeline, labor and revenue (Admins/Owner, with each person's Rippling pay rate),
  **Changes today**, **Print** (one landscape page; Save as PDF from the print dialog) and publishing.
- **Floor** — no tab since Oct 18 (Neal: it will run on its own big screen, like the station tablets); still opens at `#/floor`. The published plan replayed live for the TV (`#/floor?tv`), English/Español, alerts, the labor streak.
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

## Station tablets (`/station`, `src/tally.js`, `public/station/`)
A tablet at each starch bottoms press (SLB 1, SLB 2) in Fully Kiosk Browser. The manager enters the pairs in each batch
taken to IAB. Counts are never blocked by the time clock.
- **Pace (Neal, Oct 21)** is the station's only: all pairs entered today ÷ hours from the press's start to the last count.
  No per-person credit, no last hour, no breaks (the manager keeps the press staffed all day). The person the plan has on
  the press is still saved with each count, for history only.
- **Press start** = the first person planned on that press (moves included), at their planned clock-in + Settings ›
  Station tablets › "Press starts after clock-in" (10 min). "Change start time" on the tablet sets it by hand (or back to
  the plan); each change is a row in `plan_station_starts` with a front-camera photo of whoever made it, is written to
  Changes today, and is listed in Review (photos for Admins). No one planned → the first count is the start.
- Colors: green within 10% of the goal, yellow 10–20% under, red more than 20% under; more than 10% over, the numbers
  pulse (faster and bigger up to 40% over). **Goal**: Settings › Station tablets › Station goal (default 20 pairs/h).
- **Sign-in**: none. Settings › Station tablets › Add a tablet gives a 6-digit code (15 min, once); the tablet then keeps a
  secret in an HttpOnly cookie (Path=/station, 400 days, renewed on every poll). Only its SHA-256 is stored; Remove cuts it
  off. Ten wrong codes cancel every waiting code. Cloudflare Access needs a **Bypass** application for
  `prodplanner.netexcleaners.com/station`; nothing under /station trusts Access, and the rest of the app is unchanged.
- **Photos**: one small JPEG from the front camera per count (Settings can turn it off), stored in D1
  (`plan_station_photos`), Admins see them in Review, deleted after Settings' "keep photos" days by the cron.
  Only /station pages get `camera=(self)`.
- **Plan** shows SLB 1/SLB 2 tiles; **Review** compares pressed with SMRT's starch bottoms assembled, lists every count
  (managers add or remove; a count added there goes to whoever was planned on the station at that time).

## Shuttle status (`/shuttlestatus`, `src/shuttle.js`, `public/shuttlestatus/`)
For the van driver: is everything due at a store on VAN? (Neal, Oct 18.) Signed in like the rest of the planner (any role).
- **Tickets** (Oct 19; SMRT's word: an order's bags, `26287-5444-A`; tickets contain items): the driver scans tickets to VAN.
  An order with ticket scans (`pos_tickets`, from SMRT's rack-scan report, read every 2 minutes) is listed ticket by ticket:
  on VAN, or not with where it is (Bagging, a plant rack, Delivery 1 …). Tickets last scanned at the store, DELIVERED or
  RETURNED are left out; the order's items not ready yet get one row. Orders with no ticket scans are one row for their
  items (the item rules below decide its status). Customer names come from ticket and item scans. Wash & Fold bags are tickets too.
- **Linked both ways**: a Shuttles tab in the planner's tabs (red dot when a van leaves within the hour and that store isn't
  all on VAN; the tab then opens that store; `shuttleDot` in js/app.js, every 2 minutes), and the page uses the planner's
  own top bar and tabs.
- **Stores** = the stops of Settings › Shuttle runs, with when the van leaves (first stop's arrival less the drive).
- **Counted**: open orders returned to that store, due today or up to 45 days before (not voided/deleted/closed, not returned,
  picked up or delivered, not route deliveries). **Left out**: pieces back with the customer (item return date, rack
  RETURNED/DELIVERED, status customer) and pieces whose last rack scan was at that store (SMRT "Last racked store"; taken early).
  A piece without a stored rack store (read before Oct 18) gets it from its rack label when every other piece on that rack in
  60 days was at one store (G18 → Greenville), else from its letters when every numbered rack with them is one store's
  (Q100 → Quitman); shared labels (LONG, SHELF) stay unknown (`fillRackStores`).
- **Wash & Fold**: SMRT's items report never lists W&F bags (and every bag shares tag 90000000), so their rack can't be
  seen. A ready W&F order is listed as "W&F bag, check by hand" and doesn't hold up the run; one not ready does.
- **On VAN** = last rack location equals Settings › SMRT mapping › "Rack location for orders on the van" (VAN is a rack at
  Sulphur Springs). Anything else is **not on VAN**, with why: not detailed, not ready, ready on a plant rack, ready not racked.
- **Held over** = the order's due date moved today from today-or-earlier to later (or the piece was split onto such an order).
  SMRT's API can't change due dates, so that's done in SMRT (each order links there). A held-over piece without a note
  (piece or order note) still holds up the run.
- **OK to leave** when nothing is "not on VAN" and every held-over piece has a note. Rows: not on VAN first, then held over
  (no note first), then on VAN; every column sorts. A piece on VAN since an earlier day is flagged (likely never scanned at the store).
- **Check now** re-reads from SMRT right away the created days of that store's orders that still hold up the run (pieces not on
  VAN, held over without a note) plus today: `POST /api/shuttle/check` → netex-sync `POST /check`
  over the `SYNC` service binding (the planner has no SMRT key). Same ingest as the live sync; skipped if a sync is mid-run;
  the same days again within 45 s return the last answer. The page polls the database every minute.

## Layout
- `src/index.js` routes, security headers and the cron; `src/auth.js` sign-in; `src/users.js` users and the Access group.
- `src/team.js`, `src/settings.js`, `src/import.js`, `src/pieces.js` (SMRT pieces), `src/plan.js` (save/publish),
  `src/review.js`, `src/pay.js` (Rippling pay rates), `src/changes.js` (Changes today, shuttle events), `src/summary.js`.
- `public/` — the app (no build step). `js/engine/engine.js` draws the plan as entered (no simulation since Oct 14; the automatic planner was removed Oct 30); `js/plan/model.js` the Plan logic
  (also used by the summary email on the server); `js/views/*` one file per section.

## Deploying
Workers Builds, root directory `workers/planner`, deploy command
`npx wrangler d1 migrations apply netex-apps --remote && npx wrangler deploy` (only this Worker applies migrations).
Secret: `CF_API_TOKEN` (Account › Access: Organizations, Identity Providers, and Groups › Edit). Never commit it.

## Tests (Node 22; Node's SQLite stands in for D1, headless Chromium for the pages)
- `test/run.mjs` sign-in and users · `test/stage2.mjs` team, settings, import · `test/pieces.mjs` · `test/plan.mjs` · `test/model.mjs`
- `test/shuttle.mjs` shuttle status (rules, Check now, the page in Chromium) · `test/tally.mjs` station tablets (pairing, press start, pace, photos) · `test/station-ui.mjs` the tablet page and its Plan/Review/Settings parts in Chromium
- `test/breakpay.mjs` paid break rule · `test/review.mjs` · `test/stage5.mjs` pay rates, any day, changes, events, streak, summary email
- Browser: `test/browser.mjs`, `test/review-ui.mjs`, and **`test/e2e.mjs`** — the whole planner end to end,
  offline included. Screenshots (and the printed plan as a PDF) in `test/shots`.
