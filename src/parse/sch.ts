import { XMLParser } from "fast-xml-parser";
import type { SchematicSymbol, SchematicWire, Schematic } from "../ir/types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

// Multisim string types:
//   &ASC<text>           -> plain ASCII text after the prefix.
//   &UNI<text + escapes> -> text with `_uc<count><4hex>...` sequences for
//                          non-ASCII characters (e.g. `_uc100b5F` -> µF,
//                          `_uc103a9` -> Ω). Literal newlines may appear
//                          mid-string; the caller decides whether to keep
//                          them or collapse.
const decodeStr = (s: string | undefined): string => {
  if (!s) return "";
  if (s.startsWith("&ASC")) return s.slice(4);
  if (s.startsWith("&UNI")) {
    return s.slice(4).replace(
      /_uc(\d)((?:[0-9a-fA-F]{4})+)/g,
      (_full, countStr, hex) => {
        const n = Number(countStr);
        let out = "";
        for (let i = 0; i < n; i++) {
          out += String.fromCharCode(parseInt(hex.slice(i * 4, (i + 1) * 4), 16));
        }
        return out;
      },
    );
  }
  return s;
};
// Back-compat alias for the PCB-parser style used elsewhere in this module.
const stripAsc = decodeStr;

const arr = <T,>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

// Multisim's schematic grid uses 0.25 mm per unit (sheet 1188 x 840 units =
// 297 x 210 mm = A4). Everything in the IR is normalised to nm so emitters
// can divide by 1_000_000 the same way as PCB code.
const NM_PER_SCH_UNIT = 250_000;
const u = (v: string | number | undefined): number =>
  Number(v ?? 0) * NM_PER_SCH_UNIT;

// Walks the tree looking for elements whose key matches `tag`. Subtrees
// whose key is in `skipUnder` are NOT descended into — used to keep wire
// scanning from picking up pin-stub line segments inside CIITSymbolComp.
function collectByTag(
  node: any, tag: string, out: any[], skipUnder?: ReadonlySet<string>,
): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) collectByTag(c, tag, out, skipUnder);
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (skipUnder?.has(key)) continue;
    if (key === tag) {
      for (const item of arr(val as any)) out.push(item);
    } else {
      collectByTag(val, tag, out, skipUnder);
    }
  }
}

const INSIDE_SYMBOL = new Set(["CIITSymbolComp"]);

// CIITSymbolComp wraps its inner items (text, border rect, pins, ...) under
// `Objects > Item > <ClassName>`. Find the first direct-child item whose
// class matches `tag`.
function ownChild(symbolComp: any, tag: string): any {
  for (const item of arr(symbolComp?.Objects?.Item)) {
    if (item?.[tag]) return item[tag];
  }
  return undefined;
}

function parseSymbol(symbolComp: any): SchematicSymbol {
  const refdes = stripAsc(ownChild(symbolComp, "CIITSymTextCompName")?.["@_Output"]);
  const value = stripAsc(ownChild(symbolComp, "CIITSymTextCompValue")?.["@_Output"]);
  const border = ownChild(symbolComp, "CIITSymbolBorderRect");

  const x = u(symbolComp["@_Transformer-M20"]);
  const y = u(symbolComp["@_Transformer-M21"]);

  // Bbox is in symbol-local sch units; translate to nm. Defaults give a small
  // square if a symbol lacks an explicit border (uncommon but defensive).
  const x0 = u(border?.["@_pt0X"] ?? 0);
  const y0 = u(border?.["@_pt0Y"] ?? 0);
  const x1 = u(border?.["@_pt1X"] ?? 40);
  const y1 = u(border?.["@_pt1Y"] ?? 40);

  return {
    reference: refdes || "?",
    value: value || "",
    at: { x, y },
    bbox: { x0, y0, x1, y1 },
  };
}

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

  const symbolComps: any[] = [];
  collectByTag(designSheet, "CIITSymbolComp", symbolComps);

  // Sheet-level wires only — pin-stub CODLineComp inside CIITSymbolComp's
  // Objects are the symbol's own graphics, not page wiring.
  const lineComps: any[] = [];
  collectByTag(designSheet, "CODLineComp", lineComps, INSIDE_SYMBOL);
  const multiLineComps: any[] = [];
  collectByTag(designSheet, "CODMultiLineComp", multiLineComps, INSIDE_SYMBOL);

  const wires: SchematicWire[] = [];
  for (const ln of lineComps) {
    wires.push({
      from: { x: u(ln["@_pt0X"]), y: u(ln["@_pt0Y"]) },
      to:   { x: u(ln["@_pt1X"]), y: u(ln["@_pt1Y"]) },
    });
  }
  for (const ml of multiLineComps) {
    const pts = arr(ml?.Points?.Item).map((p: any) => ({
      x: u(p["@_X"]), y: u(p["@_Y"]),
    }));
    for (let i = 0; i + 1 < pts.length; i++) {
      wires.push({ from: pts[i], to: pts[i + 1] });
    }
  }

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
    symbols: symbolComps.map(parseSymbol),
    wires,
  };
}
