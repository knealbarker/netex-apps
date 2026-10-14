-- Station tablets (Neal, Oct 14): a tablet at each starch bottoms press (SLB 1, SLB 2). The manager enters how many pairs
-- were pressed each time they're taken to IAB, so the press's pace shows long before SMRT's assembly scans catch up.
--  - Counts are credited to whoever the plan has on that station at the moment of the entry; Review checks the day's
--    total against SMRT's starch bottoms assembled.
--  - Each person can have their own SLB goal (pairs per hour); without one they get the station goal from Settings.
--  - Tablets have no user account: an Admin pairs each one once with a 6-digit code from Settings, and the tablet then
--    keeps a long-lived secret (only its SHA-256 hash is stored here). Removing the tablet in Settings cuts it off.
--  - A small front-camera photo can be taken with each count (kept 30 days by default; Admins see them in Review).
ALTER TABLE plan_person_prefs ADD COLUMN slb_rate REAL;          -- pairs per hour expected of this person on an SLB press

CREATE TABLE plan_station_devices (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES core_organizations(id),
  station_code     TEXT NOT NULL,              -- 'slb1', 'slb2'
  name             TEXT NOT NULL,
  token_hash       TEXT UNIQUE,                -- SHA-256 of the tablet's secret; null until paired
  pair_code_hash   TEXT,                       -- SHA-256 of the pending 6-digit pairing code
  pair_expires_at  TEXT,
  pair_failures    INTEGER NOT NULL DEFAULT 0,
  paired_at        TEXT,
  last_seen_at     TEXT,
  created_by       TEXT REFERENCES core_users(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at       TEXT
);

CREATE TABLE plan_station_tally (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES core_organizations(id),
  day           TEXT NOT NULL,                 -- work day, YYYY-MM-DD (Central time)
  station_code  TEXT NOT NULL,
  person_id     TEXT REFERENCES core_people(id),   -- who the plan had on the station then (null: nobody)
  count         INTEGER NOT NULL CHECK (count > 0 AND count <= 999),
  at            TEXT NOT NULL,                 -- when it was entered (UTC)
  minute        INTEGER NOT NULL,              -- minute of the local day it counts at (0-1439)
  source        TEXT NOT NULL CHECK (source IN ('tablet','button','manager')),
  device_id     TEXT REFERENCES plan_station_devices(id),
  user_id       TEXT REFERENCES core_users(id),   -- for counts a manager added or corrected in Review
  has_photo     INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  deleted_at    TEXT,
  deleted_by    TEXT                           -- user id, or 'device:<id>' for the tablet's own undo
);
CREATE INDEX ix_tally_day ON plan_station_tally(org_id, day, station_code, minute);

CREATE TABLE plan_station_photos (
  tally_id   TEXT PRIMARY KEY REFERENCES plan_station_tally(id),
  org_id     TEXT NOT NULL REFERENCES core_organizations(id),
  day        TEXT NOT NULL,
  jpeg       BLOB NOT NULL,
  taken_at   TEXT NOT NULL
);
CREATE INDEX ix_tally_photos_day ON plan_station_photos(org_id, day);
