#!/usr/bin/env bun
/**
 * Explain a schematic scorecard miss: convert one design, export KiCad's
 * netlist (hidden), and print reference nets that KiCad split and KiCad nets
 * that merge several reference nets.
 *
 *   bun run scripts/netdiff.ts <design.ms14> [outDir]
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadDesign } from "../src/load.ts";
import { convertSch } from "../src/main.ts";
import { flattenNetlist, parseMultisimDesign } from "../src/parse/ms-hierarchy.ts";
import { parseKicadNetlist } from "../src/ref/netlist-compare.ts";

const [input, outArg] = Bun.argv.slice(2);
if (!input) {
  console.error("usage: netdiff <design.ms14> [outDir]");
  process.exit(2);
}
const outDir = resolve(outArg ?? "out/netdiff");
const { xml } = await loadDesign(input);
const log = console.log;
console.log = () => {};
const sch = await convertSch(input, xml, outDir);
console.log = log;
const netFile = `${sch}.net`;
Bun.spawnSync([
  "pwsh", "-NoProfile", "-File", resolve(import.meta.dir, "run-hidden.ps1"), "-TimeoutSec", "120", "--",
  process.env.KICAD_CLI ?? "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe",
  "sch", "export", "netlist", "--format", "kicadsexpr", "--output", netFile, sch,
]);
const got = parseKicadNetlist(await readFile(netFile, "utf8"));
const ref = flattenNetlist(parseMultisimDesign(xml));

const k = (p: { refdes: string; pin: string }) => `${p.refdes}.${p.pin}`;
const gotOf = new Map<string, string>();
for (const [n, ps] of got) for (const p of ps) gotOf.set(k(p), n);
const refOf = new Map<string, string>();
let i = 0;
const refName = new Map<string, string>();
for (const [n, ps] of ref) {
  const label = `R${++i}`;
  refName.set(n, label);
  for (const p of ps) refOf.set(k(p), label);
}

console.log("== reference nets split by KiCad");
for (const [n, ps] of ref) {
  if (ps.length < 2) continue;
  const groups = new Map<string, string[]>();
  for (const p of ps) {
    const g = gotOf.get(k(p)) ?? "(missing)";
    groups.set(g, [...(groups.get(g) ?? []), k(p)]);
  }
  if (groups.size > 1) console.log(`${refName.get(n)}:`, [...groups].map(([g, pins]) => `${g}{${pins.join(" ")}}`).join("  "));
}
console.log("== KiCad nets merging several reference nets");
for (const [n, ps] of got) {
  const groups = new Map<string, string[]>();
  for (const p of ps) {
    const g = refOf.get(k(p));
    if (!g) continue;
    groups.set(g, [...(groups.get(g) ?? []), k(p)]);
  }
  if (groups.size > 1) console.log(`${n}:`, [...groups].map(([g, pins]) => `${g}{${pins.join(" ")}}`).join("  "));
}
console.log("== reference nets not reproduced exactly");
const gotNets = new Map<string, string>();
const refParts = new Set([...ref.values()].flat().map((p) => p.refdes));
const pinSet = (ps: { refdes: string; pin: string }[]) => [...new Set(ps.map(k))].sort().join(" ");
for (const [n, ps] of got) gotNets.set(pinSet(ps.filter((p) => refParts.has(p.refdes))), n);
for (const [n, ps] of ref) {
  const key = pinSet(ps);
  if (new Set(ps.map(k)).size < 2 || gotNets.has(key)) continue;
  const near = new Set(ps.map((p) => gotOf.get(k(p)) ?? "(missing)"));
  const nearPins = [...near].map((g) => `${g}{${(got.get(g) ?? []).filter((p) => refParts.has(p.refdes)).map(k).join(" ")}}`);
  console.log(`${refName.get(n)} ${n}: {${key}}  ->  ${nearPins.join("  ")}`);
}
