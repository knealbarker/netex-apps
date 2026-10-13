-- Plan redesign (Neal, Oct 13): a person's standing schedule lives on the Team screen, one-day changes on the Plan.
--  - usual_hours: hours in a normal day (null = the Settings full day)
--  - usual_days: weekdays they usually work, as digits 0-6 (Sunday = 0), e.g. '12345'; null = not set
--  - leave_by / leave_note: a standing "must leave by" time (e.g. school pickup) and why; the plan treats it as a hard stop
-- Moves: a manager can move someone to another station partway through the day. moves_json on the assignment is a
-- list of {"at":"HH:MM","to":"<station code>"} in time order; the person starts on the assignment's station.
ALTER TABLE plan_person_prefs ADD COLUMN usual_hours REAL;
ALTER TABLE plan_person_prefs ADD COLUMN usual_days TEXT;
ALTER TABLE plan_person_prefs ADD COLUMN leave_by TEXT;
ALTER TABLE plan_person_prefs ADD COLUMN leave_note TEXT;
ALTER TABLE plan_assignments ADD COLUMN moves_json TEXT;
