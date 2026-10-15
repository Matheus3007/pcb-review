# pcb-review: web review of pcb-lab boards

A static web app (no server) for reviewing the PCBs that pcb-lab generates, without KiCad: a 2D copper viewer with net selection, datasheets opened at the right pin, a 3D render, the BOM and the checks. The owner (combat-robot builder, blog spinup.fail) reviews results, not code. See README.md for usage and hosting, and docs/bundle-format.md for the data contract.

## Hard rules

- **pcb-lab (`/mnt/c/Users/mathe/pcb-lab`) is read-only.** Another session works there. Never write, `make`, or commit in it. The exporter only reads `boards/<b>/build/**`, `board.yaml`, `lib/{datasheets,3d}`, and `lib/jlc_cache.json` (datasheet URLs for link mode).
- **Pushing `main` deploys the public site.** The repo is github.com/Matheus3007/pcb-review (public) and GitHub Pages serves https://review.spinup.fail (repo variable `PAGES_CNAME`). Commit locally as you go, but push only when the owner or manager asks. Never touch DNS (Porkbun; the owner's). A public board needs `make release-bundle BOARD=x` and a commit of `bundles/x/`.
- **Datasheets on the public site come from LCSC, never re-hosted** (the owner's decision, 2026-10-14). `make release-bundle` uses `--datasheets link`: iframe of LCSC's raw PDF at `#page=N` (no CORS, so not pdf.js). It also writes `bundles/library.json` and `bundles/_models/` (every model any pcb-lab board uses) for boards opened from disk. EasyEDA 3D models are hosted (the current default; the owner hasn't ruled on it).
- `web/src/types.ts` is the bundle contract. When you change it, change the exporter, the in-browser importer (`web/src/importer/`, a port of `kicad.py` + `bundle.py`) and docs/bundle-format.md in the same commit. `npx vitest run` checks importer ↔ exporter parity on `web/e2e/fixtures/boards/rebot-ctrl-v2`; regenerate that fixture with `scripts/make-fixture.sh`, which strips local paths.

## Loop

```
make bundle BOARD=rebot-ctrl-v2   # export into web/public/bundles (untracked)
make dev                          # vite on :5173
make test                         # pytest (exporter) + tsc (web)
make e2e                          # Playwright tests (web/e2e) on the prod build + bundles/; CI runs them before deploy
make shots                        # Playwright screenshots of the main views -> screenshots/
```

**Done** for a UI change means you took a screenshot and *looked at it* (Read the PNG). Type-checking proves nothing about the canvas. `scripts/shoot.mjs <url> <png> '[{"click":[x,y]},{"key":"3"},{"wait":ms}]'` drives clicks and keys.

## Environment gotchas (WSL on NTFS)

- **Vite file watching on /mnt/c misses edits** and then serves stale modules (it even logs "page reload"). `web/vite.config.ts` enables polling. If the UI ignores an edit, check with `curl localhost:5173/src/<file>.ts`, then restart vite.
- **Headless Chromium needs nss, nspr, gbm and asound**, and there's no sudo. They were unpacked from `apt-get download` .debs into `~/.local/lib/chromium-deps`; `scripts/shoot.mjs` sets `LD_LIBRARY_PATH`. On a new machine, repeat: `apt-get download libnspr4 libnss3 libgbm1 libasound2 libwayland-server0 libxkbcommon0`, `dpkg-deb -x` each, then copy the `*.so*` files there.
- WebGL in headless needs `--use-angle=swiftshader --enable-unsafe-swiftshader` (already in shoot.mjs).
- **iframe'd PDFs** don't render in chromium-headless-shell. Use `BROWSER=firefox` with `LD_LIBRARY_PATH=~/.local/lib/chromium-deps` set on node itself (Playwright checks host libs in-process); shoot.mjs re-enables Firefox's pdf.js, which Playwright disables. LCSC's CDN (Akamai) answers "Access Denied" to the `HeadlessChrome` user agent, so a real UA is needed when testing with Chrome. chromium-headless-shell even **crashes** ("Target page closed") on a page holding a cross-origin PDF iframe, so with link-mode bundles, shoot any selection that shows a datasheet with Firefox. `make shots` uses the dev bundle (pdf.js), which is unaffected. With the old system NSS in `~/.local/lib/chromium-deps`, chromium-headless-shell also crashes on **any HTTPS page** (example.com included). Check the live site (https://review.spinup.fail) with `BROWSER=firefox`; CI's Ubuntu runner is fine.
- Dev bundles need `make bundle` (it writes `library.json` + `_models/` too), or boards opened from disk fall back to boxes and no datasheet links.
- uv on /mnt/c: `UV_LINK_MODE=copy` (the Makefile exports it).
- The shell prints a zoxide warning on every command. It's harmless; ignore it.

## Conventions

- Coordinates follow KiCad: mm, +Y down, rotations CCW. Pads are absolute in the bundle.
- The exporter cache (STEP→GLB, pin index) lives in `~/.cache/pcb-review`, keyed by content hash.
- KiCad 3D models are resolved from `/mnt/c/Program Files/KiCad/<ver>/share/kicad/3dmodels` (override with `PCB_REVIEW_KICAD_3D`).
- Exporter tests run against the real reference board (rebot-ctrl-v2) and skip when pcb-lab is missing. Pad positions and nets are cross-checked against pcb-lab's `reports/board.json`.
- Pointer handlers must never let an exception escape or leave gesture state behind (see the wedge bug, 2026-10-15: a throw in the side pane left a drag armed). `apply()` guards each pane; `e2e/selection.spec.ts` is the regression test.
- Web: vanilla TS, no framework. `main.ts` (shell, state, side pane, BOM, checks), `view2d.ts` (canvas), `pdfview.ts` (pdf.js), `view3d.ts` (three.js, lazy-loaded) + `view3d-copper.ts` (tracks, pours, X-ray, net overlay). Colours are CSS tokens in `style.css`; the copper canvas stays dark in both themes.
