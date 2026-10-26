# Review bundle format (schema 1)

The contract between the exporter and the web app. The TypeScript types in `web/src/types.ts` are the source of truth; this page explains the conventions.

```
<bundles root>/
  index.json               {"default": "<board>", "boards": [{name, path: "<board>/board.json", generated, layers, size_mm}]}
  <board>/
    board.json             the Bundle
    pinindex.json          {lcsc: {pages, pins: {pin name: [hit]}, pads?: {pad number: [hit]}}}
    datasheets/C*.pdf      only with --datasheets bundle
    models/*.glb           converted STEP models
```

`<bundles root>/library.json` (written by `--library <pcb-lab>`) serves boards opened in the browser from a local folder. It has `parts` (LCSC number → `datasheet_url`, `pinindex`, `pinout_source`, links) for pcb-lab's whole part library, and `models` (portable model path → GLB under `_models/`) for every model any pcb-lab board uses. The importer (`web/src/importer/`) must produce the same Bundle as the Python exporter; `importer.test.ts` checks this against `bundles/rebot-ctrl-v2`.

`Bundle.silkscreen` (optional) holds board-level silkscreen art, i.e. `gr_*` items on F/B.SilkS such as the REBOT logo on rebot-ctrl-v2e's bottom. Each side has filled `polygons`, as single rings with holes joined by slits, and stroked `lines`. Footprint silk stays in `Footprint.silk`, and text items are not rendered. `index.json` `default` is the board the site opens without `?board=`, set with `--default` / `make release-bundle DEFAULT=x`.

## Coordinates

- **2D**: mm, board-relative. The board.yaml `origin` is subtracted, or the Edge.Cuts bbox corner when there is none; `Bundle.origin` keeps it, so absolute KiCad positions (e.g. DRC markers) can be mapped. +Y points down and rotations are CCW degrees on screen, both as in KiCad.
- **Pads**: `at` and `rot` are absolute; the footprint transform is already applied. Custom pads carry an absolute `polygon`. Pads with no copper (paste-only apertures) are dropped. Unnamed NPTH holes are kept, so their drills can be drawn.
- **3D**: the GLBs are cascadio output kept as is: meters, KiCad/STEP model axes (Z-up), no root transform. `view3d.ts` places them like KiCad's 3D viewer:
  ```
  T(x, -y, z_side) · Rz(rot) · [bottom: Ry(180)·Rz(180)] · T(offset) · Rz(-rz)·Ry(-ry)·Rx(-rx) · S(scale) · S(1000)
  ```
  using `Model3D.offset/rotate/scale` from the `.kicad_pcb`.

## Pin names

`Pad.pin` comes from pcb-lab's `build/work/netlist.json` (`parts[].pins`: name → pads). It is omitted when the name equals the pad number.

## Datasheets

- `Part.datasheet.file`: bundled PDF, relative to board.json. It is shown in the pdf.js viewer, with the pin name highlighted.
- `Part.datasheet.url`: link mode, where no PDF is hosted. The URL is a *direct* PDF, i.e. its body is PDF bytes, never HTML. It is resolved from pcb-lab's `lib/jlc_cache.json`: LCSC's `wmsc.lcsc.com` link, which now answers with a `top.location` script stub, is followed to `datasheet.lcsc.com`; JLC's file endpoint is the fallback. Script/meta redirects are followed at export time, and an unverifiable link is not shipped. These hosts send no CORS headers, so pdf.js can't read them from our origin. The web app embeds the PDF in an iframe instead (the browser's own PDF viewer), opened at `#page=N`; this has been seen working in Chrome and Firefox. The page hint and page buttons stay; pin highlighting is only available for bundled PDFs. LCSC's `www.lcsc.com/datasheet/...` links can't be framed: they are an HTML viewer sent with `X-Frame-Options: SAMEORIGIN`.

The pin index is built either way, from pcb-lab's local copy. Each `PinHit` has a 1-based `page`, a `kind` (`pintable` | `pinout` | `description` | `other`), a `score`, and `boxes` in PDF points with a top-left origin (PyMuPDF space, unrotated page). Hits are sorted best-first. The viewer opens `hits[0].page` and also highlights whole-word matches of the pin name found in pdf.js's text layer on whatever page is shown.
