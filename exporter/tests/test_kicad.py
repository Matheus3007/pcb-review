"""Net/pin extraction from the .kicad_pcb, cross-checked against pcb-lab's own reports."""

from __future__ import annotations

import json
import math
from pathlib import Path

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
    # counts as pcb-lab's own report states them (the board gets rebuilt: no fixed numbers)
    stats = json.loads((BOARD / "build" / "reports" / "checks.json").read_text())["stats"]
    assert len(geo["tracks"]) == stats["tracks"] and len(geo["vias"]) == stats["vias"]
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
    out = build_bundle(BOARD, tmp_path / "b", datasheets="link", models=False, check_links=False,
                       cache_dir=tmp_path / "c", log=lambda *_: None)
    b = json.loads((out / "board.json").read_text())
    assert not (out / "datasheets").exists()
    ds = b["parts"]["C529358"]["datasheet"]
    # LCSC's raw PDF host (the www.lcsc.com/datasheet link is an HTML viewer that refuses framing)
    assert "file" not in ds and ds["url"].startswith("https://wmsc.lcsc.com/") and ds["url"].endswith("C529358.pdf")
    # passives have no local PDF in pcb-lab but still get a link; the pin index still comes from local copies
    assert b["parts"]["C25076"]["datasheet"]["url"].endswith(".pdf")
    assert json.loads((out / b["pinindex"]).read_text())["C529358"]["pins"]["PA9"][0]["page"] == 56


def test_remote_datasheet_url_fallbacks(monkeypatch):
    from pcb_review_exporter import bundle as B

    cache = {"C1": {"datasheet": "https://www.lcsc.com/datasheet/lcsc_datasheet_X_C1.pdf", "datasheet_file_id": "42"},
             "C2": {"datasheet": None, "datasheet_file_id": "7"}, "C3": {}}
    # resolve_pdf follows LCSC's script redirect to the real PDF host
    monkeypatch.setattr(B, "resolve_pdf", lambda url, **k: "https://datasheet.lcsc.com/x.pdf" if "wmsc" in url else None)
    assert B.remote_datasheet_url("C1", cache) == "https://datasheet.lcsc.com/x.pdf"
    assert B.remote_datasheet_url("C2", cache) is None  # JLC candidate rejected
    monkeypatch.setattr(B, "resolve_pdf", lambda url, **k: url if "jlcpcb" in url else None)
    assert B.remote_datasheet_url("C1", cache) == B.JLC_FILE_URL.format("42")  # broken LCSC link -> JLC

    def offline(url, **k):
        raise B.Offline("no network")

    monkeypatch.setattr(B, "resolve_pdf", offline)
    assert B.remote_datasheet_url("C1", cache) is None  # unverified links are never shipped
    assert B.remote_datasheet_url("C3", cache) is None


def test_resolve_pdf_follows_lcsc_script_redirect():
    """Regression (2026-10-15): LCSC's PDF links started answering with
    <script>window.top.location.href='...pdf'</script>; embedded as-is in the side pane's iframe,
    that navigated the whole review page away. Only URLs serving PDF bytes may be returned."""
    import http.server
    import threading

    from pcb_review_exporter.bundle import resolve_pdf

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            routes = {
                "/stub.pdf": (b"text/html", b"<script>window.top.location.href='/real.pdf?productCode=C1'</script>"),
                "/meta": (b"text/html", b'<meta http-equiv="refresh" content="0; url=/real.pdf">'),
                "/real.pdf": (b"application/pdf", b"%PDF-1.7 fake"),
                "/page.html": (b"text/html", b"<html><body>product page</body></html>"),
                "/loop": (b"text/html", b"<script>location.replace('/loop')</script>"),
            }
            ctype, body = routes.get(self.path.split("?")[0], (b"text/plain", b"nope"))
            self.send_response(200 if self.path.split("?")[0] in routes else 404)
            self.send_header("Content-Type", ctype.decode())
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        assert resolve_pdf(base + "/stub.pdf") == base + "/real.pdf?productCode=C1"
        assert resolve_pdf(base + "/meta") == base + "/real.pdf"
        assert resolve_pdf(base + "/real.pdf") == base + "/real.pdf"
        assert resolve_pdf(base + "/page.html") is None  # HTML without redirect: never embeddable
        assert resolve_pdf(base + "/loop") is None       # redirect loops give up
        assert resolve_pdf(base + "/missing.pdf") is None
    finally:
        srv.shutdown()


def test_board_silkscreen_art():
    """rebot-ctrl-v2e carries the REBOT logo as filled gr_poly on B.SilkS (2026-10-26)."""
    pcb = PCB_LAB / "boards" / "rebot-ctrl-v2e" / "build" / "fab" / "rebot-ctrl-v2e.kicad_pcb"
    if not pcb.exists():
        pytest.skip("rebot-ctrl-v2e not built")
    g = parse_pcb(pcb, (100.0, 100.0))
    (silk,) = g["silkscreen"]
    assert (silk["layer"], silk["side"]) == ("B.SilkS", "bottom")
    assert len(silk["polygons"]) == 10 and silk["lines"] == []
    x0, y0, x1, y1 = g["bbox"]
    assert all(x0 <= x <= x1 and y0 <= y <= y1 for poly in silk["polygons"] for x, y in poly)


def test_portable_source(tmp_path):
    from pcb_review_exporter.bundle import portable_source

    lab = PCB_LAB
    assert portable_source("${KICAD10_3DMODEL_DIR}/X.3dshapes/Y.step", lab) == "${KICAD10_3DMODEL_DIR}/X.3dshapes/Y.step"
    assert portable_source(r"C:\\Users\\mathe\\pcb-lab\\lib\\3d\\U.step", Path("/mnt/c/Users/mathe/pcb-lab")) == "lib/3d/U.step"
    assert portable_source(r"D:\\elsewhere\\Z.step", lab) == "Z.step"


def test_lcsc_product_page_fallback_and_index_source(tmp_path, monkeypatch):
    """A part with no usable LCSC/JLC link (GD25Q128E, 2026-10-26) gets the PDF its LCSC product page
    links for its own productCode (not the related products' ones); the pin index is then built from
    that PDF when it differs from pcb-lab's copy (another revision can shift pages)."""
    import http.server
    import threading

    from pcb_review_exporter import bundle as B

    page = (b'<a href="https://datasheet.lcsc.com/datasheet/pdf/aaaa.pdf?productCode=C1234">other</a>'
            b'<a href="https://datasheet.lcsc.com/datasheet/pdf/beef01.pdf?productCode=C123">mine</a>')

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = page if self.path.startswith("/product-detail/") else b"%PDF-remote"
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        monkeypatch.setattr(B, "lcsc_url", lambda lc: f"{base}/product-detail/{lc}.html")
        assert B.lcsc_page_datasheet("C123") == "https://datasheet.lcsc.com/datasheet/pdf/beef01.pdf?productCode=C123"
        assert B.lcsc_page_datasheet("C9") is None

        local = tmp_path / "C123.pdf"
        local.write_bytes(b"%PDF-local")
        logs = []
        src = B.index_source(local, f"{base}/real.pdf", tmp_path / "cache", logs.append)
        assert src != local and src.read_bytes() == b"%PDF-remote" and logs  # differs: index LCSC's copy
        same = tmp_path / "same.pdf"
        same.write_bytes(b"%PDF-remote")
        assert B.index_source(same, f"{base}/real.pdf", tmp_path / "cache", logs.append).read_bytes() == b"%PDF-remote"
        assert B.index_source(local, None, tmp_path / "cache", logs.append) == local
    finally:
        srv.shutdown()
