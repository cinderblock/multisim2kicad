// EW Ultiboard layer number -> KiCad canonical layer name.
// Only layers with a direct KiCad equivalent are mapped; the rest
// are silently dropped at emit time (caller can count them).
//
// Verified from Temp.ewprj.xml and Design1.ewprj.xml. Both files
// share Ultiboard's identical default 2-layer layer table.

const MAP: Record<number, string> = {
  0:  "F.Cu",
  63: "B.Cu",
  65: "Edge.Cuts",
  66: "F.SilkS",
  67: "B.SilkS",
  70: "F.Paste",
  71: "B.Paste",
  72: "F.Mask",
  73: "B.Mask",
  81: "Cmts.User",
  82: "User.1",  // Mechanical Layer 1
  83: "User.2",  // Mechanical Layer 2
  84: "User.3",  // Mechanical Layer 3
  85: "User.4",  // Mechanical Layer 4
};

export function ewLayerToKicad(num: number): string | undefined {
  return MAP[num];
}
