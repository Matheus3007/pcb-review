import "./style.css";
import type { Bundle, Footprint, Pad, PinHit, PinIndexPart } from "./types";
import { View2D, layerColor, type Hit } from "./view2d";
import { PdfView } from "./pdfview";

// ---------------------------------------------------------------- state
interface State {
  tab: "copper" | "3d" | "bom" | "checks";
  net: string | null;
  ref: string | null;      // focused component
  pin: string | null;      // focused pad number on `ref`
}
const state: State = { tab: "copper", net: null, ref: null, pin: null };

let bundle: Bundle;
let base = "";             // URL prefix of the bundle (ends with "/")
let pinindex: Record<string, PinIndexPart> = {};
let view2d: View2D;
let view3d: import("./view3d").View3D | null = null;
let pdf: PdfView | null = null;
const fpByRef = new Map<string, Footprint>();

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------------------------------------------------------------- boot
interface BoardEntry { name: string; path: string; layers: number; size_mm: number[]; generated: string }
let boards: BoardEntry[] = [];

async function boot() {
  const params = new URLSearchParams(location.search);
  const url = params.get("bundle");
  bindOpeners();
  if (url) return openUrl(url);
  const idx = await fetch("bundles/index.json").then((r) => (r.ok ? r.json() : { boards: [] })).catch(() => ({ boards: [] }));
  boards = idx.boards;
  const want = params.get("board");
  const entry = boards.find((b) => b.name === want) ?? (boards.length === 1 ? boards[0] : null);
  if (!entry) {
    $("#app").innerHTML = picker(boards);
    return;
  }
  return openUrl(`bundles/${entry.path}`);
}

/** A published bundle (or any ?bundle=<url> serving board.json). */
async function openUrl(url: string) {
  const b: Bundle = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  });
  const at = new URL(url, location.href).href.replace(/[^/]*$/, "");
  const pi = b.pinindex ? await fetch(at + b.pinindex).then((r) => r.json()).catch(() => ({})) : {};
  start(b, at, pi);
}

/** Show a bundle. Called again when another board is opened: everything is rebuilt. */
function start(b: Bundle, bundleBase: string, pi: Record<string, PinIndexPart>, local?: { warnings: string[] }) {
  view3d?.dispose();
  view3d = null;
  pdf = null;
  bundle = b;
  base = bundleBase;
  pinindex = pi;
  fpByRef.clear();
  for (const fp of bundle.footprints) fpByRef.set(fp.ref, fp);
  renderShell(local ? [] : boards, local ? `${b.name} (local)` : undefined);
  document.title = `${bundle.name} · pcb-review`;
  $("#board-name").textContent = local ? `${bundle.name} · local` : bundle.name;
  if (local) {
    state.tab = "copper";
    state.net = state.ref = state.pin = null;
    history.replaceState(null, "", location.pathname + location.search);
    banner(`Opened <b>${esc(b.name)}</b> from your files. Nothing was uploaded: it only lives in this tab.`, local.warnings);
  }
  setup();
  if (!local) readHash();
  apply();
  // hook for the e2e tests (web/e2e): read-only access to the live objects
  (window as unknown as { pcbReview: unknown }).pcbReview = { bundle, state, view2d, get view3d() { return view3d; } };
}

// ---------------------------------------------------------------- open a local board
async function openLocal(files: import("./importer/importer").FileMap) {
  const [{ importBoard }] = await Promise.all([import("./importer/importer")]);
  // shared datasheet links / pin pages / published GLBs for boards that weren't exported
  const lib = await fetch("bundles/library.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const { bundle: b, pinindex: pi, warnings } = await importBoard(files, lib);
  start(b, new URL("bundles/", location.href).href, pi, { warnings });
}

async function handleOpen(get: () => Promise<import("./importer/importer").FileMap>) {
  const dlg = document.getElementById("open-dialog") as HTMLDialogElement | null;
  const status = dlg?.querySelector(".open-status");
  if (status) status.textContent = "Reading…";
  try {
    await openLocal(await get());
    dlg?.close();
  } catch (err) {
    console.warn(err);
    if (status) status.textContent = String((err as Error).message ?? err);
    else banner(`Couldn't open that: ${esc(String((err as Error).message ?? err))}`, []);
    dlg?.showModal?.();
  }
}

let openersBound = false;
function bindOpeners() {
  if (openersBound) return;
  openersBound = true;
  const dlg = document.createElement("dialog");
  dlg.id = "open-dialog";
  dlg.className = "open-dialog";
  dlg.innerHTML = `
    <form method="dialog"><button class="ghost close" aria-label="Close">✕</button></form>
    <h2>Open a pcb-lab board</h2>
    <div class="dropzone" tabindex="0">
      <p><b>Drop</b> a board folder (<code>boards/&lt;name&gt;</code>), its <code>build/</code> folder, or a <code>.zip</code> of either.</p>
      <p class="buttons"><label class="btn">Choose folder…<input type="file" id="open-folder" webkitdirectory multiple hidden></label>
      <label class="btn">Choose .zip…<input type="file" id="open-zip" accept=".zip,application/zip" hidden></label></p>
    </div>
    <p class="open-status muted small"></p>
    <p class="muted small">Read in your browser: nothing is uploaded. Uses <code>build/fab/*.kicad_pcb</code>, plus <code>build/work/netlist.json</code> (pin names), the BOM, <code>build/reports/</code> and <code>board.yaml</code> when present. Datasheets open from LCSC for parts in pcb-lab's library.</p>`;
  document.body.appendChild(dlg);
  dlg.querySelector<HTMLInputElement>("#open-folder")!.addEventListener("change", (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.length) handleOpen(async () => (await import("./importer/files")).fromFileList(files));
  });
  dlg.querySelector<HTMLInputElement>("#open-zip")!.addEventListener("change", (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.length) handleOpen(async () => (await import("./importer/files")).fromFileList(files));
  });
  // drag-and-drop anywhere on the page
  const overlay = document.createElement("div");
  overlay.className = "drop-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `<div>Drop a pcb-lab board folder or .zip</div>`;
  document.body.appendChild(overlay);
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; overlay.hidden = false; } });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const dt = e.dataTransfer!;
    // read the entries synchronously-ish: DataTransfer items expire after the event
    const pending = import("./importer/files").then((m) => m.fromDataTransfer(dt));
    handleOpen(() => pending);
  });
  document.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-open]")) {
      e.preventDefault();
      dlg.querySelector(".open-status")!.textContent = "";
      dlg.showModal();
    }
  });
}

function banner(html: string, warnings: string[]) {
  document.querySelector(".banner")?.remove();
  const el = document.createElement("div");
  el.className = "banner";
  el.innerHTML = `<span>${html}</span>${warnings.length ? `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}<button class="ghost" aria-label="Dismiss">✕</button>`;
  el.querySelector("button")!.addEventListener("click", () => el.remove());
  const main = document.querySelector(".main");
  main ? main.before(el) : document.body.prepend(el);
}

function picker(boards: { name: string; layers: number; size_mm: number[]; generated: string }[]): string {
  const open = `<p><button class="btn" data-open>Open a board from your computer…</button></p>
    <p class="muted small">Any pcb-lab board: drop its folder or a .zip anywhere on this page. Nothing is uploaded.</p>`;
  if (!boards.length) return `<div class="empty"><h1>pcb-review</h1><p>No published boards.</p>${open}</div>`;
  return `<div class="empty"><h1>pcb-review</h1><ul class="board-list">${boards
    .map((b) => `<li><a href="?board=${encodeURIComponent(b.name)}"><b>${esc(b.name)}</b><span>${b.layers} layers · ${b.size_mm.join(" × ")} mm</span></a></li>`)
    .join("")}</ul>${open}</div>`;
}

function renderShell(boards: { name: string }[], localName?: string) {
  $("#app").innerHTML = `
  <header class="topbar">
    <a class="brand" href="./" title="All boards">pcb-review</a>
    ${boards.length > 1 && !localName ? `<select id="board-select" aria-label="Board">${boards.map((b) => `<option>${esc(b.name)}</option>`).join("")}</select>` : `<span id="board-name" class="board-name"></span>`}
    <nav class="tabs" role="tablist">
      <button data-tab="copper" role="tab">Copper</button>
      <button data-tab="3d" role="tab">3D</button>
      <button data-tab="bom" role="tab">BOM</button>
      <button data-tab="checks" role="tab">Checks</button>
    </nav>
    <button class="ghost open-btn" data-open title="Open a pcb-lab board folder or .zip from your computer">Open…</button>
    <div class="search"><input id="search" list="search-list" placeholder="Net or ref…" autocomplete="off" spellcheck="false"><datalist id="search-list"></datalist></div>
  </header>
  <div class="layerbar" id="layerbar"></div>
  <main class="main">
    <section class="stage">
      <div id="pane-copper" class="pane"></div>
      <div id="pane-3d" class="pane"></div>
      <div id="pane-bom" class="pane scroll"></div>
      <div id="pane-checks" class="pane scroll"></div>
      <div id="tooltip" class="tooltip" hidden></div>
    </section>
    <div class="splitter" id="splitter" title="Drag to resize"></div>
    <aside class="side" id="side">
      <div class="side-info" id="side-info"></div>
      <div class="side-pdf" id="side-pdf"></div>
    </aside>
  </main>`;
  if (!$("#board-name")) {
    const span = document.createElement("span");
    span.id = "board-name";
    span.hidden = true;
    document.body.appendChild(span);
  }
  const sel = document.getElementById("board-select") as HTMLSelectElement | null;
  if (sel) {
    sel.value = new URLSearchParams(location.search).get("board") ?? boards[0]?.name ?? "";
    sel.addEventListener("change", () => (location.search = `?board=${encodeURIComponent(sel.value)}`));
  }
}

// ---------------------------------------------------------------- setup
function setup() {
  view2d = new View2D($("#pane-copper"), bundle, {
    onSelect: (hit) => selectHit(hit),
    onHover: (hit, x, y) => tooltip(hit, x, y),
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab as State["tab"];
      apply();
    });
  }
  buildLayerBar();
  buildSearch();
  $("#pane-bom").innerHTML = bomHtml();
  $("#pane-checks").innerHTML = checksHtml();
  initSplitter();
  if (globalsBound) return;
  globalsBound = true;
  document.addEventListener("click", onLinkClick);
  window.addEventListener("hashchange", () => {
    readHash();
    apply(false);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, select, textarea")) return;
    if (e.key === "Escape") { state.net = state.ref = state.pin = null; apply(); }
    if (e.key === "f") view2d.fit();
    if (e.key === "x" && state.tab === "3d") $<HTMLInputElement>("[data-t3=xray]")?.click();
    if (e.key === "b") { flip(!view2d.flipped); syncLayerBar(); }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= bundle.layers.length) { view2d.active = bundle.layers[n - 1].id; view2d.visible.add(view2d.active); syncLayerBar(); view2d.draw(); }
  });
}
let globalsBound = false;

function buildLayerBar() {
  const bar = $("#layerbar");
  bar.innerHTML = bundle.layers.map((l, i) => `
    <label class="layer" data-layer="${l.id}" title="Click the name to make it the active layer (key ${i + 1}); the box toggles visibility">
      <input type="checkbox" checked><span class="swatch" style="--c:${layerColor(l.id)}"></span><span class="lname">${esc(l.name)}</span>
    </label>`).join("") + `
    <span class="sep"></span>
    <label class="toggle"><input type="checkbox" id="t-zones" checked> Zones</label>
    <label class="toggle"><input type="checkbox" id="t-silk" checked> Outlines</label>
    <label class="toggle" title="View from the bottom (key b)"><input type="checkbox" id="t-flip"> Bottom view</label>
    <button class="ghost" id="t-fit" title="Fit board (key f, or double-click)">Fit</button>`;
  bar.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const lab = t.closest<HTMLElement>(".layer");
    if (lab && !(t instanceof HTMLInputElement)) {
      e.preventDefault();
      view2d.active = lab.dataset.layer!;
      view2d.visible.add(view2d.active);
      syncLayerBar();
      view2d.draw();
    }
  });
  bar.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    const lab = t.closest<HTMLElement>(".layer");
    if (lab) t.checked ? view2d.visible.add(lab.dataset.layer!) : view2d.visible.delete(lab.dataset.layer!);
    if (t.id === "t-zones") view2d.showZones = t.checked;
    if (t.id === "t-silk") view2d.showSilk = t.checked;
    if (t.id === "t-flip") flip(t.checked);
    syncLayerBar();
    view2d.draw();
  });
  $("#t-fit").addEventListener("click", () => view2d.fit());
  syncLayerBar();
}

/** Bottom view: the outer layer facing the viewer becomes the active one. */
function flip(bottom: boolean) {
  const top = bundle.layers[0].id, bot = bundle.layers[bundle.layers.length - 1].id;
  if (bottom && view2d.active === top) view2d.active = bot;
  if (!bottom && view2d.active === bot) view2d.active = top;
  view2d.visible.add(view2d.active);
  view2d.setFlipped(bottom);
  view2d.draw();
}

function syncLayerBar() {
  for (const lab of document.querySelectorAll<HTMLElement>(".layer")) {
    const id = lab.dataset.layer!;
    lab.classList.toggle("active", id === view2d.active);
    (lab.querySelector("input") as HTMLInputElement).checked = view2d.visible.has(id);
  }
  ($("#t-flip") as HTMLInputElement).checked = view2d.flipped;
}

function buildSearch() {
  const dl = $("#search-list");
  const refs = bundle.footprints.map((f) => `<option value="${esc(f.ref)}">${esc(f.value)}</option>`);
  const nets = bundle.nets.map((n) => `<option value="${esc(n)}">net</option>`);
  dl.innerHTML = refs.concat(nets).join("");
  const input = $<HTMLInputElement>("#search");
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (fpByRef.has(v)) { state.ref = v; state.pin = null; state.net = null; state.tab = state.tab === "3d" ? "3d" : "copper"; zoomToRef(v); }
    else {
      const net = bundle.nets.find((n) => n === v) ?? bundle.nets.find((n) => n.toLowerCase() === v.toLowerCase());
      if (net) { state.net = net; state.ref = state.pin = null; }
    }
    input.value = "";
    input.blur();
    apply();
  });
}

// ---------------------------------------------------------------- selection
function selectHit(hit: Hit | null) {
  if (!hit) { state.net = state.ref = state.pin = null; }
  else if (hit.kind === "pad") { state.net = hit.net || null; state.ref = hit.fp.ref; state.pin = hit.pad.num; }
  else if (hit.kind === "footprint") { state.net = null; state.ref = hit.fp.ref; state.pin = null; }
  else { state.net = hit.net || null; state.ref = null; state.pin = null; }
  apply();
}

function apply(pushHash = true) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) b.classList.toggle("on", b.dataset.tab === state.tab);
  for (const p of document.querySelectorAll<HTMLElement>(".pane")) p.classList.toggle("on", p.id === `pane-${state.tab}`);
  $("#layerbar").classList.toggle("hidden", state.tab !== "copper");
  view2d.selectedNet = state.net;
  view2d.selectedRefs = new Set(state.ref ? [state.ref] : []);
  view2d.resize();
  if (state.tab === "3d") ensure3d();
  guard("3D highlight", () => {
    view3d?.highlight(refsOnSelection());
    view3d?.setNet(state.net);
  });
  if (state.tab === "3d") view3d?.resize();
  for (const tr of document.querySelectorAll<HTMLElement>("#pane-bom tr[data-refs]")) {
    tr.classList.toggle("sel", !!state.ref && tr.dataset.refs!.split(",").includes(state.ref));
  }
  // a failing pane must not take selection down with it
  guard("side pane", renderSide);
  if (pushHash) writeHash();
}

function guard(what: string, f: () => void) {
  try {
    f();
  } catch (err) {
    console.error(`pcb-review: ${what} failed`, err);
  }
}

/** 3D pick -> the same Hit the 2D view would produce, so both views select identically. */
function hitFrom3d(p: import("./view3d").Pick3D | null): Hit | null {
  if (!p) return null;
  if ("ref" in p) {
    const fp = fpByRef.get(p.ref);
    return fp ? { kind: "footprint", net: "", fp } : null;
  }
  // a 3D click is coarser than a 2D one: 0.2 mm slack, every layer considered, hit layer first
  const hit = view2d.hitAt(p.point[0], p.point[1], { active: p.layer, tol: 0.2, allLayers: true });
  return hit;
}

function refsOnSelection(): string[] {
  if (state.net) return [...new Set(bundle.footprints.filter((f) => f.pads.some((p) => p.net === state.net)).map((f) => f.ref))];
  return state.ref ? [state.ref] : [];
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.tab !== "copper") p.set("tab", state.tab);
  if (state.net) p.set("net", state.net);
  if (state.ref) p.set("ref", state.ref);
  if (state.pin) p.set("pin", state.pin);
  const h = p.toString();
  if (h !== location.hash.slice(1)) history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.tab = (p.get("tab") as State["tab"]) || "copper";
  state.net = p.get("net");
  state.ref = p.get("ref");
  state.pin = p.get("pin");
  if (state.ref && !fpByRef.has(state.ref)) state.ref = state.pin = null;
}

function zoomToRef(ref: string) {
  const fp = fpByRef.get(ref);
  if (!fp) return;
  const c = fp.courtyard ?? [fp.at[0] - 1, fp.at[1] - 1, fp.at[0] + 1, fp.at[1] + 1];
  view2d.zoomTo(c);
}

async function ensure3d() {
  if (view3d) return;
  const host = $("#pane-3d");
  host.innerHTML = `<div class="loading">Loading 3D…</div>`;
  try {
    const mod = await import("./view3d");
    host.innerHTML = `<div class="view3d-bar">
        <button data-view="iso">Iso</button><button data-view="top">Top</button><button data-view="bottom">Bottom</button>
        <span class="sep"></span>
        <label class="toggle"><input type="checkbox" data-t3="parts" checked> Parts</label>
        <label class="toggle"><input type="checkbox" data-t3="copper" checked> Copper</label>
        <label class="toggle" title="Translucent board, all copper layers in their 2D colours (key x)"><input type="checkbox" data-t3="xray"> X-ray</label>
      </div>`;
    view3d = mod.mountView3D(host, bundle, base, { onPick: (hit) => selectHit(hitFrom3d(hit)) });
    const bar = host.querySelector(".view3d-bar")!;
    bar.addEventListener("click", (e) => {
      const v = (e.target as HTMLElement).closest<HTMLElement>("[data-view]")?.dataset.view;
      if (v) view3d?.view(v as "iso" | "top" | "bottom");
    });
    bar.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.t3 === "parts") view3d?.setParts(t.checked);
      if (t.dataset.t3 === "copper") view3d?.setCopper(t.checked);
      if (t.dataset.t3 === "xray") view3d?.setXray(t.checked);
    });
    view3d.setNet(state.net);
    view3d.highlight(refsOnSelection());
  } catch (err) {
    host.innerHTML = `<div class="loading">3D view failed: ${esc(String(err))}</div>`;
  }
}

// ---------------------------------------------------------------- tooltip
function tooltip(hit: Hit | null, x: number, y: number) {
  const tt = $("#tooltip");
  if (!hit) { tt.hidden = true; return; }
  let html = "";
  if (hit.kind === "pad") html = `<b>${esc(hit.fp.ref)}</b> pad ${esc(hit.pad.num)}${hit.pad.pin ? ` · <b>${esc(hit.pad.pin)}</b>` : ""}<br>${netLabel(hit.net)}`;
  else if (hit.kind === "via") html = `via ⌀${hit.via.size} / ${hit.via.drill} mm<br>${netLabel(hit.net)}`;
  else if (hit.kind === "track") html = `track ${hit.track.width} mm · ${esc(hit.track.layer)}<br>${netLabel(hit.net)}`;
  else if (hit.kind === "zone") html = `zone · ${esc(hit.layer)}<br>${netLabel(hit.net)}`;
  else html = `<b>${esc(hit.fp.ref)}</b> ${esc(hit.fp.value)}`;
  tt.innerHTML = html;
  tt.hidden = false;
  const r = $(".stage").getBoundingClientRect();
  tt.style.left = `${Math.min(x - r.left + 14, r.width - tt.offsetWidth - 8)}px`;
  tt.style.top = `${Math.min(y - r.top + 14, r.height - tt.offsetHeight - 8)}px`;
}
const netLabel = (n: string) => (n ? `net <b>${esc(n)}</b>` : `<i>no net</i>`);

// ---------------------------------------------------------------- side pane
const kindLabel: Record<string, string> = { pintable: "pin table", pinout: "pinout", description: "description", other: "mention" };
function renderSide() {
  const info = $("#side-info");
  if (state.net) info.innerHTML = netHtml(state.net);
  else if (state.ref) info.innerHTML = fpHtml(fpByRef.get(state.ref)!);
  else info.innerHTML = summaryHtml();
  // scroll the selected pin into view inside the pane only (scrollIntoView would also scroll the page on phones)
  const row = info.querySelector<HTMLElement>(".pinrow.sel");
  if (row) {
    const r = row.getBoundingClientRect(), box = info.getBoundingClientRect();
    if (r.bottom > box.bottom || r.top < box.top) info.scrollTop += r.top - box.top - box.height / 3;
  }
  showDatasheet();
}

function summaryHtml(): string {
  const c = bundle.reports.checks as { pass?: boolean; errors?: number; warnings?: number; waived?: number } | undefined;
  const w = bundle.bbox[2] - bundle.bbox[0], h = bundle.bbox[3] - bundle.bbox[1];
  const placed = bundle.footprints.filter((f) => !f.dnp).length;
  return `
    <h2>${esc(bundle.name)}</h2>
    <dl class="kv">
      <dt>Size</dt><dd>${w.toFixed(2)} × ${h.toFixed(2)} mm, ${bundle.thickness} mm thick</dd>
      <dt>Copper</dt><dd>${bundle.layers.length} layers</dd>
      <dt>Parts</dt><dd>${placed} placed${bundle.footprints.length - placed ? `, ${bundle.footprints.length - placed} DNP` : ""} · ${Object.keys(bundle.parts).length} unique LCSC</dd>
      <dt>Nets</dt><dd>${bundle.nets.length}</dd>
      <dt>Routing</dt><dd>${bundle.tracks.length} segments · ${bundle.vias.length} vias</dd>
      ${c ? `<dt>Checks</dt><dd><a href="#tab=checks" class="badge ${c.pass ? "ok" : "bad"}">${c.pass ? "PASS" : "FAIL"}</a> ${c.errors ?? 0} errors · ${c.warnings ?? 0} warnings · ${c.waived ?? 0} waived</dd>` : ""}
    </dl>
    <p class="hint">Click a track, via, pad or zone to select its net. Click a part body to inspect the part. Esc clears.</p>`;
}

function partLinks(lcsc?: string): string {
  if (!lcsc) return "";
  const p = bundle.parts[lcsc];
  return `<span class="links"><a href="${p?.lcsc_url ?? `https://www.lcsc.com/product-detail/${lcsc}.html`}" target="_blank" rel="noopener">LCSC ${esc(lcsc)}</a> · <a href="${p?.jlc_url ?? "#"}" target="_blank" rel="noopener">JLC</a>${p?.datasheet?.url ? ` · <a href="${p.datasheet.url}" target="_blank" rel="noopener">datasheet PDF</a>` : ""}</span>`;
}

function netHtml(net: string): string {
  const rows: { fp: Footprint; pads: Pad[] }[] = [];
  for (const fp of bundle.footprints) {
    const pads = fp.pads.filter((p) => p.net === net);
    // collapse duplicate pad numbers (e.g. 4x GND on USB-C)
    const seen = new Set<string>();
    const uniq = pads.filter((p) => !seen.has(p.num) && seen.add(p.num));
    if (uniq.length) rows.push({ fp, pads: uniq });
  }
  const len: Record<string, number> = {};
  for (const t of bundle.tracks) if (t.net === net) len[t.layer] = (len[t.layer] ?? 0) + Math.hypot(t.end[0] - t.start[0], t.end[1] - t.start[1]);
  const vias = bundle.vias.filter((v) => v.net === net).length;
  const zones = [...new Set(bundle.zones.filter((z) => z.net === net).map((z) => z.layer))];
  const lens = Object.entries(len).map(([l, v]) => `<span class="chip" style="--c:${layerColor(l)}">${esc(l)} ${v.toFixed(1)} mm</span>`).join("");
  return `
    <h2><span class="muted">net</span> ${esc(net)}</h2>
    <div class="stats">${lens}${vias ? `<span class="chip">${vias} via${vias > 1 ? "s" : ""}</span>` : ""}${zones.map((z) => `<span class="chip" style="--c:${layerColor(z)}">${esc(z)} zone</span>`).join("")}</div>
    <div class="pinlist">${rows.map(({ fp, pads }) => `
      <div class="fpgroup">
        <div class="fphead"><a href="#ref=${encodeURIComponent(fp.ref)}" data-ref="${esc(fp.ref)}"><b>${esc(fp.ref)}</b></a> <span class="muted">${esc(fp.value)}</span>${fp.dnp ? ` <span class="badge">DNP</span>` : ""}</div>
        ${pads.map((p) => pinRow(fp, p)).join("")}
      </div>`).join("")}
    </div>`;
}

function pinRow(fp: Footprint, p: Pad, showNet = false): string {
  const sel = state.ref === fp.ref && state.pin === p.num;
  const hasDs = !!dsOf(fp);
  return `<a class="pinrow${sel ? " sel" : ""}" href="#" data-pinref="${esc(fp.ref)}" data-pin="${esc(p.num)}" ${showNet && p.net ? `data-net="${esc(p.net)}"` : ""}>
      <span class="pnum">${esc(p.num)}</span><span class="pname">${esc(p.pin ?? "")}</span>
      ${showNet ? `<span class="pnet">${p.net ? esc(p.net) : `<i class="muted">nc</i>`}</span>` : ""}
      ${hasDs ? `<span class="ds" title="Open the datasheet at this pin">PDF</span>` : ""}</a>`;
}

function fpHtml(fp: Footprint): string {
  const seen = new Set<string>();
  const pads = fp.pads.filter((p) => !seen.has(p.num) && seen.add(p.num));
  pads.sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
  const part = fp.lcsc ? bundle.parts[fp.lcsc] : undefined;
  return `
    <h2>${esc(fp.ref)} <span class="muted">${esc(fp.value)}</span>${fp.dnp ? ` <span class="badge">DNP</span>` : ""}</h2>
    <dl class="kv">
      ${fp.mpn ? `<dt>MPN</dt><dd>${esc(fp.mpn)}</dd>` : ""}
      <dt>Footprint</dt><dd>${esc(fp.footprint.split(":").pop()!)}</dd>
      <dt>Placement</dt><dd>${fp.side} · (${fp.at[0].toFixed(2)}, ${fp.at[1].toFixed(2)}) · ${fp.rot}°</dd>
      ${fp.lcsc ? `<dt>Order</dt><dd>${partLinks(fp.lcsc)}</dd>` : ""}
      ${part?.pinout_source ? `<dt>Pinout</dt><dd class="small">${esc(part.pinout_source)}</dd>` : ""}
    </dl>
    <div class="pinlist">${pads.map((p) => pinRow(fp, p, true)).join("")}</div>`;
}

/** Which datasheet + page to show for the current selection. */
function showDatasheet() {
  const host = $("#side-pdf");
  // the focused pin, else the first pin on the net of the biggest part with a datasheet
  let fp: Footprint | undefined;
  let pad: Pad | undefined;
  if (state.ref) {
    fp = fpByRef.get(state.ref);
    pad = state.pin ? fp?.pads.find((p) => p.num === state.pin) : undefined;
    // part + net but no pin: the part's pin on that net
    if (!pad && state.net) pad = fp?.pads.find((p) => p.net === state.net);
  }
  if ((!fp || !dsOf(fp)) && state.net) {
    const cands = bundle.footprints.filter((f) => dsOf(f) && f.pads.some((p) => p.net === state.net)).sort((a, b) => b.pads.length - a.pads.length);
    if (cands[0]) {
      fp = cands[0];
      pad = fp.pads.find((p) => p.net === state.net);
    }
  }
  const ds = fp && dsOf(fp);
  if (!fp || !ds) {
    host.classList.remove("on");
    host.innerHTML = "";
    delete host.dataset.mode; // the viewer is gone: rebuild it next time (this was the wedge bug)
    pdf = null;
    return;
  }
  host.classList.add("on");
  const idx = pinindex[fp.lcsc!];
  let hits: PinHit[] = [];
  if (pad && idx) hits = idx.pins[pad.pin ?? ""]?.length ? idx.pins[pad.pin!] : idx.pins[pad.num] ?? idx.pads?.[pad.num] ?? [];
  const page = hits[0]?.page ?? 1;
  const pinName = pad ? esc(pad.pin ?? pad.num) : "";

  // (re)build the frame when switching between the pdf.js viewer and the iframe
  const mode = ds.file ? "pdfjs" : "iframe";
  if (host.dataset.mode !== mode || !host.querySelector(".pdf-head")) {
    host.dataset.mode = mode;
    host.innerHTML = `<div class="pdf-head"></div>` + (mode === "iframe" ? `<div class="pdf-frame"></div>` : "");
    pdf = mode === "pdfjs" ? new PdfView(host) : null;
  }
  const head = host.querySelector(".pdf-head") as HTMLElement;
  const src = ds.file ? base + ds.file : ds.url!;
  head.innerHTML = `<span class="pdf-title">${esc(fp.mpn ?? fp.value)}${pad ? ` · pin <b>${pinName}</b>` : ""}</span>
    <span class="hits">${hits.slice(0, 5).map((h) => `<button class="chip hit" data-page="${h.page}" title="score ${h.score.toFixed(2)}">p.${h.page} ${kindLabel[h.kind] ?? h.kind}</button>`).join("")}${pad && idx && !hits.length ? `<span class="muted small">pin not found in the datasheet</span>` : ""}</span>
    ${mode === "iframe" ? `<span class="pdf-note muted small">${hits[0] ? `Opened at p.${hits[0].page} for <b>${pinName}</b> · ` : ""}LCSC-hosted PDF <a href="${src}#page=${page}" target="_blank" rel="noopener">↗ new tab</a></span>` : ""}`;
  head.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button.hit");
    if (!b) return;
    const n = parseInt(b.dataset.page!, 10);
    if (pdf) pdf.goto(n);
    else frameTo(host, src, n);
  };
  if (pdf) {
    // highlight the pin name; a bare pad number ("1") would light up every digit on the page
    const terms = pad?.pin ? [pad.pin] : pad && /^[A-Z]+\d+$/i.test(pad.num) ? [pad.num] : [];
    const boxes: Record<number, [number, number, number, number][]> = {};
    for (const h of hits) (boxes[h.page] ??= []).push(...h.boxes);
    pdf.open({ url: src, page, terms, boxes }).catch((err) => console.error(err));
  } else {
    frameTo(host, src, page);
  }
}

/**
 * Remote datasheets (LCSC/JLC) send no CORS headers, so pdf.js can't read them from this site;
 * the browser's own PDF viewer can, in an iframe, and honours #page=N. A new iframe per page:
 * changing only the fragment doesn't navigate every viewer.
 */
function frameTo(host: HTMLElement, url: string, page: number) {
  const box = host.querySelector(".pdf-frame") as HTMLElement;
  // page= works in Chrome's and Firefox's viewers; zoom/pagemode are pdf.js (Firefox) extras, ignored elsewhere
  const want = `${url}#page=${page}&zoom=page-width&pagemode=none`;
  if (box.dataset.src === want) return;
  box.dataset.src = want;
  box.innerHTML = `<iframe title="Datasheet" src="${esc(want)}" referrerpolicy="no-referrer"></iframe>`;
}

function dsOf(fp: Footprint): { file?: string; url?: string } | undefined {
  const d = fp.lcsc ? bundle.parts[fp.lcsc]?.datasheet : undefined;
  return d && (d.file || d.url) ? d : undefined;
}

function onLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-pinref], [data-ref], [data-goto-ref], [data-at]");
  if (!a) return;
  if (a.dataset.pinref) {
    e.preventDefault();
    state.ref = a.dataset.pinref;
    state.pin = a.dataset.pin!;
    if (a.dataset.net) state.net = a.dataset.net;
    apply();
  } else if (a.dataset.ref || a.dataset.gotoRef) {
    e.preventDefault();
    const ref = (a.dataset.ref ?? a.dataset.gotoRef)!;
    state.ref = ref;
    state.pin = null;
    state.net = null;
    if (a.dataset.gotoRef) state.tab = "copper";
    apply();
    zoomToRef(ref);
  } else if (a.dataset.at) {
    e.preventDefault();
    const [x, y] = a.dataset.at.split(",").map(Number);
    state.tab = "copper";
    apply();
    view2d.zoomTo([x - 1, y - 1, x + 1, y + 1]);
  }
}

// ---------------------------------------------------------------- BOM / checks
function bomHtml(): string {
  const rows = bundle.bom.length ? bundle.bom : [];
  return `<div class="tablewrap"><h2>Bill of materials <span class="muted">${rows.reduce((n, r) => n + r.refs.length, 0)} placements · ${rows.length} lines</span></h2>
  <table class="grid"><thead><tr><th>Qty</th><th>Value</th><th>Designators</th><th>Footprint</th><th>LCSC</th><th>Datasheet</th></tr></thead><tbody>
  ${rows.map((r) => {
    const part = bundle.parts[r.lcsc];
    const ds = part?.datasheet?.file || part?.datasheet?.url ? `<a href="#" data-pinref="${esc(r.refs[0])}" data-pin="">open</a>` : `<span class="muted">—</span>`;
    return `<tr data-refs="${esc(r.refs.join(","))}"><td class="num">${r.refs.length}</td><td>${esc(r.comment)}</td>
      <td>${r.refs.map((ref) => `<a href="#" data-goto-ref="${esc(ref)}">${esc(ref)}</a>`).join(" ")}</td>
      <td class="small">${esc(r.footprint)}</td><td>${r.lcsc ? partLinks(r.lcsc) : ""}</td><td>${ds}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

interface Finding { check: string; severity: string; msg: string; waived?: string }
function checksHtml(): string {
  const c = bundle.reports.checks as { pass: boolean; errors: number; warnings: number; waived: number; findings: Finding[] } | undefined;
  const drc = bundle.reports.drc as { violations?: { description: string; severity: string; type: string; items: { description: string; pos: { x: number; y: number } }[] }[]; unconnected_items?: unknown[]; kicad_version?: string } | undefined;
  if (!c && !drc) return `<div class="tablewrap"><p class="hint">No reports in this bundle.</p></div>`;
  const refRe = /\b([A-Z]{1,3}\d{1,3})\b/g;
  const linkRefs = (s: string) => esc(s).replace(refRe, (m) => (fpByRef.has(m) ? `<a href="#" data-goto-ref="${m}">${m}</a>` : m));
  const groups = new Map<string, Finding[]>();
  for (const f of c?.findings ?? []) {
    const g = f.check.split("/")[0];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }
  const sevIcon = (f: Finding) => (f.waived ? `<span class="sev waived" title="waived">W</span>` : f.severity === "ok" ? `<span class="sev ok">✓</span>` : f.severity === "error" ? `<span class="sev bad">✕</span>` : f.severity === "warning" ? `<span class="sev warn">!</span>` : `<span class="sev info">i</span>`);
  const o = bundle.origin;
  return `<div class="tablewrap">
    ${c ? `<h2>Checks <span class="badge ${c.pass ? "ok" : "bad"}">${c.pass ? "PASS" : "FAIL"}</span> <span class="muted">${c.errors} errors · ${c.warnings} warnings · ${c.waived} waived</span></h2>
    <div class="filters"><label><input type="checkbox" id="f-ok"> show passed</label></div>
    ${[...groups].map(([g, fs]) => `<details ${fs.some((f) => f.severity !== "ok") ? "open" : ""} class="cgroup"><summary><b>${esc(g)}</b> <span class="muted">${fs.length} · ${fs.filter((f) => f.severity !== "ok").length} not ok</span></summary>
      <ul class="findings">${fs.map((f) => `<li class="${f.severity === "ok" && !f.waived ? "is-ok" : ""}">${sevIcon(f)}<code>${esc(f.check)}</code> ${linkRefs(f.msg)}${f.waived ? `<div class="waiver">waived: ${linkRefs(f.waived)}</div>` : ""}</li>`).join("")}</ul></details>`).join("")}` : ""}
    ${drc ? `<h2>KiCad DRC <span class="muted">${drc.violations?.length ?? 0} violations · ${drc.unconnected_items?.length ?? 0} unconnected${drc.kicad_version ? ` · KiCad ${esc(drc.kicad_version)}` : ""}</span></h2>
      <ul class="findings">${(drc.violations ?? []).map((v) => `<li><span class="sev ${v.severity === "error" ? "bad" : "warn"}">${v.severity === "error" ? "✕" : "!"}</span><code>${esc(v.type)}</code> ${esc(v.description)}
        <ul class="items">${v.items.map((it) => `<li><a href="#" data-at="${(it.pos.x - o[0]).toFixed(3)},${(it.pos.y - o[1]).toFixed(3)}">${linkRefs(it.description)}</a></li>`).join("")}</ul></li>`).join("")}</ul>` : ""}
  </div>`;
}

document.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "f-ok") $("#pane-checks").classList.toggle("show-ok", t.checked);
});

function initSplitter() {
  const sp = $("#splitter");
  const side = $("#side");
  try {
    const w = localStorage.getItem("pcb-review.side");
    if (w) side.style.width = w;
  } catch { /* storage unavailable */ }
  sp.addEventListener("pointerdown", (e) => {
    sp.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = Math.min(window.innerWidth - 240, Math.max(280, window.innerWidth - ev.clientX));
      side.style.width = `${w}px`;
    };
    const up = () => {
      sp.removeEventListener("pointermove", move);
      sp.removeEventListener("pointerup", up);
      try { localStorage.setItem("pcb-review.side", side.style.width); } catch { /* ignore */ }
      view2d.resize();
      view3d?.resize();
    };
    sp.addEventListener("pointermove", move);
    sp.addEventListener("pointerup", up);
  });
}

boot().catch((err) => {
  $("#app").innerHTML = `<div class="empty"><h1>pcb-review</h1><p class="err">${esc(String(err))}</p></div>`;
  console.error(err);
});
