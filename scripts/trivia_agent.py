#!/usr/bin/env python3
"""
trivia_agent.py — AI-powered trivia pipeline: generate/sync + translate + quality review

Pipeline:
  1. Either generate N new questions from trip.config.json directly (--generate N),
     or sync questions from an Obsidian vault (--obsidian <file>) — same logic as
     sync_trivia.py. Skip both with --check-only.
  2. Translate new / empty-en questions to English using Claude.
  3. Quality-check every question and flag issues.
  4. Save the updated trivia_questions.json.

Usage:
    python3 scripts/trivia_agent.py <trip-dir>                        # translate + review only
    python3 scripts/trivia_agent.py <trip-dir> --generate 15          # draft 15 new questions from trip.config.json
    python3 scripts/trivia_agent.py <trip-dir> --obsidian notes.md    # sync from an Obsidian vault first
    python3 scripts/trivia_agent.py <trip-dir> --dry-run              # preview, don't save
    python3 scripts/trivia_agent.py <trip-dir> --translate-all        # re-translate every question
    python3 scripts/trivia_agent.py <trip-dir> --check-only           # quality check only
    python3 scripts/trivia_agent.py <trip-dir> --model claude-haiku-4-5-20251001

    <trip-dir>  e.g. trips/my-trip — must contain trip.config.json.
                Reads/writes <trip-dir>/trivia_questions.json.

Requires:
    ANTHROPIC_API_KEY set in environment or in .env at the project root
    pip install anthropic          (installed automatically on first run if missing)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from textwrap import dedent

try:
    import anthropic  # type: ignore
except ImportError:
    print("📦 anthropic SDK not found — installing…")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "anthropic"])
    except subprocess.CalledProcessError:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q", "--break-system-packages", "anthropic"]
        )
    import anthropic  # type: ignore  # noqa: F811


SCRIPTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPTS_DIR.parent
ENV_PATH = PROJECT_ROOT / ".env"

DEFAULT_MODEL = "claude-haiku-4-5-20251001"
TRANSLATE_BATCH = 25   # questions per API call for translation
REVIEW_BATCH = 40      # questions per API call for quality review
GENERATE_BATCH = 15    # max questions requested per generation API call


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env(ENV_PATH)

sys.path.insert(0, str(SCRIPTS_DIR))
from sync_trivia import (  # noqa: E402
    answer_matches,
    best_match_key,
    load_person_map,
    norm_q,
    parse_obsidian,
)


def load_trip_config(trip_dir: Path) -> dict:
    cfg_path = trip_dir / "trip.config.json"
    if not cfg_path.exists():
        print(f"❌  {cfg_path} not found", file=sys.stderr)
        sys.exit(1)
    return json.loads(cfg_path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Sync logic (mirrors sync_trivia.sync() but returns change sets, no file I/O)
# ---------------------------------------------------------------------------
def run_sync(
    existing: list[dict], obsidian_src: Path, person_map: dict[str, str], dry_run: bool = False
) -> tuple[list[dict], list[str], list[tuple[str, str]]]:
    md_questions = parse_obsidian(obsidian_src, person_map)
    max_id = max((q["id"] for q in existing), default=0)
    ex_index: dict[str, dict] = {norm_q(q["he"]): q for q in existing}

    added: list[str] = []
    updated: list[tuple[str, str]] = []

    for md_q in md_questions:
        key = norm_q(md_q["he"])
        matched_key = best_match_key(key, ex_index)

        if matched_key is not None:
            ex_q = ex_index[matched_key]
            changes: list[str] = []
            for mc in [a for a in md_q["answers"] if a["correct"]]:
                json_match = next(
                    (a for a in ex_q["answers"] if answer_matches(a["he"], mc["he"])),
                    None,
                )
                if json_match:
                    if not json_match["correct"]:
                        changes.append(f"correct → '{json_match['he']}'")
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
            added.append(new_q["he"])

    return existing, added, updated


# ---------------------------------------------------------------------------
# Generate — draft new questions directly from trip.config.json (no Obsidian needed)
# ---------------------------------------------------------------------------
GENERATE_SYSTEM = dedent("""\
    You write bilingual (Hebrew + English) Kahoot-style trivia questions for a
    family/friend-group trip. Mix destination trivia (real facts about the places
    on the itinerary) with light "about us" questions using the trip's own
    participant/family data — never invent personal facts you weren't given.

    Rules:
    • Each question has exactly 4 answer options, exactly one marked correct.
    • Keep it warm and fun, not a pub quiz — this is for a group that knows each other.
    • Output ONLY a valid JSON array — no markdown, no prose.\
""")

GENERATE_USER_TMPL = dedent("""\
    Trip: {title}
    Destinations: {destinations}
    Participants (username: name, age, family): {participants}

    Write {n} trivia questions as a JSON array. Distribute "persons" across the
    participant usernames listed above for "about us" questions, and use "trip"
    for general destination/logistics questions. Shape:
    [
      {{
        "he": "<question in Hebrew>",
        "en": "<question in English>",
        "persons": "<username, or \\"trip\\" for general>",
        "category": "family" | "trip",
        "answers": [
          {{"he": "...", "en": "...", "correct": true}},
          {{"he": "...", "en": "...", "correct": false}},
          {{"he": "...", "en": "...", "correct": false}},
          {{"he": "...", "en": "...", "correct": false}}
        ]
      }}
    ]
""")


def _extract_json(text: str) -> str:
    text = text.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text)
    return m.group(1) if m else text


def generate_questions(
    cfg: dict, n: int, client: anthropic.Anthropic, model: str
) -> list[dict]:
    title = cfg.get("meta", {}).get("title", "the trip")
    destinations = ", ".join(p.get("tabLabel", p.get("id", "")) for p in cfg.get("phases", []))
    participants = ", ".join(
        f"{p['username']}: {p.get('name_en', p.get('name', ''))}, age {p.get('age', '?')}, family {p.get('family', '')}"
        for p in cfg.get("participants", [])
    )

    all_new: list[dict] = []
    remaining = n
    while remaining > 0:
        batch_n = min(remaining, GENERATE_BATCH)
        print(f"  Generating {batch_n} question(s)…", end=" ", flush=True)
        try:
            response = client.messages.create(
                model=model,
                max_tokens=4096,
                system=GENERATE_SYSTEM,
                messages=[{
                    "role": "user",
                    "content": GENERATE_USER_TMPL.format(
                        title=title, destinations=destinations,
                        participants=participants, n=batch_n,
                    ),
                }],
            )
            raw = _extract_json(response.content[0].text)
            batch = json.loads(raw)
            all_new.extend(batch)
            print(f"✓ {len(batch)} drafted")
        except Exception as exc:
            print(f"✗ {exc}")
            break
        remaining -= batch_n

    return all_new


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------
TRANSLATE_USER_TMPL = dedent("""\
    Translate each question and its answers. Return a JSON array (same length, same order):

    [
      {{
        "id": <int>,
        "en": "<English question>",
        "answers": [{{"en": "<opt 1>"}}, {{"en": "<opt 2>"}}, {{"en": "<opt 3>"}}, {{"en": "<opt 4>"}}]
      }},
      ...
    ]

    Input:
    {payload}
""")


def translate_system_prompt(cfg: dict) -> str:
    title = cfg.get("meta", {}).get("title", "the trip")
    n_people = len(cfg.get("participants", []))
    # Build he→en name hints straight from the trip's own participant data —
    # never a hardcoded name list, this is what caught it out last time.
    name_hints = ", ".join(
        f"{p['name']}→{p.get('name_en', p['name'])}"
        for p in cfg.get("participants", []) if p.get("name") and p.get("name_en")
    )
    return dedent(f"""\
        You are a Hebrew→English translator preparing a bilingual Kahoot-style trivia game
        for "{title}" ({n_people} people).

        Translation rules:
        • Preserve warmth, humor, and family references — funny options must stay funny.
        • Keep names naturally transliterated using this trip's own spellings: {name_hints or "(no hints given)"}.
        • Output ONLY a valid JSON array — no markdown, no prose.\
    """)


def translate_batch(
    questions: list[dict], client: anthropic.Anthropic, model: str, system: str
) -> list[dict]:
    payload = json.dumps(
        [
            {"id": q["id"], "he": q["he"], "answers": [{"he": a["he"]} for a in q["answers"]]}
            for q in questions
        ],
        ensure_ascii=False, indent=2,
    )
    response = client.messages.create(
        model=model, max_tokens=4096, system=system,
        messages=[{"role": "user", "content": TRANSLATE_USER_TMPL.format(payload=payload)}],
    )
    raw = _extract_json(response.content[0].text)
    return json.loads(raw)


def apply_translations(existing: list[dict], translations: list[dict]) -> int:
    by_id = {t["id"]: t for t in translations}
    count = 0
    for q in existing:
        t = by_id.get(q["id"])
        if not t:
            continue
        if t.get("en"):
            q["en"] = t["en"]
        ans_trans = t.get("answers", [])
        for i, a in enumerate(q["answers"]):
            if i < len(ans_trans) and ans_trans[i].get("en"):
                a["en"] = ans_trans[i]["en"]
        count += 1
    return count


def translate_missing(
    existing: list[dict], client: anthropic.Anthropic, model: str, system: str,
    translate_all: bool = False,
) -> int:
    targets = [q for q in existing if translate_all or not q.get("en") or not q["en"].strip()]
    if not targets:
        return 0

    print(f"  Translating {len(targets)} question(s) in batches of {TRANSLATE_BATCH}…")
    total = 0
    for i in range(0, len(targets), TRANSLATE_BATCH):
        batch = targets[i : i + TRANSLATE_BATCH]
        n = i // TRANSLATE_BATCH + 1
        total_batches = (len(targets) + TRANSLATE_BATCH - 1) // TRANSLATE_BATCH
        print(f"    Batch {n}/{total_batches} ({len(batch)} questions)…", end=" ", flush=True)
        try:
            translations = translate_batch(batch, client, model, system)
            count = apply_translations(existing, translations)
            total += count
            print(f"✓ {count} translated")
        except Exception as exc:
            print(f"✗ {exc}")
    return total


# ---------------------------------------------------------------------------
# Quality review
# ---------------------------------------------------------------------------
REVIEW_SYSTEM = dedent("""\
    You are reviewing bilingual (Hebrew + English) trivia questions for a family game.
    Flag ONLY real problems — do not flag style preferences.
    Output ONLY a valid JSON array — no markdown, no prose.\
""")

REVIEW_USER_TMPL = dedent("""\
    Review these questions and flag issues. Check each question for:
    1. Missing or empty English (en field is "" or null).
    2. No correct answer (none of the answers has "correct": true).
    3. More than one correct answer.
    4. Duplicate or near-identical answer options.
    5. English translation is clearly wrong or doesn't match the Hebrew.
    6. Factual error that would confuse players.

    Return ONLY questions that have issues (skip clean ones):
    [
      {{
        "id": <int>,
        "he": "<question>",
        "issues": ["<short issue description>", ...]
      }}
    ]
    If everything is clean, return [].

    Questions:
    {payload}
""")


def review_batch(questions: list[dict], client: anthropic.Anthropic, model: str) -> list[dict]:
    payload = json.dumps(
        [
            {
                "id": q["id"], "he": q["he"], "en": q.get("en", ""),
                "answers": [
                    {"he": a["he"], "en": a.get("en", ""), "correct": a.get("correct", False)}
                    for a in q["answers"]
                ],
            }
            for q in questions
        ],
        ensure_ascii=False, indent=2,
    )
    response = client.messages.create(
        model=model, max_tokens=2048, system=REVIEW_SYSTEM,
        messages=[{"role": "user", "content": REVIEW_USER_TMPL.format(payload=payload)}],
    )
    raw = _extract_json(response.content[0].text)
    return json.loads(raw)


def quality_review(existing: list[dict], client: anthropic.Anthropic, model: str) -> list[dict]:
    print(f"  Reviewing {len(existing)} question(s) in batches of {REVIEW_BATCH}…")
    all_issues: list[dict] = []
    for i in range(0, len(existing), REVIEW_BATCH):
        batch = existing[i : i + REVIEW_BATCH]
        n = i // REVIEW_BATCH + 1
        total_batches = (len(existing) + REVIEW_BATCH - 1) // REVIEW_BATCH
        print(f"    Batch {n}/{total_batches} ({len(batch)} questions)…", end=" ", flush=True)
        try:
            issues = review_batch(batch, client, model)
            all_issues.extend(issues)
            print(f"✓ ({len(issues)} flagged)")
        except Exception as exc:
            print(f"✗ {exc}")
    return all_issues


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        sys.exit(0)
    if len(sys.argv) < 2 or sys.argv[1].startswith("--"):
        print(__doc__)
        sys.exit(1)

    trip_dir = Path(sys.argv[1])
    args = set(sys.argv[2:])

    dry_run = "--dry-run" in args
    translate_all = "--translate-all" in args
    check_only = "--check-only" in args

    obsidian_src: Path | None = None
    generate_n: int | None = None
    model = DEFAULT_MODEL
    rest = sys.argv[2:]
    for i, a in enumerate(rest):
        if a == "--obsidian" and i + 1 < len(rest):
            obsidian_src = Path(rest[i + 1])
        elif a == "--generate" and i + 1 < len(rest):
            generate_n = int(rest[i + 1])
        elif a.startswith("--model="):
            model = a.split("=", 1)[1]
        elif a == "--model" and i + 1 < len(rest):
            model = rest[i + 1]

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print(
            "❌  ANTHROPIC_API_KEY not set.\n"
            "   Add it to your .env file or environment:\n"
            "   ANTHROPIC_API_KEY=sk-ant-…",
            file=sys.stderr,
        )
        sys.exit(1)

    cfg = load_trip_config(trip_dir)
    client = anthropic.Anthropic(api_key=api_key)
    json_path = trip_dir / "trivia_questions.json"
    existing: list[dict] = json.loads(json_path.read_text(encoding="utf-8")) if json_path.exists() else []

    print(f"\n🎯  Trivia Agent  |  {cfg.get('meta', {}).get('title', trip_dir.name)}  |  model: {model}  |  {'DRY RUN  |  ' if dry_run else ''}{len(existing)} questions in JSON\n")

    # ------------------------------------------------------------------
    # Step 1 — Generate or Sync (mutually exclusive; both optional)
    # ------------------------------------------------------------------
    if not check_only and generate_n:
        print(f"1️⃣   Generate {generate_n} question(s) from trip.config.json…")
        max_id = max((q["id"] for q in existing), default=0)
        drafted = generate_questions(cfg, generate_n, client, model)
        for q in drafted:
            max_id += 1
            q.setdefault("id", max_id)
            q.setdefault("duration", 20)
            if not dry_run:
                existing.append(q)
        print(f"    ✅ Drafted {len(drafted)} question(s)")
    elif not check_only and obsidian_src:
        if not obsidian_src.exists():
            print(f"⚠️   Obsidian source not found, skipping sync:\n    {obsidian_src}")
        else:
            print("1️⃣   Sync from Obsidian…")
            person_map = load_person_map(trip_dir)
            existing, added, updated = run_sync(existing, obsidian_src, person_map, dry_run=dry_run)
            if added:
                print(f"    ✅ Added   : {len(added)}")
                for q in added:
                    print(f"       + {q}")
            if updated:
                print(f"    ✏️  Updated : {len(updated)}")
                for q, desc in updated:
                    print(f"       ~ {q}  →  {desc}")
            if not added and not updated:
                print("    ✓ Already in sync, nothing changed")

    # ------------------------------------------------------------------
    # Step 2 — Translate
    # ------------------------------------------------------------------
    if not check_only:
        print("\n2️⃣   Translate missing English…")
        if dry_run:
            needs = [q for q in existing if not q.get("en") or not q["en"].strip()]
            print(f"    [dry-run] would translate {len(needs)} question(s)")
        else:
            system = translate_system_prompt(cfg)
            count = translate_missing(existing, client, model, system, translate_all=translate_all)
            if count:
                print(f"    ✅ Translated {count} question(s)")
            else:
                print("    ✓ All questions already have English")

    # ------------------------------------------------------------------
    # Step 3 — Quality review
    # ------------------------------------------------------------------
    print("\n3️⃣   Quality review…")
    if dry_run:
        print("    [dry-run] skipping API calls for review")
        issues: list[dict] = []
    else:
        issues = quality_review(existing, client, model)

    # ------------------------------------------------------------------
    # Step 4 — Save
    # ------------------------------------------------------------------
    if not dry_run:
        json_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n💾  Saved → {json_path}")

    print("\n" + "─" * 60)
    print(f"  Total questions : {len(existing)}")
    if issues:
        print(f"\n⚠️   Quality issues ({len(issues)} question(s)):")
        for item in issues:
            print(f"\n  Q{item['id']}: {item.get('he', '')}")
            for iss in item.get("issues", []):
                print(f"    • {iss}")
    else:
        print("  ✅  No quality issues found")

    if dry_run:
        print("\n  (dry-run — nothing was written)")


if __name__ == "__main__":
    main()
