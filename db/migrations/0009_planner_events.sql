-- Production Planner, stage 5: things that happen during the day, for the "Changes today" list and the daily summary.
--  - Shuttle alerts (a deadline became ready, a warning before a shuttle leaves with work unfinished). Any PC with the planner
--    open notices them; the (day, key) pair keeps one row per event however many PCs report it.
--  - The daily summary email (sent / failed).
CREATE TABLE plan_events (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES core_organizations(id),
  day       TEXT NOT NULL,              -- the work day, YYYY-MM-DD (Central time)
  key       TEXT NOT NULL,              -- e.g. ready:<run id>, warn45:<run id>, summary
  kind      TEXT NOT NULL CHECK (kind IN ('ready','warn','summary','note')),
  text      TEXT NOT NULL,
  at        TEXT NOT NULL,
  user_id   TEXT REFERENCES core_users(id),
  UNIQUE (org_id, day, key)
);
CREATE INDEX ix_plan_events_day ON plan_events(org_id, day, at);
