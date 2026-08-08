"""Deterministic startgroup intake handler used by the Kinerary Telegram gateway hook."""
import json
from pathlib import Path
from .group_link import InviteStore, verify


def consume_startgroup(*, payload: str, chat_id: int, chat_title: str, organizer_id: int, signing_key: str, db_path: Path, binding_path: Path) -> str:
    if chat_id >= 0:
        raise ValueError("startgroup must originate from a Telegram group")
    invite = InviteStore(db_path).consume(verify(payload, signing_key))
    if invite.organizer_id != organizer_id:
        raise ValueError("organizer does not match invitation")
    binding_path.parent.mkdir(parents=True, exist_ok=True)
    binding_path.write_text(json.dumps({"trip_id": invite.trip_id, "chat_id": chat_id, "title": chat_title, "organizer_id": organizer_id}, ensure_ascii=False) + "\n")
    return "✅ קבוצת הטיול חוברה בהצלחה. כעת קדם/י את הבוט ל-admin מוגבל כדי להפעיל Telegram SSO."
