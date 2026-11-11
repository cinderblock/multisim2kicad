export interface Source {
  application: string;
  versionMajor: number;
  versionMinor: number;
  schema: number;
}

export interface EwLayer {
  number: number;
  name: string;
  description?: string;
  state: number;
  rgb: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Shape =
  | { kind: "polyline"; layer: number; thickness: number; points: Point[] }
  | { kind: "rectangle"; layer: number; thickness: number; points: Point[] }
  | { kind: "roundRect"; layer: number; thickness: number; points: Point[]; radius: number }
  | { kind: "ellipse"; layer: number; thickness: number; points: Point[] };

export interface Track {
  layer: number;
  thickness: number;
  start: Point;
  end: Point;
}

// A filled region or stroke making up part of a custom pad (absolute nm).
export type PadPrimitive =
  | { kind: "poly"; points: Point[] }
  | { kind: "arc"; center: Point; start: Point; end: Point; width: number } // CCW start -> end
  | { kind: "circle"; center: Point; radius: number; width: number; fill: boolean };

// width/height are in the pad's own frame, before `rotation` is applied.
export type PadShape =
  | { kind: "circle"; diameter: number }
  | { kind: "rect"; width: number; height: number }
  | { kind: "roundrect"; width: number; height: number; cornerRadius: number }
  | { kind: "custom"; primitives: PadPrimitive[] };

export interface Pad {
  number: string;
  at: Point; // absolute, nm
  rotation: number; // millionths of a degree, CCW in EW's Y-up frame
  shape: PadShape;
  drillDiameter: number; // nm; 0 = no hole (SMD)
  // Copper side for SMD pads; "both" for through-hole.
  side: "both" | "top" | "bottom";
}

export interface Component {
  reference: string;
  value: string;
  name: string;
  origin: Point; // RefPoint, absolute nm — becomes the footprint anchor
  rotation: number; // millionths of a degree (metadata; pads are stored pre-placed)
  bottom: boolean;
  pads: Pad[];
}

// A via (EW RegularVia): plated drill + round copper ring through the board.
export interface Via {
  at: Point; // absolute, nm
  drillDiameter: number; // nm
  diameter: number; // copper ring outer diameter, nm
  netName?: string; // EW's own NetName, when set
}

// A standalone drill (Stand-Alone="1"): plated -> via, non-plated -> mounting hole.
export interface Hole {
  at: Point; // absolute, nm
  drillDiameter: number; // nm
  plated: boolean;
}

export interface NetPinRef {
  refdes: string;
  pin: string;
}

export interface Net {
  name: string;
  pins: NetPinRef[];
}

export interface Board {
  source: Source;
  projectName: string;
  sheetTitle: string;
  workArea: { left: number; bottom: number; right: number; top: number };
  layers: EwLayer[];
  shapes: Shape[];
  tracks: Track[];
  components: Component[];
  holes: Hole[];
  vias: Via[];
  nets: Net[];
}

// ---------------------------------------------------------------------------
// Schematic IR. Coordinates are Multisim schematic units (integers in every
// corpus sample; nominally 0.25 mm), Y-down, origin at the page's top-left.
// The emitter picks the physical scale (see plans/converter.md decisions).

export interface SchPoint {
  x: number;
  y: number;
}

/**
 * A dihedral transform as a 2x2 integer matrix: p' = (a*x + c*y, b*x + d*y).
 * Maps symbol-local coordinates (Y-down) onto the sheet, before translation.
 */
export interface Dihedral {
  a: number;
  b: number;
  c: number;
  d: number;
}

export type SchGraphic =
  | { kind: "polyline"; points: SchPoint[]; width: number; fill: boolean }
  | { kind: "rect"; a: SchPoint; b: SchPoint; width: number; fill: boolean }
  | { kind: "circle"; center: SchPoint; radius: number; width: number; fill: boolean }
  | { kind: "arc"; start: SchPoint; mid: SchPoint; end: SchPoint; width: number }
  | { kind: "text"; at: SchPoint; text: string; size: number };

export interface SymbolPin {
  name: string;            // e.g. "IOVDD"; empty -> "~" in KiCad
  number: string;          // one physical pin number (CSV aggregates are split)
  at: SchPoint;            // connection point, symbol-local frame
  // Unit vector from the connection point toward the symbol body, and the
  // drawn pin length (0 when the source has no pin line).
  dir: SchPoint;
  length: number;
  // Where Multisim's wiring actually attaches (sheet coords), when it differs
  // from the transformed pin position. The emitter bridges the gap.
  attach?: SchPoint;
}

export interface SymbolText {
  text: string;
  at: SchPoint;            // symbol-local frame
  hidden: boolean;
}

/** A placed part (or power port), in its own local frame plus a placement. */
export interface SchematicSymbol {
  reference: string;       // e.g. "U2"
  value: string;           // e.g. "RP2040"
  kind: "part" | "power";
  at: SchPoint;            // sheet position of the local origin
  transform: Dihedral;     // local -> sheet orientation
  graphics: SchGraphic[];  // body graphics, local frame
  pins: SymbolPin[];
  refText?: SymbolText;
  valueText?: SymbolText;
  showPinNames: boolean;
  showPinNumbers: boolean;
}

// A wire as a polyline in sheet coords.
export interface SchematicWire {
  points: SchPoint[];
}

export interface SchematicLabel {
  name: string;
  at: SchPoint;            // sheet coords; on a wire or pin
  kind: "local" | "global";
  // Direction (sheet frame, Y-down) the label body extends from its anchor.
  dir: SchPoint;
}

export interface SchematicText {
  text: string;
  at: SchPoint;
  size: number;
}

export interface SchematicSheet {
  name: string;
  size: { width: number; height: number }; // page size in units
  symbols: SchematicSymbol[];
  wires: SchematicWire[];
  labels: SchematicLabel[];
  texts: SchematicText[];
}

// Multisim schematic IR. Hierarchy (more than one sheet) arrives with D1.
export interface Schematic {
  source: Source;
  projectName: string;
  sheets: SchematicSheet[];
}
