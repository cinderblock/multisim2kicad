# Multisim 14 hierarchy encoding: findings

Research notes for ew-conv (Multisim to KiCad). All claims below were checked against the decoded corpus XML of the local corpus (decoded XML). The prototype it describes is now `src/parse/ms-hierarchy.ts` (drawing-graph flattener). Original research scripts (not kept) were:

- `drawflat.ts`: the drawing-based flattener (recommended).
- `flatten.ts`: a Ci-based flattener, kept to show why it is not enough.
- `compare.ts`: compares pin partitions against `.ewnet` / `.ewprj`.
- `struct.ts`, `cidump.ts`, `sweep.ts`, `dbg*.ts`: probes.

Run them with `bun run compare.ts <design.xml> <ref.ewnet|ref.ewprj.xml> --draw` from `scratchpad/hier`.

## 0. Corpus coverage (what is and isn't exercised)

| Feature | Present in corpus? | Where |
|---|---|---|
| Subcircuits (`CHierBlock Subcircuit="1"`, refdes `SC%d`) | yes, every hierarchical file | 1-Wire-HV-AC, Brain Adapter, Althea Main/Heater/Buttons (+ PCB.old), Pressure Servo x2, iCue to 1-Wire |
| Hierarchical blocks (`Subcircuit="0"`, separate file, `HB%d`) | **no** | n/a. Expect `CSheetComponentMSM@Path/PathAbs` to be non-empty; unverified |
| Nested hierarchy | yes, depth 2 | Althea Heater: Heater > HeaterChannel x6 > {Detect, Indicator Buffer} |
| Multi-page sheets | yes | Althea Main (5 pages + 10 SC), Pressure Servo (3 pages + 4 SC), CAN Main (11 pages, flat), 3-Phase-Driver `@...ms13` (3 pages) |
| Off-page connectors (`CIITOffPageConnector`, `NI_EWB_NET_OFFPAGE`) | only in historical 3-Phase-Driver `.ms13` versions | Driver@2014-11-22-113bacc |
| Buses (`CIITBusEntry`, `CBusOffpageConn`) | 3-Phase-Driver; one hierarchical **bus port** (`CIITBusHierConnector`) in iCue to 1-Wire | see section 6 |
| On-page connectors (`CVirtualConnector Global="0"`) | 4 in Heater | |
| Multi-section parts across pages | yes | Althea Main (U1 = sections on Pi/Power pages; D1 = D3A+D4A) |

## 1. Unique sheets, instances, and how they point at each other

### Unique sheets and pages

A **page** is one `SheetContainer` (`Project > UniqueSheets > SheetInfos > SheetContainer[]`), with `Sheet > Variable > DesignSheet[Class=CSCH_CAPSubSheet]`. A **unique sheet** is the set of pages that share `DesignSheet@Title`. Pages are told apart by `@PageName`. A single-page sheet has `PageName="1"`. Each page has its own `@SheetID` GUID and its own `CiCircuit`.

```xml
<DesignSheet Class="CSCH_CAPSubSheet" ObjectID="1499152862" DocType="&amp;ASCSCH_CAPDESIGN"
  Title="&amp;ASCHalfBridge" PageName="&amp;ASC1" SheetID="{14E5D79C-5759-4F7D-A815-4BA433C343B3}" ...>
```

The **root sheet** is named by `Project > DesignSheet[Class=CDrwSubSheet, DocType=PROJECT]@Title`. That element sits outside UniqueSheets and is the project wrapper. Its Store holds one `Group[Class=CSheetComponent]` whose `GUID` is the root of every tree-instance GUID path (`{CF812BCC...}` in 1-Wire-HV-AC).

Multi-page root example, Althea Main: Title="Main" with pages Peripherals, Pi, Microprocessor, Power and Flashing, plus child sheets "Motor Driver", "MCP96" and others. Every page, child sheets included, is a sibling SheetContainer. **Nesting is not shown by XML nesting.**

### The instance (block) on the parent page

An instance is a `CIITMacroComponent` in the parent page's drawing (`XMLSubSheet > CIITHierDoc > Diagram > CIITDiagram > ... Objects > Item`):

```xml
<Item ID="143605584" Class="CIITMacroComponent">
<CIITMacroComponent ... Transformer-M20="657" Transformer-M21="468" ... CiComponent="62438952"
    SheetComponentObjectID="1499153538" GUID="{00000000-0000-0000-0000-000000000000}">
  <Objects> CIITSymTextCompName Output="" (often EMPTY: label hidden), CIITSymTextCompValue Output="HalfBridge",
            CODRectComp body, CIITPinSymbolComp x N (block pins) </Objects>
  <HierBlock><CHierBlock Class="CHierBlock" FileName="&amp;ASCHalfBridge" Subcircuit="1" Doctype="&amp;ASCSCH_CAPDESIGN"/></HierBlock>
</CIITMacroComponent>
```

There are three equivalent links to the child sheet. All three agree in every corpus file:

1. `CHierBlock@FileName` gives the child `DesignSheet@Title`. For an SC this is a sheet name, not a path.
2. `@SheetComponentObjectID` points to a `Group[Class=CSheetComponentMSM]@ObjectID` in the **parent page's** `Store > DataTreeContainer`. That group has `SheetName` = child title and `GUID` = the **instance GUID** used in tree paths. `Path`/`PathAbs` are empty for SCs.
   ```xml
   <Group Class="CSheetComponentMSM" ObjectID="1499153538" SheetName="&amp;ASCHalfBridge" GUID="{E99159B4-BBAC-4D7E-99DF-A8A4A6F7BC1F}" Path="" PathAbs="">
   ```
3. `@CiComponent` points to `Item[CiID][Class=CiInstComponent]` in the parent page's Ci netlist. That item has `LocalName` = **instance refdes as drawn** (`SC1`) and `Circuit` = **parent** page circuit (not the child circuit). The child sheet name is in its `Attributes` `CiaCString` (`"HalfBridge"`), and the second `CiaCollString` is `["92","SC%d","x%p %tPWM %tEN %tSwitch <file>"]`.
   ```xml
   <CiInstComponent Class="CiInstComponent" LocalName="&amp;ASCSC1" SymCompID="866681176"
       InstanceID="{49472FD5-A232-4123-BA1A-D65E4E4F3862}" Circuit="972738080">
   ```

**Do not use `CiInstComponent@SymCompID`**: it is stale. In 1-Wire-HV-AC, SC1 and SC3 both say `866681176`, which matches neither macro. Use `CIITMacroComponent@CiComponent` to find the CiInstComponent instead. Likewise **don't rely on the macro's `CIITSymTextCompName@Output`** for the instance name: it is `""` in 1-Wire-HV-AC and on Althea's Pi page.

### Type codes

The second CiaCollString `strings[0]` holds a type code: `92` = SC/HB instance, `91` = connector (net label / global / on-page / hier port; hier ports have `strings[1]="IO%d"`), `12` = ground, `26` = VCC-type power, `30`/`31` = L/C, `46` = generic part.

### HB vs SC vs multi-page

- **SC** (only kind in the corpus): `Subcircuit="1"`, refdes template `SC%d`, child sheet embedded in the same file as a SheetContainer.
- **HB**: expected `Subcircuit="0"` and `HB%d`, with `FileName` / `CSheetComponentMSM@Path` pointing at an external `.ms14`. Unverified, as there are no samples.
- **Multi-page**: just several SheetContainers with the same Title. No block object is involved. Pages are joined by off-page connectors (scoped to the sheet instance) and by global connectors (design-wide).

### Instance identity paths

Two parallel path schemes, both rooted at the project:

- **CIR path** (string, used to key refdes maps): `#<page>/<SheetTitle>:<instName>` per level, **child first**, root has no instance name. Examples: root `#1/1-Wire-HV-AC:`, child `#1/HalfBridge:SC1#1/1-Wire-HV-AC:`, nested `#1/Detect:SC4#1/HeaterChannel:SC5#Control/Heater:`. Instance names here are the **drawn** (CIR) names (`SC5`), not the final IR names (`H0`).
- **Tree GUID path**: `<root CSheetComponent.GUID>/<root DesignSheet.SheetID>/<CSheetComponentMSM.GUID>/<child DesignSheet.SheetID>/...`, for example `{CF812BCC…}/{28EBE9AE…}/{E99159B4…}/{14E5D79C…}/`. It is used by `CCompInstancePropManager`, `RefDesMgr > ComponentPins@TreeInstanceProxy` and `CircuitParam*`.

## 2. Ports: parent block pins and child hierarchical connectors

**Parent side.** Pins of the `CIITMacroComponent` are ordinary `CIITPinSymbolComp`s with a `CIITPinConnectorComp` whose `ConnectList` points at a `CODPinComp`. The port name is in the pin's net modifier:
```xml
<CIITPinSymbolComp ...> ... <CIITPinConnectorComp ... ptCenterX="36" ptCenterY="54"><ConnectList><Item ID="876921912" Class="CODPinComp"/></ConnectList></CIITPinConnectorComp>
  <CIITPinSymTextCompName Output="&amp;ASCPWM"/> ...
  <ElectricalObject><ModifierInfo><Element NetModifier="&amp;ASCNI_EWB_NET_HIERARCHY_COMP"><Item Value="&amp;ASCPWM" Guid="{93708D8D-…}"/></Element></ModifierInfo></ElectricalObject>
</CIITPinSymbolComp>
```
The Ci side mirrors this: `CiInstComponent > Ports > CiPort@LocalName="PWM"`.

**Child side.** Each port is a `CIITHierConnector` (Type `H_Conn_Prototype`, `ConnectorMode="Input"`/…, `CiComponent=` a type-91 `CiComponent` with `LocalName="PWM"` and template `IO%d`). Its single `CIITPinSymbolComp` carries `NI_EWB_NET_HIERARCHY = PWM`. Position: `Transformer-M20/M21` of the CIITHierConnector, plus the pin's `ptCenterX/Y`. The two `CIITHierConnectorComp` children are just the alternative arrow shapes (`ShapeType` 0/1, `ConnectorShapes`), not electrical.

**Matching is by name.** Parent `NI_EWB_NET_HIERARCHY_COMP` value matches child `NI_EWB_NET_HIERARCHY` value (= CiPort LocalName = child connector CiComponent LocalName). The per-pin GUIDs differ between parent and child (`{93708D8D…}` vs `{781DDE4E…}`), so they are not a link.

## 3. Per-instance refdes (CIR to IR)

Location: `Project > Extensions > Extension[Class=CMultisimExtension] > RefDesMgrs > RefDesMgr[Class=CIITHierRefDesManager] > RefDesInfoContainers > RefDesInfoContainer[@CIR=<CIR path>] > CIRToInfoMap > CIRToInfoMapItem[@CIRKey] > RefDesInfo[@IRPrefix,@IRNumber,@IRSection,@IRSectionID]`.

`CIR` is the drawn refdes ("circuit instance refdes", what `CiComponent@LocalName` holds). `IR` is the final, flattened refdes ("instance refdes", what the `.ewnet` / Ultiboard use). Rules:

- `final = IRPrefix + IRNumber`; when `IRNumber="-1"` the refdes is the bare prefix (`Debug`, which Ultiboard shows as `DEBUG`).
- `CIRKey = CIR refdes + DBComponentSectionName` for multi-section parts (`U8I2C`, `D3A`). Plain `U5` otherwise. `DBComponentSectionName` is on the `CIITSymbolComp`.
- The prefix can change (`SC5→H0`, `U26→J5`, `U20→X1`), `IRNumber` can be 0 (`H0`, `I0`, `A0`), and **root-sheet parts are renumbered too** (1-Wire `C3→C1`, `C4→C2`, `C6→C3`).
- Section remap: one IR part can collect sections from different CIR parts, even on different pages. Althea Main `D3A→D1/A` and `D4A→D1/B`; `U8I2C`, `U10UART0`, `U11GPIO` (page Pi) and `U9Power` (page Power) all become `U1`. Pin numbers are then remapped with `PinNumbersCIR[i] → PinNumbersIR[i]` (D4A: CIR 1,3 become IR 2,3), with `SharedPins` noting shared pins.
- The CIR refdes is scoped to the **page**. Althea Main has `R24` on both Peripherals (→`R3`) and Flashing (→`R19`).
- The SC instances themselves also have IR names (`SC5→H0`), and the flattened net names use them (`H0/SW`).
- `RefDesInfoData@RefDes` repeats the path as a `!0`-separated string: `!0!0!0Q1!0<file>!01!0HalfBridge!0SC1!0<file>!01!01-Wire-HV-AC!0`.
- `CIITSymbolComp@InstanceRefDes` is always `""` in the corpus. **The per-instance names are not on the drawing objects.**

### Worked chain: 1-Wire-HV-AC, child part Q1 on sheet HalfBridge

1. Child page `Title="HalfBridge"` → `CIITSymbolComp CiComponent="972911592"` → `CiComponent LocalName="Q1" InstanceID="{A2CD1932-…}" Circuit="972846248"`.
2. Root page has three macros. The one at (657,468) has `CiComponent="62438952"` → `CiInstComponent LocalName="SC1"`, `SheetComponentObjectID=1499153538` → `CSheetComponentMSM GUID={E99159B4…}`.
3. CIR path = `#1/HalfBridge:SC1` + `#1/1-Wire-HV-AC:` → `RefDesInfoContainer CIR="#1/HalfBridge:SC1#1/1-Wire-HV-AC:"` → `CIRKey="Q1"` → `IRPrefix="Q" IRNumber="1"` → **Q1**. The same key under `…SC2…` gives **Q3**, and under `…SC3…` gives **Q5**.

| instance | U5 | Q1 | Q2 | C5 |
|---|---|---|---|---|
| SC1 | U4 | Q1 | Q2 | C4 |
| SC2 | U5 | Q3 | Q4 | C5 |
| SC3 | U6 | Q5 | Q6 | C6 |

This matches the `.ewnet` exactly: `(instance … "Q3" … (hb_sc_name "SC2"))`.

### GUID cross-check

`CCompInstancePropManager > RefDesGUIDsForSave > Item[@TreeInstanceGuidPath, @CiCompGUID=CiComponent@InstanceID] @InstanceGUID` equals the `.ewnet` `section_guid`. For Q1 under `…/{E99159B4…}/{14E5D79C…}/`, `InstanceGUID={C7447897…}` = ewnet Q1's section_guid. Under SC2's path it is `{46E6E1F1…}` = Q3's, and under SC3's it is `{6C45BFAF…}` = Q5's. Root C3 (`{15E3304D…}`) gives `{EA7B6E2C…}` = ewnet C1. These are stable per-instance UUIDs, which makes them good seeds for KiCad symbol/sheet instance UUIDs.

Other per-instance data:

- `RefDesMgr > ComponentPins > Item[@TreeInstanceProxy]` holds `CSCH_CAPVirtualComponentPin@lastnet`, a cached net per pin per instance. It is not needed and may be stale.
- `CComponentVariantData` on symbols holds variant membership only. No refdes.

## 4. Net names across hierarchy

Net joining is driven by pin/wire `ElectricalObject > ModifierInfo > Element@NetModifier`:

| NetModifier | carried by | scope |
|---|---|---|
| `NI_EWB_NET_GLOBAL` | `CVirtualConnector Global="1"` pins (`Type=NI_EWB_VIRTUAL_GLOBAL`), VCC-type power symbol pins | **whole design, across all instances.** Verified: Heater's HeaterChannel/Detect child sheets use global "Hot"/"Neutral". Scoping globals per instance breaks 3 Heater nets (82/82 → 79/82). |
| `NI_EWB_NET_GLOBAL_GROUND` | ground symbol (value `0`) | whole design |
| `NI_EWB_NET_VIRTUAL` | `CVirtualConnector Global="0"` (on-page connector, `Type=NI_EWB_VIRTUAL_LOCAL`) | one page of one instance |
| `NI_EWB_NET_OFFPAGE` | `CIITOffPageConnector` | all pages of one sheet instance |
| `NI_EWB_NET_HIERARCHY` / `_HIERARCHY_COMP` | child port / parent block pin | parent-child link by name |
| `NI_EWB_NET_BUS_ENTRY` | `CIITBusEntry` (value = bus line name) | bus; see section 6 |
| `NI_EWB_NET_NAME` | wires, a user-assigned net name | naming only (no join needed on any reference) |
| `NI_EWB_NET_AUTONAMED` | wires, value `""` | none |
| `NI_EWB_NET_HIDDEN` | hidden pins (CAN Main, `Mount`) | not handled; 1 case, no reference |

Flattened names in `.ewnet`/`.ewprj`:

- Nets that touch a global or power connector keep that name (`VDD`, `En`, `HV-PWM`).
- Purely local auto-named nets are renumbered globally (`1`…`9`).
- A net where the child port name wins over an unnamed parent net becomes `<IR instance>/<port>`: `SC1/Switch`, `SC2/Switch`, Heater `H0/SW` (SC5 IR = H0), Main `SC9/IO2`. Names are case-folded by Ultiboard.

KiCad will invent its own names, so these rules only matter for cosmetic name fidelity.

## 5. Multi-page designs

Pages are sibling SheetContainers with the same Title. Each has its own CiCircuit and its own RefDesInfoContainer (`#Peripherals/Main:`). Pages are connected by:

- global connectors (design-wide; this is how Althea Main and CAN Main link pages);
- off-page connectors (`NI_EWB_NET_OFFPAGE`, scoped to the instance's sheet);
- bus off-page connectors `CBusOffpageConn` (with buses).

Ordering: the SheetContainer order is not page order (Althea lists Peripherals, Pi, Microprocessor, Motor Driver (child), Power, …). The `ViewState > Path > PathElement@ID` values are `CSheetComponent`/`CSheetComponentMSM` ObjectIDs, giving the UI navigation path. Verified on 3-Phase-Driver (3 pages, off-page connectors and buses): 49/49 nets.

## 6. Traps for a robust flatten

1. **The Ci netlist is not authoritative.** `CiNode@LocalName` can be stale. In 1-Wire-HV-AC, node 873268904 is named "HV-PWM" but holds U1.PA2 + the B-PWM connector. Joining same-name nodes then wrongly merges HV-PWM and B-PWM. Not joining by name loses U2.OUT, which sits in a lone "VCC" node with no symbol. The Ci-based prototype scores 18/22 (no name join) or 20/22 (name join) on 1-Wire-HV-AC. The drawing-ID graph gets 22/22. Also, `CiPort.Nodes` and `CiNode.Ports` disagree in places.
2. Stale `CiInstComponent@SymCompID` (see section 1). Empty macro name labels.
3. CIR names are scoped per page and per instance, never global. Heater has `SC4` (Detect) both at root and inside every HeaterChannel. Only the full CIR path disambiguates.
4. Multi-section parts (section 3): the key is name+section, sections merge across CIR parts and pages, and pins need remapping.
5. Symbol classes that own pins: `CIITSymbolComp`, **`CIITAnimationSymbolComp`** (animated parts such as fuses; Heater's F1–F6 and their pins dropped out as "orphan pins" until this class was added), `CVirtualConnector`, `CIITHierConnector`, `CIITMacroComponent`, `CIITOffPageConnector`, `CBusOffpageConn`, `CIITBusHierConnector`, and `CIITBusEntry` (owns a pin connector but no `CIITPinSymbolComp`).
6. **Bus ports across hierarchy** (`CIITBusHierConnector` with `CIITBusPin`, iCue to 1-Wire child "RGB Led" port "RGB") are **not handled**. My prototype joins bus lines by line name within an instance only. This file has no reference netlist, so it is unverified. Bus lines are also joined by line name only, ignoring which bus. That was fine on 3-Phase-Driver, but is wrong if two buses share line names.
7. Reference-side noise that is not hierarchy:
   - PCB-only pads (`J*.M1..M4`, `Q*.MB`, `M1..M4`, `NB*`)
   - virtual parts not exported (L1 `INDUCTOR_VIRTUAL`, F1 pins `##`)
   - unconnected pins, which are singletons on our side only
   - stale netlists (HV-TPI-ISP `.ewnet` is a month older than the `.ms14`: 5/12; its newer `.ewprj` gives 13/13)
   - Ultiboard pin swaps within a swap group (`CiPort` strings[8] `GRP:A`). See Buttons below.
8. Unused sheets: none found (every SheetContainer title is reachable), but guard for them. Max nesting depth observed: 2.
9. The root title comes from `Project > DesignSheet@Title`, which can equal a multi-page title (`Main`).

## 7. Algorithm (implemented in `scratchpad/hier/drawflat.ts`)

**(a) Unique sheets.** Index each SheetContainer as page = {title, pageName, sheetId, drawing}. Group by title. For each page, walk the drawing once and collect:

- edges: `CIITLinkComp` Connect1/Connect2; `CODPinComp` and `CIITPinConnectorComp` ConnectList; a pin connector's link to its `CIITPinSymbolComp`/`CIITBusEntry`;
- pins: `CIITPinSymbolComp` with owner symbol, `PortID`, `PinNumber`, `PinName` and net modifiers;
- symbols, by class, with `CiComponent`;
- link/bus-entry modifiers.

Also index all `Ci*` items by CiID, `CSheetComponent*` by ObjectID, and RefDesInfoContainers by CIR (key to IR, plus pin remaps).

**(b) Instance tree.** `expand(title, path, cirOf(page), parentPortKeys)`, starting at the root title with `cirOf = p => "#"+p+"/"+title+":"`. For each page of the sheet, for each `CIITMacroComponent`:

- `inst = Ci[macro@CiComponent].LocalName`
- `child = CHierBlock@FileName || CSheetComponentMSM[macro@SheetComponentObjectID]@SheetName`
- `childCir = p => "#"+p+"/"+child+":"+inst + cirOf(thisPage)`
- `portKeys = {pin.NET_HIERARCHY_COMP value -> node key of that block pin}`

Then recurse. The refdes map for a part on a page is `irMap[cirOf(page)][LocalName + DBComponentSectionName]`, falling back to the CIR name at root.

**(c) Flattened netlist.** Use one union-find over keys `path|page|elementId`:

- union every drawing edge;
- GLOBAL/GROUND pins → `G:<NAME>`;
- VIRTUAL → `path|page|ONPAGE:<n>`;
- OFFPAGE → `path|OFFPAGE:<n>`;
- BUS_ENTRY → `path|BUSLINE:<n>`;
- HIERARCHY pin → the parent's block-pin key for that name.

Part pins (`CIITSymbolComp`/`CIITAnimationSymbolComp` whose CiComponent isn't a power/connector type) contribute `(IR refdes, pin)`, where the pin number comes from `CiPort` strings[6] (CSV, so multi-pin ports work), then the section remap, then fallback `@PinNumber`. Each union-find root is a net.

### Verification

Pin partitions only, case-insensitive refdes. Pins present on only one side and singleton nets are dropped ("shared-pin view"):

| design | reference | hierarchy | nets identical |
|---|---|---|---|
| 1-Wire-HV-AC | .ewnet | 3x SC | **21/21** (also raw: 22/22 ewnet nets, the only extra is unconnected U1.7; L1 virtual not exported) |
| 1-Wire-HV-AC | .ewprj | 3x SC | 21/21 |
| Brain Adapter | .ewnet and .ewprj | 10x SC | 14/14 |
| Althea Main | .ewprj | 5 pages, 10 SC, multi-section across pages | 96/96 |
| Althea Heater | .ewprj | 23 instances, nested depth 2 | 82/82 |
| Althea PCB.old Main / Heater | .ewprj | | 88/88, 76/76 |
| Pressure Servo (x2 copies) | .ewprj | 3 pages, 4 SC, `IRNumber=-1` | 56/56, refdes 73/73 |
| 3-Phase-Driver @113bacc (.ms13) | .ewprj | 3 pages, off-page, buses | 49/49 |
| LED-Delay, 1-Wire iCue, Fan Control (flat) | ewnet/ewprj | – | 7/7, 26/26, 7/7 |
| **Althea Buttons** | .ewprj | 5x SC | **15/23**: mismatch |
| **Althea PCB.old Buttons** | .ewprj | 5x SC | **17/22**: mismatch |
| HV-TPI-ISP | .ewnet (stale) / .ewprj | flat | 5/12 / 13/13 |

**Mismatches, stated honestly.** Both Buttons designs differ only in **connector pin numbers**. The parts are J1/J2 (= `J4` inside the Button SC) and J3: the PCB has pins permuted (e.g. B2/I on J2.4 in the PCB vs J2.7 in the schematic; J3 pins 1↔4 and 2↔3). Everything else, including all instance refdes, matches. The ports carry swap group `GRP:A` and the netlists declare `(pinswap 1)`, so the most likely cause is Ultiboard pin-swapping not back-annotated to the schematic. It could also be a footprint pin map that lives outside the `.ms14`. I did not prove which. The PCB.old Buttons `.ewnet` (older still) also shows LED pins `C` vs the symbol's `K`, which is the same class of symbol-vs-pad numbering. No mismatch anywhere traces back to hierarchy/refdes/port handling.

**Not verified (no reference netlist):** iCue to 1-Wire, which has a bus hierarchical port (section 6.6); CAN Main multi-page, which flattens with one warning (`NI_EWB_NET_HIDDEN=Mount`, ignored); HB (`Subcircuit="0"`) files.

## 8. Implications for KiCad emission

- One KiCad `.kicad_sch` per unique sheet *page*. A multi-page Multisim sheet becomes several KiCad sheets under a common parent. `CIITMacroComponent` becomes a KiCad sheet symbol, block pins become sheet pins, and `CIITHierConnector` becomes a hierarchical label, matched by name.
- Global connectors and power become global labels / power symbols. On-page connectors become local labels. Off-page connectors become hierarchical labels bubbled to the page wrapper, or global labels when the multi-page sheet is the root and names don't clash.
- Per-instance refdes goes into the KiCad `(instances (project … (path "/<rootUUID>/<sheetInstUUID>…" (reference "Q3") (unit N))))`, using the IR map and IRSection → unit. Derive UUIDs deterministically from `CSheetComponentMSM@GUID` (sheet instances) and `CCompInstancePropManager@InstanceGUID` (symbol instances).
- Verify the emitted project with `kicad-cli sch export netlist` against the same references. `drawflat.ts` is the oracle for designs without one.
