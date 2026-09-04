---
name: hermes-multiplex-relay
description: "Configure and reason about Hermes gateway multiplexing + the relay connector: which profiles get served, why the default profile is unavoidable, and the one env var that makes it safe."
version: 1.0.0
author: Kinerary
license: MIT
metadata:
  hermes:
    tags: [hermes, gateway, multiplex, relay, telegram, routing, operations]
    category: infrastructure
---

# Hermes multiplexing and the relay connector

Read this before changing `gateway.multiplex_profiles`,
`gateway.multiplex_profile_allowlist`, `gateway.relay_url`, or any
`GATEWAY_RELAY_*` variable. Every claim here was verified against a live
Hermes **0.20.5** install by running the code, not by reading it — the
commands that produced each result are included so you can re-verify rather
than trust this file.

If you are on a different Hermes version, **re-run the checks**. This is
undocumented internal behaviour, and the relay contract is explicitly marked
EXPERIMENTAL ("may change without a deprecation cycle").

## The one-sentence version

Multiplexing is only safe when `GATEWAY_RELAY_URL` is set **as an environment
variable**, because that — and only that — disables the directly-connected
messaging adapters that would otherwise collide with other running gateways.

## The three facts that trip people up

### 1. An empty allowlist serves NOTHING; an absent one serves EVERYTHING

This is backwards from most people's intuition and has been gotten wrong at
least twice in this project's history.

```
gateway:
  multiplex_profile_allowlist: []        # serves ONLY `default`
  # multiplex_profile_allowlist absent   # serves EVERY profile directory
  multiplex_profile_allowlist: [foo]     # serves `default` + `foo`
```

`profiles_to_serve` treats a *provided* list as a filter, and treats *absent*
as "no filter". Verify on the install in front of you:

```bash
cd ~/.hermes/hermes-agent && ./venv/bin/python -c "
import sys; sys.path.insert(0,'.')
from hermes_cli.profiles import profiles_to_serve
for label, arg in [('ABSENT', None), ('EMPTY', []), ('NAMED', ['some-profile'])]:
    print(label, [n for n,_ in profiles_to_serve(True, arg)])
"
```

The dangerous form is the absent one: it sweeps in every profile on the
machine, including unrelated ones that hold their own bot tokens and their own
cron jobs. **Always set the key explicitly.**

### 2. The `default` profile is ALWAYS served and cannot be excluded

There is **no deny list** — grep for one and you will find nothing.
`profiles_to_serve` unconditionally prepends `("default",
_get_default_hermes_home())` *before* the allowlist filter runs, and the
directory loop then skips `default` because it is already present. An allowlist
can add and remove named profiles; it has no power over `default`.

This matters because `default` is usually a real, live personal-assistant
profile with its own bot token — not an empty placeholder.

The only structural way to remove it from the set is to **promote your profile
to BE `default`** (`_start_secondary_profile_adapters` skips the profile that
equals the active one). That is a large, disruptive move. The practical answer
is instead to make `default` *inert*, which is what the next section is about.

### 3. Serving `default` is harmless ONLY under relay-exclusive mode

Two independent things happen when `default` joins the served set, and the
relay only fixes one of them.

**Its Telegram adapter (fixed by the relay stamp).** The mere presence of
`TELEGRAM_BOT_TOKEN` in a profile's `.env` auto-enables the Telegram platform
even with no `platforms:` block asking for it (`gateway/config.py` ~1991). In a
multiplexed process that means a second adapter for `default`'s bot, fighting
whatever gateway already holds that token — a Telegram **409 Conflict**, since
Telegram allows only one `getUpdates` consumer per token.

The relay-exclusive sweep (`gateway/config.py` ~2866-2889) disables **every**
directly-connected messaging platform — including ones explicitly enabled in a
profile's config.yaml — leaving only `local`, `api_server`, `webhook`. It runs
**per profile**: `load_gateway_config()` is called inside each profile's scope
(`gateway/run.py` ~15465), and the adapter loop skips whatever the sweep
disabled (~15500).

It reaches `default` because `GATEWAY_RELAY_URL` is on
`agent/secret_scope.py`'s **global env allowlist** (:129-130), short-circuited
to `os.environ` at :172-174 *before* profile scoping is consulted.
`TELEGRAM_BOT_TOKEN` is deliberately NOT on that list, which is exactly why the
token stays profile-scoped while the switch that disables it is global.

**Its cron jobs (NOT fixed by anything).** `gateway/run.py` (~31238) hands the
cron ticker the same unconditional `default` prepend. The relay sweep only
mutates `config.platforms`; it never touches cron. So a multiplexed gateway
ticks `default`'s enabled cron jobs *in addition to* whatever already ticks
them, concurrently — and nothing locks against it, because
`gateway/status.py` (~223) resolves the gateway lock relative to each process's
own `HERMES_HOME`, so the two processes lock different paths and never contend.

**Before enabling multiplexing, check that `default` has no enabled cron jobs**,
and re-check whenever someone adds one:

```bash
python3 -c "
import json,os
d=json.load(open(os.path.expanduser('~/.hermes/cron/jobs.json')))
print([j.get('name') for j in d.get('jobs',[]) if j.get('enabled')] or 'none enabled')
"
```

Also check the profiles you are about to allowlist — serving a profile
activates *its* cron too, which may include stale one-shot jobs whose `run_at`
is in the past.

## The env stamp is not interchangeable with the config key

```
GATEWAY_RELAY_URL=...        as an ENV VAR  -> relay-EXCLUSIVE  (direct adapters OFF)
gateway.relay_url: ...       in config.yaml -> ADDITIVE         (direct adapters ON)
```

Both activate the relay. Only the env form triggers the sweep. Setting the
config-file form while believing you set the env form gives you multiplexing
*with* the collision — the exact failure the stamp exists to prevent. The
opt-out `GATEWAY_RELAY_ALLOW_DIRECT_PLATFORMS=true` deliberately restores the
additive behaviour; do not set it unless you mean it.

Hermes reads three variables (`gateway/relay/__init__.py` ~162):

```
GATEWAY_RELAY_URL      connector BASE url; the gateway normalizes it to ws(s)://…/relay
GATEWAY_RELAY_ID       this gateway's id, the HMAC token payload
GATEWAY_RELAY_SECRET   per-gateway signing secret for the WS upgrade
```

Put them in the profile's `.env`: `hermes_cli/env_loader.py` (~499) loads it
into `os.environ` with `override=True`, so a value there becomes a genuine
process global and reaches every served profile's sweep.

## Verifying the whole thing on a live install

Config loading only — this starts nothing and opens no sockets. Run all three;
the control is what makes the result meaningful.

```bash
cd ~/.hermes/hermes-agent

# The profile that will host the gateway: relay on, telegram swept off.
HERMES_HOME=~/.hermes/profiles/<your-profile> ./venv/bin/python -c "
import sys; sys.path.insert(0,'.')
from hermes_cli.env_loader import load_hermes_dotenv; load_hermes_dotenv()
from gateway.config import load_gateway_config
cfg = load_gateway_config()
print('multiplex =', getattr(cfg,'multiplex_profiles',None))
for p,c in sorted(cfg.platforms.items(), key=lambda kv: kv[0].value):
    print(' ', p.value, c.enabled)
"

# THE COLLISION CASE: default, with the stamp as a process global.
GATEWAY_RELAY_URL=http://127.0.0.1:PORT HERMES_HOME=~/.hermes ./venv/bin/python -c "
import sys; sys.path.insert(0,'.')
from hermes_cli.env_loader import load_hermes_dotenv; load_hermes_dotenv()
from gateway.config import load_gateway_config
tg = [c for p,c in load_gateway_config().platforms.items() if p.value=='telegram'][0]
print('default telegram enabled =', tg.enabled)   # expect False
"

# CONTROL: same thing without the stamp. If this does not print True, your
# default profile has no token and the test proved nothing.
HERMES_HOME=~/.hermes ./venv/bin/python -c "
import os,sys; sys.path.insert(0,'.'); os.environ.pop('GATEWAY_RELAY_URL',None)
from hermes_cli.env_loader import load_hermes_dotenv; load_hermes_dotenv()
from gateway.config import load_gateway_config
tg = [c for p,c in load_gateway_config().platforms.items() if p.value=='telegram'][0]
print('default telegram enabled =', tg.enabled)   # expect True
"
```

There is one thing static loading cannot prove: whether anything constructs a
Telegram client *outside* `config.platforms` and polls regardless of the sweep.
None was found in the adapter-start flow, but the conclusive test is a real
boot watched for a 409. **Do that with the other gateway stopped or its token
rotated — never against a live one.**

## Routing turns to profiles

Under the relay, the connector stamps `source.profile` on each inbound event
and the gateway serves that turn from that profile's `HERMES_HOME`. Two
consequences:

- **`gateway.profile_routes` is unused.** It is a static
  platform/chat_id → profile table, the pre-relay mechanism. The stamp
  supersedes it.
- **The stamp is honoured only when multiplexing is on.**
  `SessionStore._resolve_profile_for_key` (`gateway/session.py` ~1933) returns
  `None` when `multiplex_profiles` is false, collapsing every turn into the
  legacy `agent:main` namespace. So multiplexing is not an optimization here —
  without it, per-trip routing and per-trip session isolation both silently
  do not happen.

A missing or empty stamp falls back to `get_active_profile_name()`, i.e. the
profile the gateway was launched from — **not** to `default`. Worth knowing:
an un-stamped event lands on the host profile, not on someone's personal
assistant.

Profile names also namespace gateway session keys (`agent:<profile>:…`), so
trip selection and session isolation are one decision rather than two that can
drift apart.

**Secondary profiles get no relay adapter of their own** (`gateway/run.py`
~15503): the active profile owns the single connection and inbound turns reach
secondaries by the stamp. This is by design, not a bug to work around.

## Checklist before flipping multiplexing on

1. `default` has no enabled cron jobs.
2. Each profile you are about to allowlist has no stale/unwanted cron jobs.
3. `GATEWAY_RELAY_URL` is in the host profile's `.env`, **not**
   `gateway.relay_url` in config.yaml.
4. `multiplex_profile_allowlist` is set **explicitly** — never left absent.
5. The three verification commands above give on / off / on (control).
6. You know which other gateway currently holds each bot token, and that none
   of them are about to be started twice.

## Repo conventions

`~/.hermes` is not version controlled. If you sharpen this skill while working
inside a profile, capture it back before it is lost:

```bash
scripts/install-hermes-skill.sh hermes-multiplex-relay <profile> --capture
scripts/install-hermes-skill.sh hermes-multiplex-relay <profile>
scripts/install-hermes-skill.sh hermes-multiplex-relay <profile> --check
```

Config comments do **not** survive `hermes config set` — it rewrites the YAML
and strips them. Anything that must persist belongs here, not only in a
config comment.
