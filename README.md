# pcb-review

Review the PCBs that [pcb-lab](../pcb-lab) generates in a browser, without KiCad. It's a static web app (no server) that loads a **review bundle** exported from a pcb-lab board:

- **Copper**: 2D view of every copper layer, inner layers included. Pan and zoom, toggle layers, view from the bottom. Click a track, via, pad or zone to highlight its net.
- **Side pane**: the selected net with its components and pins, and each part's **datasheet** in an embedded PDF viewer. The viewer opens at the page for the pin (pin table or pinout), with the pin name highlighted.
- **3D**: the assembled board in three.js, using the real KiCad/EasyEDA STEP models converted to GLB. Tracks and pours show under the solder mask. **X-ray** (key `x`) makes the board translucent and shows every copper layer in its 2D colour. The selected net is drawn on top, with via barrels where it changes layer.
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

## Hosting

Live at **https://review.spinup.fail**, served by GitHub Pages from this repo (`Matheus3007/pcb-review`). It goes live once the DNS record in step 4 exists. The blog stays in `Matheus3007/spinup-fail`. Every push to `main` redeploys. These were the setup steps; 2–4 are done except the DNS record:

1. **What gets public.** `make release-bundle BOARD=x` exports into `bundles/` with `--datasheets link`, so no PDFs are hosted. The side pane shows LCSC's own copy of the PDF in the browser's PDF viewer, opened at the pin's page (e.g. p.56 for PA9). Pin highlighting is only available with bundled PDFs (`DATASHEETS=bundle`, as in local dev). The 3D models (KiCad's library, plus EasyEDA models for the USB-C and LMR36506) are converted and hosted. For box-only 3D, add `ARGS=--no-models`.
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
