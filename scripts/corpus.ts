#!/usr/bin/env bun
/**
 * Corpus harness + fidelity scorecard.
 *
 * Converts every EW design under the corpus directory, then checks each
 * output with kicad-cli (ERC / DRC, and a schematic netlist export) and
 * scores it against EW's own data:
 *
 * - Schematics: KiCad's exported netlist vs Multisim's flattened netlist,
 *   rebuilt from the drawing's ID graph (src/parse/ms-hierarchy.ts; verified
 *   against .ewnet / .ewprj exports). Scored by exact nets + pin-pair
 *   precision/recall (net names ignored).
 * - PCBs: share of EW net pins that landed on a pad, plus DRC counts. Pins
 *   of parts that are only in the net list (never placed on the board, so
 *   there is no footprint to convert) are counted apart, as `unplacedPins`.
 *
 * kicad-cli always runs through scripts/run-hidden.ps1 (private desktop).
 *
 *   bun run scripts/corpus.ts [--all] [--filter <substr>] [--skip <substr>] [--corpus <dir>] [--out <dir>]
 *
 * Default selection: everything under corpus/ except corpus/github/, where
 * only the newest version of each design (by the `@YYYY-MM-DD-sha` suffix)
 * is used; `--all` takes every version. Writes <out>/report.{json,md}.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { convertPcb, convertSch } from "../src/main.ts";
import { loadDesign } from "../src/load.ts";
import { parsePcbXml, unconnectablePins } from "../src/parse/pcb.ts";
import { parseCiNetlist } from "../src/ref/ci-netlist.ts";
import { flattenNetlist, parseMultisimDesign } from "../src/parse/ms-hierarchy.ts";
import {
  compareNetlists,
  type Netlist,
  type NetlistScore,
  parseKicadNetlist,
} from "../src/ref/netlist-compare.ts";

const KICAD_CLI = process.env.KICAD_CLI ?? "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe";
const RUN_HIDDEN = resolve(import.meta.dir, "run-hidden.ps1");

const argv = Bun.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const corpusDir = resolve(opt("--corpus", "corpus"));
const outRoot = resolve(opt("--out", "out/corpus"));
const filter = opt("--filter", "");
const skip = opt("--skip", "");

const DESIGN = /\.(ewprj|ms1\d)$/i;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "gh-src") continue; // bare clones
      yield* walk(p);
    } else if (DESIGN.test(e.name)) yield p;
  }
}

async function selectInputs(): Promise<string[]> {
  const all: string[] = [];
  for await (const f of walk(corpusDir)) all.push(f);
  const versioned = /^(.*)@(\d{4}-\d{2}-\d{2})-([0-9a-f]{7})(\.[^.]+)$/;
  const latest = new Map<string, string>();
  const out: string[] = [];
  for (const f of all.sort()) {
    const m = versioned.exec(f);
    if (!m || flag("--all")) {
      out.push(f);
      continue;
    }
    const k = m[1]! + m[4]!;
    const prev = latest.get(k);
    if (!prev || (versioned.exec(prev)![2]! < m[2]!)) latest.set(k, f);
  }
  out.push(...latest.values());
  return out
    .filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase()))
    .filter((f) => !skip || !f.toLowerCase().includes(skip.toLowerCase()))
    .sort();
}

function hidden(args: string[], timeoutSec = 180) {
  const proc = Bun.spawnSync([
    "pwsh", "-NoProfile", "-File", RUN_HIDDEN, "-TimeoutSec", String(timeoutSec), "--", KICAD_CLI, ...args,
  ]);
  const stderr = proc.stderr.toString();
  const dialogs = stderr.split(/\r?\n/).filter((l) => l.startsWith("[run-hidden] dialog:"))
    .map((l) => l.slice("[run-hidden] dialog: ".length));
  return { exit: proc.exitCode ?? -1, dialogs, stderr };
}

interface Row {
  input: string;
  kind?: "pcb" | "sch";
  output?: string;
  convertError?: string;
  loaded?: boolean;
  kicadExit?: number;
  violations?: number;
  byType?: Record<string, number>;
  dialogs: string[];
  // PCB
  netPins?: number;
  padPins?: number;
  unplacedPins?: number;
  /** Placed parts' net-list pins whose footprint has no such pad, as `U7.S4/S5/S6`. */
  missingPads?: string[];
  unconnected?: number;
  // Schematic
  refSource?: string;
  score?: NetlistScore;
  ms: number;
}

async function erc(row: Row, file: string) {
  const report = `${file}.erc.json`;
  const r = hidden(["sch", "erc", "--format", "json", "--output", report, file]);
  row.kicadExit = r.exit;
  row.dialogs.push(...r.dialogs);
  try {
    const j = JSON.parse(await readFile(report, "utf8"));
    const vs: any[] = (j.sheets ?? []).flatMap((s: any) => s.violations ?? []);
    row.loaded = true;
    row.violations = vs.length;
    row.byType = tally(vs);
  } catch {
    row.loaded = false;
  }
}

async function drc(row: Row, file: string) {
  const report = `${file}.drc.json`;
  const r = hidden(["pcb", "drc", "--refill-zones", "--format", "json", "--output", report, file]);
  row.kicadExit = r.exit;
  row.dialogs.push(...r.dialogs);
  try {
    const j = JSON.parse(await readFile(report, "utf8"));
    row.loaded = true;
    row.violations = (j.violations ?? []).length;
    row.unconnected = (j.unconnected_items ?? []).length;
    row.byType = tally(j.violations ?? []);
  } catch {
    row.loaded = false;
  }
}

function tally(vs: any[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const v of vs) t[v.type] = (t[v.type] ?? 0) + 1;
  return t;
}

async function kicadNetlist(file: string): Promise<Netlist | undefined> {
  const out = `${file}.net`;
  hidden(["sch", "export", "netlist", "--format", "kicadsexpr", "--output", out, file]);
  try {
    return parseKicadNetlist(await readFile(out, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Reference netlist for a schematic: Multisim's own flattened netlist from
 * the drawing's ID graph (verified against .ewnet / .ewprj exports; see
 * src/parse/ms-hierarchy.ts). Falls back to the cached Ci* netlist.
 */
async function referenceNetlist(_input: string, xml: string): Promise<{ source: string; nets: Netlist } | undefined> {
  try {
    const nets = flattenNetlist(parseMultisimDesign(xml));
    if (nets.size) return { source: "drawing", nets };
  } catch {}
  const ci = parseCiNetlist(xml);
  const main = ci.circuits.sort((a, b) => b.components.length - a.components.length)[0];
  return main ? { source: "ci", nets: main.nets } : undefined;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

const pct = (x: number | undefined) => (x === undefined ? "" : `${(100 * x).toFixed(0)}%`);

const rows: Row[] = [];
const inputs = await selectInputs();
console.log(`${inputs.length} designs`);
for (const input of inputs) {
  const rel = relative(corpusDir, input);
  const outDir = join(outRoot, dirname(rel));
  await mkdir(outDir, { recursive: true });
  const t0 = performance.now();
  const row: Row = { input: rel, dialogs: [], ms: 0 };
  try {
    const design = await loadDesign(input);
    if (design.kind === "pcb") {
      row.kind = "pcb";
      row.output = await quiet(() => convertPcb(input, design.xml, outDir));
      const b = parsePcbXml(design.xml);
      const pads = new Set(b.components.flatMap((c) => c.pads.map((p) => `${c.reference}.${p.number}`)));
      const placed = new Set(b.components.map((c) => c.reference));
      const all = b.nets.flatMap((n) => n.pins);
      const pins = all.filter((p) => placed.has(p.refdes));
      row.unplacedPins = all.length - pins.length;
      row.netPins = pins.length;
      row.padPins = pins.filter((p) => pads.has(`${p.refdes}.${p.pin}`)).length;
      row.missingPads = [...unconnectablePins(b).missingPads].map(([r, ps]) => `${r}.${ps.join("/")}`);
      await drc(row, row.output);
    } else {
      row.kind = "sch";
      row.output = await quiet(() => convertSch(input, design.xml, outDir));
      await erc(row, row.output);
      const ref = await referenceNetlist(input, design.xml);
      const got = row.loaded ? await kicadNetlist(row.output) : undefined;
      if (ref && got) {
        row.refSource = ref.source;
        row.score = compareNetlists(ref.nets, got);
      }
    }
  } catch (e) {
    row.convertError = (e as Error).message.split("\n")[0];
  }
  row.ms = Math.round(performance.now() - t0);
  rows.push(row);
  const s = row.score;
  const status = row.convertError ? `CONVERT FAIL: ${row.convertError}`
    : !row.loaded ? `KICAD LOAD FAIL (exit ${row.kicadExit})`
    : row.kind === "pcb" ? `pins on pads ${row.padPins}/${row.netPins} (+${row.unplacedPins} unplaced)${row.missingPads?.length ? `  no pad: ${row.missingPads.join(" ")}` : ""}  unconnected=${row.unconnected}  violations=${row.violations}`
    : s ? `nets ${s.exactNets}/${s.refNets} exact (ref=${row.refSource})  pairs P=${pct(s.pairPrecision)} R=${pct(s.pairRecall)}  violations=${row.violations}`
    : `no reference netlist  violations=${row.violations}`;
  console.log(`${rel}\n    ${status}${row.dialogs.length ? `  DIALOGS=${row.dialogs.length}` : ""}`);
}

await writeFile(join(outRoot, "report.json"), JSON.stringify(rows, null, 2));

const top = (r: Row) => Object.entries(r.byType ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
  .map(([k, v]) => `${k}×${v}`).join(", ");
const sch = rows.filter((r) => r.kind === "sch");
const pcb = rows.filter((r) => r.kind === "pcb");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const scored = sch.filter((r) => r.score);
const md = [
  `# Corpus scorecard`,
  ``,
  `- Designs: ${rows.length} (${sch.length} schematics, ${pcb.length} PCBs); load in KiCad: ${rows.filter((r) => r.loaded).length}`,
  `- Schematic nets reproduced exactly: ${sum(scored.map((r) => r.score!.exactNets))}/${sum(scored.map((r) => r.score!.refNets))}`,
  `- PCB net pins on a pad: ${sum(pcb.map((r) => r.padPins ?? 0))}/${sum(pcb.map((r) => r.netPins ?? 0))}` +
    `; the ${sum(pcb.map((r) => (r.netPins ?? 0) - (r.padPins ?? 0)))} others name a pad their footprint lacks` +
    ` (plus ${sum(pcb.map((r) => r.unplacedPins ?? 0))} pins of parts that are in the net list but not on the board)`,
  `- Dialogs captured: ${sum(rows.map((r) => r.dialogs.length))}`,
  ``,
  `## Schematics`,
  ``,
  `| input | ref | exact nets | pair P | pair R | violations | top types |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...sch.map((r) => r.convertError ? `| ${r.input} | | convert fail: ${r.convertError} | | | | |`
    : `| ${r.input} | ${r.refSource ?? "-"} | ${r.score ? `${r.score.exactNets}/${r.score.refNets}` : ""} | ${pct(r.score?.pairPrecision)} | ${pct(r.score?.pairRecall)} | ${r.loaded ? r.violations : "load fail"} | ${top(r)} |`),
  ``,
  `## PCBs`,
  ``,
  `| input | pins on pads | no pad on footprint | unplaced pins | unconnected | violations | top types |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...pcb.map((r) => r.convertError ? `| ${r.input} | convert fail: ${r.convertError} | | | | | |`
    : `| ${r.input} | ${r.padPins}/${r.netPins} | ${r.missingPads?.join(" ") ?? ""} | ${r.unplacedPins ?? ""} | ${r.unconnected ?? ""} | ${r.loaded ? r.violations : "load fail"} | ${top(r)} |`),
].join("\n");
await writeFile(join(outRoot, "report.md"), md + "\n");
console.log(`\n${md.split("\n").slice(2, 7).join("\n")}\nReport: ${join(outRoot, "report.md")}`);
