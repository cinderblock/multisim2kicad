import type {
  Schematic,
  SchematicSymbol,
  SchematicWire,
  SymbolPin,
} from "../ir/types.ts";

// KiCad schematic format. KiCad 10 accepts older versions on load (offers to
// upgrade on save). We target the KiCad-8 version, which loads cleanly in
// 8/9/10 without needing 10-only features.
const KICAD_SCH_VERSION = 20250610;
const NM_PER_MM = 1_000_000;

const mm = (nm: number): string => (nm / NM_PER_MM).toFixed(4);

function q(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, "\\n")}"`;
}

function uuid(): string {
  return crypto.randomUUID();
}

// Shift Multisim's centred coords so the leftmost / bottommost point is 0,
// matching KiCad's top-left-origin sheet.
type Translator = (x: number, y: number) => { x: number; y: number };
const sheetTranslator = (sch: Schematic): Translator => {
  const dx = -sch.workArea.left;
  const dy = -sch.workArea.bottom;
  return (x, y) => ({ x: x + dx, y: y + dy });
};

const libIdFor = (sym: SchematicSymbol, i: number): string =>
  `ew:${sym.reference || "S"}__${i}`;

function libProperty(name: string, value: string, hide = false): string {
  const hideTok = hide ? ` (hide yes)` : "";
  return `\t\t\t(property ${q(name)} ${q(value)} (at 0 0 0)${hideTok} (effects (font (size 1.27 1.27))))`;
}

// Dedupe pins by number within one symbol — KiCad rejects duplicate numbers
// when (duplicate_pin_numbers_are_jumpers no). Empty-number pins are dropped
// since they can't be referenced from a wire.
function uniquePins(pins: SymbolPin[]): SymbolPin[] {
  const seen = new Set<string>();
  const out: SymbolPin[] = [];
  for (const p of pins) {
    if (!p.number) continue;
    if (seen.has(p.number)) continue;
    seen.add(p.number);
    out.push(p);
  }
  return out;
}

function emitLibPin(p: SymbolPin): string {
  const name = p.name || "~";
  return `\t\t\t\t(pin passive line (at ${mm(p.at.x)} ${mm(p.at.y)} 0) (length 0) (name ${q(name)} (effects (font (size 1.27 1.27)))) (number ${q(p.number)} (effects (font (size 1.27 1.27)))))`;
}

function emitLibSymbol(sym: SchematicSymbol, i: number): string {
  const lib = libIdFor(sym, i);
  const { x0, y0, x1, y1 } = sym.bbox;
  const pins = uniquePins(sym.pins);
  const pinLines = pins.map(emitLibPin).join("\n");
  return [
    `\t\t(symbol ${q(lib)}`,
    `\t\t\t(exclude_from_sim no)`,
    `\t\t\t(in_bom yes)`,
    `\t\t\t(on_board yes)`,
    `\t\t\t(duplicate_pin_numbers_are_jumpers no)`,
    libProperty("Reference", sym.reference || "U"),
    libProperty("Value", sym.value),
    libProperty("Footprint", "", true),
    libProperty("Datasheet", "", true),
    // Inner sub-symbol uses local name only (strip "library:" prefix). "_1_1"
    // = (unit 1, body 1 / normal de-Morgan).
    `\t\t\t(symbol ${q(lib.split(":").pop()! + "_1_1")}`,
    `\t\t\t\t(rectangle (start ${mm(x0)} ${mm(y0)}) (end ${mm(x1)} ${mm(y1)}) (stroke (width 0.254) (type default)) (fill (type none)))`,
    pinLines,
    `\t\t\t)`,
    `\t\t\t(embedded_fonts no)`,
    `\t\t)`,
  ].join("\n");
}

function instanceProperty(
  name: string, value: string, x: number, y: number, hide = false, justifyLeft = false,
): string {
  const hideTok = hide ? ` (hide yes)` : "";
  const justifyTok = justifyLeft ? ` (justify left)` : "";
  return `\t\t(property ${q(name)} ${q(value)} (at ${mm(x)} ${mm(y)} 0)${hideTok} (effects (font (size 1.27 1.27))${justifyTok}))`;
}

function emitSymbolInstance(
  sym: SchematicSymbol, i: number, t: Translator, projectName: string,
): string {
  const lib = libIdFor(sym, i);
  const at = t(sym.at.x, sym.at.y);

  // Reference label above the bbox, value below — anchored to the left edge
  // in the symbol-local frame so they translate cleanly.
  const refAt = t(sym.at.x + sym.bbox.x0, sym.at.y + sym.bbox.y0 - 1_500_000);
  const valAt = t(sym.at.x + sym.bbox.x0, sym.at.y + sym.bbox.y1 + 1_500_000);

  return [
    `\t(symbol`,
    `\t\t(lib_id ${q(lib)})`,
    `\t\t(at ${mm(at.x)} ${mm(at.y)} 0)`,
    `\t\t(unit 1)`,
    `\t\t(exclude_from_sim no)`,
    `\t\t(in_bom yes)`,
    `\t\t(on_board yes)`,
    `\t\t(dnp no)`,
    `\t\t(uuid ${q(uuid())})`,
    instanceProperty("Reference", sym.reference, refAt.x, refAt.y, false, true),
    instanceProperty("Value",     sym.value,     valAt.x, valAt.y, false, true),
    instanceProperty("Footprint", "",            at.x,    at.y,    true),
    instanceProperty("Datasheet", "",            at.x,    at.y,    true),
    ...uniquePins(sym.pins).map((p) => `\t\t(pin ${q(p.number)} (uuid ${q(uuid())}))`),
    `\t\t(instances`,
    `\t\t\t(project ${q(projectName)}`,
    `\t\t\t\t(path "/" (reference ${q(sym.reference || "?")}) (unit 1))`,
    `\t\t\t)`,
    `\t\t)`,
    `\t)`,
  ].join("\n");
}

function emitWire(w: SchematicWire, t: Translator): string {
  const a = t(w.from.x, w.from.y);
  const b = t(w.to.x, w.to.y);
  return `\t(wire (pts (xy ${mm(a.x)} ${mm(a.y)}) (xy ${mm(b.x)} ${mm(b.y)})) (stroke (width 0) (type default)) (uuid ${q(uuid())}))`;
}

export function emitKicadSch(sch: Schematic): string {
  const importNote =
    `Imported from ${sch.source.application} ` +
    `${sch.source.versionMajor}.${sch.source.versionMinor} via ew-conv`;
  const t = sheetTranslator(sch);

  const libSymbols = sch.symbols.map(emitLibSymbol).join("\n");
  const instances = sch.symbols
    .map((s, i) => emitSymbolInstance(s, i, t, sch.projectName))
    .join("\n");
  const wireLines = sch.wires.map((w) => emitWire(w, t)).join("\n");

  return [
    `(kicad_sch`,
    `\t(version ${KICAD_SCH_VERSION})`,
    `\t(generator ${q("ew-conv")})`,
    `\t(generator_version ${q("0.0")})`,
    `\t(uuid ${q(uuid())})`,
    `\t(paper ${q("A4")})`,
    ``,
    `\t(title_block`,
    `\t\t(title ${q(sch.projectName)})`,
    `\t\t(comment 1 ${q(importNote)})`,
    `\t)`,
    ``,
    `\t(lib_symbols`,
    libSymbols,
    `\t)`,
    ``,
    instances,
    ``,
    wireLines,
    ``,
    `\t(sheet_instances`,
    `\t\t(path "/" (page "1"))`,
    `\t)`,
    `)`,
    ``,
  ].join("\n");
}
