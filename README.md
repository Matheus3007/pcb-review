# pcb-review

Review the PCBs that [pcb-lab](../pcb-lab) generates in a browser, without KiCad. It's a static web app (no server) that loads a **review bundle** exported from a pcb-lab board:

- **Copper**: 2D view of every copper layer, inner layers included. Pan and zoom, toggle layers, view from the bottom. Click a track, via, pad or zone to highlight its net.
- **Side pane**: the selected net with its components and pins, and each part's **datasheet** in an embedded PDF viewer. The viewer opens at the page for the pin (pin table or pinout), with the pin name highlighted.
- **3D**: the assembled board in three.js, using the real KiCad/EasyEDA STEP models converted to GLB.
- **BOM** with LCSC/JLC links, and **Checks**: pcb-lab's check report plus KiCad DRC. Click a designator or a DRC marker to jump to it in the copper view.

Deep links work: `#net=CRSF_RX&ref=U1&pin=19`, `#tab=3d`. Several boards can be hosted side by side; `?board=<name>` picks one.

## Use

```sh
make bundle BOARD=rebot-ctrl-v2     # pcb-lab/boards/<board> -> web/public/bundles/<board>/ (pcb-lab is only read)
make dev                            # http://localhost:5173
make test                           # exporter pytest + web type-check
```

Setup, once: `cd web && npm install`. The exporter's Python environment is created by `uv` on first use. The board has to be built in pcb-lab first (`build/fab/<board>.kicad_pcb`).

Keys in the copper view: `1`..`4` set the active layer, `b` toggles the bottom view, `f` fits the board, `Esc` clears the selection.

## Hosting (prepared, not published)

The target is a subdomain such as `review.spinup.fail` on GitHub Pages. The blog stays in `Matheus3007/spinup-fail`; this would be its own repo.

1. **Decide what gets public.** Datasheet PDFs and EasyEDA 3D models are third-party content. `make release-bundle BOARD=x` exports into `bundles/` with `--datasheets link` by default: no PDFs are bundled, and the side pane links to the LCSC page and names the page to read. To host the PDFs anyway, use `make release-bundle BOARD=x DATASHEETS=bundle`. For box-only 3D, add `ARGS=--no-models`.
2. Commit `bundles/<board>/` and push to `main` in a new GitHub repo, e.g. `Matheus3007/pcb-review`.
3. In the repo settings, go to *Pages → Source: GitHub Actions*. `.github/workflows/pages.yml` builds `web/`, adds `bundles/`, and deploys.
4. Custom domain:
   - **GitHub:** set the repository variable `PAGES_CNAME=review.spinup.fail` (Settings → Secrets and variables → Actions → Variables). The workflow then writes `CNAME` into the site. Then set the same domain under *Pages → Custom domain* and tick *Enforce HTTPS* once the certificate is issued.
   - **Porkbun DNS:** add a record with type `CNAME`, host `review`, answer `matheus3007.github.io`, TTL 600. Don't touch the apex records the blog uses.
   - Optionally, verify the domain under GitHub *Settings → Pages → Verified domains*: Porkbun gets a `TXT _github-pages-challenge-matheus3007` record. This stops anyone else claiming the subdomain.

## Layout

- `exporter/`: Python (uv). `.kicad_pcb` + netlist + reports + datasheets + STEP models → bundle. See `docs/bundle-format.md`.
- `web/`: Vite + TypeScript (vanilla). Canvas 2D viewer, pdf.js, three.js.
- `scripts/shoot.mjs`: headless screenshots for verification. `screenshots/` holds milestone shots.
