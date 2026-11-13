# EW -> KiCad converter (`multisim2kicad`)

## Goal

A **full translator** from NI's old Electronics Workbench formats to modern
KiCad: point `multisim2kicad` at a Multisim `.ms14` + Ultiboard `.ewprj` design (the
binaries, not hand-decoded XML) and get a KiCad project (`.kicad_pro`,
hierarchical `.kicad_sch` sheets, `.kicad_pcb`, project-local symbol and
footprint libraries) that opens cleanly, whose schematic netlist matches the
EW netlist exactly, whose board carries every pad / track / via / pour on the
right net, and where schematic and board are linked so "Update PCB from
Schematic" is a no-op.

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\ew-conv` (Bun + TypeScript,
  Windows). Project renamed **multisim2kicad** (user, 2026-11-13): GitHub
  https://github.com/cinderblock/multisim2kicad, npm `multisim2kicad`. The
  local folder keeps the old name for now (renaming it under a running
  session breaks the session and its memory path).
- Decoder library: `..\ewd` = npm `electronics-workbench-decoder`
  (github.com/cinderblock/electronics-workbench-decoder). **Now a real
  dependency** (`^0.2.0`): `src/load.ts` uses `decodeBuffer` /
  `detectFormatByHeader` to read binaries in memory. XML inputs still work.
- KiCad 10.0.3 at `C:\Program Files\KiCad\10.0\bin\kicad-cli.exe` (KiCad 6.0
  also installed; ignore it).
- **kicad-cli must never touch the user's screen.** Always run it through
  `scripts/run-hidden.ps1` (private desktop; dialogs are logged + closed;
  timeout kill). Verified 2026-11-11: MessageBox probe + full 32-file corpus
  loop showed 0 KiCad windows and 0 foreground changes on the user desktop.
  Usage: `pwsh -NoProfile -File scripts/run-hidden.ps1 -TimeoutSec 120 -- <exe> <args...>`.
- **Real-world corpus:** `P:\Projects\Archive\Nook-git2\` (READ ONLY - never
  write there). Copied into gitignored `corpus/nook/` (41 files: 13 `.ewprj`,
  19 `.ms14`, 8 `.ewnet`, 1 `.mp14`; all Multisim/Ultiboard 14.2). Typical
  project folder = `X.ms14` + `X.ewprj` + `X.ewnet` (+ `.mp14` project file).
- **Corpus harness:** `bun run scripts/corpus.ts` -> converts everything to
  `out/corpus/`, runs ERC/DRC hidden, writes `out/corpus/report.{md,json}`.
  ~2.5 min for the whole corpus.

## Decisions already made (don't re-ask)

- **Name: `multisim2kicad`** (user, 2026-11-13). Follows the
  `<source>2kicad` convention (altium2kicad, eagle2kicad, easyeda2kicad);
  "Multisim" is the name users search for and covers Ultiboard too. Not
  "ewb" (that is EWB 5's `.ewb` format, which is not supported) and not
  "sch" (boards are half the job). Renamed before anything reached npm.

- **Library / converter split** (user, 2026-11-11): `ewd` reads and parses EW
  binary formats into useful objects; `multisim2kicad` does EW -> KiCad. If ewd needs
  richer parsed objects, that work is planned in ewd, keeping the boundary.
  Rule of thumb: *what the file says* (containers, string escapes, units,
  class layouts, the `.ewnet` grammar) belongs in ewd; *what it means in
  KiCad* belongs here.
- **multisim2kicad consumes ewd as a real dependency and takes binaries directly**
  (user, 2026-11-11). Done in `ed01de0`.
- **Verify headlessly only**, through `scripts/run-hidden.ps1`.
- **Read-only access to the archive corpus.**
- One-way conversion only. No round-trip / no KiCad -> EW.
- Bun + TypeScript. KiCad 10 is the verification target; emitter keeps
  writing the older `20240108`-era PCB format that KiCad 10 reads.
- Show the roadmap before starting large new phases (user, 2026-11-11).
- **Roadmap + order approved** (user, 2026-11-11): A4-A5 -> B1 -> C1-C2 ->
  D1-D3, then the rest.
- **ewd depth** (user, 2026-11-11): B1 + B2 now, B3 typed models grown
  gradually, moving parser code into ewd once proven here.
- **Schematic coordinates** (user, 2026-11-11: "convert to integer units in
  the intermediate state"): schematic IR uses **integer Multisim units**, not
  nm. The emitter maps **1 unit = 10 mil (0.254 mm)** and sets the project
  connection grid to 10 mil, so everything is exactly on-grid with no
  snapping (1.6% larger than Multisim's nominal 0.25 mm). Data: every pin and
  wire coordinate in the corpus is an integer unit (8064 pin-local coords,
  40852 wire ends, 0 fractional); only ~half are even, so a coarser unit
  would need snapping. 187/2868 symbol origins are fractional; check how they
  combine with rotation before relying on them.
- **Symbols/footprints** (user, 2026-11-11): extract per-design into
  project-local libs (E3). **Also support extracting parts from the EW
  database directly**, so Phase F is in scope, not optional.
- **ewd releases** (user, 2026-11-11): no need to ask; cut a release when new
  features land.
- **Corpus sources** (user, 2026-11-11): look for more `.ms*` / `.ewprj`
  across the machine and in the user's published GitHub repos (including
  older versions in git history). **Never commit or push design files found
  on the machine** (corpus stays local + gitignored).

## Roadmap to "full translator" (revised 2026-11-11)

Grounded in the first full corpus run (2026-11-11). All 32 outputs *load*
in KiCad 10, but that hides large gaps, because Design1 (the only sample
until now) is a toy:

- **PCB pads mostly missing.** Only round/square/rounded-square pads are
  parsed. LED-Delay: 9 components, 0 pads (29 net pins). HV-TPI-ISP: 16
  components, 0 pads. Main: 143 components, 64 pads (565 net pins).
  `LayoutPadRectangle` (1665 in corpus), `LayoutPadRoundedRectangle` (840),
  `LayoutPadCustom` (115) are dropped. Result: 1500 `track_dangling`.
- **4-layer boards** (Pressure Servo, Main): inner copper not handled.
- **Copper pours** `UBPowerPlane` in 7/13 boards: not handled.
- Vias: 1873 drill objects in corpus; only standalone ones are handled, and
  none is emitted as a via yet.
- `UBArc` / `UBPie` / `UBPolygon` / `UBEllipse` / `UBRectangle` graphics,
  `LayoutGroup`, `LayoutRuleArea`: not handled. Main has 27k polylines
  (probably stroked text and pour outlines). Check before mapping them.
- **Schematics are hierarchical.** 13/19 have >1 sheet (Main: 10 sheets,
  10 `CHierBlock`). The parser reads `SheetContainer[0]` only.
- **Power/ground/off-page connectors** (`CVirtualConnector`, 626) aren't
  emitted, so most nets are broken: `pin_not_connected` x1423,
  `unconnected_wire_endpoint` x1446.
- Symbols have no rotation/flip, so pins land wrong.
- `endpoint_off_grid` x2095: Multisim's 0.25 mm grid vs KiCad's 50 mil.

### Phase A - Foundation (mostly DONE 2026-11-11)

- [x] A1. ewd as dependency, binary input (`ed01de0`).
- [x] A2. Hidden kicad-cli runner (`eef0b18`).
- [x] A3. Corpus copy + harness (`a8b80be`).
- [x] A4. **Fidelity scorecard** (`9d7464b`) in the harness, beyond "loads": PCB pads
      resolved / net pins; tracks touching a same-net copper item; schematic
      netlist (`kicad-cli sch export netlist`) vs `.ewnet` / `Ci*`
      netlist (exact diff per net); counts of dropped EW classes. This is the
      definition of "done" for phases C-E.
- [x] A5. `bun test` with golden checks (`11b3c7f`) on Design1 + a couple of corpus files
      (scorecard thresholds, not byte snapshots; UUIDs are random).

### Phase B - ewd: richer parsed objects (work in the ewd repo)

- [x] B1. **`.ewnet` reader** in ewd, released as ewd 0.3.0 (ewd `66ec466`, `169f5c1`): UTF-16LE S-expression -> typed
  `{ toolInfo, nets[{name, rules}], components[{refdes, device, value,
  package, pins[{number, net, pintype, label}]}], layers }`. Small, pure
  format knowledge. It gives multisim2kicad an authoritative netlist, pin electrical
  types, and package names.
- [x] B2. **EW XML document model** in ewd (ewd `67524e0`): `parseEwXml()`
  -> `{ declaration, root: EwElement, application }`, `ewXmlText()` back.
  Purpose-built, no dependencies: byte-identical round-trip on all 592
  corpus designs (~2 GB XML), ~4x faster than fast-xml-parser. `EwElement`
  has `cls`, `str` (`&ASC`/`&UNI` decoding), `num`, `bigint`, `bool`,
  `child`, `childrenNamed`, `at(...)`, `find`, `findAll`, `findByClass`,
  `closest`, `descendants()`. Also `decodeEwString` / `encodeEwString` and
  nm unit helpers. multisim2kicad's parsers all take `XmlInput` (text or a parsed
  `EwDocument`, via `src/parse/doc.ts`), the schematic path parses once
  instead of three times, and fast-xml-parser is gone (the KiCad netlist is
  now read as `kicadsexpr` through `src/util/sexpr.ts`).
- B3. **Typed design models** in ewd, grown incrementally as multisim2kicad's
  parsers prove out: `UltiboardDesign` (layers, components + pads in
  footprint-local coords, tracks, vias, planes, nets, rules) and
  `MultisimDesign` (sheets/hierarchy, symbols, wires, connectors, labels,
  `Ci*` netlist). EW-native units and names, no KiCad-isms. As each lands,
  multisim2kicad's `src/parse/*` shrinks to a mapper `EW model -> IR`.
- Publishing: ewd 0.3.0 via its existing trusted-publishing CI. Needs an
  explicit OK first. Until then multisim2kicad links the local checkout
  (`file:../ewd`) for development.

### Phase C - PCB fidelity on real boards

- [x] C1 + C2 (`198a099`): pad kinds, SMD/custom pads, vias. Remaining from C1:
  padstacks (THT pins with several LamPads use the top one), per-pad
  mask/paste flags (`Solder-Paste-Mask` / `Solder-Resist-Mask` semantics
  unverified).
- C1. All pad kinds: rectangle, rounded rectangle, custom (polygon ->
  KiCad custom pad), SMD vs THT, per-pad layers (mask/paste), rotation.
- C2. Vias (non-pin plated drills) + via sizes. Blind/buried if present.
- C3. Multilayer stacks: inner layers, correct stackup order.
  **Design (2026-11-11, from a corpus survey of 208 boards):**
  `BoardLayerSettings@LayerLaminationPairQuantity` = N -> 2N copper layers:
  EW 0 = F.Cu, EW 1..2N-2 = In1..In(2N-2).Cu, EW 63 = B.Cu. Every 4-layer
  corpus board uses EW 1 and 2. Single laminates (`Top/BottomSingle
  LaminateQuantity`) are 0 everywhere; a few 2-layer boards have stray
  objects on EW 1 (outside the stack): dropped with a warning. THT pads
  and vias span all copper layers. `BoardThickness` -> `(general
  (thickness))`.
  Non-copper map: 64 RuleAreaLayer (rule areas), 65 outline -> Edge.Cuts,
  66/67 silk, 68/69 Top3D/Bot3D -> named user layers, 70/71 paste, 72/73
  mask, 74/75 glue -> Adhes, 76/77 assembly -> Fab, 78 ratsnest / 79 DRC /
  80 force vectors dropped, 81 comment -> Cmts.User, 82-91 mechanical 1-10
  and 93+ custom (per-design names such as `01`, `PadEdit`; Althea Main
  has 13k polylines each on `01`/`02`) -> KiCad user layers named after the
  EW layer, allocated in order of use; 92 courtyard -> CrtYd.
- C4. Copper pours `UBPowerPlane` -> `(zone ...)` with net, priority,
  clearance, thermal settings. Validate with `pcb drc --refill-zones`.
  **Findings:** planes store only the outline (`Object > Point`s, already
  arc-flattened) plus `NetName`, `LineThickness`, `ReliefSpokeWidth`,
  `ThermalReliefStyle`, `RemoveSmallIslands` / `RemoveIslandSize`,
  `RemoveNotEdgeConnectedIslands`, `MayVoid`, and `UBExtension@ClearToArea`
  etc. No fill is stored, so KiCad zones (unfilled; DRC refills) are an
  exact match. Board-level `UBPolygon` / `UBRectangle` /
  `UBRoundedRectangle` / `UBEllipse` / `UBPie` on copper carry the same
  attributes: they are copper areas -> zones too, with higher priority
  than planes.
- C5. Remaining graphics: arcs, pies, polygons, text (as real `gr_text` /
  `fp_text` where EW stores text, not stroked polylines), rule areas ->
  keepout zones.
  **Findings:** `Arc` (CDrawArc, 197 boards, 18k) = [start, end, centre]
  points + `Radius`, not emitted yet. Board text is `UBAttribute
  Tag=TEXT` (`Value`, `TXTFormat@RefPointX/Y, Angle, Mirror,
  HorizontalSize, VerticalSize, Alignment`), mostly on copper. Rule areas
  (`LayoutRuleArea`, layer 511): `RuleAreaType` 0 (529) / 1 (10),
  `ActiveLayersZero..Seven` 64-bit masks, `NetGroups@All` + `CompGroup
  @Group` net lists. Semantics of type and net groups not confirmed;
  plan: unambiguous keep-outs -> KiCad rule areas, the rest as named
  outlines on a user layer, logged.
- C6. Real footprints: pads/graphics in footprint-local coords with the
  component's rotation/side, so footprints move and flip as a unit.
  Footprint name from the EW package. REF/VALUE fields.
- C7. Design rules / net classes (from `.ewnet` + Ultiboard rules) ->
  `.kicad_pro`.
- **Exit:** every EW net pin resolves to a pad; DRC unconnected count equals
  EW's own ratsnest; `track_dangling` ~0 on all 13 boards.

### Phase D - Schematic fidelity

- D1. All sheets + hierarchy: `CHierBlock` -> hierarchical sheets (one
  `.kicad_sch` file per unique sheet), `CIITHierConnector` -> hierarchical
  labels + sheet pins. Macro components / subcircuits (`CIITMacroComponent`).
- D2. Symbol rotation/flip, pin orientation (from the pin-stub geometry),
  pin electrical types.
- D3. Connectivity objects: `CVirtualConnector` (power/ground/on-page/
  off-page) -> power symbols / global labels; net-name labels
  (`CODNodeTextComp` tied via `CIITLinkComp`) -> local labels; junctions;
  buses (2 files) -> buses + bus entries.
- D4. Real symbol graphics: body lines/rects/ellipses/arcs/polygons inside
  each symbol -> `lib_symbol` drawings. Deduplicate identical symbols into one
  library entry per part; multi-unit parts.
- D5. Free text, graphics, title block.
- [x] D6 (done with D1-D3: `MM_PER_UNIT = 0.254`, integer IR, 10 mil
  `connection_grid_size` in `.kicad_pro`). Integer-unit schematic IR + 10 mil emit scale + 10 mil connection grid
  in `.kicad_pro` (decided, see Decisions).
- **Exit:** for every corpus schematic, the KiCad-exported netlist equals the
  EW netlist (same nets, same pins); ERC is clean apart from documented
  source-faithful categories.

### Phase E - Project assembly

- E1. Emit a KiCad project directory: `.kicad_pro`, root + child sheets,
  `.kicad_pcb`, all sharing the base name.
- E2. Link schematic <-> board: symbol `Footprint` fields, matching refdes,
  and the symbol path/UUID on each PCB footprint, so "Update PCB from
  Schematic" changes nothing.
- E3. Project-local libraries extracted from the design itself:
  `<proj>.kicad_sym`, `<proj>.pretty/*.kicad_mod`, `sym-lib-table`,
  `fp-lib-table`.
- E4. Folder mode: `multisim2kicad <dir>` pairs `X.ms14` / `X.ewprj` / `X.ewnet`
  automatically and handles multi-design folders (Althea: Main / Heater /
  Buttons + `.mp14`).

### Phase F - Library translation from the EW master database (in scope)

Translate EW's own part libraries (`\\uberfall.tsl\Electronics Workbench Database\`
`.prt` Jet DBs, readable via ewd's mdb decode) into KiCad libraries.
Designs embed enough geometry that Phases C-E don't need this, but the user
wants it supported too (2026-11-11): pull a part's symbol/footprint straight
from the EW database. The DB share is mounted as `W:\` (=
`\uberfall.tsl\Electronics Workbench Database`).

**Findings (2026-11-13, read-only look at the share):** `W:\` holds no
`.prt` files any more; it holds the user's Multisim **database projects**
`Stocked Electronic Components v14.0 / v14.1 / v14.2*.prj` (Jet 4, header
"Standard Jet DB", 3-9 MB; v14.2 is the newest, 2022-04-04) plus unrelated
Altium files (`TWILL.PcbLib/SchLib/LibPkg`, `History/`). ewd's
`decodeMdbBuffer` reads every table. In v14.2:

- `SYS_COMPONENT` (241 parts: `Component_ID`, `Family_ID`,
  `Component_Name`, `Manufacturer`, `Description`, `Pin_Number`, ...),
  `SYS_CONFIGURATION` (72 families), `SYS_CONFIGURATION_GROUPS` (20 groups).
- `SYS_SYMBOL_PICTURE` (413: `Symbol_ID`, `Pin_Number`, `Layer_Number`,
  `Size`, `Image`). `Image` = 5-byte prefix + EW's usual compressed stream;
  wrapping bytes [5..] in a `CompressedElectronicsWorkbenchXML` header
  (total = `Size`) decodes with ewd's `decodeBuffer` to an XML
  `<DrDoc Type="BaseSymbolDocument">` with `LayerInfo`, `BoundaryBox`,
  `Pin` (+ `Line`, `PinNameText`, `PinNumberText`, `WireConnectionPoint`),
  `Rectangle`, ... A different schema from symbols placed in a `.ms14`.
- `SYS_MAPPING_COMP_SYMBOL` (406: component -> symbol per section, ANSI /
  DIN, `Pinout_*`, `Sec_Name`), `SYS_MAPPING_COMP_PACKAGE` (319: component
  -> package + pinout).
- `SYS_PCB_PACKAGE` (515: `Package_ID`, `Package_Type` = footprint name,
  `Pin_Number`, `Std_Pinout`, `PCB_Technology` TH/SMT).
- `tObjects` (446: `strObjectName` = footprint name, `lBlobID`,
  `lObjectTreeID`, `lObjectTypeID`) / `tObjectTree` (19 folders: Hardware,
  Cameron's, Connectors, ...) / `tObjectTypes` (UBLIB = PCB part, PADLIB =
  custom pad shape, CADDESIGN, NETBRIDGELIB) / `tBlobs` (1067). A blob is a
  complete `CompressedElectronicsWorkbenchXML` file: `<CommonLibraryObject>`
  holding a `UBComponent` with the same structure as in `.ewprj`
  (`SMT-Pin` / `Pad` / `LayoutPadRoundedRectangle`, silk `Rectangle`s,
  `TXTFormat`, `RefPoint`).

**Design:** `multisim2kicad db <file.prj> [-o dir]` writes `<db>.kicad_sym` +
`<db>.pretty/` (+ lib tables). Footprints: decode each UBLIB blob, run it
through the existing UBComponent parser and footprint-library emitter.
Symbols: new parser for `BaseSymbolDocument` -> `SchematicSymbol` IR, then
the existing `SymbolLibrary`; multi-section parts from
`SYS_MAPPING_COMP_SYMBOL` as units; each symbol's `Footprint` property from
`SYS_MAPPING_COMP_PACKAGE`. The symbol-picture unwrap belongs in ewd
(release allowed). Order: footprints, symbols, mapping. Read the share
only; work from a copy in the scratchpad.

### Phase G - Ship

CLI UX + README, `bun test` in CI, decide whether multisim2kicad is published to
npm. Altium export (old Phase 5, below) stays a future/private item.

**Decided (user, 2026-11-13): publish the project, keep the corpus
private.** Public repo https://github.com/cinderblock/multisim2kicad (created
2026-11-13, `e91ad11`); CI `test.yml` (Ubuntu + Windows x Node 20 + 24:
typecheck, test, build, Node run of the CLI on the samples) is green.
npm: `publish.yml` publishes on `v*` tags via trusted publishing with
provenance; `scripts/guard-publish.ts` refuses local publishes except the
`0.0.0` name claim. Remaining: claim `multisim2kicad` on npm with the `0.0.0`
placeholder (needs the user's npm auth; placeholder package prepared in
the session scratchpad), the user configures the trusted publisher, then
bump to `0.1.0` and push the tag.

What is public: code, plans, and `samples/Design1*` / `Temp` (the user's
own toy designs, committed by the user at scaffold time; they contain
the path `C:\Users\camer\Documents\National Instruments\...`). The plans
name corpus projects (Althea, Nook, ...) and the `\\uberfall.tsl` share
but contain no design data. `corpus/` and `out/` stay gitignored.

### Proposed order

A4-A5 -> B1 -> C1-C2 -> D1-D3 -> B2 -> C3-C6 -> D4-D5 -> E -> B3 cleanup -> C7/D6 -> G.
The goal is to fix the gaps that break connectivity first (pads, vias,
hierarchy, connectors), since those are what make an output useless today.

## EW XML facts (from sample inspection)

- Root tag: `<ElectronicsWorkbench Schema="67">` for Ultiboard,
  `<MSMElectronicsWorkbench Schema="67">` for Multisim.
- `<creator application="ultiboard"|"multisim" ...>` disambiguates.
- Coordinate unit: **nanometers.** e.g. `WorkAreaRight="30000000"` = 30 mm,
  `12700` = 12.7 um = 0.5 mil grid step.
- Top-level sheet path:
  `Project > UniqueSheets > SheetInfos > SheetContainer > Sheet > Variable > DesignSheet`
  where `DesignSheet Class` is `CLayoutSubSheet` (PCB) or `CSCH_CAPSubSheet`
  (schematic).
- Layers (Ultiboard) enumerated in `CLayoutLayerDefinition > LayerInfo`,
  with `Number` + `Name` ("Top", "Inner1"..."Bottom", "RefDes", etc.).
  Object `Layer=` attrs reference those numbers; values >=512 are special
  internal layers.
- Strings are prefixed `&amp;ASC` in the raw XML, which decodes to `&ASC`.
  This is NI's internal "ASCII string" type marker. Strip it when reading
  human-readable names.
- Geometry primitives: `CDrawRectangle`, `CDrawPoint`, etc. Class names are
  leaked from NI's internal MFC-style C++ hierarchy.

## KiCad output facts

- `.kicad_pcb` and `.kicad_sch` are S-expression text. Format documented at
  <https://dev-docs.kicad.org/en/file-formats/>.
- Units are millimeters with up to 6 decimal places. Internal precision is
  1 nm == 1e-6 mm. Direct unit match to EW (divide nm by 1_000_000).
- Every persistent object needs a UUID v4. Generate fresh ones; don't try
  to reuse EW `ObjectID` integers.

## Findings / gotchas

- **EW XML dialect** (surveyed over all 592 corpus designs, 2026-11-11):
  only elements and attributes; no text content, CDATA, comments or DTD;
  entities `&amp; &quot; &gt; &lt; &apos;` only; every file starts
  `<?xml version="1.0" encoding="ASCII"?>`. Attribute values hold raw CR/LF
  (318k occurrences) and, in 45 files, NUL/0x01 bytes (RTF/base64 blobs
  in `.ms13` samples). EW writes one element per line, `/>` for empty
  elements. ewd's `parseEwXml` relies on exactly this. (multisim2kicad used
  fast-xml-parser until B2; it groups same-named children per parent, so
  its traversal order was not document order.)
- **Refactor guard:** `scripts/ir-hashes.ts` hashes canonical parser output
  (PCB IR, schematic IR, drawing-graph netlist, Ci netlist) per corpus
  design; `--compare <baseline.json>` lists any design whose output changed.
  Schematic net ids are now the smallest member id (`c39b60a`), so they no
  longer depend on traversal order.
- Coordinate sanity check: `Temp.ewprj` reports `workArea 160.0 x 100.0 mm`,
  consistent with a typical Eurocard-ish PCB. Confirms nm-as-unit assumption.
- `DesignSheet @DocType` values seen so far: `LAYOUTDESIGN` (Ultiboard).
- The XML has TWO layer-definition blocks. The authoritative one is
  `CLayoutLayerDefinition > LayerInfo` (94 entries in both Temp and Design1).
  A second `CLayerDefinition > LayerInfo` block appears later in the file
  with a duplicate "layer 0" called `Layer1` - this is a view-state /
  presentation block, NOT the layer stack. Parse the LayoutLayerDefinition
  by name to avoid picking it up.
- Ultiboard layer state values seen: `0` (disabled), `1` (active/visible),
  `2` (active+something), `3` (Bottom layer always 3 - probably a flag
  for "is bottom of stack"), `4` (paste/mask/glue). Treat anything != 0
  as "in use" until we have a reason to distinguish further.
- The 22 active layers in both samples (Temp and Design1) are identical:
  Top (0), Bottom (63), RuleAreaLayer (64), Board Outline (65),
  Silkscreen Top/Bot (66/67), 3D Top/Bot (68/69), Solder paste/mask/Glue
  mask Top+Bot (70-75), Ratsnest (78), DRC (79), Comment (81),
  Mechanical Layer 1-4 (82-85). This is Ultiboard's default 2-layer stack.
- Component `Rotation` is in millionths of a degree
  (`Rotation=90000000` => 90 deg). Divide by 1_000_000 for KiCad's
  degrees-as-float.
- Trace `LineThickness` is in nm. Design1's traces are 1.524 mm
  (60 mil) wide - generous for a Pi hat.
- Nets in Design1 are named "1", "2", "3" (Ultiboard's default numeric
  naming when no schematic-side names exist). Preserve as-is.
- `CLayoutNet @Routing` is `18446744073709551615` (uint64 max) - looks
  like a layer-bitmask meaning "all layers permitted." TBD if any sample
  ever restricts it.
- **Net pins are nested.** `UbNetList > UBNet > Pins > UBNetPin`, NOT
  `UBNet > UBNetPin`. `UBNet` also has a `List > NetAttribute` block
  (LENGTH, BUSGROUP). `UBNetPin @Refdes`/`@Pin` reference the component
  refdes + the pad's `NUMBER` attribute (pins can be named, e.g. `POEA+`,
  not just numeric). Pad `NUMBER` and net `Pin` match exactly after `&ASC`
  strip, so resolution is a direct string-key lookup.
- **Standalone drills** are `LayoutDrillObject Stand-Alone="1"` (pin drills
  are `Stand-Alone="0"`, nested in a `Through-Board-Pin`). Position in
  `Object > Point`, size in `@Drill-Radius` (nm radius), `@Plated` 0/1.
  Design1's 4 standalone drills are non-plated 2.75 mm = mounting holes;
  emitted as a `MountingHole` footprint with one `np_thru_hole` pad
  (size == drill, no copper). Plated standalone drills would emit as
  `(via)` with a 0.25 mm default ring (no sample yet).
- **Ellipse geometry**: `CDrawEllipse` first two `Point`s are opposite ends
  of a diameter. center = midpoint, radius = |p0-p1|/2. The 8 in Design1
  are on layers 72/73 (F/B.Mask) — mask rings around the mounting holes.
- **KiCad 10 is installed** (2026-05-29) at `C:\Program Files\KiCad\10.0\bin\kicad-cli.exe`.
  Validation pipeline: `kicad-cli pcb export svg --layers <set> --output X.svg X.kicad_pcb`
  proves a full parse + render; `kicad-cli pcb drc --output X.drc.json --format json X.kicad_pcb`
  surfaces connectivity / clearance issues. KiCad 10 reads our `(version 20240108)`
  output without complaint.
- **KiCad 10 schematic load gotchas** (cost us a chunk-2 bisect):
  - `lib_symbol` requires `(duplicate_pin_numbers_are_jumpers no)` and
    `(embedded_fonts no)` — the latter is KiCad-9/10 era and not optional.
  - The nested `(symbol "<inner>_1_1" ...)` body must use the **local name
    only** — no `library:` prefix. `"ew:U2_0_1"` fails to load; `"U2_1_1"` is
    accepted.
  - `(hide)` as a bareword inside `(effects ...)` is the KiCad-6/7 spelling
    and is rejected in KiCad 10. Use property-level `(hide yes)` instead.
  - Each instance needs an `(instances (project "..." (path "/" ...)))` block
    or the schematic refuses to load.
  - Multisim values may use the `&UNI<text + _uc<n><4hex>... escapes>` form
    (e.g. `&UNI0.1_uc100b5F\n4V` -> `0.1µF\n4V`). The literal newline must
    be escaped (`\n`) in the emitted S-expr or KiCad parses the value as
    truncated and rejects the file. See `decodeStr` in `parse/sch.ts`.
- **(2026-11-11) Corpus facts.** Real Ultiboard element names differ from
  Design1-era notes: `UBTrack`, `UBComponent`, `LayoutPadRound`,
  `LayoutPadRectangle`, `LayoutPadRoundedRectangle`, `LayoutPadCustom`,
  `LayoutDrillObject`, `UBPowerPlane`, `UBArc`, `UBPie`, `UBPolygon`,
  `UBEllipse`, `UBRectangle`, `UBRoundedRectangle`, `LayoutGroup`,
  `LayoutRuleArea`, `UBNet`/`UBNetPin`. Get a full histogram with a tag-regex
  scan over decoded XML.
- **`.ewnet`** = UTF-16LE (BOM `FF FE`) S-expression netlist that Multisim
  writes for Ultiboard forward-annotation. Sections: `(ToolInfo ...)`,
  `(nets (net "NAME" (trackwidth ..) (clearance_to_* ..) (net_GUID ..)))`,
  `(components (instance "<package>" "<refdes>" (device ..) (value ..)
  (package_type ..) (placed_section "" (pin "1" (net "X") (pintype "BIDIR")
  (label "P1") ...))))`, `(layers ...)`. Units declared `(units mil)`.
- ewd-decoded XML is byte-identical to the old `samples/*.xml` copies, so
  binary input changes nothing downstream.
- **Earlier memory claim was wrong:** there is no ewdb/SQLite extraction in
  the ewd repo (no such commits on any branch as of 2026-11-11). ewd *does*
  decode `.prj`/`.usr` Jet databases (`decodeMdbBuffer`).
- kicad-cli ERC JSON: violations under `sheets[].violations[]`; DRC JSON:
  `violations[]` + `unconnected_items[]`.
- Running kicad-cli on the corpus raised **no** dialogs (none captured on the
  private desktop), but sibling threads saw wx popups from `pcb import`, so
  always use the runner anyway.
- `run-hidden.ps1` must not have a `param()` block: the wrapped command's own
  flags (e.g. a child `-Command`) and `--` get bound as the script's params
  ("parameter name '' is ambiguous"). It parses `$args` by hand.

- **(2026-11-11) Scorecard reference netlists.** Multisim's own netlist is
  in `Ci*` objects: `CiComponent` (refdes = `LocalName`), `CiPort` (pin
  number CSV at `Attributes > Item > CiaCollString[1].strings[6]`),
  `CiNode` (net = `LocalName`, members in `Ports > Item@CiID`). Component
  kinds: virtual connectors/net labels have a single attribute string
  (`"91"`), ground/supplies have family `POWER_SOURCES`, real parts have the
  full manufacturer/family record. Hierarchy: one `CiCircuit` per unique
  sheet; `CiInstComponent` (`SC1`...) instantiates it; flattened refdes are
  re-numbered per instance (child `Q1,Q2` -> `Q1..Q6`), so flattening needs the
  instance refdes map (D1).
- **`.ewnet` is a snapshot.** Compared with the paired `.ewprj` net table
  (case-folded, Ultiboard upper-cases names) it matches exactly on 3 boards;
  others drifted (board edited after the last forward annotation; Althea
  Main's `.ewnet` lists 37 parts vs 126 on the board). Use it as a reference
  only when nothing better exists.
- **Ultiboard object facts (2026-11-11):**
  - Pins: `Through-Board-Pin` (`LamPad` per layer set, `Lamination` 64-bit
    mask, bit 0 = Top, bit 63 = Bottom), `SMT-Pin` (`Pad`), `NetBridge-Pin`
    (net ties, `CLayoutNetBridge` components).
  - Pad elements `LayoutPad{Round,Square,RoundedSquare,Rectangle,
    RoundedRectangle,Custom}` carry `CenterX/Y`, `Rotation`, `HalfWidth`,
    `HalfHeight`, `Radius`. Coordinates are absolute (boards are often
    centred on the origin).
  - **Rotation is CCW as seen on screen, same as KiCad.** Proven two ways:
    IC pad rows (pad long axis perpendicular to the row) fit +theta for 3452
    pads vs 512 for -theta; and a KiCad SVG export of `(at 0 0 30)` shows the
    pad turned 30 deg CCW on screen. The old emitter negated it (wrong).
  - **Component placement (C6 survey, 2026-11-13, every corpus board):**
    `UBComponent@Rotation` (millionths of a degree) and `@Bottom`; pads and
    drawings are stored already placed (absolute). Instances of one
    footprint de-rotate to identical local pads with top = origin +
    R(rot) * local (4475 instance pairs agree, 21 same-name parts differ).
    Bottom = origin + R(-rot) * mirrorX(local) (all ~1400 top/bottom
    pairs; a few symmetric parts also fit other conventions). Bottom parts
    carry `Mirrored=1`. KiCad stores a flipped footprint as local Y-mirror
    at orientation phi, so EW bottom parts become phi = 180 - rot.
  - KiCad's file stores pad and text angles **absolute** (footprint
    rotation included), drawings in footprint-local coordinates (checked on
    KiCad 10's bundled demo boards).
  - Component drawings: silk 66/67, fab 76/77, 3D outline 68/69, paste,
    mask; **courtyard is layer 92 on both sides** (bottom parts get
    B.CrtYd). Attributes (`CDrawAttribute`): `Visibility` 0 = shown,
    2 = hidden; hidden ones carry a collapsed (single point) text box far
    from the part, so use `TXTFormat@RefPointX/Y` for them. Text `Angle`
    is millionths of a degree (REFDES of a part at 90 deg has 90000000).
  - Vias: `RegularVia[CLayoutViaStandard]` = point + plated
    `LayoutDrillObject` + round `Pad`; `Lamination-Active` all-ones or
    Top|Bottom in the corpus (no blind/buried).
  - `ObjectID` is not unique (segments of one polyline track share it,
    copies of a footprint share it, some are 0). Don't dedupe on it.
  - Custom pads: `LayoutPadCustom > Custom > LayoutGroup[CLayoutPadShape]`
    of UB primitives in absolute, already-rotated coordinates.
  - UB primitives: `UBPie`/`UBArc` points are [start, end, centre] + `Radius`,
    sweep CCW (verified on a "HalfArc" pad's bbox); start == end = full
    circle. `UBRectangle`/`UBRoundedRectangle`: 4 corners (may be rotated)
    + optional anchor point. On copper with a `NetName` these are copper
    areas (C4).
  - Remaining unresolved net pins (10/6765) are source quirks: shield pins
    not in the footprint (3-Phase Driver U7.S4-S6), unplaced connectors
    (Pressure Servo J1, Althea-old Buttons J4), Design1's `POEA` vs pad
    `POEA+` naming.
- **(2026-11-11) Multisim drawing model — the old Phase 3 "wires" were wrong.**
  Sheet-level `CODLineComp`s are page-border / title-block lines and lines
  inside connectors, not wiring. Real wires are **`CIITLinkComp`** polylines
  (`Points > Item@X/Y`) under `CIITDiagram > Components > CODComposite >
  Objects`, each with **its own `Transformer`** (copy/paste offsets: Design1's
  decoupling caps' wires only line up after applying it). `CODComposite` is
  the sheet's wiring container (2 in Design1), not a net.
- **Pin attachment.** Each `CIITPinConnectorComp` has a `ConnectList`
  naming a sheet-level `CODPinComp` (absolute `CenterX/Y`) = where wiring
  attaches. 220/242 Design1 wire ends sit exactly on one.
- **Symbol placement.** Every `CIITSymbolComp` matrix is identity; M20/M21
  is not a reliable origin. Orientation lives either in the children's own
  transforms (rotation + translation baked in, `OrientationFlip` just a
  record) or in `OrientationFlip` bits (0-1 = rotation, 0x100 = mirror y,
  0x1000 = mirror x, mirror first). Robust method (implemented): compose
  child transforms (Windows XFORM row-vector: x' = x*M00 + y*M10 + M20),
  then fit the dihedral + translation that lands the most pins on their
  `CODPinComp`s. Result on first sheets of the corpus: 98.74% of pins exact;
  the rest are real attach drift, bridged with a wire stub.
- **Buses (2026-11-13).** `CIITBusCompV8` = polyline `Points`, bus name in
  its `NI_EWB_NET_VIRTUAL` modifier, member lines as `MapBusLine2NetName`
  keys (values were empty in every file looked at). Each `CIITBusEntry` is a
  diagonal `CODLineComp` stub plus a `CIITPinConnectorComp` at the wire end
  (wires attach there via its `CODPinComp`); its `NI_EWB_NET_BUS_ENTRY`
  modifier names the line. Multisim joins entries by line name per sheet;
  **line names are their own namespace**: iCue-to-1-Wire has bus lines
  `SCLK`/`MOSI` next to unrelated global nets `SCLK`/`MOSI`. KiCad joins a
  local label to a same-named global label, so the emitter labels such a
  line `<line>_BUS`. Emitted as KiCad `bus` + `bus_entry` + member labels on
  the entry wires + an unnamed group label `{a b ...}` on the bus.
- **Unnumbered pins (2026-11-13).** Simulation-only parts (sources,
  switches, meters, controllers in the NI samples) have pins with no number
  anywhere. The emitter already fell back to the pin name; the reference
  flattener used "", collapsing all of a part's pins into one key and
  scoring whole designs wrong (the NI SMPS "Basso" set went 0 -> 401/401
  exact once both sides used the same fallback).
- **Connectors.** `CVirtualConnector` types: `NI_EWB_VIRTUAL_GLOBAL` (7911)
  and `_LOCAL` (233) -> global / local labels, named by their
  `CIITSymTextCompName`. Child transforms there are template frames
  (identical for every instance). Connectors with an empty `ConnectList`
  (22 in Design1) sit off-page and their Ci nodes contain no parts: unwired
  in the source.
- **Net-name modifiers on wires:** `NI_EWB_NET_AUTONAMED` (33582),
  `_GLOBAL` (12733), `_GLOBAL_GROUND` (4595), `_NAME` (1256, user net name
  in `Item@Value` -> local label), `_HIERARCHY_COMP` (827), `_VIRTUAL`
  (255), `_HIERARCHY` (236), `_BUS_ENTRY` (158), `_OFFPAGE` (44), `_HIDDEN`
  (18). Buses are `CIITBusCompV8`.
- **Power ports**: ground / VCC are ordinary `CIITSymbolComp`s whose Ci
  component is POWER_SOURCES with one pin; emitted as KiCad `(power global)`
  symbols whose value is the Ci refdes = net name ("0" for ground, matching
  Ultiboard's net name).
- **KiCad instance orientation (measured with kicad-cli netlists):** rotation
  first, then mirror; lib point (x, y) lands at at + K(x, -y). Table in
  `src/emit/kicad-sch.ts` (`KICAD_ORIENT`).
- **Design1's Ci* netlist looks stale vs its drawing**: labels ADC0/ADC1,
  GPIO23/24/25 sit one pin apart from where Ci says (Ci's ADC1 has a single
  pin). The KiCad output reproduces the drawing. Treat Ci as "Multisim's
  cached netlist", not gospel, when they disagree.
- **kicad-cli ERC ignores `schematic.connection_grid_size`** (tested 1/5/10/25
  mil, minimal and full project files: off-grid count unchanged), though it
  honours `erc.rule_severities`. So `endpoint_off_grid` in CLI ERC is
  expected noise at our 10 mil scale. The generated `.kicad_pro` still sets
  10 mil for the editor (GUI behaviour unverified; no foreground testing).
  ERC JSON positions are in units of 100 mm.
- **(2026-11-11) Multisim connects only what its ID graph links; KiCad
  connects whatever touches.** Corpus designs stack parts on top of each
  other (LED-Delay's J1-J4 headers share one spot) and leave wires ending on
  unrelated pins. The emitter carries each item's Multisim net id (per-page
  union-find over link `Connect1/2`, `ConnectList`s, pin<->connector) and
  resolves contacts: one net keeps a point, every other net there gets its
  own off-grid (half-unit) rendezvous point, stacked symbols each move by
  their own off-grid offset and are re-linked to same-net items only.
- **Copy-pasted parts keep stale `CODPinComp` centres** (no transform on the
  pin point) while their wires carry the paste offset in the link's own
  transform. Attachment positions therefore come from the link endpoint
  (`Connect1` = first point, `Connect2` = last) when one exists. This took
  pin placement from 98.74% to 99.92% exact over all corpus pages.
- **Name labels / power ports by the pin's net modifier value**
  (`NI_EWB_NET_GLOBAL` / `_GROUND` / `_VIRTUAL`), not by their displayed
  text: that is what Multisim joins on.
- **Hierarchy:** see `plans/multisim-hierarchy.md` (research write-up) and
  `src/parse/ms-hierarchy.ts`. The drawing-graph flattener reproduces
  Multisim's exports exactly on every hierarchical design except Buttons
  (Ultiboard pin swaps not back-annotated). KiCad emission: one file per
  page, blocks -> sheet symbols, ports -> hierarchical labels, final refdes
  per instance path; verified on 1-Wire-HV-AC (21/21, P=R=100%).
- **Pin numbers: trust the netlist port, not the drawing.** A pin's
  `PortID` -> `CiPort` pin CSV is authoritative; the drawing's `PinNumber`
  goes stale after Ultiboard pin swaps are back-annotated (3-Phase Driver's
  resistors came out reversed until this changed).
- **Multi-section parts**: drawn symbols with different drawn refdes
  (U1A, U2A, U5A, U6A) can merge into one final part (U1) as sections;
  `RefDesInfo@IRSectionID` (0-based) gives the KiCad unit. Each unit's pins
  are renumbered by the CIR->IR pin map.
- **Connect1/Connect2 convention verified**: Connect1 = first point,
  Connect2 = last point on every corpus link without a transform (thousands,
  zero reversed).
- **NUL bytes in source.** The old emitter used literal `\0` characters as
  map-key separators, making git/grep treat the file as binary. Use
  `JSON.stringify([a, b])` keys instead.
- **Bash heredocs with long Python edit scripts fail** in this harness
  ("unexpected EOF while looking for matching `'`"). Write the script to the
  scratchpad with the Write tool and run it.
- **pcbnew Python (if ever scripted):** `pcbnew.LoadBoard()` turns parser
  warnings into modal wx dialogs. Call
  `wx.Log.SetActiveTarget(wx.LogStderr())` before loading (from a sibling
  thread, verified on KiCad 10.0.6). kicad-cli itself prints them instead.

## Progress log

- [x] Scaffold (`package.json`, `tsconfig.json`, `.gitignore`,
      `src/main.ts`, `src/ir/types.ts`, `src/parse/pcb.ts`,
      `src/emit/kicad-pcb.ts`, `src/util/check-sexp.ts`).
- [x] Plan written.
- [x] Samples copied (Temp, Design1.ewprj, Design1.ms14).
- [x] `bun install` clean (fast-xml-parser 4.5.6).
- [x] Parser end-to-end on both Ultiboard samples.
- [x] **Phase 1 emit:** minimal `.kicad_pcb` produced for `Temp.ewprj.xml`
      (`out/Temp.kicad_pcb`) and `Design1.ewprj.xml`
      (`out/Design1.kicad_pcb`). Format version `20221018` (KiCad 7,
      forward-compatible). Contains: header, paper, title_block (project
      name + import-source note), standard 2-copper-layer stack with full
      tech/user layer set, empty net 0. S-exp paren balance verified.
- [x] **VERIFIED (2026-05-29):** both `out/Temp.kicad_pcb` and
      `out/Design1.kicad_pcb` parse and render cleanly in **KiCad 10.0.3**
      (`kicad-cli pcb export svg` exit 0). DRC also runs clean (exit 0).
      DRC reports 14 unconnected items (nets 1 & 2 are intentionally
      unrouted in the EW source — net 3 with 6 traces is the only routed
      net) + 10 mostly-informational violations (placeholder library, silk
      clip, source-design clearance). Source-faithful — not converter bugs.
- [x] Phase 2 chunk 1: EW layer -> KiCad layer mapping table
      (`src/util/layer-map.ts`).
- [x] Phase 2 chunk 1: Board outline (EW layer 65 -> Edge.Cuts).
- [x] Phase 2 chunk 2: Silkscreen / fab / mask graphics on all mapped layers
      (polyline, rectangle, roundRect).
- [x] Phase 2 chunk 3: Tracks -> `(segment)` (still emitted on `net 0` —
      see below; track-net inference is deferred).
- [x] Phase 2 chunk 4: Components + pads + THT pins -> `(footprint)` with
      inline pads (placeholder `lib_id` `ew:<name>`).
- [x] Phase 2 chunk 5: Net table + **per-pad** net assignment.
- [x] Phase 2 (2026-05-29): **fixed net pin-ref parsing** — pins are nested
      under `UBNet > Pins > UBNetPin`, not directly under `UBNet`. Before this
      fix all nets had 0 pin refs and no pad resolved to a net. Design1 now
      shows 3 nets / 21 pin refs.
- [x] Phase 2 (2026-05-29): standalone drills (`Stand-Alone="1"`) -> mounting
      holes (non-plated) / vias (plated). Design1 has 4 non-plated 2.75 mm
      mounting holes (Raspberry-Pi pattern).
- [x] Phase 2 (2026-05-29): ellipses -> `(gr_circle)` (was a TODO; 8 in
      Design1, mask-layer rings around the mounting holes).
- [x] Phase 2 (2026-05-29): track-net assignment. Build a pad-position ->
      net index from per-pad nets, then propagate through shared track
      endpoints (BFS) so mid-chain segments inherit. Design1's 6 tracks
      now correctly carry net 3 (the only routed net in the source).
- [ ] Phase 2 later: copper pours (no sample in Design1 yet).
- [x] Phase 3 chunk 1 (2026-05-29): scaffold — `Schematic` IR, `parse/sch.ts`,
      `emit/kicad-sch.ts`, main.ts dispatch by `.ms14.xml` extension. Emits a
      minimal `(kicad_sch ... (lib_symbols) (sheet_instances ...))` from the
      Design1 schematic metadata. KiCad 10 `sch erc` exits 0 / 0 violations.
- [x] Phase 3 chunk 2 (2026-05-29): symbol placeholders. Walks
      `CIITSymbolComp` -> emits one `lib_symbol` per instance (bbox rectangle
      from `CIITSymbolBorderRect`, reference + value text from
      `CIITSymTextCompName` / `CIITSymTextCompValue`) plus the placed
      `(symbol ...)` instance. Design1: 52 symbols, KiCad 10 `sch erc` exits 0
      with 52 violations (one per symbol — expected, no wires yet). Pins,
      rotation handling, and `OrientationFlip` come in a sub-chunk; ~26 of 52
      symbols come through with refdes `"?"` because their refdes text lives
      under a different wrapper that the current `ownChild` walker doesn't
      reach.
- [x] Phase 3 chunk 3 (2026-05-29): wires. `collectByTag` gained a
      `skipUnder` filter so `CODLineComp` inside `CIITSymbolComp.Objects`
      (pin-stub graphics) isn't picked up as page wiring. Sheet-level
      `CODLineComp` and `CODMultiLineComp` (exploded into per-segment
      `Wire`s) are emitted as `(wire (pts ...))`. Design1: 127 wires.
      KiCad 10 `sch erc` still exits 0; violation count rises to 288
      (unconnected pins — symbols carry no `(pin ...)` entries yet, so
      wires touch the symbol bbox but don't electrically connect).
- [x] Phase 3 chunk 3.5 (2026-05-29): symbol pins. `CIITPinSymbolComp` ->
      `(pin passive line ...)` inside lib_symbol with `(pin "N" (uuid ...))`
      blocks in each instance. `PinNumber="1,10,22,33,42,49"` (Multisim's
      power-pin aggregate form) splits into one pin per number, all sharing
      the connector position. Design1: 195 pins. All pins emitted as
      passive/line at rotation 0 — pin direction inference from bbox edge
      is a future polish.
- [ ] Phase 3 chunk 4: `CSchDesignNetLabel` -> `(label ...)`.
- [ ] Phase 3 chunk 5: cross-check inferred nets vs `Ci*` netlist view.
- [x] (2026-11-11) Hidden kicad-cli runner, verified invisible (`eef0b18`).
- [x] (2026-11-11) ewd dependency + binary input (`ed01de0`).
- [x] (2026-11-11) Corpus copied + harness; 32/32 outputs load, large
      fidelity gaps measured (`a8b80be`). Baseline violations: sch
      endpoint_off_grid 2095, unconnected_wire_endpoint 1446,
      pin_not_connected 1423, wire_dangling 796, lib_symbol_issues 690;
      pcb track_dangling 1500, silk_overlap 1005, track_width 984,
      lib_footprint_issues 917, nonmirrored_text_on_back_layer 693.
- [x] (2026-11-11) Roadmap to full translator written.
- [x] (2026-11-11) Roadmap approved; decisions recorded.
- [x] (2026-11-11) Corpus expanded: GitHub repos (9 repos, 322 historical
      versions incl. 50 `.ms13`, in `corpus/github/<repo>/<name>@<date>-<sha>`),
      S:/T: shares (4 new client files in `corpus/drives/`). C:/P: scans were
      still running at this point (results in scratchpad `find/`).
- [x] (2026-11-11) Drive scan ended at the 2 h background limit (not
      restarted). P: was partially indexed (730 hits); the C: scan produced
      nothing. Imported 324 new unique files into `corpus/drives/`: 203
      `.ms13`, 7 `.ms11`, 26 `.ewprj`, 86 `.ewnet`, mostly from P:\Backups.
      248 of them are NI Circuit Design Suite 13 sample designs (a laptop
      backup), which are a broad simulation-oriented test set.
- [x] (2026-11-11) B1 `.ewnet` reader -> ewd 0.3.0 published (provenance).
- [x] (2026-11-11) A4 scorecard. Baseline (64 designs: 39 sch, 25 pcb):
      schematic nets exact 0/254; PCB net pins on a pad 473/6765.
- [x] (2026-11-11) C1/C2 pads + vias: PCB pins on pads 6755/6765.
- [x] (2026-11-11) A5 tests (12, bun test).
- [x] (2026-11-11) D2/D3 schematic rewrite (`c1dcfd1`): real wires,
      fitted placement, KiCad orientation, power ports, labels, junctions.
- [x] (2026-11-11) Hierarchy research (background agent) -> drawing-graph
      flattener as the scorecard reference (`8e7149b`).
- [x] (2026-11-11) D1 hierarchy + Multisim-faithful connectivity
      (`6ae6d1c`). Schematic nets exact: 0/254 (baseline, old reference)
      -> 134/255 (D2/D3) -> 1605/1790 with the full flattened reference;
      18/39 designs exact; all 39 load in KiCad 10.
- [x] (2026-11-11) Multi-unit parts + netlist pin numbers (`c0c8f04`).
      **Schematic nets exact: 1765/1790 (98.6%); 33/39 designs exact;
      all 39 load in KiCad 10.**
- [ ] Remaining schematic residuals (all small, logged here):
  - ~~Buses~~ done 2026-11-13 (see the D bus entry below). Still open:
    bus ports across hierarchy / pages (`CIITBusHierConnector`,
    `CBusOffpageConn`), not seen failing yet.
  - ~~Shared supply pins~~ done 2026-11-13: a pin number drawn on several
    sections of one part stays a KiCad pin only on the section Multisim
    wires (others drawn as plain lines); the reference flattener now joins
    all nets holding the same (refdes, pin).
  - ~~Multi-contact switches~~ done 2026-11-13: the KiCad output was right
    all along (matches the Ultiboard netlist); the reference flattener was
    reading the never-wired pin copies interactive parts
    (`CIITAnimationSymbolComp`) keep under `AnimationLayers`. Skipped now.
  - `NI_EWB_NET_HIDDEN` pins (CAN Main, 1 net) ignored.
  - Twillbot Distribution: 164/165, not investigated.
- [x] (2026-11-11) Drive corpus scorecard (`--corpus corpus/drives`, 238
      designs, report in `out/corpus-drives/`): 233 load in KiCad;
      **schematic nets exact 1642/2300 (71%)**; PCB pins on pads 6437/6505.
      Much weaker than the main corpus: the NI CDS 13 samples are `.ms13`
      simulation circuits (instruments, analyses, mixed-signal parts). Not
      yet diagnosed; logged as the next schematic-fidelity target (see
      below).
- [x] (2026-11-11) **B2 done.** ewd `parseEwXml` (ewd `67524e0`, released
      as ewd **0.4.1**; the v0.4.0 tag exists but its publish run failed on
      a test that needs the gitignored `samples/`, fixed in `eda2e41`).
      multisim2kicad migrated off fast-xml-parser. Verified with
      `scripts/ir-hashes.ts` against a baseline over all 592 corpus designs:
      every output difference was traced and all are improvements:
      `&UNI` strings now decoded in PCB values (`200Ω 5%`), `&UNI`
      escapes followed by hex-looking text no longer truncated
      (`ICS‐43434`), 5 Thermal Analysis samples that fast-xml-parser
      refused (entity expansion limit 1000) now parse, and `Mag Sensor
      .ms11` gets its final refdes (fast-xml-parser trimmed the sheet title
      but not the CIR path naming it). Display text is trimmed and
      CRLF->LF via `displayText()` (fast-xml-parser had done that silently
      to every attribute). Main-corpus scorecard unchanged: 1765/1790.
- [x] (2026-11-11) **C3-C5 first pass.** Per-board `LayerMap`
      (`src/emit/pcb-layers.ts`): stackup-driven copper (In1..In n), fixed
      technical layers, named KiCad user layers for 3D / mechanical / custom
      EW layers. Power planes and board-level copper areas -> KiCad zones
      (net, clearance, thermal spoke width, island removal; distinct
      priorities, areas above planes). `Arc` (CDrawArc) emitted. Board text
      (`UBAttribute TEXT`) -> `gr_text`. Rule areas -> named KiCad rule
      areas that restrict nothing (semantics unconfirmed). DRC now runs with
      `--refill-zones`. **24 corpus boards: DRC unconnected items 3894 ->
      239, violations 17918 -> 17294; pins on pads unchanged.** Renders of
      Althea Main (F.Cu, In2.Cu) look right.
- [x] (2026-11-13) **C6 real footprints.** Footprints carry the part's
      rotation and side (bottom: phi = 180 - rot, local Y-mirrored as
      KiCad stores flips); the part's silk / fab / courtyard / 3D drawings
      move into the footprint as `fp_*` in local coordinates; Reference /
      Value at EW's position, size, angle and visibility; other visible EW
      labels -> `fp_text user`. Bottom courtyards (EW 92) -> B.CrtYd. Unit
      tests check placement against KiCad's transform on both sides.
      **24 baseline boards: unconnected 239 -> 228, violations 17294 ->
      15760 (silk_over_copper 3002 -> 1925, silk_overlap 2207 -> 1194),
      pins on pads unchanged (5963).** New, expected now courtyards are
      real: courtyards_overlap 497, malformed_courtyard 22 (open EW
      courtyards), text_thickness 140 (thin EW text). Full run now covers
      182 PCBs (all GitHub history): 52014/52156 net pins on a pad; old
      revisions with 100+ unconnected are boards mid-routing. Renders of
      Althea Main (front) and Sleepy Control (mirrored back) look right.
- [ ] Remaining C work: padstacks, unverified EW unit
      (`RemoveIslandSize`), footprint names from the EW package attribute,
      boards still unconnected: Distribution (50), 1-Wire-HV-AC (50),
      Althea.old Buttons (52), Brain Adapter (18); one track-net short on
      Althea Main (net propagation). Corpus baseline for later PCB work:
      `out/corpus-pcb-c6/report.json`.
- [x] (2026-11-13) **Buses + unnumbered pins.** Buses emitted (bus,
      bus entries, member labels; colliding line names relabelled). The
      reference flattener now numbers unnumbered pins like the emitter.
      **Main schematics 1591 -> 1602/1615 (37 designs, 34 exact); drive
      corpus 1642/2300 (71%) -> 2473/2600 (95%), 212/212 load.** Reports:
      `out/corpus-sch-bus/`, `out/corpus-drives-bus/`.
- [x] (2026-11-13) **Instrument pins, interactive parts, shared pins.**
      `##` pin numbers (instruments) fall back to the pin name like blank
      ones; the reference flattener skips `AnimationLayers` pin copies and
      joins nets holding the same physical pin; shared pins of
      multi-section parts stay pins only on the wired section.
      **Main schematics 1608/1609 (36/37 designs exact; the one miss is
      Distribution's Y1.2/Y1.4). Drive corpus 2624/2635 (99.6%), 203/212
      exact.** Reports `out/corpus-sch-f/`, `out/corpus-drives-f/`. Left in
      the drive corpus: ground-symbol pin naming (`0.0`, `0.GND` vs `0_n`
      parts), a few single nets in Controller.ms11 / DIGITAL / Power board.
- [x] (2026-11-13) **E2 + E4: linked projects.** `multisim2kicad <folder | X.ms14
      X.ewprj>` pairs a schematic and board by folder + base name into one
      KiCad project. Footprints carry their symbol's `path` (sheet-symbol
      UUIDs without the root + symbol UUID, as KiCad writes it), `sheetname`,
      `sheetfile`; symbols get `Footprint` = `<project>:<EW footprint>`;
      linked footprints take the symbol's value (blank values keep the
      board's); parts with no symbol are `board_only`; mounting holes get
      MH<n> references. Board net names adopt the schematic's spelling up to
      case (Ultiboard upper-cases). New `scripts/parity.ts` compares the
      schematic's KiCad netlist with the board's pad nets as groupings (the
      KiCad parity report is name-based and capped at 199 per category).
      **Althea (Trove): Heater 82/82, Main 95/97 (extra shield pads on the
      board only), Buttons 14/23 (J1/J2 pin order differs between the
      user's Multisim and Ultiboard files; each converter matches its own
      source exactly).**
- [x] (2026-11-13) **E3 footprints: project-local footprint library.**
      `<project>.pretty/` + `fp-lib-table` (entries merged, so projects can
      share a folder). Each library footprint is a placed copy turned back
      into its library drawing (C6 rules, rounded to nm). Ultiboard rounds
      every placed copy after rotating it and KiCad compares footprints
      exactly, so `harmonizeFootprints` places each copy from its library
      drawing when it agrees within 10 nm, trying quarter-turns (a 2-pin
      part may record pad 1 at the other end); a copy that matches no
      drawing (a silk mark moved on that copy) becomes a variant
      `<name>_2`. Fixes found on the way: rectangles drawn from their
      corners (were bounding boxes, wrong at odd angles), rounded rectangles
      likewise, circle rim point on the frame's +x axis, custom pads
      written in the footprint frame at the footprint's angle, a part's 3D
      outline on one user layer for both sides (KiCad does not swap user
      layers on flip), mounting holes as `MountingHole_<d>mm` library
      footprints. **24 boards: lib_footprint_issues 1921 -> 0, total DRC
      violations 15760 -> 13853, pins on pads unchanged (5963).** LED-Delay
      gained one ratsnest entry (4 -> 5) on its VCC net, already split by a
      source quirk (F.Cu track ending on P1's bottom-only pad); pads are
      unchanged. Report `out/corpus-pcb-e3/`.
- [x] (2026-11-13) **D4 dedupe + E3 symbols: project symbol library.**
      `<project>.kicad_sym` + `sym-lib-table`; every placed symbol points at
      `<lib>:<part>`, and the schematic's embedded `lib_symbols` are copies
      of the library entries. Symbols are named after the part's EW
      database name (`dbPartName`: the `family, name, family` triple in the
      CiComponent attribute strings; basic parts like resistors have none and
      fall back to the reference prefix). Three things made "the same part"
      look different and are normalised away: (1) Multisim local frames carry
      arbitrary offsets -> each symbol's origin moves to the centre of its
      pins, rounded to the grid, placement shifted to match; (2) some parts
      have their rotation baked into the drawing -> a symbol is matched
      against the library under all 8 dihedral turns (re-centred after
      turning, since an odd pin span rounds per orientation) and the turn
      moves into its placement (drawings with text are not turned);
      (3) sections of one part (U8I2C / U10UART) -> reference prefix is the
      leading letters, and each unit carries its own drawing so differently
      drawn sections share one multi-unit symbol. A drawing that still
      differs becomes `<name>_2`. Althea Main 234 placements: 101 per-
      instance symbols -> 51. **Main corpus: nets unchanged (1608/1609),
      ERC lib_symbol_issues 3233 -> 0, missing_unit 22 -> 3, total
      violations 13367 -> 10123.** pin_not_connected +8: all hierarchical
      sheet pins with no wire in either run (byte-identical geometry); the
      new run flags every instance of an unwired block where the old one
      flagged some. **Drive corpus: nets unchanged (2624/2635),
      lib_symbol_issues 4691 -> 0, missing_unit 27 -> 5;** pin_not_connected
      +5, all hierarchical labels (same reporting effect). Reports
      `out/corpus-sch-g/`, `out/corpus-drives-g/`.
- [x] (2026-11-13) **C7: design rules and net classes.** Sources:
      `BoardLayerSettings` (`ClearancetoTrace/Pad/Via/Area`,
      `NetTraceWidth`, `MinimumNetTraceWidth`,
      `BoardOutlineElectricalClearance`; `UseMultipleClearances` is 0 on
      every corpus board, so per-layer `UBLayerInfoExtension` clearances are
      unused), `Design-Rule-Via` (`PadRadius`/`DrillRadius`; the board's
      vias carry exactly these, nm artefacts included: 0.604798 / 0.299998),
      and per-net `UBNet` `TraceClearance`/`PadClearance`/`ViaClearance`/
      `CopperClearance` (always equal per net) + `Width`; 2147483646 /
      2147483647 mean "board default". Per-net via sizes are never set.
      Mapped to `.kicad_pro`: Default net class = board clearance / width /
      via; one net class per distinct (clearance, width) override, assigned
      by exact-name `netclass_patterns`; rules `min_track_width`,
      `min_copper_edge_clearance`, `min_hole_clearance` = board clearance
      (Ultiboard has no separate hole clearance), and `min_through_hole_
      diameter` / `min_via_diameter` = 0 (Ultiboard has no such minimum;
      KiCad's 0.3 / 0.5 mm defaults flagged Ultiboard's own default via).
      `MinimumAnnularRingWidth` (0.254 mm on most boards, garbage 411 mm on
      15) is not mapped: every default via has a 0.152 mm ring, so it can't
      be a via rule; KiCad's 0.1 mm default stays. Board-level pad / via
      clearances that differ from the trace clearance (5 drive boards) go
      to `<project>.kicad_dru` custom rules. **24 boards: DRC violations
      13853 -> 5194 (drill_out_of_range 1850 -> 0, via_diameter 208 -> 0,
      clearance 3797 -> 128,
      track_width 2396 -> 230 [tracks below the board's own minimum],
      copper_edge_clearance 607 -> 21, hole_clearance 258 -> 139),
      unconnected 229 -> 167 (zones now fill with the board's clearances
      and reach pads: Distribution 50 -> 12, Materna Control 6 -> 0), pins
      on pads unchanged (5963).** Left: silk (over copper / overlap /
      edge: source-faithful), courtyard overlaps, solder_mask_bridge, the
      tracks below their board's own minimum width. Report
      `out/corpus-pcb-c7c/`.
- [x] (2026-11-13) **F footprints.** `multisim2kicad <db.prj>` writes
      `<db>.pretty/` + fp-lib-table from every `UBLIB` object
      (`src/db/ewdb.ts`, `parseUbLibraryXml`). Stocked Electronic
      Components v14.2: 395 footprints, all load and plot in kicad-cli
      (`fp export svg`); 46 PADLIB + 5 NETBRIDGELIB objects skipped (custom
      pads are embedded in the footprints that use them). Checked against
      the Althea boards' own libraries: same pads and drawings; the only
      differences are text the user placed on a board's copy and 1-4 nm
      rounding in placed copies (plus genuinely older revisions, e.g.
      D0603).
- [x] (2026-11-13) **F symbols.** `<db>.kicad_sym` + sym-lib-table
      (`src/db/symbols.ts`, `librarySymbolsFile` in the emitter). Picture
      layout: pin `PNaT Txt` = 1-based index into the section's pin list
      (`PLS` = side), `CTSP` body end, `WCP` wire point; the number text is
      a `##` placeholder. Units are `.ms14` schematic units (checked
      against ACS711 placed in Althea Main: same pin spacing 18, length
      9). Draw layers 2+ are alternate looks (the Fuse's blown state:
      seven layers stacked) -> only layer 1. Objects: Line / MultiLine,
      Polygon (`BS=0` filled), Rectangle, Circle (centre + rim), Ellipse
      (bbox), HalfEllipseArc (chord ends + apex; arc when circular, else a
      polyline), SegmentArc (centre, start, end; 2 uses), Text. Component
      `Pinout` lists sections concatenated in `Sec_Order`; package
      `Pinout` gives each pin's pads ("1,2" -> stacked pins; no package ->
      the pin name). Shared pads (an op-amp's supply on every section)
      stay a pin on the first unit and are stems elsewhere. Pin types from
      `Pin_Type` (I/O -> bidirectional, PWR/GND/VCC/VEE/VPP -> power_in,
      OPEN_SOURCE -> open_emitter, ...). Reference prefix from the
      family's `Template` (`U%d`; the user's "Current" family really is
      `F%d`). Fields: Description (`Function`), Manufacturer, EW_Family,
      EW_Package when the footprint is not in this DB (127 of 319 mappings
      point at NI master-database packages). **v14.2: 241 symbols / 406
      units, all plot in kicad-cli; 128 linked to a footprint in the same
      DB.** Design conversion output unchanged (byte-identical apart from
      UUIDs on Althea). Optional: move `symbolPictureXml` into ewd.
- [x] (2026-11-13) **G: packaged and published to GitHub** (`e91ad11`).
      Node-runnable CLI (`src/cli.ts`, `main(args)`), library entry
      `src/index.ts`, `build.ts` (ESM bundles, ewd external) + d.ts, ISC
      LICENSE, CI test + publish workflows, publish guard. CI green.
- [x] (2026-11-13) **NI master database** (`7c79709`). Multisim 14.2
      installs it at `C:\ProgramData\National Instruments\Circuit Design
      Suite\14.2\database\MSCOMP_S.PRD` (241 MB, same Jet schema as the
      user's `.prj`; also `CPCOMP_S.PRJ` corporate template and
      `Program Files (x86)\...\database\UsrCompTemplate_S.usr`). ewd
      decodes it in 5 s: 57,162 components, 3,551 symbol pictures, 7,405
      library objects. The CLI now takes `.prd`. **Bug found and fixed:**
      `SYS_COMPONENT.Pinout` is the full pin list in *package order*,
      including pins no section draws (a 7400's GND / VCC), not the
      sections concatenated; the user's DB happened to be in section
      order. Section pins are now matched by name; undrawn pins go on an
      extra labelled power unit (skipped when the package has no pad for
      them). Warnings 88,251 -> 167. **KiCad 10 loads all of it:**
      `fp upgrade` on all 7,353 footprints (after skipping zero-size,
      no-drill pads: NI's DPAK `TO228P991X238-3_4N` stores its cut middle
      lead that way and one such pad made KiCad reject the whole library,
      "Unable to load library"; no corpus board has one), and `sym
      upgrade` re-saves all 57,101 symbols (25 s). Checked 74ALS00M, TLC27L7ID,
      LTC1050CJ8, MAX3212 against datasheet pinouts and rendered them
      with kicad-cli. Output must never be committed or redistributed
      (NI content).
- [ ] Master-DB leftovers: 29 symbol pictures embed a bitmap
      (`<Bmap Type="AdvancedBitmap">` with base64 *text content*, which
      ewd's `parseEwXml` rejects: "unexpected text content"; needs text
      support in ewd); 4 pictures fail to decompress ("Decoder returned
      wrong length"); 73 sections have no picture and 61 parts no symbol.
      DIN symbol variants (`Symbol_ID_DIN`) are not emitted (ANSI only).
- [ ] **Next:** npm 0.1.0 release (waiting on the user: name claim +
      trusted publisher), then B3 cleanup (typed EW models in ewd;
      multisim2kicad's parsers shrink to mappers). Drive-corpus leftovers (11
      nets: ground-symbol pin naming) are optional.
- [ ] Not translated at all yet (candidates, user to prioritise):
      SPICE simulation models (`SYS_MODEL` 45k rows in the master DB;
      designs embed models too) -> KiCad ngspice fields; 3D models;
      linking design symbols to a converted DB library instead of
      per-project copies; designs older than Multisim 10 / EWB 5
      (`.msm`, `.ewb`; none in the corpus).

## Open questions for the user

1. ~~Phase G: where multisim2kicad lives~~ answered 2026-11-13: public repo +
   npm, corpus private.
2. (2026-11-13) Which of the untranslated areas matter to you: SPICE
   simulation models, 3D models, pre-Multisim-10 formats? Recommendation:
   SPICE models first if you simulate in KiCad, else none.

## Earlier phase notes (historical, 2026-05)


#### Old Phase 0 - Scaffold (this session)

1. Project skeleton (`package.json`, `tsconfig.json`, `.gitignore`).
2. Copy samples to `./samples/`.
3. CLI: `bun run dev <file>` detects file type and prints a structured
   summary of what was found.
4. `fast-xml-parser` integration; first end-to-end pass.

#### Old Phase 1 - Minimal Ultiboard -> kicad_pcb

1. Define IR types: `Board { outline, layers[], items[] }`.
2. Map EW layer numbers -> KiCad layer names
   (`F.Cu`, `B.Cu`, `Edge.Cuts`, `F.SilkS`, `B.SilkS`, etc.).
3. Emit a valid `.kicad_pcb` containing:
   - paper size + general header
   - layer stack matching enabled EW layers
   - board outline polygon on `Edge.Cuts`
4. Open the result in KiCad; confirm it loads with no errors.

#### Old Phase 2 - PCB items

EW classes confirmed present in `Design1.ewprj.xml` (with counts):

- `CLayoutTrack` (6) -> KiCad `(segment ...)`. Width = `LineThickness` nm,
  layer from `Layer=` attr, endpoints in nested `Object > CDrawPoint`.
- `CLayoutDrillHole` (55) -> KiCad `(via ...)` if standalone, or the drill
  hole inside a `(pad ... thru_hole ...)` if attached to a THT pin.
- `CLayoutPadRound` (46), `CLayoutPadSquare` (3), `CLayoutPadRoundedSquare`
  (2) -> `(pad N circle|rect|roundrect ...)` inside a footprint.
- `CLayoutPinTHT` (51) -> wrapper around a pad + drill; one pad numbered
  per pin.
- `CLayoutComponent` (3) -> `(footprint ...)` wrapper. Name `&ASCXxx`,
  rotation in millionths of a degree (`Rotation=90000000` => 90 deg).
- `CLayoutNet` (3) + `CLayoutNetPin` (21) -> `(net N "name")` table at
  top of file, plus `(net N "name")` reference on each pad/segment.
- `CDrawPolyline` (14), `CDrawRectangle` (30), `CDrawEllipse` (8),
  `CDrawRoundRect` (2) -> `(gr_line ...)`, `(gr_rect ...)`, `(gr_circle
  ...)`, etc., on the KiCad layer matching the `Layer=` attribute.
  Layer 65 ("Board Outline") goes to `Edge.Cuts`.

Order of attack:
1. EW layer number -> KiCad layer name mapping table (Top=0 -> `F.Cu`,
   Bottom=63 -> `B.Cu`, BoardOutline=65 -> `Edge.Cuts`, SilkscreenTop=66
   -> `F.SilkS`, etc.).
2. `CDrawPolyline` / `CDrawRectangle` on Board Outline -> `Edge.Cuts`.
   Gives us a visible board.
3. `CLayoutTrack` -> `(segment ...)`.
4. `CLayoutComponent` + pads + THT pins -> `(footprint ...)` with inline
   pads. Use generic placeholder `lib_id`.
5. Free-standing `CLayoutDrillHole` (not inside a pin) -> `(via ...)`.
6. Net table + per-item net assignment.
7. Polyline / Rectangle / Ellipse on silkscreen / fab layers ->
   `(gr_*) ...`.
8. Copper pours - later, no sample in Design1 yet.

#### Old Phase 3 - Multisim -> kicad_sch

EW classes from `Design1.ms14.xml` recon (Multisim has separate hierarchy):

- **Drawing side** (`CIIT*` and `COD*`):
  - `CIITSymbolComp` -> placed schematic symbol
  - `CIITPinSymbolComp` -> pin position within a symbol
  - `CIITSymbolBorderRect` -> symbol bounding box
  - `CIITSymTextCompName` / `CIITSymTextCompValue` /
    `CIITSymTextCompLocation` -> reference / value / location annotations
  - `CODLineComp`, `CODMultiLineComp` -> wires
  - `CODRectComp`, `CODTextComp`, `CODPinComp`, `CODNodeTextComp` ->
    misc graphics + pin labels
  - `CSchDesignNetLabel` -> net label (`(label ...)`)
  - `CVirtualConnector` -> virtual/named net joiner (likely GND, VCC, etc.)
- **Netlist side** (`Ci*`):
  - `CiCircuit`, `CiComponent`, `CiNode`, `CiPort` - the SPICE-flavor
    netlist view. Probably the authoritative source for net membership.

Order of attack:
1. Walk `CIITSymbolComp` instances; emit placeholder rectangles +
   pins at the right coords. Reference/value text from `CIITSymText*`.
2. Walk `CODLineComp` / `CODMultiLineComp` -> `(wire (pts ...) )`.
   Connectivity inferred from wire-pin geometry.
3. Walk `CSchDesignNetLabel` -> `(label ...)`.
4. Cross-check inferred nets against `Ci*` netlist view; flag mismatches.
5. Phase 3.5: real `lib_id` mapping for common parts.

#### Old Phase 4 - Polish / library translation

- Footprint library translation (EW footprint defs -> `.kicad_mod`).
- Symbol library translation (-> `.kicad_sym`).
- Optional `ewd` integration so the CLI accepts binary input directly.

**EW master library + ewd DB decode (2026-05):** the sibling `ewd` decoder now
extracts the embedded SQLite database ("ewdb") from EW files (see `..\ewd\ewdb`,
commits "Working database extraction!" / "decode embedded sqlite database
blob"). The master parts/footprint/symbol library lives at
`\\uberfall.tsl\Electronics Workbench Database\` (category folders + `.prt`
part DBs: `package.prt`, `ulti.prt`, `multisim.prt`, ...).

Impact:
- Does NOT affect PCB geometry conversion (Phases 1-2). `.ewprj` embeds every
  placed component's pads/drills/silk at absolute coords; Design1 fully
  converts with no external library.
- IS the enabler for high-fidelity library translation: translate EW's own
  symbols/footprints into KiCad libs rather than inlining approximations
  (current state) or fragile-mapping to KiCad's stock library. Also the basis
  for proper schematic symbols in Phase 3.
- Verify ewd's ewdb output format before building against it (was WIP at last
  check).

#### Old Phase 5 - Altium export (future, possibly private/paid)

User is interested in exporting to Altium too, potentially as a non-public /
paid feature. Architecture implication: keep `src/ir/types.ts` format-neutral
(no KiCad-isms) so an Altium emitter is just another `src/emit/` backend over
the same `Board` IR. Natural split: EW decode + IR + KiCad emitter public;
Altium emitter private.

Feasibility, NOT yet verified - do a spike before promising:
- Altium native `.PcbDoc` / `.SchDoc` are OLE2 Compound File Binary Format
  (proprietary binary, unlike KiCad's text S-expressions). Reading is
  reverse-engineered by third parties; writing is far less charted.
- Cheaper fallbacks if native binary write is too costly: emit clean KiCad and
  use Altium's built-in KiCad importer (Altium 24+), or an intermediate format
  Altium ingests. Less "sellable" than native files that just open.


## Things not to do

- Don't attempt round-trip. Out of scope.
- Don't reach into `ewd`'s internals. If we wire it as a dep later, do so
  through its public API.
- Don't pursue byte-perfect EW class fidelity. We're translating semantics,
  not preserving the EW object model.
- **Never run kicad-cli / pcbnew directly.** Always through
  `scripts/run-hidden.ps1`.
- Never write to `P:\Projects\Archive\`. Copy into `corpus/` first.
- Don't call a corpus file "converted" because it loads in KiCad. Use the
  fidelity scorecard (A4).
