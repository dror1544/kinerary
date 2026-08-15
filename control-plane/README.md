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

## Tests

Install API dependencies once, then run the unit/contract suites:

```bash
cd control-plane/api && npm install
cd ../.. && scripts/test-control-plane.sh
```

Exercise fresh and upgrade migrations against the isolated PostgreSQL fixture:

```bash
docker compose -f control-plane/db/compose.test.yml up -d --wait
docker compose -f control-plane/db/compose.test.yml --profile test run --rm migration-tests
docker compose -f control-plane/db/compose.test.yml down
```

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
