-- People whose hours are shown but left out of labor $ / labor % / pieces per hour (Neal, Oct 30):
-- Kerry Mann, Team Lead, clocks in under Production but isn't production labor.
-- Planner (Review, trend, Plan) and Retail Snapshot still list their punches and hours, marked "not in labor %".
ALTER TABLE core_people ADD COLUMN no_labor INTEGER NOT NULL DEFAULT 0;

UPDATE core_people SET no_labor = 1 WHERE first_name = 'Kerry' AND last_name = 'Mann' AND deleted_at IS NULL;
