# Engineering & Development Log: NEXAI Warehouse Digital Twin
**Project**: Warehouse Digital Twin: 3D Picking Floor Game (NEXAI Hackathon Problem Statement 4.2)  
**Author**: Suthish E (Solo Developer)  
**AI Pair Programmer**: Google Antigravity (Advanced Agentic Coding)  
**Repository**: [https://github.com/Suthish-S-lone/warehouse-twin](https://github.com/Suthish-S-lone/warehouse-twin)  
**Date**: October 2026  

---

## 1. Chronological Engineering Decisions & Architecture

### 1.1 Strict 4-Way Manhattan A* Pathfinding with O(1) Distance Memoization
* **Core Problem**: Realistic warehouse simulations cannot allow pickers to cut diagonally across storage racking. Pallet racks and shelving units are solid structural obstacles.
* **Engineering Decision**:
  - Implemented a discrete 2D grid graph ($22 \times 16$ cells, $1.6\text{ m/cell}$) using the **A* (A-Star) search algorithm** with 4-way orthogonal transitions ($N, S, E, W$).
  - Configured the Manhattan distance heuristic:
    $$h(a, b) = |x_a - x_b| + |y_a - y_b|$$
  - Every rack cell ($X \in \{2, 3, 6, 7, 10, 11, 14, 15, 18, 19\}$ for $Y \in [3..12]$) is flagged as an impassable obstacle (`isRackCell = true`).
  - **O(1) Memoization Engine**: To score 1,367 orders (9,543 order lines) without executing 15,000+ redundant graph searches, created a memoized path cache (`pathCache`). Pairwise distances between all 100 pick points and the packing dock are cached on first access.
  - **Performance Outcome**: Graph search overhead for full-month benchmarking dropped from $~650\text{ ms}$ on cold start to **$26.8\text{ ms}$ on warm runs**, enabling instant recalculation upon every user slot swap.

### 1.2 "Golden-Zone" Velocity Slotting Heuristic
* **Core Problem**: Establishing an objective, optimal baseline to benchmark player layouts.
* **Engineering Decision**:
  - Implemented the classical industrial engineering **Golden-Zone / Velocity Slotting** heuristic.
  - Computed the true A* aisle walking distance from the Packing Dock ($(X=10, Y=1)$) to every rack pick node.
  - Sorted all 100 rack slots in ascending order of dock distance ($4.8\text{ m}$ to $28.8\text{ m}$).
  - Assigned SKUs in order of pick hit frequency: Rank #1 (`85123A`, 318 picks) placed in the nearest bay slot, descending to Rank #100 (`21533`, 63 picks) in the furthest back slot.
  - **Empirical Result**: Yielded a **202.72 km** monthly distance benchmark, beating an unoptimized/chaotic layout (229.17 km) by **$-11.5\%$** and an inverted layout (239.78 km) by **$-15.5\%$**.

### 1.3 High-Performance Rust-Accelerated Pipeline (`preprocess.py`)
* **Core Problem**: The UCI `online_retail_II.xlsx` file contains 525,461 rows and is ~45.6 MB. Ingestion with standard `openpyxl` took 60–90 seconds and consumed over 350 MB of memory.
* **Engineering Decision**:
  - Integrated `python-calamine` (Rust-based Excel parser) into Pandas.
  - Automated cancellation filtering (`Invoice` starting with `'C'`), negative quantity/price removal, and service code stripping (`POST`, `DOT`, `M`, vouchers).
  - Isolated the 100 most frequently picked items and generated a chronological order line stream.
  - **Performance Outcome**: Ingested and cleaned 525k+ records in **5.46 seconds** (>10x faster), exporting a production-ready `orders.json` (1.79 MB).

---

## 2. Stretch Goals Implemented

### 2.1 Multi-Order Batch Picking with Nearest-Neighbor TSP
* **Concept**: Rather than returning to the packing dock after each order, group sequential orders ($1\times, 3\times, 5\times$) into a single consolidated picking tour.
* **Algorithmic Solution**:
  - Built a **Nearest-Neighbor TSP (Traveling Salesperson Problem)** heuristic solver:
    $$\text{Tour} = \text{Dock} \to \text{argmin}_{s \in \text{Unvisited}}[d_{\text{A*}}(\text{curr}, s)] \to \dots \to \text{Dock}$$
  - Consolidates all required product lines across the batch into unique rack stop coordinates.
  - Starting from the dock, the picker iteratively advances to the nearest unvisited pick node, picking all required items at that rack before moving forward.
* **Empirical Impact**:
  - **Batch 3x TSP**: Reduces monthly walking distance to **69.29 km** ($-65.8\%$ vs. Baseline Single, $-69.8\%$ vs. Chaotic), saving **30.89 hours** of labor per month.
  - **Batch 5x TSP**: Reduces monthly walking distance to **49.48 km** ($-75.6\%$ vs. Baseline Single, $-78.4\%$ vs. Chaotic), saving **35.47 hours** of labor per month.

### 2.2 Instant Full-Month In-Memory Benchmark
* **Concept**: Give players instant gratification when swapping slots rather than forcing them to watch hours of visual replay.
* **Algorithmic Solution**:
  - Created `calculateFullMonthMetrics()`: evaluates all 1,367 orders across Baseline (1x), Player Custom (1x), and Player Custom (Batched TSP) in memory.
  - Powered by the memoized A* cache, the entire 1,367-order benchmark executes in **$<30\text{ ms}$**, displaying live kilometers, labor hours, and percentage efficiency gain badges immediately upon slot swap.

### 2.3 Dynamic Pick Velocity Heatmap
* **Concept**: Instant visual intuition of warehouse layout efficiency.
* **Implementation**:
  - Racks dynamically render color-coded product bins based on pick frequency rank:
    - **High Velocity (Ranks 1–15)**: Hot Crimson (`#ef4444`)
    - **High-Medium Velocity (Ranks 16–35)**: Deep Orange (`#f97316`)
    - **Medium Velocity (Ranks 36–60)**: Amber / Yellow (`#eab308`)
    - **Moderate Velocity (Ranks 61–85)**: Emerald Green (`#10b981`)
    - **Low Velocity (Ranks 86–100)**: Cool Blue (`#3b82f6`)
  - When the layout is optimal, hot colors are concentrated near the front dock; chaotic layouts visibly scatter hot colors throughout back aisles.

---

## 3. AI Assistance Declaration (Google Antigravity)

During the development of this project, **Google Antigravity** (Google DeepMind's agentic pair-programmer) was utilized for pair programming:

1. **Pipeline Scaffolding & Regex Filtering**:
   - Collaborated with Antigravity to craft the regex filter (`r"^\d{5}[a-zA-Z]*$"`) and service code sanitization rules, correctly eliminating manual entries, test SKUs, and postage fees.
   - Designed the Calamine engine fallback loader to support both `calamine` and `openpyxl`.
2. **Three.js / React Three Fiber Scene Generation**:
   - Generated procedural warehouse geometry: 100 rack meshes with upper and lower shelves, walking aisles, cross-aisles, packing dock workstation, and the stylized AGV picker mesh (chassis, wheels, rotating beacon, operator avatar).
3. **Debugging the Multi-Waypoint `useFrame` State Machine**:
   - *Bug Encountered*: The initial batch animation stalled after reaching the first pick stop because React state interval updates fought with waypoint rendering loops.
   - *Antigravity Fix*: Re-architected the animation into a segmented route array (`currentTripSegments`) managed by an internal `useFrame` state machine (`AGVController`). Refs track segment progress and pick pauses, allowing the AGV to smoothly transition through multi-stop batch tours at 60 FPS without React re-render lag.
4. **Tailwind CSS v4 UI Overhaul**:
   - Designed the floating HUD and collapsible sidebars with `pointer-events-none` root overlay and `pointer-events-auto` cards, guaranteeing $>75\%$ unobstructed center 3D viewport clearance while keeping OrbitControls and rack clicking responsive.
5. **Architectural White Warehouse, Procedural Canvas Textures & Multi-Picker Fleet**:
   - *Aesthetic Elevation*: Replaced generic grey ground with an architectural white facility framed in dark steel I-beam trusses on a black void (`#050508`) with realistic volumetric depth fog.
   - *Zero-Asset Procedural Canvas Textures*: Implemented in-memory HTML5 2D canvas texture generators for corrugated cardboard boxes (with realistic shipping labels/barcodes), slatted wooden pallets, and safety hazard striping, guaranteeing instantaneous zero-network load times.
   - *Articulated Multi-Picker Fleet*: Added support for 1 to 3 concurrent pickers with articulated human worker meshes (hi-vis vest, hard hat, swinging arms/legs synchronized to velocity) pushing AGV carts.
   - *Aisle Congestion Yielding Engine*: Workers detect higher-priority colleagues within a $1.25\text{ cell}$ radius, entering a yielding state with flashing amber beacons, floating congestion badges, and live telemetry tracking.
   - *Zero-Cost Raycasting*: Bound `raycast={() => null}` to all building envelopes, walls, and trusses so mouse events pass directly to rack slots with 60 FPS silky smooth performance.

---

## 4. Experiments & Rejected Approaches

| Attempted Approach | Why It Failed / Was Rejected | Final Engineering Solution |
| :--- | :--- | :--- |
| **Euclidean Straight-Line Distance ($\sqrt{\Delta x^2 + \Delta y^2}$)** | Pickers walked diagonally straight through solid storage racks. Travel distances were underestimated by **$35\%\text{ to }50\%$**, severely distorting layout optimization metrics. | Enforced strict 4-way orthogonal A* grid pathfinding adhering strictly to aisles and cross-aisles. |
| **HTML5 Drag-and-Drop over WebGL Canvas** | HTML5 drag gestures conflicted with Three.js `OrbitControls` mouse events (dragging an item rotated the camera instead). Raycast dragging also caused pointer-lock glitches on trackpads. | Implemented **3D Raycast Click-to-Swap**: clicking Rack A activates a cyan glowing ring; clicking Rack B swaps items cleanly with instant benchmark recalculation. |
| **8-Directional Diagonal A* Movement** | Allowed diagonal movements ($dx: \pm 1, dy: \pm 1$). Resulted in visual route ribbons cutting across rack corner posts at aisle intersections. | Restricted pathfinding strictly to 4 cardinal directions ($N, S, E, W$). |
| **Client-Side Raw Excel Ingestion (SheetJS / xlsx)** | Parsing the 45.6 MB Excel file in browser JavaScript froze the main UI thread for $>15\text{ seconds}$ and pushed client memory beyond 400 MB. | Decoupled architecture: offline Python pipeline exports a normalized, lightweight `orders.json` (1.79 MB) loaded asynchronously in milliseconds. |
| **Full 2-Year Dataset Ingestion** | Ingesting all 1M+ rows caused browser memory bloat and slowed batch calculations. | Isolated one full representative calendar month (December 2009, 45,228 rows, 1,367 orders) providing robust statistical validity. |

---

## 5. Verification & Submission Sign-Off

- [x] **Data Pipeline**: Cleanly strips 1,429 invalid records, isolates top 100 SKUs, exports 1,367 orders to `orders.json`.
- [x] **A* Pathfinding**: Strictly adheres to aisles; zero rack clipping; green continuous floor ribbon.
- [x] **Procedural 3D Scene**: Spacious architectural white facility on a black void (`#050508`), 100 racks with procedural pallet bases and cardboard textures, walking aisles, and upgraded packing platform.
- [x] **Multi-Picker Fleet & Congestion**: 1–3 articulated pickers with high-vis vests and cart stacking, $<1.25\text{ cell}$ proximity collision avoidance, yielding state machine, and delay telemetry.
- [x] **Interactive Game Mode**: Click-to-Swap and one-click presets (**Optimal**, **Randomize**, **Invert**).
- [x] **Batch Picking & TSP Brain**: Multi-order consolidation with Nearest-Neighbor TSP routing.
- [x] **Instant Benchmark**: Evaluates all 1,367 orders across Baseline, Custom, and Batched TSP in $<30\text{ ms}$.
- [x] **UI/UX Clearance**: $>75\%$ unobstructed center 3D viewport with collapsible glassmorphic panels.
