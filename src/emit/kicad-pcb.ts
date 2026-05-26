import type { Board } from "../ir/types.ts";

// KiCad 7 format version: stable, broadly compatible with 7 / 8 / 9.
// Bump once we've round-tripped through a newer release.
const KICAD_VERSION = 20221018;

type LayerRow = readonly [number, string, "signal" | "user" | "power" | "mixed" | "jumper", string?];

// Standard 2-copper-layer KiCad stack with all canonical tech / user layers.
// Inner copper layers (In1.Cu..In30.Cu, IDs 1..30) are omitted for now.
const STANDARD_LAYERS: readonly LayerRow[] = [
  [0,  "F.Cu",      "signal"],
  [31, "B.Cu",      "signal"],
  [32, "B.Adhes",   "user", "B.Adhesive"],
  [33, "F.Adhes",   "user", "F.Adhesive"],
  [34, "B.Paste",   "user"],
  [35, "F.Paste",   "user"],
  [36, "B.SilkS",   "user", "B.Silkscreen"],
  [37, "F.SilkS",   "user", "F.Silkscreen"],
  [38, "B.Mask",    "user"],
  [39, "F.Mask",    "user"],
  [40, "Dwgs.User", "user", "User.Drawings"],
  [41, "Cmts.User", "user", "User.Comments"],
  [42, "Eco1.User", "user", "User.Eco1"],
  [43, "Eco2.User", "user", "User.Eco2"],
  [44, "Edge.Cuts", "user"],
  [45, "Margin",    "user"],
  [46, "B.CrtYd",   "user", "B.Courtyard"],
  [47, "F.CrtYd",   "user", "F.Courtyard"],
  [48, "B.Fab",     "user"],
  [49, "F.Fab",     "user"],
];

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function emitKicadPcb(board: Board): string {
  const layerLines = STANDARD_LAYERS.map(([num, name, type, friendly]) => {
    return friendly
      ? `\t\t(${num} ${q(name)} ${type} ${q(friendly)})`
      : `\t\t(${num} ${q(name)} ${type})`;
  }).join("\n");

  const importNote =
    `Imported from ${board.source.application} ` +
    `${board.source.versionMajor}.${board.source.versionMinor} via ew-conv`;

  return [
    `(kicad_pcb`,
    `\t(version ${KICAD_VERSION})`,
    `\t(generator ${q("ew-conv")})`,
    ``,
    `\t(general`,
    `\t\t(thickness 1.6)`,
    `\t)`,
    ``,
    `\t(paper ${q("A4")})`,
    ``,
    `\t(title_block`,
    `\t\t(title ${q(board.projectName)})`,
    `\t\t(comment 1 ${q(importNote)})`,
    `\t)`,
    ``,
    `\t(layers`,
    layerLines,
    `\t)`,
    ``,
    `\t(setup`,
    `\t\t(pad_to_mask_clearance 0)`,
    `\t)`,
    ``,
    `\t(net 0 ${q("")})`,
    `)`,
    ``,
  ].join("\n");
}
