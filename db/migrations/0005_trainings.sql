-- Training is per kind of work, not per machine: SLB 1 and SLB 2 are the same training, as are DCT 1, 2 and 3 (Neal, Oct 10).
-- Each person has ONE ordered list of trainings (1 = where they belong first), replacing the 1st/2nd/3rd rank per station.

CREATE TABLE plan_trainings (
  id     TEXT PRIMARY KEY,           -- 'slt1','slt2','slb','dct','dcb','iab1','iab2','slo','dco'
  name   TEXT NOT NULL,
  short  TEXT NOT NULL,              -- for chips and the floor screen
  sort   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO plan_trainings(id, name, short, sort) VALUES
  ('slt1', 'Starch tops press (SLT 1)',         'SLT 1', 1),
  ('slt2', 'Starch tops helper (SLT 2)',        'SLT 2', 2),
  ('slb',  'Starch bottoms press (SLB)',        'SLB',   3),
  ('dct',  'Dry cleaning tops press (DCT)',     'DCT',   4),
  ('dcb',  'Dry cleaning bottoms press (DCB)',  'DCB',   5),
  ('iab1', 'Assembly 1 (IAB 1)',                'IAB 1', 6),
  ('iab2', 'Assembly 2 (IAB 2)',                'IAB 2', 7),
  ('slo',  'Starch laundry operator',           'SL Op', 8),
  ('dco',  'Dry cleaning operator',             'DC Op', 9);

ALTER TABLE plan_stations ADD COLUMN training_id TEXT REFERENCES plan_trainings(id);
UPDATE plan_stations SET training_id = CASE code
  WHEN 'slt1' THEN 'slt1' WHEN 'slt2' THEN 'slt2' WHEN 'slb1' THEN 'slb' WHEN 'slb2' THEN 'slb'
  WHEN 'dct1' THEN 'dct' WHEN 'dct2' THEN 'dct' WHEN 'dct3' THEN 'dct' WHEN 'dcb1' THEN 'dcb'
  WHEN 'asm1' THEN 'iab1' WHEN 'asm2' THEN 'iab2' WHEN 'slo' THEN 'slo' WHEN 'dco' THEN 'dco' END;

CREATE TABLE plan_person_trainings (
  person_id    TEXT NOT NULL REFERENCES core_people(id),
  training_id  TEXT NOT NULL REFERENCES plan_trainings(id),
  priority     INTEGER NOT NULL CHECK (priority >= 1),   -- 1 = first choice; no ties
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, training_id),
  UNIQUE (person_id, priority)
);
CREATE INDEX ix_person_trainings_training ON plan_person_trainings(training_id);

-- Carry the old rankings over: best rank across a training's stations, then the station order breaks ties.
INSERT INTO plan_person_trainings(person_id, training_id, priority, updated_by)
SELECT person_id, training_id,
       ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY best_rank, tsort),
       updated_by
  FROM (SELECT k.person_id, s.training_id, MIN(k.rank) AS best_rank, t.sort AS tsort, MAX(k.updated_by) AS updated_by
          FROM plan_skills k JOIN plan_stations s ON s.id = k.station_id JOIN plan_trainings t ON t.id = s.training_id
         WHERE k.deleted_at IS NULL
         GROUP BY k.person_id, s.training_id);

DROP INDEX IF EXISTS ix_skills_station;
DROP TABLE plan_skills;
