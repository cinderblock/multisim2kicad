# ew-conv

Convert NI Electronics Workbench designs — **Multisim** schematics (`.ms14`,
`.ms13`, …) and **Ultiboard** PCBs (`.ewprj`) — to modern **KiCad**
(`.kicad_sch`, `.kicad_pcb`, `.kicad_pro`).

Reading the proprietary containers is done by
[`electronics-workbench-decoder`](https://www.npmjs.com/package/electronics-workbench-decoder)
(`ewd`); this tool turns what's in them into KiCad.

> Work in progress. See [`plans/converter.md`](plans/converter.md) for the
> roadmap, what is and isn't translated yet, and every format finding so far.

## Usage

Requires [bun](https://bun.sh).

```bash
bun install
bun run dev path/to/Design.ewprj path/to/Design.ms14        # writes ./out/
bun run dev -o converted/ path/to/Design.ms14                # choose output dir
```

Inputs can be the binary EW files or XML already decoded by `ewd`; the
design type comes from the file's contents, not its extension.

Output per input:

- `.ewprj` → `<name>.kicad_pcb`
- `.ms1x` → `<name>.kicad_sch` + a minimal `<name>.kicad_pro`

## What gets translated

PCB: board outline, the full copper stack (inner layers from the
lamination settings), copper tracks, every pad kind (round, square,
rectangle, rounded, custom shapes; SMD on the right side), vias, mounting
holes, footprints that keep each part's rotation and side (top or
bottom) with the part's own silkscreen/fab/courtyard drawings and its
reference and value text as placed in Ultiboard, power planes and copper areas as KiCad zones (net, clearance, thermal
and island settings), nets (pads, tracks and vias carry their nets),
silkscreen/mask/fab/courtyard graphics including arcs, board text, rule
areas, and 3D/mechanical/custom EW layers as named KiCad user layers.

Schematic: every page and hierarchical block as a KiCad sheet hierarchy,
parts with their real body graphics and Multisim's final reference
designators (multi-section parts as KiCad units), pins at the exact positions
Multisim wires attach to, orientation (rotation/mirror), wires, junctions,
power and ground ports, global/local/hierarchical net connectors, user net
names, free text. One schematic unit maps to 10 mil so everything sits on a
KiCad grid.

Not yet: buses, linked schematic/board projects, symbol/footprint
libraries. `plans/converter.md` tracks these.

## Checking results

```bash
bun run test        # unit + sample-design tests
bun run typecheck
bun run corpus      # convert a whole corpus and score it (see below)
```

`bun run corpus` converts every design under `corpus/` (gitignored — put your
own designs there), checks each output with `kicad-cli` (ERC/DRC, netlist
export), and scores it against EW's own data: the schematic's KiCad netlist
vs Multisim's netlist, and the share of PCB net pins that landed on a pad.
Report: `out/corpus/report.md`.

`kicad-cli` is always run through `scripts/run-hidden.ps1`, which starts it
on a private Windows desktop so no KiCad window or warning dialog can appear
on screen; any dialog it raises is logged and closed. Set `KICAD_CLI` to
point at a different `kicad-cli.exe` (default: KiCad 10).
