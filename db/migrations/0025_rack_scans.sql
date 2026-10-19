-- Rack scans and tickets (Neal, Oct 19 2026). SMRT's saved report "TCC Racked Last 12 Hours" (ddef672f-…) lists every rack
-- scan: TICKETS (SMRT's word: an order's bags, "26287-5444-A" = order 26287-5444, ticket A; tickets contain items) and single
-- items (by tag). The van driver scans tickets to VAN; stores scan them to their racks (E05, Q153, G LONG) or DELIVERED.
-- netex-sync reads the newest scans every 2 minutes (and on Shuttle status "Check now"); the report is filtered by scan time,
-- so each read is small. Wash & Fold bags are tickets too (they never appear in the items report).

-- every scan, as SMRT logged it (one row per ticket/item per scan)
CREATE TABLE pos_rack_events (
  id               TEXT PRIMARY KEY,                          -- ulid
  org_id           TEXT NOT NULL REFERENCES core_organizations(id),
  kind             TEXT NOT NULL,                             -- "Inventory type": 'ticket' or 'item' (others kept as sent)
  ref              TEXT NOT NULL,                             -- "ID": ticket '26287-5444-A' or the item's tag
  order_no         TEXT,                                      -- tickets: the order number without dashes ('262875444')
  ticket_letter    TEXT,                                      -- tickets: 'A', 'B' …
  location         TEXT,                                      -- "Location label": VAN, E05, Bagging, DELIVERED, Delivery 1 …
  location_barcode TEXT,                                      -- "Location barcode"
  rack             TEXT,                                      -- "Rack" (the rack group, e.g. 'Additional Storage', 'QuickSort Assembly')
  station          TEXT,                                      -- "Station"
  store_id         TEXT REFERENCES core_locations(id),        -- "Store": where the scan was made (VAN is at Sulphur Springs)
  drop_store_id    TEXT REFERENCES core_locations(id),        -- "Agent": the store the order was dropped at
  at               TEXT NOT NULL,                             -- "Date of entry" (Central local with offset)
  racked_by        TEXT,                                      -- "Racked by" as SMRT shows it ('Larry N', 'Conveyor')
  is_rerack        INTEGER NOT NULL DEFAULT 0,                -- "Is rerack event" (e.g. a store's morning re-scan)
  is_current       INTEGER NOT NULL DEFAULT 0,                -- "Is current" when read (SMRT's latest spot then)
  customer_name    TEXT,                                      -- "Customer full Name"
  price_cents      INTEGER,                                   -- "Price"
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, kind, ref, at, location_barcode)
);
CREATE INDEX ix_rack_events_ref   ON pos_rack_events(org_id, kind, ref, at);
CREATE INDEX ix_rack_events_order ON pos_rack_events(org_id, order_no, at);
CREATE INDEX ix_rack_events_at    ON pos_rack_events(org_id, at);

-- where each ticket is now: its latest scan
CREATE TABLE pos_tickets (
  org_id         TEXT NOT NULL REFERENCES core_organizations(id),
  ticket_id      TEXT NOT NULL,                              -- '26287-5444-A'
  order_no       TEXT NOT NULL,                              -- '262875444' (= pos_orders.smrt_order_no)
  letter         TEXT,                                       -- 'A'
  location       TEXT,                                       -- latest scan's location label
  store_id       TEXT REFERENCES core_locations(id),         -- latest scan's store
  at             TEXT NOT NULL,                              -- latest scan's time
  racked_by      TEXT,
  customer_name  TEXT,
  first_at       TEXT,                                       -- first scan seen
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, ticket_id)
);
CREATE INDEX ix_tickets_order ON pos_tickets(org_id, order_no);
CREATE INDEX ix_tickets_loc   ON pos_tickets(org_id, location, at);

-- read state (last scan time read, how far back history is loaded) is core_settings app 'core', key 'smrt_racks'.
