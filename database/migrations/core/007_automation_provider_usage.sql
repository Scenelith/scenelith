-- Receipts survive output validation failures, cancellation and worker recovery.
ALTER TABLE public.automation_node_runs ADD COLUMN IF NOT EXISTS provider_usage_json JSONB;
