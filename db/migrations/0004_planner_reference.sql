-- Reference data the planner needs: the workshop, its stations, piece categories, station types, default speeds.
-- Values match the desktop planner 1.9.0 defaults; the one-time import from the desktop app then overwrites
-- speeds, wash programs and settings with the numbers Neal actually uses.

INSERT INTO core_locations(id, org_id, name, kind, pos_name) VALUES
  ('01M4HN5VM04Y2MJNQBKXGN9ZG1', 'tcc', 'Workshop', 'plant', NULL);
INSERT INTO core_departments(id, org_id, name, payroll_name) VALUES
  ('01M4HN5VM14R161M7GQKHXBY48', 'tcc', 'Production', 'Production');

INSERT INTO plan_categories(id, name, color, needs_assembly, sort) VALUES
  ('dct',  'Dry Cleaning Tops',      '#4f8ff7', 1, 1),
  ('dcb',  'Dry Cleaning Bottoms',   '#7c6cf2', 1, 2),
  ('slt',  'Starch Laundry Tops',    '#3ddc97', 1, 3),
  ('slb',  'Starch Laundry Bottoms', '#22b8cf', 1, 4),
  ('comf', 'Comforters',             '#f5b84b', 1, 5),
  ('tc',   'Tablecloths',            '#ff8a5c', 1, 6);

INSERT INTO plan_station_types(id, name) VALUES
  ('slt', 'Starch tops press'), ('slt_helper', 'Starch tops helper'), ('slb', 'Starch bottoms press'),
  ('dct', 'Dry cleaning tops press'), ('dcb', 'Dry cleaning bottoms press'), ('asm', 'Assembly (IAB)'),
  ('ops', 'Machine operator'), ('comf', 'Comforters (anyone free)');

-- pieces per hour. slt_helper is the TOTAL for the starch-tops pair (press + helper), as the desktop app asks for it.
INSERT INTO plan_station_rates(station_type_id, category_id, pieces_per_hour) VALUES
  ('slt', 'slt', 50), ('slt_helper', 'slt', 80), ('slb', 'slb', 38), ('dct', 'dct', 25), ('dcb', 'dcb', 25), ('dcb', 'tc', 6),
  ('asm', 'dct', 100), ('asm', 'dcb', 100), ('asm', 'slt', 100), ('asm', 'slb', 100), ('asm', 'comf', 100), ('asm', 'tc', 100),
  ('comf', 'comf', 3);

INSERT INTO plan_wash_programs(category_id, pieces_per_load, cycle_min) VALUES
  ('slt', 65, 45), ('slb', 25, 45), ('comf', 2, 60), ('tc', 10, 40);

INSERT INTO plan_stations(id, location_id, station_type_id, code, label, sort) VALUES
  ('st-slt1', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'slt',        'slt1', 'SLT 1',          1),
  ('st-slt2', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'slt_helper', 'slt2', 'SLT 2 (helper)', 2),
  ('st-slb1', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'slb',        'slb1', 'SLB 1',          3),
  ('st-slb2', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'slb',        'slb2', 'SLB 2',          4),
  ('st-dct1', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'dct',        'dct1', 'DCT 1',          5),
  ('st-dct2', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'dct',        'dct2', 'DCT 2',          6),
  ('st-dct3', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'dct',        'dct3', 'DCT 3',          7),
  ('st-dcb1', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'dcb',        'dcb1', 'DCB',            8),
  ('st-asm1', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'asm',        'asm1', 'IAB 1',          9),
  ('st-asm2', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'asm',        'asm2', 'IAB 2',          10),
  ('st-slo',  '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'ops',        'slo',  'Starch Laundry Operator', 11),
  ('st-dco',  '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'ops',        'dco',  'Dry Cleaning Operator',   12);

-- Planner-only facts about a person (the person row itself is shared by every app).
CREATE TABLE plan_person_prefs (
  person_id    TEXT PRIMARY KEY REFERENCES core_people(id),
  usual_start  TEXT,               -- 'HH:MM' usual clock-in; filled in when they're assigned
  note         TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_skills_station ON plan_skills(station_id);
