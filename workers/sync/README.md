# netex-sync

Background jobs for the netexcleaners.com apps (Cloudflare Worker).

## Live SMRT sync (`src/live.js`, every 10 minutes)
- Work days only (the planner's Settings › Working day › Work days), 4 am–9 pm Central (`LIVE_START_HOUR` / `LIVE_END_HOUR`).
- Each run re-reads the last 7 created days (1 orders call, items 3 days per call) plus any older created day with an open
  order due within 4 days or overdue (14 days back): about 8 SMRT calls. The first run of each day also re-reads every
  created day in the last 45 days that has any open order (alterations, repairs).
- Stores through the same ingest as the history load, in live mode: due dates moved later open follow-ups.

## Rack scans (`src/racks.js`, every 2 minutes in the live hours)
SMRT's saved report "TCC Racked Last 12 Hours" (`ddef672f-…`) logs every rack scan of tickets (`26287-5444-A` = order
26287-5444, ticket A) and single items, filtered by scan time. Each run reads from the last read less 10 minutes to tomorrow
(scans already stored are skipped) into `pos_rack_events`, keeps each ticket's latest scan in `pos_tickets`, and fills
`pos_orders.customer_name` from the ticket. Until 45 days are loaded it also reads two earlier whole days a run. Check now
reads the newest scans first. These runs (`racks…` in int_sync_runs) never make a check or the live sync wait.

## Check now (`runCheck` in `src/live.js`, POST /check)
The planner's Shuttle status page asks for a store's open orders to be read from SMRT right away (service binding `SYNC`;
netex-sync has no public address). The body lists created days; they're read in 3-day calls (at most 6 ranges, plus today)
with the live ingest. A check waits if any SMRT run is mid-run (a run stuck over 4 minutes stops counting), and the live
sync skips a round while a check runs, so the same pieces are never written twice at once. Logged in int_sync_runs as "check now <store>".

## Rippling hours (`src/rippling.js`, email)
- Email Routing sends reports@netexcleaners.com to this Worker. A Rippling export that's read is not forwarded; any other
  email, or a Rippling email that couldn't be read, is forwarded to `FORWARD_TO`.
- Messages from rippling.com with a passing DKIM (or SPF) check and a CSV attachment are read: rows in the Rippling departments
  (Settings › Rippling) go into labor_daily_hours (finished days) and labor_clock_today (today's punches). New Production
  employees are added to the team. Punches themselves aren't kept.

## SMRT history backfill (every 15 minutes)
- Loads SMRT orders and every piece into the `netex-apps` D1 database, **one created-day at a time, newest first**.
- Runs overnight on work days (8 pm–5 am Central, `BACKFILL_START_HOUR` / `BACKFILL_END_HOUR`) and all day on days off
  (the planner's Settings › Working day › Work days; Mon–Fri by default). 2 days per run (`BACKFILL_DAYS_PER_RUN`) — about
  70 days of history per work night (~200 small SMRT calls) and about 190 days per day off (~600 calls).
- Stops for good after 21 days in a row with no orders (the start of SMRT history) or at `BACKFILL_OLDEST_DAY`.
- A failed SMRT call stops that run; the same day is retried next run. After 3 failures the day is marked
  `error` in `int_backfill_days` and the job moves on.
- Re-loading a day rewrites nothing that hasn't changed (each row carries a fingerprint).
- Progress: `GET /status` on the worker, or `SELECT * FROM int_backfill_days ORDER BY day DESC`.

## Storing orders and pieces (`src/ingest.js`)
Shared by the backfill and (later) the live sync. Pieces are matched by barcode. Changes to stored rows are
logged in `pos_changes` (due date, notes, status, piece moved/added/removed). In live mode a due date moved
later opens a `plan_followups` row — `noted` if SMRT already has a note, otherwise `needs_note`.

Pieces also keep SMRT's "Last racked store" (`last_rack_store_id`) and "Item return date" (`returned_at`); orders keep
"Customer Internal ID" (for links into SMRT) and the customer's name when a report has a name column (`customerName()`:
"Customer Name", "Customer", "Name", or "First Name" + "Last Name" — add one to "TCC All Orders This Year" in SMRT).
The backfill also waits while a check runs; runs still "running" after 15 minutes are closed as stopped. `ITEM_HASH` in ingest.js forces every piece to be rewritten once when a column is added.

## Setup (once)
1. The D1 migrations in `db/migrations` are applied to `netex-apps` by the planner's deploy (this Worker deploys with `npx wrangler deploy`).
1. Email Routing: the reports@ rule's action is "Send to a Worker: netex-sync".
2. Secret `SMRT_KEY` is set in Cloudflare (Workers > netex-sync > Settings > Variables and Secrets). Never commit it.
3. The repo is connected to Cloudflare Workers Builds with root directory `workers/sync`.

## Tests
`node workers/sync/test/run.mjs` — Node 22's built-in SQLite stands in for D1; a fake SMRT uses the real report
columns with made-up values.
