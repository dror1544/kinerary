#!/usr/bin/env python3
"""The Gatecity e2e scenario's facts, and the two ticket PHOTOS it sends.

    ticket_photos.py <out-dir>        # writes ticket-1.jpg and ticket-2.jpg

GENERATED, NEVER COMMITTED (CLAUDE.md hard rule 3: no binaries in the tree). The
pictures are drawn here at run time, from the same facts the scenario asserts
about, so the image and the expectation cannot drift apart.

No third-party libraries, for the reason control-plane/api/test/fixtures/
make_documents.py gives: a fixture generator that needs `pip install` is one
that gets skipped. So this carries its own 5x7 bitmap font and a minimal
baseline JPEG encoder (grayscale, one scan, Huffman tables of its own — any
tables are valid JPEG, which is why they can be this simple). The result is a
clean black-on-white picture of a ticket, large enough for a vision model to
read, and a real JPEG: Telegram re-encodes every photo to JPEG, and the relay
declares photos `image/jpeg`.

The two tickets are the ones from Dror's manual Sprint 8 staging test
(2026-11-12) and from control-plane/api/test/fixtures/two-parties-same-flight/:
the SAME flight on the SAME day, booked twice by two couples, each booking
with its own reference and its own passengers. All names are invented.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

# ── The facts. The pictures and the assertions are both made from these ──────

FLIGHT = {
    "airline": "SKYLINE AIR",
    "number": "SL 482",
    "date": "2026-11-14",
    "date_printed": "14 NOV 2026",
    "from": "Harbortown (HBT)",
    "to": "Gatecity (GCY)",
    "departs": "09:40",
    "arrives": "12:05",
}

#: In the order they are sent. `surnames` are the spellings the site may show
#: (the ticket's Latin one, and the interview's Hebrew one), either of which
#: answers "whose ticket is this".
TICKETS = [
    {
        "file": "ticket-1.jpg",
        "ref": "QX7P2M",
        "passengers": ["ARLO VESPER", "LENA VESPER"],
        "surnames": ["VESPER", "וספר"],
    },
    {
        "file": "ticket-2.jpg",
        "ref": "ZT3K9D",
        "passengers": ["BRIA TALLIS", "COLE TALLIS"],
        "surnames": ["TALLIS", "טאליס"],
    },
]

GATECITY = {
    "language": "he",
    "organizer_name": "Arlo",
    "destination": "Gatecity",
    "trip_type": "family",
    "departure_date": "2026-11-14",
    # What the dashboard's new-trip form is filled with. One day SHORT of the
    # real return, on purpose: the manual test corrects the return date in words
    # at the summary, and a correction to the value already held is no
    # correction. The run asserts the corrected one reached the trip.
    "seed_return_date": "2026-11-21",
    "return_date": "2026-11-22",
    # "actually we fly back on 22 November", as the organizer types it.
    "summary_change": "בעצם אנחנו טסים חזרה ב-22 בנובמבר",
    "travellers": 4,
    "flight": FLIGHT,
    "tickets": TICKETS,
}


def ticket_lines(ticket: dict) -> "list[tuple[str, int]]":
    """What is printed on one ticket: (text, scale) per line, upper case because
    that is what the bitmap font has and what an airline prints."""
    f = FLIGHT
    lines = [
        (f"{f['airline']} - E-TICKET RECEIPT", 6),
        ("", 4),
        (f"FLIGHT {f['number']}   {f['from']} TO {f['to']}", 4),
        (f"DATE: {f['date_printed']}   DEPARTS {f['departs']}   ARRIVES {f['arrives']}", 4),
        ("", 4),
        (f"BOOKING REFERENCE: {ticket['ref']}", 4),
    ]
    for number, name in enumerate(ticket["passengers"], start=1):
        lines.append((f"PASSENGER {number}: {name}", 4))
    lines += [("", 4), ("FARE: 2 ADULTS, ECONOMY", 4)]
    return [(text.upper(), scale) for text, scale in lines]


# ── A 5x7 bitmap font: just what a ticket prints ─────────────────────────────

_GLYPHS = {
    "A": ".###.|#...#|#...#|#####|#...#|#...#|#...#",
    "B": "####.|#...#|#...#|####.|#...#|#...#|####.",
    "C": ".###.|#...#|#....|#....|#....|#...#|.###.",
    "D": "####.|#...#|#...#|#...#|#...#|#...#|####.",
    "E": "#####|#....|#....|####.|#....|#....|#####",
    "F": "#####|#....|#....|####.|#....|#....|#....",
    "G": ".###.|#...#|#....|#.###|#...#|#...#|.###.",
    "H": "#...#|#...#|#...#|#####|#...#|#...#|#...#",
    "I": ".###.|..#..|..#..|..#..|..#..|..#..|.###.",
    "J": "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
    "K": "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
    "L": "#....|#....|#....|#....|#....|#....|#####",
    "M": "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#",
    "N": "#...#|##..#|#.#.#|#..##|#...#|#...#|#...#",
    "O": ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
    "P": "####.|#...#|#...#|####.|#....|#....|#....",
    "Q": ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
    "R": "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
    "S": ".####|#....|#....|.###.|....#|....#|####.",
    "T": "#####|..#..|..#..|..#..|..#..|..#..|..#..",
    "U": "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
    "V": "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
    "W": "#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#",
    "X": "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
    "Y": "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
    "Z": "#####|....#|...#.|..#..|.#...|#....|#####",
    "0": ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
    "1": "..#..|.##..|..#..|..#..|..#..|..#..|.###.",
    "2": ".###.|#...#|....#|...#.|..#..|.#...|#####",
    "3": "####.|....#|....#|.###.|....#|....#|####.",
    "4": "...#.|..##.|.#.#.|#..#.|#####|...#.|...#.",
    "5": "#####|#....|####.|....#|....#|#...#|.###.",
    "6": ".###.|#....|#....|####.|#...#|#...#|.###.",
    "7": "#####|....#|...#.|..#..|.#...|.#...|.#...",
    "8": ".###.|#...#|#...#|.###.|#...#|#...#|.###.",
    "9": ".###.|#...#|#...#|.####|....#|....#|.###.",
    " ": ".....|.....|.....|.....|.....|.....|.....",
    "-": ".....|.....|.....|#####|.....|.....|.....",
    ":": ".....|..#..|..#..|.....|..#..|..#..|.....",
    "(": "...#.|..#..|.#...|.#...|.#...|..#..|...#.",
    ")": ".#...|..#..|...#.|...#.|...#.|..#..|.#...",
    ".": ".....|.....|.....|.....|.....|.##..|.##..",
    ",": ".....|.....|.....|.....|.##..|..#..|.#...",
    "/": "....#|....#|...#.|..#..|.#...|#....|#....",
}
FONT = {ch: rows.split("|") for ch, rows in _GLYPHS.items()}

_PAPER, _INK, _TABLE = 250, 25, 205


def render(lines: "list[tuple[str, int]]") -> "tuple[int, int, bytes]":
    """The ticket as a grayscale picture: (width, height, one byte per pixel).
    Dark text on a pale slip lying on a grey table, the way it is photographed."""
    unknown = sorted({ch for text, _ in lines for ch in text if ch not in FONT})
    if unknown:
        raise ValueError(f"the ticket font has no glyph for {unknown}")
    pad, table = 56, 36
    widest = max((len(text) * 6 * scale for text, scale in lines), default=0)
    height = sum(10 * scale for _, scale in lines)
    paper_w, paper_h = widest + 2 * pad, height + 2 * pad
    width, total = paper_w + 2 * table, paper_h + 2 * table
    px = bytearray([_TABLE]) * (width * total)
    for y in range(table, table + paper_h):
        start = y * width + table
        px[start:start + paper_w] = bytes([_PAPER]) * paper_w
    # A rule round the slip, so it reads as a ticket rather than a page of text.
    for x in range(table + 12, table + paper_w - 12):
        for y in (table + 12, table + 13, table + paper_h - 14, table + paper_h - 13):
            px[y * width + x] = _INK
    for y in range(table + 12, table + paper_h - 12):
        for x in (table + 12, table + 13, table + paper_w - 14, table + paper_w - 13):
            px[y * width + x] = _INK
    y0 = table + pad
    for text, scale in lines:
        x0 = table + pad
        for ch in text:
            for row, bits in enumerate(FONT[ch]):
                for col, bit in enumerate(bits):
                    if bit != "#":
                        continue
                    for dy in range(scale):
                        base = (y0 + row * scale + dy) * width + x0 + col * scale
                        px[base:base + scale] = bytes([_INK]) * scale
            x0 += 6 * scale
        y0 += 10 * scale
    return width, total, bytes(px)


# ── A minimal baseline JPEG encoder (grayscale) ──────────────────────────────

def _zigzag() -> "list[int]":
    order, x, y, up = [], 0, 0, True
    for _ in range(64):
        order.append(y * 8 + x)
        if up:
            if x == 7:
                y, up = y + 1, False
            elif y == 0:
                x, up = x + 1, False
            else:
                x, y = x + 1, y - 1
        else:
            if y == 7:
                x, up = x + 1, True
            elif x == 0:
                y, up = y + 1, True
            else:
                x, y = x - 1, y + 1
    return order


_ZIGZAG = _zigzag()
_COS = [[(math.sqrt(1 / 8) if u == 0 else math.sqrt(2 / 8)) * math.cos((2 * x + 1) * u * math.pi / 16)
         for x in range(8)] for u in range(8)]
_QUANT = 3  # flat: text edges stay sharp, and the file is still small


def _dct(block: "list[list[float]]") -> "list[list[float]]":
    """The orthonormal 2-D DCT-II, which is JPEG's forward transform."""
    rows = [[sum(_COS[u][x] * block[y][x] for x in range(8)) for u in range(8)] for y in range(8)]
    return [[sum(_COS[v][y] * rows[y][u] for y in range(8)) for u in range(8)] for v in range(8)]


class _Bits:
    def __init__(self) -> None:
        self.out, self._acc, self._n = bytearray(), 0, 0

    def put(self, value: int, size: int) -> None:
        self._acc = (self._acc << size) | (value & ((1 << size) - 1))
        self._n += size
        while self._n >= 8:
            byte = (self._acc >> (self._n - 8)) & 0xFF
            self.out.append(byte)
            if byte == 0xFF:
                self.out.append(0)  # byte stuffing: 0xFF is a marker's first byte
            self._n -= 8
        self._acc &= (1 << self._n) - 1

    def finish(self) -> bytes:
        if self._n:
            self.put((1 << (8 - self._n)) - 1, 8 - self._n)
        return bytes(self.out)


# Huffman tables of our own. Any prefix code is legal in a DHT segment; these
# are the plainest that are: every DC category gets a 4-bit code, and every
# (run, size) AC symbol an 8-bit one. Neither uses the all-ones code, which
# JPEG reserves. The cost is a few percent of file size, which nobody reads.
_DC_SYMBOLS = list(range(12))
_AC_SYMBOLS = [0x00, 0xF0] + [(run << 4) | size for run in range(16) for size in range(1, 11)]
_DC_CODE = {sym: (i, 4) for i, sym in enumerate(_DC_SYMBOLS)}
_AC_CODE = {sym: (i, 8) for i, sym in enumerate(_AC_SYMBOLS)}


def _segment(marker: int, payload: bytes) -> bytes:
    return bytes([0xFF, marker]) + (len(payload) + 2).to_bytes(2, "big") + payload


def _category(value: int) -> int:
    return abs(value).bit_length()


def _put_value(bits: _Bits, value: int, size: int) -> None:
    if size:
        bits.put(value if value > 0 else value + (1 << size) - 1, size)


def encode_jpeg(width: int, height: int, pixels: bytes) -> bytes:
    """A baseline, grayscale JPEG of `pixels` (one byte each, row by row)."""
    if len(pixels) != width * height:
        raise ValueError("pixels must be width*height bytes")
    bits, previous_dc = _Bits(), 0
    for by in range(0, height, 8):
        for bx in range(0, width, 8):
            block = [[pixels[min(by + y, height - 1) * width + min(bx + x, width - 1)] for x in range(8)]
                     for y in range(8)]
            flat = {v for row in block for v in row}
            if len(flat) == 1:  # a flat patch (most of a ticket): only the DC term is non-zero
                coefficients = [0] * 64
                coefficients[0] = round((flat.pop() - 128) * 8 / _QUANT)
            else:
                shifted = _dct([[v - 128 for v in row] for row in block])
                coefficients = [round(shifted[i // 8][i % 8] / _QUANT) for i in range(64)]
            zigzagged = [coefficients[i] for i in _ZIGZAG]
            diff, previous_dc = zigzagged[0] - previous_dc, zigzagged[0]
            size = _category(diff)
            bits.put(*_DC_CODE[size])
            _put_value(bits, diff, size)
            run = 0
            for value in zigzagged[1:]:
                if value == 0:
                    run += 1
                    continue
                while run > 15:
                    bits.put(*_AC_CODE[0xF0])
                    run -= 16
                size = _category(value)
                bits.put(*_AC_CODE[(run << 4) | size])
                _put_value(bits, value, size)
                run = 0
            if run:
                bits.put(*_AC_CODE[0x00])

    dht_dc = bytes([0x00]) + bytes([0, 0, 0, len(_DC_SYMBOLS)] + [0] * 12) + bytes(_DC_SYMBOLS)
    dht_ac = bytes([0x10]) + bytes([0] * 7 + [len(_AC_SYMBOLS)] + [0] * 8) + bytes(_AC_SYMBOLS)
    return b"".join([
        b"\xff\xd8",
        _segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"),
        _segment(0xDB, bytes([0]) + bytes([_QUANT] * 64)),
        _segment(0xC0, bytes([8]) + height.to_bytes(2, "big") + width.to_bytes(2, "big") + bytes([1, 1, 0x11, 0])),
        _segment(0xC4, dht_dc),
        _segment(0xC4, dht_ac),
        _segment(0xDA, bytes([1, 1, 0x00, 0, 63, 0])),
        bits.finish(),
        b"\xff\xd9",
    ])


def ticket_jpeg(ticket: dict) -> bytes:
    width, height, pixels = render(ticket_lines(ticket))
    return encode_jpeg(width, height, pixels)


def build(out_dir: Path) -> "list[Path]":
    """Write both ticket photos into `out_dir`, in the order they are sent."""
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for ticket in TICKETS:
        path = out_dir / ticket["file"]
        path.write_bytes(ticket_jpeg(ticket))
        paths.append(path)
    return paths


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: ticket_photos.py <out-dir>")
    for written in build(Path(sys.argv[1])):
        print(written)
