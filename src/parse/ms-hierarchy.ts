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
import { ciCollStrings, collValues, drawnPinNumbers } from "../ref/ci-netlist.ts";
import { displayText, docOf, type EwElement, type XmlInput } from "./doc.ts";

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
  designSheet: EwElement;
  edges: [string, string][];
  pins: PinRec[];
  symbols: Map<string, { kind: string; ciComp: string; obj: EwElement }>;
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

export interface CiItem {
  cls: string;
  body: EwElement;
}

const modsOf = (o: EwElement): Mod[] =>
  (o.at("ElectricalObject", "ModifierInfo")?.childrenNamed("Element") ?? []).flatMap((e) =>
    e.childrenNamed("Item").map((i) => ({ mod: e.str("NetModifier"), value: i.str("Value") })),
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

function indexPage(ds: EwElement, sheetComp: Map<string, string>, warnings: string[]): PageIndex {
  const pg: PageIndex = {
    title: ds.str("Title"),
    page: ds.str("PageName") || "1",
    designSheet: ds,
    edges: [],
    pins: [],
    symbols: new Map(),
    links: [],
  };
  // Drawing objects are `<Item Class=X ID=..><X ...>` wrappers; an owner
  // (symbol, connector, macro, pin) scopes the pins drawn inside it.
  const visit = (node: EwElement, owner: { id: string; kind: string } | null): void => {
    // Interactive parts (CIITAnimationSymbolComp: push-buttons, switches)
    // keep extra copies of their pins per animation state, never wired; the
    // real pins are the symbol's own Objects.
    if (node.name === "AnimationLayers") return;
    const cls = node.cls;
    const sid = node.get("ID");
    const o = cls ? node.child(cls) : undefined;
    if (sid != null && cls && o && !cls.startsWith("Ci")) {
      let next = owner;
      if (cls === "CIITLinkComp") {
        for (const c of [o.get("Connect1"), o.get("Connect2")]) if (c != null && c !== "0") pg.edges.push([sid, c]);
        pg.links.push({ id: sid, mods: modsOf(o) });
      } else if (cls === "CODPinComp" || cls === "CIITPinConnectorComp") {
        for (const c of o.child("ConnectList")?.childrenNamed("Item") ?? []) pg.edges.push([sid, c.get("ID") ?? ""]);
        if (cls === "CIITPinConnectorComp" && owner?.kind === "pin") pg.edges.push([sid, owner.id]);
      } else if (OWNER_CLASSES.has(cls)) {
        pg.symbols.set(sid, { kind: cls, ciComp: o.get("CiComponent") ?? "", obj: o });
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
            portId: o.get("PortID"),
            pinNumber: o.str("PinNumber"),
            pinName: o.str("PinName"),
            mods: modsOf(o),
          });
        } else {
          warnings.push(`orphan pin ${sid} on ${pg.title}/${pg.page}`);
        }
        next = { id: sid, kind: "pin" };
      }
      for (const c of o.children) visit(c, next);
      return;
    }
    if (cls === "CSheetComponentMSM" || cls === "CSheetComponent") {
      sheetComp.set(node.get("ObjectID") ?? "", node.str("SheetName"));
    }
    for (const c of node.children) visit(c, owner);
  };
  visit(ds, null);
  return pg;
}

/** Ci* items by CiID (used only for pin numbers, instance names, part kinds). */
function indexCi(proj: EwElement): Map<string, CiItem> {
  const ci = new Map<string, CiItem>();
  for (const o of proj.child("UniqueSheets")?.descendants() ?? []) {
    const cls = o.cls;
    if (!cls?.startsWith("Ci") || !o.has("CiID")) continue;
    const body = o.child(cls);
    if (body) ci.set(o.get("CiID")!, { cls, body });
  }
  return ci;
}

const strColls = (body: EwElement): string[][] => ciCollStrings(body).map(collValues);

export function parseMultisimDesign(input: XmlInput): MultisimDesign & { ci: Map<string, CiItem> } {
  const warnings: string[] = [];
  const { root: top } = docOf(input);
  const proj = top.name === "MSMElectronicsWorkbench" ? top.child("Project") : undefined;
  if (!proj) throw new Error("not a Multisim design");
  const ci = indexCi(proj);
  const sheetComp = new Map<string, string>();
  const pages = (proj.at("UniqueSheets", "SheetInfos")?.childrenNamed("SheetContainer") ?? [])
    .map((sc) => sc.at("Sheet", "Variable", "DesignSheet"))
    .filter((ds): ds is EwElement => ds != null)
    .map((ds) => indexPage(ds, sheetComp, warnings));
  const rootTitle = proj.child("DesignSheet")?.str("Title") || pages[0]?.title || "";

  // CIR path -> (key -> IR refdes), and pin remaps.
  const irMap = new Map<string, Map<string, string>>();
  const unitMap = new Map<string, number>(); // `${cir}|${key}` -> IRSectionID + 1
  const remaps = new Map<string, Map<string, string>>();
  for (const o of proj.child("Extensions")?.descendants() ?? []) {
    if (o.name !== "RefDesInfoContainer" || !o.has("CIR")) continue;
    const cir = o.str("CIR");
    const m = new Map<string, string>();
    for (const it of o.child("CIRToInfoMap")?.childrenNamed("CIRToInfoMapItem") ?? []) {
      const ri = it.child("RefDesInfo");
      const key = it.str("CIRKey");
      const prefix = ri?.str("IRPrefix") ?? "";
      const num = ri?.get("IRNumber");
      m.set(key, num === "-1" ? prefix : `${prefix}${num ?? ""}`);
      const sectionId = Number(ri?.get("IRSectionID") ?? -1);
      if (ri?.str("IRSection") && sectionId >= 0) unitMap.set(`${cir}|${key}`, sectionId + 1);
      const a = ri?.child("PinNumbersCIR")?.childrenNamed("PinNumbersCIRItem").map((x) => x.str("PinNumberCIR")) ?? [];
      const b = ri?.child("PinNumbersIR")?.childrenNamed("PinNumbersIRItem").map((x) => x.str("PinNumberIR")) ?? [];
      if (a.length && a.length === b.length && a.some((x, i) => x !== b[i])) remaps.set(`${cir}|${key}`, new Map(a.map((x, i) => [x, b[i]!])));
    }
    irMap.set(cir, m);
  }

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
        const iname = ci.get(s.ciComp)?.body.str("LocalName") ?? "";
        const child =
          s.obj.at("HierBlock", "CHierBlock")?.str("FileName") || sheetComp.get(s.obj.get("SheetComponentObjectID") ?? "") || "";
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
        const drawn = comp.body.str("LocalName");
        const key = drawn + owner.obj.str("DBComponentSectionName");
        const final = design.finalRefdes(inst, pg.page, key) ?? (depth === 0 ? drawn : `${inst.path}/${drawn}`);
        const remap = design.pinRemap(inst, pg.page, key);
        const nums = portPins(p.portId);
        const list = pinsAt.get(pk) ?? [];
        // Same numbering as the schematic emitter (sch.ts parsePins): netlist
        // port numbers, else the drawn pin number(s), else the pin name.
        // Simulation-only parts (sources, switches, meters) have no numbers.
        const drawnNums = drawnPinNumbers(p.pinNumber);
        const own = nums.length ? nums : drawnNums.length ? drawnNums : [displayText(p.pinName) || "?"];
        for (const n of own) list.push({ refdes: final, pin: remap?.get(n) ?? n });
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

  // One physical pin is one node: a pin number drawn on several sections of
  // a part (an op-amp's V+/V- on every section) joins all their nets, as in
  // the part itself.
  const pinHome = new Map<string, string>();
  for (const [k, ps] of pinsAt) {
    for (const p of ps) {
      if (p.pin === "?") continue;
      const id = JSON.stringify([p.refdes, p.pin]);
      const home = pinHome.get(id);
      if (home === undefined) pinHome.set(id, k);
      else union(k, home);
    }
  }

  const nets = new Map<string, NetPin[]>();
  for (const [k, ps] of pinsAt) {
    const r = find(k);
    nets.set(r, [...(nets.get(r) ?? []), ...ps]);
  }
  return nets;
}
