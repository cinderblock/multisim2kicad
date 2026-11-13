import { describe, expect, test } from "bun:test";
import { parseEwXml } from "electronics-workbench-decoder";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { harmonizeFootprints } from "./emit/footprint-lib.ts";
import { emitKicadPcb } from "./emit/kicad-pcb.ts";
import { boardCustomRules, boardProjectSettings, netClassName } from "./emit/kicad-pro.ts";
import { emitKicadSch, emitKicadSchProject } from "./emit/kicad-sch.ts";
import { parsePcbXml, parseUbLibraryXml } from "./parse/pcb.ts";
import { applyD, flipToDihedral, parseSchematicXml, placementStats } from "./parse/sch.ts";
import { ccwSweep, roundedPolygon, ubPrimitive } from "./parse/ub-geom.ts";
import { drawnPinNumbers, parseCiNetlist } from "./ref/ci-netlist.ts";
import { compareNetlists, foldNetNames, type Netlist } from "./ref/netlist-compare.ts";
import type { Board, Component, Dihedral, Point, Schematic, SchematicSymbol, SchPoint } from "./ir/types.ts";
import { checkSexp } from "./util/check-sexp.ts";
import { atom, listsNamed, parseSexpr, type Sexpr } from "./util/sexpr.ts";

const el = (xml: string) => parseEwXml(xml).root;
const sample = (name: string) => readFileSync(join(import.meta.dir, "..", "samples", name), "utf8");

describe("ub-geom", () => {
  test("pie sweeps counter-clockwise from start to end", () => {
    const c = { x: 0, y: 0 };
    // Half pie from +x to -x CCW must pass through +y (upper half).
    const prim = ubPrimitive("UBPie", el(`<UBPie Radius="1000"><Object><Point X="1000" Y="0"/><Point X="-1000" Y="0"/><Point X="0" Y="0"/></Object></UBPie>`));
    expect(prim?.kind).toBe("poly");
    const ys = prim?.kind === "poly" ? prim.points.map((p) => p.y) : [];
    expect(Math.max(...ys)).toBeCloseTo(1000, 0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-6);
    expect(ccwSweep(c, { x: 1, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
    expect(ccwSweep(c, { x: 0, y: 1 }, { x: 1, y: 0 })).toBeCloseTo((3 * Math.PI) / 2);
  });

  test("arc with start == end is a full circle", () => {
    const prim = ubPrimitive("UBArc", el(`<UBArc Radius="500" LineThickness="100"><Object><Point X="500" Y="0"/><Point X="500" Y="0"/><Point X="0" Y="0"/></Object></UBArc>`));
    expect(prim).toEqual({ kind: "circle", center: { x: 0, y: 0 }, radius: 500, width: 100, fill: false });
  });

  test("rounded rectangle stays within its corners", () => {
    const sq = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }];
    const poly = roundedPolygon(sq, 200);
    for (const p of poly) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x).toBeLessThanOrEqual(1000 + 1e-6);
    }
    // Corners are cut: no point at the exact square corner.
    expect(poly.some((p) => Math.hypot(p.x, p.y) < 1)).toBe(false);
  });
});

describe("netlist comparison", () => {
  const n = (o: Record<string, string[]>): Netlist =>
    new Map(Object.entries(o).map(([k, v]) => [k, v.map((s) => ({ refdes: s.split(".")[0]!, pin: s.split(".")[1]! }))]));

  test("identical partitions score perfectly regardless of names", () => {
    const s = compareNetlists(n({ A: ["R1.1", "R2.1"], B: ["R1.2", "R2.2"] }), n({ X: ["R2.1", "R1.1"], Y: ["R1.2", "R2.2"] }));
    expect([s.exactNets, s.refNets, s.pairPrecision, s.pairRecall]).toEqual([2, 2, 1, 1]);
  });

  test("a merged net costs precision, a split net costs recall", () => {
    const ref = n({ A: ["R1.1", "R2.1"], B: ["R1.2", "R2.2"] });
    expect(compareNetlists(ref, n({ X: ["R1.1", "R2.1", "R1.2", "R2.2"] })).pairPrecision).toBeCloseTo(2 / 6);
    expect(compareNetlists(ref, n({ X: ["R1.1"], Y: ["R2.1"], Z: ["R1.2", "R2.2"] })).pairRecall).toBeCloseTo(1 / 2);
  });

  test("components on only one side are ignored", () => {
    const s = compareNetlists(n({ A: ["R1.1", "R2.1"] }), n({ A: ["R1.1", "R2.1", "C9.1"] }));
    expect(s.pairPrecision).toBe(1);
    expect(s.onlyGot).toEqual(["C9"]);
  });

  test("foldNetNames merges case variants", () => {
    expect([...foldNetNames(n({ En: ["U1.3"], EN: ["U4.3"] })).keys()]).toEqual(["EN"]);
  });
});

describe("Design1 PCB (samples/Design1.ewprj.xml)", () => {
  const board = parsePcbXml(sample("Design1.ewprj.xml"));

  test("parses components, pads, nets and holes", () => {
    expect(board.components.length).toBe(3);
    expect(board.components.reduce((n, c) => n + c.pads.length, 0)).toBe(51);
    expect(board.nets.length).toBe(3);
    expect(board.holes.filter((h) => !h.plated).length).toBe(4);
  });

  test("every net pin lands on a pad except the source's POEA/POEC naming quirk", () => {
    const pads = new Set(board.components.flatMap((c) => c.pads.map((p) => `${c.reference}.${p.number}`)));
    const missing = board.nets.flatMap((n) => n.pins).filter((p) => !pads.has(`${p.refdes}.${p.pin}`));
    expect(missing.map((p) => `${p.refdes}.${p.pin}`).sort()).toEqual(["U1.POEA", "U1.POEC"]);
  });

  test("emits balanced S-expressions with netted tracks", () => {
    const out = emitKicadPcb(board);
    expect(checkSexp(out).ok).toBe(true);
    const segs = out.match(/\(segment [^\n]*/g) ?? [];
    expect(segs.length).toBe(6);
    expect(segs.every((s) => !s.includes("(net 0)"))).toBe(true);
  });
});

describe("EW database footprints (F)", () => {
  test("a library object's UBComponent parses like a placed one", () => {
    const xml = sample("Design1.ewprj.xml");
    const start = xml.indexOf("<UBComponent ");
    const end = xml.indexOf("</UBComponent>", start) + "</UBComponent>".length;
    const lib = `<?xml version="1.0" encoding="ASCII"?>\n<LibraryObject Schema="66">\n<LibraryObject Class="CLibraryObject" RefPointX="0" RefPointY="0">\n<List Class="CDrwObList">\n${xml.slice(start, end)}\n</List>\n</LibraryObject>\n</LibraryObject>\n`;
    const c = parseUbLibraryXml(lib)!;
    const placed = parsePcbXml(xml).components[0]!;
    expect(c.pads.map((p) => [p.number, p.at])).toEqual(placed.pads.map((p) => [p.number, p.at]));
    expect(c.graphics.length).toBe(placed.graphics.length);
  });
});

describe("design rules (C7)", () => {
  const board = parsePcbXml(sample("Design1.ewprj.xml"));

  test("board defaults come from BoardLayerSettings and the Design-Rules via", () => {
    expect(board.rules).toEqual({
      clearance: { trace: 101_600, pad: 101_600, via: 101_600, area: 101_600 },
      trackWidth: 101_600,
      minTrackWidth: 101_600,
      edgeClearance: 203_200,
      via: { diameter: 604_798, drill: 299_998 },
    });
  });

  test("nets that differ from the defaults get a net class per distinct rule pair", () => {
    const nets = [
      { name: "A", pins: [] },
      { name: "B", pins: [], clearance: 203_200 },
      { name: "C", pins: [], clearance: 203_200, trackWidth: 101_600 },
      { name: "D", pins: [], trackWidth: 508_000 },
    ];
    const pro = boardProjectSettings({ ...board, nets })!;
    const classes = pro.netSettings.classes as { name: string; clearance: number; track_width: number }[];
    expect(classes.map((c) => [c.name, c.clearance, c.track_width])).toEqual([
      ["Default", 0.1016, 0.1016],
      [netClassName(101_600, 508_000), 0.1016, 0.508],
      [netClassName(203_200, 101_600), 0.2032, 0.1016],
    ]);
    expect(pro.netSettings.netclass_patterns).toEqual([
      { netclass: netClassName(101_600, 508_000), pattern: "D" },
      { netclass: netClassName(203_200, 101_600), pattern: "B" },
      { netclass: netClassName(203_200, 101_600), pattern: "C" },
    ]);
    expect(pro.rules).toEqual({ min_track_width: 0.1016, min_copper_edge_clearance: 0.2032, min_hole_clearance: 0.1016, min_through_hole_diameter: 0, min_via_diameter: 0 });
  });

  test("separate pad / via clearances become custom rules", () => {
    expect(boardCustomRules(board)).toBeUndefined();
    const dru = boardCustomRules({ ...board, rules: { ...board.rules!, clearance: { trace: 177_800, pad: 177_800, via: 254_000, area: 254_000 } } })!;
    expect(dru).toContain(`(condition "A.Type == 'Via' || B.Type == 'Via'")`);
    expect(dru).toContain("(constraint clearance (min 0.254mm))");
    expect(dru).not.toContain("'Pad'");
  });
});

describe("footprint library (E3)", () => {
  // A part as Ultiboard stores it (already placed), from a library drawing.
  const placedFrom = (rotDeg: number, bottom: boolean, local: Point[]): Point[] => {
    const t = ((bottom ? -rotDeg : rotDeg) * Math.PI) / 180;
    return local.map((l) => {
      const x = bottom ? -l.x : l.x;
      return { x: 5_000_000 + Math.round(x * Math.cos(t) - l.y * Math.sin(t)), y: 7_000_000 + Math.round(x * Math.sin(t) + l.y * Math.cos(t)) };
    });
  };
  const part = (ref: string, rotDeg: number, bottom: boolean, turn = 0): Component => {
    const [p1, p2, a, b] = placedFrom(rotDeg + turn, bottom, [{ x: -800_000, y: 0 }, { x: 800_000, y: 0 }, { x: -1_500_000, y: 700_000 }, { x: 1_500_000, y: 700_000 }]);
    const pad = (number: string, at: Point): Component["pads"][number] => ({
      number, at, rotation: (rotDeg + turn) * 1_000_000, shape: { kind: "rect", width: 1_000_000, height: 950_000 }, drillDiameter: 0, side: bottom ? "bottom" : "top",
    });
    return {
      reference: ref, value: "C", name: "CAP", origin: { x: 5_000_000, y: 7_000_000 }, rotation: rotDeg * 1_000_000, bottom,
      pads: [pad("1", p1!), pad("2", p2!)],
      graphics: [{ kind: "polyline", layer: bottom ? 67 : 66, thickness: 120_000, points: [a!, b!] }],
      texts: [],
    };
  };
  const board = (components: Component[]): Board => ({
    source: { application: "t", versionMajor: 0, versionMinor: 0, schema: 0 }, projectName: "t", sheetTitle: "t",
    workArea: { left: 0, bottom: 0, right: 0, top: 0 }, layers: [], stackup: { copper: [0, 63], thickness: 1_600_000 },
    zones: [], texts: [], ruleAreas: [], shapes: [], tracks: [], holes: [], vias: [], nets: [], components,
  });

  test("copies at any angle and side share one library drawing", () => {
    const parts = [part("C1", 0, false), part("C2", 30, false), part("C3", 90, true), part("C4", 217.5, true)];
    const h = harmonizeFootprints(board(parts));
    expect([...h.library.keys()]).toEqual(["CAP"]);
    const lib = h.library.get("CAP")!;
    expect(lib.pads.map((p) => [p.at.x, p.at.y, p.side])).toEqual([[-800_000, 0, "top"], [800_000, 0, "top"]]);
    expect(lib.graphics[0]!.layer).toBe(66);
    // Placing from the library reproduces every copy (to Ultiboard's 1 nm).
    h.board.components.forEach((c, i) => {
      c.pads.forEach((p, k) => {
        expect(Math.abs(p.at.x - parts[i]!.pads[k]!.at.x)).toBeLessThanOrEqual(2);
        expect(Math.abs(p.at.y - parts[i]!.pads[k]!.at.y)).toBeLessThanOrEqual(2);
      });
    });
  });

  test("a copy turned a half-turn from its recorded rotation is the same footprint", () => {
    const h = harmonizeFootprints(board([part("C1", 0, false), part("C2", 90, true, 180)]));
    expect([...h.library.keys()]).toEqual(["CAP"]);
    expect(h.board.components[1]!.rotation).toBe(270_000_000);
  });

  test("a copy drawn differently becomes a variant", () => {
    const odd = part("C2", 0, false);
    odd.graphics[0]!.kind === "polyline" && (odd.graphics[0]!.points[0] = { x: 0, y: 0 });
    const h = harmonizeFootprints(board([part("C1", 0, false), odd]));
    expect([...h.library.keys()]).toEqual(["CAP", "CAP_2"]);
    expect(h.board.components.map((c) => c.name)).toEqual(["CAP", "CAP_2"]);
  });
});

describe("schematic pin numbers", () => {
  test("instrument placeholders and blanks fall back to the pin name", () => {
    expect(drawnPinNumbers("##")).toEqual([]);
    expect(drawnPinNumbers("")).toEqual([]);
    expect(drawnPinNumbers("4, 8")).toEqual(["4", "8"]);
    expect(drawnPinNumbers("A#")).toEqual(["A#"]);
  });
});

describe("footprint placement (C6)", () => {
  // KiCad places footprint items at origin + R(phi) * local, Y-down, R
  // counter-clockwise on screen. Whatever orientation the emitter picks, that
  // must land every pad and drawing back on its absolute EW position.
  const component = (bottom: boolean): Component => ({
    reference: bottom ? "U2" : "U1",
    value: "X",
    name: "PKG",
    origin: { x: 10_000_000, y: 5_000_000 },
    rotation: 30_000_000,
    bottom,
    pads: [{ number: "1", at: { x: 12_000_000, y: 6_000_000 }, rotation: 30_000_000, shape: { kind: "rect", width: 1_000_000, height: 500_000 }, drillDiameter: 0, side: bottom ? "bottom" : "top" }],
    graphics: [{ kind: "polyline", layer: bottom ? 67 : 66, thickness: 150_000, points: [{ x: 9_000_000, y: 4_000_000 }, { x: 11_000_000, y: 7_000_000 }] }],
    texts: [],
  });
  const board: Board = {
    source: { application: "test", versionMajor: 0, versionMinor: 0, schema: 0 },
    projectName: "t", sheetTitle: "t", workArea: { left: 0, bottom: 0, right: 0, top: 0 },
    layers: [], stackup: { copper: [0, 63], thickness: 1_600_000 },
    zones: [], texts: [], ruleAreas: [], shapes: [], tracks: [], holes: [], vias: [], nets: [],
    components: [component(false), component(true)],
  };
  const footprints = listsNamed(parseSexpr(emitKicadPcb(board))[0] as Sexpr[], "footprint");
  const num = (x: Sexpr | undefined) => Number(x as string);
  const place = (fp: Sexpr[], local: Sexpr[]) => {
    const [, ox, oy, phi] = listsNamed(fp, "at")[0]!;
    const t = (num(phi ?? "0") * Math.PI) / 180;
    const [x, y] = [num(local[1]), num(local[2])];
    // R(phi) on screen with Y down: x' = x cos + y sin, y' = -x sin + y cos.
    return { x: num(ox) + x * Math.cos(t) + y * Math.sin(t), y: num(oy) - x * Math.sin(t) + y * Math.cos(t) };
  };

  for (const [i, side] of [[0, "top"], [1, "bottom"]] as const) {
    test(`${side}: pads and drawings land on their EW positions`, () => {
      const fp = footprints[i]!;
      expect(atom(fp, "layer")).toBe(side === "top" ? "F.Cu" : "B.Cu");
      const pad = listsNamed(fp, "pad")[0]!;
      const p = place(fp, listsNamed(pad, "at")[0]!);
      expect(p.x).toBeCloseTo(12, 6);
      expect(p.y).toBeCloseTo(-6, 6);
      // Pad angles are absolute in KiCad files.
      expect(num(listsNamed(pad, "at")[0]![3])).toBeCloseTo(30, 6);
      const line = listsNamed(fp, "fp_line")[0]!;
      const a = place(fp, listsNamed(line, "start")[0]!);
      const b = place(fp, listsNamed(line, "end")[0]!);
      // Local coordinates are written to the nanometre, so allow 2 nm.
      [a.x, a.y, b.x, b.y].forEach((v, k) => expect(Math.abs(v - [9, -4, 11, -7][k]!)).toBeLessThan(2e-6));
      expect(atom(line, "layer")).toBe(side === "top" ? "F.SilkS" : "B.SilkS");
    });
  }

  test("a bottom part is its top-side footprint flipped the KiCad way", () => {
    // One EW part drawing (local pad at (2, 1) mm, Y-up) placed per the C6
    // survey: top = o + R(rot) * l, bottom = o + R(-rot) * mirrorX(l).
    const rot = 30;
    const at = (bottom: boolean) => {
      const t = ((bottom ? -rot : rot) * Math.PI) / 180;
      const [lx, ly] = [bottom ? -2_000_000 : 2_000_000, 1_000_000];
      return { x: 10_000_000 + lx * Math.cos(t) - ly * Math.sin(t), y: 5_000_000 + lx * Math.sin(t) + ly * Math.cos(t) };
    };
    const parts = [false, true].map((bottom) => {
      const c = component(bottom);
      c.pads[0]!.at = at(bottom);
      return c;
    });
    const fps = listsNamed(parseSexpr(emitKicadPcb({ ...board, components: parts }))[0] as Sexpr[], "footprint");
    const local = (fp: Sexpr[]) => listsNamed(listsNamed(fp, "pad")[0]!, "at")[0]!.slice(1, 3).map(num);
    const [tx, ty] = local(fps[0]!);
    const [bx, by] = local(fps[1]!);
    // KiCad flips a footprint by negating local Y, keeping X.
    expect(tx).toBeCloseTo(2, 5);
    expect(ty).toBeCloseTo(-1, 5);
    expect(bx).toBeCloseTo(tx!, 5);
    expect(by).toBeCloseTo(-ty!, 5);
    expect(num(listsNamed(fps[1]!, "at")[0]![3])).toBeCloseTo(180 - rot, 6);
  });
});

describe("Design1 schematic (samples/Design1.ms14.xml)", () => {
  const xml = sample("Design1.ms14.xml");

  test("Ci* reference netlist", () => {
    const ci = parseCiNetlist(xml);
    expect(ci.hierarchical).toBe(false);
    expect(ci.circuits.length).toBe(1);
    const c = ci.circuits[0]!;
    expect(c.components.length).toBe(19);
    expect(c.nets.get("Reset")).toEqual([{ refdes: "U2", pin: "26" }, { refdes: "U1", pin: "34" }]);
    expect(c.kinds.get("0")).toBe("power");
  });

  test("emits balanced S-expressions", () => {
    const out = emitKicadSch(parseSchematicXml(xml));
    expect(checkSexp(out).ok).toBe(true);
  });

  test("drawing: real wires, power ports, connectors", () => {
    const sheet = parseSchematicXml(xml).sheets[0]!;
    expect(sheet.wires.length).toBe(121); // CIITLinkComp, not border lines
    expect(sheet.symbols.filter((s) => s.kind === "part").length).toBe(19);
    expect(sheet.symbols.filter((s) => s.kind === "power").length).toBe(33);
    expect(sheet.labels.filter((l) => l.kind === "global").length).toBe(91);
    // Copy-pasted wiring only lines up once each link's own transform applies.
    const has = (x0: number, y0: number, x1: number, y1: number) =>
      sheet.wires.some((w) => w.points.length === 2 && w.points[0]!.x === x0 && w.points[0]!.y === y0 && w.points[1]!.x === x1 && w.points[1]!.y === y1);
    expect(has(837, 81, 837, 72)).toBe(true);
  });

  test("pins land on their wiring attachment points", () => {
    const before = { ...placementStats };
    parseSchematicXml(xml);
    const pins = placementStats.pins - before.pins;
    const hits = placementStats.pinsOnTarget - before.pinsOnTarget;
    expect(pins).toBeGreaterThan(150);
    expect(hits / pins).toBeGreaterThan(0.98);
  });
});

describe("symbol library (D4/E3)", () => {
  // A resistor as Multisim stores it: pins and body in a local frame with an
  // arbitrary offset, sometimes with a rotation baked into the drawing.
  const resistor = (ref: string, at: SchPoint, off: SchPoint, turned: boolean, flip = 0): SchematicSymbol => {
    const v = (x: number, y: number) => (turned ? { x: off.x + y, y: off.y - x } : { x: off.x + x, y: off.y + y });
    const d = (x: number, y: number) => (turned ? { x: y, y: -x } : { x, y });
    return {
      reference: ref, value: "1k", kind: "part", at, transform: flipToDihedral(flip), partName: "RESISTOR",
      graphics: [{ kind: "polyline", points: [v(0, -9), v(-3, -6), v(3, 0), v(0, 9)], width: 0, fill: false }],
      pins: [
        { name: "1", number: "1", at: v(0, -18), dir: d(0, 1), length: 9 },
        { name: "2", number: "2", at: v(0, 19), dir: d(0, -1), length: 10 },
      ],
      showPinNames: false, showPinNumbers: false,
    };
  };
  const syms = [resistor("R1", { x: 40, y: 40 }, { x: 7, y: 3 }, false), resistor("R2", { x: 90, y: 40 }, { x: -11, y: 25 }, true), resistor("R3", { x: 40, y: 90 }, { x: 0, y: 0 }, true, 0x101)];
  const sch: Schematic = { source: { application: "t", versionMajor: 0, versionMinor: 0, schema: 0 }, projectName: "t", rootSheet: "t",
    root: { sheet: "t", name: "", refdes: {}, pinRemaps: {}, units: {}, children: [] }, sheets: [{
      name: "t", title: "t", page: "1", blocks: [], size: { width: 200, height: 200 }, wires: [], labels: [], texts: [], buses: [], busEntries: [], symbols: syms,
    }] };
  const out = emitKicadSchProject(sch, "t", { library: "proj" });

  test("one library symbol for one part, whatever its offset or baked rotation", () => {
    const lib = parseSexpr(out.symbolLibrary)[0] as Sexpr[];
    expect(listsNamed(lib, "symbol").map((x) => x[1])).toEqual(["RESISTOR"]);
    const page = parseSexpr([...out.files.values()][0]!)[0] as Sexpr[];
    expect(listsNamed(page, "symbol").filter((x) => atom(x, "lib_id")).map((x) => atom(x, "lib_id"))).toEqual(["proj:RESISTOR", "proj:RESISTOR", "proj:RESISTOR"]);
  });

  test("every pin stays where Multisim placed it", () => {
    // KiCad: a lib point (x, y) lands at at + K(x, -y); K from (angle, mirror).
    const K: Record<string, Dihedral> = {
      "0": { a: 1, b: 0, c: 0, d: 1 }, "90": { a: 0, b: -1, c: 1, d: 0 }, "180": { a: -1, b: 0, c: 0, d: -1 }, "270": { a: 0, b: 1, c: -1, d: 0 },
      "0x": { a: 1, b: 0, c: 0, d: -1 }, "90x": { a: 0, b: 1, c: 1, d: 0 }, "180x": { a: -1, b: 0, c: 0, d: 1 }, "270x": { a: 0, b: -1, c: -1, d: 0 },
    };
    const page = parseSexpr([...out.files.values()][0]!)[0] as Sexpr[];
    const libSym = listsNamed(listsNamed(page, "lib_symbols")[0]!, "symbol")[0]!;
    const libPins = listsNamed(libSym, "symbol").flatMap((u) => listsNamed(u, "pin"));
    const mm = (x: Sexpr | undefined) => Number(x) / 0.254;
    const instances = listsNamed(page, "symbol").filter((x) => atom(x, "lib_id"));
    instances.forEach((inst, i) => {
      const [, x, y, ang] = listsNamed(inst, "at")[0]!;
      const k = K[`${ang}${atom(inst, "mirror") ?? ""}`]!;
      for (const pin of libPins) {
        const [, px, py] = listsNamed(pin, "at")[0]!;
        const at = applyD(k, { x: mm(px), y: -mm(py) });
        const placed = { x: Math.round(mm(x) + at.x), y: Math.round(mm(y) + at.y) };
        const src = syms[i]!.pins.find((p) => p.number === listsNamed(pin, "number")[0]![1])!;
        const want = applyD(syms[i]!.transform, src.at);
        expect(placed).toEqual({ x: syms[i]!.at.x + want.x, y: syms[i]!.at.y + want.y });
      }
    });
  });
});

describe("orientation", () => {
  test("OrientationFlip: mirror first, then rotate", () => {
    const p = { x: 2, y: 1 };
    expect(applyD(flipToDihedral(0), p)).toEqual({ x: 2, y: 1 });
    expect(applyD(flipToDihedral(1), p)).toEqual({ x: -1, y: 2 }); // r270
    expect(applyD(flipToDihedral(3), p)).toEqual({ x: 1, y: -2 }); // r90
    expect(applyD(flipToDihedral(0x100), p)).toEqual({ x: 2, y: -1 }); // mirror y
    expect(applyD(flipToDihedral(0x101), p)).toEqual({ x: 1, y: 2 }); // my then r270
  });

  test("every dihedral maps to a KiCad orientation", () => {
    for (let f of [0, 1, 2, 3, 0x100, 0x101, 0x102, 0x103, 0x1000, 0x1001, 0x1100]) {
      const sch = { source: { application: "t", versionMajor: 0, versionMinor: 0, schema: 0 }, projectName: "t", rootSheet: "t",
        root: { sheet: "t", name: "", refdes: {}, pinRemaps: {}, units: {}, children: [] }, sheets: [{
        name: "t", title: "t", page: "1", blocks: [], size: { width: 100, height: 100 }, wires: [], labels: [], texts: [], buses: [], busEntries: [],
        symbols: [{ reference: "R1", value: "", kind: "part" as const, at: { x: 10, y: 10 }, transform: flipToDihedral(f), graphics: [], pins: [], showPinNames: false, showPinNumbers: false }],
      }] };
      expect(() => emitKicadSch(sch)).not.toThrow();
    }
  });
});
