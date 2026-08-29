ALTER TABLE public.automation_runs
  ADD COLUMN input_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.automation_runs
  ADD CONSTRAINT automation_runs_input_snapshot_object
  CHECK (jsonb_typeof(input_snapshot_json) = 'object');

ALTER TABLE public.automation_tree_usage_reservations
  DROP CONSTRAINT automation_tree_usage_reservations_kind_check;

ALTER TABLE public.automation_tree_usage_reservations
  ADD CONSTRAINT automation_tree_usage_reservations_kind_check
  CHECK (kind IN ('asset', 'node'));
