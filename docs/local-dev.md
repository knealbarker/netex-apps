# Local development on Windows

Run any app on your laptop against a local copy of the database. Nothing here changes production unless you push to `main`.

## First time
1. `1 - Install tools.cmd`: installs Git, Node.js LTS, VS Code (with a SQLite viewer and Claude Code), and the GitHub CLI.
2. Close the window, then run `2 - Set up.cmd`. It pins the folder in OneDrive, installs packages, writes `.dev.vars`,
   builds an empty local database from `db/migrations` (Neal seeded as Owner), runs the tests, and offers the Cloudflare sign-in.
(Both `.cmd` files sit in the folder above this repo and call `dev/windows/*.ps1`.)

## Every day
| Do | How |
|---|---|
| Run an app | `Start planner.cmd` (or retail, supplies, texts), or `dev\windows\start.ps1 <app>` |
| Open it | planner :8787, retail :8788, supplies :8789, sms :8790, mcp :8791, auth :8792, sync :8793 (`http://localhost:<port>`) |
| Run the tests | `Run tests.cmd`, or `node workers/<app>/test/run.mjs` |
| Use real data | `Copy production data.cmd` (read-only export, then loaded locally; run after 9pm) |
| Start clean | `dev\windows\reset-local-db.ps1` |
| Run a cron job | `http://localhost:<port>/__scheduled?cron=<cron from wrangler.toml>` |

## How local differs from Cloudflare
- **Sign-in:** no Cloudflare Access locally. `DEV_EMAIL` in `.dev.vars` signs you in, and the code honors it only on `localhost`/`127.0.0.1`.
- **Database:** one local SQLite copy of D1 `netex-apps`, shared by every app, kept in `%LOCALAPPDATA%\netex-dev\wrangler-state`
  (outside OneDrive, so it isn't synced or corrupted mid-write). New migrations: run `reset-local-db.ps1`, or
  `npx wrangler d1 migrations apply netex-apps --local --persist-to "%LOCALAPPDATA%\netex-dev\wrangler-state"` from `workers/planner`.
- **Secrets:** `.dev.vars` per worker; git ignores them. Leave the Twilio keys and `CF_API_TOKEN` empty: with them, a local run
  sends real texts or edits the real Access group. `SMRT_KEY` only reads SMRT.
- **Email:** `send_email` is simulated locally (wrangler prints it); nothing goes out.
- **Linked apps:** planner starts with netex-sync (`SYNC`) and netex-sms (`TEXTS`), retail with netex-sms (`TEXTS`).

## Rules
- Work on a branch; merge to `main` only when ready. **A push to `main` deploys to the live apps.**
- Never run `wrangler deploy`, or any `--remote` command except the read-only export, from the laptop.
- Never commit `.dev.vars` or a `.sql` export.
- Browser tests (`test/browser.mjs` etc.) need Playwright: `npm i -g playwright`, `npx playwright install chromium`, and the
  `NODE_PATH` user variable set to the output of `npm root -g`.
