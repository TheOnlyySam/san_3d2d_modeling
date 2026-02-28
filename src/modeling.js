export const RU_HEIGHT = 44.45;
export const RACK_BASE_CLEARANCE = 40;

export const EQUIPMENT_PRESETS = {
  cabinet: { width: 600, depth: 1000, height: 2200, color2d: "#384a5f", color3d: "#617e98", label: "Network Cabinet", mountable: false, rackUnits: 42 },
  crac: { width: 900, depth: 1200, height: 2400, color2d: "#668c4d", color3d: "#84aa69", label: "CRAC Unit", mountable: false, rackUnits: 0 },
  switch: { width: 450, depth: 450, height: 44.45, color2d: "#6a5b95", color3d: "#8d80b8", label: "Network Switch", mountable: true, rackUnits: 1 },
  ups: { width: 440, depth: 700, height: 133.35, color2d: "#a85b3c", color3d: "#cb7e5d", label: "UPS", mountable: true, rackUnits: 3 },
  pdu: { width: 440, depth: 220, height: 88.9, color2d: "#aa8b2b", color3d: "#c8aa4b", label: "PDU", mountable: true, rackUnits: 2 },
};

export function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

export function degToRad(value) {
  return (Number(value) * Math.PI) / 180;
}

function radians(value) {
  return (value * Math.PI) / 180;
}

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

function rotatePoint(center, point, angleDeg) {
  const angle = radians(angleDeg);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

function directionVector(direction) {
  switch (direction) {
    case "x-": return { x: -1, y: 0 };
    case "y+": return { x: 0, y: 1 };
    case "y-": return { x: 0, y: -1 };
    default: return { x: 1, y: 0 };
  }
}

function turnVector(primary, turn) {
  if (turn === "none") { return { x: 0, y: 0 }; }
  if (turn === "left") { return { x: -primary.y, y: primary.x }; }
  return { x: primary.y, y: -primary.x };
}

export function getRoomFootprint(room) {
  const southRise = Math.tan(degToRad(room.southTiltDeg)) * room.width;
  const eastShift = Math.tan(degToRad(room.eastTiltDeg)) * room.length;
  return [
    { x: 0, y: 0 },
    { x: room.width, y: southRise },
    { x: room.width + eastShift, y: southRise + room.length },
    { x: eastShift, y: room.length },
  ];
}

export function getWallSegments(room) {
  const points = getRoomFootprint(room);
  return points.map((start, index) => {
    const end = points[(index + 1) % points.length];
    const vector = { x: end.x - start.x, y: end.y - start.y };
    return {
      index,
      start,
      end,
      length: Math.hypot(vector.x, vector.y),
      dir: normalize(vector),
      angle: Math.atan2(vector.y, vector.x),
    };
  });
}

export function pointAlongWall(wall, distance) {
  const safe = clamp(distance, 0, wall.length);
  return { x: wall.start.x + wall.dir.x * safe, y: wall.start.y + wall.dir.y * safe };
}

export function getOpeningBounds(opening, wall, room) {
  const width = clamp(opening.width, 150, Math.max(wall.length - 100, 150));
  const start = clamp(opening.offset, 50, Math.max(wall.length - width - 50, 50));
  const end = start + width;
  const sill = clamp(opening.sillHeight, 0, room.height - 100);
  const top = clamp(sill + opening.height, sill + 100, room.height);
  return { start, end, sill, top };
}

export function getTraySegments(tray) {
  const primary = directionVector(tray.primaryDirection);
  const firstEnd = { x: tray.x + primary.x * tray.lengthA, y: tray.y + primary.y * tray.lengthA, z: tray.z };
  const segments = [{ start: { x: tray.x, y: tray.y, z: tray.z }, end: firstEnd }];
  if (tray.turn !== "none" && tray.lengthB > 0) {
    const secondary = turnVector(primary, tray.turn);
    segments.push({
      start: firstEnd,
      end: { x: firstEnd.x + secondary.x * tray.lengthB, y: firstEnd.y + secondary.y * tray.lengthB, z: tray.z },
    });
  }
  return segments;
}

export function getTrayAnchor(tray) {
  const segments = getTraySegments(tray);
  if (segments.length === 0) {
    return { x: tray.x, y: tray.y, z: tray.z };
  }
  const first = segments[0];
  return {
    x: (first.start.x + first.end.x) / 2,
    y: (first.start.y + first.end.y) / 2,
    z: tray.z,
  };
}

export function normalizeConnection(connection) {
  if ("fromKind" in connection && "toKind" in connection) {
    return connection;
  }
  return {
    ...connection,
    fromKind: "equipment",
    fromIndex: connection.from,
    toKind: "equipment",
    toIndex: connection.to,
  };
}

export function getConnectionAnchor(ref, equipment, trays) {
  if (!ref) return null;
  if (ref.kind === "equipment") {
    const item = equipment[ref.index];
    if (!item) return null;
    const mountedCabinet =
      item.mountedIn !== null && item.mountedIn !== undefined ? equipment[item.mountedIn] : null;
    if (mountedCabinet && mountedCabinet.type === "cabinet") {
      return {
        x: mountedCabinet.x,
        y: mountedCabinet.y,
        z: ((item.rackStart || 1) - 1) * RU_HEIGHT + item.height / 2 + RACK_BASE_CLEARANCE,
      };
    }
    return { x: item.x, y: item.y, z: item.height };
  }
  if (ref.kind === "tray") {
    const tray = trays[ref.index];
    if (!tray) return null;
    return getTrayAnchor(tray);
  }
  return null;
}

export function isPointInsidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const hit = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-6) + xi;
    if (hit) { inside = !inside; }
  }
  return inside;
}

export function fitCanvas(canvas, ctx) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(Math.floor(rect.width * ratio), 300);
  const height = Math.max(Math.floor(rect.height * ratio), 240);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(ratio, ratio);
  return { width: width / ratio, height: height / ratio };
}

export function getPlanProjection(room, canvas) {
  const walls = getWallSegments(room);
  const points = walls.map((wall) => wall.start);
  const ratio = window.devicePixelRatio || 1;
  const renderWidth = canvas.width / ratio;
  const renderHeight = canvas.height / ratio;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padding = 60;
  const scale = Math.min(
    (renderWidth - padding * 2) / Math.max(maxX - minX, 1),
    (renderHeight - padding * 2) / Math.max(maxY - minY, 1)
  );
  function project(point) {
    return { x: padding + (point.x - minX) * scale, y: renderHeight - padding - (point.y - minY) * scale };
  }
  function unproject(point) {
    return {
      x: minX + (point.x - padding) / scale,
      y: minY + (renderHeight - padding - point.y) / scale,
    };
  }
  return { walls, points, renderWidth, renderHeight, scale, project, unproject, minX, minY, maxX, maxY, padding };
}

export function project3D(vertex, metrics, view3d) {
  const cosY = Math.cos(view3d.yaw);
  const sinY = Math.sin(view3d.yaw);
  const cosP = Math.cos(view3d.pitch);
  const sinP = Math.sin(view3d.pitch);
  const dx = vertex.x - metrics.center.x;
  const dy = vertex.y - metrics.center.y;
  const dz = vertex.z - metrics.center.z;
  const x1 = dx * cosY - dy * sinY;
  const y1 = dx * sinY + dy * cosY;
  const y2 = y1 * cosP - dz * sinP;
  const depth = y1 * sinP + dz * cosP;
  return { x: metrics.canvasWidth / 2 + x1 * view3d.zoom, y: metrics.canvasHeight * 0.72 - y2 * view3d.zoom, depth };
}

function queueFace(metrics, vertices, fill, stroke, view3d) {
  const projected = vertices.map((vertex) => project3D(vertex, metrics, view3d));
  const depth = projected.reduce((sum, point) => sum + point.depth, 0) / projected.length;
  return { projected, depth, fill, stroke };
}

function prismVertices(center, width, depth, height, rotationDeg, baseZ) {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const corners = [
    { x: center.x - halfWidth, y: center.y - halfDepth },
    { x: center.x + halfWidth, y: center.y - halfDepth },
    { x: center.x + halfWidth, y: center.y + halfDepth },
    { x: center.x - halfWidth, y: center.y + halfDepth },
  ].map((corner) => rotatePoint(center, corner, rotationDeg));
  return {
    bottom: corners.map((corner) => ({ x: corner.x, y: corner.y, z: baseZ })),
    top: corners.map((corner) => ({ x: corner.x, y: corner.y, z: baseZ + height })),
  };
}

export function drawQueuedFaces(ctx, faces) {
  faces.sort((a, b) => a.depth - b.depth).forEach((face) => {
    ctx.beginPath();
    face.projected.forEach((point, index) => {
      if (index === 0) { ctx.moveTo(point.x, point.y); } else { ctx.lineTo(point.x, point.y); }
    });
    ctx.closePath();
    ctx.fillStyle = face.fill;
    ctx.fill();
    ctx.strokeStyle = face.stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  });
}

export function buildFaces(room, footprint, openings, equipment, trays, view3d) {
  const walls = getWallSegments(room);
  const metrics = {
    canvasWidth: 0,
    canvasHeight: 0,
    center: {
      x: footprint.reduce((sum, point) => sum + point.x, 0) / footprint.length,
      y: footprint.reduce((sum, point) => sum + point.y, 0) / footprint.length,
      z: room.height / 2,
    },
  };
  const faces = [];
  faces.push((size) => queueFace({ ...metrics, ...size }, footprint.map((point) => ({ x: point.x, y: point.y, z: 0 })), "#e7d8ba", "#a88b5c", view3d));
  walls.forEach((wall) => {
    const wallOpenings = openings
      .filter((opening) => opening.wall === wall.index)
      .map((opening) => ({ bounds: getOpeningBounds(opening, wall, room) }))
      .sort((a, b) => a.bounds.start - b.bounds.start);
    const sections = [];
    let cursor = 0;
    wallOpenings.forEach(({ bounds }) => {
      if (bounds.start > cursor) { sections.push({ start: cursor, end: bounds.start, z0: 0, z1: room.height }); }
      if (bounds.sill > 0) { sections.push({ start: bounds.start, end: bounds.end, z0: 0, z1: bounds.sill }); }
      if (bounds.top < room.height) { sections.push({ start: bounds.start, end: bounds.end, z0: bounds.top, z1: room.height }); }
      cursor = bounds.end;
    });
    if (cursor < wall.length) { sections.push({ start: cursor, end: wall.length, z0: 0, z1: room.height }); }
    sections.forEach((section) => {
      if (section.end - section.start < 25 || section.z1 - section.z0 < 25) { return; }
      const a = pointAlongWall(wall, section.start);
      const b = pointAlongWall(wall, section.end);
      faces.push((size) => queueFace({ ...metrics, ...size }, [
        { x: a.x, y: a.y, z: section.z0 },
        { x: b.x, y: b.y, z: section.z0 },
        { x: b.x, y: b.y, z: section.z1 },
        { x: a.x, y: a.y, z: section.z1 },
      ], "#d8c6a2", "#8d7343", view3d));
    });
  });
  equipment.forEach((item) => {
    if (!isPointInsidePolygon({ x: item.x, y: item.y }, footprint)) { return; }
    const preset = EQUIPMENT_PRESETS[item.type];
    const vertices = prismVertices({ x: item.x, y: item.y }, item.width, item.depth, item.height, item.rotationDeg, 0);
    [
      [vertices.top[0], vertices.top[1], vertices.top[2], vertices.top[3], preset.color3d],
      [vertices.bottom[0], vertices.bottom[1], vertices.top[1], vertices.top[0], preset.color2d],
      [vertices.bottom[1], vertices.bottom[2], vertices.top[2], vertices.top[1], preset.color2d],
      [vertices.bottom[2], vertices.bottom[3], vertices.top[3], vertices.top[2], preset.color2d],
      [vertices.bottom[3], vertices.bottom[0], vertices.top[0], vertices.top[3], preset.color2d],
    ].forEach((definition) => {
      faces.push((size) => queueFace({ ...metrics, ...size }, definition.slice(0, 4), definition[4], "#2b2b2b", view3d));
    });
  });
  trays.forEach((tray) => {
    getTraySegments(tray).forEach((segment) => {
      const dx = segment.end.x - segment.start.x;
      const dy = segment.end.y - segment.start.y;
      const length = Math.hypot(dx, dy);
      if (length <= 0) { return; }
      const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      const center = { x: (segment.start.x + segment.end.x) / 2, y: (segment.start.y + segment.end.y) / 2 };
      const vertices = prismVertices(center, length, tray.width, tray.depth, angleDeg, tray.z);
      [
        [vertices.top[0], vertices.top[1], vertices.top[2], vertices.top[3], "#e1b155"],
        [vertices.bottom[0], vertices.bottom[1], vertices.top[1], vertices.top[0], "#c88f22"],
        [vertices.bottom[1], vertices.bottom[2], vertices.top[2], vertices.top[1], "#c88f22"],
        [vertices.bottom[2], vertices.bottom[3], vertices.top[3], vertices.top[2], "#c88f22"],
        [vertices.bottom[3], vertices.bottom[0], vertices.top[0], vertices.top[3], "#c88f22"],
      ].forEach((definition) => {
        faces.push((size) => queueFace({ ...metrics, ...size }, definition.slice(0, 4), definition[4], "#855b11", view3d));
      });
    });
  });
  return faces;
}
