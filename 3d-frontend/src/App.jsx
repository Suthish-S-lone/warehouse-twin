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
const PICKER_SPEED = 3.6; // Virtual m/s base speed for picker movement
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
    for (let gy = 3; gy <= 12; gy++) {
      slots.push({
        slotId: id++,
        rackX: bay.leftCol,
        rackY: gy,
        pickX: bay.leftAisle,
        pickY: gy,
        bayName: `Bay ${bay.leftCol / 4 | 0}-L`,
      });
    }
    for (let gy = 3; gy <= 12; gy++) {
      slots.push({
        slotId: id++,
        rackX: bay.rightCol,
        rackY: gy,
        pickX: bay.rightAisle,
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

function getVelocityColor(rank) {
  if (rank <= 15) return '#ef4444';
  if (rank <= 35) return '#f97316';
  if (rank <= 60) return '#eab308';
  if (rank <= 85) return '#10b981';
  return '#3b82f6';
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
// 4. 3D COMPONENTS
// ==========================================

function WarehouseFloor() {
  const floorWidth = GRID_W * CELL_SIZE;
  const floorDepth = GRID_H * CELL_SIZE;

  return (
    <group position={[0, -0.01, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[floorWidth + 4, floorDepth + 4]} />
        <meshStandardMaterial color="#0b1120" roughness={0.9} metalness={0.1} />
      </mesh>
      <gridHelper
        args={[Math.max(floorWidth, floorDepth) + 4, Math.max(GRID_W, GRID_H) + 2, '#334155', '#1e293b']}
        position={[0, 0.01, 0]}
      />
      {/* Front cross-aisle */}
      <mesh position={[0, 0.02, (2 - GRID_H / 2 + 0.5) * CELL_SIZE]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[floorWidth - 2, 0.15]} />
        <meshBasicMaterial color="#eab308" transparent opacity={0.6} />
      </mesh>
      {/* Back cross-aisle */}
      <mesh position={[0, 0.02, (13 - GRID_H / 2 + 0.5) * CELL_SIZE]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[floorWidth - 2, 0.15]} />
        <meshBasicMaterial color="#eab308" transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

function PackingDock() {
  const [dx, dz] = [
    (DOCK_COORD.x - GRID_W / 2 + 0.5) * CELL_SIZE,
    (DOCK_COORD.y - GRID_H / 2 + 0.5) * CELL_SIZE,
  ];

  return (
    <group position={[dx, 0, dz - 1.2]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <planeGeometry args={[4.8, 2.2]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <planeGeometry args={[4.6, 2.0]} />
        <meshStandardMaterial color="#fbbf24" roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.55, -0.4]} castShadow receiveShadow>
        <boxGeometry args={[3.2, 0.9, 0.9]} />
        <meshStandardMaterial color="#334155" roughness={0.5} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.6, 0.4]} castShadow>
        <boxGeometry args={[3.6, 0.4, 0.6]} />
        <meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh position={[-0.8, 1.2, -0.4]} rotation={[0, 0.2, 0]}>
        <boxGeometry args={[0.5, 0.35, 0.05]} />
        <meshStandardMaterial color="#0284c7" emissive="#0284c7" emissiveIntensity={0.6} />
      </mesh>
      <mesh position={[0.6, 0.95, 0.4]} castShadow>
        <boxGeometry args={[0.45, 0.35, 0.45]} />
        <meshStandardMaterial color="#b45309" roughness={0.9} />
      </mesh>
      <mesh position={[-0.2, 0.9, 0.4]} castShadow>
        <boxGeometry args={[0.4, 0.3, 0.4]} />
        <meshStandardMaterial color="#d97706" roughness={0.9} />
      </mesh>
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
      <mesh castShadow receiveShadow position={[0, 0, 0]}>
        <boxGeometry args={[1.0, 1.7, 1.0]} />
        <meshStandardMaterial
          color={isSelected ? '#38bdf8' : isSwapTarget ? '#a855f7' : '#1e293b'}
          roughness={0.4}
          metalness={0.7}
        />
      </mesh>
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
      {isSelected && (
        <mesh position={[0, 1.05, 0]}>
          <ringGeometry args={[0.3, 0.55, 32]} />
          <meshBasicMaterial color="#38bdf8" side={THREE.DoubleSide} />
        </mesh>
      )}
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

// Continuous polyline representing the full planned tour on the floor
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
    <primitive object={new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: '#10b981', linewidth: 3 }))} />
  );
}

// Numbered floating markers and glowing floor rings for active batch targets
function BatchTargetMarkers({ stops, currentSegmentIdx }) {
  return (
    <group>
      {stops.map((stop) => {
        const [wx, , wz] = gridToWorld(stop.rackX, stop.rackY, 0);
        const isCurrent = currentSegmentIdx === stop.stopNumber - 1;
        const isCompleted = currentSegmentIdx > stop.stopNumber - 1;
        const ringColor = isCurrent ? '#38bdf8' : isCompleted ? '#10b981' : '#f59e0b';

        return (
          <group key={stop.slotId} position={[wx, 0, wz]}>
            {/* Glowing Floor Ring */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
              <ringGeometry args={[0.55, 0.9, 32]} />
              <meshBasicMaterial
                color={ringColor}
                side={THREE.DoubleSide}
                transparent
                opacity={isCurrent ? 0.9 : 0.45}
              />
            </mesh>

            {/* Numbered Floating Marker Badge */}
            <group position={[0, 2.3, 0]}>
              <mesh>
                <sphereGeometry args={[0.32, 16, 16]} />
                <meshStandardMaterial
                  color={isCurrent ? '#0284c7' : isCompleted ? '#059669' : '#d97706'}
                  emissive={ringColor}
                  emissiveIntensity={isCurrent ? 0.8 : 0.4}
                />
              </mesh>
              <Text
                position={[0, 0, 0.35]}
                fontSize={0.34}
                color="#ffffff"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.03}
                outlineColor="#0f172a"
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
// 5. AGV PICKER COMPONENT (USEFRAME STATE MACHINE)
// ==========================================
function AGVController({
  segments,
  currentSegmentIdx,
  isPlaying,
  simSpeed,
  carriedBoxCount,
  onSegmentComplete,
  onTripComplete,
  onPickAction,
  onPositionUpdate,
}) {
  const groupRef = useRef();
  const beaconRef = useRef();

  // State Machine Refs (avoids 60fps re-render overhead)
  const segmentIdxRef = useRef(0);
  const waypointIdxRef = useRef(0);
  const progressRef = useRef(0);
  const stateRef = useRef('DRIVING'); // 'DRIVING' | 'PICKING'
  const pauseTimerRef = useRef(0);
  const angleRef = useRef(0);

  // Sync segment index when parent changes it or resets
  useEffect(() => {
    segmentIdxRef.current = currentSegmentIdx;
    waypointIdxRef.current = 0;
    progressRef.current = 0;
    stateRef.current = 'DRIVING';
  }, [currentSegmentIdx]);

  useFrame((_, delta) => {
    if (beaconRef.current) {
      beaconRef.current.rotation.y += delta * 8;
    }

    if (!isPlaying || !segments || segments.length === 0) return;

    const currentSeg = segments[segmentIdxRef.current];
    if (!currentSeg || !currentSeg.path || currentSeg.path.length === 0) return;

    // 1. PICKING PAUSE STATE
    if (stateRef.current === 'PICKING') {
      pauseTimerRef.current -= delta * simSpeed;
      if (pauseTimerRef.current <= 0) {
        // Pick pause completed! Trigger increment and transition to next segment
        onPickAction();
        const nextIdx = segmentIdxRef.current + 1;
        if (nextIdx < segments.length) {
          segmentIdxRef.current = nextIdx;
          waypointIdxRef.current = 0;
          progressRef.current = 0;
          stateRef.current = 'DRIVING';
          onSegmentComplete(nextIdx);
        }
      }
      return;
    }

    // 2. DRIVING STATE
    const path = currentSeg.path;
    const wpIdx = waypointIdxRef.current;

    // Check if reached end of current segment
    if (wpIdx >= path.length - 1) {
      if (currentSeg.isDock) {
        // Return to dock segment complete! Entire trip finishes.
        stateRef.current = 'DOCK_IDLE';
        onTripComplete();
      } else {
        // Arrived at a pick rack stop! Enter PICKING pause
        stateRef.current = 'PICKING';
        pauseTimerRef.current = Math.max(0.12, 0.65 / Math.min(simSpeed, 8));
      }
      return;
    }

    // Interpolate between path[wpIdx] and path[wpIdx + 1]
    const p0 = gridToWorld(path[wpIdx].x, path[wpIdx].y, 0);
    const p1 = gridToWorld(path[wpIdx + 1].x, path[wpIdx + 1].y, 0);
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

    if (groupRef.current) {
      groupRef.current.position.set(posX, 0, posZ);
      groupRef.current.rotation.y = THREE.MathUtils.lerp(
        groupRef.current.rotation.y,
        angleRef.current,
        0.25
      );
    }

    if (onPositionUpdate) {
      onPositionUpdate([posX, 0, posZ]);
    }
  });

  return (
    <group ref={groupRef} position={gridToWorld(DOCK_COORD.x, DOCK_COORD.y, 0)}>
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
          <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={1.4} />
        </mesh>
      </group>

      {/* Operator Avatar (Human in High-Vis Vest & Helmet) */}
      <group position={[0, 0, -0.9]}>
        <mesh position={[-0.14, 0.45, 0]}>
          <cylinderGeometry args={[0.08, 0.08, 0.6, 12]} />
          <meshStandardMaterial color="#1e293b" />
        </mesh>
        <mesh position={[0.14, 0.45, 0]}>
          <cylinderGeometry args={[0.08, 0.08, 0.6, 12]} />
          <meshStandardMaterial color="#1e293b" />
        </mesh>
        <mesh position={[0, 1.0, 0]} castShadow>
          <boxGeometry args={[0.42, 0.55, 0.26]} />
          <meshStandardMaterial color="#eab308" roughness={0.5} />
        </mesh>
        <mesh position={[0, 1.02, 0.14]}>
          <planeGeometry args={[0.38, 0.08]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
        <mesh position={[0, 1.45, 0]} castShadow>
          <sphereGeometry args={[0.14, 16, 16]} />
          <meshStandardMaterial color="#fcd34d" roughness={0.8} />
        </mesh>
        <mesh position={[0, 1.54, 0]}>
          <cylinderGeometry args={[0.18, 0.17, 0.1, 16]} />
          <meshStandardMaterial color="#ffffff" metalness={0.2} roughness={0.3} />
        </mesh>
      </group>

      {/* Dynamic Stacked Cargo Boxes */}
      <group position={[0, 0.42, 0.15]}>
        {Array.from({ length: Math.min(carriedBoxCount, 8) }).map((_, idx) => {
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

// Camera Manager for View Presets
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
// 6. MAIN APPLICATION COMPONENT
// ==========================================
export default function App() {
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const [baselineLayout, setBaselineLayout] = useState({});
  const [customLayout, setCustomLayout] = useState({});
  const [activeLayoutView, setActiveLayoutView] = useState('CUSTOM');

  const [batchSize, setBatchSize] = useState(3);
  const [simSpeed, setSimSpeed] = useState(5);
  const [isPlaying, setIsPlaying] = useState(true);

  const [selectedSlotId, setSelectedSlotId] = useState(null);
  const [swapFeedback, setSwapFeedback] = useState(null);
  const [hoveredProduct, setHoveredProduct] = useState(null);
  const [cameraMode, setCameraMode] = useState('PERSPECTIVE');

  // UI Panels Collapsible State
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  // Active Batch Trip State Machine
  const [batchStartIndex, setBatchStartIndex] = useState(0);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);
  const [boxesOnCart, setBoxesOnCart] = useState(0);
  const [pickerWorldPos, setPickerWorldPos] = useState(gridToWorld(DOCK_COORD.x, DOCK_COORD.y, 0));

  // Live Cumulative Simulation Metrics
  const [liveStats, setLiveStats] = useState({
    tripsCompleted: 0,
    ordersProcessed: 0,
    distanceWalkedM: 0,
    secondsElapsed: 0,
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

  // Instant Full-Month Benchmark across all 1,367 orders
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

  // Active Batch Orders Slice
  const currentBatchOrders = useMemo(() => {
    if (!orders || orders.length === 0) return [];
    const end = Math.min(batchStartIndex + batchSize, orders.length);
    return orders.slice(batchStartIndex, end);
  }, [orders, batchStartIndex, batchSize]);

  // Active Batch Stops (TSP-Ordered)
  const currentBatchStops = useMemo(() => {
    if (!currentBatchOrders || currentBatchOrders.length === 0) return [];

    const activeProdToSlot = activeLayoutView === 'BASELINE' ? baselineProdToSlot : customProdToSlot;
    const uniqueSlotMap = new Map();

    for (const ord of currentBatchOrders) {
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
              if (!existing.orderIds.includes(ord.order_id)) {
                existing.orderIds.push(ord.order_id);
              }
            }
          }
        }
      }
    }

    const rawStops = Array.from(uniqueSlotMap.values());
    const ordered = batchSize > 1 ? solveNearestNeighborTSP(DOCK_COORD, rawStops, getCachedDistance) : rawStops;

    return ordered.map((s, idx) => ({ ...s, stopNumber: idx + 1 }));
  }, [currentBatchOrders, activeLayoutView, baselineProdToSlot, customProdToSlot, slotsWithDistances, batchSize]);

  // SEGMENTED ROUTE CONSTRUCTION
  // [Segment 0: Dock -> Stop 1, Segment 1: Stop 1 -> Stop 2, ..., Segment K: Stop K -> Dock]
  const currentTripSegments = useMemo(() => {
    if (!currentBatchStops || currentBatchStops.length === 0) return [];

    const segments = [];
    let startPoint = DOCK_COORD;

    for (let i = 0; i < currentBatchStops.length; i++) {
      const stop = currentBatchStops[i];
      const endPoint = { x: stop.pickX, y: stop.pickY };
      const path = findAStarPath(startPoint, endPoint);

      segments.push({
        segmentIndex: i,
        start: startPoint,
        end: endPoint,
        path,
        targetSlot: stop,
        items: stop.items,
        totalUnits: stop.totalUnits,
        isDock: false,
        stopNumber: i + 1,
      });

      startPoint = endPoint;
    }

    // Return to Packing Dock segment
    const returnPath = findAStarPath(startPoint, DOCK_COORD);
    segments.push({
      segmentIndex: currentBatchStops.length,
      start: startPoint,
      end: DOCK_COORD,
      path: returnPath,
      targetSlot: null,
      items: [],
      totalUnits: 0,
      isDock: true,
      stopNumber: null,
    });

    return segments;
  }, [currentBatchStops]);

  // Full continuous path ribbon for the current batch
  const fullBatchWaypoints = useMemo(() => {
    if (!currentTripSegments || currentTripSegments.length === 0) return [];
    const full = [];
    currentTripSegments.forEach((seg, sIdx) => {
      if (seg.path && seg.path.length > 0) {
        if (sIdx === 0) {
          full.push(...seg.path);
        } else {
          full.push(...seg.path.slice(1));
        }
      }
    });
    return full;
  }, [currentTripSegments]);

  // Handle slot swapping
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
    [activeLayoutView, selectedSlotId, customLayout]
  );

  const handleResetToBaseline = useCallback(() => {
    setCustomLayout({ ...baselineLayout });
    setSelectedSlotId(null);
    setSwapFeedback({ type: 'info', text: 'Reset custom layout to Optimal Baseline!' });
    resetSimulation();
    setTimeout(() => setSwapFeedback(null), 3000);
  }, [baselineLayout]);

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
  }, [customLayout]);

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

  const handleBatchSizeChange = (newSize) => {
    setBatchSize(newSize);
    resetSimulation();
    setSwapFeedback({
      type: 'info',
      text: newSize === 1 ? 'Single Order Picking' : `Batch Picking Enabled (${newSize} Orders via Nearest-Neighbor TSP)`,
    });
    setTimeout(() => setSwapFeedback(null), 3000);
  };

  const resetSimulation = () => {
    setBatchStartIndex(0);
    setCurrentSegmentIndex(0);
    setBoxesOnCart(0);
    setLiveStats({
      tripsCompleted: 0,
      ordersProcessed: 0,
      distanceWalkedM: 0,
      secondsElapsed: 0,
    });
  };

  // Callback when a segment completes pick pause
  const handleSegmentComplete = (nextSegIdx) => {
    setCurrentSegmentIndex(nextSegIdx);
  };

  // Callback when items are picked at a rack stop
  const handlePickAction = () => {
    setBoxesOnCart((prev) => prev + 1);
  };

  // Callback when the final return to dock segment finishes
  const handleTripComplete = () => {
    // 1. Calculate this trip's distance & time
    let tripDistance = 0;
    currentTripSegments.forEach((seg) => {
      tripDistance += Math.max(0, seg.path.length - 1) * CELL_SIZE;
    });

    const linesInBatch = currentBatchOrders.reduce((sum, o) => sum + o.lines.length, 0);
    const tripSeconds = (tripDistance / HUMAN_WALK_SPEED) + (linesInBatch * ITEM_PICK_TIME);

    // 2. Increment live stats
    setLiveStats((prev) => ({
      tripsCompleted: prev.tripsCompleted + 1,
      ordersProcessed: prev.ordersProcessed + currentBatchOrders.length,
      distanceWalkedM: prev.distanceWalkedM + tripDistance,
      secondsElapsed: prev.secondsElapsed + tripSeconds,
    }));

    // 3. Reset cargo and advance to next batch
    setBoxesOnCart(0);
    setCurrentSegmentIndex(0);
    setBatchStartIndex((prev) => (prev + batchSize) % (orders.length || 1));
  };

  const activeLayoutMap = activeLayoutView === 'BASELINE' ? baselineLayout : customLayout;
  const currentSegment = currentTripSegments[currentSegmentIndex];

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
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 select-none">
      {/* ====================================================
          1. 3D CANVAS SCENE (FULLSCREEN UNOBSTRUCTED)
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

        <WarehouseFloor />
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

        {/* Continuous Full Batch Tour Path Ribbon */}
        <ActivePathRibbon waypoints={fullBatchWaypoints} />

        {/* Numbered 3D Floating Markers & Glowing Floor Rings for Active Batch */}
        <BatchTargetMarkers
          stops={currentBatchStops}
          currentSegmentIdx={currentSegmentIndex}
        />

        {/* AGV Picker Mesh driven by useFrame State Machine */}
        <AGVController
          segments={currentTripSegments}
          currentSegmentIdx={currentSegmentIndex}
          isPlaying={isPlaying}
          simSpeed={simSpeed}
          carriedBoxCount={boxesOnCart}
          onSegmentComplete={handleSegmentComplete}
          onTripComplete={handleTripComplete}
          onPickAction={handlePickAction}
          onPositionUpdate={setPickerWorldPos}
        />

        <CameraController cameraMode={cameraMode} pickerPos={pickerWorldPos} />
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
      <header className="absolute top-3 left-4 right-4 flex items-center justify-between gap-3 pointer-events-none z-20">
        {/* Title & Active Mode */}
        <div className="flex items-center gap-2 bg-slate-900/95 backdrop-blur-md px-3.5 py-1.5 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-extrabold tracking-wide text-white">NEXAI TWIN</span>
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

        {/* Center: Batch Size Selector */}
        <div className="flex items-center gap-1 bg-slate-900/95 backdrop-blur-md p-1 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <span className="text-[10px] font-semibold text-slate-400 px-1.5">Batch:</span>
          {[
            { size: 1, label: '1x Single' },
            { size: 3, label: '3x TSP' },
            { size: 5, label: '5x Mega' },
          ].map(({ size, label }) => (
            <button
              key={size}
              onClick={() => handleBatchSizeChange(size)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition ${
                batchSize === size
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Right: Play/Pause & Speed */}
        <div className="flex items-center gap-1.5 bg-slate-900/95 backdrop-blur-md p-1 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition flex items-center gap-1 ${
              isPlaying
                ? 'bg-amber-600/90 hover:bg-amber-500 text-white'
                : 'bg-emerald-600/90 hover:bg-emerald-500 text-white'
            }`}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <div className="h-4 w-px bg-slate-700 mx-0.5" />
          {[1, 5, 10, 25].map((spd) => (
            <button
              key={spd}
              onClick={() => setSimSpeed(spd)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition ${
                simSpeed === spd
                  ? 'bg-sky-500 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {spd}x
            </button>
          ))}
        </div>
      </header>

      {/* ====================================================
          4. LEFT COLLAPSIBLE PANEL (SLOTTING & CONTROLS)
      ==================================================== */}
      <div className="absolute top-16 left-4 z-20 pointer-events-none">
        {leftPanelOpen ? (
          <aside className="w-72 bg-slate-900/95 backdrop-blur-md p-3.5 rounded-2xl border border-slate-700/60 shadow-2xl pointer-events-auto space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="text-xs font-bold text-slate-200 uppercase tracking-wide flex items-center gap-1.5">
                <span>⚙️</span> Slotting & Camera
              </span>
              <button
                onClick={() => setLeftPanelOpen(false)}
                className="text-slate-400 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-slate-800"
                title="Collapse panel"
              >
                ✕
              </button>
            </div>

            {/* Camera Angle Presets */}
            <div className="space-y-1">
              <div className="text-[10px] font-semibold text-slate-400 uppercase">Camera View</div>
              <div className="grid grid-cols-3 gap-1">
                <button
                  onClick={() => setCameraMode('PERSPECTIVE')}
                  className={`py-1 text-[10px] font-semibold rounded-lg transition ${
                    cameraMode === 'PERSPECTIVE'
                      ? 'bg-sky-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Isometric
                </button>
                <button
                  onClick={() => setCameraMode('TOP')}
                  className={`py-1 text-[10px] font-semibold rounded-lg transition ${
                    cameraMode === 'TOP'
                      ? 'bg-sky-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Top-Down
                </button>
                <button
                  onClick={() => setCameraMode('FOLLOW')}
                  className={`py-1 text-[10px] font-semibold rounded-lg transition ${
                    cameraMode === 'FOLLOW'
                      ? 'bg-sky-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
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
                    Slot <strong>#{selectedSlotId}</strong> selected — click any rack to swap!
                  </span>
                  <button
                    onClick={() => setSelectedSlotId(null)}
                    className="text-red-400 hover:underline text-[10px] font-bold ml-1"
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

            {/* Heatmap Legend */}
            <div className="pt-1 border-t border-slate-800">
              <div className="text-[9px] font-semibold text-slate-400 mb-1 uppercase">
                Pick Velocity Heatmap
              </div>
              <div className="flex justify-between text-[9px] text-slate-300">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-[#ef4444]" /> Top 15
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-[#f97316]" /> 16-35
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-[#eab308]" /> 36-60
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-[#10b981]" /> 61-85
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-[#3b82f6]" /> 86-100
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
          <aside className="w-84 bg-slate-900/95 backdrop-blur-md p-3.5 rounded-2xl border border-slate-700/60 shadow-2xl pointer-events-auto space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="text-xs font-bold text-slate-200 uppercase tracking-wide flex items-center gap-1.5">
                <span>⚡</span> Instant Benchmark (1,367 Orders)
              </span>
              <button
                onClick={() => setRightPanelOpen(false)}
                className="text-slate-400 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-slate-800"
                title="Collapse panel"
              >
                ✕
              </button>
            </div>

            {/* 3-Tier Monthly Benchmark Summary */}
            {monthlyBenchmark && (
              <div className="space-y-1.5 text-xs">
                {/* 1. Baseline Single */}
                <div className="bg-slate-950/70 p-2 rounded-lg border border-sky-500/20 flex justify-between items-center">
                  <div>
                    <div className="text-[10px] text-sky-400 font-bold">1. Baseline (Single)</div>
                    <div className="text-[11px] text-slate-300">
                      {monthlyBenchmark.baselineSingle.distanceKm} km • {monthlyBenchmark.baselineSingle.timeHours} hrs
                    </div>
                  </div>
                  <span className="text-[10px] text-slate-500">Ref</span>
                </div>

                {/* 2. Custom Single */}
                <div className="bg-slate-950/70 p-2 rounded-lg border border-purple-500/20 flex justify-between items-center">
                  <div>
                    <div className="text-[10px] text-purple-400 font-bold">2. Custom (Single)</div>
                    <div className="text-[11px] text-slate-300">
                      {monthlyBenchmark.customSingle.distanceKm} km • {monthlyBenchmark.customSingle.timeHours} hrs
                    </div>
                  </div>
                  <span className="text-[10px] text-purple-300 font-semibold">Active</span>
                </div>

                {/* 3. Custom Batched TSP */}
                <div className="bg-indigo-950/60 p-2 rounded-lg border border-indigo-500/40 ring-1 ring-indigo-500/30 flex justify-between items-center">
                  <div>
                    <div className="text-[10px] text-emerald-400 font-bold">
                      3. Custom ({monthlyBenchmark.benchmarkBatchSize}x Batch + TSP)
                    </div>
                    <div className="text-[11px] font-extrabold text-white">
                      {monthlyBenchmark.customBatched.distanceKm} km • {monthlyBenchmark.customBatched.timeHours} hrs
                    </div>
                  </div>
                  <span className="text-[10px] font-bold bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">
                    -{monthlyBenchmark.distSavedVsCustomSinglePct}%
                  </span>
                </div>

                {/* Savings Callout */}
                <div className="p-2 bg-gradient-to-r from-emerald-950/80 to-indigo-950/80 border border-emerald-500/40 rounded-lg text-center text-[11px] text-emerald-300 font-semibold">
                  Saves {monthlyBenchmark.distSavedVsCustomSingleKm} km & {monthlyBenchmark.timeSavedVsCustomSingleHours} labor hrs/mo!
                </div>
              </div>
            )}

            {/* Live Trip Progress Card */}
            <div className="space-y-2 pt-2 border-t border-slate-800">
              <div className="flex justify-between items-center text-xs">
                <span className="font-bold text-slate-300 flex items-center gap-1.5">
                  <span>🚚</span> Active Trip (
                  {currentBatchOrders.map((o) => `#${o.order_id}`).join(', ')})
                </span>
                <span className="text-[10px] font-mono bg-slate-800 text-sky-300 px-1.5 py-0.5 rounded">
                  {currentSegment && !currentSegment.isDock
                    ? `Stop ${currentSegment.stopNumber} / ${currentBatchStops.length}`
                    : 'Returning to Dock'}
                </span>
              </div>

              {/* Target Stop Details */}
              {currentSegment && !currentSegment.isDock && currentSegment.targetSlot ? (
                <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800 text-xs space-y-0.5">
                  <div className="text-sky-300 font-bold flex justify-between">
                    <span>Target: Slot #{currentSegment.targetSlot.slotId}</span>
                    <span className="text-[10px] text-slate-400">
                      Units: {currentSegment.totalUnits}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {currentSegment.items[0]?.stock_code} - {currentSegment.items[0]?.description}
                  </div>
                </div>
              ) : (
                <div className="bg-emerald-950/50 p-2 rounded-lg border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  All Batch Items Collected! Unloading at Dock...
                </div>
              )}

              {/* Live Cumulative Counters */}
              <div className="grid grid-cols-3 gap-1 pt-1 text-center">
                <div className="bg-slate-950/60 p-1.5 rounded-lg border border-slate-800">
                  <div className="text-[9px] text-slate-500">Trips</div>
                  <div className="text-xs font-bold text-white">{liveStats.tripsCompleted}</div>
                </div>
                <div className="bg-slate-950/60 p-1.5 rounded-lg border border-slate-800">
                  <div className="text-[9px] text-slate-500">Orders</div>
                  <div className="text-xs font-bold text-white">{liveStats.ordersProcessed}</div>
                </div>
                <div className="bg-slate-950/60 p-1.5 rounded-lg border border-slate-800">
                  <div className="text-[9px] text-slate-500">Live Dist</div>
                  <div className="text-xs font-bold text-emerald-400">
                    {liveStats.distanceWalkedM.toFixed(0)}m
                  </div>
                </div>
              </div>
            </div>

            {/* Hovered Product Card */}
            {hoveredProduct && (
              <div className="p-2 bg-slate-950/90 border border-sky-500/30 rounded-lg text-xs space-y-0.5">
                <div className="flex justify-between font-bold text-sky-300">
                  <span>{hoveredProduct.stock_code}</span>
                  <span className="text-[10px] text-slate-400">Rank #{hoveredProduct.rank}</span>
                </div>
                <div className="text-[10px] text-slate-300 truncate">{hoveredProduct.description}</div>
                <div className="text-[10px] text-slate-400">
                  Picks: {hoveredProduct.pick_frequency} • Qty: {hoveredProduct.total_quantity_picked}
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
