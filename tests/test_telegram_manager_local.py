import asyncio
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))
from telegram_manager.config import Settings
from telegram_manager.main import Manager
from cryptography.fernet import Fernet

class FakeAPI:
    def __init__(self): self.calls=[]
    async def call(self, method, **params):
        self.calls.append((method,params))
        if method == "getManagedBotToken": return "child-token"
        return {"ok": True}

async def run():
    with tempfile.TemporaryDirectory() as d:
        s=Settings(manager_bot_token="x"*25, storage_key=Fernet.generate_key().decode(), database_path=Path(d)/"db.sqlite")
        m=Manager(s); m.api=FakeAPI()
        update={"message":{"from":{"id":42},"chat":{"id":42},"managed_bot_created":{"bot":{"id":99,"username":"test_child"}}}}
        await m.handle(update)
        assert m.store.crypto.decrypt(__import__('sqlite3').connect(s.database_path).execute('select token_ciphertext from managed_bots').fetchone()[0]).decode()=="child-token"
        assert ('getManagedBotToken',{'user_id':99}) in m.api.calls
        assert any(x[0]=='sendMessage' for x in m.api.calls)
asyncio.run(run())
print('managed-bot local workflow test: PASS')
