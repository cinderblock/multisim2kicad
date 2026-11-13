import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Board, Schematic } from "./ir/types.ts";
import { designBaseName, loadDesign } from "./load.ts";
import { parsePcbXml } from "./parse/pcb.ts";
import { parseSchematicXml } from "./parse/sch.ts";
import { emitKicadPcb, footprintName } from "./emit/kicad-pcb.ts";
import { emitKicadSchProject, kicadProSchematicSettings, librarySymbolsFile } from "./emit/kicad-sch.ts";
import { databaseSymbols } from "./db/symbols.ts";
import { emitFootprintLibrary, harmonizeFootprints } from "./emit/footprint-lib.ts";
import { boardCustomRules, boardProjectSettings } from "./emit/kicad-pro.ts";
import { databaseFootprints, footprintBoard, readEwDatabase } from "./db/ewdb.ts";

const NM_PER_MM = 1_000_000;

/** One KiCad project: an EW schematic and/or board sharing a base name. */
export interface ProjectInput {
  base: string;
  sch?: { input: string; xml: string };
  pcb?: { input: string; xml: string };
}

/** KiCad library nickname for a project's own footprints. */
const libNickname = (base: string) => base.replace(/[^A-Za-z0-9_.+-]+/g, "_") || "ew";

/**
 * Convert a project. With both halves present the outputs are linked the
 * way KiCad's "Update PCB from Schematic" expects: each footprint carries its
 * symbol's path / sheet name / sheet file, and each symbol names its
 * footprint. See plans/converter.md, phase E.
 */
export async function convertProject(p: ProjectInput, outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const parsed = p.pcb ? harmonizeFootprints(parsePcbXml(p.pcb.xml)) : undefined;
  const board = parsed?.board;
  const sch = p.sch ? parseSchematicXml(p.sch.xml) : undefined;
  const lib = libNickname(p.base);

  if (board && sch) adoptSchematicNetNames(board, sch);

  let links;
  if (sch) {
    const footprints = board ? new Map(board.components.map((c) => [c.reference, `${lib}:${footprintName(c)}`])) : undefined;
    const out = emitKicadSchProject(sch, p.base, { footprints, library: lib });
    for (const [name, text] of out.files) await writeFile(join(outDir, name), text, "utf8");
    // Project-local symbol library the symbols' lib ids point at.
    await writeFile(join(outDir, `${lib}.kicad_sym`), out.symbolLibrary, "utf8");
    await addLibTableEntry(join(outDir, "sym-lib-table"), "sym_lib_table", lib, `\${KIPRJMOD}/${lib}.kicad_sym`, "Symbols from the Multisim design (ew-conv)");
    links = out.links;
    written.push(join(outDir, `${p.base}.kicad_sch`));
    reportSch(p.sch!.input, sch, out.files.size);
  }
  if (board) {
    const path = join(outDir, `${p.base}.kicad_pcb`);
    await writeFile(path, emitKicadPcb(board, { footprintLib: lib, links }), "utf8");
    written.push(path);
    // Project-local footprint library the footprints' lib ids point at.
    const pretty = join(outDir, `${lib}.pretty`);
    await mkdir(pretty, { recursive: true });
    for (const [name, text] of emitFootprintLibrary(board, parsed!.library)) await writeFile(join(pretty, name), text, "utf8");
    await addLibTableEntry(join(outDir, "fp-lib-table"), "fp_lib_table", lib, `\${KIPRJMOD}/${lib}.pretty`, "Footprints from the Ultiboard design (ew-conv)");
    reportPcb(p.pcb!.input, board, links);
  }
  if (board) {
    const dru = boardCustomRules(board);
    if (dru) await writeFile(join(outDir, `${p.base}.kicad_dru`), dru, "utf8");
  }
  await writeProjectFile(join(outDir, `${p.base}.kicad_pro`), !!sch, board);
  return written;
}

/**
 * Ultiboard upper-cases net names (TAC-FAN for Multisim's Tac-Fan). When the
 * schematic names a net the same way up to case, the board takes the
 * schematic's spelling, so KiCad's schematic parity sees one net.
 */
function adoptSchematicNetNames(board: Board, sch: Schematic): void {
  const names = new Map<string, string>();
  for (const sheet of sch.sheets) {
    const all = [
      ...sheet.labels.map((l) => l.name),
      ...sheet.symbols.filter((s) => s.kind === "power").map((s) => s.value),
      ...sheet.buses.flatMap((b) => b.members),
    ];
    for (const n of all) if (n && !names.has(n.toUpperCase())) names.set(n.toUpperCase(), n);
  }
  const rename = (n: string) => names.get(n.toUpperCase()) ?? n;
  for (const net of board.nets) net.name = rename(net.name);
  for (const z of board.zones) z.netName = rename(z.netName);
  for (const v of board.vias) if (v.netName) v.netName = rename(v.netName);
}

export async function convertPcb(input: string, xml: string, outDir: string): Promise<string> {
  const [path] = await convertProject({ base: designBaseName(input), pcb: { input, xml } }, outDir);
  return path!;
}

export async function convertSch(input: string, xml: string, outDir: string): Promise<string> {
  const [path] = await convertProject({ base: designBaseName(input), sch: { input, xml } }, outDir);
  return path!;
}

function reportPcb(input: string, board: Board, links?: ReadonlyMap<string, unknown>): void {
  const enabled = board.layers.filter((l) => l.state !== 0);
  const w = (board.workArea.right - board.workArea.left) / NM_PER_MM;
  const h = (board.workArea.top - board.workArea.bottom) / NM_PER_MM;
  const padCount = board.components.reduce((n, c) => n + c.pads.length, 0);
  const plated = board.holes.filter((x) => x.plated).length;
  const netPins = board.nets.reduce((n, net) => n + net.pins.length, 0);
  console.log(`${basename(input)}`);
  console.log(`  app:        ${board.source.application} v${board.source.versionMajor}.${board.source.versionMinor}  (schema ${board.source.schema})`);
  console.log(`  project:    ${board.projectName}`);
  console.log(`  sheet:      "${board.sheetTitle}"  workArea ${w.toFixed(1)} x ${h.toFixed(1)} mm`);
  console.log(`  layers:     ${board.layers.length} EW layers (${enabled.length} enabled), ${board.stackup.copper.length} copper`);
  console.log(`  parts:      ${board.components.length} (${padCount} pads)`);
  console.log(`  tracks:     ${board.tracks.length}  vias: ${board.vias.length}  zones: ${board.zones.length}`);
  console.log(`  holes:      ${board.holes.length} (${plated} plated, ${board.holes.length - plated} mounting)`);
  console.log(`  nets:       ${board.nets.length} (${netPins} pin refs)`);
  if (links) {
    const linked = board.components.filter((c) => links.has(c.reference)).length;
    console.log(`  linked:     ${linked}/${board.components.length} footprints to schematic symbols`);
  }
}

function reportSch(input: string, sch: Schematic, fileCount: number): void {
  console.log(`${basename(input)}`);
  console.log(`  app:        ${sch.source.application} v${sch.source.versionMajor}.${sch.source.versionMinor}  (schema ${sch.source.schema})`);
  console.log(`  project:    ${sch.projectName}`);
  for (const sheet of sch.sheets) {
    const pinCount = sheet.symbols.reduce((n, s) => n + s.pins.length, 0);
    const power = sheet.symbols.filter((s) => s.kind === "power").length;
    console.log(`  sheet:      "${sheet.name}"  ${sheet.size.width} x ${sheet.size.height} units`);
    console.log(`  symbols:    ${sheet.symbols.length - power} parts + ${power} power ports (${pinCount} pins)`);
    console.log(`  wires:      ${sheet.wires.length}  labels: ${sheet.labels.length}  buses: ${sheet.buses.length}`);
  }
  console.log(`  instances:  ${countInstances(sch.root)} sheet instance(s), ${fileCount} file(s)`);
}

const countInstances = (i: { children: any[] }): number => 1 + i.children.reduce((n: number, c: any) => n + countInstances(c), 0);

/**
 * Minimal .kicad_pro: KiCad fills in defaults for everything not given. The
 * schematic needs a 10 mil connection grid to match ew-conv's unit scale.
 * Existing files are merged, not replaced.
 */
async function writeProjectFile(path: string, schematic: boolean, board?: Board): Promise<void> {
  let pro: any = {};
  try {
    pro = JSON.parse(await readFile(path, "utf8"));
  } catch {}
  pro.meta ??= { filename: basename(path), version: 3 };
  if (schematic) pro.schematic = { ...(pro.schematic ?? {}), ...kicadProSchematicSettings() };
  // Design rules and net classes (C7).
  const rules = board && boardProjectSettings(board);
  if (rules) {
    pro.board ??= {};
    pro.board.design_settings ??= {};
    pro.board.design_settings.rules = { ...(pro.board.design_settings.rules ?? {}), ...rules.rules };
    pro.net_settings = rules.netSettings;
  }
  await writeFile(path, `${JSON.stringify(pro, null, 2)}\n`, "utf8");
}

/**
 * Add (or replace) one library in a KiCad lib table, keeping other entries:
 * several converted projects can share an output folder.
 */
async function addLibTableEntry(path: string, head: string, name: string, uri: string, descr: string): Promise<void> {
  const q = (s: string) => JSON.stringify(s);
  const entry = `\t(lib (name ${q(name)}) (type "KiCad") (uri ${q(uri)}) (options "") (descr ${q(descr)}))`;
  let lines: string[] = [];
  try {
    lines = (await readFile(path, "utf8")).split(/\r?\n/).filter((l) => l.trim().startsWith("(lib "));
  } catch {}
  lines = lines.filter((l) => !l.includes(`(name ${q(name)})`));
  await writeFile(path, [`(${head}`, `\t(version 7)`, ...lines, entry, `)`, ``].join("\n"), "utf8");
}

const DESIGN_FILE = /\.(ewprj|ms1\d)(\.xml)?$/i;

/**
 * Group design files into projects: a schematic and a board in the same
 * folder with the same base name (Main.ms14 + Main.ewprj) are one project.
 * Directories contribute every design file directly inside them.
 */
export async function groupProjects(paths: string[]): Promise<ProjectInput[]> {
  const files: string[] = [];
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) {
      for (const e of await readdir(p, { withFileTypes: true })) if (e.isFile() && DESIGN_FILE.test(e.name)) files.push(join(p, e.name));
    } else files.push(p);
  }
  const projects = new Map<string, ProjectInput>();
  for (const file of files) {
    const design = await loadDesign(file);
    const base = designBaseName(file);
    const key = join(resolve(dirname(file)), base).toLowerCase();
    const proj = projects.get(key) ?? { base };
    const half = design.kind === "schematic" ? "sch" : "pcb";
    if (proj[half]) throw new Error(`${file}: a second ${half === "sch" ? "schematic" : "board"} for project ${base} (${proj[half]!.input})`);
    proj[half] = { input: file, xml: design.xml };
    projects.set(key, proj);
  }
  return [...projects.values()];
}

/** Convert one design file on its own (no pairing). */
export async function convertFile(input: string, outDir = "out"): Promise<string> {
  const design = await loadDesign(input);
  return design.kind === "schematic"
    ? convertSch(input, design.xml, outDir)
    : convertPcb(input, design.xml, outDir);
}

/** The command line: `ew-conv [-o <outDir>] <inputs...>`. */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let outDir = "out";
  const inputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--out") outDir = args[++i] ?? outDir;
    else inputs.push(args[i]!);
  }
  if (inputs.length === 0) {
    console.error("usage: ew-conv [-o <outDir>] <design.ms14 | design.ewprj | folder | database.prj> [...]");
    console.error("  A schematic and board with the same name in the same folder become one linked KiCad project.");
    process.exit(2);
  }
  const designs: string[] = [];
  for (const i of inputs) {
    if (DATABASE_FILE.test(i)) await convertDatabase(i, outDir);
    else designs.push(i);
  }
  for (const p of await groupProjects(designs)) await convertProject(p, outDir);
}

const DATABASE_FILE = /\.(prj|usr|prd)$/i;

/**
 * An EW component database (`.prj` / `.usr`) -> KiCad libraries named after
 * it: `<name>.pretty/` (+ fp-lib-table) and `<name>.kicad_sym` (+
 * sym-lib-table), each symbol's Footprint pointing into the `.pretty` when
 * the database holds its package. Phase F.
 */
export async function convertDatabase(input: string, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const db = readEwDatabase(await readFile(input), input);
  const lib = libNickname(basename(input).replace(DATABASE_FILE, ""));
  const fps = databaseFootprints(db);
  const h = harmonizeFootprints(footprintBoard(fps.components, lib));
  const pretty = join(outDir, `${lib}.pretty`);
  await mkdir(pretty, { recursive: true });
  for (const [name, text] of emitFootprintLibrary(h.board, h.library)) await writeFile(join(pretty, name), text, "utf8");
  await addLibTableEntry(join(outDir, "fp-lib-table"), "fp_lib_table", lib, `\${KIPRJMOD}/${lib}.pretty`, `Footprints from the EW database ${basename(input)} (ew-conv)`);
  const syms = databaseSymbols(db, (pkg) => {
    const name = footprintName({ name: pkg } as Board["components"][number]);
    return h.library.has(name) ? `${lib}:${name}` : undefined;
  });
  const symPath = join(outDir, `${lib}.kicad_sym`);
  await writeFile(symPath, librarySymbolsFile(syms.specs), "utf8");
  await addLibTableEntry(join(outDir, "sym-lib-table"), "sym_lib_table", lib, `\${KIPRJMOD}/${lib}.kicad_sym`, `Symbols from the EW database ${basename(input)} (ew-conv)`);
  const reasons = new Map<string, number>();
  for (const s of fps.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  console.log(`${input}`);
  console.log(`  footprints: ${h.library.size} -> ${pretty}`);
  console.log(`  symbols:    ${syms.specs.length} -> ${symPath} (${syms.specs.filter((x) => x.footprint).length} with a footprint here)`);
  for (const w of syms.warnings.slice(0, 20)) console.log(`  warning: ${w}`);
  if (syms.warnings.length > 20) console.log(`  ... ${syms.warnings.length - 20} more warnings`);
  if (reasons.size) console.log(`  skipped:    ${[...reasons].map(([r, n]) => `${n} ${r}`).join(", ")}`);
}
