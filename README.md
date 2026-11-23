# multisim2kicad

Convert NI Electronics Workbench designs to KiCad: Multisim schematics (`.ms10`–`.ms14`), Ultiboard boards (`.ewprj`), and component databases (`.prj`, `.usr`, `.prd`).

I wrote this because there didn't seem to be a working way to move NI-era Multisim and Ultiboard projects into KiCad. Container decoding is handled by [`electronics-workbench-decoder`](https://www.npmjs.com/package/electronics-workbench-decoder) (`ewd`); this tool turns the contents into linked KiCad projects, libraries, and SPICE simulation files.

## Quick start

Needs **Node 20+** (or [Bun](https://bun.sh)) to run, and **KiCad 10** to open schematics and symbol libraries. Schematics are written in KiCad 10's format, which KiCad 9 and older refuse to open; boards and footprints use KiCad 8's format and also open in KiCad 8 and 9.

```bash
npx multisim2kicad path/to/Design.ms14 path/to/Design.ewprj   # writes ./out/
npx multisim2kicad -o converted/ path/to/project-folder/       # every design directly in a folder
npx multisim2kicad -o libs/ "path/to/Stocked Components.prj"   # an EW component database
```

Flags: `-o, --out <dir>` (default `./out`), `-h, --help`, `-V, --version`, `--debug` (full stack traces).

Inputs can be binary EW files or XML already decoded by `ewd`; the design type comes from the file's contents, not its extension. A schematic and a board with the same base name in the same folder (`Main.ms14` + `Main.ewprj`) become one linked KiCad project so "Update PCB from Schematic" works.

### What it doesn't handle

- **Pre-Multisim-10 designs**: Multisim 2001–9 (`.msm`, `.ms7`–`.ms9`) and Electronics Workbench 5 (`.ewb`). Multisim 10 or later can open these and save them in a supported format.
- **Ultiboard 4/5 boards (`.ddf`)**: a different format from `.ewprj`. Use [KIUB](https://github.com/Snieffy/KIUB) instead.
- **Ulticap schematics (`.sch`)**: see KIUB's companion, KIUC.
- **KiCad 9 or older** for schematics (KiCad 10 format only).
- **3D models**: 3D layers come across as KiCad user layers, but no STEP/VRML models are linked to footprints.

## Current status

Across my 299 test designs (mostly mine, plus NI's sample circuits), every output loads in KiCad. All 4263 schematic nets match Multisim's netlist exactly, and 12455 of 12458 PCB net pins land on a pad. The other 3 have no pad in the original Ultiboard board either.

Because most of those files are my own, I'm looking for other people's projects to break it on. If a design of yours converts badly, please [report it](#reporting-a-bad-conversion). You don't need to share private files to file a useful report.

## Output files

Each converted project `<name>` produces:

- `<name>.kicad_pro`: board design rules. Ultiboard's default clearance, track width, and via become KiCad's Default net class; nets with their own clearance or width become additional net classes; plus the minimum track width / board-edge clearance (and `<name>.kicad_dru` when a board sets separate clearances to pads or vias).
- `<name>.kicad_sch` (plus one file per sub-sheet or extra page) from `.ms1x`.
- `<name>.kicad_pcb` from `.ewprj`.
- `<name>.pretty/`: project footprint library (one `.kicad_mod` per EW footprint, unrotated and top-side), registered in `fp-lib-table`.
- `<name>.kicad_sym`: project symbol library (one symbol per part, named after the part in the EW database, multi-section parts as multi-unit symbols), registered in `sym-lib-table`.
- `<name>.lib`: SPICE models from the design, when the schematic contains simulated parts.

When both a schematic and a board are present, they are linked the way KiCad expects: footprints carry their symbol's sheet path, symbols name their footprint, footprint values follow the schematic, and parts that exist only on the board (mounting hardware, fiducials) are marked board-only.

Some Ultiboard boards list connections the board can't carry: a net-list pin the placed footprint has no pad for, or a part that was never placed. They dangle in Ultiboard too. The converter doesn't invent copper; it prints a warning naming them:

```
  warning:    3 net-list pins have no pad on their footprint and cannot be connected: U7 (S4, S5, S6)
  warning:    12 net-list pins belong to 4 unplaced parts and cannot be connected: U3, U4, U5, U6
```

## What gets translated

### PCB (`.ewprj`)

- Board outline and full copper stack (inner layers from the lamination settings)
- Copper tracks, vias, and mounting holes
- Every pad shape (round, square, rectangle, rounded, custom shapes; SMD pads on the right side)
- Footprints preserving each part's rotation and side (top or bottom), with its silkscreen, fab, and courtyard drawings and its reference and value text as placed in Ultiboard
- Power planes and copper areas as KiCad zones (net, clearance, thermal, and island settings)
- Nets on pads, tracks, and vias
- Silkscreen, mask, fab, and courtyard graphics (including arcs), board text, rule areas, and 3D, mechanical, and custom EW layers as named KiCad user layers

### Schematic (`.ms10`–`.ms14`)

- Every page and hierarchical block as a KiCad sheet hierarchy
- Parts with their body graphics and Multisim's final reference designators (multi-section parts as KiCad units), orientation (rotation/mirror), and pins at the exact positions Multisim wires attach to
- Shared supply pins of multi-section parts (such as an op-amp's V+/V- on every section), kept connected the way Multisim wires them
- Wires, junctions, power and ground ports, global/local/hierarchical net connectors, user net names, buses (with bus entries and buses continued across pages), and free text
- One Multisim schematic unit maps to 10 mil so everything sits on a KiCad grid

When you open a converted schematic, KiCad's ERC reports many `endpoint_off_grid` warnings. That is expected: Multisim's grid is finer than KiCad's, and the connectivity is still correct.

### Simulation (ngspice)

Converted schematics run in KiCad's simulator (ngspice). The project's simulator compatibility is set to PSpice because Multisim's vendor models use PSpice syntax (`IF()`, `R ... TC a b`).

**Models, supplies, and settings**

- Each part's SPICE model from the design goes into `<name>.lib` next to the schematic. The symbol references it through KiCad's `Sim.*` fields, mapping pins to model nodes in Multisim's order.
- Resistors, capacitors, and inductors use KiCad's built-in models. Sources, diode models, and other one-off cases get a small wrapper subcircuit holding the lines Multisim would netlist.
- KiCad leaves power symbols out of simulation, whereas Multisim's VCC/VDD symbols are real sources. Each supply net gets a simulation-only source symbol (`SUP1`, ...; excluded from the BOM and board), parked to the right of the root sheet.
- Parts Multisim has no model for (most ICs and connectors) are marked "exclude from simulation". A board whose ICs lack models leaves those nets floating; Multisim's `rshunt` option (carried over) usually lets it simulate anyway, though a large digital board may still need models for its ICs.
- Simulation settings come across as a text directive on the root sheet: Multisim's SPICE options (its default `rshunt=1e12` for floating nets, plus any tolerances set in the design) and the analysis Multisim has results for (transient, else Fourier, else AC, else operating point), so KiCad's Run matches what Multisim ran. Fourier comes across as its transient plus a note with the fundamental; other analyses (noise, sweeps, ...) are listed in a comment.
- Circuit parameters become a `.param` directive on their sheet, and part values using them stay expressions.
- Expressions reading another part's current (`I(Vsensor1)`) or a net by name (`V(pri)`), as in Multisim's flat netlist, get a behavioural-source probe copying the value onto a `.global` node. Coupled inductors that are separate parts (`K1 L4 L5 0.9`) become a `K` line in a directive on the root sheet.
- Vendor models' capacitor `IC=` values seed the operating point (`.nodeset`), as PSpice uses them (PWM controller latches need this).

**Multisim, PSpice, and digital translations**

- Multisim-only constructs rewritten for ngspice: `.mergenodes`, `TABLE ... USELIM`, and the interactive potentiometer (fixed at its saved setting).
- PSpice forms ngspice lacks: `sdt()` (integral) becomes an XSPICE integrator; `E`/`G ... LAPLACE {in} {H(s)}` becomes an XSPICE `s_xfer` block (plus a delay line for an `e^(-sT)` factor; numeric coefficients only); subcircuit parameters named like functions (`max`, `min`) are renamed.
- Digital parts simulate with ngspice's XSPICE gates, with each digital pin getting the ideal analog/digital bridge from its Multisim interface model.
- Multisim's `d_chip` behavioural logic (most 74xx and 4000-series MSI parts: counters, decoders, comparators, registers, latches, multiplexers) is compiled into an XSPICE subcircuit: each table output becomes a `d_lut` truth table, and each state flag becomes a `d_dff` with its clocked and asynchronous rows. The 74LS161, 74LS74, 74LS85, 74LS138, 74LS47, 74150, 4511, and 40192 were checked against their datasheets in ngspice. Timing is simplified: each output gets its slowest listed delay, and setup/hold checks are dropped.
- Tri-state and bidirectional pins (bus buffers and transceivers: 74xx125, 240, 244, 245, 373, ...) work on shared buses: each output that can go high-Z gets an enable signal from the chip's tables driving its output switch.
- Schmitt-trigger inputs (74xx14 and friends) keep their hysteresis via an XSPICE `hyst` block ahead of the input bridge. Multisim's interactive digital constant becomes a fixed logic level at its saved state. Ideal digital outputs have a 1 mOhm series resistance so an output tied to a source or another output still solves.

**Simulation limits**

- Parts whose model needs something ngspice doesn't have are excluded with a warning: `chirp()` sources, `d_vhdl`, other Multisim-only code models, and PSpice `FREQ` response-table sources.
- Multisim's high-Z sensing (`dac_hiz`) has no ngspice equivalent.
- Unconnected digital inputs read low, as in XSPICE (some of NI's counter demos leave `~LOAD` open, so they load instead of counting).
- Designs driven by LabVIEW co-simulation get a warning; those inputs are undriven in KiCad.

Checked on NI's Multisim 13 sample circuits: none fail to parse, and 156 carry an analysis Multisim ran; 145 of those run to completion in KiCad's ngspice as converted. Of the other 11:

- 2 are meant to fail: NI's "Overcoming Simulation Challenges" demos, whose notes say to watch the convergence failure.
- 3 are LabVIEW co-simulations driven by a LabVIEW VI that isn't in the design.
- 1 saves a 5000-second transient at a 0.1 ms step.
- 5 are switching converters where ngspice's transient hits "timestep too small" and Multisim's solver does not.

192 of the 200 sample circuits solve their operating point (the rest are converters whose own analysis skips it, plus one co-simulation).

### Component databases (`.prj`, `.usr`, `.prd`)

An EW component database becomes KiCad libraries named after it: either a Multisim database project (`.prj` / `.usr`) or NI's master database `MSCOMP_S.PRD` installed under `C:\ProgramData\National Instruments\Circuit Design Suite\<version>\database\` (about 57,000 parts and 7,000 footprints; takes around two minutes). Convert NI's database for your own use only: it is NI's content, so don't redistribute the output.

- `<name>.pretty/`: every Ultiboard footprint stored in the database, registered in `fp-lib-table`.
- `<name>.kicad_sym`: every component drawn from its Multisim symbol (sections as units, pin numbers from its package, pin electrical types, reference prefix from its family; pins Multisim hides, such as a logic chip's GND/VCC, on an extra power unit), registered in `sym-lib-table`. Its `Footprint` points into `<name>.pretty` when the database holds the package; otherwise the package name is kept in an `EW_Package` field.
- `<name>.spice/<family>.lib`: SPICE models for the database's simulated parts, one file per family. Each symbol's `Sim.*` fields point into it through `${KIPRJMOD}` (this works when the libraries sit in a project folder; update the path if you install them globally). A multi-section part (such as a quad op-amp) is one subcircuit across all its units. Parts without a model, and the few whose template needs values Multisim only sets on a placed part, are excluded from simulation. Set the project's simulator compatibility to PSpice (Simulator > Settings).

## Reporting a bad conversion

Please [open an issue](https://github.com/cinderblock/multisim2kicad/issues/new?template=bad-conversion.yml). What helps most:

- Multisim/Ultiboard version and file type (`.ms14`, `.ewprj`, ...), KiCad version, and the output of `npx multisim2kicad --version`
- What went wrong: a screenshot of the EW original next to the KiCad result, or the relevant ERC/DRC lines
- The design file if you can share it. If the design is private, a stripped-down copy that still shows the problem is just as useful, as is XML decoded with [`ewd`](https://www.npmjs.com/package/electronics-workbench-decoder) with the sensitive parts deleted.
- If the command itself failed, run it again with `--debug` and include the output.

## Using as a library

```js
import { convertProject, convertDatabase, parsePcbXml, ... } from "multisim2kicad";
```

Exports the high-level converters, parsers into a format-neutral IR, and KiCad emitters.

## Development

From a checkout:

```bash
bun install
bun run dev -o out/ path/to/Design.ms14   # same arguments as the CLI
bun test && bun run typecheck
bun run build                             # builds dist/ (what npm ships)
```

Corpus and parity checks:

- `bun run corpus`: converts every design under `corpus/` (gitignored; put your own designs there), checks each output with `kicad-cli` (ERC/DRC and netlist export), and scores it against EW's own data (the schematic's KiCad netlist vs Multisim's netlist, and the share of PCB net pins that landed on a pad). Writes `out/corpus/report.md`.
- `bun run scripts/parity.ts <output-folder>`: checks converted projects that have both a schematic and a board. It compares the schematic's KiCad netlist against the board's pad nets as connectivity (net names aside) and lists linked, board-only, and orphaned footprints.
- `kicad-cli` is always run through `scripts/run-hidden.ps1`, which starts it on a private Windows desktop so no KiCad window or warning dialog appears on screen (any dialog is logged and closed). Set `KICAD_CLI` to point at a different `kicad-cli.exe` (default: KiCad 10).

Releases are published to npm by CI (`.github/workflows/publish.yml`) when a `v<version>` tag matching `package.json` is pushed. See [`plans/converter.md`](plans/converter.md) for the roadmap and format notes.
