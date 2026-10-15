# Starting supply catalog for supplies.netexcleaners.com, cleaned up from "2026 TCC Inventory Order Sheets.xlsx" (Oct 15, 2026).
# Run: python3 db/supplies/catalog.py  -> writes db/migrations/0021_supplies_seed.sql and db/supplies/catalog.json
#
# Units: `unit` is what a store counts and what goes on the shuttle; `bulk` is what the Workshop counts and what is ordered
# from the vendor (None = same as unit). Workshop par/reorder are in bulk units, store par in units.
# Pars: ws = Workshop par, wsr = Workshop reorder point (None = reorder when below par), st = each retail store's par,
# hub = Laundry Hub par. None = not kept there. "AN" = as needed (no par; asked "Need any?").
# check = a guess made while cleaning that Neal or Karla should confirm.
import json, os

VENDORS = [
    # id, name, how ordered, notes
    ("fabriclean", "Fabriclean Supply", "Phone / web", ""),
    ("janitorial", "Northeast Texas Janitorial", "Phone", ""),
    ("cleaners-supply", "Cleaners Supply", "Web (cleanersupply.com)", "Custom-printed items (barcode labels, Eco2Go bags) are ordered by email."),
    ("latsons", "Latson's", "Phone / email", "Printed forms, pads, cards and tags."),
    ("other", "Other (store run / Amazon)", "Store run or Amazon", "Batteries, tape, water, candy and other odds and ends."),
    ("in-house", "In-house (not bought)", "", "Made or kept in-house: cleaning towels returned in the specials bag, new-customer packets, printouts."),
]

AN = "AN"
I = []
def item(name, vendor, cat, unit, bulk=None, sku=None, ws=None, wsr=None, st=None, hub=None, note="", check=""):
    I.append(dict(name=name, vendor=vendor, sku=sku, category=cat, unit=unit, bulk=bulk, ws=ws, wsr=wsr, st=st, hub=hub, note=note, check=check))

# ---------------- Fabriclean ----------------
F = "fabriclean"
item('Poly shirt mark 40" big gusset', F, "Assembly & bagging", "roll", ws=16)
item('Poly shirt mark 60"', F, "Assembly & bagging", "roll", ws=3)
item('Poly shirt mark 72"', F, "Assembly & bagging", "roll", ws=2)
item("Sultra Soft Deo HC dry clean detergent", F, "Laundry & dry clean chemicals", "pail (5 gal)", ws=1)
item("UNX Liquid Sour Bright", F, "Laundry & dry clean chemicals", "drum (15 gal)", ws=1)
item("Faultless Super Star powder starch", F, "Laundry & dry clean chemicals", "bag (50 lb)", ws=3)
item("Faultless Star Bright liquid starch", F, "Laundry & dry clean chemicals", "drum (15 gal)", ws=1)
item("UNX Spec Tak detergent", F, "Laundry & dry clean chemicals", "bag (50 lb)", ws=6, check="Sheet says 6 x 50-LB — bags or pails?")
item("UNX Pro Fit Clean", F, "Laundry & dry clean chemicals", "pail (5 gal)", ws=1)
item("UNX Vita-Pro degreaser", F, "Laundry & dry clean chemicals", "pail (5 gal)", ws=1)
item("UNX Pro Fit Body", F, "Laundry & dry clean chemicals", "pail (5 gal)", ws=1)
item("EcoSolv dry clean solvent", F, "Laundry & dry clean chemicals", "pail (5 gal)", ws=1)
item("Dry clean filter — carbon split", F, "Laundry & dry clean chemicals", "filter", ws=AN)
item("Dry clean filter — delux split", F, "Laundry & dry clean chemicals", "filter", ws=AN)
item('18" Ultimate strut hanger (purple box)', F, "Hangers", "case (200)", ws=1)
item("Jeans strut hanger (black/pink box)", F, "Hangers", "case (500)", ws=8)
item('20" knit standard 14g hanger (black/green box)', F, "Hangers", "case (250)", ws=4)
item('18" caped plain 13g Ultimate hanger (green/red box)', F, "Hangers", "case (500)", ws=4)
item('16" caped 13g plain hanger (red box)', F, "Hangers", "case", ws=2, check="Case count not on the sheet.")
item('13" 13g gold juvenile hanger (plain box)', F, "Hangers", "case (500)", ws=1)
item('18" shirt hanger Ultimate (blue box)', F, "Hangers", "hanger", bulk="case (500)", ws=10, hub=30,
     check="Laundry Hub's 'shirt hangers' (30) assumed to be this hanger; the Hub counts hangers, the Workshop counts cases.")
item("Ammonia 9%", F, "Spotting", "gallon", ws=1)
item("Bongo 12 oz", F, "Spotting", "bottle", ws=1, wsr=0.5, note="Goal on sheet: half bottle")
item("EasyGo gallon", F, "Spotting", "bottle", ws=1, wsr=0.5, note="Goal on sheet: half bottle")
item("Exit deodorizer aerosol", F, "Spotting", "can", ws=6)
item("InkGo 16 oz", F, "Spotting", "bottle", ws=1, wsr=0.5, note="Goal on sheet: half bottle")
item("PSR powder spot remover", F, "Spotting", "can", ws=8)
item("QwikGo 1/2 gallon", F, "Spotting", "bottle", ws=1, wsr=0.5, note="Goal on sheet: half bottle")
item("RiteGo gallon", F, "Spotting", "case", ws=1)
item("RustGo 14 oz", F, "Spotting", "bottle", ws=1, wsr=0.5, note="Goal on sheet: half bottle")
item("Sodium perborate", F, "Spotting", "bag", ws=1, wsr=0.25, note="Goal on sheet: quarter bag")
item("SoGo 1 lb", F, "Spotting", "bottle", ws=1, wsr=0.5, note="Goal on sheet: half bottle")
item("TarGo laundry", F, "Spotting", "bottle", ws=1, wsr=0.5, note="Goal on sheet: half bottle")
item("TarGo EF 16 oz", F, "Spotting", "bottle", ws=1, wsr=0.5, note="Goal on sheet: half bottle")
item("YellowGo gallon", F, "Spotting", "bottle", ws=1, wsr=0.5, note="Goal on sheet: half bottle")
item("Boiler compound", F, "Boiler & general", "pail", ws=1, wsr=0.25, note="Goal on sheet: quarter pail")
item("Spray sizing / starch", F, "Boiler & general", "case", ws=1)

# ---------------- Northeast Texas Janitorial ----------------
J = "janitorial"
item("Toilet paper", J, "Janitorial", "roll", bulk="case", ws=1, st=6, check="Rolls per case?")
item("Hand towels", J, "Janitorial", "pack", bulk="case", ws=1, st=1, hub=1, check="Stores and the Hub count packs/rolls, the Workshop counts cases.")
item("Hand soap", J, "Janitorial", "bottle", bulk="case", ws=1, st=1)
item("Blue Dawn dish soap", J, "Janitorial", "gallon", ws=2)
item("Window cleaner", J, "Janitorial", "bottle", bulk="case", ws=1, st=1)
item("Surface cleaner", J, "Janitorial", "bottle", bulk="case", ws=1, st=1)
item("Spray bottles", J, "Janitorial", "bottle", ws=2)
item("Liquid Live", J, "Janitorial", "gallon", ws=1)
item("Air freshener", J, "Janitorial", "bottle", ws=4, st=2)
item("Hand sanitizer", J, "Janitorial", "bottle", ws=4)
item("Gloves — medium", J, "Janitorial", "box", ws=1, st=1, note="Keep one unopened box")
item("Gloves — XL", J, "Janitorial", "box", ws=1, st=1, note="Keep one unopened box")

# ---------------- Cleaners Supply ----------------
C = "cleaners-supply"
item("Heat seal machine Teflon pad", C, "Counter supplies", "pad", sku="HSM2002", ws=AN, st=AN)
item("Laundry pen", C, "Counter supplies", "pen", sku="PN1", ws=12, st=2)
item('Button foil 2 3/4"', C, "Counter supplies", "roll", sku="BW1", ws=2, st=1)
item("Barcode heat seal labels (custom)", C, "Tags & labels", "box (2000)", sku="EMAIL", ws=1, st=1, note="Order by email", check="Sheet: 2,000 at Workshop and 2,000 per store — assumed boxes of 2,000.")
item("Receipt paper", C, "Counter supplies", "roll", bulk="case", sku="RCT1WH", ws=1, st=20, check="Rolls per case?")
item("Safe and Secure bags", C, "Counter supplies", "bag", bulk="box", sku="SS1", ws=1, st=100, check="Bags per box? Stores answer Out/Low/OK for this one.")
item("Dennison gun", C, "Counter supplies", "gun", sku="DG1", ws=2, st=1)
item("Dennison gun needles", C, "Counter supplies", "needle", sku="DN1", ws=2, st=1)
item('Dennison fastener yellow 3/4"', C, "Counter supplies", "box", sku="DF10YE", ws=1)
item('Dennison fastener white 3/4"', C, "Counter supplies", "box", st=1, check="Stores use white (1,000); Workshop sheet lists yellow — no Cleaners Supply # for white yet. Assumed 1 box = 1,000.")
item("B8 stapler", C, "Counter supplies", "stapler", sku="B8P", ws=2)
item("Staples B8", C, "Counter supplies", "box (1000)", sku="S810", ws=20, st=1, check="Sheet: 20,000 at Workshop, 1,000 per store — assumed boxes of 1,000.")
for tag, sku, at_store in [('"Crease" white', "IT52", True), ('"Special Attention" blue', "IT228", True), ('"Fold" white', "IT26", True),
                           ('"No Crease / Sin Raya" white', "IT81WH", True), ('"Rush" red', "IT51", False), ('"Prespot" yellow', "IT25YE", True),
                           ('"Received in Damage" blue', "IT47", True), ('"Do-Over" white', "IT13", False), ('"Sizing" lavender', "IT20", True)]:
    item(f"Instruction tag {tag}", C, "Tags & labels", "box (1000)", sku=sku, ws=5, st=1 if at_store else None,
         check="Sheet: 5,000 at Workshop, 1,000 per store — assumed boxes of 1,000." if tag.startswith('"Crease"') else "")
item("Tag stain sticker", C, "Tags & labels", "box (1000)", sku="ID1", ws=5, st=1)
item("Plastic holder with loop", C, "Counter supplies", "each", sku="ET3", ws=200, st=25)
item("Eco2Go standard counter bags (yellow logo)", C, "Bags", "bag", sku="EMAIL", ws=200, st=25, note="Order by email")
item("Eco2Go 20 gal wash & fold bags (yellow logo)", C, "Bags", "bag", sku="EMAIL", ws=50, st=10, note="Order by email")
item("Eco2Go 30 gal wash & fold bags (white logo)", C, "Bags", "bag", sku="EMAIL", ws=50, st=10, note="Order by email")
item("Auto carrier hooks", C, "Counter supplies", "hook", sku="CAR1CIT", ws=30, st=10)
item("Collar Styx", C, "Assembly & bagging", "each", bulk="box", sku="STX1", ws=600, check="600 on the sheet — loose count or boxes?")
for size, sku in [("extra large", "COMF26NV"), ("large", "COMF24NV"), ("medium", "COMF20NV"), ("small", "COMF15NV"), ("extra small", "COMF3NV")]:
    item(f"Comforter bag {size} (navy)", C, "Bags", "bag", sku=sku, ws=24, hub=24)
item("Standard foamies (yellow)", C, "Assembly & bagging", "each", sku="FC2YE", ws=500)
item("Thick foamies (blue)", C, "Assembly & bagging", "each", sku="FC500BL", ws=200)
item("Conveyor wheels", C, "Boiler & general", "wheel", sku="TRB1", ws=20)
item("Lint roller handles", C, "Assembly & bagging", "handle", sku="LR2000", ws=6)
item("Lint roller refills", C, "Assembly & bagging", "roll", sku="LR15", ws=12)
item("Plastic clip short hangers", C, "Hangers", "hanger", sku="HNG104", ws=200)
item('5" seam ripper', C, "Assembly & bagging", "each", sku="SR1", ws=10)
item("Special attention tags", C, "Tags & labels", "tag", sku="HT10", ws=1000)
item("Standard bust forms", C, "Assembly & bagging", "each", sku="BUS50", ws=25)
item("Heavy weight bust forms", C, "Assembly & bagging", "each", sku="BUS3", ws=25)
item("General release forms", C, "Forms & print", "form", sku="RF1", ws=1000)
item("Steam iron hose", C, "Boiler & general", "hose", sku="TEF7", ws=1)
item("Tie boards", C, "Assembly & bagging", "each", sku="BB2", ws=50)
item("Shirt carrying bags", C, "Bags", "bag", sku="SH1300", ws=50)
item("Hot head mitt", C, "Assembly & bagging", "each", sku="HM1", ws=1)
item("Spotting brush — white", C, "Spotting", "brush", sku="BH1WH", ws=1)
item("Spotting brush — black", C, "Spotting", "brush", sku="BH1BK", ws=1)
item("Safety pins", C, "Assembly & bagging", "box", sku="SP1", ws=1)
item("Fabric shaver", C, "Assembly & bagging", "each", sku="BH26", ws=1)

# ---------------- Latson's (print) ----------------
L = "latsons"
for n in ["Alterations order pad", "Cobbler order pad", "Leather care order pad", "Wedding dress order pad", "WDF order pad",
          "Our Services card", "Welcome coupon", "New customer info pad", "Tag PNC bag", "Letter from Neal"]:
    item(n, L, "Forms & print", "pad" if "pad" in n else "pack", ws=AN, check="No goal on the sheet yet.")
item("Retail lot tags", L, "Forms & print", "tag", ws=AN, st=100)

# ---------------- Other ----------------
O = "other"
item("AA batteries", O, "Store extras", "battery", ws=10, st=AN)
item("AAA batteries", O, "Store extras", "battery", ws=10, st=AN)
item("Packing tape", O, "Store extras", "roll", ws=AN, st=AN)
item("Bottled water for the store", O, "Store extras", "case", ws=AN, st=2)
item("Candy", O, "Store extras", "large bag", ws=AN, st=2)
item("Detergent pods — regular scent", O, "Laundry Hub", "pod", bulk="tub", ws=AN, hub=200, check="Vendor? Hub counts pods; Workshop counts tubs/boxes.")
item("Detergent pods — unscented", O, "Laundry Hub", "pod", bulk="tub", ws=AN, hub=200, check="Vendor? Hub counts pods; Workshop counts tubs/boxes.")
item("Dryer sheets — regular scent", O, "Laundry Hub", "sheet", bulk="box", ws=AN, hub=200, check="Vendor?")
item("Dryer sheets — unscented", O, "Laundry Hub", "sheet", bulk="box", ws=AN, hub=200, check="Vendor?")
item("Wash & fold liner bags", O, "Laundry Hub", "case", ws=AN, hub=0.5, check="Vendor? Hub goal is half a case.")

# ---------------- In-house / partner-supplied ----------------
H = "in-house"
item("Cleaning towels (return dirty ones in the specials bag)", H, "Janitorial", "towel", st=10, hub=5)
item("Cobblers Direct order forms", H, "Forms & print", "form", st=20, note="From Cobblers Direct")
item("Arrow Leather order forms", H, "Forms & print", "form", st=20, note="From Arrow Leather")
item("Temp tag material", H, "Tags & labels", "pack", st=AN)
item("New customer packets", H, "Forms & print", "packet", st=20, note="Put together at the office")
item("Supply list printout", H, "Forms & print", "sheet", st=10)
item("Prespot bottles", H, "Counter supplies", "bottle", st=1)

# How stores answer by default: a number when the par is small enough to count, Out/Low/OK otherwise, "Need any?" for as-needed.
def store_mode(par):
    if par == AN: return "check"
    return "count" if par <= 30 else "level"

STORES = ["Sulphur Springs", "Greenville", "Emory", "Winnsboro", "Quitman"]
ws_items = st_items = hub_items = 0
rows = []
for n, it in enumerate(I, 1):
    pars = []
    if it["ws"] is not None:
        pars.append(("Workshop", None if it["ws"] == AN else it["ws"], it["wsr"], "check" if it["ws"] == AN else "count")); ws_items += 1
    if it["st"] is not None:
        for s in STORES: pars.append((s, None if it["st"] == AN else it["st"], None, store_mode(it["st"])))
        st_items += 1
    if it["hub"] is not None:
        pars.append(("Laundry Hub", it["hub"], None, store_mode(it["hub"]))); hub_items += 1
    rows.append({**it, "sort": n * 10, "pars": pars})

here = os.path.dirname(os.path.abspath(__file__))
json.dump({"vendors": VENDORS, "items": rows}, open(os.path.join(here, "catalog.json"), "w"), indent=1)

q = lambda v: "NULL" if v is None or v == "" else ("'" + str(v).replace("'", "''") + "'" if isinstance(v, str) else repr(v))
sql = ["-- Starting supply list (generated by db/supplies/catalog.py from the 2026 order sheets; edit in the app after this).",
       "-- Migrations run once, so later changes made in the app are never overwritten."]
for i, (vid, name, how, notes) in enumerate(VENDORS, 1):
    sql.append(f"INSERT INTO supply_vendors(id, org_id, name, order_method, notes, sort) VALUES({q(vid)}, 'tcc', {q(name)}, {q(how)}, {q(notes)}, {i*10});")
for k, it in enumerate(rows, 1):
    iid = f"seed-{k:03d}"
    sql.append(f"INSERT INTO supply_items(id, org_id, name, vendor_id, vendor_sku, category, unit, bulk_unit, notes, review_note, sort)"
               f" SELECT {q(iid)}, 'tcc', {q(it['name'])}, {q(it['vendor'])}, {q(it['sku'] if it['sku'] != 'EMAIL' else None)}, {q(it['category'])},"
               f" {q(it['unit'])}, {q(it['bulk'])}, {q(it['note'])}, {q(it['check'])}, {it['sort']};")
    for loc, par, reorder, mode in it["pars"]:
        sql.append(f"INSERT INTO supply_pars(item_id, location_id, par, reorder_at, mode)"
                   f" SELECT {q(iid)}, l.id, {q(par)}, {q(reorder)}, {q(mode)} FROM core_locations l"
                   f" WHERE l.org_id='tcc' AND l.name={q(loc)};")
open(os.path.join(here, "../migrations/0021_supplies_seed.sql"), "w").write("\n".join(sql) + "\n")
print(f"{len(rows)} items · Workshop {ws_items} · each store {st_items} · Laundry Hub {hub_items} · to check: {sum(1 for r in rows if r['check'])}")
