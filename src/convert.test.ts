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
import { checkSexp } from "./util/check-sexp.ts";

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
        name: "t", title: "t", page: "1", blocks: [], size: { width: 100, height: 100 }, wires: [], labels: [], texts: [],
        symbols: [{ reference: "R1", value: "", kind: "part" as const, at: { x: 10, y: 10 }, transform: flipToDihedral(f), graphics: [], pins: [], showPinNames: false, showPinNumbers: false }],
      }] };
      expect(() => emitKicadSch(sch)).not.toThrow();
    }
  });
});
