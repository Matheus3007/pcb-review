// Parity: the in-browser importer must produce what the Python exporter produced for the same
// board (bundles/rebot-ctrl-v2, link mode), from the fixture copy of its pcb-lab build files.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { importBoard, locate, boardYaml, parseCsv, portableSource, type FileMap, type Library } from "./importer";
import { parse } from "./sexp";
import type { Bundle } from "../types";

const FIX = join(__dirname, "../../e2e/fixtures");
const BUNDLES = join(__dirname, "../../../bundles");

function fileMap(dir: string, prefix = "drop/"): FileMap {
  const m: FileMap = new Map();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else m.set(prefix + relative(dir, p).replace(/\\/g, "/"), new Blob([readFileSync(p)]));
    }
  };
  walk(dir);
  return m;
}

/** deep equality with a numeric tolerance (Python rounds half-even, JS half-up) */
function close(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 2e-4 ? null : `${path}: ${a} != ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = close(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka} != ${kb}`;
    for (const k of ka) {
      const d = close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

describe("importer", () => {
  const files = fileMap(join(FIX, "boards/rebot-ctrl-v2"), "Downloads/rebot-ctrl-v2/");
  const want = JSON.parse(readFileSync(join(BUNDLES, "rebot-ctrl-v2/board.json"), "utf8")) as Bundle;
  const library = JSON.parse(readFileSync(join(BUNDLES, "library.json"), "utf8")) as Library;

  it("finds the board files under any prefix", () => {
    const loc = locate(files);
    expect(loc.name).toBe("rebot-ctrl-v2");
    expect(loc.netlist).toMatch(/build\/work\/netlist\.json$/);
    expect(loc.bom).toMatch(/rebot-ctrl-v2-bom\.csv$/);
    expect(loc.boardYaml).toMatch(/rebot-ctrl-v2\/board\.yaml$/);
  });

  it("matches the Python exporter's bundle", async () => {
    const { bundle: got, pinindex, warnings } = await importBoard(files, library);
    expect(warnings).toEqual([]);
    for (const k of ["layers", "nets", "bbox", "outline", "origin", "thickness", "tracks", "vias", "zones", "bom"] as const) {
      expect(close(got[k], want[k], k)).toBeNull();
    }
    // footprints: GLB paths are relative to the bundles root here, to the board dir there
    const norm = (b: Bundle) => b.footprints.map((f) => ({ ...f, models: f.models.map((m) => ({ ...m, glb: m.glb?.split("/").pop() })) }));
    expect(close(norm(got), norm(want), "footprints")).toBeNull();
    expect(close(got.parts, want.parts, "parts")).toBeNull();
    expect(got.reports.checks).toEqual(want.reports.checks);
    expect(got.reports.drc).toEqual(want.reports.drc);
    expect(pinindex.C529358.pins.PA9[0].page).toBe(56);
  });

  it("degrades without the netlist, board.yaml and library", async () => {
    const bare: FileMap = new Map([...files].filter(([p]) => p.endsWith(".kicad_pcb")));
    const { bundle, warnings } = await importBoard(bare, null);
    expect(bundle.footprints.length).toBe(want.footprints.length);
    expect(bundle.bbox).toEqual([0, 0, 25, 25]); // origin falls back to the outline corner
    expect(warnings.join(" ")).toMatch(/board\.yaml/);
    expect(bundle.footprints.find((f) => f.ref === "U1")!.lcsc).toBe("C529358"); // LCSC field on the footprint
  });
});

describe("helpers", () => {
  it("sexp handles quotes", () => expect(parse('(a "x \\"y\\"" (b 1))')).toEqual(["a", 'x "y"', ["b", "1"]]));
  it("board.yaml keys", () => expect(boardYaml("layers: 4\nthickness: 1.0\norigin: [100.0, 100.0]\n")).toEqual({ origin: [100, 100], thickness: 1 }));
  it("csv quotes", () => expect(parseCsv('a,b\n"R1,R2",x\n')).toEqual([["a", "b"], ["R1,R2", "x"]]));
  it("model paths", () => {
    expect(portableSource("C:\\pcb-lab\\lib\\3d\\U.step")).toBe("lib/3d/U.step");
    expect(portableSource("${KICAD10_3DMODEL_DIR}/A.3dshapes/B.step")).toBe("${KICAD10_3DMODEL_DIR}/A.3dshapes/B.step");
  });
});
