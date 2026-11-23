# Launch post drafts (early testers)

Drafts for the user to review. **Nothing here is posted without the user's
yes for that specific post.** Numbers are from the 2026-11-22 corpus run
(`out/corpus-2026-11-22/report.md`). Post only after 0.2.2 is on npm, so
`npx` gets the scorecard fixes.

---

## 1. KiCad forum: new topic

**Category:** (pick on posting: the projects/show-and-tell or "Software" category)

**Title:** multisim2kicad: NI Multisim / Ultiboard to KiCad converter (testers wanted)

**Body:**

I've seen Multisim conversion come up here before without a working answer
(e.g. https://forum.kicad.info/t/convert-multisim-14/38339), so I wrote an
open-source converter for NI Electronics Workbench projects:

https://github.com/cinderblock/multisim2kicad

It turns Multisim schematics (`.ms10` to `.ms14`) into `.kicad_sch` with full
sheet hierarchy, and Ultiboard `.ewprj` boards into `.kicad_pcb` with pads,
tracks, vias, zones, inner layers, and design rules. A matching schematic and
board become one linked project so "Update PCB from Schematic" works, alongside
project symbol/footprint libraries and SPICE models for simulation. Output
schematics are KiCad 10 only.

Run it with Node 20+:

```
npx multisim2kicad -o converted/ path/to/project-folder/
```

Across my 299 test designs (mostly mine, plus NI's sample circuits), every
output loads in KiCad. All 4263 schematic nets match Multisim's netlist
exactly, and 12455 of 12458 PCB net pins land on a pad. The other 3 don't have
a pad in the original Ultiboard board either. The converter doesn't invent
copper; it warns about those pins and about parts that were never placed.

Because most of those files are my own, I'm looking for other people's projects
to break it on. If you hit a snag with a private design, the repo's issue form
explains how to report it without sharing your files.

For older Ultiboard 4/5 `.ddf` boards, see KIUB instead:
https://forum.kicad.info/t/ulticap-sch-and-ultiboard-ddf-to-kicad-converter/71177

---

## 2. KiCad forum: reply in the KIUB thread

**Dropped** (user, 2026-11-18): the thread is closed, so replies aren't possible.

https://forum.kicad.info/t/ulticap-sch-and-ultiboard-ddf-to-kicad-converter/71177

Nice work. This fills the gap for the old Ultimate-era files. For anyone who
lands here with newer NI files: I've been working on the other end,
Multisim `.ms1x` schematics and Ultiboard `.ewprj` boards (Ultiboard 2001 and
later) to KiCad: https://github.com/cinderblock/multisim2kicad. Between the
two tools, most Ultiboard generations should now have a path into KiCad. My
README points `.ddf` users to KIUB.

---

## 3. EEVblog: new topic in EDA

**Title:** Open-source Multisim / Ultiboard to KiCad converter (looking for test designs)

**Body:**

Back in 2018 someone asked here whether a Multisim/Ultiboard-to-KiCad converter
existed (https://www.eevblog.com/forum/eda/20-years-with-ultiboard-what-next/).
Nobody had an answer then, and as far as I could tell nobody built one since,
so I wrote one:

https://github.com/cinderblock/multisim2kicad

With Node 20+, run:

```
npx multisim2kicad -o out/ MyDesign.ms14 MyDesign.ewprj
```

That gives you a linked KiCad 10 project: hierarchical schematic, board (pads,
tracks, vias, pours, inner layers, design rules), project libraries, and SPICE
models.

On 299 test designs, every output loads in KiCad, all 4263 schematic nets match
Multisim's netlist exactly, and 12455 of 12458 PCB net pins land on a pad.
Those 3 have no pad in the original Ultiboard board either. Rather than
inventing copper, it warns about those pins and about parts that were never
placed.

Most of those 299 designs are mine, so I'm looking for other people's archives
to shake out edge cases. There's an issue form in the repo for reporting a bad
conversion without sharing a private design.

Limits: schematics need KiCad 10, and no pre-Multisim-10 or Ultiboard 4/5 `.ddf` support
(see KIUB for `.ddf`: https://github.com/Snieffy/KIUB).
