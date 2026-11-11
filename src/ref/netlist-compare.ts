/**
 * Netlist comparison for the fidelity scorecard.
 *
 * A netlist here is `net name -> pins`, where a pin is `refdes.pin`. Net
 * names are not compared (KiCad invents names for unlabelled nets); only the
 * partition of pins into nets matters. Both sides are restricted to the same
 * set of components first, so parts one side doesn't know about don't count
 * as errors.
 */
import { XMLParser } from "fast-xml-parser";

export interface PinRef {
  refdes: string;
  pin: string;
}
export type Netlist = Map<string, PinRef[]>;

export interface NetlistScore {
  /** Reference nets with >= 2 pins, after restricting to shared components. */
  refNets: number;
  /** Of those, how many appear in the candidate with exactly the same pins. */
  exactNets: number;
  /** Same-net pin pairs: |ref ∩ got| / |got| and / |ref|. 1 = perfect. */
  pairPrecision: number;
  pairRecall: number;
  /** Components compared (present on both sides). */
  components: number;
  /** Components only in the reference / only in the candidate. */
  onlyRef: string[];
  onlyGot: string[];
  /** A few reference nets that were not reproduced, for debugging. */
  sampleMisses: string[];
}

const key = (p: PinRef) => `${p.refdes}.${p.pin}`;

/** Pin -> net-id map, keeping only pins whose refdes passes `keep`. */
function pinToNet(n: Netlist, keep: (refdes: string) => boolean): Map<string, string> {
  const m = new Map<string, string>();
  for (const [name, pins] of n) for (const p of pins) if (keep(p.refdes)) m.set(key(p), name);
  return m;
}

function groups(m: Map<string, string>): Map<string, string[]> {
  const g = new Map<string, string[]>();
  for (const [pin, net] of m) {
    const list = g.get(net) ?? [];
    list.push(pin);
    g.set(net, list);
  }
  return g;
}

function pairCount(g: Map<string, string[]>): number {
  let n = 0;
  for (const pins of g.values()) n += (pins.length * (pins.length - 1)) / 2;
  return n;
}

export function compareNetlists(ref: Netlist, got: Netlist): NetlistScore {
  const refComps = new Set([...ref.values()].flat().map((p) => p.refdes));
  const gotComps = new Set([...got.values()].flat().map((p) => p.refdes));
  const shared = (r: string) => refComps.has(r) && gotComps.has(r);

  const refPin = pinToNet(ref, shared);
  const gotPin = pinToNet(got, shared);
  const refGroups = groups(refPin);
  const gotGroups = groups(gotPin);

  // Pairs in common: for each ref net, bucket its pins by candidate net.
  let common = 0;
  const misses: string[] = [];
  let refNets = 0;
  let exactNets = 0;
  for (const [name, pins] of refGroups) {
    const byGot = new Map<string, number>();
    for (const p of pins) {
      const g = gotPin.get(p);
      if (g !== undefined) byGot.set(g, (byGot.get(g) ?? 0) + 1);
    }
    for (const c of byGot.values()) common += (c * (c - 1)) / 2;
    if (pins.length < 2) continue;
    refNets++;
    const only = byGot.size === 1 ? [...byGot.keys()][0] : undefined;
    if (only !== undefined && byGot.get(only) === pins.length && gotGroups.get(only)?.length === pins.length) {
      exactNets++;
    } else if (misses.length < 5) {
      misses.push(`${name}: ${pins.slice(0, 6).join(",")}${pins.length > 6 ? ",…" : ""}`);
    }
  }

  const refPairs = pairCount(refGroups);
  const gotPairs = pairCount(gotGroups);
  return {
    refNets,
    exactNets,
    pairPrecision: gotPairs === 0 ? (refPairs === 0 ? 1 : 0) : common / gotPairs,
    pairRecall: refPairs === 0 ? 1 : common / refPairs,
    components: [...refComps].filter(shared).length,
    onlyRef: [...refComps].filter((r) => !gotComps.has(r)).sort(),
    onlyGot: [...gotComps].filter((r) => !refComps.has(r)).sort(),
    sampleMisses: misses,
  };
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const arr = <T,>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Parse `kicad-cli sch export netlist --format kicadxml` output. */
export function parseKicadXmlNetlist(text: string): Netlist {
  const tree = xml.parse(text);
  const out: Netlist = new Map();
  for (const net of arr(tree?.export?.nets?.net)) {
    const name = String(net["@_name"] ?? net["@_code"]);
    out.set(
      name,
      arr(net.node).map((n: any) => ({ refdes: String(n["@_ref"]), pin: String(n["@_pin"]) })),
    );
  }
  return out;
}

/** Upper-case net names (Ultiboard upper-cases them) and merge duplicates. */
export function foldNetNames(n: Netlist): Netlist {
  const out: Netlist = new Map();
  for (const [name, pins] of n) {
    const k = name.toUpperCase();
    out.set(k, [...(out.get(k) ?? []), ...pins]);
  }
  return out;
}
