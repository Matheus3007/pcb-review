from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

PCB_LAB = Path(os.environ.get("PCB_LAB", "/mnt/c/Users/mathe/pcb-lab"))
DATASHEETS = PCB_LAB / "lib" / "datasheets"
PARTS_YAML = PCB_LAB / "lib" / "parts.yaml"


def _parts() -> dict:
    if not PARTS_YAML.exists():
        return {}
    return yaml.safe_load(PARTS_YAML.read_text(encoding="utf-8")) or {}


@pytest.fixture(scope="session")
def part_pins():
    """part_pins(lcsc) -> (pdf_path, {pin: [pads]}); skips if pcb-lab data is missing."""
    parts = _parts()

    def get(lcsc: str):
        pdf = DATASHEETS / f"{lcsc}.pdf"
        if not pdf.exists():
            pytest.skip(f"datasheet {pdf} not available")
        for entry in parts.values():
            if isinstance(entry, dict) and str(entry.get("lcsc")) == lcsc:
                pins = entry.get("pins") or {}
                return pdf, {str(k): [str(p) for p in (v if isinstance(v, list) else [v])] for k, v in pins.items()}
        pytest.skip(f"{lcsc} not in {PARTS_YAML}")

    return get
