"""3D models: resolve KiCad model paths and convert STEP -> GLB for the web viewer.

GLB convention (what the web side must assume)
-----------------------------------------------
cascadio (OpenCASCADE's RWGltf writer) emits the STEP geometry *unchanged*, and the
post-processing here keeps it that way:

* **Units: meters.** A 0402 resistor spans x -0.0005..0.0005 m. Multiply by 1000 to get mm.
* **Axes: KiCad model space, Z-up**, i.e. NOT the glTF Y-up convention. No root rotation
  is written. +X/+Y/+Z are exactly the STEP model's axes, which are the axes KiCad's 3D
  viewer uses for the model before applying the footprint's (offset, rotate, scale):
  +X right, +Y "up" on the board seen from the top (= -Y of the board/bundle coordinates,
  which are +Y down), +Z out of the top face. z = 0 is the seating plane.
* **No normals.** Normals are dropped to halve the size; render with flat shading
  (three.js `flatShading: true` derives normals per fragment). Vertices are merged.
* One mesh primitive per STEP color (cascadio ``merge_primitives``), material =
  ``pbrMetallicRoughness.baseColorFactor`` (linear RGBA), no textures.

So in KiCad 3D space (mm, X right, Y up, Z out of the top copper) a model vertex ``p``
lands at (KiCad 3d-viewer, ``render_3d_opengl.cpp``)::

    T(fp.x, -fp.y, z_side) * Rz(fp.rot) * [bottom: Ry(180) * Rz(180)]
      * T(offset) * Rz(-rot.z) * Ry(-rot.y) * Rx(-rot.x) * S(scale) * (1000 * p)

Tessellation: ``tol_linear=0.01`` (mm) with ``tol_angular=1.0`` rad keeps 0402 parts at
a few KB and connectors at ~100-200 KB.

Path resolution
---------------
``${KICAD<N>_3DMODEL_DIR}`` / ``${KICAD_3DMODEL_DIR}`` map to the KiCad 3dmodels dir:
``kicad_3d_dir`` arg > env ``PCB_REVIEW_KICAD_3D`` > env var of the same name > newest
``/mnt/c/Program Files/KiCad/*/share/kicad/3dmodels`` (WSL) > ``/usr/share/kicad/3dmodels``.
Windows paths (``C:\\Users\\...``) map to ``/mnt/c/Users/...`` when not on Windows.
``.wrl``/``.wings`` requests fall back to a ``.step``/``.stp`` sibling (KiCad 10 ships STEP only).
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import sys
from pathlib import Path

CONVERTER_VERSION = "1"  # bump to invalidate caches when conversion settings change
TOL_LINEAR = 0.01
TOL_ANGULAR = 1.0

_VAR_RE = re.compile(r"\$\{([A-Za-z0-9_]+)\}|\$\(([A-Za-z0-9_]+)\)")
_KICAD_3D_VAR = re.compile(r"^KICAD\d*_3DMODEL_DIR$")
_STEP_EXTS = (".step", ".stp", ".STEP", ".STP")


def default_kicad_3d_dir() -> Path | None:
    env = os.environ.get("PCB_REVIEW_KICAD_3D")
    if env:
        return Path(env)
    candidates = sorted(
        Path("/mnt/c/Program Files/KiCad").glob("*/share/kicad/3dmodels"),
        key=lambda p: _version_key(p.parts[-4]),
        reverse=True,
    )
    candidates += [Path("C:/Program Files/KiCad") / v / "share/kicad/3dmodels" for v in ("10.0", "9.0")]
    candidates += [Path("/usr/share/kicad/3dmodels"), Path("/usr/local/share/kicad/3dmodels")]
    for c in candidates:
        if c.is_dir():
            return c
    return None


def _version_key(s: str) -> tuple:
    return tuple(int(x) if x.isdigit() else 0 for x in s.split("."))


def _windows_to_posix(p: str) -> str:
    p = re.sub(r"\\+", "/", p)
    m = re.match(r"^([A-Za-z]):/(.*)$", p)
    if m and sys.platform != "win32":
        p = f"/mnt/{m.group(1).lower()}/{m.group(2)}"
    return p


def resolve_model_path(
    source: str,
    kicad_3d_dir: Path | str | None = None,
    base_dir: Path | str | None = None,
) -> Path | None:
    """Map a kicad_pcb ``(model "...")`` string to an existing STEP file, or None.

    ``base_dir``: directory for relative paths and ``${KIPRJMOD}`` (the board dir).
    """
    k3d = Path(kicad_3d_dir) if kicad_3d_dir else None
    missing = False

    def sub(m: re.Match) -> str:
        nonlocal k3d, missing
        name = m.group(1) or m.group(2)
        if _KICAD_3D_VAR.match(name):
            if k3d is None:
                k3d = default_kicad_3d_dir()
                if k3d is None and os.environ.get(name):
                    k3d = Path(_windows_to_posix(os.environ[name]))
            if k3d is None:
                missing = True
                return ""
            return str(k3d).replace("\\", "/")
        if name == "KIPRJMOD" and base_dir is not None:
            return str(base_dir)
        val = os.environ.get(name)
        if val is None:
            missing = True
            return ""
        return val

    expanded = _VAR_RE.sub(sub, source)
    if missing:
        return None
    path = Path(_windows_to_posix(expanded))
    if not path.is_absolute() and base_dir is not None:
        path = Path(base_dir) / path
    for cand in _with_step_fallbacks(path):
        if cand.is_file():
            return cand
    return None


def _with_step_fallbacks(path: Path) -> list[Path]:
    out = [path]
    out += [path.with_suffix(ext) for ext in _STEP_EXTS if path.suffix != ext]
    return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(f"v{CONVERTER_VERSION}:{TOL_LINEAR}:{TOL_ANGULAR}\0".encode())
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def step_to_glb(step: Path, out: Path) -> None:
    """Convert one STEP file to a compact GLB (see module docstring for the convention)."""
    import cascadio
    import trimesh

    tmp = out.with_suffix(".raw.glb")
    rc = cascadio.step_to_glb(
        str(step), str(tmp), tol_linear=TOL_LINEAR, tol_angular=TOL_ANGULAR, merge_primitives=True
    )
    if rc != 0 or not tmp.is_file():
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"cascadio failed ({rc}) on {step}")
    try:
        scene = trimesh.load(str(tmp), force="scene")
        for g in scene.geometry.values():
            g.merge_vertices(merge_tex=True, merge_norm=True)
        data = trimesh.exchange.gltf.export_glb(scene, include_normals=False)
    finally:
        tmp.unlink(missing_ok=True)
    out.write_bytes(data)


def convert_models(
    sources: list[str],
    out_dir: Path,
    cache_dir: Path,
    kicad_3d_dir: Path | str | None = None,
    base_dir: Path | str | None = None,
    rel_prefix: str = "models/",
) -> dict[str, str | None]:
    """Convert every resolvable source to ``<bundle_dir>/models/<stem>.glb``.

    ``out_dir`` is the bundle dir (GLBs go to ``out_dir/models/``); an ``out_dir`` already named
    ``models`` is used as is. Returns ``{source: rel_prefix + "<stem>.glb"}``, i.e. paths relative
    to the bundle dir (None when the file is missing or the conversion failed). Conversions are cached in ``cache_dir`` keyed by the sha256 of the
    STEP file (plus converter settings). Distinct files sharing a stem get ``<stem>-<hash8>``.
    """
    out_dir = Path(out_dir)
    if out_dir.name != rel_prefix.strip("/"):
        out_dir = out_dir / rel_prefix.strip("/")
    cache_dir = Path(cache_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    result: dict[str, str | None] = {}
    by_hash: dict[str, str] = {}  # sha -> written file name
    used_names: dict[str, str] = {}  # file name -> sha
    for src in dict.fromkeys(sources):
        step = resolve_model_path(src, kicad_3d_dir, base_dir)
        if step is None:
            print(f"models: not found: {src}", file=sys.stderr)
            result[src] = None
            continue
        sha = _sha256(step)
        if sha in by_hash:
            result[src] = rel_prefix + by_hash[sha]
            continue
        cached = cache_dir / f"{sha}.glb"
        if not cached.is_file():
            try:
                step_to_glb(step, cached)
            except Exception as e:  # noqa: BLE001 - one bad model must not kill the export
                print(f"models: conversion failed: {step}: {e}", file=sys.stderr)
                result[src] = None
                continue
        name = f"{step.stem}.glb"
        if used_names.get(name, sha) != sha:
            name = f"{step.stem}-{sha[:8]}.glb"
        used_names[name] = sha
        by_hash[sha] = name
        shutil.copyfile(cached, out_dir / name)
        result[src] = rel_prefix + name
    return result
