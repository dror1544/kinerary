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
"""

import json
import sys
import argparse
import xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime

# ── KML namespace ───────────────────────────────────────────────────────────
KML_NS = "http://www.opengis.net/kml/2.2"
ET.register_namespace("", KML_NS)

FILTER_LABELS = {
    "all":          "כל המקומות",
    "hotels":       "מלונות ולינה",
    "attractions":  "אטרקציות",
    "restaurants":  "מסעדות",
    "all_bookings": "כל ההזמנות",
}

TYPE_ICONS = {
    "hotel":       "http://maps.google.com/mapfiles/kml/paddle/H.png",
    "attraction":  "http://maps.google.com/mapfiles/kml/paddle/ylw-stars.png",
    "restaurant":  "http://maps.google.com/mapfiles/kml/paddle/orange-circle.png",
    "flight":      "http://maps.google.com/mapfiles/kml/shapes/airports.png",
    "default":     "http://maps.google.com/mapfiles/kml/paddle/red-circle.png",
}


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


def coords_from_obj(obj):
    """Try multiple field names for lat/lon. Returns (lat, lon) or None."""
    lat = obj.get("lat") or obj.get("latitude") or obj.get("lat_lon", {}).get("lat")
    lon = obj.get("lon") or obj.get("lng") or obj.get("longitude") or obj.get("lat_lon", {}).get("lon")
    if lat is not None and lon is not None:
        try:
            return float(lat), float(lon)
        except (ValueError, TypeError):
            pass
    return None


def hotel_description(acc, phase_name, dates):
    parts = [f"שלב: {phase_name}"]
    if dates:
        parts.append(f"תאריכים: {dates}")
    for field in ("address", "checkIn", "checkOut", "confirmationNumber", "notes"):
        val = acc.get(field)
        if val:
            parts.append(f"{field}: {val}")
    return "\n".join(parts)


def booking_description(b):
    parts = []
    for field in ("type", "date", "provider", "confirmationNumber", "notes", "address"):
        val = b.get(field)
        if val:
            parts.append(f"{field}: {val}")
    return "\n".join(parts) if parts else ""


def extract_hotels(config):
    """Yield (name, description, lat, lon) for each accommodation."""
    phases = config.get("phases") or config.get("itinerary") or []
    for phase in phases:
        phase_name = phase.get("name") or phase.get("title") or phase.get("destination") or "שלב"
        dates = f"{phase.get('startDate','')} – {phase.get('endDate','')}".strip(" –")

        # accommodation can be a list or a single object
        acc_raw = phase.get("accommodation") or phase.get("hotel") or []
        if isinstance(acc_raw, dict):
            acc_raw = [acc_raw]

        for acc in acc_raw:
            if not acc:
                continue
            coords = coords_from_obj(acc)
            # fallback: phase-level coordinates
            if not coords:
                coords = coords_from_obj(phase)
            if not coords:
                continue
            name = acc.get("name") or acc.get("hotelName") or f"מלון – {phase_name}"
            desc = hotel_description(acc, phase_name, dates)
            yield name, desc, coords[0], coords[1]


def extract_bookings(bookings, type_filter=None):
    """Yield (name, type, description, lat, lon) from bookings list."""
    if not bookings:
        return
    # bookings might be wrapped: {"bookings": [...]} or just [...]
    if isinstance(bookings, dict):
        bookings = bookings.get("bookings") or bookings.get("items") or []
    for b in bookings:
        btype = (b.get("type") or "").lower()
        if type_filter and btype != type_filter:
            continue
        coords = coords_from_obj(b)
        if not coords:
            # try nested location object
            loc = b.get("location") or {}
            coords = coords_from_obj(loc)
        if not coords:
            continue
        name = b.get("name") or b.get("title") or btype or "מקום"
        desc = booking_description(b)
        yield name, btype, desc, coords[0], coords[1]


def build_kml(config, bookings, filter_mode, trip_name):
    root = ET.Element(f"{{{KML_NS}}}kml")
    doc = ET.SubElement(root, f"{{{KML_NS}}}Document")
    ET.SubElement(doc, f"{{{KML_NS}}}name").text = f"{trip_name} — {FILTER_LABELS.get(filter_mode, filter_mode)}"
    ET.SubElement(doc, f"{{{KML_NS}}}description").text = f"יוצא: {datetime.now().strftime('%Y-%m-%d %H:%M')}"

    # Add styles
    for style_id, icon_url in TYPE_ICONS.items():
        add_style(doc, style_id, icon_url)

    added = 0

    # Hotels folder
    if filter_mode in ("all", "hotels"):
        folder = ET.SubElement(doc, f"{{{KML_NS}}}Folder")
        ET.SubElement(folder, f"{{{KML_NS}}}name").text = "🏨 מלונות ולינה"
        for name, desc, lat, lon in extract_hotels(config):
            pm = make_placemark(name, desc, lat, lon, "#hotel")
            folder.append(pm)
            added += 1

    # Bookings folders
    if filter_mode in ("all", "attractions", "all_bookings"):
        btype_filter = "attraction" if filter_mode == "attractions" else None
        folder = ET.SubElement(doc, f"{{{KML_NS}}}Folder")
        folder_name = "⭐ אטרקציות" if filter_mode == "attractions" else "📍 הזמנות ופעילויות"
        ET.SubElement(folder, f"{{{KML_NS}}}name").text = folder_name
        for name, btype, desc, lat, lon in extract_bookings(bookings, type_filter=btype_filter):
            style = f"#{btype}" if btype in TYPE_ICONS else "#default"
            pm = make_placemark(name, desc, lat, lon, style)
            folder.append(pm)
            added += 1

    if filter_mode == "restaurants":
        folder = ET.SubElement(doc, f"{{{KML_NS}}}Folder")
        ET.SubElement(folder, f"{{{KML_NS}}}name").text = "🍽️ מסעדות"
        for name, btype, desc, lat, lon in extract_bookings(bookings, type_filter="restaurant"):
            pm = make_placemark(name, desc, lat, lon, "#restaurant")
            folder.append(pm)
            added += 1

    return root, added


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="/tmp/trip_export.kml")
    parser.add_argument("--filter", default="all",
                        choices=["all", "hotels", "attractions", "restaurants", "all_bookings"])
    args = parser.parse_args()

    raw = sys.stdin.read()
    data = json.loads(raw)

    config   = data.get("config") or {}
    bookings = data.get("bookings") or []

    trip_name = (
        config.get("tripName")
        or config.get("name")
        or config.get("title")
        or "הטיול שלנו"
    )

    root, added = build_kml(config, bookings, args.filter, trip_name)

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
