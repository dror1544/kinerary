# Kinerary control plane — Sprint 0

This directory establishes the portable control-plane boundary described by
PR 10. It does not provision, activate, expose provider actions, or deploy a
live trip.

## Repository shape

- `contracts/v1/`: closed JSON Schema contracts for canonical records and the
  provider-neutral adapter request/result envelope.
- `api/`: TypeScript/Fastify public API skeleton, architecture validation,
  lifecycle guards, safe operational logs, fake adapters and a transactional
  migration runner. PostgreSQL constraints are the authoritative canonical
  JSON write guard in this stage.
- `worker/`: private Python queue worker skeleton. It has no public HTTP action
  listener; its operator CLI provides read-only Proxmox inventory and dry-run
  test cleanup only.
- `db/`: PostgreSQL registry migrations and an isolated local test database.
- `deployment/`: a boundary example where only the API joins ingress; the
  worker and PostgreSQL remain on an internal network.

Architecture-specific values and credentials come from an external profile
and opaque secret references. `config/architecture.example.json` contains
only test adapter names and validation-safe references.

## Secret references

The profile never holds a credential, only a reference to one. Three schemes
are accepted, all resolved by `api/src/secrets.ts`:

| Reference | Resolves to |
|---|---|
| `env://NAME` | the `NAME` environment variable |
| `file:///run/secrets/thing` | the file's contents, trimmed |
| `vault://secret/data/kinerary/telegram#bot_token` | the `bot_token` field of that Vault KV secret |

A `vault://` reference must name its field with `#`, because a KV secret holds
several pairs and a bare path would not say which one it means. Both KV v1 and
KV v2 mounts work — the path is the Vault API path, so `secret/data/...` is v2
while a v1 mount is addressed directly.

Vault access comes from the environment, not from the profile, so the profile
stays free of environment-specific addressing:

```bash
export VAULT_ADDR=https://vault.internal:8200
export VAULT_TOKEN=...          # or VAULT_TOKEN_FILE=/run/secrets/vault_token
```

`VAULT_ADDR` must be `https://`. Plain `http://` is refused unless the host is
loopback, since the Vault token unlocks every other secret and must not cross a
network in cleartext. Nothing is read from the environment unless a `vault://`
reference is actually resolved, so an installation using only `env://` and
`file://` needs no Vault at all.

### Who resolves what

The TypeScript entrypoints — the API (`src/server.ts`) and the migration job
(`src/migrate.ts`) — resolve every reference in the profile they are given,
including `database.connection_secret_ref`. Both are handed the same profile so
they cannot end up pointed at different databases.

The Python worker is the exception. It takes `CONTROL_PLANE_DATABASE_URL_FILE`,
a plain path with no scheme, and has no resolver of its own — so a deployment
whose database reference is `env://` or `vault://` must still supply that file
to the worker separately. Only `file://` is consistent across all three
processes today; giving the worker a resolver twin is tracked in PR #10.

## Tests

Install API dependencies once, then run the unit/contract suites:

```bash
cd control-plane/api && npm install
cd ../.. && scripts/test-control-plane.sh
```

Exercise fresh and upgrade migrations against the isolated PostgreSQL fixture,
and the `vault://` resolver against a dev-mode Vault:

```bash
docker compose -f control-plane/db/compose.test.yml up -d --wait
docker compose -f control-plane/db/compose.test.yml --profile test run --rm migration-tests
CONTROL_PLANE_TEST_VAULT_ADDR=http://127.0.0.1:8200 npm --prefix control-plane/api test
docker compose -f control-plane/db/compose.test.yml down
```

The Vault fixture is dev-mode with a fixed root token and in-memory storage —
only ever a test fixture. Without `CONTROL_PLANE_TEST_VAULT_ADDR` those tests
skip and the rest of the suite is unaffected.

The database constraint suite rejects raw secrets, host paths, private IPs and
unlabelled test resources. A controlled failure is stored as a failed job with
a safe error code and no resource row.

## Read-only safety commands

Proxmox inventory uses only `GET` and prints an allowlisted view. Credentials
remain in the environment:

```bash
PYTHONPATH=control-plane/worker python3 -m control_plane_worker inventory --node TEST_NODE
```

Cleanup is selection-only in Sprint 0 and requires an exact test-run label:

```bash
PYTHONPATH=control-plane/worker python3 -m control_plane_worker cleanup \
  --inventory /private/test-inventory.json \
  --architecture-profile control-plane/config/architecture.example.json \
  --test-run-id tr_example123 --dry-run
```

No execute/delete option exists in this stage.

## Reviewable local runtime

The local stack runs PostgreSQL with persistent storage, a one-shot migration
container, the database-aware API and a private queue-observer worker. Only the
API is published, on loopback by default; PostgreSQL and the worker have no
host port.

The `run` command deliberately does not instantiate the executable `Worker`
class in Sprint 0. That class is contract-test scaffolding for the later
durable claim/execute sprint; the deployed worker only observes queue and
migration health and has no provider-mutation path.

```bash
control-plane/deployment/prepare-local.sh
docker compose -f control-plane/deployment/compose.local.yml up -d --build --wait
curl http://127.0.0.1:4310/
curl http://127.0.0.1:4310/readyz
```

Stop the services without deleting PostgreSQL data:

```bash
docker compose -f control-plane/deployment/compose.local.yml down
```

Deleting the named volume is a separate destructive operation and is never
performed by the setup or test scripts.

## Release catalog (operator CLI)

A release is the trip-runtime source (`site/` + `server/` + `shared/`) frozen at
a git revision, rendered into a sealed manifest — the exact file list with git's
per-file content hash, a sanitation scan report, and the schema-compatibility
range. `generatePlan` only ever selects a release whose status is `available`.

LAN-only, like `mcp/provision.js` — building and promoting a release is a
deliberate local command, not an HTTP route. Run from `control-plane/api/`:

```bash
npm run release -- build                       # freeze HEAD -> a 'candidate' row + releases/<id>.json
npm run release -- promote <id> --to verified  # re-verifies the seal + requires a clean scan
npm run release -- promote <id> --to available # enters the planner-selectable pool
npm run release -- list                        # every release and its status
npm run release -- show <id>
```

`build` is idempotent on the artifact digest and exits non-zero when the scan
finds anything, while still recording the candidate so the failure is visible.
A `candidate` cannot skip straight to `available`. DB URL comes from
`CONTROL_PLANE_DATABASE_URL` / `..._FILE` / `CONTROL_PLANE_TEST_DATABASE_URL`
or `--database-url`.

At provision time the worker checks out `site/ server/ shared/` at the selected
release's `source_revision` into a throwaway dir, re-verifies the tree against
its `artifact_digest`, and deploys from there — so a release scanned and
promoted for one commit can never ship a later, unscanned one. The hand-seeded
`release_localdev0001` (no manifest) is the exception: it deploys the ambient
checkout with a `provisioner.release_unverified` warning until a real
`npm run release -- build` replaces it.
