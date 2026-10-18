-- Shuttle status (Neal, Oct 18 2026): prodplanner.netexcleaners.com/shuttlestatus.
-- Before the van leaves for a store, every piece due there today or earlier must be racked to VAN (or already at the store,
-- or back with the customer). These come from SMRT's items report and are filled by netex-sync from now on
-- (pieces read before Oct 18 get them the next time their created day is re-read).

-- the store whose rack the piece was last scanned to ("Last racked store"): VAN is a rack at Sulphur Springs; a store's own
-- racks (Q153, E68, G30, LONG …) carry that store, so a piece racked at its own store has already arrived
ALTER TABLE pos_items ADD COLUMN last_rack_store_id TEXT REFERENCES core_locations(id); -- "Last racked store" (where the last rack scan was)

-- when the piece went back to the customer ("Item return date")
ALTER TABLE pos_items ADD COLUMN returned_at TEXT; -- "Item return date" (Central local with offset)

-- SMRT's own customer id ("Customer Internal ID", e.g. 6p9avfo0b): opens the order in SMRT
-- https://towncountryclean.smrtapp.com/posx/dash/customer/clothestracker/<customer_internal_id>/?saleId=<smrt_order_no>
ALTER TABLE pos_orders ADD COLUMN customer_internal_id TEXT; -- "Customer Internal ID" from the items report (SMRT link)

-- The "Check now" button's state (last check, so it isn't pressed twice at once) is core_settings app 'core', key 'smrt_check'.
