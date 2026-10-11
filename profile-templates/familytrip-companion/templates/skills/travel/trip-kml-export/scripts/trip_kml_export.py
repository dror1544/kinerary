#!/usr/bin/env python3
"""
trip_kml_export.py — Generate KML from trip-mcp config + bookings data.

Usage:
    python trip_kml_export.py --output /tmp/trip.kml [--filter all|hotels|attractions|restaurants|all_bookings]

Input (stdin): JSON with keys:
    {
      "config":   <get_config response>,
      "bookings": <get_bookings response>   # optional
    }

Filter values:
    all            Hotels + all bookings with coordinates
    hotels         Accommodation only (from config phases)
    attractions    Bookings with type="attraction"
    restaurants    Bookings with type="restaurant"
    all_bookings   All bookings regardless of type

Output: KML file at --output path (default: /tmp/trip_export.kml)

Language: every name and description is ONE string in the trip's own
language — never two languages side by side. The trip's language is
config.meta.defaultLang; without it, Hebrew when the config carries any Hebrew
text, else English. A bilingual value ({"he": ..., "en": ...}) is read in that
language, and the other language is used only when the preferred one is
missing or empty. Labels the script writes itself are Hebrew for a Hebrew trip
and English otherwise.
"""

import json
import re
import sys
import argparse
import xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime

# ── KML namespace ───────────────────────────────────────────────────────────
KML_NS = "http://www.opengis.net/kml/2.2"
ET.register_namespace("", KML_NS)

LABELS = {
    "he": {
        "filter": {
            "all":          "כל המקומות",
            "hotels":       "מלונות ולינה",
            "attractions":  "אטרקציות",
            "restaurants":  "מסעדות",
            "all_bookings": "כל ההזמנות",
        },
        "hotels_folder":      "🏨 מלונות ולינה",
        "attractions_folder": "⭐ אטרקציות",
        "bookings_folder":    "📍 הזמנות ופעילויות",
        "restaurants_folder": "🍽️ מסעדות",
        "exported":     "יוצא",
        "default_trip": "הטיול שלנו",
        "stop":         "שלב",
        "dates":        "תאריכים",
        "hotel_of":     "מלון",
        "place":        "מקום",
        "fields": {
            "type": "סוג", "date": "תאריך", "provider": "ספק",
            "confirmationNumber": "מספר אישור", "notes": "הערות", "address": "כתובת",
            "checkIn": "צ׳ק-אין", "checkOut": "צ׳ק-אאוט",
        },
        "types": {
            "hotel": "מלון", "attraction": "אטרקציה", "restaurant": "מסעדה",
            "flight": "טיסה", "car": "רכב", "other": "אחר",
        },
    },
    "en": {
        "filter": {
            "all":          "All places",
            "hotels":       "Hotels and lodging",
            "attractions":  "Attractions",
            "restaurants":  "Restaurants",
            "all_bookings": "All bookings",
        },
        "hotels_folder":      "🏨 Hotels and lodging",
        "attractions_folder": "⭐ Attractions",
        "bookings_folder":    "📍 Bookings and activities",
        "restaurants_folder": "🍽️ Restaurants",
        "exported":     "Exported",
        "default_trip": "Our trip",
        "stop":         "Stop",
        "dates":        "Dates",
        "hotel_of":     "Hotel",
        "place":        "Place",
        "fields": {
            "type": "Type", "date": "Date", "provider": "Provider",
            "confirmationNumber": "Confirmation", "notes": "Notes", "address": "Address",
            "checkIn": "Check-in", "checkOut": "Check-out",
        },
        "types": {
            "hotel": "Hotel", "attraction": "Attraction", "restaurant": "Restaurant",
            "flight": "Flight", "car": "Car", "other": "Other",
        },
    },
}

TYPE_ICONS = {
    "hotel":       "http://maps.google.com/mapfiles/kml/paddle/H.png",
    "attraction":  "http://maps.google.com/mapfiles/kml/paddle/ylw-stars.png",
    "restaurant":  "http://maps.google.com/mapfiles/kml/paddle/orange-circle.png",
    "flight":      "http://maps.google.com/mapfiles/kml/shapes/airports.png",
    "default":     "http://maps.google.com/mapfiles/kml/paddle/red-circle.png",
}

# Characters XML 1.0 cannot carry at all (escaping does not help), plus lone
# surrogates, which cannot be encoded as UTF-8. ElementTree escapes & < > and
# quotes itself; these it would write through and leave an unparseable file.
_XML_INVALID = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿\ud800-\udfff]")
_HEBREW = re.compile("[֐-׿]")


def labels(lang):
    return LABELS["he"] if lang == "he" else LABELS["en"]


def clean(s):
    return _XML_INVALID.sub("", s).strip()


def text_in(value, lang):
    """One display string for `value` in `lang`.

    A plain string (legacy configs) is used as it is. A bilingual object is
    read in `lang`, then Hebrew, then English — the first non-empty one, never
    two of them joined. A list (e.g. accommodation notes) is its items, one per
    line. None, an empty object and anything unrecognised give "".
    """
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, (int, float)):
        return clean(str(value))
    if isinstance(value, str):
        return clean(value)
    if isinstance(value, dict):
        for key in (lang, "he", "en", "text", "name"):
            if key in value:
                s = text_in(value.get(key), lang)
                if s:
                    return s
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(s for s in (text_in(v, lang) for v in value) if s)
    return ""


def first_text(obj, keys, lang):
    if not isinstance(obj, dict):
        return ""
    for key in keys:
        s = text_in(obj.get(key), lang)
        if s:
            return s
    return ""


def _has_hebrew(value, depth=0):
    if depth > 20:
        return False
    if isinstance(value, str):
        return bool(_HEBREW.search(value))
    if isinstance(value, dict):
        return any(_has_hebrew(v, depth + 1) for v in value.values())
    if isinstance(value, (list, tuple)):
        return any(_has_hebrew(v, depth + 1) for v in value)
    return False


def trip_language(config, bookings=None):
    """meta.defaultLang; else "he" when any Hebrew is present; else "en"."""
    meta = config.get("meta") if isinstance(config, dict) else None
    lang = meta.get("defaultLang") if isinstance(meta, dict) else None
    if isinstance(lang, str) and lang.strip():
        return lang.strip().lower().split("-")[0].split("_")[0]
    return "he" if (_has_hebrew(config) or _has_hebrew(bookings)) else "en"


def kml_el(tag, text=None, **attrib):
    el = ET.Element(f"{{{KML_NS}}}{tag}", **attrib)
    if text is not None:
        el.text = str(text)
    return el


def add_style(doc, style_id, icon_url):
    style = ET.SubElement(doc, f"{{{KML_NS}}}Style", id=style_id)
    icon_style = ET.SubElement(style, f"{{{KML_NS}}}IconStyle")
    icon = ET.SubElement(icon_style, f"{{{KML_NS}}}Icon")
    ET.SubElement(icon, f"{{{KML_NS}}}href").text = icon_url


def make_placemark(name, description, lat, lon, style_url=None):
    pm = kml_el("Placemark")
    ET.SubElement(pm, f"{{{KML_NS}}}name").text = name
    ET.SubElement(pm, f"{{{KML_NS}}}description").text = description
    if style_url:
        ET.SubElement(pm, f"{{{KML_NS}}}styleUrl").text = style_url
    point = ET.SubElement(pm, f"{{{KML_NS}}}Point")
    ET.SubElement(point, f"{{{KML_NS}}}coordinates").text = f"{lon},{lat},0"
    return pm


def _first_present(obj, keys):
    for key in keys:
        v = obj.get(key)
        if v is not None and v != "":
            return v
    return None


def coords_from_obj(obj):
    """Try multiple field names for lat/lon. Returns (lat, lon) or None."""
    if not isinstance(obj, dict):
        return None
    nested = obj.get("lat_lon") if isinstance(obj.get("lat_lon"), dict) else {}
    lat = _first_present(obj, ("lat", "latitude"))
    if lat is None:
        lat = _first_present(nested, ("lat",))
    lon = _first_present(obj, ("lon", "lng", "longitude"))
    if lon is None:
        lon = _first_present(nested, ("lon", "lng"))
    if lat is None or lon is None or isinstance(lat, bool) or isinstance(lon, bool):
        return None
    try:
        lat, lon = float(lat), float(lon)
    except (ValueError, TypeError):
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None
    return lat, lon


def _lines(pairs, lang):
    """`label: value` lines for the fields that have a value."""
    out = []
    for label, value in pairs:
        s = text_in(value, lang)
        if s:
            out.append(f"{label}: {s}")
    return out


def hotel_description(acc, phase_name, dates, lang):
    L = labels(lang)
    F = L["fields"]
    parts = [f"{L['stop']}: {phase_name}"]
    if dates:
        parts.append(f"{L['dates']}: {dates}")
    parts += _lines([
        (F["address"], acc.get("address")),
        (F["checkIn"], _first_present(acc, ("checkIn", "check_in"))),
        (F["checkOut"], _first_present(acc, ("checkOut", "check_out"))),
        (F["confirmationNumber"], acc.get("confirmationNumber")),
        (F["notes"], acc.get("notes")),
    ], lang)
    return "\n".join(parts)


def booking_description(b, lang):
    L = labels(lang)
    F = L["fields"]
    btype = text_in(b.get("type"), "en").lower()
    date = _first_present(b, ("date", "date_from"))
    return "\n".join(_lines([
        (F["type"], L["types"].get(btype, btype)),
        (F["date"], date),
        (F["provider"], b.get("provider")),
        (F["confirmationNumber"], b.get("confirmationNumber")),
        (F["notes"], b.get("notes")),
        (F["address"], b.get("address")),
    ], lang))


def _phase_dates(phase):
    dates = phase.get("dates") if isinstance(phase.get("dates"), dict) else {}
    start = text_in(_first_present(phase, ("startDate", "start")) or dates.get("start"), "en")
    end = text_in(_first_present(phase, ("endDate", "end")) or dates.get("end"), "en")
    joined = f"{start} – {end}".strip(" –")
    return joined or text_in(dates.get("display"), "en")


def _as_list(v):
    if isinstance(v, dict):
        return [v]
    if isinstance(v, list):
        return v
    return []


def extract_hotels(config, lang):
    """Yield (name, description, lat, lon) for each accommodation."""
    L = labels(lang)
    if not isinstance(config, dict):
        return
    phases = config.get("phases") or config.get("itinerary") or []
    if not isinstance(phases, list):
        return
    name_keys = ("name_en", "name", "hotelName", "hotel", "title") if lang == "en" \
        else ("name", "hotelName", "hotel", "title", "name_en")
    for phase in phases:
        if not isinstance(phase, dict):
            continue
        phase_name = first_text(phase, ("name", "title", "destination"), lang) or L["stop"]
        dates = _phase_dates(phase)

        # A legacy multi-hotel stop lists every hotel in `hotels`; otherwise the
        # stop's one `accommodation` (or a hand-written `hotel`), object or list.
        acc_list = _as_list(phase.get("hotels")) or _as_list(phase.get("accommodation") or phase.get("hotel"))

        for acc in acc_list:
            if not isinstance(acc, dict) or not acc:
                continue
            # fallback: the stop's own coordinates, then its map pin — the only
            # coordinates /api/config serves for a config-built stop.
            coords = coords_from_obj(acc) or coords_from_obj(phase) or coords_from_obj(phase.get("mapStop"))
            if not coords:
                continue
            name = first_text(acc, name_keys, lang) or f"{L['hotel_of']} – {phase_name}"
            desc = hotel_description(acc, phase_name, dates, lang)
            yield name, desc, coords[0], coords[1]


def extract_bookings(bookings, lang, type_filter=None):
    """Yield (name, type, description, lat, lon) from bookings list."""
    if not bookings:
        return
    L = labels(lang)
    # bookings might be wrapped: {"bookings": [...]} or just [...]
    if isinstance(bookings, dict):
        bookings = bookings.get("bookings") or bookings.get("items") or []
    if not isinstance(bookings, list):
        return
    for b in bookings:
        if not isinstance(b, dict):
            continue
        btype = text_in(b.get("type"), "en").lower()
        if type_filter and btype != type_filter:
            continue
        coords = coords_from_obj(b) or coords_from_obj(b.get("location"))
        if not coords:
            continue
        name = first_text(b, ("name", "title"), lang) or L["types"].get(btype) or L["place"]
        desc = booking_description(b, lang)
        yield name, btype, desc, coords[0], coords[1]


def trip_title(config, lang):
    meta = config.get("meta") if isinstance(config.get("meta"), dict) else {}
    meta_keys = ("title_en", "title") if lang == "en" else ("title", "title_en")
    return (
        first_text(meta, meta_keys, lang)
        or first_text(config, ("tripName", "name", "title"), lang)
        or labels(lang)["default_trip"]
    )


def build_kml(config, bookings, filter_mode, trip_name, lang="he"):
    L = labels(lang)
    root = ET.Element(f"{{{KML_NS}}}kml")
    doc = ET.SubElement(root, f"{{{KML_NS}}}Document")
    ET.SubElement(doc, f"{{{KML_NS}}}name").text = f"{trip_name} — {L['filter'].get(filter_mode, filter_mode)}"
    ET.SubElement(doc, f"{{{KML_NS}}}description").text = f"{L['exported']}: {datetime.now().strftime('%Y-%m-%d %H:%M')}"

    # Add styles
    for style_id, icon_url in TYPE_ICONS.items():
        add_style(doc, style_id, icon_url)

    added = 0

    # Hotels folder
    if filter_mode in ("all", "hotels"):
        folder = ET.SubElement(doc, f"{{{KML_NS}}}Folder")
        ET.SubElement(folder, f"{{{KML_NS}}}name").text = L["hotels_folder"]
        for name, desc, lat, lon in extract_hotels(config, lang):
            pm = make_placemark(name, desc, lat, lon, "#hotel")
            folder.append(pm)
            added += 1

    # Bookings folders
    if filter_mode in ("all", "attractions", "all_bookings"):
        btype_filter = "attraction" if filter_mode == "attractions" else None
        folder = ET.SubElement(doc, f"{{{KML_NS}}}Folder")
        folder_name = L["attractions_folder"] if filter_mode == "attractions" else L["bookings_folder"]
        ET.SubElement(folder, f"{{{KML_NS}}}name").text = folder_name
        for name, btype, desc, lat, lon in extract_bookings(bookings, lang, type_filter=btype_filter):
            style = f"#{btype}" if btype in TYPE_ICONS else "#default"
            pm = make_placemark(name, desc, lat, lon, style)
            folder.append(pm)
            added += 1

    if filter_mode == "restaurants":
        folder = ET.SubElement(doc, f"{{{KML_NS}}}Folder")
        ET.SubElement(folder, f"{{{KML_NS}}}name").text = L["restaurants_folder"]
        for name, btype, desc, lat, lon in extract_bookings(bookings, lang, type_filter="restaurant"):
            pm = make_placemark(name, desc, lat, lon, "#restaurant")
            folder.append(pm)
            added += 1

    return root, added


def _decoded(v):
    """get_config / get_bookings may arrive as their JSON text rather than parsed."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return None
    return v


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="/tmp/trip_export.kml")
    parser.add_argument("--filter", default="all",
                        choices=["all", "hotels", "attractions", "restaurants", "all_bookings"])
    args = parser.parse_args()

    raw = sys.stdin.read()
    data = json.loads(raw)

    config   = _decoded(data.get("config")) or {}
    bookings = _decoded(data.get("bookings")) or []
    if not isinstance(config, dict):
        config = {}

    lang = trip_language(config, bookings)
    trip_name = trip_title(config, lang)

    root, added = build_kml(config, bookings, args.filter, trip_name, lang)

    out_path = Path(args.output)
    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(str(out_path), encoding="utf-8", xml_declaration=True)

    print(json.dumps({
        "ok": True,
        "file": str(out_path),
        "filter": args.filter,
        "placemarks": added,
        "trip": trip_name,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
