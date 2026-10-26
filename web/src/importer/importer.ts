// A pcb-lab board build, opened in the browser -> Bundle. Same output as the Python exporter's
// link mode (datasheets from LCSC, nothing uploaded anywhere), minus what needs pcb-lab's lib or
// KiCad: datasheet URLs, pin pages and GLB models come from the published bundles/library.json
// when it knows the part / model, and 3D falls back to boxes otherwise.
import type { BomRow, Bundle, Part, PinIndexPart } from "../types";
import { parsePcb } from "./kicad";

/** path (with "/" separators, any prefix) -> file contents */
export type FileMap = Map<string, Blob>;

export interface Library {
  parts: Record<string, { lcsc: string; mpn?: string; datasheet_url?: string; lcsc_url: string; jlc_url: string; pinout_source?: string; pinindex?: PinIndexPart }>;
  models: Record<string, string>; // portable model source -> GLB path relative to the bundles root
}

export interface Imported {
  bundle: Bundle;
  pinindex: Record<string, PinIndexPart>;
  warnings: string[];
}

const lcscUrl = (lc: string) => `https://www.lcsc.com/product-detail/${lc}.html`;
const jlcUrl = (lc: string) => `https://jlcpcb.com/parts/componentSearch?searchTxt=${lc}`;

/** Pick the board's files out of whatever was dropped (board dir, build dir, repo subtree, zip). */
export function locate(files: FileMap) {
  const paths = [...files.keys()].map((p) => p.replace(/\\/g, "/"));
  const pcbs = paths.filter((p) => p.endsWith(".kicad_pcb") && !p.includes("/.") && !/-backups\//.test(p));
  if (!pcbs.length) throw new Error("No .kicad_pcb found. Drop a pcb-lab board folder (boards/<name>), its build folder, or a .zip of either.");
  // pcb-lab's fab output is the routed board; prefer it over work copies
  const pcb = pcbs.find((p) => /\/build\/fab\/[^/]+\.kicad_pcb$/.test(p)) ?? pcbs.find((p) => /\/fab\//.test(p)) ?? pcbs[0];
  const name = pcb.split("/").pop()!.replace(/\.kicad_pcb$/, "");
  // the board root: the dir that holds build/ (or the pcb's own dir)
  const buildIdx = pcb.lastIndexOf("/build/");
  const root = buildIdx >= 0 ? pcb.slice(0, buildIdx + 1) : pcb.slice(0, pcb.lastIndexOf("/") + 1);
  // board-relative path under the root, else the same relative path anywhere below it
  const find = (rel: string) => paths.find((p) => p === root + rel) ?? paths.find((p) => p.startsWith(root) && p.endsWith("/" + rel));
  return {
    name, pcb, root,
    netlist: find("build/work/netlist.json"),
    bom: find(`build/fab/${name}-bom.csv`),
    checks: find("build/reports/checks.json"),
    drc: find("build/reports/drc.json"),
    summary: find("build/reports/summary.md"),
    boardYaml: find("board.yaml"),
  };
}

/** board.yaml, only the two keys the viewer needs (avoids a YAML dependency). */
export function boardYaml(text: string): { origin?: [number, number]; thickness?: number } {
  const out: { origin?: [number, number]; thickness?: number } = {};
  const o = /^origin:\s*\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]/m.exec(text);
  if (o) out.origin = [Number(o[1]), Number(o[2])];
  const t = /^thickness:\s*([-\d.]+)/m.exec(text);
  if (t) out.thickness = Number(t[1]);
  return out;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

function bomRows(text: string): BomRow[] {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  const col = (n: string) => head.indexOf(n);
  return rows.map((r) => ({
    comment: r[col("Comment")] ?? "",
    refs: (r[col("Designator")] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    footprint: r[col("Footprint")] ?? "",
    lcsc: r[col("LCSC Part #")] ?? "",
  }));
}

/** Same rule as exporter bundle.portable_source, without knowing where pcb-lab lives. */
export function portableSource(src: string): string {
  if (src.startsWith("${")) return src;
  const p = src.replace(/\\/g, "/");
  const i = p.lastIndexOf("/lib/3d/");
  return i >= 0 ? p.slice(i + 1) : p.split("/").pop()!;
}

interface NetlistPart {
  ref: string; lcsc?: string | null; mpn?: string; dnp?: boolean;
  pins?: Record<string, string | number | (string | number)[]>;
  meta?: { pinout_source?: string };
}

/** GLB paths in the result are relative to the bundles root that served library.json. */
export async function importBoard(files: FileMap, library?: Library | null): Promise<Imported> {
  const loc = locate(files);
  const text = (p?: string) => (p ? files.get(p)!.text() : Promise.resolve(undefined));
  const json = async (p?: string) => {
    const t = await text(p);
    return t ? JSON.parse(t) : undefined;
  };
  const warnings: string[] = [];
  const by = boardYaml((await text(loc.boardYaml)) ?? "");
  if (!loc.boardYaml) warnings.push("no board.yaml: origin taken from the outline's corner");
  const geo = parsePcb((await text(loc.pcb))!, by.origin);

  const netlist = ((await json(loc.netlist)) ?? { parts: [] }) as { parts: NetlistPart[] };
  if (!loc.netlist) warnings.push("no build/work/netlist.json: pin names and LCSC numbers only from the footprints");
  const byRef = new Map(netlist.parts.map((p) => [p.ref, p]));
  for (const fp of geo.footprints) {
    const np = byRef.get(fp.ref);
    if (!np) continue;
    if (!fp.lcsc && np.lcsc) fp.lcsc = np.lcsc;
    if (np.mpn) fp.mpn = np.mpn;
    fp.dnp = fp.dnp || !!np.dnp;
    const pad2pin = new Map<string, string>();
    for (const [pin, pads] of Object.entries(np.pins ?? {})) {
      for (const pad of Array.isArray(pads) ? pads : [pads]) if (!pad2pin.has(String(pad))) pad2pin.set(String(pad), pin);
    }
    for (const pad of fp.pads) {
      const pin = pad2pin.get(pad.num);
      if (pin !== undefined && pin !== pad.num) pad.pin = pin;
    }
  }

  const parts: Record<string, Part> = {};
  const pinindex: Record<string, PinIndexPart> = {};
  for (const fp of geo.footprints) {
    const lc = fp.lcsc;
    if (!lc) continue;
    const lib = library?.parts[lc];
    const part = (parts[lc] ??= { lcsc: lc, value: fp.value, refs: [], lcsc_url: lcscUrl(lc), jlc_url: jlcUrl(lc) });
    if (fp.mpn && !part.mpn) part.mpn = fp.mpn;
    part.refs.push(fp.ref);
    const ps = byRef.get(fp.ref)?.meta?.pinout_source ?? lib?.pinout_source;
    if (ps) part.pinout_source = ps;
    if (lib?.datasheet_url) part.datasheet = { url: lib.datasheet_url };
    if (lib?.pinindex) pinindex[lc] = lib.pinindex;
  }
  const unknown = Object.keys(parts).filter((lc) => !parts[lc].datasheet);
  if (unknown.length) warnings.push(`${unknown.length} part(s) not in the library, no datasheet link: ${unknown.join(", ")}`);

  let boxes = 0;
  for (const fp of geo.footprints) {
    for (const m of fp.models) {
      m.source = portableSource(m.source);
      const glb = library?.models[m.source];
      if (glb) m.glb = glb;
      else boxes++;
    }
  }
  if (boxes) warnings.push(`${boxes} 3D model(s) not published yet: shown as boxes`);

  const bundle: Bundle = {
    schema: 1,
    name: loc.name,
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    source: { board_dir: loc.root.replace(/\/$/, "") || loc.name, kicad_pcb: loc.pcb },
    origin: geo.origin,
    thickness: by.thickness ?? geo.thickness,
    bbox: geo.bbox, outline: geo.outline, layers: geo.layers, nets: geo.nets,
    tracks: geo.tracks, vias: geo.vias, zones: geo.zones, footprints: geo.footprints, silkscreen: geo.silkscreen,
    parts,
    bom: loc.bom ? bomRows((await text(loc.bom))!) : [],
    reports: { checks: await json(loc.checks), drc: await json(loc.drc), summary_md: await text(loc.summary) },
  };
  return { bundle, pinindex, warnings };
}
