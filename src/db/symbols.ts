// EW database symbols -> KiCad library symbols (Phase F).
//
// A symbol picture (`SYS_SYMBOL_PICTURE.Image`) is Multisim's symbol-editor
// document, `<DrDoc Type="BaseSymbolDocument">`: layers (`LayerInfo LN=`)
// "Border" (a BoundaryBox), "Pins" and "N Draw layer"s (layers 2+ are
// alternate looks, e.g. a fuse's blown state), each an
// `ObjectsList` of objects tagged by `Type`. Coordinates are Multisim
// schematic units, Y down (the same frame as a placed `.ms14` symbol).
//
// A pin: `CTSP` (its body end), `WCP` (the wire connection point),
// `PNaT Txt` = the pin's 1-based index into its section's pin list; the
// number text is a `##` placeholder (numbers come from the package).
//
// A component (`SYS_COMPONENT`) lists every pin once per section in
// `Pinout` (sections concatenated, in `Sec_Order`), with `Pin_Type`
// ("A:INPUT", "A:I/O::1", ...). `SYS_MAPPING_COMP_SYMBOL` gives each
// section's picture and pin list; `SYS_MAPPING_COMP_PACKAGE.Pinout` the
// pads of each component pin ("1,2" = two pads), same order as `Pinout`.

import { decodeBuffer, type EwElement, parseEwXml } from "electronics-workbench-decoder";
import { type LibrarySymbolSpec, simFieldList } from "../emit/kicad-sch.ts";
import { modelDef, type SimSection, simSpec, SpiceLibrary } from "../parse/spice.ts";
import type { PinElectrical, SchGraphic, SchPoint, SymbolPin } from "../ir/types.ts";
import type { EwDatabase } from "./ewdb.ts";

type Row = Record<string, unknown>;
const rows = (db: EwDatabase, table: string): Row[] => db.tables[table]?.rows ?? [];
const lines = (v: unknown) => String(v ?? "").split(/\r?\n/).filter((l) => l !== "");

/**
 * A symbol picture's XML. The stored image is a 5-byte prefix followed by
 * EW's usual compressed stream (as after a compressed file's header).
 */
export function symbolPictureXml(image: Uint8Array, size: number): string {
  const body = image.subarray(5);
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const file = Buffer.concat([Buffer.from("CompressedElectronicsWorkbenchXML", "latin1"), u32(size), u32(0), u32(size), u32(body.length), body]);
  return decodeBuffer(file).xml.toString("latin1");
}

export interface PicturePin {
  /** 1-based index into the section's pin list. */
  index: number;
  at: SchPoint;
  dir: SchPoint;
  length: number;
}

export interface SymbolPicture {
  graphics: SchGraphic[];
  pins: PicturePin[];
  showPinNames: boolean;
}

const pointsOf = (e: EwElement): SchPoint[] =>
  (e.child("PtA")?.childrenNamed() ?? []).filter((p) => p.get("Type") === "Point").map((p) => ({ x: p.numOr("X", 0), y: p.numOr("Y", 0) }));
const pointAt = (e: EwElement | undefined): SchPoint | undefined => (e ? { x: e.numOr("X", 0), y: e.numOr("Y", 0) } : undefined);
const objectsOf = (layer: EwElement): EwElement[] => layer.child("DS")?.childrenNamed() ?? [];

/** An ellipse arc from `t0` to `t1` (radians) around `c` with conjugate axes `a`, `b`, as a polyline. */
function ellipsePoints(c: SchPoint, a: SchPoint, b: SchPoint, t0: number, t1: number, steps: number): SchPoint[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = t0 + ((t1 - t0) * i) / steps;
    return { x: c.x + a.x * Math.cos(t) + b.x * Math.sin(t), y: c.y + a.y * Math.cos(t) + b.y * Math.sin(t) };
  });
}

function graphicOf(o: EwElement): SchGraphic | undefined {
  const pts = pointsOf(o);
  const width = o.numOr("PW", 0);
  // Windows brush styles: 0 solid, 1 hollow.
  const fill = o.get("BS") === "0";
  switch (o.get("Type")) {
    case "Line":
    case "MultiLine":
      return pts.length >= 2 ? { kind: "polyline", points: pts, width, fill: false } : undefined;
    case "Polygon":
      return pts.length >= 3 ? { kind: "polyline", points: [...pts, pts[0]!], width, fill } : undefined;
    case "Rectangle":
      return pts.length >= 2 ? { kind: "rect", a: pts[0]!, b: pts[1]!, width, fill } : undefined;
    case "Circle": {
      const [c, rim] = pts;
      return c && rim ? { kind: "circle", center: c, radius: Math.hypot(rim.x - c.x, rim.y - c.y), width, fill } : undefined;
    }
    case "Ellipse": {
      const [p, q] = pts;
      if (!p || !q) return undefined;
      const c = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const rx = Math.abs(q.x - p.x) / 2;
      const ry = Math.abs(q.y - p.y) / 2;
      if (rx === ry) return { kind: "circle", center: c, radius: rx, width, fill };
      return { kind: "polyline", points: ellipsePoints(c, { x: rx, y: 0 }, { x: 0, y: ry }, 0, 2 * Math.PI, 48), width, fill };
    }
    case "HalfEllipseArc": {
      // Chord ends + the apex of the bulge: half an ellipse with conjugate
      // semi-axes (end - centre) and (apex - centre).
      const [p0, p1, apex] = pts;
      if (!p0 || !p1 || !apex) return undefined;
      const c = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const a = { x: p0.x - c.x, y: p0.y - c.y };
      const b = { x: apex.x - c.x, y: apex.y - c.y };
      if (Math.abs(Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y)) < 1e-9 && Math.abs(a.x * b.x + a.y * b.y) < 1e-9) {
        return { kind: "arc", start: p0, mid: apex, end: p1, width };
      }
      return { kind: "polyline", points: ellipsePoints(c, a, b, 0, Math.PI, 24), width, fill: false };
    }
    case "SegmentArc": {
      // Centre, start, end; drawn counter-clockwise on screen (Y down).
      const [c, s, e] = pts;
      if (!c || !s || !e) return undefined;
      const r = Math.hypot(s.x - c.x, s.y - c.y);
      const a0 = Math.atan2(s.y - c.y, s.x - c.x);
      const a1 = Math.atan2(e.y - c.y, e.x - c.x);
      const sweep = (((a0 - a1) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
      const am = a0 - sweep / 2;
      return { kind: "arc", start: s, mid: { x: c.x + r * Math.cos(am), y: c.y + r * Math.sin(am) }, end: e, width };
    }
    case "Text": {
      const at = pts[0];
      const text = o.str("Txt");
      return at && text ? { kind: "text", at, text, size: o.numOr("H", 10) } : undefined;
    }
    default:
      return undefined;
  }
}

export function parseSymbolPicture(xml: string): SymbolPicture {
  const root = parseEwXml(xml).root;
  const graphics: SchGraphic[] = [];
  const pins: PicturePin[] = [];
  let showPinNames = false;
  for (const layer of root.child("LrsArr")?.childrenNamed() ?? []) {
    // "Border" is the bounding box; draw layers past the first are
    // alternate looks (a blown fuse's state), not part of the symbol.
    const name = layer.str("LN");
    const draw = /^(\d+) Draw layer$/i.exec(name);
    if (name === "Border" || (draw && draw[1] !== "1")) continue;
    for (const o of objectsOf(layer)) {
      if (o.get("Type") === "Pin") {
        const body = pointAt(o.child("CTSP"));
        const wire = pointAt(o.child("WCP"));
        const nameText = o.child("PNaT");
        const index = Number(nameText?.str("Txt"));
        if (!body || !wire || !Number.isInteger(index)) continue;
        const length = Math.hypot(body.x - wire.x, body.y - wire.y);
        pins.push({ index, at: wire, dir: length ? { x: (body.x - wire.x) / length, y: (body.y - wire.y) / length } : { x: 0, y: 0 }, length });
        showPinNames ||= nameText?.get("Vis") !== "0";
      } else {
        const g = graphicOf(o);
        if (g) graphics.push(g);
      }
    }
  }
  return { graphics, pins, showPinNames };
}

const ELECTRICAL: Record<string, PinElectrical> = {
  INPUT: "input",
  OUTPUT: "output",
  "I/O": "bidirectional",
  PASSIVE: "passive",
  PWR: "power_in",
  GND: "power_in",
  VCC: "power_in",
  VEE: "power_in",
  VPP: "power_in",
  OPEN_COLLECTOR: "open_collector",
  OPEN_DRAIN: "open_collector",
  OPEN_EMITTER: "open_emitter",
  OPEN_SOURCE: "open_emitter",
  TRISTATE: "tri_state",
  NC: "no_connect",
};

export interface DatabaseSymbols {
  specs: LibrarySymbolSpec[];
  warnings: string[];
  /** SPICE library text per family (only families with simulated parts). */
  spice: Map<string, string>;
}

/**
 * One library symbol per database component: sections as units, pin
 * numbers from the package (several pads -> stacked pins; no package -> the
 * pin name), electrical types from `Pin_Type`. `footprintFor` maps a
 * package name to a KiCad footprint id when the footprint is in this
 * database.
 */
export function databaseSymbols(
  db: EwDatabase,
  footprintFor: (pkg: string) => string | undefined,
  /** `Sim.Library` path for a family's SPICE library. */
  spicePath: (family: string) => string = (family) => `${family}.lib`,
): DatabaseSymbols {
  const warnings: string[] = [];
  const pictures = new Map<number, SymbolPicture>();
  for (const r of rows(db, "SYS_SYMBOL_PICTURE")) {
    const img = r.Image as { value?: string } | undefined;
    if (!img?.value) continue;
    try {
      pictures.set(Number(r.Symbol_ID), parseSymbolPicture(symbolPictureXml(Buffer.from(img.value, "base64"), Number(r.Size))));
    } catch (e) {
      warnings.push(`symbol picture ${r.Symbol_ID}: ${e}`);
    }
  }
  const families = new Map(rows(db, "SYS_CONFIGURATION").map((r) => [r.Family_ID, r]));
  const packages = new Map(rows(db, "SYS_PCB_PACKAGE").map((r) => [r.Package_ID, String(r.Package_Type ?? "")]));
  const sectionsOf = groupBy(rows(db, "SYS_MAPPING_COMP_SYMBOL"), (r) => r.Component_ID);
  const packageOf = new Map(rows(db, "SYS_MAPPING_COMP_PACKAGE").map((r) => [r.Component_ID, r]));
  const modelRowsOf = groupBy(rows(db, "SYS_MAPPING_COMP_MODEL"), (r) => r.Component_ID);
  const modelText = new Map(rows(db, "SYS_MODEL").map((r) => [String(r.MODEL_ID ?? "").toLowerCase(), String(r.DATA ?? "")]));
  const modelCache = new Map<string, ReturnType<typeof modelDef>>();
  const modelFor = (id: string) => {
    const key = id.toLowerCase();
    if (!modelCache.has(key)) modelCache.set(key, modelText.has(key) ? modelDef(id, modelText.get(key)!) : undefined);
    return modelCache.get(key);
  };
  const spiceLibs = new Map<string, SpiceLibrary>();
  let needParams = 0;

  const used = new Set<string>();
  const specs: LibrarySymbolSpec[] = [];
  for (const c of rows(db, "SYS_COMPONENT")) {
    const compName = String(c.Component_Name ?? "");
    const family = families.get(c.Family_ID);
    const familyName = String(family?.Family_Name ?? "");
    const pinNames = lines(c.Pinout);
    const pinTypes = lines(c.Pin_Type).map((t) => ELECTRICAL[t.split(":")[1] ?? ""] ?? "unspecified");
    const pkg = packageOf.get(c.Component_ID);
    const pkgName = pkg ? (packages.get(pkg.Package_ID) ?? "") : "";
    const pads = pkg ? lines(pkg.Pinout).map((l) => l.split(",").map((s) => s.trim()).filter(Boolean)) : [];
    const sections = (sectionsOf.get(c.Component_ID) ?? []).sort((a, b) => Number(a.Sec_Order) - Number(b.Sec_Order));

    // A section names its pins; the component's `Pinout` lists every pin in
    // package order (the package `Pinout` has the same order), including
    // pins no section draws (a 7400's GND / VCC). So section pins are
    // matched to component pins by name: the first not yet taken, else the
    // first (a supply pin drawn on every section), else by position.
    const units: LibrarySymbolSpec["units"] = [];
    const placedPads = new Set<string>();
    const claimed = new Set<number>();
    const pinIndex = (name: string, fallback: number): number => {
      let first = -1;
      for (let i = 0; i < pinNames.length; i++) {
        if (pinNames[i] !== name) continue;
        if (!claimed.has(i)) return i;
        if (first < 0) first = i;
      }
      return first >= 0 ? first : fallback;
    };
    let offset = 0;
    let showPinNames = false;
    for (const sec of sections) {
      const pic = pictures.get(Number(sec.Symbol_ID_ANSI));
      const secNames = lines(sec.Pinout_ANSI);
      if (!pic) {
        warnings.push(`${compName}: section ${sec.Sec_Order} has no symbol picture ${sec.Symbol_ID_ANSI}`);
        offset += secNames.length;
        continue;
      }
      showPinNames ||= pic.showPinNames;
      const pins: SymbolPin[] = [];
      const stems: SymbolPin[] = [];
      for (const p of [...pic.pins].sort((a, b) => a.index - b.index)) {
        const secName = secNames[p.index - 1];
        const k = secName === undefined ? offset + p.index - 1 : pinIndex(secName, offset + p.index - 1);
        claimed.add(k);
        const name = secName ?? pinNames[k] ?? String(p.index);
        if (secName !== undefined && pinNames.length && pinNames[k] !== secName) warnings.push(`${compName}: section ${sec.Sec_Order} pin ${secName} is not in the component's Pinout`);
        const numbers = pads[k]?.length ? pads[k]! : [name];
        const base = { name, at: p.at, dir: p.dir, length: p.length, electrical: pinTypes[k] ?? "unspecified" } as const;
        // A pad already on an earlier section (shared supply pins) stays
        // there; this copy is drawn as plain lines.
        const fresh = numbers.filter((n) => !placedPads.has(n));
        if (fresh.length === 0) stems.push({ ...base, number: numbers[0]! });
        for (const n of fresh) {
          placedPads.add(n);
          pins.push({ ...base, number: n });
        }
      }
      units.push({ graphics: pic.graphics, pins, stems });
      offset += secNames.length;
    }
    // Pins no section draws (Multisim's hidden power pins) go on one more
    // unit, so they still reach the netlist and the footprint.
    if (units.length) {
      const hidden: SymbolPin[] = [];
      pinNames.forEach((name, k) => {
        // A hidden pin the package gives no pad (a crystal's case ground)
        // would only dangle.
        if (claimed.has(k) || (pkg && !pads[k]?.length)) return;
        const numbers = (pads[k]?.length ? pads[k]! : [name]).filter((n) => !placedPads.has(n));
        for (const n of numbers) {
          placedPads.add(n);
          hidden.push({ name, number: n, at: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, length: PIN, electrical: pinTypes[k] ?? "power_in" });
        }
      });
      if (hidden.length) units.push(pinBlock(hidden));
    }
    if (units.length === 0) {
      warnings.push(`${compName}: no symbol`);
      continue;
    }
    let name = sanitize(compName) || "PART";
    if (used.has(name.toLowerCase())) name = sanitize(`${compName}_${familyName}`);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${sanitize(compName)}_${n}`;
    used.add(name.toLowerCase());

    const footprint = pkgName ? footprintFor(pkgName) : undefined;
    const fields: [string, string][] = [];
    const description = String(c.Function ?? "") || String(c.Description ?? "");
    if (description) fields.push(["Description", description]);
    if (c.Manufacturer) fields.push(["Manufacturer", String(c.Manufacturer)]);
    if (familyName) fields.push(["EW_Family", familyName]);
    if (pkgName && !footprint) fields.push(["EW_Package", pkgName]);

    // Simulation: Multisim's per-section templates and models. Terminals
    // are the component's pin names; each maps to its symbol pin (first pad).
    const terminals = new Map<string, string>();
    pinNames.forEach((n, k) => {
      const num = pads[k]?.[0] ?? (pkg ? undefined : n);
      if (!terminals.has(n) && num && placedPads.has(num)) terminals.set(n, num);
    });
    // A section can list several alternative models (TLC271H, TLC271H_2,
    // ...; no default flag, row order varies): take the base one, i.e. the
    // shortest name, then alphabetical.
    const bySection = new Map<number, Row>();
    for (const r of modelRowsOf.get(c.Component_ID) ?? []) {
      if (!String(r.Template ?? "").trim()) continue;
      const sec = Number(r.Sec_Order);
      const cur = bySection.get(sec);
      const id = String(r.Model_ID ?? "");
      const curId = String(cur?.Model_ID ?? "");
      if (!cur || id.length < curId.length || (id.length === curId.length && id < curId)) bySection.set(sec, r);
    }
    const modelRows = [...bySection].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    const reference = /^[A-Za-z_#]*/.exec(String(family?.Template ?? ""))![0] || "U";
    let excludeFromSim = modelRows.length === 0;
    if (modelRows.some((r) => /#\d|%v\d|%S\d/.test(String(r.Template)))) {
      // Parameters come from a placed part's properties; the database has none.
      needParams++;
      excludeFromSim = true;
    } else if (modelRows.length) {
      const fam = sanitize(familyName) || "Misc";
      const lib = spiceLibs.get(fam) ?? new SpiceLibrary();
      spiceLibs.set(fam, lib);
      const sections: SimSection[] = modelRows.map((r) => {
        const id = String(r.Model_ID ?? "");
        const model = id && id !== "DUMMY" ? modelFor(id) : undefined;
        if (id && id !== "DUMMY" && !model && /%m/.test(String(r.Template))) lib.warnings.push(`${compName}: model ${id} not in the database`);
        return { template: String(r.Template), params: [], model, pins: terminals };
      });
      const sim = simSpec(compName, sections, lib, `EW_${sanitize(compName).replace(/[^A-Za-z0-9_]/g, "_")}`);
      if (sim.exclude) excludeFromSim = true;
      else fields.push(...simFieldList(sim, { value: compName, prefix: reference, library: spicePath(fam) }));
    }
    specs.push({
      name,
      reference,
      value: compName,
      footprint,
      fields,
      excludeFromSim,
      showPinNames,
      showPinNumbers: true,
      units,
    });
  }
  if (needParams) warnings.push(`${needParams} parts need instance parameters for simulation (set when placed in Multisim); excluded from simulation`);
  const spice = new Map<string, string>();
  for (const [fam, lib] of spiceLibs) {
    warnings.push(...lib.warnings);
    const text = lib.text(`SPICE models for the ${fam} family (multisim2kicad)`);
    if (text) spice.set(fam, text);
  }
  return { specs, warnings, spice };
}

/** Multisim's pin pitch and length, in schematic units. */
const PIN = 9;

/**
 * A plain box with the given pins down its left side. Pin names are
 * written as text in the box, since KiCad hides pin names symbol-wide and
 * the other units usually hide them.
 */
function pinBlock(pins: SymbolPin[]): LibrarySymbolSpec["units"][number] {
  const TEXT = 5;
  const longest = Math.max(...pins.map((p) => p.name.length));
  const width = Math.max(4, Math.ceil((longest * TEXT + 2 * TEXT) / PIN)) * PIN;
  const height = (pins.length + 1) * PIN;
  const y = (i: number) => (i + 1) * PIN;
  return {
    graphics: [
      { kind: "rect", a: { x: PIN, y: 0 }, b: { x: PIN + width, y: height }, width: 1, fill: false },
      ...pins.map((p, i): SchGraphic => ({ kind: "text", at: { x: PIN + 2, y: y(i) - 3 }, text: p.name, size: TEXT })),
    ],
    pins: pins.map((p, i) => ({ ...p, at: { x: 0, y: y(i) }, dir: { x: 1, y: 0 }, length: PIN })),
  };
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_.+-]+/g, "_").replace(/^_+|_+$/g, "");

function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k) ?? [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}
