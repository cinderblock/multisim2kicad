#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parsePcbXml } from "./parse/pcb.ts";
import { parseSchematicXml } from "./parse/sch.ts";
import { emitKicadPcb } from "./emit/kicad-pcb.ts";
import { emitKicadSch } from "./emit/kicad-sch.ts";

function outputName(input: string): string {
  return basename(input)
    .replace(/\.(ewprj|ms14)\.xml$/i, "")
    .replace(/\.xml$/i, "");
}

const NM_PER_MM = 1_000_000;
const isMultisim = (input: string): boolean => /\.ms14\.xml$/i.test(input);

async function convertPcb(input: string): Promise<void> {
  const xml = await readFile(input, "utf8");
  const board = parsePcbXml(xml);

  const outPath = join("out", `${outputName(input)}.kicad_pcb`);
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
}

async function convertSch(input: string): Promise<void> {
  const xml = await readFile(input, "utf8");
  const sch = parseSchematicXml(xml);

  const outPath = join("out", `${outputName(input)}.kicad_sch`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, emitKicadSch(sch), "utf8");

  const w = (sch.workArea.right - sch.workArea.left) / NM_PER_MM;
  const h = (sch.workArea.top - sch.workArea.bottom) / NM_PER_MM;

  console.log(`${basename(input)}`);
  console.log(`  app:        ${sch.source.application} v${sch.source.versionMajor}.${sch.source.versionMinor}  (schema ${sch.source.schema})`);
  console.log(`  project:    ${sch.projectName}`);
  console.log(`  sheet:      "${sch.sheetTitle}"  workArea ${w.toFixed(1)} x ${h.toFixed(1)} mm`);
  console.log(`  symbols:    ${sch.symbols.length}`);
  console.log(`  wrote:      ${outPath}`);
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: bun run dev <file.ewprj.xml | file.ms14.xml> [...]");
    process.exit(2);
  }

  for (const input of args) {
    if (isMultisim(input)) {
      await convertSch(input);
    } else {
      await convertPcb(input);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
