# Onboarding provisioning framework

`provisioning/` reconciles an onboarding topology through three injected provider
adapters: a Proxmox LXC, an Nginx Proxy Manager proxy host, and a Cloudflare
Tunnel plus DNS record. It is intentionally separate from the privileged MCP
server: it is an operator-run CLI and does not expose a provisioning API.

## Safety model

- **No credentials or deployment values are committed.** Copy
  `provisioning/.env.example` into a private, untracked environment file or use
  a secret manager. Export it before running the CLI.
- **Topology values are environment references.** Copy
  `provisioning/topology.example.yaml` and retain `${VARIABLE}` references; the
  loader rejects unresolved variables and malformed/empty fields.
- `apply` is a **dry-run by default**. It prints a plan and makes no writes.
  Infrastructure writes occur only with the additional `--execute` flag.
- `plan` and `verify` make read-only provider API calls. `verify` exits nonzero
  if one of the three desired resources is absent.
- No real infrastructure is contacted by the unit test suite.

## Commands

Install the single parser dependency in an isolated environment if it is not
already available:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r provisioning/requirements.txt
```

Then, with values exported in your shell:

```bash
python3 -m provisioning plan --topology /private/kinerary-topology.yaml
python3 -m provisioning apply --topology /private/kinerary-topology.yaml
python3 -m provisioning apply --execute --topology /private/kinerary-topology.yaml \
  --snapshot /private/kinerary-rollback.json
python3 -m provisioning verify --topology /private/kinerary-topology.yaml
```

The implementation does not source `.env` automatically, so secret loading is
an explicit operator/secret-manager decision. Do not pass secrets as topology
arguments or commit the copied files.

## Idempotency and rollback design

Each adapter first looks up its resource by its stable identity (LXC name,
proxy hostname, tunnel name plus DNS hostname). Existing desired resources are
no-ops; the framework deliberately does **not** mutate an existing resource's
configuration, avoiding accidental replacement during onboarding. Changes to an
existing resource need an explicit reviewed migration.

A plan/apply returns a secret-free JSON `RollbackSnapshot`. Every newly-created
resource receives a reverse `delete` entry, ordered in creation order for
operator review. Persist it with `--snapshot` only when the operator has
chosen `--execute`. Automatic rollback is intentionally not performed: partial
failure must be reviewed before deleting a container, proxy route, tunnel, or
DNS record. Adapter `delete` methods exist to enable a separately approved
rollback runner using the journal.

## Tests

```bash
python3 -m unittest discover -s tests/provisioning -v
```

The tests use a fake JSON transport and `unittest.mock`; they validate topology
input, dry-run gating, idempotent planning, rollback journal generation, and
provider request shapes without live credentials or network access.
