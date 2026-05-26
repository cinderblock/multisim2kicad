import { XMLParser } from "fast-xml-parser";
import type { Board, EwLayer } from "../ir/types.ts";

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
  };
}
