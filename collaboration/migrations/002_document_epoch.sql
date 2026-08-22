ALTER TABLE collaboration_documents
  ADD COLUMN IF NOT EXISTS epoch bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS compacting boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS state_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS update_bytes_since_checkpoint bigint NOT NULL DEFAULT 0;

UPDATE collaboration_documents
SET state_bytes = octet_length(state)
WHERE state_bytes = 0;

ALTER TABLE collaboration_document_versions
  ADD COLUMN IF NOT EXISTS epoch bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS version_kind text NOT NULL DEFAULT 'automatic';

CREATE INDEX IF NOT EXISTS collaboration_documents_state_size_idx
  ON collaboration_documents (state_bytes DESC);

CREATE INDEX IF NOT EXISTS collaboration_documents_epoch_idx
  ON collaboration_documents (document_name, epoch);
