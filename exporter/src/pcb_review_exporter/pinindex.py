"""Datasheet pin index: find where each pin of a part is documented in its PDF datasheet.

`build_pin_index(pdf, pins)` returns, per pin name, a ranked list of page hits with highlight
boxes, so the web viewer can open the datasheet at the pin-definition table row (best) or the
package pinout diagram (second), never at the table of contents or a random mention.

Scoring, per occurrence of a pin name on a page (whole-word, case-sensitive):
  * token quality: exact token (footnote markers / trailing punctuation stripped) > member of a
    slash list ("SDO/SA0") > hyphen compound ("PB8-BOOT0", "PA9-USART1_TX");
  * row evidence: one of the pin's own pad numbers in the same table row (strong: this is the
    pin-definition row for *this* package), or near the word (pinout diagram label), the word
    leading its row (first non-numeric cell), prose rows penalized;
  * page evidence: pin-table caption/header ("Table N ... pin definitions", "Pin Functions",
    "PIN ASSIGNMENT", "引脚定义", ...), pinout figure caption, fraction of the part's pins on the
    page, fraction of those that sit next to their own pad number; TOC pages heavily penalized.
Running headers/footers (lines repeated on many pages) are ignored for keyword detection.

Coordinates are PDF points with a top-left origin (PyMuPDF / pdf.js viewport at scale 1).

Debug CLI:  uv run python -m pcb_review_exporter.pinindex <pdf> <lcsc> [parts.yaml] [-v]
"""

from __future__ import annotations

import functools
import math
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

MAX_HITS = 5
MAX_BOXES = 8
SMALL_PART_PADS = 16  # index pad numbers as keys for parts with at most this many pads

# ---------------------------------------------------------------------------------------------
# Page text cache

_FOOTNOTE_RE = re.compile(r"(?:\(\s*[0-9a-z*]{1,2}\s*\)|\[[0-9]{1,2}\]|[*†‡])$")
_LEAD = "([•·■●▪◆"
_PINNUM_RE = re.compile(r"^(?:[A-Z]{0,2}\d{1,3}|[-–—]|NC|N/?A|EP|\d{1,3}[,/]\d{1,3}.*)$")
_TOC_LINE_RE = re.compile(r"(?:\.\s?){5,}\s*\d+\s*$|(?:\.\s?){8,}")
_TOC_HEAD_RE = re.compile(r"^\s*(table of contents|contents|list of (tables|figures)|目\s*录|目次)\s*$", re.I)

_KW = r"(?:pin|pad|ball|terminal|signal)s?\s*(?:definitions?|descriptions?|functions?|assignments?|configurations?|list|out)"
_TABLE_CAPTION_RE = re.compile(r"^\s*(?:table|tab\.|表)\s*[\dA-Z\-\.]*\s*[\.:：]?.*?(?:" + _KW + r"|引脚|管脚|端子)", re.I)
_FIG_CAPTION_RE = re.compile(
    r"^\s*(?:figure|fig\.?|图)\s*[\dA-Z\-\.]*.*?(?:pinout|pin[\s-]?out|" + _KW + r"|top view|引脚分布|引脚图|管脚图|引脚排列|顶视图)", re.I
)
# Table header cells ("Pin name", "Pin No.") are strong evidence of a pin table; bare section headings
# ("Pin descriptions", "PIN ASSIGNMENT") are weaker (they also title pinout figures and prose sections).
_TABLE_CELL_RE = re.compile(
    r"^\s*(?:pin\s*(?:name|no\.?|number|#)s?|terminal\s*(?:name|no\.?)|引脚名称|引脚号|管脚号|管脚名称)\s*(?:\(\d\))?\s*$", re.I
)
_TABLE_HEAD_RE = re.compile(
    r"^\s*(?:pin\s*(?:definitions?|descriptions?|functions?|assignments?|list)|terminal functions?|"
    r"引脚定义|管脚定义|引脚功能|引脚说明|管脚说明)\s*(?:\(\d\))?\s*$",
    re.I,
)
_FIG_HEAD_RE = re.compile(
    r"^\s*(?:pinouts?(?:\s+description)?|pin\s*(?:configurations?|assignments?|diagrams?)|pad\s*(?:configuration|assignments?)|"
    r"(?:\(\s*)?top\s*view(?:\s*\))?|引脚分布|引脚图|管脚图|引脚配置)\s*$",
    re.I,
)


@dataclass
class _Word:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    parts: tuple[str, ...]  # normalized slash-separated tokens

    @property
    def h(self) -> float:
        return max(self.y1 - self.y0, 1.0)

    @property
    def w(self) -> float:
        return max(self.x1 - self.x0, 1.0)

    @property
    def vertical(self) -> bool:  # rotated text: bbox much taller than wide
        return len(self.text) >= 2 and self.y1 - self.y0 > 1.8 * (self.x1 - self.x0)

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2


@dataclass
class _Page:
    number: int  # 1-based
    words: list[_Word]
    index: dict[str, list[int]]  # normalized token -> word indices (exact / slash members)
    compound: dict[str, list[int]]  # hyphen-compound prefix -> word indices
    loose: dict[str, list[int]]  # case/underscore-insensitive token -> word indices ("Vdd_IO" ~ "VDDIO")
    lines: list[str]
    toc: bool = False
    table_kw: bool = False  # pin-table caption or header cells
    head_kw: bool = False  # pin-table-ish section heading
    fig_kw: bool = False
    rows: dict[int, list[int]] = field(default_factory=dict)  # lazy row cache


def _normalize(text: str) -> tuple[str, ...]:
    t = text.strip()
    while t and t[0] in _LEAD:
        t = t[1:]
    for _ in range(4):
        t2 = _FOOTNOTE_RE.sub("", t.rstrip(",;:."))
        if t2.endswith((")", "]")) and t2.count(t2[-1]) > t2.count("(" if t2[-1] == ")" else "["):
            t2 = t2[:-1]  # unbalanced closing bracket: "(PA9)" -> "(PA9" -> leading "(" stripped above
        if t2 == t:
            break
        t = t2
    while t and t[0] in _LEAD:
        t = t[1:]
    parts = tuple(p for p in t.split("/") if p)
    return parts or ((t,) if t else ())


def _loose_key(t: str) -> str:
    return t.upper().replace("_", "")


def _load_page(page: pymupdf.Page) -> _Page:
    words: list[_Word] = []
    index: dict[str, list[int]] = {}
    compound: dict[str, list[int]] = {}
    loose: dict[str, list[int]] = {}
    for x0, y0, x1, y1, text, *_ in page.get_text("words", sort=False):
        parts = _normalize(text)
        if not parts:
            continue
        i = len(words)
        words.append(_Word(x0, y0, x1, y1, text, parts))
        for p in set(parts):
            index.setdefault(p, []).append(i)
            loose.setdefault(_loose_key(p), []).append(i)
            if "-" in p:
                head = p.split("-", 1)[0]
                if head:
                    compound.setdefault(head, []).append(i)
    lines = [ln.strip() for ln in page.get_text("text").splitlines() if ln.strip()]
    return _Page(page.number + 1, words, index, compound, loose, lines)


@functools.lru_cache(maxsize=8)
def _load_doc(path: str, mtime: float, size: int) -> tuple[_Page, ...]:
    # Read into memory first: random access straight from slow filesystems (WSL /mnt/c) is ~20x slower.
    with open(path, "rb") as f:
        data = f.read()
    doc = pymupdf.open(stream=data, filetype="pdf")
    try:
        pages = [_load_page(p) for p in doc]
    finally:
        doc.close()
    # Lines repeated on many pages are running headers/footers: ignore them for keyword detection.
    freq = Counter(ln for p in pages for ln in set(p.lines))
    limit = max(3, len(pages) // 8)
    for p in pages:
        body = [ln for ln in p.lines if freq[ln] < limit or _TABLE_CAPTION_RE.match(ln)]
        toc_lines = sum(1 for ln in body if _TOC_LINE_RE.search(ln))
        p.toc = toc_lines >= 5 or any(_TOC_HEAD_RE.match(ln) for ln in body[:6]) and toc_lines >= 2
        p.table_kw = any(_TABLE_CAPTION_RE.match(ln) or _TABLE_CELL_RE.match(ln) for ln in body)
        p.head_kw = any(_TABLE_HEAD_RE.match(ln) for ln in body)
        p.fig_kw = any(_FIG_CAPTION_RE.match(ln) or _FIG_HEAD_RE.match(ln) for ln in body)
    return tuple(pages)


def _pages_for(pdf_path: str | Path) -> tuple[_Page, ...]:
    path = os.path.abspath(str(pdf_path))
    st = os.stat(path)
    return _load_doc(path, st.st_mtime, st.st_size)


# ---------------------------------------------------------------------------------------------
# Geometry helpers


def _row(page: _Page, i: int, tol: float = 0.45) -> list[int]:
    """Indices of words on the same visual row as word i (same column for vertical text).
    A wider `tol` catches multi-line table cells whose neighbours are vertically centred."""
    key = i if tol == 0.45 else (i, tol)
    cached = page.rows.get(key)
    if cached is not None:
        return cached
    w = page.words[i]
    out = []
    if w.vertical:
        for j, o in enumerate(page.words):
            if j != i and o.vertical and abs(o.cx - w.cx) < (tol + 0.05) * max(w.w, o.w):
                out.append(j)
    else:
        for j, o in enumerate(page.words):
            if j != i and not o.vertical and abs(o.cy - w.cy) < tol * max(w.h, o.h):
                out.append(j)
    page.rows[key] = out
    return out


def _dist(a: _Word, b: _Word) -> float:
    dx = max(a.x0 - b.x1, b.x0 - a.x1, 0.0)
    dy = max(a.y0 - b.y1, b.y0 - a.y1, 0.0)
    return math.hypot(dx, dy)


def _is_pad_token(parts: tuple[str, ...], pads: set[str]) -> bool:
    return any(p in pads for p in parts)


# ---------------------------------------------------------------------------------------------
# Scoring


@dataclass
class _Occ:
    word: int
    score: float
    quality: float
    pad_row: bool
    pad_near: bool
    lead: bool
    pad_words: list[int]


def _has(page: _Page, name: str, loose: bool) -> bool:
    if loose:
        return _loose_key(name) in page.loose
    return name in page.index or name in page.compound


def _cached_occ(cache: dict, page: _Page, name: str, pads: set[str], loose: bool = False) -> list[_Occ]:
    key = (page.number, name, loose)
    if key not in cache:
        cache[key] = _occurrences(page, name, pads, loose) if _has(page, name, loose) else []
    return cache[key]


def _occurrences(page: _Page, name: str, pads: set[str], loose: bool = False) -> list[_Occ]:
    found: dict[int, float] = {}
    if loose:
        for i in page.loose.get(_loose_key(name), ()):
            found[i] = 0.7 if len(page.words[i].parts) == 1 else 0.6
    else:
        for i in page.index.get(name, ()):
            found[i] = 1.0 if len(page.words[i].parts) == 1 else 0.8
        for i in page.compound.get(name, ()):
            found.setdefault(i, 0.6)
    if not found:
        return []
    numeric_name = name.isdigit()
    own_pads = pads - {name}
    occs = []
    for i, q in found.items():
        w = page.words[i]
        row = _row(page, i)
        pad_row_words = [j for j in row if own_pads and _is_pad_token(page.words[j].parts, own_pads)]
        wide = False
        if own_pads and not pad_row_words and not w.vertical:
            # multi-line cell ("PF1-" / "OSC_OUT"): pad number centred between the lines
            wrow = _row(page, i, 1.3)
            pad_row_words = [j for j in wrow if _is_pad_token(page.words[j].parts, own_pads)
                             and page.words[j].cx < w.cx]
            if pad_row_words:
                wide = True
                if not row:
                    row = wrow
        pad_near_words = []
        if own_pads and not pad_row_words:
            lim = 3.5 * w.h
            for j in _near_candidates(page, own_pads):
                if j != i and _dist(w, page.words[j]) < lim:
                    pad_near_words.append(j)
        if w.vertical:
            before = [j for j in row if page.words[j].cy < w.cy]
        else:
            before = [j for j in row if page.words[j].cx < w.cx]
        lead = len(row) >= 1 and all(_PINNUM_RE.match(page.words[j].parts[0]) for j in before)
        alpha_words = sum(1 for j in row if len(page.words[j].text) > 3 and page.words[j].text.isalpha())
        prose = alpha_words >= 6
        s = q
        s += (2.5 if wide else 3.0) * bool(pad_row_words) + 1.5 * bool(pad_near_words)
        s += 1.0 * (lead and not prose)
        s -= 1.0 * prose
        if numeric_name:
            # bare numbers ("1") are everywhere: only trust them next to a word on the same row
            s -= 0.5
        occs.append(_Occ(i, s, q, bool(pad_row_words), bool(pad_near_words), lead and not prose,
                         pad_row_words or pad_near_words))
    return occs


def _near_candidates(page: _Page, pads: set[str]) -> list[int]:
    out: list[int] = []
    for p in pads:
        out.extend(page.index.get(p, ()))
    return out


def _page_stats(page: _Page, pins: dict[str, list[str]], occ_cache: dict) -> tuple[float, float]:
    """(density, consistency): fraction of the part's pins present on the page, and fraction of
    those present that sit next to one of their own pad numbers."""
    present = 0
    consistent = 0
    names = [n for n in pins if not n.isdigit()] or list(pins)
    for n in names:
        occs = _cached_occ(occ_cache, page, n, set(pins[n]))
        if occs:
            present += 1
            if any(o.pad_row or o.pad_near for o in occs):
                consistent += 1
    density = present / len(names) if names else 0.0
    consistency = consistent / present if present >= 2 else 0.0
    return density, consistency


def _kind(page: _Page, occ: _Occ, density: float) -> str:
    if (page.table_kw or page.head_kw) and (occ.pad_row or occ.lead) and not (page.fig_kw and occ.pad_near):
        return "pintable"
    if page.fig_kw and (occ.pad_near or occ.pad_row or density >= 0.5):
        return "pinout"
    if occ.pad_row and occ.lead:
        return "pintable"
    if occ.pad_near and density >= 0.5:
        return "pinout"
    if page.table_kw or page.head_kw or page.fig_kw or occ.lead:
        return "description"
    return "other"


def _box(w: _Word) -> list[float]:
    return [round(w.x0, 2), round(w.y0, 2), round(w.x1, 2), round(w.y1, 2)]


def _rank_pin(pages: tuple[_Page, ...], name: str, pads: set[str], pins: dict[str, list[str]],
              occ_cache: dict, stats_cache: dict, loose: bool = False) -> list[dict]:
    hits = []
    for page in pages:
        if not _has(page, name, loose):
            continue
        occs = _cached_occ(occ_cache, page, name, pads, loose)
        if not occs:
            continue
        if page.number not in stats_cache:
            stats_cache[page.number] = _page_stats(page, pins, occ_cache)
        density, consistency = stats_cache[page.number]
        best = max(occs, key=lambda o: (o.score, -o.word))
        s = best.score
        # section headings next to figures are usually just "Pinouts and pin description" titles
        s += 3.0 if page.table_kw else 1.0 if page.head_kw and not page.fig_kw else 0.0
        s += 1.0 * page.fig_kw
        s += 0.5 * density + 2.0 * consistency
        # more than a handful of plain mentions on one page (prose, register descriptions) is noise
        s += 0.1 * min(len(occs), 3)
        if page.toc:
            s -= 8.0
        good = sorted((o for o in occs if o.score >= best.score - 1.0), key=lambda o: -o.score)
        boxes = [_box(page.words[o.word]) for o in good[:MAX_BOXES]]
        pad_boxes: dict[str, list[list[float]]] = {}
        for o in good[:MAX_BOXES]:
            for j in o.pad_words[:4]:
                for p in set(page.words[j].parts) & pads:
                    pad_boxes.setdefault(p, []).append(_box(page.words[j]))
        hits.append({
            "page": page.number,
            "kind": _kind(page, best, density),
            "score": round(s, 3),
            "boxes": boxes,
            "_pad_boxes": pad_boxes,
        })
    hits.sort(key=lambda h: (-h["score"], h["page"]))
    return hits[:MAX_HITS]


_ALIASES = {
    "EP": ["EPAD", "PAD", "Exposed", "Thermal", "TAB"],
    "EPAD": ["EP", "PAD", "Exposed", "Thermal"],
    "PAD": ["EP", "EPAD", "Exposed", "Thermal"],
    "SH": ["SHIELD", "Shell"],
    "SHIELD": ["SH", "Shell"],
    "MP": ["Mounting"],
}


def _candidates(name: str) -> list[tuple[str, bool, float]]:
    """(name to search, loose?, score penalty), in order of preference."""
    out = [(name, False, 0.0), (name, True, 0.3)]
    m = re.match(r"^([A-Za-z_]{2,}?)_?(\d+)$", name)
    if m and m.group(1).upper() in {"NC", "GND", "VSS", "VDD", "VCC", "DNC", "RSVD", "NU", "PGND", "AGND", "VIN", "VOUT"}:
        out.append((m.group(1), False, 0.5))  # "NC1" -> "NC" (names disambiguated for the symbol)
    for alias in _ALIASES.get(name.upper(), []):
        out.append((alias, False, 1.0))
    return out


def _best_hits(pages: tuple[_Page, ...], name: str, pads: set[str], pins: dict[str, list[str]],
               occ_cache: dict, stats_cache: dict) -> list[dict]:
    best: list[dict] = []
    for i, (cand, loose, penalty) in enumerate(_candidates(name)):
        if i and best and best[0]["kind"] in ("pintable", "pinout"):
            break  # exact name already lands on a pin table / pinout page: no fallbacks
        if loose and _loose_key(cand) == cand:
            if not any(_loose_key(cand) in p.loose and cand not in p.index for p in pages):
                continue  # loose search would only find the same words
        hits = _rank_pin(pages, cand, pads, pins, occ_cache, stats_cache, loose)
        for h in hits:
            h["score"] = round(h["score"] - penalty, 3)
        if hits and (not best or hits[0]["score"] > best[0]["score"]):
            best = hits
    if len(name) == 1 and not name.isdigit():
        # single letters ("A", "K", "S") occur in every unit and axis label: only keep solid hits
        best = [h for h in best if h["score"] >= 4.0]
    return best


def build_pin_index(pdf_path: str | Path, pins: dict[str, list[str]], mpn: str | None = None) -> dict:
    """pins: pin name -> pad numbers, e.g. {"PA9": ["19"], "VDD": ["1","17"]}.
    Returns {"pages": int, "pins": {name: [hit, ...]}} where each hit is
    {"page": 1-based int, "kind": "pintable"|"pinout"|"description"|"other",
     "score": float, "boxes": [[x0,y0,x1,y1], ...]}  # PDF points, top-left origin (PyMuPDF coords)
    Hits sorted best-first, at most ~5 per pin. Pins with no hit map to [].

    For small parts (<= 16 pads) the result also has "pads": {pad: [hit, ...]}: the pad number
    sitting next to the pin name in the best hits (e.g. "1" in the pin-assignment table row).
    `mpn` is accepted for future use (e.g. picking the package column); currently unused."""
    pins = {str(k): [str(p) for p in (v if isinstance(v, (list, tuple)) else [v])] for k, v in pins.items()}
    pages = _pages_for(pdf_path)
    occ_cache: dict = {}
    stats_cache: dict = {}
    out: dict[str, list[dict]] = {}
    pad_hits: dict[str, list[dict]] = {}
    all_pads = {p for v in pins.values() for p in v}
    index_pads = 0 < len(all_pads) <= SMALL_PART_PADS
    for name, pads in pins.items():
        hits = _best_hits(pages, name, set(pads), pins, occ_cache, stats_cache)
        for h in hits:
            pad_boxes = h.pop("_pad_boxes")
            if index_pads and h["kind"] in ("pintable", "pinout"):
                for pad, boxes in pad_boxes.items():
                    if pad != name:
                        pad_hits.setdefault(pad, []).append({**h, "boxes": boxes[:MAX_BOXES]})
        out[name] = hits
    result: dict = {"pages": len(pages), "pins": out}
    if index_pads:
        result["pads"] = {
            pad: sorted(v, key=lambda h: (-h["score"], h["page"]))[:MAX_HITS] for pad, v in sorted(pad_hits.items())
        }
    return result


# ---------------------------------------------------------------------------------------------
# Debug CLI


def _pins_from_parts_yaml(parts_yaml: str | Path, lcsc: str) -> tuple[str | None, dict[str, list[str]]]:
    import yaml

    data = yaml.safe_load(Path(parts_yaml).read_text(encoding="utf-8"))
    for mpn, entry in data.items():
        if isinstance(entry, dict) and str(entry.get("lcsc")) == lcsc:
            pins = entry.get("pins") or {}
            return mpn, {str(k): [str(p) for p in (v if isinstance(v, list) else [v])] for k, v in pins.items()}
    raise SystemExit(f"{lcsc} not found in {parts_yaml}")


def main(argv: list[str] | None = None) -> int:
    import time

    args = list(sys.argv[1:] if argv is None else argv)
    verbose = "-v" in args
    args = [a for a in args if a != "-v"]
    if len(args) < 2:
        print("usage: python -m pcb_review_exporter.pinindex <pdf> <lcsc> [parts.yaml] [-v]", file=sys.stderr)
        return 2
    pdf, lcsc = args[0], args[1]
    parts_yaml = args[2] if len(args) > 2 else str(Path(pdf).resolve().parent.parent / "parts.yaml")
    mpn, pins = _pins_from_parts_yaml(parts_yaml, lcsc)
    t = time.perf_counter()
    res = build_pin_index(pdf, pins, mpn)
    dt = time.perf_counter() - t
    print(f"{mpn} ({lcsc}): {res['pages']} pages, {dt:.2f}s")
    for name, hits in res["pins"].items():
        if not hits:
            print(f"  {name:10s} -")
            continue
        h = hits[0]
        rest = " ".join(f"{x['page']}/{x['kind'][:4]}/{x['score']:.1f}" for x in hits[1:]) if verbose else ""
        print(f"  {name:10s} p{h['page']:<4d} {h['kind']:12s} {h['score']:5.1f}  {rest}")
    if verbose and res.get("pads"):
        print("  pads:", {p: [h["page"] for h in v] for p, v in res["pads"].items()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
