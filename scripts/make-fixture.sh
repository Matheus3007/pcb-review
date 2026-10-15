#!/usr/bin/env bash
# Copy a pcb-lab board's build files into web/e2e/fixtures (importer parity + drag-and-drop tests).
# Read-only on pcb-lab. Local paths (C:\Users\<name>\...) are stripped: the fixture is public.
set -euo pipefail
LAB=${PCB_LAB:-/mnt/c/Users/mathe/pcb-lab}
B=${1:-rebot-ctrl-v2}
SRC=$LAB/boards/$B
DST=$(dirname "$0")/../web/e2e/fixtures/boards/$B
rm -rf "$DST" && mkdir -p "$DST/build/fab" "$DST/build/work" "$DST/build/reports"
cp "$SRC/board.yaml" "$DST/"
cp "$SRC/build/fab/$B.kicad_pcb" "$SRC/build/fab/$B-bom.csv" "$DST/build/fab/"
cp "$SRC/build/work/netlist.json" "$DST/build/work/"
cp "$SRC/build/reports/checks.json" "$SRC/build/reports/drc.json" "$SRC/build/reports/summary.md" "$DST/build/reports/"
sed -i -E 's#C:\\\\Users\\\\[^\\]+\\\\#C:\\\\#g; s#/mnt/c/Users/[^/]+/#/#g' "$DST"/build/fab/*.kicad_pcb "$DST"/build/work/*.json "$DST"/build/reports/*
grep -rlE 'Users[\\/]' "$DST" && { echo "local paths left" >&2; exit 1; } || true
du -sh "$DST"
