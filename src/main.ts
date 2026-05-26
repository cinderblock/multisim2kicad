#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parsePcbXml } from "./parse/pcb.ts";
import { emitKicadPcb } from "./emit/kicad-pcb.ts";

function outputName(input: string): string {
  return basename(input)
    .replace(/\.(ewprj|ms14)\.xml$/i, "")
    .replace(/\.xml$/i, "");
}

const NM_PER_MM = 1_000_000;

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: bun run dev <file.ewprj.xml> [...]");
    process.exit(2);
  }

  for (const input of args) {
    const xml = await readFile(input, "utf8");
    const board = parsePcbXml(xml);

    const outPath = join("out", `${outputName(input)}.kicad_pcb`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, emitKicadPcb(board), "utf8");

    const enabled = board.layers.filter((l) => l.state !== 0);
    const w = (board.workArea.right - board.workArea.left) / NM_PER_MM;
    const h = (board.workArea.top - board.workArea.bottom) / NM_PER_MM;

    console.log(`${basename(input)}`);
    console.log(`  app:        ${board.source.application} v${board.source.versionMajor}.${board.source.versionMinor}  (schema ${board.source.schema})`);
    console.log(`  project:    ${board.projectName}`);
    console.log(`  sheet:      "${board.sheetTitle}"  workArea ${w.toFixed(1)} x ${h.toFixed(1)} mm`);
    console.log(`  EW layers:  ${board.layers.length} defined, ${enabled.length} enabled`);
    console.log(`  wrote:      ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
