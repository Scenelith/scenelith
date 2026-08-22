-- Add the deployment-neutral usage owner for generation admission. The old
-- column remains only for compatibility with already-applied immutable schema.
ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS usage_workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'generations'
      AND column_name = 'billing_workspace_id'
  ) THEN
    EXECUTE 'UPDATE generations SET usage_workspace_id = billing_workspace_id WHERE usage_workspace_id IS NULL';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS generations_usage_workspace_idx
  ON generations(usage_workspace_id, status);
