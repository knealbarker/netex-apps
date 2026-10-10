# Database

One Cloudflare D1 database (`netex-apps`) for every app on netexcleaners.com.

- `migrations/0001_initial.sql` — first draft of the schema (34 tables), awaiting review.
- Table name prefixes: `core_` (shared by every app), `int_` (integrations), `pos_` (copy of SMRT orders), `labor_` (Rippling time clock, pay rates), `plan_` (production planner).
- Diagram: https://claude.ai/artifact/Mrtv6nRqE1d43SSVQzxV3a

Status: draft. Not applied to the live database.
