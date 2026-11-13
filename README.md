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

Needs Node 20+ (or [Bun](https://bun.sh)).

```bash
npx ew-conv path/to/Design.ms14 path/to/Design.ewprj        # writes ./out/
npx ew-conv -o converted/ path/to/project-folder/            # every design in a folder
npx ew-conv -o libs/ "path/to/Stocked Components.prj"        # an EW component database
```

As a library, `import { convertProject, convertDatabase, parsePcbXml, ... } from "ew-conv"`
gives the converters, the parsers into a format-neutral IR, and the KiCad emitters.

### From a checkout

```bash
bun install
bun run dev -o out/ path/to/Design.ms14   # same arguments as the CLI
bun test && bun run typecheck
bun run build                             # dist/ (what npm ships)
```

Releases are published to npm by CI (`.github/workflows/publish.yml`) when a
`v<version>` tag matching `package.json` is pushed.

Inputs can be the binary EW files or XML already decoded by `ewd`; the
design type comes from the file's contents, not its extension. A schematic
and a board with the same name in the same folder (`Main.ms14` +
`Main.ewprj`) become **one linked KiCad project**.

Output per project `<name>`:

- `<name>.kicad_pro`, with the board's design rules: Ultiboard's default
  clearance, track width and via as KiCad's Default net class, nets with
  their own clearance or width as further net classes, and the minimum
  track width / board-edge clearance (plus `<name>.kicad_dru` when a board
  sets separate clearances to pads or vias)
- `<name>.kicad_sch` (+ one file per sub-sheet / extra page) from the `.ms1x`
- `<name>.kicad_pcb` from the `.ewprj`
- `<name>.pretty/`: the board's footprints as a project library (one
  `.kicad_mod` per EW footprint, unrotated and top-side), registered in
  `fp-lib-table`
- `<name>.kicad_sym`: the schematic's symbols as a project library (one
  symbol per part, named after the part in the EW database, multi-section
  parts as multi-unit symbols), registered in `sym-lib-table`

When both halves are present they are linked the way KiCad expects:
footprints carry their symbol's sheet path, symbols name their footprint,
footprint values follow the schematic, and parts that exist only on the
board (mounting hardware, fiducials) are marked board-only.

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
names, buses (with bus entries; buses continued across pages), free text.
Shared supply pins of multi-section parts (an op-amp's V+/V- on every
section) stay connected the way Multisim wires them. One schematic unit maps to 10 mil so everything sits on a
KiCad grid.

An EW component database (a Multisim database project, `.prj` / `.usr`)
becomes KiCad libraries named after it:

- `<name>.pretty/`: every Ultiboard footprint stored in it
- `<name>.kicad_sym`: every component, drawn from its Multisim symbol
  (sections as units, pin numbers from its package, pin electrical types,
  reference prefix from its family), with its Footprint pointing into
  `<name>.pretty` when the database holds the package (otherwise the
  package name is kept as an `EW_Package` field)

both registered in the project's lib tables.
`plans/converter.md` tracks these.

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

`bun run scripts/parity.ts <output-folder>` checks converted projects that
have both a schematic and a board: the schematic's KiCad netlist against the
board's pad nets, compared as connectivity (net names aside), plus which
footprints are linked, board-only or orphaned.

`kicad-cli` is always run through `scripts/run-hidden.ps1`, which starts it
on a private Windows desktop so no KiCad window or warning dialog can appear
on screen; any dialog it raises is logged and closed. Set `KICAD_CLI` to
point at a different `kicad-cli.exe` (default: KiCad 10).
