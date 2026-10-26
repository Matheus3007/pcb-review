"""Extract review geometry from a .kicad_pcb (KiCad 8-10 format).

Output follows web/src/types.ts: mm, board-relative (origin subtracted), +Y down,
rotations CCW degrees. Pad positions/rotations are absolute.
"""

from __future__ import annotations

import math
from pathlib import Path

from .sexp import child, children, floats, has_atom, parse, value

ROUND = 4


def _r(v: float) -> float:
    return round(v, ROUND) + 0.0  # +0.0 turns -0.0 into 0.0


def rotate(x: float, y: float, deg: float) -> tuple[float, float]:
    """KiCad rotation: CCW on screen with +Y down."""
    if not deg:
        return x, y
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return x * c + y * s, -x * s + y * c


def copper_layers(root: list) -> list[dict]:
    names = []
    for entry in child(root, "layers")[1:]:
        if isinstance(entry, list) and len(entry) >= 3 and entry[1].endswith(".Cu"):
            names.append(entry[1])

    def order(n: str) -> int:
        if n == "F.Cu":
            return 0
        if n == "B.Cu":
            return 10_000
        return int(n[2:-3])  # In1.Cu -> 1

    names.sort(key=order)
    out = []
    for i, n in enumerate(names):
        side = "top" if n == "F.Cu" else "bottom" if n == "B.Cu" else "inner"
        out.append({"id": n, "name": n.removesuffix(".Cu"), "index": i, "side": side})
    return out


def expand_layers(layers: list[str], copper: list[str]) -> list[str]:
    out: list[str] = []
    for l in layers:
        if l == "*.Cu":
            out.extend(copper)
        elif l == "F&B.Cu":
            out.extend(c for c in ("F.Cu", "B.Cu") if c in copper)
        elif l in copper:
            out.append(l)
    return list(dict.fromkeys(out))


def _arc_points(start, mid, end, seg_len: float = 0.25) -> list[tuple[float, float]]:
    """Polyline through a 3-point arc."""
    (x1, y1), (x2, y2), (x3, y3) = start, mid, end
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-12:
        return [start, end]
    ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
    uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d
    r = math.hypot(x1 - ux, y1 - uy)
    a1, a2, a3 = (math.atan2(p[1] - uy, p[0] - ux) for p in (start, mid, end))

    def ccw(a, b):  # angle from a to b going positive
        return (b - a) % (2 * math.pi)

    sweep = ccw(a1, a3)
    if ccw(a1, a2) > sweep:  # mid not on the positive sweep: go the other way
        sweep -= 2 * math.pi
    n = max(2, int(abs(sweep) * r / seg_len) + 1)
    return [(ux + r * math.cos(a1 + sweep * i / n), uy + r * math.sin(a1 + sweep * i / n)) for i in range(n + 1)]


def _pts(node: list) -> list[tuple[float, float]]:
    pts = child(node, "pts")
    out = []
    for p in pts[1:] if pts else []:
        if p[0] == "xy":
            out.append((float(p[1]), float(p[2])))
        elif p[0] == "arc":
            s, m, e = (tuple(floats(p, k)) for k in ("start", "mid", "end"))
            out.extend(_arc_points(s, m, e)[:-1] if out else _arc_points(s, m, e))
    return out


def _graphic_polylines(node: list) -> list[list[tuple[float, float]]]:
    """Local-coordinate polylines for gr_/fp_ line, rect, circle, arc, poly."""
    tag = node[0][3:]  # strip "fp_" / "gr_"
    if tag == "line":
        return [[tuple(floats(node, "start")), tuple(floats(node, "end"))]]
    if tag == "rect":
        (x1, y1), (x2, y2) = floats(node, "start"), floats(node, "end")
        return [[(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)]]
    if tag == "circle":
        (cx, cy), (ex, ey) = floats(node, "center"), floats(node, "end")
        r = math.hypot(ex - cx, ey - cy)
        n = 32
        return [[(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n + 1)]]
    if tag == "arc":
        return [_arc_points(tuple(floats(node, "start")), tuple(floats(node, "mid")), tuple(floats(node, "end")))]
    if tag == "poly":
        p = _pts(node)
        return [p + p[:1]] if p else []
    return []


def _chain_outline(segments: list[list[tuple[float, float]]], tol: float = 1e-3) -> list[list[tuple[float, float]]]:
    """Join loose Edge.Cuts segments into closed loops."""
    segs = [list(s) for s in segments if len(s) >= 2]
    loops = []
    while segs:
        loop = segs.pop(0)
        changed = True
        while changed and math.dist(loop[0], loop[-1]) > tol:
            changed = False
            for i, s in enumerate(segs):
                if math.dist(loop[-1], s[0]) <= tol:
                    loop += s[1:]
                elif math.dist(loop[-1], s[-1]) <= tol:
                    loop += s[::-1][1:]
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        loops.append(loop)
    return loops


def parse_pcb(path: str | Path, origin: tuple[float, float] | None = None) -> dict:
    root = parse(Path(path).read_text(encoding="utf-8"))
    layers = copper_layers(root)
    copper = [l["id"] for l in layers]

    # Board outline (Edge.Cuts), in absolute coords first.
    edge_segs = []
    for tag in ("gr_line", "gr_arc", "gr_rect", "gr_circle", "gr_poly"):
        for g in children(root, tag):
            if value(g, "layer") == "Edge.Cuts":
                edge_segs.extend(_graphic_polylines(g))
    loops = _chain_outline(edge_segs)
    loops.sort(key=lambda lp: -_area(lp))
    if origin is None:
        xs = [p[0] for lp in loops for p in lp] or [0.0]
        ys = [p[1] for lp in loops for p in lp] or [0.0]
        origin = (min(xs), min(ys))
    ox, oy = origin

    def P(x: float, y: float) -> list[float]:
        return [_r(x - ox), _r(y - oy)]

    outline = [[P(*p) for p in lp] for lp in loops]
    allp = [p for lp in outline for p in lp] or [[0, 0]]
    bbox = [min(p[0] for p in allp), min(p[1] for p in allp), max(p[0] for p in allp), max(p[1] for p in allp)]

    tracks = []
    for s in children(root, "segment"):
        tracks.append({"layer": value(s, "layer"), "net": value(s, "net", ""), "width": float(value(s, "width")),
                       "start": P(*floats(s, "start")), "end": P(*floats(s, "end"))})
    for s in children(root, "arc"):
        tracks.append({"layer": value(s, "layer"), "net": value(s, "net", ""), "width": float(value(s, "width")),
                       "start": P(*floats(s, "start")), "mid": P(*floats(s, "mid")), "end": P(*floats(s, "end"))})

    vias = []
    for v in children(root, "via"):
        ls = child(v, "layers")[1:]
        vias.append({"at": P(*floats(v, "at")[:2]), "size": float(value(v, "size")), "drill": float(value(v, "drill")),
                     "layers": [ls[0], ls[-1]], "net": value(v, "net", "")})

    zones = []
    for z in children(root, "zone"):
        net = value(z, "net", "")
        by_layer: dict[str, list] = {}
        for fp in children(z, "filled_polygon"):
            by_layer.setdefault(value(fp, "layer"), []).append([P(*p) for p in _pts(fp)])
        for layer, polys in by_layer.items():
            zones.append({"layer": layer, "net": net, "polygons": polys})

    footprints = [_footprint(f, copper, P) for f in children(root, "footprint")]
    footprints.sort(key=lambda f: _ref_key(f["ref"]))

    silkscreen = _board_silk(root, P)

    nets = sorted({t["net"] for t in tracks} | {v["net"] for v in vias} | {z["net"] for z in zones}
                  | {p["net"] for f in footprints for p in f["pads"]} - {""})
    nets = [n for n in nets if n]

    general = child(root, "general")
    return {
        "thickness": float(value(general, "thickness", 1.6)) if general else 1.6,
        "origin": [ox, oy],
        "bbox": bbox,
        "outline": outline,
        "layers": layers,
        "nets": nets,
        "tracks": tracks,
        "vias": vias,
        "zones": zones,
        "footprints": footprints,
        "silkscreen": silkscreen,
    }


SILK_LAYERS = {"F.SilkS": "top", "B.SilkS": "bottom"}


def _board_silk(root: list, P) -> list[dict]:
    """Board-level silkscreen art (gr_* on F/B.SilkS, e.g. a logo): filled shapes as polygons,
    the rest as stroked polylines. Footprint silk stays in Footprint.silk. Text is not rendered."""
    by_layer: dict[str, dict] = {}
    for tag in ("gr_poly", "gr_rect", "gr_circle", "gr_line", "gr_arc"):
        for g in children(root, tag):
            layer = value(g, "layer")
            if layer not in SILK_LAYERS:
                continue
            fill = child(g, "fill")
            filled = bool(fill and (has_atom(fill, "yes") or has_atom(fill, "solid")))
            stroke = child(g, "stroke")
            width = (floats(stroke, "width") or floats(g, "width") or [0.15])[0]
            entry = by_layer.setdefault(layer, {"layer": layer, "side": SILK_LAYERS[layer], "polygons": [], "lines": []})
            for pl in _graphic_polylines(g):
                pts = [P(*q) for q in pl]
                if filled:
                    entry["polygons"].append(pts)
                if not filled or width > 0:  # an outlined filled shape also gets its stroke
                    entry["lines"].append({"pts": pts, "width": width})
    return [by_layer[l] for l in SILK_LAYERS if l in by_layer]


def _area(loop) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(loop, loop[1:] + loop[:1]))) / 2


def _ref_key(ref: str):
    i = len(ref.rstrip("0123456789"))
    return (ref[:i], int(ref[i:]) if ref[i:] else 0)


def _props(f: list) -> dict[str, str]:
    out = {}
    for p in children(f, "property"):
        out[p[1]] = p[2] if len(p) > 2 and isinstance(p[2], str) else ""
    # KiCad 6/7 used fp_text reference/value
    for t in children(f, "fp_text"):
        if t[1] in ("reference", "value"):
            out.setdefault(t[1].capitalize(), t[2])
    return out


def _footprint(f: list, copper: list[str], P) -> dict:
    fx, fy, *rest = floats(f, "at")
    frot = rest[0] if rest else 0.0
    side = "bottom" if value(f, "layer") == "B.Cu" else "top"
    props = _props(f)
    attr = child(f, "attr")
    dnp = bool(attr and has_atom(attr, "dnp")) or props.get("DNP", "") not in ("", "0", "no")

    def A(lx: float, ly: float) -> list[float]:
        dx, dy = rotate(lx, ly, frot)
        return P(fx + dx, fy + dy)

    pads = []
    for p in children(f, "pad"):
        num, kind, shape = p[1], p[2], p[3]
        px, py, *prot = floats(p, "at")
        prot = prot[0] if prot else 0.0  # absolute in the file (includes the footprint's rotation)
        layers = expand_layers(child(p, "layers")[1:], copper)
        if not layers:
            continue
        pad = {"num": num, "net": value(p, "net", ""), "at": A(px, py), "rot": _r(prot % 360),
               "shape": shape, "size": floats(p, "size")[:2], "layers": layers}
        if kind in ("thru_hole", "np_thru_hole"):
            d = child(p, "drill")
            nums = floats(d)
            pad["drill"] = nums[0] if len(nums) == 1 else nums[:2]
        rr = value(p, "roundrect_rratio")
        if rr is not None:
            pad["roundrect_ratio"] = float(rr)
        if shape == "custom":
            pad["polygon"] = _custom_polygon(p, pad["at"], prot)
        pads.append(pad)

    # Silkscreen + fab outline polylines, absolute (for the 2D view's component outlines).
    silk = []
    want = ("F.SilkS", "F.Fab") if side == "top" else ("B.SilkS", "B.Fab")
    for tag in ("fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly"):
        for g in children(f, tag):
            if value(g, "layer") in want:
                for pl in _graphic_polylines(g):
                    silk.append([A(*pt) for pt in pl])

    court = []
    for tag in ("fp_line", "fp_rect", "fp_poly", "fp_circle", "fp_arc"):
        for g in children(f, tag):
            if value(g, "layer") in ("F.CrtYd", "B.CrtYd"):
                for pl in _graphic_polylines(g):
                    court.extend(A(*pt) for pt in pl)

    models = []
    for m in children(f, "model"):
        if has_atom(m, "hide"):
            continue
        models.append({
            "source": m[1],
            "offset": [*floats(child(m, "offset"), "xyz")] or [0, 0, 0],
            "rotate": [*floats(child(m, "rotate"), "xyz")] or [0, 0, 0],
            "scale": [*floats(child(m, "scale"), "xyz")] or [1, 1, 1],
        })

    out = {
        "ref": props.get("Reference", "?"),
        "value": props.get("Value", ""),
        "footprint": f[1],
        "side": side,
        "at": P(fx, fy),
        "rot": _r(frot % 360),
        "dnp": dnp,
        "pads": pads,
        "silk": silk,
        "models": models,
    }
    if props.get("LCSC"):
        out["lcsc"] = props["LCSC"]
    if court:
        out["courtyard"] = [min(p[0] for p in court), min(p[1] for p in court),
                            max(p[0] for p in court), max(p[1] for p in court)]
    return out


def _custom_polygon(p: list, at: list[float], prot: float) -> list[list[float]]:
    prims = child(p, "primitives")
    poly: list[tuple[float, float]] = []
    for g in children(prims, "gr_poly") if prims else []:
        poly = _pts(g)
        break
    if not poly:  # anchor-only custom pad: use the anchor size as a rect
        w, h = floats(p, "size")[:2]
        poly = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    out = []
    for x, y in poly:
        dx, dy = rotate(x, y, prot)
        out.append([_r(at[0] + dx), _r(at[1] + dy)])
    return out
