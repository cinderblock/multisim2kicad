# multisim2kicad

Convert NI Electronics Workbench designs — **Multisim** schematics (`.ms14`,
`.ms13`, …) and **Ultiboard** PCBs (`.ewprj`) — to modern **KiCad**
(`.kicad_sch`, `.kicad_pcb`, `.kicad_pro`).

Reading the proprietary containers is done by
[`electronics-workbench-decoder`](https://www.npmjs.com/package/electronics-workbench-decoder)
(`ewd`); this tool turns what's in them into KiCad.

> **Early release: testers wanted.** It converts real multi-sheet, multi-layer
> projects well, but so far it has been tested mostly on one designer's files.
> If a design of yours converts badly, please
> [report it](#reporting-a-bad-conversion). See
> [`plans/converter.md`](plans/converter.md) for the roadmap and every format
> finding so far.

## Usage

Needs Node 20+ (or [Bun](https://bun.sh)) to run, and **KiCad 10** to open the
results. Schematics and symbol libraries are written in KiCad 10's format,
which KiCad 9 and older refuse to open. Boards and footprints use KiCad 8's
format, so they also open in KiCad 8 and 9.

```bash
npx multisim2kicad path/to/Design.ms14 path/to/Design.ewprj        # writes ./out/
npx multisim2kicad -o converted/ path/to/project-folder/            # every design in a folder
npx multisim2kicad -o libs/ "path/to/Stocked Components.prj"        # an EW component database
```

As a library, `import { convertProject, convertDatabase, parsePcbXml, ... } from "multisim2kicad"`
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

Some Ultiboard boards list connections the board can't carry: a net-list
pin the placed footprint has no pad for, or a part that was never placed.
They dangle in Ultiboard too. The converter adds no pads; it prints a
warning naming them:

```
  warning:    3 net-list pins have no pad on their footprint and cannot be connected: U7 (S4, S5, S6)
  warning:    12 net-list pins belong to 4 unplaced parts and cannot be connected: U3, U4, U5, U6
```

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

Simulation: the converted schematic runs in KiCad's simulator (ngspice).
Each part's SPICE model from the design goes into `<design>.lib` next to
the schematic. The part points at it through KiCad's `Sim.*` fields, which
map its pins to the model's nodes in Multisim's order.

- Resistors, capacitors and inductors use KiCad's built-in models.
- Sources, diode models and other one-off cases get a small wrapper
  subcircuit holding exactly the lines Multisim would netlist.
- KiCad leaves power symbols out of simulation, but Multisim's VCC / VDD
  symbols are real sources. Each supply net therefore gets a
  simulation-only source symbol (`SUP1`, ...; not in the BOM, not on the
  board), parked to the right of the root sheet.
- Parts Multisim has no model for (most ICs and connectors) are marked
  "exclude from simulation".
- A few Multisim-only SPICE constructs are rewritten for ngspice:
  `.mergenodes`, `TABLE ... USELIM`, and the interactive potentiometer
  (fixed at its saved setting).
- PSpice forms ngspice lacks are translated: `sdt()` (integral) becomes an
  XSPICE integrator, `E`/`G ... LAPLACE {in} {H(s)}` an XSPICE `s_xfer`
  block (plus a delay line for an `e^(-sT)` factor; numeric coefficients
  only), and subcircuit parameters named like functions (`max`, `min`) are
  renamed. A `FREQ` response-table source has no exact equivalent: its part
  is excluded, with a warning.
- Digital parts simulate with ngspice's XSPICE gates. Each digital pin
  gets the ideal analog/digital bridge from its Multisim interface model.
- Multisim's `d_chip` behavioural logic (most 74xx and 4000-series MSI
  parts: counters, decoders, comparators, registers, latches, multiplexers)
  is compiled into an XSPICE subcircuit. Each table output becomes a
  `d_lut` truth table, and each state flag a `d_dff` with its clocked and
  asynchronous rows. The 74LS161, 74LS74, 74LS85, 74LS138, 74LS47, 74150,
  4511 and 40192 were checked against their datasheets in ngspice. Timing is
  simplified: each output gets its slowest listed delay, and setup / hold
  checks are dropped.
- Circuit parameters become a `.param` simulator directive on their sheet.
  Part values that use them stay expressions.
- A part's expression can read another part's current (`I(Vsensor1)`) or a
  net by name (`V(pri)`), as in Multisim's flat netlist. The part that owns
  the current or sits on the net gets a probe: a behavioural source copying
  the value onto a shared (`.global`) node, which the expression reads.
  Coupled inductors that are separate parts (`K1 L4 L5 0.9`) become a `K`
  line in a text directive on the root sheet.
- Tri-state and bidirectional pins (bus buffers and transceivers: 74xx125,
  240, 244, 245, 373, ...) work on shared buses. Each output that can go
  high-Z gets an enable signal from the chip's tables, and the enable drives
  the pin's output switch. Multisim's own high-Z sensing (`dac_hiz`) has no
  ngspice equivalent.
- Parts whose model needs something ngspice doesn't have are excluded,
  with a warning: `chirp()` sources, `d_vhdl`, other Multisim-only code
  models, PSpice `FREQ` tables.
- A digital input left unconnected reads low, as in XSPICE (some of NI's
  counter demos leave `~LOAD` open, so they load instead of counting).
- Schmitt-trigger inputs (74xx14 and friends) keep their hysteresis: an
  XSPICE `hyst` block ahead of the input bridge. Multisim's interactive
  digital constant is a fixed logic level at its saved state. Ideal digital
  outputs have a 1 mOhm series resistance, so an output tied to a source or
  to another output still solves.
- Vendor models' capacitor `IC=` values seed the operating point
  (`.nodeset`), as PSpice uses them; PWM controller latches need that.

- The design's simulation settings come along as a text directive on the
  root sheet: Multisim's SPICE options (its default `rshunt=1e12`, which
  lets designs with floating nets simulate, and any tolerances the designer
  set) and the analysis Multisim has results for (transient, else Fourier,
  else AC, else operating point), so KiCad's Run does what Multisim did. A
  Fourier analysis comes across as its transient plus a note with the
  fundamental. Other analyses it ran (noise, sweeps, ...) are listed in a
  comment.
- A design driven by LabVIEW co-simulation gets a warning: those inputs
  are undriven in KiCad.

Checked on NI's own Multisim 13 sample circuits: none fail to parse, and
156 carry an analysis Multisim ran; 145 of those run to completion in
KiCad's ngspice as converted. Of the other 11:
- 2 are meant to fail: NI's "Overcoming Simulation Challenges" demos, whose
  notes say to watch the convergence failure.
- 3 are LabVIEW co-simulations, driven by a LabVIEW VI that isn't in the
  design.
- 1 saves a 5000-second transient at a 0.1 ms step.
- 5 are switching converters on which ngspice's transient gives up
  ("timestep too small") where Multisim's solver does not.

192 of the 200 solve their operating point. The rest are converters whose
own analysis skips it, and one co-simulation.

The project's simulator compatibility is set to PSpice, because Multisim's
vendor models use PSpice syntax (`IF()`, `R ... TC a b`).

A board whose ICs have no model leaves those nets floating; Multisim's
`rshunt` option (carried over) usually lets it simulate anyway. A large
digital board may still need models for its ICs.

An EW component database becomes KiCad libraries named after it. That is
a Multisim database project (`.prj` / `.usr`), or NI's master database
`MSCOMP_S.PRD` that Multisim installs under
`C:\ProgramData\National Instruments\Circuit Design Suite\<version>\database\`
(about 57,000 parts and 7,000 footprints; around two minutes). Convert
NI's database for your own use only: it is NI's content, so don't
redistribute the output.

- `<name>.pretty/`: every Ultiboard footprint stored in it
- `<name>.kicad_sym`: every component, drawn from its Multisim symbol
  (sections as units, pin numbers from its package, pin electrical types,
  reference prefix from its family; pins Multisim hides, like a logic
  chip's GND / VCC, on an extra power unit), with its Footprint pointing into
  `<name>.pretty` when the database holds the package (otherwise the
  package name is kept as an `EW_Package` field)
- `<name>.spice/<family>.lib`: the SPICE models of the database's
  simulated parts, one file per family. Each symbol's `Sim.*` fields point
  into it through `${KIPRJMOD}`. That works when the libraries sit in the
  project folder; if you install them globally, fix the path. A part
  with several sections (a quad op-amp) is one subcircuit across all its
  units. Parts without a model, and the few whose template needs values
  Multisim only sets on a placed part, are excluded from simulation. Set
  the project's simulator compatibility to PSpice (Simulator > Settings).

The symbol and footprint libraries are registered in the project's lib
tables.

### Not supported (yet)

- **Designs older than Multisim 10**: Multisim 2001–9 (`.msm`, `.ms7`–`.ms9`)
  and Electronics Workbench 5 (`.ewb`). Multisim 10 or later can open these
  and save them in a supported format.
- **Ultimate-era Ultiboard boards (`.ddf`, Ultiboard 4/5)**: a different
  format from `.ewprj`. [KIUB](https://github.com/Snieffy/KIUB) converts
  those to KiCad.
- **Ulticap schematics (`.sch`)**: see KIUB's companion, KIUC.
- **3D models**: the 3D layers come across, but no STEP/VRML models are
  linked to footprints.
- **KiCad 9 or older** for schematics (see [Usage](#usage)).

When you open a converted schematic, KiCad's ERC reports many
`endpoint_off_grid` warnings. They are expected: Multisim's grid is finer
than KiCad's, and the connectivity is still correct.

`plans/converter.md` tracks all of these.

## Reporting a bad conversion

Please [open an issue](https://github.com/cinderblock/multisim2kicad/issues/new?template=bad-conversion.yml).
These help the most:

- the Multisim/Ultiboard version and file type (`.ms14`, `.ewprj`, ...),
  the KiCad version, and `npx multisim2kicad --version`
- what's wrong: a screenshot of the EW original next to the KiCad result,
  or the relevant ERC/DRC lines
- the design file itself, if you can share it. If you can't, a stripped-down
  copy that still shows the problem is just as good. You can also send XML
  decoded with [`ewd`](https://www.npmjs.com/package/electronics-workbench-decoder)
  with the sensitive parts deleted.

If the command itself failed, run it again with `--debug` and include the
output.

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
