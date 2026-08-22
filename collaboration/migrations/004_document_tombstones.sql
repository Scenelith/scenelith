CREATE TABLE IF NOT EXISTS collaboration_document_tombstones (
  document_name text PRIMARY KEY,
  reason text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collaboration_document_tombstones_deleted_idx
  ON collaboration_document_tombstones (deleted_at DESC);
