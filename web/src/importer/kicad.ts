// .kicad_pcb -> review geometry, in the browser. Port of exporter/kicad.py: the output must match
// it (web/src/types.ts; parity test in importer.test.ts). mm, board-relative, +Y down, CCW degrees.
import type { Footprint, Layer, Model3D, Pad, Track, Via, XY, Zone } from "../types";
import { child, children, floats, hasAtom, parse, value, type Node } from "./sexp";

const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0; // + 0 turns -0 into 0

/** KiCad rotation: CCW on screen with +Y down. */
export function rotate(x: number, y: number, deg: number): XY {
  if (!deg) return [x, y];
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c + y * s, -x * s + y * c];
}

function copperLayers(root: Node): Layer[] {
  const names: string[] = [];
  for (const e of child(root, "layers")!.slice(1)) {
    if (Array.isArray(e) && e.length >= 3 && typeof e[1] === "string" && e[1].endsWith(".Cu")) names.push(e[1]);
  }
  const order = (n: string) => (n === "F.Cu" ? 0 : n === "B.Cu" ? 10_000 : parseInt(n.slice(2, -3), 10));
  names.sort((a, b) => order(a) - order(b));
  return names.map((id, index) => ({
    id, name: id.replace(/\.Cu$/, ""), index, side: id === "F.Cu" ? "top" : id === "B.Cu" ? "bottom" : "inner",
  }));
}

function expandLayers(layers: string[], copper: string[]): string[] {
  const out: string[] = [];
  for (const l of layers) {
    if (l === "*.Cu") out.push(...copper);
    else if (l === "F&B.Cu") out.push(...["F.Cu", "B.Cu"].filter((c) => copper.includes(c)));
    else if (copper.includes(l)) out.push(l);
  }
  return [...new Set(out)];
}

export function arcPoints(start: XY, mid: XY, end: XY, segLen = 0.25): XY[] {
  const [x1, y1] = start, [x2, y2] = mid, [x3, y3] = end;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-12) return [start, end];
  const ux = ((x1 ** 2 + y1 ** 2) * (y2 - y3) + (x2 ** 2 + y2 ** 2) * (y3 - y1) + (x3 ** 2 + y3 ** 2) * (y1 - y2)) / d;
  const uy = ((x1 ** 2 + y1 ** 2) * (x3 - x2) + (x2 ** 2 + y2 ** 2) * (x1 - x3) + (x3 ** 2 + y3 ** 2) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy);
  const [a1, a2, a3] = [start, mid, end].map((p) => Math.atan2(p[1] - uy, p[0] - ux));
  const ccw = (a: number, b: number) => (((b - a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = ccw(a1, a3);
  if (ccw(a1, a2) > sweep) sweep -= 2 * Math.PI;
  const n = Math.max(2, Math.floor((Math.abs(sweep) * r) / segLen) + 1);
  return Array.from({ length: n + 1 }, (_, i) => [ux + r * Math.cos(a1 + (sweep * i) / n), uy + r * Math.sin(a1 + (sweep * i) / n)] as XY);
}

const xy = (n: Node | undefined, tag: string): XY => floats(n, tag).slice(0, 2) as XY;

function pts(node: Node): XY[] {
  const p = child(node, "pts");
  const out: XY[] = [];
  for (const e of p ? p.slice(1) : []) {
    if (!Array.isArray(e)) continue;
    if (e[0] === "xy") out.push([Number(e[1]), Number(e[2])]);
    else if (e[0] === "arc") {
      const a = arcPoints(xy(e, "start"), xy(e, "mid"), xy(e, "end"));
      out.push(...(out.length ? a.slice(0, -1) : a));
    }
  }
  return out;
}

/** Local-coordinate polylines for gr_/fp_ line, rect, circle, arc, poly. */
function graphicPolylines(node: Node): XY[][] {
  const tag = (node[0] as string).slice(3);
  if (tag === "line") return [[xy(node, "start"), xy(node, "end")]];
  if (tag === "rect") {
    const [x1, y1] = xy(node, "start"), [x2, y2] = xy(node, "end");
    return [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]];
  }
  if (tag === "circle") {
    const [cx, cy] = xy(node, "center"), [ex, ey] = xy(node, "end");
    const r = Math.hypot(ex - cx, ey - cy);
    return [Array.from({ length: 33 }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / 32), cy + r * Math.sin((2 * Math.PI * i) / 32)] as XY)];
  }
  if (tag === "arc") return [arcPoints(xy(node, "start"), xy(node, "mid"), xy(node, "end"))];
  if (tag === "poly") {
    const p = pts(node);
    return p.length ? [[...p, p[0]]] : [];
  }
  return [];
}

function chainOutline(segments: XY[][], tol = 1e-3): XY[][] {
  const segs = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const loops: XY[][] = [];
  while (segs.length) {
    let loop = segs.shift()!;
    let changed = true;
    while (changed && dist(loop[0], loop[loop.length - 1]) > tol) {
      changed = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (dist(loop[loop.length - 1], s[0]) <= tol) loop = loop.concat(s.slice(1));
        else if (dist(loop[loop.length - 1], s[s.length - 1]) <= tol) loop = loop.concat([...s].reverse().slice(1));
        else continue;
        segs.splice(i, 1);
        changed = true;
        break;
      }
    }
    loops.push(loop);
  }
  return loops;
}

function area(loop: XY[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function refKey(ref: string): [string, number] {
  const m = /^(.*?)(\d*)$/.exec(ref)!;
  return [m[1], m[2] ? parseInt(m[2], 10) : 0];
}

export interface Geometry {
  thickness: number;
  origin: XY;
  bbox: [number, number, number, number];
  outline: XY[][];
  layers: Layer[];
  nets: string[];
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  footprints: (Footprint & { lcsc?: string })[];
}

export function parsePcb(text: string, origin?: XY): Geometry {
  const root = parse(text);
  const layers = copperLayers(root);
  const copper = layers.map((l) => l.id);

  const edge: XY[][] = [];
  for (const tag of ["gr_line", "gr_arc", "gr_rect", "gr_circle", "gr_poly"]) {
    for (const g of children(root, tag)) if (value(g, "layer") === "Edge.Cuts") edge.push(...graphicPolylines(g));
  }
  const loops = chainOutline(edge).sort((a, b) => area(b) - area(a));
  if (!origin) {
    // no board.yaml: the outline's top-left corner, as the exporter does
    const all = loops.flat();
    origin = all.length ? [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))] : [0, 0];
  }
  const [ox, oy] = origin;
  const P = (x: number, y: number): XY => [r4(x - ox), r4(y - oy)];

  const outline = loops.map((lp) => lp.map((p) => P(p[0], p[1])));
  const allp = outline.flat();
  const bbox: [number, number, number, number] = allp.length
    ? [Math.min(...allp.map((p) => p[0])), Math.min(...allp.map((p) => p[1])), Math.max(...allp.map((p) => p[0])), Math.max(...allp.map((p) => p[1]))]
    : [0, 0, 0, 0];

  const tracks: Track[] = [];
  for (const s of children(root, "segment")) {
    tracks.push({ layer: value(s, "layer")!, net: value(s, "net") ?? "", width: Number(value(s, "width")), start: P(...xy(s, "start")), end: P(...xy(s, "end")) });
  }
  for (const s of children(root, "arc")) {
    tracks.push({ layer: value(s, "layer")!, net: value(s, "net") ?? "", width: Number(value(s, "width")), start: P(...xy(s, "start")), mid: P(...xy(s, "mid")), end: P(...xy(s, "end")) });
  }

  const vias: Via[] = [];
  for (const v of children(root, "via")) {
    const ls = child(v, "layers")!.slice(1) as string[];
    vias.push({ at: P(...xy(v, "at")), size: Number(value(v, "size")), drill: Number(value(v, "drill")), layers: [ls[0], ls[ls.length - 1]], net: value(v, "net") ?? "" });
  }

  const zones: Zone[] = [];
  for (const z of children(root, "zone")) {
    const net = value(z, "net") ?? "";
    const byLayer = new Map<string, XY[][]>();
    for (const fp of children(z, "filled_polygon")) {
      const l = value(fp, "layer")!;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(pts(fp).map((p) => P(p[0], p[1])));
    }
    for (const [layer, polygons] of byLayer) zones.push({ layer, net, polygons });
  }

  const footprints = children(root, "footprint").map((f) => footprint(f, copper, P));
  footprints.sort((a, b) => {
    const [pa, na] = refKey(a.ref), [pb, nb] = refKey(b.ref);
    return pa < pb ? -1 : pa > pb ? 1 : na - nb;
  });

  const netSet = new Set<string>();
  for (const t of tracks) netSet.add(t.net);
  for (const v of vias) netSet.add(v.net);
  for (const z of zones) netSet.add(z.net);
  for (const f of footprints) for (const p of f.pads) netSet.add(p.net);
  netSet.delete("");
  const general = child(root, "general");
  return {
    thickness: Number(value(general, "thickness") ?? 1.6),
    origin: [ox, oy],
    bbox, outline, layers, nets: [...netSet].sort(), tracks, vias, zones, footprints,
  };
}

function props(f: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of children(f, "property")) out[p[1] as string] = typeof p[2] === "string" ? p[2] : "";
  for (const t of children(f, "fp_text")) {
    if (t[1] === "reference" || t[1] === "value") {
      const k = t[1] === "reference" ? "Reference" : "Value";
      out[k] ??= t[2] as string;
    }
  }
  return out;
}

function footprint(f: Node, copper: string[], P: (x: number, y: number) => XY): Footprint & { lcsc?: string } {
  const at = floats(f, "at");
  const [fx, fy] = at;
  const frot = at[2] ?? 0;
  const side = value(f, "layer") === "B.Cu" ? "bottom" : "top";
  const pr = props(f);
  const attr = child(f, "attr");
  const dnp = !!(attr && hasAtom(attr, "dnp")) || !["", "0", "no", undefined].includes(pr.DNP);
  const A = (lx: number, ly: number): XY => {
    const [dx, dy] = rotate(lx, ly, frot);
    return P(fx + dx, fy + dy);
  };

  const pads: Pad[] = [];
  for (const p of children(f, "pad")) {
    const [num, kind, shape] = [p[1], p[2], p[3]] as string[];
    const pat = floats(p, "at");
    const prot = pat[2] ?? 0; // absolute in the file (includes the footprint's rotation)
    const layers = expandLayers((child(p, "layers") ?? []).slice(1) as string[], copper);
    if (!layers.length) continue;
    const pad: Pad = {
      num, net: value(p, "net") ?? "", at: A(pat[0], pat[1]), rot: r4(((prot % 360) + 360) % 360),
      shape: shape as Pad["shape"], size: floats(p, "size").slice(0, 2) as XY, layers,
    };
    if (kind === "thru_hole" || kind === "np_thru_hole") {
      const nums = floats(child(p, "drill"));
      pad.drill = nums.length === 1 ? nums[0] : (nums.slice(0, 2) as XY);
    }
    const rr = value(p, "roundrect_rratio");
    if (rr !== undefined) pad.roundrect_ratio = Number(rr);
    if (shape === "custom") pad.polygon = customPolygon(p, pad.at, prot);
    pads.push(pad);
  }

  const silk: XY[][] = [];
  const want = side === "top" ? ["F.SilkS", "F.Fab"] : ["B.SilkS", "B.Fab"];
  for (const tag of ["fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly"]) {
    for (const g of children(f, tag)) if (want.includes(value(g, "layer") ?? "")) for (const pl of graphicPolylines(g)) silk.push(pl.map((q) => A(q[0], q[1])));
  }
  const court: XY[] = [];
  for (const tag of ["fp_line", "fp_rect", "fp_poly", "fp_circle", "fp_arc"]) {
    for (const g of children(f, tag)) if (["F.CrtYd", "B.CrtYd"].includes(value(g, "layer") ?? "")) for (const pl of graphicPolylines(g)) court.push(...pl.map((q) => A(q[0], q[1])));
  }
  const models: Model3D[] = [];
  for (const m of children(f, "model")) {
    if (hasAtom(m, "hide")) continue;
    const v3 = (tag: string, d: [number, number, number]) => {
      const n = floats(child(m, tag), "xyz");
      return (n.length ? n : d) as [number, number, number];
    };
    models.push({ source: m[1] as string, offset: v3("offset", [0, 0, 0]), rotate: v3("rotate", [0, 0, 0]), scale: v3("scale", [1, 1, 1]) });
  }

  const out: Footprint & { lcsc?: string } = {
    ref: pr.Reference ?? "?", value: pr.Value ?? "", footprint: f[1] as string, side, at: P(fx, fy),
    rot: r4(((frot % 360) + 360) % 360), dnp, pads, silk, models,
  };
  if (pr.LCSC) out.lcsc = pr.LCSC;
  if (court.length) {
    out.courtyard = [Math.min(...court.map((p) => p[0])), Math.min(...court.map((p) => p[1])), Math.max(...court.map((p) => p[0])), Math.max(...court.map((p) => p[1]))];
  }
  return out;
}

function customPolygon(p: Node, at: XY, prot: number): XY[] {
  const prims = child(p, "primitives");
  let poly: XY[] = [];
  for (const g of prims ? children(prims, "gr_poly") : []) {
    poly = pts(g);
    break;
  }
  if (!poly.length) {
    const [w, h] = floats(p, "size");
    poly = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  }
  return poly.map(([x, y]) => {
    const [dx, dy] = rotate(x, y, prot);
    return [r4(at[0] + dx), r4(at[1] + dy)];
  });
}
