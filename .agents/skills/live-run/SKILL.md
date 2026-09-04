---
name: live-run
description: Drive the live signup→interview→plan→provision acceptance run described in docs/setup-test-plan.md — executes the API-call steps, pauses at every step that genuinely needs a person, and is resumable. Also runs the post-deploy smoke check on its own. Use when asked to do a live run, an acceptance test, a signup test, or to check a freshly provisioned site is actually up.
---

`docs/setup-test-plan.md` legends every step of the live run: 🤖 AI (a
stand-in for a UI that does not exist yet), 🏭 PRODUCTION (a loop already
running that we only wait on), and 🧍 HUMAN. The 🤖 steps are plain API calls
against `control-plane/api`, and re-typing them by hand each run is where the
time goes. [driver.mjs](driver.mjs) runs them in order, checks each response,
waits on the 🏭 loops, and stops at every 🧍 with instructions.

It does **not** deploy, and it does **not** tear anything down. Step 14
(destroying a real container, NPM host and DNS record) stays manual on purpose.

## Running one

```bash
export KINERARY_TEST_PASSWORD='…'          # never persisted to disk
D=.agents/skills/live-run/driver.mjs

node $D --run run3 --email you@example.com --trip "Test Trip" \
        --api http://127.0.0.1:8080        # steps 4 → pause at 6
node $D --run run3 --from 7                # after tapping Approve
node $D --run run3 --from 9                # after finishing the interview
node $D --run run3 --status                # where this run stands
node $D --run run3 --smoke                 # reachability only
```

State lives in `.live-runs/<name>.json` (gitignored) so the pauses do not lose
the run. The password is never written there — pass it per invocation or via
`KINERARY_TEST_PASSWORD`.

Add `--with-correction` to exercise step 13, the intake-correction path.

## What the driver expects

| Step | What happens |
|---|---|
| 4 | `POST /v1/signup` with `{password:{email,password}, trip_name_request}` |
| 6 | 🧍 tap Approve in the Telegram DM |
| 7 | poll `GET /v1/signup/status` until it leaves `pending` |
| 8 | 🧍 hold the interview through to CONFIRM |
| 9 | `POST /v1/trips/:id/plan`, then `POST /v1/plans/:planId/approve` |
| 10 | poll `GET /v1/trips/:id` while the worker provisions |
| 12 | smoke-check the provisioned site |
| 13 | `POST /v1/trips/:id/intake/correct` (opt-in) |

Auth is the `x-portal-password-login` header carrying base64url JSON — see
`resolveWebAuth()` in `control-plane/api/src/password-identity.ts`, not a
bearer token.

## Before a run

The stack has to be up and the worker configured with real credentials — see
`docs/setup-test-plan.md` setup steps 1–3, which the driver does not do.
`scripts/preflight-deploy.sh` proves the build is deployable first.

## After a run

Two things, in order:

1. Take your notes — messy is fine, that is the point — to the **run-capture**
   agent. It produces triaged Status-ledger rows routed to the sprint that owns
   each one.
2. The driver's approving of a plan is a real decision, and every issue it
   surfaces is only "fixed / rejected / ignored" once **you** say so. Neither
   the driver nor run-capture may record that approval.
