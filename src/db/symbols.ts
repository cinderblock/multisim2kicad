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
import type { LibrarySymbolSpec } from "../emit/kicad-sch.ts";
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
}

/**
 * One library symbol per database component: sections as units, pin
 * numbers from the package (several pads -> stacked pins; no package -> the
 * pin name), electrical types from `Pin_Type`. `footprintFor` maps a
 * package name to a KiCad footprint id when the footprint is in this
 * database.
 */
export function databaseSymbols(db: EwDatabase, footprintFor: (pkg: string) => string | undefined): DatabaseSymbols {
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

    const units: LibrarySymbolSpec["units"] = [];
    const placedPads = new Set<string>();
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
      for (const p of pic.pins) {
        const k = offset + p.index - 1;
        const name = secNames[p.index - 1] ?? pinNames[k] ?? String(p.index);
        if (pinNames[k] !== undefined && pinNames[k] !== name) warnings.push(`${compName}: pin ${k + 1} is ${pinNames[k]} in Pinout, ${name} in section ${sec.Sec_Order}`);
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
    specs.push({
      name,
      reference: /^[A-Za-z_#]*/.exec(String(family?.Template ?? ""))![0] || "U",
      value: compName,
      footprint,
      fields,
      showPinNames,
      showPinNumbers: true,
      units,
    });
  }
  return { specs, warnings };
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
