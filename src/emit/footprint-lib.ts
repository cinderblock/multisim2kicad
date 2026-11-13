/**
 * Project-local footprint library (phase E3): one `.kicad_mod` per EW
 * footprint, drawn the way a library has it: unrotated, top side.
 *
 * Ultiboard stores every part already placed. A placed part is turned back
 * into its library drawing with the C6 placement rules (see Component in
 * ir/types.ts): top = origin + R(rot) * local, bottom = origin + R(-rot) *
 * mirrorX(local).
 *
 * Ultiboard rounds each placed copy to the nanometre after rotating it, so
 * two copies of one footprint can differ by a nanometre once un-rotated,
 * and KiCad compares footprints with their library copy exactly (DRC
 * lib_footprint_mismatch). So the library drawing is taken once per name
 * (rounded to whole nanometres) and every copy that agrees with it to within
 * a few nanometres is placed from it. Copies that really differ (edited on
 * the board) keep their own geometry and show up as mismatches, as they
 * should.
 */
import type { Board, Component, ComponentText, Pad, PadPrimitive, Point, Shape } from "../ir/types.ts";
import { emitFootprintFor, footprintName, mountingHoleFootprint, mountingHoleName } from "./kicad-pcb.ts";
import { LayerMap, TOP_TWIN } from "./pcb-layers.ts";

const KICAD_MOD_VERSION = 20240108;
/** Copies within this many nm of the library drawing are placed from it. */
const SAME_NM = 10;
const QUARTER_TURNS = [0, 180, 90, 270];

const deg = (millionths: number) => millionths / 1_000_000;
const toMillionths = (d: number) => Math.round((((d % 360) + 360) % 360) * 1_000_000);
const BOTTOM_TWIN: Record<number, number> = Object.fromEntries(Object.entries(TOP_TWIN).map(([b, t]) => [t, Number(b)]));

/** A geometry mapping applied to every part of a component. */
interface Mapping {
  point(p: Point): Point;
  angle(a: number): number;
  layer(l: number): number;
  side(s: Pad["side"]): Pad["side"];
  mirrors: boolean;
  /** Text reads mirrored (bottom side); library drawings are top-side. */
  textMirror: boolean;
}

/** Placed part -> library frame (origin 0, unrotated, top side), rounded to nm. */
function toLibrary(c: Component): Mapping {
  const r = (deg(c.rotation) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    // l = R(-r)(b - o) on the top; l = mirrorX(R(r)(b - o)) on the bottom.
    point: (p) => {
      const dx = p.x - c.origin.x;
      const dy = p.y - c.origin.y;
      const l = c.bottom ? { x: -(dx * cos - dy * sin), y: dx * sin + dy * cos } : { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
      return { x: Math.round(l.x), y: Math.round(l.y) };
    },
    // Angles (CCW): top a - rot; bottom 180 - a - rot.
    angle: (a) => toMillionths(c.bottom ? 180 - deg(a) - deg(c.rotation) : deg(a) - deg(c.rotation)),
    layer: (l) => (c.bottom ? TOP_TWIN[l] ?? l : l),
    side: (s) => (s === "both" ? "both" : "top"),
    mirrors: c.bottom,
    textMirror: false,
  };
}

/** Library frame -> placed like `c` (the inverse of toLibrary). */
function toPlaced(c: Component): Mapping {
  const r = (deg(c.rotation) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    // b = o + R(r) l on the top; b = o + R(-r) mirrorX(l) on the bottom.
    point: (l) =>
      c.bottom
        ? { x: c.origin.x - l.x * cos + l.y * sin, y: c.origin.y + l.x * sin + l.y * cos }
        : { x: c.origin.x + l.x * cos - l.y * sin, y: c.origin.y + l.x * sin + l.y * cos },
    angle: (a) => toMillionths(c.bottom ? 180 - deg(a) - deg(c.rotation) : deg(a) + deg(c.rotation)),
    layer: (l) => (c.bottom ? BOTTOM_TWIN[l] ?? l : l),
    side: (s) => (s === "both" ? "both" : c.bottom ? "bottom" : "top"),
    mirrors: c.bottom,
    textMirror: c.bottom,
  };
}

function shape(s: Shape, m: Mapping): Shape {
  const layer = m.layer(s.layer);
  if (s.kind === "arc") {
    // A mirror reverses the sweep: swap the ends to stay counter-clockwise.
    const [start, end] = m.mirrors ? [s.end, s.start] : [s.start, s.end];
    return { ...s, layer, start: m.point(start), end: m.point(end), center: m.point(s.center) };
  }
  return { ...s, layer, points: s.points.map(m.point) };
}

function primitive(p: PadPrimitive, m: Mapping): PadPrimitive {
  switch (p.kind) {
    case "poly":
      return { ...p, points: p.points.map(m.point) };
    case "circle":
      return { ...p, center: m.point(p.center) };
    case "arc": {
      const [start, end] = m.mirrors ? [p.end, p.start] : [p.start, p.end];
      return { ...p, center: m.point(p.center), start: m.point(start), end: m.point(end) };
    }
  }
}

function pad(p: Pad, m: Mapping): Pad {
  return {
    ...p,
    at: m.point(p.at),
    rotation: m.angle(p.rotation),
    side: m.side(p.side),
    shape: p.shape.kind === "custom" ? { kind: "custom", primitives: p.shape.primitives.map((x) => primitive(x, m)) } : p.shape,
  };
}

function text(t: ComponentText, m: Mapping): ComponentText {
  return { ...t, layer: m.layer(t.layer), at: m.point(t.at), angle: m.angle(t.angle), mirror: m.textMirror };
}

function mapComponent(c: Component, m: Mapping): Pick<Component, "pads" | "graphics" | "texts"> {
  return { pads: c.pads.map((p) => pad(p, m)), graphics: c.graphics.map((s) => shape(s, m)), texts: c.texts.map((t) => text(t, m)) };
}

/** The part as its library drawing: origin (0, 0), unrotated, top side. */
export function libraryComponent(c: Component): Component {
  return {
    ...c,
    ...mapComponent(c, toLibrary(c)),
    reference: "REF**",
    value: footprintName(c),
    origin: { x: 0, y: 0 },
    rotation: 0,
    bottom: false,
  };
}

/**
 * A drawing as a sorted list of items, each a label plus its coordinates.
 * Ultiboard's copies of one footprint may list items in a different order
 * and draw a line either way round, so both are normalised away.
 */
function signature(c: Component): { label: string; nums: number[] }[] {
  const items: { label: string; nums: number[] }[] = [];
  const flat = (ps: Point[]) => ps.flatMap((p) => [p.x, p.y]);
  /** A path drawn either way round: keep the lexicographically smaller. */
  const undirected = (ps: Point[]) => {
    const f = flat(ps);
    const r = flat([...ps].reverse());
    for (let i = 0; i < f.length; i++) if (f[i] !== r[i]) return f[i]! < r[i]! ? f : r;
    return f;
  };
  for (const p of c.pads) {
    const extra = p.shape.kind === "custom" ? p.shape.primitives.flatMap((x) => flat(x.kind === "poly" ? x.points : x.kind === "arc" ? [x.center, x.start, x.end] : [x.center])) : [];
    items.push({ label: `pad ${p.number} ${p.shape.kind} ${p.side} ${p.drillDiameter}`, nums: [...flat([p.at]), ...extra] });
  }
  for (const g of c.graphics) {
    items.push({ label: `${g.kind} ${g.layer}`, nums: g.kind === "arc" ? flat([g.start, g.end, g.center]) : g.kind === "polyline" ? undirected(g.points) : flat(g.points) });
  }
  for (const t of c.texts.filter((x) => x.tag !== "REFDES" && x.tag !== "VALUE")) items.push({ label: `text ${t.tag} ${t.text}`, nums: flat([t.at]) });
  const key = (i: { label: string; nums: number[] }) => `${i.label}|${i.nums.map((v) => Math.round(v / 1000)).join(",")}`;
  return items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function sameDrawing(a: Component, b: Component): boolean {
  const x = signature(a);
  const y = signature(b);
  return (
    x.length === y.length &&
    x.every((it, i) => {
      const o = y[i]!;
      return it.label === o.label && it.nums.length === o.nums.length && it.nums.every((v, k) => Math.abs(v - o.nums[k]!) <= SAME_NM);
    })
  );
}

/**
 * The board's footprint library, and the board with every copy placed from
 * its library drawing. Copies are taken top-side first. A copy matching an
 * existing drawing of its name (at some quarter-turn: pad 1 may sit at the
 * other end of a 2-pin part) is placed from it; one that matches none (a
 * silkscreen mark moved on that copy, say) becomes a variant `<name>_2`, ...
 * so every board footprint is exactly its library entry.
 */
export function harmonizeFootprints(board: Board): { board: Board; library: Map<string, Component> } {
  const library = new Map<string, Component>();
  const variants = new Map<string, string[]>(); // EW name -> library names
  const order = board.components.map((c, i) => i).sort((a, b) => Number(board.components[a]!.bottom) - Number(board.components[b]!.bottom));
  const components: Component[] = [...board.components];
  for (const i of order) {
    const c = board.components[i]!;
    const base = footprintName(c);
    const names = variants.get(base) ?? [];
    let match: { name: string; turned: Component } | undefined;
    for (const name of names) {
      const lib = library.get(name)!;
      const turned = QUARTER_TURNS.map((d) => ({ ...c, rotation: toMillionths(deg(c.rotation) + d) })).find((t) =>
        sameDrawing(libraryComponent(t), lib),
      );
      if (turned) {
        match = { name, turned };
        break;
      }
    }
    if (!match) {
      const name = names.length === 0 ? base : `${base}_${names.length + 1}`;
      names.push(name);
      variants.set(base, names);
      library.set(name, { ...libraryComponent(c), name, value: name });
      match = { name, turned: c };
    }
    const lib = library.get(match.name)!;
    const placed = mapComponent(lib, toPlaced(match.turned));
    // Reference / value placement is per copy; everything else is the library's.
    const fields = c.texts.filter((t) => t.tag === "REFDES" || t.tag === "VALUE");
    components[i] = {
      ...match.turned,
      name: match.name,
      pads: placed.pads,
      graphics: placed.graphics,
      texts: [...fields, ...placed.texts.filter((t) => t.tag !== "REFDES" && t.tag !== "VALUE")],
    };
  }
  return { board: { ...board, components }, library };
}

/** A board-style footprint block as a `.kicad_mod` file. */
const asLibraryFile = (body: string, name: string) =>
  body.replace(/^\t\(footprint [^\n]*\n/, `(footprint ${JSON.stringify(name)}\n\t(version ${KICAD_MOD_VERSION})\n\t(generator "ew-conv")\n`);

/** `<name>.kicad_mod` files for a harmonized board's library. */
export function emitFootprintLibrary(board: Board, library: ReadonlyMap<string, Component>): Map<string, string> {
  const lm = new LayerMap(board); // same layer mapping as the board file
  const out = new Map<string, string>();
  for (const [name, c] of library) {
    const body = emitFootprintFor(c, lm, { library: true });
    out.set(`${name}.kicad_mod`, asLibraryFile(body, name));
  }
  for (const h of board.holes.filter((x) => !x.plated)) {
    const name = mountingHoleName(h.drillDiameter);
    if (!out.has(`${name}.kicad_mod`)) out.set(`${name}.kicad_mod`, asLibraryFile(mountingHoleFootprint(h.drillDiameter, ""), name));
  }
  return out;
}
