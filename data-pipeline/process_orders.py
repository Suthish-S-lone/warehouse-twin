"""
Warehouse Digital Twin Data Pipeline
Processes 'Online Retail II' dataset to extract top 100 picked products
and a chronological sequence of picking trips (orders) for simulation.
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
import pandas as pd


def get_excel_engine() -> str:
    """Detect the fastest available Excel reading engine."""
    try:
        import python_calamine  # noqa: F401
        return "calamine"
    except ImportError:
        return "openpyxl"


def find_dataset_file(specified_path: str = None) -> Path:
    """Find the dataset file across common locations."""
    if specified_path and os.path.exists(specified_path):
        return Path(specified_path)

    search_candidates = [
        Path("data-pipeline/online_retail_II.xlsx"),
        Path("online_retail_II.xlsx"),
        Path("../data-pipeline/online_retail_II.xlsx"),
        Path("data/online_retail_II.xlsx"),
    ]

    for candidate in search_candidates:
        if candidate.is_file():
            return candidate

    raise FileNotFoundError(
        "Could not find 'online_retail_II.xlsx'. "
        "Please provide the path using --input <path_to_excel_file>."
    )


def load_one_month_data(
    file_path: Path,
    year: int = 2009,
    month: int = 12,
    sheet_name: str | int = 0
) -> pd.DataFrame:
    """
    Loads data efficiently from Excel and filters down to exactly one month.
    """
    engine = get_excel_engine()
    print(f"[*] Reading dataset from '{file_path}' using '{engine}' engine...")
    t0 = time.time()

    required_cols = [
        "Invoice",
        "StockCode",
        "Description",
        "Quantity",
        "InvoiceDate",
        "Price",
        "Customer ID",
    ]

    df = pd.read_excel(
        file_path,
        sheet_name=sheet_name,
        usecols=required_cols,
        engine=engine
    )
    print(f"[+] Loaded {len(df):,} total rows in {time.time() - t0:.2f}s.")

    # Convert InvoiceDate to datetime
    print(f"[*] Filtering data for target month: {year}-{month:02d}...")
    df["InvoiceDate"] = pd.to_datetime(df["InvoiceDate"])

    # Filter to target month
    mask_month = (df["InvoiceDate"].dt.year == year) & (df["InvoiceDate"].dt.month == month)
    df_month = df[mask_month].copy()
    print(f"[+] Month {year}-{month:02d} contains {len(df_month):,} raw records.")

    return df_month


def clean_retail_data(df: pd.DataFrame) -> pd.DataFrame:
    """
    Clean the dataset according to strict warehouse simulation constraints:
    1. Filter out cancelled invoices (Invoice starts with 'C' or 'c').
    2. Remove non-positive quantities and zero/negative prices.
    3. Remove non-product codes (Postage, Manual adjustments, Carriage, Vouchers, etc.).
    """
    print("[*] Cleaning records and applying domain filters...")
    initial_count = len(df)

    # 1. Strip strings and filter out cancelled invoices
    df["Invoice"] = df["Invoice"].astype(str).str.strip()
    non_cancelled_mask = ~df["Invoice"].str.upper().str.startswith("C")
    df = df[non_cancelled_mask]

    # Filter out non-positive quantities and non-positive prices (returns, write-offs, damages)
    valid_qty_price = (df["Quantity"] > 0) & (df["Price"] > 0)
    df = df[valid_qty_price]

    # 2. Clean StockCode and Description
    df["StockCode"] = df["StockCode"].astype(str).str.strip()
    df["Description"] = df["Description"].fillna("").astype(str).str.strip()

    # Known non-product stock codes to explicitly drop
    known_non_products = {
        "POST", "DOT", "M", "D", "C2", "C3", "BANK CHARGES",
        "TEST001", "TEST002", "ADJUST", "ADJUST2", "AMAZONFEE",
        "CRUK", "PADS", "S", "B", "GIFT"
    }

    # Filter by known set and voucher prefixes
    not_known_non_product = (
        ~df["StockCode"].str.upper().isin(known_non_products) &
        ~df["StockCode"].str.lower().str.startswith("gift_")
    )
    df = df[not_known_non_product]

    # Real warehouse product codes in Online Retail follow standard format:
    # 5 digits followed optionally by 1-2 letters (e.g. '85123A', '22111', '79323LP')
    valid_product_pattern = re.compile(r"^\d{5}[a-zA-Z]*$")
    df = df[df["StockCode"].str.match(valid_product_pattern)]

    # Discard records with blank descriptions
    df = df[df["Description"] != ""]

    print(f"[+] Retained {len(df):,} valid product order lines ({initial_count - len(df):,} excluded).")
    return df


def extract_top_products_and_orders(df: pd.DataFrame, top_n: int = 100) -> tuple[list[dict], list[dict]]:
    """
    1. Calculates pick frequency for all items and isolates the top N products.
    2. Filters the chronological sequence of order lines for only those top N products.
    3. Groups lines into chronological picking trips (orders).
    """
    print(f"[*] Calculating pick frequency to identify top {top_n} products...")
    # Pick frequency = number of times an item was requested across order lines
    pick_counts = df["StockCode"].value_counts()
    top_n_counts = pick_counts.head(top_n)
    top_stock_codes = set(top_n_counts.index)

    # Compute summary metadata for each top product (canonical description and total quantity)
    # Mode of description handles slight catalog wording variations across invoices
    top_descriptions = (
        df[df["StockCode"].isin(top_stock_codes)]
        .groupby("StockCode")["Description"]
        .agg(lambda s: s.mode().iloc[0] if not s.empty else "")
        .to_dict()
    )
    total_quantities = (
        df[df["StockCode"].isin(top_stock_codes)]
        .groupby("StockCode")["Quantity"]
        .sum()
        .to_dict()
    )

    # Build top products list with frequencies
    products_list = []
    for rank, (code, freq) in enumerate(top_n_counts.items(), start=1):
        products_list.append({
            "rank": rank,
            "stock_code": str(code),
            "description": top_descriptions.get(code, ""),
            "pick_frequency": int(freq),
            "total_quantity_picked": int(total_quantities.get(code, 0)),
        })

    print(f"[+] Top product: {products_list[0]['stock_code']} ('{products_list[0]['description']}') with {products_list[0]['pick_frequency']} picks.")
    print(f"[+] #{top_n} product: {products_list[-1]['stock_code']} with {products_list[-1]['pick_frequency']} picks.")

    # Filter dataset for only top N products
    print(f"[*] Filtering order lines to top {top_n} products and sorting chronologically...")
    df_top = df[df["StockCode"].isin(top_stock_codes)].copy()

    # Sort in chronological sequence by InvoiceDate, then Invoice order
    df_top = df_top.sort_values(by=["InvoiceDate", "Invoice"])

    # Group into picking trips (orders) preserving chronological order
    orders_list = []
    for invoice_id, group in df_top.groupby("Invoice", sort=False):
        first_row = group.iloc[0]
        customer_id = (
            str(int(first_row["Customer ID"]))
            if pd.notna(first_row["Customer ID"])
            else None
        )

        trip_items = []
        for _, row in group.iterrows():
            trip_items.append({
                "stock_code": str(row["StockCode"]),
                "description": str(row["Description"]),
                "quantity": int(row["Quantity"]),
                "price": round(float(row["Price"]), 2),
            })

        orders_list.append({
            "order_id": str(invoice_id),
            "timestamp": first_row["InvoiceDate"].strftime("%Y-%m-%d %H:%M:%S"),
            "customer_id": customer_id,
            "item_count": len(trip_items),
            "total_quantity": sum(item["quantity"] for item in trip_items),
            "lines": trip_items,
        })

    print(f"[+] Extracted {len(orders_list):,} chronological picking trips containing {len(df_top):,} total order lines.")
    return products_list, orders_list


def export_orders_json(products: list[dict], orders: list[dict], output_path: str = "orders.json"):
    """
    Exports data to orders.json with root keys 'products' and 'orders'.
    """
    payload = {
        "metadata": {
            "dataset": "Online Retail II",
            "timeframe": "1 Month",
            "top_products_count": len(products),
            "picking_trips_count": len(orders),
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "products": products,
        "orders": orders,
    }

    out_file = Path(output_path)
    out_file.parent.mkdir(parents=True, exist_ok=True)

    print(f"[*] Exporting cleanly to '{output_path}'...")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    file_size_mb = out_file.stat().st_size / (1024 * 1024)
    print(f"[SUCCESS] Export completed: '{output_path}' ({file_size_mb:.2f} MB).")


def main():
    parser = argparse.ArgumentParser(
        description="Process Online Retail II dataset for Warehouse Digital Twin picking simulation."
    )
    parser.add_argument(
        "--input",
        type=str,
        default=None,
        help="Path to online_retail_II.xlsx (auto-detected if omitted)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="orders.json",
        help="Path for exported orders.json (default: orders.json)",
    )
    parser.add_argument(
        "--year",
        type=int,
        default=2009,
        help="Target year to process (default: 2009)",
    )
    parser.add_argument(
        "--month",
        type=int,
        default=12,
        help="Target month to process (default: 12)",
    )
    parser.add_argument(
        "--sheet",
        type=str,
        default="Year 2009-2010",
        help="Excel sheet name (default: 'Year 2009-2010')",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=100,
        help="Number of top products to isolate by pick frequency (default: 100)",
    )
    parser.add_argument(
        "--sync-frontend",
        action="store_true",
        default=True,
        help="Also write a copy to 3d-frontend/public/orders.json if the directory exists",
    )

    args = parser.parse_args()

    start_time = time.time()
    try:
        dataset_path = find_dataset_file(args.input)
    except FileNotFoundError as err:
        print(f"[ERROR] {err}", file=sys.stderr)
        sys.exit(1)

    # 1. Load one month of data
    df_raw = load_one_month_data(
        file_path=dataset_path,
        year=args.year,
        month=args.month,
        sheet_name=args.sheet,
    )

    # 2. Filter cancelled invoices and remove non-products
    df_clean = clean_retail_data(df_raw)

    # 3. Calculate pick frequencies & isolate top 100 & generate chronological trips
    products, orders = extract_top_products_and_orders(df_clean, top_n=args.top)

    # 4. Export to JSON
    export_orders_json(products, orders, output_path=args.output)

    # Also sync to 3d-frontend/public/orders.json if frontend directory exists
    if args.sync_frontend:
        frontend_public = Path("3d-frontend/public")
        if frontend_public.is_dir():
            frontend_dest = frontend_public / "orders.json"
            export_orders_json(products, orders, output_path=str(frontend_dest))

    total_duration = time.time() - start_time
    print(f"[+] Total execution time: {total_duration:.2f} seconds.")


if __name__ == "__main__":
    main()
