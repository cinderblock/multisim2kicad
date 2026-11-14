/**
 * Multisim's `d_chip` behavioural logic -> ngspice XSPICE.
 *
 * Multisim describes most MSI logic (74xx counters, decoders, comparators,
 * 4000-series registers, ...) with a `.MODEL <name> d_chip (behaviour="...")`
 * whose string is a small table language:
 *
 *     /inputs  A B C          pins, in the order the instance lists them
 *     /outputs Y Z
 *     /wires   W1 W2          internal nets of the top level
 *     /module NAME ... /endmodule
 *     /instance NAME a b y    a module instance (its inputs, then outputs)
 *     /table N                N rows: input values, then output values
 *     /clock CLK +|-|X F S A  F state flags; S synchronous rows (applied on
 *                             the clock edge), then A asynchronous rows
 *     /delay N                N rows: input output rise fall
 *     /conditional_delay N, /constraint N   timing detail and checks
 *
 * Rows match top to bottom; the first that matches wins. Input values are
 * `L`/`H`/`X` (don't care), one character per column, so `HHLL` covers four
 * columns. A clocked module's columns are its inputs followed by its flags
 * (`F0` = flag 0). Output values: `L`, `H`, `X`, `Z`, an input's name (or
 * `~name`), `Fk` / `~Fk`, and `F+k` / `F-k`: bit k of the flags read as a
 * binary number (F0 lowest) plus or minus one.
 *
 * Translation: each output of a table becomes an XSPICE `d_lut` over the
 * columns it depends on; each flag a `d_dff` whose data input is a `d_lut`
 * of the synchronous rows and whose set / reset inputs are `d_lut`s of the
 * asynchronous rows; modules are flattened. Delays: a module output gets the
 * largest rise / fall delay its `/delay` rows give it (per-path delays and
 * conditional delays are folded into that one number); timing constraints
 * are dropped.
 */

/** SPICE-safe identifier (as spice.ts; kept here to avoid an import cycle). */
const spiceName = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, "_");

type Value = "0" | "1" | "X" | "Z";

interface Clock {
  input: string;
  edge: "+" | "-" | "X";
  flags: number;
  sync: string[][];
  async: string[][];
}

interface Module {
  name: string;
  inputs: string[];
  outputs: string[];
  wires: string[];
  clock?: Clock;
  table?: string[][];
  /** Output -> largest rise / fall delay in seconds. */
  delays: Map<string, { rise: number; fall: number }>;
  instances: { module: string; args: string[] }[];
}

export interface Chip {
  top: Module;
  modules: Map<string, Module>;
}

const SCALE: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9 };

function seconds(v: string): number | undefined {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(meg|[fpnumkg])?s?$/i.exec(v.trim());
  if (!m) return undefined;
  return Number(m[1]) * (m[2] ? SCALE[m[2].toLowerCase()]! : 1);
}

/** The text inside `behaviour="..."` (continuation `+` already part of it). */
function behaviourText(modelText: string): string | undefined {
  const m = /behaviou?r\s*=\s*"([\s\S]*?)"/i.exec(modelText);
  return m?.[1];
}

/** Parse a `d_chip` model's behaviour string. Throws on anything it doesn't know. */
export function parseChip(modelText: string): Chip {
  const text = behaviourText(modelText);
  if (text === undefined) throw new Error("no behaviour string");
  const newModule = (name: string): Module => ({ name, inputs: [], outputs: [], wires: [], delays: new Map(), instances: [] });
  const top = newModule("");
  const modules = new Map<string, Module>();
  let cur = top;
  // Modules may nest (a module's own helper modules); names are global.
  const stack: Module[] = [];
  // Rows still expected by the last directive.
  let want: { kind: "table" | "sync" | "async" | "delay" | "cdelay" | "skip"; left: number } | undefined;
  let asyncLeft = 0;
  const addDelay = (out: string, rise: number | undefined, fall: number | undefined) => {
    if (rise === undefined && fall === undefined) return;
    const d = cur.delays.get(out) ?? { rise: 0, fall: 0 };
    d.rise = Math.max(d.rise, rise ?? fall ?? 0);
    d.fall = Math.max(d.fall, fall ?? rise ?? 0);
    cur.delays.set(out, d);
  };

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    // `*+...`: a commented-out row.
    if (/^\s*\*/.test(raw)) continue;
    const line = raw.replace(/^\s*\+/, "").replace(/;.*$/, "").trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (line.startsWith("/")) {
      want = undefined;
      const dir = tokens[0]!.toLowerCase();
      const args = tokens.slice(1);
      const count = (i: number) => {
        const n = Number(args[i]);
        if (!Number.isInteger(n) || n < 0) throw new Error(`${dir}: bad count ${args[i]}`);
        return n;
      };
      switch (dir) {
        case "/inputs":
          cur.inputs.push(...args);
          break;
        case "/outputs":
          cur.outputs.push(...args);
          break;
        case "/wires":
          cur.wires.push(...args);
          break;
        case "/module": {
          stack.push(cur);
          cur = newModule(args[0] ?? "");
          modules.set(cur.name.toLowerCase(), cur);
          break;
        }
        case "/endmodule":
          cur = stack.pop() ?? top;
          break;
        case "/instance":
          cur.instances.push({ module: args[0] ?? "", args: args.slice(1) });
          break;
        case "/table":
          cur.table = [];
          want = { kind: "table", left: count(0) };
          break;
        case "/clock": {
          const edge = (args[1] ?? "").toUpperCase();
          if (edge !== "+" && edge !== "-" && edge !== "X") throw new Error(`/clock: edge ${args[1]}`);
          cur.clock = { input: args[0] ?? "", edge, flags: count(2), sync: [], async: [] };
          want = { kind: "sync", left: count(3) };
          asyncLeft = count(4);
          if (want.left === 0) want = { kind: "async", left: asyncLeft };
          break;
        }
        case "/delay":
          want = { kind: "delay", left: args.length ? count(0) : Infinity };
          break;
        case "/conditional_delay":
          want = { kind: "cdelay", left: args.length ? count(0) : Infinity };
          break;
        case "/constraint":
          want = { kind: "skip", left: Infinity };
          break;
        default:
          throw new Error(`unknown directive ${tokens[0]}`);
      }
      continue;
    }
    if (!want || want.left <= 0) throw new Error(`unexpected row: ${line}`);
    want.left--;
    switch (want.kind) {
      case "table":
        cur.table!.push(tokens);
        break;
      case "sync":
        cur.clock!.sync.push(tokens);
        if (want.left === 0) want = { kind: "async", left: asyncLeft };
        break;
      case "async":
        cur.clock!.async.push(tokens);
        break;
      case "delay": {
        // input output rise fall
        if (tokens.length < 4) throw new Error(`/delay row: ${line}`);
        addDelay(tokens[1]!, seconds(tokens[2]!), seconds(tokens[3]!));
        break;
      }
      case "cdelay": {
        // event input (condition) output min/max time
        const t = seconds(tokens[tokens.length - 1]!);
        const out = tokens[tokens.length - 3]!;
        const event = tokens[0]!.toUpperCase();
        // LH / ZH: a rise; HL / ZL: a fall; to Z: both.
        addDelay(out, event.endsWith("L") ? undefined : t, event.endsWith("H") ? undefined : t);
        break;
      }
      case "skip":
        break;
    }
  }
  if (stack.length) throw new Error(`module ${cur.name} has no /endmodule`);
  return { top, modules };
}

/** A table's rows split into one value per input column and one token per output. */
function splitRows(rows: string[][], nIn: number, nOut: number, what: string): { ins: string; outs: string[] }[] {
  return rows.map((tokens) => {
    let ins = "";
    let i = 0;
    while (ins.length < nIn) {
      const t = tokens[i++];
      if (t === undefined || !/^[LHXZ01]+$/i.test(t)) throw new Error(`${what}: row "${tokens.join(" ")}" has too few input columns`);
      ins += t.toUpperCase();
    }
    if (ins.length !== nIn) throw new Error(`${what}: row "${tokens.join(" ")}" does not split into ${nIn} inputs`);
    let outs = tokens.slice(i);
    if (outs.length !== nOut) outs = outs.flatMap((t) => (/^[LHXZ]+$/i.test(t) ? [...t] : [t]));
    if (outs.length !== nOut) throw new Error(`${what}: row "${tokens.join(" ")}" does not have ${nOut} outputs`);
    return { ins: ins.replace(/0/g, "L").replace(/1/g, "H").replace(/Z/g, "X"), outs };
  });
}

/**
 * The columns a table reads: the module's inputs, its flags (clocked), then
 * its own outputs (a table that names an output in an output column holds
 * that output's present value: a latch).
 */
interface Columns {
  inputs: string[];
  flags: number;
  outputs: string[];
}

/**
 * An output token as a function of the columns: its value, and the columns
 * it reads.
 */
function outputFn(token: string, c: Columns, what: string): { read: number[]; value: (col: (i: number) => 0 | 1) => Value } {
  const t = token;
  const constant = ({ L: "0", H: "1", X: "X", Z: "Z", "0": "0", "1": "1" } as Record<string, Value>)[t.toUpperCase()];
  if (constant) return { read: [], value: () => constant };
  const names = [...c.inputs, ...Array.from({ length: c.flags }, () => "\u0000"), ...c.outputs];
  const find = (name: string) => {
    let i = names.indexOf(name);
    if (i < 0) i = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    return i;
  };
  const bit = (b: 0 | 1, invert: boolean): Value => ((b ^ (invert ? 1 : 0)) === 1 ? "1" : "0");
  const direct = find(t);
  if (direct >= 0) return { read: [direct], value: (col) => bit(col(direct), false) };
  if (t.startsWith("~") && find(t.slice(1)) >= 0) {
    const i = find(t.slice(1));
    return { read: [i], value: (col) => bit(col(i), true) };
  }
  const base = c.inputs.length;
  const flag = /^(~?)F(\d+)$/i.exec(t);
  if (flag && Number(flag[2]) < c.flags) {
    const i = base + Number(flag[2]);
    return { read: [i], value: (col) => bit(col(i), !!flag[1]) };
  }
  const count = /^F([+-])(\d+)$/i.exec(t);
  if (count && Number(count[2]) < c.flags) {
    // Bit k of the count +/- 1 depends on bits 0..k only.
    const k = Number(count[2]);
    const read = Array.from({ length: k + 1 }, (_, j) => base + j);
    return {
      read,
      value: (col) => {
        let n = 0;
        for (let j = 0; j <= k; j++) n |= col(base + j) << j;
        n = (n + (count[1] === "+" ? 1 : -1) + (2 << k)) % (2 << k);
        return (n >> k) & 1 ? "1" : "0";
      },
    };
  }
  throw new Error(`${what}: unknown output value ${token}`);
}

/** Widest `d_lut` we generate (2^n table entries); wider functions are split. */
const MAX_LUT_INPUTS = 10;

/** One output of a table as a boolean function of its columns. */
interface TableFn {
  rows: { ins: string; outs: string[] }[];
  out: number;
  columns: Columns;
  /** Value when no row matches, and the columns that reads. */
  fallback: (col: (i: number) => 0 | 1) => Value;
  fallbackReads: number[];
  /** Map a matched row's value (and its token) to the result. */
  pick?: (v: Value, token: string) => Value;
  what: string;
}

/** Rows that can still match with `fixed` columns, and the columns the result reads. */
function cofactor(f: TableFn, fixed: ReadonlyMap<number, 0 | 1>): { rows: number[]; support: number[] } {
  const rows: number[] = [];
  const cols = new Set<number>(f.fallbackReads);
  for (let r = 0; r < f.rows.length; r++) {
    const ins = f.rows[r]!.ins;
    let possible = true;
    for (const [i, v] of fixed) if ((ins[i] === "L" && v === 1) || (ins[i] === "H" && v === 0)) possible = false;
    if (!possible) continue;
    rows.push(r);
    [...ins].forEach((ch, i) => ch !== "X" && cols.add(i));
    for (const i of outputFn(f.rows[r]!.outs[f.out]!, f.columns, f.what).read) cols.add(i);
    // A row that matches whatever the free columns are hides every row below it.
    if ([...ins].every((ch, i) => ch === "X" || fixed.has(i))) break;
  }
  return { rows, support: [...cols].filter((i) => !fixed.has(i)).sort((a, b) => a - b) };
}

/**
 * The truth table of `f` over its free columns (first = least significant
 * index bit), with columns it turns out not to depend on dropped.
 */
function truthTable(f: TableFn, fixed: ReadonlyMap<number, 0 | 1>): { support: number[]; table: string } {
  const { rows, support: sup } = cofactor(f, fixed);
  let support = sup;
  const fns = new Map(rows.map((r) => [r, outputFn(f.rows[r]!.outs[f.out]!, f.columns, f.what)]));
  const pick = f.pick ?? ((v) => v);
  const evaluate = (assign: Map<number, 0 | 1>): Value => {
    const col = (i: number) => assign.get(i) ?? fixed.get(i) ?? 0;
    for (const r of rows) {
      const ins = f.rows[r]!.ins;
      let ok = true;
      for (let i = 0; i < ins.length && ok; i++) {
        const ch = ins[i];
        if (ch === "L") ok = col(i) === 0;
        else if (ch === "H") ok = col(i) === 1;
      }
      if (ok) return pick(fns.get(r)!.value(col), f.rows[r]!.outs[f.out]!);
    }
    return f.fallback(col);
  };
  let table = "";
  for (let idx = 0; idx < 1 << support.length; idx++) {
    const assign = new Map<number, 0 | 1>();
    support.forEach((c, j) => assign.set(c, ((idx >> j) & 1) as 0 | 1));
    table += evaluate(assign);
  }
  for (let j = support.length - 1; j >= 0; j--) {
    const half = 1 << j;
    let same = true;
    for (let idx = 0; idx < table.length && same; idx++) if (!(idx & half) && table[idx] !== table[idx | half]) same = false;
    if (!same) continue;
    let reduced = "";
    for (let idx = 0; idx < table.length; idx++) if (!(idx & half)) reduced += table[idx];
    table = reduced;
    support = support.filter((_, k) => k !== j);
  }
  return { support, table };
}

const TINY = "1e-12";

/** Emits the flattened netlist of one chip. */
class Emitter {
  lines: string[] = [];
  private models = new Map<string, string>(); // definition -> name
  private used = new Set<string>();
  private n = 0;
  constructor(private base: string) {}

  node(hint: string): string {
    const s = spiceName(hint) || "x";
    let n = s.startsWith("n_") ? s : `n_${s}`;
    while (this.used.has(n.toLowerCase())) n += "_";
    this.used.add(n.toLowerCase());
    return n;
  }
  reserve(name: string): string {
    let n = spiceName(name) || "p";
    if (/^\d/.test(n)) n = `p${n}`;
    while (this.used.has(n.toLowerCase())) n += "_";
    this.used.add(n.toLowerCase());
    return n;
  }
  model(type: string, params: string): string {
    const def = `${type}(${params})`;
    let name = this.models.get(def);
    if (!name) {
      name = `${this.base}_${type.replace(/^d_/, "")}${this.models.size}`;
      this.models.set(def, name);
    }
    return name;
  }
  element(text: string): void {
    this.lines.push(`a${++this.n} ${text}`);
  }
  modelLines(): string[] {
    return [...this.models].map(([def, name]) => `.model ${name} ${def}`);
  }
}

/** Seconds, short: 2.8e-8 rather than 2.8000000000000003e-8. */
const fmt = (s: number) => String(Number(s.toPrecision(6)));

const delayParams = (d?: { rise: number; fall: number }) =>
  `rise_delay=${d && d.rise > 0 ? fmt(d.rise) : TINY} fall_delay=${d && d.fall > 0 ? fmt(d.fall) : TINY}`;

function lut(em: Emitter, inputs: string[], out: string, table: string, d?: { rise: number; fall: number }): void {
  em.element(`[${inputs.join(" ")}] ${out} ${em.model("d_lut", `table_values="${table}" ${delayParams(d)}`)}`);
}

/**
 * Emit `f` driving `out`. A function of more than MAX_LUT_INPUTS columns is
 * split on one column (Shannon: out = x ? f|x=1 : f|x=0), choosing the
 * column whose two halves read the fewest columns: a 16-to-1 multiplexer
 * splits on its select lines.
 */
function emitFn(
  em: Emitter,
  f: TableFn,
  fixed: ReadonlyMap<number, 0 | 1>,
  colNode: (i: number) => string,
  out: string,
  d?: { rise: number; fall: number },
  depth = 0,
): void {
  const { support } = cofactor(f, fixed);
  if (support.length <= MAX_LUT_INPUTS) {
    const t = truthTable(f, fixed);
    // A constant still needs an input to hang its table on.
    if (t.support.length === 0) lut(em, [colNode(support[0] ?? 0)], out, t.table + t.table, d);
    else lut(em, t.support.map(colNode), out, t.table, d);
    return;
  }
  if (depth > 24) throw new Error(`${f.what}: cannot split a ${support.length}-column function`);
  let best = support[0]!;
  let bestCost = Infinity;
  for (const x of support) {
    const cost = Math.max(...([0, 1] as const).map((v) => cofactor(f, new Map([...fixed, [x, v]])).support.length));
    if (cost < bestCost) [best, bestCost] = [x, cost];
  }
  const halves = ([0, 1] as const).map((v) => {
    const n = em.node(`${out}_${v}`);
    emitFn(em, f, new Map([...fixed, [best, v]]), colNode, n, undefined, depth + 1);
    return n;
  });
  // [f0 f1 x]: x ? f1 : f0.
  lut(em, [halves[0]!, halves[1]!, colNode(best)], out, "01010011", d);
}

/** Whether an async set / reset function can ever be 1: some row produces it. */
function canBeOne(f: TableFn): boolean {
  return f.rows.some((r) => {
    const token = r.outs[f.out]!;
    const fn = outputFn(token, f.columns, f.what);
    if (fn.read.length === 0) return f.pick!(fn.value(() => 0), token) === "1";
    return f.pick!("1", token) === "1" || f.pick!("0", token) === "1";
  });
}

/** Flatten `mod` into `em`, its pins bound to `ports`. */
function flatten(chip: Chip, mod: Module, ports: Map<string, string>, em: Emitter, scope: string, depth: number): void {
  if (depth > 8) throw new Error("modules nested too deep");
  const what = mod.name || "top level";
  const local = new Map(ports);
  const net = (name: string): string => {
    let n = local.get(name);
    if (!n) {
      n = em.node(`${scope}${name}`);
      local.set(name, n);
    }
    return n;
  };
  for (const w of mod.wires) net(w);

  // Outputs driven by instances but delayed by this module's /delay: a buffer.
  const fromTable = new Set(mod.table || mod.clock ? mod.outputs : []);
  const delayedPre = new Map<string, string>();
  for (const [out, d] of mod.delays) {
    if (fromTable.has(out) || !mod.outputs.includes(out)) continue;
    const pre = em.node(`${scope}${out}_pre`);
    delayedPre.set(out, pre);
    em.element(`${pre} ${net(out)} ${em.model("d_buffer", delayParams(d))}`);
  }

  mod.instances.forEach((inst, k) => {
    const sub = chip.modules.get(inst.module.toLowerCase());
    if (!sub) throw new Error(`${what}: no module ${inst.module}`);
    const pins = [...sub.inputs, ...sub.outputs];
    if (inst.args.length !== pins.length) throw new Error(`${what}: /instance ${inst.module} has ${inst.args.length} of ${pins.length} pins`);
    const bind = new Map<string, string>();
    pins.forEach((p, i) => {
      const a = inst.args[i]!;
      bind.set(p, (i >= sub.inputs.length && delayedPre.get(a)) || net(a));
    });
    flatten(chip, sub, bind, em, `${scope}${spiceName(inst.module)}${k}_`, depth + 1);
  });

  if (!mod.table && !mod.clock) return;
  const flags = mod.clock?.flags ?? 0;
  const columns: Columns = { inputs: mod.inputs, flags, outputs: mod.outputs };
  const inNodes = mod.inputs.map(net);
  const flagNodes = Array.from({ length: flags }, (_, k) => em.node(`${scope}F${k}`));
  const colNode = (i: number) =>
    i < inNodes.length ? inNodes[i]! : i < inNodes.length + flags ? flagNodes[i - inNodes.length]! : net(mod.outputs[i - inNodes.length - flags]!);
  if (!inNodes.length && !flags) throw new Error(`${what}: no inputs`);
  const nCols = mod.inputs.length + flags;
  const none = new Map<number, 0 | 1>();

  if (mod.clock) {
    const c = mod.clock;
    const sync = splitRows(c.sync, nCols, flags, `${what} /clock`);
    const asyn = splitRows(c.async, nCols, flags, `${what} /clock`);
    const clkIndex = mod.inputs.indexOf(c.input);
    if (clkIndex < 0) throw new Error(`${what}: clock ${c.input} is not an input`);
    let clk = inNodes[clkIndex]!;
    if (c.edge === "-") {
      const inv = em.node(`${scope}${c.input}_n`);
      em.element(`${clk} ${inv} ${em.model("d_inverter", delayParams())}`);
      clk = inv;
    } else if (c.edge === "X") {
      // Level-only module: the asynchronous rows do all the work.
      const low = em.node(`${scope}clk0`);
      em.element(`${low} ${em.model("d_pulldown", "")}`);
      clk = low;
    }
    for (let k = 0; k < flags; k++) {
      const own = mod.inputs.length + k;
      // Synchronous: the next value on the clock edge; no matching row holds.
      let data = flagNodes[k]!;
      if (c.edge !== "X") {
        data = em.node(`${scope}F${k}_next`);
        const f: TableFn = { rows: sync, out: k, columns, fallback: (col) => (col(own) ? "1" : "0"), fallbackReads: [own], what: `${what} /clock sync` };
        emitFn(em, f, none, colNode, data);
      }
      // Asynchronous: set / reset while a row forces a value; `Fk` holds.
      const isHold = (token: string) => token.toUpperCase() === `F${k}`;
      const pins = (["1", "0"] as const).map((want) => {
        const f: TableFn = {
          rows: asyn,
          out: k,
          columns,
          fallback: () => "0",
          fallbackReads: [],
          pick: (v, token) => (isHold(token) ? "0" : v === want ? "1" : "0"),
          what: `${what} /clock async`,
        };
        if (!canBeOne(f)) return "NULL";
        const n = em.node(`${scope}F${k}_${want === "1" ? "set" : "reset"}`);
        emitFn(em, f, none, colNode, n);
        return n;
      });
      em.element(
        `${data} ${clk} ${pins[0]} ${pins[1]} ${flagNodes[k]} NULL ${em.model("d_dff", `clk_delay=${TINY} set_delay=${TINY} reset_delay=${TINY} ${delayParams()}`)}`,
      );
    }
  }

  if (mod.table) {
    const rows = splitRows(mod.table, nCols, mod.outputs.length, `${what} /table`);
    mod.outputs.forEach((out, o) => {
      const f: TableFn = { rows, out: o, columns, fallback: () => "X", fallbackReads: [], what: `${what} /table` };
      emitFn(em, f, none, colNode, net(out), mod.delays.get(out));
    });
  } else if (mod.clock && mod.outputs.length === flags) {
    // No output table: the outputs are the flags.
    mod.outputs.forEach((out, k) => em.element(`${flagNodes[k]} ${net(out)} ${em.model("d_buffer", delayParams(mod.delays.get(out)))}`));
  } else if (mod.clock) {
    throw new Error(`${what}: clocked module without an output /table`);
  }
}

/** A translated chip: its subcircuit's name and pin count. */
export interface DChip {
  name: string;
  pins: number;
  inputs: number;
  outputs: number;
}

/**
 * A d_chip model as an ngspice subcircuit named `spiceName(name)`: pins are
 * the chip's inputs, then its outputs.
 */
export function dchipSubckt(name: string, modelText: string): DChip & { text: string } {
  const chip = parseChip(modelText);
  if (!chip.top.outputs.length) throw new Error("no /outputs");
  if (!chip.top.table && !chip.top.clock && !chip.top.instances.length) throw new Error("no logic (/table, /clock or /instance)");
  const safe = spiceName(name);
  const em = new Emitter(safe);
  const ports = new Map<string, string>();
  const portNodes: string[] = [];
  for (const p of [...chip.top.inputs, ...chip.top.outputs]) {
    if (ports.has(p)) throw new Error(`pin ${p} listed twice`);
    const n = em.reserve(p);
    ports.set(p, n);
    portNodes.push(n);
  }
  flatten(chip, chip.top, ports, em, "", 0);
  const header = `* Multisim d_chip ${name}, translated: ${chip.top.inputs.join(" ")} -> ${chip.top.outputs.join(" ")}`;
  const text = [header, `.subckt ${safe} ${portNodes.join(" ")}`, ...em.lines, ...em.modelLines(), `.ends ${safe}`].join("\n");
  return { name: safe, pins: portNodes.length, inputs: chip.top.inputs.length, outputs: chip.top.outputs.length, text };
}

/**
 * Translate every `.MODEL x d_chip (...)` in `text` into a subcircuit, and
 * its `a...` instances in `text` into `x...` subcircuit calls. Generated
 * subcircuits go to the top level, ahead of the rest (a model inside a
 * `.subckt` would otherwise nest). `chips` is keyed by the lower-case model
 * name, both as written and SPICE-safe. Models that fail to translate stay
 * as they are, with the reason in `errors`.
 */
export function translateDChips(text: string): { text: string; chips: Map<string, DChip>; errors: string[] } {
  const chips = new Map<string, DChip>();
  const errors: string[] = [];
  const generated: string[] = [];
  const src = text.replace(/\r\n?/g, "\n");
  if (!/\bd_chip\b/i.test(src)) return { text, chips, errors };
  const re = /^[ \t]*\.model[ \t]+(\S+)[ \t]+d_chip\b[^"]*"[^"]*"[ \t]*\)?[ \t]*$/gim;
  let out = src.replace(re, (whole, name: string) => {
    try {
      const sub = dchipSubckt(name, whole);
      const chip: DChip = { name: sub.name, pins: sub.pins, inputs: sub.inputs, outputs: sub.outputs };
      chips.set(name.toLowerCase(), chip);
      chips.set(sub.name.toLowerCase(), chip);
      generated.push(sub.text);
      return "";
    } catch (e) {
      errors.push(`d_chip ${name} not translated: ${(e as Error).message}`);
      return whole;
    }
  });
  if (!chips.size) return { text, chips, errors };
  out = rewriteDChipInstances(out, chips, errors);
  return { text: `${generated.join("\n\n")}\n\n${out.trim()}`, chips, errors };
}

/**
 * `aName [in ...] [out ...] model` -> `xaName in ... out ... model` for
 * translated chips. Templates often list more nodes than the chip declares
 * (an IC variant's VCC / GND at the end of the outputs, an open-collector
 * part's outputs read back at the end of the inputs); the chip never reads
 * them, so trailing extras are dropped. Too few nodes is an error.
 */
export function rewriteDChipInstances(text: string, chips: ReadonlyMap<string, DChip>, errors: string[] = []): string {
  // Instance lines may continue with `+`.
  const joined = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]*\+/g, " ");
  return joined.replace(/^([ \t]*)(a\S*)[ \t]+\[([^\]]*)\][ \t]*\[([^\]]*)\][ \t]+(\S+)[ \t]*$/gim, (whole, indent: string, inst: string, ins: string, outs: string, model: string) => {
    const chip = chips.get(model.toLowerCase());
    if (!chip) return whole;
    const list = (s: string) => s.trim().split(/\s+/).filter(Boolean);
    const i = list(ins);
    const o = list(outs);
    if (i.length < chip.inputs || o.length < chip.outputs) {
      errors.push(`${inst}: ${i.length} inputs / ${o.length} outputs for d_chip ${model}, which has ${chip.inputs} / ${chip.outputs}`);
      return whole;
    }
    return `${indent}x${inst} ${[...i.slice(0, chip.inputs), ...o.slice(0, chip.outputs)].join(" ")} ${chip.name}`;
  });
}
