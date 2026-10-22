-- Remove copies of SMRT lines that have no tag number (Neal, Oct 22).
-- The sync matched pieces only by barcode, so a line without one ("Describe and Price" placeholders, employee discounts,
-- bags) was inserted again on every read: 26289-6547 had 385 rows for 2 pieces and put ~385 extra DC tops in the plan.
-- Those rows were never updated after insert, so last_sync_id is the run that inserted them. For each order, item type and
-- created time, the rows from the first run that saw the line are the real ones; rows from later runs are copies.
-- The sync now matches these lines (workers/sync/src/ingest.js) and removes any copy it still finds.

DELETE FROM plan_followups WHERE item_id IN (SELECT c.id FROM pos_items c WHERE COALESCE(c.barcode,'') = '' AND c.last_sync_id > (
    SELECT MIN(f.last_sync_id) FROM pos_items f WHERE COALESCE(f.barcode,'') = '' AND f.order_id = c.order_id
      AND f.item_type_id = c.item_type_id AND f.smrt_created_at = c.smrt_created_at))
  OR change_id IN (SELECT id FROM pos_changes WHERE item_id IN (SELECT c.id FROM pos_items c WHERE COALESCE(c.barcode,'') = '' AND c.last_sync_id > (
    SELECT MIN(f.last_sync_id) FROM pos_items f WHERE COALESCE(f.barcode,'') = '' AND f.order_id = c.order_id
      AND f.item_type_id = c.item_type_id AND f.smrt_created_at = c.smrt_created_at)));
DELETE FROM pos_changes WHERE item_id IN (SELECT c.id FROM pos_items c WHERE COALESCE(c.barcode,'') = '' AND c.last_sync_id > (
    SELECT MIN(f.last_sync_id) FROM pos_items f WHERE COALESCE(f.barcode,'') = '' AND f.order_id = c.order_id
      AND f.item_type_id = c.item_type_id AND f.smrt_created_at = c.smrt_created_at));
DELETE FROM pos_items WHERE id IN (SELECT c.id FROM pos_items c WHERE COALESCE(c.barcode,'') = '' AND c.last_sync_id > (
    SELECT MIN(f.last_sync_id) FROM pos_items f WHERE COALESCE(f.barcode,'') = '' AND f.order_id = c.order_id
      AND f.item_type_id = c.item_type_id AND f.smrt_created_at = c.smrt_created_at));
