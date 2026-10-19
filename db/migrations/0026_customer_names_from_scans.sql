-- Customer names from the rack scans already loaded (Neal, Oct 19: Shuttle status should show names, not SMRT's ids).
-- netex-sync fills pos_orders.customer_name from each new scan (tickets by order number, items by tag); this fills the orders
-- of the last 60 days from the scans read before that (45 days of history were loaded on Oct 19).
UPDATE pos_orders SET customer_name = (
    SELECT e.customer_name FROM pos_rack_events e
    WHERE e.org_id = pos_orders.org_id AND e.kind = 'ticket' AND e.order_no = pos_orders.smrt_order_no AND e.customer_name IS NOT NULL
    ORDER BY e.at DESC LIMIT 1)
  WHERE (customer_name IS NULL OR customer_name = '') AND smrt_created_at >= '2026-08-20'
    AND EXISTS (SELECT 1 FROM pos_rack_events e WHERE e.org_id = pos_orders.org_id AND e.kind = 'ticket' AND e.order_no = pos_orders.smrt_order_no AND e.customer_name IS NOT NULL);

UPDATE pos_orders SET customer_name = (
    SELECT e.customer_name FROM pos_items i JOIN pos_rack_events e ON e.org_id = pos_orders.org_id AND e.kind = 'item' AND e.ref = i.barcode
    WHERE i.order_id = pos_orders.id AND i.removed_at IS NULL AND e.customer_name IS NOT NULL ORDER BY e.at DESC LIMIT 1)
  WHERE (customer_name IS NULL OR customer_name = '') AND smrt_created_at >= '2026-08-20'
    AND EXISTS (SELECT 1 FROM pos_items i JOIN pos_rack_events e ON e.org_id = pos_orders.org_id AND e.kind = 'item' AND e.ref = i.barcode
      WHERE i.order_id = pos_orders.id AND i.removed_at IS NULL AND e.customer_name IS NOT NULL);
