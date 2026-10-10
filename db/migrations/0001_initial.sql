-- Netex apps database (Cloudflare D1 / SQLite)
-- One database for every app on netexcleaners.com. Tables are grouped by a name prefix:
--   core_   shared by every app: company, locations, people, users, roles, devices, settings, audit log
--   int_    connections to outside systems (SMRT, Rippling, Gmail) and their sync history
--   pos_    every order and piece from SMRT, kept as history (SMRT stays the source of truth for open orders)
--   labor_  hours per person per day from Rippling, and pay rates
--   plan_   the production planner
-- Conventions
--   ids are text (ULIDs) so a PC working offline can create rows without clashing; small lookup tables use readable ids ('dct', 'owner').
--   times are ISO-8601 text in UTC; work dates are 'YYYY-MM-DD'; times of day are 'HH:MM' in the company's time zone; money is integer cents.
--   Most tables end with: created_at, updated_at, updated_by (user), deleted_at (soft delete), rev (sync counter).
--   No totals are stored that can be calculated from other rows, except plan_publications.snapshot_json (a frozen record of what was published)
--   and labor_daily_hours (Rippling's punches are not kept after the day is added up).

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

-- History loaded a little at a time: one row per SMRT created-day, newest first, a few days per night.
CREATE TABLE int_backfill_days (
  integration_id  TEXT NOT NULL REFERENCES int_integrations(id),
  day             TEXT NOT NULL,        -- the created date in SMRT ('YYYY-MM-DD')
  status          TEXT NOT NULL CHECK (status IN ('done','empty','error')),
  orders          INTEGER NOT NULL DEFAULT 0,
  items           INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 1,
  last_error      TEXT,
  loaded_at       TEXT NOT NULL,
  sync_run_id     TEXT REFERENCES int_sync_runs(id),
  PRIMARY KEY (integration_id, day)
);

-- ===================== orders (full copy of SMRT) =====================
-- Every order and every piece SMRT reports is kept for good. Each sync asks SMRT only for recently created orders and for
-- the created days that still have open orders; a closed order (picked up, delivered, deleted) is never read again.
-- Columns the planner doesn't use yet are kept in extra_json, so nothing SMRT sends is lost.

CREATE TABLE pos_order_statuses (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES core_organizations(id),
  name        TEXT NOT NULL,       -- as SMRT spells it: 'processing', 'ready', 'pickedUp', ...
  is_done     INTEGER NOT NULL DEFAULT 0,   -- finished for production
  is_closed   INTEGER NOT NULL DEFAULT 0,   -- nothing more will change; stop re-reading
  is_void     INTEGER NOT NULL DEFAULT 0,   -- deleted / disabled: left out of counts
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, name)
);

CREATE TABLE pos_item_statuses (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES core_organizations(id),
  name          TEXT NOT NULL,     -- 'detailed', 'assembled', 'racked', ...
  is_assembled  INTEGER NOT NULL DEFAULT 0,   -- counts as complete for production
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, name)
);

CREATE TABLE pos_departments (
  id      TEXT PRIMARY KEY,
  org_id  TEXT NOT NULL REFERENCES core_organizations(id),
  name    TEXT NOT NULL,           -- financial department: 'Dry Cleaning Tops', 'Laundry Bottoms', ...
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, name)
);

CREATE TABLE pos_item_types (
  id      TEXT PRIMARY KEY,
  org_id  TEXT NOT NULL REFERENCES core_organizations(id),
  name    TEXT NOT NULL,           -- 'Shirt L', 'Comforter', 'Tablecloth', ...
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, name)
);

CREATE TABLE pos_staff (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES core_organizations(id),
  smrt_name  TEXT NOT NULL,        -- as SMRT shows it in 'Created by', 'Assembled by' ...: 'Sheri L'
  person_id  TEXT REFERENCES core_people(id),   -- matched to the employee list (blank until matched)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, smrt_name)
);

CREATE TABLE pos_orders (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES core_organizations(id),
  smrt_order_no       TEXT NOT NULL,  -- SMRT's order id, e.g. 262813231
  status_id           TEXT NOT NULL REFERENCES pos_order_statuses(id),
  order_type          TEXT,           -- 'Dry Cleaning', 'Wash & Fold', ...
  customer_ref        TEXT,           -- SMRT customer id (names and phones aren't in the reports)
  return_location_id  TEXT REFERENCES core_locations(id),  -- where it goes back to (decides the shuttle)
  drop_location_id    TEXT REFERENCES core_locations(id),  -- where it was dropped off (SMRT 'Agent')
  is_route_delivery   INTEGER NOT NULL DEFAULT 0,
  is_route_pickup     INTEGER NOT NULL DEFAULT 0,
  piece_count         INTEGER,
  original_piece_count INTEGER,
  weight_in_lbs       REAL,           -- wash & fold
  weight_out_lbs      REAL,
  notes               TEXT,           -- SMRT 'Order Notes'; every change is kept in pos_changes
  before_discount_cents INTEGER,
  discount_cents      INTEGER,
  surcharge_cents     INTEGER,
  taxable_cents       INTEGER,
  tax_cents           INTEGER,
  price_cents         INTEGER,
  paid_cents          INTEGER,
  payment_setting     TEXT,           -- 'AutoPay', ...
  promotion           TEXT,
  created_by_staff_id  TEXT REFERENCES pos_staff(id),
  detailed_by_staff_id TEXT REFERENCES pos_staff(id),
  smrt_created_at     TEXT NOT NULL,  -- when the order was written up in SMRT
  detailed_at         TEXT,
  due_at              TEXT,           -- current due time; earlier ones are in pos_changes
  assembled_at        TEXT,
  ready_at            TEXT,
  returned_at         TEXT,
  picked_up_at        TEXT,
  delivered_at        TEXT,
  paid_at             TEXT,
  smrt_deleted_at     TEXT,
  extra_json          TEXT,           -- every other column SMRT sent
  row_hash            TEXT NOT NULL,  -- fingerprint of SMRT's row; unchanged rows aren't rewritten
  first_sync_id       TEXT REFERENCES int_sync_runs(id),
  last_sync_id        TEXT REFERENCES int_sync_runs(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, smrt_order_no)
);

CREATE TABLE pos_order_departments (
  order_id       TEXT NOT NULL REFERENCES pos_orders(id),
  department_id  TEXT NOT NULL REFERENCES pos_departments(id),
  PRIMARY KEY (order_id, department_id)
);

CREATE TABLE pos_items (
  id                    TEXT PRIMARY KEY,
  order_id              TEXT NOT NULL REFERENCES pos_orders(id),   -- changes if SMRT moves the piece to another order
  barcode               TEXT,         -- SMRT's tag barcode; how a piece is matched on every sync
  line_no               INTEGER NOT NULL,
  item_type_id          TEXT NOT NULL REFERENCES pos_item_types(id),
  department_id         TEXT NOT NULL REFERENCES pos_departments(id),
  status_id             TEXT REFERENCES pos_item_statuses(id),
  lot_status            TEXT,         -- laundry lot: 'Washing', 'Completed'
  category              TEXT,         -- SMRT 'Category'
  classification        TEXT,
  description           TEXT,
  notes                 TEXT,         -- SMRT 'Item Notes'; every change is kept in pos_changes
  special_cares         TEXT,
  brand                 TEXT,
  colors                TEXT,
  fabrics               TEXT,
  pattern               TEXT,
  detailed_by_staff_id  TEXT REFERENCES pos_staff(id),
  assembled_by_staff_id TEXT REFERENCES pos_staff(id),
  racked_by_staff_id    TEXT REFERENCES pos_staff(id),
  last_rack_location    TEXT,
  smrt_created_at       TEXT NOT NULL,
  detailed_at           TEXT,
  assembled_at          TEXT,         -- drives done-ahead, done-today and the pieces-through-the-day chart
  racked_at             TEXT,
  removed_at            TEXT,         -- taken off the order; kept for history, left out of counts
  base_cents            INTEGER,
  upcharge_cents        INTEGER,
  discount_cents        INTEGER,
  price_cents           INTEGER,      -- SMRT 'Price' (includes tax); revenue uses base + upcharge - discount
  extra_json            TEXT,
  row_hash              TEXT NOT NULL,
  last_sync_id          TEXT REFERENCES int_sync_runs(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

-- What changed in SMRT, as found by each sync: due dates moved, notes added or edited, pieces moved between orders,
-- status changes. Nothing is overwritten without a row here, so every earlier due date and note is kept.
CREATE TABLE pos_changes (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES pos_orders(id),
  item_id      TEXT REFERENCES pos_items(id),
  kind         TEXT NOT NULL CHECK (kind IN ('due_changed','order_note','item_note','item_moved','item_added','item_removed','status_changed','order_deleted')),
  old_value    TEXT,
  new_value    TEXT,
  detected_at  TEXT NOT NULL,
  sync_run_id  TEXT REFERENCES int_sync_runs(id)
);

-- ===================== labor (hours + pay) =====================
-- Only hours per person per day are kept. Today's clock punches sit in labor_clock_today so the planner can see who's in;
-- each night they are added up into labor_daily_hours and cleared.

CREATE TABLE labor_daily_hours (
  person_id      TEXT NOT NULL REFERENCES core_people(id),
  work_date      TEXT NOT NULL,
  department_id  TEXT NOT NULL REFERENCES core_departments(id),   -- Production, Counter, Route ...
  location_id    TEXT REFERENCES core_locations(id),
  hours          REAL NOT NULL,     -- paid hours that day; weekly overtime is worked out from these
  first_in       TEXT,              -- 'HH:MM', for plan vs actual in Review
  last_out       TEXT,
  sync_run_id    TEXT REFERENCES int_sync_runs(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, work_date, department_id)
);

CREATE TABLE labor_clock_today (
  id             TEXT PRIMARY KEY,
  person_id      TEXT NOT NULL REFERENCES core_people(id),
  department_id  TEXT REFERENCES core_departments(id),
  clock_in       TEXT NOT NULL,
  clock_out      TEXT,
  payroll_entry_id TEXT UNIQUE,     -- Rippling's id, so the 10-minute re-reads don't duplicate
  sync_run_id    TEXT REFERENCES int_sync_runs(id)
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

CREATE TABLE plan_department_categories (
  department_id  TEXT PRIMARY KEY REFERENCES pos_departments(id),
  category_id    TEXT NOT NULL REFERENCES plan_categories(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES core_users(id),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE plan_item_categories (
  item_type_id  TEXT PRIMARY KEY REFERENCES pos_item_types(id),
  category_id   TEXT NOT NULL REFERENCES plan_categories(id),   -- overrides the department (comforters, tablecloths)
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

CREATE TABLE plan_followup_reasons (
  id     TEXT PRIMARY KEY,           -- 'stain','repair','customer','waiting','missing','other'
  name   TEXT NOT NULL,
  sort   INTEGER NOT NULL DEFAULT 0
);

-- Opened when an order's due date moves later, a piece moves to another order, or an order goes overdue.
-- If SMRT already has a note, it opens as 'noted'; if not, it asks the production manager for one.
CREATE TABLE plan_followups (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES pos_orders(id),
  item_id       TEXT REFERENCES pos_items(id),
  kind          TEXT NOT NULL CHECK (kind IN ('due_moved','item_moved','overdue')),
  change_id     TEXT REFERENCES pos_changes(id),   -- the SMRT change that opened it
  status        TEXT NOT NULL DEFAULT 'needs_note' CHECK (status IN ('needs_note','noted','resolved')),
  reason_id     TEXT REFERENCES plan_followup_reasons(id),
  note          TEXT,                -- entered in the app (SMRT's own note stays on the order or piece)
  noted_by      TEXT REFERENCES core_users(id),
  noted_at      TEXT,
  resolved_by   TEXT REFERENCES core_users(id),
  resolved_at   TEXT,                -- finished, or the new due date was met
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
CREATE INDEX ix_orders_created      ON pos_orders(org_id, smrt_created_at);
CREATE INDEX ix_orders_status       ON pos_orders(status_id);
CREATE INDEX ix_orders_return       ON pos_orders(return_location_id, due_at);
CREATE INDEX ix_order_deps_dep      ON pos_order_departments(department_id);
CREATE INDEX ix_items_order         ON pos_items(order_id);
CREATE INDEX ix_items_barcode       ON pos_items(barcode);
CREATE INDEX ix_changes_order       ON pos_changes(order_id, detected_at);
CREATE INDEX ix_changes_kind        ON pos_changes(kind, detected_at);
CREATE INDEX ix_followups_open      ON plan_followups(status, order_id);
CREATE INDEX ix_staff_person        ON pos_staff(person_id);
CREATE INDEX ix_items_assembled     ON pos_items(assembled_at);
CREATE INDEX ix_items_type          ON pos_items(item_type_id);
CREATE INDEX ix_items_dep           ON pos_items(department_id, assembled_at);
CREATE INDEX ix_hours_date          ON labor_daily_hours(work_date, department_id);
CREATE INDEX ix_clock_today_person  ON labor_clock_today(person_id);
CREATE INDEX ix_assignments_day     ON plan_assignments(day_id);
CREATE INDEX ix_assignments_person  ON plan_assignments(person_id);
CREATE INDEX ix_callouts_day        ON plan_callouts(day_id);
CREATE INDEX ix_run_events_day      ON plan_run_events(day_id, run_id);
CREATE INDEX ix_run_stops_location  ON plan_run_stops(location_id);
