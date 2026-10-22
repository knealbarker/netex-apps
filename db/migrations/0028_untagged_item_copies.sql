-- Remove copies of SMRT lines that have no tag number (Neal, Oct 22).
-- The sync matched pieces only by barcode, so a line without one ("Describe and Price" placeholders, employee discounts,
-- bags) was inserted again on every read: 26289-6547 had 385 rows for 2 pieces and put ~385 extra DC tops in the plan.
-- Those rows were never updated after insert, so last_sync_id is the run that inserted them. For each order, item type and
-- created time, the rows from the first run that saw the line are the real ones; rows from later runs are copies
-- (8,342 copies, 380 real lines on Oct 22). The sync now matches these lines (workers/sync/src/ingest.js).
-- The list is worked out once (barcode index, one grouping) because per-row subqueries ran out of D1 CPU time.

CREATE TABLE _untagged_copies AS
WITH b AS MATERIALIZED (
  SELECT id, order_id, item_type_id, smrt_created_at, last_sync_id FROM pos_items WHERE barcode IS NULL OR barcode = ''
), g AS MATERIALIZED (
  SELECT order_id, item_type_id, smrt_created_at, MIN(last_sync_id) AS first_run FROM b GROUP BY 1, 2, 3 HAVING COUNT(*) > 1
)
SELECT b.id FROM b JOIN g USING (order_id, item_type_id, smrt_created_at) WHERE b.last_sync_id > g.first_run;

DELETE FROM plan_followups WHERE item_id IN (SELECT id FROM _untagged_copies)
  OR change_id IN (SELECT c.id FROM pos_changes c JOIN _untagged_copies u ON u.id = c.item_id);
DELETE FROM pos_changes WHERE item_id IN (SELECT id FROM _untagged_copies);
DELETE FROM pos_items WHERE id IN (SELECT id FROM _untagged_copies);
DROP TABLE _untagged_copies;
