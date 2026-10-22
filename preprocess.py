"""
Preprocessing pipeline for the Warehouse Digital Twin (Hackathon Problem Statement 4.2).
Loads Online Retail II, cleans data, calculates pick frequencies for top 100 products,
and exports chronological picking trips to orders.json.
"""
from pathlib import Path
import sys

# Ensure data-pipeline is in sys.path
pipeline_dir = Path(__file__).resolve().parent / "data-pipeline"
if str(pipeline_dir) not in sys.path:
    sys.path.insert(0, str(pipeline_dir))

from process_orders import main

if __name__ == "__main__":
    main()
