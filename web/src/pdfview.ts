// Embedded datasheet viewer (pdf.js): one page at a time, fit-to-width, pin-name highlights.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Box = [number, number, number, number];

export interface PdfTarget {
  url: string;
  page: number;
  terms: string[];                    // words to highlight on every page (pin names)
  boxes?: Record<number, Box[]>;      // per page, PDF points top-left origin (from pinindex)
}

const docCache = new Map<string, Promise<PDFDocumentProxy>>();

export class PdfView {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private overlay: HTMLDivElement;
  private pageWrap: HTMLDivElement;
  private status: HTMLSpanElement;
  private pageInput: HTMLInputElement;
  private doc: PDFDocumentProxy | null = null;
  private target: PdfTarget | null = null;
  private page = 1;
  private zoom = 1;
  private task: RenderTask | null = null;
  private seq = 0;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "pdfview";
    this.el.innerHTML = `
      <div class="pdf-toolbar">
        <button data-a="prev" title="Previous page (←)">‹</button>
        <input class="pdf-page" type="number" min="1" value="1" aria-label="Page">
        <span class="pdf-status"></span>
        <button data-a="next" title="Next page (→)">›</button>
        <span class="spacer"></span>
        <button data-a="out" title="Zoom out">−</button>
        <button data-a="in" title="Zoom in">+</button>
        <a class="pdf-open" target="_blank" rel="noopener" title="Open the PDF in a new tab">↗</a>
      </div>
      <div class="pdf-scroll"><div class="pdf-page-wrap"><canvas></canvas><div class="pdf-overlay"></div></div></div>`;
    host.appendChild(this.el);
    this.canvas = this.el.querySelector("canvas")!;
    this.overlay = this.el.querySelector(".pdf-overlay")!;
    this.pageWrap = this.el.querySelector(".pdf-page-wrap")!;
    this.status = this.el.querySelector(".pdf-status")!;
    this.pageInput = this.el.querySelector(".pdf-page")!;
    this.el.querySelector(".pdf-toolbar")!.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("button")?.dataset.a;
      if (a === "prev") this.goto(this.page - 1);
      if (a === "next") this.goto(this.page + 1);
      if (a === "in") { this.zoom = Math.min(4, this.zoom * 1.25); this.render(); }
      if (a === "out") { this.zoom = Math.max(0.5, this.zoom / 1.25); this.render(); }
    });
    this.pageInput.addEventListener("change", () => this.goto(parseInt(this.pageInput.value, 10) || 1));
    this.el.tabIndex = 0;
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") this.goto(this.page - 1);
      if (e.key === "ArrowRight") this.goto(this.page + 1);
    });
    new ResizeObserver(() => this.render()).observe(this.el.querySelector(".pdf-scroll")!);
  }

  async open(t: PdfTarget) {
    const same = this.target?.url === t.url;
    this.target = t;
    if (!same) {
      this.doc = null;
      this.status.textContent = "loading…";
      let p = docCache.get(t.url);
      if (!p) {
        p = pdfjs.getDocument({ url: t.url }).promise;
        docCache.set(t.url, p);
      }
      try {
        this.doc = await p;
      } catch (err) {
        docCache.delete(t.url);
        this.status.textContent = "failed to load";
        throw err;
      }
      if (this.target !== t) return;
    }
    (this.el.querySelector(".pdf-open") as HTMLAnchorElement).href = `${t.url}#page=${t.page}`;
    this.goto(t.page);
  }

  goto(n: number) {
    if (!this.doc) return;
    this.page = Math.max(1, Math.min(this.doc.numPages, n));
    this.pageInput.value = String(this.page);
    this.pageInput.max = String(this.doc.numPages);
    this.status.textContent = `/ ${this.doc.numPages}`;
    if (this.target) (this.el.querySelector(".pdf-open") as HTMLAnchorElement).href = `${this.target.url}#page=${this.page}`;
    this.render();
  }

  private async render() {
    const doc = this.doc;
    if (!doc || !this.target) return;
    const my = ++this.seq;
    const page = await doc.getPage(this.page);
    if (my !== this.seq) return;
    const scroll = this.el.querySelector(".pdf-scroll") as HTMLElement;
    const avail = Math.max(200, scroll.clientWidth - 16);
    const base = page.getViewport({ scale: 1 });
    const cssScale = (avail / base.width) * this.zoom;
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: cssScale * dpr });
    this.task?.cancel();
    this.canvas.width = Math.floor(vp.width);
    this.canvas.height = Math.floor(vp.height);
    this.canvas.style.width = `${vp.width / dpr}px`;
    this.canvas.style.height = `${vp.height / dpr}px`;
    this.pageWrap.style.width = `${vp.width / dpr}px`;
    this.pageWrap.style.height = `${vp.height / dpr}px`;
    this.task = page.render({ canvas: this.canvas, canvasContext: this.canvas.getContext("2d")!, viewport: vp });
    try {
      await this.task.promise;
    } catch {
      return; // cancelled
    }
    if (my !== this.seq) return;
    const boxes = await this.highlightBoxes(page);
    if (my !== this.seq) return;
    this.overlay.innerHTML = "";
    const cssVp = page.getViewport({ scale: cssScale });
    const [vx0, , , vy1] = (page.view as number[]);
    let first: HTMLElement | null = null;
    for (const [x0, y0, x1, y1] of boxes) {
      // top-left-origin page coords -> PDF user space -> viewport
      const r = cssVp.convertToViewportRectangle([x0 + vx0, vy1 - y1, x1 + vx0, vy1 - y0]);
      const left = Math.min(r[0], r[2]), top = Math.min(r[1], r[3]);
      const d = document.createElement("div");
      d.className = "pdf-hl";
      const padPx = 2;
      d.style.left = `${left - padPx}px`;
      d.style.top = `${top - padPx}px`;
      d.style.width = `${Math.abs(r[2] - r[0]) + 2 * padPx}px`;
      d.style.height = `${Math.abs(r[3] - r[1]) + 2 * padPx}px`;
      this.overlay.appendChild(d);
      first ??= d;
    }
    if (first) {
      const top = first.offsetTop - scroll.clientHeight / 3;
      scroll.scrollTo({ top: Math.max(0, top), behavior: "instant" as ScrollBehavior });
    } else {
      scroll.scrollTo({ top: 0 });
    }
  }

  /** Index boxes for this page, plus whole-word matches of the terms in the page text. */
  private async highlightBoxes(page: PDFPageProxy): Promise<Box[]> {
    const t = this.target!;
    const out: Box[] = [...(t.boxes?.[this.page] ?? [])];
    if (!t.terms.length) return out;
    const tc = await page.getTextContent();
    const h = (page.view as number[])[3];
    const vx0 = (page.view as number[])[0];
    const words = new Set(t.terms.filter(Boolean));
    for (const item of tc.items) {
      if (!("str" in item) || !item.str) continue;
      const tokens = item.str.split(/([^A-Za-z0-9_+\-#]+)/);
      const fullW = item.width;
      const total = item.str.length || 1;
      let pos = 0;
      for (const tok of tokens) {
        if (words.has(tok)) {
          const [, , , , ex, ey] = item.transform as number[];
          const fh = Math.hypot(item.transform[2], item.transform[3]) || item.height;
          const x0 = ex - vx0 + (fullW * pos) / total;
          const x1 = x0 + (fullW * tok.length) / total;
          const box: Box = [x0, h - ey - fh * 0.85, x1, h - ey + fh * 0.2];
          if (!out.some((b) => overlap(b, box))) out.push(box);
        }
        pos += tok.length;
      }
    }
    return out;
  }
}

function overlap(a: Box, b: Box): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}
