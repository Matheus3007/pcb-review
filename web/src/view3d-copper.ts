// Copper for the 3D view: tracks, zone fills and vias per layer, in the view3d world frame
// (mm, world = (x, -y), top copper z = 0, bottom z = -thickness, inner layers evenly between).
//
// Normal mode: only the outer layers show, as copper seen through green solder mask (a lighter
// green, raised a hair above the mask). X-ray mode: every layer in its 2D layer colour, so inner
// routing can be followed (the caller makes the board translucent). The selected net is redrawn
// on top in a bright overlay, through the board in X-ray mode.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Bundle, Track, XY } from "./types";
import { layerColor } from "./view2d";

const UNDER_MASK = { top: 0x2f7a3c, bottom: 0x2a6e37 };
const NET_COLOR = 0xffb02e;        // normal mode: amber against the green mask
const NET_COLOR_XRAY = 0xffffff;   // X-ray: white against the coloured layers
const CAP_SEGS = 8;
const XRAY_ZONE = 0.14, XRAY_TRACK = 0.85, XRAY_DIM = 0.3; // dim factor for other copper while a net is selected

export interface Copper {
  group: THREE.Group;
  setXray(on: boolean): void;
  setVisible(on: boolean): void;
  setNet(net: string | null): void;
  dispose(): void;
}

/** z of each copper layer's surface, plus which way is "outward" for stacking offsets. */
function layerZ(bundle: Bundle, thickness: number): Map<string, { z: number; out: number }> {
  const n = bundle.layers.length;
  const m = new Map<string, { z: number; out: number }>();
  bundle.layers.forEach((l, i) => {
    const z = n > 1 ? (-thickness * i) / (n - 1) : 0;
    m.set(l.id, { z, out: l.side === "bottom" ? -1 : 1 });
  });
  return m;
}

function arcPoints(a: XY, mid: XY, e: XY, n = 16): XY[] {
  const [x1, y1] = a, [x2, y2] = mid, [x3, y3] = e;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-12) return [a, e];
  const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy);
  const ang = (p: XY) => Math.atan2(p[1] - uy, p[0] - ux);
  const pos = (f: number, t: number) => (((t - f) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a1 = ang(a);
  let sweep = pos(a1, ang(e));
  if (pos(a1, ang(mid)) > sweep) sweep -= 2 * Math.PI;
  return Array.from({ length: n + 1 }, (_, i) => [ux + r * Math.cos(a1 + (sweep * i) / n), uy + r * Math.sin(a1 + (sweep * i) / n)] as XY);
}

/** Flat ribbon triangles (rect + round caps) for one track, appended to `out` at height z. */
function pushTrack(out: number[], t: Track, z: number) {
  const pts = t.mid ? arcPoints(t.start, t.mid, t.end) : [t.start, t.end];
  const r = t.width / 2;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) {
      const nx = (-dy / len) * r, ny = (dx / len) * r;
      // world y = -board y
      const p = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
      const v = (q: number[]) => out.push(q[0], -q[1], z);
      v(p[0]); v(p[1]); v(p[2]);
      v(p[0]); v(p[2]); v(p[3]);
    }
  }
  for (const [cx, cy] of [pts[0], pts[pts.length - 1]]) pushDisc(out, cx, cy, r, z);
}

function pushDisc(out: number[], cx: number, cy: number, r: number, z: number, segs = CAP_SEGS * 2) {
  for (let k = 0; k < segs; k++) {
    const a0 = (2 * Math.PI * k) / segs, a1 = (2 * Math.PI * (k + 1)) / segs;
    out.push(cx, -cy, z, cx + r * Math.cos(a0), -(cy + r * Math.sin(a0)), z, cx + r * Math.cos(a1), -(cy + r * Math.sin(a1)), z);
  }
}

function flatGeometry(tris: number[]): THREE.BufferGeometry | null {
  if (!tris.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(tris, 3));
  g.computeVertexNormals();
  return g;
}

function zoneGeometry(polys: XY[][], z: number): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const poly of polys) {
    if (poly.length < 3) continue;
    // KiCad fill polygons are "fractured": holes joined to the outline by zero-width slits, so a
    // single ring triangulates correctly (earcut handles the touching edges).
    const g = new THREE.ShapeGeometry(new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, -y))), 1);
    g.deleteAttribute("uv");
    g.translate(0, 0, z);
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  if (!parts.length) return null;
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return m;
}

export function buildCopper(bundle: Bundle, thickness: number): Copper {
  const group = new THREE.Group();
  group.name = "copper";
  const zs = layerZ(bundle, thickness);
  const owned: { dispose(): void }[] = [];
  // offsets above each layer surface (outward): zones under tracks, both under silk (0.01) and pads
  const Z_ZONE = 0.004, Z_TRACK = 0.006, Z_NET = 0.008;

  interface LayerMeshes { normal: THREE.Mesh[]; xray: THREE.Mesh[]; outer: boolean }
  const layers = new Map<string, LayerMeshes>();

  for (const l of bundle.layers) {
    const { z, out } = zs.get(l.id)!;
    const outer = l.side !== "inner";
    const zoneG = zoneGeometry(bundle.zones.filter((zn) => zn.layer === l.id).flatMap((zn) => zn.polygons), z + out * Z_ZONE);
    const tris: number[] = [];
    for (const t of bundle.tracks) if (t.layer === l.id) pushTrack(tris, t, z + out * Z_TRACK);
    const trackG = flatGeometry(tris);
    const entry: LayerMeshes = { normal: [], xray: [], outer };
    const col = new THREE.Color(layerColor(l.id));
    const maskCol = l.side === "bottom" ? UNDER_MASK.bottom : UNDER_MASK.top;
    for (const [g, isZone] of [[zoneG, true], [trackG, false]] as const) {
      if (!g) continue;
      owned.push(g);
      if (outer) {
        const m = new THREE.MeshStandardMaterial({ color: maskCol, roughness: 0.45, side: THREE.DoubleSide,
          polygonOffset: true, polygonOffsetFactor: isZone ? -1 : -2, polygonOffsetUnits: isZone ? -1 : -2 });
        owned.push(m);
        const mesh = new THREE.Mesh(g, m);
        mesh.userData.layer = l.id;
        entry.normal.push(mesh);
        group.add(mesh);
      }
      const xm = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: isZone ? XRAY_ZONE : XRAY_TRACK,
        side: THREE.DoubleSide, depthWrite: false });
      xm.userData.base = xm.opacity;
      owned.push(xm);
      const xmesh = new THREE.Mesh(g, xm);
      xmesh.userData.layer = l.id;
      xmesh.visible = false;
      xmesh.renderOrder = 2;
      entry.xray.push(xmesh);
      group.add(xmesh);
    }
    layers.set(l.id, entry);
  }

  // selected-net overlay, rebuilt on demand
  let netGroup: THREE.Group | null = null;
  let netName: string | null = null;
  const netMat = new THREE.MeshBasicMaterial({ color: NET_COLOR, side: THREE.DoubleSide, transparent: true, opacity: 0.95 });
  const netZoneMat = new THREE.MeshBasicMaterial({ color: NET_COLOR, side: THREE.DoubleSide, transparent: true, opacity: 0.35, depthWrite: false });
  owned.push(netMat, netZoneMat);
  let xray = false;
  let visible = true;

  function buildNet(net: string) {
    const g = new THREE.Group();
    for (const l of bundle.layers) {
      const { z, out } = zs.get(l.id)!;
      const zoneG = zoneGeometry(bundle.zones.filter((zn) => zn.layer === l.id && zn.net === net).flatMap((zn) => zn.polygons), z + out * Z_NET);
      const tris: number[] = [];
      for (const t of bundle.tracks) if (t.layer === l.id && t.net === net) pushTrack(tris, t, z + out * (Z_NET + 0.001));
      const trackG = flatGeometry(tris);
      for (const [geom, mat] of [[zoneG, netZoneMat], [trackG, netMat]] as const) {
        if (!geom) continue;
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.inner = l.side === "inner";
        mesh.userData.layer = l.id;
        mesh.renderOrder = 3;
        g.add(mesh);
      }
    }
    // via barrels: a vertical line of discs is overkill; draw a thin cylinder through the board
    for (const v of bundle.vias) {
      if (v.net !== net) continue;
      const z0 = zs.get(v.layers[0])?.z ?? 0, z1 = zs.get(v.layers[1])?.z ?? -thickness;
      const cyl = new THREE.CylinderGeometry(v.size / 2, v.size / 2, Math.abs(z1 - z0) + 0.02, 12, 1, true);
      cyl.rotateX(Math.PI / 2);
      cyl.translate(v.at[0], -v.at[1], (z0 + z1) / 2);
      const mesh = new THREE.Mesh(cyl, netMat);
      mesh.userData.inner = true;
      mesh.renderOrder = 3;
      g.add(mesh);
    }
    return g;
  }

  function apply() {
    const dim = netGroup && xray ? XRAY_DIM : 1;
    for (const e of layers.values()) {
      for (const m of e.normal) m.visible = visible && !xray;
      for (const m of e.xray) {
        m.visible = visible && xray;
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.opacity = (mat.userData.base as number) * dim;
      }
    }
    netMat.color.setHex(xray ? NET_COLOR_XRAY : NET_COLOR);
    netZoneMat.color.setHex(xray ? NET_COLOR_XRAY : NET_COLOR);
    if (netGroup) {
      netGroup.visible = visible;
      for (const c of netGroup.children) {
        const mesh = c as THREE.Mesh;
        // through the board only in X-ray; otherwise inner copper stays hidden like the real board
        mesh.visible = xray || !mesh.userData.inner;
        (mesh.material as THREE.Material).depthTest = !xray;
      }
    }
  }

  return {
    group,
    setXray(on) { xray = on; apply(); },
    setVisible(on) { visible = on; apply(); },
    setNet(net) {
      if (net === netName) return;
      netName = net;
      if (netGroup) {
        group.remove(netGroup);
        netGroup.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        netGroup = null;
      }
      if (net) {
        netGroup = buildNet(net);
        group.add(netGroup);
      }
      apply();
    },
    dispose() {
      if (netGroup) netGroup.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      for (const o of owned) o.dispose();
    },
  };
}
