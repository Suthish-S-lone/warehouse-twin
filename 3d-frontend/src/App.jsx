import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, Html } from '@react-three/drei';
import * as THREE from 'three';

// ==========================================
// 1. WAREHOUSE GRID CONSTANTS & GEOMETRY
// ==========================================
const GRID_W = 22; // X: 0 to 21
const GRID_H = 16; // Y: 0 to 15
const CELL_SIZE = 2.2; // Spatial visual scale multiplier for spacious 2-lane aisles
const DOCK_COORD = { x: 10, y: 1 }; // Front center packing dock node
const PICKER_SPEED = 3.8; // Virtual m/s base speed for picker movement
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
    { bayIdx: 0, leftCol: 2, rightCol: 3, leftAisle: 1, rightAisle: 4 },
    { bayIdx: 1, leftCol: 6, rightCol: 7, leftAisle: 5, rightAisle: 8 },
    { bayIdx: 2, leftCol: 10, rightCol: 11, leftAisle: 9, rightAisle: 12 },
    { bayIdx: 3, leftCol: 14, rightCol: 15, leftAisle: 13, rightAisle: 16 },
    { bayIdx: 4, leftCol: 18, rightCol: 19, leftAisle: 17, rightAisle: 20 },
  ];

  let id = 0;
  for (const bay of bays) {
    for (let gy = 3; gy <= 12; gy++) {
      slots.push({
        slotId: id++,
        rackX: bay.leftCol,
        rackY: gy,
        pickX: bay.leftAisle,
        pickY: gy,
        bayName: `Bay ${bay.bayIdx}-L`,
      });
    }
    for (let gy = 3; gy <= 12; gy++) {
      slots.push({
        slotId: id++,
        rackX: bay.rightCol,
        rackY: gy,
        pickX: bay.rightAisle,
        pickY: gy,
        bayName: `Bay ${bay.bayIdx}-R`,
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

      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
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

  return [{ x: start.x, y: start.y }, { x: goal.x, y: goal.y }];
}

const pathCache = new Map();
function getCachedDistance(p1, p2) {
  const k1 = `${p1.x},${p1.y}->${p2.x},${p2.y}`;
  if (pathCache.has(k1)) return pathCache.get(k1);
  const path = findAStarPath(p1, p2);
  const distMeters = Math.max(0, path.length - 1) * CELL_SIZE;
  pathCache.set(k1, distMeters);
  return distMeters;
}

function getVelocityLEDColor(rank) {
  if (rank <= 35) return '#ef4444'; // Red LED (Rank 1-35)
  if (rank <= 60) return '#f59e0b'; // Amber LED (Rank 36-60)
  return '#10b981'; // Emerald LED (Rank 61-100)
}

// ==========================================
// 3. BATCH ROUTING ENGINE: NEAREST-NEIGHBOR TSP
// ==========================================
function solveNearestNeighborTSP(startNode, stops, getDistance) {
  if (stops.length <= 1) return stops;

  const unvisited = [...stops];
  const route = [];
  let current = startNode;

  while (unvisited.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < unvisited.length; i++) {
      const candidate = unvisited[i];
      const dist = getDistance(current, { x: candidate.pickX, y: candidate.pickY });
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }

    const nextStop = unvisited.splice(nearestIdx, 1)[0];
    route.push(nextStop);
    current = { x: nextStop.pickX, y: nextStop.pickY };
  }

  return route;
}

function calculateFullMonthMetrics(allOrders, prodToSlot, slots, batchSize, getDistance) {
  if (!allOrders || allOrders.length === 0) {
    return { distanceM: 0, distanceKm: '0.0', timeSec: 0, timeHours: '0.0', tripsCount: 0, totalLines: 0 };
  }

  let totalDistance = 0;
  let totalLines = 0;
  const numOrders = allOrders.length;
  const tripsCount = Math.ceil(numOrders / batchSize);

  for (let i = 0; i < numOrders; i += batchSize) {
    const batch = allOrders.slice(i, i + batchSize);
    const uniqueSlotMap = new Map();

    for (const ord of batch) {
      totalLines += ord.lines.length;
      for (const line of ord.lines) {
        const sId = prodToSlot.get(line.stock_code);
        if (sId !== undefined && !uniqueSlotMap.has(sId)) {
          const slot = slots[sId];
          if (slot) uniqueSlotMap.set(sId, slot);
        }
      }
    }

    const stops = Array.from(uniqueSlotMap.values());
    if (batchSize === 1) {
      let curr = DOCK_COORD;
      for (const stop of stops) {
        totalDistance += getDistance(curr, { x: stop.pickX, y: stop.pickY });
        curr = { x: stop.pickX, y: stop.pickY };
      }
      totalDistance += getDistance(curr, DOCK_COORD);
    } else {
      const tspRoute = solveNearestNeighborTSP(DOCK_COORD, stops, getDistance);
      let curr = DOCK_COORD;
      for (const stop of tspRoute) {
        totalDistance += getDistance(curr, { x: stop.pickX, y: stop.pickY });
        curr = { x: stop.pickX, y: stop.pickY };
      }
      totalDistance += getDistance(curr, DOCK_COORD);
    }
  }

  const walkingTimeSec = totalDistance / HUMAN_WALK_SPEED;
  const pickingTimeSec = totalLines * ITEM_PICK_TIME;
  const totalTimeSec = walkingTimeSec + pickingTimeSec;

  return {
    distanceM: totalDistance,
    distanceKm: (totalDistance / 1000).toFixed(1),
    timeSec: totalTimeSec,
    timeHours: (totalTimeSec / 3600).toFixed(1),
    tripsCount,
    totalLines,
  };
}

// ==========================================
// 4. PROCEDURAL TEXTURES (ZERO EXTERNAL IMAGES)
// ==========================================
function useProceduralTextures() {
  return useMemo(() => {
    // 1. Corrugated Cardboard Texture
    const boxCanvas = document.createElement('canvas');
    boxCanvas.width = 256;
    boxCanvas.height = 256;
    const bCtx = boxCanvas.getContext('2d');
    bCtx.fillStyle = '#c89666';
    bCtx.fillRect(0, 0, 256, 256);

    // Subtle cardboard grain
    bCtx.fillStyle = 'rgba(160, 110, 65, 0.18)';
    for (let y = 0; y < 256; y += 4) {
      bCtx.fillRect(0, y, 256, 1.5);
    }

    // Seam borders
    bCtx.strokeStyle = '#6e451b';
    bCtx.lineWidth = 3;
    bCtx.strokeRect(3, 3, 250, 250);
    bCtx.beginPath();
    bCtx.moveTo(128, 3);
    bCtx.lineTo(128, 253);
    bCtx.stroke();

    // Packing tape
    bCtx.fillStyle = 'rgba(215, 175, 120, 0.75)';
    bCtx.fillRect(114, 0, 28, 256);

    // Shipping barcode label
    bCtx.fillStyle = '#ffffff';
    bCtx.fillRect(20, 26, 84, 52);
    bCtx.fillStyle = '#0f172a';
    bCtx.font = 'bold 8px monospace';
    bCtx.fillText('NEXAI LOGISTICS', 24, 38);
    for (let x = 24; x < 98; x += 3) {
      if (x % 7 !== 0) bCtx.fillRect(x, 42, x % 5 === 0 ? 2 : 1, 28);
    }
    bCtx.strokeStyle = '#ef4444';
    bCtx.lineWidth = 1.5;
    bCtx.strokeRect(70, 30, 28, 12);
    bCtx.fillStyle = '#ef4444';
    bCtx.font = 'bold 7px sans-serif';
    bCtx.fillText('PRIORITY', 72, 39);

    const boxTexture = new THREE.CanvasTexture(boxCanvas);
    boxTexture.wrapS = THREE.RepeatWrapping;
    boxTexture.wrapT = THREE.RepeatWrapping;

    // 2. Wooden Pallet Texture
    const palletCanvas = document.createElement('canvas');
    palletCanvas.width = 256;
    palletCanvas.height = 256;
    const pCtx = palletCanvas.getContext('2d');
    pCtx.fillStyle = '#5c2d16'; // Dark wood recessed gaps
    pCtx.fillRect(0, 0, 256, 256);

    const slatH = 44;
    const gap = 8;
    for (let i = 0; i < 5; i++) {
      const y = i * (slatH + gap) + 4;
      pCtx.fillStyle = i % 2 === 0 ? '#b45309' : '#9a3412';
      pCtx.fillRect(4, y, 248, slatH);
      pCtx.fillStyle = 'rgba(67, 20, 7, 0.25)';
      for (let gx = 0; gx < 248; gx += 10) {
        pCtx.fillRect(gx + 4, y, 2, slatH);
      }
      pCtx.fillStyle = '#1e293b';
      pCtx.beginPath();
      pCtx.arc(16, y + slatH / 2, 2.5, 0, Math.PI * 2);
      pCtx.arc(128, y + slatH / 2, 2.5, 0, Math.PI * 2);
      pCtx.arc(240, y + slatH / 2, 2.5, 0, Math.PI * 2);
      pCtx.fill();
    }

    const palletTexture = new THREE.CanvasTexture(palletCanvas);
    palletTexture.wrapS = THREE.RepeatWrapping;
    palletTexture.wrapT = THREE.RepeatWrapping;

    // 3. Hazard Striped Texture
    const hazardCanvas = document.createElement('canvas');
    hazardCanvas.width = 128;
    hazardCanvas.height = 128;
    const hCtx = hazardCanvas.getContext('2d');
    hCtx.fillStyle = '#0f172a';
    hCtx.fillRect(0, 0, 128, 128);
    hCtx.fillStyle = '#f59e0b';
    for (let i = -128; i < 256; i += 32) {
      hCtx.beginPath();
      hCtx.moveTo(i, 0);
      hCtx.lineTo(i + 16, 0);
      hCtx.lineTo(i + 16 + 128, 128);
      hCtx.lineTo(i + 128, 128);
      hCtx.closePath();
      hCtx.fill();
    }

    const hazardTexture = new THREE.CanvasTexture(hazardCanvas);
    hazardTexture.wrapS = THREE.RepeatWrapping;
    hazardTexture.wrapT = THREE.RepeatWrapping;
    hazardTexture.repeat.set(6, 1);

    return { boxTexture, palletTexture, hazardTexture };
  }, []);
}

// ==========================================
// 5. ARCHITECTURAL BUILDING & ENVIRONMENT (RAYCAST=NULL)
// ==========================================
function ArchitecturalWarehouse({ textures }) {
  const floorWidth = GRID_W * CELL_SIZE;
  const floorDepth = GRID_H * CELL_SIZE;

  // Shared geometry & materials memoized once
  const wallMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.9, metalness: 0.05 }),
    []
  );
  const steelMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.4, metalness: 0.8 }),
    []
  );
  const curbMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.8 }),
    []
  );

  return (
    <group position={[0, 0, 0]} raycast={() => null}>
      {/* 1. Crisp White Concrete Architectural Floor Slab */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow raycast={() => null}>
        <planeGeometry args={[floorWidth + 10, floorDepth + 10]} />
        <meshStandardMaterial color="#f1f5f9" roughness={0.85} metalness={0.12} />
      </mesh>

      {/* Grid overlay for aesthetic floor tile lines */}
      <gridHelper
        args={[Math.max(floorWidth, floorDepth) + 10, Math.max(GRID_W, GRID_H) + 4, '#cbd5e1', '#e2e8f0']}
        position={[0, 0.005, 0]}
        raycast={() => null}
      />

      {/* Yellow Safety Aisle Walk-Lane Borders */}
      {/* Front cross-aisle (Y=2) */}
      <mesh
        position={[0, 0.012, (2 - GRID_H / 2 + 0.5) * CELL_SIZE]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => null}
      >
        <planeGeometry args={[floorWidth + 4, 0.16]} />
        <meshBasicMaterial color="#f59e0b" />
      </mesh>
      {/* Back cross-aisle (Y=13) */}
      <mesh
        position={[0, 0.012, (13 - GRID_H / 2 + 0.5) * CELL_SIZE]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => null}
      >
        <planeGeometry args={[floorWidth + 4, 0.16]} />
        <meshBasicMaterial color="#f59e0b" />
      </mesh>

      {/* Painted Bay Numbers on Floor (Front entrance of each bay) */}
      {[0, 1, 2, 3, 4].map((bayIdx) => {
        const bayAisleX = bayIdx * 4 + 2.5;
        const [wx, , wz] = gridToWorld(bayAisleX, 1.8, 0.015);
        return (
          <Text
            key={bayIdx}
            position={[wx, 0.02, wz]}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={0.65}
            color="#94a3b8"
            anchorX="center"
            anchorY="middle"
            raycast={() => null}
          >
            {`BAY ${bayIdx}`}
          </Text>
        );
      })}

      {/* 2. Cutaway Tilt-Up Concrete Perimeter Walls (Height = 6.5m) */}
      {/* Back Wall (Y = 14.5) */}
      <mesh
        position={[0, 3.25, (14.5 - GRID_H / 2 + 0.5) * CELL_SIZE]}
        material={wallMat}
        receiveShadow
        raycast={() => null}
      >
        <boxGeometry args={[floorWidth + 8, 6.5, 0.5]} />
      </mesh>

      {/* Left Wall (X = -0.8) */}
      <mesh
        position={[(-0.8 - GRID_W / 2 + 0.5) * CELL_SIZE, 3.25, 0]}
        material={wallMat}
        receiveShadow
        raycast={() => null}
      >
        <boxGeometry args={[0.5, 6.5, floorDepth + 8]} />
      </mesh>

      {/* Right Wall (X = 22.8) */}
      <mesh
        position={[(22.8 - GRID_W / 2 + 0.5) * CELL_SIZE, 3.25, 0]}
        material={wallMat}
        receiveShadow
        raycast={() => null}
      >
        <boxGeometry args={[0.5, 6.5, floorDepth + 8]} />
      </mesh>

      {/* Front Low Cutaway Architectural Curb (Height = 0.4m) for Unobstructed Camera View */}
      <mesh
        position={[0, 0.2, (-0.8 - GRID_H / 2 + 0.5) * CELL_SIZE]}
        material={curbMat}
        receiveShadow
        raycast={() => null}
      >
        <boxGeometry args={[floorWidth + 8, 0.4, 0.4]} />
      </mesh>

      {/* 3. Dark Steel I-Beam Columns along Perimeter */}
      {[-0.5, 22.5].map((cx, i) =>
        [2, 6, 10, 14].map((cy, j) => {
          const [wx, , wz] = gridToWorld(cx, cy, 3.25);
          return (
            <mesh key={`${i}-${j}`} position={[wx, 3.25, wz]} material={steelMat} castShadow raycast={() => null}>
              <boxGeometry args={[0.45, 6.5, 0.45]} />
            </mesh>
          );
        })
      )}

      {/* 4. Overhead Steel Roof Trusses Spanning Across Warehouse */}
      {[4, 9, 13].map((ty, idx) => {
        const [, , wz] = gridToWorld(0, ty, 6.4);
        return (
          <group key={idx} position={[0, 6.4, wz]} raycast={() => null}>
            {/* Main horizontal truss chord */}
            <mesh material={steelMat} raycast={() => null}>
              <boxGeometry args={[floorWidth + 7, 0.25, 0.25]} />
            </mesh>
            {/* Lower chord */}
            <mesh position={[0, -0.6, 0]} material={steelMat} raycast={() => null}>
              <boxGeometry args={[floorWidth + 7, 0.15, 0.15]} />
            </mesh>
          </group>
        );
      })}

      {/* 5. Staged Wooden Pallets near Packing Dock & Perimeter */}
      {[-2, 2, 4].map((offset, idx) => {
        const [wx, , wz] = gridToWorld(DOCK_COORD.x + offset * 1.5, DOCK_COORD.y - 1.5, 0.1);
        return (
          <mesh key={idx} position={[wx, 0.1, wz]} castShadow raycast={() => null}>
            <boxGeometry args={[1.3, 0.2, 1.3]} />
            <meshStandardMaterial map={textures.palletTexture} roughness={0.8} />
          </mesh>
        );
      })}
    </group>
  );
}

// ==========================================
// 6. UPGRADED STORAGE RACK WITH PALLETS & CARDBOARD BOXES
// ==========================================
function StorageRack({ slot, product, isSelected, isSwapTarget, textures, onSelect, onHover }) {
  const [hovered, setHovered] = useState(false);
  const [wx, wy, wz] = gridToWorld(slot.rackX, slot.rackY, 1.0);

  const productRank = product ? product.rank : 999;
  const ledColor = product ? getVelocityLEDColor(productRank) : '#64748b';

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
      {/* Wooden Pallet Base underneath rack */}
      <mesh position={[0, -0.92, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.25, 0.14, 1.25]} />
        <meshStandardMaterial map={textures.palletTexture} roughness={0.8} />
      </mesh>

      {/* Upright Industrial Metal Rack Frame */}
      <mesh castShadow receiveShadow position={[0, 0, 0]}>
        <boxGeometry args={[1.2, 1.8, 1.2]} />
        <meshStandardMaterial
          color={isSelected ? '#38bdf8' : isSwapTarget ? '#c084fc' : '#1e293b'}
          roughness={0.4}
          metalness={0.7}
        />
      </mesh>

      {/* Top Tier: Textured Corrugated Cardboard Boxes */}
      <mesh position={[0, 0.32, 0]} castShadow>
        <boxGeometry args={[0.98, 0.52, 0.98]} />
        <meshStandardMaterial map={textures.boxTexture} roughness={0.85} />
      </mesh>

      {/* Bottom Tier: Textured Corrugated Cardboard Boxes */}
      <mesh position={[0, -0.38, 0]} castShadow>
        <boxGeometry args={[0.98, 0.52, 0.98]} />
        <meshStandardMaterial map={textures.boxTexture} roughness={0.85} />
      </mesh>

      {/* Velocity LED Strip/Badge on Rack Face */}
      <mesh position={[0, 0.62, 0.61]}>
        <boxGeometry args={[0.9, 0.08, 0.04]} />
        <meshStandardMaterial
          color={ledColor}
          emissive={ledColor}
          emissiveIntensity={isSelected ? 1.5 : hovered ? 1.2 : 0.8}
        />
      </mesh>

      {/* Selection Glow Indicator */}
      {isSelected && (
        <mesh position={[0, 1.15, 0]}>
          <ringGeometry args={[0.35, 0.65, 32]} />
          <meshBasicMaterial color="#38bdf8" side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Floating 3D Rank Label */}
      {product && (
        <Text
          position={[0, 1.05, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={0.32}
          color="#0f172a"
          anchorX="center"
          anchorY="middle"
        >
          {`#${product.rank}`}
        </Text>
      )}

      {/* Hover Card Tooltip */}
      {hovered && product && (
        <Html position={[0, 1.8, 0]} center distanceFactor={14}>
          <div className="bg-slate-900/95 text-white p-3 rounded-xl shadow-2xl border border-sky-500/50 pointer-events-none w-52 text-xs backdrop-blur-md">
            <div className="flex items-center justify-between font-bold text-sky-400">
              <span>{`Slot #${slot.slotId}`}</span>
              <span className="bg-sky-500/20 text-sky-300 px-1.5 py-0.5 rounded text-[10px]">
                {`Rank #${product.rank}`}
              </span>
            </div>
            <div className="mt-1 font-semibold text-slate-100 truncate">{product.stock_code}</div>
            <div className="text-slate-400 text-[11px] truncate">{product.description}</div>
            <div className="mt-2 pt-1.5 border-t border-slate-800 flex justify-between text-slate-300">
              <span>
                Picks: <strong>{product.pick_frequency}</strong>
              </span>
              <span>
                Dist: <strong>{slot.dockDistance?.toFixed(1) || '--'}m</strong>
              </span>
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}

// ==========================================
// 7. UPGRADED PACKING & DISPATCH DOCK
// ==========================================
function UpgradedPackingDock({ textures }) {
  const [dx, dz] = [
    (DOCK_COORD.x - GRID_W / 2 + 0.5) * CELL_SIZE,
    (DOCK_COORD.y - GRID_H / 2 + 0.5) * CELL_SIZE,
  ];

  return (
    <group position={[dx, 0, dz - 1.4]} raycast={() => null}>
      {/* Hazard Striped Floor Area */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]} raycast={() => null}>
        <planeGeometry args={[6.2, 2.8]} />
        <meshStandardMaterial map={textures.hazardTexture} roughness={0.4} />
      </mesh>

      {/* White & Slate Supervisory Workstation Platform */}
      <mesh position={[0, 0.6, -0.6]} castShadow receiveShadow raycast={() => null}>
        <boxGeometry args={[4.2, 0.95, 1.1]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.4} metalness={0.2} />
      </mesh>

      {/* Roller Conveyors */}
      <mesh position={[0, 0.65, 0.5]} castShadow raycast={() => null}>
        <boxGeometry args={[4.8, 0.45, 0.8]} />
        <meshStandardMaterial color="#334155" metalness={0.8} roughness={0.2} />
      </mesh>

      {/* Textured Cardboard Outbound Cartons on Conveyor */}
      {[-1.4, -0.5, 0.4, 1.3].map((cx, idx) => (
        <mesh key={idx} position={[cx, 1.05, 0.5]} castShadow raycast={() => null}>
          <boxGeometry args={[0.55, 0.4, 0.55]} />
          <meshStandardMaterial map={textures.boxTexture} roughness={0.85} />
        </mesh>
      ))}

      {/* Dual Monitor Terminals */}
      {[-0.8, 0.8].map((mx, idx) => (
        <group key={idx} position={[mx, 1.3, -0.6]} raycast={() => null}>
          <mesh>
            <boxGeometry args={[0.65, 0.42, 0.05]} />
            <meshStandardMaterial color="#0284c7" emissive="#0284c7" emissiveIntensity={0.6} />
          </mesh>
          <mesh position={[0, -0.25, 0]}>
            <cylinderGeometry args={[0.04, 0.04, 0.25, 8]} />
            <meshStandardMaterial color="#0f172a" />
          </mesh>
        </group>
      ))}

      {/* 3D Header Label */}
      <Text
        position={[0, 2.2, -0.6]}
        fontSize={0.48}
        color="#0f172a"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor="#ffffff"
        raycast={() => null}
      >
        PACKING & DISPATCH DOCK
      </Text>
    </group>
  );
}

// Continuous Floor Ribbon for Picker Path
function PickerPathRibbon({ waypoints, color = '#10b981' }) {
  const points = useMemo(() => {
    if (!waypoints || waypoints.length < 2) return [];
    return waypoints.map((wp) => {
      const [x, , z] = gridToWorld(wp.x, wp.y, 0.04);
      return new THREE.Vector3(x, 0.05, z);
    });
  }, [waypoints]);

  if (points.length < 2) return null;

  const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
  return (
    <primitive
      object={new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color, linewidth: 3 }))}
      raycast={() => null}
    />
  );
}

// Numbered floating stop markers for active batch
function BatchTargetMarkers({ stops, currentSegmentIdx }) {
  return (
    <group raycast={() => null}>
      {stops.map((stop) => {
        const [wx, , wz] = gridToWorld(stop.rackX, stop.rackY, 0);
        const isCurrent = currentSegmentIdx === stop.stopNumber - 1;
        const isCompleted = currentSegmentIdx > stop.stopNumber - 1;
        const markerColor = isCurrent ? '#0284c7' : isCompleted ? '#059669' : '#d97706';

        return (
          <group key={stop.slotId} position={[wx, 0, wz]} raycast={() => null}>
            {/* Numbered Badge above Rack */}
            <group position={[0, 2.5, 0]} raycast={() => null}>
              <mesh raycast={() => null}>
                <sphereGeometry args={[0.34, 16, 16]} />
                <meshStandardMaterial
                  color={markerColor}
                  emissive={markerColor}
                  emissiveIntensity={isCurrent ? 0.9 : 0.4}
                />
              </mesh>
              <Text
                position={[0, 0, 0.36]}
                fontSize={0.34}
                color="#ffffff"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.03}
                outlineColor="#0f172a"
                raycast={() => null}
              >
                {String(stop.stopNumber)}
              </Text>
            </group>
          </group>
        );
      })}
    </group>
  );
}

// ==========================================
// 8. ARTICULATED HUMAN WORKER + AGV CART (60 FPS ZERO-STUTTER)
// ==========================================
function ArticulatedPickerUnit({
  workerId,
  vestColor,
  segments,
  currentSegmentIdx,
  isPlaying,
  simSpeed,
  carriedBoxCount,
  textures,
  otherPickersRef,
  onSegmentComplete,
  onTripComplete,
  onPickAction,
  onCongestionEvent,
}) {
  const rootGroupRef = useRef();
  const beaconRef = useRef();
  const leftLegRef = useRef();
  const rightLegRef = useRef();
  const leftArmRef = useRef();
  const rightArmRef = useRef();

  // Internal state machine variables (refs prevent 60fps React re-renders)
  const segmentIdxRef = useRef(0);
  const waypointIdxRef = useRef(0);
  const progressRef = useRef(0);
  const stateRef = useRef('DRIVING'); // 'DRIVING' | 'PICKING' | 'YIELDING'
  const pauseTimerRef = useRef(0);
  const yieldingTimerRef = useRef(0);
  const angleRef = useRef(0);
  const [isYieldingBadge, setIsYieldingBadge] = useState(false);

  useEffect(() => {
    segmentIdxRef.current = currentSegmentIdx;
    waypointIdxRef.current = 0;
    progressRef.current = 0;
    stateRef.current = 'DRIVING';
  }, [currentSegmentIdx]);

  useFrame(({ clock }, delta) => {
    if (beaconRef.current) {
      beaconRef.current.rotation.y += delta * (stateRef.current === 'YIELDING' ? 16 : 6);
    }

    if (!isPlaying || !segments || segments.length === 0) return;

    const currentSeg = segments[segmentIdxRef.current];
    if (!currentSeg || !currentSeg.path || currentSeg.path.length === 0) return;

    // 1. YIELDING (CONGESTION) STATE
    if (stateRef.current === 'YIELDING') {
      yieldingTimerRef.current -= delta * simSpeed;
      // Stance remains stationary
      if (leftLegRef.current) leftLegRef.current.rotation.x = 0;
      if (rightLegRef.current) rightLegRef.current.rotation.x = 0;
      if (leftArmRef.current) leftArmRef.current.rotation.x = 0;
      if (rightArmRef.current) rightArmRef.current.rotation.x = 0;

      if (yieldingTimerRef.current <= 0) {
        // Congestion wait finished; resume driving
        stateRef.current = 'DRIVING';
        setIsYieldingBadge(false);
      }
      return;
    }

    // 2. PICKING PAUSE STATE
    if (stateRef.current === 'PICKING') {
      pauseTimerRef.current -= delta * simSpeed;
      if (leftLegRef.current) leftLegRef.current.rotation.x = 0;
      if (rightLegRef.current) rightLegRef.current.rotation.x = 0;

      if (pauseTimerRef.current <= 0) {
        onPickAction(workerId);
        const nextIdx = segmentIdxRef.current + 1;
        if (nextIdx < segments.length) {
          segmentIdxRef.current = nextIdx;
          waypointIdxRef.current = 0;
          progressRef.current = 0;
          stateRef.current = 'DRIVING';
          onSegmentComplete(workerId, nextIdx);
        }
      }
      return;
    }

    // 3. DRIVING STATE & CONGESTION DETECTION
    const path = currentSeg.path;
    const wpIdx = waypointIdxRef.current;

    // Check segment arrival
    if (wpIdx >= path.length - 1) {
      if (currentSeg.isDock) {
        stateRef.current = 'DOCK_IDLE';
        onTripComplete(workerId);
      } else {
        stateRef.current = 'PICKING';
        pauseTimerRef.current = Math.max(0.12, 0.65 / Math.min(simSpeed, 8));
      }
      return;
    }

    const currentWp = path[wpIdx];
    const nextWp = path[wpIdx + 1];

    // CONGESTION CHECK: Check if any higher priority worker is within 1.2 grid units
    if (otherPickersRef && otherPickersRef.current) {
      const otherPositions = otherPickersRef.current;
      for (const [otherId, otherPos] of Object.entries(otherPositions)) {
        if (parseInt(otherId, 10) < workerId && otherPos) {
          const dx = nextWp.x - otherPos.gx;
          const dy = nextWp.y - otherPos.gy;
          const gridDist = Math.sqrt(dx * dx + dy * dy);
          if (gridDist < 1.25) {
            // Enter YIELDING state for 1.2s
            stateRef.current = 'YIELDING';
            yieldingTimerRef.current = Math.max(0.2, 1.2 / Math.min(simSpeed, 4));
            setIsYieldingBadge(true);
            onCongestionEvent(workerId);
            return;
          }
        }
      }
    }

    // Normal driving interpolation
    const p0 = gridToWorld(currentWp.x, currentWp.y, 0);
    const p1 = gridToWorld(nextWp.x, nextWp.y, 0);
    const edgeDist = CELL_SIZE;
    const stepSpeed = PICKER_SPEED * simSpeed;
    const progressInc = (stepSpeed * delta) / edgeDist;

    progressRef.current += progressInc;

    if (progressRef.current >= 1.0) {
      progressRef.current = 0;
      waypointIdxRef.current += 1;
    }

    const t = Math.min(1.0, Math.max(0.0, progressRef.current));
    const posX = p0[0] + (p1[0] - p0[0]) * t;
    const posZ = p0[2] + (p1[2] - p0[2]) * t;

    const dx = p1[0] - p0[0];
    const dz = p1[2] - p0[2];
    if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
      angleRef.current = Math.atan2(dx, dz);
    }

    // Mutate position and rotation directly (Zero React state overhead)
    if (rootGroupRef.current) {
      rootGroupRef.current.position.set(posX, 0, posZ);
      rootGroupRef.current.rotation.y = THREE.MathUtils.lerp(
        rootGroupRef.current.rotation.y,
        angleRef.current,
        0.25
      );
    }

    // Report grid position to shared ref for neighbor congestion detection
    if (otherPickersRef && otherPickersRef.current) {
      otherPickersRef.current[workerId] = {
        gx: currentWp.x + (nextWp.x - currentWp.x) * t,
        gy: currentWp.y + (nextWp.y - currentWp.y) * t,
        world: [posX, 0, posZ],
      };
    }

    // Articulate human arms and legs smoothly during walking
    const walkCycle = Math.sin(clock.elapsedTime * 9 * Math.min(simSpeed, 3));
    if (leftLegRef.current) leftLegRef.current.rotation.x = walkCycle * 0.55;
    if (rightLegRef.current) rightLegRef.current.rotation.x = -walkCycle * 0.55;
    if (leftArmRef.current) leftArmRef.current.rotation.x = -walkCycle * 0.45;
    if (rightArmRef.current) rightArmRef.current.rotation.x = walkCycle * 0.45;
  });

  return (
    <group ref={rootGroupRef} position={gridToWorld(DOCK_COORD.x, DOCK_COORD.y, 0)} raycast={() => null}>
      {/* Floating Congestion Yielding Badge */}
      {isYieldingBadge && (
        <Html position={[0, 2.4, 0]} center distanceFactor={14}>
          <div className="bg-amber-500 text-slate-950 font-black px-2 py-0.5 rounded text-[10px] tracking-wide shadow-xl uppercase animate-bounce whitespace-nowrap">
            ⚠️ AISLE CONGESTION - YIELDING
          </div>
        </Html>
      )}

      {/* 1. INDUSTRIAL AGV PICKING CART (Pushed in front of worker) */}
      <group position={[0, 0, 0.4]}>
        {/* Cart Base Chassis */}
        <mesh position={[0, 0.22, 0]} castShadow>
          <boxGeometry args={[0.95, 0.22, 1.25]} />
          <meshStandardMaterial color="#0284c7" metalness={0.7} roughness={0.3} />
        </mesh>

        {/* 4 Wheels */}
        {[-0.44, 0.44].map((x, i) =>
          [-0.48, 0.48].map((z, j) => (
            <mesh key={`${i}-${j}`} position={[x, 0.1, z]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.1, 0.1, 0.12, 16]} />
              <meshStandardMaterial color="#0f172a" />
            </mesh>
          ))
        )}

        {/* Upright Handlebar & Tablet Screen */}
        <mesh position={[0, 0.72, -0.55]} castShadow>
          <boxGeometry args={[0.75, 0.85, 0.06]} />
          <meshStandardMaterial color="#334155" metalness={0.8} />
        </mesh>
        <mesh position={[0, 1.1, -0.52]}>
          <boxGeometry args={[0.38, 0.24, 0.04]} />
          <meshStandardMaterial color="#38bdf8" emissive="#38bdf8" emissiveIntensity={0.8} />
        </mesh>

        {/* Flashing Amber / Worker Color Safety Beacon */}
        <group position={[0, 1.3, -0.55]} ref={beaconRef}>
          <mesh>
            <cylinderGeometry args={[0.07, 0.07, 0.15, 12]} />
            <meshStandardMaterial
              color={isYieldingBadge ? '#f59e0b' : vestColor}
              emissive={isYieldingBadge ? '#f59e0b' : vestColor}
              emissiveIntensity={isYieldingBadge ? 2.5 : 1.2}
            />
          </mesh>
        </group>

        {/* Stacked Corrugated Cardboard Boxes on Cart */}
        <group position={[0, 0.44, 0.15]}>
          {Array.from({ length: Math.min(carriedBoxCount, 8) }).map((_, idx) => {
            const col = idx % 2;
            const row = Math.floor(idx / 2);
            return (
              <mesh
                key={idx}
                position={[(col - 0.5) * 0.34, 0.1 + row * 0.22, (row % 2 - 0.5) * 0.1]}
                castShadow
              >
                <boxGeometry args={[0.3, 0.2, 0.38]} />
                <meshStandardMaterial map={textures.boxTexture} roughness={0.85} />
              </mesh>
            );
          })}
        </group>
      </group>

      {/* 2. ARTICULATED HUMAN WORKER (Behind Cart) */}
      <group position={[0, 0, -0.5]}>
        {/* Left Leg */}
        <group ref={leftLegRef} position={[-0.15, 0.55, 0]}>
          <mesh position={[0, -0.28, 0]}>
            <cylinderGeometry args={[0.08, 0.08, 0.56, 12]} />
            <meshStandardMaterial color="#1e293b" />
          </mesh>
        </group>

        {/* Right Leg */}
        <group ref={rightLegRef} position={[0.15, 0.55, 0]}>
          <mesh position={[0, -0.28, 0]}>
            <cylinderGeometry args={[0.08, 0.08, 0.56, 12]} />
            <meshStandardMaterial color="#1e293b" />
          </mesh>
        </group>

        {/* Torso with High-Vis Safety Vest */}
        <mesh position={[0, 0.98, 0]} castShadow>
          <boxGeometry args={[0.44, 0.58, 0.28]} />
          <meshStandardMaterial color={vestColor} roughness={0.5} />
        </mesh>
        {/* Reflective silver vest stripe */}
        <mesh position={[0, 1.0, 0.15]}>
          <planeGeometry args={[0.4, 0.09]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>

        {/* Left Arm */}
        <group ref={leftArmRef} position={[-0.26, 1.15, 0]}>
          <mesh position={[0, -0.22, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 0.44, 10]} />
            <meshStandardMaterial color="#1e293b" />
          </mesh>
        </group>

        {/* Right Arm */}
        <group ref={rightArmRef} position={[0.26, 1.15, 0]}>
          <mesh position={[0, -0.22, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 0.44, 10]} />
            <meshStandardMaterial color="#1e293b" />
          </mesh>
        </group>

        {/* Head & White Safety Hard Hat */}
        <mesh position={[0, 1.45, 0]} castShadow>
          <sphereGeometry args={[0.14, 16, 16]} />
          <meshStandardMaterial color="#fcd34d" roughness={0.8} />
        </mesh>
        <mesh position={[0, 1.54, 0]}>
          <cylinderGeometry args={[0.19, 0.18, 0.1, 16]} />
          <meshStandardMaterial color="#ffffff" metalness={0.2} roughness={0.3} />
        </mesh>
      </group>
    </group>
  );
}

// Camera Presets Manager
function CameraController({ cameraMode, focusPos }) {
  const controlsRef = useRef();

  useEffect(() => {
    if (!controlsRef.current) return;
    if (cameraMode === 'TOP') {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.object.position.set(0, 48, 0.1);
    } else if (cameraMode === 'PERSPECTIVE') {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.object.position.set(0, 32, 38);
    }
  }, [cameraMode]);

  useFrame(() => {
    if (cameraMode === 'FOLLOW' && controlsRef.current && focusPos) {
      controlsRef.current.target.lerp(new THREE.Vector3(focusPos[0], 0.5, focusPos[2]), 0.08);
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      maxPolarAngle={cameraMode === 'TOP' ? 0.01 : Math.PI / 2.05}
      minDistance={8}
      maxDistance={85}
    />
  );
}

// ==========================================
// 9. MAIN APPLICATION COMPONENT
// ==========================================
export default function App() {
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const [baselineLayout, setBaselineLayout] = useState({});
  const [customLayout, setCustomLayout] = useState({});
  const [activeLayoutView, setActiveLayoutView] = useState('CUSTOM');

  // Stretch Goals Configuration
  const [batchSize, setBatchSize] = useState(3);
  const [fleetSize, setFleetSize] = useState(3); // 1, 2, or 3 pickers
  const [simSpeed, setSimSpeed] = useState(5);
  const [isPlaying, setIsPlaying] = useState(true);

  // UI State
  const [selectedSlotId, setSelectedSlotId] = useState(null);
  const [swapFeedback, setSwapFeedback] = useState(null);
  const [hoveredProduct, setHoveredProduct] = useState(null);
  const [cameraMode, setCameraMode] = useState('PERSPECTIVE');
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  // Shared Procedural Textures (Memoized once)
  const textures = useProceduralTextures();

  // Multi-Picker Fleet State
  // Picker 0 = Emerald (#10b981), Picker 1 = Cyan (#06b6d4), Picker 2 = Amber (#f59e0b)
  const workerConfigs = useMemo(
    () => [
      { id: 0, vestColor: '#10b981', ribbonColor: '#10b981', label: 'Picker 1 (Emerald)' },
      { id: 1, vestColor: '#06b6d4', ribbonColor: '#06b6d4', label: 'Picker 2 (Cyan)' },
      { id: 2, vestColor: '#f59e0b', ribbonColor: '#f59e0b', label: 'Picker 3 (Amber)' },
    ],
    []
  );

  const [pickerStates, setPickerStates] = useState({
    0: { batchStart: 0, segIdx: 0, carriedBoxes: 0, activeStop: null },
    1: { batchStart: 3, segIdx: 0, carriedBoxes: 0, activeStop: null },
    2: { batchStart: 6, segIdx: 0, carriedBoxes: 0, activeStop: null },
  });

  // Shared ref holding live coordinates for congestion checks
  const otherPickersRef = useRef({});

  // Telemetry: Congestion counter
  const [congestionStats, setCongestionStats] = useState({
    eventsCount: 0,
    totalDelaySec: 0,
  });

  // Live cumulative counters
  const [liveStats, setLiveStats] = useState({
    tripsCompleted: 0,
    ordersProcessed: 0,
    distanceWalkedM: 0,
  });

  const slotsWithDistances = useMemo(() => {
    return WAREHOUSE_SLOTS.map((slot) => {
      const dist = getCachedDistance(DOCK_COORD, { x: slot.pickX, y: slot.pickY });
      return { ...slot, dockDistance: dist };
    });
  }, []);

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

        const sortedSlots = [...slotsWithDistances].sort((a, b) => a.dockDistance - b.dockDistance);
        const baseMap = {};
        const custMap = {};

        sortedSlots.forEach((slot, idx) => {
          if (idx < prods.length) {
            baseMap[slot.slotId] = prods[idx];
            custMap[slot.slotId] = prods[idx];
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

  // Instant Full-Month Benchmark across all 1,367 orders (Under 30ms)
  const monthlyBenchmark = useMemo(() => {
    if (!dataLoaded || orders.length === 0) return null;

    const baselineSingle = calculateFullMonthMetrics(
      orders,
      baselineProdToSlot,
      slotsWithDistances,
      1,
      getCachedDistance
    );

    const customSingle = calculateFullMonthMetrics(
      orders,
      customProdToSlot,
      slotsWithDistances,
      1,
      getCachedDistance
    );

    const benchmarkBatchSize = batchSize > 1 ? batchSize : 3;
    const customBatched = calculateFullMonthMetrics(
      orders,
      customProdToSlot,
      slotsWithDistances,
      benchmarkBatchSize,
      getCachedDistance
    );

    const distSavedVsCustomSingle = customSingle.distanceM - customBatched.distanceM;
    const distSavedVsCustomSinglePct = ((distSavedVsCustomSingle / customSingle.distanceM) * 100).toFixed(1);
    const timeSavedVsCustomSingleHours = (customSingle.timeSec - customBatched.timeSec) / 3600;

    return {
      baselineSingle,
      customSingle,
      customBatched,
      benchmarkBatchSize,
      distSavedVsCustomSingleKm: (distSavedVsCustomSingle / 1000).toFixed(1),
      distSavedVsCustomSinglePct,
      timeSavedVsCustomSingleHours: timeSavedVsCustomSingleHours.toFixed(1),
    };
  }, [dataLoaded, orders, baselineProdToSlot, customProdToSlot, slotsWithDistances, batchSize]);

  // Helper: Generates TSP Segments for any given batch offset
  const buildSegmentsForBatch = useCallback(
    (startIdx) => {
      if (!orders || orders.length === 0) return { segments: [], stops: [], fullWaypoints: [] };

      const batchOrders = orders.slice(startIdx, Math.min(startIdx + batchSize, orders.length));
      const activeProdToSlot = activeLayoutView === 'BASELINE' ? baselineProdToSlot : customProdToSlot;
      const uniqueSlotMap = new Map();

      for (const ord of batchOrders) {
        for (const line of ord.lines) {
          const sId = activeProdToSlot.get(line.stock_code);
          if (sId !== undefined) {
            const slot = slotsWithDistances.find((s) => s.slotId === sId);
            if (slot) {
              if (!uniqueSlotMap.has(sId)) {
                uniqueSlotMap.set(sId, {
                  ...slot,
                  items: [{ stock_code: line.stock_code, description: line.description, quantity: line.quantity }],
                  totalUnits: line.quantity,
                  orderIds: [ord.order_id],
                });
              } else {
                const existing = uniqueSlotMap.get(sId);
                existing.items.push({ stock_code: line.stock_code, description: line.description, quantity: line.quantity });
                existing.totalUnits += line.quantity;
                if (!existing.orderIds.includes(ord.order_id)) existing.orderIds.push(ord.order_id);
              }
            }
          }
        }
      }

      const rawStops = Array.from(uniqueSlotMap.values());
      const orderedStops =
        batchSize > 1 ? solveNearestNeighborTSP(DOCK_COORD, rawStops, getCachedDistance) : rawStops;
      const stopsWithNum = orderedStops.map((s, idx) => ({ ...s, stopNumber: idx + 1 }));

      const segments = [];
      let startP = DOCK_COORD;

      for (let i = 0; i < stopsWithNum.length; i++) {
        const stop = stopsWithNum[i];
        const endP = { x: stop.pickX, y: stop.pickY };
        const path = findAStarPath(startP, endP);

        segments.push({
          segmentIndex: i,
          start: startP,
          end: endP,
          path,
          targetSlot: stop,
          items: stop.items,
          totalUnits: stop.totalUnits,
          isDock: false,
          stopNumber: i + 1,
        });

        startP = endP;
      }

      const returnPath = findAStarPath(startP, DOCK_COORD);
      segments.push({
        segmentIndex: stopsWithNum.length,
        start: startP,
        end: DOCK_COORD,
        path: returnPath,
        targetSlot: null,
        items: [],
        totalUnits: 0,
        isDock: true,
        stopNumber: null,
      });

      const fullWaypoints = [];
      segments.forEach((seg, sIdx) => {
        if (seg.path && seg.path.length > 0) {
          if (sIdx === 0) fullWaypoints.push(...seg.path);
          else fullWaypoints.push(...seg.path.slice(1));
        }
      });

      return { segments, stops: stopsWithNum, fullWaypoints };
    },
    [orders, batchSize, activeLayoutView, baselineProdToSlot, customProdToSlot, slotsWithDistances]
  );

  // Pre-generate trip routes for active fleet members
  const fleetTrips = useMemo(() => {
    const trips = {};
    for (let i = 0; i < fleetSize; i++) {
      const startIdx = (pickerStates[i]?.batchStart ?? i * batchSize) % (orders.length || 1);
      trips[i] = buildSegmentsForBatch(startIdx);
    }
    return trips;
  }, [fleetSize, pickerStates, buildSegmentsForBatch, orders.length, batchSize]);

  // Congestion event handler
  const handleCongestionEvent = useCallback((_wId) => {
    setCongestionStats((prev) => ({
      eventsCount: prev.eventsCount + 1,
      totalDelaySec: prev.totalDelaySec + 1.2,
    }));
  }, []);

  // Segment progression handler
  const handleSegmentComplete = useCallback((wId, nextSegIdx) => {
    setPickerStates((prev) => ({
      ...prev,
      [wId]: { ...prev[wId], segIdx: nextSegIdx },
    }));
  }, []);

  // Pick item handler
  const handlePickAction = useCallback((wId) => {
    setPickerStates((prev) => ({
      ...prev,
      [wId]: { ...prev[wId], carriedBoxes: (prev[wId]?.carriedBoxes || 0) + 1 },
    }));
  }, []);

  // Trip complete handler
  const handleTripComplete = useCallback(
    (wId) => {
      const trip = fleetTrips[wId];
      let dist = 0;
      if (trip && trip.segments) {
        trip.segments.forEach((seg) => {
          dist += Math.max(0, seg.path.length - 1) * CELL_SIZE;
        });
      }

      setLiveStats((prev) => ({
        tripsCompleted: prev.tripsCompleted + 1,
        ordersProcessed: prev.ordersProcessed + batchSize,
        distanceWalkedM: prev.distanceWalkedM + dist,
      }));

      // Pull next batch from parallel sequence
      setPickerStates((prev) => {
        const nextStart = (prev[wId].batchStart + fleetSize * batchSize) % (orders.length || 1);
        return {
          ...prev,
          [wId]: { batchStart: nextStart, segIdx: 0, carriedBoxes: 0 },
        };
      });
    },
    [fleetTrips, batchSize, fleetSize, orders.length]
  );

  const resetSimulation = useCallback(() => {
    setPickerStates({
      0: { batchStart: 0, segIdx: 0, carriedBoxes: 0 },
      1: { batchStart: batchSize, segIdx: 0, carriedBoxes: 0 },
      2: { batchStart: batchSize * 2, segIdx: 0, carriedBoxes: 0 },
    });
    setLiveStats({ tripsCompleted: 0, ordersProcessed: 0, distanceWalkedM: 0 });
    setCongestionStats({ eventsCount: 0, totalDelaySec: 0 });
  }, [batchSize]);

  // Slot swap handler (Preserving 100% of game mode)
  const handleSlotSelect = useCallback(
    (slotId) => {
      if (activeLayoutView !== 'CUSTOM') {
        setSwapFeedback({ type: 'warning', text: 'Switch to Custom Layout view to swap slots!' });
        setTimeout(() => setSwapFeedback(null), 3000);
        return;
      }

      if (selectedSlotId === null) {
        setSelectedSlotId(slotId);
      } else if (selectedSlotId === slotId) {
        setSelectedSlotId(null);
      } else {
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

        resetSimulation();
      }
    },
    [activeLayoutView, selectedSlotId, customLayout, resetSimulation]
  );

  const handleResetToBaseline = useCallback(() => {
    setCustomLayout({ ...baselineLayout });
    setSelectedSlotId(null);
    setSwapFeedback({ type: 'info', text: 'Reset custom layout to Optimal Baseline!' });
    resetSimulation();
    setTimeout(() => setSwapFeedback(null), 3000);
  }, [baselineLayout, resetSimulation]);

  const handleRandomizeLayout = useCallback(() => {
    const slotKeys = Object.keys(customLayout);
    const prodValues = Object.values(customLayout);
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
  }, [customLayout, resetSimulation]);

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
  }, [slotsWithDistances, products, resetSimulation]);

  const activeLayoutMap = activeLayoutView === 'BASELINE' ? baselineLayout : customLayout;

  if (errorMsg) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950 text-white p-6">
        <div className="bg-red-950/80 border border-red-500 p-6 rounded-xl max-w-lg text-center">
          <h2 className="text-xl font-bold text-red-400">Data Loading Error</h2>
          <p className="mt-2 text-sm text-red-200">{errorMsg}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#050508] select-none">
      {/* ====================================================
          1. 3D CANVAS SCENE: BLACK VOID + WHITE ARCHITECTURE
      ==================================================== */}
      <Canvas
        shadows
        camera={{ position: [0, 32, 38], fov: 45 }}
        className="w-full h-full"
      >
        {/* Black Void Scene Atmosphere & Fog */}
        <color attach="background" args={['#050508']} />
        <fog attach="fog" args={['#050508', 45, 115]} />

        <ambientLight intensity={0.7} />
        <directionalLight
          position={[20, 40, 20]}
          intensity={1.3}
          castShadow
          shadow-mapSize={[2048, 2048]}
        />
        <pointLight position={[0, 20, 0]} intensity={0.6} />

        {/* Crisp White Architectural Building & Perimeter Trusses */}
        <ArchitecturalWarehouse textures={textures} />

        {/* Upgraded Packing & Dispatch Dock */}
        <UpgradedPackingDock textures={textures} />

        {/* 100 Storage Racks with Wooden Pallets & Cardboard Textures */}
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
              textures={textures}
              onSelect={handleSlotSelect}
              onHover={(_, p) => setHoveredProduct(p)}
            />
          );
        })}

        {/* Numbered Floating Badges for Worker 0's active batch */}
        {fleetTrips[0] && (
          <BatchTargetMarkers
            stops={fleetTrips[0].stops}
            currentSegmentIdx={pickerStates[0]?.segIdx || 0}
          />
        )}

        {/* Color-Coded Continuous Floor Path Ribbons for Each Active Picker */}
        {Array.from({ length: fleetSize }).map((_, i) => {
          const trip = fleetTrips[i];
          if (!trip || !trip.fullWaypoints) return null;
          return (
            <PickerPathRibbon
              key={i}
              waypoints={trip.fullWaypoints}
              color={workerConfigs[i].ribbonColor}
            />
          );
        })}

        {/* Articulated Multi-Picker Fleet with Aisle Congestion State Machine */}
        {Array.from({ length: fleetSize }).map((_, i) => {
          const trip = fleetTrips[i];
          return (
            <ArticulatedPickerUnit
              key={i}
              workerId={i}
              vestColor={workerConfigs[i].vestColor}
              segments={trip?.segments || []}
              currentSegmentIdx={pickerStates[i]?.segIdx || 0}
              isPlaying={isPlaying}
              simSpeed={simSpeed}
              carriedBoxCount={pickerStates[i]?.carriedBoxes || 0}
              textures={textures}
              otherPickersRef={otherPickersRef}
              onSegmentComplete={handleSegmentComplete}
              onTripComplete={handleTripComplete}
              onPickAction={handlePickAction}
              onCongestionEvent={handleCongestionEvent}
            />
          );
        })}

        <CameraController cameraMode={cameraMode} focusPos={[0, 0, 0]} />
      </Canvas>

      {/* ====================================================
          2. TOAST NOTIFICATION
      ==================================================== */}
      {swapFeedback && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 pointer-events-none transition-all">
          <div
            className={`px-4 py-2 rounded-xl text-xs font-semibold shadow-2xl backdrop-blur-md border ${
              swapFeedback.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200'
                : swapFeedback.type === 'warning'
                ? 'bg-amber-950/90 border-amber-500 text-amber-200'
                : 'bg-indigo-950/90 border-indigo-500 text-indigo-200'
            }`}
          >
            {swapFeedback.text}
          </div>
        </div>
      )}

      {/* ====================================================
          3. TOP FLOATING HUD BAR (COMPACT & SLEEK)
      ==================================================== */}
      <header className="absolute top-3 left-4 right-4 flex items-center justify-between gap-2 pointer-events-none z-20">
        {/* Title & Mode */}
        <div className="flex items-center gap-2 bg-slate-900/90 backdrop-blur-md px-3.5 py-1.5 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-black tracking-wide text-white">NEXAI TWIN</span>
          <div className="h-4 w-px bg-slate-700 mx-1" />
          <button
            onClick={() => setActiveLayoutView((v) => (v === 'BASELINE' ? 'CUSTOM' : 'BASELINE'))}
            className={`px-2 py-0.5 rounded text-[10px] font-bold transition flex items-center gap-1.5 ${
              activeLayoutView === 'BASELINE'
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                : 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                activeLayoutView === 'BASELINE' ? 'bg-sky-400' : 'bg-purple-400'
              }`}
            />
            {activeLayoutView === 'BASELINE' ? 'Baseline View' : 'Player Custom'}
          </button>
        </div>

        {/* Fleet Size Selector (Stretch Goal) */}
        <div className="flex items-center gap-1 bg-slate-900/90 backdrop-blur-md p-1 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <span className="text-[10px] font-semibold text-slate-400 px-1">Fleet:</span>
          {[1, 2, 3].map((num) => (
            <button
              key={num}
              onClick={() => {
                setFleetSize(num);
                resetSimulation();
              }}
              className={`px-2 py-0.5 rounded text-[10px] font-bold transition ${
                fleetSize === num ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              {`${num} ${num === 1 ? 'Picker' : 'Pickers'}`}
            </button>
          ))}
        </div>

        {/* Batch Size Selector */}
        <div className="flex items-center gap-1 bg-slate-900/90 backdrop-blur-md p-1 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <span className="text-[10px] font-semibold text-slate-400 px-1">Batch:</span>
          {[
            { size: 1, label: '1x' },
            { size: 3, label: '3x TSP' },
            { size: 5, label: '5x Mega' },
          ].map(({ size, label }) => (
            <button
              key={size}
              onClick={() => {
                setBatchSize(size);
                resetSimulation();
              }}
              className={`px-2 py-0.5 rounded text-[10px] font-bold transition ${
                batchSize === size ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Play/Pause & Speed */}
        <div className="flex items-center gap-1 bg-slate-900/90 backdrop-blur-md p-1 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className={`px-2 py-0.5 rounded text-[10px] font-bold transition ${
              isPlaying ? 'bg-amber-600/90 text-white' : 'bg-emerald-600/90 text-white'
            }`}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          {[1, 5, 10, 25].map((spd) => (
            <button
              key={spd}
              onClick={() => setSimSpeed(spd)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition ${
                simSpeed === spd ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {`${spd}x`}
            </button>
          ))}
        </div>
      </header>

      {/* ====================================================
          4. LEFT COLLAPSIBLE PANEL (SLOTTING & CONTROLS)
      ==================================================== */}
      <div className="absolute top-16 left-4 z-20 pointer-events-none">
        {leftPanelOpen ? (
          <aside className="w-72 bg-slate-900/90 backdrop-blur-md p-3.5 rounded-2xl border border-slate-700/60 shadow-2xl pointer-events-auto space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="text-xs font-bold text-slate-200 uppercase tracking-wide flex items-center gap-1.5">
                <span>⚙️</span> Controls & Camera
              </span>
              <button
                onClick={() => setLeftPanelOpen(false)}
                className="text-slate-400 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-slate-800"
              >
                ✕
              </button>
            </div>

            {/* Camera Views */}
            <div className="space-y-1">
              <div className="text-[10px] font-semibold text-slate-400 uppercase">Camera View</div>
              <div className="grid grid-cols-3 gap-1">
                <button
                  onClick={() => setCameraMode('PERSPECTIVE')}
                  className={`py-1 text-[10px] font-semibold rounded-lg transition ${
                    cameraMode === 'PERSPECTIVE' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Isometric
                </button>
                <button
                  onClick={() => setCameraMode('TOP')}
                  className={`py-1 text-[10px] font-semibold rounded-lg transition ${
                    cameraMode === 'TOP' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Top-Down
                </button>
                <button
                  onClick={() => setCameraMode('FOLLOW')}
                  className={`py-1 text-[10px] font-semibold rounded-lg transition ${
                    cameraMode === 'FOLLOW' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Follow AGV
                </button>
              </div>
            </div>

            {/* Click-to-Swap Banner */}
            <div
              className={`p-2 rounded-xl text-xs border transition ${
                selectedSlotId !== null
                  ? 'bg-sky-950/80 border-sky-400 text-sky-200 animate-pulse'
                  : 'bg-slate-950/70 border-slate-800 text-slate-400'
              }`}
            >
              {selectedSlotId !== null ? (
                <div className="flex justify-between items-center">
                  <span>
                    Slot <strong>#{selectedSlotId}</strong> selected — click rack to swap!
                  </span>
                  <button
                    onClick={() => setSelectedSlotId(null)}
                    className="text-red-400 hover:underline text-[10px] font-bold"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <span>Click any rack to select, then click another to swap product slots.</span>
              )}
            </div>

            {/* Layout Presets */}
            <div className="space-y-1">
              <div className="text-[10px] font-semibold text-slate-400 uppercase">Layout Presets</div>
              <div className="grid grid-cols-3 gap-1">
                <button
                  onClick={handleResetToBaseline}
                  className="py-1 text-[10px] font-bold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                >
                  Optimal
                </button>
                <button
                  onClick={handleRandomizeLayout}
                  className="py-1 text-[10px] font-bold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                >
                  Randomize
                </button>
                <button
                  onClick={handleInvertLayout}
                  className="py-1 text-[10px] font-bold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                >
                  Invert
                </button>
              </div>
            </div>

            {/* Velocity Heatmap Legend */}
            <div className="pt-1 border-t border-slate-800">
              <div className="text-[9px] font-semibold text-slate-400 mb-1 uppercase">
                Pick Velocity LED Badges
              </div>
              <div className="flex justify-between text-[9px] text-slate-300">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-[#ef4444]" /> Top 35 (Red)
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-[#f59e0b]" /> 36-60 (Amber)
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-[#10b981]" /> 61-100 (Grn)
                </span>
              </div>
            </div>
          </aside>
        ) : (
          <button
            onClick={() => setLeftPanelOpen(true)}
            className="bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-700/60 text-xs font-bold text-slate-300 shadow-xl pointer-events-auto hover:text-white"
          >
            ⚙️ Controls
          </button>
        )}
      </div>

      {/* ====================================================
          5. RIGHT COLLAPSIBLE PANEL (TELEMETRY & INSTANT BENCHMARK)
      ==================================================== */}
      <div className="absolute top-16 right-4 z-20 pointer-events-none">
        {rightPanelOpen ? (
          <aside className="w-84 bg-slate-900/90 backdrop-blur-md p-3.5 rounded-2xl border border-slate-700/60 shadow-2xl pointer-events-auto space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="text-xs font-bold text-slate-200 uppercase tracking-wide flex items-center gap-1.5">
                <span>⚡</span> Full Month Benchmark (1,367 Orders)
              </span>
              <button
                onClick={() => setRightPanelOpen(false)}
                className="text-slate-400 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-slate-800"
              >
                ✕
              </button>
            </div>

            {/* 3-Tier Monthly Benchmark Summary */}
            {monthlyBenchmark && (
              <div className="space-y-1.5 text-xs">
                <div className="bg-slate-950/70 p-2 rounded-lg border border-sky-500/20 flex justify-between items-center">
                  <div>
                    <div className="text-[10px] text-sky-400 font-bold">1. Baseline (Single)</div>
                    <div className="text-[11px] text-slate-300">
                      {monthlyBenchmark.baselineSingle.distanceKm} km • {monthlyBenchmark.baselineSingle.timeHours} hrs
                    </div>
                  </div>
                  <span className="text-[10px] text-slate-500">Ref</span>
                </div>

                <div className="bg-slate-950/70 p-2 rounded-lg border border-purple-500/20 flex justify-between items-center">
                  <div>
                    <div className="text-[10px] text-purple-400 font-bold">2. Custom (Single)</div>
                    <div className="text-[11px] text-slate-300">
                      {monthlyBenchmark.customSingle.distanceKm} km • {monthlyBenchmark.customSingle.timeHours} hrs
                    </div>
                  </div>
                  <span className="text-[10px] text-purple-300 font-semibold">Active</span>
                </div>

                <div className="bg-indigo-950/60 p-2 rounded-lg border border-indigo-500/40 ring-1 ring-indigo-500/30 flex justify-between items-center">
                  <div>
                    <div className="text-[10px] text-emerald-400 font-bold">
                      {`3. Custom (${monthlyBenchmark.benchmarkBatchSize}x Batch + TSP)`}
                    </div>
                    <div className="text-[11px] font-extrabold text-white">
                      {monthlyBenchmark.customBatched.distanceKm} km • {monthlyBenchmark.customBatched.timeHours} hrs
                    </div>
                  </div>
                  <span className="text-[10px] font-bold bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">
                    {`-${monthlyBenchmark.distSavedVsCustomSinglePct}%`}
                  </span>
                </div>

                <div className="p-2 bg-gradient-to-r from-emerald-950/80 to-indigo-950/80 border border-emerald-500/40 rounded-lg text-center text-[11px] text-emerald-300 font-semibold">
                  {`Saves ${monthlyBenchmark.distSavedVsCustomSingleKm} km & ${monthlyBenchmark.timeSavedVsCustomSingleHours} labor hrs/mo!`}
                </div>
              </div>
            )}

            {/* Aisle Congestion & Fleet Telemetry Card */}
            <div className="space-y-2 pt-2 border-t border-slate-800">
              <div className="flex justify-between items-center text-xs">
                <span className="font-bold text-slate-300 flex items-center gap-1.5">
                  <span>🚦</span> Aisle Congestion Monitor
                </span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    congestionStats.eventsCount > 0 ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {`${congestionStats.eventsCount} Events`}
                </span>
              </div>

              {/* Live Session Counters */}
              <div className="grid grid-cols-2 gap-1.5 text-center text-xs">
                <div className="bg-slate-950/60 p-1.5 rounded-lg border border-slate-800">
                  <div className="text-[9px] text-slate-400">Live Orders Picked</div>
                  <div className="font-mono text-emerald-400 font-bold">
                    {liveStats.ordersProcessed}
                  </div>
                </div>
                <div className="bg-slate-950/60 p-1.5 rounded-lg border border-slate-800">
                  <div className="text-[9px] text-slate-400">Live Dist Walked</div>
                  <div className="font-mono text-sky-400 font-bold">
                    {`${liveStats.distanceWalkedM.toFixed(0)}m`}
                  </div>
                </div>
              </div>

              {/* Congestion Metrics */}
              <div className="grid grid-cols-2 gap-1.5 text-center text-xs">
                <div className="bg-slate-950/60 p-1.5 rounded-lg border border-slate-800">
                  <div className="text-[9px] text-slate-400">Total Yield Delays</div>
                  <div className="font-mono text-amber-400 font-bold">
                    {`${congestionStats.totalDelaySec.toFixed(1)}s`}
                  </div>
                </div>
                <div className="bg-slate-950/60 p-1.5 rounded-lg border border-slate-800">
                  <div className="text-[9px] text-slate-400">Active Fleet</div>
                  <div className="font-mono text-white font-bold">{`${fleetSize} Workers`}</div>
                </div>
              </div>

              {/* Multi-Picker Live Status List */}
              <div className="space-y-1 pt-1">
                {Array.from({ length: fleetSize }).map((_, i) => {
                  const state = pickerStates[i];
                  const trip = fleetTrips[i];
                  const currentSeg = trip?.segments?.[state?.segIdx || 0];

                  return (
                    <div
                      key={i}
                      className="bg-slate-950/70 p-1.5 rounded-lg border border-slate-800 text-[10px] flex justify-between items-center"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: workerConfigs[i].vestColor }} />
                        <span className="font-bold text-slate-200">{`Worker ${i + 1}`}</span>
                      </div>
                      <span className="text-slate-400">
                        {currentSeg && !currentSeg.isDock
                          ? `Stop ${currentSeg.stopNumber} / ${trip?.stops?.length || 0}`
                          : 'Returning to Dock'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Hovered Product Card */}
            {hoveredProduct && (
              <div className="p-2 bg-slate-950/90 border border-sky-500/30 rounded-lg text-xs space-y-0.5">
                <div className="flex justify-between font-bold text-sky-300">
                  <span>{hoveredProduct.stock_code}</span>
                  <span className="text-[10px] text-slate-400">{`Rank #${hoveredProduct.rank}`}</span>
                </div>
                <div className="text-[10px] text-slate-300 truncate">{hoveredProduct.description}</div>
                <div className="text-[10px] text-slate-400">
                  {`Picks: ${hoveredProduct.pick_frequency} • Qty: ${hoveredProduct.total_quantity_picked}`}
                </div>
              </div>
            )}
          </aside>
        ) : (
          <button
            onClick={() => setRightPanelOpen(true)}
            className="bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-700/60 text-xs font-bold text-slate-300 shadow-xl pointer-events-auto hover:text-white"
          >
            ⚡ Telemetry
          </button>
        )}
      </div>
    </div>
  );
}
