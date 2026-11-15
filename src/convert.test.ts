import { describe, expect, test } from "bun:test";
import { encodeBuffer, formatForExtension, parseEwXml } from "electronics-workbench-decoder";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseSymbols, parseSymbolPicture, symbolPictureXml } from "./db/symbols.ts";
import type { EwDatabase } from "./db/ewdb.ts";
import { harmonizeFootprints } from "./emit/footprint-lib.ts";
import { emitKicadPcb } from "./emit/kicad-pcb.ts";
import { boardCustomRules, boardProjectSettings, netClassName } from "./emit/kicad-pro.ts";
import { emitKicadSch, emitKicadSchProject } from "./emit/kicad-sch.ts";
import { parsePcbXml, parseUbLibraryXml } from "./parse/pcb.ts";
import { applyD, flipToDihedral, parseSchematicXml, placementStats } from "./parse/sch.ts";
import { ccwSweep, roundedPolygon, ubPrimitive } from "./parse/ub-geom.ts";
import { collectCiItems, drawnPinNumbers, parseCiNetlist } from "./ref/ci-netlist.ts";
import { parseSimState, simSettings } from "./parse/sim-settings.ts";
import { circuitParams, enablePinModel, expandTemplate, inlineResistorModels, laplaceToXspice, modelDef, ngspiceDialect, parseLaplace, parseSpice, pinModelDef, renameReservedParams, sdtToIntegrator, simSpec, SpiceLibrary, staticPot, unsupportedModelType } from "./parse/spice.ts";
import { dchipSubckt, parseChip, rewriteDChipInstances, translateDChips } from "./parse/dchip.ts";
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

describe("EW database symbols (F)", () => {
  const pt = (x: number, y: number, i = 0) => `<I${i} Type="Point" X="${x}" Y="${y}"/>`;
  const pin = (i: number, index: number, body: [number, number], wire: [number, number]) =>
    `<I${i} Type="Pin" PShp="0" PTp="4"><PNaT Type="PinNameText" Txt="${index}" Vis="1"><PtA Type="PtrArray" S="1">${pt(0, 0)}</PtA></PNaT>` +
    `<CTSP Type="Point" X="${body[0]}" Y="${body[1]}"/><WCP Type="WireConnectionPoint" X="${wire[0]}" Y="${wire[1]}"/></I${i}>`;
  const doc = `<?xml version="1.0"?><DrDoc Type="BaseSymbolDocument"><LrsArr Type="PtrArray" S="4">` +
    `<I0 Type="LayerInfo" LN="Border"><DS Type="ObjectsList"><I0 Type="BoundaryBox"><PtA Type="PtrArray" S="2">${pt(0, 0)}${pt(90, 90, 1)}</PtA></I0></DS></I0>` +
    `<I1 Type="LayerInfo" LN="Pins"><DS Type="ObjectsList">${pin(0, 2, [45, 54], [36, 54])}${pin(1, 1, [81, 54], [90, 54])}</DS></I1>` +
    `<I2 Type="LayerInfo" LN="1 Draw layer"><DS Type="ObjectsList">` +
    `<I0 Type="HalfEllipseArc" PW="1" BS="1"><PtA Type="PtrArray" S="3">${pt(63, 72)}${pt(45, 72, 1)}${pt(54, 63, 2)}</PtA></I0>` +
    `<I1 Type="Polygon" PW="1" BS="0"><PtA Type="PtrArray" S="3">${pt(62, 48)}${pt(46, 48, 1)}${pt(54, 61, 2)}</PtA></I1></DS></I2>` +
    `<I3 Type="LayerInfo" LN="2 Draw Layer"><DS Type="ObjectsList"><I0 Type="Line"><PtA Type="PtrArray" S="2">${pt(0, 0)}${pt(9, 9, 1)}</PtA></I0></DS></I3>` +
    `</LrsArr></DrDoc>`;

  test("pins, drawing layer 1 only, arcs and filled polygons", () => {
    const pic = parseSymbolPicture(doc);
    expect(pic.pins).toEqual([
      { index: 2, at: { x: 36, y: 54 }, dir: { x: 1, y: 0 }, length: 9 },
      { index: 1, at: { x: 90, y: 54 }, dir: { x: -1, y: 0 }, length: 9 },
    ]);
    expect(pic.graphics).toEqual([
      { kind: "arc", start: { x: 63, y: 72 }, mid: { x: 54, y: 63 }, end: { x: 45, y: 72 }, width: 1 },
      { kind: "polyline", points: [{ x: 62, y: 48 }, { x: 46, y: 48 }, { x: 54, y: 61 }, { x: 62, y: 48 }], width: 1, fill: true },
    ]);
  });

  test("a stored picture is a 5-byte prefix and EW's compressed stream", () => {
    const enc = encodeBuffer(Buffer.from(doc), formatForExtension(".ms14")!);
    const image = Buffer.concat([Buffer.alloc(5), enc.subarray(52)]);
    expect(symbolPictureXml(image, doc.length)).toBe(doc);
  });

  test("section pins match the component's package-order Pinout by name; undrawn pins get a power unit", () => {
    const enc = encodeBuffer(Buffer.from(doc), formatForExtension(".ms14")!);
    const image = { value: Buffer.concat([Buffer.alloc(5), enc.subarray(52)]).toString("base64") };
    const t = (rows: Record<string, unknown>[]) => ({ rows });
    const db = {
      source: "",
      tables: {
        SYS_SYMBOL_PICTURE: t([{ Symbol_ID: 7, Size: doc.length, Image: image }]),
        SYS_CONFIGURATION: t([{ Family_ID: 1, Family_Name: "Gates", Template: "U%d" }]),
        SYS_PCB_PACKAGE: t([{ Package_ID: 3, Package_Type: "DIP6" }]),
        // Package order, as in NI's master database: GND / VCC belong to no section.
        SYS_COMPONENT: t([{ Component_ID: 9, Family_ID: 1, Component_Name: "GATE2", Pinout: "A1\r\nGND\r\nB1\r\nA2\r\nB2\r\nVCC\r\n", Pin_Type: "A:INPUT\r\nA:GND\r\nA:INPUT\r\nA:INPUT\r\nA:INPUT\r\nA:VCC\r\n" }]),
        SYS_MAPPING_COMP_SYMBOL: t([
          { Component_ID: 9, Sec_Order: 2, Symbol_ID_ANSI: 7, Pinout_ANSI: "A2\r\nB2\r\n" },
          { Component_ID: 9, Sec_Order: 1, Symbol_ID_ANSI: 7, Pinout_ANSI: "A1\r\nB1\r\n" },
        ]),
        SYS_MAPPING_COMP_PACKAGE: t([{ Component_ID: 9, Package_ID: 3, Pinout: "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n" }]),
      },
    } as unknown as EwDatabase;
    const r = databaseSymbols(db, () => undefined);
    expect(r.warnings).toEqual([]);
    const pins = r.specs[0]!.units.map((u) => u.pins.map((p) => `${p.name}=${p.number}:${p.electrical}`).sort());
    expect(pins).toEqual([
      ["A1=1:input", "B1=3:input"],
      ["A2=4:input", "B2=5:input"],
      ["GND=2:power_in", "VCC=6:power_in"],
    ]);

    // Simulation: one model per section (the base of the alternatives),
    // both sections in one wrapper, nodes by pin number; a part with no
    // template is excluded.
    const sim = databaseSymbols(
      {
        source: "",
        tables: {
          ...db.tables,
          SYS_COMPONENT: t([
            ...db.tables.SYS_COMPONENT!.rows,
            { Component_ID: 10, Family_ID: 1, Component_Name: "NOSIM", Pinout: "A1\r\nB1\r\n" },
          ]),
          SYS_MAPPING_COMP_SYMBOL: t([...db.tables.SYS_MAPPING_COMP_SYMBOL!.rows, { Component_ID: 10, Sec_Order: 1, Symbol_ID_ANSI: 7, Pinout_ANSI: "A1\r\nB1\r\n" }]),
          SYS_MAPPING_COMP_MODEL: t([
            { Component_ID: 9, Model_ID: "G_2", Sec_Order: 1, Template: "x%p_a %tA1 %tB1 %tVCC %tGND %m" },
            { Component_ID: 9, Model_ID: "G", Sec_Order: 1, Template: "x%p_a %tA1 %tB1 %tVCC %tGND %m" },
            { Component_ID: 9, Model_ID: "G", Sec_Order: 2, Template: "x%p_b %tA2 %tB2 %tVCC %tGND %m" },
            { Component_ID: 10, Model_ID: "DUMMY", Sec_Order: 1, Template: "" },
          ]),
          SYS_MODEL: t([
            { MODEL_ID: "G", DATA: ".SUBCKT G 1 2 3 4\r\nR1 1 2 1k\r\n.ENDS" },
            { MODEL_ID: "G_2", DATA: ".SUBCKT G_2 1 2 3 4\r\nR1 1 2 2k\r\n.ENDS" },
          ]),
        },
      } as unknown as EwDatabase,
      () => undefined,
      (family) => `lib/${family}.lib`,
    );
    const gate = sim.specs.find((s) => s.value === "GATE2")!;
    expect(Object.fromEntries(gate.fields!.filter(([k]) => k.startsWith("Sim.")))).toEqual({
      "Sim.Device": "SUBCKT",
      "Sim.Library": "lib/Gates.lib",
      "Sim.Name": "EW_GATE2",
      "Sim.Pins": "1=p1 2=p2 3=p3 4=p4 5=p5 6=p6",
    });
    expect(gate.excludeFromSim).toBe(false);
    expect(sim.specs.find((s) => s.value === "NOSIM")!.excludeFromSim).toBe(true);
    expect(sim.spice.get("Gates")).toContain(".subckt EW_GATE2 p1 p2 p3 p4 p5 p6\nxGATE2_a p1 p3 p6 p2 G\nxGATE2_b p4 p5 p6 p2 G\n.ends EW_GATE2");
    expect(sim.spice.get("Gates")).not.toContain("G_2");
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
    expect(sheet.symbols.filter((s) => s.kind === "part" && !s.simOnly).length).toBe(19);
    expect(sheet.symbols.filter((s) => s.kind === "power" && !s.simOnly).length).toBe(33);
    // Each supply net with a model gets a simulation-only source + a power symbol copy.
    expect(sheet.symbols.filter((s) => s.simOnly).map((s) => [s.kind, s.value, s.sim?.name])).toEqual([
      ["power", "VCC", undefined],
      ["part", "VCC source", "EW_VCC"],
      ["power", "VDD", undefined],
      ["part", "VDD source", "EW_VDD"],
    ]);
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

describe("spice", () => {
  const coll = (vals: string[]) =>
    `<CiaCollString Class="CiaCollString"><strings>${vals.map((v) => `<Item Value="${v ? `&amp;ASC${v}` : ""}"/>`).join("")}</strings></CiaCollString>`;
  const params = (vals: string[]) =>
    `<CiaParamList Class="CiaParamList"><doubles/><strings/><parameters>${vals.map((v) => `<Item Value="&amp;ASC${v}"/>`).join("")}</parameters><paramindicators/></CiaParamList>`;
  const comp = (id: string, ref: string, template: string, p: string[] = [], model = "") =>
    `<Item CiID="${id}" Class="CiComponent"><CiComponent Class="CiComponent" LocalName="&amp;ASC${ref}"${model ? ` Model="${model}"` : ""}><Attributes><Item/><Item>${params(p)}</Item><Item>${coll(["FAM", "PART"])}</Item><Item>${coll(["1", "Product", "FAM", "", "U%d", template])}</Item></Attributes></CiComponent></Item>`;
  const port = (id: string, compId: string, name: string, pad: string) =>
    `<Item CiID="${id}" Class="CiPort"><CiPort Class="CiPort" LocalName="&amp;ASC${name}" Component="${compId}"><Attributes><Item>${coll(["FAM"])}</Item><Item>${coll(["", "", "", "", "", "", pad])}</Item></Attributes></CiPort></Item>`;
  const model = (id: string, name: string, text: string) =>
    `<Item CiID="${id}" Class="CiModel"><CiModel Class="CiModel" LocalName="&amp;ASC${name}"><Attributes><Item/><Item><CiaCString Class="CiaCString" String="&amp;ASC${text}"/></Item></Attributes></CiModel></Item>`;
  const items = (xml: string) => collectCiItems(parseEwXml(`<Root>${xml}</Root>`).root);

  test("templates: parameters, conditionals, nodes, model", () => {
    const r = "r%p %t1 %t2 #1 vres%p %v4?TEMP=#5%v:%v; \n.model vres%p r(%v6?TC1=#7%v:%v;)";
    const out = expandTemplate(r, { ref: "R2", params: ["0", "10k", "0", "0", "1", "50", "0", "0"], node: (t) => `n${t}` });
    expect(out).toBe("rR2 n1 n2 10k vresR2 TEMP=50 \n.model vresR2 r()");
  });

  test("models: renamed SPICE-safe, nodes read, Multisim dialect rewritten", () => {
    const def = modelDef("2N7002/NXP__MOS__1", ".SUBCKT 2N7002/NXP__MOS__1 DRAIN GATE\n+ SOURCE PARAMS: X=1\nG1 1 0 TABLE {V(1)} ((0,0)(1,1)) USELIM\n.mergenodes 1 0\n.ENDS 2N7002/NXP__MOS__1");
    expect(def?.name).toBe("2N7002_NXP__MOS__1");
    expect(def?.nodes).toEqual(["DRAIN", "GATE", "SOURCE"]);
    expect(def?.text).toContain(".SUBCKT 2N7002_NXP__MOS__1 DRAIN GATE");
    expect(def?.text).toContain(".ENDS 2N7002_NXP__MOS__1");
    expect(def?.text).toContain("((0,0)(1,1))\n");
    expect(def?.text).toContain("Rmerge_1_0 1 0 1u");
  });

  test("a subcircuit's inner .MODEL of the same name keeps its name; VT is renamed", () => {
    const def = modelDef("MDA980-3", ".SUBCKT MDA980-3 1 2\nD1 1 2 MDA980-3\nVT 2 3 0\nB1 3 0 I=I(VT)\n.MODEL MDA980-3 D(IS=1n)\n.ENDS MDA980-3");
    expect(def?.text).toBe(".SUBCKT MDA980_3 1 2\nD1 1 2 MDA980-3\nVTx 2 3 0\nB1 3 0 I=I(VTx)\n.MODEL MDA980-3 D(IS=1n)\n.ENDS MDA980_3");
  });

  test("digital pins: gate on d_ nodes, ideal (L1) bridge per pin; Multisim-only code models excluded", () => {
    const rcv = pinModelDef("TTL_RCV", ".SUBCKT TTL_RCV 1 2 3 4\r\n*#L1\r\naA [1] [2] ADC\r\n.MODEL ADC adc_bridge (in_low=2.5 in_high=2.5)\r\n*#L1\r\n*#L2\r\naA [1] [2] 3 4 ADC\r\n.model ADC adc_bridge_real(technology=7)\r\n*#L2\r\n.ENDS")!;
    expect(rcv.text).not.toContain("_real");
    const drv = pinModelDef("TTL_DRV", ".SUBCKT TTL_DRV 1 2 3 4\n*#L1\naD [1] [2] DAC\n.MODEL DAC dac_bridge (out_low=0 out_high=5)\n*#L1\n.ENDS")!;
    const lib = new SpiceLibrary();
    const gate = modelDef("NAND", ".MODEL NAND d_nand (rise_delay=10n)")!;
    const pins = new Map([["A", "1"], ["B", "2"], ["Y", "3"], ["VCC", "14"], ["GND", "7"]]);
    const pinModels = new Map([
      ["A", { model: rcv, template: "x%p %t1 %t2 %tVCC %tGND %m" }],
      ["B", { model: rcv, template: "x%p %t1 %t2 %tVCC %tGND %m" }],
      ["Y", { model: drv, template: "x%p %t2 %t1 %tVCC %tGND %m" }],
    ]);
    const spec = simSpec("U1", [{ template: "a%p_a [%tA?%t:d%t;A %tB?%t:d%t;B] %tY?%t:d%t;Y %m", params: [], model: gate, pins, pinModels }], lib);
    expect(spec).toMatchObject({ device: "SUBCKT", name: "EW_U1" });
    const text = lib.text("t");
    expect(text).toContain("aU1_a [d_A d_B] d_Y NAND");
    expect(text).toContain("xU1_A A d_A VCC GND TTL_RCV");
    expect(text).toContain("xU1_Y d_Y Y VCC GND TTL_DRV");
    const chip = modelDef("C", '.MODEL C d_chip ( behaviour= "\n+/inputs A\n+")')!;
    expect(simSpec("U2", [{ template: "a%p [%tA?%t:d%t;A] %m", params: [], model: chip, pins }], lib)).toEqual({ exclude: true });
    expect(unsupportedModelType(".model X d_vhdl ()")).toBe("d_vhdl");
    expect(unsupportedModelType(".MODEL Q npn(BF=100)\n.model S vswitch")).toBeUndefined();
  });

  test("templates' own subcircuits move to the top level; <expr> becomes {expr}; numeric nodes get a prefix", () => {
    const lib = new SpiceLibrary();
    const pins = new Map([["1", "1"], ["2", "2"]]);
    simSpec("J1", [{ template: "xJ %t1 %t2 SW%p\n.subckt SW%p 1 2\nR1 1 2 <1/1k>\n.ends", params: [], pins }], lib);
    const text = lib.text("t");
    expect(text).toContain(".subckt SWJ1 1 2\nR1 1 2 {1/1k}\n.ends");
    expect(text).toContain(".subckt EW_J1 t1 t2\nxJ t1 t2 SWJ1\n.ends EW_J1");
  });

  test("template codes: %% literal, %f arrays, %s strings, circuit parameters in braces only outside expressions", () => {
    const params = ["1", "0", "1", "5", "0", "0", "0", "0", "0", "0", "6", "0", "1", "5", "1e7", "5", "2e6"];
    expect(expandTemplate("a%p %%vd (%t2 %t1) sq%p\n+ cntl_array = [%f11:10:2]\n+ freq_array = [%f12:10:2]", { ref: "V1", params, node: (t) => `n${t}` })).toBe(
      "aV1 %vd(n2 n1) sqV1\n+ cntl_array = [0 5 5]\n+ freq_array = [1 1e7 2e6]",
    );
    // s_xfer's template: a stray else/end opens each list; the last condition has no end.
    expect(expandTemplate("num=[ %v:%v;%v3?#4 %v:%v;%v1?#2 ]\nden=[ %v:%v;%v5?#6 %v:%v;%v7?#8 ])", { ref: "A1", params: ["", "1", "1", "0", "5", "1", "0.001", "1", "1"], node: (t) => t })).toBe(
      "num=[ 1 ]\nden=[ 0.001 1 ])",
    );
    expect(expandTemplate("v%p %t1 0 pwl(%f2:1:1)",{ ref: "V2", params: ["", "5", "0", "0", "t_on", "5", "t_on+10n"], node: (t) => t, circuitParams: new Set(["t_on"]) })).toBe(
      "vV2 1 0 pwl(0 0 {t_on} 5 {t_on+10n})",
    );
    expect(expandTemplate("m%p %tD %tG %tS %tS %m %S0",{ ref: "Q1", params: [], strings: [" L=6u W=125u"], node: (t) => t, model: "N" })).toBe("mQ1 D G S S N  L=6u W=125u");
    const names = new Set(["r", "freq", "kp"]);
    expect(expandTemplate("c%p %t1 %t2 #1 x=#2 e={#3*v(1)} m=#4", { ref: "C1", params: ["", "1/freq", "bidirectional", "kp", "10k"], node: (t) => t, circuitParams: names })).toBe(
      "cC1 1 2 {1/freq} x=bidirectional e={kp*v(1)} m=10k",
    );
  });

  test("Multisim's resistor model folds into the resistor (PSpice mode reads it as a parameter)", () => {
    expect(inlineResistorModels("rR1 a b {R} vresR1  \n.model vresR1 r(  )")).toBe("rR1 a b {R}");
    expect(inlineResistorModels("rR2 a b 1k vresR2 TEMP=50\n.model vresR2 r(TC1=1m TC2=2u TNOM=27)")).toBe("rR2 a b 1k TEMP=50 tc1=1m tc2=2u");
  });

  test("circuit parameters become one .param directive per sheet", () => {
    const root = el(
      `<R><Group SheetName="&amp;ASCTop"><CCircuitParamSheetGroupExtension><CircuitParamData><CircuitParamNameList><CircuitParamName NameItem="&amp;ASCfreq"/><CircuitParamName NameItem="&amp;ASCw"/></CircuitParamNameList><CircuitParamValueList><CircuitParamValue ValueItem="&amp;ASC1meg"/><CircuitParamValue ValueItem="&amp;ASC2*pi*freq"/></CircuitParamValueList></CircuitParamData></CCircuitParamSheetGroupExtension></Group></R>`,
    );
    expect(circuitParams(root)).toEqual(new Map([["Top", ".param pi=3.141592653589793\n.param freq=1meg\n.param w={2*pi*freq}"]]));
  });

  test("interactive potentiometer gets its saved setting", () => {
    const pot = "*  2000.0 constant potvalue\n*  25.0 VARIABLE setting\nR1 1 2  1e-3\nR2 2 3  1e-3\n* !!!BEGIN-INTERACT";
    expect(staticPot(pot)).toContain("R1 1 2  500\nR2 2 3  1500");
  });

  test("components: built-in R, vendor subcircuit by pin order, wrapper, exclusion", () => {
    const xml = [
      comp("1", "R1", "r%p %t1 %t2 #1 vres%p %v4?TEMP=#5%v:%v; \n.model vres%p r()", ["0", "4.7k", "0", "0", "0", "27", "0", "0", "0", "0", "0", "27"]),
      port("11", "1", "1", "1"),
      port("12", "1", "2", "2"),
      model("9", "FET/X__1", ".SUBCKT FET/X__1 DRAIN GATE SOURCE\nR1 DRAIN SOURCE 1\n.ENDS"),
      comp("2", "Q1", "x%p %tD %tG %tS %m", [], "9"),
      port("21", "2", "D", "3"),
      port("22", "2", "G", "1"),
      port("23", "2", "S", "2"),
      comp("3", "VCC", "VCC%p  %tVCC 0 dc #0", ["5"]),
      port("31", "3", "VCC", "1"),
      comp("4", "U1", ""),
      comp("5", "V2", "V%p %t1 %t2 chirp(#1)", ["1"]),
    ].join("");
    const s = parseSpice(items(xml));
    expect(s.byComponent.get("1")).toEqual({ device: "R", params: "r=4.7k", value: "4.7k", pins: [["1", "+"], ["2", "-"]] });
    expect(s.byComponent.get("2")).toEqual({ device: "SUBCKT", name: "FET_X__1", library: true, pins: [["3", "DRAIN"], ["1", "GATE"], ["2", "SOURCE"]] });
    expect(s.byComponent.get("3")).toMatchObject({ device: "SUBCKT", name: "EW_VCC", pins: [["1", "VCC"]] });
    expect(s.byComponent.get("4")).toEqual({ exclude: true });
    expect(s.byComponent.get("5")).toEqual({ exclude: true });
    expect(s.library).toContain(".SUBCKT FET_X__1 DRAIN GATE SOURCE");
    expect(s.library).toContain(".subckt EW_VCC VCC\nVCCVCC  VCC 0 dc 5\n.ends EW_VCC");
    expect(s.warnings.some((w) => w.includes("chirp"))).toBe(true);
  });

  test("cross-part references: currents and nets through global probes, couplings to a directive", () => {
    const node = (id: string, name: string, ports: string[]) =>
      `<Item CiID="${id}" Class="CiNode"><CiNode Class="CiNode" LocalName="&amp;ASC${name}" Circuit=""><Ports>${ports.map((p) => `<Item CiID="${p}"/>`).join("")}</Ports></CiNode></Item>`;
    const xml = [
      // Multisim calls V5 "Sensor1" (its final refdes): I2 reads I(Vsensor1).
      comp("1", "V5", "v%p %t1 %t2 dc 0"),
      port("11", "1", "1", "1"),
      port("12", "1", "2", "2"),
      comp("2", "I2", "B%p %t2 %t1 I = { I(Vsensor1) - 1.13 + V(12) * v(pri) }"),
      port("21", "2", "1", "1"),
      port("22", "2", "2", "2"),
      // An ideal resistor holds the only pins on nets 12 and pri: it becomes a wrapper to carry the probes.
      comp("3", "R1", "r%p %t1 %t2 #1 vres%p \n.model vres%p r()", ["0", "1k"]),
      port("31", "3", "1", "1"),
      port("32", "3", "2", "2"),
      node("41", "12", ["31"]),
      comp("5", "L4", "l%p %t1 %t2 #1 %v4?IC=#5%v:%v;", ["0", "90m"]),
      port("51", "5", "1", "1"),
      port("52", "5", "2", "2"),
      comp("6", "L5", "l%p %t1 %t2 #1 %v4?IC=#5%v:%v;", ["0", "10m"]),
      port("61", "6", "1", "1"),
      port("62", "6", "2", "2"),
      comp("7", "K1", "k%p lL4 lL5 0.9"),
    ].join("");
    const finals = new Map([["1", ["Sensor1"]]]);
    const s = parseSpice(items(xml), new Set(), finals, new Map([["pri", [{ refdes: "R1", pin: "2" }]]]));
    expect(s.library).toContain(".global ew_v_12 ew_v_pri ew_i_vsensor1");
    expect(s.library).toContain("BI2 t2 t1 I = { V(ew_i_vsensor1) - 1.13 + V(ew_v_12) * v(ew_v_pri) }");
    expect(s.library).toContain("vV5 t1 t2 dc 0\n* Probes other parts read (Multisim names are global)\nBew_i_vsensor1 ew_i_vsensor1 0 V={I(vV5)}");
    expect(s.byComponent.get("3")).toMatchObject({ device: "SUBCKT", name: "EW_R1" });
    expect(s.library).toContain("Bew_v_12 ew_v_12 0 V={V(t1)}\nBew_v_pri ew_v_pri 0 V={V(t2)}");
    // The inductors stay KiCad's own; the coupling is a top-level K line.
    expect(s.byComponent.get("5")).toMatchObject({ device: "L" });
    expect(s.byComponent.get("7")).toEqual({ exclude: true });
    expect(s.directives).toEqual(["K1 L4 L5 0.9"]);
  });
});

describe("d_chip (Multisim behavioural logic)", () => {
  const chip = (name: string, body: string[]) => `.MODEL ${name} d_chip ( behaviour= "\n${body.map((l) => `+${l}`).join("\n")}\n+")`;

  test("a table output becomes a d_lut over the columns it reads (first = lowest index bit)", () => {
    const { text, pins } = dchipSubckt("AND2X", chip("AND2X", ["/inputs A B C", "/outputs Y", "/table 2", " H H X  H", " X X X  L", "/delay 1", " A Y 10n 12n"]));
    expect(pins).toBe(4);
    expect(text).toContain(".subckt AND2X A B C Y");
    expect(text).toContain("a1 [A B] Y AND2X_lut0");
    expect(text).toContain('.model AND2X_lut0 d_lut(table_values="0001" rise_delay=1e-8 fall_delay=1.2e-8)');
  });

  test("clocked modules: one d_dff per flag, synchronous rows as data, asynchronous rows as set / reset; F+k counts", () => {
    const { text } = dchipSubckt(
      "CNT2",
      chip("CNT2", ["/inputs CLK ~CLR", "/outputs Q0 Q1", "/clock CLK + 2 1 2", " X X XX F+0 F+1", " X L XX L L", " X X XX F0 F1", "/table 1", " X X XX F0 F1"]),
    );
    expect(text).toContain("a1 [n_F0] n_F0_next CNT2_lut0");
    expect(text).toContain('CNT2_lut0 d_lut(table_values="10"');
    expect(text).toMatch(/\[_CLR\] n_F0_reset CNT2_lut\d/);
    expect(text).toMatch(/n_F0_next CLK NULL n_F0_reset n_F0 NULL CNT2_dff\d/);
    expect(text).toMatch(/\[n_F0 n_F1\] n_F1_next CNT2_lut\d/);
    expect(text).toContain('table_values="0110"');
  });

  test("an output column naming an output holds it (a latch)", () => {
    const { text } = dchipSubckt("LATCH", chip("LATCH", ["/inputs EN D", "/outputs Q", "/table 2", " H X D", " L X Q"]));
    expect(text).toContain("a1 [EN D Q] Q LATCH_lut0");
    expect(text).toContain('table_values="00011011"');
  });

  test("wide tables split on their select lines; no d_lut over more than 10 inputs", () => {
    const rows = Array.from({ length: 16 }, (_, s) => ` ${[3, 2, 1, 0].map((b) => ((s >> b) & 1 ? "H" : "L")).join(" ")} ${"X".repeat(16)} E${s}`);
    const data = Array.from({ length: 16 }, (_, i) => `E${i}`).join(" ");
    const { text } = dchipSubckt("MUX16", chip("MUX16", [`/inputs D C B A ${data}`, "/outputs W", "/table 16", ...rows]));
    const widths = [...text.matchAll(/^a\d+ \[([^\]]*)\]/gm)].map((m) => m[1]!.split(" ").length);
    expect(Math.max(...widths)).toBeLessThanOrEqual(10);
    expect(text).toContain('table_values="01010011"'); // x ? f1 : f0
  });

  test("modules flatten; a d_chip inside a subcircuit moves to the top level and its instance becomes a call", () => {
    const src = [
      ".SUBCKT OPTO 1 2",
      "aU [d1]",
      "+ [d2] LOGIC",
      chip("LOGIC", ["/inputs A", "/outputs Y", "/module INV", "/inputs I", "/outputs O", "/table 2", " H L", " L H", "/endmodule", "/instance INV A Y"]),
      ".ENDS",
    ].join("\n");
    const r = translateDChips(src);
    expect(r.errors).toEqual([]);
    expect(r.text.indexOf(".subckt LOGIC A Y")).toBeLessThan(r.text.indexOf(".SUBCKT OPTO"));
    expect(r.text).toContain("a1 [A] Y LOGIC_lut0");
    expect(r.text).toContain("xaU d1 d2 LOGIC");
    expect(r.text).not.toMatch(/d_chip \(/);
    expect(parseChip(chip("X", ["/inputs A", "/outputs Y", "/module M", "/module N", "/endmodule", "/endmodule"])).modules.size).toBe(2);
  });

  test("parts with a d_chip model simulate through a subcircuit call; untranslatable ones say why", () => {
    const lib = new SpiceLibrary();
    const pins = new Map([["A", "1"], ["Y", "2"]]);
    const inv = modelDef("INV1", chip("INV1", ["/inputs A", "/outputs Y", "/table 2", " H L", " L H"]))!;
    expect(inv).toMatchObject({ kind: "subckt", name: "INV1", nodes: ["A", "Y"] });
    expect(simSpec("U3", [{ template: "a%p [%tA?%t:d%t;A]\n+ [%tY?%t:d%t;Y] %m", params: [], model: inv, pins }], lib)).toMatchObject({ device: "SUBCKT" });
    expect(lib.text("t")).toContain("xaU3 d_A d_Y INV1");
    const bad = modelDef("BAD", chip("BAD", ["/inputs A", "/outputs Y", "/frobnicate"]))!;
    expect(simSpec("U4", [{ template: "a%p [%tA?%t:d%t;A] [%tY?%t:d%t;Y] %m", params: [], model: bad, pins }], lib)).toEqual({ exclude: true });
    expect(lib.warnings.some((w) => w.startsWith("U4: its model uses d_chip") && w.includes("unknown directive /frobnicate"))).toBe(true);
  });

  test("trailing pins the chip doesn't declare (VCC / GND, read-back) are dropped; too few is an error", () => {
    const chips = new Map([["ch", { name: "CH", pins: 3, inputs: 2, outputs: 1, enables: [] }]]);
    expect(rewriteDChipInstances("aU [a b r_y] [y VCC GND] CH", chips)).toBe("xaU a b y CH");
    const errors: string[] = [];
    expect(rewriteDChipInstances("aU [a] [y] CH", chips, errors)).toBe("aU [a] [y] CH");
    expect(errors[0]).toContain("1 inputs / 1 outputs for d_chip CH, which has 2 / 1");
  });
});

describe("spice: PSpice functions ngspice lacks", () => {
  test("parameters named like functions are renamed in the subcircuit and its calls", () => {
    const text = [
      ".subckt PI inp inn outp outn PARAMS: kp=1 ki=1",
      "+ max=60 min=-60",
      "E1 outp outn value={limit(kp*V(inp,inn),min,max)}",
      ".ends",
      "xA1 a b c d PI PARAMS: kp=2 max=6 min=-6",
    ].join("\n");
    expect(renameReservedParams(text)).toBe(
      [".subckt PI inp inn outp outn PARAMS: kp=1 ki=1", "+ p_max=60 p_min=-60", "E1 outp outn value={limit(kp*V(inp,inn),p_min,p_max)}", ".ends", "xA1 a b c d PI PARAMS: kp=2 p_max=6 p_min=-6"].join("\n"),
    );
  });

  test("sdt() becomes an XSPICE integrator after its element", () => {
    expect(sdtToIntegrator("E1 o 0 value={kp*v(a) + ki*sdt(v(a,b)*2)}\n+ ")).toBe(
      [
        "E1 o 0 value={kp*v(a) + ki*V(ew_sdt1)}",
        "+ ",
        "Bew_sdt1 ew_sdt1_in 0 V={v(a,b)*2}",
        "aew_sdt1 ew_sdt1_in ew_sdt1 ew_sdt1_int",
        ".model ew_sdt1_int int(gain=1 out_ic=0 out_lower_limit=-1e12 out_upper_limit=1e12 limit_range=1e-6)",
      ].join("\n"),
    );
  });

  test("LAPLACE: rational functions of s and delays become s_xfer (+ a delay line)", () => {
    expect(parseLaplace("e^(-1m*s)/(1+0.001*s)")).toEqual({ num: [1], den: [1, 0.001], delay: 0.001 });
    expect(parseLaplace("100/(s*(s+10))")).toEqual({ num: [100], den: [0, 10, 1], delay: 0 });
    expect(parseLaplace("(s+1)^2/(s+1k)^2")).toEqual({ num: [1, 2, 1], den: [1e6, 2000, 1], delay: 0 });
    expect(parseLaplace("1/(1+s*tau)")).toBeUndefined();
    expect(laplaceToXspice("G2 a b LAPLACE {V(x)} = {1/(s+1)}")).toBe(
      [
        "* G2: LAPLACE {V(x)} {1/(s+1)} as XSPICE s_xfer",
        "Bew_lap_G2 ew_lap_G2_in 0 V={V(x)}",
        "aew_lap_G2 ew_lap_G2_in ew_lap_G2_out ew_lap_G2_xfer",
        ".model ew_lap_G2_xfer s_xfer(gain=1 num_coeff=[1] den_coeff=[1 1])",
        "G2 a b ew_lap_G2_out 0 1",
      ].join("\n"),
    );
    const warnings: string[] = [];
    expect(laplaceToXspice("E3 a b LAPLACE {V(x)} {s^2/(s+1)}", warnings)).toBe("E3 a b LAPLACE {V(x)} {s^2/(s+1)}");
    expect(warnings).toHaveLength(1);
    // What stays untranslated marks the part excluded.
    expect(unsupportedModelType("E3 a b LAPLACE {V(x)} {s^2/(s+1)}")).toBe("PSpice LAPLACE");
    expect(unsupportedModelType("E4 3 4 FREQ {v(1,2)} (100,0,0) (1k,-3,-45) db deg")).toBe("PSpice FREQ");
  });
});

describe("spice: digital details", () => {
  test("an all-digit model name gets a prefix (ngspice reads `7400` as a number)", () => {
    const def = modelDef("7400", ".MODEL 7400 d_nand ( rise_delay = 22n)")!;
    expect(def.name).toBe("m7400");
    expect(def.text).toBe(".MODEL m7400 d_nand ( rise_delay = 22n)");
  });

  test("Multisim's VHDL-family bridges are XSPICE's adc / dac bridges", () => {
    expect(ngspiceDialect(".MODEL ADC a2vhdl (in_low= 0.8 in_high = 2.0)\n.MODEL DAC vhdl2a (out_low= 0 out_high= 4.5)")).toBe(
      ".MODEL ADC adc_bridge (in_low= 0.8 in_high = 2.0)\n.MODEL DAC dac_bridge (out_low= 0 out_high= 4.5)",
    );
    expect(unsupportedModelType(".model C dac_hiz (out_enabled=5)")).toBe("dac_hiz");
  });

  test("a pin named as drive (d) and read-back (r) gets one bridge with both", () => {
    const lib = new SpiceLibrary();
    const bidi = pinModelDef("BIDI", ".SUBCKT BIDI 1 2 3\naA [1] [3] A\naD [2] [1] D\n.MODEL A adc_bridge(in_low=1 in_high=1)\n.MODEL D dac_bridge(out_low=0 out_high=5)\n.ENDS")!;
    const gate = modelDef("BUF", ".MODEL BUF d_buffer")!;
    const pins = new Map([["A", "1"], ["Y", "2"]]);
    simSpec("U9", [{ template: "a%p %tY?%t:r%t;Y %tY?%t:d%t;Y %m", params: [], model: gate, pins, pinModels: new Map([["Y", { model: bidi, template: "x%p %t1 %t2 %t3 %m" }]]) }], lib);
    const text = lib.text("t");
    expect(text).toContain("aU9 r_Y d_Y BUF");
    expect(text.match(/^xU9_Y /gm)).toEqual(["xU9_Y "]);
    expect(text).toContain("xU9_Y Y d_Y r_Y BIDI");
  });

  test("a `~` node in a pin template is made by an inverter", () => {
    const lib = new SpiceLibrary();
    const drv = pinModelDef("DRV", ".SUBCKT DRV 1 2\naD [1] [2] D\n.MODEL D dac_bridge(out_low=0 out_high=5)\n.ENDS")!;
    const gate = modelDef("BUF", ".MODEL BUF d_buffer")!;
    simSpec("U8", [{ template: "a%p %tA?%t:d%t;A %tY?%t:d%t;Y %m", params: [], model: gate, pins: new Map([["A", "1"], ["Y", "2"]]), pinModels: new Map([["Y", { model: drv, template: "x%p ~%t2 %t1 %m" }]]) }], lib);
    const text = lib.text("t");
    expect(text).toContain("xU8_Y d_Y_n Y DRV");
    expect(text).toContain("ad_Y_inv d_Y d_Y_n EW_invert");
  });
});

describe("tri-state digital pins", () => {
  const chip = (name: string, body: string[]) => `.MODEL ${name} d_chip ( behaviour= "\n${body.map((l) => `+${l}`).join("\n")}\n+")`;
  const buffer = chip("TS", ["/inputs ~C A", "/outputs Y", "/table 2", " L X A", " H X Z", "/conditional_delay 2", " ZH ~C (~C=L) Y MAX 20n", " HZ ~C (~C=H) Y MAX 25n"]);
  const ls3s = {
    model: pinModelDef("LS3S", ".SUBCKT LS3S 1 2 3 4\naDACin [1] [5] aDAC_in\naDACcntl [1] [6] aDAC_cntl\nS1 5 2 6 0 vsw0\n.model vsw0 vswitch (Roff=10MEG Ron=100m Voff=2.5 Von=2.5)\n.MODEL aDAC_in dac_bridge (out_low= 0 out_high = 5)\n.MODEL aDAC_cntl dac_hiz (out_enabled= 5.0 out_disabled = 0)\n.ENDS")!,
    template: "x%p %t2 %t1 %tVCC %tGND %m",
  };

  test("a chip output that can be Z gets an enable pin (1 while it drives), with the Z delays", () => {
    const sub = dchipSubckt("TS", buffer);
    expect(sub.enables).toEqual([0]);
    expect(sub.text).toContain(".subckt TS _C A Y Y_en");
    expect(sub.text).toMatch(/\[_C\] n_Y_en TS_lut\d/);
    expect(sub.text).toContain('table_values="10" rise_delay=2e-8 fall_delay=2.5e-8');
    // A latch whose flags go to Z asynchronously (4043): the flag holds, its enable drops.
    const latch = dchipSubckt("L", chip("L", ["/inputs EO S", "/outputs O", "/clock EO X 1 1 2", " X X X F0", " L X X Z", " H X X S", "/table 1", " X X X F0"]));
    expect(latch.enables).toEqual([0]);
    expect(latch.text).toContain("n_F0_en");
  });

  test("the pin model's dac_hiz becomes a dac_bridge driven by an extra `en` node", () => {
    const v = enablePinModel(ls3s)!;
    expect(v.model.name).toBe("LS3S_EN");
    expect(v.model.text).toContain(".SUBCKT LS3S_EN 1 2 3 4 en");
    expect(v.model.text).toContain("aDACcntl [en] [6] aDAC_cntl");
    expect(v.model.text).toContain(".MODEL aDAC_cntl dac_bridge (out_low=0 out_high=5.0 out_undef=0)");
    expect(v.template).toBe("x%p %t2 %t1 %tVCC %tGND %tEN %m");
    expect(enablePinModel({ model: pinModelDef("R", ".SUBCKT R 1 2\naA [1] [2] A\n.MODEL A adc_bridge\n.ENDS")!, template: "x%p %t1 %t2 %m" })).toBeUndefined();
  });

  test("the chip's enable reaches the pin; a pin whose logic is never Z always drives", () => {
    const lib = new SpiceLibrary();
    const pins = new Map([["~C", "1"], ["A", "2"], ["Y", "3"], ["VCC", "14"], ["GND", "7"]]);
    const t = "a%p [%t~C?%t:d%t;~C %tA?%t:d%t;A] [%tY?%t:d%t;Y] %m";
    simSpec("U1", [{ template: t, params: [], model: modelDef("TS", buffer)!, pins, pinModels: new Map([["Y", ls3s]]) }], lib);
    const plain = modelDef("PL", chip("PL", ["/inputs ~C A", "/outputs Y", "/table 1", " X X A"]))!;
    simSpec("U2", [{ template: t, params: [], model: plain, pins, pinModels: new Map([["Y", ls3s]]) }], lib);
    const text = lib.text("t");
    expect(text).toContain("xaU1 d__C d_A d_Y d_Y_en TS");
    expect(text).toContain("xU1_Y d_Y Y VCC GND d_Y_en LS3S_EN");
    expect(text).toContain("ad_Y_en_on d_Y_en EW_drives");
    expect(text.match(/EW_drives/g)?.length).toBe(2); // U2 only: the pull-up and its model
  });
});

describe("simulation settings (SimState)", () => {
  const opt = (k: string, type: string, v: string, on: boolean) => `${k}:list{IsEnabled:long{${on ? 1 : 0}}\n${k}:${type}{${v}}\n}`;
  const analysis = (key: string, id: number, body: string, opts = "") =>
    `${key}:list{NODES:list{}\nANALYSIS:list{${body}}\nANALYSIS_ID:long{${id}}\nASYS_OPT:list{${opts}}\n}`;
  const opts = [opt("0", "flag", "", false).replace("0:flag{}", "acct:flag{}"), "1:list{IsEnabled:long{1}\nrshunt:double{1e+012}\n}", "2:list{IsEnabled:long{1}\nconvlimit:flag{}\n}", "3:list{IsEnabled:long{1}\ndynamicdc:flag{}\n}", "4:list{IsEnabled:long{0}\nreltol:double{0.001}\n}"].join("\n");
  const state = (analyses: string) => `SIMULATION_INFO:list{ANALYSES:list{ANALYSIS_LIST:list{}\nUSE:long{-1}\n${analyses}}\n}`;

  test("parses Multisim's serialization, typed arrays included", () => {
    expect(parseSimState("A:list{B:double{1.5}\nC:double[]{}\nD:string{x{y}}\n}")).toEqual([
      { key: "A", type: "list", items: [{ key: "B", type: "double", value: "1.5" }, { key: "C", type: "double[]", value: "" }, { key: "D", type: "string", value: "x{y}" }] },
    ]);
  });

  test("enabled ngspice options and the preferred analysis with results", () => {
    const s = simSettings(
      state(
        [
          analysis("OP", 3, "", opts),
          analysis("AC", 2, "VARIATION:string{dec}\nNPOINTS_PER_VARIATION:double{10}\nFSTART:double{1}\nFSTOP:double{1e+010}", opts),
          analysis("TRAN", 5, "TSTEP:string{calculate}\nTSTOP:double{0.5}\nTSTART:double{0}\nTMAX:double{1e-005}\nIC:string{uic}", opts),
          analysis("FOUR", 1, "", opts),
        ].join("\n"),
      ),
    );
    expect(s).toEqual({ options: ".options rshunt=1e+012 convlimit", analysis: ".tran 5e-04 0.5 0 1e-05 uic", skipped: ["OP", "AC", "FOUR"] });
  });

  test("no results: options only; interactive (run until stopped) transients don't translate", () => {
    expect(simSettings(state(analysis("OP", 0, "", opts)))).toEqual({ options: ".options rshunt=1e+012 convlimit", analysis: undefined, skipped: [] });
    const ac = analysis("AC", 1, "VARIATION:string{lin}\nNPOINTS_PER_VARIATION:double{1000}\nFSTART:double{3.3e+009}\nFSTOP:double{5.3e+009}");
    expect(simSettings(state(analysis("TRAN", 4, "TSTEP:string{calculate}\nTSTOP:double{1e+030}\nTSTART:double{0}\nTMAX:string{calculate}\nIC:string{auto_ic}") + "\n" + ac)).analysis).toBe(".ac lin 1000 3.3e+09 5.3e+09");
  });
});
