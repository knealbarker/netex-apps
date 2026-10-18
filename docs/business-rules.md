# Business rules (Neal's definitions)

Every app and report should use these. If a new question needs a definition that isn't here, ask Neal and add it.

## The business
Town & Country Cleaners: dry cleaning and starched laundry, about 900–1,100 pieces a day.
- **Workshop** (production plant) and **Sulphur Springs** counter at 1415 S. Broadway, Sulphur Springs, TX.
- Drop stores: **Quitman**, **Emory**, **Greenville** (a full store), **Winnsboro** (no staff; its numbers roll into Sulphur Springs).
- **Laundry Hub**: wash & fold and comforters.
- Pickup and delivery routes. Route orders are worked the work day **before** their due date.
- Production works **Monday–Friday**. Systems: SMRT (POS), Rippling (time clock and payroll; ADP before).

## Money
- **Sales** = orders **detailed** in the period (`pos_orders.detailed_at`), before tax (`price_cents - tax_cents`).
- **Revenue** = orders **paid** in the period (`paid_at`), before tax.
- **Store credit** goes to the store the order was dropped at (SMRT "Agent", `drop_location_id`).
- **Collected %** = of a period's sales, the share already paid.
- **Piece value** before tax = base + upcharge − discount (`pos_items.price_cents` includes tax).
- **Production value** (Workshop, Laundry Hub) = pre-tax value of pieces each plant finished, on the assembly date
  (never-assembled pieces like wash & fold: the order's ready date).
- Leave out deleted orders (`pos_order_statuses.is_void = 1` or `smrt_deleted_at`) and removed pieces (`pos_items.removed_at`).

## Production
- **A piece is complete when it's assembled** (Neal: "Assembled = complete for production"): `assembled_at` set, or an assembled
  status, or its order is done (ready / returned / picked up / delivered date or a done status).
- **Categories:** DCT Dry Cleaning Tops, DCB Dry Cleaning Bottoms, SLT starch (laundry) tops, SLB starch (laundry) bottoms,
  Comforters (item type Comforter or Bedspread), Tablecloths. Item type is matched before department. Wash & Fold isn't planned.
- Overdue leaves out tickets never detailed (no pieces).
- Starch bottoms steady pace ≈ 20 pairs per presser-hour; a press starting from empty loses about 20 minutes.

## Labor
- **Labor % = labor $ ÷ revenue** (stores, company) or **÷ production value** (Workshop, Laundry Hub). **Target 17%.**
- Hours are **paid** hours: Production and Laundry Hub get one paid break a day, up to 30 min (the first gap; back within
  35 min = paid, longer = all unpaid). Store staff: no paid break in the calculations.
- Labor $ = hours × the person's rate from that date (`labor_pay_rates`), or the department average when missing.
  **Overtime**: hours past 40 in a Monday-start week, all locations together, at 1.5×.
- **Pay rates are for Admins and the Owner only**, in every app and report.

## Counter (Retail Snapshot › Counter, Neal Oct 18 2026)
- Staff create the SMRT ticket when the customer walks in, so a **drop-off = ticket created**; a **pickup = order picked up**.
  One customer's drop-offs and pickups at one store within 20 min (Settings) are **one visit**: drop-off only, pickup only, both.
  Route orders, deleted tickets and stores with no one on the clock (Winnsboro) are left out.
- **Detailing speed** = average time between two pieces of one order by the same person. A gap of **90 s or more**
  (Settings) is a **distraction gap**: counted separately, left out of the speed.
- **Salaried staff** (Karla, Debra; list in Settings) don't clock in. Their counter hours = their detailing time (gaps under
  90 s + one typical piece per order) + **2 min per pickup** (measured median, Settings) while they're working, shared
  with whoever is on the clock. **Visits per labor hour** = visits ÷ (Rippling store hours + salaried hours).
- **Clock check**: SMRT work at a store Rippling doesn't have the person at, SMRT work with no punch (not salaried), or
  SMRT work more than 15 min outside punches. **Rippling is the source of truth**: fix it there and the flag clears;
  a Manager can mark a flag OK with a note.

## Times
- Central time (America/Chicago). SMRT and Rippling stamps are stored as Central local with offset; app timestamps are UTC.
