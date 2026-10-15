# netex-supplies

Supply counts, shuttle lists and vendor orders at **https://supplies.netexcleaners.com** (Cloudflare Worker + static files +
the shared `netex-apps` D1 database, tables `supply_*`, migrations 0020–0021).

## How it works (Neal, Oct 15 2026)
- **Locations**: Sulphur Springs Workshop (the warehouse), Sulphur Springs, Greenville, Emory, Winnsboro and Quitman Retail, Laundry Hub.
- **Counting** happens at `supplies.netexcleaners.com/count` on a device at each location. No sign-in: the device is paired once
  with a 6-digit code (Setup › Counting devices; 15 minutes, once; ten wrong codes cancel every waiting code), then keeps a secret
  in an HttpOnly cookie (Path=/count, 400 days). The person types **first name + last initial** ("KarlaV"); only names on
  Setup › Who can count are accepted (optionally limited to one location). Answers are kept on the device while counting.
- **How each item is asked** is set per item per location (Supply list › item): **Count** (a number), **Out / Low / OK**, or
  **Need any?** (yes + how many). Out = a full par, Low = half the par (rounded up), OK = nothing.
- **Par / reorder point**: below par → ask for par − on hand. With a reorder point, only once at or below it (then back up to par).
  Workshop numbers are in the order unit ("case"); stores count the store unit ("roll").
- **Shuttle (Mon–Fri)**: a store's count becomes its open shuttle list; a newer count replaces the open list. The supply manager
  adjusts what's sent, adds items or write-ins, prints the slip (it rides back with the items) and marks it sent.
- **Orders**: the Workshop's latest count of each item drives "to order", grouped by vendor with lead time (expected date) and
  minimum (shown against the total when items have a cost). Mark ordered → off the suggestions until counted again after the order.
  Received / cancelled close it. A Workshop count can be entered by the vendor or shelf; only answered items are saved.
- **Count requests**: the supply manager asks locations to count (with a due date and note); it shows on their count page until
  a count comes in.

## Roles (app `supplies`)
| Role | Can |
|---|---|
| Owner / Admin | everything, plus Users & access |
| Manager (supply manager) | shuttle, orders, counts, requests, supply list, vendors, counters, devices |
| Viewer | look only |

## Starting supply list
`db/supplies/catalog.py` turned "2026 TCC Inventory Order Sheets.xlsx" into 129 items, 6 vendors and pars per location
(writes `db/migrations/0021_supplies_seed.sql`). Guesses are saved on the item as **To check** (Supply list › To check).

## Deploying
Migrations 0020–0021 are applied by the planner's build when this is pushed to `main` (this app's deploy doesn't migrate).
1. Workers & Pages › Create application › Continue with GitHub › `knealbarker/netex-apps`. Project name `netex-supplies`,
   deploy command `npx wrangler deploy`, Advanced settings › Path `/workers/supplies`, preview builds off, "Protect with
   Cloudflare Access" off, API token "netex-sync build". The deploy creates `supplies.netexcleaners.com`.
2. Zero Trust › Access › Applications › Add › Self-hosted: name "Supply count (public)", destination
   `supplies.netexcleaners.com` path `/count`, policy **Tablets bypass** (the same Bypass as `prodplanner…/station`).
   Everything else stays behind "Netex apps"; the Worker checks the device cookie on /count itself.
3. Optional secret `CF_API_TOKEN` (same as the planner's) so Users & access keeps the "Netex users" Access group in step.
4. Give Karla a **Manager** role under Users & access, then Setup › Who can count, and pair one device per location.

## Tests
- `node workers/supplies/test/run.mjs` — rules, seeded list, sign-in/roles, pairing, approved names, counts → shuttle, Workshop → orders, edits.
- `node workers/supplies/test/browser.mjs` — the real pages in headless Chromium (store phone, manager desktop and phone, print); screenshots in `test/shots`.
