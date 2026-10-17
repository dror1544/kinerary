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

## Which Hermes this set applies to

**The set in this tree is rebased onto upstream `4097709b0c` (the v0.21.4 line,
2026-10-03). It does NOT apply to the VM's current snapshot, `ab0d984145`
(2026-08-24).** Upstream restructured the code 0001 and 0002 edit, so a build
from this tree against `/opt/hermes-src` as it stands fails with "does not
apply cleanly" — by design: a patch that lands on the wrong code is worse than
no image. The repo and the VM move together: refresh `/opt/hermes-src` to
`4097709b0c`, bump `HERMES_REV` through `kinerary-cp-release`, and only then
build from this tree. Nothing in this directory does either, and until it is
done a VM image can only be built from a checkout that predates the rebase.

### Test a new Hermes tree before applying anything

Every upstream update can fix a patch (then it is dead weight), move the code
it edits (then it conflicts) or leave it alone. `scripts/hermes-patches.sh`
answers which, without writing to the tree:

```bash
export HERMES_PATCH_PYTHON=<an interpreter that can import Hermes' dependencies and pytest>
scripts/hermes-patches.sh check <hermes-tree>   # classify, test in a copy, change nothing
scripts/hermes-patches.sh apply <hermes-tree>   # check, then write — all or nothing
```

Per patch, in name order, against a scratch copy the earlier patches are
already in: `APPLIES` (forward dry-run clean at `--fuzz=0`), `ALREADY-APPLIED`
(reverse dry-run clean; idempotent, not an error), `SUPERSEDED` (the patch's own
test files, with its source hunks left out, already pass — upstream fixed it;
reported, never applied, exit 1 so a person decides) or `CONFLICT`. Then the
test files the patches add or touch run on the fully patched copy; one failure
refuses. `apply` writes only when every patch is `APPLIES` or `ALREADY-APPLIED`
and the tests pass, and is all-or-nothing: before the first write it copies
every file the patches touch (bytes, mode, and whether it existed) into its temp
directory, and any unsuccessful exit after that — a patch that fails or dies
halfway, a failed final comparison with the tested copy, INT, TERM or HUP —
restores the tree from those copies, deleting what the patches created, before
the temp directory goes. Restoration ignores further signals and stops a still
running `patch` first; if it cannot finish it keeps the temp directory and names
it. It stamps no manifest — that file is the image build's. The interpreter
comes from `HERMES_PATCH_PYTHON` only; unset, the tool refuses (the path is per
machine, and this repo names no machine). Exit codes: 0 ready, 1 not ready,
2 could not start, 128+N when stopped by signal N.
`tests/scripts/test_hermes_patches_tool.py` drives it against a fixture tree:
one test per classification, and for the write phase a stand-in `patch` that
dies halfway and one that blocks mid-write while signals arrive.

The apply logic is not shared with `build-hermes-image.sh`: that script writes a
`.kinerary-patches` manifest into the tree and refuses a tree that already
carries a patch, which is its contract with the image tag and
`hermes-image-check.sh`. The tool uses the same flags and order instead, and a
test holds the two to the same resulting tree.

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

**Where it lives at `4097709b0c`.** Upstream replaced the single-entry shim
with `normalize_tool_call_entries` in `tools/tool_search_validation.py`, which
turns the single `{name, arguments}` shape and the batch `calls[]` shape into
one list of entries. The rebased patch fixes it there, so it covers **both
shapes**: the single shape now hands the whole dict to the per-entry read
instead of rebuilding `{name, arguments}` (which dropped the alias before it
could be read), and each batch entry resolves its own payload key. Before the
rebase the patch edited the resolver in `tools/tool_search.py` and covered the
single shape only; at `ab0d984145` the patch did not touch a batch shape.

Tests: `TestRegression_PayloadKeyAliases` in `tests/tools/test_tool_search.py`
— the alias survives the probe-validator, dispatches end to end, covers
`args`/`input` and JSON-string payloads, keeps `arguments` winning when both
carry content, reads the alias through nine spellings of empty, and resolves a
batch entry's alias and names its key when malformed. At `4097709b0c`, 16 of
them fail on stock Hermes and all pass patched (64 tests in the file; 76 with
0002's file, checked 2026-10-03 by `scripts/hermes-patches.sh check`).

The build script and the image check (`build-hermes-image.sh`,
`hermes-image-check.sh`) are in this tree now, and so is
`0002-relay-media-dir`. The hand-built `kinerary-cp/hermes:ab0d98414-toolcall-alias2`
this patch was first carried in was the practice the script exists to end; the
image running on 2026-09-28 is `ab0d98414-pbf43d580`, built by the script from
0001 and 0002 (regression plan
`docs/test-reports/regression-plan-2026-09-28-saturday-window-monitor-and-hermes-image.md`,
section 5).

## 0002-relay-media-dir

`RelayMediaClient.download` saves a Telegram attachment with
`tempfile.mkstemp`, so it landed in the container's own `/tmp`, where the
host's trip-mcp — which runs outside the container, as the same uid — cannot
open the path it is handed. Nothing failed: a family's file went where the
site could not read it. The patch makes `download` save into
`$HERMES_RELAY_MEDIA_DIR` when that names a directory (`media_dir()`, exported
from the module); unset, or not a directory, it falls back to the default temp
dir with a warning, because a misconfiguration must not drop a family's file.

It is one variable for one purpose on purpose. Pointing `TMPDIR` at that
directory worked and took everything else with it — model CLIs, document
conversion, dependencies — into a host-persistent folder whose janitor removes
only `relay_media_*` (runbook, "Inbound files"). The compose line and the image
move together: an image without this patch ignores the variable silently.

**At `4097709b0c`.** Same file as before, `gateway/relay/media.py`; the module
and its test file were rearranged around the edit (`media_dir()` now follows
`media_base_url`, where it used to precede it), so the patch was regenerated
against it. The behaviour and the variable are
unchanged.

Tests: `tests/gateway/relay/test_relay_media.py` — the file lands in the named
dir, falls back when unset or not a directory, and an unrelated temp file does
not follow the variable. At `4097709b0c` the named-dir test fails on stock and
all 12 pass patched.

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
another apt cache-and-cleanup cycle.

**Which line at `4097709b0c`.** The runtime stage is now named `runtime_base`
(the second `FROM debian:`), and the Dockerfile has three `apt-get install`
lines. The patch edits the first list in `runtime_base` (`Dockerfile:76-78`:
`ca-certificates … docker-cli xz-utils`), appended after `xz-utils`. Not the
`sqlite_build` stage's line (discarded). Not the one under
`if [ "$HERMES_BOT_DESKTOP" = "1" ]` (~line 94): that installs only for the
opt-in desktop variant, which the VM does not build, so `psql` would be missing
from the image that runs. Not the second package list of the same `RUN`
(the Chromium shared libraries): it is the same command, but that list is
documented as exactly the `ldd` set of the pinned browser, and a database
client does not belong in it. The later stages (`python_deps`, `runtime`) are
built `FROM` `runtime_base`, so they inherit the package. Debian 13 (trixie) ships client 17, which
talks to older servers fine.

Like any patch, it changes the patch-set hash and therefore the image tag
(`<base>-p<hash>`), so the running image cannot pass for the new set until it
is rebuilt. Deploying it recreates the `hermes` container, which restarts every
companion gateway: do it when no conversation is live.
`hermes-image-check.sh` now asks the running container (or the named image) for
`psql` after the manifest check and fails, naming this patch, when it is absent.

Tests: `tests/scripts/test_hermes_patches.py` applies the Dockerfile patches at
fuzz 0 to a verbatim copy of the pristine Dockerfile
(`tests/scripts/fixtures/hermes-src/Dockerfile`, now the one at upstream
`4097709b0c`, 2026-10-03; until then the VM's `/opt/hermes-src` copy read on
2026-09-28), asserts `postgresql-client` lands in the
runtime stage and not the `sqlite_build` stage, and drives the image check with
a stand-in `docker` that has and lacks `psql`. The image itself was not built by
this change; the VM builds it.
