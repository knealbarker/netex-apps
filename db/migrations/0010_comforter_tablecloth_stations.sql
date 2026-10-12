-- Comforters and Tablecloths become real stations with their own trainings (Neal, Oct 12).
-- Before: comforters were done by "anyone free" and tablecloths by whoever was on the DCB press.
-- Now: only people trained on Comforters / Tablecloths are planned on them (assigned there, or moving there when their
-- own station runs out of work). The engine keeps the old behaviour if either station is switched off in Settings.

UPDATE plan_station_types SET name = 'Comforters' WHERE id = 'comf';
INSERT OR IGNORE INTO plan_station_types(id, name) VALUES ('tc', 'Tablecloths');

INSERT OR IGNORE INTO plan_trainings(id, name, short, sort) VALUES
  ('comf', 'Comforters', 'Comf', 10),
  ('tc',   'Tablecloths', 'TC', 11);

-- Tablecloths keep the speed they had on the DCB press.
INSERT OR IGNORE INTO plan_station_rates(station_type_id, category_id, pieces_per_hour)
  SELECT 'tc', 'tc', pieces_per_hour FROM plan_station_rates WHERE station_type_id = 'dcb' AND category_id = 'tc' AND deleted_at IS NULL;
INSERT OR IGNORE INTO plan_station_rates(station_type_id, category_id, pieces_per_hour) VALUES ('tc', 'tc', 6);

-- After DCB, before assembly.
UPDATE plan_stations SET sort = sort + 2 WHERE location_id = '01M4HN5VM04Y2MJNQBKXGN9ZG1' AND sort >= 9;
INSERT OR IGNORE INTO plan_stations(id, location_id, station_type_id, code, label, sort, training_id) VALUES
  ('st-comf', '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'comf', 'comf', 'Comforters', 9, 'comf'),
  ('st-tc',   '01M4HN5VM04Y2MJNQBKXGN9ZG1', 'tc',   'tc',   'Tablecloths', 10, 'tc');

-- Starting point: whoever is trained on the DCB press (they did tablecloths until now) gets Tablecloths as their last training.
-- Nobody gets Comforters automatically; Neal ticks who can do them on the Team screen.
INSERT OR IGNORE INTO plan_person_trainings(person_id, training_id, priority)
  SELECT pt.person_id, 'tc', (SELECT MAX(x.priority) FROM plan_person_trainings x WHERE x.person_id = pt.person_id) + 1
    FROM plan_person_trainings pt WHERE pt.training_id = 'dcb' AND pt.deleted_at IS NULL;
