import type { Schematic } from "../ir/types.ts";

// KiCad 8 schematic format. KiCad 10 reads it without complaint
// (offers to upgrade on save, harmless).
const KICAD_SCH_VERSION = 20231120;

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function uuid(): string {
  return crypto.randomUUID();
}

export function emitKicadSch(sch: Schematic): string {
  const importNote =
    `Imported from ${sch.source.application} ` +
    `${sch.source.versionMajor}.${sch.source.versionMinor} via ew-conv`;

  return [
    `(kicad_sch`,
    `\t(version ${KICAD_SCH_VERSION})`,
    `\t(generator ${q("ew-conv")})`,
    `\t(generator_version ${q("0.0")})`,
    `\t(uuid ${q(uuid())})`,
    `\t(paper ${q("A4")})`,
    ``,
    `\t(title_block`,
    `\t\t(title ${q(sch.projectName)})`,
    `\t\t(comment 1 ${q(importNote)})`,
    `\t)`,
    ``,
    `\t(lib_symbols)`,
    ``,
    `\t(sheet_instances`,
    `\t\t(path "/" (page "1"))`,
    `\t)`,
    `)`,
    ``,
  ].join("\n");
}
