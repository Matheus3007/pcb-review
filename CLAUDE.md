# pcb-review: web review of pcb-lab boards

A static web app (no server) for reviewing the PCBs that pcb-lab generates, without KiCad: a 2D copper viewer with net selection, datasheets opened at the right pin, a 3D render, the BOM and the checks. The owner (combat-robot builder, blog spinup.fail) reviews results, not code. See README.md for usage and hosting, and docs/bundle-format.md for the data contract.

## Hard rules

- **pcb-lab (`/mnt/c/Users/mathe/pcb-lab`) is read-only.** Another session works there. Never write, `make`, or commit in it. The exporter only reads `boards/<b>/build/**`, `board.yaml`, and `lib/{datasheets,3d}`.
- **No publishing.** Don't create GitHub repos, push, deploy, or touch DNS; those are the owner's calls. The deploy workflow and DNS steps are prepared in README.md.
- **Hosting third-party content publicly** (datasheet PDFs, EasyEDA models) is the owner's decision. `make release-bundle` defaults to `--datasheets link`.
- `web/src/types.ts` is the bundle contract. When you change it, change the exporter and docs/bundle-format.md in the same commit.

## Loop

```
make bundle BOARD=rebot-ctrl-v2   # export into web/public/bundles (untracked)
make dev                          # vite on :5173
make test                         # pytest (exporter) + tsc (web)
make shots                        # Playwright screenshots of the main views -> screenshots/
```

**Done** for a UI change means you took a screenshot and *looked at it* (Read the PNG). Type-checking proves nothing about the canvas. `scripts/shoot.mjs <url> <png> '[{"click":[x,y]},{"key":"3"},{"wait":ms}]'` drives clicks and keys.

## Environment gotchas (WSL on NTFS)

- **Vite file watching on /mnt/c misses edits** and then serves stale modules (it even logs "page reload"). `web/vite.config.ts` enables polling. If the UI ignores an edit, check with `curl localhost:5173/src/<file>.ts`, then restart vite.
- **Headless Chromium needs nss, nspr, gbm and asound**, and there's no sudo. They were unpacked from `apt-get download` .debs into `~/.local/lib/chromium-deps`; `scripts/shoot.mjs` sets `LD_LIBRARY_PATH`. On a new machine, repeat: `apt-get download libnspr4 libnss3 libgbm1 libasound2 libwayland-server0 libxkbcommon0`, `dpkg-deb -x` each, then copy the `*.so*` files there.
- WebGL in headless needs `--use-angle=swiftshader --enable-unsafe-swiftshader` (already in shoot.mjs).
- uv on /mnt/c: `UV_LINK_MODE=copy` (the Makefile exports it).
- The shell prints a zoxide warning on every command. It's harmless; ignore it.

## Conventions

- Coordinates follow KiCad: mm, +Y down, rotations CCW. Pads are absolute in the bundle.
- The exporter cache (STEP→GLB, pin index) lives in `~/.cache/pcb-review`, keyed by content hash.
- KiCad 3D models are resolved from `/mnt/c/Program Files/KiCad/<ver>/share/kicad/3dmodels` (override with `PCB_REVIEW_KICAD_3D`).
- Exporter tests run against the real reference board (rebot-ctrl-v2) and skip when pcb-lab is missing. Pad positions and nets are cross-checked against pcb-lab's `reports/board.json`.
- Web: vanilla TS, no framework. `main.ts` (shell, state, side pane, BOM, checks), `view2d.ts` (canvas), `pdfview.ts` (pdf.js), `view3d.ts` (three.js, lazy-loaded) + `view3d-copper.ts` (tracks, pours, X-ray, net overlay). Colours are CSS tokens in `style.css`; the copper canvas stays dark in both themes.
