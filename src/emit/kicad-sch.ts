import type {
  Dihedral,
  SchInstance,
  SheetBlock,
  Schematic,
  SchematicBus,
  SchematicBusEntry,
  SchematicLabel,
  SchematicSheet,
  SchematicSymbol,
  SchGraphic,
  SchPoint,
  SymbolPin,
  SymbolText,
} from "../ir/types.ts";

// KiCad 9/10 schematic format (KiCad 10 reads it natively).
const KICAD_SCH_VERSION = 20250610;
const KICAD_SYM_VERSION = 20250610;

/**
 * One Multisim schematic unit in mm. Multisim's nominal unit is 0.25 mm; we
 * use 10 mil (0.254 mm) so every integer coordinate is on a KiCad grid, and
 * set the project's connection grid to match (decision 2026-11-11).
 */
export const MM_PER_UNIT = 0.254;
const u = (v: number): string => (v * MM_PER_UNIT).toFixed(4).replace(/\.?0+$/, "") || "0";

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, "\\n")}"`;
}

function uuid(): string {
  return crypto.randomUUID();
}

const FONT = "(effects (font (size 1.27 1.27)))";

// ---------------------------------------------------------------------------
// Orientation: Multisim dihedral -> KiCad (angle, mirror). Measured with
// kicad-cli on KiCad 10 (rotation applies first, then the mirror); a symbol's
// lib point (x, y) lands at at + K(x, -y).
const KICAD_ORIENT: [Dihedral, number, "" | "x"][] = [
  [{ a: 1, b: 0, c: 0, d: 1 }, 0, ""],
  [{ a: 0, b: -1, c: 1, d: 0 }, 90, ""],
  [{ a: -1, b: 0, c: 0, d: -1 }, 180, ""],
  [{ a: 0, b: 1, c: -1, d: 0 }, 270, ""],
  [{ a: 1, b: 0, c: 0, d: -1 }, 0, "x"],
  [{ a: 0, b: 1, c: 1, d: 0 }, 90, "x"],
  [{ a: -1, b: 0, c: 0, d: 1 }, 180, "x"],
  [{ a: 0, b: -1, c: -1, d: 0 }, 270, "x"],
];

function kicadOrient(t: Dihedral): { angle: number; mirror: "" | "x" } {
  const hit = KICAD_ORIENT.find(([m]) => m.a === t.a && m.b === t.b && m.c === t.c && m.d === t.d);
  if (!hit) throw new Error(`not a dihedral transform: ${JSON.stringify(t)}`);
  return { angle: hit[1], mirror: hit[2] };
}

const applyD = (t: Dihedral, p: SchPoint): SchPoint => ({ x: t.a * p.x + t.c * p.y, y: t.b * p.x + t.d * p.y });
const add = (a: SchPoint, b: SchPoint): SchPoint => ({ x: a.x + b.x, y: a.y + b.y });
const sheetPinPos = (s: SchematicSymbol, p: SymbolPin): SchPoint => add(s.at, applyD(s.transform, p.at));

// ---------------------------------------------------------------------------
// Library symbols (one per placed symbol for now; dedupe is Phase D4)

// Lib space is Y-up: local (x, y) -> lib (x, -y).
const lib = (p: SchPoint) => `${u(p.x)} ${u(-p.y)}`;
const stroke = (w: number) => `(stroke (width ${w > 1 ? u(w * 0.5) : "0"}) (type default))`;
const fill = (f: boolean) => `(fill (type ${f ? "outline" : "none"}))`;

function libGraphic(g: SchGraphic): string | undefined {
  switch (g.kind) {
    case "polyline":
      return `\t\t\t\t(polyline (pts ${g.points.map((p) => `(xy ${lib(p)})`).join(" ")}) ${stroke(g.width)} ${fill(g.fill)})`;
    case "rect":
      return `\t\t\t\t(rectangle (start ${lib(g.a)}) (end ${lib(g.b)}) ${stroke(g.width)} ${fill(g.fill)})`;
    case "circle":
      return `\t\t\t\t(circle (center ${lib(g.center)}) (radius ${u(g.radius)}) ${stroke(g.width)} ${fill(g.fill)})`;
    case "arc":
      return `\t\t\t\t(arc (start ${lib(g.start)}) (mid ${lib(g.mid)}) (end ${lib(g.end)}) ${stroke(g.width)} ${fill(false)})`;
    case "text":
      return `\t\t\t\t(text ${q(g.text)} (at ${lib(g.at)} 0) (effects (font (size ${u(g.size)} ${u(g.size)})) (justify left top)))`;
  }
}

/** KiCad pin angle (lib frame, degrees) for a local-frame direction toward the body. */
function pinAngle(dir: SchPoint): number {
  if (dir.x === 0 && dir.y === 0) return 0;
  const a = (Math.atan2(-dir.y, dir.x) * 180) / Math.PI;
  return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
}

// KiCad rejects duplicate pin numbers when (duplicate_pin_numbers_are_jumpers
// no); keep the first.
function uniquePins(pins: SymbolPin[]): SymbolPin[] {
  const seen = new Set<string>();
  return pins.filter((p) => p.number && !seen.has(p.number) && seen.add(p.number));
}

/** A pin drawn as plain lines (its stem), for pins that must not be KiCad pins. */
const pinStem = (p: SymbolPin): SchGraphic => ({
  kind: "polyline",
  points: [p.at, { x: p.at.x + p.dir.x * p.length, y: p.at.y + p.dir.y * p.length }],
  width: 0,
  fill: false,
});

/**
 * One library symbol, shared by every placed symbol drawn the same way.
 * `head` + `body` (the drawing) must match exactly to share; each unit's
 * pins (renumbered per section, shared pins dropped) must agree per unit.
 */
interface LibEntry {
  name: string;
  key: string;
  value: string;
  head: string[];
  body: string[];
  units: Map<number, string[]>;
  footprint?: string;
  /** Extra properties (hidden), e.g. Description, Manufacturer. */
  fields?: [string, string][];
  /** Where Reference / Value sit (local units); default the origin. */
  refAt?: SchPoint;
  valueAt?: SchPoint;
}

const libLines = (gs: SchGraphic[]) => gs.map(libGraphic).filter((x): x is string => !!x);

function libParts(s: SchematicSymbol, refs: InstanceRef[], dropped: ReadonlySet<string>): Omit<LibEntry, "name" | "key"> {
  const pins = uniquePins(s.pins).filter((p) => !dropped.has(p.number));
  const power = s.kind === "power";
  const pinLine = (p: SymbolPin, number: string) => {
    const type = power ? "power_in" : (p.electrical ?? "passive");
    // Power ports: KiCad hides their pin, so the stem is drawn as graphics.
    const length = power ? 0 : p.length;
    return `\t\t\t\t(pin ${type} line (at ${lib(p.at)} ${pinAngle(p.dir)}) (length ${u(length)})${power ? " (hide yes)" : ""} (name ${q(p.name || "~")} ${FONT}) (number ${q(number)} ${FONT}))`;
  };
  const stems = (keep: (p: SymbolPin) => boolean) => libLines(s.pins.filter((p) => p.length > 0 && keep(p)).map(pinStem));
  const head = [
    power ? `\t\t\t(power global)` : "",
    `\t\t\t(pin_numbers${s.showPinNumbers && !power ? "" : " (hide yes)"})`,
    `\t\t\t(pin_names (offset 0.254)${s.showPinNames && !power ? "" : " (hide yes)"})`,
    `\t\t\t(exclude_from_sim no)`,
    `\t\t\t(in_bom ${power ? "no" : "yes"})`,
    `\t\t\t(on_board ${power ? "no" : "yes"})`,
    `\t\t\t(duplicate_pin_numbers_are_jumpers no)`,
    `\t\t\t(property "Reference" ${q(power ? "#PWR" : refPrefix(s))} (at 0 0 0) ${FONT})`,
  ].filter(Boolean);
  // One body per unit: the same drawing, pins renumbered for that section.
  // Shared pins kept on another section are drawn as plain stems here.
  const units = new Map<number, string[]>();
  const drawing = [...libLines(s.graphics), ...stems((p) => power || dropped.has(p.number))];
  for (const [unit, map] of unitsOf(refs)) units.set(unit, [...drawing, ...pins.map((p) => pinLine(p, map?.[p.number] ?? p.number))]);
  return { value: s.value, head, body: [], units };
}

/**
 * Move a symbol's local origin to the centre of its pins (of its drawing,
 * when it has no pins), rounded to the grid, and shift its placement to
 * match. Multisim's local frames carry arbitrary offsets, so the same part
 * drawn twice would otherwise be two library symbols; KiCad also expects
 * the origin near the body. Pins stay on grid (integer units).
 */
function centreSymbol(s: SchematicSymbol): SchematicSymbol {
  const pts = s.pins.length ? s.pins.map((p) => p.at) : s.graphics.flatMap(graphicPoints);
  if (!pts.length) return s;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const o = { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };
  if (o.x === 0 && o.y === 0) return s;
  const m = (p: SchPoint): SchPoint => ({ x: p.x - o.x, y: p.y - o.y });
  const text = (t?: SymbolText) => t && { ...t, at: m(t.at) };
  return {
    ...s,
    at: add(s.at, applyD(s.transform, o)),
    graphics: s.graphics.map((g) => mapGraphic(g, m)),
    pins: s.pins.map((p) => ({ ...p, at: m(p.at) })),
    refText: text(s.refText),
    valueText: text(s.valueText),
  };
}

const IDENTITY_D: Dihedral = { a: 1, b: 0, c: 0, d: 1 };
/** t after h: p -> t(h(p)). */
const composeD = (t: Dihedral, h: Dihedral): Dihedral => ({
  a: t.a * h.a + t.c * h.b,
  b: t.b * h.a + t.d * h.b,
  c: t.a * h.c + t.c * h.d,
  d: t.b * h.c + t.d * h.d,
});
const transposeD = (g: Dihedral): Dihedral => ({ a: g.a, b: g.c, c: g.b, d: g.d });

/** The same placed symbol with its drawing turned by `g` (placement unchanged on the sheet). */
function reorient(s: SchematicSymbol, g: Dihedral): SchematicSymbol {
  if (g.a === 1 && g.d === 1 && !g.b && !g.c) return s;
  const m = (p: SchPoint) => applyD(g, p);
  const text = (t?: SymbolText) => t && { ...t, at: m(t.at) };
  return {
    ...s,
    transform: composeD(s.transform, transposeD(g)),
    graphics: s.graphics.map((x) => mapGraphic(x, m)),
    pins: s.pins.map((p) => ({ ...p, at: m(p.at), dir: m(p.dir) })),
    refText: text(s.refText),
    valueText: text(s.valueText),
  };
}

function mapGraphic(g: SchGraphic, m: (p: SchPoint) => SchPoint): SchGraphic {
  switch (g.kind) {
    case "polyline":
      return { ...g, points: g.points.map(m) };
    case "rect":
      return { ...g, a: m(g.a), b: m(g.b) };
    case "circle":
      return { ...g, center: m(g.center) };
    case "arc":
      return { ...g, start: m(g.start), mid: m(g.mid), end: m(g.end) };
    case "text":
      return { ...g, at: m(g.at) };
  }
}

function graphicPoints(g: SchGraphic): SchPoint[] {
  switch (g.kind) {
    case "polyline":
      return g.points;
    case "rect":
      return [g.a, g.b];
    case "circle":
      return [g.center];
    case "arc":
      return [g.start, g.mid, g.end];
    case "text":
      return [g.at];
  }
}

/** Reference prefix: the letters before the number (U8I2C -> U). */
const refPrefix = (s: SchematicSymbol) => /^[A-Za-z_]*/.exec(s.reference)![0] || "U";

/** A library symbol as text, at `indent` (schematic `lib_symbols`: 2 tabs; `.kicad_sym`: 1). */
function renderLibSymbol(e: LibEntry, fullName: string, indent: 1 | 2): string {
  const at = (p?: SchPoint) => `(at ${p ? lib(p) : "0 0"} 0)`;
  const lines = [
    `\t\t(symbol ${q(fullName)}`,
    ...e.head.map((l) => (e.refAt && l.includes(`(property "Reference"`) ? l.replace("(at 0 0 0)", at(e.refAt)) : l)),
    `\t\t\t(property "Value" ${q(e.value)} ${at(e.valueAt)} ${FONT})`,
    `\t\t\t(property "Footprint" ${q(e.footprint ?? "")} (at 0 0 0) (hide yes) ${FONT})`,
    `\t\t\t(property "Datasheet" "" (at 0 0 0) (hide yes) ${FONT})`,
    ...(e.fields ?? []).map(([k, v]) => `\t\t\t(property ${q(k)} ${q(v)} (at 0 0 0) (hide yes) ${FONT})`),
    ...(e.body.length ? [`\t\t\t(symbol ${q(`${e.name}_0_1`)}`, ...e.body, `\t\t\t)`] : []),
    ...[...e.units].sort((a, b) => a[0] - b[0]).flatMap(([unit, pins]) => [`\t\t\t(symbol ${q(`${e.name}_${unit}_1`)}`, ...pins, `\t\t\t)`]),
    `\t\t\t(embedded_fonts no)`,
    `\t\t)`,
  ];
  return indent === 2 ? lines.join("\n") : lines.map((l) => l.slice(1)).join("\n");
}

/** A library symbol described directly (EW database parts), not from placements. */
export interface LibrarySymbolSpec {
  name: string;
  /** Reference prefix ("U"). */
  reference: string;
  value: string;
  footprint?: string;
  fields?: [string, string][];
  showPinNames: boolean;
  showPinNumbers: boolean;
  /** Unit 1..n: its drawing, its pins, and pins drawn as plain stems (kept on another unit). */
  units: { graphics: SchGraphic[]; pins: SymbolPin[]; stems?: SymbolPin[] }[];
}

/** A `.kicad_sym` file of directly described symbols; each unit centred on its pins. */
export function librarySymbolsFile(specs: LibrarySymbolSpec[]): string {
  const entries = specs.map((spec): LibEntry => {
    const units = new Map<number, string[]>();
    let head: string[] = [];
    let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
    spec.units.forEach((unit, i) => {
      const stems = unit.stems ?? [];
      const centred = centreSymbol({
        reference: spec.reference, value: spec.value, kind: "part", at: { x: 0, y: 0 }, transform: IDENTITY_D,
        graphics: [...unit.graphics, ...stems.filter((p) => p.length > 0).map(pinStem)],
        pins: unit.pins, showPinNames: spec.showPinNames, showPinNumbers: spec.showPinNumbers,
      });
      if (i === 0) {
        const pts = [...centred.graphics.flatMap(graphicPoints), ...centred.pins.map((p) => p.at)];
        if (pts.length) box = { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) };
      }
      const parts = libParts(centred, [{ path: "", reference: spec.reference, unit: i + 1 }], new Set());
      head = parts.head;
      for (const [u, lines] of parts.units) units.set(u, lines);
    });
    // Reference above the first unit, Value below it (text is 5 units tall).
    const cx = box ? Math.round((box.x0 + box.x1) / 2) : 0;
    return {
      name: spec.name, key: spec.name, value: spec.value, head, body: [], units, footprint: spec.footprint, fields: spec.fields,
      refAt: box && { x: cx, y: box.y0 - 4 },
      valueAt: box && { x: cx, y: box.y1 + 4 },
    };
  });
  return libraryFileText(entries);
}

const libraryFileText = (entries: LibEntry[]) =>
  [
    `(kicad_symbol_lib`,
    `\t(version ${KICAD_SYM_VERSION})`,
    `\t(generator "multisim2kicad")`,
    `\t(generator_version "0.1")`,
    ...[...entries].sort((a, b) => a.name.localeCompare(b.name)).map((e) => renderLibSymbol(e, e.name, 1)),
    `)`,
    ``,
  ].join("\n");

/** The symbol library: identical drawings share one entry; unit sets merge. */
class SymbolLibrary {
  readonly entries: LibEntry[] = [];
  private readonly names = new Set<string>();

  /**
   * The library entry for a placed symbol, and the symbol as placed from it.
   * Multisim bakes some rotations into a part's drawing, so a symbol that
   * matches an entry turned or mirrored is placed from that entry with the
   * difference moved into its placement.
   */
  add(s: SchematicSymbol, refs: InstanceRef[], dropped: ReadonlySet<string>): { entry: LibEntry; symbol: SchematicSymbol } {
    const base = (s.kind === "power" ? `PWR_${s.value}` : s.partName || refPrefix(s)).replace(/[^A-Za-z0-9_.+-]+/g, "_") || "U";
    // Power symbols name their net through Value, so the value is part of them.
    const keyOf = (parts: ReturnType<typeof libParts>) => JSON.stringify([base, parts.head, parts.body, s.kind === "power" ? s.value : ""]);
    const fits = (e: LibEntry, key: string, parts: ReturnType<typeof libParts>) =>
      e.key === key && [...parts.units].every(([u, pins]) => !e.units.has(u) || e.units.get(u)!.join("\n") === pins.join("\n"));
    // Text in a drawing would turn with it, so only plain drawings are re-oriented.
    const turns = s.graphics.some((g) => g.kind === "text") ? [IDENTITY_D] : KICAD_ORIENT.map(([m]) => m);
    for (const g of turns) {
      // Re-centred after turning: an odd span rounds its centre per orientation.
      const t = centreSymbol(reorient(s, g));
      const parts = libParts(t, refs, dropped);
      const key = keyOf(parts);
      const found = this.entries.find((e) => fits(e, key, parts));
      if (found) {
        for (const [u, pins] of parts.units) if (!found.units.has(u)) found.units.set(u, pins);
        return { entry: found, symbol: t };
      }
    }
    const parts = libParts(s, refs, dropped);
    const key = keyOf(parts);
    let name = base;
    for (let n = 2; this.names.has(name.toLowerCase()); n++) name = `${base}_${n}`;
    this.names.add(name.toLowerCase());
    const e: LibEntry = { ...parts, name, key };
    this.entries.push(e);
    return { entry: e, symbol: s };
  }

  /** `.kicad_sym` file text. */
  file(): string {
    return libraryFileText(this.entries);
  }
}

// ---------------------------------------------------------------------------
// Instances

function property(name: string, value: string, at: SchPoint, hide: boolean): string {
  return `\t\t(property ${q(name)} ${q(value)} (at ${u(at.x)} ${u(at.y)} 0)${hide ? " (hide yes)" : ""} (effects (font (size 1.27 1.27)) (justify left)))`;
}

interface InstanceRef {
  path: string;
  reference: string;
  unit: number;
  /** Drawn -> final pin numbers for this instance (multi-section parts). */
  pinMap?: Record<string, string>;
}

/** Units this symbol plays across its instances, with each unit's pin renumbering. */
function unitsOf(refs: InstanceRef[]): Map<number, Record<string, string> | undefined> {
  const m = new Map<number, Record<string, string> | undefined>();
  for (const r of refs) if (!m.has(r.unit) || (!m.get(r.unit) && r.pinMap)) m.set(r.unit, r.pinMap);
  if (m.size === 0) m.set(1, undefined);
  return m;
}

function emitInstance(
  sym: SchematicSymbol,
  libName: string,
  uuidStr: string,
  refs: InstanceRef[],
  projectName: string,
  dropped: ReadonlySet<string> = new Set(),
  footprint = "",
): string {
  const s = sym.floating ? { ...sym, at: { x: sym.at.x + NUDGE, y: sym.at.y + NUDGE } } : sym;
  const reference = refs[0]?.reference ?? s.reference;
  const { angle, mirror } = kicadOrient(s.transform);
  const textAt = (t: SchematicSymbol["refText"], dflt: SchPoint) => (t ? add(s.at, applyD(s.transform, t.at)) : dflt);
  const refAt = textAt(s.refText, s.at);
  const valAt = textAt(s.valueText, s.at);
  const power = s.kind === "power";
  return [
    `\t(symbol`,
    `\t\t(lib_id ${q(libName)})`,
    `\t\t(at ${u(s.at.x)} ${u(s.at.y)} ${angle})${mirror ? ` (mirror ${mirror})` : ""}`,
    `\t\t(unit ${refs[0]?.unit ?? 1})`,
    `\t\t(exclude_from_sim no)`,
    `\t\t(in_bom ${power ? "no" : "yes"})`,
    `\t\t(on_board ${power ? "no" : "yes"})`,
    `\t\t(dnp no)`,
    `\t\t(uuid ${q(uuidStr)})`,
    property("Reference", reference, refAt, power || !!s.refText?.hidden),
    property("Value", s.value, valAt, !power && !!s.valueText?.hidden),
    property("Footprint", footprint, s.at, true),
    property("Datasheet", "", s.at, true),
    ...[...new Set(uniquePins(s.pins).filter((p) => !dropped.has(p.number)).flatMap((p) => [...unitsOf(refs).values()].map((m) => m?.[p.number] ?? p.number)))].map(
      (n) => `\t\t(pin ${q(n)} (uuid ${q(uuid())}))`,
    ),
    `\t\t(instances (project ${q(projectName)} ${refs.map((r) => `(path ${q(r.path)} (reference ${q(r.reference)}) (unit ${r.unit}))`).join(" ")}))`,
    `\t)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Wires, labels, junctions

const key = (p: SchPoint) => `${p.x},${p.y}`;

function emitWire(a: SchPoint, b: SchPoint): string {
  return `\t(wire (pts (xy ${u(a.x)} ${u(a.y)}) (xy ${u(b.x)} ${u(b.y)})) (stroke (width 0) (type default)) (uuid ${q(uuid())}))`;
}

function labelAngle(dir: SchPoint): number {
  if (dir.x < 0) return 180;
  if (dir.y < 0) return 90;
  if (dir.y > 0) return 270;
  return 0;
}

/**
 * A Multisim bus as KiCad bus segments, its entries, and an unnamed bus-group
 * label `{a b ...}` so the members keep their plain net names (the wires at
 * each entry carry member-name labels, which is what actually connects them).
 */
function emitBus(bus: SchematicBus): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < bus.points.length; i++) {
    const [a, b] = [bus.points[i]!, bus.points[i + 1]!];
    if (a.x === b.x && a.y === b.y) continue;
    out.push(`\t(bus (pts (xy ${u(a.x)} ${u(a.y)}) (xy ${u(b.x)} ${u(b.y)})) (stroke (width 0) (type default)) (uuid ${q(uuid())}))`);
  }
  const members = [...new Set(bus.members)];
  // KiCad bus member names can't contain spaces or braces.
  if (members.length && members.every((m) => /^[^\s{}\[\]]+$/.test(m))) {
    const at = bus.points[0]!;
    out.push(`\t(label ${q(`{${members.join(" ")}}`)} (at ${u(at.x)} ${u(at.y)} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid ${q(uuid())}))`);
  }
  return out;
}

function emitBusEntry(e: SchematicBusEntry): string {
  return `\t(bus_entry (at ${u(e.wire.x)} ${u(e.wire.y)}) (size ${u(e.bus.x - e.wire.x)} ${u(e.bus.y - e.wire.y)}) (stroke (width 0) (type default)) (uuid ${q(uuid())}))`;
}

// Items Multisim leaves unconnected but which touch other geometry are moved
// half a unit off-grid so KiCad doesn't join them.
const NUDGE = 0.5;

function emitLabel(label: SchematicLabel): string {
  const l = label.floating ? { ...label, at: { x: label.at.x + NUDGE, y: label.at.y + NUDGE } } : label;
  const angle = labelAngle(l.dir);
  const justify = angle === 180 || angle === 270 ? "right" : "left";
  if (l.kind === "hierarchical") {
    return `\t(hierarchical_label ${q(l.name)} (shape bidirectional) (at ${u(l.at.x)} ${u(l.at.y)} ${angle}) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid ${q(uuid())}))`;
  }
  if (l.kind === "global") {
    return `\t(global_label ${q(l.name)} (shape bidirectional) (at ${u(l.at.x)} ${u(l.at.y)} ${angle}) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid ${q(uuid())}) (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at ${u(l.at.x)} ${u(l.at.y)} 0) (hide yes) (effects (font (size 1.27 1.27)))))`;
  }
  return `\t(label ${q(l.name)} (at ${u(l.at.x)} ${u(l.at.y)} ${angle}) (effects (font (size 1.27 1.27)) (justify ${justify} bottom)) (uuid ${q(uuid())}))`;
}

type Segment = [SchPoint, SchPoint, string?]; // optional Multisim net id

/**
 * Points where a junction dot is needed: 3+ connections, or a T onto a
 * wire's interior — but only where everything meeting there is on the same
 * Multisim net (a junction between different nets would short them).
 */
function junctions(segments: Segment[], pinPoints: [SchPoint, string?][]): SchPoint[] {
  const ends = new Map<string, { p: SchPoint; n: number; nets: Set<string | undefined> }>();
  const bump = (p: SchPoint, net: string | undefined, n = 1) => {
    const k = key(p);
    const e = ends.get(k);
    if (e) {
      e.n += n;
      e.nets.add(net);
    } else ends.set(k, { p, n, nets: new Set([net]) });
  };
  for (const [a, b, net] of segments) {
    bump(a, net);
    bump(b, net);
  }
  for (const [p, net] of pinPoints) if (ends.has(key(p))) bump(p, net);
  // A segment's interior passing through a point counts as two connections.
  for (const e of ends.values()) {
    for (const [a, b, net] of segments) {
      if (onInterior(e.p, a, b)) {
        e.n += 2;
        e.nets.add(net);
      }
    }
  }
  const sameNet = (nets: Set<string | undefined>) => {
    const known = [...nets].filter((n) => n !== undefined);
    return new Set(known).size <= 1;
  };
  return [...ends.values()].filter((e) => e.n >= 3 && sameNet(e.nets)).map((e) => e.p);
}

function onInterior(p: SchPoint, a: SchPoint, b: SchPoint): boolean {
  if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y)) return false;
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 1e-6) return false;
  return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Project (one file per Multisim page) and hierarchy

interface SheetSymbolRef {
  path: string;
  page: number;
}

interface PageFile {
  sheet: SchematicSheet;
  fileName: string;
  uuid: string;
  symbolUuids: string[];
  libNames: string[];
  /** Per symbol: its library entry (filled once every instance is known). */
  libEntries: LibEntry[];
  symbolRefs: InstanceRef[][];
  /** Per symbol: drawn pin numbers emitted as plain lines (shared pins kept on another section). */
  droppedPins: Set<string>[];
  /** Sheet symbols on this page: hierarchical blocks and (first page only) the sheet's other pages. */
  sub: { key: string; uuid: string; name: string; file: string; block?: SheetBlock; refs: SheetSymbolRef[] }[];
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9_.+-]+/g, "_").replace(/^_+|_+$/g, "") || "sheet";

/** Sheet symbol for a hierarchical block: rectangle + pins on its edges. */
function emitSheetSymbol(
  sub: PageFile["sub"][number],
  at: SchPoint,
  size: { w: number; h: number },
  pins: { name: string; at: SchPoint; angle: number }[],
  projectName: string,
): string {
  return [
    `\t(sheet (at ${u(at.x)} ${u(at.y)}) (size ${u(size.w)} ${u(size.h)}) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)`,
    `\t\t(stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid ${q(sub.uuid)})`,
    `\t\t(property "Sheetname" ${q(sub.name)} (at ${u(at.x)} ${u(at.y - 2)} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))`,
    `\t\t(property "Sheetfile" ${q(sub.file)} (at ${u(at.x)} ${u(at.y + size.h + 2)} 0) (hide yes) (effects (font (size 1.27 1.27)) (justify left top)))`,
    ...pins.map(
      (p) =>
        `\t\t(pin ${q(p.name)} bidirectional (at ${u(p.at.x)} ${u(p.at.y)} ${p.angle}) (uuid ${q(uuid())}) (effects (font (size 1.27 1.27)) (justify ${p.angle === 180 ? "left" : p.angle === 0 ? "right" : "left"})))`,
    ),
    `\t\t(instances (project ${q(projectName)} ${sub.refs.map((r) => `(path ${q(r.path)} (page ${q(String(r.page))}))`).join(" ")}))`,
    `\t)`,
  ].join("\n");
}

/** Place block pins on the rectangle's edges; returns pins + stub wires for any that had to move. */
function blockGeometry(b: SheetBlock) {
  const w = Math.max(b.b.x - b.a.x, 9);
  const h = Math.max(b.b.y - b.a.y, 9);
  const stubs: [SchPoint, SchPoint][] = [];
  const pins = b.pins.map((p) => {
    const d = [
      { side: 180, dist: Math.abs(p.at.x - b.a.x), at: { x: b.a.x, y: p.at.y } },
      { side: 0, dist: Math.abs(p.at.x - (b.a.x + w)), at: { x: b.a.x + w, y: p.at.y } },
      { side: 90, dist: Math.abs(p.at.y - b.a.y), at: { x: p.at.x, y: b.a.y } },
      { side: 270, dist: Math.abs(p.at.y - (b.a.y + h)), at: { x: p.at.x, y: b.a.y + h } },
    ].sort((x, y) => x.dist - y.dist)[0]!;
    if (d.dist > 0) stubs.push([p.at, d.at]);
    if (p.attach) stubs.push([p.attach, p.at]);
    return { name: p.name, at: d.at, angle: d.side };
  });
  return { at: b.a, size: { w, h }, pins, stubs };
}

/**
 * Multisim only connects what its ID graph links; KiCad connects whatever
 * touches. Make the KiCad geometry connect exactly like Multisim:
 *
 * At every point where items of different Multisim nets touch, one net (the
 * first symbol pin's, else the most common) keeps the point. Every other net
 * there gets its own off-grid rendezvous point nearby; its wire ends and
 * labels move to it. Symbols stacked on top of each other (allowed in
 * Multisim) are each moved by their own off-grid offset, and each moved pin
 * is wired back to its net's point (original or rendezvous) when something
 * on that net is attached there. Half-unit coordinates never coincide with
 * the integer grid, so nothing else can touch the moved geometry.
 */
function resolveContacts(
  symbolsIn: SchematicSymbol[],
  segmentsIn: Segment[],
  labelsIn: SchematicLabel[],
): { symbols: SchematicSymbol[]; segments: Segment[]; labels: SchematicLabel[] } {
  type Item = { net?: string; sym?: number };
  const at = new Map<string, Item[]>();
  const put = (p: SchPoint, it: Item) => {
    const k = key(p);
    at.set(k, [...(at.get(k) ?? []), it]);
  };
  symbolsIn.forEach((s, i) => {
    for (const p of s.pins) put(p.attach ?? sheetPinPos(s, p), { net: p.netId, sym: i });
  });
  for (const [a, b, net] of segmentsIn) {
    put(a, { net });
    put(b, { net });
  }
  for (const l of labelsIn) if (!l.floating) put(l.at, { net: l.netId });

  const keeper = new Map<string, string | undefined>();
  const rendezvous = new Map<string, SchPoint>(); // `${pointKey}|${net}`
  for (const [k, items] of at) {
    const nets = [...new Set(items.map((i) => i.net).filter((n) => n !== undefined))];
    if (nets.length < 2) continue;
    const firstPin = items.find((i) => i.sym !== undefined && i.net !== undefined);
    const counts = new Map<string, number>();
    for (const i of items) if (i.net !== undefined) counts.set(i.net, (counts.get(i.net) ?? 0) + 1);
    const keep = firstPin?.net ?? [...counts].sort((x, y) => y[1] - x[1])[0]![0];
    keeper.set(k, keep);
    const [x, y] = k.split(",").map(Number) as [number, number];
    nets.filter((n) => n !== keep).forEach((n, j) => rendezvous.set(`${k}|${n}`, { x: x - NUDGE, y: y - NUDGE - j }));
  }
  if (keeper.size === 0) return { symbols: symbolsIn, segments: segmentsIn, labels: labelsIn };

  const relocate = (p: SchPoint, net: string | undefined): SchPoint => {
    const k = key(p);
    const keep = keeper.get(k);
    if (keep === undefined || net === undefined || net === keep) return p;
    return rendezvous.get(`${k}|${net}`) ?? p;
  };

  // Symbols that have a pin on a point owned by another net move.
  const move = new Map<number, SchPoint>();
  symbolsIn.forEach((s, i) => {
    const conflicted = s.pins.some((p) => {
      const keep = keeper.get(key(p.attach ?? sheetPinPos(s, p)));
      return keep !== undefined && p.netId !== undefined && p.netId !== keep;
    });
    if (conflicted) move.set(i, { x: NUDGE, y: NUDGE + move.size });
  });

  const segments: Segment[] = segmentsIn.map(([a, b, net]) => [relocate(a, net), relocate(b, net), net]);
  const symbols = symbolsIn.map((s, i) => {
    const d = move.get(i);
    if (!d) return s;
    const moved = { ...s, at: { x: s.at.x + d.x, y: s.at.y + d.y }, pins: s.pins.map((p) => ({ ...p, attach: undefined })) };
    s.pins.forEach((p, j) => {
      const orig = p.attach ?? sheetPinPos(s, p);
      const others = (at.get(key(orig)) ?? []).filter((it) => it.sym !== i && it.net === p.netId);
      if (others.length === 0 && !p.attach) return;
      segments.push([sheetPinPos(moved, moved.pins[j]!), relocate(orig, p.netId), p.netId]);
    });
    return moved;
  });
  const labels = labelsIn.map((l) => (l.floating ? l : { ...l, at: relocate(l.at, l.netId) }));
  return { symbols, segments, labels };
}

function renderPage(f: PageFile, sch: Schematic, isRoot: boolean, footprints?: ReadonlyMap<string, string>): string {
  const importNote = `Imported from ${sch.source.application} ${sch.source.versionMajor}.${sch.source.versionMinor} via multisim2kicad`;

  const rawSegments: Segment[] = [];
  for (const w of f.sheet.wires) for (let i = 0; i + 1 < w.points.length; i++) rawSegments.push([w.points[i]!, w.points[i + 1]!, w.netId]);
  const resolved = resolveContacts(f.sheet.symbols, rawSegments, f.sheet.labels);
  const sheet = { ...f.sheet, symbols: resolved.symbols };
  const segments: Segment[] = [...resolved.segments];
  for (const s of sheet.symbols) for (const p of s.pins) if (p.attach) segments.push([p.attach, sheetPinPos(s, p), p.netId]);

  const sheetSymbols: string[] = [];
  const blockPinPoints: [SchPoint, string?][] = [];
  let stackY = 20;
  for (const sub of f.sub) {
    if (sub.block) {
      const g = blockGeometry(sub.block);
      segments.push(...g.stubs);
      blockPinPoints.push(...g.pins.map((p): [SchPoint, string?] => [p.at, undefined]));
      sheetSymbols.push(emitSheetSymbol(sub, g.at, g.size, g.pins, sch.projectName));
    } else {
      // Extra pages of a multi-page sheet: parked to the right of the page.
      sheetSymbols.push(emitSheetSymbol(sub, { x: sheet.size.width + 40, y: stackY }, { w: 100, h: 30 }, [], sch.projectName));
      stackY += 50;
    }
  }
  const pinPoints: [SchPoint, string?][] = [
    ...sheet.symbols.flatMap((s) => s.pins.map((p): [SchPoint, string?] => [sheetPinPos(s, p), p.netId])),
    ...blockPinPoints,
  ];
  const labels = resolved.labels;

  return [
    `(kicad_sch`,
    `\t(version ${KICAD_SCH_VERSION})`,
    `\t(generator "multisim2kicad")`,
    `\t(generator_version "0.1")`,
    `\t(uuid ${q(f.uuid)})`,
    `\t(paper "User" ${u(sheet.size.width)} ${u(sheet.size.height)})`,
    `\t(title_block`,
    `\t\t(title ${q(sheet.page && sheet.page !== "1" ? `${sheet.title} — ${sheet.page}` : sheet.title || sch.projectName)})`,
    `\t\t(comment 1 ${q(importNote)})`,
    `\t)`,
    `\t(lib_symbols`,
    ...[...new Set(f.libEntries)].map((e) => renderLibSymbol(e, f.libNames[f.libEntries.indexOf(e)]!, 2)),
    `\t)`,
    ...junctions(segments, pinPoints).map((p) => `\t(junction (at ${u(p.x)} ${u(p.y)}) (diameter 0) (color 0 0 0 0) (uuid ${q(uuid())}))`),
    ...segments.filter(([a, b]) => a.x !== b.x || a.y !== b.y).map(([a, b]) => emitWire(a, b)),
    ...labels.map(emitLabel),
    ...sheet.buses.flatMap(emitBus),
    ...sheet.busEntries.map(emitBusEntry),
    ...sheet.texts.map((t) => `\t(text ${q(t.text)} (exclude_from_sim no) (at ${u(t.at.x)} ${u(t.at.y)} 0) (effects (font (size ${u(t.size)} ${u(t.size)})) (justify left top)) (uuid ${q(uuid())}))`),
    ...sheet.symbols.map((s, i) =>
      emitInstance(s, f.libNames[i]!, f.symbolUuids[i]!, f.symbolRefs[i]!, sch.projectName, f.droppedPins[i], footprints?.get(f.symbolRefs[i]![0]?.reference ?? "")),
    ),
    ...sheetSymbols,
    ...(isRoot ? [`\t(sheet_instances (path "/" (page "1")))`] : []),
    `\t(embedded_fonts no)`,
    `)`,
    ``,
  ].join("\n");
}

/**
 * Emit a KiCad schematic project: file name -> contents. The root page goes
 * to `<baseName>.kicad_sch`; every other Multisim page gets its own file,
 * shared by all instances of its sheet, with per-instance references.
 */
/** Where a schematic part lives, for the matching PCB footprint's link fields. */
export interface SymbolLink {
  path: string;      // board-style path: sheet symbol UUIDs (no root) + symbol UUID
  sheetname: string; // "/" or "/Child/Grandchild/"
  sheetfile: string;
  value: string;
  unit: number;
}

export interface SchProjectOptions {
  /** Reference -> "lib:footprint" for the symbols' Footprint field. */
  footprints?: ReadonlyMap<string, string>;
  /** Nickname of the project symbol library (default "ew"). */
  library?: string;
}

export function emitKicadSchProject(
  source: Schematic,
  baseName: string,
  opts: SchProjectOptions = {},
): { files: Map<string, string>; links: Map<string, SymbolLink>; symbolLibrary: string } {
  const libNick = opts.library ?? "ew";
  const sch: Schematic = { ...source, sheets: source.sheets.map((sh) => ({ ...sh, symbols: sh.symbols.map(centreSymbol) })) };
  const pagesOf = (title: string) => sch.sheets.filter((s) => s.title === title);
  const rootPages = pagesOf(sch.rootSheet);
  const rootFirst = rootPages[0] ?? sch.sheets[0];
  if (!rootFirst) throw new Error("schematic has no sheets");

  const files = new Map<SchematicSheet, PageFile>();
  const usedNames = new Set<string>();
  for (const sheet of sch.sheets) {
    let fileName =
      sheet === rootFirst ? `${baseName}.kicad_sch` : `${baseName}-${slug(sheet.title)}${pagesOf(sheet.title).length > 1 ? `-${slug(sheet.page)}` : ""}.kicad_sch`;
    while (usedNames.has(fileName)) fileName = fileName.replace(/\.kicad_sch$/, "_.kicad_sch");
    usedNames.add(fileName);
    files.set(sheet, {
      sheet,
      fileName,
      uuid: uuid(),
      symbolUuids: sheet.symbols.map(() => uuid()),
      libNames: [],
      libEntries: [],
      symbolRefs: sheet.symbols.map(() => []),
      droppedPins: sheet.symbols.map(() => new Set<string>()),
      sub: [],
    });
  }
  // Sheet symbols: other pages hang off a sheet's first page; blocks sit where drawn.
  for (const sheet of sch.sheets) {
    const f = files.get(sheet)!;
    const pages = pagesOf(sheet.title);
    if (pages[0] === sheet) {
      for (const other of pages.slice(1)) {
        f.sub.push({ key: `page:${other.page}`, uuid: uuid(), name: other.page, file: files.get(other)!.fileName, refs: [] });
      }
    }
    for (const b of sheet.blocks) {
      const child = pagesOf(b.childSheet)[0];
      if (!child) continue;
      f.sub.push({ key: `block:${b.id}`, uuid: uuid(), name: b.childSheet, file: files.get(child)!.fileName, block: b, refs: [] });
    }
  }

  // Walk the hierarchy: assign page numbers and per-instance references.
  let pageNo = 0;
  let pwr = 0;
  type Sub = PageFile["sub"][number];
  const placements: { f: PageFile; i: number; ref: InstanceRef; chain: Sub[] }[] = [];
  const visit = (inst: SchInstance, sheet: SchematicSheet, path: string, chain: Sub[] = []): number => {
    const f = files.get(sheet)!;
    const myPage = ++pageNo;
    const seen = new Map<string, number>();
    sheet.symbols.forEach((s, i) => {
      let ref: string;
      if (s.kind === "power") ref = `#PWR${String(++pwr).padStart(3, "0")}`;
      else {
        ref = (s.drawnKey && inst.refdes[`${sheet.page}|${s.drawnKey}`]) || s.reference || "U?";
        if (!(s.drawnKey && inst.refdes[`${sheet.page}|${s.drawnKey}`])) {
          // Drawn names are only unique per page and instance: qualify fallbacks.
          const n = seen.get(ref) ?? 0;
          seen.set(ref, n + 1);
          if (n > 0) ref = `${ref}_${n}`;
          if (path.split("/").length > 2) ref = `${ref}_${inst.name || "X"}`;
        }
      }
      const k = s.drawnKey ? `${sheet.page}|${s.drawnKey}` : "";
      const r: InstanceRef = { path, reference: ref, unit: (k && inst.units[k]) || 1, pinMap: k ? inst.pinRemaps[k] : undefined };
      f.symbolRefs[i]!.push(r);
      placements.push({ f, i, ref: r, chain });
    });
    for (const sub of f.sub) {
      if (sub.key.startsWith("page:")) {
        const other = pagesOf(sheet.title).find((p) => `page:${p.page}` === sub.key)!;
        sub.refs.push({ path, page: visit(inst, other, `${path}/${sub.uuid}`, [...chain, sub]) });
      } else {
        const child = inst.children.find((c) => c.parentPage === sheet.page && `block:${c.blockId}` === sub.key);
        if (!child) continue;
        if (child.name) sub.name = child.name;
        const childFirst = pagesOf(child.sheet)[0]!;
        sub.refs.push({ path, page: visit(child, childFirst, `${path}/${sub.uuid}`, [...chain, sub]) });
      }
    }
    return myPage;
  };
  const rootFile = files.get(rootFirst)!;
  visit(sch.root, rootFirst, `/${rootFile.uuid}`);

  // Sheet names must be unique per parent page.
  for (const f of files.values()) {
    const count = new Map<string, number>();
    for (const sub of f.sub) {
      const n = count.get(sub.name) ?? 0;
      count.set(sub.name, n + 1);
      if (n > 0) sub.name = `${sub.name}_${n}`;
    }
  }

  for (const f of files.values()) {
    // Unreferenced pages (not reachable from the root) are still written,
    // so nothing in the source is silently dropped.
    if (f.symbolRefs.some((r) => r.length === 0) && f !== rootFile) {
      f.symbolRefs.forEach((r, i) => r.length || r.push({ path: `/${f.uuid}`, reference: f.sheet.symbols[i]!.reference || "U?", unit: 1 }));
    }
  }
  dropSharedPins([...files.values()]);

  // One library symbol per distinct drawing, across the whole project.
  const library = new SymbolLibrary();
  for (const f of files.values()) {
    f.libEntries = f.sheet.symbols.map((s, i) => {
      const r = library.add(s, f.symbolRefs[i]!, f.droppedPins[i]!);
      f.sheet.symbols[i] = r.symbol;
      return r.entry;
    });
    f.libNames = f.libEntries.map((e) => `${libNick}:${e.name}`);
  }

  // Board links: one per reference (the lowest unit when a part has several).
  const links = new Map<string, SymbolLink>();
  for (const { f, i, ref, chain } of placements) {
    const s = f.sheet.symbols[i]!;
    if (s.kind === "power") continue;
    const cur = links.get(ref.reference);
    if (cur && cur.unit <= ref.unit) continue;
    links.set(ref.reference, {
      // Board paths leave out the root sheet's UUID.
      path: `${ref.path.split("/").slice(2).map((x) => `/${x}`).join("")}/${f.symbolUuids[i]}`,
      sheetname: `/${chain.map((c) => `${c.name}/`).join("")}`,
      sheetfile: f.fileName,
      value: s.value,
      unit: ref.unit,
    });
  }

  const out = new Map<string, string>();
  for (const f of files.values()) out.set(f.fileName, renderPage(f, sch, f === rootFile, opts.footprints));
  return { files: out, links, symbolLibrary: library.file() };
}

/**
 * Multisim draws a multi-section part's shared pins (an op-amp's V+/V-) on
 * every section. KiCad keeps one pin per number per part, and a copy left
 * dangling on another section takes the pin off its net. Keep the pin on the
 * section where Multisim wires it (else the first) and draw the other copies
 * as plain lines. Decided on each symbol's first instance.
 */
function dropSharedPins(files: PageFile[]): void {
  const owners = new Map<string, { f: PageFile; i: number; drawn: string; connected: boolean }[]>();
  for (const f of files) {
    f.sheet.symbols.forEach((s, i) => {
      const r = f.symbolRefs[i]![0];
      if (s.kind === "power" || !r) return;
      for (const p of uniquePins(s.pins)) {
        const k = JSON.stringify([r.reference, r.pinMap?.[p.number] ?? p.number]);
        const list = owners.get(k) ?? [];
        list.push({ f, i, drawn: p.number, connected: !!p.connected });
        owners.set(k, list);
      }
    });
  }
  for (const list of owners.values()) {
    if (list.length < 2) continue;
    const keep = list.find((o) => o.connected) ?? list[0]!;
    for (const o of list) if (o !== keep) o.f.droppedPins[o.i]!.add(o.drawn);
  }
}

/** Single-file convenience (tests): the root page's contents. */
export function emitKicadSch(sch: Schematic): string {
  return [...emitKicadSchProject(sch, "out").files.values()][0]!;
}

/**
 * Project-file settings the schematic needs: a 10 mil connection grid so the
 * integer Multisim grid is on-grid for ERC.
 */
export function kicadProSchematicSettings() {
  return { connection_grid_size: 10.0 };
}
