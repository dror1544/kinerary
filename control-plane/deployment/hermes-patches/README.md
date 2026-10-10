# Hermes patches

Changes we carry on the Hermes fork the VM runs. They live here because they
live nowhere else: `/opt/hermes-src` on `kinerary-cp` is a history-less
`git archive` of the fork at `HERMES_REV`, and the fork's local commits are on
no remote (`docs/control-plane-vm-deployment.md` → Hermes). A patch that is
only in the image is one rebuild away from gone.

Adding a patch file here is the whole act of carrying it — nothing else needs
editing. `control-plane/deployment/build-hermes-image.sh` globs this directory,
applies every patch in name order onto a **copy** of the snapshot, builds, and
verifies what it built: the manifest is inside the image and the fork's own
tests for the patched files pass against it.

```bash
ssh debian@192.168.0.45
# Build from a tree of the revision that carries the newest patch, WITHOUT --set-rev.
git -C /opt/kinerary fetch
git -C /opt/kinerary worktree add --detach /var/tmp/hermes-build-<rev> <rev>
sudo /var/tmp/hermes-build-<rev>/control-plane/deployment/build-hermes-image.sh   # prints the tag
# Deploy through the release tool: it recreates Hermes last, every companion gateway restarts.
sudo kinerary-cp-release upgrade <rev> --hermes-rev <tag> --dry-run
sudo kinerary-cp-release upgrade <rev> --hermes-rev <tag>
sudo /opt/kinerary/control-plane/deployment/hermes-image-check.sh
```

The release tool never builds the image. `upgrade --hermes-rev <tag>` refuses in
Prepare when `kinerary-cp/hermes:<tag>` is absent (`vm-release.py:1488-1491`),
recreates Hermes after the relay restart (`vm-release.py:1239-1254`) and records
`hermes_from` / `hermes_to`, which is how `rollback` flips the tag back
(`vm-release.py:1523,1530,1590-1597`).

`--set-rev` writes `HERMES_REV` into `vm.env` outside that history
(`build-hermes-image.sh:141-143`). Before an upgrade, the upgrade then sees no
Hermes change and `verify` fails the image check; after a release, a later
`rollback` of it silently reverts Hermes. It is for a VM without the release
tool. The runbook's "Hermes" section
(`docs/control-plane-vm-deployment.md`) has the full reasoning.

Never build from `/opt/kinerary` when its `hermes-patches/` lacks the newest
patch: the script reads the patch set from the checkout it lives in
(`build-hermes-image.sh:26-28`) and the tag is `<base>-p<hash of the patch set>`,
so a build from an older tree re-tags the previous image and destroys the
rollback target.

`/opt/hermes-src` stays pristine: a tree that is already patched is refused,
because the next `git archive` refresh would drop hand edits silently. The tag
is `<base>-p<hash of the patch set>`, so a stale image cannot answer to a newer
patch set's name, and the check reads the manifest back out of whatever is
running — the question the compose file cannot answer.

Do the deploy when no conversation is live: a Hermes recreate is not queued at
Telegram (about 16 s with no companion, an in-flight turn killed), and nothing
guards companion turns — see "What trips notice" in the runbook.

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

"Carries content" parses a JSON string before judging it, because emptiness
has more than one spelling: `"{ }"` and `"{\n}"` are as empty as `"{}"`, and a
first cut of this patch compared the raw string against a literal `"{}"` — so
a runtime that pretty-prints an empty `arguments` beside a populated
`parameters` still lost the call, in exactly the way the patch exists to
prevent. Unparseable is deliberately NOT empty: a mangled payload belongs in
an error naming the key it was sent under, not silently replaced by an alias.

Tests: `TestRegression_PayloadKeyAliases` in `tests/tools/test_tool_search.py`
— the alias survives the probe-validator, dispatches end to end, covers
`args`/`input` and JSON-string payloads, keeps `arguments` winning when both
carry content, and reads the alias through nine spellings of empty. 7 fail on
stock Hermes; the empty-spelling cases fail on the first cut; all pass now.
51 in that file, 105 across the dispatcher suites.

The build script and the image check (`build-hermes-image.sh`,
`hermes-image-check.sh`) are in this tree now, and so is
`0002-relay-media-dir`. The hand-built `kinerary-cp/hermes:ab0d98414-toolcall-alias2`
this patch was first carried in was the practice the script exists to end; the
image running on 2026-09-28 is `ab0d98414-pbf43d580`, built by the script from
0001 and 0002 (regression plan
`docs/test-reports/regression-plan-2026-09-28-saturday-window-monitor-and-hermes-image.md`,
section 5).

## 0003-postgresql-client

The fleet monitor reads the control-plane database through an MCP that shells
out to `psql`, and it runs inside the Hermes container. Stock Hermes ships no
`psql`, so `bootstrap-monitor.sh` refuses on the VM — deliberately, because a
monitor that cannot reach the database reports nothing, which reads exactly
like a healthy fleet. The image is not ours to install into: a package put into
the running container is lost on the next recreate, so the only place it can
live is the image, and the only way to change the image is a patch here.

The patch adds `postgresql-client` to the **runtime** stage's existing
`apt-get install -y --no-install-recommends …` line — not the `sqlite_build`
stage's, which is discarded — and keeps `--no-install-recommends`. It is one
edited line, not a new `RUN` layer, so the image gains the package without
another apt cache-and-cleanup cycle. Debian 13 (trixie) ships client 17, which
talks to older servers fine.

Like any patch, it changes the patch-set hash and therefore the image tag
(`<base>-p<hash>`), so the running image cannot pass for the new set until it
is rebuilt. Deploying it recreates the `hermes` container, which restarts every
companion gateway: do it when no conversation is live.
`hermes-image-check.sh` now asks the running container (or the named image) for
`psql` after the manifest check and fails, naming this patch, when it is absent.

Tests: `tests/scripts/test_hermes_patches.py` applies the Dockerfile patches at
fuzz 0 to a verbatim copy of the pristine Dockerfile
(`tests/scripts/fixtures/hermes-src/Dockerfile`, read from the VM's
`/opt/hermes-src` on 2026-09-28), asserts `postgresql-client` lands in the
runtime stage and not the `sqlite_build` stage, and drives the image check with
a stand-in `docker` that has and lacks `psql`. The image itself was not built by
this change; the VM builds it.
