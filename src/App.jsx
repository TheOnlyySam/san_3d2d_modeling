import { Component, useEffect, useRef, useState } from "react";
import {
  EQUIPMENT_PRESETS,
  RU_HEIGHT,
  clamp,
  degToRad,
  fitCanvas,
  getConnectionAnchor,
  getOpeningBounds,
  getPlanProjection,
  getTraySegments,
  getWallSegments,
  normalizeConnection,
  pointAlongWall,
} from "./modeling.js";
import Scene3D from "./Scene3D.jsx";

const HARDWARE_COLORS = {
  red: { label: "Red", color2d: "#d24444", color3d: "#c73a3a" },
  blue: { label: "Blue", color2d: "#2a7bc9", color3d: "#2e68b7" },
  green: { label: "Green", color2d: "#3c8a4d", color3d: "#3a7a48" },
  yellow: { label: "Yellow", color2d: "#d19a1f", color3d: "#be8a12" },
  purple: { label: "Purple", color2d: "#7a4db8", color3d: "#6942a8" },
};

const defaultRoom = { width: 6000, length: 9000, height: 3200, southTiltDeg: 0, eastTiltDeg: 0, floorElevation: 300, floorTileSize: 600 };
const defaultOpening = { label: "Door 1", type: "door", wall: 0, offset: 800, width: 1000, height: 2100, sillHeight: 0 };
const defaultEquipment = {
  label: "Cabinet 1",
  type: "cabinet",
  x: 1200,
  y: 1800,
  width: 600,
  depth: 1000,
  height: 2200,
  rotationDeg: 0,
  colorKey: "red",
  installMode: "floor",
  mountTarget: "",
};
const defaultTray = { label: "Tray 1", x: 500, y: 500, z: 2600, width: 300, depth: 100, lengthA: 2500, primaryDirection: "x+", turn: "none", lengthB: 1800 };
const defaultConnection = { label: "Cable 1", fromRef: "", toRef: "", color: "#d24444", routeHeight: 2600 };

function NumberField({ label, value, onChange, ...rest }) {
  return <label>{label}<input value={value} onChange={(event) => onChange(Number(event.target.value))} {...rest} /></label>;
}

function SelectField({ label, value, onChange, children, ...rest }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)} {...rest}>{children}</select></label>;
}

function TextField({ label, value, onChange, ...rest }) {
  return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} {...rest} /></label>;
}

class SceneErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch() {}

  render() {
    if (this.state.hasError) {
      return (
        <div className="scene-fallback">
          <strong>3D view is temporarily unavailable.</strong>
          <span>The 2D editor is still active. Refresh after changes if needed.</span>
        </div>
      );
    }
    return this.props.children;
  }
}

function pointInRotatedEquipment(point, item) {
  const angle = degToRad(item.rotationDeg);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const dx = point.x - item.x;
  const dy = point.y - item.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return Math.abs(localX) <= item.width / 2 && Math.abs(localY) <= item.depth / 2;
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  const px = start.x + dx * t;
  const py = start.y + dy * t;
  return Math.hypot(point.x - px, point.y - py);
}

function parseRef(ref) {
  if (!ref) return null;
  const [kind, rawIndex] = ref.split(":");
  const index = Number(rawIndex);
  if (!kind || Number.isNaN(index)) return null;
  return { kind, index };
}

function getConnectionPath(connection, equipment, trays) {
  const normalized = normalizeConnection(connection);
  const from = getConnectionAnchor({ kind: normalized.fromKind, index: normalized.fromIndex }, equipment, trays);
  const to = getConnectionAnchor({ kind: normalized.toKind, index: normalized.toIndex }, equipment, trays);
  if (!from || !to) return null;
  const control = {
    x: normalized.controlX ?? to.x,
    y: normalized.controlY ?? from.y,
    z: normalized.routeHeight,
  };
  return { from, control, to, normalized };
}

function getNextRackStart(equipment, cabinetIndex, rackUnits) {
  const occupied = equipment
    .filter((item) => item.mountedIn === cabinetIndex)
    .map((item) => ({ start: item.rackStart || 1, end: (item.rackStart || 1) + (item.rackUnits || 1) - 1 }))
    .sort((a, b) => a.start - b.start);

  let cursor = 1;
  for (const slot of occupied) {
    if (cursor + rackUnits - 1 < slot.start) {
      return cursor;
    }
    cursor = Math.max(cursor, slot.end + 1);
  }
  return cursor;
}

function getMountedEquipmentDisplay(item, equipment) {
  if (item.mountedIn === null || item.mountedIn === undefined) {
    return item;
  }
  const cabinet = equipment[item.mountedIn];
  if (!cabinet || cabinet.type !== "cabinet") {
    return item;
  }
  return {
    ...item,
    x: cabinet.x,
    y: cabinet.y,
    width: Math.max(Math.min(item.width, cabinet.width - 120), 180),
    depth: Math.max(Math.min(item.depth, cabinet.depth - 180), 160),
    rotationDeg: cabinet.rotationDeg,
  };
}

export default function App() {
  const [room, setRoom] = useState(defaultRoom);
  const [openings, setOpenings] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [trays, setTrays] = useState([]);
  const [connections, setConnections] = useState([]);
  const [openingDraft, setOpeningDraft] = useState(defaultOpening);
  const [equipmentDraft, setEquipmentDraft] = useState(defaultEquipment);
  const [trayDraft, setTrayDraft] = useState(defaultTray);
  const [connectionDraft, setConnectionDraft] = useState(defaultConnection);
  const [resizeTick, setResizeTick] = useState(0);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [assetQuery, setAssetQuery] = useState("");
  const planRef = useRef(null);
  const planInteractionRef = useRef({ dragging: false, kind: null, index: null, offsetX: 0, offsetY: 0 });

  const connectableOptions = [
    ...equipment.map((item, index) => ({ value: `equipment:${index}`, label: `${index + 1}. ${EQUIPMENT_PRESETS[item.type].label}` })),
    ...trays.map((_, index) => ({ value: `tray:${index}`, label: `${index + 1}. Cable Tray` })),
  ];
  const cabinetOptions = equipment
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === "cabinet")
    .map(({ item, index }) => ({ value: String(index), label: item.label || `${index + 1}. Cabinet` }));

  useEffect(() => {
    const preset = EQUIPMENT_PRESETS[equipmentDraft.type];
    setEquipmentDraft((current) => ({
      ...current,
      width: preset.width,
      depth: preset.depth,
      height: preset.height,
      installMode: preset.mountable ? current.installMode : "floor",
      mountTarget: preset.mountable ? current.mountTarget : "",
    }));
  }, [equipmentDraft.type]);

  useEffect(() => {
    if (connectableOptions.length === 0) {
      setConnectionDraft((current) => ({ ...current, fromRef: "", toRef: "" }));
      return;
    }
    setConnectionDraft((current) => {
      const next = { ...current };
      const values = connectableOptions.map((item) => item.value);
      if (!values.includes(next.fromRef)) next.fromRef = values[0];
      if (!values.includes(next.toRef) || next.toRef === next.fromRef) next.toRef = values.length > 1 ? values.find((value) => value !== next.fromRef) || next.fromRef : next.fromRef;
      return next;
    });
  }, [equipment, trays]);

  useEffect(() => {
    if (!selectedTarget) {
      return;
    }
    const collections = {
      equipment,
      tray: trays,
      opening: openings,
      connection: connections,
    };
    const source = collections[selectedTarget.kind];
    if (!source || !source[selectedTarget.index]) {
      setSelectedTarget(null);
    }
  }, [equipment, trays, openings, connections, selectedTarget]);

  useEffect(() => {
    const canvas = planRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    fitCanvas(canvas, ctx);
    const { walls, points, renderWidth, renderHeight, minX, minY, maxX, maxY, scale, project } = getPlanProjection(room, canvas);
    ctx.clearRect(0, 0, renderWidth, renderHeight);
    ctx.fillStyle = "#fffcf5";
    ctx.beginPath();
    points.forEach((point, index) => {
      const p = project(point);
      if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fill();

    // Clip the 60x60 tile pattern to the room footprint so the tiles follow wall tilt.
    ctx.save();
    ctx.beginPath();
    points.forEach((point, index) => {
      const p = project(point);
      if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = "rgba(159, 132, 82, 0.12)";
    ctx.lineWidth = 1;
    const tileSize = Math.max(room.floorTileSize || 600, 100);
    for (let x = Math.floor(minX / tileSize) * tileSize; x <= maxX; x += tileSize) {
      const start = project({ x, y: minY });
      const end = project({ x, y: maxY });
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
    for (let y = Math.floor(minY / tileSize) * tileSize; y <= maxY; y += tileSize) {
      const start = project({ x: minX, y });
      const end = project({ x: maxX, y });
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
    ctx.restore();
    walls.forEach((wall) => {
      const wallOpenings = openings
        .map((opening, index) => ({ opening, index }))
        .filter(({ opening }) => opening.wall === wall.index)
        .map(({ opening, index }) => ({ opening, index, bounds: getOpeningBounds(opening, wall, room) }))
        .sort((a, b) => a.bounds.start - b.bounds.start);
      let cursor = 0;
      ctx.lineCap = "round";
      ctx.lineWidth = 7;
      ctx.strokeStyle = "#5f5137";
      wallOpenings.forEach(({ opening, index, bounds }) => {
        if (bounds.start > cursor) {
          const from = project(pointAlongWall(wall, cursor));
          const to = project(pointAlongWall(wall, bounds.start));
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
        }
        const gapStart = project(pointAlongWall(wall, bounds.start));
        const gapEnd = project(pointAlongWall(wall, bounds.end));
        ctx.lineWidth = 3;
        ctx.strokeStyle = opening.type === "door" ? "#b55d2f" : "#4a88b2";
        ctx.beginPath();
        ctx.moveTo(gapStart.x, gapStart.y);
        ctx.lineTo(gapEnd.x, gapEnd.y);
        ctx.stroke();
        if (selectedTarget?.kind === "opening" && selectedTarget.index === index) {
          ctx.lineWidth = 6;
          ctx.strokeStyle = "#f08b00";
          ctx.beginPath();
          ctx.moveTo(gapStart.x, gapStart.y);
          ctx.lineTo(gapEnd.x, gapEnd.y);
          ctx.stroke();
        }
        ctx.lineWidth = 7;
        ctx.strokeStyle = "#5f5137";
        cursor = bounds.end;
      });
      if (cursor < wall.length) {
        const from = project(pointAlongWall(wall, cursor));
        const to = project(pointAlongWall(wall, wall.length));
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
    });
    trays.forEach((tray, trayIndex) => {
      ctx.strokeStyle = selectedTarget?.kind === "tray" && selectedTarget.index === trayIndex ? "#f08b00" : "#c88f22";
      ctx.lineWidth = Math.max(3, tray.width * scale * 0.08);
      const traySegments = getTraySegments(tray);
      traySegments.forEach((segment) => {
        const start = project(segment.start);
        const end = project(segment.end);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      });
      const trayAnchor = traySegments[0]?.start || { x: tray.x, y: tray.y };
      const trayLabelPoint = project(trayAnchor);
      ctx.fillStyle = "#6f6146";
      ctx.font = "700 12px Segoe UI";
      ctx.fillText(tray.label || `Tray ${trayIndex + 1}`, trayLabelPoint.x + 8, trayLabelPoint.y - 10);
    });
    equipment.forEach((item, index) => {
      const palette = HARDWARE_COLORS[item.colorKey] || HARDWARE_COLORS.red;
      const drawItem = getMountedEquipmentDisplay(item, equipment);
      const center = project({ x: drawItem.x, y: drawItem.y });
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(-degToRad(drawItem.rotationDeg || 0));
      const drawWidth = drawItem.width * scale;
      const drawDepth = drawItem.depth * scale;
      const left = -drawWidth / 2;
      const top = -drawDepth / 2;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      if (drawItem.type === "cabinet") {
        ctx.fillStyle = palette.color2d;
        ctx.fillRect(left, top, drawWidth, drawDepth);
        const frameSize = Math.max(Math.min(Math.min(drawWidth, drawDepth) * 0.14, 18), 8);
        ctx.fillStyle = "#fffcf5";
        ctx.fillRect(left + frameSize, top + frameSize, drawWidth - frameSize * 2, drawDepth - frameSize * 2);
        ctx.strokeRect(left, top, drawWidth, drawDepth);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
        ctx.lineWidth = 1.5;
        if (drawItem.frontFace !== "removed") {
          ctx.beginPath();
          ctx.moveTo(left + frameSize, top + frameSize);
          ctx.lineTo(left + drawWidth - frameSize, top + frameSize);
          ctx.stroke();
        }
        if (drawItem.rearFace !== "removed") {
          ctx.beginPath();
          ctx.moveTo(left + frameSize, top + drawDepth - frameSize);
          ctx.lineTo(left + drawWidth - frameSize, top + drawDepth - frameSize);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = palette.color2d;
        ctx.fillRect(left, top, drawWidth, drawDepth);
        ctx.strokeRect(left, top, drawWidth, drawDepth);
      }
      if (selectedTarget?.kind === "equipment" && selectedTarget.index === index) {
        ctx.strokeStyle = "#f08b00";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(left - 4, top - 4, drawWidth + 8, drawDepth + 8);
        ctx.setLineDash([]);
      }
      ctx.restore();
      ctx.fillStyle = "#3f3424";
      ctx.font = "700 12px Segoe UI";
      ctx.fillText(item.label || `${index + 1}. ${item.type}`, center.x + 8, center.y - 10);
    });
    openings.forEach((opening, index) => {
      const wall = walls[opening.wall];
      const bounds = getOpeningBounds(opening, wall, room);
      const start = pointAlongWall(wall, bounds.start);
      const end = pointAlongWall(wall, bounds.end);
      const openingLabelPoint = project({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
      ctx.fillStyle = "#6f6146";
      ctx.font = "700 12px Segoe UI";
      ctx.fillText(opening.label || `${opening.type} ${index + 1}`, openingLabelPoint.x + 8, openingLabelPoint.y - 8);
    });
    connections.forEach((connection, connectionIndex) => {
      const path = getConnectionPath(connection, equipment, trays);
      if (!path) return;
      const a = project(path.from);
      const c = project(path.control);
      const b = project(path.to);
      ctx.strokeStyle = path.normalized.color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = selectedTarget?.kind === "connection" && selectedTarget.index === connectionIndex ? "#f08b00" : "#ffffff";
      ctx.strokeStyle = path.normalized.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#6f6146";
      ctx.font = "700 12px Segoe UI";
      ctx.fillText(path.normalized.label || `Cable ${connectionIndex + 1}`, c.x + 10, c.y - 10);
    });
  }, [room, openings, equipment, trays, connections, resizeTick, selectedTarget]);

  useEffect(() => {
    const canvas = planRef.current;
    if (!canvas) return;

    const getWorldPoint = (event) => {
      const projection = getPlanProjection(room, canvas);
      const rect = canvas.getBoundingClientRect();
      return projection.unproject({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };

    const down = (event) => {
      const worldPoint = getWorldPoint(event);
      const equipmentHit = [...equipment]
        .map((item, index) => ({ item: getMountedEquipmentDisplay(item, equipment), index }))
        .reverse()
        .find(({ item }) => pointInRotatedEquipment(worldPoint, item));

      if (equipmentHit) {
        const sourceItem = equipment[equipmentHit.index];
        const canDrag = sourceItem.mountedIn === null || sourceItem.mountedIn === undefined;
        setSelectedTarget({ kind: "equipment", index: equipmentHit.index });
        planInteractionRef.current = {
          dragging: canDrag,
          kind: canDrag ? "equipment" : null,
          index: canDrag ? equipmentHit.index : null,
          offsetX: canDrag ? worldPoint.x - sourceItem.x : 0,
          offsetY: canDrag ? worldPoint.y - sourceItem.y : 0,
        };
        return;
      }

      const trayHit = trays
        .map((tray, index) => ({
          tray,
          index,
          hit: getTraySegments(tray).some((segment) =>
            distanceToSegment(worldPoint, segment.start, segment.end) <= Math.max(tray.width / 2, 150)
          ),
        }))
        .reverse()
        .find((candidate) => candidate.hit);

      if (trayHit) {
        setSelectedTarget({ kind: "tray", index: trayHit.index });
        planInteractionRef.current = {
          dragging: true,
          kind: "tray",
          index: trayHit.index,
          offsetX: worldPoint.x - trays[trayHit.index].x,
          offsetY: worldPoint.y - trays[trayHit.index].y,
        };
        return;
      }

      const connectionHit = connections
        .map((connection, index) => {
          const path = getConnectionPath(connection, equipment, trays);
          if (!path) return { index, hit: false, handleHit: false };
          const handleHit = Math.hypot(worldPoint.x - path.control.x, worldPoint.y - path.control.y) <= 180;
          const lineHit =
            distanceToSegment(worldPoint, path.from, path.control) <= 160 ||
            distanceToSegment(worldPoint, path.control, path.to) <= 160;
          return { index, hit: handleHit || lineHit, handleHit, path };
        })
        .reverse()
        .find((candidate) => candidate.hit);

      if (connectionHit) {
        setSelectedTarget({ kind: "connection", index: connectionHit.index });
        planInteractionRef.current = {
          dragging: true,
          kind: "connection",
          index: connectionHit.index,
          offsetX: worldPoint.x - connectionHit.path.control.x,
          offsetY: worldPoint.y - connectionHit.path.control.y,
        };
        return;
      }

      const walls = getWallSegments(room);
      const openingHit = openings
        .map((opening, index) => {
          const wall = walls[opening.wall];
          const bounds = getOpeningBounds(opening, wall, room);
          return {
            index,
            hit:
              distanceToSegment(
                worldPoint,
                pointAlongWall(wall, bounds.start),
                pointAlongWall(wall, bounds.end)
              ) <= 140,
          };
        })
        .reverse()
        .find((candidate) => candidate.hit);

      if (openingHit) {
        setSelectedTarget({ kind: "opening", index: openingHit.index });
        planInteractionRef.current = { dragging: false, kind: null, index: null, offsetX: 0, offsetY: 0 };
        return;
      }

      setSelectedTarget(null);
      planInteractionRef.current = { dragging: false, kind: null, index: null, offsetX: 0, offsetY: 0 };
    };

    const move = (event) => {
      const interaction = planInteractionRef.current;
      if (!interaction.dragging || interaction.index === null) return;
      const worldPoint = getWorldPoint(event);
      if (interaction.kind === "equipment") {
        setEquipment((current) =>
          current.map((item, index) =>
            index === interaction.index
              ? {
                  ...item,
                  x: Math.round((worldPoint.x - interaction.offsetX) / 50) * 50,
                  y: Math.round((worldPoint.y - interaction.offsetY) / 50) * 50,
                }
              : item
          )
        );
        return;
      }
      if (interaction.kind === "tray") {
        setTrays((current) =>
          current.map((item, index) =>
            index === interaction.index
              ? {
                  ...item,
                  x: Math.round((worldPoint.x - interaction.offsetX) / 50) * 50,
                  y: Math.round((worldPoint.y - interaction.offsetY) / 50) * 50,
                }
              : item
          )
        );
        return;
      }
      if (interaction.kind === "connection") {
        setConnections((current) =>
          current.map((item, index) =>
            index === interaction.index
              ? {
                  ...normalizeConnection(item),
                  controlX: Math.round((worldPoint.x - interaction.offsetX) / 50) * 50,
                  controlY: Math.round((worldPoint.y - interaction.offsetY) / 50) * 50,
                }
              : item
          )
        );
      }
    };

    const up = () => {
      planInteractionRef.current = { dragging: false, kind: null, index: null, offsetX: 0, offsetY: 0 };
    };

    canvas.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      canvas.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [room, equipment, trays, openings, connections]);

  useEffect(() => {
    const onResize = () => setResizeTick((current) => current + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function addOpening() {
    setOpenings((current) => [...current, { ...openingDraft, sillHeight: openingDraft.type === "door" ? 0 : openingDraft.sillHeight }]);
    setOpeningDraft((current) => ({ ...current, label: `Door ${openings.length + 2}` }));
  }

  function addEquipment() {
    const preset = EQUIPMENT_PRESETS[equipmentDraft.type];
    const nextItem = { ...equipmentDraft };

    if (equipmentDraft.type === "cabinet") {
      nextItem.frontFace = nextItem.frontFace || "transparent";
      nextItem.rearFace = nextItem.rearFace || "transparent";
      nextItem.mountedIn = null;
      nextItem.rackUnits = preset.rackUnits;
      nextItem.rackStart = null;
      nextItem.installMode = "floor";
      nextItem.mountTarget = "";
    } else if (preset.mountable && equipmentDraft.installMode === "rack" && equipmentDraft.mountTarget !== "") {
      const cabinetIndex = Number(equipmentDraft.mountTarget);
      const cabinet = equipment[cabinetIndex];
      if (cabinet && cabinet.type === "cabinet") {
        const rackUnits = preset.rackUnits || Math.max(1, Math.round(preset.height / RU_HEIGHT));
        const rackStart = getNextRackStart(equipment, cabinetIndex, rackUnits);
        const rackCapacity = cabinet.rackUnits || Math.max(1, Math.round(cabinet.height / RU_HEIGHT));
        if (rackStart + rackUnits - 1 > rackCapacity) {
          return;
        }
        nextItem.mountedIn = cabinetIndex;
        nextItem.rackUnits = rackUnits;
        nextItem.rackStart = rackStart;
        nextItem.height = rackUnits * RU_HEIGHT;
        nextItem.width = Math.max(Math.min(cabinet.width - 120, 482), 200);
        nextItem.depth = Math.max(Math.min(cabinet.depth - 180, preset.depth), 180);
        nextItem.x = cabinet.x;
        nextItem.y = cabinet.y;
        nextItem.rotationDeg = cabinet.rotationDeg;
      } else {
        return;
      }
    } else {
      nextItem.mountedIn = null;
      nextItem.rackUnits = preset.rackUnits || 0;
      nextItem.rackStart = null;
      nextItem.mountTarget = "";
    }

    setEquipment((current) => [...current, nextItem]);
    setEquipmentDraft((current) => ({ ...current, label: `${EQUIPMENT_PRESETS[current.type].label} ${equipment.length + 2}` }));
  }

  function addTray() {
    setTrays((current) => [...current, { ...trayDraft }]);
    setTrayDraft((current) => ({ ...current, label: `Tray ${trays.length + 2}` }));
  }

  function addConnection() {
    const fromRef = parseRef(connectionDraft.fromRef);
    const toRef = parseRef(connectionDraft.toRef);
    if (!fromRef || !toRef) return;
    if (fromRef.kind === toRef.kind && fromRef.index === toRef.index) return;
    const fromAnchor = getConnectionAnchor(fromRef, equipment, trays);
    const toAnchor = getConnectionAnchor(toRef, equipment, trays);
    if (!fromAnchor || !toAnchor) return;
    setConnections((current) => [
      ...current,
      {
        ...connectionDraft,
        fromKind: fromRef.kind,
        fromIndex: fromRef.index,
        toKind: toRef.kind,
        toIndex: toRef.index,
        controlX: toAnchor.x,
        controlY: fromAnchor.y,
      },
    ]);
    setConnectionDraft((current) => ({ ...current, label: `Cable ${connections.length + 2}` }));
  }

  function removeEquipment(index) {
    const removedIndexes = new Set([index]);
    const item = equipment[index];
    if (item?.type === "cabinet") {
      equipment.forEach((equipmentItem, equipmentIndex) => {
        if (equipmentItem.mountedIn === index) {
          removedIndexes.add(equipmentIndex);
        }
      });
    }
    setEquipment((current) =>
      current
        .filter((_, itemIndex) => !removedIndexes.has(itemIndex))
        .map((equipmentItem) => {
          if (equipmentItem.mountedIn === null || equipmentItem.mountedIn === undefined) {
            return equipmentItem;
          }
          if (removedIndexes.has(equipmentItem.mountedIn)) {
            return { ...equipmentItem, mountedIn: null, rackStart: null };
          }
          const removedBeforeMount = [...removedIndexes].filter((removedIndex) => removedIndex < equipmentItem.mountedIn).length;
          return removedBeforeMount > 0
            ? { ...equipmentItem, mountedIn: equipmentItem.mountedIn - removedBeforeMount }
            : equipmentItem;
        })
    );
    setConnections((current) =>
      current
        .map((connectionItem) => normalizeConnection(connectionItem))
        .filter(
          (connectionItem) =>
            !(connectionItem.fromKind === "equipment" && removedIndexes.has(connectionItem.fromIndex)) &&
            !(connectionItem.toKind === "equipment" && removedIndexes.has(connectionItem.toIndex))
        )
        .map((connectionItem) => ({
          ...connectionItem,
          fromIndex:
            connectionItem.fromKind === "equipment"
              ? connectionItem.fromIndex - [...removedIndexes].filter((removedIndex) => removedIndex < connectionItem.fromIndex).length
              : connectionItem.fromIndex,
          toIndex:
            connectionItem.toKind === "equipment"
              ? connectionItem.toIndex - [...removedIndexes].filter((removedIndex) => removedIndex < connectionItem.toIndex).length
              : connectionItem.toIndex,
        }))
    );
    setSelectedTarget((current) => {
      if (!current || current.kind !== "equipment") return current;
      if (removedIndexes.has(current.index)) return null;
      const removedBefore = [...removedIndexes].filter((removedIndex) => removedIndex < current.index).length;
      return removedBefore > 0 ? { ...current, index: current.index - removedBefore } : current;
    });
  }

  function removeTray(index) {
    setTrays((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setConnections((current) => current
      .map((item) => normalizeConnection(item))
      .filter((item) => !(item.fromKind === "tray" && item.fromIndex === index) && !(item.toKind === "tray" && item.toIndex === index))
      .map((item) => ({
        ...item,
        fromIndex: item.fromKind === "tray" && item.fromIndex > index ? item.fromIndex - 1 : item.fromIndex,
        toIndex: item.toKind === "tray" && item.toIndex > index ? item.toIndex - 1 : item.toIndex,
      })));
    setSelectedTarget((current) => {
      if (!current || current.kind !== "tray") return current;
      if (current.index === index) return null;
      return current.index > index ? { ...current, index: current.index - 1 } : current;
    });
  }

  function removeOpening(index) {
    setOpenings((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setSelectedTarget((current) => {
      if (!current || current.kind !== "opening") return current;
      if (current.index === index) return null;
      return current.index > index ? { ...current, index: current.index - 1 } : current;
    });
  }

  function removeConnection(index) {
    setConnections((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setSelectedTarget((current) => {
      if (!current || current.kind !== "connection") return current;
      if (current.index === index) return null;
      return current.index > index ? { ...current, index: current.index - 1 } : current;
    });
  }

  const floorArea = Math.round((room.width * room.length) / 1000000);
  const totalRackUnits = equipment
    .filter((item) => item.type === "cabinet")
    .reduce((sum, item) => sum + Math.round(item.height / RU_HEIGHT), 0);
  const assetRows = [
    ...equipment.map((item, index) => ({
      kind: "equipment",
      index,
      title: item.label || `${index + 1}. ${EQUIPMENT_PRESETS[item.type].label}`,
      detail:
        item.mountedIn !== null && item.mountedIn !== undefined
          ? `${equipment[item.mountedIn]?.label || `Cabinet ${item.mountedIn + 1}`} | RU ${item.rackStart || 1}`
          : `${item.x}, ${item.y}`,
    })),
    ...trays.map((item, index) => ({
      kind: "tray",
      index,
      title: item.label || `${index + 1}. Cable Tray`,
      detail: `${item.x}, ${item.y}, z${item.z}`,
    })),
    ...openings.map((item, index) => ({
      kind: "opening",
      index,
      title: item.label || `${index + 1}. ${item.type === "door" ? "Door" : "Window"}`,
      detail: ["South", "East", "North", "West"][item.wall],
    })),
    ...connections.map((item, index) => {
      const normalized = normalizeConnection(item);
      return {
        kind: "connection",
        index,
        title: item.label || `${index + 1}. Cable Link`,
        detail: `${normalized.fromKind}:${normalized.fromIndex + 1} -> ${normalized.toKind}:${normalized.toIndex + 1}`,
      };
    }),
  ];
  const filteredAssets = assetRows.filter((row) =>
    `${row.title} ${row.detail}`.toLowerCase().includes(assetQuery.toLowerCase())
  );
  const selectedItem = selectedTarget ? ({ equipment, tray: trays, opening: openings, connection: connections }[selectedTarget.kind] || [])[selectedTarget.index] : null;

  function updateSelectedField(field, value) {
    if (!selectedTarget) return;
    if (selectedTarget.kind === "equipment") {
      setEquipment((current) =>
        current.map((item, index) => {
          if (index !== selectedTarget.index) {
            return item;
          }

          const nextItem = { ...item, [field]: value };
          if (field === "type") {
            const preset = EQUIPMENT_PRESETS[value];
            nextItem.width = preset.width;
            nextItem.depth = preset.depth;
            nextItem.height = preset.height;
            nextItem.rackUnits = preset.rackUnits || 0;

            if (value === "cabinet") {
              nextItem.mountedIn = null;
              nextItem.rackStart = null;
              nextItem.installMode = "floor";
              nextItem.mountTarget = "";
              nextItem.frontFace = nextItem.frontFace || "transparent";
              nextItem.rearFace = nextItem.rearFace || "transparent";
            } else if (!preset.mountable) {
              nextItem.mountedIn = null;
              nextItem.rackStart = null;
              nextItem.installMode = "floor";
              nextItem.mountTarget = "";
            } else if (item.mountedIn !== null && item.mountedIn !== undefined) {
              const cabinet = current[item.mountedIn];
              const rackUnits = preset.rackUnits || Math.max(1, Math.round(preset.height / RU_HEIGHT));
              nextItem.rackUnits = rackUnits;
              nextItem.height = rackUnits * RU_HEIGHT;
              if (cabinet?.type === "cabinet") {
                nextItem.width = Math.max(Math.min(cabinet.width - 120, 482), 200);
                nextItem.depth = Math.max(Math.min(cabinet.depth - 180, preset.depth), 180);
                nextItem.x = cabinet.x;
                nextItem.y = cabinet.y;
                nextItem.rotationDeg = cabinet.rotationDeg;
              }
            }
          }

          if (field === "rotationDeg" && item.mountedIn !== null && item.mountedIn !== undefined) {
            const cabinet = current[item.mountedIn];
            if (cabinet?.type === "cabinet") {
              nextItem.rotationDeg = cabinet.rotationDeg;
            }
          }

          return nextItem;
        })
      );
      return;
    }
    if (selectedTarget.kind === "tray") {
      setTrays((current) => current.map((item, index) => (index === selectedTarget.index ? { ...item, [field]: value } : item)));
      return;
    }
    if (selectedTarget.kind === "connection") {
      setConnections((current) => current.map((item, index) => (index === selectedTarget.index ? { ...normalizeConnection(item), [field]: value } : item)));
      return;
    }
    setOpenings((current) => current.map((item, index) => (index === selectedTarget.index ? { ...item, [field]: value } : item)));
  }

  return (
    <div className="dcim-shell">
      <header className="top-nav">
        <div className="brand-block">
          <p className="eyebrow">dcTrack Inspired Workspace</p>
          <h2>DCIM Operations Console</h2>
        </div>
        <nav className="nav-strip">
          <span className="nav-item active-nav">Dashboard</span>
          <span className="nav-item">Visualization</span>
          <span className="nav-item">Capacity</span>
          <span className="nav-item">Assets</span>
          <span className="nav-item">Connectivity</span>
          <span className="nav-item">Change</span>
          <span className="nav-item">Reports</span>
        </nav>
      </header>

      <div className="app-shell">
        <aside className="control-panel">
        <div className="panel-header">
          <p className="eyebrow">Infrastructure Planner</p>
          <h1>Room 2D + 3D Modeler</h1>
          <p className="intro">React + Vite foundation now. The layout is shifted toward a DCIM operator console with floor-map style controls and monitoring context.</p>
        </div>

        <section className="card compact-card">
          <div className="status-strip">
            <div className="status-chip">
              <span className="status-label">Assets</span>
              <strong>{equipment.length}</strong>
            </div>
            <div className="status-chip">
              <span className="status-label">Connections</span>
              <strong>{connections.length}</strong>
            </div>
            <div className="status-chip">
              <span className="status-label">Floor Area</span>
              <strong>{floorArea} m2</strong>
            </div>
          </div>
          <div className="status-strip">
            <div className="status-chip">
              <span className="status-label">Openings</span>
              <strong>{openings.length}</strong>
            </div>
            <div className="status-chip">
              <span className="status-label">Trays</span>
              <strong>{trays.length}</strong>
            </div>
            <div className="status-chip">
              <span className="status-label">Rack U</span>
              <strong>{totalRackUnits}</strong>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="section-head">
            <h2>Asset Browser</h2>
            <span className="section-meta">{filteredAssets.length} visible</span>
          </div>
          <label className="search-field">
            Search Assets
            <input
              type="text"
              value={assetQuery}
              onChange={(event) => setAssetQuery(event.target.value)}
              placeholder="cabinet, switch, 1..."
            />
          </label>
          <div className="asset-list">
            {filteredAssets.map((row) => (
              <button
                key={`${row.kind}-${row.index}`}
                type="button"
                className={`asset-row${selectedTarget?.kind === row.kind && selectedTarget?.index === row.index ? " selected-row" : ""}`}
                onClick={() => setSelectedTarget({ kind: row.kind, index: row.index })}
              >
                <span className="asset-name">{row.title}</span>
                <span className="asset-coords">{row.detail}</span>
              </button>
            ))}
            {filteredAssets.length === 0 ? <p className="empty-copy">No assets match the current filter.</p> : null}
          </div>
        </section>

        <section className="card">
          <h2>Room</h2>
          <div className="field-grid">
            <NumberField label="Width (mm)" type="number" min="1000" step="100" value={room.width} onChange={(value) => setRoom((current) => ({ ...current, width: Math.max(value, 1000) }))} />
            <NumberField label="Length (mm)" type="number" min="1000" step="100" value={room.length} onChange={(value) => setRoom((current) => ({ ...current, length: Math.max(value, 1000) }))} />
            <NumberField label="Height (mm)" type="number" min="2200" step="100" value={room.height} onChange={(value) => setRoom((current) => ({ ...current, height: Math.max(value, 2200) }))} />
            <NumberField label="Floor Elevation (mm)" type="number" min="0" step="50" value={room.floorElevation} onChange={(value) => setRoom((current) => ({ ...current, floorElevation: Math.max(value, 0) }))} />
            <NumberField label="Tile Size (mm)" type="number" min="100" step="50" value={room.floorTileSize} onChange={(value) => setRoom((current) => ({ ...current, floorTileSize: Math.max(value, 100) }))} />
            <NumberField label="South Wall Tilt (deg)" type="number" min="-20" max="20" step="0.5" value={room.southTiltDeg} onChange={(value) => setRoom((current) => ({ ...current, southTiltDeg: clamp(value, -20, 20) }))} />
            <NumberField label="East Wall Tilt (deg)" type="number" min="-20" max="20" step="0.5" value={room.eastTiltDeg} onChange={(value) => setRoom((current) => ({ ...current, eastTiltDeg: clamp(value, -20, 20) }))} />
          </div>
        </section>

        <section className="card">
          <h2>Doors & Windows</h2>
          <div className="field-grid">
            <TextField label="Label" value={openingDraft.label} onChange={(value) => setOpeningDraft((current) => ({ ...current, label: value }))} />
            <SelectField label="Type" value={openingDraft.type} onChange={(value) => setOpeningDraft((current) => ({ ...current, type: value }))}><option value="door">Door</option><option value="window">Window</option></SelectField>
            <SelectField label="Wall" value={String(openingDraft.wall)} onChange={(value) => setOpeningDraft((current) => ({ ...current, wall: Number(value) }))}><option value="0">South</option><option value="1">East</option><option value="2">North</option><option value="3">West</option></SelectField>
            <NumberField label="Offset From Wall Start (mm)" type="number" min="0" step="50" value={openingDraft.offset} onChange={(value) => setOpeningDraft((current) => ({ ...current, offset: value }))} />
            <NumberField label="Width (mm)" type="number" min="300" step="50" value={openingDraft.width} onChange={(value) => setOpeningDraft((current) => ({ ...current, width: value }))} />
            <NumberField label="Height (mm)" type="number" min="300" step="50" value={openingDraft.height} onChange={(value) => setOpeningDraft((current) => ({ ...current, height: value }))} />
            <NumberField label="Sill Height (mm)" type="number" min="0" step="50" value={openingDraft.sillHeight} onChange={(value) => setOpeningDraft((current) => ({ ...current, sillHeight: value }))} />
          </div>
          <button className="action-button" type="button" onClick={addOpening}>Add Opening</button>
          <List items={openings} labelForItem={(item, index) => `${item.label || `${index + 1}. ${item.type}`} on ${["South", "East", "North", "West"][item.wall]}`} onRemove={removeOpening} selected={selectedTarget} kind="opening" onSelect={setSelectedTarget} />
        </section>

        <section className="card">
          <h2>Network Hardware</h2>
          <div className="field-grid">
            <SelectField label="Type" value={equipmentDraft.type} onChange={(value) => setEquipmentDraft((current) => ({ ...current, type: value }))}>
              {Object.entries(EQUIPMENT_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
            </SelectField>
            <TextField label="Label" value={equipmentDraft.label} onChange={(value) => setEquipmentDraft((current) => ({ ...current, label: value }))} />
            <SelectField label="Color" value={equipmentDraft.colorKey} onChange={(value) => setEquipmentDraft((current) => ({ ...current, colorKey: value }))}>
              {Object.entries(HARDWARE_COLORS).map(([key, color]) => <option key={key} value={key}>{color.label}</option>)}
            </SelectField>
            {EQUIPMENT_PRESETS[equipmentDraft.type].mountable ? (
              <SelectField label="Install Mode" value={equipmentDraft.installMode} onChange={(value) => setEquipmentDraft((current) => ({ ...current, installMode: value, mountTarget: value === "rack" ? current.mountTarget : "" }))}>
                <option value="floor">Floor Standing</option>
                <option value="rack">Mount In Rack</option>
              </SelectField>
            ) : null}
            {EQUIPMENT_PRESETS[equipmentDraft.type].mountable && equipmentDraft.installMode === "rack" ? (
              <SelectField label="Rack Cabinet" value={equipmentDraft.mountTarget} onChange={(value) => setEquipmentDraft((current) => ({ ...current, mountTarget: value }))} disabled={cabinetOptions.length === 0}>
                {cabinetOptions.length === 0 ? <option value="">Add cabinet first</option> : <>
                  <option value="">Select Rack</option>
                  {cabinetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </>}
              </SelectField>
            ) : null}
            {!(EQUIPMENT_PRESETS[equipmentDraft.type].mountable && equipmentDraft.installMode === "rack") ? (
              <>
                <NumberField label="X Position (mm)" type="number" step="50" value={equipmentDraft.x} onChange={(value) => setEquipmentDraft((current) => ({ ...current, x: value }))} />
                <NumberField label="Y Position (mm)" type="number" step="50" value={equipmentDraft.y} onChange={(value) => setEquipmentDraft((current) => ({ ...current, y: value }))} />
                <NumberField label="Width (mm)" type="number" min="200" step="50" value={equipmentDraft.width} onChange={(value) => setEquipmentDraft((current) => ({ ...current, width: value }))} />
                <NumberField label="Depth (mm)" type="number" min="200" step="50" value={equipmentDraft.depth} onChange={(value) => setEquipmentDraft((current) => ({ ...current, depth: value }))} />
                <NumberField label="Height (mm)" type="number" min="200" step="50" value={equipmentDraft.height} onChange={(value) => setEquipmentDraft((current) => ({ ...current, height: value }))} />
                <NumberField label="Rotation (deg)" type="number" step="5" value={equipmentDraft.rotationDeg} onChange={(value) => setEquipmentDraft((current) => ({ ...current, rotationDeg: value }))} />
              </>
            ) : (
              <div className="mount-info">
                <strong>Rack Mounted</strong>
                <span>Size and position will be taken from the selected cabinet.</span>
              </div>
            )}
          </div>
          <button
            className="action-button"
            type="button"
            onClick={addEquipment}
            disabled={
              EQUIPMENT_PRESETS[equipmentDraft.type].mountable &&
              equipmentDraft.installMode === "rack" &&
              equipmentDraft.mountTarget === ""
            }
          >
            Add Hardware
          </button>
          <List items={equipment} labelForItem={(item, index) => `${item.label || `${index + 1}. ${item.type}`} at (${item.x}, ${item.y})`} onRemove={removeEquipment} selected={selectedTarget} kind="equipment" onSelect={setSelectedTarget} />
        </section>

        <section className="card">
          <h2>Cable Tray</h2>
          <div className="field-grid">
            <TextField label="Label" value={trayDraft.label} onChange={(value) => setTrayDraft((current) => ({ ...current, label: value }))} />
            <NumberField label="Start X (mm)" type="number" step="50" value={trayDraft.x} onChange={(value) => setTrayDraft((current) => ({ ...current, x: value }))} />
            <NumberField label="Start Y (mm)" type="number" step="50" value={trayDraft.y} onChange={(value) => setTrayDraft((current) => ({ ...current, y: value }))} />
            <NumberField label="Elevation Z (mm)" type="number" step="50" value={trayDraft.z} onChange={(value) => setTrayDraft((current) => ({ ...current, z: value }))} />
            <NumberField label="Width (mm)" type="number" min="50" step="25" value={trayDraft.width} onChange={(value) => setTrayDraft((current) => ({ ...current, width: value }))} />
            <NumberField label="Depth (mm)" type="number" min="25" step="25" value={trayDraft.depth} onChange={(value) => setTrayDraft((current) => ({ ...current, depth: value }))} />
            <NumberField label="Primary Length (mm)" type="number" min="100" step="50" value={trayDraft.lengthA} onChange={(value) => setTrayDraft((current) => ({ ...current, lengthA: value }))} />
            <SelectField label="Primary Direction" value={trayDraft.primaryDirection} onChange={(value) => setTrayDraft((current) => ({ ...current, primaryDirection: value }))}><option value="x+">+X</option><option value="x-">-X</option><option value="y+">+Y</option><option value="y-">-Y</option></SelectField>
            <SelectField label="90 Degree Turn" value={trayDraft.turn} onChange={(value) => setTrayDraft((current) => ({ ...current, turn: value }))}><option value="none">Straight Only</option><option value="left">Left Turn</option><option value="right">Right Turn</option></SelectField>
            <NumberField label="Secondary Length (mm)" type="number" min="0" step="50" value={trayDraft.lengthB} onChange={(value) => setTrayDraft((current) => ({ ...current, lengthB: value }))} />
          </div>
          <button className="action-button" type="button" onClick={addTray}>Add Tray</button>
          <List items={trays} labelForItem={(item, index) => `${item.label || `${index + 1}. tray`} from (${item.x}, ${item.y}, ${item.z}) ${item.primaryDirection}`} onRemove={removeTray} selected={selectedTarget} kind="tray" onSelect={setSelectedTarget} />
        </section>

        <section className="card">
          <h2>Wire Connections</h2>
          <div className="field-grid">
            <TextField label="Label" value={connectionDraft.label} onChange={(value) => setConnectionDraft((current) => ({ ...current, label: value }))} />
            <SelectField label="From Component" value={connectionDraft.fromRef} onChange={(value) => setConnectionDraft((current) => ({ ...current, fromRef: value }))} disabled={connectableOptions.length === 0}>
              {connectableOptions.length === 0 ? <option value="">Add components first</option> : connectableOptions.map((item) => <option key={`from-${item.value}`} value={item.value}>{item.label}</option>)}
            </SelectField>
            <SelectField label="To Component" value={connectionDraft.toRef} onChange={(value) => setConnectionDraft((current) => ({ ...current, toRef: value }))} disabled={connectableOptions.length === 0}>
              {connectableOptions.length === 0 ? <option value="">Add components first</option> : connectableOptions.map((item) => <option key={`to-${item.value}`} value={item.value}>{item.label}</option>)}
            </SelectField>
            <SelectField label="Cable Color" value={connectionDraft.color} onChange={(value) => setConnectionDraft((current) => ({ ...current, color: value }))}><option value="#d24444">Red</option><option value="#2a7bc9">Blue</option><option value="#d19a1f">Amber</option><option value="#3c8a4d">Green</option></SelectField>
            <NumberField label="Route Height (mm)" type="number" min="0" step="50" value={connectionDraft.routeHeight} onChange={(value) => setConnectionDraft((current) => ({ ...current, routeHeight: value }))} />
          </div>
          <button className="action-button" type="button" onClick={addConnection} disabled={connectableOptions.length < 2}>Add Connection</button>
          <List
            items={connections}
            labelForItem={(item, index) => {
              const normalized = normalizeConnection(item);
              return `${item.label || `${index + 1}. Cable`} ${normalized.fromKind}:${normalized.fromIndex + 1} -> ${normalized.toKind}:${normalized.toIndex + 1}`;
            }}
            onRemove={removeConnection}
            selected={selectedTarget}
            kind="connection"
            onSelect={setSelectedTarget}
          />
        </section>
        </aside>

        <main className="viewport-panel">
        <section className="workspace-bar">
          <div className="workspace-title">
            <p className="eyebrow">Operations Workspace</p>
            <h2>Floor Map Console</h2>
          </div>
          <div className="workspace-tools">
            <span className="tool-pill active-pill">Visualization</span>
            <span className="tool-pill">Capacity</span>
            <span className="tool-pill">Connectivity</span>
            <span className="tool-pill">Changes</span>
          </div>
        </section>

        <section className="view-card">
          <div className="view-head">
            <h2>2D Plan</h2>
            <p>Top-down footprint, openings, hardware, trays, and wire routes.</p>
          </div>
          <div className="viewport-toolbar">
            <span className="toolbar-pill active-pill">Floor Map</span>
            <span className="toolbar-pill">Search</span>
            <span className="toolbar-pill">Measure</span>
            <span className="toolbar-pill">Connectivity</span>
            <span className="toolbar-pill">Layers</span>
          </div>
          <canvas ref={planRef} className="viewport-canvas" />
        </section>
        <section className="view-card">
          <div className="view-head">
            <h2>3D View</h2>
            <p>Orbit, pan, and zoom with real `react-three-fiber` controls.</p>
          </div>
          <div className="viewport-toolbar">
            <span className="toolbar-pill active-pill">3D</span>
            <span className="toolbar-pill">Isolate</span>
            <span className="toolbar-pill">Thermal Map</span>
            <span className="toolbar-pill">Reports</span>
            <span className="toolbar-pill">Settings</span>
          </div>
          <div className="viewport-canvas viewport-3d">
            <SceneErrorBoundary>
              <Scene3D
                room={room}
                openings={openings}
                equipment={equipment}
                trays={trays}
                connections={connections}
                selectedTarget={selectedTarget}
              />
            </SceneErrorBoundary>
          </div>
        </section>
        </main>

        <aside className="properties-panel">
          <section className="view-card properties-card">
            <div className="view-head">
              <h2>Properties</h2>
              <p>{selectedTarget ? `Editing ${selectedTarget.kind} ${selectedTarget.index + 1}` : "Select an asset from the floor map or asset browser."}</p>
            </div>
            {selectedItem ? (
              <div className="field-grid single-column">
                {selectedTarget.kind === "equipment" ? (
                  <>
                    <TextField label="Label" value={selectedItem.label || ""} onChange={(value) => updateSelectedField("label", value)} />
                    <SelectField label="Asset Type" value={selectedItem.type} onChange={(value) => updateSelectedField("type", value)}>
                      {Object.entries(EQUIPMENT_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
                    </SelectField>
                    <SelectField label="Color" value={selectedItem.colorKey || "red"} onChange={(value) => updateSelectedField("colorKey", value)}>
                      {Object.entries(HARDWARE_COLORS).map(([key, color]) => <option key={key} value={key}>{color.label}</option>)}
                    </SelectField>
                    {selectedItem.type === "cabinet" ? (
                      <>
                        <SelectField label="Front Panel" value={selectedItem.frontFace || "transparent"} onChange={(value) => updateSelectedField("frontFace", value)}>
                          <option value="transparent">Transparent</option>
                          <option value="removed">Removed</option>
                        </SelectField>
                        <SelectField label="Rear Panel" value={selectedItem.rearFace || "transparent"} onChange={(value) => updateSelectedField("rearFace", value)}>
                          <option value="transparent">Transparent</option>
                          <option value="removed">Removed</option>
                        </SelectField>
                      </>
                    ) : null}
                    {selectedItem.mountedIn !== null && selectedItem.mountedIn !== undefined ? (
                      <div className="mount-info">
                        <strong>Mounted In Rack</strong>
                        <span>{equipment[selectedItem.mountedIn]?.label || `Cabinet ${selectedItem.mountedIn + 1}`}</span>
                        <span>{`RU ${selectedItem.rackStart} - ${(selectedItem.rackStart || 1) + (selectedItem.rackUnits || 1) - 1}`}</span>
                        <span>{`${selectedItem.width}W x ${selectedItem.depth}D x ${selectedItem.height}H mm`}</span>
                      </div>
                    ) : null}
                    {selectedItem.mountedIn === null || selectedItem.mountedIn === undefined ? (
                      <>
                        <NumberField label="X Position (mm)" type="number" step="50" value={selectedItem.x} onChange={(value) => updateSelectedField("x", value)} />
                        <NumberField label="Y Position (mm)" type="number" step="50" value={selectedItem.y} onChange={(value) => updateSelectedField("y", value)} />
                        <NumberField label="Width (mm)" type="number" min="200" step="50" value={selectedItem.width} onChange={(value) => updateSelectedField("width", value)} />
                        <NumberField label="Depth (mm)" type="number" min="200" step="50" value={selectedItem.depth} onChange={(value) => updateSelectedField("depth", value)} />
                        <NumberField label="Height (mm)" type="number" min="200" step="50" value={selectedItem.height} onChange={(value) => updateSelectedField("height", value)} />
                        <NumberField label="Rotation (deg)" type="number" step="5" value={selectedItem.rotationDeg} onChange={(value) => updateSelectedField("rotationDeg", value)} />
                      </>
                    ) : null}
                    <button className="action-button" type="button" onClick={() => removeEquipment(selectedTarget.index)}>Delete Selected Asset</button>
                  </>
                ) : null}
                {selectedTarget.kind === "tray" ? (
                  <>
                    <TextField label="Label" value={selectedItem.label || ""} onChange={(value) => updateSelectedField("label", value)} />
                    <NumberField label="Start X (mm)" type="number" step="50" value={selectedItem.x} onChange={(value) => updateSelectedField("x", value)} />
                    <NumberField label="Start Y (mm)" type="number" step="50" value={selectedItem.y} onChange={(value) => updateSelectedField("y", value)} />
                    <NumberField label="Elevation Z (mm)" type="number" step="50" value={selectedItem.z} onChange={(value) => updateSelectedField("z", value)} />
                    <NumberField label="Width (mm)" type="number" min="50" step="25" value={selectedItem.width} onChange={(value) => updateSelectedField("width", value)} />
                    <NumberField label="Depth (mm)" type="number" min="25" step="25" value={selectedItem.depth} onChange={(value) => updateSelectedField("depth", value)} />
                    <NumberField label="Primary Length (mm)" type="number" min="100" step="50" value={selectedItem.lengthA} onChange={(value) => updateSelectedField("lengthA", value)} />
                    <button className="action-button" type="button" onClick={() => removeTray(selectedTarget.index)}>Delete Selected Tray</button>
                  </>
                ) : null}
                {selectedTarget.kind === "opening" ? (
                  <>
                    <TextField label="Label" value={selectedItem.label || ""} onChange={(value) => updateSelectedField("label", value)} />
                    <SelectField label="Type" value={selectedItem.type} onChange={(value) => updateSelectedField("type", value)}>
                      <option value="door">Door</option>
                      <option value="window">Window</option>
                    </SelectField>
                    <SelectField label="Wall" value={String(selectedItem.wall)} onChange={(value) => updateSelectedField("wall", Number(value))}>
                      <option value="0">South</option>
                      <option value="1">East</option>
                      <option value="2">North</option>
                      <option value="3">West</option>
                    </SelectField>
                    <NumberField label="Offset From Wall Start (mm)" type="number" min="0" step="50" value={selectedItem.offset} onChange={(value) => updateSelectedField("offset", value)} />
                    <NumberField label="Width (mm)" type="number" min="300" step="50" value={selectedItem.width} onChange={(value) => updateSelectedField("width", value)} />
                    <NumberField label="Height (mm)" type="number" min="300" step="50" value={selectedItem.height} onChange={(value) => updateSelectedField("height", value)} />
                    <NumberField label="Sill Height (mm)" type="number" min="0" step="50" value={selectedItem.sillHeight} onChange={(value) => updateSelectedField("sillHeight", value)} />
                    <button className="action-button" type="button" onClick={() => removeOpening(selectedTarget.index)}>Delete Selected Opening</button>
                  </>
                ) : null}
                {selectedTarget.kind === "connection" ? (
                  <>
                    <TextField label="Label" value={normalizeConnection(selectedItem).label || ""} onChange={(value) => updateSelectedField("label", value)} />
                    <SelectField label="Cable Color" value={normalizeConnection(selectedItem).color} onChange={(value) => updateSelectedField("color", value)}>
                      <option value="#d24444">Red</option>
                      <option value="#2a7bc9">Blue</option>
                      <option value="#d19a1f">Amber</option>
                      <option value="#3c8a4d">Green</option>
                    </SelectField>
                    <NumberField label="Route Height (mm)" type="number" min="0" step="50" value={normalizeConnection(selectedItem).routeHeight} onChange={(value) => updateSelectedField("routeHeight", value)} />
                    <NumberField label="Control X (mm)" type="number" step="50" value={normalizeConnection(selectedItem).controlX ?? 0} onChange={(value) => updateSelectedField("controlX", value)} />
                    <NumberField label="Control Y (mm)" type="number" step="50" value={normalizeConnection(selectedItem).controlY ?? 0} onChange={(value) => updateSelectedField("controlY", value)} />
                    <button className="action-button" type="button" onClick={() => removeConnection(selectedTarget.index)}>Delete Selected Cable</button>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="empty-state">
                <p>Click a cabinet, tray, door, window, or cable in the 2D plan to select it.</p>
                <p>Equipment, trays, and cable routes can be moved directly on the floor map.</p>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function List({ items, labelForItem, onRemove, selected, kind, onSelect }) {
  return (
    <ul className="item-list">
      {items.map((item, index) => (
        <li key={index} className={selected?.kind === kind && selected?.index === index ? "selected-list-item" : ""}>
          <span
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? 0 : undefined}
            className="list-label"
            onClick={() => onSelect?.({ kind, index })}
            onKeyDown={(event) => {
              if ((event.key === "Enter" || event.key === " ") && onSelect) onSelect({ kind, index });
            }}
          >
            {labelForItem(item, index)}
          </span>
          <button type="button" onClick={() => onRemove(index)}>Remove</button>
        </li>
      ))}
    </ul>
  );
}
