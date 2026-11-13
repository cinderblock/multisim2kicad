/**
 * Schematic <-> board parity for converted projects, by connectivity rather
 * than net names: the schematic's KiCad netlist (kicad-cli, run hidden) vs.
 * the nets on the board's pads, compared as pin groupings. Also lists
 * footprints without a symbol and symbols without a footprint, and counts
 * footprints whose schematic link (path) is set.
 *
 *   bun run scripts/parity.ts <dir-or-.kicad_pro> [...]
 *
 * Every <base>.kicad_pro with both <base>.kicad_sch and <base>.kicad_pcb is
 * checked. KiCad's own `pcb drc --schematic-parity` report is name-based and
 * capped at 199 entries per category, so it can't score a whole board.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareNetlists, type Netlist, parseKicadNetlist } from "../src/ref/netlist-compare.ts";
import { atom, headOf, isList, listsNamed, parseSexpr, type Sexpr } from "../src/util/sexpr.ts";

const KICAD_CLI = process.env.KICAD_CLI ?? "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe";
const RUN_HIDDEN = resolve(import.meta.dir, "run-hidden.ps1");

function hidden(args: string[], timeoutSec = 300) {
  const proc = Bun.spawnSync(["pwsh", "-NoProfile", "-File", RUN_HIDDEN, "-TimeoutSec", String(timeoutSec), "--", KICAD_CLI, ...args]);
  return proc.exitCode ?? -1;
}

/** Board nets from pads: net name -> pins, plus per-footprint facts. */
function boardNetlist(text: string) {
  const root = parseSexpr(text).find((x) => headOf(x) === "kicad_pcb") as Sexpr[];
  const nets: Netlist = new Map();
  const footprints: { ref: string; linked: boolean; boardOnly: boolean }[] = [];
  for (const fp of listsNamed(root, "footprint")) {
    const refProp = listsNamed(fp, "property").find((p) => p[1] === "Reference");
    const ref = typeof refProp?.[2] === "string" ? refProp[2] : "";
    const attr = listsNamed(fp, "attr")[0] ?? [];
    footprints.push({ ref, linked: !!atom(fp, "path"), boardOnly: attr.includes("board_only") });
    for (const pad of listsNamed(fp, "pad")) {
      const num = typeof pad[1] === "string" ? pad[1] : "";
      const net = listsNamed(pad, "net")[0];
      const name = net && typeof net[2] === "string" ? net[2] : "";
      if (!ref || !num || !name) continue;
      const list = nets.get(name) ?? [];
      list.push({ refdes: ref, pin: num });
      nets.set(name, list);
    }
  }
  return { nets, footprints };
}

async function projects(args: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const a of args) {
    if (a.endsWith(".kicad_pro")) out.push(a.slice(0, -".kicad_pro".length));
    else if ((await stat(a)).isDirectory()) {
      for (const e of await readdir(a)) if (e.endsWith(".kicad_pro")) out.push(join(a, e.slice(0, -".kicad_pro".length)));
    }
  }
  return out.filter((b) => existsSync(`${b}.kicad_sch`) && existsSync(`${b}.kicad_pcb`));
}

const args = Bun.argv.slice(2);
if (args.length === 0) {
  console.error("usage: bun run scripts/parity.ts <dir-or-.kicad_pro> [...]");
  process.exit(2);
}
let totals = { ref: 0, exact: 0 };
for (const base of await projects(args)) {
  hidden(["sch", "export", "netlist", "--format", "kicadsexpr", "--output", `${base}.parity.net`, `${base}.kicad_sch`]);
  const sch = parseKicadNetlist(await readFile(`${base}.parity.net`, "utf8"));
  const board = boardNetlist(await readFile(`${base}.kicad_pcb`, "utf8"));
  const score = compareNetlists(sch, board.nets);
  const schParts = new Set([...sch.values()].flat().map((p) => p.refdes));
  const unlinked = board.footprints.filter((f) => !f.linked && !f.boardOnly).map((f) => f.ref);
  const boardOnly = board.footprints.filter((f) => f.boardOnly).length;
  totals = { ref: totals.ref + score.refNets, exact: totals.exact + score.exactNets };
  console.log(`${base}`);
  console.log(`  nets (schematic grouping found on the board): ${score.exactNets}/${score.refNets}  pairs P=${(score.pairPrecision * 100).toFixed(1)}% R=${(score.pairRecall * 100).toFixed(1)}%`);
  console.log(`  footprints: ${board.footprints.length} (${board.footprints.filter((f) => f.linked).length} linked, ${boardOnly} board-only, ${unlinked.length} unlinked)`);
  if (score.onlyRef.length) console.log(`  symbols without a footprint: ${score.onlyRef.join(" ")}`);
  if (unlinked.length) console.log(`  footprints without a symbol: ${unlinked.join(" ")}`);
  for (const m of score.sampleMisses.slice(0, 5)) console.log(`    miss: ${m}`);
  void schParts;
}
console.log(`total: ${totals.exact}/${totals.ref} schematic nets reproduced on the boards`);
