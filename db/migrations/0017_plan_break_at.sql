-- A break time set for one person on one day (Neal, Oct 14: "keep Carnell on SLB until 9AM and take a break at 9AM").
-- HH:MM; null = the planner places the break.
ALTER TABLE plan_assignments ADD COLUMN break_at TEXT;
