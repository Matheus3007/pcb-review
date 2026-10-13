# pcb-review exporter

`uv run pcb-review-export <pcb-lab>/boards/<board> -o <bundles root> [--datasheets bundle|link|none] [--no-models] [--no-pinindex]`

- `kicad.py`: reads the `.kicad_pcb` (an s-expression via `sexp.py`): layers, tracks, vias, zone fills, footprints, pads, silk, model refs.
- `bundle.py`: joins in the pcb-lab netlist (pad → pin name, LCSC, MPN), BOM, reports, datasheets, and writes `board.json` and `index.json`.
- `pinindex.py`: datasheet pin index (PyMuPDF). For each pin, the best pages (pin table, pinout) and the boxes of the matches. Debug CLI: `uv run python -m pcb_review_exporter.pinindex <pdf> <lcsc> -v`.
- `models.py`: STEP → GLB (cascadio), cached by content hash in `~/.cache/pcb-review`.

Tests: `uv run pytest`. They need pcb-lab at `$PCB_LAB` (default `/mnt/c/Users/mathe/pcb-lab`) and skip otherwise.
