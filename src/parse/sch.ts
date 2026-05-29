import { XMLParser } from "fast-xml-parser";
import type { Schematic } from "../ir/types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

const stripAsc = (s: string | undefined): string =>
  s?.startsWith("&ASC") ? s.slice(4) : (s ?? "");

const arr = <T,>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

export function parseSchematicXml(xml: string): Schematic {
  const tree = parser.parse(xml);

  if (tree.ElectronicsWorkbench) {
    throw new Error(
      "input is an Ultiboard PCB; use the PCB converter (parsePcbXml)",
    );
  }

  const root = tree.MSMElectronicsWorkbench;
  if (!root) throw new Error("not a Multisim schematic XML file");

  const creator = root.history?.creator ?? {};
  const project = root.Project ?? {};
  const projectName = stripAsc(project["@_Name"]);

  const sheetContainer = arr(project.UniqueSheets?.SheetInfos?.SheetContainer)[0];
  const designSheet = sheetContainer?.Sheet?.Variable?.DesignSheet;
  if (!designSheet) throw new Error("no DesignSheet element found");

  return {
    source: {
      application: creator["@_application"] ?? "unknown",
      versionMajor: Number(creator["@_versionMajor"] ?? 0),
      versionMinor: Number(creator["@_versionMinor"] ?? 0),
      schema: Number(root["@_Schema"] ?? 0),
    },
    projectName,
    sheetTitle: stripAsc(designSheet["@_Title"]),
    workArea: {
      left: Number(designSheet["@_WorkAreaLeft"] ?? 0),
      bottom: Number(designSheet["@_WorkAreaBottom"] ?? 0),
      right: Number(designSheet["@_WorkAreaRight"] ?? 0),
      top: Number(designSheet["@_WorkAreaTop"] ?? 0),
    },
  };
}
