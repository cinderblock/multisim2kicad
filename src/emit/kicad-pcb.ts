import type { Board, BoardText, Component, Hole, Net, Pad, PadPrimitive, Point, RuleArea, Shape, Track, Via, Zone } from "../ir/types.ts";
import { LayerMap } from "./pcb-layers.ts";

// KiCad 8 board format. Matches the (uuid ...) keyword used throughout
// (KiCad 7 used (tstamp ...)). KiCad 9/10 read this without complaint.
const KICAD_VERSION = 20240108;

// EW uses Y-up math convention; KiCad uses Y-down. Flip Y on emit.
const NM_PER_MM = 1_000_000;
const mm = (nm: number): string => (nm / NM_PER_MM).toFixed(6);
const fx = (nm: number): string => mm(nm);
const fy = (nm: number): string => mm(-nm);
const deg = (millionths: number): number => millionths / 1_000_000;
const normDeg = (d: number): number => ((d % 360) + 360) % 360;

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

/**
 * Where graphics land: on the board (`gr_*`, absolute) or inside a footprint
 * (`fp_*`, footprint-local). `xy` maps an absolute EW point (nm, Y-up) to a
 * KiCad "x y" pair in mm. Footprint frames are rigid (rotation only), so arc
 * mid points and circle radii computed in EW coordinates carry over.
 */
interface Frame {
  kind: "gr" | "fp";
  indent: string;
  xy(x: number, y: number): string;
  /** Frame coordinates in nm (KiCad's Y-down, frame-local). */
  local(x: number, y: number): Point;
  /** The frame's orientation on the board, degrees CCW (footprint rotation). */
  angle: number;
}

const BOARD: Frame = { kind: "gr", indent: "\t", xy: (x, y) => `${fx(x)} ${fy(y)}`, local: (x, y) => ({ x, y: -y }), angle: 0 };

const stroke = (widthNm: number) => `(stroke (width ${mm(widthNm)}) (type default))`;

function emitLine(
  f: Frame,
  x1: number, y1: number, x2: number, y2: number,
  widthNm: number, layer: string,
): string {
  return `${f.indent}(${f.kind}_line (start ${f.xy(x1, y1)}) (end ${f.xy(x2, y2)}) ${stroke(widthNm)} (layer ${q(layer)}) (uuid ${q(uuid())}))`;
}

function emitArc(
  f: Frame,
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
  return `${f.indent}(${f.kind}_arc (start ${f.xy(sx, sy)}) (mid ${f.xy(midX, midY)}) (end ${f.xy(ex, ey)}) ${stroke(widthNm)} (layer ${q(layer)}) (uuid ${q(uuid())}))`;
}

function emitCircle(
  f: Frame,
  cx: number, cy: number, rNm: number,
  widthNm: number, layer: string,
): string {
  // KiCad circle: center + a point on the circumference defines the radius.
  // The rim point sits on the frame's +x axis, so a footprint's circles
  // read the same at any rotation (and match the library copy).
  const c = f.local(cx, cy);
  return `${f.indent}(${f.kind}_circle (center ${mm(c.x)} ${mm(c.y)}) (end ${mm(c.x + rNm)} ${mm(c.y)}) ${stroke(widthNm)} (fill none) (layer ${q(layer)}) (uuid ${q(uuid())}))`;
}

function emitEllipse(f: Frame, s: Extract<Shape, { kind: "ellipse" }>, layer: string): string[] {
  // EW circle: first two points are opposite ends of a diameter.
  if (s.points.length < 2) return [];
  const [p0, p1] = s.points as [Point, Point];
  const cx = (p0.x + p1.x) / 2;
  const cy = (p0.y + p1.y) / 2;
  const r = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2;
  if (r <= 0) return [];
  return [emitCircle(f, cx, cy, r, strokeWidthFor(s.thickness, layer), layer)];
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

function emitRoundRect(f: Frame, s: Extract<Shape, { kind: "roundRect" }>, layer: string): string[] {
  // First 4 points are the corners, in a loop (a 5th anchor point is
  // ignored). Built from the corners, not the bounding box, so a part at any
  // angle keeps its outline.
  if (s.points.length < 4) return [];
  const corners = s.points.slice(0, 4);
  const w = strokeWidthFor(s.thickness, layer);
  const unit = (a: Point, b: Point) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };
  const shortest = Math.min(...corners.map((p, i) => Math.hypot(corners[(i + 1) % 4]!.x - p.x, corners[(i + 1) % 4]!.y - p.y)));
  const r = Math.max(0, Math.min(s.radius, shortest / 2));
  // Per corner: where the arc meets the edge to the previous / next corner.
  const ends = corners.map((p, i) => {
    const toPrev = unit(p, corners[(i + 3) % 4]!);
    const toNext = unit(p, corners[(i + 1) % 4]!);
    return {
      a: { x: p.x + toPrev.x * r, y: p.y + toPrev.y * r },
      b: { x: p.x + toNext.x * r, y: p.y + toNext.y * r },
      c: { x: p.x + (toPrev.x + toNext.x) * r, y: p.y + (toPrev.y + toNext.y) * r },
    };
  });
  const out: string[] = [];
  ends.forEach((e, i) => {
    const next = ends[(i + 1) % 4]!;
    out.push(emitLine(f, e.b.x, e.b.y, next.a.x, next.a.y, w, layer));
  });
  if (r > 0) for (const e of ends) out.push(emitArc(f, e.c.x, e.c.y, e.a.x, e.a.y, e.b.x, e.b.y, r, w, layer));
  return out;
}

function emitRectangle(f: Frame, s: Extract<Shape, { kind: "rectangle" }>, layer: string): string[] {
  if (s.points.length < 4) return [];
  // The 4 corners in Ultiboard's order (always a loop): a rotated part's
  // rectangle stays rotated (not its bounding box), and copies of one
  // footprint draw it the same way (library match).
  const corners = s.points.slice(0, 4);
  const w = strokeWidthFor(s.thickness, layer);
  return corners.map((p, i) => {
    const q = corners[(i + 1) % 4]!;
    return emitLine(f, p.x, p.y, q.x, q.y, w, layer);
  });
}

function emitPolyline(f: Frame, s: Extract<Shape, { kind: "polyline" }>, layer: string): string[] {
  if (s.points.length < 2) return [];
  const w = strokeWidthFor(s.thickness, layer);
  const out: string[] = [];
  for (let i = 0; i + 1 < s.points.length; i++) {
    const p1 = s.points[i]!;
    const p2 = s.points[i + 1]!;
    out.push(emitLine(f, p1.x, p1.y, p2.x, p2.y, w, layer));
  }
  return out;
}

/** Mid point of a counter-clockwise (Y-up) arc from start to end. */
function ccwMid(center: Point, start: Point, end: Point): Point {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  let sweep = Math.atan2(end.y - center.y, end.x - center.x) - a0;
  while (sweep <= 1e-12) sweep += 2 * Math.PI;
  return { x: center.x + r * Math.cos(a0 + sweep / 2), y: center.y + r * Math.sin(a0 + sweep / 2) };
}

function emitArcShape(f: Frame, s: Extract<Shape, { kind: "arc" }>, layer: string): string[] {
  const r = Math.hypot(s.start.x - s.center.x, s.start.y - s.center.y);
  if (r <= 0) return [];
  const w = strokeWidthFor(s.thickness, layer);
  if (Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) < 1) return [emitCircle(f, s.center.x, s.center.y, r, w, layer)];
  const m = ccwMid(s.center, s.start, s.end);
  return [`${f.indent}(${f.kind}_arc (start ${f.xy(s.start.x, s.start.y)}) (mid ${f.xy(m.x, m.y)}) (end ${f.xy(s.end.x, s.end.y)}) ${stroke(w)} (layer ${q(layer)}) (uuid ${q(uuid())}))`];
}

function emitShape(shape: Shape, layer: string | undefined, f: Frame = BOARD): string[] {
  if (!layer) return []; // EW-internal layer (ratsnest, DRC markers, ...)
  switch (shape.kind) {
    case "roundRect":  return emitRoundRect(f, shape, layer);
    case "rectangle":  return emitRectangle(f, shape, layer);
    case "polyline":   return emitPolyline(f, shape, layer);
    case "ellipse":    return emitEllipse(f, shape, layer);
    case "arc":        return emitArcShape(f, shape, layer);
  }
}

// ---------------------------------------------------------------------------
// Zones, text, rule areas

const pts = (outline: Point[]) => outline.map((p) => `(xy ${fx(p.x)} ${fy(p.y)})`).join(" ");

/**
 * EW pour -> KiCad zone (unfilled; KiCad refills). Copper areas outrank
 * planes, and each zone gets its own priority (KiCad rejects overlapping
 * zones of equal priority, even on one net); later-drawn areas win. Island removal: EW's "remove not edge connected islands" removes
 * copper not tied to the net (KiCad mode 0); "remove small islands" alone
 * maps to KiCad's area threshold mode with KiCad's default area, since
 * EW's RemoveIslandSize unit is unverified.
 */
function emitZone(z: Zone, lm: LayerMap, net: NetRef | undefined, priority: number): string | undefined {
  const layer = lm.kicad(z.layer);
  if (!lm.isCopper(layer)) return undefined;
  const mode = z.removeNotEdgeConnected ? 0 : z.removeIslands ? 2 : 1;
  const gap = z.clearance > 0 ? z.clearance : 254_000;
  const spoke = z.reliefSpokeWidth > 0 ? z.reliefSpokeWidth : 254_000;
  const minT = z.minThickness > 0 ? Math.min(z.minThickness, 1_000_000) : 254_000;
  return [
    `\t(zone (net ${net?.idx ?? 0}) (net_name ${q(net?.name ?? "")}) (layer ${q(layer!)}) (uuid ${q(uuid())})`,
    `\t\t(name ${q(`EW ${z.kind === "plane" ? "power plane" : "copper area"} ${z.netName}`)})`,
    `\t\t(hatch edge 0.5)`,
    `\t\t(priority ${priority})`,
    `\t\t(connect_pads (clearance ${mm(gap)}))`,
    `\t\t(min_thickness ${mm(minT)}) (filled_areas_thickness no)`,
    `\t\t(fill (thermal_gap ${mm(gap)}) (thermal_bridge_width ${mm(spoke)}) (island_removal_mode ${mode})${mode === 2 ? " (island_area_min 10)" : ""})`,
    `\t\t(polygon (pts ${pts(z.outline)}))`,
    `\t)`,
  ].join("\n");
}

/** `(at ...)` and `(effects ...)` of a text; KiCad stores text angles absolute, even in footprints. */
function textParts(t: BoardText, f: Frame): { at: string; effects: string } {
  const h = t.height > 0 ? t.height : 1_000_000;
  const w = t.width > 0 ? t.width : h;
  const thick = t.strokeWidth > 0 ? t.strokeWidth : Math.round(h * 0.15);
  const a = normDeg(deg(t.angle));
  return {
    at: `(at ${f.xy(t.at.x, t.at.y)}${a || f.kind === "fp" ? ` ${+a.toFixed(6)}` : ""})`,
    effects: `(effects (font (size ${mm(h)} ${mm(w)}) (thickness ${mm(thick)}))${t.mirror ? " (justify mirror)" : ""})`,
  };
}

function emitText(t: BoardText, lm: LayerMap): string | undefined {
  const layer = lm.kicad(t.layer);
  if (!layer) return undefined;
  const { at, effects } = textParts(t, BOARD);
  return `\t(gr_text ${q(t.text)} ${at} (layer ${q(layer)}) (uuid ${q(uuid())}) ${effects})`;
}

/**
 * EW rule areas become KiCad rule areas that allow everything: the outline,
 * layers and net list survive (named, for custom DRC rules) without guessing
 * restrictions whose EW semantics are unconfirmed.
 */
function emitRuleArea(r: RuleArea, i: number, lm: LayerMap): string {
  const nets = r.allNets ? "all nets" : `nets ${r.nets.join(", ") || "(none)"}`;
  return [
    `\t(zone (net 0) (net_name "") (layers ${lm.copper.map(q).join(" ")}) (uuid ${q(uuid())})`,
    `\t\t(name ${q(`EW rule area ${i + 1} (type ${r.type}, ${nets})`)})`,
    `\t\t(hatch edge 0.5)`,
    `\t\t(connect_pads (clearance 0))`,
    `\t\t(min_thickness 0.25) (filled_areas_thickness no)`,
    `\t\t(keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))`,
    `\t\t(fill (thermal_gap 0.5) (thermal_bridge_width 0.5))`,
    `\t\t(polygon (pts ${pts(r.outline)}))`,
    `\t)`,
  ].join("\n");
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
  copper: string[];
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
  lm: LayerMap,
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
      if (layer && !pp.copper.includes(layer)) continue;
      if (padContains(pp.pad, p)) return pp;
    }
    return undefined;
  };

  tracks.forEach((t, i) => {
    const layer = lm.kicad(t.layer);
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

function emitTrack(t: Track, netIdx: number, lm: LayerMap): string | undefined {
  const layer = lm.kicad(t.layer);
  // Only copper layers in the stack can carry tracks.
  if (!layer || !lm.isCopper(layer)) return undefined;
  return `\t(segment (start ${fx(t.start.x)} ${fy(t.start.y)}) (end ${fx(t.end.x)} ${fy(t.end.y)}) (width ${mm(t.thickness)}) (layer ${q(layer)}) (net ${netIdx}) (uuid ${q(uuid())}))`;
}

function emitVia(v: Via, netIdx: number): string {
  return `\t(via (at ${fx(v.at.x)} ${fy(v.at.y)}) (size ${mm(v.diameter)}) (drill ${mm(v.drillDiameter)}) (layers "F.Cu" "B.Cu") (net ${netIdx}) (uuid ${q(uuid())}))`;
}

// ---------------------------------------------------------------------------
// Footprints

function padCopper(pad: Pad, lm: LayerMap): string[] {
  return pad.side === "both" ? lm.copper : pad.side === "bottom" ? ["B.Cu"] : ["F.Cu"];
}

/**
 * Custom-pad primitive relative to its pad, in the frame's orientation (the
 * pad is emitted at the frame's angle, so primitives read the same on every
 * copy of a footprint and in its library entry).
 */
function emitPrimitive(pr: PadPrimitive, at: Point, f: Frame): string {
  const o = f.local(at.x, at.y);
  const rel = (x: number, y: number) => {
    const p = f.local(x, y);
    return { x: p.x - o.x, y: p.y - o.y };
  };
  const xy = (x: number, y: number) => {
    const p = rel(x, y);
    return `${mm(p.x)} ${mm(p.y)}`;
  };
  const lx = (x: number, y: number) => mm(rel(x, y).x);
  const ly = (x: number, y: number) => mm(rel(x, y).y);
  switch (pr.kind) {
    case "poly":
      return `(gr_poly (pts ${pr.points.map((p) => `(xy ${xy(p.x, p.y)})`).join(" ")}) (width 0) (fill yes))`;
    case "circle": {
      const c = rel(pr.center.x, pr.center.y);
      return `(gr_circle (center ${mm(c.x)} ${mm(c.y)}) (end ${mm(c.x + pr.radius)} ${mm(c.y)}) (width ${mm(pr.fill ? 0 : pr.width)}) (fill ${pr.fill ? "yes" : "no"}))`;
    }
    case "arc": {
      const r = Math.hypot(pr.start.x - pr.center.x, pr.start.y - pr.center.y);
      const a0 = Math.atan2(pr.start.y - pr.center.y, pr.start.x - pr.center.x);
      let sweep = Math.atan2(pr.end.y - pr.center.y, pr.end.x - pr.center.x) - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      const mid = { x: pr.center.x + r * Math.cos(a0 + sweep / 2), y: pr.center.y + r * Math.sin(a0 + sweep / 2) };
      return `(gr_arc (start ${lx(pr.start.x, pr.start.y)} ${ly(pr.start.x, pr.start.y)}) (mid ${lx(mid.x, mid.y)} ${ly(mid.x, mid.y)}) (end ${lx(pr.end.x, pr.end.y)} ${ly(pr.end.x, pr.end.y)}) (width ${mm(pr.width)}))`;
    }
  }
}

/**
 * False for a zero-size pad with no hole: EW's placeholder for a lead the
 * package leaves out (the cut middle lead of NI's DPAK `TO228P991X238-3_4N`).
 * It has no copper in EW, and KiCad refuses to load a library holding a
 * zero-size pad, so it is not emitted.
 */
function hasCopper(pad: Pad): boolean {
  if (pad.drillDiameter > 0) return true;
  const s = pad.shape;
  return s.kind === "custom" || (s.kind === "circle" ? s.diameter > 0 : s.width > 0 && s.height > 0);
}

function emitPad(pad: Pad, f: Frame, net: NetRef | undefined): string {
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
      extra = ` (options (clearance outline) (anchor circle)) (primitives ${pad.shape.primitives.map((p) => emitPrimitive(p, pad.at, f)).join(" ")})`;
      break;
    }
  }

  // EW and KiCad both measure rotation counter-clockwise as seen on screen,
  // so the angle carries over unchanged despite the Y flip. KiCad stores pad
  // angles absolute (footprint rotation included), as EW does. Round and
  // custom pads take the footprint's own angle (custom primitives are
  // written in the footprint's frame), so they match the library copy.
  const rotDeg = pad.shape.kind === "circle" || pad.shape.kind === "custom" ? normDeg(f.angle) : normDeg(deg(pad.rotation));
  const at = `(at ${f.xy(pad.at.x, pad.at.y)}${rotDeg !== 0 ? ` ${+rotDeg.toFixed(6)}` : ""})`;
  const netTok = net ? ` (net ${net.idx} ${q(net.name)})` : "";

  return `\t\t(pad ${q(pad.number)} ${type} ${shapeTok} ${at} (size ${size})${drill} (layers ${layers})${extra}${netTok} (uuid ${q(uuid())}))`;
}

/**
 * KiCad orientation of a placed part and its footprint-local frame.
 *
 * KiCad places footprint items at origin + R(phi) * local and stores bottom
 * footprints with local Y mirrored relative to the top-side drawing. EW's
 * bottom-side parts are origin + R(-rot) * mirrorX(local) (C6 survey);
 * mirrorX = R(180) * mirrorY, so phi = 180 - rot on the bottom, and the same
 * footprint flipped to the top in KiCad gets EW's top-side drawing back.
 */
function footprintFrame(c: Component): { phi: number; frame: Frame } {
  const r = deg(c.rotation);
  const phi = normDeg(+(c.bottom ? 180 - r : r).toFixed(6));
  const t = (phi * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // KiCad board coordinates are Y-down: (x, -y). local = R(-phi) * (b - o),
  // where R is counter-clockwise as seen on screen.
  const ox = c.origin.x;
  const oy = -c.origin.y;
  const local = (x: number, y: number): Point => {
    const dx = x - ox;
    const dy = -y - oy;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  };
  const xy = (x: number, y: number) => {
    const p = local(x, y);
    return `${mm(p.x)} ${mm(p.y)}`;
  };
  return { phi, frame: { kind: "fp", indent: "\t\t", xy, local, angle: phi } };
}

/** Footprint name for a part: EW's footprint (shape) name, file-name safe. */
export function footprintName(c: Component): string {
  return (c.name || c.value || "UNKNOWN").replace(/[\\/:*?"<>|]+/g, "_");
}

/** Schematic link fields for a footprint (KiCad's path / sheetname / sheetfile). */
export interface FootprintLink {
  path: string;
  sheetname: string;
  sheetfile: string;
  /** The symbol's value; KiCad treats the schematic as the master copy. */
  value: string;
}

export interface PcbOptions {
  /** Emit a library footprint: no position, nets or board links. */
  library?: boolean;
  /** Footprint library nickname for the footprints' lib ids (default "ew"). */
  footprintLib?: string;
  /** Reference -> schematic symbol, to link the board to its schematic. */
  links?: ReadonlyMap<string, FootprintLink>;
}

function emitFootprint(c: Component, resolve: NetResolver, lm: LayerMap, opts: PcbOptions): string {
  const cu = c.bottom ? "B.Cu" : "F.Cu";
  const silk = c.bottom ? "B.SilkS" : "F.SilkS";
  const fab = c.bottom ? "B.Fab" : "F.Fab";
  const { phi, frame } = footprintFrame(c);
  const link = opts.links?.get(c.reference);
  const lines: string[] = [
    `\t(footprint ${q(`${opts.footprintLib ?? "ew"}:${footprintName(c)}`)}`,
    `\t\t(layer ${q(cu)})`,
    ...(opts.library ? [] : [`\t\t(uuid ${q(uuid())})`, `\t\t(at ${fx(c.origin.x)} ${fy(c.origin.y)}${phi ? ` ${+phi.toFixed(6)}` : ""})`]),
    ...(link
      ? [`\t\t(path ${q(link.path)})`, `\t\t(sheetname ${q(link.sheetname)})`, `\t\t(sheetfile ${q(link.sheetfile)})`]
      : []),
    // A board linked to a schematic: parts with no symbol (mounting
    // hardware, fiducials, test points drawn only on the board) are
    // board-only, so "Update PCB from Schematic" keeps them.
    ...(opts.links && !link ? [`\t\t(attr board_only)`] : []),
  ];
  const value = link?.value || c.value;

  // Reference and Value are footprint properties; other visible EW labels
  // become footprint text.
  const field = (name: string, value: string, tag: string, fallbackLayer: string) => {
    const t = c.texts.find((x) => x.tag === tag);
    const layer = (t && lm.kicadInPart(t.layer, c.bottom)) || fallbackLayer;
    const parts = t
      ? textParts(t, frame)
      : { at: `(at 0 0 ${+phi.toFixed(6)})`, effects: `(effects (font (size 1 1) (thickness 0.15))${c.bottom ? " (justify mirror)" : ""})` };
    const hide = t && !t.visible ? " (hide yes)" : "";
    return `\t\t(property ${q(name)} ${q(value)} ${parts.at} (layer ${q(layer)})${hide} (uuid ${q(uuid())}) ${parts.effects})`;
  };
  lines.push(field("Reference", c.reference, "REFDES", silk));
  lines.push(field("Value", value, "VALUE", fab));
  for (const t of c.texts) {
    if (t.tag === "REFDES" || t.tag === "VALUE" || !t.visible) continue;
    const layer = lm.kicadInPart(t.layer, c.bottom);
    if (!layer) continue;
    const { at, effects } = textParts(t, frame);
    lines.push(`\t\t(fp_text user ${q(t.text)} ${at} (layer ${q(layer)}) (uuid ${q(uuid())}) ${effects})`);
  }
  for (const g of c.graphics) lines.push(...emitShape(g, lm.kicadInPart(g.layer, c.bottom), frame));
  for (const pad of c.pads) if (hasCopper(pad)) lines.push(emitPad(pad, frame, resolve(c.reference, pad.number)));
  lines.push(`\t)`);
  return lines.join("\n");
}

/** One footprint on its own (library files): no nets. */
export function emitFootprintFor(c: Component, lm: LayerMap, opts: PcbOptions = {}): string {
  return emitFootprint(c, () => undefined, lm, opts);
}

/** Library name of a mounting hole footprint: by drill size. */
export const mountingHoleName = (drillNm: number) => `MountingHole_${+(drillNm / NM_PER_MM).toFixed(4)}mm`;

/**
 * A mechanical mounting hole: KiCad models it as a footprint holding one
 * np_thru_hole pad with size == drill (no copper). `at` is omitted for the
 * library copy.
 */
export function mountingHoleFootprint(drillNm: number, lib: string, place?: { at: Point; n: number }): string {
  const d = mm(drillNm);
  const name = mountingHoleName(drillNm);
  return [
    `\t(footprint ${q(place ? `${lib}:${name}` : name)}`,
    `\t\t(layer "F.Cu")`,
    ...(place ? [`\t\t(uuid ${q(uuid())})`, `\t\t(at ${fx(place.at.x)} ${fy(place.at.y)})`] : []),
    `\t\t(property "Reference" ${q(place ? `MH${place.n}` : "MH**")} (at 0 0 0) (layer "F.Fab") (hide yes) (uuid ${q(uuid())}) (effects (font (size 1 1) (thickness 0.15))))`,
    `\t\t(property "Value" ${q(name)} (at 0 0 0) (layer "F.Fab") (hide yes) (uuid ${q(uuid())}) (effects (font (size 1 1) (thickness 0.15))))`,
    `\t\t(attr board_only exclude_from_pos_files exclude_from_bom)`,
    `\t\t(pad "" np_thru_hole circle (at 0 0) (size ${d} ${d}) (drill ${d}) (layers "*.Cu" "*.Mask") (uuid ${q(uuid())}))`,
    `\t)`,
  ].join("\n");
}

function emitHole(h: Hole, n: number, lib: string): string {
  if (h.plated) {
    // Plated standalone drill -> via. No copper pad diameter in EW, so give a
    // 0.25 mm annular ring. net 0 (KiCad recomputes from connectivity).
    const size = h.drillDiameter + 500_000;
    return `\t(via (at ${fx(h.at.x)} ${fy(h.at.y)}) (size ${mm(size)}) (drill ${mm(h.drillDiameter)}) (layers "F.Cu" "B.Cu") (net 0) (uuid ${q(uuid())}))`;
  }
  return mountingHoleFootprint(h.drillDiameter, lib, { at: h.at, n });
}

export function emitKicadPcb(board: Board, opts: PcbOptions = {}): string {
  const lm = new LayerMap(board);
  const layerLines = lm.table
    .map((l) => (l.userName ? `\t\t(${l.id} ${q(l.name)} ${l.type} ${q(l.userName)})` : `\t\t(${l.id} ${q(l.name)} ${l.type})`))
    .join("\n");

  const { table: netTable, resolve, byName } = buildNets(board.nets);
  const shapeLines = board.shapes.flatMap((sh) => emitShape(sh, lm.kicad(sh.layer))).join("\n");
  const planeCount = board.zones.filter((z) => z.kind === "plane").length;
  let areaIdx = 0;
  let planeIdx = 0;
  const zoneLines = board.zones
    .map((z) => {
      const priority = z.kind === "plane" ? planeIdx++ : planeCount + areaIdx++;
      return emitZone(z, lm, byName.get(z.netName.toUpperCase()), priority);
    })
    .filter((x): x is string => x !== undefined)
    .join("\n");
  const textLines = board.texts.map((t) => emitText(t, lm)).filter((x): x is string => x !== undefined).join("\n");
  const ruleLines = board.ruleAreas.map((r, i) => emitRuleArea(r, i, lm)).join("\n");
  const footprintLines = board.components.map((c) => emitFootprint(c, resolve, lm, opts)).join("\n");
  const holeLines = board.holes.map((h, i) => emitHole(h, i + 1, opts.footprintLib ?? "ew")).join("\n");

  const placed: PlacedPad[] = [];
  for (const c of board.components) {
    for (const pad of c.pads) {
      const net = resolve(c.reference, pad.number);
      if (net) placed.push({ pad, net, copper: padCopper(pad, lm) });
    }
  }
  const { trackNets, viaNets } = computeNets(board.tracks, board.vias, placed, byName, lm);
  const trackLines = board.tracks
    .map((t, i) => emitTrack(t, trackNets[i]!, lm))
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
    `\t\t(thickness ${mm(board.stackup.thickness)})`,
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
    textLines,
    ``,
    trackLines,
    ``,
    viaLines,
    ``,
    zoneLines,
    ``,
    ruleLines,
    ``,
    `)`,
    ``,
  ].join("\n");
}
