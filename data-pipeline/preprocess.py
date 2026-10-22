"""
Preprocessing pipeline for the Warehouse Digital Twin (Hackathon Problem Statement 4.2).
Loads Online Retail II, cleans data, calculates pick frequencies for top 100 products,
and exports chronological picking trips to orders.json.
"""
from process_orders import main

if __name__ == "__main__":
    main()
