-- Retail Snapshot: production value for the Workshop and Laundry Hub is counted when pieces are finished
-- (item assembly date) or, for work that's never assembled (wash & fold), when the order is ready.
CREATE INDEX IF NOT EXISTS ix_orders_ready ON pos_orders(org_id, ready_at);
