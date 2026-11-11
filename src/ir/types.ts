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

export interface SymbolPin {
  name: string;            // e.g. "IOVDD"; empty string -> "~" in KiCad
  number: string;          // e.g. "1"; Multisim's CSV ("1,10,22,33,42,49") is
                           // split — see parser.
  at: Point;               // connection point in symbol-local coords (nm)
}

// A schematic symbol placeholder: bounding box, identity, and pins.
// Rotation and OrientationFlip come in a later Phase-3 sub-chunk.
export interface SchematicSymbol {
  reference: string;       // e.g. "U2"
  value: string;           // e.g. "RP2040"
  at: Point;               // sheet position (nm)
  // Symbol-local bbox (nm), relative to `at`. The local frame matches what
  // KiCad's lib_symbol uses for rectangles/pins inside the symbol body.
  bbox: { x0: number; y0: number; x1: number; y1: number };
  pins: SymbolPin[];
}

// A schematic wire segment in sheet coords (nm). Multi-point lines from
// CODMultiLineComp are exploded into per-segment Wire entries on parse.
export interface SchematicWire {
  from: Point;
  to: Point;
}

// Multisim schematic IR. Labels + Ci* netlist cross-check come in later
// Phase-3 chunks.
export interface Schematic {
  source: Source;
  projectName: string;
  sheetTitle: string;
  workArea: { left: number; bottom: number; right: number; top: number };
  symbols: SchematicSymbol[];
  wires: SchematicWire[];
}
