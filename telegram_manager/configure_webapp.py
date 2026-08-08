#!/usr/bin/env python3
"""Configure a managed trip bot's Web App menu button from environment values.

This is idempotent and only uses the Bot API.  Telegram Login Widget domain
registration remains a BotFather/MTProto capability and is deliberately
reported as a required external verification step.
"""
import argparse, asyncio, json, os
from urllib.parse import urlparse
from .main import API


def main_args():
    p = argparse.ArgumentParser()
    p.add_argument('--bot-token', default=os.getenv('TELEGRAM_BOT_TOKEN'))
    p.add_argument('--site-url', required=True)
    p.add_argument('--label', default='אתר הטיול')
    p.add_argument('--dry-run', action='store_true')
    return p.parse_args()

async def run(args):
    parsed = urlparse(args.site_url)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.query or parsed.fragment:
        raise SystemExit('--site-url must be a clean HTTPS origin or page URL')
    if not args.bot_token:
        raise SystemExit('TELEGRAM_BOT_TOKEN is required via environment or --bot-token')
    payload = {'menu_button': {'type': 'web_app', 'text': args.label, 'web_app': {'url': args.site_url}}}
    if args.dry_run:
        print(json.dumps({'dry_run': True, 'method': 'setChatMenuButton', 'site_url': args.site_url}, ensure_ascii=False)); return
    api = API(args.bot_token)
    try:
        await api.call('setChatMenuButton', **payload)
        got = await api.call('getChatMenuButton')
        if got.get('type') != 'web_app' or got.get('web_app', {}).get('url') != args.site_url:
            raise RuntimeError('menu button verification failed')
        print(json.dumps({'ok': True, 'site_url': args.site_url, 'login_widget_domain': 'requires_botfather_verification'}, ensure_ascii=False))
    finally:
        await api.close()

if __name__ == '__main__': asyncio.run(run(main_args()))
