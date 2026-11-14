/**
 * Multisim simulation data -> KiCad simulator (ngspice) fields.
 *
 * Every simulated `CiComponent` carries a *netlist template* (attribute
 * strings[1][5]) that Multisim expands into SPICE lines:
 *
 * - `%p` the component name (refdes), `%m` its model's name,
 * - `%tNAME` the node on the terminal (pin) called NAME,
 * - `#N` parameter N of its `CiaParamList`,
 * - `%vN?A%v:B%v;` A when parameter N is set (non-zero), else B.
 *
 * Models (`.SUBCKT` / `.MODEL` text) live in `CiModel` objects, referenced
 * by the component's `Model` attribute. Their names are scoped by Multisim
 * (`2N7002PW/NXP__MOS_ENH_N__1`), and the template references them by `%m`.
 *
 * KiCad mapping, from most to least native:
 * 1. Plain resistors, capacitors and inductors use KiCad's built-in R / C / L
 *    models (or nothing at all when KiCad infers them from the value).
 * 2. `x%p %tA %tB ... %m` parts (a vendor `.SUBCKT`) point at that
 *    subcircuit in the design's model library, with a pin map.
 * 3. Anything else (sources, diode `.MODEL`s, inline subcircuits, ...)
 *    becomes a small wrapper subcircuit holding exactly what Multisim would
 *    netlist, so the simulation matches Multisim's.
 * Parts with no template have no simulation model in Multisim and are
 * excluded from simulation.
 */
import type { SchematicSheet, SchematicSymbol, SimSpec } from "../ir/types.ts";
import type { EwElement } from "./doc.ts";
import { ciCollStrings, collValues, portPinNumbers } from "../ref/ci-netlist.ts";
import { type DChip, rewriteDChipInstances, translateDChips } from "./dchip.ts";

export interface SpiceDesign {
  /** Sim spec per `CiComponent` id. */
  byComponent: Map<string, SimSpec>;
  /** The design's model library text (models + wrappers); empty when none. */
  library: string;
  warnings: string[];
}

export interface ModelDef {
  /** Sanitised name used in the library. */
  name: string;
  kind: "subckt" | "model";
  /** Subcircuit node names, in order. */
  nodes: string[];
  text: string;
  /** The model was a Multisim `d_chip`, now this subcircuit (instances need rewriting). */
  dchip?: DChip;
  /** Why parts of the text could not be translated (a `d_chip` left as it was). */
  issues?: string[];
}

/**
 * KiCad leaves power symbols (`#PWR` references) out of the simulation, but
 * Multisim simulates its supply symbols (VCC is a 5 V source to ground). For
 * each supply net whose symbol has a model, add a one-pin, simulation-only
 * part carrying that model, touching a copy of the net's power symbol,
 * parked to the right of the root page.
 */
/**
 * Where simulation-only additions go: right of everything on the page
 * (Multisim content can sit past its edge) and of the parked extra-page
 * sheet symbols at width + 40.
 */
export function parkingX(page: SchematicSheet): number {
  const xs = [
    page.size.width + 40 + 100,
    ...page.symbols.filter((s) => !s.simOnly).map((s) => s.at.x),
    ...page.wires.flatMap((w) => w.points.map((q) => q.x)),
    ...page.labels.map((l) => l.at.x),
  ];
  return Math.max(...xs) + 60;
}

export function supplySymbols(sheets: SchematicSheet[], page: SchematicSheet): { symbols: SchematicSymbol[]; warnings: string[] } {
  const warnings: string[] = [];
  const firstByNet = new Map<string, SchematicSymbol>();
  for (const sheet of sheets) {
    for (const s of sheet.symbols) {
      if (s.kind !== "power" || !s.sim?.device || s.sim.exclude || s.pins.length !== 1) continue;
      const first = firstByNet.get(s.value);
      if (!first) firstByNet.set(s.value, s);
      else if (first.sim!.name !== s.sim.name) warnings.push(`supply ${s.value}: symbols disagree (${first.sim!.name} vs ${s.sim.name}); simulating the first`);
    }
  }
  const symbols: SchematicSymbol[] = [];
  const x = parkingX(page);
  let y = 20;
  let n = 0;
  for (const [net, p] of firstByNet) {
    const pin = p.pins[0]!;
    // The copy: same drawing, upright, its pin at `tip`.
    // The pin tip on 50 mil (5 units), KiCad's default grid, which its ERC
    // checks; the copy's own origin may then be fractional, as Multisim's
    // often are.
    const tip = { x: Math.round(x / 5) * 5, y: Math.round(y / 5) * 5 };
    const at = { x: tip.x - pin.at.x, y: tip.y - pin.at.y };
    const copy: SchematicSymbol = { ...p, at, transform: { a: 1, b: 0, c: 0, d: 1 }, floating: false, drawnKey: undefined, sim: undefined, simOnly: true };
    const node = p.sim!.pins?.[0]?.[1];
    if (!node) continue;
    symbols.push(copy, {
      reference: `SUP${++n}`,
      value: `${net} source`,
      kind: "part",
      at: tip,
      transform: { a: 1, b: 0, c: 0, d: 1 },
      graphics: [
        { kind: "circle", center: { x: 6, y: 0 }, radius: 3, width: 0, fill: false },
        { kind: "polyline", points: [{ x: 5, y: 0 }, { x: 7, y: 0 }], width: 0, fill: false },
        { kind: "polyline", points: [{ x: 6, y: -1 }, { x: 6, y: 1 }], width: 0, fill: false },
      ],
      pins: [{ name: net, number: "1", at: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, length: 3, electrical: "passive" }],
      refText: { text: `SUP${n}`, at: { x: 10, y: -2 }, hidden: false },
      valueText: { text: `${net} source`, at: { x: 10, y: 2 }, hidden: false },
      showPinNames: false,
      showPinNumbers: false,
      simOnly: true,
      sim: { ...p.sim!, pins: [["1", node]] },
    });
    y += 30;
  }
  return { symbols, warnings };
}

/** SPICE-safe identifier: Multisim names carry `/`, `-`, `+`, ... */
export const spiceName = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, "_");

/** Join SPICE `+` continuation lines into their logical lines. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*\+/.test(raw) && out.length) out[out.length - 1] += " " + raw.replace(/^\s*\+/, "");
    else out.push(raw);
  }
  return out;
}

/**
 * Multisim's resistor template pairs `rR1 a b 10k vresR1` with a
 * `.model vresR1 r(TC1=.. TC2=..)` that is often empty. In PSpice mode
 * (which the model files need) a resistor's model name goes before its
 * value, so the pair breaks: drop the model and put its temperature
 * coefficients on the resistor itself.
 */
export function inlineResistorModels(text: string): string {
  const models = new Map<string, string>();
  const kept = text.replace(/^[ \t]*\.model[ \t]+(vres\S*)[ \t]+r[ \t]*\(([^)]*)\)[ \t]*$/gim, (_, name: string, params: string) => {
    const tc = [...params.matchAll(/\b(TC[12])\s*=\s*(\S+)/gi)].map((m) => `${m[1]!.toLowerCase()}=${m[2]}`);
    models.set(name.toLowerCase(), tc.join(" "));
    return "";
  });
  if (!models.size) return text;
  return kept
    .replace(/^([ \t]*r\S+[ \t]+\S+[ \t]+\S+[ \t]+\S+)[ \t]+(vres\S*)(.*)$/gim, (m, head: string, name: string, rest: string) => {
      const tc = models.get(name.toLowerCase());
      return tc === undefined ? m : `${head}${rest.trimEnd()}${tc ? ` ${tc}` : ""}`;
    })
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Rewrite the Multisim-only SPICE that real models use into ngspice. */
export function ngspiceDialect(text: string): string {
  return (
    inlineResistorModels(text)
      // `.mergenodes a b` (Multisim's digital ground ties itself to 0): a
      // 1 uOhm resistor does the same job.
      .replace(/^[ \t]*\.mergenodes[ \t]+(\S+)[ \t]+(\S+)[ \t]*$/gim, (_, a: string, b: string) => `Rmerge_${spiceName(a)}_${spiceName(b)} ${a} ${b} 1u`)
      // `TABLE {...} (pairs) USELIM`: clamp at the table's ends, which
      // ngspice's TABLE always does; ngspice rejects the keyword.
      .replace(/\)[ \t]*uselim\b/gi, ")")
      // ngspice's PSpice mode (which these models need) mistakes a source
      // named exactly `VT` for something else ("no such function v.x1.v_").
      .replace(/^([ \t]*)VT(?=[ \t])/gim, "$1VTx")
      .replace(/\bI\([ \t]*VT[ \t]*\)/gi, "I(VTx)")
      // Multisim's VHDL-family pin bridges take exactly the parameters of
      // XSPICE's adc_bridge / dac_bridge. (Its tri-state sense `dac_hiz` has
      // no equivalent: an ngspice dac_bridge holds its level on a high-Z
      // input instead of reporting it.)
      .replace(/^([ \t]*\.model[ \t]+\S+[ \t]+\(?[ \t]*)(a2vhdl|vhdl2a)\b/gim, (_, head: string, type: string) =>
        `${head}${type.toLowerCase() === "a2vhdl" ? "adc_bridge" : "dac_bridge"}`,
      )
  );
}

/** A model's definition: find its `.SUBCKT` / `.MODEL` head and rename it SPICE-safe. */
export function modelDef(localName: string, textIn: string): ModelDef | undefined {
  // Multisim's `d_chip` logic becomes XSPICE subcircuits first.
  const dchips = translateDChips(textIn);
  const text = dchips.text;
  const lines = logicalLines(text);
  const want = spiceName(localName).toLowerCase();
  const heads = lines
    .map((l) => /^\s*\.(subckt|model)\s+(\S+)(.*)$/i.exec(l))
    .filter((m): m is RegExpExecArray => !!m);
  // The head naming this model; otherwise the first top-level one.
  const head = heads.find((m) => spiceName(m[2]!).toLowerCase() === want) ?? heads[0];
  if (!head) return undefined;
  const kind = head[1]!.toLowerCase() as ModelDef["kind"];
  const original = head[2]!;
  // An all-digit name (NI's `7400` NAND) reads as a number on an XSPICE line.
  const name = /^\d+$/.test(spiceName(original)) ? `m${spiceName(original)}` : spiceName(original);
  const nodes =
    kind === "subckt"
      ? head[3]!
          // In-line comments (`; (+IN -IN V+ V- OUT)`, `$ ...`), then parameters.
          .replace(/[;$].*$/, "")
          .replace(/\bparams:.*$/i, "")
          .trim()
          .split(/\s+/)
          .filter((t) => t && !t.includes("="))
      : [];
  // Rename the head of this kind (and a matching `.ENDS name`) only. Names
  // inside the body are local to the subcircuit, and a subcircuit's inner
  // `.MODEL` may share its name (NI's MDA980-3 bridge and its diodes).
  const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const renamed = ngspiceDialect(text.replace(/\r\n?/g, "\n"))
    .replace(new RegExp(`^([ \\t]*\\.${kind}[ \\t]+)${escaped}(?=\\s|\\(|$)`, "gim"), `$1${name}`)
    .replace(new RegExp(`^([ \\t]*\\.ends[ \\t]+)${escaped}(?=\\s|$)`, "gim"), (m, head: string) => (kind === "subckt" ? `${head}${name}` : m));
  const dchip = kind === "subckt" ? dchips.chips.get(original.toLowerCase()) : undefined;
  return { name, kind, nodes, text: renamed.trim(), ...(dchip && { dchip: { ...dchip, name } }), ...(dchips.errors.length > 0 && { issues: dchips.errors }) };
}

const truthy = (v: string | undefined): boolean => {
  if (v === undefined) return false;
  const t = v.trim();
  if (!t) return false;
  const n = Number(t);
  return Number.isNaN(n) ? true : n !== 0;
};

/**
 * Expand a Multisim netlist template. `node` maps a terminal name to the
 * node it should print; unknown terminals are reported via `missing`.
 */
export function expandTemplate(
  template: string,
  o: {
    ref: string;
    params: string[];
    node: (terminal: string) => string | undefined;
    /**
     * `%tNAME?%t:d%t;NAME`: the digital side of pin NAME (`d`, or `r` for
     * bidirectional pins), which Multisim bridges to the pin's analog node
     * with the pin's interface model.
     */
    digital?: (terminal: string, prefix: string) => string;
    /** `%sN`: the component's string parameters (MOSFET geometry, ...). */
    strings?: string[];
    /** Circuit parameter names (lower case): values using them get braces. */
    circuitParams?: ReadonlySet<string>;
    model?: string;
    missing?: (t: string) => void;
  },
): string {
  const raw = (i: number) => (o.params[i] ?? "").trim();
  // A value that uses a circuit parameter (`R`, `1/freq`) is evaluated by
  // ngspice in braces, unless it already sits in an expression; anything
  // else (numbers, words like `bidirectional`) stays as it is.
  const usesCircuitParam = (v: string) => [...v.matchAll(/[A-Za-z_]\w*/g)].some((m) => o.circuitParams?.has(m[0].toLowerCase()));
  const param = (i: number, inExpression: boolean) => {
    const v = raw(i);
    return v && !inExpression && !isSpiceNumber(v) && !/^[{"'[]/.test(v) && usesCircuitParam(v) ? `{${v}}` : v;
  };
  // Inside `{...}` or an open `(` on the same line: an expression.
  const inExpression = (s: string, at: number) => {
    const line = s.slice(s.lastIndexOf("\n", at) + 1, at);
    const open = (c: string, d: string) => line.split(c).length - line.split(d).length;
    return open("{", "}") > 0 || /[=]\s*\(/.test(line) && open("(", ")") > 0;
  };
  const conditionals = template
    .replace(/%%/g, "\u0000") // a literal `%` (`%%vd(` is XSPICE's `%vd(`)
    .replace(/%v(\d+)\?([\s\S]*?)%v:([\s\S]*?)%v;/g, (_, n: string, a: string, b: string) => (truthy(o.params[Number(n)]) ? a : b));
  return conditionals
    // `%fS:L:K`: an array, parameters S, S+K, ... (parameter L / K of them);
    // `%fS`: parameter S.
    .replace(/%f(\d+)(?::(\d+):(\d+))?/g, (_, s: string, l?: string, k?: string) => {
      if (!l || !k) return param(Number(s), true);
      const step = Number(k) || 1;
      const count = Math.floor(Number(raw(Number(l))) / step) || 0;
      return Array.from({ length: count }, (_, j) => raw(Number(s) + j * step)).filter(Boolean).join(" ");
    })
    .replace(/%[sS](\d+)/g, (_, n: string) => {
      const s = o.strings?.[Number(n)] ?? "";
      return s === "Param" ? "" : s;
    })
    .replace(/%t([^\s?]+)\?%t:([a-z]*)%t;[^\s\]]*/g, (_, t: string, prefix: string) => o.digital?.(t, prefix || "d") ?? `${prefix || "d"}_${spiceName(t)}`)
    .replace(/%t([^\s\]]+)/g, (_, t: string) => {
      const n = o.node(t);
      if (n === undefined) o.missing?.(t);
      return n ?? t;
    })
    .replace(/#(\d+)/g, (_, n: string, at: number, s: string) => param(Number(n), inExpression(s, at)))
    .replace(/%p/g, o.ref)
    .replace(/%m/g, o.model ?? "")
    .replace(/\u0000/g, "%")
    .replace(/%vd\s+\(/g, "%vd("); // XSPICE port types take no space
}

/** The component's netlist template (attribute strings[1][5]). */
export const netlistTemplate = (comp: EwElement): string => collValues(ciCollStrings(comp)[1])[5] ?? "";

/** A SPICE number with an optional scale suffix / unit: `10k`, `1.5e-3`, `100nF`. */
export const isSpiceNumber = (v: string): boolean => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?[a-zµ]*$/i.test(v);

/** The component's `CiaParamList` parameter values (`parameters`, or `strings`). */
export function componentParams(comp: EwElement, list: "parameters" | "strings" = "parameters"): string[] {
  const pl = comp.child("Attributes")?.find("CiaParamList");
  return pl?.child(list)?.childrenNamed("Item").map((i) => i.str("Value")) ?? [];
}

/**
 * Circuit parameters (Multisim's per-sheet `.param`s) as one simulator
 * directive per sheet title: names from `CircuitParamNameList`, values
 * (numbers or expressions) from `CircuitParamValueList`.
 */
export function circuitParams(root: EwElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const ext of root.findAll("CCircuitParamSheetGroupExtension")) {
    const names = ext.find("CircuitParamNameList")?.childrenNamed("CircuitParamName").map((n) => n.str("NameItem")) ?? [];
    const values = ext.find("CircuitParamValueList")?.childrenNamed("CircuitParamValue").map((v) => v.str("ValueItem")) ?? [];
    const pairs = names
      .map((n, i) => [n.trim(), (values[i] ?? "").trim()] as const)
      .filter(([n, v]) => /^[A-Za-z_]\w*$/.test(n) && v)
      .map(([n, v]) => `.param ${n}=${isSpiceNumber(v) ? v : `{${v}}`}`);
    if (!pairs.length) continue;
    // Multisim's expressions know `pi`; ngspice's don't.
    if (pairs.some((p) => /\bpi\b/i.test(p)) && !names.some((n) => n.toLowerCase() === "pi")) pairs.unshift(".param pi=3.141592653589793");
    const sheet = ext.closest((e) => e.has("SheetName"))?.str("SheetName") ?? "";
    out.set(sheet, [...(out.get(sheet)?.split("\n") ?? []), ...pairs].join("\n"));
  }
  return out;
}

/** The CiModel's SPICE text (its `CiaCString`). */
function modelText(model: EwElement): string {
  return model.child("Attributes")?.find("CiaCString")?.str("String") ?? "";
}

/**
 * Multisim's interactive potentiometer: a script (in `*` comments) sets the
 * two halves from the slider at run time; the netlisted values are 1 mOhm
 * placeholders. Fix them at the saved setting:
 * R1 = total * setting% (clamped like the script), R2 = total - R1.
 */
export function staticPot(lines: string): string {
  if (!lines.includes("!!!BEGIN-INTERACT")) return lines;
  const total = Number(/^\*\s*(\S+)\s+constant\s+potvalue\b/im.exec(lines)?.[1]);
  const setting = Number(/^\*\s*(\S+)\s+VARIABLE\s+setting\b/im.exec(lines)?.[1]);
  if (!Number.isFinite(total) || !Number.isFinite(setting)) return lines;
  const factor = Math.min(0.9999999, Math.max(0.0000001, setting / 100));
  const r1 = total * factor;
  const values: Record<string, number> = { R1: r1, R2: total - r1 };
  return lines.replace(/^(R[12])(\s+\S+\s+\S+\s+)\S+\s*$/gim, (m, name: string, nodes: string) =>
    values[name.toUpperCase()] !== undefined ? `${name}${nodes}${Number(values[name.toUpperCase()]!.toPrecision(6))}` : m,
  );
}

/**
 * `.MODEL` types ngspice (with KiCad's XSPICE code models) understands:
 * SPICE devices, PSpice names its PSpice mode accepts, and the analog,
 * digital, bridge and extra-device code models.
 */
const NGSPICE_MODEL_TYPES = new Set(
  (
    "r c l d npn pnp nmos pmos njf pjf nmf pmf sw csw ltra urc txl cpl vdmos res cap ind vswitch iswitch " +
    "aswitch climit cmeter core d_dt divide gain hyst ilimit int limit lmeter mult multi_input_pwl oneshot pwl " +
    "s_xfer sine slew square summer triangle file_source zener lcouple potentiometer delay " +
    "d_and d_nand d_or d_nor d_xor d_xnor d_inverter d_buffer d_tristate d_open_c d_open_e d_pullup d_pulldown " +
    "d_dff d_jkff d_tff d_srff d_dlatch d_srlatch d_state d_fsim d_osc d_source d_ram d_lut d_genlut d_pwm d_process " +
    "adc_bridge dac_bridge d_to_real real_delay real_gain real_to_v"
  ).split(" "),
);

/** The first `.MODEL` type in `text` that ngspice lacks, if any. */
export function unsupportedModelType(text: string): string | undefined {
  for (const m of text.matchAll(/^[ \t]*\.model[ \t]+\S+[ \t]+\(?[ \t]*([A-Za-z_][A-Za-z0-9_]*)/gim)) {
    const type = m[1]!.toLowerCase();
    if (!NGSPICE_MODEL_TYPES.has(type)) return type;
  }
  return undefined;
}

const R_TEMPLATE =/^r%p %t1 %t2 #1 vres%p /;
const CL_TEMPLATE = /^([cl])%p %t1 %t2 #1 %v4\?IC=#5%v:%v;\s*$/;
const SUBCKT_TEMPLATE = /^x%p(?:_\w+)?((?:\s+%t\S+)+)\s+%m\s*$/;

/** One simulated section of a part: its template, parameters, model and terminals. */
export interface SimSection {
  template: string;
  params: string[];
  /** String parameters (`%sN`). */
  strings?: string[];
  /** The design's circuit parameter names (lower case). */
  circuitParams?: ReadonlySet<string>;
  model?: ModelDef;
  /** Terminal name -> symbol pin number. */
  pins: Map<string, string>;
  /** Digital pins: terminal name -> its interface (A/D, D/A bridge) model. */
  pinModels?: Map<string, PinModel>;
}

/** A digital pin's interface model and the template that instantiates it. */
export interface PinModel {
  model: ModelDef;
  template: string;
}

/**
 * A pin interface model: Multisim keeps an ideal (`*#L1`, standard XSPICE
 * `adc_bridge` / `dac_bridge`) and a real (`*#L2`, Multisim-only code
 * models) variant in one text; ngspice gets the ideal one.
 */
export function pinModelDef(id: string, text: string): ModelDef | undefined {
  const ideal = text.replace(/\r\n?/g, "\n").replace(/^\*#L2[^\n]*\n[\s\S]*?^\*#L2[^\n]*(\n|$)/gm, "");
  return modelDef(id, ideal);
}

/** Split out top-level `.subckt ... .ends` blocks (with anything nested in them). */
export function hoistSubckts(text: string): { body: string; blocks: string[] } {
  const body: string[] = [];
  const blocks: string[] = [];
  let cur: string[] = [];
  let depth = 0;
  for (const line of text.split("\n")) {
    if (/^\s*\.subckt\s/i.test(line)) depth++;
    if (depth > 0) cur.push(line);
    else body.push(line);
    if (depth > 0 && /^\s*\.ends\b/i.test(line)) {
      depth--;
      if (depth === 0) {
        blocks.push(cur.join("\n"));
        cur = [];
      }
    }
  }
  if (cur.length) body.push(...cur); // unterminated: leave in place
  return { body: body.join("\n"), blocks };
}

/** The models and wrapper subcircuits a design or library needs, deduplicated. */
export class SpiceLibrary {
  private models = new Map<string, string>();
  private wrappers = new Map<string, string>(); // body -> name
  private names = new Set<string>();
  private texts: string[] = [];
  readonly warnings: string[] = [];

  useModel(m: ModelDef): void {
    const prev = this.models.get(m.name);
    if (prev !== undefined && prev !== m.text) this.warnings.push(`model ${m.name}: two different definitions; keeping the first`);
    if (prev === undefined) this.models.set(m.name, m.text);
  }

  /**
   * A wrapper subcircuit around `lines`; identical bodies share one.
   * Subcircuits defined inside `lines` (templates that carry their own)
   * move to the top level: KiCad's library reader misreads the outer
   * subcircuit's pins when another is nested in it.
   */
  wrapper(base: string, nodes: string[], linesIn: string, comment: string): string {
    const { body: lines, blocks } = hoistSubckts(linesIn);
    for (const b of blocks) if (!this.texts.includes(b)) this.texts.push(b);
    const body = `${nodes.join(" ")}\n${lines}`;
    const known = this.wrappers.get(body);
    if (known) return known;
    let name = base;
    while (this.names.has(name.toLowerCase())) name += "_";
    this.names.add(name.toLowerCase());
    this.wrappers.set(body, name);
    this.texts.push(`* ${comment}\n.subckt ${name} ${nodes.join(" ")}\n${lines}\n.ends ${name}`);
    return name;
  }

  text(header: string): string {
    const sections = [...this.models.values(), ...this.texts];
    return sections.length ? `* ${header}\n\n${sections.join("\n\n")}\n` : "";
  }
}

/**
 * KiCad simulation spec for one part from its sections (one per Multisim
 * section that carries a template). KiCad simulates a part as one element
 * across all its units, so several sections become one wrapper.
 */
export function simSpec(ref: string, sectionsIn: SimSection[], lib: SpiceLibrary, wrapperBase = `EW_${spiceName(ref)}`): SimSpec {
  const sections = sectionsIn.filter((s) => s.template.trim());
  if (sections.length === 0) return { exclude: true };
  for (const s of sections) {
    // Multisim-only source functions: no ngspice equivalent.
    const unsupported = /\b(chirp)\s*\(/i.exec(s.template);
    if (unsupported) {
      lib.warnings.push(`${ref}: Multisim's ${unsupported[1]!.toLowerCase()}() source has no ngspice equivalent; excluded from simulation`);
      return { exclude: true };
    }
  }

  if (sections.length === 1) {
    const { template, params, model, pins } = sections[0]!;
    const t = template.trim();
    // 1. Ideal R / C / L.
    const r = R_TEMPLATE.test(t) && ![4, 6, 8, 10].some((i) => truthy(params[i]));
    const cl = CL_TEMPLATE.exec(t);
    if ((r || (cl && !truthy(params[4]))) && isSpiceNumber((params[1] ?? "").trim()) && pins.get("1") && pins.get("2")) {
      const device = r ? "R" : cl![1]!.toUpperCase();
      return {
        device,
        params: `${device.toLowerCase()}=${params[1] ?? ""}`,
        value: params[1] ?? "",
        pins: [
          [pins.get("1")!, "+"],
          [pins.get("2")!, "-"],
        ],
      };
    }
    // 2. A vendor subcircuit, pins in template order.
    const sub = SUBCKT_TEMPLATE.exec(t);
    if (sub && model?.kind === "subckt") {
      const terminals = sub[1]!.trim().split(/\s+/).map((x) => x.slice(2));
      const mapped: [string, string][] = [];
      terminals.forEach((term, i) => {
        const pin = pins.get(term);
        const node = model.nodes[i];
        if (pin && node) mapped.push([pin, node]);
      });
      const distinct = new Set(mapped.map(([pin]) => pin)).size === mapped.length;
      if (mapped.length === terminals.length && terminals.length === model.nodes.length && distinct) {
        lib.useModel(model);
        return { device: "SUBCKT", name: model.name, library: true, pins: mapped };
      }
      lib.warnings.push(`${ref}: template pins ${terminals.join(" ")} do not match model ${model.name} (${model.nodes.join(" ")}); using a wrapper`);
    }
  }

  // Code models ngspice doesn't have (Multisim's `d_chip` logic language,
  // `d_vhdl`, ...): one unknown model type fails the whole simulation.
  const modelTexts = sections.flatMap((s) => [ngspiceDialect(s.template), s.model?.text ?? "", ...[...(s.pinModels?.values() ?? [])].map((p) => p.model.text)]);
  const foreign = unsupportedModelType(modelTexts.join("\n"));
  if (foreign) {
    const why = sections.flatMap((s) => s.model?.issues ?? []);
    lib.warnings.push(`${ref}: model type ${foreign} is Multisim-only${why.length ? ` (${why.join("; ")})` : ""}; excluded from simulation`);
    return { exclude: true };
  }

  // 3. Wrapper: Multisim's own netlist lines inside a subcircuit. One
  // section: nodes named after its terminals; several: after the pins.
  const nodeOfPin = new Map<string, string>();
  const used = new Set<string>();
  const nodeFor = (pin: string, terminal: string): string => {
    let n = nodeOfPin.get(pin);
    if (n) return n;
    // Non-numeric: KiCad reads a numeric model pin name in Sim.Pins as an index.
    n = (sections.length === 1 ? spiceName(terminal) : `p${spiceName(pin)}`) || "n";
    if (/^\d/.test(n)) n = `t${n}`;
    while (used.has(n.toLowerCase())) n += "_";
    used.add(n.toLowerCase());
    nodeOfPin.set(pin, n);
    return n;
  };
  // Every pin a section names gets a node, even if its template skips it.
  for (const s of sections) for (const [term, pin] of s.pins) nodeFor(pin, term);
  const missing: string[] = [];
  const chipErrors: string[] = [];
  const noInterface = new Set<string>();
  const bridged = new Set<string>();
  const lines = sections.map((s) => {
    if (s.model) lib.useModel(s.model);
    const node = (term: string) => {
      const pin = s.pins.get(term);
      return pin === undefined ? undefined : nodeFor(pin, term);
    };
    // Digital pins: the gate model sees `d_<node>`; the pin's interface
    // model (an A/D or D/A bridge) joins it to the pin.
    const bridges: string[] = [];
    // One bridge per pin: `d_` is what the logic drives, `r_` what it reads
    // back (a bidirectional or open-collector pin names both).
    const digital = (term: string, prefix: string): string => {
      const analog = node(term);
      const dnode = `${prefix}_${analog ?? spiceName(term)}`;
      if (!analog || bridged.has(analog)) return dnode;
      bridged.add(analog);
      const pm = s.pinModels?.get(term);
      if (!pm) {
        noInterface.add(term);
        return dnode;
      }
      lib.useModel(pm.model);
      bridges.push(
        expandTemplate(pm.template.replace(/\r\n?/g, "\n").trim(), {
          ref: `${spiceName(ref)}_${spiceName(term)}`,
          params: [],
          model: pm.model.name,
          // 1 = the pin, 2 = the digital side the logic drives, 3 = the pin
          // read back (a bidirectional model's A/D output), else a supply pin.
          node: (t) => (t === "1" ? analog : t === "2" ? `d_${analog}` : t === "3" ? `r_${analog}` : (node(t) ?? "0")),
        }),
      );
      return dnode;
    };
    const main = expandTemplate(s.template.replace(/\r\n?/g, "\n").trim(), {
      ref: spiceName(ref),
      params: s.params,
      strings: s.strings,
      circuitParams: s.circuitParams,
      model: s.model?.name,
      node,
      digital,
      missing: (term) => missing.push(term),
    })
      // Multisim's inline arithmetic `<50*0.01/1k>` is ngspice's `{...}`.
      .replace(/<([0-9.][^<>\n]*)>/g, "{$1}");
    // A translated `d_chip` is a subcircuit now: `a... [ins] [outs] chip` -> `x...`.
    const call = s.model?.dchip ? rewriteDChipInstances(main, new Map([[s.model.name.toLowerCase(), s.model.dchip]]), chipErrors) : main;
    return ngspiceDialect(staticPot([call, ...bridges].join("\n")));
  });
  if (chipErrors.length) {
    lib.warnings.push(`${ref}: ${chipErrors.join("; ")}; excluded from simulation`);
    return { exclude: true };
  }
  if (noInterface.size) lib.warnings.push(`${ref}: digital pins ${[...noInterface].join(", ")} have no interface model; left unbridged`);
  if (missing.length) lib.warnings.push(`${ref}: template terminals ${[...new Set(missing)].join(", ")} have no pin; left as internal nodes`);
  const pinList = [...nodeOfPin.keys()];
  const nodes = pinList.map((p) => nodeOfPin.get(p)!);
  let body = lines.join("\n");
  // Again on the expanded text: `%S0` can carry a whole `.model`.
  const foreignExpanded = unsupportedModelType(body);
  if (foreignExpanded) {
    lib.warnings.push(`${ref}: model type ${foreignExpanded} is Multisim-only; excluded from simulation`);
    return { exclude: true };
  }
  // Multisim's expressions know `pi`; ngspice's `{...}` doesn't.
  if (/\{[^}]*\bpi\b/i.test(body)) body = `.param pi=3.141592653589793\n${body}`;
  const name = lib.wrapper(wrapperBase, nodes, body, `${ref} (Multisim netlist template)`);
  return { device: "SUBCKT", name, library: true, pins: pinList.map((p) => [p, nodeOfPin.get(p)!]) };
}

/**
 * Build KiCad simulation specs for every simulated component of a design.
 * `items` is the design's Ci objects by class (`collectCiItems`). The
 * sections of one part (same circuit and refdes) share one spec.
 */
export function parseSpice(items: Map<string, { id: string; body: EwElement }[]>, circuitParamNames: ReadonlySet<string> = new Set()): SpiceDesign {
  const lib = new SpiceLibrary();
  const byComponent = new Map<string, SimSpec>();

  const ports = new Map<string, Map<string, string>>();
  const pinModels = new Map<string, Map<string, PinModel>>();
  const pinModelCache = new Map<string, ModelDef>();
  for (const { body } of items.get("CiPort") ?? []) {
    const comp = body.get("Component") ?? "";
    const terminal = body.str("LocalName");
    // No pad number (instruments, interactive parts): the KiCad pin is numbered
    // by its name, as for the drawing.
    const pad = portPinNumbers(body)[0] ?? (terminal || undefined);
    if (!terminal || !pad) continue;
    const m = ports.get(comp) ?? new Map<string, string>();
    if (!m.has(terminal)) m.set(terminal, pad);
    ports.set(comp, m);
    // A digital pin carries its interface model: name, text, template.
    const [a, b] = ciCollStrings(body).map(collValues);
    const pmId = a?.[3] ?? "";
    const pmTemplate = b?.[5] ?? "";
    if (pmId && pmTemplate && a?.[5]) {
      const def = pinModelCache.get(pmId) ?? pinModelDef(pmId, a[5]);
      if (def) {
        pinModelCache.set(pmId, def);
        const pm = pinModels.get(comp) ?? new Map<string, PinModel>();
        pm.set(terminal, { model: def, template: pmTemplate });
        pinModels.set(comp, pm);
      }
    }
  }

  const models = new Map<string, ModelDef>();
  for (const { id, body } of items.get("CiModel") ?? []) {
    const def = modelDef(body.str("LocalName"), modelText(body));
    if (def) models.set(id, def);
    else lib.warnings.push(`model ${body.str("LocalName")}: no .SUBCKT or .MODEL in its text`);
  }

  const parts = new Map<string, { ref: string; ids: string[]; sections: SimSection[] }>();
  for (const { id, body } of items.get("CiComponent") ?? []) {
    const ref = body.str("LocalName");
    const template = netlistTemplate(body);
    // Sections of one part netlist as `%p_a`, `%p_b`, ...; other parts that
    // share a name (every VCC symbol is "VCC") stay separate.
    const key = /%p_\w/.test(template) ? `${body.get("Circuit") ?? ""}|${ref}` : id;
    const part = parts.get(key) ?? { ref, ids: [], sections: [] };
    part.ids.push(id);
    part.sections.push({
      template,
      params: componentParams(body),
      strings: componentParams(body, "strings"),
      circuitParams: circuitParamNames,
      model: body.get("Model") ? models.get(body.get("Model")!) : undefined,
      pins: ports.get(id) ?? new Map(),
      pinModels: pinModels.get(id),
    });
    parts.set(key, part);
  }
  for (const { ref, ids, sections } of parts.values()) {
    const spec = simSpec(ref, sections, lib);
    for (const id of ids) byComponent.set(id, spec);
  }

  return { byComponent, library: lib.text("SPICE models from the Multisim design (multisim2kicad)"), warnings: lib.warnings };
}
