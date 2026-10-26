// 2D copper viewer: Canvas 2D, per-layer Path2D cache, pan/zoom, hit testing.
import type { Bundle, Footprint, Pad, Track, Via, XY } from "./types";

export type Hit =
  | { kind: "pad"; net: string; fp: Footprint; pad: Pad; layer: string }
  | { kind: "via"; net: string; via: Via }
  | { kind: "track"; net: string; track: Track }
  | { kind: "zone"; net: string; layer: string }
  | { kind: "footprint"; net: ""; fp: Footprint };

export interface View2DOptions {
  onSelect(hit: Hit | null): void;
  onHover?(hit: Hit | null, clientX: number, clientY: number): void;
}

const LAYER_COLORS: Record<string, string> = {
  "F.Cu": "#d0453f",
  "In1.Cu": "#c9b53c",
  "In2.Cu": "#a85fd0",
  "In3.Cu": "#3cc9a6",
  "In4.Cu": "#d07f3c",
  "B.Cu": "#4d8fd6",
};
export function layerColor(id: string): string {
  return LAYER_COLORS[id] ?? "#9a9a9a";
}

interface PadItem { fp: Footprint; pad: Pad; path: Path2D }
interface LayerGeom {
  zones: { net: string; path: Path2D }[];
  tracks: { net: string; track: Track }[];
  pads: PadItem[];
}

export class View2D {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private geom = new Map<string, LayerGeom>();
  private viaPaths: { via: Via; path: Path2D }[] = [];
  private outline = new Path2D();
  private fpPaths = new Map<string, Path2D>();
  // board-level silkscreen art (logos), per side: filled shapes (one path each) + stroked lines
  private silkArt = { top: { fills: [] as Path2D[], lines: [] as { path: Path2D; width: number }[] },
    bottom: { fills: [] as Path2D[], lines: [] as { path: Path2D; width: number }[] } };
  // view state
  private scale = 20; // px per mm
  private tx = 0;
  private ty = 0;
  private dpr = 1;
  visible = new Set<string>();
  active: string;
  flipped = false; // view from the bottom (mirrored X)
  showZones = true;
  showSilk = true;
  selectedNet: string | null = null;
  selectedRefs = new Set<string>();
  private raf = 0;

  constructor(private host: HTMLElement, private b: Bundle, private opts: View2DOptions) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "view2d";
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    for (const l of b.layers) this.visible.add(l.id);
    this.active = b.layers[0]?.id ?? "F.Cu";
    this.build();
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }
  private userMoved = false; // until the user pans/zooms, keep the board fitted on resize

  // ---------- geometry ----------
  private build() {
    const b = this.b;
    for (const l of b.layers) this.geom.set(l.id, { zones: [], tracks: [], pads: [] });
    for (const z of b.zones) {
      const p = new Path2D();
      for (const poly of z.polygons) polyPath(p, poly);
      this.geom.get(z.layer)?.zones.push({ net: z.net, path: p });
    }
    for (const t of b.tracks) this.geom.get(t.layer)?.tracks.push({ net: t.net, track: t });
    for (const fp of b.footprints) {
      for (const pad of fp.pads) {
        const path = padPath(pad);
        for (const l of pad.layers) this.geom.get(l)?.pads.push({ fp, pad, path });
      }
      const fpPath = new Path2D();
      for (const pl of fp.silk ?? []) polyPath(fpPath, pl, false);
      this.fpPaths.set(fp.ref, fpPath);
    }
    for (const v of b.vias) {
      const p = new Path2D();
      p.arc(v.at[0], v.at[1], v.size / 2, 0, Math.PI * 2);
      this.viaPaths.push({ via: v, path: p });
    }
    for (const poly of b.outline) polyPath(this.outline, poly);
    for (const sl of b.silkscreen ?? []) {
      const art = this.silkArt[sl.side];
      for (const poly of sl.polygons) {
        const p = new Path2D();
        polyPath(p, poly);
        art.fills.push(p);
      }
      for (const l of sl.lines) {
        const p = new Path2D();
        polyPath(p, l.pts, false);
        art.lines.push({ path: p, width: l.width });
      }
    }
  }

  // ---------- view ----------
  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = r.width + "px";
    this.canvas.style.height = r.height + "px";
    if (!this.userMoved && r.width > 50 && r.height > 50) this.fit();
    this.draw();
  }

  fit(box?: [number, number, number, number], maxScale = Infinity) {
    const [x0, y0, x1, y1] = box ?? this.b.bbox;
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    if (w < 50 || h < 50) return; // hidden pane: fit again on the next real resize
    const pad = 24;
    this.scale = Math.min(maxScale, Math.min((w - 2 * pad) / Math.max(x1 - x0, 0.1), (h - 2 * pad) / Math.max(y1 - y0, 0.1)));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    this.tx = w / 2 - (this.flipped ? -cx : cx) * this.scale;
    this.ty = h / 2 - cy * this.scale;
    this.draw();
  }

  setFlipped(f: boolean) {
    if (f === this.flipped) return;
    const w = this.canvas.width / this.dpr;
    // keep the screen centre on the same board point
    const cx = this.toBoard(w / 2, 0)[0];
    this.flipped = f;
    this.tx = w / 2 - (f ? -cx : cx) * this.scale;
    this.draw();
  }

  /** Board mm -> canvas CSS px (tests, overlays). */
  toScreen(x: number, y: number): XY {
    return [(this.flipped ? -x : x) * this.scale + this.tx, y * this.scale + this.ty];
  }

  /** Pan/zoom state (tests). */
  viewState() {
    return { scale: this.scale, tx: this.tx, ty: this.ty };
  }

  private toBoard(sx: number, sy: number): XY {
    const x = (sx - this.tx) / this.scale;
    return [this.flipped ? -x : x, (sy - this.ty) / this.scale];
  }

  draw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.render());
  }

  private render() {
    const { ctx, b } = this;
    const css = getComputedStyle(this.host);
    const bg = css.getPropertyValue("--canvas-bg").trim() || "#101418";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const s = this.scale * this.dpr;
    ctx.setTransform(this.flipped ? -s : s, 0, 0, s, this.tx * this.dpr, this.ty * this.dpr);

    // board substrate
    ctx.fillStyle = css.getPropertyValue("--board-fill").trim() || "#16221c";
    ctx.fill(this.outline, "evenodd");

    const sel = this.selectedNet;
    // draw bottom-up as seen: when flipped, top layer is farthest
    const order = [...b.layers].map((l) => l.id);
    if (!this.flipped) order.reverse();
    // active layer last (on top)
    const drawOrder = order.filter((l) => l !== this.active && this.visible.has(l));
    if (this.visible.has(this.active)) drawOrder.push(this.active);

    for (const lid of drawOrder) {
      const g = this.geom.get(lid)!;
      const col = layerColor(lid);
      const isActive = lid === this.active;
      const base = isActive ? 0.9 : 0.45;
      const dim = sel ? 0.18 : 1;
      if (this.showZones) {
        for (const z of g.zones) {
          ctx.globalAlpha = (sel && z.net === sel ? 0.55 : 0.28 * dim) * (isActive ? 1 : 0.7);
          ctx.fillStyle = sel && z.net === sel ? hiColor(col) : col;
          ctx.fill(z.path, "evenodd");
        }
      }
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const { net, track } of g.tracks) {
        const on = sel !== null && net === sel;
        ctx.globalAlpha = on ? 1 : base * dim;
        ctx.strokeStyle = on ? hiColor(col) : col;
        ctx.lineWidth = track.width;
        ctx.beginPath();
        trackPath(ctx, track);
        ctx.stroke();
      }
      for (const { pad, path, fp } of g.pads) {
        const on = sel !== null && pad.net === sel && pad.net !== "";
        const fpSel = this.selectedRefs.has(fp.ref);
        ctx.globalAlpha = on || fpSel ? 1 : (isActive ? 0.95 : 0.55) * dim;
        ctx.fillStyle = on ? hiColor(col) : col;
        ctx.fill(path);
      }
    }
    // vias span layers: draw once on top
    ctx.globalAlpha = 1;
    for (const { via, path } of this.viaPaths) {
      const on = sel !== null && via.net === sel;
      ctx.globalAlpha = on ? 1 : sel ? 0.3 : 0.9;
      ctx.fillStyle = on ? "#ffffff" : "#b9bfc6";
      ctx.fill(path);
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(via.at[0], via.at[1], via.drill / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    // drilled pad holes
    for (const fp of b.footprints) for (const pad of fp.pads) if (pad.drill !== undefined) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = bg;
      const d = pad.drill;
      ctx.save();
      ctx.translate(pad.at[0], pad.at[1]);
      ctx.rotate((-pad.rot * Math.PI) / 180);
      ctx.beginPath();
      if (typeof d === "number") ctx.arc(0, 0, d / 2, 0, Math.PI * 2);
      else ctx.roundRect(-d[0] / 2, -d[1] / 2, d[0], d[1], Math.min(d[0], d[1]) / 2);
      ctx.fill();
      ctx.restore();
    }

    // outline
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css.getPropertyValue("--edge").trim() || "#e5d37a";
    ctx.lineWidth = 1.5 / this.scale;
    ctx.stroke(this.outline);

    // footprint outlines (silk/fab of the side facing the viewer)
    const facing = this.flipped ? "bottom" : "top";
    if (this.showSilk) {
      // board silkscreen art of the facing side (e.g. the bottom logo in Bottom view)
      const art = this.silkArt[facing];
      const silk = css.getPropertyValue("--silk").trim() || "#d8dde3";
      ctx.globalAlpha = this.selectedNet ? 0.3 : 0.85;
      ctx.fillStyle = silk;
      ctx.strokeStyle = silk;
      ctx.lineCap = "round";
      for (const p of art.fills) ctx.fill(p, "evenodd");
      for (const l of art.lines) {
        ctx.lineWidth = Math.max(l.width, 0.5 / this.scale);
        ctx.stroke(l.path);
      }
    }
    if (this.showSilk) {
      ctx.lineWidth = Math.max(0.05, 1 / this.scale);
      for (const fp of b.footprints) {
        const selFp = this.selectedRefs.has(fp.ref);
        if (fp.side !== facing && !selFp) continue;
        ctx.globalAlpha = selFp ? 1 : sel ? 0.25 : 0.55;
        ctx.strokeStyle = selFp ? "#ffffff" : css.getPropertyValue("--silk").trim() || "#d8dde3";
        ctx.lineWidth = selFp ? 2 / this.scale : Math.max(0.05, 1 / this.scale);
        ctx.stroke(this.fpPaths.get(fp.ref)!);
      }
    }

    this.drawLabels(css);
    ctx.globalAlpha = 1;
  }

  private drawLabels(css: CSSStyleDeclaration) {
    const { ctx, b } = this;
    const facing = this.flipped ? "bottom" : "top";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = (str: string, x: number, y: number, size: number, color: string, alpha: number) => {
      ctx.save();
      ctx.translate(x, y);
      if (this.flipped) ctx.scale(-1, 1);
      ctx.globalAlpha = alpha;
      ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(str, 0, 0);
      ctx.restore();
    };
    // reference designators
    if (this.showSilk && this.scale > 9) {
      for (const fp of b.footprints) {
        if (fp.side !== facing) continue;
        const c = fp.courtyard;
        const [x, y] = c ? [(c[0] + c[2]) / 2, (c[1] + c[3]) / 2] : fp.at;
        const w = c ? c[2] - c[0] : 1;
        const h = c ? c[3] - c[1] : 1;
        const size = Math.min(Math.max(Math.min(w, h) * 0.35, 0.35), 1.4);
        if (size * this.scale < 7) continue;
        text(fp.ref, x, y, size, css.getPropertyValue("--ref-label").trim() || "#f2f4f6",
          this.selectedNet ? 0.35 : 0.8);
      }
    }
    // pad pin names / numbers when zoomed in
    if (this.scale > 45) {
      for (const fp of b.footprints) {
        if (fp.side !== facing && !this.selectedRefs.has(fp.ref)) continue;
        for (const pad of fp.pads) {
          const m = Math.min(pad.size[0], pad.size[1]);
          const label = pad.pin ?? pad.num;
          if (!label) continue;
          const size = Math.min(m * 0.55, (Math.max(pad.size[0], pad.size[1]) * 1.4) / Math.max(label.length, 1));
          if (size * this.scale < 6) continue;
          text(label, pad.at[0], pad.at[1], size, "#ffffff", 0.9);
        }
      }
    }
  }

  // ---------- interaction ----------
  hitTest(sx: number, sy: number): Hit | null {
    const [x, y] = this.toBoard(sx, sy);
    return this.hitAt(x, y);
  }

  /**
   * What's at board point (x, y) mm. Defaults follow the 2D view (active layer first, visible
   * layers, 3 px slack); the 3D view passes the layer it hit and its own tolerance.
   */
  hitAt(x: number, y: number, opts: { active?: string; tol?: number; allLayers?: boolean } = {}): Hit | null {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const tol = opts.tol ?? 3 / this.scale; // 3 px slack
    const active = opts.active ?? this.active;
    // layers in "nearest first" order: active, then visible from the viewer side
    const order = [...this.b.layers].map((l) => l.id);
    if (this.flipped) order.reverse();
    const layers = [active, ...order.filter((l) => l !== active)].filter((l) => opts.allLayers || this.visible.has(l));
    for (const { via } of this.viaPaths) {
      if (Math.hypot(x - via.at[0], y - via.at[1]) <= via.size / 2 + tol) return { kind: "via", net: via.net, via };
    }
    for (const lid of layers) {
      const g = this.geom.get(lid)!;
      for (const it of g.pads) if (ctx.isPointInPath(it.path, x, y)) return { kind: "pad", net: it.pad.net, fp: it.fp, pad: it.pad, layer: lid };
      for (const it of g.pads) {
        if (Math.hypot(x - it.pad.at[0], y - it.pad.at[1]) <= Math.min(...it.pad.size) / 2 + tol)
          return { kind: "pad", net: it.pad.net, fp: it.fp, pad: it.pad, layer: lid };
      }
      let best: { d: number; t: Track; net: string } | null = null;
      for (const { net, track } of g.tracks) {
        const d = trackDist(track, x, y) - track.width / 2;
        if (d <= tol && (!best || d < best.d)) best = { d, t: track, net };
      }
      if (best) return { kind: "track", net: best.net, track: best.t };
      if (lid === active && this.showZones) {
        for (const z of g.zones) if (ctx.isPointInPath(z.path, x, y, "evenodd")) return { kind: "zone", net: z.net, layer: lid };
      }
    }
    // footprint body (courtyard), for parts without a net click
    for (const fp of this.b.footprints) {
      const c = fp.courtyard;
      if (c && x >= c[0] && x <= c[2] && y >= c[1] && y <= c[3]) return { kind: "footprint", net: "", fp };
    }
    // zones on other layers last
    for (const lid of layers) {
      if (lid === active || !this.showZones) continue;
      for (const z of this.geom.get(lid)!.zones) if (ctx.isPointInPath(z.path, x, y, "evenodd")) return { kind: "zone", net: z.net, layer: lid };
    }
    return null;
  }

  zoomTo(box: [number, number, number, number]) {
    const m = 1.5;
    this.fit([box[0] - m, box[1] - m, box[2] + m, box[3] + m], 120);
    this.userMoved = true;
  }

  private bindEvents() {
    const c = this.canvas;
    let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; scale: number } | null = null;

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomAt(e.offsetX, e.offsetY, k);
    }, { passive: false });

    // Pointer state must never outlive the gesture: a drag left armed pans the board on plain
    // mouse moves and swallows every later click. So: state is cleared before any callback runs,
    // callbacks can't throw out of the handler, and a missed pointerup (button released outside
    // the window, capture lost) is detected from e.buttons / lostpointercapture.
    const endGesture = (id?: number) => {
      if (id === undefined) pointers.clear();
      else pointers.delete(id);
      if (pointers.size < 2) pinch = null;
      drag = null;
    };
    const safe = (f: () => void) => {
      try {
        f();
      } catch (err) {
        console.error("pcb-review: selection handler failed", err);
      }
    };

    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      // a mouse has one pointer: anything left in the map is stale
      if (e.pointerType === "mouse") pointers.clear();
      try {
        c.setPointerCapture(e.pointerId);
      } catch { /* pointer already gone */ }
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pointers.size === 2) {
        const [a, bb] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - bb.x, a.y - bb.y), scale: this.scale };
        drag = null;
      } else {
        drag = { x: e.offsetX, y: e.offsetY, tx: this.tx, ty: this.ty, moved: false };
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (drag && e.pointerType === "mouse" && (e.buttons & 1) === 0) endGesture(); // missed pointerup
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && pointers.size === 2) {
        const [a, bb] = [...pointers.values()];
        const d = Math.hypot(a.x - bb.x, a.y - bb.y);
        const k = (pinch.scale * (d / pinch.d)) / this.scale;
        this.zoomAt((a.x + bb.x) / 2, (a.y + bb.y) / 2, k);
        return;
      }
      if (drag) {
        const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          this.userMoved = true;
          this.tx = drag.tx + dx;
          this.ty = drag.ty + dy;
          this.draw();
        }
        return;
      }
      safe(() => this.opts.onHover?.(this.hitTest(e.offsetX, e.offsetY), e.clientX, e.clientY));
    });
    c.addEventListener("pointerup", (e) => {
      const click = !!drag && !drag.moved && !pinch;
      endGesture(e.pointerId);
      if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId);
      if (click) safe(() => this.opts.onSelect(this.hitTest(e.offsetX, e.offsetY)));
    });
    c.addEventListener("pointercancel", (e) => endGesture(e.pointerId));
    c.addEventListener("lostpointercapture", (e) => {
      if (pointers.has(e.pointerId)) endGesture(e.pointerId);
    });
    window.addEventListener("blur", () => endGesture());
    c.addEventListener("pointerleave", () => this.opts.onHover?.(null, 0, 0));
    c.addEventListener("dblclick", () => this.fit());
  }

  private zoomAt(sx: number, sy: number, k: number) {
    this.userMoved = true;
    const ns = Math.min(400, Math.max(2, this.scale * k));
    k = ns / this.scale;
    this.tx = sx - (sx - this.tx) * k;
    this.ty = sy - (sy - this.ty) * k;
    this.scale = ns;
    this.draw();
  }
}

// ---------- helpers ----------
function hiColor(col: string): string {
  // blend toward white for highlighted copper
  const n = parseInt(col.slice(1), 16);
  const mix = (v: number) => Math.round(v + (255 - v) * 0.55);
  return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}

function polyPath(p: Path2D, poly: XY[], close = true) {
  if (!poly.length) return;
  p.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) p.lineTo(poly[i][0], poly[i][1]);
  if (close) p.closePath();
}

function padPath(pad: Pad): Path2D {
  const out = new Path2D();
  if (pad.polygon) {
    polyPath(out, pad.polygon);
    return out;
  }
  const [w, h] = pad.size;
  const local = new Path2D();
  switch (pad.shape) {
    case "circle":
      local.arc(0, 0, w / 2, 0, Math.PI * 2);
      break;
    case "oval":
      local.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2);
      break;
    case "roundrect":
      local.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) * (pad.roundrect_ratio ?? 0.25));
      break;
    default:
      local.rect(-w / 2, -h / 2, w, h);
  }
  out.addPath(local, new DOMMatrix().translate(pad.at[0], pad.at[1]).rotate(-pad.rot));
  return out;
}

function trackPath(ctx: CanvasRenderingContext2D, t: Track) {
  if (!t.mid) {
    ctx.moveTo(t.start[0], t.start[1]);
    ctx.lineTo(t.end[0], t.end[1]);
    return;
  }
  const pts = arcPoints(t.start, t.mid, t.end);
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
}

function arcPoints(a: XY, m: XY, e: XY, n = 24): XY[] {
  const [x1, y1] = a, [x2, y2] = m, [x3, y3] = e;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-12) return [a, e];
  const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy);
  const ang = (p: XY) => Math.atan2(p[1] - uy, p[0] - ux);
  const a1 = ang(a), a2 = ang(m), a3 = ang(e);
  const pos = (from: number, to: number) => ((to - from) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = pos(a1, a3);
  if (pos(a1, a2) > sweep) sweep -= 2 * Math.PI;
  return Array.from({ length: n + 1 }, (_, i) => [ux + r * Math.cos(a1 + (sweep * i) / n), uy + r * Math.sin(a1 + (sweep * i) / n)] as XY);
}

function segDist(a: XY, b: XY, x: number, y: number): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

function trackDist(t: Track, x: number, y: number): number {
  if (!t.mid) return segDist(t.start, t.end, x, y);
  const pts = arcPoints(t.start, t.mid, t.end);
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(pts[i - 1], pts[i], x, y));
  return d;
}
