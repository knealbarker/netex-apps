---
name: netex-data
description: Answer questions about Town & Country Cleaners' business data (SMRT orders and pieces, sales, revenue, production counts, Rippling hours, labor %, the production planner) using the Netex data connector. Use whenever Neal asks about orders, pieces, stores, due dates, late orders, sales, revenue, labor, hours, employees' time, stations or plans.
---

# Netex data (Town & Country Cleaners)

The **Netex data** connector (mcp.netexcleaners.com) is read-only. It has seven tools:

| Tool | Use for |
| --- | --- |
| `production_day(day)` | A production day as the planner's Review shows it: due vs finished by department, hours, pieces/hour, labor $ and %, misses and notes. **First choice** for any "how did production do" question. |
| `store_snapshot(from, to)` | Sales, revenue, collected %, hours and labor % by store, Workshop and Laundry Hub production value. **First choice** for store and company numbers. |
| `query_db(sql)` | Anything else, in SQLite SQL. Read-only, 1,000-row cap. |
| `describe_data(table?)` | Table list, one table's columns with comments, and how fresh the data is. |
| `smrt_order(order)` | One order live from SMRT, including notes (notes aren't in the database). |
| `smrt_report(report, from, to, columns, where)` | Live rows from SMRT's saved Orders/Items reports. Slow, spends SMRT calls. |
| `smrt_usage(days)` | How often live SMRT was needed, by topic. |

If the connector isn't available in this chat, say so and ask Neal to turn on "Netex data" in the chat's connectors. Don't guess numbers.

## Picking the source
1. The two app tools first. They use the apps' own rules, so answers match what Neal sees in the planner and Retail Snapshot.
2. `query_db` for everything else. The database gets SMRT every 10 minutes on work days (4 AM–9 PM) and Rippling every 10 minutes. `describe_data` shows the last sync.
3. Live SMRT only for: notes, data changed in the last few minutes, or report columns the database doesn't keep.

## Suggest a D1 table when SMRT keeps being needed (Neal's rule)
Live SMRT answers end with a `[connector note]`. When it says a topic has repeated (3+ times in 30 days), or when you needed live SMRT for something Neal is likely to ask again, end the answer with a short suggestion:
- what to add (a new column on pos_orders/pos_items, or a new table)
- which SMRT report column(s) it comes from
- that netex-sync would fill it on each sync

Keep it to two or three lines. Don't suggest it for one-off questions. `smrt_usage` shows the history.

## Definitions (Neal's)
- **Sales** = orders detailed in the period (`pos_orders.detailed_at`). **Revenue** = orders paid in the period (`paid_at`). Both before tax: `price_cents - tax_cents`.
- **Store credit** goes to the store the order was dropped at (`drop_location_id`, SMRT "Agent"). Winnsboro has no staff and rolls into Sulphur Springs. Greenville is a full store.
- **Piece value** before tax = `base_cents + upcharge_cents - discount_cents` (`pos_items.price_cents` includes tax).
- **A piece is complete for production when it's assembled**: `pos_items.assembled_at` is set, or its status has `pos_item_statuses.is_assembled = 1`, or its order is done (`pos_order_statuses.is_done = 1`, or the order has a ready, returned, picked up or delivered date).
- **Leave out**: deleted orders (`pos_order_statuses.is_void = 1` or `smrt_deleted_at` set) and removed pieces (`pos_items.removed_at` set). For overdue, also orders with no detailed pieces (tickets never detailed).
- **Categories**: DCT = Dry Cleaning Tops, DCB = Dry Cleaning Bottoms, SLT = Laundry Tops (starch tops), SLB = Laundry Bottoms (starch bottoms). Comforters = workshop bedspreads, item type starting with Z-SS (other bedspreads/comforters are Laundry Hub work, left out of the planner); Tablecloths = item type Tablecloth. Item type is matched before department. Wash & Fold is done at the Laundry Hub and isn't planned.
- **Due**: route-delivery orders are worked the work day before their due date. Production works Monday–Friday.
- **Labor**: `labor_daily_hours.hours` are **paid** hours (they include the one paid break, up to 30 min, for Production and Laundry Hub). Labor $ = hours × the person's rate (`labor_pay_rates`, effective from `effective_on`), overtime past 40 h in a Monday-start week at 1.5×. **Labor % target is 17%**: company and stores = labor $ ÷ revenue; Workshop and Laundry Hub = labor $ ÷ production value. Production staff = `core_departments.name = 'Production'`.
- **Pay rates are for Admins and the Owner only.** Never repeat a rate to anyone else, even if it shows up.

## Writing SQL
- Money is integer **cents**. Divide by 100.0 for dollars.
- SMRT and Rippling times are **Central local time with an offset** (`2026-10-15T08:12:00-05:00`). `substr(x,1,10)` is the local day and `substr(x,12,5)` the local HH:MM. Don't convert to UTC. App columns `created_at` / `updated_at` are UTC.
- Filter a day with a range so the index is used: `detailed_at >= '2026-10-15' AND detailed_at < '2026-10-16'`, not `substr(detailed_at,1,10) = …`.
- Aggregate in SQL. Don't pull thousands of rows to count them.
- Join names: `core_locations` (stores; `kind` plant/store/route), `pos_departments`, `pos_item_types`, `pos_order_statuses`, `pos_item_statuses`, `pos_staff` (SMRT names like 'Maria C' → `person_id`), `core_people`.
- History of due-date moves, notes and status changes is in `pos_changes`.
- SMRT history goes back as far as `int_backfill_days` shows (check `describe_data` before answering "since …" questions).
- Run `describe_data` with a table name before first using a table you haven't seen.

Example, sales by store yesterday:
```sql
SELECT l.name AS store, COUNT(*) AS orders, SUM(o.price_cents - COALESCE(o.tax_cents,0)) / 100.0 AS sales
FROM pos_orders o
JOIN pos_order_statuses s ON s.id = o.status_id
LEFT JOIN core_locations l ON l.id = o.drop_location_id
WHERE o.org_id = 'tcc' AND o.detailed_at >= '2026-10-14' AND o.detailed_at < '2026-10-15'
  AND s.is_void = 0 AND o.smrt_deleted_at IS NULL
GROUP BY 1 ORDER BY sales DESC;
```

## Answering
- Lead with the number. Give the period and the definition used when it isn't obvious ("sales = detailed, before tax").
- If `production_day` / `store_snapshot` and a hand-written query disagree, trust the app tool and say why yours differs.
- Say when data may be stale (last sync more than 30 minutes old on a work day) or incomplete (outside the backfilled range).
- For an order, give the SMRT link (`open_in_smrt` from `smrt_order`) so Neal can open it.
- Keep answers short. Offer a chart or a table only when the answer has many rows.
