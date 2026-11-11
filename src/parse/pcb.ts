import { XMLParser } from "fast-xml-parser";
import type {
  Board,
  Component,
  EwLayer,
  Hole,
  Net,
  Pad,
  PadShape,
  Point,
  Shape,
  Track,
  Via,
} from "../ir/types.ts";
import { ubPrimitive, UB_PRIMITIVE_TAGS } from "./ub-geom.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

const stripAsc = (s: string | undefined): string =>
  s?.startsWith("&ASC") ? s.slice(4) : (s ?? "");

const arr = <T,>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

function findFirst(obj: any, key: string): any {
  if (obj == null || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    if (v == null || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = findFirst(x, key);
        if (r !== undefined) return r;
      }
    } else {
      const r = findFirst(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

const SHAPE_TAGS = new Set([
  "Polyline",
  "Rectangle",
  "RoundedRectangle",
  "Ellipse",
]);

function toPoints(item: any): Point[] {
  return arr(item?.Object?.Point).map((p: any) => ({
    x: Number(p["@_X"] ?? 0),
    y: Number(p["@_Y"] ?? 0),
  }));
}

function toShape(tag: string, item: any): Shape | undefined {
  const layer = Number(item["@_Layer"] ?? -1);
  const thickness = Number(item["@_LineThickness"] ?? 0);
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
        radius: Number(item["@_Radius"] ?? 0),
      };
    case "Ellipse":
      return { kind: "ellipse", layer, thickness, points };
  }
  return undefined;
}

function toTrack(item: any): Track | undefined {
  const layer = Number(item["@_Layer"] ?? -1);
  const thickness = Number(item["@_LineThickness"] ?? 0);
  const pts = arr(item?.Object?.Point);
  if (pts.length < 2) return undefined;
  return {
    layer,
    thickness,
    start: { x: Number(pts[0]["@_X"]), y: Number(pts[0]["@_Y"]) },
    end: { x: Number(pts[1]["@_X"]), y: Number(pts[1]["@_Y"]) },
  };
}

// Collect the (possibly multiple) Attribute children directly owned by a
// component or pin: ...ExtentableObject > AttributeInterface > Containers >
// AttributeContainer > Store > DataTreeContainer > Attribute. Scoped so a
// component's own REFDES/VALUE don't get mixed with its pins' NUMBER.
function ownAttributes(node: any): Map<string, string> {
  const m = new Map<string, string>();
  const container = node?.ExtentableObject?.AttributeInterface?.Containers?.AttributeContainer;
  for (const a of arr(container?.Store?.DataTreeContainer?.Attribute)) {
    const tag = stripAsc(a["@_Tag"]);
    if (tag) m.set(tag, stripAsc(a["@_Value"]));
  }
  return m;
}

function collectByTag(node: any, tag: string, out: any[]): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) collectByTag(c, tag, out);
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (key === tag) {
      for (const item of arr(val as any)) out.push(item);
    } else {
      collectByTag(val, tag, out);
    }
  }
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
function parsePadElement(container: any): PadGeom | undefined {
  if (!container) return undefined;
  for (const tag of PAD_TAGS) {
    const p = container[tag];
    if (!p) continue;
    const center = { x: Number(p["@_CenterX"] ?? 0), y: Number(p["@_CenterY"] ?? 0) };
    const rotation = Number(p["@_Rotation"] ?? 0);
    const w = 2 * Number(p["@_HalfWidth"] ?? 0);
    const h = 2 * Number(p["@_HalfHeight"] ?? p["@_HalfWidth"] ?? 0);
    const r = Number(p["@_Radius"] ?? 0);
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
          const items: any[] = [];
          collectByTag(p.Custom, ptag, items);
          for (const it of items) {
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
function pickLamPad(lamPads: any[]): any {
  return lamPads.find((lp) => (lamination(lp?.["@_Lamination"]) & TOP_BIT) !== 0n) ?? lamPads[0];
}

function parsePin(pin: any, bottom: boolean, tht: boolean): Pad | undefined {
  const container = tht ? pickLamPad(arr(pin?.LamPad)) : arr(pin?.Pad)[0];
  const geom = parsePadElement(container);
  if (!geom) return undefined;
  const drill = pin?.LayoutDrillObject;
  return {
    number: ownAttributes(pin).get("NUMBER") ?? "",
    at: geom.center,
    rotation: geom.rotation,
    shape: geom.shape,
    drillDiameter: tht && drill ? 2 * Number(drill["@_Drill-Radius"] ?? 0) : 0,
    side: tht ? "both" : bottom ? "bottom" : "top",
  };
}

const PIN_TAGS: readonly [string, boolean][] = [
  ["Through-Board-Pin", true],
  ["SMT-Pin", false],
  ["NetBridge-Pin", false],
];

function parseComponent(comp: any): Component {
  const attrs = ownAttributes(comp);
  const name = stripAsc(comp["@_Name"]);
  const bottom = Number(comp["@_Bottom"] ?? 0) !== 0;
  const pads: Pad[] = [];
  for (const [tag, tht] of PIN_TAGS) {
    const pins: any[] = [];
    collectByTag(comp.Group, tag, pins);
    for (const pin of pins) {
      const pad = parsePin(pin, bottom, tht);
      if (pad) pads.push(pad);
    }
  }
  const rp = arr(comp.Group?.RefPoint)[0];
  const origin = rp
    ? { x: Number(rp["@_X"]), y: Number(rp["@_Y"]) }
    : (pads[0]?.at ?? { x: 0, y: 0 });
  return {
    reference: attrs.get("REFDES") || name || "REF**",
    value: attrs.get("VALUE") || name || "",
    name,
    origin,
    rotation: Number(comp["@_Rotation"] ?? 0),
    bottom,
    pads,
  };
}

function parseNets(node: any): Net[] {
  const netList = findFirst(node, "UbNetList");
  if (!netList) return [];
  return arr(netList.UBNet).map((n: any) => ({
    name: stripAsc(n["@_Name"]),
    pins: arr(n.Pins?.UBNetPin).map((p: any) => ({
      refdes: stripAsc(p["@_Refdes"]),
      pin: stripAsc(p["@_Pin"]),
    })),
  }));
}

interface Collected {
  shapes: Shape[];
  tracks: Track[];
  components: Component[];
  holes: Hole[];
  vias: Via[];
}

function parseVia(item: any): Via | undefined {
  const pt = arr(item?.Object?.Point)[0];
  const drill = item?.LayoutDrillObject;
  if (!pt || !drill) return undefined;
  const pad = parsePadElement(arr(item?.Pad)[0]);
  const drillDiameter = 2 * Number(drill["@_Drill-Radius"] ?? 0);
  const diameter = pad?.shape.kind === "circle" ? pad.shape.diameter : drillDiameter + 300_000;
  const netName = stripAsc(item["@_NetName"]);
  return {
    at: { x: Number(pt["@_X"]), y: Number(pt["@_Y"]) },
    drillDiameter,
    diameter,
    netName: netName || undefined,
  };
}

function walkGeometry(node: any, out: Collected): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) walkGeometry(c, out);
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (SHAPE_TAGS.has(key)) {
      for (const item of arr(val as any)) {
        const s = toShape(key, item);
        if (s) out.shapes.push(s);
        walkGeometry(item, out);
      }
    } else if (key === "UBTrack") {
      for (const item of arr(val as any)) {
        const t = toTrack(item);
        if (t) out.tracks.push(t);
      }
    } else if (key === "UBComponent") {
      for (const item of arr(val as any)) {
        out.components.push(parseComponent(item));
        walkGeometry(item, out); // still collect silk shapes inside the component
      }
    } else if (key === "RegularVia") {
      for (const item of arr(val as any)) {
        const v = parseVia(item);
        if (v) out.vias.push(v);
      }
    } else if (key === "LayoutDrillObject") {
      // Only free-standing drills become board-level holes; drills with
      // Stand-Alone="0" belong to a THT pin and are parsed via parsePin.
      for (const item of arr(val as any)) {
        if (String(item["@_Stand-Alone"]) !== "1") continue;
        const pt = arr(item?.Object?.Point)[0];
        if (!pt) continue;
        out.holes.push({
          at: { x: Number(pt["@_X"]), y: Number(pt["@_Y"]) },
          drillDiameter: 2 * Number(item["@_Drill-Radius"] ?? 0),
          plated: Number(item["@_Plated"] ?? 0) !== 0,
        });
      }
    } else {
      walkGeometry(val, out);
    }
  }
}

export function parsePcbXml(xml: string): Board {
  const tree = parser.parse(xml);

  if (tree.MSMElectronicsWorkbench) {
    throw new Error(
      "input is a Multisim schematic; schematic conversion is phase 3 (not implemented)",
    );
  }

  const root = tree.ElectronicsWorkbench;
  if (!root) throw new Error("not an Electronics Workbench XML file");

  const creator = root.history?.creator ?? {};
  const project = root.Project ?? {};
  const projectName = stripAsc(project["@_Name"]);

  const sheetContainer = arr(project.UniqueSheets?.SheetInfos?.SheetContainer)[0];
  const designSheet = sheetContainer?.Sheet?.Variable?.DesignSheet;
  if (!designSheet) throw new Error("no DesignSheet element found");

  const sheetTitle = stripAsc(designSheet["@_Title"]);
  const workArea = {
    left: Number(designSheet["@_WorkAreaLeft"] ?? 0),
    bottom: Number(designSheet["@_WorkAreaBottom"] ?? 0),
    right: Number(designSheet["@_WorkAreaRight"] ?? 0),
    top: Number(designSheet["@_WorkAreaTop"] ?? 0),
  };

  const layerDef = findFirst(designSheet, "LayoutLayerDefinition");
  const layerNodes = arr(layerDef?.LayerInfo);
  const layers: EwLayer[] = layerNodes.map((node: any) => ({
    number: Number(node["@_Number"]),
    name: stripAsc(node["@_Name"]),
    description: stripAsc(node["@_UserDescription"]) || undefined,
    state: Number(node["@_State"] ?? 0),
    rgb: Number(node["@_RGB"] ?? 0),
  }));

  const collected: Collected = { shapes: [], tracks: [], components: [], holes: [], vias: [] };
  walkGeometry(designSheet, collected);

  return {
    source: {
      application: creator["@_application"] ?? "unknown",
      versionMajor: Number(creator["@_versionMajor"] ?? 0),
      versionMinor: Number(creator["@_versionMinor"] ?? 0),
      schema: Number(root["@_Schema"] ?? 0),
    },
    projectName,
    sheetTitle,
    workArea,
    layers,
    shapes: collected.shapes,
    tracks: collected.tracks,
    components: collected.components,
    holes: collected.holes,
    vias: collected.vias,
    nets: parseNets(root),
  };
}
