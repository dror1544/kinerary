# Control-plane runbook — failed provisioning, stale lease, cleanup, upgrade, rollback

Sprint 6's build list calls for this runbook and never got one — the six
topics below exist scattered across code comments, `CLAUDE.md` and other
docs; this is the single page that names which one to read for which
symptom. Each section says only what is not already written better
elsewhere, and points at the real thing instead of duplicating it.

## Failed provisioning

Start from the evidence, not the guess:

```sql
SELECT check_name, outcome, observed_at
FROM control_plane.verification_evidence
WHERE trip_id = '<trip_id>'
ORDER BY observed_at DESC;
```

Six rows per attempt (`release_compatibility`, `runtime_health`,
`rendered_data`, `mcp_isolation`, `messaging_binding`, `backup_checkpoint`).
The first three are hard-gated — any `failed` among them is why
`ready_private` was refused; the job's own traceback
(`docker logs <worker container>`, or the VM's worker log) ends in
`VerificationFailed: verification gate failed: <which ones>`.

**`runtime_health` and/or `rendered_data` failing on a site that looks fine
by hand is not necessarily a slow site.** `deploy.sh`'s own health check
reaches the container by a more direct path (SSH/localhost) than the
verification gate's HTTP probe, which goes through the real
Cloudflare → NPM → LXC chain — so the gate can fail even though `deploy()`
already returned successfully. Two distinct causes produce the identical
symptom, and telling them apart matters:

- **Genuine propagation lag** (a brand-new DNS record or cert). The gate
  retries (`VERIFICATION_RETRY_ATTEMPTS = 6`, `VERIFICATION_RETRY_DELAY_S =
  10.0` in `provisioner.py`, added 2026-10-03 after this exact failure) —
  about a minute of grace before it gives up. If it still fails after that,
  move to the next cause.
- **A blocked request, not a slow one.** Found live on 2026-10-03: the
  check's HTTP client sent no `User-Agent`, and Cloudflare's Browser
  Integrity Check rejects Python's default one outright (`error code: 1010`
  in the response body) on every attempt, with no improvement no matter how
  long it waits — that is the tell. Confirm by hand against any
  Cloudflare-proxied trip hostname:
  ```
  curl -s https://<any-trip-hostname>/api/health   # a bare request
  ```
  A `1010` body means the WAF, not the trip. `default_http_get` in
  `verification.py` now sends a real `User-Agent`, which is what fixed this
  instance — but the same signature (identical failure, repeated, no decay
  over multiple job attempts spanning minutes) means "something between the
  check and the site," not "give it longer."

## Stale worker lease

A worker claims a job with a 900-second lease (`provisioner.py`'s
`LEASE_SECONDS`) and renews it on a heartbeat while it runs. If the worker
process dies mid-job, the lease simply stops being renewed.

**Recovery is automatic**, not a manual step: `job-queue.ts`'s
`recoverStaleLeases` runs on its own timer in the API process
(`server.ts`, every 2 minutes, unconditional) and re-queues any job whose
lease has expired — up to `max_attempts`, after which the job moves to
`failed` with `safe_error_code = 'LEASE_EXHAUSTED'` and its approval is
consumed (the organizer would need to re-approve, same as any other
exhausted retry). **This was not true before 2026-10-04**: the function
existed, was unit-tested, and both its own comments and `provisioner.py`'s
called it "the real safety net" — but nothing outside a test ever called
it, so a dead worker's job stayed `leased` forever. Confirm it is running
on a given deployment: `job_queue.stale_leases_recovered` (only logged when
it actually finds one) or its absence under `job_queue.stale_lease_*` in
the API's stderr. To see a job currently stuck in `leased`, `/v1/admin/jobs`
(the super-admin dashboard) shows its state and lease expiry directly.

## Failed activation

Not built, and not a gap to fill under this heading — the whole activation
design (`activation_approved`/`active`) is superseded pending scoping
(`docs/onboarding-mvp-sprint-plan.md`, "Activation is superseded pending
scoping," 2026-09-05). There is no activation runbook because there is no
activation to run.

## Cleanup

`scripts/teardown-trip.py` — read its own module docstring first; it is
the order a real failure found necessary (backup, then allowlist-before-
profile-delete specifically, then infra, then database, then deploy dir,
then profile), not an arbitrary list. `CLAUDE.md`'s "Tearing down a test
trip" section has the day-to-day commands. Nothing here duplicates it.

## Upgrade rehearsal and rollback

`kinerary-cp-release upgrade|rollback`, always `--dry-run` first — full
runbook in `docs/control-plane-vm-deployment.md`, "Upgrades and rollback."
Not duplicated here. The one rule worth repeating because getting it wrong
is silent and destructive: every migration must start with
`-- rollback: compatible|breaking — <why>`; a missing header reads as
`breaking` and a rollback then **discards the database** instead of keeping
it (`docs/migrations.md`).
