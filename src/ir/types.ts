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

export interface Board {
  source: Source;
  projectName: string;
  sheetTitle: string;
  workArea: { left: number; bottom: number; right: number; top: number };
  layers: EwLayer[];
  shapes: Shape[];
  tracks: Track[];
}
