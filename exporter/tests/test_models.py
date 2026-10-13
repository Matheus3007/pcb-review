import json
import re
import struct
from pathlib import Path

import pytest

from pcb_review_exporter.models import convert_models, default_kicad_3d_dir, resolve_model_path

REF_PCB = Path("/mnt/c/Users/mathe/pcb-lab/boards/rebot-ctrl-v2/build/fab/rebot-ctrl-v2.kicad_pcb")
KICAD_3D = default_kicad_3d_dir()

needs_ref = pytest.mark.skipif(not REF_PCB.is_file(), reason="reference board not available")
needs_kicad = pytest.mark.skipif(KICAD_3D is None, reason="KiCad 3dmodels dir not found")


def ref_sources() -> list[str]:
    txt = REF_PCB.read_text()
    raw = re.findall(r'\(model "((?:[^"\\]|\\.)*)"', txt)
    return sorted({re.sub(r"\\\\", r"\\", s) for s in raw})  # unescape s-expr backslashes


def glb_json(path: Path) -> dict:
    b = path.read_bytes()
    assert b[:4] == b"glTF"
    n = struct.unpack("<I", b[12:16])[0]
    return json.loads(b[20 : 20 + n])


def test_windows_path_mapping(tmp_path):
    lib = tmp_path / "lib" / "3d"
    lib.mkdir(parents=True)
    (lib / "X.step").write_text("dummy")
    # simulate the drive mapping by resolving a POSIX path under the same rules
    assert resolve_model_path(str(lib / "X.step")) == lib / "X.step"
    # .wrl request falls back to the .step sibling
    assert resolve_model_path(str(lib / "X.wrl")) == lib / "X.step"
    assert resolve_model_path(str(lib / "missing.step")) is None
    # ${KIPRJMOD} and relative paths resolve against base_dir
    assert resolve_model_path("${KIPRJMOD}/lib/3d/X.step", base_dir=tmp_path) == lib / "X.step"
    assert resolve_model_path("lib/3d/X.wrl", base_dir=tmp_path) == lib / "X.step"


def test_kicad_var_with_explicit_dir(tmp_path, monkeypatch):
    d = tmp_path / "3dmodels" / "Resistor_SMD.3dshapes"
    d.mkdir(parents=True)
    (d / "R_0402.step").write_text("x")
    for var in ("KICAD10_3DMODEL_DIR", "KICAD9_3DMODEL_DIR", "KICAD_3DMODEL_DIR"):
        src = "${%s}/Resistor_SMD.3dshapes/R_0402.wrl" % var
        assert resolve_model_path(src, kicad_3d_dir=tmp_path / "3dmodels") == d / "R_0402.step"
    monkeypatch.setenv("PCB_REVIEW_KICAD_3D", str(tmp_path / "3dmodels"))
    assert resolve_model_path("${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402.step") == d / "R_0402.step"
    assert resolve_model_path("${UNDEFINED_VAR_XYZ}/a.step") is None


@needs_ref
@needs_kicad
def test_resolve_reference_board_models():
    srcs = ref_sources()
    assert len(srcs) >= 10
    assert any(s.startswith("C:\\") for s in srcs)
    for s in srcs:
        p = resolve_model_path(s)
        assert p is not None, s
        assert p.suffix.lower() in (".step", ".stp")
    win = next(s for s in srcs if "HRO_TYPE-C" in s)
    assert resolve_model_path(win) == Path("/mnt/c/Users/mathe/pcb-lab/lib/3d/HRO_TYPE-C-31-M-12_C165948.step")
    # escaped form (as written in the file) resolves too
    assert resolve_model_path(win.replace("\\", "\\\\")) is not None


@needs_kicad
def test_convert_small_model(tmp_path):
    src = "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step"
    if resolve_model_path(src) is None:
        pytest.skip("R_0402 model not installed")
    bundle, cache = tmp_path / "bundle", tmp_path / "cache"
    res = convert_models([src, src, "${KICAD10_3DMODEL_DIR}/Nope.3dshapes/nope.step"], bundle, cache)
    assert res[src] == "models/R_0402_1005Metric.glb"
    assert res["${KICAD10_3DMODEL_DIR}/Nope.3dshapes/nope.step"] is None
    out = bundle / res[src]
    assert out.is_file() and out.stat().st_size < 30_000  # 0402 must stay small
    j = glb_json(out)
    # convention: meters, Z-up model space (no root transform), no normals
    assert not any(k in n for n in j["nodes"] for k in ("matrix", "rotation", "scale"))
    for m in j["meshes"]:
        for p in m["primitives"]:
            assert "NORMAL" not in p["attributes"]
    lo = [min(j["accessors"][p["attributes"]["POSITION"]]["min"][i] for m in j["meshes"] for p in m["primitives"]) for i in range(3)]
    hi = [max(j["accessors"][p["attributes"]["POSITION"]]["max"][i] for m in j["meshes"] for p in m["primitives"]) for i in range(3)]
    assert hi[0] - lo[0] == pytest.approx(0.001, abs=1e-4)  # 1.0 mm long (X), in meters
    assert hi[1] - lo[1] == pytest.approx(0.0005, abs=1e-4)  # 0.5 mm wide (Y)
    assert lo[2] == pytest.approx(0, abs=1e-6) and hi[2] == pytest.approx(0.00035, abs=5e-5)  # Z up from seating plane
    # cached: second run reuses cache entry
    assert len(list(cache.glob("*.glb"))) == 1
    out.unlink()
    assert convert_models([src], bundle, cache)[src] == "models/R_0402_1005Metric.glb" and out.is_file()
