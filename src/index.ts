/**
 * multisim2kicad as a library: Electronics Workbench (Multisim / Ultiboard) designs
 * and component databases -> KiCad.
 *
 * The high-level entry points write a KiCad project or library to a folder;
 * the parsers and emitters underneath work on the format-neutral IR in
 * `./ir/types.ts`, so other front or back ends can plug in.
 */
export {
  convertDatabase,
  convertFile,
  convertPcb,
  convertProject,
  convertSch,
  groupProjects,
  main,
  type ProjectInput,
} from "./main.ts";
export { designBaseName, loadDesign, type DesignKind, type LoadedDesign } from "./load.ts";
export { parseSchematicXml } from "./parse/sch.ts";
export { parsePcbXml, parseUbLibraryXml } from "./parse/pcb.ts";
export { emitKicadPcb, footprintName, type PcbOptions } from "./emit/kicad-pcb.ts";
export { emitKicadSch, emitKicadSchProject, librarySymbolsFile, type LibrarySymbolSpec } from "./emit/kicad-sch.ts";
export { emitFootprintLibrary, harmonizeFootprints } from "./emit/footprint-lib.ts";
export { boardCustomRules, boardProjectSettings } from "./emit/kicad-pro.ts";
export { databaseFootprints, footprintBoard, readEwDatabase, type EwDatabase } from "./db/ewdb.ts";
export { databaseSymbols, parseSymbolPicture, symbolPictureXml } from "./db/symbols.ts";
export type * from "./ir/types.ts";
