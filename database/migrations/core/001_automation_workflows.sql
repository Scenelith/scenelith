CREATE TABLE public.automation_workflows (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id text REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('system', 'draft', 'published', 'archived')),
  system_key text,
  system_revision integer,
  draft_version_id text,
  published_version_id text,
  source_package_digest text,
  source_package_metadata_json jsonb,
  created_by text REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX automation_workflows_system_key_idx
  ON public.automation_workflows(workspace_id, system_key)
  WHERE system_key IS NOT NULL;
CREATE INDEX automation_workflows_workspace_updated_idx
  ON public.automation_workflows(workspace_id, updated_at DESC);
CREATE INDEX automation_workflows_project_updated_idx
  ON public.automation_workflows(project_id, updated_at DESC)
  WHERE project_id IS NOT NULL;
ALTER TABLE public.automation_workflows ADD CONSTRAINT automation_workflows_workspace_id_unique UNIQUE (workspace_id, id);

CREATE TABLE public.automation_workflow_versions (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES public.automation_workflows(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
  graph_json jsonb NOT NULL,
  validation_json jsonb NOT NULL,
  created_by text REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  change_note text,
  restored_from_version_id text,
  UNIQUE(workflow_id, version),
  UNIQUE(workflow_id, id)
);

ALTER TABLE public.automation_workflow_versions
  ADD CONSTRAINT automation_workflow_versions_restored_from_fk
  FOREIGN KEY (workflow_id, restored_from_version_id)
  REFERENCES public.automation_workflow_versions(workflow_id, id);

ALTER TABLE public.automation_workflows
  ADD CONSTRAINT automation_workflows_draft_version_fk
  FOREIGN KEY (id, draft_version_id)
  REFERENCES public.automation_workflow_versions(workflow_id, id);
ALTER TABLE public.automation_workflows
  ADD CONSTRAINT automation_workflows_published_version_fk
  FOREIGN KEY (id, published_version_id)
  REFERENCES public.automation_workflow_versions(workflow_id, id);

CREATE INDEX automation_workflow_versions_workflow_idx
  ON public.automation_workflow_versions(workflow_id, version DESC);
CREATE UNIQUE INDEX automation_workflow_versions_one_draft_idx
  ON public.automation_workflow_versions(workflow_id)
  WHERE status = 'draft';
CREATE UNIQUE INDEX automation_workflow_versions_one_published_idx
  ON public.automation_workflow_versions(workflow_id)
  WHERE status = 'published';

CREATE TABLE public.automation_credentials (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('api-key', 'bearer', 'basic', 'header')),
  encrypted_payload text NOT NULL,
  encryption_version integer NOT NULL CHECK (encryption_version > 0),
  fingerprint text NOT NULL,
  created_by text REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_used_at timestamptz,
  UNIQUE(workspace_id, name),
  UNIQUE(workspace_id, id)
);

CREATE TABLE public.automation_workflow_bindings (
  workflow_id text NOT NULL REFERENCES public.automation_workflows(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  slot_key text NOT NULL,
  binding_type text NOT NULL CHECK (binding_type IN ('credential', 'subworkflow')),
  credential_id text,
  target_workflow_id text,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(workflow_id, slot_key),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES public.automation_workflows(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, credential_id) REFERENCES public.automation_credentials(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, target_workflow_id) REFERENCES public.automation_workflows(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (binding_type = 'credential' AND credential_id IS NOT NULL AND target_workflow_id IS NULL)
    OR (binding_type = 'subworkflow' AND credential_id IS NULL AND target_workflow_id IS NOT NULL)
  )
);

CREATE INDEX automation_workflow_bindings_workspace_idx ON public.automation_workflow_bindings(workspace_id, binding_type);

CREATE TABLE public.automation_workflow_triggers (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES public.automation_workflows(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('schedule', 'webhook', 'canvas-event')),
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  name text NOT NULL,
  overlap_policy text NOT NULL DEFAULT 'queue' CHECK (overlap_policy IN ('queue', 'skip', 'cancel-previous')),
  max_concurrent_runs integer NOT NULL DEFAULT 1 CHECK (max_concurrent_runs >= 1 AND max_concurrent_runs <= 32),
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  webhook_token_hash text,
  next_fire_at timestamptz,
  last_fired_at timestamptz,
  locked_at timestamptz,
  worker_id text,
  created_by text REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES public.automation_workflows(workspace_id, id) ON DELETE CASCADE,
  CHECK ((type = 'webhook' AND webhook_token_hash IS NOT NULL) OR (type <> 'webhook' AND webhook_token_hash IS NULL))
);

CREATE INDEX automation_workflow_triggers_due_idx ON public.automation_workflow_triggers(status, next_fire_at) WHERE type = 'schedule';
CREATE INDEX automation_workflow_triggers_project_idx ON public.automation_workflow_triggers(project_id, status);

CREATE TABLE public.automation_product_event_outbox (
  id text PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES public.users(id) ON DELETE SET NULL,
  event_name text NOT NULL CHECK (event_name IN ('tiktok.imported', 'generation.completed')),
  event_version integer NOT NULL CHECK (event_version > 0),
  payload_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'retry_wait', 'delivered', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  worker_id text,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  delivered_at timestamptz
);

CREATE INDEX automation_product_event_outbox_queue_idx
  ON public.automation_product_event_outbox(status, available_at, created_at);
CREATE INDEX automation_product_event_outbox_project_idx
  ON public.automation_product_event_outbox(project_id, created_at DESC);

CREATE TABLE public.automation_runs (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES public.automation_workflows(id) ON DELETE RESTRICT,
  workflow_version_id text NOT NULL,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'completed_with_warnings', 'failed', 'cancelled')),
  run_kind text NOT NULL DEFAULT 'production' CHECK (run_kind IN ('production', 'test', 'replay', 'trigger', 'subworkflow', 'node-preview')),
  admission_key text NOT NULL,
  overlap_policy text NOT NULL DEFAULT 'queue' CHECK (overlap_policy IN ('queue', 'skip', 'cancel-previous')),
  max_concurrent_runs integer NOT NULL DEFAULT 1 CHECK (max_concurrent_runs >= 1 AND max_concurrent_runs <= 32),
  trigger_id text REFERENCES public.automation_workflow_triggers(id) ON DELETE SET NULL,
  trigger_delivery_id text,
  preview_node_id text,
  fixture_id text,
  parent_run_id text REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  parent_node_id text,
  root_run_id text REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  replay_of_run_id text REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  item_index integer CHECK (item_index IS NULL OR item_index >= 0),
  execution_depth integer NOT NULL DEFAULT 0 CHECK (execution_depth >= 0 AND execution_depth <= 16),
  stage_label text NOT NULL DEFAULT '',
  progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb,
  error text,
  error_code text,
  estimated_credits integer NOT NULL DEFAULT 0 CHECK (estimated_credits >= 0),
  charged_credits integer NOT NULL DEFAULT 0 CHECK (charged_credits >= 0),
  reserved_credits integer NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  reused_node_count integer NOT NULL DEFAULT 0 CHECK (reused_node_count >= 0),
  tree_node_executions integer NOT NULL DEFAULT 0 CHECK (tree_node_executions >= 0),
  tree_generated_assets integer NOT NULL DEFAULT 0 CHECK (tree_generated_assets >= 0),
  policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  deployment_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger_payload_json jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  worker_id text,
  dedupe_key text,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  deadline_at timestamptz,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT automation_runs_workflow_version_fk
    FOREIGN KEY (workflow_id, workflow_version_id)
    REFERENCES public.automation_workflow_versions(workflow_id, id) ON DELETE RESTRICT
);

CREATE INDEX automation_runs_queue_idx ON public.automation_runs(status, available_at, created_at);
CREATE INDEX automation_runs_user_created_idx ON public.automation_runs(user_id, created_at DESC);
CREATE INDEX automation_runs_project_created_idx ON public.automation_runs(project_id, created_at DESC);
CREATE INDEX automation_runs_workflow_created_idx ON public.automation_runs(workflow_id, created_at DESC);
CREATE INDEX automation_runs_admission_active_idx ON public.automation_runs(admission_key, status, created_at)
  WHERE parent_run_id IS NULL AND status IN ('queued', 'running');
CREATE INDEX automation_runs_workspace_active_idx ON public.automation_runs(workspace_id, status, created_at)
  WHERE parent_run_id IS NULL AND status = 'running';
CREATE INDEX automation_runs_parent_idx ON public.automation_runs(parent_run_id, item_index) WHERE parent_run_id IS NOT NULL;
CREATE INDEX automation_runs_root_idx ON public.automation_runs(root_run_id, created_at) WHERE root_run_id IS NOT NULL;
CREATE UNIQUE INDEX automation_runs_active_dedupe_idx
  ON public.automation_runs(user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
CREATE UNIQUE INDEX automation_runs_trigger_delivery_idx
  ON public.automation_runs(trigger_delivery_id) WHERE trigger_delivery_id IS NOT NULL;

CREATE TABLE public.automation_trigger_deliveries (
  id text PRIMARY KEY,
  delivery_key text NOT NULL UNIQUE,
  trigger_id text REFERENCES public.automation_workflow_triggers(id) ON DELETE SET NULL,
  workflow_id text NOT NULL REFERENCES public.automation_workflows(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES public.users(id) ON DELETE SET NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('schedule', 'webhook', 'canvas-event')),
  trigger_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'retry_wait', 'delivered', 'dead_letter', 'cancelled')),
  runtime_inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_for timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  worker_id text,
  run_id text REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  replay_of_delivery_id text REFERENCES public.automation_trigger_deliveries(id) ON DELETE SET NULL,
  error_code text,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  delivered_at timestamptz,
  dead_lettered_at timestamptz
);

CREATE INDEX automation_trigger_deliveries_queue_idx
  ON public.automation_trigger_deliveries(status, available_at, created_at);
CREATE INDEX automation_trigger_deliveries_workflow_idx
  ON public.automation_trigger_deliveries(workflow_id, created_at DESC);
CREATE INDEX automation_trigger_deliveries_trigger_idx
  ON public.automation_trigger_deliveries(trigger_id, created_at DESC) WHERE trigger_id IS NOT NULL;

ALTER TABLE public.automation_runs
  ADD CONSTRAINT automation_runs_trigger_delivery_fk
  FOREIGN KEY (trigger_delivery_id) REFERENCES public.automation_trigger_deliveries(id) ON DELETE SET NULL;

CREATE TABLE public.automation_trigger_alerts (
  id text PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE REFERENCES public.automation_trigger_deliveries(id) ON DELETE CASCADE,
  trigger_id text REFERENCES public.automation_workflow_triggers(id) ON DELETE SET NULL,
  workflow_id text NOT NULL REFERENCES public.automation_workflows(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  code text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE INDEX automation_trigger_alerts_open_idx
  ON public.automation_trigger_alerts(workspace_id, created_at DESC) WHERE status = 'open';

CREATE TABLE public.automation_notification_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  alert_id text REFERENCES public.automation_trigger_alerts(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('trigger-delivery-failed', 'trigger-delivery-recovered')),
  payload_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'retry_wait', 'delivered', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  worker_id text,
  channel text,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  delivered_at timestamptz
);

CREATE INDEX automation_notification_outbox_queue_idx
  ON public.automation_notification_outbox(status, available_at, created_at);
CREATE INDEX automation_notification_outbox_workspace_idx
  ON public.automation_notification_outbox(workspace_id, created_at DESC);

CREATE TABLE public.automation_workflow_fixtures (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES public.automation_workflows(id) ON DELETE CASCADE,
  workflow_version_id text NOT NULL,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  runtime_inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  node_inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_run_id text REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  created_by text REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT automation_workflow_fixtures_version_fk
    FOREIGN KEY (workflow_id, workflow_version_id)
    REFERENCES public.automation_workflow_versions(workflow_id, id) ON DELETE RESTRICT
);

CREATE INDEX automation_workflow_fixtures_workflow_idx
  ON public.automation_workflow_fixtures(workflow_id, updated_at DESC);

ALTER TABLE public.automation_runs
  ADD CONSTRAINT automation_runs_fixture_fk
  FOREIGN KEY (fixture_id) REFERENCES public.automation_workflow_fixtures(id) ON DELETE SET NULL;

CREATE TABLE public.automation_run_budget_reservations (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  requested_credits integer NOT NULL CHECK (requested_credits >= 0),
  actual_credits integer CHECK (actual_credits IS NULL OR actual_credits >= 0),
  status text NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX automation_run_budget_reservations_run_idx ON public.automation_run_budget_reservations(run_id, status);

CREATE TABLE public.automation_tree_usage_reservations (
  run_id text NOT NULL REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  root_run_id text NOT NULL REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('asset')),
  usage_key text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, kind, usage_key)
);

CREATE INDEX automation_tree_usage_reservations_root_idx
  ON public.automation_tree_usage_reservations(root_run_id, kind);

CREATE TABLE public.automation_node_runs (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  node_type text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
  input_json jsonb,
  output_json jsonb,
  error text,
  error_code text,
  output_ports_json jsonb,
  reused_from_node_run_id text REFERENCES public.automation_node_runs(id) ON DELETE SET NULL,
  charged_credits integer NOT NULL DEFAULT 0 CHECK (charged_credits >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(run_id, node_id, attempt)
);

CREATE INDEX automation_node_runs_run_idx ON public.automation_node_runs(run_id, created_at);

CREATE TABLE public.automation_run_events (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  node_run_id text REFERENCES public.automation_node_runs(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX automation_run_events_run_idx ON public.automation_run_events(run_id, id);

CREATE TABLE public.automation_artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  node_run_id text REFERENCES public.automation_node_runs(id) ON DELETE SET NULL,
  node_id text NOT NULL,
  item_key text NOT NULL,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  asset_id text REFERENCES public.assets(id) ON DELETE SET NULL,
  value_json jsonb,
  source_artifact_id text REFERENCES public.automation_artifacts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX automation_artifacts_run_idx ON public.automation_artifacts(run_id, created_at);
CREATE UNIQUE INDEX automation_artifacts_run_node_item_idx ON public.automation_artifacts(run_id, node_id, item_key);
