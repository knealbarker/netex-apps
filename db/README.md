# Database

One Cloudflare D1 database (`netex-apps`) for every app on netexcleaners.com.

- `migrations/0001_initial.sql` — draft schema (39 tables), awaiting review.
- Table name prefixes: `core_` (shared by every app), `int_` (integrations), `pos_` (copy of SMRT orders), `labor_` (Rippling time clock, pay rates), `plan_` (production planner).
- Diagram: https://claude.ai/artifact/Mrtv6nRqE1d43SSVQzxV3a

Status: draft. Not applied to the live database.

Revision 2 (Oct 10): keeps every SMRT order and piece for history (`pos_orders`, `pos_items`, status and department tables);
keeps only hours per person per day from Rippling (`labor_daily_hours`), with today's punches in `labor_clock_today`.
