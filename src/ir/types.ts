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

export type PadShape =
  | { kind: "circle"; diameter: number }
  | { kind: "rect"; width: number; height: number }
  | { kind: "roundrect"; width: number; height: number; cornerRadius: number };

export interface Pad {
  number: string;
  at: Point; // absolute, nm
  rotation: number; // millionths of a degree
  shape: PadShape;
  drillDiameter: number; // nm; 0 = no hole (SMD)
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
  nets: Net[];
}
