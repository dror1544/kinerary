# Trip companion scheduler controls

The Today card's organizer-only **Companion settings** panel reads and controls
real Hermes tasks. It does not create a second scheduler or edit `jobs.json`
itself. The adapter uses Hermes' locked `list_jobs`, `pause_job`, `resume_job`,
and `trigger_job` operations and reads the result back after every change.

One adapter process serves exactly one explicit trip profile and one dedicated
credential. Nothing supplied by the browser selects a profile, path, command,
prompt, delivery address, or upstream URL. Only tasks registered for this UI
can be controlled. Private/system jobs not registered here are not exposed.

## Configure at deployment

Run with the same Hermes installation/venv that runs the trip companion:

```sh
PYTHONPATH=/path/to/hermes-agent \
COMPANION_PROFILE_HOME=/path/to/hermes/profiles/the-trip \
COMPANION_CONTROL_TOKEN_FILE=/private/path/to/trip-control-token \
COMPANION_TASK_REGISTRY=/private/path/to/trip-tasks.json \
/path/to/hermes-agent/venv/bin/python /path/to/kinerary/companion-control/service.py
```

The token must be unique to this trip, at least 32 characters, and stored outside
version control. The default bind is `127.0.0.1:4326`. If the runtime lives in a
container, provide an appropriately isolated network route to the adapter.
Do not publish this service on the Internet or reuse a personal default profile.
Bind/port can be set with `COMPANION_CONTROL_HOST`/`COMPANION_CONTROL_PORT`.

Set **only in the matching trip runtime**:

- `COMPANION_CONTROL_URL`: adapter's reachable origin (no profile suffix).
- `COMPANION_CONTROL_TOKEN`: the matching dedicated credential.

The registry is an explicit list of existing job IDs, product labels, and their
verified audience. Register only trip updates intended for organizer control:

```json
[
  {
    "id": "actual-existing-hermes-job-id",
    "label": { "he": "עדכון בוקר", "en": "Morning briefing" },
    "audience": "group"
  }
]
```

Audience is `website`, `group`, or `private`. Check the job's actual delivery
configuration when registering it, and keep the label/audience in sync if that
configuration changes. Restart the adapter to reload its registry. Do not put
raw prompts, scripts, tokens, chat IDs, or personal details in UI labels.

## Behavior

- Missing integration: the panel says updates are not connected, without fake tasks.
- Unless both the heartbeat and successful-tick marker are recent, the scheduler is reported offline and Run now is disabled.
- Off pauses the actual task, preserving its prompt and schedule; On resumes it.
- Run now queues an enabled task for the next scheduler tick. It does not mean
  the task completed or that a Telegram message was delivered.
- Run now is refused for paused jobs: native Hermes triggering would otherwise
  silently resume them. Enable the task first to make that change explicit.
- Task results, execution logs, prompts, and private message contents never reach
  the browser. This panel does not grant general Hermes configuration access.

No real job is created, run, paused, or resumed by merely deploying the UI.
Deploying the adapter requires selecting the correct trip profile and registry.
The shared conversation and connection metadata are documented below; the
scheduler controls only manage explicitly registered tasks.

## Verification

```sh
PYTHONPATH=/path/to/hermes-agent /path/to/hermes-agent/venv/bin/python companion-control/test_service.py
node --test tests/companion-control.test.js
npm test --prefix trip-web -- src/CompanionTasks.test.tsx
```

The Python test uses a disposable profile, real Hermes cron storage and APIs,
and no running scheduler; it never sends a message or executes a job.

## Website companion card

The Today card now owns the shared website conversation and scheduler controls;
the duplicate status card is removed. Website messages are visible to **all trip
members**, explicitly stated above the input. This is not an organizer-private
channel. The trip database persists questions and replies across restarts.

Runtime routes:
- `GET/POST /api/companion/conversation`: authenticated shared feed / question.
  Server assigns the author, limits text to 2,000 characters and outstanding
  questions to five per member. Saving means pending, not delivered or answered.
  The card displays an offline notice when no agent inbox check occurred in the
  last ten minutes; it never infers bot availability from a saved message.
- `GET /api/agent/companion/inbox`: agent-key-only unanswered questions.
- `POST /api/agent/companion/messages`: agent-key-only replies or group updates.
  Replies reference an existing question; retries return the first saved reply.
- `POST /api/agent/companion/connection`: agent-key-only verified Telegram links
  and optional control-plane-issued binding command with its real expiry.
- `GET /api/companion/connection`: organizer/agent-only unexpired command.
  The shared feed never includes that command. No raw trip config is served.

MCP tools `get_companion_inbox`, `publish_companion_reply`,
`publish_companion_group_update`, and `set_companion_connection` connect the
trip companion to this store. Group updates are mirrored **after confirmed
Telegram delivery**, never from private history. Links open Telegram for the
user to compose/send; opening the card does not send messages.

Activation requires a real assigned trip profile, the updated MCP tool set, a
healthy recurring inbox check, and verified Telegram connection metadata. The
profile SOUL template specifies that workflow. This code does not assign a
profile, mint binding tokens, read Telegram histories, or install a cron job into
an arbitrary existing profile. Until activated, questions remain visibly pending
and absent connections are hidden. Copying the group command rechecks expiry.
