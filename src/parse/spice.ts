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
  /** Top-level netlist lines for a KiCad text directive (couplings across parts). */
  directives: string[];
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

/** Function names a subcircuit parameter can't share in ngspice's PSpice mode (it expands `limit()` into `min()` / `max()`). */
const RESERVED_PARAMS = new Set(["min", "max", "abs", "sqrt", "exp", "ln", "log", "log10", "sin", "cos", "tan", "atan", "sinh", "cosh", "tanh", "pow", "pwr", "sgn", "floor", "ceil", "int", "limit", "if", "table"]);

/**
 * Subcircuit parameters named like functions (NI's PI block has `max=60
 * min=-60` and uses `limit(..., min, max)`) become `p_<name>`: in the
 * subcircuit that declares them, and in every call's `PARAMS:`.
 */
export function renameReservedParams(text: string): string {
  if (!/\bparams:/i.test(text)) return text;
  const reserved = (name: string) => RESERVED_PARAMS.has(name.toLowerCase());
  const lines = text.split("\n");
  // Elements with their `+` continuation lines.
  const groups: string[][] = [];
  for (const l of lines) {
    if (/^\s*\+/.test(l) && groups.length) groups.at(-1)!.push(l);
    else groups.push([l]);
  }
  let renames: RegExp | undefined;
  const out: string[] = [];
  for (const g of groups) {
    const joined = g.join(" ");
    if (/^\s*\.ends\b/i.test(joined)) renames = undefined;
    const isHeader = /^\s*\.subckt\b/i.test(joined);
    if (isHeader) {
      const names = [...(/\bparams:(.*)$/i.exec(joined)?.[1] ?? "").matchAll(/\b([A-Za-z_]\w*)\s*=/g)].map((m) => m[1]!).filter(reserved);
      renames = names.length ? new RegExp(`\\b(${names.join("|")})\\b(?!\\s*[(=])`, "gi") : undefined;
    }
    // Everything after `PARAMS:` (on whichever line of the element) is assignments: `max=6` -> `p_max=6`.
    let afterParams = false;
    for (const line of g) {
      const at = afterParams ? 0 : (/\bparams:/i.exec(line)?.index ?? -1);
      let l = line;
      if (at >= 0) {
        afterParams = true;
        l = l.slice(0, at) + l.slice(at).replace(/\b([A-Za-z_]\w*)(\s*=)/g, (m, n: string, eq: string) => (reserved(n) ? `p_${n}${eq}` : m));
      }
      // Uses inside the subcircuit that declares them (not calls, not assignments).
      out.push(renames && !isHeader && !/^\s*\*/.test(l) ? l.replace(renames, "p_$1") : l);
    }
  }
  return out.join("\n");
}

/**
 * PSpice's integral `sdt(x)`, which ngspice lacks, as XSPICE's integrator:
 * a B source carries `x` onto a node, an `int` block integrates it (from 0
 * at the operating point, as PSpice does), and the expression reads its
 * output. The new lines go after the element that used it, in its scope.
 */
export function sdtToIntegrator(text: string): string {
  if (!/\bsdt\s*\(/i.test(text)) return text;
  let n = 0;
  const lines = text.split("\n");
  const out: string[] = [];
  const pending: string[] = [];
  const rewrite = (s: string): string => {
    let r = "";
    let i = 0;
    for (;;) {
      const m = /\bsdt\s*\(/gi;
      m.lastIndex = i;
      const hit = m.exec(s);
      if (!hit) return r + s.slice(i);
      // The argument, up to its matching parenthesis.
      let depth = 1;
      let j = hit.index + hit[0].length;
      for (; j < s.length && depth; j++) depth += s[j] === "(" ? 1 : s[j] === ")" ? -1 : 0;
      const arg = rewrite(s.slice(hit.index + hit[0].length, j - 1));
      const k = ++n;
      pending.push(`Bew_sdt${k} ew_sdt${k}_in 0 V={${arg}}`, `aew_sdt${k} ew_sdt${k}_in ew_sdt${k} ew_sdt${k}_int`, `.model ew_sdt${k}_int int(gain=1 out_ic=0 out_lower_limit=-1e12 out_upper_limit=1e12 limit_range=1e-6)`);
      r += `${s.slice(i, hit.index)}V(ew_sdt${k})`;
      i = j;
    }
  };
  lines.forEach((line, i) => {
    out.push(/^\s*\*/.test(line) ? line : rewrite(line));
    // After the last continuation line of this element.
    if (pending.length && !/^\s*\+/.test(lines[i + 1] ?? "")) out.push(...pending.splice(0));
  });
  return out.join("\n");
}

/** A transfer function: numerator / denominator polynomials in s (index = power), times e^(-delay*s). */
interface Rational {
  num: number[];
  den: number[];
  delay: number;
}

const polyMul = (a: number[], b: number[]): number[] => {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => b.forEach((y, j) => (out[i + j]! += x * y)));
  return out;
};
const polyAdd = (a: number[], b: number[]): number[] => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
const SPICE_SCALE: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, mil: 25.4e-6, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };

/**
 * Read a PSpice `LAPLACE` transfer function, `e^(-1m*s)/(1+0.001*s)`, into
 * a rational function of s and a pure delay. Numbers only (with SPICE
 * suffixes); undefined for anything else (parameters, other functions).
 */
export function parseLaplace(expr: string): Rational | undefined {
  const tokens = expr.match(/\d+\.?\d*(?:e[-+]?\d+)?(?:meg|mil|[tgkmunpf])?[a-z]*|\.\d+(?:e[-+]?\d+)?(?:meg|mil|[tgkmunpf])?[a-z]*|[A-Za-z_]\w*|\*\*|[-+*/^()]|\S/gi) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const constant = (r: Rational) => r.num.length === 1 && r.den.length === 1 && r.delay === 0;
  const value = (r: Rational) => r.num[0]! / r.den[0]!;
  const fail = (): never => {
    throw new Error("unsupported");
  };
  const atom = (): Rational => {
    const t = tokens[i++] ?? fail();
    if (t === "(") {
      const r = sum();
      if (tokens[i++] !== ")") fail();
      return r;
    }
    if (t === "-") {
      const r = power();
      return { ...r, num: r.num.map((x) => -x) };
    }
    if (t === "+") return power();
    if (/^s$/i.test(t)) return { num: [0, 1], den: [1], delay: 0 };
    const num = /^(\d+\.?\d*(?:e[-+]?\d+)?|\.\d+(?:e[-+]?\d+)?)(meg|mil|[tgkmunpf])?[a-z]*$/i.exec(t);
    if (num) return { num: [Number(num[1]) * (num[2] ? SPICE_SCALE[num[2].toLowerCase()]! : 1)], den: [1], delay: 0 };
    // e^(x) / exp(x): x must be -T*s (a delay).
    const isE = /^e$/i.test(t) && (peek() === "^" || peek() === "**");
    if (isE || (/^exp$/i.test(t) && peek() === "(")) {
      if (isE) i++;
      const x = atom();
      if (x.delay !== 0 || x.den.length !== 1 || x.num.length !== 2 || x.num[0] !== 0) fail();
      const T = -x.num[1]! / x.den[0]!;
      if (!(T >= 0)) fail();
      return { num: [1], den: [1], delay: T };
    }
    return fail();
  };
  const power = (): Rational => {
    const base = atom();
    if (peek() !== "^" && peek() !== "**") return base;
    i++;
    const e = atom();
    if (!constant(e) || !Number.isInteger(value(e))) fail();
    const n = value(e);
    let r: Rational = { num: [1], den: [1], delay: 0 };
    for (let k = 0; k < Math.abs(n); k++) r = { num: polyMul(r.num, base.num), den: polyMul(r.den, base.den), delay: r.delay + base.delay };
    return n < 0 ? { num: r.den, den: r.num, delay: -r.delay } : r;
  };
  const product = (): Rational => {
    let r = power();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[i++];
      const b = power();
      r = op === "*" ? { num: polyMul(r.num, b.num), den: polyMul(r.den, b.den), delay: r.delay + b.delay } : { num: polyMul(r.num, b.den), den: polyMul(r.den, b.num), delay: r.delay - b.delay };
    }
    return r;
  };
  const sum = (): Rational => {
    let r = product();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[i++];
      const b = product();
      // Terms with different delays don't combine into one delay line.
      if (b.delay !== r.delay) fail();
      const bn = op === "-" ? b.num.map((x) => -x) : b.num;
      r = { num: polyAdd(polyMul(r.num, b.den), polyMul(bn, r.den)), den: polyMul(r.den, b.den), delay: r.delay };
    }
    return r;
  };
  try {
    const r = sum();
    if (i !== tokens.length || r.delay < 0) return undefined;
    const trim = (p: number[]) => {
      const q = [...p];
      while (q.length > 1 && q.at(-1) === 0) q.pop();
      return q;
    };
    return { num: trim(r.num), den: trim(r.den), delay: r.delay };
  } catch {
    return undefined;
  }
}

/**
 * PSpice's `E/G name n+ n- LAPLACE {input} {H(s)}` (no ngspice equivalent)
 * as XSPICE: a B source carries the input onto a node, a lossless line
 * delays it when H has an `e^(-sT)` factor, an `s_xfer` block applies the
 * rational part, and the original E / G drives from its output.
 */
export function laplaceToXspice(text: string, warnings?: string[]): string {
  return text.replace(/^([ \t]*)([EG]\S*)[ \t]+(\S+)[ \t]+(\S+)[ \t]+LAPLACE[ \t]*=?[ \t]*\{([^{}]*)\}[ \t]*=?[ \t]*\{([^{}]*)\}[ \t]*$/gim, (all, ind: string, name: string, p: string, n: string, input: string, h: string) => {
    const r = parseLaplace(h);
    // s_xfer needs a proper function (numerator order <= denominator order).
    if (!r || r.num.length > r.den.length || r.den.every((x) => x === 0)) {
      warnings?.push(`${name}: LAPLACE ${h.trim()} is not a rational function of s (plus a delay) with numeric coefficients; left as is`);
      return all;
    }
    const b = `ew_lap_${spiceName(name)}`;
    const fmt = (x: number) => Number(x.toPrecision(12)).toString();
    const coeffs = (poly: number[]) => `[${[...poly].reverse().map(fmt).join(" ")}]`;
    const src = r.delay > 0 ? `${b}_d` : `${b}_in`;
    return [
      `${ind}* ${name}: LAPLACE {${input.trim()}} {${h.trim()}} as XSPICE s_xfer`,
      `${ind}B${b} ${b}_in 0 V={${input}}`,
      ...(r.delay > 0 ? [`${ind}T${b} ${b}_in 0 ${b}_d 0 Z0=1 TD=${fmt(r.delay)}`, `${ind}R${b} ${b}_d 0 1`] : []),
      `${ind}a${b} ${src} ${b}_out ${b}_xfer`,
      `${ind}.model ${b}_xfer s_xfer(gain=1 num_coeff=${coeffs(r.num)} den_coeff=${coeffs(r.den)})`,
      `${ind}${name} ${p} ${n} ${b}_out 0 1`,
    ].join("\n");
  });
}

/**
 * Multisim's `adc_bridge (in_low=a in_high=b schmitt=true)`: a Schmitt input
 * that switches high at `in_high` and low at `in_low`. XSPICE's bridge has
 * no hysteresis (it ignores `schmitt`), so an XSPICE `hyst` block takes the
 * input first (rising threshold `b`, falling `a`, output 0..1) and the bridge
 * reads that at 0.5.
 */
export function schmittBridges(text: string): string {
  const schmitt = new Map<string, { low: number; high: number }>();
  let out = text.replace(/^([ \t]*\.model[ \t]+(\S+)[ \t]+)\(?[ \t]*adc_bridge\b[ \t]*\(([^)]*)\).*$/gim, (m, head: string, name: string, params: string) => {
    if (!/\bschmitt[ \t]*=[ \t]*true\b/i.test(params)) return m;
    const value = (p: string) => Number(new RegExp(`\\b${p}\\s*=\\s*([^\\s)]+)`, "i").exec(params)?.[1]);
    const low = value("in_low");
    const high = value("in_high");
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return m.replace(/\bschmitt[ \t]*=[ \t]*true\b/i, "");
    schmitt.set(name.toLowerCase(), { low, high });
    const mid = (low + high) / 2;
    const half = (high - low) / 2;
    const w = Math.min(half / 10, 0.01);
    return [
      `${head}adc_bridge (in_low=0.5 in_high=0.5)`,
      `${head.replace(/(\S+)([ \t]+)$/, "$1_hyst$2")}hyst (in_low=${fmtNum(mid - w)} in_high=${fmtNum(mid + w)} hyst=${fmtNum(half)} out_lower_limit=0 out_upper_limit=1 input_domain=0.01 fraction=false)`,
    ].join("\n");
  });
  if (!schmitt.size) return text;
  out = out.replace(/^([ \t]*)(a\S+)([ \t]+)\[[ \t]*([^\s\]]+)[ \t]*\]([ \t]+\[[^\]]*\][ \t]+)(\S+)[ \t]*$/gim, (m, ind: string, a: string, sp: string, input: string, rest: string, model: string) => {
    if (!schmitt.has(model.toLowerCase())) return m;
    const mid = `${a}_hy`;
    return `${ind}${a}_h ${input} ${mid} ${model}_hyst\n${ind}${a}${sp}[${mid}]${rest}${model}`;
  });
  return out;
}

const fmtNum = (x: number): string => String(Number(x.toPrecision(6)));

/**
 * A capacitor's `IC=` in a vendor model: PSpice (which these models target)
 * holds that voltage during the bias point, and models lean on it to start
 * their latches in a known state (Basso's PWM controllers). ngspice uses
 * device `IC=` only with `uic`, so such latches leave the operating point
 * without a solution. A `.nodeset` for each grounded one gives ngspice the
 * same starting state, without holding the node once the bias point is found.
 */
export function capacitorIcNodesets(text: string): string {
  if (!/\bic[ \t]*=/i.test(text)) return text;
  return text.replace(/^([ \t]*)C\S*[ \t]+(\S+)[ \t]+(\S+)[ \t]+[^\n]*?\bIC[ \t]*=[ \t]*([-+]?[0-9.]+(?:e[-+]?\d+)?[a-z]*)[ \t]*$/gim, (m, ind: string, a: string, b: string, v: string) => {
    const neg = (x: string) => (x.startsWith("-") ? x.slice(1) : `-${x.replace(/^\+/, "")}`);
    if (b === "0") return `${m}\n${ind}.nodeset V(${a})=${v}`;
    if (a === "0") return `${m}\n${ind}.nodeset V(${b})=${neg(v)}`;
    return m;
  });
}

/** Rewrite the Multisim-only SPICE that real models use into ngspice. */
export function ngspiceDialect(text: string): string {
  return (
    capacitorIcNodesets(schmittBridges(laplaceToXspice(sdtToIntegrator(renameReservedParams(inlineResistorModels(text))))))
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
      // Multisim's interactive digital constant: a fixed logic level (its
      // saved state; the key toggles it only while Multisim runs).
      .replace(/^([ \t]*\.model[ \t]+\S+[ \t]+)\(?[ \t]*d_constsource\b[ \t]*(\([^)]*\))?.*$/gim, (_, head: string, params = "") =>
        `${head}${/\bstate[ \t]*=[ \t]*0*1\b/i.test(params) ? "d_pullup" : "d_pulldown"}`,
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
    .replace(/%v(\d+)\?([\s\S]*?)%v:([\s\S]*?)%v;/g, (_, n: string, a: string, b: string) => (truthy(o.params[Number(n)]) ? a : b))
    // An else / end with no `%vN?` before it (the s_xfer template starts each
    // coefficient list with one) adds nothing; a last `%vN?` with no end runs
    // to the end of the template.
    .replace(/%v:([\s\S]*?)%v;/g, "")
    .replace(/%v(\d+)\?([\s\S]*)$/, (_, n: string, a: string) => (truthy(o.params[Number(n)]) ? a : ""));
  return conditionals
    // `%fS:L:K`: an array, parameters S, S+K, ... (parameter L / K of them);
    // `%fS`: parameter S.
    .replace(/%f(\d+)(?::(\d+):(\d+))?/g, (_, s: string, l?: string, k?: string) => {
      if (!l || !k) return param(Number(s), true);
      const step = Number(k) || 1;
      const count = Math.floor(Number(raw(Number(l))) / step) || 0;
      // Each item on its own: `pwl(%f11:10:1)` lists times like `T_on+10n`.
      return Array.from({ length: count }, (_, j) => param(Number(s) + j * step, false)).filter(Boolean).join(" ");
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

/**
 * The first `.MODEL` type in `text` that ngspice lacks, if any; or a PSpice
 * source form it lacks: a `FREQ` response table (no exact time-domain
 * equivalent), or a `LAPLACE` that `laplaceToXspice` couldn't translate.
 */
export function unsupportedModelType(text: string): string | undefined {
  for (const m of text.matchAll(/^[ \t]*\.model[ \t]+\S+[ \t]+\(?[ \t]*([A-Za-z_][A-Za-z0-9_]*)/gim)) {
    const type = m[1]!.toLowerCase();
    if (!NGSPICE_MODEL_TYPES.has(type)) return type;
  }
  const source = /^[ \t]*[EG]\S*[ \t]+\S+[ \t]+\S+[ \t]+(FREQ|LAPLACE)\b/im.exec(text);
  return source ? `PSpice ${source[1]!.toUpperCase()}` : undefined;
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
  return modelDef(id, dacOutputResistance(ideal));
}

/**
 * An XSPICE `dac_bridge` output is an ideal voltage source, so two outputs
 * tied together, or one driving a source (NI's pin-model demo), make a
 * singular matrix. Multisim's real pin models have an output impedance; a
 * 1 mOhm series resistor keeps the ideal level within microvolts while
 * letting such circuits solve.
 */
export function dacOutputResistance(text: string): string {
  const dacs = new Set([...text.matchAll(/^[ \t]*\.model[ \t]+(\S+)[ \t]+\(?[ \t]*(?:dac_bridge|vhdl2a)\b/gim)].map((m) => m[1]!.toLowerCase()));
  if (!dacs.size) return text;
  return text.replace(/^([ \t]*)(a\S+)([ \t]+\[[^\]]*\][ \t]+)\[[ \t]*([^\s\]]+)[ \t]*\]([ \t]+)(\S+)[ \t]*$/gim, (m, ind: string, a: string, input: string, out: string, sp: string, model: string) => {
    if (!dacs.has(model.toLowerCase())) return m;
    const mid = `${out}_${a}_ro`;
    return `${ind}${a}${input}[${mid}]${sp}${model}\n${ind}R${a}_ro ${mid} ${out} 1m`;
  });
}

const enableVariants = new WeakMap<PinModel, PinModel | null>();

/**
 * A tri-state / bidirectional pin model with an enable pin. Multisim's
 * `dac_hiz` turns its digital input's high-Z into the voltage that opens the
 * output switch; an ngspice `dac_bridge` can't see high-Z (it holds its
 * level). The variant takes an extra last node, `en` (1 while the logic
 * drives the pin, from the translated chip), and a plain `dac_bridge` makes
 * the switch voltage from that. `undefined` for a model without `dac_hiz`.
 */
export function enablePinModel(pm: PinModel): PinModel | undefined {
  const known = enableVariants.get(pm);
  if (known !== undefined) return known ?? undefined;
  const hiz = new Map<string, string>(); // model name (lower) -> dac_bridge definition
  let text = pm.model.text.replace(/^([ \t]*\.model[ \t]+(\S+)[ \t]+)\(?[ \t]*(?:dac_hiz|vhdl2hiz)\b[ \t]*(\([^)]*\))?.*$/gim, (_, head: string, name: string, params = "") => {
    const value = (p: string) => new RegExp(`\\b${p}\\s*=\\s*([^\\s)]+)`, "i").exec(params)?.[1];
    const on = value("out_enabled") ?? "5";
    const off = value("out_disabled") ?? "0";
    hiz.set(name.toLowerCase(), name);
    return `${head}dac_bridge (out_low=${off} out_high=${on} out_undef=${off})`;
  });
  let variant: PinModel | undefined;
  if (hiz.size && pm.model.kind === "subckt") {
    const name = `${pm.model.name}_EN`;
    text = text
      // Its control bridges read `en` instead of the data.
      .replace(/^([ \t]*a\S+[ \t]+)\[[^\]]*\]([ \t]*\[[^\]]*\][ \t]+)(\S+)[ \t]*$/gim, (m, a: string, b: string, model: string) => (hiz.has(model.toLowerCase()) ? `${a}[en]${b}${model}` : m))
      .replace(/^([ \t]*\.subckt[ \t]+)(\S+)([^\n]*)/im, (_, a: string, _n: string, nodes: string) => `${a}${name}${nodes.trimEnd()} en`)
      .replace(/^([ \t]*\.ends)[ \t]+\S+/im, `$1 ${name}`);
    variant = {
      model: { ...pm.model, name, text, nodes: [...pm.model.nodes, "en"] },
      template: pm.template.replace(/%m\s*$/, "%tEN %m"),
    };
  }
  enableVariants.set(pm, variant ?? null);
  return variant;
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

  /** Nodes every subcircuit shares (cross-part probes, see `Xref`). */
  readonly globals = new Set<string>();

  text(header: string): string {
    const globals = this.globals.size ? [`.global ${[...this.globals].join(" ")}`] : [];
    const sections = [...globals, ...this.models.values(), ...this.texts];
    return sections.length ? `* ${header}\n\n${sections.join("\n\n")}\n` : "";
  }
}

/**
 * Cross-part references. Multisim netlists flat, so a part's expression can
 * read another part's current (`I(Vsensor1)`) or any net (`V(pri)`). Here
 * each part is its own subcircuit, where ngspice would look those names up
 * locally (and fail, or read a floating node). The part that owns the name
 * gets a probe instead: a B source copying the current or voltage onto a
 * `.global` node, which the expression reads.
 */
export interface Xref {
  /** In: the part's lines moved to the top level (couplings); the part itself is excluded. */
  moved?: boolean;
  /** In: always build a wrapper (a probe needs one), even for an ideal R/C/L or a vendor subcircuit. */
  wrap?: boolean;
  /** In: node names the expressions read -> what to read instead (a pin's node or a global). */
  nodes?: Map<string, string>;
  /** In: device names whose current the expressions read -> the global node carrying it. */
  currents?: Map<string, string>;
  /** In: probes to add, onto global nodes: a pin's voltage, or a device's current. */
  probes?: { global: string; pin?: string; device?: string }[];
  /** Out: whether the part became a wrapper. */
  wrapped?: boolean;
  /** Out: devices the wrapper defines, and the node of each pin. */
  devices?: string[];
  pinNodes?: Map<string, string>;
  /** Out: names the expressions read but the wrapper doesn't define (lowercase). */
  readsNodes?: string[];
  readsCurrents?: string[];
  /** Out: the wrapper is only mutual inductances (`K`) coupling inductors it doesn't define. */
  couplings?: { name: string; inductors: string[]; k: string }[];
}

const EXPR_REF = /\b([vi])\(\s*([^()]*?)\s*\)/gi;
/** Apply `f` to the inside of each `{...}` expression. */
const inExpressions = (text: string, f: (expr: string) => string): string => text.replace(/\{[^{}]*\}/g, f);

/** Fill `xref`'s outputs from a wrapper body, and apply its rewrites. */
function crossRefs(full: string, ports: string[], xref: Xref): string {
  // Subcircuits a template defines have their own local names: leave them be.
  const { body, blocks } = hoistSubckts(full);
  const elements = body.split("\n").filter((l) => l.trim() && !/^[*.+]/.test(l.trim()));
  // Local names: the tokens outside expressions (element names, nodes, models).
  const local = new Set<string>(["0", ...ports.map((p) => p.toLowerCase())]);
  for (const l of elements) for (const t of l.replace(/\{[^{}]*\}/g, " ").split(/[\s=(),]+/)) if (t) local.add(t.toLowerCase());
  const devices = elements.map((l) => l.trim().split(/\s+/)[0]!);
  const isDevice = (d: string) => devices.some((x) => x.toLowerCase() === d);
  const nodes = new Set<string>();
  const currents = new Set<string>();
  const rewritten = inExpressions(body, (expr) =>
    expr.replace(EXPR_REF, (all, kind: string, args: string) => {
      const names = args.split(",").map((a) => a.trim());
      if (kind.toLowerCase() === "i") {
        const d = names[0]!.toLowerCase();
        if (isDevice(d)) return all;
        currents.add(d);
        const g = xref.currents?.get(d);
        return g ? `V(${g})` : all;
      }
      const out = names.map((n) => {
        if (local.has(n.toLowerCase())) return n;
        nodes.add(n.toLowerCase());
        return xref.nodes?.get(n.toLowerCase()) ?? n;
      });
      return `${kind}(${out.join(",")})`;
    }),
  );
  xref.devices = devices;
  xref.readsNodes = [...nodes];
  xref.readsCurrents = [...currents];
  // A coupling part (`kT2 lL4 lL5 0.9`): the inductors are other parts.
  const ks = elements.map((l) => l.trim().split(/\s+/)).filter((t) => /^k/i.test(t[0]!) && t.length >= 4);
  const foreignL = (t: string[]) => t.slice(1, -1).every((x) => !isDevice(x.toLowerCase()));
  xref.couplings =
    ks.length && ks.length === elements.length && ks.every(foreignL)
      ? ks.map((t) => ({ name: t[0]!, inductors: t.slice(1, -1).map((x) => x.toLowerCase()), k: t.at(-1)! }))
      : undefined;
  return [...blocks, rewritten].join("\n");
}

/**
 * KiCad simulation spec for one part from its sections (one per Multisim
 * section that carries a template). KiCad simulates a part as one element
 * across all its units, so several sections become one wrapper.
 */
export function simSpec(ref: string, sectionsIn: SimSection[], lib: SpiceLibrary, wrapperBase = `EW_${spiceName(ref)}`, xref?: Xref): SimSpec {
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

  if (sections.length === 1 && !xref?.wrap) {
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
  const modelTexts = sections.flatMap((s) => [ngspiceDialect(s.template), s.model?.text ?? "", ...[...(s.pinModels?.values() ?? [])].map((p) => (enablePinModel(p) ?? p).model.text)]);
  // (A template's LAPLACE has its function only once expanded: checked below.)
  const foreign = unsupportedModelType(modelTexts.join("\n").replace(/^.*\bLAPLACE\b.*$/gim, ""));
  if (foreign) {
    const why = sections.flatMap((s) => s.model?.issues ?? []);
    lib.warnings.push(`${ref}: its model uses ${foreign}, which ngspice lacks${why.length ? ` (${why.join("; ")})` : ""}; excluded from simulation`);
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
  // Tri-state pins' enable nodes the bridges read, and those a chip drives.
  const enRead = new Set<string>();
  const enDriven = new Set<string>();
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
      const base = s.pinModels?.get(term);
      const pm = base && (enablePinModel(base) ?? base);
      if (pm && pm !== base) enRead.add(`d_${analog}_en`);
      if (!pm) {
        noInterface.add(term);
        return dnode;
      }
      lib.useModel(pm.model);
      const line = expandTemplate(pm.template.replace(/\r\n?/g, "\n").trim(), {
        ref: `${spiceName(ref)}_${spiceName(term)}`,
        params: [],
        model: pm.model.name,
        // 1 = the pin, 2 = the digital side the logic drives, 3 = the pin
        // read back (a bidirectional model's A/D output), else a supply pin.
        // EN = a tri-state pin's enable (see enablePinModel).
        node: (t) => (t === "1" ? analog : t === "2" ? `d_${analog}` : t === "3" ? `r_${analog}` : t === "EN" ? `d_${analog}_en` : (node(t) ?? "0")),
      });
      // `~%t2`: the model takes the inverted signal (an XSPICE array
      // notation, meaningless on a subcircuit call): an inverter makes it.
      const inverted: string[] = [];
      const call = line.replace(/(^|\s)~(\S+)/g, (_, sp: string, n: string) => {
        inverted.push(`a${n}_inv ${n} ${n}_n EW_invert`, ".model EW_invert d_inverter(rise_delay=1e-12 fall_delay=1e-12)");
        return `${sp}${n}_n`;
      });
      bridges.push(call, ...inverted);
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
    const call = s.model?.dchip ? rewriteDChipInstances(main, new Map([[s.model.name.toLowerCase(), s.model.dchip]]), chipErrors, enDriven) : main;
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
  // A tri-state pin whose logic has no enable (an output that is never Z) always drives.
  const alwaysOn = [...enRead].filter((n) => !enDriven.has(n));
  if (alwaysOn.length) lines.push([...alwaysOn.map((n) => `a${n}_on ${n} EW_drives`), ".model EW_drives d_pullup"].join("\n"));
  // Helper models (EW_invert, ...) once per wrapper.
  const seenModels = new Set<string>();
  let body = lines
    .join("\n")
    .split("\n")
    .filter((l) => !/^\.model EW_/.test(l) || (!seenModels.has(l) && !!seenModels.add(l)))
    .join("\n");
  // Again on the expanded text: `%S0` can carry a whole `.model`.
  const foreignExpanded = unsupportedModelType(body);
  if (foreignExpanded) {
    lib.warnings.push(`${ref}: its model uses ${foreignExpanded}, which ngspice lacks; excluded from simulation`);
    return { exclude: true };
  }
  // Multisim's expressions know `pi`; ngspice's `{...}` doesn't.
  if (/\{[^}]*\bpi\b/i.test(body)) body = `.param pi=3.141592653589793\n${body}`;
  if (xref) {
    body = crossRefs(body, nodes, xref);
    xref.wrapped = true;
    xref.pinNodes = new Map(nodeOfPin);
    const probes = (xref.probes ?? []).flatMap((p) => {
      const what = p.pin !== undefined ? nodeOfPin.get(p.pin) && `V(${nodeOfPin.get(p.pin)})` : p.device && `I(${p.device})`;
      return what ? [`B${p.global} ${p.global} 0 V={${what}}`] : [];
    });
    if (probes.length) body = `${body}\n* Probes other parts read (Multisim names are global)\n${probes.join("\n")}`;
  }
  const name = lib.wrapper(wrapperBase, nodes, body, `${ref} (Multisim netlist template)`);
  return { device: "SUBCKT", name, library: true, pins: pinList.map((p) => [p, nodeOfPin.get(p)!]) };
}

/**
 * Find what each part's expressions read from other parts (see `Xref`) and
 * set up the probes and rewrites. A dry run of every part (on a scratch
 * library) gives the names each one reads and defines.
 */
function resolveCrossRefs(
  parts: { ref: string; circuit: string; ids: string[]; sections: SimSection[]; xref: Xref }[],
  ciNodes: { body: EwElement }[],
  portOf: Map<string, { comp: string; pad: string }>,
  partOf: Map<string, (typeof parts)[number]>,
  finals: Map<string, string[]>,
  namedNets: Map<string, { refdes: string; pin: string }[]>,
  lib: SpiceLibrary,
): string[] {
  type P = (typeof parts)[number];
  // How each part simulates on its own, and its wrapper's names.
  const plain = new Map<P, boolean>();
  const info = new Map<P, Xref>();
  for (const p of parts) {
    const asIs: Xref = {};
    const spec = simSpec(p.ref, p.sections, new SpiceLibrary(), undefined, asIs);
    if (spec.exclude) continue;
    plain.set(p, !asIs.wrapped);
    const wrapped: Xref = { wrap: true };
    simSpec(p.ref, p.sections, new SpiceLibrary(), undefined, wrapped);
    info.set(p, wrapped);
  }
  const readers = parts.filter((p) => !plain.get(p) && (info.get(p)?.readsNodes?.length || info.get(p)?.readsCurrents?.length));
  const couplers = parts.filter((p) => info.get(p)?.couplings);
  if (!readers.length && !couplers.length) return [];

  // Multisim's name for each part: its final refdes, once per placement.
  const namesOf = (p: P): string[] => [...new Set(p.ids.flatMap((id) => finals.get(id) ?? [p.ref]))];
  const nets = ciNodes.map(({ body }) => ({
    name: body.str("LocalName").toLowerCase(),
    circuit: body.get("Circuit") ?? "",
    ports: (body.child("Ports")?.childrenNamed("Item") ?? []).flatMap((i) => {
      const port = portOf.get(i.get("CiID") ?? "");
      const part = port && partOf.get(port.comp);
      return port && part ? [{ part, pad: port.pad }] : [];
    }),
  }));
  const probe = (target: P, global: string, at: { pin?: string; device?: string }): void => {
    target.xref.wrap = true;
    const probes = (target.xref.probes ??= []);
    if (!probes.some((q) => q.global === global)) probes.push({ global, ...at });
    lib.globals.add(global);
  };
  // One global node per name read (`amp_in+` and `amp_in-` stay apart).
  const globalNames = new Map<string, string>();
  const globalFor = (prefix: string, name: string): string => {
    const key = `${prefix}${name}`;
    let g = globalNames.get(key);
    if (g) return g;
    g = `${prefix}${spiceName(name.replace(/\+/g, "p").replace(/-/g, "n"))}`;
    while ([...globalNames.values()].includes(g)) g += "_";
    globalNames.set(key, g);
    return g;
  };
  // A probe in a part placed more than once would be driven once per placement.
  const once = (p: P): boolean => namesOf(p).length === 1 && info.has(p);

  // `vSensor1` is the device `v%p` of the part named Sensor1: our wrapper
  // names it after the part's Ci name (`vV5`).
  const deviceNamed = (d: string): { part: P; device: string; final: string } | undefined => {
    for (const p of parts) {
      if (!info.has(p)) continue;
      const own = spiceName(p.ref).toLowerCase();
      for (const dev of info.get(p)!.devices ?? []) {
        const lower = dev.toLowerCase();
        const at = lower.indexOf(own);
        if (at < 0) continue;
        const final = namesOf(p).find((f) => `${lower.slice(0, at)}${f.toLowerCase()}${lower.slice(at + own.length)}` === d);
        if (final) return { part: p, device: dev, final };
      }
    }
    return undefined;
  };

  // Couplings move to the top level as a KiCad text directive (KiCad passes
  // `K` lines through), naming the inductors as KiCad's netlist does.
  const directives: string[] = [];
  for (const p of couplers) {
    const lines: string[] = [];
    for (const c of info.get(p)!.couplings!) {
      const names = c.inductors.map((l) => {
        const found = deviceNamed(l);
        if (!found || !once(found.part)) return undefined;
        // An ideal inductor is KiCad's own `L`, named after its reference
        // (prefixed with L unless it starts with one); else the inductor
        // inside the part's subcircuit, by its flattened name.
        return plain.get(found.part) ? (found.final.startsWith("L") ? found.final : `L${found.final}`) : `${found.device[0]}.x${found.final}.${found.device}`.toLowerCase();
      });
      if (names.some((n) => !n)) {
        lib.warnings.push(`${p.ref}: couples ${c.inductors.join(", ")}, which the design doesn't simulate as single inductors; excluded from simulation`);
        lines.length = 0;
        break;
      }
      const own = spiceName(namesOf(p)[0]!);
      lines.push(`${/^k/i.test(own) ? own : `K${own}`}${lines.length ? `_${lines.length}` : ""} ${names.join(" ")} ${c.k}`);
    }
    p.xref.moved = true;
    if (lines.length) directives.push(lines.join("\n"));
  }

  for (const reader of readers) {
    const { readsNodes = [], readsCurrents = [] } = info.get(reader)!;
    const nodes = (reader.xref.nodes ??= new Map());
    const currents = (reader.xref.currents ??= new Map());
    for (const n of readsNodes) {
      // A name users gave the net, else Multisim's own net number (`V(12,1)`).
      const same = nets.filter((x) => x.name === n && x.circuit === reader.circuit);
      const numbered = same[0] ?? (nets.filter((x) => x.name === n).length === 1 ? nets.find((x) => x.name === n) : undefined);
      const named = namedNets.get(n)?.flatMap(({ refdes, pin }) => {
        const part = parts.find((p) => namesOf(p).includes(refdes));
        return part ? [{ part, pad: pin }] : [];
      });
      const net = named ? { ports: named } : numbered;
      if (!net) {
        lib.warnings.push(`${reader.ref}: its expression reads V(${n}), but the design has no net ${n}`);
        continue;
      }
      // The reader's own pin: read its node directly.
      const own = net.ports.find((q) => q.part === reader);
      const ownNode = own && info.get(reader)?.pinNodes?.get(own.pad);
      if (ownNode) {
        nodes.set(n, ownNode);
        continue;
      }
      // Else probe on another part's pin, preferring one that is a wrapper anyway.
      const host = [...net.ports].filter((q) => q.part !== reader && once(q.part) && info.get(q.part)?.pinNodes?.has(q.pad)).sort((a, b) => Number(plain.get(a.part)) - Number(plain.get(b.part)))[0];
      if (!host) {
        lib.warnings.push(`${reader.ref}: its expression reads V(${n}), but no simulated part on that net can carry a probe; left unconnected`);
        continue;
      }
      const g = globalFor("ew_v_", n);
      probe(host.part, g, { pin: host.pad });
      nodes.set(n, g);
    }
    for (const d of readsCurrents) {
      const found = deviceNamed(d);
      if (!found) {
        lib.warnings.push(`${reader.ref}: its expression reads I(${d}), but no part defines ${d}`);
        continue;
      }
      if (!once(found.part)) {
        lib.warnings.push(`${reader.ref}: its expression reads I(${d}), but that part is placed more than once; left as is`);
        continue;
      }
      const g = globalFor("ew_i_", d);
      probe(found.part, g, { device: found.device });
      currents.set(d, g);
    }
  }
  return directives;
}

/**
 * Build KiCad simulation specs for every simulated component of a design.
 * `items` is the design's Ci objects by class (`collectCiItems`). The
 * sections of one part (same circuit and refdes) share one spec.
 */
export function parseSpice(
  items: Map<string, { id: string; body: EwElement }[]>,
  circuitParamNames: ReadonlySet<string> = new Set(),
  /** Final refdes per `CiComponent` placement (`MultisimDesign.finalNames`), for cross-part references. */
  finals: Map<string, string[]> = new Map(),
  /** Pins on each net users named (`flattenNetlist`), for expressions that read `V(name)`. */
  namedNets: Map<string, { refdes: string; pin: string }[]> = new Map(),
): SpiceDesign {
  const lib = new SpiceLibrary();
  const byComponent = new Map<string, SimSpec>();

  const ports = new Map<string, Map<string, string>>();
  const portOf = new Map<string, { comp: string; pad: string }>();
  const pinModels = new Map<string, Map<string, PinModel>>();
  const pinModelCache = new Map<string, ModelDef>();
  for (const { id, body } of items.get("CiPort") ?? []) {
    const comp = body.get("Component") ?? "";
    const terminal = body.str("LocalName");
    // No pad number (instruments, interactive parts): the KiCad pin is numbered
    // by its name, as for the drawing.
    const pad = portPinNumbers(body)[0] ?? (terminal || undefined);
    if (!terminal || !pad) continue;
    portOf.set(id, { comp, pad });
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

  interface Part {
    ref: string;
    circuit: string;
    ids: string[];
    sections: SimSection[];
    xref: Xref;
  }
  const parts = new Map<string, Part>();
  const partOf = new Map<string, Part>();
  for (const { id, body } of items.get("CiComponent") ?? []) {
    const ref = body.str("LocalName");
    const template = netlistTemplate(body);
    // Sections of one part netlist as `%p_a`, `%p_b`, ...; other parts that
    // share a name (every VCC symbol is "VCC") stay separate.
    const key = /%p_\w/.test(template) ? `${body.get("Circuit") ?? ""}|${ref}` : id;
    const part = parts.get(key) ?? { ref, circuit: body.get("Circuit") ?? "", ids: [], sections: [], xref: {} };
    partOf.set(id, part);
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
  const directives = resolveCrossRefs([...parts.values()], items.get("CiNode") ?? [], portOf, partOf, finals, namedNets, lib);
  for (const { ref, ids, sections, xref } of parts.values()) {
    const spec = xref.moved ? { exclude: true } : simSpec(ref, sections, lib, undefined, xref);
    for (const id of ids) byComponent.set(id, spec);
  }

  return { byComponent, library: lib.text("SPICE models from the Multisim design (multisim2kicad)"), directives, warnings: lib.warnings };
}
