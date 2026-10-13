"""Net/pin extraction from the .kicad_pcb, cross-checked against pcb-lab's own reports."""

from __future__ import annotations

import json
import math

import pytest

from pcb_review_exporter.bundle import build_bundle
from pcb_review_exporter.kicad import _arc_points, parse_pcb, rotate
from pcb_review_exporter.sexp import parse

from conftest import PCB_LAB

BOARD = PCB_LAB / "boards" / "rebot-ctrl-v2"
PCB = BOARD / "build" / "fab" / "rebot-ctrl-v2.kicad_pcb"
needs_board = pytest.mark.skipif(not PCB.exists(), reason="reference board not built")


def test_sexp_quotes_and_nesting():
    n = parse('(a "x \\"y\\"" (b 1 2) "(not a list)")')
    assert n == ["a", 'x "y"', ["b", "1", "2"], "(not a list)"]


def test_rotate_is_ccw_on_screen():
    # +Y down: rotating +X by 90 CCW (on screen) points up, i.e. -Y
    x, y = rotate(1, 0, 90)
    assert (round(x, 9), round(y, 9)) == (0, -1)


def test_arc_points_pass_through_mid():
    pts = _arc_points((1, 0), (0, 1), (-1, 0))
    assert pts[0] == (1, 0) and math.dist(pts[-1], (-1, 0)) < 1e-9
    assert all(abs(math.hypot(*p) - 1) < 1e-9 for p in pts)
    assert max(p[1] for p in pts) > 0.95  # went through the top, not the bottom


@pytest.fixture(scope="module")
def geo():
    if not PCB.exists():
        pytest.skip("reference board not built")
    return parse_pcb(PCB, (100.0, 100.0))


@needs_board
def test_layers_and_outline(geo):
    assert [l["id"] for l in geo["layers"]] == ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]
    assert geo["bbox"] == [0.0, 0.0, 25.0, 25.0]
    assert len(geo["outline"]) == 1


@needs_board
def test_pads_match_pcb_lab_report(geo):
    """Every pad position and net equals pcb-lab's reports/board.json (written by KiCad's pcbnew)."""
    report = json.loads((BOARD / "build" / "reports" / "board.json").read_text())
    # unnamed pads are paste-only apertures (no copper): the exporter skips them on purpose
    theirs = {f["ref"]: [p for p in f["pads"] if p["num"]] for f in report["footprints"]}
    ours = {f["ref"]: [p for p in f["pads"] if p["num"]] for f in geo["footprints"]}  # minus NPTH holes
    assert ours.keys() == theirs.keys()
    for ref, pads in theirs.items():
        assert len(ours[ref]) == len(pads), ref
        for p in pads:
            match = [q for q in ours[ref] if q["num"] == p["num"] and math.dist(q["at"], p["at"]) < 1e-3]
            assert match, f"{ref} pad {p['num']} at {p['at']} missing"
            assert match[0]["net"] == p["net"], f"{ref}.{p['num']}"


@needs_board
def test_track_and_via_nets_exist(geo):
    nets = set(geo["nets"])
    assert all(t["net"] in nets for t in geo["tracks"])
    assert all(v["net"] in nets for v in geo["vias"])
    assert len(geo["tracks"]) == 478 and len(geo["vias"]) >= 100
    # inner planes are filled zones
    assert {z["layer"] for z in geo["zones"]} >= {"In1.Cu", "B.Cu"}


@needs_board
def test_bundle_pin_names_and_index(tmp_path):
    out = build_bundle(BOARD, tmp_path / "bundles", models=False, cache_dir=tmp_path / "cache", log=lambda *_: None)
    b = json.loads((out / "board.json").read_text())
    u1 = next(f for f in b["footprints"] if f["ref"] == "U1")
    pads = {p["num"]: p for p in u1["pads"]}
    assert (pads["19"]["pin"], pads["19"]["net"]) == ("PA9", "CRSF_RX")
    assert (pads["20"]["pin"], pads["20"]["net"]) == ("PA10", "CRSF_TX")
    assert u1["lcsc"] == "C529358"
    part = b["parts"]["C529358"]
    assert part["datasheet"]["file"] == "datasheets/C529358.pdf" and (out / part["datasheet"]["file"]).exists()
    idx = json.loads((out / b["pinindex"]).read_text())
    assert idx["C529358"]["pins"]["PA9"][0]["page"] == 56
    assert b["bom"] and b["reports"]["checks"]["pass"] is True
    index = json.loads((tmp_path / "bundles" / "index.json").read_text())
    assert index["boards"][0]["name"] == "rebot-ctrl-v2"


@needs_board
def test_link_mode_bundles_no_pdfs(tmp_path):
    out = build_bundle(BOARD, tmp_path / "b", datasheets="link", models=False, cache_dir=tmp_path / "c", log=lambda *_: None)
    b = json.loads((out / "board.json").read_text())
    assert not (out / "datasheets").exists()
    ds = b["parts"]["C529358"]["datasheet"]
    assert "file" not in ds and ds["url"].startswith("https://www.lcsc.com/")
