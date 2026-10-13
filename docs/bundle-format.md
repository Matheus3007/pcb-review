# Review bundle format (schema 1)

The contract between the exporter and the web app. The TypeScript types in `web/src/types.ts` are the source of truth; this page explains the conventions.

```
<bundles root>/
  index.json               {"boards": [{name, path: "<board>/board.json", generated, layers, size_mm}]}
  <board>/
    board.json             the Bundle
    pinindex.json          {lcsc: {pages, pins: {pin name: [hit]}, pads?: {pad number: [hit]}}}
    datasheets/C*.pdf      only with --datasheets bundle
    models/*.glb           converted STEP models
```

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

- `Part.datasheet.file`: bundled PDF, relative to board.json; it is shown in the embedded viewer.
- `Part.datasheet.url`: link mode; no PDF is hosted, and the UI links to LCSC.

The pin index is built either way, from pcb-lab's local copy. Each `PinHit` has a 1-based `page`, a `kind` (`pintable` | `pinout` | `description` | `other`), a `score`, and `boxes` in PDF points with a top-left origin (PyMuPDF space, unrotated page). Hits are sorted best-first. The viewer opens `hits[0].page` and also highlights whole-word matches of the pin name found in pdf.js's text layer on whatever page is shown.
