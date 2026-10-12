-- Time off and late arrivals, set on the Team screen (Neal, Oct 12): "out" for a day or a range of days,
-- or "late" = in at a given time on one day. The Plan reads them: people who are out can't be planned that day,
-- people coming in late don't start before their time. Replaces the per-plan call-outs (plan_callouts stays for history).
CREATE TABLE plan_time_off (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES core_organizations(id),
  person_id   TEXT NOT NULL REFERENCES core_people(id),
  kind        TEXT NOT NULL CHECK (kind IN ('out','late')),
  from_day    TEXT NOT NULL,             -- YYYY-MM-DD
  to_day      TEXT NOT NULL,             -- inclusive; same as from_day for one day (always for 'late')
  at          TEXT,                      -- 'HH:MM' arrival time for 'late'
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by  TEXT REFERENCES core_users(id),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  CHECK (to_day >= from_day),
  CHECK (kind = 'out' OR at IS NOT NULL)
);
CREATE INDEX ix_time_off_days ON plan_time_off(org_id, to_day, from_day);
CREATE INDEX ix_time_off_person ON plan_time_off(person_id);
