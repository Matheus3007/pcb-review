// 3D board view (three.js).
//
// World frame = KiCad's 3D-viewer frame, in mm: +X right, +Y up the board as seen from the top
// (bundle/board coords are +Y down, so world = (x, -y)), +Z out of the top copper.
// The top copper surface is z = 0, the bottom one z = -thickness. camera.up = +Z.
// In this frame a KiCad CCW angle (screen, Y down) is a positive rotation about +Z.
//
// GLB convention (exporter/models.py): meters, Z-up model space, no normals (flat shading).
// Placement follows KiCad (3d-viewer/3d_rendering/opengl/render_3d_opengl.cpp):
//   T(x, -y, z_side) * Rz(fp.rot) * [bottom: Ry(180) * Rz(180)]
//     * T(offset) * Rz(-rot.z) * Ry(-rot.y) * Rx(-rot.x) * S(scale) * S(1000)
//
// Fallbacks: a declared model without glb -> box of body.size (footprint frame) or the courtyard
// bbox, 1 mm tall. Footprints with no model at all get the courtyard box only if they have >= 2 pads
// (test points / fiducials / mounting holes stay bare, like in KiCad).

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Bundle, Footprint, Model3D, Pad, XY } from "./types";
import { buildCopper } from "./view3d-copper";

/** What a click in the 3D view hit: a part, or a board point (mm, board coords) on a copper layer. */
export type Pick3D = { ref: string } | { point: XY; layer: string; side: "top" | "bottom" };

export interface View3D {
  dispose(): void;
  highlight(refs: string[]): void;
  resize(): void;
  view(kind: "iso" | "top" | "bottom"): void;
  /** Selected net: drawn as a bright overlay (through the board in X-ray mode). */
  setNet(net: string | null): void;
  /** X-ray: translucent board, every copper layer in its 2D colour, parts dimmed. */
  setXray(on: boolean): void;
  setParts(on: boolean): void;
  setCopper(on: boolean): void;
  /** Board point (mm, +Y down) at height z (mm, top copper = 0) -> client px (tests, overlays). */
  project(x: number, y: number, z?: number): XY;
}

const DEG = Math.PI / 180;
const COPPER_T = 0.035;
const COLORS = {
  maskTop: 0x123d1e,
  maskBottom: 0x10351a,
  edge: 0x8c7b4e,
  pad: 0xd8b25a,
  viaHole: 0x101410,
  silk: 0xf2f2f2,
  fallback: 0x8a8f96,
  highlight: 0xff7a1a,
};

// Shared GLB cache across views (keyed by absolute URL). Geometry/materials are shared; instances
// are clones of the group (geometry not duplicated).
const glbCache = new Map<string, Promise<THREE.Group>>();
const loader = new GLTFLoader();

function loadGlb(url: string): Promise<THREE.Group> {
  let p = glbCache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => {
      const root = gltf.scene;
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const src = m.material as THREE.MeshStandardMaterial;
        // glTF defaults metallicFactor to 1 which renders near-black without a strong env map,
        // and the GLBs carry no normals: replace with a flat-shaded dielectric of the same color.
        const mat = new THREE.MeshStandardMaterial({
          color: src.color ?? new THREE.Color(0x888888),
          roughness: 0.55,
          metalness: 0.05,
          flatShading: true,
          side: THREE.DoubleSide,
        });
        mat.name = src.name;
        src.dispose();
        m.material = mat;
      });
      return root;
    });
    p.catch(() => glbCache.delete(url));
    glbCache.set(url, p);
  }
  return p;
}

const w = ([x, y]: XY): THREE.Vector2 => new THREE.Vector2(x, -y);

function roundRectShape(sx: number, sy: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const hx = sx / 2, hy = sy / 2;
  r = Math.max(0, Math.min(r, hx, hy));
  s.moveTo(-hx + r, -hy);
  s.lineTo(hx - r, -hy);
  if (r) s.absarc(hx - r, -hy + r, r, -Math.PI / 2, 0, false);
  s.lineTo(hx, hy - r);
  if (r) s.absarc(hx - r, hy - r, r, 0, Math.PI / 2, false);
  s.lineTo(-hx + r, hy);
  if (r) s.absarc(-hx + r, hy - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-hx, -hy + r);
  if (r) s.absarc(-hx + r, -hy + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Pad copper as a geometry in world coords, top face at z (side "top") or bottom face at z. */
function padGeometry(pad: Pad, side: "top" | "bottom", thickness: number): THREE.BufferGeometry | null {
  const [sx, sy] = pad.size;
  let geom: THREE.BufferGeometry;
  if (pad.shape === "custom" && pad.polygon && pad.polygon.length > 2) {
    // absolute outline -> build in world, no extra transform
    const shape = new THREE.Shape(pad.polygon.map(w));
    geom = new THREE.ExtrudeGeometry(shape, { depth: COPPER_T, bevelEnabled: false, curveSegments: 6 });
    geom.translate(0, 0, side === "top" ? 0 : -thickness - COPPER_T);
    return geom;
  }
  if (!(sx > 0 && sy > 0)) return null;
  let r = 0;
  if (pad.shape === "circle" || pad.shape === "oval") r = Math.min(sx, sy) / 2;
  else if (pad.shape === "roundrect") r = (pad.roundrect_ratio ?? 0.25) * Math.min(sx, sy);
  if (r > 0) {
    geom = new THREE.ExtrudeGeometry(roundRectShape(sx, sy, r), {
      depth: COPPER_T, bevelEnabled: false, curveSegments: pad.shape === "circle" ? 8 : 4,
    });
  } else {
    geom = new THREE.BoxGeometry(sx, sy, COPPER_T);
    geom.translate(0, 0, COPPER_T / 2);
  }
  geom.deleteAttribute("uv");
  geom.rotateZ(pad.rot * DEG);
  geom.translate(pad.at[0], -pad.at[1], side === "top" ? 0 : -thickness - COPPER_T);
  return geom;
}

function nonIndexedPosNormal(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal") n.deleteAttribute(k);
  if (!n.getAttribute("normal")) n.computeVertexNormals();
  return n;
}

function mergeAll(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geoms.length) return null;
  const norm = geoms.map(nonIndexedPosNormal);
  const merged = mergeGeometries(norm, false);
  for (const g of geoms) g.dispose();
  for (const g of norm) g.dispose();
  return merged;
}

/** KiCad model transform (footprint frame), see header. */
function modelMatrix(m: Model3D): THREE.Matrix4 {
  const t = new THREE.Matrix4().makeTranslation(m.offset[0], m.offset[1], m.offset[2]);
  const rz = new THREE.Matrix4().makeRotationZ(-m.rotate[2] * DEG);
  const ry = new THREE.Matrix4().makeRotationY(-m.rotate[1] * DEG);
  const rx = new THREE.Matrix4().makeRotationX(-m.rotate[0] * DEG);
  const s = new THREE.Matrix4().makeScale(m.scale[0] * 1000, m.scale[1] * 1000, m.scale[2] * 1000);
  return t.multiply(rz).multiply(ry).multiply(rx).multiply(s);
}

function footprintMatrix(fp: Footprint, thickness: number): THREE.Matrix4 {
  const bottom = fp.side === "bottom";
  const m = new THREE.Matrix4().makeTranslation(fp.at[0], -fp.at[1], bottom ? -thickness : 0);
  m.multiply(new THREE.Matrix4().makeRotationZ(fp.rot * DEG));
  if (bottom) {
    m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI));
  }
  return m;
}

export function mountView3D(el: HTMLElement, bundle: Bundle, bundleBase: string,
  opts: { onPick?(hit: Pick3D | null): void } = {}): View3D {
  const thickness = bundle.thickness || 1.6;
  let disposed = false;
  let needsRender = true;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.background =
    "radial-gradient(ellipse at 50% 35%, var(--bg3d-hi, #b9bec6), var(--bg3d, #7d838c))";
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  el.appendChild(canvas);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.45;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x50555c, 1.4);
  hemi.position.set(0, 0, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  scene.add(fill);

  const [bx0, by0, bx1, by1] = bundle.bbox;
  const center = new THREE.Vector3((bx0 + bx1) / 2, -(by0 + by1) / 2, -thickness / 2);
  const radius = Math.max(1, Math.hypot(bx1 - bx0, by1 - by0) / 2);
  sun.position.set(center.x - radius, center.y - radius * 1.5, radius * 3);
  sun.target.position.copy(center);
  fill.position.set(center.x + radius * 2, center.y + radius, -radius * 2);
  fill.target.position.copy(center);
  scene.add(sun.target, fill.target);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, radius * 100);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.target.copy(center);
  controls.addEventListener("change", () => (needsRender = true));

  const owned: { dispose(): void }[] = [envTex, pmrem];
  const own = <T extends { dispose(): void }>(x: T): T => (owned.push(x), x);

  // ---- board ----
  const boardGroup = new THREE.Group();
  scene.add(boardGroup);
  const boardMats: THREE.MeshStandardMaterial[] = [];
  if (bundle.outline.length && bundle.outline[0].length > 2) {
    const shape = new THREE.Shape(bundle.outline[0].map(w));
    for (const hole of bundle.outline.slice(1)) if (hole.length > 2) shape.holes.push(new THREE.Path(hole.map(w)));
    const g = own(new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 12 }));
    g.translate(0, 0, -thickness);
    const capMat = own(new THREE.MeshStandardMaterial({ color: COLORS.maskBottom, roughness: 0.6 }));
    const sideMat = own(new THREE.MeshStandardMaterial({ color: COLORS.edge, roughness: 0.85 }));
    const body = new THREE.Mesh(g, [capMat, sideMat]);
    body.userData.board = true;
    boardGroup.add(body);
    boardMats.push(capMat, sideMat);
    const topG = own(new THREE.ShapeGeometry(shape, 12));
    topG.translate(0, 0, 0.002);
    const topMat = own(new THREE.MeshStandardMaterial({ color: COLORS.maskTop, roughness: 0.5, metalness: 0.0 }));
    const top = new THREE.Mesh(topG, topMat);
    top.userData.board = true;
    boardGroup.add(top);
    boardMats.push(topMat);
  }

  // pads (one merged mesh)
  const padGeoms: THREE.BufferGeometry[] = [];
  const topIds = new Set(bundle.layers.filter((l) => l.side === "top").map((l) => l.id));
  const botIds = new Set(bundle.layers.filter((l) => l.side === "bottom").map((l) => l.id));
  if (!topIds.size) topIds.add("F.Cu");
  if (!botIds.size) botIds.add("B.Cu");
  for (const fp of bundle.footprints) {
    for (const pad of fp.pads) {
      for (const side of ["top", "bottom"] as const) {
        const ids = side === "top" ? topIds : botIds;
        if (!pad.layers.some((l) => ids.has(l))) continue;
        const g = padGeometry(pad, side, thickness);
        if (g) padGeoms.push(g);
      }
    }
  }
  const padMerged = mergeAll(padGeoms);
  const padMat = own(new THREE.MeshStandardMaterial({ color: COLORS.pad, roughness: 0.35, metalness: 0.6 }));
  if (padMerged) boardGroup.add(new THREE.Mesh(own(padMerged), padMat));

  // vias + THT drills: copper annulus + dark hole disk on both faces (instanced)
  const holes: { at: XY; d: number; ring: number }[] = bundle.vias.map((v) => ({ at: v.at, d: v.drill, ring: v.size }));
  for (const fp of bundle.footprints)
    for (const p of fp.pads)
      if (p.drill !== undefined) holes.push({ at: p.at, d: typeof p.drill === "number" ? p.drill : Math.min(...p.drill), ring: 0 });
  if (holes.length) {
    const disk = own(new THREE.CircleGeometry(0.5, 12));
    const holeMat = own(new THREE.MeshBasicMaterial({ color: COLORS.viaHole, side: THREE.DoubleSide }));
    const holeInst = new THREE.InstancedMesh(disk, holeMat, holes.length * 2);
    const rings = holes.filter((h) => h.ring > h.d);
    const ringInst = new THREE.InstancedMesh(disk, padMat, Math.max(1, rings.length * 2));
    ringInst.count = rings.length * 2;
    const m = new THREE.Matrix4();
    const zTop = COPPER_T + 0.003, zBot = -thickness - COPPER_T - 0.003;
    const flip = new THREE.Matrix4().makeRotationX(Math.PI);
    holes.forEach((h, i) => {
      m.makeScale(h.d, h.d, 1).setPosition(h.at[0], -h.at[1], zTop);
      holeInst.setMatrixAt(2 * i, m);
      m.makeScale(h.d, h.d, 1).setPosition(h.at[0], -h.at[1], zBot);
      holeInst.setMatrixAt(2 * i + 1, m);
    });
    rings.forEach((h, i) => {
      m.makeScale(h.ring, h.ring, 1).setPosition(h.at[0], -h.at[1], zTop - 0.002);
      ringInst.setMatrixAt(2 * i, m);
      m.makeScale(h.ring, h.ring, 1).multiply(flip).setPosition(h.at[0], -h.at[1], zBot + 0.002);
      ringInst.setMatrixAt(2 * i + 1, m);
    });
    boardGroup.add(holeInst, ringInst);
  }

  // tracks, zone fills (under the mask), X-ray layers, selected net
  const copper = buildCopper(bundle, thickness);
  owned.push(copper);
  scene.add(copper.group);

  // silkscreen (optional in the bundle)
  const silkPts: number[] = [];
  for (const fp of bundle.footprints) {
    if (!fp.silk) continue;
    const z = fp.side === "top" ? 0.01 : -thickness - 0.01;
    for (const line of fp.silk)
      for (let i = 1; i < line.length; i++)
        silkPts.push(line[i - 1][0], -line[i - 1][1], z, line[i][0], -line[i][1], z);
  }
  if (silkPts.length) {
    const g = own(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(silkPts, 3));
    boardGroup.add(new THREE.LineSegments(g, own(new THREE.LineBasicMaterial({ color: COLORS.silk }))));
  }

  // ---- components ----
  const fallbackMat = own(new THREE.MeshStandardMaterial({
    color: COLORS.fallback, roughness: 0.7, transparent: true, opacity: 0.75,
  }));
  const fpGroups = new Map<string, THREE.Group>();
  const pending: Promise<void>[] = [];

  const courtyardBox = (fp: Footprint, parent: THREE.Group) => {
    if (!fp.courtyard) return;
    const [x0, y0, x1, y1] = fp.courtyard;
    const h = 1;
    const g = own(new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), h));
    const mesh = new THREE.Mesh(g, fallbackMat);
    // courtyard is an absolute axis-aligned bbox: place in world (parent group holds identity)
    const bottom = fp.side === "bottom";
    mesh.position.set((x0 + x1) / 2, -(y0 + y1) / 2, bottom ? -thickness - h / 2 : h / 2);
    parent.add(mesh);
  };

  for (const fp of bundle.footprints) {
    const root = new THREE.Group(); // world-space container (for highlight / courtyard boxes)
    root.name = fp.ref;
    root.userData.ref = fp.ref;
    scene.add(root);
    fpGroups.set(fp.ref, root);
    const fpFrame = new THREE.Group();
    fpFrame.matrixAutoUpdate = false;
    fpFrame.matrix.copy(footprintMatrix(fp, thickness));
    root.add(fpFrame);

    if (!fp.models.length) {
      if (fp.pads.length >= 2) courtyardBox(fp, root);
      continue;
    }
    for (const model of fp.models) {
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(modelMatrix(model));
      fpFrame.add(holder);
      if (model.glb) {
        pending.push(
          loadGlb(bundleBase + model.glb).then(
            (g) => {
              if (disposed) return;
              const inst = g.clone(true);
              if (fp.dnp) inst.traverse((o) => ((o as THREE.Mesh).isMesh ? dimMesh(o as THREE.Mesh) : null));
              holder.add(inst);
              needsRender = true;
            },
            (err) => {
              console.warn(`view3d: ${model.glb}: ${err}`);
              if (!disposed) fallbackFor(fp, model, holder, fpFrame, root);
            },
          ),
        );
      } else {
        fallbackFor(fp, model, holder, fpFrame, root);
      }
    }
  }

  function fallbackFor(fp: Footprint, model: Model3D, _holder: THREE.Group, fpFrame: THREE.Group, root: THREE.Group) {
    if (model.body) {
      const [sx, sy, sz] = model.body.size;
      const g = own(new THREE.BoxGeometry(sx, sy, sz));
      g.translate(0, 0, sz / 2);
      fpFrame.add(new THREE.Mesh(g, fallbackMat));
    } else {
      courtyardBox(fp, root);
    }
    needsRender = true;
  }

  const dimmed = new Map<THREE.Material, THREE.Material>();
  function dimMesh(m: THREE.Mesh) {
    const src = m.material as THREE.Material;
    let d = dimmed.get(src);
    if (!d) {
      d = src.clone();
      d.transparent = true;
      d.opacity = 0.35;
      dimmed.set(src, own(d));
    }
    m.material = d;
  }

  el.dataset.view3d = "loading";
  Promise.allSettled(pending).then(() => {
    if (!disposed) {
      el.dataset.view3d = "ready";
      needsRender = true;
    }
  });

  // ---- highlight ----
  const hiMats = new Map<THREE.Material, THREE.Material>();
  const original = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  let highlighted = new Set<string>();
  function hiMat(src: THREE.Material): THREE.Material {
    let h = hiMats.get(src);
    if (!h) {
      const c = src.clone() as THREE.MeshStandardMaterial;
      if (c.emissive) {
        c.emissive = new THREE.Color(COLORS.highlight);
        c.emissiveIntensity = 0.55;
      }
      c.transparent = false;
      c.opacity = 1;
      h = own(c);
      hiMats.set(src, h);
    }
    return h;
  }
  function applyHighlight(ref: string, on: boolean) {
    const g = fpGroups.get(ref);
    if (!g) return;
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (on) {
        if (!original.has(m)) original.set(m, m.material);
        const src = original.get(m)!;
        m.material = Array.isArray(src) ? src.map(hiMat) : hiMat(src);
      } else if (original.has(m)) {
        m.material = original.get(m)!;
        original.delete(m);
      }
    });
  }

  // ---- camera / loop ----
  function fit() {
    const dir = new THREE.Vector3(-0.25, -1.0, 1.05).normalize();
    const dist = radius / Math.sin((camera.fov * DEG) / 2) * (camera.aspect < 1 ? 1.15 / camera.aspect : 1.05);
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = dist / 100;
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    needsRender = true;
  }

  function resize() {
    const wpx = Math.max(1, el.clientWidth), hpx = Math.max(1, el.clientHeight);
    renderer.setSize(wpx, hpx, false);
    camera.aspect = wpx / hpx;
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  resize();
  fit();
  const ro = new ResizeObserver(() => resize());
  ro.observe(el);

  renderer.setAnimationLoop(() => {
    if (controls.update()) needsRender = true;
    if (needsRender) {
      needsRender = false;
      renderer.render(scene, camera);
    }
  });

  // ---- picking: a click (not a drag) raycasts the scene ----
  const raycaster = new THREE.Raycaster();
  const layerZs = bundle.layers.map((l, i, all) => ({
    id: l.id, z: all.length > 1 ? (-thickness * i) / (all.length - 1) : 0,
  }));
  const visibleChain = (o: THREE.Object3D | null): boolean => {
    for (; o; o = o.parent) if (!o.visible) return false;
    return true;
  };
  function pick(clientX: number, clientY: number): Pick3D | null {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    for (const hit of raycaster.intersectObjects(scene.children, true)) {
      const o = hit.object;
      if (!(o as THREE.Mesh).isMesh || !visibleChain(o)) continue;
      if (xray && o.userData.board) continue; // see-through board: pick the copper behind it
      for (let a: THREE.Object3D | null = o; a; a = a.parent) {
        if (a.userData.ref) return { ref: a.userData.ref as string };
      }
      const p = hit.point;
      // layer: the copper mesh says so; otherwise the nearest copper surface to the hit height
      const layer = (o.userData.layer as string | undefined)
        ?? layerZs.reduce((best, l) => (Math.abs(l.z - p.z) < Math.abs(best.z - p.z) ? l : best)).id;
      const side = p.z < -thickness / 2 ? "bottom" : "top";
      return { point: [p.x, -p.y], layer, side };
    }
    return null;
  }
  let down: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  });
  canvas.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!d || !opts.onPick) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 700) return; // orbit/pan
    try {
      opts.onPick(pick(e.clientX, e.clientY));
    } catch (err) {
      console.error("pcb-review: 3D pick failed", err);
    }
  });
  canvas.addEventListener("pointercancel", () => (down = null));

  let xray = false;
  let partsOn = true;
  function applyParts() {
    // X-ray hides the parts so the copper underneath can be read; highlighted parts stay visible
    for (const [ref, g] of fpGroups) g.visible = partsOn && (!xray || highlighted.has(ref));
    needsRender = true;
  }

  const api = {
    resize,
    highlight(refs: string[]) {
      const next = new Set(refs);
      for (const r of highlighted) if (!next.has(r)) applyHighlight(r, false);
      for (const r of next) applyHighlight(r, true);
      // GLBs still loading get highlighted once they arrive
      if ([...next].some((r) => !highlighted.has(r)))
        Promise.allSettled(pending).then(() => {
          if (!disposed) for (const r of highlighted) applyHighlight(r, true);
          needsRender = true;
        });
      highlighted = next;
      applyParts();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      for (const o of owned) o.dispose();
      renderer.dispose();
      canvas.remove();
      delete el.dataset.view3d;
    },
    setNet(net: string | null) {
      copper.setNet(net);
      needsRender = true;
    },
    setXray(on: boolean) {
      xray = on;
      for (const m of boardMats) {
        m.transparent = on;
        m.opacity = on ? 0.18 : 1;
        m.depthWrite = !on;
        m.needsUpdate = true;
      }
      copper.setXray(on);
      applyParts();
    },
    setParts(on: boolean) {
      partsOn = on;
      applyParts();
    },
    setCopper(on: boolean) {
      copper.setVisible(on);
      needsRender = true;
    },
    project(x: number, y: number, z = 0): XY {
      const v = new THREE.Vector3(x, -y, z).project(camera);
      const r = canvas.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    },
    /** Camera presets. */
    view(kind: "iso" | "top" | "bottom") {
      if (kind === "iso") return fit();
      const dist = radius / Math.sin((camera.fov * DEG) / 2) * 1.05;
      camera.position.set(center.x, center.y + (kind === "top" ? -0.001 : 0.001), center.z + (kind === "top" ? dist : -dist));
      controls.target.copy(center);
      controls.update();
      needsRender = true;
    },
    /** Not part of the View3D contract: internals for debugging/tests. */
    _debug: { camera, controls, scene },
  };
  return api;
}
