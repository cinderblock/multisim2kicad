/**
 * Ultiboard layer numbers -> KiCad layers, per board.
 *
 * Copper comes from the board's stackup (EW 0 = F.Cu, EW 1..n = In1..In n.Cu,
 * EW 63 = B.Cu). Technical layers map one to one. Layers with no KiCad
 * counterpart that carry drawings (3D outlines, mechanical layers, the
 * per-design custom layers 93+) get KiCad user layers named after the EW
 * layer, in EW layer order. EW-internal layers (ratsnest, DRC markers, force
 * vectors) are dropped. See plans/converter.md, phase C3.
 */
import type { Board } from "../ir/types.ts";

export type KicadLayerType = "signal" | "user";

export interface KicadLayer {
  /** KiCad 8 layer id (F.Cu 0, In1..In30 1..30, B.Cu 31, technical 32+). */
  id: number;
  name: string;
  type: KicadLayerType;
  /** Display name shown in KiCad (user layers carry the EW layer name). */
  userName?: string;
}

const TECHNICAL: readonly KicadLayer[] = [
  { id: 32, name: "B.Adhes", type: "user", userName: "B.Adhesive" },
  { id: 33, name: "F.Adhes", type: "user", userName: "F.Adhesive" },
  { id: 34, name: "B.Paste", type: "user" },
  { id: 35, name: "F.Paste", type: "user" },
  { id: 36, name: "B.SilkS", type: "user", userName: "B.Silkscreen" },
  { id: 37, name: "F.SilkS", type: "user", userName: "F.Silkscreen" },
  { id: 38, name: "B.Mask", type: "user" },
  { id: 39, name: "F.Mask", type: "user" },
  { id: 40, name: "Dwgs.User", type: "user", userName: "User.Drawings" },
  { id: 41, name: "Cmts.User", type: "user", userName: "User.Comments" },
  { id: 42, name: "Eco1.User", type: "user", userName: "User.Eco1" },
  { id: 43, name: "Eco2.User", type: "user", userName: "User.Eco2" },
  { id: 44, name: "Edge.Cuts", type: "user" },
  { id: 45, name: "Margin", type: "user" },
  { id: 46, name: "B.CrtYd", type: "user", userName: "B.Courtyard" },
  { id: 47, name: "F.CrtYd", type: "user", userName: "F.Courtyard" },
  { id: 48, name: "B.Fab", type: "user" },
  { id: 49, name: "F.Fab", type: "user" },
];
const USER_SLOTS = 9; // User.1..User.9 (ids 50..58) in the KiCad 8 format

/** EW technical layers with a direct KiCad equivalent. */
const FIXED: Record<number, string> = {
  65: "Edge.Cuts",
  66: "F.SilkS",
  67: "B.SilkS",
  70: "F.Paste",
  71: "B.Paste",
  72: "F.Mask",
  73: "B.Mask",
  74: "F.Adhes",
  75: "B.Adhes",
  76: "F.Fab",
  77: "B.Fab",
  81: "Cmts.User",
  92: "F.CrtYd",
};

const COURTYARD = 92;

/** EW-internal layers: never emitted. */
const DROPPED = new Set([64, 78, 79, 80, 511]);

/** The KiCad copper layer name for a 0-based position in an n-layer stack. */
const copperName = (i: number, n: number) => (i === 0 ? "F.Cu" : i === n - 1 ? "B.Cu" : `In${i}.Cu`);

export class LayerMap {
  /** Copper layer names, top to bottom. */
  readonly copper: string[];
  /** Layer table for the board file. */
  readonly table: KicadLayer[];
  /** EW layers that carried drawings but were not emitted, with counts. */
  readonly dropped = new Map<number, number>();
  private readonly map = new Map<number, string>();

  constructor(board: Board) {
    const n = board.stackup.copper.length;
    this.copper = board.stackup.copper.map((_, i) => copperName(i, n));
    board.stackup.copper.forEach((ew, i) => this.map.set(ew, this.copper[i]!));
    const copperTable: KicadLayer[] = this.copper.map((name, i) => ({
      id: i === n - 1 ? 31 : i,
      name,
      type: "signal",
    }));
    for (const [ew, name] of Object.entries(FIXED)) this.map.set(Number(ew), name);

    // User layers for drawing layers without a KiCad equivalent, by EW number.
    const used = new Set<number>([
      ...board.shapes.map((s) => s.layer),
      ...board.texts.map((t) => t.layer),
      ...board.components.flatMap((c) => [...c.graphics.map((g) => g.layer), ...c.texts.map((t) => t.layer)]),
    ]);
    const ewName = new Map(board.layers.map((l) => [l.number, l.name]));
    const wanted = [...used]
      .filter((l) => !this.map.has(l) && !DROPPED.has(l) && !(l >= 0 && l <= 63))
      .sort((a, b) => a - b);
    const user: KicadLayer[] = [];
    for (const ew of wanted) {
      if (user.length < USER_SLOTS) {
        const name = `User.${user.length + 1}`;
        user.push({ id: 50 + user.length, name, type: "user", userName: ewName.get(ew) || `EW layer ${ew}` });
        this.map.set(ew, name);
      } else {
        // Out of user layers: fold the rest onto Dwgs.User.
        this.map.set(ew, "Dwgs.User");
      }
    }
    this.table = [...copperTable, ...TECHNICAL, ...user];
  }

  /** KiCad layer for an EW layer, or undefined if it is not emitted. */
  kicad(ew: number): string | undefined {
    const k = this.map.get(ew);
    if (k === undefined) this.dropped.set(ew, (this.dropped.get(ew) ?? 0) + 1);
    return k;
  }

  /**
   * KiCad layer for a drawing inside a part. EW draws courtyards of both
   * sides on its one courtyard layer (92); bottom parts get B.CrtYd.
   */
  kicadInPart(ew: number, bottom: boolean): string | undefined {
    if (bottom && ew === COURTYARD) return "B.CrtYd";
    return this.kicad(ew);
  }

  isCopper(name: string | undefined): boolean {
    return name !== undefined && this.copper.includes(name);
  }
}
