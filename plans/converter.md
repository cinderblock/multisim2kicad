# EW -> KiCad converter (`ew-conv`)

## Goal

Convert decompressed Electronics Workbench XML (output of the sibling `ewd`
library) into KiCad project files:

- `*.ewprj.xml` (Ultiboard) -> `*.kicad_pcb` (PCB layout)
- `*.ms14.xml`  (Multisim)   -> `*.kicad_sch` (schematic)

End state: someone with Ultiboard / Multisim files can run `ew-conv <file>`
and open the result in KiCad with traces, components, and nets intact (or, at
minimum, placeholders that preserve geometry and connectivity so the design
is recoverable rather than redrawn from screenshots).

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\ew-conv`
- Sibling repo `..\ewd` is the decoder (binary `.ewprj` / `.ms14` -> XML).
  Not yet wired as a dep; we work from XML samples copied into `./samples/`.
- Runtime: Bun + TypeScript on Windows / PowerShell.
- Target KiCad version: 7 / 8 / 9. The S-expression formats are stable across
  these. Output `version` field will track whichever KiCad release we
  actively test against (default: 9).

## Decisions already made (don't re-ask)

- **PCB-first.** Start with `.ewprj.xml` -> `.kicad_pcb`, then schematic.
  Reason: user has more PCB samples; PCB layouts are the more painful asset
  to lose, and the schematic side carries the symbol-library nightmare. The
  user confirmed "let's keep [decoder] separate and build here."
- **One-way conversion only.** No round-trip / no KiCad -> EW.
- **`ewd` stays a separate library.** This repo consumes the XML output, not
  the decoder code directly (for now). A binary-input convenience wrapper
  can come later.
- **Bun + TypeScript** for new code.
- **Samples copied locally** under `./samples/` so we're not tied to ewd's
  path on disk.

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

## Plan / steps

### Phase 0 - Scaffold (this session)

1. Project skeleton (`package.json`, `tsconfig.json`, `.gitignore`).
2. Copy samples to `./samples/`.
3. CLI: `bun run dev <file>` detects file type and prints a structured
   summary of what was found.
4. `fast-xml-parser` integration; first end-to-end pass.

### Phase 1 - Minimal Ultiboard -> kicad_pcb

1. Define IR types: `Board { outline, layers[], items[] }`.
2. Map EW layer numbers -> KiCad layer names
   (`F.Cu`, `B.Cu`, `Edge.Cuts`, `F.SilkS`, `B.SilkS`, etc.).
3. Emit a valid `.kicad_pcb` containing:
   - paper size + general header
   - layer stack matching enabled EW layers
   - board outline polygon on `Edge.Cuts`
4. Open the result in KiCad; confirm it loads with no errors.

### Phase 2 - PCB items

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

### Phase 3 - Multisim -> kicad_sch

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

### Phase 4 - Polish

- Footprint library translation (EW footprint defs -> `.kicad_mod`).
- Symbol library translation.
- Optional `ewd` integration so the CLI accepts binary input directly.

## Findings / gotchas

- `fast-xml-parser` (defaults + `ignoreAttributes:false`, `attributeNamePrefix:"@_"`)
  parses the EW XML cleanly with no special configuration. Entity decoding is
  automatic, so `&amp;ASCTemp` arrives as `&ASCTemp` and the strip becomes a
  simple `s.startsWith("&ASC")` check.
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
- [ ] **OPEN ITEM:** verify Phase 1 output opens in KiCad without errors.
      Needs a human (or scripted KiCad CLI) to confirm. KiCad will offer
      to create the `.kicad_pro` on first open; that is expected.
- [ ] Phase 2: EW layer -> KiCad layer mapping table.
- [ ] Phase 2: Board outline (CDrawPolyline / CDrawRectangle on EW layer 65
      -> Edge.Cuts).
- [ ] Phase 2: Tracks -> `(segment)`.
- [ ] Phase 2: Components + pads + THT pins -> `(footprint)`.
- [ ] Phase 2: Drill holes -> `(via)` or pad drill.
- [ ] Phase 2: Nets table + per-item net assignment.
- [ ] Phase 2: Silkscreen / fab graphics.
- [ ] Phase 3: Multisim schematic.

## Open questions for the user

1. KiCad target version - currently emitting format `20221018` (KiCad 7,
   forward-compatible with 8/9). If the user is on a specific version we
   can bump and use newer features.
2. Should the CLI accept binary `.ewprj` / `.ms14` directly (calling into
   `ewd`), or stay XML-only and let users two-step?
3. Where should real symbol/footprint mapping data live - checked in here,
   or as a side data file the user maintains separately?
4. **Verify `out/Temp.kicad_pcb` and `out/Design1.kicad_pcb` open cleanly
   in KiCad** before moving to Phase 2. If they don't, fixing that comes
   first.

## Things not to do

- Don't attempt round-trip. Out of scope.
- Don't reach into `ewd`'s internals. If we wire it as a dep later, do so
  through its public API.
- Don't pursue byte-perfect EW class fidelity. We're translating semantics,
  not preserving the EW object model.
