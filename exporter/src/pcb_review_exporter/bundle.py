"""pcb-lab board dir -> review bundle (see docs/bundle-format.md)."""

from __future__ import annotations

import csv
import datetime as dt
import json
import shutil
import sys
from pathlib import Path

import yaml

from .kicad import parse_pcb

DATASHEET_MODES = ("bundle", "link", "none")


def lcsc_url(lcsc: str) -> str:
    return f"https://www.lcsc.com/product-detail/{lcsc}.html"


def jlc_url(lcsc: str) -> str:
    return f"https://jlcpcb.com/parts/componentSearch?searchTxt={lcsc}"


def _board_files(board_dir: Path) -> dict[str, Path]:
    name = board_dir.name
    b = board_dir / "build"
    return {
        "pcb": b / "fab" / f"{name}.kicad_pcb",
        "netlist": b / "work" / "netlist.json",
        "bom": b / "fab" / f"{name}-bom.csv",
        "checks": b / "reports" / "checks.json",
        "drc": b / "reports" / "drc.json",
        "summary": b / "reports" / "summary.md",
        "board_yaml": board_dir / "board.yaml",
    }


def _lib_dir(board_dir: Path) -> Path:
    return board_dir.parent.parent / "lib"


def _read_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _bom(p: Path) -> list[dict]:
    if not p.exists():
        return []
    rows = []
    with p.open(newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            rows.append({"comment": r.get("Comment", ""), "refs": [s.strip() for s in r.get("Designator", "").split(",") if s.strip()],
                         "footprint": r.get("Footprint", ""), "lcsc": r.get("LCSC Part #", "")})
    return rows


def build_bundle(board_dir: str | Path, out_root: str | Path, *, datasheets: str = "bundle",
                 models: bool = True, pin_index: bool = True, cache_dir: str | Path | None = None,
                 log=print) -> Path:
    if datasheets not in DATASHEET_MODES:
        raise ValueError(f"datasheets must be one of {DATASHEET_MODES}")
    board_dir = Path(board_dir).resolve()
    files = _board_files(board_dir)
    if not files["pcb"].exists():
        raise FileNotFoundError(f"{files['pcb']} not found: build the board in pcb-lab first")
    name = board_dir.name
    out = Path(out_root) / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    cache = Path(cache_dir) if cache_dir else Path.home() / ".cache" / "pcb-review"

    board_yaml = yaml.safe_load(files["board_yaml"].read_text()) if files["board_yaml"].exists() else {}
    origin = tuple(board_yaml["origin"]) if board_yaml.get("origin") else None
    geo = parse_pcb(files["pcb"], origin)
    log(f"{name}: {len(geo['footprints'])} footprints, {len(geo['tracks'])} tracks, {len(geo['vias'])} vias, "
        f"{len(geo['zones'])} zone fills, {len(geo['layers'])} copper layers")

    # Pin names + part metadata from pcb-lab's netlist (pad -> pin name).
    netlist = _read_json(files["netlist"]) or {"parts": []}
    by_ref = {p["ref"]: p for p in netlist.get("parts", [])}
    for fp in geo["footprints"]:
        np_ = by_ref.get(fp["ref"])
        if not np_:
            continue
        fp.setdefault("lcsc", np_.get("lcsc") or None)
        if np_.get("mpn"):
            fp["mpn"] = np_["mpn"]
        fp["dnp"] = fp["dnp"] or bool(np_.get("dnp"))
        pad2pin = {}
        for pin, pads in (np_.get("pins") or {}).items():
            for pad in pads if isinstance(pads, list) else [pads]:
                pad2pin.setdefault(str(pad), pin)
        for pad in fp["pads"]:
            pin = pad2pin.get(pad["num"])
            if pin is not None and pin != pad["num"]:
                pad["pin"] = pin
        if fp.get("lcsc") is None:
            fp.pop("lcsc")

    # Parts keyed by LCSC.
    lib = _lib_dir(board_dir)
    parts: dict[str, dict] = {}
    for fp in geo["footprints"]:
        lc = fp.get("lcsc")
        if not lc:
            continue
        meta = (by_ref.get(fp["ref"]) or {}).get("meta") or {}
        part = parts.setdefault(lc, {"lcsc": lc, "mpn": fp.get("mpn"), "value": fp["value"], "refs": [],
                                     "lcsc_url": lcsc_url(lc), "jlc_url": jlc_url(lc)})
        part["refs"].append(fp["ref"])
        if meta.get("pinout_source"):
            part["pinout_source"] = meta["pinout_source"]
        if not part.get("mpn"):
            part.pop("mpn", None)

    pinindex: dict[str, dict] = {}
    for lc, part in parts.items():
        pdf = lib / "datasheets" / f"{lc}.pdf"
        if not pdf.exists() or datasheets == "none":
            continue
        if datasheets == "bundle":
            (out / "datasheets").mkdir(exist_ok=True)
            shutil.copy2(pdf, out / "datasheets" / pdf.name)
            part["datasheet"] = {"file": f"datasheets/{pdf.name}"}
        else:
            part["datasheet"] = {"url": part["lcsc_url"]}
        if pin_index:
            pins = _part_pins(parts[lc]["refs"], by_ref)
            if pins:
                pinindex[lc] = _pin_index(pdf, pins, part.get("mpn"), cache, log)

    if models:
        _attach_models(geo["footprints"], out, cache, log)

    bundle = {
        "schema": 1,
        "name": name,
        "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "source": {"board_dir": str(board_dir), "kicad_pcb": str(files["pcb"])},
        "origin": geo["origin"],
        "thickness": float(board_yaml.get("thickness", geo["thickness"])),
        **{k: geo[k] for k in ("bbox", "outline", "layers", "nets", "tracks", "vias", "zones", "footprints")},
        "parts": parts,
        "bom": _bom(files["bom"]),
        "reports": {
            "checks": _read_json(files["checks"]),
            "drc": _read_json(files["drc"]),
            "summary_md": files["summary"].read_text(encoding="utf-8") if files["summary"].exists() else None,
        },
    }
    if pinindex:
        (out / "pinindex.json").write_text(json.dumps(pinindex, separators=(",", ":")))
        bundle["pinindex"] = "pinindex.json"
    (out / "board.json").write_text(json.dumps(bundle, separators=(",", ":")))
    _update_index(Path(out_root), bundle)
    log(f"wrote {out}")
    return out


def _part_pins(refs: list[str], by_ref: dict) -> dict[str, list[str]]:
    pins: dict[str, list[str]] = {}
    for ref in refs:
        for pin, pads in ((by_ref.get(ref) or {}).get("pins") or {}).items():
            pins.setdefault(pin, [str(p) for p in (pads if isinstance(pads, list) else [pads])])
    return pins


def _pin_index(pdf: Path, pins: dict, mpn, cache: Path, log) -> dict:
    """Cached per (pdf content, pin set)."""
    import hashlib

    key = hashlib.sha256(pdf.read_bytes() + json.dumps(pins, sort_keys=True).encode()).hexdigest()[:16]
    cfile = cache / "pinindex" / f"{pdf.stem}-{key}.json"
    if cfile.exists():
        return json.loads(cfile.read_text())
    try:
        from .pinindex import build_pin_index
    except ImportError:
        log("pinindex module unavailable: skipping datasheet pin index")
        return {"pages": 0, "pins": {}}
    res = build_pin_index(pdf, pins, mpn)
    cfile.parent.mkdir(parents=True, exist_ok=True)
    cfile.write_text(json.dumps(res))
    return res


def _attach_models(footprints: list[dict], out: Path, cache: Path, log) -> None:
    try:
        from .models import convert_models
    except ImportError:
        log("models module unavailable: 3D view will use boxes")
        return
    sources = sorted({m["source"] for fp in footprints for m in fp["models"]})
    mapping = convert_models(sources, out, cache / "models")
    missing = [s for s, g in mapping.items() if not g]
    if missing:
        log(f"3D: {len(missing)} model(s) not converted (box fallback): " + ", ".join(Path(s).name for s in missing))
    for fp in footprints:
        for m in fp["models"]:
            if mapping.get(m["source"]):
                m["glb"] = mapping[m["source"]]


def _update_index(out_root: Path, bundle: dict) -> None:
    idx_file = out_root / "index.json"
    idx = _read_json(idx_file) or {"boards": []}
    idx["boards"] = [b for b in idx["boards"] if b["name"] != bundle["name"]]
    idx["boards"].append({"name": bundle["name"], "path": f"{bundle['name']}/board.json", "generated": bundle["generated"],
                          "layers": len(bundle["layers"]), "size_mm": [round(bundle["bbox"][2] - bundle["bbox"][0], 2),
                                                                       round(bundle["bbox"][3] - bundle["bbox"][1], 2)]})
    idx["boards"].sort(key=lambda b: b["name"])
    idx_file.write_text(json.dumps(idx, indent=1))


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(prog="pcb-review-export", description=__doc__)
    ap.add_argument("board_dirs", nargs="+", type=Path, help="pcb-lab boards/<name> directories (read-only)")
    ap.add_argument("-o", "--out", type=Path, default=Path("web/public/bundles"), help="bundles root (default: %(default)s)")
    ap.add_argument("--datasheets", choices=DATASHEET_MODES, default="bundle",
                    help="bundle = copy PDFs into the bundle (embedded viewer); link = link to LCSC only "
                         "(no third-party PDFs hosted); none = skip")
    ap.add_argument("--no-models", action="store_true", help="skip STEP->GLB conversion (3D uses boxes)")
    ap.add_argument("--no-pinindex", action="store_true")
    ap.add_argument("--cache", type=Path, default=None)
    a = ap.parse_args(argv)
    for bd in a.board_dirs:
        build_bundle(bd, a.out, datasheets=a.datasheets, models=not a.no_models, pin_index=not a.no_pinindex,
                     cache_dir=a.cache)
    return 0


if __name__ == "__main__":
    sys.exit(main())
