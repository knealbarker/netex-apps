-- Time clock record (Neal, Oct 13): every Rippling report replaces today's punches (labor_clock_today), so a punch that
-- shows up and is later deleted or edited in Rippling used to leave no trace. netex-sync now compares each report with
-- the one before and keeps what changed here: a new clock-in, a clock-out, a punch whose times were edited, a punch that
-- disappeared. seen_at is when the report reached us (Rippling sends one every 10 minutes), not the punch time.
-- The planner shows edits and removals of Production punches in "Changes today".
CREATE TABLE labor_punch_log (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES core_organizations(id),
  person_id         TEXT NOT NULL REFERENCES core_people(id),
  day               TEXT NOT NULL,             -- work day of the punch, YYYY-MM-DD (Central time)
  department_id     TEXT REFERENCES core_departments(id),
  payroll_entry_id  TEXT,                      -- Rippling's time_entry_id
  change            TEXT NOT NULL CHECK (change IN ('in','out','changed','removed')),
  clock_in          TEXT,                      -- the punch as it is now (for 'removed': as it was)
  clock_out         TEXT,
  was_in            TEXT,                      -- for 'changed': the times before the edit
  was_out           TEXT,
  seen_at           TEXT NOT NULL,
  sync_run_id       TEXT REFERENCES int_sync_runs(id)
);
CREATE INDEX ix_punch_log_day ON labor_punch_log(org_id, day, seen_at);
CREATE INDEX ix_punch_log_person ON labor_punch_log(person_id, day);
