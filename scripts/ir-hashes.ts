/**
 * Refactoring guard: hash every parser output for every corpus design.
 *
 *   bun run scripts/ir-hashes.ts [--corpus <dir>] [--filter <substr>] > hashes.json
 *   bun run scripts/ir-hashes.ts --compare hashes.json
 *
 * Covers the PCB and schematic IR, the drawing-graph reference netlist and the
 * Ci* netlist, in canonical form (unordered collections sorted). A parser
 * refactor that should not change behaviour must leave every hash unchanged.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { loadDesign } from "../src/load.ts";
import { flattenNetlist, parseMultisimDesign } from "../src/parse/ms-hierarchy.ts";
import { parsePcbXml } from "../src/parse/pcb.ts";
import { parseSchematicXml } from "../src/parse/sch.ts";
import { parseCiNetlist } from "../src/ref/ci-netlist.ts";

const argv = Bun.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const corpusDir = resolve(opt("--corpus", "corpus"));
const filter = opt("--filter", "").toLowerCase();
const compareWith = opt("--compare", "");

const files: string[] = [];
async function walk(d: string) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== "gh-src") await walk(p);
    } else if (/\.(ewprj|ms1\d)$/i.test(e.name)) files.push(p);
  }
}
await walk(corpusDir);
files.sort();

const replacer = (_k: string, v: unknown) =>
  v instanceof Map ? { __map: [...v] } : v instanceof Set ? { __set: [...v] } : typeof v === "bigint" ? `${v}n` : v;
const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v, replacer) ?? "undefined").digest("hex").slice(0, 16);
// Canonical forms: collections whose order carries no meaning are sorted, so a
// parser that visits elements in a different order hashes the same.
const j = (v: unknown) => JSON.stringify(v, replacer);
const sorted = <T,>(xs: T[]) => [...xs].sort((a, b) => (j(a) < j(b) ? -1 : j(a) > j(b) ? 1 : 0));
const canonBoard = (b: any) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Array.isArray(v) ? sorted(v) : v]));
const canonSch = (s: any) => ({
  ...s,
  sheets: sorted(
    s.sheets.map((sh: any) => ({
      ...sh,
      blocks: sorted(sh.blocks),
      symbols: sorted(sh.symbols.map((y: any) => ({ ...y, pins: sorted(y.pins), graphics: sorted(y.graphics) }))),
      wires: sorted(sh.wires),
      labels: sorted(sh.labels),
      texts: sorted(sh.texts),
    })),
  ),
});
const pinList = (ps: { refdes: string; pin: string }[]) => ps.map((p) => `${p.refdes}.${p.pin}`).sort();
const canonFlat = (nets: Map<string, { refdes: string; pin: string }[]>) => sorted([...nets.values()].map(pinList));
const canonCi = (ci: any) => ({
  hierarchical: ci.hierarchical,
  circuits: sorted(
    ci.circuits.map((c: any) => ({
      id: c.id,
      nets: sorted([...c.nets].map(([n, ps]: [string, any]) => [n, pinList(ps)])),
      components: [...c.components].sort(),
      kinds: sorted([...c.kinds]),
      instances: [...c.instances].sort(),
    })),
  ),
});
const attempt = (f: () => unknown) => {
  try {
    return hash(f());
  } catch (e) {
    return `error: ${String(e).slice(0, 120)}`;
  }
};

const out: Record<string, Record<string, string>> = {};
for (const f of files) {
  const key = relative(corpusDir, f).replaceAll("\\", "/");
  if (filter && !key.toLowerCase().includes(filter)) continue;
  const { kind, xml } = await loadDesign(f);
  if (kind === "pcb") out[key] = { pcb: attempt(() => canonBoard(parsePcbXml(xml))) };
  else {
    out[key] = {
      sch: attempt(() => canonSch(parseSchematicXml(xml))),
      flat: attempt(() => canonFlat(flattenNetlist(parseMultisimDesign(xml)))),
      ci: attempt(() => canonCi(parseCiNetlist(xml))),
    };
  }
  process.stderr.write(".");
}
process.stderr.write("\n");

if (!compareWith) console.log(JSON.stringify(out, null, 1));
else {
  const base: typeof out = JSON.parse(await readFile(compareWith, "utf8"));
  let same = 0;
  let diff = 0;
  for (const [k, v] of Object.entries(out)) {
    for (const [part, h] of Object.entries(v)) {
      if (base[k]?.[part] === h) same++;
      else {
        diff++;
        console.log(`DIFF ${part} ${k}: ${base[k]?.[part]} -> ${h}`);
      }
    }
  }
  console.log(`${same} same, ${diff} different`);
  process.exitCode = diff ? 1 : 0;
}
