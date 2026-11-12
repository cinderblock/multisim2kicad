/**
 * Ultiboard drawing primitives (UBPolygon, UBRectangle, UBRoundedRectangle,
 * UBPie, UBArc, UBEllipse) -> geometry in absolute nm, EW's Y-up frame.
 *
 * Conventions verified on corpus samples:
 * - Points live in `Object > Point`.
 * - UBPie / UBArc: points are [start, end, center] plus `Radius`; the sweep
 *   runs counter-clockwise (Y-up) from start to end; start == end is a full
 *   circle.
 * - UBRectangle / UBRoundedRectangle: the first 4 points are the corners in
 *   order (the rectangle may be rotated); a 5th point, when present, is an
 *   anchor and is ignored. UBRoundedRectangle adds `Radius`.
 */
import type { EwElement } from "./doc.ts";
import type { PadPrimitive, Point } from "../ir/types.ts";


export function points(item: EwElement | undefined): Point[] {
  return (item?.child("Object")?.childrenNamed("Point") ?? []).map((p) => ({ x: Number(p.get("X") ?? 0), y: Number(p.get("Y") ?? 0) }));
}

/** Max chord deviation when approximating arcs with straight segments. */
const ARC_TOLERANCE_NM = 5_000; // 5 um

function segmentsFor(radius: number, sweep: number): number {
  if (radius <= 0) return 1;
  const step = 2 * Math.acos(Math.max(-1, 1 - ARC_TOLERANCE_NM / radius));
  return Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3)));
}

/** CCW sweep from start to end around center; (0, 2pi], full circle when start == end. */
export function ccwSweep(center: Point, start: Point, end: Point): number {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  let s = a1 - a0;
  while (s <= 1e-12) s += 2 * Math.PI;
  return s;
}

/** Points along a CCW arc (inclusive of both ends). */
export function arcPoints(center: Point, radius: number, a0: number, sweep: number): Point[] {
  const n = segmentsFor(radius, sweep);
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return out;
}

/** Polygon for a rectangle given by 4 corners, with corners rounded by `r`. */
export function roundedPolygon(corners: Point[], r: number): Point[] {
  if (r <= 0) return corners;
  const out: Point[] = [];
  const n = corners.length;
  // Orientation (shoelace) decides which way the corner arcs turn.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = corners[i]!, b = corners[(i + 1) % n]!;
    area += a.x * b.y - b.x * a.y;
  }
  const ccw = area > 0;
  for (let i = 0; i < n; i++) {
    const prev = corners[(i + n - 1) % n]!, cur = corners[i]!, next = corners[(i + 1) % n]!;
    const u1 = unit(prev, cur), u2 = unit(cur, next);
    const len = Math.min(r, dist(prev, cur) / 2, dist(cur, next) / 2);
    // Corner centre: back off along both edges, then inward by r.
    const pIn = { x: cur.x - u1.x * len, y: cur.y - u1.y * len };
    const pOut = { x: cur.x + u2.x * len, y: cur.y + u2.y * len };
    const inward = ccw ? { x: -u1.y, y: u1.x } : { x: u1.y, y: -u1.x };
    const c = { x: pIn.x + inward.x * len, y: pIn.y + inward.y * len };
    const a0 = Math.atan2(pIn.y - c.y, pIn.x - c.x);
    const a1 = Math.atan2(pOut.y - c.y, pOut.x - c.x);
    let sweep = a1 - a0;
    if (ccw) while (sweep < 0) sweep += 2 * Math.PI;
    else while (sweep > 0) sweep -= 2 * Math.PI;
    out.push(...arcPoints(c, len, a0, sweep));
  }
  return out;
}

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
function unit(a: Point, b: Point): Point {
  const d = dist(a, b) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
}

/**
 * A UB primitive as filled/stroked geometry. Returns undefined for tags this
 * module doesn't know. Filled outlines come back as `poly`; UBArc as `arc`
 * (or `circle` when it closes on itself).
 */
export function ubPrimitive(tag: string, item: EwElement): PadPrimitive | undefined {
  const pts = points(item);
  const radius = Number(item.get("Radius") ?? 0);
  const width = Number(item.get("LineThickness") ?? 0);
  switch (tag) {
    case "UBPolygon":
      return pts.length >= 3 ? { kind: "poly", points: pts } : undefined;
    case "UBRectangle":
      return pts.length >= 4 ? { kind: "poly", points: pts.slice(0, 4) } : undefined;
    case "UBRoundedRectangle":
      return pts.length >= 4 ? { kind: "poly", points: roundedPolygon(pts.slice(0, 4), radius) } : undefined;
    case "UBPie": {
      if (pts.length < 3) return undefined;
      const [start, end, center] = pts as [Point, Point, Point];
      const r = radius || dist(center, start);
      const a0 = Math.atan2(start.y - center.y, start.x - center.x);
      const sweep = ccwSweep(center, start, end);
      if (sweep >= 2 * Math.PI - 1e-9) return { kind: "circle", center, radius: r, width: 0, fill: true };
      return { kind: "poly", points: [center, ...arcPoints(center, r, a0, sweep)] };
    }
    case "UBArc": {
      if (pts.length < 3) return undefined;
      const [start, end, center] = pts as [Point, Point, Point];
      const r = radius || dist(center, start);
      if (dist(start, end) < 1) return { kind: "circle", center, radius: r, width, fill: false };
      return { kind: "arc", center, start, end, width };
    }
    case "UBEllipse": {
      // Same convention as CDrawEllipse: first two points span a diameter.
      if (pts.length < 2) return undefined;
      const [p0, p1] = pts as [Point, Point];
      const center = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      return { kind: "circle", center, radius: dist(p0, p1) / 2, width, fill: true };
    }
  }
  return undefined;
}

export const UB_PRIMITIVE_TAGS = ["UBPolygon", "UBRectangle", "UBRoundedRectangle", "UBPie", "UBArc", "UBEllipse"];

/** Bounding box of a set of primitives. */
export function primitivesBBox(prims: PadPrimitive[]) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of prims) {
    if (p.kind === "poly") for (const q of p.points) { xs.push(q.x); ys.push(q.y); }
    else { const r = p.kind === "circle" ? p.radius + p.width / 2 : dist(p.center, p.start) + p.width / 2;
      xs.push(p.center.x - r, p.center.x + r); ys.push(p.center.y - r, p.center.y + r); }
  }
  return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) };
}
