# Hermes patches

Changes we carry on the Hermes fork the VM runs. They live here because they
live nowhere else: `/opt/hermes-src` on `kinerary-cp` is a history-less
`git archive` of the fork at `HERMES_REV`, and the fork's local commits are on
no remote (`docs/control-plane-vm-deployment.md` → Hermes). A patch that is
only in the image is one rebuild away from gone.

Each patch applies from the root of the Hermes source tree:

```bash
ssh debian@192.168.0.45
cd /opt/hermes-src && sudo patch -p1 --dry-run < <patch>   # check first
cd /opt/hermes-src && sudo patch -p1 < <patch>
sudo docker build --build-arg HERMES_GIT_SHA=<rev>-<name> -t kinerary-cp/hermes:<rev>-<name> .
sudo sed -i "s|^HERMES_REV=.*|HERMES_REV=<rev>-<name>|" /opt/kinerary-deploy/vm.env
```

then bring the container up the way the runbook does (both env files). Every
companion gateway restarts with it, so do it when no conversation is live.

Run the fork's own tests before building — the image has no pytest, so install
it into the app venv in a throwaway container:

```bash
sudo docker run --rm --entrypoint sh -v /opt/hermes-src:/src -w /src \
  kinerary-cp/hermes:<rev> -lc \
  "VIRTUAL_ENV=/opt/hermes/.venv uv pip install -q pytest pytest-asyncio; \
   /opt/hermes/.venv/bin/python -m pytest tests/tools/test_tool_search.py -q"
```

## 0001-tool-call-payload-key-aliases

`tool_call`, the shim that invokes a deferred tool once Tool Search has hidden
it, read the payload from `arguments` and only `arguments`. `gpt-5.6-terra`
spells that key `parameters` roughly half the time. Those calls did not fail
loudly: they arrived empty, the probe-validator refused them as missing every
required field and handed back the schema, and the model re-sent the same
spelling on the next batch.

Live on 2026-09-18 a companion asked to rewrite a trip's itinerary issued 93
dispatches — 44 spelled `arguments` and ran, 49 spelled `parameters` and were
discarded. Half the trip never reached the site, and the agent reported the
update as complete. The organizer saw a website that had not changed.

The patch reads the payload from the first of `arguments`, `parameters`,
`args`, `input` that carries content, keeping `arguments` authoritative when
more than one is present, and names the key it actually read in parse errors.
Tests: `TestRegression_PayloadKeyAliases` in `tests/tools/test_tool_search.py`
(7 of them fail on stock, all pass patched; 42 in that file, 96 across the
dispatcher suites).

Deployed as `kinerary-cp/hermes:ab0d98414-toolcall-alias`.
