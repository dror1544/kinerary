-- Which model serves which task, when the super admin says otherwise.
--
-- Every task's model is pinned by the environment (INTERPRET_*, EXTRACT_*, and
-- the per-task EXTRACT_INTAKE_* / EXTRACT_ITINERARY_*). Changing one used to
-- mean editing provisioning.env and restarting the relay, which is the right
-- ceremony for a deployment and the wrong one for comparing two providers on
-- the same documents, or moving extraction off a quota that is running low.
--
-- So a super admin can override a task's binding at runtime, and this is where
-- that decision lives. It is a DECISION, recorded, not a fallback: the runner
-- never picks a different model on its own (see FORBIDDEN_MODELS and the retry
-- policy in model-runner.ts), and nothing here makes it. An override takes
-- effect between calls — a call already running finishes on the model it
-- started with.
--
-- The history is append-only, because "which model read this organizer's
-- documents on the 14th" must be answerable after the setting has moved on.

CREATE TABLE IF NOT EXISTS control_plane.model_task_settings (
  task        text PRIMARY KEY,
  runner      text NOT NULL,
  model       text NOT NULL,
  -- The super admin, as the same subject digest signup approvals are checked
  -- against — never a raw Telegram id.
  changed_by  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT model_task_settings_task_check CHECK (task ~ '^[a-z][a-z_]{1,39}$'),
  CONSTRAINT model_task_settings_runner_check CHECK (runner IN ('claude', 'codex', 'openrouter', 'hermes')),
  CONSTRAINT model_task_settings_model_check CHECK (model <> '' AND length(model) <= 200),
  CONSTRAINT model_task_settings_changed_by_check CHECK (changed_by ~ '^sha256:[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS control_plane.model_task_setting_history (
  id          text PRIMARY KEY,
  task        text NOT NULL,
  -- Both NULL: the override was cleared and the task went back to its
  -- environment binding.
  runner      text,
  model       text,
  changed_by  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT model_task_setting_history_id_is_opaque CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT model_task_setting_history_cleared_shape CHECK ((runner IS NULL) = (model IS NULL)),
  CONSTRAINT model_task_setting_history_changed_by_check CHECK (changed_by ~ '^sha256:[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS model_task_setting_history_task_idx
  ON control_plane.model_task_setting_history (task, changed_at DESC);

CREATE OR REPLACE FUNCTION control_plane.model_task_setting_history_is_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'model_task_setting_history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS model_task_setting_history_append_only ON control_plane.model_task_setting_history;
CREATE TRIGGER model_task_setting_history_append_only
  BEFORE UPDATE OR DELETE ON control_plane.model_task_setting_history
  FOR EACH ROW EXECUTE FUNCTION control_plane.model_task_setting_history_is_append_only();
