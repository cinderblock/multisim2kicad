# Launch post drafts (early testers)

Drafts for the user to review. **Nothing here is posted without the user's
yes for that specific post.** Numbers are from the 2026-11-15 corpus run
(`out/corpus-2026-11-15/report.md`). Post only after 0.2.1 is on npm, so
`npx` gets the CLI fixes.

---

## 1. KiCad forum: new topic

**Category:** (pick on posting: the projects/show-and-tell or "Software" category)

**Title:** multisim2kicad: convert NI Multisim / Ultiboard projects to KiCad (testers wanted)

**Body:**

I've written an open-source converter that turns NI Electronics Workbench
designs into KiCad projects:

- Multisim schematics (`.ms10`–`.ms14`) → `.kicad_sch`, with the full sheet hierarchy
- Ultiboard boards (`.ewprj`) → `.kicad_pcb` (pads, tracks, vias, zones, inner layers, design rules)
- A schematic and board with the same name become one linked project ("Update PCB from Schematic" works)
- Project symbol / footprint libraries, and SPICE models for simulation

Usage (Node 20+):

```
npx multisim2kicad -o converted/ path/to/project-folder/
```

You need **KiCad 10** to open the schematics.

On my test set (299 designs, including NI's own sample circuits), every output
loads in KiCad. 4232 of 4244 schematic nets match Multisim's netlist exactly,
and 99.4% of PCB net pins land on a pad.

Most of those designs are my own, though, so I'm looking for people with
Multisim / Ultiboard files to try it and tell me what breaks. There's an issue
form that explains how to report a problem without sharing a private design.

Repo: https://github.com/cinderblock/multisim2kicad

This has come up here before without a good answer, e.g.
https://forum.kicad.info/t/convert-multisim-14/38339. For older Ultiboard
4/5 `.ddf` boards, see KIUB:
https://forum.kicad.info/t/ulticap-sch-and-ultiboard-ddf-to-kicad-converter/71177

---

## 2. KiCad forum: reply in the KIUB thread

https://forum.kicad.info/t/ulticap-sch-and-ultiboard-ddf-to-kicad-converter/71177

Nice work. This fills the gap for the old Ultimate-era files. For anyone who
lands here with newer NI files: I've been working on the other end,
Multisim `.ms1x` schematics and Ultiboard `.ewprj` boards (Ultiboard 2001 and
later) to KiCad: https://github.com/cinderblock/multisim2kicad. Between the
two tools, most Ultiboard generations should now have a path into KiCad. My
README points `.ddf` users to KIUB.

---

## 3. EEVblog: new topic in EDA

**Title:** Converting Multisim / Ultiboard designs to KiCad: open-source converter, testers wanted

**Body:**

A while back someone asked in
https://www.eevblog.com/forum/eda/20-years-with-ultiboard-what-next/ (last
post, 2018) whether any converter from Ultiboard/Multisim to KiCad existed.
Nobody answered, and as far as I can tell there still wasn't one, so I wrote one:
https://github.com/cinderblock/multisim2kicad

`npx multisim2kicad -o out/ MyDesign.ms14 MyDesign.ewprj` produces a linked
KiCad 10 project: the schematic with its hierarchy, the board with pads,
tracks, vias, pours, inner layers and design rules, project libraries, and
SPICE models.

On 299 test designs, everything loads, 99.7% of schematic nets match
Multisim's netlist exactly, and 99.4% of PCB net pins land on a pad. Most of
those designs are my own, though, so I'd love reports from anyone with a
stack of old Multisim/Ultiboard projects. The README explains how to report
a bad conversion without sharing the design.

Limitations: schematics need KiCad 10. Pre-Multisim-10 files and Ultiboard
4/5 `.ddf` aren't supported (KIUB handles `.ddf`:
https://github.com/Snieffy/KIUB).
