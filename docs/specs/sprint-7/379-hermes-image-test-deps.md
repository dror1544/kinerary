# build-hermes-image.sh: install the in-image test dependencies without uv, and fail loudly

Status: draft (2026-10-19) · Issue: #379 · Track: T3 · Size: S · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: no

## Problem

The verify step of `control-plane/deployment/build-hermes-image.sh` runs the
fork's own tests for the patched files inside the built image
(`build-hermes-image.sh:121-137`). It installs the test dependencies with:

```sh
VIRTUAL_ENV=… uv pip install -q pytest pytest-asyncio >/dev/null 2>&1; \
…/python -m pytest $TESTS -q -p no:cacheprovider
```
(`build-hermes-image.sh:133-136`)

Four defects in two lines:

1. **It depends on `uv` inside the image.** The target Hermes image
   (`4097709b0c`, verbatim in `tests/scripts/fixtures/hermes-src/Dockerfile`)
   stages uv only for its own build: "build consumers receive Python
   environments, never an installer executable" (`Dockerfile:181-191`).
2. **It writes into the image's venv**, which the target image builds
   `--sealed` (`Dockerfile:277`) and documents as "never written"
   (`Dockerfile:450-451`). Even with an installer present, that is the wrong
   place.
3. **A failed install is invisible.** Output goes to `/dev/null`, and `;` runs
   pytest regardless. pytest then fails with "No module named pytest" — reported
   as "the patched tests fail in the built image", which is wrong — or passes
   against whatever pytest happened to be in the environment.
4. **Unpinned dependencies.** `pytest` and `pytest-asyncio` resolve to whatever
   the index serves that day, so the same image can verify differently twice.

A fifth, found by the 2026-10-03 Hermes regression plan (notes folder,
`regression-plans/2026-10-03-vm-hermes-upgrade-to-4097709b0c.md`, F3.2): the
base revision defaults to the deployment's current `HERMES_REV`
(`build-hermes-image.sh:106-108`), so a build from a *new* `--source` without
`--base-rev` tags the target Hermes with the old revision's name.

Effect: the build for the target Hermes cannot verify, and can mislabel what it
built, which blocks the #189 rehearsal.

## Behaviour

The verify step installs pinned test dependencies into a throwaway directory
outside the image's venv, with an installer that does not depend on what the
image ships, using the image's own interpreter. It works identically for the
current image (`ab0d984145`) and the target (`4097709b0c`). An install failure
stops the build with its own message, separate from a test failure, and a run
that collects no tests is a failure.

## Acceptance criteria

- AC-1 Given a built image with no `uv` and no `pip` in its venv, when the
  verify step runs, then the test dependencies are installed and the patched
  tests run under the image venv's interpreter.
- AC-2 Given the dependency install fails (network, hash mismatch, wheel
  unavailable for the image's Python), when the verify step runs, then the build
  exits non-zero with `build-hermes-image: test dependencies did not install`
  and the installer's own output, and pytest is never started.
- AC-3 Given the install succeeds and a patched test fails, when the verify step
  runs, then the build exits non-zero with the existing "the patched tests fail
  in the built image" message (unchanged wording) and pytest's output.
- AC-4 Given pytest collects zero tests (exit status 5), when the verify step
  runs, then the build fails; "no tests ran" is never a pass.
- AC-5 Given any image, when the verify step runs, then nothing is written to
  the image's venv: the dependencies live in a directory mounted for the run
  only and discarded with it.
- AC-6 Given the pinned requirements file, when the installer runs, then it
  installs with `--require-hashes`, and the installer itself is checked against
  a pinned sha256 before it is executed.
- AC-7 Given the script's source, then it contains no `uv` invocation and no
  `>/dev/null 2>&1;` on the install path (a static test, so the shape cannot
  creep back).
- AC-8 Given `--source` (or `HERMES_SRC`) names a tree other than the default
  and no `--base-rev` is given, when the build starts, then it refuses before
  building with "pass --base-rev for a non-default source"; the `vm.env`
  fallback applies only to the default source.

## Contracts

- **Changed** `control-plane/deployment/build-hermes-image.sh`, verify section
  only. Two `docker run` steps instead of one:
  1. **install** — the image's venv interpreter runs a pinned pip zipapp
     (`pip.pyz`, version and sha256 constants in the script, fetched to the
     build dir on the host and verified with `sha256sum` before mounting) with
     `install --require-hashes --target /kinerary-testdeps -r <requirements>`,
     into a host temp dir mounted at `/kinerary-testdeps`. One path for both
     images: no "uv if present, else pip" ladder to test twice.
  2. **test** — `PYTHONPATH=/kinerary-testdeps <venv python> -m pytest $TESTS
     -q -p no:cacheprovider`, the tree mounted as today.
  The venv interpreter path stays as it is read today (`build-hermes-image.sh:135`);
  the fixture Dockerfile shows the same path at the target.
- **New** `control-plane/deployment/hermes-test-requirements.txt` — `pytest` and
  `pytest-asyncio` pinned with hashes, for versions with wheels for both images'
  Python versions.
- **Changed** base-revision resolution (AC-8): the `vm.env` fallback only when
  the source is the default.
- Unchanged: the tag format, the manifest check, `--apply-only`, `--set-rev`. The
  existing `.preflight-allow` BACKLOG entry for this file is untouched (this
  spec adds no deployment name).

## Non-goals

- Running Hermes' full test suite in the image (still only the tests the
  patches touch).
- Moving the build off the machine that runs it, or to a registry (Track 2 /
  `docs/future/control-plane-ota-upgrades.md`).
- Making the staging machine's Docker engine able to build the target
  Dockerfile (see #189 spec, risks).

## Security and boundary notes

None of CLAUDE.md's three invariants applies. Supply chain: today's step runs
unpinned code from the index as root in a container that holds the patched
tree; after this, both the installer and the packages are hash-pinned. The
container gets no secrets either way.

## Test plan

Written first, in `tests/scripts/test_hermes_patches.py`, driven through a
stand-in `docker` on `PATH` (the pattern already used at
`test_hermes_patches.py:267-316`) and a fixture patch set that touches a
`tests/` file so the verify step has tests to run:
- `test_verify_installs_into_a_throwaway_target_not_the_venv` (AC-1, AC-5: the
  recorded install argv carries `--target /kinerary-testdeps` and mounts a host
  dir there; no argv writes the venv).
- `test_a_failed_install_stops_before_pytest_with_its_own_message` (AC-2).
- `test_a_failing_patched_test_keeps_the_existing_message` (AC-3).
- `test_no_tests_collected_is_a_failure` (AC-4).
- `test_installer_hash_is_checked_before_it_runs` (AC-6: a tampered `pip.pyz`
  is refused, nothing executed).
- `test_the_script_never_calls_uv_or_discards_install_output` (AC-7).
- `test_a_non_default_source_needs_an_explicit_base_rev` (AC-8; refused before
  the stand-in `docker build` is called).
- `test_the_target_dockerfile_ships_no_installer_to_consumers` — reads the
  fixture Dockerfile and asserts the `--sealed` venv build, recording why this
  change exists so a future Dockerfile refresh re-tests the premise.

Suite: `python3 -m pytest tests/scripts/test_hermes_patches.py`.

Manual: one real build of the target base (needs a modern BuildKit; the #189
rehearsal is where that happens). The patch set in the tree applies only to
the target (`control-plane/deployment/hermes-patches/README.md:17-23`), so a
real build of the current base is not possible from this tree; for it, the
verify step is proven by the stand-in tests plus one run of the install and
test steps (`docker run` only, no build) against the already-built current
image, which keeps the mechanism honest for a rollback rebuild.

## Rollout and regression

Build-time tooling only; no running service changes, nothing reaches a trip.
assessment: not needed (tooling; the image contents are unchanged — the tag is
a hash of the patch set, which this does not touch).

## Open questions

1. The install fetches `pip.pyz` and wheels from the network at build time, as
   today's step already does. Acceptable, or should a wheelhouse be kept in
   `kinerary-deploy` for offline builds?
