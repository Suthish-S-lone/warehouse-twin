# Development Log: NEXAI Warehouse Digital Twin
**Project**: Warehouse Digital Twin (Hackathon Problem Statement 4.2)  
**Author**: Solo Member  
**AI Assistant**: Antigravity (Google DeepMind)  
**Date**: October 2026  

---

## 1. Executive Log & Key Architectural Decisions

### 1.1 Strict A* Grid Pathfinding vs. Euclidean Distance
* **Decision**: Implement a 4-way orthogonal grid graph using the **A* (A-Star) search algorithm** with the Manhattan distance heuristic ($h(a, b) = |x_a - x_b| + |y_a - y_b|$).
* **Rationale**: In real warehouse logistics, physical pallet racks are impassable solid obstacles. A picker cannot walk through racking uprights or shelves.
* **Implementation Details**:
  - Grid dimensions: $22 \times 16$ cells ($1.6\text{ m/cell}$).
  - Solid storage racks are strictly marked as obstacles (`isRackCell(gx, gy) = true`).
  - Pick points are assigned to adjacent open aisles (left column picks from the left aisle, right column picks from the right aisle).
  - The pathfinder returns an exact sequence of aisle waypoints `[{x, y}, ...]`, and the 3D picker mesh lerps smoothly between them.
  - A distance memoization map (`getCachedDistance`) caches pairwise distances between rack pick points, enabling instant scoring without redundant graph traversal.

### 1.2 Layout Heuristic: Velocity-Based "Golden Zone" Slotting
* **Decision**: Formulate the automated baseline layout using a pure velocity-based slotting strategy.
* **Rationale**: Industrial engineering principles (Pareto principle / 80-20 rule) dictate that high-velocity SKUs (fast-movers) should be positioned at the nearest ergonomic locations relative to the drop-off / packing dock to minimize total picker travel distance.
* **Implementation Details**:
  - Computed the true A* walking distance from the Packing Dock ($X=10, Y=1$) to all 100 rack pick points.
  - Sorted the 100 rack slots in ascending order of dock distance.
  - Assigned Rank #1 SKU (`85123A`, 318 picks) to the closest slot (4.8 m), progressing sequentially to Rank #100 SKU (`21533`, 63 picks) in the furthest back slot (28.8 m).

### 1.3 High-Performance Data Preprocessing (`preprocess.py`)
* **Decision**: Preprocess raw multi-sheet Excel data offline using Pandas accelerated with the Rust-based `python-calamine` engine.
* **Rationale**: The raw `online_retail_II.xlsx` file contains over 525,000 rows and is ~45.6 MB. Standard Python `openpyxl` takes 60–90 seconds to parse and loads tens of megabytes into memory.
* **Results**:
  - `python-calamine` parsed the entire 525,461-row dataset in **5.46 seconds** (a >10x speedup).
  - Filtered one full calendar month (`2009-12`), sanitized cancellations (`C*`) and non-product service codes (`POST`, `DOT`, `M`, vouchers), and extracted 1,367 clean picking trips.
  - Outputted a lightweight, production-ready `orders.json` (1.79 MB) directly into the frontend's public directory.

### 1.4 Stretch Goal: Batch Picking & Nearest-Neighbor TSP Optimization
* **Decision**: Implement a Batch Picking routing engine that groups sequential orders into single multi-stop trips and optimizes the stop sequence using a **Nearest-Neighbor TSP (Traveling Salesperson Problem)** heuristic based on cached A* graph distances.
* **Rationale**: In single-order picking, pickers must return to the packing dock after fulfilling each individual customer order, resulting in 1,367 round-trips for 1,367 orders. Grouping orders into batches of 3 or 5 orders allows pickers to pick consolidated quantities in a single tour, eliminating redundant trips to the dock.
* **Results**:
  - Batch Size 3 reduces monthly walking distance by **~66.5%** (from 206.7 km to 69.3 km) and saves **~31.8 hours** of warehouse picker labor per month.
  - Batch Size 5 reduces monthly walking distance by **~76.1%** (down to 49.5 km) and saves **~36.4 hours** of labor per month.
  - Nearest-Neighbor TSP runs in $< 30\text{ ms}$ over the entire month's dataset using memoized A* distances, ensuring instant feedback whenever rack slots are swapped.

---

## 2. Experiments & Rejected Approaches

### 2.1 Rejection of Euclidean / Straight-Line Distance
* **Attempted Approach**: Computing picker trip distances using straight Euclidean geometry ($\sqrt{\Delta x^2 + \Delta y^2}$).
* **Why It Was Rejected**:
  1. Pickers cut diagonally straight through solid storage racks, yielding completely unrealistic walking paths.
  2. Travel distance was underestimated by **35% to 50%**, severely distorting the ROI calculation of the velocity-based layout.
* **Final Solution**: Enforced strict 4-directional A* grid pathfinding adhering strictly to aisles and cross-aisles.

### 2.2 Rejection of HTML5 Canvas Drag-and-Drop
* **Attempted Approach**: Standard HTML5 `draggable` DOM elements over 3D rack objects to move SKUs between slots.
* **Why It Was Rejected**:
  1. Pointer drag events conflicted directly with Three.js `OrbitControls`. Attempting to drag an item rotated the 3D scene camera instead.
  2. 3D raycasting drag-and-drop required complex invisible collision planes and suffered from pointer-lock issues on trackpads and mobile screens.
* **Final Solution**: Implemented a **3D Click-to-Swap** mechanic:
  - Clicking Rack $A$ activates a cyan glowing selection ring and tooltips.
  - Clicking Rack $B$ swaps the products cleanly and triggers an instant delta recalculation.
  - Added one-click layout presets (**Optimal Baseline**, **Randomized Chaotic**, and **Worst-Case Inverted**) for rapid benchmarking.

### 2.3 Rejection of Client-Side Raw Excel Parsing
* **Attempted Approach**: Parsing `online_retail_II.xlsx` directly in the browser using client-side JavaScript (`xlsx` / `SheetJS`).
* **Why It Was Rejected**:
  1. Parsing a 45 MB Excel spreadsheet in client JavaScript blocked the main browser thread for over 15 seconds, triggering unresponsive script warnings.
  2. Increased client bundle size and mobile memory footprint to over 400 MB.
* **Final Solution**: Decoupled the architecture: Python data engineering pipeline creates a normalized JSON contract (`orders.json`) that the browser fetches asynchronously in milliseconds.

### 2.4 Rejection of 8-Directional Diagonal Movement
* **Attempted Approach**: Allowing diagonal movements in A* (`dx: ±1, dy: ±1`).
* **Why It Was Rejected**: Diagonals caused the picker path line to visually slice through rack corner pillars at aisle intersections.
* **Final Solution**: Restricted path transitions strictly to 4 orthogonal cardinal directions ($N, S, E, W$).

---

## 3. Use of AI Assistance (Antigravity)

Throughout this project, **Antigravity** (Google DeepMind's agentic coding assistant) was utilized for pair programming:

1. **Pipeline Optimization & Data Hygiene**:
   - Designed robust regex filters (`r"^\d{5}[a-zA-Z]*$"`) to eliminate non-inventory codes (postage, shipping adjustments, bank fees, manual entries).
   - Integrated `python-calamine` to accelerate data ingestion speed by over 10x.
2. **Three.js / React Three Fiber Architecture**:
   - Scaffolded procedural warehouse geometry: 100 rack slots across 5 double-row bays, walking aisles, and cross-aisle safety lines.
   - Built the composite 3D picker mesh (chassis, wheels, rotating beacon, operator avatar in high-vis vest, dynamic cargo boxes).
   - Designed the glowing floor route ribbon using Three.js line geometries.
3. **Algorithm Implementation & Diagnostics**:
   - Implemented and verified the A* grid algorithm and Manhattan heuristic.
   - Conducted an automated diagnostic evaluation auditing all code paths against Hackathon Problem Statement 4.2 requirements.

---

## 4. Final Verification Summary

- [x] **Data Pipeline**: Successfully processes 525k records into top 100 SKUs and 1,367 clean orders.
- [x] **A* Pathfinding**: Strictly adheres to aisles; zero rack clipping.
- [x] **Scoring Engine**: Compares Baseline vs Custom layout on identical historical order lines.
- [x] **Interactive UI**: Real-time Tailwind CSS v4 dashboard, responsive 3D controls, and live efficiency metrics.
- [x] **Stretch Goal (Batch Picking & TSP Brain)**: 1-, 3-, and 5-order batching with Nearest-Neighbor TSP, 3-tier projected monthly savings panel, and dynamic multi-stop 3D AGV routing.
