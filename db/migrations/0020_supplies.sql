-- Supplies (Neal, Oct 15 2026): supplies.netexcleaners.com. Stores, the Laundry Hub and the Workshop count supplies on a paired
-- device (no sign-in; the person types their first name + last initial, checked against an approved list). A store's count
-- becomes its list for the daily shuttle (Mon–Fri); the Workshop's count becomes the list of what to order from each vendor.
-- The supply manager (Karla Velasquez for now) signs in like every other app; access is a role in app 'supplies'.
-- Table prefix: supply_.

INSERT INTO core_apps(id, name, subdomain) VALUES ('supplies', 'Supplies', 'supplies');
INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at)
SELECT id, 'supplies', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM core_users WHERE lower(email) = 'neal@towncountryclean.com';

-- The seven places that keep supplies. Names match what netex-sync creates from Rippling ("TCC Quitman" -> Quitman);
-- rows that already exist are left alone, so this only adds the ones with no time-clock hours yet (e.g. Winnsboro).
INSERT OR IGNORE INTO core_locations(id, org_id, name, kind) VALUES
  ('01MSUPLOC0SULPHURSPRINGS0', 'tcc', 'Sulphur Springs', 'store'),
  ('01MSUPLOC0GREENVILLE00000', 'tcc', 'Greenville', 'store'),
  ('01MSUPLOC0EMORY0000000000', 'tcc', 'Emory', 'store'),
  ('01MSUPLOC0WINNSBORO000000', 'tcc', 'Winnsboro', 'store'),
  ('01MSUPLOC0QUITMAN00000000', 'tcc', 'Quitman', 'store'),
  ('01MSUPLOC0LAUNDRYHUB00000', 'tcc', 'Laundry Hub', 'plant');   -- same kind netex-sync gives it from Rippling

-- Which locations take part, and how. The warehouse (Workshop) is restocked by vendor orders; the others by the shuttle.
CREATE TABLE supply_locations (
  location_id  TEXT PRIMARY KEY REFERENCES core_locations(id),
  org_id       TEXT NOT NULL REFERENCES core_organizations(id),
  role         TEXT NOT NULL CHECK (role IN ('warehouse','store')),
  label        TEXT,                 -- shown on the count page and slips, e.g. 'Sulphur Springs Retail'
  sort         INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1
);
INSERT INTO supply_locations(location_id, org_id, role, label, sort)
SELECT id, org_id, CASE WHEN name = 'Workshop' THEN 'warehouse' ELSE 'store' END,
       CASE name WHEN 'Workshop' THEN 'Sulphur Springs Workshop' WHEN 'Laundry Hub' THEN 'Laundry Hub' ELSE name || ' Retail' END,
       CASE name WHEN 'Workshop' THEN 10 WHEN 'Sulphur Springs' THEN 20 WHEN 'Greenville' THEN 30 WHEN 'Emory' THEN 40
                 WHEN 'Winnsboro' THEN 50 WHEN 'Quitman' THEN 60 WHEN 'Laundry Hub' THEN 70 END
FROM core_locations WHERE org_id = 'tcc' AND name IN ('Workshop','Sulphur Springs','Greenville','Emory','Winnsboro','Quitman','Laundry Hub');

CREATE TABLE supply_vendors (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES core_organizations(id),
  name              TEXT NOT NULL,
  order_method      TEXT,            -- 'Phone / web'
  phone             TEXT,
  website           TEXT,
  account_no        TEXT,
  contact           TEXT,
  lead_days         INTEGER,         -- days from ordering to arriving
  min_order_cents   INTEGER,         -- minimum order in cents, if there is one
  min_order_note    TEXT,            -- other minimums, e.g. 'free freight over $300'
  notes             TEXT,
  sort              INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  updated_at        TEXT,
  updated_by        TEXT REFERENCES core_users(id)
);

CREATE TABLE supply_items (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES core_organizations(id),
  name         TEXT NOT NULL,
  vendor_id    TEXT REFERENCES supply_vendors(id),
  vendor_sku   TEXT,
  category     TEXT NOT NULL DEFAULT 'Other',
  unit         TEXT NOT NULL DEFAULT 'each',   -- what a store counts and what goes on the shuttle
  bulk_unit    TEXT,                           -- what the Workshop counts and orders (null = same as unit), e.g. 'case'
  unit_cost_cents INTEGER,                     -- per order unit, cents (optional; shows order totals against a vendor minimum)
  notes        TEXT,
  review_note  TEXT,                           -- a question left from cleaning up the old sheets; cleared once checked
  sort         INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT,
  updated_by   TEXT REFERENCES core_users(id)
);
CREATE INDEX ix_supply_items ON supply_items(org_id, is_active, sort);

-- An item is kept at a location when it has a row here. par = keep this many on hand (null = as needed);
-- reorder_at = ask for more once at or below this (null = as soon as below par). Workshop numbers are in bulk units.
-- mode = how the count page asks: 'count' (a number), 'level' (Out / Low / OK), 'check' (Need any? and how many).
CREATE TABLE supply_pars (
  item_id      TEXT NOT NULL REFERENCES supply_items(id),
  location_id  TEXT NOT NULL REFERENCES core_locations(id),
  par          REAL,
  reorder_at   REAL,
  mode         TEXT NOT NULL DEFAULT 'count' CHECK (mode IN ('count','level','check')),
  PRIMARY KEY (item_id, location_id)
);

-- People allowed to submit a count: first name + last initial ('KarlaV'). handle is that, lower-case, letters only.
CREATE TABLE supply_counters (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES core_organizations(id),
  first_name   TEXT NOT NULL,
  last_initial TEXT NOT NULL,
  handle       TEXT NOT NULL,
  location_id  TEXT REFERENCES core_locations(id),   -- null = may count anywhere
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by   TEXT REFERENCES core_users(id),
  UNIQUE (org_id, handle)
);

-- Counting devices (a store PC, tablet or phone), paired once with a 6-digit code like the station tablets.
CREATE TABLE supply_devices (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES core_organizations(id),
  location_id      TEXT NOT NULL REFERENCES core_locations(id),
  name             TEXT NOT NULL,
  token_hash       TEXT UNIQUE,
  pair_code_hash   TEXT,
  pair_expires_at  TEXT,
  pair_failures    INTEGER NOT NULL DEFAULT 0,
  paired_at        TEXT,
  last_seen_at     TEXT,
  created_by       TEXT REFERENCES core_users(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at       TEXT
);

-- The supply manager asks a location to count (shown on its count page until a count comes in).
CREATE TABLE supply_requests (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES core_organizations(id),
  location_id   TEXT NOT NULL REFERENCES core_locations(id),
  requested_by  TEXT REFERENCES core_users(id),
  requested_at  TEXT NOT NULL,
  due_on        TEXT,                -- YYYY-MM-DD
  note          TEXT,
  done_count_id TEXT,
  done_at       TEXT,
  cancelled_at  TEXT
);
CREATE INDEX ix_supply_requests ON supply_requests(org_id, location_id, done_at, cancelled_at);

CREATE TABLE supply_counts (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES core_organizations(id),
  location_id   TEXT NOT NULL REFERENCES core_locations(id),
  counter_id    TEXT REFERENCES supply_counters(id),
  counted_by    TEXT NOT NULL,       -- the name as shown ('Karla V')
  device_id     TEXT REFERENCES supply_devices(id),
  user_id       TEXT REFERENCES core_users(id),     -- when entered by a signed-in manager
  submitted_at  TEXT NOT NULL,
  note          TEXT,                -- "anything else you need?"
  items         INTEGER NOT NULL DEFAULT 0,
  needs         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_supply_counts ON supply_counts(org_id, location_id, submitted_at);

CREATE TABLE supply_count_lines (
  count_id  TEXT NOT NULL REFERENCES supply_counts(id),
  item_id   TEXT NOT NULL REFERENCES supply_items(id),
  mode      TEXT NOT NULL,
  qty       REAL,                    -- 'count': on hand; 'check': how many needed
  level     TEXT,                    -- 'level': out / low / ok; 'check': need / none
  par       REAL,                    -- the par at the time
  need      REAL NOT NULL DEFAULT 0, -- worked out when submitted
  PRIMARY KEY (count_id, item_id)
);
CREATE INDEX ix_supply_count_lines_item ON supply_count_lines(item_id);

-- A store's shuttle list. One open list per store; a newer count replaces the open one. 'sent' = packed on the shuttle.
CREATE TABLE supply_shipments (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES core_organizations(id),
  location_id  TEXT NOT NULL REFERENCES core_locations(id),
  count_id     TEXT REFERENCES supply_counts(id),
  status       TEXT NOT NULL CHECK (status IN ('open','sent','replaced','cancelled')),
  created_at   TEXT NOT NULL,
  sent_at      TEXT,
  sent_by      TEXT REFERENCES core_users(id),
  ship_on      TEXT,                 -- shuttle day, YYYY-MM-DD
  note         TEXT                  -- the store's "anything else" text
);
CREATE INDEX ix_supply_shipments ON supply_shipments(org_id, status, location_id);

CREATE TABLE supply_shipment_lines (
  id           TEXT PRIMARY KEY,
  shipment_id  TEXT NOT NULL REFERENCES supply_shipments(id),
  item_id      TEXT REFERENCES supply_items(id),   -- null for a write-in
  label        TEXT,                               -- write-in text
  need         REAL NOT NULL DEFAULT 0,
  send_qty     REAL,                               -- what the supply manager is sending (null = the need)
  sort         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_supply_shipment_lines ON supply_shipment_lines(shipment_id);

-- Vendor orders the supply manager placed (by phone or web). Items on an open order aren't suggested again.
CREATE TABLE supply_orders (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES core_organizations(id),
  vendor_id    TEXT REFERENCES supply_vendors(id),
  status       TEXT NOT NULL CHECK (status IN ('ordered','received','cancelled')),
  ordered_at   TEXT NOT NULL,
  ordered_by   TEXT REFERENCES core_users(id),
  expected_on  TEXT,
  received_at  TEXT,
  reference    TEXT,                 -- confirmation / PO number
  note         TEXT
);
CREATE INDEX ix_supply_orders ON supply_orders(org_id, status);

CREATE TABLE supply_order_lines (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES supply_orders(id),
  item_id    TEXT REFERENCES supply_items(id),
  label      TEXT,
  qty        REAL NOT NULL,
  unit_cost_cents INTEGER,
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_supply_order_lines ON supply_order_lines(order_id);
