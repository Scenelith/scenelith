ALTER TABLE project_snapshots
  ADD COLUMN source_revision bigint NOT NULL DEFAULT 0 CHECK (source_revision >= 0);

CREATE INDEX project_snapshot_versions_created_idx
  ON project_snapshot_versions (created_at);
