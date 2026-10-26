# pcb-review: every command goes through make.
PCB_LAB ?= /mnt/c/Users/mathe/pcb-lab
BOARD ?= rebot-ctrl-v2
DATASHEETS ?= bundle
# release-bundle only: the board the site opens by default (index.json "default"), e.g. DEFAULT=rebot-ctrl-v2e
DEFAULT ?=
PORT ?= 5173
export UV_LINK_MODE = copy
UV = uv run --project exporter

.PHONY: help bundle release-bundle dev build test e2e shots clean
help:
	@echo "make bundle BOARD=x [DATASHEETS=bundle|link|none]  export a board for local dev (web/public/bundles, untracked)"
	@echo "make release-bundle BOARD=x [DATASHEETS=link]      export into bundles/ (committed, deployed to GitHub Pages)"
	@echo "make dev | build | test | e2e | shots"

bundle:
	$(UV) pcb-review-export $(PCB_LAB)/boards/$(BOARD) -o web/public/bundles --datasheets $(DATASHEETS) --library $(PCB_LAB) $(ARGS)

# Deployed copy. Default: link to LCSC rather than re-hosting third-party PDFs (the owner's call, see README).
release-bundle:
	$(UV) pcb-review-export $(PCB_LAB)/boards/$(BOARD) -o bundles --datasheets $(if $(filter command line,$(origin DATASHEETS)),$(DATASHEETS),link) --library $(PCB_LAB) $(if $(DEFAULT),--default $(DEFAULT)) $(ARGS)

dev:
	cd web && npx vite --port $(PORT)

build:
	cd web && npm run build

test:
	cd exporter && uv run pytest -q
	cd web && npx tsc --noEmit && npx vitest run

# Browser tests (Playwright) against the production build + bundles/, as deployed
e2e:
	cd web && npx playwright test --reporter=line

# Screenshots of the main views against a running `make dev` (needs chromium deps, see CLAUDE.md)
shots:
	node scripts/shoot.mjs "http://localhost:$(PORT)/" screenshots/overview.png
	node scripts/shoot.mjs "http://localhost:$(PORT)/#net=CRSF_RX&ref=U1&pin=19" screenshots/net-datasheet.png
	node scripts/shoot.mjs "http://localhost:$(PORT)/#tab=3d&ref=U1" screenshots/3d.png '[{"wait":4000}]'
	node scripts/shoot.mjs "http://localhost:$(PORT)/#tab=bom" screenshots/bom.png
	node scripts/shoot.mjs "http://localhost:$(PORT)/#tab=checks" screenshots/checks.png

clean:
	rm -rf web/dist web/public/bundles
