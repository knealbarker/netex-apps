-- Customer names (Neal, Oct 18 2026): the Shuttle status page shows the customer's name instead of SMRT's customer id.
-- Filled by netex-sync from a name column on the saved orders report "TCC All Orders This Year" (or the items report):
-- "Customer Name" / "Customer" / "Name", or "First Name" + "Last Name". Until such a column exists it stays empty.
ALTER TABLE pos_orders ADD COLUMN customer_name TEXT; -- customer's name from the SMRT report (when the report has a name column)
