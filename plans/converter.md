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

### Phase 4 - Polish / library translation

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

### Phase 5 - Altium export (future, possibly private/paid)

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

## Open questions for the user

1. **KiCad target version (RESOLVED 2026-05-29).** User installed KiCad 10.
   Emitter continues to write `(version 20240108)` (KiCad 8) — KiCad 10
   reads it without complaint (offers to upgrade on save, harmless). No
   change needed unless we want KiCad-9/10-specific features.
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
