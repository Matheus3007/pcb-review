"""Shared part library for boards opened in the browser (bundles/library.json).

A board dropped into the web app is parsed client-side from its pcb-lab build folder, which has
no datasheet URLs, pin index or GLB models. pcb-lab boards draw their parts from one library
(lib/parts.yaml + lib/jlc_cache.json), so this file carries, per LCSC number, the remote
datasheet URL (link mode, never a hosted PDF) and the datasheet pin index, plus a map from KiCad
model path to a GLB already published in one of the bundles.
"""

from __future__ import annotations

import datetime as dt
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

from .bundle import _pin_index, index_source, lcsc_url, jlc_url, remote_datasheet_url


def build_library(pcb_lab: str | Path, out_root: str | Path, *, check_links: bool = True,
                  pin_index: bool = True, convert_models_too: bool = True, cache_dir: str | Path | None = None,
                  log=print) -> Path:
    lab = Path(pcb_lab)
    out_root = Path(out_root)
    lib = lab / "lib"
    cache = Path(cache_dir) if cache_dir else Path.home() / ".cache" / "pcb-review"
    jlc = json.loads((lib / "jlc_cache.json").read_text(encoding="utf-8")) if (lib / "jlc_cache.json").exists() else {}
    entries = yaml.safe_load((lib / "parts.yaml").read_text(encoding="utf-8")) if (lib / "parts.yaml").exists() else {}

    # pins per LCSC number from parts.yaml (name -> pad list), as the pin index wants them
    lib_parts: dict[str, dict] = {}
    for key, e in (entries or {}).items():
        if not isinstance(e, dict) or not e.get("lcsc"):
            continue
        pins = {str(n): [str(p) for p in (v if isinstance(v, list) else [v])] for n, v in (e.get("pins") or {}).items()}
        lib_parts[str(e["lcsc"])] = {"mpn": key, "value": e.get("value"), "pins": pins,
                                     "pinout_source": e.get("pinout_source")}

    lcscs = sorted(set(jlc) | set(lib_parts))
    with ThreadPoolExecutor(8) as pool:
        urls = dict(zip(lcscs, pool.map(lambda lc: remote_datasheet_url(lc, jlc, check=check_links), lcscs)))

    parts: dict[str, dict] = {}
    for lc in lcscs:
        info, lp = jlc.get(lc) or {}, lib_parts.get(lc) or {}
        p = {"lcsc": lc, "lcsc_url": lcsc_url(lc), "jlc_url": jlc_url(lc)}
        if lp.get("mpn") or info.get("mpn"):
            p["mpn"] = info.get("mpn") or lp["mpn"]
        if urls.get(lc):
            p["datasheet_url"] = urls[lc]
        if lp.get("pinout_source"):
            p["pinout_source"] = lp["pinout_source"]
        pdf = lib / "datasheets" / f"{lc}.pdf"
        if pin_index and lp.get("pins") and pdf.exists():
            p["pinindex"] = _pin_index(index_source(pdf, p.get("datasheet_url") if check_links else None, cache, log), lp["pins"], p.get("mpn"), cache, log)
        parts[lc] = p

    # KiCad model path -> shared GLB, for every model any pcb-lab board uses (converted once into
    # <out>/_models/, cached), so boards opened in the browser get real 3D parts, not just boxes
    models: dict[str, str] = {}
    if convert_models_too:
        import re

        from .bundle import portable_source
        from .models import convert_models

        sources = set()
        for pcb in sorted(lab.glob("boards/*/build/fab/*.kicad_pcb")):
            # raw file text: unescape KiCad's doubled backslashes like the s-expression reader does
            sources |= {m.replace("\\\\", "\\") for m in re.findall(r'\(model "([^"]+)"', pcb.read_text(encoding="utf-8"))}
        mapping = convert_models(sorted(sources), out_root / "_models", cache / "models", rel_prefix="_models/")
        for src, glb in mapping.items():
            if glb:
                models.setdefault(portable_source(src, lab), glb)

    out = out_root / "library.json"
    out.write_text(json.dumps({
        "schema": 1,
        "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "parts": parts,
        "models": models,
    }, separators=(",", ":")))
    n_ds = sum(1 for p in parts.values() if "datasheet_url" in p)
    n_pi = sum(1 for p in parts.values() if "pinindex" in p)
    log(f"wrote {out}: {len(parts)} parts ({n_ds} datasheet links, {n_pi} pin indexes), {len(models)} models")
    return out
