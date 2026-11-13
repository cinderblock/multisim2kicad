import type {
  Board,
  BoardText,
  Component,
  ComponentText,
  EwLayer,
  Hole,
  Net,
  Pad,
  PadShape,
  Point,
  RuleArea,
  Shape,
  Stackup,
  Track,
  Via,
  Zone,
} from "../ir/types.ts";
import { displayText, docOf, type EwElement, type XmlInput } from "./doc.ts";
import { points, primitiveOutline, ubPrimitive, UB_PRIMITIVE_TAGS } from "./ub-geom.ts";

/** Named children of a named child: `kids(n, "Object", "Point")`. */
const kids = (n: EwElement | undefined, list: string, item: string): EwElement[] =>
  n?.child(list)?.childrenNamed(item) ?? [];

const SHAPE_TAGS = new Set([
  "Polyline",
  "Rectangle",
  "RoundedRectangle",
  "Ellipse",
  "Arc",
]);

const toPoints = points;

function toShape(tag: string, item: EwElement): Shape | undefined {
  const layer = Number(item.get("Layer") ?? -1);
  const thickness = Number(item.get("LineThickness") ?? 0);
  const points = toPoints(item);
  switch (tag) {
    case "Polyline":
      return { kind: "polyline", layer, thickness, points };
    case "Rectangle":
      return { kind: "rectangle", layer, thickness, points };
    case "RoundedRectangle":
      return {
        kind: "roundRect",
        layer,
        thickness,
        points,
        radius: Number(item.get("Radius") ?? 0),
      };
    case "Ellipse":
      return { kind: "ellipse", layer, thickness, points };
    case "Arc": {
      // CDrawArc: [start, end, centre], counter-clockwise like UBArc.
      if (points.length < 3) return undefined;
      const [start, end, center] = points as [Point, Point, Point];
      return { kind: "arc", layer, thickness, start, end, center };
    }
  }
  return undefined;
}

function toTrack(item: EwElement): Track | undefined {
  const layer = Number(item.get("Layer") ?? -1);
  const thickness = Number(item.get("LineThickness") ?? 0);
  const pts = kids(item, "Object", "Point");
  if (pts.length < 2) return undefined;
  return {
    layer,
    thickness,
    start: { x: Number(pts[0]!.get("X")), y: Number(pts[0]!.get("Y")) },
    end: { x: Number(pts[1]!.get("X")), y: Number(pts[1]!.get("Y")) },
  };
}

// Collect the (possibly multiple) Attribute children directly owned by a
// component or pin: ...ExtentableObject > AttributeInterface > Containers >
// AttributeContainer > Store > DataTreeContainer > Attribute. Scoped so a
// component's own REFDES/VALUE don't get mixed with its pins' NUMBER.
function ownAttributes(node: EwElement): Map<string, string> {
  const m = new Map<string, string>();
  const container = node.at("ExtentableObject", "AttributeInterface", "Containers", "AttributeContainer");
  for (const a of container?.at("Store", "DataTreeContainer")?.childrenNamed("Attribute") ?? []) {
    const tag = a.str("Tag");
    if (tag) m.set(tag, displayText(a.str("Value")));
  }
  return m;
}

/** `tag` elements under `node` in document order, not descending into matches. */
function collectByTag(node: EwElement | undefined, tag: string): EwElement[] {
  const out: EwElement[] = [];
  const rec = (n: EwElement) => {
    for (const c of n.children) {
      if (c.name === tag) out.push(c);
      else rec(c);
    }
  };
  if (node) rec(node);
  return out;
}

const PAD_TAGS = [
  "LayoutPadRound",
  "LayoutPadSquare",
  "LayoutPadRoundedSquare",
  "LayoutPadRectangle",
  "LayoutPadRoundedRectangle",
  "LayoutPadCustom",
] as const;

// Lamination is a 64-bit layer mask (bit 0 = Top, bit 63 = Bottom); keep it
// as a BigInt, the values don't fit a JS number.
const TOP_BIT = 1n;
const ALL_LAYERS = 0xffffffffffffffffn;
const lamination = (v: unknown): bigint => {
  if (v == null) return ALL_LAYERS;
  try {
    return BigInt(String(v));
  } catch {
    return ALL_LAYERS;
  }
};

interface PadGeom {
  shape: PadShape;
  center: Point;
  rotation: number;
}

// One pad-shape container (holding a LayoutPad* element) -> shape + centre + rotation.
function parsePadElement(container: EwElement | undefined): PadGeom | undefined {
  if (!container) return undefined;
  for (const tag of PAD_TAGS) {
    const p = container.child(tag);
    if (!p) continue;
    const center = { x: Number(p.get("CenterX") ?? 0), y: Number(p.get("CenterY") ?? 0) };
    const rotation = Number(p.get("Rotation") ?? 0);
    const w = 2 * Number(p.get("HalfWidth") ?? 0);
    const h = 2 * Number(p.get("HalfHeight") ?? p.get("HalfWidth") ?? 0);
    const r = Number(p.get("Radius") ?? 0);
    switch (tag) {
      case "LayoutPadRound":
        return { shape: { kind: "circle", diameter: 2 * r }, center, rotation };
      case "LayoutPadSquare":
        return { shape: { kind: "rect", width: w, height: w }, center, rotation };
      case "LayoutPadRoundedSquare":
        return { shape: { kind: "roundrect", width: w, height: w, cornerRadius: r }, center, rotation };
      case "LayoutPadRectangle":
        return { shape: { kind: "rect", width: w, height: h }, center, rotation };
      case "LayoutPadRoundedRectangle":
        return { shape: { kind: "roundrect", width: w, height: h, cornerRadius: r }, center, rotation };
      case "LayoutPadCustom": {
        // Custom shape = a CLayoutPadShape group of UB primitives in absolute
        // coordinates (already rotated), so the pad itself is emitted unrotated.
        const prims = [];
        for (const ptag of UB_PRIMITIVE_TAGS) {
          for (const it of collectByTag(p.child("Custom"), ptag)) {
            const prim = ubPrimitive(ptag, it);
            if (prim) prims.push(prim);
          }
        }
        if (prims.length === 0) return undefined;
        return { shape: { kind: "custom", primitives: prims }, center, rotation: 0 };
      }
    }
  }
  return undefined;
}

// THT pins carry one LamPad per layer set (a pad stack). Until padstacks are
// emitted, use the pad that covers the top layer (else the first).
function pickLamPad(lamPads: EwElement[]): EwElement | undefined {
  return lamPads.find((lp) => (lamination(lp?.get("Lamination")) & TOP_BIT) !== 0n) ?? lamPads[0];
}

function parsePin(pin: EwElement, bottom: boolean, tht: boolean): Pad | undefined {
  const container = tht ? pickLamPad(pin.childrenNamed("LamPad")) : pin.child("Pad");
  const geom = parsePadElement(container);
  if (!geom) return undefined;
  const drill = pin.child("LayoutDrillObject");
  return {
    number: ownAttributes(pin).get("NUMBER") ?? "",
    at: geom.center,
    rotation: geom.rotation,
    shape: geom.shape,
    drillDiameter: tht && drill ? 2 * Number(drill.get("Drill-Radius") ?? 0) : 0,
    side: tht ? "both" : bottom ? "bottom" : "top",
  };
}

const PIN_TAGS: readonly [string, boolean][] = [
  ["Through-Board-Pin", true],
  ["SMT-Pin", false],
  ["NetBridge-Pin", false],
];

/** Attribute elements owned directly by a component or pin (see ownAttributes). */
function ownAttributeElements(node: EwElement): EwElement[] {
  const container = node.at("ExtentableObject", "AttributeInterface", "Containers", "AttributeContainer");
  return container?.at("Store", "DataTreeContainer")?.childrenNamed("Attribute") ?? [];
}

/**
 * Bookkeeping attributes (library ids, schematic links, variants): never
 * shown as text in KiCad. Anything else visible in EW becomes footprint text.
 */
const INTERNAL_ATTRS = new Set([
  "GUID", "LIBRARYTREEID", "SCHEMATICSECTIONS", "SCHEMATICVARIANTS", "DONOTANNOTATE", "NETBRIDGE",
  "SHAPE", "PACKAGE", "DEVICE",
]);

/** EW `Visibility`: 0 shown, 2 hidden. */
const shown = (attr: EwElement) => attr.numOr("Visibility", 0) === 0;

function componentTexts(comp: EwElement): ComponentText[] {
  const out: ComponentText[] = [];
  for (const a of ownAttributeElements(comp)) {
    const tag = a.str("Tag");
    const keep = tag === "REFDES" || tag === "VALUE" || (shown(a) && !INTERNAL_ATTRS.has(tag));
    const t = keep ? toText(a) : undefined;
    if (t) out.push({ ...t, tag, visible: shown(a) });
  }
  return out;
}

function parseComponent(comp: EwElement): Component {
  const attrs = ownAttributes(comp);
  const name = displayText(comp.str("Name"));
  const bottom = Number(comp.get("Bottom") ?? 0) !== 0;
  const pads: Pad[] = [];
  for (const [tag, tht] of PIN_TAGS) {
    for (const pin of collectByTag(comp.child("Group"), tag)) {
      const pad = parsePin(pin, bottom, tht);
      if (pad) pads.push(pad);
    }
  }
  const rp = comp.child("Group")?.child("RefPoint");
  const origin = rp
    ? { x: Number(rp.get("X")), y: Number(rp.get("Y")) }
    : (pads[0]?.at ?? { x: 0, y: 0 });
  return {
    reference: attrs.get("REFDES") || name || "REF**",
    value: attrs.get("VALUE") || name || "",
    name,
    origin,
    rotation: Number(comp.get("Rotation") ?? 0),
    bottom,
    pads,
    graphics: [],
    texts: componentTexts(comp),
  };
}

function parseNets(node: EwElement): Net[] {
  const netList = node.find("UbNetList");
  if (!netList) return [];
  return netList.childrenNamed("UBNet").map((n) => ({
    name: n.str("Name"),
    pins: kids(n, "Pins", "UBNetPin").map((p) => ({
      refdes: p.str("Refdes"),
      pin: p.str("Pin"),
    })),
  }));
}

interface Collected {
  shapes: Shape[];
  tracks: Track[];
  components: Component[];
  holes: Hole[];
  vias: Via[];
  zones: Zone[];
  texts: BoardText[];
  ruleAreas: RuleArea[];
}

const emptyCollected = (): Collected => ({
  shapes: [], tracks: [], components: [], holes: [], vias: [], zones: [], texts: [], ruleAreas: [],
});

/** Copper pour settings shared by power planes and copper areas. */
function toZone(kind: Zone["kind"], item: EwElement, outline: Point[]): Zone {
  const ext = item.child("UBExtension");
  return {
    kind,
    layer: item.numOr("Layer", -1),
    netName: item.str("NetName"),
    outline,
    clearance: ext?.num("Clearance") ?? 0,
    minThickness: item.numOr("LineThickness", 0),
    reliefSpokeWidth: item.numOr("ReliefSpokeWidth", 0),
    thermalReliefStyle: item.numOr("ThermalReliefStyle", 0),
    removeIslands: item.bool("RemoveSmallIslands") ?? false,
    islandArea: item.numOr("RemoveIslandSize", 0),
    removeNotEdgeConnected: item.bool("RemoveNotEdgeConnectedIslands") ?? false,
  };
}

const RULE_LAYER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Size", "Seven"]; // sic: "Size"

function toRuleArea(item: EwElement): RuleArea | undefined {
  const outline = points(item);
  if (outline.length < 3) return undefined;
  const groups = item.child("NetGroups");
  return {
    type: item.numOr("RuleAreaType", 0),
    outline,
    activeLayers: RULE_LAYER_WORDS.map((w) => BigInt.asUintN(64, item.bigint(`ActiveLayers${w}`) ?? 0n)),
    allNets: groups ? groups.bool("All") ?? false : true,
    nets: groups?.childrenNamed("CompGroup").map((g) => g.str("Group")) ?? [],
  };
}

function toText(item: EwElement): BoardText | undefined {
  const text = displayText(item.str("Value"));
  const fmt = item.child("TXTFormat");
  if (!text || !fmt) return undefined;
  // The Object points are the text's bounding box; its centre is where the
  // text sits whatever the alignment code. Hidden attributes carry a
  // collapsed (single point) box that is not near the part; use the
  // reference point for those.
  const box = points(item);
  const xs = box.map((p) => p.x);
  const ys = box.map((p) => p.y);
  const real = box.length >= 4 && Math.max(...xs) > Math.min(...xs) && Math.max(...ys) > Math.min(...ys);
  const at = real
    ? { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
    : { x: fmt.numOr("RefPointX", 0), y: fmt.numOr("RefPointY", 0) };
  return {
    layer: item.numOr("Layer", -1),
    text,
    at,
    angle: fmt.numOr("Angle", 0),
    mirror: fmt.bool("Mirror") ?? false,
    width: fmt.numOr("HorizontalSize", 0),
    height: fmt.numOr("VerticalSize", 0),
    strokeWidth: item.numOr("LineThickness", 0),
  };
}

const UB_AREA_TAGS = new Set(UB_PRIMITIVE_TAGS);

function parseVia(item: EwElement): Via | undefined {
  const pt = kids(item, "Object", "Point")[0];
  const drill = item.child("LayoutDrillObject");
  if (!pt || !drill) return undefined;
  const pad = parsePadElement(item.child("Pad"));
  const drillDiameter = 2 * Number(drill.get("Drill-Radius") ?? 0);
  const diameter = pad?.shape.kind === "circle" ? pad.shape.diameter : drillDiameter + 300_000;
  const netName = item.str("NetName");
  return {
    at: { x: Number(pt.get("X")), y: Number(pt.get("Y")) },
    drillDiameter,
    diameter,
    netName: netName || undefined,
  };
}

function walkGeometry(node: EwElement, out: Collected, inComponent = false): void {
  for (const item of node.children) {
    const key = item.name;
    if (SHAPE_TAGS.has(key)) {
      const s = toShape(key, item);
      if (s) out.shapes.push(s);
      walkGeometry(item, out, inComponent);
    } else if (key === "UBPowerPlane") {
      const outline = points(item);
      if (outline.length >= 3) out.zones.push(toZone("plane", item, outline));
    } else if (UB_AREA_TAGS.has(key) && !inComponent) {
      // Board-level copper area (component-level ones are pad shapes).
      const prim = ubPrimitive(key, item);
      const outline = prim && primitiveOutline(prim);
      if (outline && outline.length >= 3) out.zones.push(toZone("area", item, outline));
    } else if (key === "LayoutRuleArea" && !inComponent) {
      const r = toRuleArea(item);
      if (r) out.ruleAreas.push(r);
    } else if (key === "UBAttribute" && !inComponent) {
      if (item.str("Tag") === "TEXT") {
        const t = toText(item);
        if (t) out.texts.push(t);
      }
    } else if (key === "UBTrack") {
      const t = toTrack(item);
      if (t) out.tracks.push(t);
    } else if (key === "UBComponent") {
      // The part's own drawings belong to its footprint; anything else found
      // inside (tracks, vias, drills, planes) stays board-level.
      const comp = parseComponent(item);
      const inner = emptyCollected();
      walkGeometry(item, inner, true);
      comp.graphics = inner.shapes;
      out.components.push(comp, ...inner.components);
      out.tracks.push(...inner.tracks);
      out.holes.push(...inner.holes);
      out.vias.push(...inner.vias);
      out.zones.push(...inner.zones);
    } else if (key === "RegularVia") {
      const v = parseVia(item);
      if (v) out.vias.push(v);
    } else if (key === "LayoutDrillObject") {
      // Only free-standing drills become board-level holes; drills with
      // Stand-Alone="0" belong to a THT pin and are parsed via parsePin.
      if (String(item.get("Stand-Alone")) !== "1") continue;
      const pt = kids(item, "Object", "Point")[0];
      if (!pt) continue;
      out.holes.push({
        at: { x: Number(pt.get("X")), y: Number(pt.get("Y")) },
        drillDiameter: 2 * Number(item.get("Drill-Radius") ?? 0),
        plated: Number(item.get("Plated") ?? 0) !== 0,
      });
    } else {
      walkGeometry(item, out, inComponent);
    }
  }
}

/** Copper stack from the board settings: N lamination pairs = 2N layers. */
function parseStackup(designSheet: EwElement): Stackup {
  const bs = designSheet.find("BoardLayerSettings");
  const pairs = Math.max(1, bs?.numOr("LayerLaminationPairQuantity", 1) ?? 1);
  const inner = Array.from({ length: Math.min(2 * pairs - 2, 62) }, (_, i) => i + 1);
  return { copper: [0, ...inner, 63], thickness: bs?.numOr("BoardThickness", 1_600_000) ?? 1_600_000 };
}

export function parsePcbXml(input: XmlInput): Board {
  const doc = docOf(input);
  if (doc.application === "multisim") {
    throw new Error("input is a Multisim schematic; use the schematic converter (parseSchematicXml)");
  }
  if (doc.application !== "ultiboard") throw new Error("not an Electronics Workbench XML file");
  const root = doc.root;

  const creator = root.at("history", "creator");
  const project = root.child("Project");
  const projectName = project?.str("Name") ?? "";

  const sheetContainer = project?.at("UniqueSheets", "SheetInfos")?.child("SheetContainer");
  const designSheet = sheetContainer?.at("Sheet", "Variable", "DesignSheet");
  if (!designSheet) throw new Error("no DesignSheet element found");

  const sheetTitle = designSheet.str("Title");
  const workArea = {
    left: Number(designSheet.get("WorkAreaLeft") ?? 0),
    bottom: Number(designSheet.get("WorkAreaBottom") ?? 0),
    right: Number(designSheet.get("WorkAreaRight") ?? 0),
    top: Number(designSheet.get("WorkAreaTop") ?? 0),
  };

  const layerDef = designSheet.find("LayoutLayerDefinition");
  const layerNodes = layerDef?.childrenNamed("LayerInfo") ?? [];
  const layers: EwLayer[] = layerNodes.map((node) => ({
    number: Number(node.get("Number")),
    name: node.str("Name"),
    description: node.str("UserDescription") || undefined,
    state: Number(node.get("State") ?? 0),
    rgb: Number(node.get("RGB") ?? 0),
  }));

  const collected = emptyCollected();
  walkGeometry(designSheet, collected);

  return {
    source: {
      application: creator?.get("application") ?? "unknown",
      versionMajor: Number(creator?.get("versionMajor") ?? 0),
      versionMinor: Number(creator?.get("versionMinor") ?? 0),
      schema: Number(root.get("Schema") ?? 0),
    },
    projectName,
    sheetTitle,
    workArea,
    layers,
    stackup: parseStackup(designSheet),
    zones: collected.zones,
    texts: collected.texts,
    ruleAreas: collected.ruleAreas,
    shapes: collected.shapes,
    tracks: collected.tracks,
    components: collected.components,
    holes: collected.holes,
    vias: collected.vias,
    nets: parseNets(root),
  };
}
