// Board design rules and net classes for the KiCad project file (C7).
//
// Ultiboard keeps board-wide defaults (BoardLayerSettings + Design-Rules)
// and per-net overrides (clearance, track width) on every UBNet. KiCad keeps
// the defaults in the Default net class plus `design_settings.rules`, and
// overrides as further net classes assigned by exact-name patterns.

import type { Board, DesignRules } from "../ir/types.ts";

const NM_PER_MM = 1_000_000;
const mm = (nm: number) => +(nm / NM_PER_MM).toFixed(6);

const netClass = (name: string, clearance: number, width: number, rules: DesignRules, priority: number) => ({
  bus_width: 12,
  clearance: mm(clearance),
  diff_pair_gap: 0.25,
  diff_pair_via_gap: 0.25,
  diff_pair_width: 0.2,
  line_style: 0,
  microvia_diameter: 0.3,
  microvia_drill: 0.1,
  name,
  pcb_color: "rgba(0, 0, 0, 0.000)",
  priority,
  schematic_color: "rgba(0, 0, 0, 0.000)",
  track_width: mm(width),
  via_diameter: mm(rules.via.diameter),
  via_drill: mm(rules.via.drill),
  wire_width: 6,
});

/** Name of the net class holding nets with this clearance and track width. */
export const netClassName = (clearance: number, width: number) => `EW clearance ${mm(clearance)} track ${mm(width)}`;

/**
 * The parts of a `.kicad_pro` the board's rules decide: `board.design_settings`
 * rules and `net_settings` (classes + patterns). Undefined when the board
 * has no rules (hand-built boards in tests).
 */
export function boardProjectSettings(board: Board): { rules: Record<string, number>; netSettings: Record<string, unknown> } | undefined {
  const r = board.rules;
  if (!r) return undefined;
  const classes = new Map<string, { clearance: number; width: number; nets: string[] }>();
  for (const n of board.nets) {
    const clearance = n.clearance ?? r.clearance.trace;
    const width = n.trackWidth ?? r.trackWidth;
    if (clearance === r.clearance.trace && width === r.trackWidth) continue;
    const name = netClassName(clearance, width);
    const c = classes.get(name) ?? { clearance, width, nets: [] };
    c.nets.push(n.name);
    classes.set(name, c);
  }
  const ordered = [...classes].sort((a, b) => a[1].clearance - b[1].clearance || a[1].width - b[1].width);
  return {
    rules: {
      min_track_width: mm(r.minTrackWidth),
      min_copper_edge_clearance: mm(r.edgeClearance),
      // Ultiboard has no separate hole clearance: its clearance applies to
      // every object (KiCad's own default, 0.25 mm, is not in the source).
      min_hole_clearance: mm(r.clearance.trace),
      // Nor minimum drill / via sizes: KiCad's defaults (0.3 mm, 0.5 mm)
      // would flag Ultiboard's own default via (0.299998 mm drill).
      min_through_hole_diameter: 0,
      min_via_diameter: 0,
    },
    netSettings: {
      classes: [netClass("Default", r.clearance.trace, r.trackWidth, r, 2147483647), ...ordered.map(([name, c], i) => netClass(name, c.clearance, c.width, r, i))],
      meta: { version: 4 },
      net_colors: null,
      netclass_assignments: null,
      netclass_patterns: ordered.flatMap(([name, c]) => c.nets.map((pattern) => ({ netclass: name, pattern }))),
    },
  };
}

/**
 * Custom rules for board-wide clearances KiCad's net classes can't hold:
 * Ultiboard sets clearance to pads and to vias separately from clearance to
 * traces. Undefined when they all agree (most boards).
 */
export function boardCustomRules(board: Board): string | undefined {
  const r = board.rules;
  if (!r) return undefined;
  const rules: string[] = [];
  const add = (what: "Pad" | "Via", nm: number) => {
    if (nm === r.clearance.trace) return;
    rules.push(
      [`(rule "EW clearance to ${what.toLowerCase()}s"`, `\t(condition "A.Type == '${what}' || B.Type == '${what}'")`, `\t(constraint clearance (min ${mm(nm)}mm)))`].join("\n"),
    );
  };
  add("Pad", r.clearance.pad);
  add("Via", r.clearance.via);
  return rules.length ? ["(version 1)", ...rules, ""].join("\n") : undefined;
}
