#!/usr/bin/env python3
"""Generate the document fixtures the interview E2E reads.

GENERATED, NEVER COMMITTED. CLAUDE.md hard rule 3 forbids binaries in the
tree, and a real organizer's booking PDF is their private travel data besides.
So the fixtures are written at test time from the facts asserted about them —
which also means the expected values and the document can never drift apart,
because both come from `SCENARIOS` below.

No third-party libraries on purpose. `.docx` and `.xlsx` are ZIP+XML and the
minimum viable PDF is a few objects and an xref table, all reachable from the
standard library. A fixture generator that needs `pip install` is a fixture
generator that gets skipped in CI.

Usage:
    make_documents.py <scenario> <out-dir>      # japan | multi | (manual: none)
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

# ── The facts. Documents and assertions are both generated from these ────────

SCENARIOS: dict[str, dict] = {
    # Scenario 1 — one PDF, the shape of the real Yapan Tours booking that
    # took four attempts to extract on 2026-09-10.
    "japan": {
        "destination": "Japan",
        "departure_date": "2026-09-19",
        "return_date": "2026-10-03",
        "documents": {
            "booking.pdf": [
                "Yapan Tours - Booking Confirmation",
                "Quote 2026-4471   5 adults",
                "Entire Trip: 19 Sep, 2026 - 03 Oct, 2026",
                "",
                "Tokyo      Sep 19 - Sep 23   OMO3 Asakusa by Hoshino Resorts",
                "  Tokyo Skytree           20 Sep 10:00",
                "  TeamLab Planets         20 Sep 18:00",
                "Hakone     Sep 23 - Sep 24   Hakone Ashinoko Hanaori",
                "Kyoto      Sep 24 - Sep 27   Cross Hotel Kyoto",
                "Osaka      Sep 27 - Sep 30   Hotel Royal Classic Osaka",
            ],
        },
        # What the extraction must produce. Checked by the E2E, not by eye.
        "expect_answers": ["destination", "departure_date", "return_date", "phases"],
        "expect_in_phases": ["Tokyo", "Hakone", "Kyoto", "Osaka"],
        "expect_planned": ["Tokyo Skytree", "TeamLab Planets"],
    },
    # Scenario 2 — several documents, several formats, each carrying a
    # DIFFERENT kind of fact. The point is that one trip is assembled from all
    # of them: flights with times, hotels with dates and addresses, and ticketed
    # attractions. Read as ONE document, the way the relay reads a burst.
    "multi": {
        "destination": "Italy",
        "departure_date": "2026-05-02",
        "return_date": "2026-05-12",
        "documents": {
            # A flight confirmation — names, times, a real confirmation number.
            # These must reach travel_anchors AND show on the site.
            "flights.pdf": [
                "AIRLINE E-TICKET RECEIPT",
                "Booking reference: XR7T2Q",
                "Passengers: Dana Levi, Omri Levi, Yael Levi",
                "",
                "Outbound  LY381  02 May 2026",
                "  Tel Aviv (TLV)  06:15  ->  Rome Fiumicino (FCO)  09:40",
                "Return    LY382  12 May 2026",
                "  Rome Fiumicino (FCO)  11:20  ->  Tel Aviv (TLV)  16:05",
            ],
            # Hotels — names, dates, locations. A .docx, to exercise that reader.
            "hotels.docx": [
                "HOTEL RESERVATIONS - Levi family, Italy May 2026",
                "",
                "Rome: Hotel Artemide, Via Nazionale 22, Rome",
                "  Check-in 02 May 2026, check-out 06 May 2026",
                "  Confirmation HTL-99117",
                "",
                "Florence: Hotel Davanzati, Via Porta Rossa 5, Florence",
                "  Check-in 06 May 2026, check-out 09 May 2026",
                "  Confirmation HTL-99118",
                "",
                "Venice: Hotel Ai Reali, Campo della Fava, Venice",
                "  Check-in 09 May 2026, check-out 12 May 2026",
                "  Confirmation HTL-99119",
            ],
            # Attraction tickets — a spreadsheet, because that is what a
            # ticket bundle usually arrives as.
            "tickets.xlsx": [
                ["Attraction", "City", "Date", "Time", "Ref"],
                ["Colosseum Underground", "Rome", "2026-05-03", "09:30", "TK-5521"],
                ["Vatican Museums", "Rome", "2026-05-04", "14:00", "TK-5522"],
                ["Uffizi Gallery", "Florence", "2026-05-07", "10:00", "TK-5523"],
                ["Doge's Palace", "Venice", "2026-05-10", "11:15", "TK-5524"],
            ],
            # Notes the organizer wrote themselves — markdown, no structure.
            "notes.md": [
                "# Italy trip notes",
                "",
                "Three of us: me (Dana), Omri, Yael.",
                "Balanced pace - one main thing a day, nobody likes 6am starts.",
                "Omri is vegetarian. Yael cannot do dairy.",
                "",
                "Rome 2-6 May, Florence 6-9 May, Venice 9-12 May.",
            ],
        },
        "expect_answers": ["destination", "departure_date", "return_date", "phases"],
        "expect_in_phases": ["Rome", "Florence", "Venice"],
        "expect_planned": ["Colosseum", "Uffizi"],
        # The flight is BOOKED — evidence of booking is a confirmation number —
        # so it belongs in travel_anchors, not in a phase's planned list.
        "expect_anchor_text": ["XR7T2Q", "LY381"],
    },
    # Scenario 3 — no documents at all. Every answer typed. This is the control:
    # if it passes only when a document is uploaded, the interview is not an
    # interview.
    "manual": {
        "destination": "Portugal",
        "departure_date": "2026-06-10",
        "return_date": "2026-06-18",
        "documents": {},
        "expect_answers": ["destination", "departure_date", "return_date", "phases"],
        "expect_in_phases": ["Lisbon", "Porto"],
    },
}


# ── Writers ──────────────────────────────────────────────────────────────────

def write_pdf(path: Path, lines: list[str]) -> None:
    """A minimal one-page PDF with a text stream. Hand-built because the point
    is to exercise the PDF READER, and any generator would be a dependency."""
    content = ["BT", "/F1 10 Tf", "1 0 0 1 40 750 Tm", "12 TL"]
    for line in lines:
        escaped = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        content.append(f"({escaped}) Tj")
        content.append("T*")
    content.append("ET")
    stream = "\n".join(content).encode("latin-1", "replace")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


def _xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# XML attributes are DOUBLE-quoted throughout, because that is what Word and
# Excel emit and the readers' regexes are tuned to real files — `xlsxToText`
# matches `t="inlineStr"` literally. Single quotes are valid XML and produced a
# fixture that parsed as NO_TEXT, which is a fixture bug wearing a reader bug's
# clothes.

def write_docx(path: Path, lines: list[str]) -> None:
    """docx is a zip of XML parts. Only the three the readers need."""
    paras = "".join(
        '<w:p><w:r><w:t xml:space="preserve">' + _xml_escape(l) + "</w:t></w:r></w:p>"
        for l in lines
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>" + paras + "</w:body></w:document>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)


def write_xlsx(path: Path, rows: list[list[str]]) -> None:
    """xlsx, with every cell an inline string so no sharedStrings part is
    needed — fewer parts, and the readers only want the text."""
    def cell(col: int, row: int, value: str) -> str:
        ref = ""
        c = col
        while True:
            ref = chr(ord("A") + c % 26) + ref
            c = c // 26 - 1
            if c < 0:
                break
        return (
            '<c r="' + ref + str(row) + '" t="inlineStr"><is><t xml:space="preserve">'
            + _xml_escape(value) + "</t></is></c>"
        )

    body = "".join(
        '<row r="' + str(r) + '">' + "".join(cell(c, r, str(v)) for c, v in enumerate(cells)) + "</row>"
        for r, cells in enumerate(rows, start=1)
    )
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData>" + body + "</sheetData></worksheet>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Tickets" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/worksheets/sheet1.xml", sheet)


def build(scenario: str, out_dir: Path) -> list[Path]:
    spec = SCENARIOS[scenario]
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name, content in spec["documents"].items():
        path = out_dir / name
        if name.endswith(".pdf"):
            write_pdf(path, content)
        elif name.endswith(".docx"):
            write_docx(path, content)
        elif name.endswith(".xlsx"):
            write_xlsx(path, content)
        elif name.endswith(".md"):
            path.write_text("\n".join(content) + "\n")
        else:
            raise SystemExit(f"no writer for {name}")
        written.append(path)
    return written


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in SCENARIOS:
        raise SystemExit(f"usage: make_documents.py <{'|'.join(SCENARIOS)}> <out-dir>")
    files = build(sys.argv[1], Path(sys.argv[2]))
    for f in files:
        print(f"{f}  ({f.stat().st_size} bytes)")
    if not files:
        print("(no documents — this scenario is typed by hand on purpose)")
