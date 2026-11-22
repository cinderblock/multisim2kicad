/**
 * Multisim's own netlist, read from the `Ci*` objects in a `.ms1x` file.
 *
 * Each `CiCircuit` (one per unique sheet / subcircuit) owns `CiComponent`s
 * (refdes in `LocalName`), `CiPort`s (one per symbol pin, pointing back at
 * its component and holding the pin-number CSV) and `CiNode`s (nets: name in
 * `LocalName`, member ports in `Ports > Item@CiID`). Hierarchical instances
 * are `CiInstComponent`s; flattening them needs the per-instance refdes map
 * and is Phase D1 work, so for now this returns each circuit separately and
 * reports whether the design is hierarchical.
 *
 * This is EW format knowledge, so it is a candidate to move into ewd (Phase
 * B3) once it settles.
 */
import { docOf, type EwElement, type XmlInput } from "../parse/doc.ts";

export interface CiPinRef {
  refdes: string;
  pin: string;
}

/**
 * - `part`: a real component (has a manufacturer/family record).
 * - `power`: ground / supply symbols (family `POWER_SOURCES`).
 * - `connector`: virtual net joiners (on/off-page connectors, net-label
 *   components); their attribute record is a single type code.
 */
export type CiComponentKind = "part" | "power" | "connector";

export interface CiCircuitNetlist {
  id: string;
  /** Net name -> pins on it. Only `part` pins with pin numbers are included. */
  nets: Map<string, CiPinRef[]>;
  /** Refdes of every `part` in this circuit. */
  components: string[];
  /** Refdes -> kind, for every component (parts, power, connectors). */
  kinds: Map<string, CiComponentKind>;
  instances: string[];
}

export interface CiNetlist {
  circuits: CiCircuitNetlist[];
  hierarchical: boolean;
  /** CiComponent id (as referenced by a drawing's `CiComponent=` attr) -> refdes + kind. */
  componentsById: Map<string, { refdes: string; kind: CiComponentKind; part?: string }>;
}

/** Every `<Item CiID=.. Class="Ci...">` wrapper's body element, by class, in document order. */
export function collectCiItems(root: EwElement): Map<string, { id: string; body: EwElement }[]> {
  const out = new Map<string, { id: string; body: EwElement }[]>();
  for (const e of root.descendants()) {
    const cls = e.cls;
    if (!cls?.startsWith("Ci") || !e.has("CiID")) continue;
    const body = e.child(cls);
    if (!body) continue;
    const list = out.get(cls) ?? [];
    list.push({ id: e.get("CiID")!, body });
    out.set(cls, list);
  }
  return out;
}

/** A Ci object's `CiaCollString` records: direct ones, then those wrapped in `Item`s. */
export function ciCollStrings(body: EwElement): EwElement[] {
  const attrs = body.child("Attributes");
  if (!attrs) return [];
  return [
    ...attrs.childrenNamed("CiaCollString"),
    ...attrs.childrenNamed("Item").flatMap((it) => it.childrenNamed("CiaCollString")),
  ];
}

/** The decoded `Value`s of one `CiaCollString`. */
export const collValues = (coll: EwElement | undefined): string[] =>
  coll?.child("strings")?.childrenNamed("Item").map((s) => s.str("Value")) ?? [];

/** All `CiaCollString` string values under an object's `Attributes`, in order. */
const attrStrings = (body: EwElement): string[] => ciCollStrings(body).flatMap(collValues);

/**
 * Ground / supply symbols: the `POWER_SOURCES` family, or the older
 * database's ground (`GROUND, GROUND, VIRTUAL_DEVICES`, seen in NI's RF
 * samples). `record` is the component's attribute strings, in order.
 */
export const isPowerRecord = (record: readonly string[]): boolean =>
  record[0] === "POWER_SOURCES" || (record[0] === "GROUND" && record[2] === "VIRTUAL_DEVICES");

function componentKind(body: EwElement): CiComponentKind {
  const s = attrStrings(body).filter(Boolean);
  if (s.length <= 1) return "connector";
  if (isPowerRecord(s)) return "power";
  return "part";
}

/**
 * The part's EW database name. Database parts list `family, name, family`
 * in their attribute strings (`MicroFit, 43650-04-11, MicroFit, ...`;
 * virtual parts the same further in); basic parts (resistors) are all
 * numbers and have none.
 */
export function dbPartName(body: EwElement): string | undefined {
  const s = attrStrings(body);
  for (let i = 0; i + 2 < Math.min(s.length, 24); i++) {
    if (/[A-Za-z]/.test(s[i]!) && s[i] === s[i + 2] && s[i + 1] && s[i + 1]!.length < 64) return s[i + 1];
  }
  return undefined;
}

/** Pin-number CSV lives at strings[6] of a CiPort's second CiaCollString. */
export function portPinNumbers(port: EwElement): string[] {
  const csv = collValues(ciCollStrings(port)[1])[6] ?? "";
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * A pin's drawn number(s) (`CIITPinSymbolComp@PinNumber`). Instruments
 * (multimeters, scopes, analyzers) show "##" as a placeholder; like an empty
 * number, it means "use the pin name".
 */
export function drawnPinNumbers(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter((s) => s && !/^#+$/.test(s));
}

export function parseCiNetlist(input: XmlInput): CiNetlist {
  const items = collectCiItems(docOf(input).root);

  const components = new Map<string, { refdes: string; circuit: string; kind: CiComponentKind; part?: string }>();
  for (const { id, body } of items.get("CiComponent") ?? []) {
    components.set(id, {
      refdes: body.str("LocalName"),
      circuit: body.get("Circuit") ?? "",
      kind: componentKind(body),
      part: dbPartName(body),
    });
  }
  const instances = items.get("CiInstComponent") ?? [];

  const ports = new Map<string, { component: string; pins: string[] }>();
  for (const { id, body } of items.get("CiPort") ?? []) {
    ports.set(id, { component: body.get("Component") ?? "", pins: portPinNumbers(body) });
  }

  const circuits = new Map<string, CiCircuitNetlist>();
  const circuit = (id: string): CiCircuitNetlist => {
    let c = circuits.get(id);
    if (!c) {
      c = { id, nets: new Map(), components: [], kinds: new Map(), instances: [] };
      circuits.set(id, c);
    }
    return c;
  };
  for (const { id } of items.get("CiCircuit") ?? []) circuit(id);
  for (const comp of components.values()) {
    const c = circuit(comp.circuit);
    c.kinds.set(comp.refdes, comp.kind);
    if (comp.kind === "part" && !c.components.includes(comp.refdes)) c.components.push(comp.refdes);
  }
  for (const { body } of instances) circuit(body.get("Circuit") ?? "").instances.push(body.str("LocalName"));

  for (const { body } of items.get("CiNode") ?? []) {
    const c = circuit(body.get("Circuit") ?? "");
    const name = body.str("LocalName");
    const list = c.nets.get(name) ?? [];
    for (const ref of body.child("Ports")?.childrenNamed("Item") ?? []) {
      const port = ports.get(ref.get("CiID") ?? "");
      const comp = port && components.get(port.component);
      if (!port || !comp || comp.kind !== "part") continue; // instance ports / virtual parts
      for (const pin of port.pins) list.push({ refdes: comp.refdes, pin });
    }
    c.nets.set(name, list);
  }

  return {
    circuits: [...circuits.values()],
    hierarchical: instances.length > 0,
    componentsById: new Map([...components].map(([id, c]) => [id, { refdes: c.refdes, kind: c.kind, part: c.part }])),
  };
}
