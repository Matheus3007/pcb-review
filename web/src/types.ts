// Review bundle format (schema 1). Source of truth for exporter <-> web.
// Coordinates: mm, board-relative (board.yaml origin subtracted), +Y down, rotations CCW degrees
// (KiCad convention). Documented in docs/bundle-format.md.

export type XY = [number, number];

export interface Bundle {
  schema: 1;
  name: string;
  generated: string;                 // ISO timestamp
  source: { board_dir: string; kicad_pcb: string }; // relative to the pcb-lab root
  origin: XY;                        // absolute KiCad coords of board (0,0): subtract from DRC positions
  thickness: number;                 // mm
  bbox: [number, number, number, number]; // x0,y0,x1,y1 of the outline
  outline: XY[][];                   // Edge.Cuts polygons; first = outer
  layers: Layer[];                   // copper layers, top to bottom
  nets: string[];                    // all net names ("" excluded)
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  footprints: Footprint[];
  parts: Record<string, Part>;       // keyed by LCSC number (e.g. "C529358")
  bom: BomRow[];
  reports: { checks?: unknown; drc?: unknown; summary_md?: string };
  pinindex?: string;                 // relative path to pinindex.json
}

export interface Layer { id: string; name: string; index: number; side: "top" | "inner" | "bottom" }

export interface Track { layer: string; net: string; width: number; start: XY; end: XY; mid?: XY /* arcs */ }

export interface Via { at: XY; size: number; drill: number; layers: [string, string]; net: string }

export interface Zone { layer: string; net: string; polygons: XY[][] /* filled copper, outer rings */ }

export interface Pad {
  num: string;                       // pad number ("1", "A5", "EP"...)
  pin?: string;                      // pin name from netlist.json (e.g. "PA9"), if known
  net: string;                       // "" if unconnected
  at: XY;                            // absolute board coords
  rot: number;                       // absolute rotation, degrees CCW
  shape: "rect" | "roundrect" | "circle" | "oval" | "custom" | "trapezoid" | "chamfered_rect";
  size: XY;                          // before rotation
  layers: string[];                  // copper layers this pad is on (expanded, e.g. all 4 for THT)
  drill?: number | XY;               // THT only
  polygon?: XY[];                    // custom pads: absolute outline
  roundrect_ratio?: number;
}

export interface Footprint {
  ref: string;
  value: string;
  footprint: string;                 // "Lib:Name"
  lcsc?: string;
  mpn?: string;
  side: "top" | "bottom";
  at: XY;
  rot: number;
  dnp: boolean;
  courtyard?: [number, number, number, number]; // absolute bbox
  silk?: XY[][];                     // absolute polylines (F/B.SilkS + Fab outline), optional
  pads: Pad[];
  models: Model3D[];
}

export interface Model3D {
  glb?: string;                      // relative path in bundle (models/*.glb); absent -> box fallback
  source: string;                    // original model path from the kicad_pcb
  offset: [number, number, number];  // mm, KiCad (model) convention
  rotate: [number, number, number];  // degrees
  scale: [number, number, number];
  body?: { size: [number, number, number] }; // fallback box size (mm) when no glb
}

export interface Part {
  lcsc: string;
  mpn?: string;
  value?: string;
  refs: string[];
  datasheet?: { file?: string; url?: string }; // file = bundled PDF (relative); url = external link
  lcsc_url: string;                  // https://www.lcsc.com/product-detail/<lcsc>.html
  jlc_url: string;
  pinout_source?: string;
}

export interface BomRow { comment: string; refs: string[]; footprint: string; lcsc: string }

// pinindex.json: { [lcsc]: PinIndexPart }
export interface PinIndexPart {
  pages: number;
  pins: Record<string, PinHit[]>;    // key: pin name (e.g. "PA9")
  pads?: Record<string, PinHit[]>;   // key: pad number (parts with <= 16 pads): its cell in the pin table
}
export interface PinHit {
  page: number;                      // 1-based
  kind: "pintable" | "pinout" | "description" | "other";
  score: number;                     // higher = better; hits sorted best-first
  boxes: [number, number, number, number][]; // PDF points, origin top-left (x0,y0,x1,y1)
}
