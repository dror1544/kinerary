"""Telegram Bot API 9.6 managed-bot manager.
Uses Bot API (not BotFather text commands or MTProto)."""
import asyncio, hashlib, logging, sqlite3, time
from contextlib import closing
from typing import Any
import httpx
from cryptography.fernet import Fernet
from .config import Settings

log = logging.getLogger(__name__)

class TelegramError(RuntimeError): pass
class API:
    def __init__(self, token: str): self.base=f"https://api.telegram.org/bot{token}/"; self.http=httpx.AsyncClient(timeout=45)
    async def call(self, method: str, **params: Any) -> Any:
        r=await self.http.post(self.base+method,json=params); d=r.json()
        if not d.get("ok"): raise TelegramError(f"{method}: {d.get('description','unknown error')}")
        return d["result"]
    async def close(self): await self.http.aclose()

class Store:
    def __init__(self,s: Settings):
        s.database_path.parent.mkdir(parents=True,exist_ok=True); self.path=s.database_path; self.crypto=Fernet(s.storage_key.encode())
        with closing(sqlite3.connect(self.path)) as c:
            c.execute("CREATE TABLE IF NOT EXISTS managed_bots (bot_id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, username TEXT, token_ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL)"); c.commit()
    def save(self, bot: dict, owner_id: int, token: str):
        encrypted=self.crypto.encrypt(token.encode())
        with closing(sqlite3.connect(self.path)) as c:
            c.execute("INSERT INTO managed_bots VALUES(?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET username=excluded.username,token_ciphertext=excluded.token_ciphertext",(bot['id'],owner_id,bot.get('username'),encrypted,int(time.time()))); c.commit()

class Manager:
    def __init__(self,s:Settings): self.s=s; self.api=API(s.manager_bot_token); self.store=Store(s); self.offset=None; self.username=""
    async def configure_child(self, token:str, name:str, about:str, description:str, commands:list[dict]):
        child=API(token)
        try:
            await child.call("setMyName",name=name); await child.call("setMyShortDescription",short_description=about); await child.call("setMyDescription",description=description); await child.call("setMyCommands",commands=commands)
        finally: await child.close()
    async def handle(self,u:dict):
        msg=u.get("message") or {}
        created=msg.get("managed_bot_created")
        if created:
            bot=created["bot"]; owner=msg.get("from",{}).get("id")
            if not owner: raise TelegramError("managed bot update missing owner")
            token=await self.api.call("getManagedBotToken",user_id=bot["id"])
            self.store.save(bot,owner,token)
            await self.api.call("sendMessage",chat_id=msg["chat"]["id"],text=f"הבוט @{bot.get('username','')} נוצר ונשמר בצורה מאובטחת.")
            return
        if msg.get("text")!="/create_trip_bot": return
        user=msg["from"]["id"]; suffix=hashlib.sha256(str(user).encode()).hexdigest()[:8]
        keyboard={"keyboard":[[{"text":"🤖 יצירת בוט טיול","request_managed_bot":{"request_id":1,"suggested_name":"Kinerary Trip","suggested_username":f"kinerary_{suffix}_bot"}}]],"resize_keyboard":True,"one_time_keyboard":True}
        await self.api.call("sendMessage",chat_id=msg["chat"]["id"],text="אשר/י יצירת בוט טיול מנוהל:",reply_markup=keyboard)
    async def run(self):
        me=await self.api.call("getMe")
        if not me.get("can_manage_bots"): raise TelegramError("Manager bot lacks Bot Management Mode")
        self.username=me.get("username",""); log.info("manager @%s ready",self.username)
        while True:
            for u in await self.api.call("getUpdates",offset=self.offset,timeout=self.s.poll_timeout_seconds,allowed_updates=["message","managed_bot"]):
                self.offset=u["update_id"]+1
                try: await self.handle(u)
                except Exception: log.exception("update failed: %s",u.get("update_id"))

async def main():
    logging.basicConfig(level=logging.INFO); m=Manager(Settings())
    try: await m.run()
    finally: await m.api.close()
if __name__ == "__main__": asyncio.run(main())
