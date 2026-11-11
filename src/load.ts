import { readFile } from "node:fs/promises";
import { decodeBuffer, detectFormatByHeader, MAX_HEADER_LENGTH } from "electronics-workbench-decoder";

export type DesignKind = "pcb" | "schematic";

export interface LoadedDesign {
  kind: DesignKind;
  /** Decompressed EW XML text. */
  xml: string;
  /** "binary" when decoded via ewd, "xml" when read as already-decoded text. */
  via: "binary" | "xml";
}

/**
 * Read an EW design from disk. Binary `.ewprj` / `.ms1x` containers are
 * detected by magic bytes and decompressed in memory via `ewd`
 * (electronics-workbench-decoder); anything else is treated as the XML that
 * `ewd` would produce. The design kind comes from the XML root element, not
 * the filename.
 */
export async function loadDesign(path: string): Promise<LoadedDesign> {
  const buf = await readFile(path);
  const format = detectFormatByHeader(buf.subarray(0, MAX_HEADER_LENGTH));

  let xml: string;
  let via: LoadedDesign["via"];
  if (format) {
    if (format.kind !== "compressed-xml") {
      throw new Error(`${path}: ${format.label} files are component databases, not designs`);
    }
    xml = decodeBuffer(buf).xml.toString("utf8");
    via = "binary";
  } else {
    xml = buf.toString("utf8");
    via = "xml";
  }

  // Root element decides: <MSMElectronicsWorkbench> is Multisim,
  // <ElectronicsWorkbench> is Ultiboard. Look only near the top.
  const head = xml.slice(0, 4096);
  if (/<MSMElectronicsWorkbench[\s>]/.test(head)) return { kind: "schematic", xml, via };
  if (/<ElectronicsWorkbench[\s>]/.test(head)) return { kind: "pcb", xml, via };
  throw new Error(`${path}: not an Electronics Workbench design (no EW root element)`);
}

/** Output base name: strips `.xml` and the EW design extension. */
export function designBaseName(file: string): string {
  return file
    .replace(/^.*[\\/]/, "")
    .replace(/\.xml$/i, "")
    .replace(/\.(ewprj|ms1\d)$/i, "");
}
