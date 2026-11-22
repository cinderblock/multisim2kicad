#!/usr/bin/env bun
/**
 * Explain a PCB scorecard miss: list EW net pins that don't land on a pad,
 * with the pads the named component does have.
 *
 *   bun run scripts/pindiff.ts <board.ewprj>
 */
import { loadDesign } from "../src/load.ts";
import { parsePcbXml } from "../src/parse/pcb.ts";

const [input] = Bun.argv.slice(2);
if (!input) {
  console.error("usage: pindiff <board.ewprj>");
  process.exit(2);
}
const { xml } = await loadDesign(input);
const b = parsePcbXml(xml);
const byRef = new Map(b.components.map((c) => [c.reference, c]));
for (const n of b.nets) {
  for (const p of n.pins) {
    const c = byRef.get(p.refdes);
    if (c?.pads.some((q) => q.number === p.pin)) continue;
    console.log(
      `${n.name}: ${p.refdes}.${p.pin}  ->  ${c ? `pads [${c.pads.map((q) => q.number).join(",")}] (${c.footprint ?? ""})` : "not placed on the board"}`,
    );
  }
}
