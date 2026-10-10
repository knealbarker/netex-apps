-- Netex apps database (Cloudflare D1 / SQLite)
-- One database for every app on netexcleaners.com. Tables are grouped by a name prefix:
--   core_   shared by every app: company, locations, people, users, roles, devices, settings, audit log
--   int_    connections to outside systems (SMRT, Rippling, Gmail) and their sync history
--   pos_    orders copied from SMRT (read-only copy; SMRT stays the source of truth)
--   labor_  time clock punches from Rippling and pay rates
--   plan_   the production planner
-- Conventions
--   ids are text (ULIDs) so a PC working offline can create rows without clashing; small lookup tables use readable ids ('dct', 'owner').
--   times are ISO-8601 text in UTC; work dates are 'YYYY-MM-DD'; times of day are 'HH:MM' in the company's time zone; money is integer cents.
--   Most tables end with: created_at, updated_at, updated_by (user), deleted_at (soft delete), rev (sync counter).
--   No totals are stored that can be calculated from other rows, except plan_publications.snapshot_json (a frozen record of what was published).

PRAGMA foreign_keys = ON;

-- =========================== core ===========================

CREATE TABLE core_organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  legal_name  TEXT,
  timezone    TEXT NOT NULL DEFAULT 'America/Chicago',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE core_locations (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES core_organizations(id),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('plant','store','route')),
  pos_name   TEXT,                 -- how SMRT names it, e.g. 'TCC Quitman'
  address    TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, name)
);

CREATE TABLE core_departments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES core_organizations(id),
  name          TEXT NOT NULL,
  payroll_name  TEXT,              -- department name in Rippling, e.g. 'Production'
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, name)
);

CREATE TABLE core_people (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES core_organizations(id),
  department_id     TEXT REFERENCES core_departments(id),
  home_location_id  TEXT REFERENCES core_locations(id),
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  display_name      TEXT,
  payroll_id        TEXT,          -- Rippling employee id
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  hired_on          TEXT,
  left_on           TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, payroll_id)
);

CREATE TABLE core_users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES core_organizations(id),
  person_id     TEXT UNIQUE REFERENCES core_people(id),
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  pin_hash      TEXT,              -- quick switch on shared shop PCs; never the PIN itself
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_seen_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, email)
);

CREATE TABLE core_apps (
  id         TEXT PRIMARY KEY,     -- 'core', 'planner', ...
  name       TEXT NOT NULL,
  subdomain  TEXT UNIQUE,          -- 'planner' -> planner.netexcleaners.com
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE core_roles (
  id    TEXT PRIMARY KEY,          -- 'owner','admin','manager','viewer'
  name  TEXT NOT NULL,
  rank  INTEGER NOT NULL UNIQUE    -- higher can do more
);

CREATE TABLE core_user_app_roles (
  user_id     TEXT NOT NULL REFERENCES core_users(id),
  app_id      TEXT NOT NULL REFERENCES core_apps(id),
  role_id     TEXT NOT NULL REFERENCES core_roles(id),
  granted_by  TEXT REFERENCES core_users(id),
  granted_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, app_id)
);

CREATE TABLE core_devices (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES core_organizations(id),
  location_id         TEXT REFERENCES core_locations(id),
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('office_pc','shop_pc','tv')),
  service_token_name  TEXT,        -- the Cloudflare Access service token this PC signs in with
  last_seen_at        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE core_settings (
  org_id      TEXT NOT NULL REFERENCES core_organizations(id),
  app_id      TEXT NOT NULL REFERENCES core_apps(id),
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, app_id, key)
);

CREATE TABLE core_audit_log (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES core_organizations(id),
  at             TEXT NOT NULL,
  user_id        TEXT REFERENCES core_users(id),
  device_id      TEXT REFERENCES core_devices(id),
  app_id         TEXT REFERENCES core_apps(id),
  entity         TEXT NOT NULL,    -- table name
  entity_id      TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('create','update','delete','publish','sign_in')),
  changes_json   TEXT
);

-- ======================== integrations ========================

CREATE TABLE int_integrations (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES core_organizations(id),
  kind         TEXT NOT NULL CHECK (kind IN ('smrt','rippling','gmail')),
  name         TEXT NOT NULL,
  config_json  TEXT,               -- report names, intervals; never passwords or keys
  is_enabled   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, kind, name)
);

CREATE TABLE int_sync_runs (
  id              TEXT PRIMARY KEY,
  integration_id  TEXT NOT NULL REFERENCES int_integrations(id),
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  rows_read       INTEGER,
  rows_changed    INTEGER,
  message         TEXT
);

-- ===================== orders (copy of SMRT) =====================

CREATE TABLE pos_departments (
  id      TEXT PRIMARY KEY,
  org_id  TEXT NOT NULL REFERENCES core_organizations(id),
  name    TEXT NOT NULL,           -- 'Dry Cleaning Tops', 'Laundry Bottoms', ...
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, name)
);

CREATE TABLE pos_item_types (
  id             TEXT PRIMARY KEY,
  department_id  TEXT NOT NULL REFERENCES pos_departments(id),
  name           TEXT NOT NULL,    -- 'Shirt L', 'Comforter', 'Tablecloth', ...
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (department_id, name)
);

CREATE TABLE pos_orders (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES core_organizations(id),
  pos_order_no      TEXT NOT NULL,  -- SMRT order number
  location_id       TEXT REFERENCES core_locations(id),   -- return location (decides the shuttle)
  drop_location_id  TEXT REFERENCES core_locations(id),
  customer_ref      TEXT,           -- SMRT customer id only; names and phone numbers stay in SMRT
  due_at            TEXT NOT NULL,
  is_rush           INTEGER NOT NULL DEFAULT 0,
  status            TEXT,
  last_sync_run_id  TEXT REFERENCES int_sync_runs(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, pos_order_no)
);

CREATE TABLE pos_order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES pos_orders(id),
  item_type_id  TEXT NOT NULL REFERENCES pos_item_types(id),
  pieces        INTEGER NOT NULL,
  pieces_ready  INTEGER NOT NULL DEFAULT 0,
  ready_at      TEXT,               -- when the last piece was assembled (done-ahead vs done-today comes from this)
  price_cents   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

-- ===================== labor (time clock + pay) =====================

CREATE TABLE labor_punches (
  id                TEXT PRIMARY KEY,
  person_id         TEXT NOT NULL REFERENCES core_people(id),
  location_id       TEXT REFERENCES core_locations(id),
  clock_in          TEXT NOT NULL,
  clock_out         TEXT,
  payroll_entry_id  TEXT UNIQUE,    -- Rippling's id for the entry, so re-imports don't duplicate
  sync_run_id       TEXT REFERENCES int_sync_runs(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE labor_pay_rates (
  id            TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES core_people(id),
  effective_on  TEXT NOT NULL,
  hourly_cents  INTEGER NOT NULL,   -- Owner only
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, effective_on)
);

-- ===================== production planner =====================

CREATE TABLE plan_categories (
  id              TEXT PRIMARY KEY, -- 'dct','dcb','slt','slb','comf','tc'
  name            TEXT NOT NULL,
  color           TEXT,
  needs_assembly  INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE plan_item_categories (
  item_type_id  TEXT PRIMARY KEY REFERENCES pos_item_types(id),
  category_id   TEXT NOT NULL REFERENCES plan_categories(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE plan_station_types (
  id    TEXT PRIMARY KEY,           -- 'slt','slt_helper','slb','dct','dcb','assembly','operator'
  name  TEXT NOT NULL
);

CREATE TABLE plan_station_rates (
  station_type_id  TEXT NOT NULL REFERENCES plan_station_types(id),
  category_id      TEXT NOT NULL REFERENCES plan_categories(id),
  pieces_per_hour  REAL NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (station_type_id, category_id)
);

CREATE TABLE plan_wash_programs (
  category_id      TEXT PRIMARY KEY REFERENCES plan_categories(id),
  pieces_per_load  INTEGER NOT NULL,
  cycle_min        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE plan_stations (
  id               TEXT PRIMARY KEY,
  location_id      TEXT NOT NULL REFERENCES core_locations(id),
  station_type_id  TEXT NOT NULL REFERENCES plan_station_types(id),
  code             TEXT NOT NULL,   -- 'slt1', 'dct3', ...
  label            TEXT NOT NULL,
  max_hours        REAL,
  sort             INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (location_id, code)
);

CREATE TABLE plan_skills (
  person_id   TEXT NOT NULL REFERENCES core_people(id),
  station_id  TEXT NOT NULL REFERENCES plan_stations(id),
  rank        INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),   -- 1st, 2nd, 3rd choice
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, station_id)
);

CREATE TABLE plan_runs (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES core_organizations(id),
  name            TEXT NOT NULL,    -- 'Winnsboro + Quitman', 'Sulphur Springs counter'
  kind            TEXT NOT NULL CHECK (kind IN ('shuttle','counter')),
  drive_back_min  INTEGER,
  sort            INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE plan_run_stops (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES plan_runs(id),
  location_id     TEXT NOT NULL REFERENCES core_locations(id),
  seq             INTEGER NOT NULL,
  arrive_at       TEXT NOT NULL,    -- shuttle time at the store (counter: ready-by time)
  drive_min       INTEGER NOT NULL DEFAULT 0,   -- from the workshop or the previous stop
  stop_min        INTEGER NOT NULL DEFAULT 15,
  dropoff_cutoff  TEXT,             -- items in by this time are due the next day
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, seq),
  UNIQUE (run_id, location_id)
);

CREATE TABLE plan_days (
  id           TEXT PRIMARY KEY,
  location_id  TEXT NOT NULL REFERENCES core_locations(id),
  work_date    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (location_id, work_date)
);

CREATE TABLE plan_count_overrides (
  day_id       TEXT NOT NULL REFERENCES plan_days(id),
  category_id  TEXT NOT NULL REFERENCES plan_categories(id),
  pieces       INTEGER NOT NULL,    -- typed over SMRT's number for that day
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_id, category_id)
);

CREATE TABLE plan_assignments (
  id          TEXT PRIMARY KEY,
  day_id      TEXT NOT NULL REFERENCES plan_days(id),
  station_id  TEXT NOT NULL REFERENCES plan_stations(id),
  person_id   TEXT REFERENCES core_people(id),
  starts_at   TEXT NOT NULL,
  hours       REAL NOT NULL,
  hard_stop   TEXT,
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('suggested','user','clock')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (day_id, station_id)
);

CREATE TABLE plan_callouts (
  id          TEXT PRIMARY KEY,
  day_id      TEXT NOT NULL REFERENCES plan_days(id),
  person_id   TEXT NOT NULL REFERENCES core_people(id),
  station_id  TEXT REFERENCES plan_stations(id),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE plan_publications (
  id             TEXT PRIMARY KEY,
  day_id         TEXT NOT NULL REFERENCES plan_days(id),
  published_by   TEXT NOT NULL REFERENCES core_users(id),
  published_at   TEXT NOT NULL,
  snapshot_json  TEXT NOT NULL      -- the plan and its numbers exactly as published
);

CREATE TABLE plan_run_events (
  id           TEXT PRIMARY KEY,
  day_id       TEXT NOT NULL REFERENCES plan_days(id),
  run_id       TEXT NOT NULL REFERENCES plan_runs(id),
  kind         TEXT NOT NULL CHECK (kind IN ('ready','warn_45','warn_15','late')),
  at           TEXT NOT NULL,
  pieces_left  INTEGER NOT NULL DEFAULT 0
);

-- ============================ indexes ============================
CREATE INDEX ix_people_org          ON core_people(org_id, status);
CREATE INDEX ix_audit_org_at        ON core_audit_log(org_id, at);
CREATE INDEX ix_audit_entity        ON core_audit_log(entity, entity_id);
CREATE INDEX ix_sync_runs_int       ON int_sync_runs(integration_id, started_at);
CREATE INDEX ix_orders_due          ON pos_orders(org_id, due_at);
CREATE INDEX ix_orders_location     ON pos_orders(location_id, due_at);
CREATE INDEX ix_order_items_order   ON pos_order_items(order_id);
CREATE INDEX ix_order_items_ready   ON pos_order_items(ready_at);
CREATE INDEX ix_punches_person      ON labor_punches(person_id, clock_in);
CREATE INDEX ix_assignments_day     ON plan_assignments(day_id);
CREATE INDEX ix_assignments_person  ON plan_assignments(person_id);
CREATE INDEX ix_callouts_day        ON plan_callouts(day_id);
CREATE INDEX ix_run_events_day      ON plan_run_events(day_id, run_id);
CREATE INDEX ix_run_stops_location  ON plan_run_stops(location_id);
