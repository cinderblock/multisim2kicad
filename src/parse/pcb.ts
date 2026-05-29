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
} from "../ir/types.ts";

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

function parsePadShape(lamPad: any): PadShape | undefined {
  if (!lamPad) return undefined;
  if (lamPad.LayoutPadRound) {
    return { kind: "circle", diameter: 2 * Number(lamPad.LayoutPadRound["@_Radius"] ?? 0) };
  }
  if (lamPad.LayoutPadRoundedSquare) {
    const p = lamPad.LayoutPadRoundedSquare;
    const w = 2 * Number(p["@_HalfWidth"] ?? 0);
    return { kind: "roundrect", width: w, height: w, cornerRadius: Number(p["@_Radius"] ?? 0) };
  }
  if (lamPad.LayoutPadSquare) {
    const w = 2 * Number(lamPad.LayoutPadSquare["@_HalfWidth"] ?? 0);
    return { kind: "rect", width: w, height: w };
  }
  return undefined;
}

function parsePin(pin: any): Pad | undefined {
  const pt = arr(pin?.Object?.Point)[0];
  const shape = parsePadShape(pin?.LamPad);
  if (!pt || !shape) return undefined;
  const drill = pin?.LayoutDrillObject;
  return {
    number: ownAttributes(pin).get("NUMBER") ?? "",
    at: { x: Number(pt["@_X"]), y: Number(pt["@_Y"]) },
    rotation: Number(pin["@_Rotation"] ?? 0),
    shape,
    drillDiameter: drill ? 2 * Number(drill["@_Drill-Radius"] ?? 0) : 0,
  };
}

function parseComponent(comp: any): Component {
  const attrs = ownAttributes(comp);
  const name = stripAsc(comp["@_Name"]);
  const pins: any[] = [];
  collectByTag(comp.Group, "Through-Board-Pin", pins);
  const pads = pins.map(parsePin).filter((p): p is Pad => p !== undefined);
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
    bottom: Number(comp["@_Bottom"] ?? 0) !== 0,
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

  const collected: Collected = { shapes: [], tracks: [], components: [], holes: [] };
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
    nets: parseNets(root),
  };
}
