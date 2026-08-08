"""One-shot startgroup receiver. Run while the organizer adds the child bot."""
import asyncio, json, os, sqlite3
from pathlib import Path
from cryptography.fernet import Fernet
from .group_link import InviteStore, verify
from .main import API

async def main():
    env=dict(x.split('=',1) for x in Path('telegram_manager/.env').read_text().splitlines() if '=' in x)
    row=sqlite3.connect('data/managed_bots.sqlite3').execute("select token_ciphertext from managed_bots where username=?",('kinerary_onboarding_test_bot',)).fetchone()
    token=Fernet(env['TG_MANAGER_STORAGE_KEY'].encode()).decrypt(row[0]).decode()
    api=API(token); offset=None
    try:
        while True:
            updates=await api.call('getUpdates',offset=offset,timeout=45,allowed_updates=['message'])
            for u in updates:
                offset=u['update_id']+1; m=u.get('message',{}); text=m.get('text','')
                if m.get('chat',{}).get('type') not in ('group','supergroup') or not text.startswith('/start'): continue
                payload=text[6:].split('@',1)[0].lower()
                try:
                    invite=InviteStore(Path('data/group_invites.sqlite3')).consume(verify(payload,env['TG_MANAGER_GROUP_SIGNING_KEY']))
                    chat=m['chat']; Path('data/japan-2025-group.json').write_text(json.dumps({'trip_id':invite.trip_id,'chat_id':chat['id'],'title':chat.get('title'),'organizer_id':invite.organizer_id})+'\n')
                    await api.call('sendMessage',chat_id=chat['id'],text='✅ קבוצת הטיול חוברה בהצלחה. המארגן: קדם/י את הבוט ל-admin מוגבל; לאחר מכן יופעל האתר עם Telegram SSO.')
                    print('GROUP_ONBOARDING_SUCCESS',chat['id'],flush=True); return
                except Exception as e:
                    await api.call('sendMessage',chat_id=m['chat']['id'],text='❌ קישור ההקמה אינו תקין או פג תוקף. חזור/י לקישור חדש מהבוט.')
                    print('GROUP_ONBOARDING_REJECTED',type(e).__name__,flush=True)
    finally: await api.close()
if __name__=='__main__': asyncio.run(main())
