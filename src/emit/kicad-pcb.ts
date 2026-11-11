import type { Board, Component, Hole, Net, Pad, PadPrimitive, Point, Shape, Track, Via } from "../ir/types.ts";
import { ewLayerToKicad } from "../util/layer-map.ts";

// KiCad 8 board format. Matches the (uuid ...) keyword used throughout
// (KiCad 7 used (tstamp ...)). KiCad 9/10 read this without complaint.
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
const deg = (millionths: number): number => millionths / 1_000_000;

const EDGE_CUTS_WIDTH_NM = 50_000; // 0.05 mm — KiCad's typical Edge.Cuts width

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
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

function emitCircle(
  cx: number, cy: number, rNm: number,
  widthNm: number, layer: string,
): string {
  // KiCad (gr_circle): center + a point on the circumference defines the radius.
  return `\t(gr_circle (center ${fx(cx)} ${fy(cy)}) (end ${fx(cx + rNm)} ${fy(cy)}) (stroke (width ${mm(widthNm)}) (type default)) (fill none) (layer ${q(layer)}) (uuid ${q(uuid())}))`;
}

function emitEllipse(s: Extract<Shape, { kind: "ellipse" }>, layer: string): string[] {
  // EW circle: first two points are opposite ends of a diameter.
  if (s.points.length < 2) return [];
  const [p0, p1] = s.points as [Point, Point];
  const cx = (p0.x + p1.x) / 2;
  const cy = (p0.y + p1.y) / 2;
  const r = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2;
  if (r <= 0) return [];
  return [emitCircle(cx, cy, r, strokeWidthFor(s.thickness, layer), layer)];
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
    const p1 = s.points[i]!;
    const p2 = s.points[i + 1]!;
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
    case "ellipse":    return emitEllipse(shape, layer);
  }
}

// ---------------------------------------------------------------------------
// Nets

type NetRef = { idx: number; name: string };
// Resolves a (refdes, pin) pair to its KiCad net, or undefined.
type NetResolver = (refdes: string, pin: string) => NetRef | undefined;

const pinKey = (refdes: string, pin: string) => JSON.stringify([refdes, pin]);

function buildNets(nets: Net[]): { table: string[]; resolve: NetResolver; byName: Map<string, NetRef> } {
  const table = [`\t(net 0 ${q("")})`];
  const byPin = new Map<string, NetRef>();
  const byName = new Map<string, NetRef>();
  nets.forEach((net, i) => {
    const ref = { idx: i + 1, name: net.name };
    table.push(`\t(net ${ref.idx} ${q(net.name)})`);
    byName.set(net.name.toUpperCase(), ref);
    for (const p of net.pins) byPin.set(pinKey(p.refdes, p.pin), ref);
  });
  return { table, resolve: (refdes, pin) => byPin.get(pinKey(refdes, pin)), byName };
}

const posKey = (p: Point): string => `${p.x},${p.y}`;

/** Is `p` inside the pad's copper (approximate for custom pads: bbox)? */
function padContains(pad: Pad, p: Point): boolean {
  const dx = p.x - pad.at.x;
  const dy = p.y - pad.at.y;
  switch (pad.shape.kind) {
    case "circle":
      return Math.hypot(dx, dy) <= pad.shape.diameter / 2 + 1;
    case "rect":
    case "roundrect": {
      const a = -(deg(pad.rotation) * Math.PI) / 180;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      return Math.abs(lx) <= pad.shape.width / 2 + 1 && Math.abs(ly) <= pad.shape.height / 2 + 1;
    }
    case "custom": {
      const pts = pad.shape.primitives.flatMap((pr) =>
        pr.kind === "poly" ? pr.points : [
          { x: pr.center.x - (pr.kind === "circle" ? pr.radius : 0), y: pr.center.y },
          { x: pr.center.x + (pr.kind === "circle" ? pr.radius : 0), y: pr.center.y },
        ]);
      const b = bbox(pts);
      return p.x >= b.xMin && p.x <= b.xMax && p.y >= b.yMin && p.y <= b.yMax;
    }
  }
}

interface PlacedPad {
  pad: Pad;
  net: NetRef;
  copper: ("F.Cu" | "B.Cu")[];
}

/**
 * EW tracks and vias carry no reliable net reference. Compute one per item:
 *   1. Seed each track endpoint that lies inside a netted pad on the same
 *      copper layer, and each via whose own NetName resolves.
 *   2. Propagate through shared endpoints (tracks <-> tracks <-> vias); a via
 *      joins every track that ends on it, on any layer.
 */
function computeNets(
  tracks: Track[],
  vias: Via[],
  pads: PlacedPad[],
  byName: Map<string, NetRef>,
): { trackNets: number[]; viaNets: number[] } {
  const trackNets = new Array<number>(tracks.length).fill(0);
  const viaNets = new Array<number>(vias.length).fill(0);

  // Node ids: tracks are 0..T-1, vias are T..T+V-1.
  const T = tracks.length;
  const byPoint = new Map<string, number[]>();
  const add = (p: Point, id: number) => {
    const k = posKey(p);
    const l = byPoint.get(k);
    if (l) l.push(id);
    else byPoint.set(k, [id]);
  };
  tracks.forEach((t, i) => { add(t.start, i); add(t.end, i); });
  vias.forEach((v, i) => add(v.at, T + i));

  const get = (id: number) => (id < T ? trackNets[id]! : viaNets[id - T]!);
  const set = (id: number, n: number) => { if (id < T) trackNets[id] = n; else viaNets[id - T] = n; };
  const queue: number[] = [];

  // Spatial bucket for pads so seeding stays fast on big boards.
  const CELL = 2_000_000; // 2 mm
  const grid = new Map<string, PlacedPad[]>();
  for (const pp of pads) {
    const r = padReach(pp.pad);
    for (let gx = Math.floor((pp.pad.at.x - r) / CELL); gx <= Math.floor((pp.pad.at.x + r) / CELL); gx++) {
      for (let gy = Math.floor((pp.pad.at.y - r) / CELL); gy <= Math.floor((pp.pad.at.y + r) / CELL); gy++) {
        const k = `${gx},${gy}`;
        const l = grid.get(k);
        if (l) l.push(pp);
        else grid.set(k, [pp]);
      }
    }
  }
  const padAt = (p: Point, layer: string | undefined): PlacedPad | undefined => {
    for (const pp of grid.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`) ?? []) {
      if (layer && !pp.copper.includes(layer as "F.Cu" | "B.Cu")) continue;
      if (padContains(pp.pad, p)) return pp;
    }
    return undefined;
  };

  tracks.forEach((t, i) => {
    const layer = ewLayerToKicad(t.layer);
    const hit = padAt(t.start, layer) ?? padAt(t.end, layer);
    if (hit) { trackNets[i] = hit.net.idx; queue.push(i); }
  });
  vias.forEach((v, i) => {
    const named = v.netName ? byName.get(v.netName.toUpperCase()) : undefined;
    const hit = named ?? padAt(v.at, undefined)?.net;
    if (hit) { viaNets[i] = hit.idx; queue.push(T + i); }
  });

  while (queue.length > 0) {
    const id = queue.shift()!;
    const pts = id < T ? [tracks[id]!.start, tracks[id]!.end] : [vias[id - T]!.at];
    for (const p of pts) {
      for (const j of byPoint.get(posKey(p)) ?? []) {
        if (j !== id && get(j) === 0) { set(j, get(id)); queue.push(j); }
      }
    }
  }
  return { trackNets, viaNets };
}

function padReach(pad: Pad): number {
  switch (pad.shape.kind) {
    case "circle": return pad.shape.diameter / 2;
    case "rect":
    case "roundrect": return Math.hypot(pad.shape.width, pad.shape.height) / 2;
    case "custom": {
      let r = 0;
      for (const pr of pad.shape.primitives) {
        const pts = pr.kind === "poly" ? pr.points : [pr.center];
        const extra = pr.kind === "poly" ? 0 : pr.kind === "circle" ? pr.radius : Math.hypot(pr.start.x - pr.center.x, pr.start.y - pr.center.y);
        for (const p of pts) r = Math.max(r, Math.hypot(p.x - pad.at.x, p.y - pad.at.y) + extra);
      }
      return r;
    }
  }
}

function emitTrack(t: Track, netIdx: number): string | undefined {
  const layer = ewLayerToKicad(t.layer);
  // Only copper layers can carry tracks in KiCad
  if (layer !== "F.Cu" && layer !== "B.Cu") return undefined;
  return `\t(segment (start ${fx(t.start.x)} ${fy(t.start.y)}) (end ${fx(t.end.x)} ${fy(t.end.y)}) (width ${mm(t.thickness)}) (layer ${q(layer)}) (net ${netIdx}) (uuid ${q(uuid())}))`;
}

function emitVia(v: Via, netIdx: number): string {
  return `\t(via (at ${fx(v.at.x)} ${fy(v.at.y)}) (size ${mm(v.diameter)}) (drill ${mm(v.drillDiameter)}) (layers "F.Cu" "B.Cu") (net ${netIdx}) (uuid ${q(uuid())}))`;
}

// ---------------------------------------------------------------------------
// Footprints

function padCopper(pad: Pad): ("F.Cu" | "B.Cu")[] {
  return pad.side === "both" ? ["F.Cu", "B.Cu"] : pad.side === "bottom" ? ["B.Cu"] : ["F.Cu"];
}

/** Custom-pad primitive in pad-local KiCad coordinates (pad emitted unrotated). */
function emitPrimitive(pr: PadPrimitive, at: Point): string {
  const lx = (x: number) => mm(x - at.x);
  const ly = (y: number) => mm(-(y - at.y));
  switch (pr.kind) {
    case "poly":
      return `(gr_poly (pts ${pr.points.map((p) => `(xy ${lx(p.x)} ${ly(p.y)})`).join(" ")}) (width 0) (fill yes))`;
    case "circle":
      return `(gr_circle (center ${lx(pr.center.x)} ${ly(pr.center.y)}) (end ${lx(pr.center.x + pr.radius)} ${ly(pr.center.y)}) (width ${mm(pr.fill ? 0 : pr.width)}) (fill ${pr.fill ? "yes" : "no"}))`;
    case "arc": {
      const r = Math.hypot(pr.start.x - pr.center.x, pr.start.y - pr.center.y);
      const a0 = Math.atan2(pr.start.y - pr.center.y, pr.start.x - pr.center.x);
      let sweep = Math.atan2(pr.end.y - pr.center.y, pr.end.x - pr.center.x) - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      const mid = { x: pr.center.x + r * Math.cos(a0 + sweep / 2), y: pr.center.y + r * Math.sin(a0 + sweep / 2) };
      return `(gr_arc (start ${lx(pr.start.x)} ${ly(pr.start.y)}) (mid ${lx(mid.x)} ${ly(mid.y)}) (end ${lx(pr.end.x)} ${ly(pr.end.y)}) (width ${mm(pr.width)}))`;
    }
  }
}

function emitPad(pad: Pad, origin: Point, net: NetRef | undefined): string {
  // Position relative to footprint origin (footprint emitted at rotation 0),
  // Y flipped to KiCad's screen convention.
  const lx = mm(pad.at.x - origin.x);
  const ly = mm(-(pad.at.y - origin.y));
  const thru = pad.drillDiameter > 0;
  const type = thru ? "thru_hole" : "smd";
  const layers = thru
    ? `"*.Cu" "*.Mask"`
    : pad.side === "bottom" ? `"B.Cu" "B.Paste" "B.Mask"` : `"F.Cu" "F.Paste" "F.Mask"`;
  const drill = thru ? ` (drill ${mm(pad.drillDiameter)})` : "";

  let shapeTok = "circle";
  let size = "";
  let extra = "";
  switch (pad.shape.kind) {
    case "circle":
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
    case "custom": {
      // Tiny circular anchor at the pad centre; the primitives carry the shape.
      shapeTok = "custom";
      const anchor = Math.max(10_000, Math.min(pad.drillDiameter, 100_000));
      size = `${mm(anchor)} ${mm(anchor)}`;
      extra = ` (options (clearance outline) (anchor circle)) (primitives ${pad.shape.primitives.map((p) => emitPrimitive(p, pad.at)).join(" ")})`;
      break;
    }
  }

  // EW and KiCad both measure rotation counter-clockwise as seen on screen,
  // so the angle carries over unchanged despite the Y flip.
  const rotDeg = pad.shape.kind === "circle" || pad.shape.kind === "custom" ? 0 : deg(pad.rotation);
  const at = rotDeg !== 0 ? `(at ${lx} ${ly} ${+rotDeg.toFixed(6)})` : `(at ${lx} ${ly})`;
  const netTok = net ? ` (net ${net.idx} ${q(net.name)})` : "";

  return `\t\t(pad ${q(pad.number)} ${type} ${shapeTok} ${at} (size ${size})${drill} (layers ${layers})${extra}${netTok} (uuid ${q(uuid())}))`;
}

function emitFootprint(c: Component, resolve: NetResolver): string {
  const cu = c.bottom ? "B.Cu" : "F.Cu";
  const silk = c.bottom ? "B.SilkS" : "F.SilkS";
  const fab = c.bottom ? "B.Fab" : "F.Fab";
  const lines: string[] = [
    `\t(footprint ${q("ew:" + (c.name || c.value || "UNKNOWN"))}`,
    `\t\t(layer ${q(cu)})`,
    `\t\t(uuid ${q(uuid())})`,
    `\t\t(at ${fx(c.origin.x)} ${fy(c.origin.y)})`,
    `\t\t(property "Reference" ${q(c.reference)} (at 0 0 0) (layer ${q(silk)}) (uuid ${q(uuid())}) (effects (font (size 1 1) (thickness 0.15))${c.bottom ? " (justify mirror)" : ""}))`,
    `\t\t(property "Value" ${q(c.value)} (at 0 0 0) (layer ${q(fab)}) (uuid ${q(uuid())}) (effects (font (size 1 1) (thickness 0.15))${c.bottom ? " (justify mirror)" : ""}))`,
  ];
  for (const pad of c.pads) lines.push(emitPad(pad, c.origin, resolve(c.reference, pad.number)));
  lines.push(`\t)`);
  return lines.join("\n");
}

function emitHole(h: Hole): string {
  if (h.plated) {
    // Plated standalone drill -> via. No copper pad diameter in EW, so give a
    // 0.25 mm annular ring. net 0 (KiCad recomputes from connectivity).
    const size = h.drillDiameter + 500_000;
    return `\t(via (at ${fx(h.at.x)} ${fy(h.at.y)}) (size ${mm(size)}) (drill ${mm(h.drillDiameter)}) (layers "F.Cu" "B.Cu") (net 0) (uuid ${q(uuid())}))`;
  }
  // Non-plated drill -> mechanical mounting hole. KiCad models this as a
  // footprint holding a single np_thru_hole pad with size == drill (no copper).
  const d = mm(h.drillDiameter);
  return [
    `\t(footprint ${q("ew:MountingHole")}`,
    `\t\t(layer "F.Cu")`,
    `\t\t(uuid ${q(uuid())})`,
    `\t\t(at ${fx(h.at.x)} ${fy(h.at.y)})`,
    `\t\t(pad "" np_thru_hole circle (at 0 0) (size ${d} ${d}) (drill ${d}) (layers "*.Cu" "*.Mask") (uuid ${q(uuid())}))`,
    `\t)`,
  ].join("\n");
}

export function emitKicadPcb(board: Board): string {
  const layerLines = STANDARD_LAYERS.map(([num, name, type, friendly]) => {
    return friendly
      ? `\t\t(${num} ${q(name)} ${type} ${q(friendly)})`
      : `\t\t(${num} ${q(name)} ${type})`;
  }).join("\n");

  const { table: netTable, resolve, byName } = buildNets(board.nets);
  const shapeLines = board.shapes.flatMap(emitShape).join("\n");
  const footprintLines = board.components.map((c) => emitFootprint(c, resolve)).join("\n");
  const holeLines = board.holes.map(emitHole).join("\n");

  const placed: PlacedPad[] = [];
  for (const c of board.components) {
    for (const pad of c.pads) {
      const net = resolve(c.reference, pad.number);
      if (net) placed.push({ pad, net, copper: padCopper(pad) });
    }
  }
  const { trackNets, viaNets } = computeNets(board.tracks, board.vias, placed, byName);
  const trackLines = board.tracks
    .map((t, i) => emitTrack(t, trackNets[i]!))
    .filter((s): s is string => s !== undefined)
    .join("\n");
  const viaLines = board.vias.map((v, i) => emitVia(v, viaNets[i]!)).join("\n");

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
    netTable.join("\n"),
    ``,
    footprintLines,
    ``,
    holeLines,
    ``,
    shapeLines,
    ``,
    trackLines,
    ``,
    viaLines,
    ``,
    `)`,
    ``,
  ].join("\n");
}
