import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, Html } from '@react-three/drei';
import * as THREE from 'three';

// ==========================================
// 1. WAREHOUSE GRID CONSTANTS & GEOMETRY
// ==========================================
const GRID_W = 22; // X: 0 to 21
const GRID_H = 16; // Y: 0 to 15
const CELL_SIZE = 1.6; // Meters per grid cell
const DOCK_COORD = { x: 10, y: 1 }; // Front center packing dock node
const PICKER_SPEED = 3.2; // Virtual m/s for picker animation
const ITEM_PICK_TIME = 4.0; // Seconds to pick an item at rack
const HUMAN_WALK_SPEED = 1.2; // Real-world human picker walking speed (m/s)

// World coordinate helper: converts grid (x, y) to 3D (X, 0, Z) centered
const gridToWorld = (gx, gy, height = 0) => {
  const x = (gx - GRID_W / 2 + 0.5) * CELL_SIZE;
  const z = (gy - GRID_H / 2 + 0.5) * CELL_SIZE;
  return [x, height, z];
};

// Check if a grid coordinate is an obstacle (Rack)
// 5 Bays, each has 2 columns: [2,3], [6,7], [10,11], [14,15], [18,19]
// Racks run from Y = 3 to Y = 12 (10 slots per column -> 10 * 10 = 100 slots)
const isRackCell = (gx, gy) => {
  const rackCols = [2, 3, 6, 7, 10, 11, 14, 15, 18, 19];
  return rackCols.includes(gx) && gy >= 3 && gy <= 12;
};

// Generate 100 distinct rack slots with their assigned pick points in adjacent aisles
const generateWarehouseSlots = () => {
  const slots = [];
  const bays = [
    { leftCol: 2, rightCol: 3, leftAisle: 1, rightAisle: 4 },
    { leftCol: 6, rightCol: 7, leftAisle: 5, rightAisle: 8 },
    { leftCol: 10, rightCol: 11, leftAisle: 9, rightAisle: 12 },
    { leftCol: 14, rightCol: 15, leftAisle: 13, rightAisle: 16 },
    { leftCol: 18, rightCol: 19, leftAisle: 17, rightAisle: 20 },
  ];

  let id = 0;
  for (const bay of bays) {
    // Left column of the bay
    for (let gy = 3; gy <= 12; gy++) {
      slots.push({
        slotId: id++,
        rackX: bay.leftCol,
        rackY: gy,
        pickX: bay.leftAisle, // Picker stands in left aisle
        pickY: gy,
        bayName: `Bay ${bay.leftCol / 4 | 0}-L`,
      });
    }
    // Right column of the bay
    for (let gy = 3; gy <= 12; gy++) {
      slots.push({
        slotId: id++,
        rackX: bay.rightCol,
        rackY: gy,
        pickX: bay.rightAisle, // Picker stands in right aisle
        pickY: gy,
        bayName: `Bay ${bay.leftCol / 4 | 0}-R`,
      });
    }
  }
  return slots;
};

const WAREHOUSE_SLOTS = generateWarehouseSlots();

// ==========================================
// 2. STRICT A* (A-STAR) PATHFINDING ALGORITHM
// ==========================================
function findAStarPath(start, goal) {
  if (start.x === goal.x && start.y === goal.y) {
    return [{ x: start.x, y: start.y }];
  }

  const key = (x, y) => `${x},${y}`;
  const startKey = key(start.x, start.y);
  const goalKey = key(goal.x, goal.y);

  const openSet = new Set([startKey]);
  const cameFrom = new Map();

  const gScore = new Map();
  gScore.set(startKey, 0);

  const fScore = new Map();
  const manhattan = (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2);
  fScore.set(startKey, manhattan(start.x, start.y, goal.x, goal.y));

  const coords = new Map();
  coords.set(startKey, { x: start.x, y: start.y });
  coords.set(goalKey, { x: goal.x, y: goal.y });

  const neighbors = [
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
  ];

  while (openSet.size > 0) {
    let currentKey = null;
    let lowestF = Infinity;
    for (const k of openSet) {
      const f = fScore.get(k) ?? Infinity;
      if (f < lowestF) {
        lowestF = f;
        currentKey = k;
      }
    }

    if (currentKey === goalKey) {
      const path = [];
      let curr = currentKey;
      while (curr) {
        path.push(coords.get(curr));
        curr = cameFrom.get(curr);
      }
      path.reverse();
      return path;
    }

    openSet.delete(currentKey);
    const currCoord = coords.get(currentKey);

    for (const { dx, dy } of neighbors) {
      const nx = currCoord.x + dx;
      const ny = currCoord.y + dy;

      // Ensure inside grid boundaries
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;

      // Obstacle check: RACKS CANNOT BE WALKED THROUGH
      if (isRackCell(nx, ny)) continue;

      const neighborKey = key(nx, ny);
      if (!coords.has(neighborKey)) {
        coords.set(neighborKey, { x: nx, y: ny });
      }

      const tentativeG = (gScore.get(currentKey) ?? Infinity) + 1;
      if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
        cameFrom.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentativeG);
        fScore.set(neighborKey, tentativeG + manhattan(nx, ny, goal.x, goal.y));
        openSet.add(neighborKey);
      }
    }
  }

  // Fallback direct path if enclosed
  return [{ x: start.x, y: start.y }, { x: goal.x, y: goal.y }];
}

// Distance cache to avoid redundant path calculations during simulation scoring
const pathCache = new Map();
function getCachedDistance(p1, p2) {
  const k1 = `${p1.x},${p1.y}->${p2.x},${p2.y}`;
  if (pathCache.has(k1)) return pathCache.get(k1);
  const path = findAStarPath(p1, p2);
  const distMeters = Math.max(0, path.length - 1) * CELL_SIZE;
  pathCache.set(k1, distMeters);
  return distMeters;
}

// Color coding according to pick frequency / velocity
function getVelocityColor(rank) {
  if (rank <= 15) return '#ef4444'; // Top velocity: High-heat Red
  if (rank <= 35) return '#f97316'; // High velocity: Orange
  if (rank <= 60) return '#eab308'; // Medium velocity: Amber/Yellow
  if (rank <= 85) return '#10b981'; // Moderate: Emerald
  return '#3b82f6'; // Low velocity: Cool Blue
}

// ==========================================
// 3. 3D COMPONENTS (R3F)
// ==========================================

// Warehouse Floor with Walkable Aisles and Hazard Markings
function WarehouseFloor() {
  const floorWidth = GRID_W * CELL_SIZE;
  const floorDepth = GRID_H * CELL_SIZE;

  return (
    <group position={[0, -0.01, 0]}>
      {/* Main concrete floor slab */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[floorWidth + 4, floorDepth + 4]} />
        <meshStandardMaterial color="#0f172a" roughness={0.85} metalness={0.15} />
      </mesh>

      {/* Grid line texture overlay */}
      <gridHelper
        args={[Math.max(floorWidth, floorDepth) + 4, Math.max(GRID_W, GRID_H) + 2, '#334155', '#1e293b']}
        position={[0, 0.01, 0]}
      />

      {/* Cross-Aisle Safety Guide Lines */}
      {/* Front cross-aisle at Y=2 */}
      <mesh position={[0, 0.02, (2 - GRID_H / 2 + 0.5) * CELL_SIZE]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[floorWidth - 2, 0.15]} />
        <meshBasicMaterial color="#eab308" transparent opacity={0.6} />
      </mesh>
      {/* Back cross-aisle at Y=13 */}
      <mesh position={[0, 0.02, (13 - GRID_H / 2 + 0.5) * CELL_SIZE]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[floorWidth - 2, 0.15]} />
        <meshBasicMaterial color="#eab308" transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

// Packing & Shipping Dock
function PackingDock() {
  const [dx, dz] = [
    (DOCK_COORD.x - GRID_W / 2 + 0.5) * CELL_SIZE,
    (DOCK_COORD.y - GRID_H / 2 + 0.5) * CELL_SIZE,
  ];

  return (
    <group position={[dx, 0, dz - 1.2]}>
      {/* Hazard striped floor zone */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <planeGeometry args={[4.8, 2.2]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <planeGeometry args={[4.6, 2.0]} />
        <meshStandardMaterial color="#fbbf24" roughness={0.4} />
      </mesh>

      {/* Packing Station Work Bench */}
      <mesh position={[0, 0.55, -0.4]} castShadow receiveShadow>
        <boxGeometry args={[3.2, 0.9, 0.9]} />
        <meshStandardMaterial color="#334155" roughness={0.5} metalness={0.5} />
      </mesh>

      {/* Conveyor rollers */}
      <mesh position={[0, 0.6, 0.4]} castShadow>
        <boxGeometry args={[3.6, 0.4, 0.6]} />
        <meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.3} />
      </mesh>

      {/* Computer terminal screen */}
      <mesh position={[-0.8, 1.2, -0.4]} rotation={[0, 0.2, 0]}>
        <boxGeometry args={[0.5, 0.35, 0.05]} />
        <meshStandardMaterial color="#0284c7" emissive="#0284c7" emissiveIntensity={0.6} />
      </mesh>

      {/* Outbound shipping boxes on conveyor */}
      <mesh position={[0.6, 0.95, 0.4]} castShadow>
        <boxGeometry args={[0.45, 0.35, 0.45]} />
        <meshStandardMaterial color="#b45309" roughness={0.9} />
      </mesh>
      <mesh position={[-0.2, 0.9, 0.4]} castShadow>
        <boxGeometry args={[0.4, 0.3, 0.4]} />
        <meshStandardMaterial color="#d97706" roughness={0.9} />
      </mesh>

      {/* 3D Label */}
      <Text
        position={[0, 1.8, -0.4]}
        fontSize={0.4}
        color="#f8fafc"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor="#0f172a"
      >
        PACKING DOCK
      </Text>
    </group>
  );
}

// Individual Storage Rack with Shelves, Colored Bins, and Hover/Selection
function StorageRack({ slot, product, isSelected, isSwapTarget, onSelect, onHover }) {
  const [hovered, setHovered] = useState(false);
  const [wx, wy, wz] = gridToWorld(slot.rackX, slot.rackY, 0.85);

  const productRank = product ? product.rank : 999;
  const binColor = product ? getVelocityColor(productRank) : '#475569';

  return (
    <group
      position={[wx, wy, wz]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(slot.slotId);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        if (onHover) onHover(slot, product);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHovered(false);
        if (onHover) onHover(null, null);
      }}
    >
      {/* Upright metal storage rack frame */}
      <mesh castShadow receiveShadow position={[0, 0, 0]}>
        <boxGeometry args={[1.0, 1.7, 1.0]} />
        <meshStandardMaterial
          color={isSelected ? '#38bdf8' : isSwapTarget ? '#a855f7' : '#1e293b'}
          roughness={0.4}
          metalness={0.7}
          wireframe={false}
        />
      </mesh>

      {/* Internal product storage bins / boxes (Top & Bottom shelves) */}
      <mesh position={[0, 0.25, 0]} castShadow>
        <boxGeometry args={[0.82, 0.42, 0.82]} />
        <meshStandardMaterial
          color={binColor}
          emissive={isSelected ? '#38bdf8' : binColor}
          emissiveIntensity={isSelected ? 0.6 : hovered ? 0.4 : 0.15}
          roughness={0.4}
        />
      </mesh>
      <mesh position={[0, -0.32, 0]} castShadow>
        <boxGeometry args={[0.82, 0.42, 0.82]} />
        <meshStandardMaterial
          color={binColor}
          emissive={binColor}
          emissiveIntensity={hovered ? 0.3 : 0.1}
          roughness={0.4}
        />
      </mesh>

      {/* Selection Glow Indicator */}
      {isSelected && (
        <mesh position={[0, 1.05, 0]}>
          <ringGeometry args={[0.3, 0.55, 32]} />
          <meshBasicMaterial color="#38bdf8" side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Rank number label on top of rack */}
      {product && (
        <Text
          position={[0, 0.95, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={0.28}
          color="#ffffff"
          anchorX="center"
          anchorY="middle"
        >
          #{product.rank}
        </Text>
      )}

      {/* Floating HTML tooltip on hover */}
      {hovered && product && (
        <Html position={[0, 1.5, 0]} center distanceFactor={12}>
          <div className="bg-slate-900/95 text-white p-2.5 rounded-lg shadow-2xl border border-sky-500/50 pointer-events-none w-48 text-xs backdrop-blur-md">
            <div className="flex items-center justify-between font-bold text-sky-400">
              <span>Slot #{slot.slotId}</span>
              <span className="bg-sky-500/20 text-sky-300 px-1.5 py-0.5 rounded text-[10px]">
                Rank #{product.rank}
              </span>
            </div>
            <div className="mt-1 font-semibold text-slate-100 truncate">
              {product.stock_code}
            </div>
            <div className="text-slate-400 text-[11px] truncate" title={product.description}>
              {product.description}
            </div>
            <div className="mt-1.5 pt-1.5 border-t border-slate-800 flex justify-between text-slate-300">
              <span>Picks: <strong>{product.pick_frequency}</strong></span>
              <span>Dist: <strong>{slot.dockDistance?.toFixed(1) || '--'}m</strong></span>
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}

// Glowing neon A* path line on the floor
function ActivePathRibbon({ waypoints }) {
  const points = useMemo(() => {
    if (!waypoints || waypoints.length < 2) return [];
    return waypoints.map((wp) => {
      const [x, , z] = gridToWorld(wp.x, wp.y, 0.05);
      return new THREE.Vector3(x, 0.06, z);
    });
  }, [waypoints]);

  if (points.length < 2) return null;

  const lineGeo = new THREE.BufferGeometry().setFromPoints(points);

  return (
    <primitive object={new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: '#22c55e', linewidth: 3 }))} />
  );
}

// Stylized Animated 3D Warehouse Picker (Cart + Operator Avatar)
function AnimatedPicker({ currentPos, rotationAngle, carriedBoxCount }) {
  const beaconRef = useRef();

  useFrame((_, delta) => {
    if (beaconRef.current) {
      beaconRef.current.rotation.y += delta * 8;
    }
  });

  return (
    <group position={[currentPos[0], currentPos[1], currentPos[2]]} rotation={[0, rotationAngle, 0]}>
      {/* Mobile Cart Chassis */}
      <mesh position={[0, 0.22, 0]} castShadow>
        <boxGeometry args={[0.9, 0.22, 1.2]} />
        <meshStandardMaterial color="#0284c7" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Cart 4 Wheels */}
      {[-0.42, 0.42].map((x, i) =>
        [-0.45, 0.45].map((z, j) => (
          <mesh key={`${i}-${j}`} position={[x, 0.1, z]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.1, 0.1, 0.12, 16]} />
            <meshStandardMaterial color="#0f172a" />
          </mesh>
        ))
      )}

      {/* Cart Upright Handle and Order Display Terminal */}
      <mesh position={[0, 0.7, -0.5]} castShadow>
        <boxGeometry args={[0.7, 0.8, 0.06]} />
        <meshStandardMaterial color="#334155" metalness={0.8} />
      </mesh>
      <mesh position={[0, 1.05, -0.48]}>
        <boxGeometry args={[0.35, 0.22, 0.04]} />
        <meshStandardMaterial color="#38bdf8" emissive="#38bdf8" emissiveIntensity={0.8} />
      </mesh>

      {/* Rotating Amber Safety Beacon */}
      <group position={[0, 1.25, -0.5]} ref={beaconRef}>
        <mesh>
          <cylinderGeometry args={[0.07, 0.07, 0.14, 12]} />
          <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={1.2} />
        </mesh>
      </group>

      {/* Operator Avatar (Stylized Human with High-Vis Safety Vest & Helmet) */}
      <group position={[0, 0, -0.9]}>
        {/* Legs / Pants */}
        <mesh position={[-0.14, 0.45, 0]}>
          <cylinderGeometry args={[0.08, 0.08, 0.6, 12]} />
          <meshStandardMaterial color="#1e293b" />
        </mesh>
        <mesh position={[0.14, 0.45, 0]}>
          <cylinderGeometry args={[0.08, 0.08, 0.6, 12]} />
          <meshStandardMaterial color="#1e293b" />
        </mesh>
        {/* Torso with High-Vis Yellow Vest */}
        <mesh position={[0, 1.0, 0]} castShadow>
          <boxGeometry args={[0.42, 0.55, 0.26]} />
          <meshStandardMaterial color="#eab308" roughness={0.5} />
        </mesh>
        {/* Reflective silver stripes */}
        <mesh position={[0, 1.02, 0.14]}>
          <planeGeometry args={[0.38, 0.08]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
        {/* Head */}
        <mesh position={[0, 1.45, 0]} castShadow>
          <sphereGeometry args={[0.14, 16, 16]} />
          <meshStandardMaterial color="#fcd34d" roughness={0.8} />
        </mesh>
        {/* Safety Hard Hat / Helmet */}
        <mesh position={[0, 1.54, 0]}>
          <cylinderGeometry args={[0.18, 0.17, 0.1, 16]} />
          <meshStandardMaterial color="#ffffff" metalness={0.2} roughness={0.3} />
        </mesh>
      </group>

      {/* Picked Cargo Tote / Boxes dynamically loading onto cart */}
      <group position={[0, 0.42, 0.15]}>
        {Array.from({ length: Math.min(carriedBoxCount, 6) }).map((_, idx) => {
          const col = idx % 2;
          const row = Math.floor(idx / 2);
          return (
            <mesh
              key={idx}
              position={[(col - 0.5) * 0.32, 0.1 + row * 0.22, (row % 2 - 0.5) * 0.1]}
              castShadow
            >
              <boxGeometry args={[0.28, 0.2, 0.35]} />
              <meshStandardMaterial color="#b45309" roughness={0.9} />
            </mesh>
          );
        })}
      </group>
    </group>
  );
}

// Camera Manager for View Presets (Overview, Top-Down, Follow Picker)
function CameraController({ cameraMode, pickerPos }) {
  const controlsRef = useRef();

  useEffect(() => {
    if (!controlsRef.current) return;
    if (cameraMode === 'TOP') {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.object.position.set(0, 36, 0.1);
    } else if (cameraMode === 'PERSPECTIVE') {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.object.position.set(0, 24, 28);
    }
  }, [cameraMode]);

  useFrame(() => {
    if (cameraMode === 'FOLLOW' && controlsRef.current && pickerPos) {
      controlsRef.current.target.lerp(new THREE.Vector3(pickerPos[0], 0.5, pickerPos[2]), 0.08);
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      maxPolarAngle={cameraMode === 'TOP' ? 0.01 : Math.PI / 2.05}
      minDistance={6}
      maxDistance={65}
    />
  );
}

// ==========================================
// 4. MAIN APPLICATION COMPONENT
// ==========================================
export default function App() {
  // Raw Data State
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  // Layouts State: maps slotId -> Product Object
  const [baselineLayout, setBaselineLayout] = useState({});
  const [customLayout, setCustomLayout] = useState({});
  const [activeLayoutView, setActiveLayoutView] = useState('CUSTOM'); // 'BASELINE' | 'CUSTOM'

  // Interactive Swap State
  const [selectedSlotId, setSelectedSlotId] = useState(null);
  const [swapFeedback, setSwapFeedback] = useState(null);
  const [hoveredProduct, setHoveredProduct] = useState(null);

  // Camera preset
  const [cameraMode, setCameraMode] = useState('PERSPECTIVE'); // 'PERSPECTIVE' | 'TOP' | 'FOLLOW'

  // Simulation Controls & Engine State
  const [isPlaying, setIsPlaying] = useState(true);
  const [simSpeed, setSimSpeed] = useState(2); // 1x, 2x, 5x, 10x, 25x
  const [orderIndex, setOrderIndex] = useState(0);
  const [itemIndex, setItemIndex] = useState(0);

  // Live Cumulative Simulation Metrics for comparison
  const [baselineStats, setBaselineStats] = useState({
    distanceMeters: 0,
    totalSeconds: 0,
    ordersCompleted: 0,
    itemsPicked: 0,
  });

  const [customStats, setCustomStats] = useState({
    distanceMeters: 0,
    totalSeconds: 0,
    ordersCompleted: 0,
    itemsPicked: 0,
  });

  // 3D Animation Picker State
  const [pickerGridPos, setPickerGridPos] = useState({ x: DOCK_COORD.x, y: DOCK_COORD.y });
  const [pickerWorldPos, setPickerWorldPos] = useState(gridToWorld(DOCK_COORD.x, DOCK_COORD.y, 0));
  const [pickerAngle, setPickerAngle] = useState(0);
  const [activePathWaypoints, setActivePathWaypoints] = useState([]);
  const [currentWaypointIdx, setCurrentWaypointIdx] = useState(0);
  const [boxesOnCart, setBoxesOnCart] = useState(0);

  // Slots with precomputed dock distance
  const slotsWithDistances = useMemo(() => {
    return WAREHOUSE_SLOTS.map((slot) => {
      const dist = getCachedDistance(DOCK_COORD, { x: slot.pickX, y: slot.pickY });
      return { ...slot, dockDistance: dist };
    });
  }, []);

  // ----------------------------------------------------
  // Load orders.json on mount
  // ----------------------------------------------------
  useEffect(() => {
    fetch('/orders.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const prods = data.products || [];
        const ords = data.orders || [];
        setProducts(prods);
        setOrders(ords);

        // ----------------------------------------------------
        // Build Automatic Baseline Layout:
        // Fastest-moving items (lowest rank) slotted nearest to packing dock
        // ----------------------------------------------------
        const sortedSlots = [...slotsWithDistances].sort((a, b) => a.dockDistance - b.dockDistance);

        const baseMap = {};
        const custMap = {};

        sortedSlots.forEach((slot, idx) => {
          if (idx < prods.length) {
            baseMap[slot.slotId] = prods[idx];
            custMap[slot.slotId] = prods[idx]; // Initially clone baseline
          }
        });

        setBaselineLayout(baseMap);
        setCustomLayout(custMap);
        setDataLoaded(true);
      })
      .catch((err) => {
        console.error('Failed to load orders.json:', err);
        setErrorMsg('Failed to load orders.json from public directory.');
      });
  }, [slotsWithDistances]);

  // Lookup product to slot ID for current active layout
  const productToSlotMap = useMemo(() => {
    const layout = activeLayoutView === 'BASELINE' ? baselineLayout : customLayout;
    const map = new Map();
    for (const [slotId, prod] of Object.entries(layout)) {
      if (prod) map.set(prod.stock_code, parseInt(slotId, 10));
    }
    return map;
  }, [activeLayoutView, baselineLayout, customLayout]);

  // Reverse lookups for scoring both layouts concurrently
  const baselineProdToSlot = useMemo(() => {
    const map = new Map();
    for (const [slotId, prod] of Object.entries(baselineLayout)) {
      if (prod) map.set(prod.stock_code, parseInt(slotId, 10));
    }
    return map;
  }, [baselineLayout]);

  const customProdToSlot = useMemo(() => {
    const map = new Map();
    for (const [slotId, prod] of Object.entries(customLayout)) {
      if (prod) map.set(prod.stock_code, parseInt(slotId, 10));
    }
    return map;
  }, [customLayout]);

  // ----------------------------------------------------
  // Layout Management & Swap Game Mode
  // ----------------------------------------------------
  const handleSlotSelect = useCallback(
    (slotId) => {
      if (activeLayoutView !== 'CUSTOM') {
        setSwapFeedback({
          type: 'warning',
          text: 'Switch to Custom Layout view to swap slots!',
        });
        setTimeout(() => setSwapFeedback(null), 3000);
        return;
      }

      if (selectedSlotId === null) {
        // Select first slot
        setSelectedSlotId(slotId);
      } else if (selectedSlotId === slotId) {
        // Deselect
        setSelectedSlotId(null);
      } else {
        // Swap selectedSlotId with slotId
        setCustomLayout((prev) => {
          const updated = { ...prev };
          const prodA = updated[selectedSlotId];
          const prodB = updated[slotId];
          updated[selectedSlotId] = prodB;
          updated[slotId] = prodA;
          return updated;
        });

        const prodA = customLayout[selectedSlotId];
        const prodB = customLayout[slotId];
        setSwapFeedback({
          type: 'success',
          text: `Swapped Slot #${selectedSlotId} (${prodA?.stock_code || 'Empty'}) with Slot #${slotId} (${prodB?.stock_code || 'Empty'})!`,
        });
        setSelectedSlotId(null);
        setTimeout(() => setSwapFeedback(null), 3500);

        // Reset cumulative simulation to score newly swapped layout cleanly
        resetSimulation();
      }
    },
    [activeLayoutView, selectedSlotId, customLayout]
  );

  // Quick preset: Reset custom to optimal baseline
  const handleResetToBaseline = useCallback(() => {
    setCustomLayout({ ...baselineLayout });
    setSelectedSlotId(null);
    setSwapFeedback({ type: 'info', text: 'Reset custom layout to Optimal Baseline!' });
    resetSimulation();
    setTimeout(() => setSwapFeedback(null), 3000);
  }, [baselineLayout]);

  // Quick preset: Randomize layout (chaotic / unoptimized warehouse)
  const handleRandomizeLayout = useCallback(() => {
    const slotKeys = Object.keys(customLayout);
    const prodValues = Object.values(customLayout);
    // Fisher-Yates shuffle
    for (let i = prodValues.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [prodValues[i], prodValues[j]] = [prodValues[j], prodValues[i]];
    }
    const randomized = {};
    slotKeys.forEach((key, idx) => {
      randomized[key] = prodValues[idx];
    });
    setCustomLayout(randomized);
    setSelectedSlotId(null);
    setSwapFeedback({ type: 'info', text: 'Randomized rack layout (Simulating chaotic warehouse)!' });
    resetSimulation();
    setTimeout(() => setSwapFeedback(null), 3000);
  }, [customLayout]);

  // Quick preset: Inverted layout (Worst-case: fastest items furthest away)
  const handleInvertLayout = useCallback(() => {
    const sortedSlots = [...slotsWithDistances].sort((a, b) => b.dockDistance - a.dockDistance);
    const inverted = {};
    sortedSlots.forEach((slot, idx) => {
      if (idx < products.length) {
        inverted[slot.slotId] = products[idx];
      }
    });
    setCustomLayout(inverted);
    setSelectedSlotId(null);
    setSwapFeedback({ type: 'warning', text: 'Inverted layout: Fastest items placed furthest away!' });
    resetSimulation();
    setTimeout(() => setSwapFeedback(null), 3000);
  }, [slotsWithDistances, products]);

  // Reset simulation counters
  const resetSimulation = () => {
    setOrderIndex(0);
    setItemIndex(0);
    setBaselineStats({ distanceMeters: 0, totalSeconds: 0, ordersCompleted: 0, itemsPicked: 0 });
    setCustomStats({ distanceMeters: 0, totalSeconds: 0, ordersCompleted: 0, itemsPicked: 0 });
    setPickerGridPos({ x: DOCK_COORD.x, y: DOCK_COORD.y });
    setPickerWorldPos(gridToWorld(DOCK_COORD.x, DOCK_COORD.y, 0));
    setActivePathWaypoints([]);
    setCurrentWaypointIdx(0);
    setBoxesOnCart(0);
  };

  // ----------------------------------------------------
  // SIMULATION & PATH EXECUTION LOOP
  // ----------------------------------------------------
  useEffect(() => {
    if (!dataLoaded || orders.length === 0 || !isPlaying) return;

    const currentOrder = orders[orderIndex % orders.length];
    if (!currentOrder || !currentOrder.lines || currentOrder.lines.length === 0) return;

    let targetGridCoord;
    const isReturningToDock = itemIndex >= currentOrder.lines.length;

    if (isReturningToDock) {
      // Returning to Packing Dock to complete picking trip
      targetGridCoord = DOCK_COORD;
    } else {
      // Moving to next item rack pick point
      const currentLine = currentOrder.lines[itemIndex];
      const slotId = productToSlotMap.get(currentLine.stock_code);
      if (slotId !== undefined) {
        const slot = slotsWithDistances.find((s) => s.slotId === slotId);
        targetGridCoord = slot ? { x: slot.pickX, y: slot.pickY } : DOCK_COORD;
      } else {
        targetGridCoord = DOCK_COORD;
      }
    }

    // Compute A* Path from current picker grid pos to target
    const path = findAStarPath(pickerGridPos, targetGridCoord);
    setActivePathWaypoints(path);
    setCurrentWaypointIdx(0);
  }, [orderIndex, itemIndex, isPlaying, dataLoaded, orders, productToSlotMap, slotsWithDistances]);

  // Animation frame loop moving the picker through waypoints
  useEffect(() => {
    if (!isPlaying || activePathWaypoints.length < 2) return;

    const intervalTime = Math.max(16, 200 / simSpeed);
    const timer = setInterval(() => {
      setCurrentWaypointIdx((prevIdx) => {
        if (prevIdx < activePathWaypoints.length - 1) {
          const nextIdx = prevIdx + 1;
          const prevWp = activePathWaypoints[prevIdx];
          const nextWp = activePathWaypoints[nextIdx];

          // Compute angle of movement
          const dx = nextWp.x - prevWp.x;
          const dy = nextWp.y - prevWp.y;
          const angle = Math.atan2(dx, dy);

          setPickerAngle(angle);
          setPickerGridPos(nextWp);
          setPickerWorldPos(gridToWorld(nextWp.x, nextWp.y, 0));

          return nextIdx;
        } else {
          // Reached destination waypoint
          clearInterval(timer);
          onTargetReached();
          return prevIdx;
        }
      });
    }, intervalTime);

    return () => clearInterval(timer);
  }, [activePathWaypoints, isPlaying, simSpeed]);

  // When picker reaches an item or dock
  const onTargetReached = () => {
    const currentOrder = orders[orderIndex % orders.length];
    if (!currentOrder) return;

    const isReturningToDock = itemIndex >= currentOrder.lines.length;

    if (!isReturningToDock) {
      // Picked an item
      setBoxesOnCart((prev) => prev + 1);
      setItemIndex((prev) => prev + 1);
    } else {
      // Completed entire picking trip at dock! Score both layouts for this order.
      scoreCompletedOrder(currentOrder);
      setBoxesOnCart(0);
      setItemIndex(0);
      setOrderIndex((prev) => (prev + 1) % orders.length);
    }
  };

  // Replay & Score order lines identically across Baseline & Custom layouts
  const scoreCompletedOrder = (order) => {
    // 1. Calculate Baseline Trip Distance
    let baseDist = 0;
    let baseCurr = DOCK_COORD;
    for (const line of order.lines) {
      const sId = baselineProdToSlot.get(line.stock_code);
      if (sId !== undefined) {
        const slot = slotsWithDistances.find((s) => s.slotId === sId);
        if (slot) {
          const target = { x: slot.pickX, y: slot.pickY };
          baseDist += getCachedDistance(baseCurr, target);
          baseCurr = target;
        }
      }
    }
    baseDist += getCachedDistance(baseCurr, DOCK_COORD); // Return to dock
    const basePickSeconds = (baseDist / HUMAN_WALK_SPEED) + (order.lines.length * ITEM_PICK_TIME);

    // 2. Calculate Custom Trip Distance
    let custDist = 0;
    let custCurr = DOCK_COORD;
    for (const line of order.lines) {
      const sId = customProdToSlot.get(line.stock_code);
      if (sId !== undefined) {
        const slot = slotsWithDistances.find((s) => s.slotId === sId);
        if (slot) {
          const target = { x: slot.pickX, y: slot.pickY };
          custDist += getCachedDistance(custCurr, target);
          custCurr = target;
        }
      }
    }
    custDist += getCachedDistance(custCurr, DOCK_COORD); // Return to dock
    const custPickSeconds = (custDist / HUMAN_WALK_SPEED) + (order.lines.length * ITEM_PICK_TIME);

    setBaselineStats((prev) => ({
      distanceMeters: prev.distanceMeters + baseDist,
      totalSeconds: prev.totalSeconds + basePickSeconds,
      ordersCompleted: prev.ordersCompleted + 1,
      itemsPicked: prev.itemsPicked + order.lines.length,
    }));

    setCustomStats((prev) => ({
      distanceMeters: prev.distanceMeters + custDist,
      totalSeconds: prev.totalSeconds + custPickSeconds,
      ordersCompleted: prev.ordersCompleted + 1,
      itemsPicked: prev.itemsPicked + order.lines.length,
    }));
  };

  // Performance comparison metrics
  const activeLayoutMap = activeLayoutView === 'BASELINE' ? baselineLayout : customLayout;
  const currentOrder = orders[orderIndex % (orders.length || 1)];

  const baselineAvgTime =
    baselineStats.ordersCompleted > 0
      ? (baselineStats.totalSeconds / baselineStats.ordersCompleted).toFixed(1)
      : '0.0';
  const customAvgTime =
    customStats.ordersCompleted > 0
      ? (customStats.totalSeconds / customStats.ordersCompleted).toFixed(1)
      : '0.0';

  const distanceDeltaPct =
    baselineStats.distanceMeters > 0
      ? (
          ((customStats.distanceMeters - baselineStats.distanceMeters) /
            baselineStats.distanceMeters) *
          100
        ).toFixed(1)
      : '0.0';

  const timeDeltaPct =
    baselineStats.totalSeconds > 0
      ? (
          ((customStats.totalSeconds - baselineStats.totalSeconds) /
            baselineStats.totalSeconds) *
          100
        ).toFixed(1)
      : '0.0';

  if (errorMsg) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950 text-white p-6">
        <div className="bg-red-950/80 border border-red-500 p-6 rounded-xl max-w-lg text-center">
          <h2 className="text-xl font-bold text-red-400">Data Loading Error</h2>
          <p className="mt-2 text-sm text-red-200">{errorMsg}</p>
          <p className="mt-4 text-xs text-slate-400">
            Please run <code>python process_orders.py</code> to generate <code>orders.json</code> in <code>3d-frontend/public/</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 select-none">
      {/* ====================================================
          3D CANVAS SCENE (R3F)
      ==================================================== */}
      <Canvas
        shadows
        camera={{ position: [0, 24, 28], fov: 45 }}
        className="w-full h-full"
      >
        <ambientLight intensity={0.65} />
        <directionalLight
          position={[16, 32, 16]}
          intensity={1.2}
          castShadow
          shadow-mapSize={[2048, 2048]}
        />
        <pointLight position={[0, 15, 0]} intensity={0.5} />

        {/* Warehouse Floor */}
        <WarehouseFloor />

        {/* Packing Dock */}
        <PackingDock />

        {/* 100 Storage Racks */}
        {slotsWithDistances.map((slot) => {
          const prod = activeLayoutMap[slot.slotId];
          const isSelected = selectedSlotId === slot.slotId;
          return (
            <StorageRack
              key={slot.slotId}
              slot={slot}
              product={prod}
              isSelected={isSelected}
              isSwapTarget={selectedSlotId !== null && !isSelected}
              onSelect={handleSlotSelect}
              onHover={(_, p) => setHoveredProduct(p)}
            />
          );
        })}

        {/* Active A* Path Ribbon */}
        <ActivePathRibbon waypoints={activePathWaypoints} />

        {/* Animated 3D Picker Mesh */}
        <AnimatedPicker
          currentPos={pickerWorldPos}
          rotationAngle={pickerAngle}
          carriedBoxCount={boxesOnCart}
        />

        {/* Camera Control Presets */}
        <CameraController cameraMode={cameraMode} pickerPos={pickerWorldPos} />
      </Canvas>

      {/* ====================================================
          TOP NAVIGATION BAR & CONTROLS
      ==================================================== */}
      <header className="absolute top-0 left-0 right-0 p-4 flex flex-wrap items-center justify-between gap-3 pointer-events-none z-10">
        <div className="flex items-center gap-3 bg-slate-900/90 backdrop-blur-md px-4 py-2.5 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse" />
          <div>
            <h1 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
              NEXAI WAREHOUSE TWIN
              <span className="text-[10px] font-semibold bg-sky-500/20 text-sky-400 px-2 py-0.5 rounded border border-sky-500/30">
                100 SKU VELOCITY A*
              </span>
            </h1>
            <p className="text-[11px] text-slate-400">
              Online Retail II Dataset Replay • Dec 2009
            </p>
          </div>
        </div>

        {/* Camera View Switcher */}
        <div className="flex items-center gap-1 bg-slate-900/90 backdrop-blur-md p-1 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <button
            onClick={() => setCameraMode('PERSPECTIVE')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              cameraMode === 'PERSPECTIVE'
                ? 'bg-sky-500 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            3D View
          </button>
          <button
            onClick={() => setCameraMode('TOP')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              cameraMode === 'TOP'
                ? 'bg-sky-500 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Top Down
          </button>
          <button
            onClick={() => setCameraMode('FOLLOW')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              cameraMode === 'FOLLOW'
                ? 'bg-sky-500 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Follow Picker
          </button>
        </div>
      </header>

      {/* ====================================================
          SWAP TOAST FEEDBACK
      ==================================================== */}
      {swapFeedback && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 pointer-events-none transition-all">
          <div
            className={`px-4 py-2 rounded-xl text-xs font-medium shadow-2xl backdrop-blur-md border ${
              swapFeedback.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200'
                : swapFeedback.type === 'warning'
                ? 'bg-amber-950/90 border-amber-500 text-amber-200'
                : 'bg-sky-950/90 border-sky-500 text-sky-200'
            }`}
          >
            {swapFeedback.text}
          </div>
        </div>
      )}

      {/* ====================================================
          LEFT SIDEBAR: KPI BENCHMARK DASHBOARD
      ==================================================== */}
      <aside className="absolute top-20 left-4 w-84 flex flex-col gap-3 pointer-events-none z-10">
        {/* Layout Mode Toggle */}
        <div className="bg-slate-900/90 backdrop-blur-md p-3 rounded-2xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Active 3D Layout View
          </div>
          <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-950/80 rounded-xl border border-slate-800">
            <button
              onClick={() => setActiveLayoutView('BASELINE')}
              className={`py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                activeLayoutView === 'BASELINE'
                  ? 'bg-sky-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-sky-400" />
              Baseline (Dock-Near)
            </button>
            <button
              onClick={() => setActiveLayoutView('CUSTOM')}
              className={`py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                activeLayoutView === 'CUSTOM'
                  ? 'bg-purple-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-purple-400" />
              Player Custom
            </button>
          </div>
        </div>

        {/* Comparative KPI Scoreboard */}
        <div className="bg-slate-900/90 backdrop-blur-md p-4 rounded-2xl border border-slate-700/60 shadow-xl pointer-events-auto space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <h2 className="text-xs font-bold tracking-wider text-slate-300 uppercase">
              Scoring Engine (Live Replay)
            </h2>
            <span className="text-[10px] text-slate-400">
              Orders: <strong>{baselineStats.ordersCompleted}</strong>
            </span>
          </div>

          {/* Metric 1: Walking Distance */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-semibold">
              <span className="text-slate-400">Total Walking Distance:</span>
              <span
                className={`font-bold px-1.5 py-0.5 rounded text-[11px] ${
                  parseFloat(distanceDeltaPct) <= 0
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-red-500/20 text-red-300'
                }`}
              >
                {parseFloat(distanceDeltaPct) > 0 ? `+${distanceDeltaPct}%` : `${distanceDeltaPct}%`}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-slate-950/70 p-2 rounded-lg border border-sky-500/20">
                <div className="text-[10px] text-sky-400 font-medium">Baseline</div>
                <div className="text-base font-bold text-white mt-0.5">
                  {baselineStats.distanceMeters.toFixed(0)}{' '}
                  <span className="text-[10px] font-normal text-slate-400">m</span>
                </div>
              </div>
              <div className="bg-slate-950/70 p-2 rounded-lg border border-purple-500/20">
                <div className="text-[10px] text-purple-400 font-medium">Custom Layout</div>
                <div className="text-base font-bold text-white mt-0.5">
                  {customStats.distanceMeters.toFixed(0)}{' '}
                  <span className="text-[10px] font-normal text-slate-400">m</span>
                </div>
              </div>
            </div>
          </div>

          {/* Metric 2: Average Pick Time */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-semibold">
              <span className="text-slate-400">Avg Pick Time / Order:</span>
              <span
                className={`font-bold px-1.5 py-0.5 rounded text-[11px] ${
                  parseFloat(timeDeltaPct) <= 0
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-red-500/20 text-red-300'
                }`}
              >
                {parseFloat(timeDeltaPct) > 0 ? `+${timeDeltaPct}%` : `${timeDeltaPct}%`}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-slate-950/70 p-2 rounded-lg border border-sky-500/20">
                <div className="text-[10px] text-sky-400 font-medium">Baseline</div>
                <div className="text-base font-bold text-white mt-0.5">
                  {baselineAvgTime}{' '}
                  <span className="text-[10px] font-normal text-slate-400">sec</span>
                </div>
              </div>
              <div className="bg-slate-950/70 p-2 rounded-lg border border-purple-500/20">
                <div className="text-[10px] text-purple-400 font-medium">Custom Layout</div>
                <div className="text-base font-bold text-white mt-0.5">
                  {customAvgTime}{' '}
                  <span className="text-[10px] font-normal text-slate-400">sec</span>
                </div>
              </div>
            </div>
          </div>

          {/* Efficiency verdict tag */}
          <div className="pt-1 text-center">
            {parseFloat(distanceDeltaPct) <= 0 ? (
              <div className="text-[11px] text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 p-1.5 rounded-lg">
                ★ Custom layout matches/beats baseline efficiency!
              </div>
            ) : (
              <div className="text-[11px] text-amber-300 bg-amber-950/40 border border-amber-500/30 p-1.5 rounded-lg">
                ▲ Baseline is {distanceDeltaPct}% faster. Re-slot fast SKUs near dock!
              </div>
            )}
          </div>
        </div>

        {/* Game Mode: Slotting Presets & Instructions */}
        <div className="bg-slate-900/90 backdrop-blur-md p-4 rounded-2xl border border-slate-700/60 shadow-xl pointer-events-auto space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold tracking-wider text-slate-300 uppercase">
              Slotting Game Mode
            </h3>
            {selectedSlotId !== null && (
              <button
                onClick={() => setSelectedSlotId(null)}
                className="text-[10px] text-red-400 hover:underline"
              >
                Cancel Selection
              </button>
            )}
          </div>

          <p className="text-[11px] text-slate-400 leading-relaxed">
            {selectedSlotId === null ? (
              <>
                Click any <strong>rack</strong> to select, then click another rack to{' '}
                <strong className="text-purple-400">swap product slots</strong>!
              </>
            ) : (
              <span className="text-sky-300 font-medium">
                Slot #{selectedSlotId} selected. Click another rack to swap!
              </span>
            )}
          </p>

          <div className="grid grid-cols-3 gap-1.5 pt-1">
            <button
              onClick={handleResetToBaseline}
              className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-semibold transition border border-slate-700"
              title="Slot top velocity products nearest the dock"
            >
              Optimal
            </button>
            <button
              onClick={handleRandomizeLayout}
              className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-semibold transition border border-slate-700"
              title="Randomize product slots"
            >
              Randomize
            </button>
            <button
              onClick={handleInvertLayout}
              className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-semibold transition border border-slate-700"
              title="Worst case layout"
            >
              Invert (Worst)
            </button>
          </div>
        </div>

        {/* Heatmap Legend */}
        <div className="bg-slate-900/90 backdrop-blur-md p-3 rounded-2xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <div className="text-[10px] font-semibold text-slate-400 mb-1.5 uppercase">
            Pick Frequency Heatmap
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-slate-300">
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#ef4444]" />
              <span>Top 15</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#f97316]" />
              <span>16-35</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#eab308]" />
              <span>36-60</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#10b981]" />
              <span>61-85</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#3b82f6]" />
              <span>86-100</span>
            </div>
          </div>
        </div>
      </aside>

      {/* ====================================================
          RIGHT SIDEBAR: CURRENT ORDER & HOVER DETAILS
      ==================================================== */}
      <aside className="absolute top-20 right-4 w-76 flex flex-col gap-3 pointer-events-none z-10">
        {/* Live Active Order Trip Card */}
        {currentOrder && (
          <div className="bg-slate-900/90 backdrop-blur-md p-4 rounded-2xl border border-slate-700/60 shadow-xl pointer-events-auto space-y-2">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="text-[11px] font-bold text-sky-400 uppercase tracking-wide">
                Picking Trip: #{currentOrder.order_id}
              </span>
              <span className="text-[10px] text-slate-400">
                Line {Math.min(itemIndex + 1, currentOrder.lines.length)} / {currentOrder.lines.length}
              </span>
            </div>

            <div className="text-xs text-slate-300">
              <div className="text-[10px] text-slate-500">Timestamp</div>
              <div className="font-mono text-[11px] text-slate-200">{currentOrder.timestamp}</div>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] text-slate-500">Current Target SKU</div>
              {itemIndex < currentOrder.lines.length ? (
                <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800">
                  <div className="font-bold text-sky-300 text-xs">
                    {currentOrder.lines[itemIndex].stock_code}
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {currentOrder.lines[itemIndex].description}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    Qty: <strong>{currentOrder.lines[itemIndex].quantity}</strong> units
                  </div>
                </div>
              ) : (
                <div className="bg-emerald-950/40 p-2 rounded-lg border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  Returning to Packing Dock...
                </div>
              )}
            </div>
          </div>
        )}

        {/* Selected / Hovered Product Card */}
        {hoveredProduct && (
          <div className="bg-slate-900/90 backdrop-blur-md p-4 rounded-2xl border border-slate-700/60 shadow-xl pointer-events-auto space-y-1.5">
            <div className="flex justify-between items-center text-xs font-bold text-white">
              <span>{hoveredProduct.stock_code}</span>
              <span className="text-[10px] bg-sky-500/20 text-sky-300 px-1.5 py-0.5 rounded">
                Rank #{hoveredProduct.rank}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-snug">
              {hoveredProduct.description}
            </p>
            <div className="pt-2 border-t border-slate-800 grid grid-cols-2 gap-2 text-xs text-slate-300">
              <div>
                <span className="text-[10px] text-slate-500 block">Pick Frequency</span>
                <strong>{hoveredProduct.pick_frequency}</strong> picks
              </div>
              <div>
                <span className="text-[10px] text-slate-500 block">Total Qty</span>
                <strong>{hoveredProduct.total_quantity_picked}</strong> pcs
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* ====================================================
          BOTTOM CONTROLLER: SIMULATION PLAYBACK
      ==================================================== */}
      <footer className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-slate-900/95 backdrop-blur-md px-5 py-2.5 rounded-2xl border border-slate-700/70 shadow-2xl pointer-events-auto z-10">
        {/* Play / Pause */}
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          className={`px-4 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-2 ${
            isPlaying
              ? 'bg-amber-600 hover:bg-amber-500 text-white shadow'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow'
          }`}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play Replay'}
        </button>

        {/* Simulation Speed */}
        <div className="flex items-center gap-1 border-l border-r border-slate-800 px-3">
          <span className="text-[10px] text-slate-400 font-semibold mr-1">Speed:</span>
          {[1, 2, 5, 10, 25].map((spd) => (
            <button
              key={spd}
              onClick={() => setSimSpeed(spd)}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition ${
                simSpeed === spd
                  ? 'bg-sky-500 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {spd}x
            </button>
          ))}
        </div>

        {/* Step Next Order */}
        <button
          onClick={() => {
            setOrderIndex((prev) => (prev + 1) % orders.length);
            setItemIndex(0);
          }}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
        >
          ⏭ Next Order
        </button>

        {/* Reset */}
        <button
          onClick={resetSimulation}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
        >
          ↺ Reset Stats
        </button>
      </footer>
    </div>
  );
}
