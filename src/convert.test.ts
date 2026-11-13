import { describe, expect, test } from "bun:test";
import { parseEwXml } from "electronics-workbench-decoder";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emitKicadPcb } from "./emit/kicad-pcb.ts";
import { emitKicadSch } from "./emit/kicad-sch.ts";
import { parsePcbXml } from "./parse/pcb.ts";
import { applyD, flipToDihedral, parseSchematicXml, placementStats } from "./parse/sch.ts";
import { ccwSweep, roundedPolygon, ubPrimitive } from "./parse/ub-geom.ts";
import { parseCiNetlist } from "./ref/ci-netlist.ts";
import { compareNetlists, foldNetNames, type Netlist } from "./ref/netlist-compare.ts";
import type { Board, Component } from "./ir/types.ts";
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
