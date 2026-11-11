#!/usr/bin/env bun
/**
 * Corpus harness: convert every EW design under a directory, then validate
 * each output with kicad-cli (ERC for schematics, DRC for PCBs). kicad-cli is
 * always launched through scripts/run-hidden.ps1 so no dialog can reach the
 * user's screen; any dialog it raises is captured and reported.
 *
 *   bun run scripts/corpus.ts [corpusDir=corpus] [outDir=out/corpus]
 *
 * Writes <outDir>/report.json and <outDir>/report.md.
 */
import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, dirname, resolve } from "node:path";
import { convertFile } from "../src/main.ts";

const KICAD_CLI = process.env.KICAD_CLI ?? "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe";
const RUN_HIDDEN = resolve(import.meta.dir, "run-hidden.ps1");

const corpusDir = resolve(Bun.argv[2] ?? "corpus");
const outRoot = resolve(Bun.argv[3] ?? "out/corpus");

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ewprj|ms1\d)$/i.test(e.name)) yield p;
  }
}

interface Row {
  input: string;
  output?: string;
  convertError?: string;
  kicadExit?: number;
  loaded?: boolean;
  violations?: number;
  unconnected?: number;
  byType?: Record<string, number>;
  dialogs?: string[];
  ms: number;
}

async function kicadCheck(file: string, kind: "sch" | "pcb"): Promise<Partial<Row>> {
  const report = `${file}.${kind === "sch" ? "erc" : "drc"}.json`;
  const cmd = kind === "sch" ? ["sch", "erc"] : ["pcb", "drc"];
  const proc = Bun.spawnSync([
    "pwsh", "-NoProfile", "-File", RUN_HIDDEN, "-TimeoutSec", "180", "--",
    KICAD_CLI, ...cmd, "--format", "json", "--output", report, file,
  ]);
  const stderr = proc.stderr.toString();
  const dialogs = stderr.split(/\r?\n/).filter((l) => l.startsWith("[run-hidden] dialog:"))
    .map((l) => l.slice("[run-hidden] dialog: ".length));
  const out: Partial<Row> = { kicadExit: proc.exitCode ?? -1, dialogs };
  try {
    const j = JSON.parse(await readFile(report, "utf8"));
    out.loaded = true;
    const vs: any[] = kind === "sch"
      ? (j.sheets ?? []).flatMap((s: any) => s.violations ?? [])
      : (j.violations ?? []);
    out.violations = vs.length;
    out.unconnected = kind === "pcb" ? (j.unconnected_items ?? []).length : undefined;
    const byType: Record<string, number> = {};
    for (const v of vs) byType[v.type] = (byType[v.type] ?? 0) + 1;
    out.byType = byType;
  } catch {
    out.loaded = false;
  }
  return out;
}

const rows: Row[] = [];
for await (const input of walk(corpusDir)) {
  const rel = relative(corpusDir, input);
  const outDir = join(outRoot, dirname(rel));
  await mkdir(outDir, { recursive: true });
  const t0 = performance.now();
  const row: Row = { input: rel, ms: 0 };
  try {
    const origLog = console.log;
    console.log = () => {};
    try { row.output = await convertFile(input, outDir); } finally { console.log = origLog; }
    Object.assign(row, await kicadCheck(row.output, row.output.endsWith(".kicad_sch") ? "sch" : "pcb"));
  } catch (e) {
    row.convertError = (e as Error).message.split("\n")[0];
  }
  row.ms = Math.round(performance.now() - t0);
  rows.push(row);
  const status = row.convertError ? `CONVERT FAIL: ${row.convertError}`
    : !row.loaded ? `KICAD LOAD FAIL (exit ${row.kicadExit})`
    : `ok  violations=${row.violations}${row.unconnected != null ? ` unconnected=${row.unconnected}` : ""}`;
  console.log(`${rel}\n    ${status}${row.dialogs?.length ? `  DIALOGS=${row.dialogs.length}` : ""}`);
}

await writeFile(join(outRoot, "report.json"), JSON.stringify(rows, null, 2));
const md = [
  "| input | result | violations | unconnected | top violation types | dialogs |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => {
    const top = Object.entries(r.byType ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}×${v}`).join(", ");
    const result = r.convertError ? `convert fail: ${r.convertError}` : r.loaded ? "loads" : `load fail (${r.kicadExit})`;
    return `| ${r.input} | ${result} | ${r.violations ?? ""} | ${r.unconnected ?? ""} | ${top} | ${r.dialogs?.join("; ") ?? ""} |`;
  }),
].join("\n");
await writeFile(join(outRoot, "report.md"), md + "\n");
const ok = rows.filter((r) => r.loaded).length;
console.log(`\n${ok}/${rows.length} outputs load in KiCad. Report: ${join(outRoot, "report.md")}`);
