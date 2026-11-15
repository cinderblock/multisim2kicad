/**
 * Multisim's simulation settings -> ngspice directives.
 *
 * Each sheet's `CIITDiagram` carries a `SimState` attribute: Multisim's own
 * serialization, `KEY:type{value}` with `list` values nesting
 * (`SIMULATION_INFO > ANALYSES > TRAN > ANALYSIS > TSTOP:double{0.5}`).
 * Per analysis (OP, AC, TRAN, ...) it keeps the settings, an `ANALYSIS_ID`
 * (non-zero once that analysis has results in the design) and `ASYS_OPT`,
 * the SPICE options with an `IsEnabled` flag each. Multisim enables
 * `rshunt=1e12` (plus `trtol=7 itl4=100 convlimit`) by default, which is
 * why it simulates designs with floating nets that plain ngspice rejects.
 */

export interface SimStateNode {
  key: string;
  type: string;
  value?: string;
  items?: SimStateNode[];
}

/** Parse a `SimState` string. Throws on text that isn't one. */
export function parseSimState(t: string): SimStateNode[] {
  let i = 0;
  const items = (): SimStateNode[] => {
    const out: SimStateNode[] = [];
    for (;;) {
      while (i < t.length && /\s/.test(t[i]!)) i++;
      if (i >= t.length || t[i] === "}") return out;
      const m = /^([^:{}\s]+):([a-z]+(?:\[\])?)\{/.exec(t.slice(i, i + 300));
      if (!m) throw new Error(`SimState: unexpected text at ${i}`);
      i += m[0].length;
      if (m[2] === "list") {
        const list = items();
        i++; // its "}"
        out.push({ key: m[1]!, type: "list", items: list });
      } else {
        let depth = 1;
        let j = i;
        for (; j < t.length && depth; j++) depth += t[j] === "{" ? 1 : t[j] === "}" ? -1 : 0;
        out.push({ key: m[1]!, type: m[2]!, value: t.slice(i, j - 1) });
        i = j;
      }
    }
  };
  return items();
}

const child = (nodes: SimStateNode[] | undefined, ...path: string[]): SimStateNode | undefined => {
  let cur: SimStateNode | undefined;
  for (const p of path) {
    cur = nodes?.find((n) => n.key === p);
    nodes = cur?.items;
  }
  return cur;
};

/** ngspice's options among Multisim's (Multisim-only ones, such as `dynamicdc` or `inertialdelay`, are dropped). */
const NGSPICE_OPTIONS = new Set(
  (
    "acct gmin reltol abstol vntol trtol chgtol pivtol pivrel tnom itl1 itl2 itl4 itl6 gminsteps defl defw defad defas " +
    "bypass maxord temp oldlimit minbreak noopiter method trytocompact badmos3 keepopinfo noopalter ramptime maxevtiter " +
    "maxopalter convlimit convabsstep convstep autopartial rshunt"
  ).split(" "),
);

export interface SimSettings {
  /** `.options ...`, or undefined when none apply. */
  options?: string;
  /** The analysis to run (`.tran ...`, `.ac ...`, `.op`), from those Multisim has results for, plus any note on it. */
  analysis?: string;
  /** The other analyses Multisim has results for (KiCad's directive runs one). */
  skipped: string[];
}

const num = (v: string | undefined): number | undefined => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** Six significant digits; exponent form when very large or small (`1e-05`, `3.3e+09`). */
const fmt = (x: number): string => {
  const v = Number(x.toPrecision(6));
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) {
    const [m, e] = v.toExponential().split("e");
    return `${m}e${e![0]}${e!.slice(1).padStart(2, "0")}`;
  }
  return v.toString();
};

/** The enabled options of one analysis, as an `.options` line. */
function optionsOf(analysis: SimStateNode | undefined): string | undefined {
  const opts = (child(analysis?.items, "ASYS_OPT")?.items ?? []).flatMap((o) => {
    if (child(o.items, "IsEnabled")?.value !== "1") return [];
    const opt = o.items!.find((x) => x.key !== "IsEnabled");
    if (!opt || !NGSPICE_OPTIONS.has(opt.key.toLowerCase())) return [];
    return [opt.type === "flag" ? opt.key : `${opt.key}=${opt.value}`];
  });
  return opts.length ? `.options ${opts.join(" ")}` : undefined;
}

/** A transient from its settings (`TSTOP`, `TSTEP`, `TMAX`, `IC`, ...). */
function tranDirective(a: SimStateNode[] | undefined): string | undefined {
  const v = (k: string) => child(a, k)?.value;
  const tstop = num(v("TSTOP"));
  // 1e30: Multisim's "run until stopped" (interactive), no fixed end.
  if (tstop === undefined || tstop <= 0 || tstop >= 1e20) return undefined;
  const tstart = num(v("TSTART")) ?? 0;
  const tmax = num(v("TMAX"));
  // "calculate": Multisim picks the step; a thousandth of the span plots smoothly.
  const tstep = num(v("TSTEP")) ?? (tstop - tstart) / 1000;
  const uic = /^(uic|zero_ic)$/i.test(v("IC") ?? "");
  const parts = [".tran", fmt(tstep), fmt(tstop)];
  if (tstart || tmax !== undefined || uic) parts.push(fmt(tstart));
  if (tmax !== undefined) parts.push(fmt(tmax));
  if (uic) parts.push("uic");
  return parts.join(" ");
}

/** The directive (and any note) for one analysis, when it translates. */
function directiveOf(kind: string, analysis: SimStateNode): string[] | undefined {
  const a = child(analysis.items, "ANALYSIS")?.items;
  const v = (k: string) => child(a, k)?.value;
  if (kind === "OP") return [".op"];
  if (kind === "TRAN") {
    const tran = tranDirective(a);
    return tran ? [tran] : undefined;
  }
  if (kind === "FOUR") {
    // Multisim's Fourier analysis runs a transient (its own settings) and
    // transforms the last period. ngspice ignores `.four` in KiCad's
    // interactive mode, so the transient runs and a note gives the
    // fundamental (KiCad can plot the FFT, or ngspice's `fourier` command).
    const tran = child(a, "Tran")?.items ?? [];
    const tstop = num(v("TStop"));
    const settings = tstop && !num(child(tran, "TSTOP")?.value) ? [...tran, { key: "TSTOP", type: "double", value: String(tstop) }] : tran;
    const directive = tranDirective(settings);
    if (!directive) return undefined;
    const fund = num(v("FundFreq"));
    const n = num(v("NumFreqs"));
    const note = fund && v("FundFreqSet") !== "0" ? `* Multisim's Fourier analysis of this transient: fundamental ${fmt(fund)} Hz${n ? `, ${fmt(n)} harmonics` : ""}` : "* Multisim's Fourier analysis runs this transient";
    return [directive, note];
  }
  if (kind === "AC") {
    const variation = (v("VARIATION") ?? "dec").toLowerCase();
    const n = num(v("NPOINTS_PER_VARIATION"));
    const f1 = num(v("FSTART"));
    const f2 = num(v("FSTOP"));
    if (!/^(dec|oct|lin)$/.test(variation) || n === undefined || f1 === undefined || f2 === undefined) return undefined;
    return [`.ac ${variation} ${fmt(n)} ${fmt(f1)} ${fmt(f2)}`];
  }
  return undefined;
}

/** Order of preference when Multisim has results for several analyses. */
const PREFERRED = ["TRAN", "FOUR", "AC", "OP"];

/**
 * Settings from a sheet's `SimState` attribute (the root sheet's speaks for
 * the design). `digital`: the design has XSPICE event-driven parts.
 */
export function simSettings(simState: string, o: { digital?: boolean } = {}): SimSettings {
  const analyses = child(parseSimState(simState), "SIMULATION_INFO", "ANALYSES")?.items ?? [];
  // Multisim has results for an analysis that wrote a results file (plotted
  // analyses), or that has an id (the operating point, shown as a table).
  const ran = analyses.filter((n) => n.type === "list" && ((num(child(n.items, "ANALYSIS_ID")?.value) ?? 0) > 0 || !!child(n.items, "RAWFILE_NAME")?.value));
  const chosen = PREFERRED.map((k) => ran.find((n) => n.key === k)).find((n) => n && directiveOf(n.key, n));
  // Options of the analysis that runs; else the operating point's (Multisim's defaults).
  let options = optionsOf(chosen ?? analyses.find((n) => n.key === "OP"));
  const analysis = chosen && directiveOf(chosen.key, chosen)?.join("\n");
  // A transient that starts from the operating point ("determine
  // automatically"): Multisim starts from zero when that fails, as it does
  // for a digital oscillator, whose analog/digital alternation never
  // settles. ngspice has no fallback; `noopalter` takes one alternation
  // instead, which changes only the t=0 point of a design that would settle
  // (its logic re-evaluates at the first time step).
  if (o.digital && analysis?.startsWith(".tran") && !/ uic$/.test(analysis.split("\n")[0]!)) options = options ? `${options} noopalter` : ".options noopalter";
  return {
    options,
    analysis,
    skipped: ran.filter((n) => n !== chosen).map((n) => n.key),
  };
}
