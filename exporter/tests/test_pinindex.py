from __future__ import annotations

import time

import pymupdf
import pytest

from pcb_review_exporter import pinindex
from pcb_review_exporter.pinindex import build_pin_index


def _best(res: dict, pin: str) -> dict:
    hits = res["pins"][pin]
    assert hits, f"no hit for {pin}"
    return hits[0]


def _overlaps(a, b) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _assert_boxes_on_word(pdf, page_no: int, boxes, word: str):
    with pymupdf.open(pdf) as doc:
        rects = [w[:4] for w in doc[page_no - 1].get_text("words") if word in w[4]]
    assert boxes and rects
    assert all(any(_overlaps(b, r) for r in rects) for b in boxes), (boxes, rects)


def _check_result_shape(res: dict):
    assert isinstance(res["pages"], int) and res["pages"] > 0
    for hits in res["pins"].values():
        assert len(hits) <= pinindex.MAX_HITS
        assert [h["score"] for h in hits] == sorted((h["score"] for h in hits), reverse=True)
        for h in hits:
            assert set(h) == {"page", "kind", "score", "boxes"}
            assert 1 <= h["page"] <= res["pages"]
            assert h["kind"] in ("pintable", "pinout", "description", "other")
            for b in h["boxes"]:
                assert len(b) == 4 and b[0] <= b[2] and b[1] <= b[3]


def test_stm32_pa9_pa10_pin_definitions_table(part_pins):
    # DS12589 Rev 2: table 12 "pin definition", PA8..PA11 rows on p.56; UFQFPN32 pinout fig.5 on p.44
    pdf, pins = part_pins("C529358")
    pinindex._load_doc.cache_clear()
    t = time.perf_counter()
    res = build_pin_index(pdf, pins, "STM32G431KBU6")
    assert time.perf_counter() - t < 15
    _check_result_shape(res)
    assert res["pages"] == 200
    for pin, word in (("PA9", "PA9"), ("PA10", "PA10")):
        best = _best(res, pin)
        assert (best["page"], best["kind"]) == (56, "pintable")
        _assert_boxes_on_word(pdf, 56, best["boxes"], word)
        assert 44 in [h["page"] for h in res["pins"][pin][:3]]  # pinout diagram is a good runner-up
    # the whole table spans p.51-60; no pin should land on the TOC (p.2-10) or the AF table
    for pin, hits in res["pins"].items():
        assert 51 <= _best(res, pin)["page"] <= 60, pin


def test_xc6206_pin_assignment(part_pins):
    # Torex ETR0305 p.2 PIN ASSIGNMENT, SOT-23 column 1=VSS 2=VOUT 3=VIN
    pdf, pins = part_pins("C5446")
    res = build_pin_index(pdf, pins)
    _check_result_shape(res)
    for pin in ("VIN", "VOUT", "VSS"):
        assert (_best(res, pin)["page"], _best(res, pin)["kind"]) == (2, "pintable")
    _assert_boxes_on_word(pdf, 2, _best(res, "VIN")["boxes"], "VIN")
    # pad numbers are indexed for small parts: "3" is the SOT-23 cell of the VIN row
    pad3 = res["pads"]["3"][0]
    assert pad3["page"] == 2
    vin_box = _best(res, "VIN")["boxes"][0]
    assert all(abs((b[1] + b[3]) / 2 - (vin_box[1] + vin_box[3]) / 2) < 3 for b in pad3["boxes"])


@pytest.mark.parametrize(
    "lcsc,expected_page,check_pins",
    [
        ("C2870127", 4, None),  # LMR36506 p.4 fig.6-1 + table 6-1
        ("C3655801", 4, None),  # DRV8300 p.4 fig.6-1 + table 6-1 (NC1/NC2 -> "NC", EP -> thermal pad)
        ("C14289", 5, None),  # HT75xx-1 p.5 pin descriptions
        ("C22461202", 11, ["SDO", "SDX", "SCX", "INT1", "VDDIO", "GND", "VDD", "INT2", "CS", "SCL", "SDA"]),  # table 2
        ("C190862", 6, ["CS", "DO", "WP", "GND", "DI", "CLK", "HOLD", "VCC"]),  # printed p.5 = PDF p.6
    ],
)
def test_parts_best_page(part_pins, lcsc, expected_page, check_pins):
    pdf, pins = part_pins(lcsc)
    res = build_pin_index(pdf, pins)
    _check_result_shape(res)
    for pin in check_pins or pins:
        best = _best(res, pin)
        assert best["page"] == expected_page, (pin, res["pins"][pin])
        assert best["kind"] in ("pintable", "pinout")


def test_at32_pin_table(part_pins):
    # Artery AT32F421: QFN28 pinout fig.6 p.23, pin definition table 5 p.25-27
    pdf, pins = part_pins("C2765098")
    res = build_pin_index(pdf, pins)
    for pin in ("PA9", "PA10", "BOOT0", "NRST", "VDD"):
        best = _best(res, pin)
        assert 25 <= best["page"] <= 27 and best["kind"] == "pintable", (pin, res["pins"][pin])
    assert 23 in [h["page"] for h in res["pins"]["PA9"]]


def test_unknown_pin_and_single_letters(part_pins):
    pdf, _ = part_pins("C8598")  # diode datasheet: pinout is a drawing; "A"/"K" only as units/axis labels
    res = build_pin_index(pdf, {"K": ["1"], "A": ["2"], "NOT_A_PIN": ["3"]})
    assert res["pins"] == {"K": [], "A": [], "NOT_A_PIN": []}


def test_normalize_tokens():
    n = pinindex._normalize
    assert n("PA9,") == ("PA9",)
    assert n("PA9(1)") == ("PA9",)
    assert n("(PA9)") == ("PA9",)
    assert n("PA9/") == ("PA9",)
    assert n("SDO/SA0(1)") == ("SDO", "SA0")
    assert n("■PIN") == ("PIN",)
    assert n("PA9-USART1_TX") == ("PA9-USART1_TX",)
