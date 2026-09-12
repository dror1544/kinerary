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
The group-message feed, binding-command retrieval, and website conversations
are separate integrations; these scheduler controls do not claim to implement them.

## Verification

```sh
PYTHONPATH=/path/to/hermes-agent /path/to/hermes-agent/venv/bin/python companion-control/test_service.py
node --test tests/companion-control.test.js
npm test --prefix trip-web -- src/CompanionTasks.test.tsx
```

The Python test uses a disposable profile, real Hermes cron storage and APIs,
and no running scheduler; it never sends a message or executes a job.
