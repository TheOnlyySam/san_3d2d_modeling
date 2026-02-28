import { Fragment, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, Line } from "@react-three/drei";
import { Color, DoubleSide, Shape, Vector3 } from "three";
import {
  EQUIPMENT_PRESETS,
  getOpeningBounds,
  getRoomFootprint,
  getTraySegments,
  getWallSegments,
  pointAlongWall,
} from "./modeling.js";

function floorShape(points) {
  const shape = new Shape();
  points.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, point.y);
    else shape.lineTo(point.x, point.y);
  });
  shape.closePath();
  return shape;
}

function SelectionOutline({ width, depth, y = 6 }) {
  const points = [
    new Vector3(-width / 2, y, -depth / 2),
    new Vector3(width / 2, y, -depth / 2),
    new Vector3(width / 2, y, depth / 2),
    new Vector3(-width / 2, y, depth / 2),
    new Vector3(-width / 2, y, -depth / 2),
  ];
  return <Line points={points} color="#f08b00" lineWidth={2} />;
}

function OpeningMarker({ wall, opening, room, selected }) {
  const bounds = getOpeningBounds(opening, wall, room);
  const start = pointAlongWall(wall, bounds.start);
  const end = pointAlongWall(wall, bounds.end);
  const center = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const verticalCenter = bounds.sill + (bounds.top - bounds.sill) / 2;

  return (
    <mesh
      position={[center.x, verticalCenter, center.y]}
      rotation={[0, -wall.angle, 0]}
    >
      <boxGeometry args={[length, Math.max(bounds.top - bounds.sill, 40), 20]} />
      <meshStandardMaterial
        color={selected ? "#f08b00" : opening.type === "door" ? "#b55d2f" : "#4a88b2"}
        transparent
        opacity={0.45}
      />
    </mesh>
  );
}

function WallMeshes({ room, openings, selectedTarget }) {
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
                    position={[center.x, section.z0 + (section.z1 - section.z0) / 2, center.y]}
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
              />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

function EquipmentMeshes({ equipment, selectedTarget }) {
  return equipment.map((item, index) => {
    const preset = EQUIPMENT_PRESETS[item.type];
    const selected = selectedTarget?.kind === "equipment" && selectedTarget.index === index;
    return (
      <group key={`equipment-${index}`} position={[item.x, item.height / 2, item.y]} rotation={[0, item.rotationDeg * (Math.PI / 180), 0]}>
        <mesh>
          <boxGeometry args={[item.width, item.height, item.depth]} />
          <meshStandardMaterial color={new Color(selected ? "#f08b00" : preset.color3d)} />
        </mesh>
        {selected ? <SelectionOutline width={item.width + 80} depth={item.depth + 80} y={item.height / 2 + 8} /> : null}
      </group>
    );
  });
}

function TrayMeshes({ trays, selectedTarget }) {
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
          position={[(segment.start.x + segment.end.x) / 2, tray.z, (segment.start.y + segment.end.y) / 2]}
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

function ConnectionLines({ connections, equipment }) {
  return connections.map((connection, index) => {
    const from = equipment[connection.from];
    const to = equipment[connection.to];
    if (!from || !to) return null;
    const routeHeight = Math.max(connection.routeHeight, from.height, to.height);
    return (
      <Line
        key={`connection-${index}`}
        points={[
          [from.x, from.height, from.y],
          [from.x, routeHeight, from.y],
          [to.x, routeHeight, to.y],
          [to.x, to.height, to.y],
        ]}
        color={connection.color}
        lineWidth={1.5}
      />
    );
  });
}

export default function Scene3D({ room, openings, equipment, trays, connections, selectedTarget }) {
  const footprint = useMemo(() => getRoomFootprint(room), [room]);
  const shape = useMemo(() => floorShape(footprint), [footprint]);
  const center = useMemo(() => ({
    x: footprint.reduce((sum, point) => sum + point.x, 0) / footprint.length,
    y: footprint.reduce((sum, point) => sum + point.y, 0) / footprint.length,
  }), [footprint]);

  return (
    <Canvas camera={{ position: [room.width * 1.1, room.height * 1.25, room.length * 0.9], fov: 42 }}>
      <color attach="background" args={["#fdf8ef"]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[room.width, room.height * 1.5, room.length]} intensity={1.1} />
      <directionalLight position={[-room.width, room.height, -room.length]} intensity={0.4} color="#ffe5bf" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color="#e7d8ba" side={DoubleSide} />
      </mesh>

      <WallMeshes room={room} openings={openings} selectedTarget={selectedTarget} />
      <EquipmentMeshes equipment={equipment} selectedTarget={selectedTarget} />
      <TrayMeshes trays={trays} selectedTarget={selectedTarget} />
      <ConnectionLines connections={connections} equipment={equipment} />

      <Grid
        args={[Math.max(room.width, room.length) * 2, 40]}
        cellColor="#e8dcc3"
        sectionColor="#bca06e"
        position={[center.x, 1, center.y]}
        infiniteGrid={false}
      />
      <OrbitControls target={[center.x, room.height * 0.35, center.y]} makeDefault />
    </Canvas>
  );
}
