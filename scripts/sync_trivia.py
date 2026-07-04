#!/usr/bin/env python3
"""
sync_trivia.py — Sync trivia questions from Obsidian notes → trips/<slug>/trivia_questions.json

Usage:
    python3 scripts/sync_trivia.py <obsidian-md-file> <trip-dir> [--dry-run]

    <obsidian-md-file>  Markdown file with one "## <Person>" or "### <Person>"
                         section per participant, each with "- question" bullets
                         and nested "- answer" / "- **correct answer**" bullets.
    <trip-dir>           e.g. trips/my-trip — must contain trip.config.json.
                         Participant names are read from there to build the
                         person-section → username map; nothing is hardcoded.

Rules:
  - New questions in Obsidian are added to the JSON (en field left empty — add manually).
  - Existing questions: correct answer flag is updated if it changed.
  - Questions removed from Obsidian are NOT removed from the JSON (manual only).
  - Answer option text in the JSON is preserved as-is (may be richer/funnier than Obsidian).
  - Minor wording differences (spelling variants, apostrophe styles, typos) are handled by
    fuzzy matching — questions within 70% similarity are treated as the same question.
  - A section header matches a participant if their trip.config.json `name` appears
    anywhere in the header — so "Grandpa Sam" matches a participant named "Sam".
"""

import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

FUZZY_THRESHOLD = 0.70         # min SequenceMatcher ratio to treat two questions as the same
ANSWER_FUZZY_THRESHOLD = 0.75  # min ratio to treat two answer options as the same

# Section headers that aren't a specific participant — always available regardless of trip.
GENERIC_SECTIONS = {
    "שאלות כלליות": "general", "general": "general", "general questions": "general",
    "שאלות על הטיול": "trip", "trip": "trip", "about the trip": "trip",
}


def load_person_map(trip_dir: Path) -> dict[str, str]:
    """Build {section-header-text: username} from trip.config.json — never hardcoded."""
    cfg_path = trip_dir / "trip.config.json"
    if not cfg_path.exists():
        print(f"❌  {cfg_path} not found", file=sys.stderr)
        sys.exit(1)
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    person_map = dict(GENERIC_SECTIONS)
    for p in cfg.get("participants", []):
        if p.get("name"):
            person_map[p["name"]] = p["username"]
        if p.get("name_en"):
            person_map[p["name_en"]] = p["username"]
    return person_map


def resolve_person(header: str, person_map: dict[str, str]) -> str | None:
    """Match a section header to a username. Exact match first, then substring
    (so "Grandpa Sam" / "סבא סמי" matches a participant named "Sam" / "סמי")."""
    header = header.strip()
    if header in person_map:
        return person_map[header]
    for name, username in person_map.items():
        if name and name in header:
            return username
    return None


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------
def norm_q(text: str) -> str:
    """Normalize a question string for comparison.

    Handles:
      - Trailing question marks
      - Hebrew apostrophe ׳ → ASCII '
      - Geresh/gershayim characters
      - Collapsing whitespace
    """
    t = text.strip().rstrip("?").strip()
    t = t.replace("׳", "'").replace("״", '"')
    t = re.sub(r"\s+", " ", t)
    return t.lower()


def norm_a(text: str) -> str:
    """Normalize an answer string for comparison.

    Also handles currency/number formatting differences:
      - 225,000 vs 225000
      - $225,000 vs 225,000$
    """
    t = text.strip()
    t = t.replace("׳", "'").replace("״", '"')
    # Normalize number formatting: remove commas inside numbers, strip $ symbol
    t = re.sub(r"(\d),(\d)", r"\1\2", t)  # 225,000 → 225000
    t = t.replace("$", "").strip()
    t = re.sub(r"\s+", " ", t)
    return t.lower()


# ---------------------------------------------------------------------------
# Fuzzy question matching
# ---------------------------------------------------------------------------
def best_match_key(key: str, ex_index: dict[str, dict]) -> str | None:
    """Return the key in ex_index that best matches `key`, or None.

    Strategy (in order):
    1. Exact match after normalization.
    2. Prefix match: the shorter normalized text is a prefix of the longer.
    3. Fuzzy match via SequenceMatcher ratio ≥ FUZZY_THRESHOLD.
    """
    if key in ex_index:
        return key

    for ex_key in ex_index:
        shorter, longer = (key, ex_key) if len(key) <= len(ex_key) else (ex_key, key)
        if longer.startswith(shorter):
            return ex_key

    best_ex_key: str | None = None
    best_ratio = 0.0
    for ex_key in ex_index:
        ratio = SequenceMatcher(None, key, ex_key).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_ex_key = ex_key

    return best_ex_key if best_ratio >= FUZZY_THRESHOLD else None


def answer_matches(json_he: str, obsidian_he: str) -> bool:
    """True if two answer texts refer to the same option (fuzzy, handles number formatting)."""
    jn = norm_a(json_he)
    on = norm_a(obsidian_he)
    if jn == on:
        return True
    if jn.startswith(on) or on.startswith(jn):
        return True
    if min(len(jn), len(on)) < 10:
        return False
    return SequenceMatcher(None, jn, on).ratio() >= ANSWER_FUZZY_THRESHOLD


# ---------------------------------------------------------------------------
# Obsidian markdown parser
# ---------------------------------------------------------------------------
def parse_obsidian(path: Path, person_map: dict[str, str]) -> list[dict]:
    """Parse Obsidian markdown into a flat list of question dicts."""
    lines = path.read_text(encoding="utf-8").split("\n")
    questions: list[dict] = []
    current_person: str | None = None
    i = 0

    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()

        m3 = re.match(r"^### (.+)$", raw)
        m2 = re.match(r"^## (.+)$", raw)
        if m3:
            current_person = resolve_person(m3.group(1), person_map)
            i += 1
            continue
        if m2:
            current_person = resolve_person(m2.group(1), person_map)
            i += 1
            continue

        if stripped in ("---", "") or not current_person:
            i += 1
            continue

        indent = len(raw) - len(raw.lstrip())

        if stripped.startswith("- ") and indent <= 1:
            q_text = stripped[2:].strip()
            answers: list[dict] = []
            i += 1

            while i < len(lines):
                araw = lines[i]
                astripped = araw.strip()
                aindent = len(araw) - len(araw.lstrip())

                if re.match(r"^#{1,3} ", araw) or astripped == "---":
                    break
                if astripped.startswith("- ") and aindent <= 1:
                    break

                if astripped.startswith("- ") and aindent >= 2:
                    ans_raw = astripped[2:].strip()
                    correct = ans_raw.startswith("**") and ans_raw.endswith("**")
                    if correct:
                        ans_raw = ans_raw[2:-2].strip()
                    answers.append({"he": ans_raw, "en": "", "correct": correct})

                i += 1

            if len(answers) >= 2:
                questions.append(
                    {
                        "he": q_text,
                        "persons": current_person,
                        "category": "trip" if current_person == "trip" else "family",
                        "answers": answers,
                    }
                )
        else:
            i += 1

    return questions


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------
def sync(obsidian_src: Path, json_path: Path, person_map: dict[str, str], dry_run: bool = False) -> None:
    if not obsidian_src.exists():
        print(f"❌  Obsidian source not found:\n    {obsidian_src}", file=sys.stderr)
        sys.exit(1)

    md_questions = parse_obsidian(obsidian_src, person_map)
    existing: list[dict] = json.loads(json_path.read_text(encoding="utf-8")) if json_path.exists() else []
    max_id = max((q["id"] for q in existing), default=0)

    ex_index: dict[str, dict] = {norm_q(q["he"]): q for q in existing}

    added: list[str] = []
    updated: list[tuple[str, str]] = []
    unchanged = 0

    for md_q in md_questions:
        key = norm_q(md_q["he"])
        matched_key = best_match_key(key, ex_index)

        if matched_key is not None:
            ex_q = ex_index[matched_key]
            changes: list[str] = []
            md_correct_options = [a for a in md_q["answers"] if a["correct"]]

            for mc in md_correct_options:
                json_match = next(
                    (a for a in ex_q["answers"] if answer_matches(a["he"], mc["he"])),
                    None,
                )
                if json_match:
                    if not json_match["correct"]:
                        changes.append(f"correct changed to: '{json_match['he']}'")
                        if not dry_run:
                            for a in ex_q["answers"]:
                                a["correct"] = False
                            json_match["correct"] = True
                else:
                    changes.append(f"new correct option: '{mc['he']}'")
                    if not dry_run:
                        for a in ex_q["answers"]:
                            a["correct"] = False
                        ex_q["answers"].append({"he": mc["he"], "en": "", "correct": True})

            if changes:
                updated.append((ex_q["he"], "; ".join(changes)))
            else:
                unchanged += 1
        else:
            max_id += 1
            new_q: dict = {
                "id": max_id,
                "he": md_q["he"],
                "en": "",
                "persons": md_q["persons"],
                "answers": md_q["answers"],
                "duration": 20,
                "category": md_q["category"],
            }
            if not dry_run:
                existing.append(new_q)
                ex_index[norm_q(new_q["he"])] = new_q
            added.append(md_q["he"])

    if not dry_run:
        json_path.write_text(
            json.dumps(existing, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    tag = " [DRY RUN]" if dry_run else ""
    print(f"\nSync complete{tag}")
    print(f"  Obsidian  : {len(md_questions)} questions parsed")
    print(f"  Added     : {len(added)}")
    print(f"  Updated   : {len(updated)}")
    print(f"  Unchanged : {unchanged}")

    if added:
        print("\nNEW questions (add English translation manually, or run trivia_agent.py):")
        for q in added:
            print(f"  + {q}")

    if updated:
        print("\nUPDATED questions:")
        for q, desc in updated:
            print(f"  ~ {q}")
            print(f"      {desc}")

    if not dry_run and (added or updated):
        print(f"\nSaved → {json_path}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    if "--help" in sys.argv or "-h" in sys.argv or len(sys.argv) < 3:
        print(__doc__)
        sys.exit(0 if "--help" in sys.argv or "-h" in sys.argv else 1)

    obsidian_arg = Path(sys.argv[1])
    trip_dir_arg = Path(sys.argv[2])
    dry_run_arg = "--dry-run" in sys.argv

    pmap = load_person_map(trip_dir_arg)
    sync(obsidian_arg, trip_dir_arg / "trivia_questions.json", pmap, dry_run=dry_run_arg)
