import type { Board, Component, Pad, Point, Shape, Track } from "../ir/types.ts";
import { ewLayerToKicad } from "../util/layer-map.ts";

// KiCad 8 board format. Matches the (uuid ...) keyword used throughout
// (KiCad 7 used (tstamp ...)). KiCad 9 reads this without complaint.
const KICAD_VERSION = 20240108;

type LayerRow = readonly [number, string, "signal" | "user" | "power" | "mixed" | "jumper", string?];

const STANDARD_LAYERS: readonly LayerRow[] = [
  [0,  "F.Cu",      "signal"],
  [31, "B.Cu",      "signal"],
  [32, "B.Adhes",   "user", "B.Adhesive"],
  [33, "F.Adhes",   "user", "F.Adhesive"],
  [34, "B.Paste",   "user"],
  [35, "F.Paste",   "user"],
  [36, "B.SilkS",   "user", "B.Silkscreen"],
  [37, "F.SilkS",   "user", "F.Silkscreen"],
  [38, "B.Mask",    "user"],
  [39, "F.Mask",    "user"],
  [40, "Dwgs.User", "user", "User.Drawings"],
  [41, "Cmts.User", "user", "User.Comments"],
  [42, "Eco1.User", "user", "User.Eco1"],
  [43, "Eco2.User", "user", "User.Eco2"],
  [44, "Edge.Cuts", "user"],
  [45, "Margin",    "user"],
  [46, "B.CrtYd",   "user", "B.Courtyard"],
  [47, "F.CrtYd",   "user", "F.Courtyard"],
  [48, "B.Fab",     "user"],
  [49, "F.Fab",     "user"],
  [50, "User.1",    "user"],
  [51, "User.2",    "user"],
  [52, "User.3",    "user"],
  [53, "User.4",    "user"],
];

// EW uses Y-up math convention; KiCad uses Y-down. Flip Y on emit.
const NM_PER_MM = 1_000_000;
const mm = (nm: number): string => (nm / NM_PER_MM).toFixed(6);
const fx = (nm: number): string => mm(nm);
const fy = (nm: number): string => mm(-nm);

const EDGE_CUTS_WIDTH_NM = 50_000; // 0.05 mm — KiCad's typical Edge.Cuts width

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function uuid(): string {
  return crypto.randomUUID();
}

function strokeWidthFor(rawNm: number, layer: string): number {
  // EW Edge.Cuts thickness is often a meaningless 1 um value; clamp to 0.05 mm.
  if (layer === "Edge.Cuts") return EDGE_CUTS_WIDTH_NM;
  if (rawNm > 0) return rawNm;
  return 120_000; // 0.12 mm — KiCad's default silkscreen width
}

function emitLine(
  x1: number, y1: number, x2: number, y2: number,
  widthNm: number, layer: string,
): string {
  return `\t(gr_line (start ${fx(x1)} ${fy(y1)}) (end ${fx(x2)} ${fy(y2)}) (stroke (width ${mm(widthNm)}) (type default)) (layer ${q(layer)}) (uuid ${q(uuid())}))`;
}

function emitArc(
  cx: number, cy: number,
  sx: number, sy: number,
  ex: number, ey: number,
  rNm: number,
  widthNm: number, layer: string,
): string {
  // Midpoint on the arc: from center, head in the bisector direction
  // between start and end, scaled to radius.
  const dx = (sx + ex) / 2 - cx;
  const dy = (sy + ey) / 2 - cy;
  const len = Math.hypot(dx, dy);
  const midX = len === 0 ? cx : cx + (dx / len) * rNm;
  const midY = len === 0 ? cy : cy + (dy / len) * rNm;
  return `\t(gr_arc (start ${fx(sx)} ${fy(sy)}) (mid ${fx(midX)} ${fy(midY)}) (end ${fx(ex)} ${fy(ey)}) (stroke (width ${mm(widthNm)}) (type default)) (layer ${q(layer)}) (uuid ${q(uuid())}))`;
}

function bbox(points: { x: number; y: number }[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    xMin: Math.min(...xs),
    xMax: Math.max(...xs),
    yMin: Math.min(...ys),
    yMax: Math.max(...ys),
  };
}

function emitRoundRect(s: Extract<Shape, { kind: "roundRect" }>, layer: string): string[] {
  // First 4 points are the bbox corners; any extras (5th anchor point seen
  // in samples) are ignored.
  if (s.points.length < 4) return [];
  const { xMin, xMax, yMin, yMax } = bbox(s.points.slice(0, 4));
  const r = s.radius;
  const w = strokeWidthFor(s.thickness, layer);
  return [
    // 4 straight edges between rounded corners
    emitLine(xMin, yMin + r, xMin, yMax - r, w, layer),
    emitLine(xMin + r, yMax, xMax - r, yMax, w, layer),
    emitLine(xMax, yMax - r, xMax, yMin + r, w, layer),
    emitLine(xMax - r, yMin, xMin + r, yMin, w, layer),
    // 4 corner arcs (90 deg each); start/end on the bbox edges
    emitArc(xMin + r, yMax - r, xMin, yMax - r, xMin + r, yMax, r, w, layer),
    emitArc(xMax - r, yMax - r, xMax - r, yMax, xMax, yMax - r, r, w, layer),
    emitArc(xMax - r, yMin + r, xMax, yMin + r, xMax - r, yMin, r, w, layer),
    emitArc(xMin + r, yMin + r, xMin + r, yMin, xMin, yMin + r, r, w, layer),
  ];
}

function emitRectangle(s: Extract<Shape, { kind: "rectangle" }>, layer: string): string[] {
  if (s.points.length < 4) return [];
  const { xMin, xMax, yMin, yMax } = bbox(s.points.slice(0, 4));
  const w = strokeWidthFor(s.thickness, layer);
  return [
    emitLine(xMin, yMin, xMax, yMin, w, layer),
    emitLine(xMax, yMin, xMax, yMax, w, layer),
    emitLine(xMax, yMax, xMin, yMax, w, layer),
    emitLine(xMin, yMax, xMin, yMin, w, layer),
  ];
}

function emitPolyline(s: Extract<Shape, { kind: "polyline" }>, layer: string): string[] {
  if (s.points.length < 2) return [];
  const w = strokeWidthFor(s.thickness, layer);
  const out: string[] = [];
  for (let i = 0; i + 1 < s.points.length; i++) {
    const p1 = s.points[i];
    const p2 = s.points[i + 1];
    out.push(emitLine(p1.x, p1.y, p2.x, p2.y, w, layer));
  }
  return out;
}

function emitShape(shape: Shape): string[] {
  const layer = ewLayerToKicad(shape.layer);
  if (!layer) return []; // unmapped EW layer (3D, ratsnest, DRC, page meta, etc.)
  switch (shape.kind) {
    case "roundRect":  return emitRoundRect(shape, layer);
    case "rectangle":  return emitRectangle(shape, layer);
    case "polyline":   return emitPolyline(shape, layer);
    case "ellipse":    return []; // TODO: gr_circle / gr_arc
  }
}

function emitTrack(t: Track): string | undefined {
  const layer = ewLayerToKicad(t.layer);
  // Only copper layers can carry tracks in KiCad
  if (layer !== "F.Cu" && layer !== "B.Cu") return undefined;
  return `\t(segment (start ${fx(t.start.x)} ${fy(t.start.y)}) (end ${fx(t.end.x)} ${fy(t.end.y)}) (width ${mm(t.thickness)}) (layer ${q(layer)}) (net 0) (uuid ${q(uuid())}))`;
}

function emitPad(pad: Pad, origin: Point): string {
  // Position relative to footprint origin (footprint emitted at rotation 0),
  // Y flipped to KiCad's screen convention.
  const lx = mm(pad.at.x - origin.x);
  const ly = mm(-(pad.at.y - origin.y));
  const thru = pad.drillDiameter > 0;
  const type = thru ? "thru_hole" : "smd";
  const layers = thru ? `"*.Cu" "*.Mask"` : `"F.Cu" "F.Paste" "F.Mask"`;
  const drill = thru ? ` (drill ${mm(pad.drillDiameter)})` : "";

  let shapeTok: string;
  let size: string;
  let extra = "";
  switch (pad.shape.kind) {
    case "circle":
      shapeTok = "circle";
      size = `${mm(pad.shape.diameter)} ${mm(pad.shape.diameter)}`;
      break;
    case "rect":
      shapeTok = "rect";
      size = `${mm(pad.shape.width)} ${mm(pad.shape.height)}`;
      break;
    case "roundrect": {
      shapeTok = "roundrect";
      size = `${mm(pad.shape.width)} ${mm(pad.shape.height)}`;
      const minDim = Math.min(pad.shape.width, pad.shape.height);
      const ratio = minDim > 0 ? Math.min(0.5, pad.shape.cornerRadius / minDim) : 0;
      extra = ` (roundrect_rratio ${ratio.toFixed(6)})`;
      break;
    }
  }

  // Circle pads are rotation-invariant; for others negate to match the Y flip.
  // (Unverified for non-square rect pads — no sample yet.)
  const rotDeg = pad.shape.kind === "circle" ? 0 : -(pad.rotation / 1_000_000);
  const at = rotDeg !== 0 ? `(at ${lx} ${ly} ${rotDeg})` : `(at ${lx} ${ly})`;

  return `\t\t(pad ${q(pad.number)} ${type} ${shapeTok} ${at} (size ${size})${drill} (layers ${layers})${extra} (uuid ${q(uuid())}))`;
}

function emitFootprint(c: Component): string {
  const cu = c.bottom ? "B.Cu" : "F.Cu";
  const silk = c.bottom ? "B.SilkS" : "F.SilkS";
  const fab = c.bottom ? "B.Fab" : "F.Fab";
  const lines: string[] = [
    `\t(footprint ${q("ew:" + (c.name || c.value || "UNKNOWN"))}`,
    `\t\t(layer ${q(cu)})`,
    `\t\t(uuid ${q(uuid())})`,
    `\t\t(at ${fx(c.origin.x)} ${fy(c.origin.y)})`,
    `\t\t(property "Reference" ${q(c.reference)} (at 0 0 0) (layer ${q(silk)}) (uuid ${q(uuid())}) (effects (font (size 1 1) (thickness 0.15))))`,
    `\t\t(property "Value" ${q(c.value)} (at 0 0 0) (layer ${q(fab)}) (uuid ${q(uuid())}) (effects (font (size 1 1) (thickness 0.15))))`,
  ];
  for (const pad of c.pads) lines.push(emitPad(pad, c.origin));
  lines.push(`\t)`);
  return lines.join("\n");
}

export function emitKicadPcb(board: Board): string {
  const layerLines = STANDARD_LAYERS.map(([num, name, type, friendly]) => {
    return friendly
      ? `\t\t(${num} ${q(name)} ${type} ${q(friendly)})`
      : `\t\t(${num} ${q(name)} ${type})`;
  }).join("\n");

  const shapeLines = board.shapes.flatMap(emitShape).join("\n");
  const footprintLines = board.components.map(emitFootprint).join("\n");
  const trackLines = board.tracks
    .map(emitTrack)
    .filter((s): s is string => s !== undefined)
    .join("\n");

  const importNote =
    `Imported from ${board.source.application} ` +
    `${board.source.versionMajor}.${board.source.versionMinor} via ew-conv`;

  return [
    `(kicad_pcb`,
    `\t(version ${KICAD_VERSION})`,
    `\t(generator ${q("ew-conv")})`,
    ``,
    `\t(general`,
    `\t\t(thickness 1.6)`,
    `\t)`,
    ``,
    `\t(paper ${q("A4")})`,
    ``,
    `\t(title_block`,
    `\t\t(title ${q(board.projectName)})`,
    `\t\t(comment 1 ${q(importNote)})`,
    `\t)`,
    ``,
    `\t(layers`,
    layerLines,
    `\t)`,
    ``,
    `\t(setup`,
    `\t\t(pad_to_mask_clearance 0)`,
    `\t)`,
    ``,
    `\t(net 0 ${q("")})`,
    ``,
    footprintLines,
    ``,
    shapeLines,
    ``,
    trackLines,
    ``,
    `)`,
    ``,
  ].join("\n");
}
