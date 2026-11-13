// EW component database (Multisim "database project" `.prj` / `.usr`, a Jet
// DB) -> KiCad libraries. Phase F; formats documented in plans/converter.md.
//
// Tables used:
// - tObjects / tObjectTypes / tBlobs: Ultiboard library objects. A `UBLIB`
//   object's blob is a complete compressed EW XML file holding one
//   `UBComponent` in its own frame (the footprint). `PADLIB` objects are
//   reusable custom pad shapes; footprints embed their own copy, so they
//   are not needed.

import { decodeBuffer, decodeMdbBuffer, type MdbJson } from "electronics-workbench-decoder";
import type { Board, Component } from "../ir/types.ts";
import { parseUbLibraryXml } from "../parse/pcb.ts";

type Row = Record<string, unknown>;

export interface EwDatabase {
  source: string;
  tables: MdbJson["tables"];
}

export function readEwDatabase(bytes: Uint8Array, source = ""): EwDatabase {
  return { source, tables: decodeMdbBuffer(bytes, source).tables };
}

const rows = (db: EwDatabase, table: string): Row[] => db.tables[table]?.rows ?? [];
const blobBytes = (v: unknown): Buffer | undefined => {
  const b = v as { _bytes?: string; value?: string } | undefined;
  return b?.value ? Buffer.from(b.value, "base64") : undefined;
};

export interface DatabaseFootprints {
  components: Component[];
  /** Objects not turned into footprints, with the reason. */
  skipped: { name: string; reason: string }[];
}

/** Every Ultiboard footprint in the database, named after its library object. */
export function databaseFootprints(db: EwDatabase): DatabaseFootprints {
  const types = new Map(rows(db, "tObjectTypes").map((r) => [r.lObjectTypeID, String(r.strDocumentType ?? "")]));
  const blobs = new Map(rows(db, "tBlobs").map((r) => [r.lBlobID, r.blbBlob]));
  const components: Component[] = [];
  const skipped: DatabaseFootprints["skipped"] = [];
  for (const o of rows(db, "tObjects")) {
    const name = String(o.strObjectName ?? "");
    const type = types.get(o.lObjectTypeID) ?? "?";
    if (type !== "UBLIB") {
      skipped.push({ name, reason: type });
      continue;
    }
    const bytes = blobBytes(blobs.get(o.lBlobID));
    if (!bytes) {
      skipped.push({ name, reason: "no blob" });
      continue;
    }
    try {
      const c = parseUbLibraryXml(decodeBuffer(bytes).xml.toString("latin1"));
      if (c) components.push({ ...c, name, reference: "REF**", value: name });
      else skipped.push({ name, reason: "no component" });
    } catch (e) {
      skipped.push({ name, reason: String(e) });
    }
  }
  return { components, skipped };
}

/** A board holding the database's footprints, for the footprint-library emitter. */
export function footprintBoard(components: Component[], name: string): Board {
  return {
    source: { application: "ultiboard", versionMajor: 0, versionMinor: 0, schema: 0 },
    projectName: name,
    sheetTitle: name,
    workArea: { left: 0, bottom: 0, right: 0, top: 0 },
    layers: [],
    stackup: { copper: [0, 63], thickness: 1_600_000 },
    zones: [],
    texts: [],
    ruleAreas: [],
    shapes: [],
    tracks: [],
    holes: [],
    vias: [],
    nets: [],
    components,
  };
}
