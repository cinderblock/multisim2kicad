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
import { XMLParser } from "fast-xml-parser";

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
  componentsById: Map<string, { refdes: string; kind: CiComponentKind }>;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const arr = <T,>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const asc = (s: unknown): string => {
  const v = typeof s === "string" ? s : s == null ? "" : String(s);
  return v.startsWith("&ASC") ? v.slice(4) : v;
};

/** Collect every `<Item CiID=.. Class="Ci...">` wrapper anywhere in the tree. */
function collectCiItems(node: unknown, out: Map<string, any[]>): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) collectCiItems(c, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  const cls = obj["@_Class"];
  if (typeof cls === "string" && cls.startsWith("Ci") && obj["@_CiID"] != null && obj[cls]) {
    const list = out.get(cls) ?? [];
    list.push({ id: String(obj["@_CiID"]), body: obj[cls] });
    out.set(cls, list);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("@_")) collectCiItems(v, out);
  }
}

/** All `CiaCollString` string values under an object's `Attributes`, in order. */
function attrStrings(body: any): string[] {
  const colls = [
    ...arr(body?.Attributes?.CiaCollString),
    ...arr(body?.Attributes?.Item).flatMap((it: any) => arr(it?.CiaCollString)),
  ];
  return colls.flatMap((c: any) => arr(c?.strings?.Item).map((s: any) => asc(s?.["@_Value"])));
}

function componentKind(body: any): CiComponentKind {
  const s = attrStrings(body).filter(Boolean);
  if (s.length <= 1) return "connector";
  if (s[0] === "POWER_SOURCES") return "power";
  return "part";
}

/** Pin-number CSV lives at strings[6] of a CiPort's second CiaCollString. */
function portPinNumbers(port: any): string[] {
  const colls = [
    ...arr(port?.Attributes?.CiaCollString),
    ...arr(port?.Attributes?.Item).flatMap((it: any) => arr(it?.CiaCollString)),
  ];
  const strings = arr(colls[1]?.strings?.Item);
  const csv = asc(strings[6]?.["@_Value"]);
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseCiNetlist(xml: string): CiNetlist {
  const tree = parser.parse(xml);
  const items = new Map<string, any[]>();
  collectCiItems(tree, items);

  const components = new Map<string, { refdes: string; circuit: string; kind: CiComponentKind }>();
  for (const { id, body } of items.get("CiComponent") ?? []) {
    components.set(id, {
      refdes: asc(body["@_LocalName"]),
      circuit: String(body["@_Circuit"] ?? ""),
      kind: componentKind(body),
    });
  }
  const instances = items.get("CiInstComponent") ?? [];

  const ports = new Map<string, { component: string; pins: string[] }>();
  for (const { id, body } of items.get("CiPort") ?? []) {
    ports.set(id, { component: String(body["@_Component"] ?? ""), pins: portPinNumbers(body) });
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
  for (const { body } of instances) circuit(String(body["@_Circuit"] ?? "")).instances.push(asc(body["@_LocalName"]));

  for (const { body } of items.get("CiNode") ?? []) {
    const c = circuit(String(body["@_Circuit"] ?? ""));
    const name = asc(body["@_LocalName"]);
    const list = c.nets.get(name) ?? [];
    for (const ref of arr(body?.Ports?.Item)) {
      const port = ports.get(String(ref?.["@_CiID"]));
      const comp = port && components.get(port.component);
      if (!port || !comp || comp.kind !== "part") continue; // instance ports / virtual parts
      for (const pin of port.pins) list.push({ refdes: comp.refdes, pin });
    }
    c.nets.set(name, list);
  }

  return {
    circuits: [...circuits.values()],
    hierarchical: instances.length > 0,
    componentsById: new Map([...components].map(([id, c]) => [id, { refdes: c.refdes, kind: c.kind }])),
  };
}
