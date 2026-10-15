-- Paid break (Neal, Oct 15): Production and Laundry Hub get one paid break a day, up to 30 minutes, unpaid if back after
-- more than 35. labor_daily_hours.hours now includes the paid break (paid hours); this column says how much of it was break.
ALTER TABLE labor_daily_hours ADD COLUMN break_paid_hours REAL NOT NULL DEFAULT 0;
