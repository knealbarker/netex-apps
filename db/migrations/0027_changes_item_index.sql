-- Look up SMRT changes by piece (Oct 22). Deleting a piece checks pos_changes.item_id for references; without this index
-- every delete scanned all of pos_changes (574k rows), so the cleanup in 0028 ran out of D1 CPU time.
CREATE INDEX IF NOT EXISTS ix_changes_item ON pos_changes(item_id);
