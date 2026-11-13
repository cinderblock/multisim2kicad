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
  | { kind: "ellipse"; layer: number; thickness: number; points: Point[] }
  // CDrawArc: counter-clockwise (Y-up) from start to end around center.
  | { kind: "arc"; layer: number; thickness: number; start: Point; end: Point; center: Point };

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
  /**
   * Millionths of a degree, CCW. Pads and graphics are stored already placed
   * (absolute). Top: placed = origin + R(rotation) * local. Bottom: placed =
   * origin + R(-rotation) * mirrorX(local), from a corpus survey of parts
   * used on both sides (plans/converter.md, C6).
   */
  rotation: number;
  bottom: boolean;
  pads: Pad[];
  /** Silk / fab / courtyard / 3D outline graphics owned by the part, absolute. */
  graphics: Shape[];
  /** The part's text attributes that KiCad can show (REFDES, VALUE, visible labels). */
  texts: ComponentText[];
}

/** A component text attribute; `tag` is EW's attribute name (REFDES, VALUE, ...). */
export interface ComponentText extends BoardText {
  tag: string;
  visible: boolean;
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

/** Copper stack, top to bottom, as EW layer numbers (0, 1..2N-2, 63). */
export interface Stackup {
  copper: number[];
  thickness: number; // nm
}

/**
 * A copper pour: EW power plane (`UBPowerPlane`) or board-level copper area
 * (`UBPolygon`, `UBRectangle`, ...). EW stores the outline and fill rules,
 * never the computed fill.
 */
export interface Zone {
  kind: "plane" | "area";
  layer: number;
  netName: string;
  outline: Point[]; // absolute nm, closed implicitly
  clearance: number; // nm
  minThickness: number; // nm (EW LineThickness)
  reliefSpokeWidth: number; // nm
  thermalReliefStyle: number; // EW code (2 in every corpus board)
  removeIslands: boolean;
  islandArea: number; // nm^2 threshold for RemoveSmallIslands
  removeNotEdgeConnected: boolean;
}

/** Free text on the board (`UBAttribute Tag=TEXT`). */
export interface BoardText {
  layer: number;
  text: string;
  at: Point; // centre of the text box, absolute nm
  angle: number; // millionths of a degree, CCW
  mirror: boolean;
  width: number; // character width, nm
  height: number; // character height, nm
  strokeWidth: number; // nm
}

/**
 * An Ultiboard rule area (keep-in / keep-out). Semantics of `type` and the
 * net groups are not confirmed; masks are kept raw.
 */
export interface RuleArea {
  type: number;
  outline: Point[];
  /** ActiveLayersZero..Seven, bit i of word w = EW layer 64w + i. */
  activeLayers: bigint[];
  allNets: boolean;
  nets: string[];
}

export interface Board {
  source: Source;
  projectName: string;
  sheetTitle: string;
  workArea: { left: number; bottom: number; right: number; top: number };
  layers: EwLayer[];
  stackup: Stackup;
  zones: Zone[];
  texts: BoardText[];
  ruleAreas: RuleArea[];
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
  // Multisim connectivity (ID graph, per page). Items that touch in the
  // drawing are only connected in Multisim if they share a netId; the
  // emitter uses this to avoid geometric joins Multisim doesn't make.
  netId?: string;
  // Multisim connects something to this pin (false: dangling in the source).
  connected?: boolean;
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
  /**
   * Key for final-refdes lookup: drawn refdes + Multisim section name. The
   * final refdes depends on which hierarchy instance the sheet is in.
   */
  drawnKey?: string;
  /** Power port that Multisim doesn't connect to anything. */
  floating?: boolean;
}

// A wire as a polyline in sheet coords.
export interface SchematicWire {
  points: SchPoint[];
  netId?: string;
}

export interface SchematicLabel {
  name: string;
  at: SchPoint;            // sheet coords; on a wire or pin
  kind: "local" | "global" | "hierarchical";
  // Direction (sheet frame, Y-down) the label body extends from its anchor.
  dir: SchPoint;
  netId?: string;
  // Not connected to anything in Multisim (even if it touches something).
  floating?: boolean;
}

/**
 * A Multisim bus line. Drawing only: bus members connect by name, through
 * the labels placed at each bus entry's wire end.
 */
export interface SchematicBus {
  points: SchPoint[];
  name: string;            // Multisim's bus name (may be empty)
  members: string[];       // bus line names
}

/** A bus entry stub: `wire` is where the member's wire attaches, `bus` lies on the bus. */
export interface SchematicBusEntry {
  wire: SchPoint;
  bus: SchPoint;
  member: string;
}

export interface SchematicText {
  text: string;
  at: SchPoint;
  size: number;
}

/** A hierarchical block (sub-sheet instance) placed on a page. */
export interface SheetBlock {
  id: string;              // source object id, matches SchInstance.blockId
  childSheet: string;      // unique sheet title it instantiates
  a: SchPoint;             // rectangle corners, sheet coords
  b: SchPoint;
  pins: { name: string; at: SchPoint; attach?: SchPoint }[];
}

export interface SchematicSheet {
  name: string;
  title: string;           // unique sheet this page belongs to
  page: string;            // page name within that sheet
  blocks: SheetBlock[];
  size: { width: number; height: number }; // page size in units
  symbols: SchematicSymbol[];
  wires: SchematicWire[];
  labels: SchematicLabel[];
  texts: SchematicText[];
  buses: SchematicBus[];
  busEntries: SchematicBusEntry[];
}

/** One instantiation of a unique sheet in the design hierarchy. */
export interface SchInstance {
  sheet: string;           // unique sheet title
  name: string;            // final instance name ("" for the root)
  blockId?: string;        // SheetBlock.id on the parent page
  parentPage?: string;     // page of the parent sheet holding the block
  /** Final refdes by `${page}|${drawnKey}`; absent -> keep the drawn name. */
  refdes: Record<string, string>;
  /** Drawn -> final pin numbers by `${page}|${drawnKey}`. */
  pinRemaps: Record<string, Record<string, string>>;
  /** 1-based unit of a multi-section part by `${page}|${drawnKey}`. */
  units: Record<string, number>;
  children: SchInstance[];
}

export interface Schematic {
  source: Source;
  projectName: string;
  rootSheet: string;       // unique sheet title of the root
  sheets: SchematicSheet[]; // every page of every unique sheet
  root: SchInstance;
}
