import type {
  Dihedral,
  Schematic,
  SchematicLabel,
  SchematicSheet,
  SchematicSymbol,
  SchGraphic,
  SchPoint,
  SymbolPin,
} from "../ir/types.ts";

// KiCad 9/10 schematic format (KiCad 10 reads it natively).
const KICAD_SCH_VERSION = 20250610;

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

function emitLibSymbol(s: SchematicSymbol, libName: string): string {
  const local = libName.split(":").pop()!;
  const pins = uniquePins(s.pins);
  const power = s.kind === "power";
  const lines = [
    `\t\t(symbol ${q(libName)}`,
    power ? `\t\t\t(power global)` : "",
    `\t\t\t(pin_numbers${s.showPinNumbers && !power ? "" : " (hide yes)"})`,
    `\t\t\t(pin_names (offset 0.254)${s.showPinNames && !power ? "" : " (hide yes)"})`,
    `\t\t\t(exclude_from_sim no)`,
    `\t\t\t(in_bom ${power ? "no" : "yes"})`,
    `\t\t\t(on_board ${power ? "no" : "yes"})`,
    `\t\t\t(duplicate_pin_numbers_are_jumpers no)`,
    `\t\t\t(property "Reference" ${q(power ? "#PWR" : s.reference.replace(/\d+$/, "") || "U")} (at 0 0 0) ${FONT})`,
    `\t\t\t(property "Value" ${q(s.value)} (at 0 0 0) ${FONT})`,
    `\t\t\t(property "Footprint" "" (at 0 0 0) (hide yes) ${FONT})`,
    `\t\t\t(property "Datasheet" "" (at 0 0 0) (hide yes) ${FONT})`,
    `\t\t\t(symbol ${q(`${local}_0_1`)}`,
    ...s.graphics.map(libGraphic).filter((x): x is string => !!x),
    `\t\t\t)`,
    `\t\t\t(symbol ${q(`${local}_1_1`)}`,
    ...pins.map((p) => {
      const type = power ? "power_in" : "passive";
      return `\t\t\t\t(pin ${type} line (at ${lib(p.at)} ${pinAngle(p.dir)}) (length ${u(p.length)})${power ? " (hide yes)" : ""} (name ${q(p.name || "~")} ${FONT}) (number ${q(p.number)} ${FONT}))`;
    }),
    `\t\t\t)`,
    `\t\t\t(embedded_fonts no)`,
    `\t\t)`,
  ];
  return lines.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Instances

function property(name: string, value: string, at: SchPoint, hide: boolean): string {
  return `\t\t(property ${q(name)} ${q(value)} (at ${u(at.x)} ${u(at.y)} 0)${hide ? " (hide yes)" : ""} (effects (font (size 1.27 1.27)) (justify left)))`;
}

function emitInstance(s: SchematicSymbol, libName: string, reference: string, projectName: string): string {
  const { angle, mirror } = kicadOrient(s.transform);
  const textAt = (t: SchematicSymbol["refText"], dflt: SchPoint) => (t ? add(s.at, applyD(s.transform, t.at)) : dflt);
  const refAt = textAt(s.refText, s.at);
  const valAt = textAt(s.valueText, s.at);
  const power = s.kind === "power";
  return [
    `\t(symbol`,
    `\t\t(lib_id ${q(libName)})`,
    `\t\t(at ${u(s.at.x)} ${u(s.at.y)} ${angle})${mirror ? ` (mirror ${mirror})` : ""}`,
    `\t\t(unit 1)`,
    `\t\t(exclude_from_sim no)`,
    `\t\t(in_bom ${power ? "no" : "yes"})`,
    `\t\t(on_board ${power ? "no" : "yes"})`,
    `\t\t(dnp no)`,
    `\t\t(uuid ${q(uuid())})`,
    property("Reference", reference, refAt, power || !!s.refText?.hidden),
    property("Value", s.value, valAt, !power && !!s.valueText?.hidden),
    property("Footprint", "", s.at, true),
    property("Datasheet", "", s.at, true),
    ...uniquePins(s.pins).map((p) => `\t\t(pin ${q(p.number)} (uuid ${q(uuid())}))`),
    `\t\t(instances (project ${q(projectName)} (path "/" (reference ${q(reference)}) (unit 1))))`,
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

function emitLabel(l: SchematicLabel): string {
  const angle = labelAngle(l.dir);
  const justify = angle === 180 || angle === 270 ? "right" : "left";
  if (l.kind === "global") {
    return `\t(global_label ${q(l.name)} (shape bidirectional) (at ${u(l.at.x)} ${u(l.at.y)} ${angle}) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid ${q(uuid())}) (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at ${u(l.at.x)} ${u(l.at.y)} 0) (hide yes) (effects (font (size 1.27 1.27)))))`;
  }
  return `\t(label ${q(l.name)} (at ${u(l.at.x)} ${u(l.at.y)} ${angle}) (effects (font (size 1.27 1.27)) (justify ${justify} bottom)) (uuid ${q(uuid())}))`;
}

/** Points where a junction dot is needed: 3+ connections, or a T onto a wire's interior. */
function junctions(segments: [SchPoint, SchPoint][], pinPoints: SchPoint[]): SchPoint[] {
  const ends = new Map<string, { p: SchPoint; n: number }>();
  const bump = (p: SchPoint, n = 1) => {
    const k = key(p);
    const e = ends.get(k);
    if (e) e.n += n;
    else ends.set(k, { p, n });
  };
  for (const [a, b] of segments) {
    bump(a);
    bump(b);
  }
  for (const p of pinPoints) if (ends.has(key(p))) bump(p);
  // A segment's interior passing through a point counts as two connections.
  for (const e of ends.values()) {
    for (const [a, b] of segments) {
      if (onInterior(e.p, a, b)) e.n += 2;
    }
  }
  return [...ends.values()].filter((e) => e.n >= 3).map((e) => e.p);
}

function onInterior(p: SchPoint, a: SchPoint, b: SchPoint): boolean {
  if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y)) return false;
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 1e-6) return false;
  return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
}

// ---------------------------------------------------------------------------

function emitSheet(sheet: SchematicSheet, sch: Schematic): string {
  const importNote = `Imported from ${sch.source.application} ${sch.source.versionMajor}.${sch.source.versionMinor} via ew-conv`;

  // Unique references: Multisim allows duplicates (e.g. power ports "0").
  let pwr = 0;
  const used = new Map<string, number>();
  const refs = sheet.symbols.map((s) => {
    if (s.kind === "power") return `#PWR${String(++pwr).padStart(3, "0")}`;
    const base = s.reference || "U?";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}_${n}`;
  });
  const libNames = sheet.symbols.map((s, i) => `ew:${(s.kind === "power" ? `PWR_${s.value}` : refs[i]!).replace(/[^A-Za-z0-9_.+-]/g, "_")}__${i}`);

  const segments: [SchPoint, SchPoint][] = [];
  for (const w of sheet.wires) for (let i = 0; i + 1 < w.points.length; i++) segments.push([w.points[i]!, w.points[i + 1]!]);
  // Bridge pins whose wiring attaches off the pin (source data drift).
  for (const s of sheet.symbols) for (const p of s.pins) if (p.attach) segments.push([p.attach, sheetPinPos(s, p)]);
  const pinPoints = sheet.symbols.flatMap((s) => s.pins.map((p) => sheetPinPos(s, p)));

  return [
    `(kicad_sch`,
    `\t(version ${KICAD_SCH_VERSION})`,
    `\t(generator "ew-conv")`,
    `\t(generator_version "0.1")`,
    `\t(uuid ${q(uuid())})`,
    `\t(paper "User" ${u(sheet.size.width)} ${u(sheet.size.height)})`,
    `\t(title_block`,
    `\t\t(title ${q(sheet.name || sch.projectName)})`,
    `\t\t(comment 1 ${q(importNote)})`,
    `\t)`,
    `\t(lib_symbols`,
    ...sheet.symbols.map((s, i) => emitLibSymbol(s, libNames[i]!)),
    `\t)`,
    ...junctions(segments, pinPoints).map((p) => `\t(junction (at ${u(p.x)} ${u(p.y)}) (diameter 0) (color 0 0 0 0) (uuid ${q(uuid())}))`),
    ...segments.filter(([a, b]) => a.x !== b.x || a.y !== b.y).map(([a, b]) => emitWire(a, b)),
    ...sheet.labels.map(emitLabel),
    ...sheet.texts.map((t) => `\t(text ${q(t.text)} (exclude_from_sim no) (at ${u(t.at.x)} ${u(t.at.y)} 0) (effects (font (size ${u(t.size)} ${u(t.size)})) (justify left top)) (uuid ${q(uuid())}))`),
    ...sheet.symbols.map((s, i) => emitInstance(s, libNames[i]!, refs[i]!, sch.projectName)),
    `\t(sheet_instances (path "/" (page "1")))`,
    `\t(embedded_fonts no)`,
    `)`,
    ``,
  ].join("\n");
}

export function emitKicadSch(sch: Schematic): string {
  const sheet = sch.sheets[0];
  if (!sheet) throw new Error("schematic has no sheets");
  return emitSheet(sheet, sch);
}

/**
 * Project-file settings the schematic needs: a 10 mil connection grid so the
 * integer Multisim grid is on-grid for ERC.
 */
export function kicadProSchematicSettings() {
  return { connection_grid_size: 10.0 };
}
