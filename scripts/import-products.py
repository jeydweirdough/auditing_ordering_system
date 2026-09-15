"""
Import and normalize product data from FollowPricesGetmeds.xlsx to data/products.json.
"""
import os
import re
import json
import openpyxl

EXCEL_PATH = r"C:\Users\Getmeds Backend\Downloads\FollowPricesGetmeds.xlsx"
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "products.json")

def clean_str(val):
    if val is None:
        return None
    s = str(val).strip()
    return s if s else None

def parse_price(val):
    if val is None:
        return None, None
    if isinstance(val, (int, float)):
        return float(round(val, 2)), None
    
    s = str(val).replace('₱', '').replace(',', '').strip()
    # Check if there are notes like "4500 +1 IV set" or "2800 + 1 IV set every 300mg"
    match = re.match(r"^([\d.]+)\s*(\+.*)$", s, re.IGNORECASE)
    if match:
        try:
            price = float(round(float(match.group(1)), 2))
            note = match.group(2).strip()
            return price, note
        except ValueError:
            pass

    try:
        return float(round(float(s), 2)), None
    except ValueError:
        return None, s

def slugify(text):
    text = re.sub(r'[^a-zA-Z0-9]+', '-', str(text).lower()).strip('-')
    return text

def main():
    if not os.path.exists(EXCEL_PATH):
        raise FileNotFoundError(f"Excel file not found at: {EXCEL_PATH}")

    wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)
    sheet = wb["Pricelist"]
    rows = list(sheet.iter_rows(values_only=True))

    products = []
    seen_ids = set()

    for row_idx, r in enumerate(rows[2:], start=3):
        if not any(r):
            continue

        account = clean_str(r[0])
        classification = clean_str(r[1])
        tax = clean_str(r[2])
        generic_name = clean_str(r[3])
        brand_name = clean_str(r[4])
        dosage_strength = clean_str(r[5])
        dosage_form = clean_str(r[6])
        unit = clean_str(r[7])
        pack_size = clean_str(r[8])
        mc = clean_str(r[9])
        count = r[10]
        if isinstance(count, (int, float)):
            count = int(count)
        else:
            count = None
        shelf_life = clean_str(r[11])

        doc_unit, doc_unit_note = parse_price(r[12])
        doc_pack, doc_pack_note = parse_price(r[13])

        pat_unit, pat_unit_note = parse_price(r[14])
        pat_pack, pat_pack_note = parse_price(r[15])

        srp_unit, srp_unit_note = parse_price(r[16])
        srp_pack, srp_pack_note = parse_price(r[17])

        dist_unit, dist_unit_note = parse_price(r[18])
        dist_pack, dist_pack_note = parse_price(r[19])
        dist_deals = clean_str(r[20])

        hosp_unit, hosp_unit_note = parse_price(r[21])
        hosp_pack, hosp_pack_note = parse_price(r[22])

        status_remark = clean_str(r[23]) if len(r) > 23 else None

        base_id = slugify(brand_name or generic_name or f"item-{row_idx}")
        item_id = base_id
        suffix = 2
        while item_id in seen_ids:
            item_id = f"{base_id}-{suffix}"
            suffix += 1
        seen_ids.add(item_id)

        display_name = brand_name if brand_name else generic_name
        if generic_name and brand_name and generic_name != brand_name:
            full_label = f"{brand_name} ({generic_name})"
        else:
            full_label = display_name
        if dosage_strength:
            full_label += f" {dosage_strength}"
        if pack_size:
            full_label += f" - {pack_size}"

        doc_notes = [n for n in [doc_unit_note, doc_pack_note] if n]
        dist_notes = [n for n in [dist_unit_note, dist_pack_note, dist_deals] if n]

        product = {
            "id": item_id,
            "row": row_idx,
            "account": account,
            "classification": classification,
            "tax": tax,
            "genericName": generic_name,
            "brandName": brand_name,
            "dosageStrength": dosage_strength,
            "dosageForm": dosage_form,
            "unit": unit,
            "packSize": pack_size,
            "mc": mc,
            "count": count,
            "shelfLife": shelf_life,
            "fullName": full_label,
            "prices": {
                "doctor": {
                    "unitPrice": doc_unit,
                    "packPrice": doc_pack,
                    "note": "; ".join(doc_notes) if doc_notes else None
                },
                "patient": {
                    "unitPrice": pat_unit,
                    "packPrice": pat_pack,
                    "note": None
                },
                "srp": {
                    "unitPrice": srp_unit,
                    "packPrice": srp_pack,
                    "note": None
                },
                "distributor": {
                    "unitPrice": dist_unit,
                    "packPrice": dist_pack,
                    "note": "; ".join(dist_notes) if dist_notes else None
                },
                "hospital": {
                    "unitPrice": hosp_unit,
                    "packPrice": hosp_pack,
                    "note": None
                }
            },
            "statusRemark": status_remark
        }
        products.append(product)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(products, f, indent=2, ensure_ascii=False)

    print(f"Successfully exported {len(products)} products to {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
