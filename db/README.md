# Database

One Cloudflare D1 database (`netex-apps`) for every app on netexcleaners.com.

- `migrations/0001_initial.sql` — draft schema (43 tables), awaiting review.
- Table name prefixes: `core_` (shared by every app), `int_` (integrations), `pos_` (copy of SMRT orders), `labor_` (Rippling time clock, pay rates), `plan_` (production planner), `supply_` (supplies: counts, shuttle lists, vendor orders).
- Diagram: https://claude.ai/artifact/Mrtv6nRqE1d43SSVQzxV3a

Status: approved by Neal Oct 10, 2026.

Revision 2 (Oct 10): keeps every SMRT order and piece for history (`pos_orders`, `pos_items`, status and department tables);
keeps only hours per person per day from Rippling (`labor_daily_hours`), with today's punches in `labor_clock_today`.

Revision 3 (Oct 10): order and item notes, barcode matching, staff names (`pos_staff`), a log of every SMRT change
(`pos_changes`: due date moved, note added/edited, piece moved, status) and follow-ups (`plan_followups`) that ask the
production manager for a reason and note when a due date moves, a piece moves, or an order goes overdue without one.
