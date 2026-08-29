ALTER TABLE public.automation_workflow_triggers
  ADD COLUMN active_version_id text;

UPDATE public.automation_workflow_triggers trigger
SET active_version_id = workflow.published_version_id
FROM public.automation_workflows workflow
WHERE trigger.workflow_id = workflow.id
  AND trigger.status = 'active'
  AND workflow.published_version_id IS NOT NULL;

UPDATE public.automation_workflow_triggers
SET status = 'paused', next_fire_at = NULL
WHERE status = 'active' AND active_version_id IS NULL;

UPDATE public.automation_workflow_triggers
SET config_json = jsonb_build_object(
  'mode', 'interval',
  'everyMinutes', (config_json ->> 'everyMinutes')::integer,
  'misfirePolicy', COALESCE(config_json ->> 'misfirePolicy', 'catch-up-once')
)
WHERE type = 'schedule'
  AND config_json ? 'everyMinutes'
  AND NOT config_json ? 'mode';

UPDATE public.automation_workflow_triggers
SET config_json = config_json || '{"version":1}'::jsonb
WHERE type = 'canvas-event' AND NOT config_json ? 'version';

ALTER TABLE public.automation_workflow_triggers
  ADD CONSTRAINT automation_workflow_triggers_active_version_fk
  FOREIGN KEY (workflow_id, active_version_id)
  REFERENCES public.automation_workflow_versions(workflow_id, id) ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE public.automation_workflow_triggers
  ADD CONSTRAINT automation_workflow_triggers_active_version_required
  CHECK (status = 'paused' OR active_version_id IS NOT NULL) NOT VALID;

ALTER TABLE public.automation_workflow_triggers
  VALIDATE CONSTRAINT automation_workflow_triggers_active_version_fk;

ALTER TABLE public.automation_workflow_triggers
  VALIDATE CONSTRAINT automation_workflow_triggers_active_version_required;

ALTER TABLE public.automation_trigger_deliveries
  ADD COLUMN workflow_version_id text,
  ADD COLUMN trigger_key text,
  ADD COLUMN overlap_policy text NOT NULL DEFAULT 'queue',
  ADD COLUMN max_concurrent_runs integer NOT NULL DEFAULT 1,
  ADD COLUMN deployment_json jsonb NOT NULL DEFAULT '{"version":1,"workflows":{}}'::jsonb;

UPDATE public.automation_trigger_deliveries delivery
SET workflow_version_id = COALESCE(
  (SELECT run.workflow_version_id FROM public.automation_runs run WHERE run.trigger_delivery_id = delivery.id LIMIT 1),
  (SELECT trigger.active_version_id FROM public.automation_workflow_triggers trigger WHERE trigger.id = delivery.trigger_id),
  (SELECT workflow.published_version_id FROM public.automation_workflows workflow WHERE workflow.id = delivery.workflow_id),
  (SELECT version.id FROM public.automation_workflow_versions version WHERE version.workflow_id = delivery.workflow_id ORDER BY version.version DESC LIMIT 1)
),
trigger_key = COALESCE(delivery.trigger_id, NULLIF(split_part(delivery.delivery_key, ':', 1), ''), 'delivery:' || delivery.id),
overlap_policy = COALESCE(
  (SELECT run.overlap_policy FROM public.automation_runs run WHERE run.trigger_delivery_id = delivery.id LIMIT 1),
  (SELECT trigger.overlap_policy FROM public.automation_workflow_triggers trigger WHERE trigger.id = delivery.trigger_id),
  delivery.overlap_policy
),
max_concurrent_runs = COALESCE(
  (SELECT run.max_concurrent_runs FROM public.automation_runs run WHERE run.trigger_delivery_id = delivery.id LIMIT 1),
  (SELECT trigger.max_concurrent_runs FROM public.automation_workflow_triggers trigger WHERE trigger.id = delivery.trigger_id),
  delivery.max_concurrent_runs
),
deployment_json = COALESCE(
  (SELECT run.deployment_json FROM public.automation_runs run WHERE run.trigger_delivery_id = delivery.id LIMIT 1),
  delivery.deployment_json
);

ALTER TABLE public.automation_trigger_deliveries
  ADD CONSTRAINT automation_trigger_deliveries_workflow_version_fk
  FOREIGN KEY (workflow_id, workflow_version_id)
  REFERENCES public.automation_workflow_versions(workflow_id, id) ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE public.automation_trigger_deliveries
  ADD CONSTRAINT automation_trigger_deliveries_workflow_version_required
  CHECK (workflow_version_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT automation_trigger_deliveries_trigger_key_required
  CHECK (trigger_key IS NOT NULL AND length(trigger_key) > 0) NOT VALID,
  ADD CONSTRAINT automation_trigger_deliveries_overlap_policy_check
  CHECK (overlap_policy IN ('queue', 'skip', 'cancel-previous')) NOT VALID,
  ADD CONSTRAINT automation_trigger_deliveries_max_concurrent_runs_check
  CHECK (max_concurrent_runs >= 1 AND max_concurrent_runs <= 32) NOT VALID;

ALTER TABLE public.automation_trigger_deliveries
  VALIDATE CONSTRAINT automation_trigger_deliveries_workflow_version_fk;

ALTER TABLE public.automation_trigger_deliveries
  VALIDATE CONSTRAINT automation_trigger_deliveries_workflow_version_required;

ALTER TABLE public.automation_trigger_deliveries
  VALIDATE CONSTRAINT automation_trigger_deliveries_trigger_key_required;

ALTER TABLE public.automation_trigger_deliveries
  VALIDATE CONSTRAINT automation_trigger_deliveries_overlap_policy_check;

ALTER TABLE public.automation_trigger_deliveries
  VALIDATE CONSTRAINT automation_trigger_deliveries_max_concurrent_runs_check;

CREATE INDEX automation_trigger_deliveries_version_idx
  ON public.automation_trigger_deliveries(workflow_id, workflow_version_id, created_at DESC);

UPDATE public.automation_trigger_deliveries
SET payload_json = CASE trigger_type
  WHEN 'webhook' THEN jsonb_build_object(
    'contractVersion', 1,
    'type', 'webhook',
    'payload', COALESCE(payload_json -> 'trigger.payload', payload_json)
  )
  WHEN 'schedule' THEN jsonb_build_object(
    'contractVersion', 1,
    'type', 'schedule',
    'payload', jsonb_build_object('scheduledAt', COALESCE(payload_json -> 'trigger.scheduledAt', to_jsonb(scheduled_for)))
  )
  WHEN 'canvas-event' THEN jsonb_build_object(
    'contractVersion', 1,
    'type', 'canvas-event',
    'event', COALESCE(payload_json -> 'trigger.event', '"unknown"'::jsonb),
    'eventVersion', COALESCE(payload_json -> 'trigger.eventVersion', '1'::jsonb),
    'payload', COALESCE(payload_json -> 'trigger.payload', '{}'::jsonb)
  )
END
WHERE NOT (payload_json ? 'contractVersion' AND payload_json ? 'type' AND payload_json ? 'payload');

UPDATE public.automation_runs run
SET trigger_payload_json = delivery.payload_json
FROM public.automation_trigger_deliveries delivery
WHERE run.trigger_delivery_id = delivery.id
  AND run.trigger_payload_json IS NOT NULL;

UPDATE public.automation_runs
SET trigger_payload_json = jsonb_build_object(
  'contractVersion', 1,
  'type', 'subworkflow',
  'payload', trigger_payload_json
)
WHERE run_kind = 'subworkflow'
  AND trigger_payload_json IS NOT NULL
  AND NOT (trigger_payload_json ? 'contractVersion' AND trigger_payload_json ? 'type' AND trigger_payload_json ? 'payload');
