ALTER TABLE collaboration_document_versions
  ADD COLUMN IF NOT EXISTS version_kind text NOT NULL DEFAULT 'automatic';

ALTER TABLE collaboration_document_versions
  DROP CONSTRAINT IF EXISTS collaboration_document_versions_version_kind_check;
ALTER TABLE collaboration_document_versions
  ADD CONSTRAINT collaboration_document_versions_version_kind_check
  CHECK (version_kind IN ('automatic', 'checkpoint', 'migration'));

CREATE INDEX IF NOT EXISTS collaboration_versions_document_created_idx
  ON collaboration_document_versions (document_name, created_at DESC);
CREATE INDEX IF NOT EXISTS collaboration_updates_created_idx
  ON collaboration_document_updates (created_at);
