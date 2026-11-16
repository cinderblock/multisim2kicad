# Issues

Side issues found while working on something else. Each is a seed for a separate fix.

## Schematics don't open in KiCad 9

**Deferred** (user, 2026-11-15): KiCad 10 only for now. Pick this up only if testers ask for KiCad 9.

`src/emit/kicad-sch.ts` writes `.kicad_sch` / `.kicad_sym` with `(version 20250610)`, a KiCad 10
development-cycle format. KiCad 9's newest is `20250114` (sch) / `20241209` (sym), per
`eeschema/sch_file_versions.h` on the `9.0` branch, so KiCad 9 refuses our schematics.
Boards (`20240108`) are fine. Many forum users are still on KiCad 9.

To fix: check which post-`20250114` features the emitter uses. "~ no longer means empty text"
(20250318) changes what `~` means, and local power symbols are 20250227. Then either emit
`20250114` everywhere, or add a `--kicad 9` option. Needs a KiCad 9 `kicad-cli` to verify (only
10.0 and 6.0 are installed).
