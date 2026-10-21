-- Press start times for the station tablets (Neal, Oct 21).
-- Pace is now the station's alone: all pairs entered today ÷ hours from the press's start to the last entry. No credit per
-- person, no breaks (the manager keeps the press staffed all day).
--  - The start is the first person planned on that press, at their planned clock-in + a delay from Settings (10 min).
--  - Someone at the tablet can set the start by hand; a front-camera photo of whoever made the change is kept with it.
--  - Every change is a row; the newest row for the day and station wins. minute NULL = "back to the plan".
CREATE TABLE plan_station_starts (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES core_organizations(id),
  day           TEXT NOT NULL,                 -- work day, YYYY-MM-DD (Central time)
  station_code  TEXT NOT NULL,
  minute        INTEGER,                       -- minute of the local day the press started (null: use the plan)
  at            TEXT NOT NULL,                 -- when the change was made (UTC)
  device_id     TEXT REFERENCES plan_station_devices(id),
  user_id       TEXT REFERENCES core_users(id),
  jpeg          BLOB,                          -- photo of the person making the change (cleared with the count photos)
  deleted_at    TEXT
);
CREATE INDEX ix_station_starts_day ON plan_station_starts(org_id, day, station_code, at);
