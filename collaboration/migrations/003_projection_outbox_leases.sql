ALTER TABLE collaboration_projection_outbox
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text;

CREATE INDEX IF NOT EXISTS collaboration_projection_outbox_available_idx
  ON collaboration_projection_outbox (available_at, created_at)
  WHERE locked_at IS NULL;

CREATE INDEX IF NOT EXISTS collaboration_projection_outbox_lease_idx
  ON collaboration_projection_outbox (locked_at)
  WHERE locked_at IS NOT NULL;
