/**
 * Multisim design structure: pages, the hierarchical instance tree, final
 * (per-instance) reference designators, and the flattened netlist.
 *
 * Source of truth is the drawing's ID graph, not the cached Ci* netlist
 * (which goes stale; see plans/converter.md). Verified against Multisim's
 * own exports (.ewnet / .ewprj net tables) on every hierarchical corpus
 * design: e.g. Althea Main 96/96 nets, Heater (nested) 82/82.
 *
 * Encoding summary (details + evidence: plans/converter.md, "Hierarchy"):
 * - A page is one SheetContainer; a unique sheet is the set of pages sharing
 *   `DesignSheet@Title`. Nesting is not XML nesting: all pages are siblings.
 *   The root sheet's title is `Project > DesignSheet@Title`.
 * - An instance is a `CIITMacroComponent` on the parent page: child sheet =
 *   `CHierBlock@FileName` (or the CSheetComponentMSM it points at), instance
 *   name = `CiInstComponent@LocalName` via `@CiComponent`.
 * - Ports match by name: parent block pin `NI_EWB_NET_HIERARCHY_COMP` =
 *   child connector pin `NI_EWB_NET_HIERARCHY`.
 * - Final refdes: `RefDesInfoContainer[@CIR=<path>] > CIRToInfoMapItem
 *   [@CIRKey = drawn refdes + section] > RefDesInfo@IRPrefix/@IRNumber`
 *   (IRNumber -1 = bare prefix), with optional CIR->IR pin remaps. CIR paths
 *   are child-first: `#<page>/<sheet>:<inst>` + parent's path; root
 *   `#<page>/<root>:`.
 * - Joins: GLOBAL / GLOBAL_GROUND design-wide; VIRTUAL (on-page connector)
 *   per page instance; OFFPAGE per sheet instance; BUS_ENTRY by line name per
 *   sheet instance; user NET_NAME per page instance.
 *
 * Known gaps: bus ports across hierarchy (CIITBusHierConnector), external
 * hierarchical-block files (Subcircuit="0"), NI_EWB_NET_HIDDEN pins.
 */
import { XMLParser } from "fast-xml-parser";
import { decodeStr } from "./ew-strings.ts";

const arr = <T,>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export interface NetPin {
  refdes: string;
  pin: string;
}

interface Mod {
  mod: string;
  value: string;
}

interface PinRec {
  id: string;
  owner: string;
  ownerKind: string;
  portId?: string;
  pinNumber: string;
  pinName: string;
  mods: Mod[];
}

export interface PageIndex {
  title: string;
  page: string;
  /** The page's DesignSheet element (for drawing extraction). */
  designSheet: any;
  edges: [string, string][];
  pins: PinRec[];
  symbols: Map<string, { kind: string; ciComp: string; obj: any }>;
  links: { id: string; mods: Mod[] }[];
}

export interface SheetInstance {
  /** "" for the root, else "/SC1/SC4"-style path of drawn instance names. */
  path: string;
  sheet: string; // unique sheet title
  /** Drawn instance name (e.g. "SC1") and final name (e.g. "H0"). */
  name: string;
  finalName: string;
  /** Macro element ID on the parent page (for matching the sheet symbol). */
  macroId?: string;
  parentPath?: string;
  parentPage?: string;
  /** CIR path for one of this instance's pages. */
  cirOf: (page: string) => string;
  children: SheetInstance[];
}

export interface MultisimDesign {
  rootTitle: string;
  pages: PageIndex[];
  root: SheetInstance;
  /** Final refdes for a drawn part: (instance path, page, drawn refdes + section). */
  finalRefdes(inst: SheetInstance, page: string, drawnKey: string): string | undefined;
  /** CIR -> IR pin-number remap for a part, if any. */
  pinRemap(inst: SheetInstance, page: string, drawnKey: string): Map<string, string> | undefined;
  /** 1-based unit (section) of the final part this drawn symbol is, if multi-section. */
  finalUnit(inst: SheetInstance, page: string, drawnKey: string): number | undefined;
  warnings: string[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseAttributeValue: false, parseTagValue: false });

function visit(node: any, cb: (tag: string, obj: any) => void, tag = ""): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) visit(c, cb, tag);
    return;
  }
  if (tag) cb(tag, node);
  for (const [k, v] of Object.entries(node)) if (!k.startsWith("@_")) visit(v, cb, k);
}

const modsOf = (o: any): Mod[] =>
  arr(o?.ElectricalObject?.ModifierInfo?.Element).flatMap((e: any) =>
    arr(e.Item).map((i: any) => ({ mod: decodeStr(e["@_NetModifier"]), value: decodeStr(i["@_Value"]) })),
  );

const OWNER_CLASSES = new Set([
  "CIITSymbolComp",
  "CIITAnimationSymbolComp",
  "CIITOffPageConnector",
  "CBusOffpageConn",
  "CIITBusHierConnector",
  "CIITMacroComponent",
  "CVirtualConnector",
  "CIITHierConnector",
]);

function indexPage(ds: any, sheetComp: Map<string, string>, warnings: string[]): PageIndex {
  const pg: PageIndex = {
    title: decodeStr(ds?.["@_Title"]),
    page: decodeStr(ds?.["@_PageName"]) || "1",
    designSheet: ds,
    edges: [],
    pins: [],
    symbols: new Map(),
    links: [],
  };
  const walk = (node: any, owner: { id: string; kind: string } | null): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c, owner);
      return;
    }
    const cls = node["@_Class"];
    const id = node["@_ID"];
    if (id != null && typeof cls === "string" && node[cls] && !cls.startsWith("Ci")) {
      const o = node[cls];
      const sid = String(id);
      let next = owner;
      if (cls === "CIITLinkComp") {
        for (const c of [o["@_Connect1"], o["@_Connect2"]]) if (c != null && c !== "0") pg.edges.push([sid, String(c)]);
        pg.links.push({ id: sid, mods: modsOf(o) });
      } else if (cls === "CODPinComp" || cls === "CIITPinConnectorComp") {
        for (const c of arr(o.ConnectList?.Item)) pg.edges.push([sid, String(c["@_ID"])]);
        if (cls === "CIITPinConnectorComp" && owner?.kind === "pin") pg.edges.push([sid, owner.id]);
      } else if (OWNER_CLASSES.has(cls)) {
        pg.symbols.set(sid, { kind: cls, ciComp: String(o["@_CiComponent"] ?? ""), obj: o });
        next = { id: sid, kind: cls };
      } else if (cls === "CIITBusEntry") {
        pg.links.push({ id: sid, mods: modsOf(o) });
        next = { id: sid, kind: "pin" };
      } else if (cls === "CIITPinSymbolComp") {
        if (owner) {
          pg.pins.push({
            id: sid,
            owner: owner.id,
            ownerKind: owner.kind,
            portId: o["@_PortID"] != null ? String(o["@_PortID"]) : undefined,
            pinNumber: decodeStr(o["@_PinNumber"]),
            pinName: decodeStr(o["@_PinName"]),
            mods: modsOf(o),
          });
        } else {
          warnings.push(`orphan pin ${sid} on ${pg.title}/${pg.page}`);
        }
        next = { id: sid, kind: "pin" };
      }
      walk(o, next);
      return;
    }
    if (cls === "CSheetComponentMSM" || cls === "CSheetComponent") {
      sheetComp.set(String(node["@_ObjectID"]), decodeStr(node["@_SheetName"]));
    }
    for (const [k, v] of Object.entries(node)) if (!k.startsWith("@_")) walk(v, owner);
  };
  walk(ds, null);
  return pg;
}

/** Ci* items by CiID (used only for pin numbers, instance names, part kinds). */
function indexCi(proj: any) {
  const ci = new Map<string, { cls: string; body: any }>();
  visit(proj.UniqueSheets, (_t, o) => {
    const cls = o["@_Class"];
    if (typeof cls === "string" && cls.startsWith("Ci") && o["@_CiID"] != null && o[cls]) ci.set(String(o["@_CiID"]), { cls, body: o[cls] });
  });
  return ci;
}

const strColls = (body: any): string[][] =>
  [...arr(body?.Attributes?.CiaCollString), ...arr(body?.Attributes?.Item).flatMap((it: any) => arr(it?.CiaCollString))].map(
    (c: any) => arr(c?.strings?.Item).map((s: any) => decodeStr(s?.["@_Value"])),
  );

export function parseMultisimDesign(xml: string): MultisimDesign & { ci: Map<string, { cls: string; body: any }> } {
  const warnings: string[] = [];
  const tree = parser.parse(xml);
  const proj = tree?.MSMElectronicsWorkbench?.Project;
  if (!proj) throw new Error("not a Multisim design");
  const ci = indexCi(proj);
  const sheetComp = new Map<string, string>();
  const pages = arr(proj.UniqueSheets?.SheetInfos?.SheetContainer)
    .map((sc: any) => sc?.Sheet?.Variable?.DesignSheet)
    .filter(Boolean)
    .map((ds: any) => indexPage(ds, sheetComp, warnings));
  const rootTitle = decodeStr(proj.DesignSheet?.["@_Title"]) || pages[0]?.title || "";

  // CIR path -> (key -> IR refdes), and pin remaps.
  const irMap = new Map<string, Map<string, string>>();
  const unitMap = new Map<string, number>(); // `${cir}|${key}` -> IRSectionID + 1
  const remaps = new Map<string, Map<string, string>>();
  visit(proj.Extensions, (t, o) => {
    if (t !== "RefDesInfoContainer" || o["@_CIR"] == null) return;
    const cir = decodeStr(o["@_CIR"]);
    const m = new Map<string, string>();
    for (const it of arr(o.CIRToInfoMap?.CIRToInfoMapItem)) {
      const ri = it.RefDesInfo;
      const key = decodeStr(it["@_CIRKey"]);
      const prefix = decodeStr(ri?.["@_IRPrefix"]);
      m.set(key, String(ri?.["@_IRNumber"]) === "-1" ? prefix : `${prefix}${ri?.["@_IRNumber"] ?? ""}`);
      const sectionId = Number(ri?.["@_IRSectionID"] ?? -1);
      if (decodeStr(ri?.["@_IRSection"]) && sectionId >= 0) unitMap.set(`${cir}|${key}`, sectionId + 1);
      const a = arr(ri?.PinNumbersCIR?.PinNumbersCIRItem).map((x: any) => decodeStr(x["@_PinNumberCIR"]));
      const b = arr(ri?.PinNumbersIR?.PinNumbersIRItem).map((x: any) => decodeStr(x["@_PinNumberIR"]));
      if (a.length && a.length === b.length && a.some((x, i) => x !== b[i])) remaps.set(`${cir}|${key}`, new Map(a.map((x, i) => [x, b[i]!])));
    }
    irMap.set(cir, m);
  });

  // Instance tree.
  const build = (sheet: string, path: string, name: string, cirOf: (p: string) => string, depth: number): SheetInstance => {
    const inst: SheetInstance = { path, sheet, name, finalName: name, cirOf, children: [] };
    if (depth > 20) {
      warnings.push(`hierarchy deeper than 20 at ${path}`);
      return inst;
    }
    const pgs = pages.filter((p) => p.title === sheet);
    if (!pgs.length) warnings.push(`no pages for sheet "${sheet}" at ${path || "/"}`);
    for (const pg of pgs) {
      const cir = cirOf(pg.page);
      for (const [sid, s] of pg.symbols) {
        if (s.kind !== "CIITMacroComponent") continue;
        const iname = decodeStr(ci.get(s.ciComp)?.body?.["@_LocalName"]);
        const child =
          decodeStr(s.obj.HierBlock?.CHierBlock?.["@_FileName"]) || sheetComp.get(String(s.obj["@_SheetComponentObjectID"])) || "";
        if (!iname) warnings.push(`macro ${sid} has no CiInstComponent`);
        const c = build(child, `${path}/${iname}`, iname, (p) => `#${p}/${child}:${iname}${cir}`, depth + 1);
        c.macroId = sid;
        c.parentPath = path;
        c.parentPage = pg.page;
        c.finalName = irMap.get(cir)?.get(iname) ?? iname;
        inst.children.push(c);
      }
    }
    return inst;
  };
  const root = build(rootTitle, "", "", (p) => `#${p}/${rootTitle}:`, 0);

  return {
    rootTitle,
    pages,
    root,
    ci,
    warnings,
    finalRefdes: (inst, page, key) => irMap.get(inst.cirOf(page))?.get(key),
    pinRemap: (inst, page, key) => remaps.get(`${inst.cirOf(page)}|${key}`),
    finalUnit: (inst, page, key) => unitMap.get(`${inst.cirOf(page)}|${key}`),
  };
}

/**
 * Multisim's flattened netlist (final refdes, final pin numbers), built from
 * the drawing ID graph. This is the scorecard's reference.
 */
export function flattenNetlist(design: ReturnType<typeof parseMultisimDesign>): Map<string, NetPin[]> {
  const { ci, pages, warnings } = design;
  const portPins = (portId?: string): string[] => {
    const p = portId ? ci.get(portId) : undefined;
    return p ? (strColls(p.body)[1]?.[6] ?? "").split(",").map((x) => x.trim()).filter(Boolean) : [];
  };

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== r) {
      const n = parent.get(y)!;
      parent.set(y, r);
      y = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const pinsAt = new Map<string, NetPin[]>();
  const expand = (inst: SheetInstance, ports: Map<string, string>, depth: number) => {
    for (const pg of pages.filter((p) => p.title === inst.sheet)) {
      const K = (id: string) => `${inst.path}|${pg.page}|${id}`;
      for (const [a, b] of pg.edges) union(K(a), K(b));
      for (const l of pg.links) {
        for (const m of l.mods) {
          if (m.mod === "NI_EWB_NET_NAME" && m.value) union(K(l.id), `${inst.path}|${pg.page}|NAME:${m.value}`);
          if (m.mod === "NI_EWB_NET_BUS_ENTRY") union(K(l.id), `${inst.path}|BUSLINE:${m.value}`);
        }
      }
      for (const p of pg.pins) {
        const pk = K(p.id);
        find(pk);
        for (const m of p.mods) {
          if (m.mod === "NI_EWB_NET_GLOBAL" || m.mod === "NI_EWB_NET_GLOBAL_GROUND") union(pk, `G:${m.value.toUpperCase()}`);
          else if (m.mod === "NI_EWB_NET_VIRTUAL") union(pk, `${inst.path}|${pg.page}|ONPAGE:${m.value}`);
          else if (m.mod === "NI_EWB_NET_OFFPAGE") union(pk, `${inst.path}|OFFPAGE:${m.value}`);
          else if (m.mod === "NI_EWB_NET_HIERARCHY") {
            const pkey = ports.get(m.value);
            if (pkey) union(pk, pkey);
            else if (depth > 0) warnings.push(`no parent port for ${m.value} at ${inst.path}`);
          }
        }
        const owner = pg.symbols.get(p.owner);
        if ((p.ownerKind !== "CIITSymbolComp" && p.ownerKind !== "CIITAnimationSymbolComp") || !owner) continue;
        const comp = ci.get(owner.ciComp);
        if (!comp) {
          warnings.push(`symbol ${p.owner} CiComponent ${owner.ciComp} missing`);
          continue;
        }
        const s = strColls(comp.body);
        if (s[0]?.[0] === "POWER_SOURCES" || s[1]?.[0] === "91") continue; // power / connector: joined by modifier
        const drawn = decodeStr(comp.body["@_LocalName"]);
        const key = drawn + decodeStr(owner.obj["@_DBComponentSectionName"]);
        const final = design.finalRefdes(inst, pg.page, key) ?? (depth === 0 ? drawn : `${inst.path}/${drawn}`);
        const remap = design.pinRemap(inst, pg.page, key);
        const nums = portPins(p.portId);
        const list = pinsAt.get(pk) ?? [];
        for (const n of nums.length ? nums : [p.pinNumber]) list.push({ refdes: final, pin: remap?.get(n) ?? n });
        pinsAt.set(pk, list);
      }
      for (const child of inst.children.filter((c) => c.parentPage === pg.page)) {
        const pmap = new Map<string, string>();
        for (const p of pg.pins.filter((x) => x.owner === child.macroId)) {
          const nm = p.mods.find((m) => m.mod === "NI_EWB_NET_HIERARCHY_COMP")?.value ?? p.pinName;
          pmap.set(nm, K(p.id));
        }
        expand(child, pmap, depth + 1);
      }
    }
  };
  expand(design.root, new Map(), 0);

  const nets = new Map<string, NetPin[]>();
  for (const [k, ps] of pinsAt) {
    const r = find(k);
    nets.set(r, [...(nets.get(r) ?? []), ...ps]);
  }
  return nets;
}
