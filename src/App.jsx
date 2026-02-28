import { useEffect, useRef, useState } from "react";
import {
  EQUIPMENT_PRESETS,
  clamp,
  degToRad,
  fitCanvas,
  getOpeningBounds,
  getPlanProjection,
  getTraySegments,
  getWallSegments,
  pointAlongWall,
} from "./modeling.js";
import Scene3D from "./Scene3D.jsx";

const defaultRoom = { width: 6000, length: 9000, height: 3200, southTiltDeg: 0, eastTiltDeg: 0 };
const defaultOpening = { type: "door", wall: 0, offset: 800, width: 1000, height: 2100, sillHeight: 0 };
const defaultEquipment = { type: "cabinet", x: 1200, y: 1800, width: 600, depth: 1000, height: 2200, rotationDeg: 0 };
const defaultTray = { x: 500, y: 500, z: 2600, width: 300, depth: 100, lengthA: 2500, primaryDirection: "x+", turn: "none", lengthB: 1800 };
const defaultConnection = { from: "", to: "", color: "#d24444", routeHeight: 2600 };

function NumberField({ label, value, onChange, ...rest }) {
  return <label>{label}<input value={value} onChange={(event) => onChange(Number(event.target.value))} {...rest} /></label>;
}

function SelectField({ label, value, onChange, children, ...rest }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)} {...rest}>{children}</select></label>;
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
  const planInteractionRef = useRef({ dragging: false, index: null, offsetX: 0, offsetY: 0 });

  useEffect(() => {
    const preset = EQUIPMENT_PRESETS[equipmentDraft.type];
    setEquipmentDraft((current) => ({ ...current, width: preset.width, depth: preset.depth, height: preset.height }));
  }, [equipmentDraft.type]);

  useEffect(() => {
    if (equipment.length === 0) {
      setConnectionDraft((current) => ({ ...current, from: "", to: "" }));
      return;
    }
    setConnectionDraft((current) => {
      const next = { ...current };
      if (next.from === "" || !equipment[Number(next.from)]) next.from = "0";
      if (next.to === "" || !equipment[Number(next.to)] || next.to === next.from) next.to = equipment.length > 1 ? (next.from === "0" ? "1" : "0") : next.from;
      return next;
    });
  }, [equipment]);

  useEffect(() => {
    if (!selectedTarget) {
      return;
    }
    const collections = {
      equipment,
      tray: trays,
      opening: openings,
    };
    const source = collections[selectedTarget.kind];
    if (!source || !source[selectedTarget.index]) {
      setSelectedTarget(null);
    }
  }, [equipment, trays, openings, selectedTarget]);

  useEffect(() => {
    const canvas = planRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    fitCanvas(canvas, ctx);
    const { walls, points, renderWidth, renderHeight, scale, project } = getPlanProjection(room, canvas);
    ctx.clearRect(0, 0, renderWidth, renderHeight);
    ctx.fillStyle = "#fffcf5";
    ctx.beginPath();
    points.forEach((point, index) => {
      const p = project(point);
      if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fill();
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
      getTraySegments(tray).forEach((segment) => {
        const start = project(segment.start);
        const end = project(segment.end);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      });
    });
    equipment.forEach((item, index) => {
      const preset = EQUIPMENT_PRESETS[item.type];
      const center = project({ x: item.x, y: item.y });
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(-degToRad(item.rotationDeg));
      ctx.fillStyle = preset.color2d;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.fillRect((-item.width * scale) / 2, (-item.depth * scale) / 2, item.width * scale, item.depth * scale);
      ctx.strokeRect((-item.width * scale) / 2, (-item.depth * scale) / 2, item.width * scale, item.depth * scale);
      if (selectedTarget?.kind === "equipment" && selectedTarget.index === index) {
        ctx.strokeStyle = "#f08b00";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect((-item.width * scale) / 2 - 4, (-item.depth * scale) / 2 - 4, item.width * scale + 8, item.depth * scale + 8);
        ctx.setLineDash([]);
      }
      ctx.restore();
    });
    connections.forEach((connection) => {
      const from = equipment[connection.from];
      const to = equipment[connection.to];
      if (!from || !to) return;
      const a = project({ x: from.x, y: from.y });
      const b = project({ x: to.x, y: to.y });
      const mid = { x: b.x, y: a.y };
      ctx.strokeStyle = connection.color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(mid.x, mid.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
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
        .map((item, index) => ({ item, index }))
        .reverse()
        .find(({ item }) => pointInRotatedEquipment(worldPoint, item));

      if (equipmentHit) {
        setSelectedTarget({ kind: "equipment", index: equipmentHit.index });
        planInteractionRef.current = {
          dragging: true,
          index: equipmentHit.index,
          offsetX: worldPoint.x - equipment[equipmentHit.index].x,
          offsetY: worldPoint.y - equipment[equipmentHit.index].y,
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
        planInteractionRef.current = { dragging: false, index: null, offsetX: 0, offsetY: 0 };
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
        planInteractionRef.current = { dragging: false, index: null, offsetX: 0, offsetY: 0 };
        return;
      }

      setSelectedTarget(null);
      planInteractionRef.current = { dragging: false, index: null, offsetX: 0, offsetY: 0 };
    };

    const move = (event) => {
      const interaction = planInteractionRef.current;
      if (!interaction.dragging || interaction.index === null) return;
      const worldPoint = getWorldPoint(event);
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
    };

    const up = () => {
      planInteractionRef.current = { dragging: false, index: null, offsetX: 0, offsetY: 0 };
    };

    canvas.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      canvas.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [room, equipment, trays, openings]);

  useEffect(() => {
    const onResize = () => setResizeTick((current) => current + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function addOpening() {
    setOpenings((current) => [...current, { ...openingDraft, sillHeight: openingDraft.type === "door" ? 0 : openingDraft.sillHeight }]);
  }

  function addEquipment() {
    setEquipment((current) => [...current, { ...equipmentDraft }]);
  }

  function addTray() {
    setTrays((current) => [...current, { ...trayDraft }]);
  }

  function addConnection() {
    const from = Number(connectionDraft.from);
    const to = Number(connectionDraft.to);
    if (Number.isNaN(from) || Number.isNaN(to) || from === to || !equipment[from] || !equipment[to]) return;
    setConnections((current) => [...current, { ...connectionDraft, from, to }]);
  }

  function removeEquipment(index) {
    setEquipment((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setConnections((current) => current
      .filter((item) => item.from !== index && item.to !== index)
      .map((item) => ({ ...item, from: item.from > index ? item.from - 1 : item.from, to: item.to > index ? item.to - 1 : item.to })));
    setSelectedTarget((current) => {
      if (!current || current.kind !== "equipment") return current;
      if (current.index === index) return null;
      return current.index > index ? { ...current, index: current.index - 1 } : current;
    });
  }

  function removeTray(index) {
    setTrays((current) => current.filter((_, itemIndex) => itemIndex !== index));
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

  const floorArea = Math.round((room.width * room.length) / 1000000);
  const totalRackUnits = equipment
    .filter((item) => item.type === "cabinet")
    .reduce((sum, item) => sum + Math.round(item.height / 44.45), 0);
  const assetRows = [
    ...equipment.map((item, index) => ({
      kind: "equipment",
      index,
      title: `${index + 1}. ${EQUIPMENT_PRESETS[item.type].label}`,
      detail: `${item.x}, ${item.y}`,
    })),
    ...trays.map((item, index) => ({
      kind: "tray",
      index,
      title: `${index + 1}. Cable Tray`,
      detail: `${item.x}, ${item.y}, z${item.z}`,
    })),
    ...openings.map((item, index) => ({
      kind: "opening",
      index,
      title: `${index + 1}. ${item.type === "door" ? "Door" : "Window"}`,
      detail: ["South", "East", "North", "West"][item.wall],
    })),
  ];
  const filteredAssets = assetRows.filter((row) =>
    `${row.title} ${row.detail}`.toLowerCase().includes(assetQuery.toLowerCase())
  );
  const selectedItem = selectedTarget ? ({ equipment, tray: trays, opening: openings }[selectedTarget.kind] || [])[selectedTarget.index] : null;

  function updateSelectedField(field, value) {
    if (!selectedTarget) return;
    if (selectedTarget.kind === "equipment") {
      const preset = field === "type" ? EQUIPMENT_PRESETS[value] : null;
      setEquipment((current) =>
        current.map((item, index) =>
          index === selectedTarget.index
            ? { ...item, [field]: value, ...(preset ? { width: preset.width, depth: preset.depth, height: preset.height } : {}) }
            : item
        )
      );
      return;
    }
    if (selectedTarget.kind === "tray") {
      setTrays((current) => current.map((item, index) => (index === selectedTarget.index ? { ...item, [field]: value } : item)));
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
            <NumberField label="South Wall Tilt (deg)" type="number" min="-20" max="20" step="0.5" value={room.southTiltDeg} onChange={(value) => setRoom((current) => ({ ...current, southTiltDeg: clamp(value, -20, 20) }))} />
            <NumberField label="East Wall Tilt (deg)" type="number" min="-20" max="20" step="0.5" value={room.eastTiltDeg} onChange={(value) => setRoom((current) => ({ ...current, eastTiltDeg: clamp(value, -20, 20) }))} />
          </div>
        </section>

        <section className="card">
          <h2>Doors & Windows</h2>
          <div className="field-grid">
            <SelectField label="Type" value={openingDraft.type} onChange={(value) => setOpeningDraft((current) => ({ ...current, type: value }))}><option value="door">Door</option><option value="window">Window</option></SelectField>
            <SelectField label="Wall" value={String(openingDraft.wall)} onChange={(value) => setOpeningDraft((current) => ({ ...current, wall: Number(value) }))}><option value="0">South</option><option value="1">East</option><option value="2">North</option><option value="3">West</option></SelectField>
            <NumberField label="Offset From Wall Start (mm)" type="number" min="0" step="50" value={openingDraft.offset} onChange={(value) => setOpeningDraft((current) => ({ ...current, offset: value }))} />
            <NumberField label="Width (mm)" type="number" min="300" step="50" value={openingDraft.width} onChange={(value) => setOpeningDraft((current) => ({ ...current, width: value }))} />
            <NumberField label="Height (mm)" type="number" min="300" step="50" value={openingDraft.height} onChange={(value) => setOpeningDraft((current) => ({ ...current, height: value }))} />
            <NumberField label="Sill Height (mm)" type="number" min="0" step="50" value={openingDraft.sillHeight} onChange={(value) => setOpeningDraft((current) => ({ ...current, sillHeight: value }))} />
          </div>
          <button className="action-button" type="button" onClick={addOpening}>Add Opening</button>
          <List items={openings} labelForItem={(item, index) => `${index + 1}. ${item.type} on ${["South", "East", "North", "West"][item.wall]}`} onRemove={removeOpening} selected={selectedTarget} kind="opening" onSelect={setSelectedTarget} />
        </section>

        <section className="card">
          <h2>Network Hardware</h2>
          <div className="field-grid">
            <SelectField label="Type" value={equipmentDraft.type} onChange={(value) => setEquipmentDraft((current) => ({ ...current, type: value }))}>
              {Object.entries(EQUIPMENT_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
            </SelectField>
            <NumberField label="X Position (mm)" type="number" step="50" value={equipmentDraft.x} onChange={(value) => setEquipmentDraft((current) => ({ ...current, x: value }))} />
            <NumberField label="Y Position (mm)" type="number" step="50" value={equipmentDraft.y} onChange={(value) => setEquipmentDraft((current) => ({ ...current, y: value }))} />
            <NumberField label="Width (mm)" type="number" min="200" step="50" value={equipmentDraft.width} onChange={(value) => setEquipmentDraft((current) => ({ ...current, width: value }))} />
            <NumberField label="Depth (mm)" type="number" min="200" step="50" value={equipmentDraft.depth} onChange={(value) => setEquipmentDraft((current) => ({ ...current, depth: value }))} />
            <NumberField label="Height (mm)" type="number" min="200" step="50" value={equipmentDraft.height} onChange={(value) => setEquipmentDraft((current) => ({ ...current, height: value }))} />
            <NumberField label="Rotation (deg)" type="number" step="5" value={equipmentDraft.rotationDeg} onChange={(value) => setEquipmentDraft((current) => ({ ...current, rotationDeg: value }))} />
          </div>
          <button className="action-button" type="button" onClick={addEquipment}>Add Hardware</button>
          <List items={equipment} labelForItem={(item, index) => `${index + 1}. ${item.type} at (${item.x}, ${item.y})`} onRemove={removeEquipment} selected={selectedTarget} kind="equipment" onSelect={setSelectedTarget} />
        </section>

        <section className="card">
          <h2>Cable Tray</h2>
          <div className="field-grid">
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
          <List items={trays} labelForItem={(item, index) => `${index + 1}. tray from (${item.x}, ${item.y}, ${item.z}) ${item.primaryDirection}`} onRemove={removeTray} selected={selectedTarget} kind="tray" onSelect={setSelectedTarget} />
        </section>

        <section className="card">
          <h2>Wire Connections</h2>
          <div className="field-grid">
            <SelectField label="From Equipment" value={connectionDraft.from} onChange={(value) => setConnectionDraft((current) => ({ ...current, from: value }))} disabled={equipment.length === 0}>
              {equipment.length === 0 ? <option value="">Add hardware first</option> : equipment.map((item, index) => <option key={`from-${index}`} value={String(index)}>{`${index + 1}. ${item.type}`}</option>)}
            </SelectField>
            <SelectField label="To Equipment" value={connectionDraft.to} onChange={(value) => setConnectionDraft((current) => ({ ...current, to: value }))} disabled={equipment.length === 0}>
              {equipment.length === 0 ? <option value="">Add hardware first</option> : equipment.map((item, index) => <option key={`to-${index}`} value={String(index)}>{`${index + 1}. ${item.type}`}</option>)}
            </SelectField>
            <SelectField label="Cable Color" value={connectionDraft.color} onChange={(value) => setConnectionDraft((current) => ({ ...current, color: value }))}><option value="#d24444">Red</option><option value="#2a7bc9">Blue</option><option value="#d19a1f">Amber</option><option value="#3c8a4d">Green</option></SelectField>
            <NumberField label="Route Height (mm)" type="number" min="0" step="50" value={connectionDraft.routeHeight} onChange={(value) => setConnectionDraft((current) => ({ ...current, routeHeight: value }))} />
          </div>
          <button className="action-button" type="button" onClick={addConnection} disabled={equipment.length < 2}>Add Connection</button>
          <List items={connections} labelForItem={(item, index) => `${index + 1}. ${item.from + 1}:${equipment[item.from]?.type || "missing"} -> ${item.to + 1}:${equipment[item.to]?.type || "missing"}`} onRemove={(index) => setConnections((current) => current.filter((_, itemIndex) => itemIndex !== index))} />
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
            <Scene3D
              room={room}
              openings={openings}
              equipment={equipment}
              trays={trays}
              connections={connections}
              selectedTarget={selectedTarget}
            />
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
                    <SelectField label="Asset Type" value={selectedItem.type} onChange={(value) => updateSelectedField("type", value)}>
                      {Object.entries(EQUIPMENT_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
                    </SelectField>
                    <NumberField label="X Position (mm)" type="number" step="50" value={selectedItem.x} onChange={(value) => updateSelectedField("x", value)} />
                    <NumberField label="Y Position (mm)" type="number" step="50" value={selectedItem.y} onChange={(value) => updateSelectedField("y", value)} />
                    <NumberField label="Width (mm)" type="number" min="200" step="50" value={selectedItem.width} onChange={(value) => updateSelectedField("width", value)} />
                    <NumberField label="Depth (mm)" type="number" min="200" step="50" value={selectedItem.depth} onChange={(value) => updateSelectedField("depth", value)} />
                    <NumberField label="Height (mm)" type="number" min="200" step="50" value={selectedItem.height} onChange={(value) => updateSelectedField("height", value)} />
                    <NumberField label="Rotation (deg)" type="number" step="5" value={selectedItem.rotationDeg} onChange={(value) => updateSelectedField("rotationDeg", value)} />
                    <button className="action-button" type="button" onClick={() => removeEquipment(selectedTarget.index)}>Delete Selected Asset</button>
                  </>
                ) : null}
                {selectedTarget.kind === "tray" ? (
                  <>
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
              </div>
            ) : (
              <div className="empty-state">
                <p>Click a cabinet, tray, door, or window in the 2D plan to select it.</p>
                <p>Equipment can be dragged on the floor map. All selected items can be edited here.</p>
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
          <span role="button" tabIndex={0} className="list-label" onClick={() => onSelect({ kind, index })} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onSelect({ kind, index });
          }}>{labelForItem(item, index)}</span>
          <button type="button" onClick={() => onRemove(index)}>Remove</button>
        </li>
      ))}
    </ul>
  );
}
