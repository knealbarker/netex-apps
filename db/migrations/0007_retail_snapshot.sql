-- Retail Snapshot (retailview.netexcleaners.com): store and company sales, revenue, labor hours, labor cost.
--  - Rippling hours are now kept for every department (Retail, Laundry Hub, ...) and every work location, not just Production.
--    A person can work two stores in one day, so daily hours are keyed by person, day, department AND location.
--  - Today's punches remember their location too.
--  - Lookups by detailed date (sales) and paid date (revenue).
--  - The Retail Snapshot app, with Neal as Owner.
PRAGMA defer_foreign_keys = on;

CREATE TABLE labor_daily_hours_new (
  person_id      TEXT NOT NULL REFERENCES core_people(id),
  work_date      TEXT NOT NULL,
  department_id  TEXT NOT NULL REFERENCES core_departments(id),   -- Production, Retail, Laundry Hub ...
  location_id    TEXT NOT NULL REFERENCES core_locations(id),     -- Rippling work location: a store, the Workshop, the Laundry Hub
  hours          REAL NOT NULL,
  first_in       TEXT,
  last_out       TEXT,
  sync_run_id    TEXT REFERENCES int_sync_runs(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, work_date, department_id, location_id)
);
INSERT INTO labor_daily_hours_new(person_id, work_date, department_id, location_id, hours, first_in, last_out, sync_run_id, created_at, updated_at, updated_by, deleted_at, rev)
SELECT h.person_id, h.work_date, h.department_id,
       COALESCE(h.location_id, (SELECT l.id FROM core_locations l WHERE l.kind = 'plant' ORDER BY l.created_at LIMIT 1)),
       h.hours, h.first_in, h.last_out, h.sync_run_id, h.created_at, h.updated_at, h.updated_by, h.deleted_at, h.rev
  FROM labor_daily_hours h;
DROP TABLE labor_daily_hours;
ALTER TABLE labor_daily_hours_new RENAME TO labor_daily_hours;
CREATE INDEX ix_hours_date ON labor_daily_hours(work_date, department_id);
CREATE INDEX ix_hours_location ON labor_daily_hours(work_date, location_id);

ALTER TABLE labor_clock_today ADD COLUMN location_id TEXT REFERENCES core_locations(id);

CREATE INDEX ix_orders_detailed ON pos_orders(org_id, detailed_at);
CREATE INDEX ix_orders_paid ON pos_orders(org_id, paid_at);
CREATE INDEX ix_pay_rates_person ON labor_pay_rates(person_id, effective_on);

INSERT INTO core_apps(id, name, subdomain) VALUES ('retail', 'Retail Snapshot', 'retailview');
INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at)
SELECT id, 'retail', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM core_users WHERE lower(email) = 'neal@towncountryclean.com';
