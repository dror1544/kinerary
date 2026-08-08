"""Short, Telegram command-parser-safe, signed, single-use group invitations."""
import hashlib, hmac, secrets, sqlite3, time
from dataclasses import dataclass
from pathlib import Path

@dataclass(frozen=True)
class GroupInvite:
    trip_id: str; organizer_id: int; expires_at: int; nonce: str

class InviteStore:
    def __init__(self,path:Path):
        self.path=path; path.parent.mkdir(parents=True,exist_ok=True)
        with sqlite3.connect(path) as c: c.execute('CREATE TABLE IF NOT EXISTS group_invites (nonce TEXT PRIMARY KEY, trip_id TEXT NOT NULL, organizer_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)')
    def issue(self,trip_id:str,organizer_id:int,ttl_seconds:int=3600)->GroupInvite:
        i=GroupInvite(trip_id,organizer_id,int(time.time())+ttl_seconds,secrets.token_hex(12))
        with sqlite3.connect(self.path) as c: c.execute('INSERT INTO group_invites VALUES(?,?,?,?,NULL)',(i.nonce,i.trip_id,i.organizer_id,i.expires_at))
        return i
    def consume(self,nonce:str)->GroupInvite:
        with sqlite3.connect(self.path) as c:
            r=c.execute('SELECT trip_id,organizer_id,expires_at,used_at FROM group_invites WHERE nonce=?',(nonce,)).fetchone()
            if not r or r[3] is not None or r[2]<time.time(): raise ValueError('invalid, used, or expired invite')
            c.execute('UPDATE group_invites SET used_at=? WHERE nonce=?',(int(time.time()),nonce))
        return GroupInvite(r[0],r[1],r[2],nonce)

def payload(invite:GroupInvite,signing_key:str)->str:
    # Hex only: Telegram command parsers may lowercase /start payloads.
    mac=hmac.new(signing_key.encode(),invite.nonce.encode(),hashlib.sha256).hexdigest()[:24]
    return invite.nonce+mac

def verify(payload_text:str,signing_key:str)->str:
    if len(payload_text)!=48 or any(c not in '0123456789abcdef' for c in payload_text): raise ValueError('invalid payload syntax')
    nonce,mac=payload_text[:24],payload_text[24:]
    expected=hmac.new(signing_key.encode(),nonce.encode(),hashlib.sha256).hexdigest()[:24]
    if not hmac.compare_digest(mac,expected): raise ValueError('invalid signature')
    return nonce

def url(bot_username:str,payload_text:str)->str:
    if len(payload_text)>64: raise ValueError('Telegram startgroup payload exceeds 64 chars')
    return f'https://t.me/{bot_username}?startgroup={payload_text}'
