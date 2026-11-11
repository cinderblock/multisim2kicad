#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { designBaseName, loadDesign } from "./load.ts";
import { parsePcbXml } from "./parse/pcb.ts";
import { parseSchematicXml } from "./parse/sch.ts";
import { emitKicadPcb } from "./emit/kicad-pcb.ts";
import { emitKicadSch, kicadProSchematicSettings } from "./emit/kicad-sch.ts";

const NM_PER_MM = 1_000_000;

export async function convertPcb(input: string, xml: string, outDir: string): Promise<string> {
  const board = parsePcbXml(xml);

  const outPath = join(outDir, `${designBaseName(input)}.kicad_pcb`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, emitKicadPcb(board), "utf8");

  const enabled = board.layers.filter((l) => l.state !== 0);
  const w = (board.workArea.right - board.workArea.left) / NM_PER_MM;
  const h = (board.workArea.top - board.workArea.bottom) / NM_PER_MM;

  const shapeCounts: Record<string, number> = {};
  for (const s of board.shapes) {
    shapeCounts[s.kind] = (shapeCounts[s.kind] ?? 0) + 1;
  }
  const shapeSummary = Object.entries(shapeCounts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ") || "none";

  const padCount = board.components.reduce((n, c) => n + c.pads.length, 0);
  const plated = board.holes.filter((h) => h.plated).length;
  const netPins = board.nets.reduce((n, net) => n + net.pins.length, 0);

  console.log(`${basename(input)}`);
  console.log(`  app:        ${board.source.application} v${board.source.versionMajor}.${board.source.versionMinor}  (schema ${board.source.schema})`);
  console.log(`  project:    ${board.projectName}`);
  console.log(`  sheet:      "${board.sheetTitle}"  workArea ${w.toFixed(1)} x ${h.toFixed(1)} mm`);
  console.log(`  EW layers:  ${board.layers.length} defined, ${enabled.length} enabled`);
  console.log(`  shapes:     ${shapeSummary}`);
  console.log(`  tracks:     ${board.tracks.length}`);
  console.log(`  components: ${board.components.length} (${padCount} pads)`);
  console.log(`  holes:      ${board.holes.length} (${plated} plated/via, ${board.holes.length - plated} mounting)`);
  console.log(`  nets:       ${board.nets.length} (${netPins} pin refs)`);
  console.log(`  wrote:      ${outPath}`);
  return outPath;
}

export async function convertSch(input: string, xml: string, outDir: string): Promise<string> {
  const sch = parseSchematicXml(xml);

  const base = designBaseName(input);
  const outPath = join(outDir, `${base}.kicad_sch`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, emitKicadSch(sch), "utf8");
  await writeProjectFile(join(outDir, `${base}.kicad_pro`));

  console.log(`${basename(input)}`);
  console.log(`  app:        ${sch.source.application} v${sch.source.versionMajor}.${sch.source.versionMinor}  (schema ${sch.source.schema})`);
  console.log(`  project:    ${sch.projectName}`);
  for (const sheet of sch.sheets) {
    const pinCount = sheet.symbols.reduce((n, s) => n + s.pins.length, 0);
    const power = sheet.symbols.filter((s) => s.kind === "power").length;
    console.log(`  sheet:      "${sheet.name}"  ${sheet.size.width} x ${sheet.size.height} units`);
    console.log(`  symbols:    ${sheet.symbols.length - power} parts + ${power} power ports (${pinCount} pins)`);
    console.log(`  wires:      ${sheet.wires.length}  labels: ${sheet.labels.length}  texts: ${sheet.texts.length}`);
  }
  console.log(`  wrote:      ${outPath}`);
  return outPath;
}

/**
 * Minimal .kicad_pro: KiCad fills in defaults for everything not given. The
 * schematic needs a 10 mil connection grid to match ew-conv's unit scale.
 * Existing files are merged, not replaced.
 */
async function writeProjectFile(path: string): Promise<void> {
  let pro: any = {};
  try {
    pro = JSON.parse(await readFile(path, "utf8"));
  } catch {}
  pro.meta ??= { filename: basename(path), version: 3 };
  pro.schematic = { ...(pro.schematic ?? {}), ...kicadProSchematicSettings() };
  await writeFile(path, `${JSON.stringify(pro, null, 2)}\n`, "utf8");
}

export async function convertFile(input: string, outDir = "out"): Promise<string> {
  const design = await loadDesign(input);
  return design.kind === "schematic"
    ? convertSch(input, design.xml, outDir)
    : convertPcb(input, design.xml, outDir);
}

async function main() {
  const args = Bun.argv.slice(2);
  let outDir = "out";
  const inputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--out") outDir = args[++i] ?? outDir;
    else inputs.push(args[i]!);
  }
  if (inputs.length === 0) {
    console.error("usage: bun run dev [-o <outDir>] <design.ewprj | design.ms14 | *.xml> [...]");
    process.exit(2);
  }

  for (const input of inputs) await convertFile(input, outDir);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
