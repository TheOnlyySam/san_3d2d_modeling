import { Fragment, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { BufferGeometry, CanvasTexture, DoubleSide, LineBasicMaterial, LineLoop, RepeatWrapping, Shape, Vector3, Line as ThreeLine } from "three";
import {
  RACK_BASE_CLEARANCE,
  RU_HEIGHT,
  getConnectionAnchor,
  getOpeningBounds,
  getRoomFootprint,
  getTraySegments,
  getWallSegments,
  normalizeConnection,
  pointAlongWall,
} from "./modeling.js";

const HARDWARE_COLORS = {
  red: "#c73a3a",
  blue: "#2e68b7",
  green: "#3a7a48",
  yellow: "#be8a12",
  purple: "#6942a8",
};

function floorShape(points) {
  const shape = new Shape();
  points.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, point.y);
    else shape.lineTo(point.x, point.y);
  });
  shape.closePath();
  return shape;
}

function getBounds(points) {
  return points.reduce(
    (acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minY: Math.min(acc.minY, point.y),
      maxY: Math.max(acc.maxY, point.y),
    }),
    { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY }
  );
}

function createTileTexture(tileSize, width, depth) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(159, 132, 82, 0.45)";
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(Math.max(width / tileSize, 1), Math.max(depth / tileSize, 1));
  return texture;
}

function RaisedFloor({ shape, footprint, room, tileTexture }) {
  const points = [...footprint, footprint[0]];
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color="#d9d3c7" side={DoubleSide} />
      </mesh>

      {room.floorElevation > 0 ? (
        points.slice(0, -1).map((point, index) => {
          const next = points[index + 1];
          const dx = next.x - point.x;
          const dz = next.y - point.y;
          const length = Math.hypot(dx, dz);
          const angle = Math.atan2(dz, dx);
          return (
            <mesh
              key={`floor-edge-${index}`}
              position={[
                (point.x + next.x) / 2,
                room.floorElevation / 2,
                (point.y + next.y) / 2,
              ]}
              rotation={[0, -angle, 0]}
            >
              <boxGeometry args={[length, room.floorElevation, 30]} />
              <meshStandardMaterial color="#c2b59b" transparent opacity={0.28} />
            </mesh>
          );
        })
      ) : null}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, room.floorElevation, 0]}>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color="#e7d8ba" map={tileTexture} side={DoubleSide} transparent opacity={0.42} />
      </mesh>
    </>
  );
}

function Polyline3D({ points, color, loop = false }) {
  const object = useMemo(() => {
    const geometry = new BufferGeometry().setFromPoints(
      points.map((point) => new Vector3(point[0], point[1], point[2]))
    );
    const material = new LineBasicMaterial({ color });
    return loop ? new LineLoop(geometry, material) : new ThreeLine(geometry, material);
  }, [color, loop, points]);

  return <primitive object={object} />;
}

function SelectionOutline({ width, depth, y = 6 }) {
  const points = [
    [-width / 2, y, -depth / 2],
    [width / 2, y, -depth / 2],
    [width / 2, y, depth / 2],
    [-width / 2, y, depth / 2],
  ];
  return <Polyline3D points={points} color="#f08b00" loop />;
}

function OpeningMarker({ wall, opening, room, selected, centerOffset }) {
  const bounds = getOpeningBounds(opening, wall, room);
  const start = pointAlongWall(wall, bounds.start);
  const end = pointAlongWall(wall, bounds.end);
  const center = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const verticalCenter = room.floorElevation + bounds.sill + (bounds.top - bounds.sill) / 2;

  return (
    <group position={[center.x - centerOffset.x, verticalCenter, center.y - centerOffset.y]} rotation={[0, -wall.angle, 0]}>
      <mesh>
        <boxGeometry args={[length, Math.max(bounds.top - bounds.sill, 40), 20]} />
        <meshStandardMaterial
          color={selected ? "#f08b00" : opening.type === "door" ? "#b55d2f" : "#4a88b2"}
          transparent
          opacity={0.45}
        />
      </mesh>
    </group>
  );
}

function WallMeshes({ room, openings, selectedTarget, centerOffset }) {
  const walls = useMemo(() => getWallSegments(room), [room]);

  return (
    <>
      {walls.map((wall) => {
        const wallOpenings = openings
          .map((opening, index) => ({ opening, index }))
          .filter(({ opening }) => opening.wall === wall.index)
          .map(({ opening, index }) => ({ opening, index, bounds: getOpeningBounds(opening, wall, room) }))
          .sort((a, b) => a.bounds.start - b.bounds.start);

        const sections = [];
        let cursor = 0;
        wallOpenings.forEach(({ bounds }) => {
          if (bounds.start > cursor) sections.push({ start: cursor, end: bounds.start, z0: 0, z1: room.height });
          if (bounds.sill > 0) sections.push({ start: bounds.start, end: bounds.end, z0: 0, z1: bounds.sill });
          if (bounds.top < room.height) sections.push({ start: bounds.start, end: bounds.end, z0: bounds.top, z1: room.height });
          cursor = bounds.end;
        });
        if (cursor < wall.length) sections.push({ start: cursor, end: wall.length, z0: 0, z1: room.height });

        return (
          <Fragment key={`wall-${wall.index}`}>
            {sections
              .filter((section) => section.end - section.start > 25 && section.z1 - section.z0 > 25)
              .map((section, index) => {
                const segmentLength = section.end - section.start;
                const center = pointAlongWall(wall, section.start + segmentLength / 2);
                return (
                  <mesh
                    key={`wall-${wall.index}-${index}`}
                    position={[center.x - centerOffset.x, room.floorElevation + section.z0 + (section.z1 - section.z0) / 2, center.y - centerOffset.y]}
                    rotation={[0, -wall.angle, 0]}
                  >
                    <boxGeometry args={[segmentLength, section.z1 - section.z0, room.wallThickness || 160]} />
                    <meshStandardMaterial color="#d8c6a2" />
                  </mesh>
                );
              })}
            {wallOpenings.map(({ opening, index }) => (
              <OpeningMarker
                key={`opening-marker-${index}`}
                wall={wall}
                opening={opening}
                room={room}
                selected={selectedTarget?.kind === "opening" && selectedTarget.index === index}
                centerOffset={centerOffset}
              />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

function EquipmentMeshes({ equipment, selectedTarget, centerOffset, floorElevation }) {
  return equipment.map((item, index) => {
    const selected = selectedTarget?.kind === "equipment" && selectedTarget.index === index;
    const color = HARDWARE_COLORS[item.colorKey] || HARDWARE_COLORS.red;
    if (item.type === "cabinet") {
      const wallThickness = 18;
      const innerWidth = Math.max(item.width - wallThickness * 2, 50);
      const innerDepth = Math.max(item.depth - wallThickness * 2, 50);
      const leftCenter = -item.width / 2 + wallThickness / 2;
      const rightCenter = item.width / 2 - wallThickness / 2;
      const topCenter = item.height / 2 - wallThickness / 2;
      const bottomCenter = -item.height / 2 + wallThickness / 2;
      const frontCenter = -item.depth / 2 + wallThickness / 2;
      const rearCenter = item.depth / 2 - wallThickness / 2;
      const frontTransparent = (item.frontFace || "transparent") === "transparent";
      const rearTransparent = (item.rearFace || "transparent") === "transparent";
      const frontRemoved = item.frontFace === "removed";
      const rearRemoved = item.rearFace === "removed";
      return (
        <group
          key={`equipment-${index}`}
          position={[item.x - centerOffset.x, floorElevation + item.height / 2, item.y - centerOffset.y]}
          rotation={[0, item.rotationDeg * (Math.PI / 180), 0]}
        >
          <mesh position={[leftCenter, 0, 0]}>
            <boxGeometry args={[wallThickness, item.height, item.depth]} />
            <meshStandardMaterial color={selected ? "#f08b00" : color} />
          </mesh>
          <mesh position={[rightCenter, 0, 0]}>
            <boxGeometry args={[wallThickness, item.height, item.depth]} />
            <meshStandardMaterial color={selected ? "#f08b00" : color} />
          </mesh>
          <mesh position={[0, topCenter, 0]}>
            <boxGeometry args={[innerWidth, wallThickness, item.depth]} />
            <meshStandardMaterial color={selected ? "#f08b00" : color} />
          </mesh>
          <mesh position={[0, bottomCenter, 0]}>
            <boxGeometry args={[innerWidth, wallThickness, item.depth]} />
            <meshStandardMaterial color={selected ? "#f08b00" : color} />
          </mesh>
          {!frontRemoved ? (
            <mesh position={[0, 0, frontCenter]}>
              <boxGeometry args={[innerWidth, item.height - wallThickness * 2, wallThickness]} />
              <meshStandardMaterial color={selected ? "#f08b00" : color} transparent opacity={frontTransparent ? 0.2 : 1} />
            </mesh>
          ) : null}
          {!rearRemoved ? (
            <mesh position={[0, 0, rearCenter]}>
              <boxGeometry args={[innerWidth, item.height - wallThickness * 2, wallThickness]} />
              <meshStandardMaterial color={selected ? "#f08b00" : color} transparent opacity={rearTransparent ? 0.2 : 1} />
            </mesh>
          ) : null}
          {selected ? <SelectionOutline width={item.width + 80} depth={item.depth + 80} y={item.height / 2 + 8} /> : null}
        </group>
      );
    }

    const mountedCabinet = item.mountedIn !== null && item.mountedIn !== undefined ? equipment[item.mountedIn] : null;
    const mountedX = mountedCabinet ? mountedCabinet.x : item.x;
    const mountedZ = mountedCabinet ? mountedCabinet.y : item.y;
    const mountedY = mountedCabinet
      ? floorElevation + ((item.rackStart || 1) - 1) * RU_HEIGHT + item.height / 2 + RACK_BASE_CLEARANCE
      : floorElevation + item.height / 2;
    const drawWidth = mountedCabinet ? Math.min(item.width, mountedCabinet.width - 120) : item.width;
    const drawDepth = mountedCabinet ? Math.min(item.depth, mountedCabinet.depth - 180) : item.depth;
    return (
      <group
        key={`equipment-${index}`}
        position={[mountedX - centerOffset.x, mountedY, mountedZ - centerOffset.y]}
        rotation={[0, (mountedCabinet ? mountedCabinet.rotationDeg : item.rotationDeg) * (Math.PI / 180), 0]}
      >
        <mesh>
          <boxGeometry args={[drawWidth, item.height, drawDepth]} />
          <meshStandardMaterial color={selected ? "#f08b00" : color} />
        </mesh>
        {selected ? <SelectionOutline width={drawWidth + 80} depth={drawDepth + 80} y={item.height / 2 + 8} /> : null}
      </group>
    );
  });
}

function TrayMeshes({ trays, selectedTarget, centerOffset, floorElevation }) {
  return trays.flatMap((tray, trayIndex) =>
    getTraySegments(tray).map((segment, segmentIndex) => {
      const dx = segment.end.x - segment.start.x;
      const dy = segment.end.y - segment.start.y;
      const length = Math.hypot(dx, dy);
      if (length <= 0) return null;
      const selected = selectedTarget?.kind === "tray" && selectedTarget.index === trayIndex;
      return (
        <group
          key={`tray-${trayIndex}-${segmentIndex}`}
          position={[
            (segment.start.x + segment.end.x) / 2 - centerOffset.x,
            floorElevation + tray.z,
            (segment.start.y + segment.end.y) / 2 - centerOffset.y,
          ]}
          rotation={[0, Math.atan2(dy, dx), 0]}
        >
          <mesh>
            <boxGeometry args={[length, tray.depth, tray.width]} />
            <meshStandardMaterial color={selected ? "#f08b00" : "#c88f22"} />
          </mesh>
        </group>
      );
    })
  );
}

function ConnectionLines({ connections, equipment, trays, selectedTarget, centerOffset, floorElevation }) {
  return connections.map((connection, index) => {
    const normalized = normalizeConnection(connection);
    const from = getConnectionAnchor({ kind: normalized.fromKind, index: normalized.fromIndex }, equipment, trays);
    const to = getConnectionAnchor({ kind: normalized.toKind, index: normalized.toIndex }, equipment, trays);
    if (!from || !to) return null;
    const routeHeight = floorElevation + Math.max(normalized.routeHeight, from.z, to.z);
    const controlX = normalized.controlX ?? to.x;
    const controlY = normalized.controlY ?? from.y;
    const selected = selectedTarget?.kind === "connection" && selectedTarget.index === index;
    return (
      <Fragment key={`connection-${index}`}>
        <Polyline3D
          points={[
            [from.x - centerOffset.x, floorElevation + from.z, from.y - centerOffset.y],
            [from.x - centerOffset.x, routeHeight, from.y - centerOffset.y],
            [controlX - centerOffset.x, routeHeight, controlY - centerOffset.y],
            [to.x - centerOffset.x, routeHeight, to.y - centerOffset.y],
            [to.x - centerOffset.x, floorElevation + to.z, to.y - centerOffset.y],
          ]}
          color={selected ? "#f08b00" : normalized.color}
        />
      </Fragment>
    );
  });
}

export default function Scene3D({ room, openings, equipment, trays, connections, selectedTarget }) {
  const footprint = useMemo(() => getRoomFootprint(room), [room]);
  const center = useMemo(() => ({
    x: footprint.reduce((sum, point) => sum + point.x, 0) / footprint.length,
    y: footprint.reduce((sum, point) => sum + point.y, 0) / footprint.length,
  }), [footprint]);
  const centeredFootprint = useMemo(
    () => footprint.map((point) => ({ x: point.x - center.x, y: point.y - center.y })),
    [footprint, center]
  );
  const shape = useMemo(() => floorShape(centeredFootprint), [centeredFootprint]);
  const maxSpan = Math.max(room.width, room.length);
  const bounds = useMemo(() => getBounds(centeredFootprint), [centeredFootprint]);
  const tileSize = Math.max(room.floorTileSize || 600, 100);
  const gridDivisions = Math.max(Math.round((maxSpan * 2) / tileSize), 1);
  const tileTexture = useMemo(
    () => createTileTexture(tileSize, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY),
    [tileSize, bounds.maxX, bounds.minX, bounds.maxY, bounds.minY]
  );
  const cameraPosition = useMemo(
    () => [maxSpan * 0.85, room.floorElevation + room.height + maxSpan * 0.45, maxSpan * 0.85],
    [maxSpan, room.floorElevation, room.height]
  );

  return (
    <Canvas camera={{ position: cameraPosition, fov: 42, near: 10, far: 200000 }}>
      <color attach="background" args={["#fdf8ef"]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[room.width, room.height * 1.5, room.length]} intensity={1.1} />
      <directionalLight position={[-room.width, room.height, -room.length]} intensity={0.4} color="#ffe5bf" />

      <RaisedFloor shape={shape} footprint={centeredFootprint} room={room} tileTexture={tileTexture} />

      <WallMeshes room={room} openings={openings} selectedTarget={selectedTarget} centerOffset={center} />
      <EquipmentMeshes equipment={equipment} selectedTarget={selectedTarget} centerOffset={center} floorElevation={room.floorElevation} />
      <TrayMeshes trays={trays} selectedTarget={selectedTarget} centerOffset={center} floorElevation={room.floorElevation} />
      <ConnectionLines connections={connections} equipment={equipment} trays={trays} selectedTarget={selectedTarget} centerOffset={center} floorElevation={room.floorElevation} />

      <gridHelper args={[maxSpan * 2, gridDivisions, "#bca06e", "#e8dcc3"]} position={[0, 1, 0]} />
      <OrbitControls target={[0, room.floorElevation + room.height * 0.25, 0]} minDistance={maxSpan * 0.2} maxDistance={maxSpan * 4} makeDefault />
    </Canvas>
  );
}
