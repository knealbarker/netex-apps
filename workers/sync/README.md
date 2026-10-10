# netex-sync

Background jobs for the netexcleaners.com apps (Cloudflare Worker, runs every 15 minutes).

## SMRT history backfill
- Loads SMRT orders and every piece into the `netex-apps` D1 database, **one created-day at a time, newest first**.
- Runs only overnight (8 pm–5 am Central, `BACKFILL_START_HOUR` / `BACKFILL_END_HOUR`), 2 days per run
  (`BACKFILL_DAYS_PER_RUN`) — about 70 days of history per night, roughly 200 small SMRT calls.
- Stops for good after 21 days in a row with no orders (the start of SMRT history) or at `BACKFILL_OLDEST_DAY`.
- A failed SMRT call stops that run; the same day is retried next run. After 3 failures the day is marked
  `error` in `int_backfill_days` and the job moves on.
- Re-loading a day rewrites nothing that hasn't changed (each row carries a fingerprint).
- Progress: `GET /status` on the worker, or `SELECT * FROM int_backfill_days ORDER BY day DESC`.

## Storing orders and pieces (`src/ingest.js`)
Shared by the backfill and (later) the live sync. Pieces are matched by barcode. Changes to stored rows are
logged in `pos_changes` (due date, notes, status, piece moved/added/removed). In live mode a due date moved
later opens a `plan_followups` row — `noted` if SMRT already has a note, otherwise `needs_note`.

## Setup (once)
1. The D1 migrations in `db/migrations` are applied to `netex-apps`.
2. Secret `SMRT_KEY` is set in Cloudflare (Workers > netex-sync > Settings > Variables and Secrets). Never commit it.
3. The repo is connected to Cloudflare Workers Builds with root directory `workers/sync`.

## Tests
`node workers/sync/test/run.mjs` — Node 22's built-in SQLite stands in for D1; a fake SMRT uses the real report
columns with made-up values.
