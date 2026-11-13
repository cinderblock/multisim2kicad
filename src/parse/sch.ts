/**
 * Multisim schematic XML -> Schematic IR (Multisim units, Y-down).
 *
 * Model (verified on the corpus, see plans/converter.md "Findings"):
 * - Placed parts are `CIITSymbolComp`. Their drawing objects live in
 *   `Objects > Item > <Class>`, each with its own affine `Transformer-M**`
 *   (Windows XFORM: x' = x*M00 + y*M10 + M20, y' = x*M01 + y*M11 + M21)
 *   into the symbol frame.
 * - Symbol orientation is `OrientationFlip`: bits 0-1 rotate (0, 1 = r270,
 *   2 = r180, 3 = r90 in (x, y) -> (y, -x) terms), 0x100 mirrors y, 0x1000
 *   mirrors x; the mirror applies before the rotation. The symbol's own
 *   `Transformer` matrix is always identity and its M20/M21 is not a reliable
 *   origin, so the translation is recovered from the pins.
 * - Each pin connector's `ConnectList` names a sheet-level `CODPinComp`
 *   whose CenterX/Y is where wiring attaches (absolute).
 * - Wires are `CIITLinkComp` polylines. User-named nets carry an
 *   `NI_EWB_NET_NAME` modifier.
 * - `CVirtualConnector` = named net connector (`NI_EWB_VIRTUAL_GLOBAL` /
 *   `_LOCAL`), emitted as global / local labels.
 * - Ground / supply symbols are `CIITSymbolComp`s whose Ci component is in
 *   the POWER_SOURCES family with a single pin; emitted as power ports whose
 *   name is the Ci refdes (= the net name, e.g. "0", "VCC").
 */
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
  SchematicText,
  SchematicWire,
  SchGraphic,
  SchPoint,
  SymbolPin,
  SymbolText,
} from "../ir/types.ts";
import { type CiNetlist, parseCiNetlist } from "../ref/ci-netlist.ts";
import { drawnPinNumbers, portPinNumbers } from "../ref/ci-netlist.ts";
import { displayText, docOf, type EwElement, type XmlInput } from "./doc.ts";
import { type PageIndex, parseMultisimDesign, type SheetInstance } from "./ms-hierarchy.ts";

/** Child elements of `n` named `list` > `item` (e.g. `Points` > `Item`). */
const items = (n: EwElement | undefined, list: string, item = "Item"): EwElement[] =>
  n?.child(list)?.childrenNamed(item) ?? [];
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
// Snap to the integer grid when within float noise (transforms carry 1e-7 junk).
const snap = (v: number): number => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : v);
const pt = (x: unknown, y: unknown): SchPoint => ({ x: num(x), y: num(y) });

// ---------------------------------------------------------------------------
// Transforms

interface Affine {
  m00: number; m01: number; m10: number; m11: number; m20: number; m21: number;
}
const IDENTITY: Affine = { m00: 1, m01: 0, m10: 0, m11: 1, m20: 0, m21: 0 };

function affineOf(node: EwElement | undefined): Affine {
  if (!node || node.get("Transformer-M00") === undefined) return IDENTITY;
  return {
    m00: num(node.get("Transformer-M00"), 1), m01: num(node.get("Transformer-M01")),
    m10: num(node.get("Transformer-M10")), m11: num(node.get("Transformer-M11"), 1),
    m20: num(node.get("Transformer-M20")), m21: num(node.get("Transformer-M21")),
  };
}
const apply = (t: Affine, p: SchPoint): SchPoint => ({
  x: snap(p.x * t.m00 + p.y * t.m10 + t.m20),
  y: snap(p.x * t.m01 + p.y * t.m11 + t.m21),
});
const affineScale = (t: Affine) => Math.sqrt(Math.abs(t.m00 * t.m11 - t.m01 * t.m10)) || 1;

const D_ID: Dihedral = { a: 1, b: 0, c: 0, d: 1 };
const mul = (p: Dihedral, q: Dihedral): Dihedral => ({
  a: p.a * q.a + p.c * q.b,
  b: p.b * q.a + p.d * q.b,
  c: p.a * q.c + p.c * q.d,
  d: p.b * q.c + p.d * q.d,
});
export const applyD = (t: Dihedral, p: SchPoint): SchPoint => ({ x: t.a * p.x + t.c * p.y, y: t.b * p.x + t.d * p.y });

/** OrientationFlip -> dihedral (mirror first, then rotate). */
export function flipToDihedral(flip: number): Dihedral {
  const rot: Dihedral[] = [
    D_ID,
    { a: 0, b: 1, c: -1, d: 0 }, // r270: (x, y) -> (-y, x)
    { a: -1, b: 0, c: 0, d: -1 }, // r180
    { a: 0, b: -1, c: 1, d: 0 }, // r90: (x, y) -> (y, -x)
  ];
  let m = D_ID;
  if (flip & 0x100) m = mul({ a: 1, b: 0, c: 0, d: -1 }, m); // mirror y
  if (flip & 0x1000) m = mul({ a: -1, b: 0, c: 0, d: 1 }, m); // mirror x
  return mul(rot[flip & 3]!, m);
}

// ---------------------------------------------------------------------------
// Tree walking

/**
 * `tag` elements under `node`, in document order. Does not descend into a
 * match, nor into elements named in `skip`.
 */
function collect(node: EwElement, tag: string, skip: ReadonlySet<string>): EwElement[] {
  const out: EwElement[] = [];
  const rec = (n: EwElement) => {
    for (const c of n.children) {
      if (c.name === tag) out.push(c);
      else if (!skip.has(c.name)) rec(c);
    }
  };
  rec(node);
  return out;
}

/** `<Item Class=X ID=..><X/>` wrappers under `node` (per `collect`), as [body, wrapper ID]. */
function wrapped(node: EwElement, cls: string, skip: ReadonlySet<string>): [EwElement, string][] {
  const out: [EwElement, string][] = [];
  for (const it of collect(node, "Item", skip)) {
    const body = it.cls === cls ? it.child(cls) : undefined;
    if (body) out.push([body, it.get("ID") ?? ""]);
  }
  return out;
}

/** Direct children of an object's `Objects` list as [class, element, wrapperID]. */
function children(node: EwElement): [string, EwElement, string][] {
  const out: [string, EwElement, string][] = [];
  for (const item of items(node, "Objects")) {
    for (const c of item.children) out.push([c.name, c, item.get("ID") ?? ""]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Graphics

const penWidth = (n: EwElement): number => Math.max(0, num(n?.get("Pen-Width")));
// Windows brush styles: 0 = solid, 1 = hollow.
const filled = (n: EwElement): boolean => String(n?.get("Brush-Style") ?? "1") === "0";

function ellipsePoints(c: SchPoint, rx: number, ry: number): SchPoint[] {
  const out: SchPoint[] = [];
  for (let i = 0; i <= 32; i++) {
    const a = (2 * Math.PI * i) / 32;
    out.push({ x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) });
  }
  return out;
}

/** One drawing object (in its parent's frame after `t`), or undefined if not graphics. */
function graphicOf(cls: string, n: EwElement, parent: Affine, raw = false): SchGraphic | undefined {
  const t = raw ? parent : composeAffine(affineOf(n), parent);
  if (String(n?.get("Hidden") ?? "0") === "1") return undefined;
  const w = penWidth(n);
  switch (cls) {
    case "CODLineComp":
      return { kind: "polyline", points: [apply(t, pt(n.get("pt0X"), n.get("pt0Y"))), apply(t, pt(n.get("pt1X"), n.get("pt1Y")))], width: w, fill: false };
    case "CODMultiLineComp":
    case "CODPolygonComp": {
      const pts = items(n, "Points").map((p) => apply(t, pt(p.get("X"), p.get("Y"))));
      if (pts.length < 2) return undefined;
      if (cls === "CODPolygonComp") pts.push(pts[0]!);
      return { kind: "polyline", points: pts, width: w, fill: cls === "CODPolygonComp" && filled(n) };
    }
    case "CODRectComp": {
      const p0 = pt(n.get("pt0X"), n.get("pt0Y"));
      const p1 = pt(n.get("pt1X"), n.get("pt1Y"));
      const axisAligned = Math.abs(t.m01) < 1e-6 && Math.abs(t.m10) < 1e-6;
      if (axisAligned) return { kind: "rect", a: apply(t, p0), b: apply(t, p1), width: w, fill: filled(n) };
      const corners = [p0, { x: p1.x, y: p0.y }, p1, { x: p0.x, y: p1.y }, p0].map((p) => apply(t, p));
      return { kind: "polyline", points: corners, width: w, fill: filled(n) };
    }
    case "CODEllipseComp": {
      const c = pt(n.get("CenterX"), n.get("CenterY"));
      const r1 = num(n.get("Radius1"));
      const r2 = num(n.get("Radius2"));
      if (Math.abs(r1 - r2) < 1e-6) {
        return { kind: "circle", center: apply(t, c), radius: r1 * affineScale(t), width: w, fill: filled(n) };
      }
      return { kind: "polyline", points: ellipsePoints(c, r1, r2).map((p) => apply(t, p)), width: w, fill: filled(n) };
    }
    case "CIITArcComp":
      return {
        kind: "arc",
        start: apply(t, pt(n.get("StartX"), n.get("StartY"))),
        mid: apply(t, pt(n.get("MiddleX"), n.get("MiddleY"))),
        end: apply(t, pt(n.get("EndX"), n.get("EndY"))),
        width: w,
      };
    case "CODTextComp": {
      const text = displayText(n.str("Output"));
      if (!text) return undefined;
      return { kind: "text", at: apply(t, { x: 0, y: 0 }), text, size: fontSize(n) };
    }
  }
  return undefined;
}

// child then parent: p -> parent(child(p))
function composeAffine(child: Affine, parent: Affine): Affine {
  return {
    m00: child.m00 * parent.m00 + child.m01 * parent.m10,
    m01: child.m00 * parent.m01 + child.m01 * parent.m11,
    m10: child.m10 * parent.m00 + child.m11 * parent.m10,
    m11: child.m10 * parent.m01 + child.m11 * parent.m11,
    m20: child.m20 * parent.m00 + child.m21 * parent.m10 + parent.m20,
    m21: child.m20 * parent.m01 + child.m21 * parent.m11 + parent.m21,
  };
}

/** Multisim font heights are negative pixel heights; map to schematic units. */
const fontSize = (n: EwElement): number => Math.max(4, Math.min(12, Math.abs(num(n?.get("Font-Height"), -13)) * 0.4));

// ---------------------------------------------------------------------------
// Symbols

type PortPins = (portId: string | undefined) => string[];
let portPins: PortPins = () => [];

interface ParsedPin {
  pin: SymbolPin;
  attachIds: string[];
}

function parsePins(pinComp: EwElement, parent: Affine, extraGraphics: SchGraphic[], raw = false, sourceId = ""): { pins: ParsedPin[]; nameHidden: boolean; numberHidden: boolean } {
  const child = (n: EwElement, p: Affine) => (raw ? p : composeAffine(affineOf(n), p));
  const t = child(pinComp, parent);
  let conn: SchPoint | undefined;
  let attachIds: string[] = [];
  const lines: SchPoint[][] = [];
  let nameHidden = true;
  let numberHidden = true;
  for (const [cls, n] of children(pinComp)) {
    if (cls === "CIITPinConnectorComp") {
      conn = apply(child(n, t), pt(n.get("ptCenterX"), n.get("ptCenterY")));
      attachIds = items(n, "ConnectList").map((i) => String(i.get("ID")));
    } else if (cls === "CODLineComp") {
      const tt = child(n, t);
      lines.push([apply(tt, pt(n.get("pt0X"), n.get("pt0Y"))), apply(tt, pt(n.get("pt1X"), n.get("pt1Y")))]);
    } else if (cls === "CIITPinSymTextCompName") {
      if (String(n.get("Hidden") ?? "0") !== "1" && n.str("Output")) nameHidden = false;
    } else if (cls === "CIITPinSymTextCompNumber") {
      if (String(n.get("Hidden") ?? "0") !== "1" && n.str("Output")) numberHidden = false;
    } else {
      const g = graphicOf(cls, n, t, raw);
      if (g) extraGraphics.push(g);
    }
  }
  if (!conn) return { pins: [], nameHidden, numberHidden };

  // The pin line is the one starting (or ending) at the connection point;
  // anything else (clock wedges, inversion marks) is decoration.
  let dir = { x: 0, y: 0 };
  let length = 0;
  for (const [a, b] of lines) {
    const near = (p: SchPoint) => Math.hypot(p.x - conn!.x, p.y - conn!.y) < 0.5;
    const far = near(a) ? b : near(b) ? a : undefined;
    if (far && length === 0) {
      length = Math.hypot(far.x - conn.x, far.y - conn.y);
      if (length > 0) dir = { x: (far.x - conn.x) / length, y: (far.y - conn.y) / length };
    } else {
      extraGraphics.push({ kind: "polyline", points: [a, b], width: 0, fill: false });
    }
  }

  const name = displayText(pinComp.str("PinName"));
  const fromNetlist = portPins(pinComp.get("PortID"));
  const numbers = fromNetlist.length
    ? fromNetlist
    : drawnPinNumbers(pinComp.str("PinNumber"));
  if (numbers.length === 0) numbers.push(name || "?");
  return {
    pins: numbers.map((number) => ({ pin: { name, number, at: conn!, dir, length, netId: sourceId || undefined }, attachIds })),
    nameHidden,
    numberHidden,
  };
}

function symbolText(n: EwElement | undefined, raw: boolean): SymbolText | undefined {
  if (!n) return undefined;
  const text = displayText(n.str("Output"));
  const at = raw ? { x: 0, y: 0 } : apply(affineOf(n), { x: 0, y: 0 });
  return { text, at, hidden: String(n.get("Hidden") ?? "0") === "1" || !text };
}

interface Placed {
  symbol: SchematicSymbol;
  attach: Map<SymbolPin, string[]>;
  fallback: SchPoint; // Transformer-M20/M21, used when no pin is attached
}

function parseSymbolLike(comp: EwElement, raw = false): Placed {
  const graphics: SchGraphic[] = [];
  const parsed: ParsedPin[] = [];
  let anyNameShown = false;
  let anyNumberShown = false;
  let refText: SymbolText | undefined;
  let valueText: SymbolText | undefined;
  for (const [cls, n, id] of children(comp)) {
    switch (cls) {
      case "CIITPinSymbolComp": {
        const r = parsePins(n, IDENTITY, graphics, raw, id);
        parsed.push(...r.pins);
        anyNameShown ||= !r.nameHidden;
        anyNumberShown ||= !r.numberHidden;
        break;
      }
      case "CIITSymTextCompName":
        refText = symbolText(n, raw);
        break;
      case "CIITSymTextCompValue":
        valueText = symbolText(n, raw);
        break;
      case "CIITSymbolBorderRect":
      case "CIITSymTextCompLocation":
        break;
      default: {
        const g = graphicOf(cls, n, IDENTITY, raw);
        if (g) graphics.push(g);
      }
    }
  }
  const attach = new Map<SymbolPin, string[]>();
  for (const p of parsed) attach.set(p.pin, p.attachIds);
  return {
    symbol: {
      reference: refText?.text ?? "",
      value: valueText?.text ?? "",
      kind: "part",
      at: { x: 0, y: 0 },
      transform: flipToDihedral(num(comp.get("OrientationFlip"))),
      graphics,
      pins: parsed.map((p) => p.pin),
      refText,
      valueText,
      showPinNames: anyNameShown,
      showPinNumbers: anyNumberShown,
    },
    attach,
    fallback: pt(comp.get("Transformer-M20"), comp.get("Transformer-M21")),
  };
}

const ALL_DIHEDRALS: Dihedral[] = [
  { a: 1, b: 0, c: 0, d: 1 }, { a: 0, b: -1, c: 1, d: 0 }, { a: -1, b: 0, c: 0, d: -1 }, { a: 0, b: 1, c: -1, d: 0 },
  { a: 1, b: 0, c: 0, d: -1 }, { a: 0, b: 1, c: 1, d: 0 }, { a: -1, b: 0, c: 0, d: 1 }, { a: 0, b: -1, c: -1, d: 0 },
];
const sameD = (p: Dihedral, q: Dihedral) => p.a === q.a && p.b === q.b && p.c === q.c && p.d === q.d;

interface Fit {
  transform: Dihedral;
  at: SchPoint;
  hits: number;
  attached: number;
}

/**
 * Best (orientation, translation) mapping the symbol's pins onto their
 * attachment points. Ties prefer `preferred` (the OrientationFlip reading),
 * then identity.
 */
function fit(p: Placed, pinPts: Map<string, SchPoint>, preferred: Dihedral): Fit | undefined {
  const pairs: [SchPoint, SchPoint][] = [];
  for (const pin of p.symbol.pins) {
    const target = (p.attach.get(pin) ?? []).map((id) => pinPts.get(id)).find(Boolean);
    if (target) pairs.push([pin.at, target]);
  }
  if (pairs.length === 0) return undefined;
  let best: Fit | undefined;
  const order = [preferred, ...ALL_DIHEDRALS.filter((d) => !sameD(d, preferred))];
  for (const d of order) {
    const votes = new Map<string, { off: SchPoint; n: number }>();
    for (const [local, target] of pairs) {
      const l = applyD(d, local);
      const off = { x: snap(target.x - l.x), y: snap(target.y - l.y) };
      const k = `${off.x},${off.y}`;
      const v = votes.get(k);
      if (v) v.n++;
      else votes.set(k, { off, n: 1 });
    }
    const top = [...votes.values()].sort((x, y) => y.n - x.n)[0]!;
    if (!best || top.n > best.hits) best = { transform: d, at: top.off, hits: top.n, attached: pairs.length };
  }
  return best;
}

/** Apply a fit: set placement, and record attach points that the pins miss. */
function applyFit(p: Placed, f: Fit | undefined, pinPts: Map<string, SchPoint>): void {
  const { symbol } = p;
  if (f) {
    symbol.transform = f.transform;
    symbol.at = f.at;
  } else {
    symbol.at = p.fallback;
  }
  for (const pin of symbol.pins) {
    const target = (p.attach.get(pin) ?? []).map((id) => pinPts.get(id)).find(Boolean);
    if (!target) continue;
    const l = applyD(symbol.transform, pin.at);
    if (Math.abs(symbol.at.x + l.x - target.x) > 1e-3 || Math.abs(symbol.at.y + l.y - target.y) > 1e-3) {
      pin.attach = target;
    }
  }
}

/** Placement stats, for the converter summary and the plan's findings. */
export const placementStats = { symbols: 0, pins: 0, pinsOnTarget: 0, raw: 0, composed: 0, unattached: 0 };

/**
 * Multisim stores orientation two ways: rotation baked into each child's
 * transform (with OrientationFlip as a record), or identity children rotated
 * by OrientationFlip around an unrecorded pivot. Parse both readings and keep
 * whichever lands more pins on their wiring attachment points.
 */
function parsePlaced(comp: EwElement, pinPts: Map<string, SchPoint>): Placed {
  const flipD = flipToDihedral(num(comp.get("OrientationFlip")));
  const composed = parseSymbolLike(comp, false);
  const fc = fit(composed, pinPts, { a: 1, b: 0, c: 0, d: 1 });
  const raw = parseSymbolLike(comp, true);
  const fr = fit(raw, pinPts, flipD);
  const useRaw = !!fr && (!fc || fr.hits > fc.hits);
  const chosen = useRaw ? raw : composed;
  const f = useRaw ? fr : fc;
  if (!f) chosen.symbol.transform = { a: 1, b: 0, c: 0, d: 1 };
  applyFit(chosen, f, pinPts);
  placementStats.symbols++;
  if (f) {
    placementStats.pins += f.attached;
    placementStats.pinsOnTarget += f.hits;
    if (useRaw) placementStats.raw++;
    else placementStats.composed++;
  } else {
    placementStats.unattached++;
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Sheet

const SYMBOLISH = new Set([
  "CIITSymbolComp",
  "CIITAnimationSymbolComp",
  "CVirtualConnector",
  "CIITHierConnector",
  "CIITMacroComponent",
  "CIITOffPageConnector",
  "DesignSheet",
  "Background",
]);

const pinMods = (pinComp: EwElement): { mod: string; value: string }[] =>
  (pinComp.at("ElectricalObject", "ModifierInfo")?.childrenNamed("Element") ?? []).flatMap((e) =>
    e.childrenNamed("Item").map((i) => ({ mod: e.str("NetModifier"), value: i.str("Value") })),
  );

/** First pin's net-modifier value of the given kind, for connector-like objects. */
function connectorModValue(comp: EwElement, mod: string): string {
  for (const [cls, n] of children(comp)) {
    if (cls !== "CIITPinSymbolComp") continue;
    const m = pinMods(n).find((x) => x.mod === mod);
    if (m?.value) return m.value;
  }
  return "";
}

/** Union-find over a page's ID graph: id -> net root, plus per-root contents. */
function pageNets(edges: [string, string][], linkIds: string[], pinIds: string[]) {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== r) {
      const n = parent.get(y)!;
      parent.set(y, r);
      y = n;
    }
    return r;
  };
  for (const [a, b] of edges) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const links = new Map<string, number>();
  const pins = new Map<string, number>();
  for (const id of linkIds) links.set(find(id), (links.get(find(id)) ?? 0) + 1);
  for (const id of pinIds) pins.set(find(id), (pins.get(find(id)) ?? 0) + 1);
  // Name each net by its smallest member id, so net ids do not depend on the
  // order edges were visited in.
  const byId = (a: string, b: string) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
  const label = new Map<string, string>();
  for (const id of [...parent.keys(), ...linkIds, ...pinIds]) {
    const r = find(id);
    const cur = label.get(r);
    if (cur === undefined || byId(id, cur) < 0) label.set(r, id);
  }
  return {
    netOf: (id: string | undefined) => (id ? label.get(find(id)) ?? id : undefined),
    /** Nothing else is connected to this pin in Multisim. */
    isolated: (id: string | undefined) => !!id && !links.get(find(id)) && (pins.get(find(id)) ?? 0) <= 1,
  };
}

function parseSheet(designSheet: EwElement, ci: CiNetlist, pageIndex?: PageIndex): SchematicSheet {
  const nets = pageNets(pageIndex?.edges ?? [], pageIndex?.links.map((l) => l.id) ?? [], pageIndex?.pins.map((p) => p.id) ?? []);
  // Sheet-level pin attachment points.
  const pinPts = new Map<string, SchPoint>();
  const pinSkip = new Set(["CIITSymbolComp", "CVirtualConnector", "DesignSheet"]);
  for (const [c, id] of wrapped(designSheet, "CODPinComp", pinSkip)) {
    pinPts.set(id, pt(c.get("CenterX"), c.get("CenterY")));
  }
  // Copy-pasted parts keep stale CODPinComp centres while their wires carry
  // the paste offset in their own transform. Where a wire ends on a pin point
  // (Connect1 = first point, Connect2 = last), that wire end is the truth.
  for (const [l] of wrapped(designSheet, "CIITLinkComp", pinSkip)) {
    const t = affineOf(l);
    const ptsL = items(l, "Points").map((q) => apply(t, pt(q.get("X"), q.get("Y"))));
    if (ptsL.length < 2) continue;
    for (const [attr, p] of [["Connect1", ptsL[0]!], ["Connect2", ptsL[ptsL.length - 1]!]] as const) {
      const id = l.get(attr) ?? "";
      if (id && id !== "0" && pinPts.has(id)) pinPts.set(id, p);
    }
  }

  const symbols: SchematicSymbol[] = [];
  const comps = [
    ...collect(designSheet, "CIITSymbolComp", SYMBOLISH),
    ...collect(designSheet, "CIITAnimationSymbolComp", SYMBOLISH),
  ];
  for (const comp of comps) {
    const placed = parsePlaced(comp, pinPts);
    const ciComp = ci.componentsById.get(String(comp.get("CiComponent") ?? ""));
    if (ciComp?.kind === "power" && placed.symbol.pins.length === 1) {
      placed.symbol.kind = "power";
      // The net it drives: the pin's global modifier (what Multisim joins on).
      placed.symbol.value =
        connectorModValue(comp, "NI_EWB_NET_GLOBAL_GROUND") || connectorModValue(comp, "NI_EWB_NET_GLOBAL") || ciComp.refdes;
    }
    if (!placed.symbol.reference && ciComp) placed.symbol.reference = ciComp.refdes;
    for (const pin of placed.symbol.pins) {
      pin.connected = !nets.isolated(pin.netId);
      pin.netId = nets.netOf(pin.netId);
    }
    if (placed.symbol.kind === "power" && placed.symbol.pins[0] && nets.isolated(placed.symbol.pins[0].netId)) {
      placed.symbol.floating = true;
    }
    if (ciComp) placed.symbol.drawnKey = ciComp.refdes + comp.str("DBComponentSectionName");
    symbols.push(placed.symbol);
  }

  // Named connectors -> labels at their attachment point.
  const labels: SchematicLabel[] = [];
  const connectors: [string, EwElement][] = [];
  for (const cls of ["CVirtualConnector", "CIITHierConnector", "CIITOffPageConnector"]) {
    for (const f of collect(designSheet, cls, SYMBOLISH)) connectors.push([cls, f]);
  }
  for (const [cls, c] of connectors) {
    const placed = parsePlaced(c, pinPts);
    const s = placed.symbol;
    const pin = s.pins[0];
    const name =
      cls === "CIITHierConnector"
        ? connectorModValue(c, "NI_EWB_NET_HIERARCHY") || s.reference
        : cls === "CIITOffPageConnector"
          ? connectorModValue(c, "NI_EWB_NET_OFFPAGE") || s.reference
          : // The net is the pin's modifier value, not the displayed name.
            connectorModValue(c, "NI_EWB_NET_GLOBAL") ||
            connectorModValue(c, "NI_EWB_NET_VIRTUAL") ||
            s.reference ||
            c.str("Name");
    if (!pin || !name) continue;
    const anchorLocal = applyD(s.transform, pin.at);
    const anchor = pin.attach ?? { x: s.at.x + anchorLocal.x, y: s.at.y + anchorLocal.y };
    // Body direction: from the pin toward the body (pin line), in sheet frame.
    const d = applyD(s.transform, pin.dir.x || pin.dir.y ? pin.dir : { x: 1, y: 0 });
    const dir = Math.abs(d.x) >= Math.abs(d.y) ? { x: Math.sign(d.x) || 1, y: 0 } : { x: 0, y: Math.sign(d.y) };
    // Off-page connectors join the pages of one sheet instance; KiCad has no
    // exact equivalent, so they become global labels (only old .ms13 files
    // use them).
    const kind =
      cls === "CIITHierConnector"
        ? "hierarchical"
        : cls === "CIITOffPageConnector" || String(c.get("Global") ?? "1") === "1" || c.str("Type").includes("GLOBAL")
          ? "global"
          : "local";
    labels.push({ name, at: anchor, kind, dir, netId: nets.netOf(pin.netId), floating: nets.isolated(pin.netId) });
  }

  // Hierarchical blocks -> sheet symbols. KiCad sheet pins must sit on the
  // sheet rectangle, so the rectangle spans the block body and its pin tips.
  const blocks: SheetBlock[] = [];
  for (const [m, macroId] of wrapped(designSheet, "CIITMacroComponent", SYMBOLISH)) {
    const placed = parsePlaced(m, pinPts);
    const s = placed.symbol;
    const toSheet = (q: SchPoint) => {
      const l = applyD(s.transform, q);
      return { x: s.at.x + l.x, y: s.at.y + l.y };
    };
    const pts: SchPoint[] = [];
    for (const g of s.graphics) {
      if (g.kind === "rect") pts.push(toSheet(g.a), toSheet(g.b));
      else if (g.kind === "polyline") pts.push(...g.points.map(toSheet));
    }
    const pinNames = new Map<SymbolPin, string>();
    const pinComps = children(m).filter(([cls]) => cls === "CIITPinSymbolComp").map(([, n]) => n);
    s.pins.forEach((pin, i) => {
      const n = pinComps[i];
      const nm = (n && pinMods(n).find((x) => x.mod === "NI_EWB_NET_HIERARCHY_COMP")?.value) || pin.name;
      pinNames.set(pin, nm);
    });
    const pinPos = s.pins.map((pin) => toSheet(pin.at));
    const all = [...pts, ...pinPos];
    if (all.length === 0) continue;
    const a = { x: Math.min(...all.map((q) => q.x)), y: Math.min(...all.map((q) => q.y)) };
    const b = { x: Math.max(...all.map((q) => q.x)), y: Math.max(...all.map((q) => q.y)) };
    blocks.push({
      id: macroId,
      childSheet: m.at("HierBlock", "CHierBlock")?.str("FileName") ?? "",
      a,
      b,
      pins: s.pins.map((pin, i) => ({ name: pinNames.get(pin) ?? pin.name, at: pinPos[i]!, attach: pin.attach })),
    });
  }

  // Wires and user net names.
  const wires: SchematicWire[] = [];
  for (const [l, linkId] of wrapped(designSheet, "CIITLinkComp", SYMBOLISH)) {
    // Links carry their own transform (copy/paste offsets).
    const lt = affineOf(l);
    const points = items(l, "Points").map((p) => apply(lt, pt(p.get("X"), p.get("Y"))));
    if (points.length < 2) continue;
    wires.push({ points, netId: nets.netOf(linkId) });
    for (const el of l.at("ElectricalObject", "ModifierInfo")?.childrenNamed("Element") ?? []) {
      if (el.str("NetModifier") !== "NI_EWB_NET_NAME") continue;
      const name = el.child("Item")?.str("Value") ?? "";
      if (name) labels.push({ name, at: points[0]!, kind: "local", dir: { x: 1, y: 0 }, netId: nets.netOf(linkId) });
    }
  }

  // Buses. Multisim joins a bus entry's wire to the other wires carrying the
  // same bus line name (NI_EWB_NET_BUS_ENTRY) on the sheet; KiCad does the
  // same with a local label of that name at the entry's wire end.
  const modValue = (n: EwElement, mod: string) => pinMods(n).find((m) => m.mod === mod)?.value ?? "";
  // Bus lines live in their own namespace in Multisim: line "SCLK" is not
  // the global net "SCLK". KiCad joins same-named labels and power ports, so
  // a line whose name is already taken on the sheet gets a distinct label.
  // Buses continued on other pages (CBusOffpageConn) join the pages of one
  // sheet instance, like off-page connectors: global labels in KiCad. Their
  // names can't be checked against the other pages here, so they always get
  // the suffix. Net names compare case-insensitively downstream (Ultiboard
  // upper-cases them), so collisions do too.
  const busKind = wrapped(designSheet, "CBusOffpageConn", SYMBOLISH).length ? "global" : "local";
  const taken = new Set(
    [...labels.map((l) => l.name), ...symbols.filter((x) => x.kind === "power").map((x) => x.value)].map((n) => n.toUpperCase()),
  );
  const lineLabel = (line: string) => (busKind === "global" || taken.has(line.toUpperCase()) ? `${line}_BUS` : line);
  const buses: SchematicBus[] = [];
  for (const [b] of wrapped(designSheet, "CIITBusCompV8", SYMBOLISH)) {
    const bt = affineOf(b);
    const points = items(b, "Points").map((p) => apply(bt, pt(p.get("X"), p.get("Y"))));
    if (points.length < 2) continue;
    const members = (b.child("MapBusLine2NetName")?.childrenNamed("Element") ?? []).map((e) => e.str("Key")).filter(Boolean);
    buses.push({ points, name: modValue(b, "NI_EWB_NET_VIRTUAL"), members: members.map(lineLabel) });
  }
  const busEntries: SchematicBusEntry[] = [];
  for (const [e, id] of wrapped(designSheet, "CIITBusEntry", SYMBOLISH)) {
    const et = affineOf(e);
    let conn: SchPoint | undefined;
    let line: [SchPoint, SchPoint] | undefined;
    for (const [cls, n] of children(e)) {
      const t = composeAffine(affineOf(n), et);
      if (cls === "CIITPinConnectorComp") conn = apply(t, pt(n.get("ptCenterX"), n.get("ptCenterY")));
      else if (cls === "CODLineComp") line = [apply(t, pt(n.get("pt0X"), n.get("pt0Y"))), apply(t, pt(n.get("pt1X"), n.get("pt1Y")))];
    }
    const member = modValue(e, "NI_EWB_NET_BUS_ENTRY");
    if (!line || !member) continue;
    // The wire end is the stub end at the entry's connector.
    const d = (p: SchPoint) => (conn ? Math.hypot(p.x - conn.x, p.y - conn.y) : 0);
    const [wire, bus] = d(line[0]) <= d(line[1]) ? line : [line[1], line[0]];
    busEntries.push({ wire, bus, member: lineLabel(member) });
    labels.push({ name: lineLabel(member), at: wire, kind: busKind, dir: { x: wire.x < bus.x ? -1 : 1, y: 0 }, netId: nets.netOf(id) });
  }

  // Free text on the sheet (not inside symbols / the title block).
  const texts: SchematicText[] = [];
  for (const t of collect(designSheet, "CODTextComp", SYMBOLISH)) {
    const text = displayText(t.str("Output"));
    if (text && String(t.get("Hidden") ?? "0") !== "1") texts.push({ text, at: apply(affineOf(t), { x: 0, y: 0 }), size: fontSize(t) });
  }

  // Page size: WorkArea is nm at the nominal 0.25 mm/unit; else fit content.
  const nmPerUnit = 250_000;
  let width = (num(designSheet.get("WorkAreaRight")) - num(designSheet.get("WorkAreaLeft"))) / nmPerUnit;
  let height = (num(designSheet.get("WorkAreaTop")) - num(designSheet.get("WorkAreaBottom"))) / nmPerUnit;
  if (!(width > 0 && height > 0)) {
    const xs = wires.flatMap((w) => w.points.map((p) => p.x)).concat(symbols.map((s) => s.at.x));
    const ys = wires.flatMap((w) => w.points.map((p) => p.y)).concat(symbols.map((s) => s.at.y));
    width = Math.max(1188, ...xs.map((x) => x + 40));
    height = Math.max(840, ...ys.map((y) => y + 40));
  }

  const title = designSheet.str("Title");
  const page = designSheet.str("PageName") || "1";
  return {
    name: title,
    title,
    page,
    blocks,
    size: { width, height },
    symbols,
    wires,
    labels,
    texts,
    buses,
    busEntries,
  };
}

function toSchInstance(inst: SheetInstance, sheets: SchematicSheet[], design: ReturnType<typeof parseMultisimDesign>): SchInstance {
  const refdes: Record<string, string> = {};
  const pinRemaps: Record<string, Record<string, string>> = {};
  const units: Record<string, number> = {};
  for (const sh of sheets.filter((x) => x.title === inst.sheet)) {
    for (const sym of sh.symbols) {
      if (!sym.drawnKey) continue;
      const final = design.finalRefdes(inst, sh.page, sym.drawnKey);
      if (final) refdes[`${sh.page}|${sym.drawnKey}`] = final;
      const remap = design.pinRemap(inst, sh.page, sym.drawnKey);
      if (remap) pinRemaps[`${sh.page}|${sym.drawnKey}`] = Object.fromEntries(remap);
      const unit = design.finalUnit(inst, sh.page, sym.drawnKey);
      if (unit) units[`${sh.page}|${sym.drawnKey}`] = unit;
    }
  }
  return {
    sheet: inst.sheet,
    name: inst.finalName,
    blockId: inst.macroId,
    parentPage: inst.parentPage,
    refdes,
    pinRemaps,
    units,
    children: inst.children.map((c) => toSchInstance(c, sheets, design)),
  };
}

export function parseSchematicXml(input: XmlInput): Schematic {
  const doc = docOf(input);
  if (doc.application === "ultiboard") {
    throw new Error("input is an Ultiboard PCB; use the PCB converter (parsePcbXml)");
  }
  if (doc.application !== "multisim") throw new Error("not a Multisim schematic XML file");
  const root = doc.root;

  const creator = root.at("history", "creator");
  const project = root.child("Project");
  const designSheets = (project?.at("UniqueSheets", "SheetInfos")?.childrenNamed("SheetContainer") ?? [])
    .map((sc) => sc.at("Sheet", "Variable", "DesignSheet"))
    .filter((ds): ds is EwElement => ds != null);
  if (designSheets.length === 0) throw new Error("no DesignSheet element found");

  const ci = parseCiNetlist(doc);
  const design = parseMultisimDesign(doc);
  portPins = (portId) => {
    const port = portId ? design.ci.get(portId) : undefined;
    return port ? portPinNumbers(port.body) : [];
  };
  const sheets = designSheets.map((ds) => {
    const title = ds.str("Title");
    const page = ds.str("PageName") || "1";
    return parseSheet(ds, ci, design.pages.find((p) => p.title === title && p.page === page));
  });
  const rootSheet = design.rootTitle || sheets[0]!.title;

  return {
    source: {
      application: creator?.get("application") ?? "unknown",
      versionMajor: num(creator?.get("versionMajor")),
      versionMinor: num(creator?.get("versionMinor")),
      schema: num(root.get("Schema")),
    },
    projectName: project?.str("Name") ?? "",
    rootSheet,
    sheets,
    root: toSchInstance(design.root, sheets, design),
  };
}
