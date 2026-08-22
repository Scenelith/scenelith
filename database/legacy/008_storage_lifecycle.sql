CREATE TABLE workspace_storage_usage (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  quota_bytes bigint NOT NULL DEFAULT 107374182400 CHECK (quota_bytes > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workspace_storage_usage (workspace_id, used_bytes, reserved_bytes, updated_at)
SELECT workspace_id,
  COALESCE(SUM(COALESCE(size_bytes, 0) + COALESCE(thumbnail_size_bytes, 0)), 0),
  0,
  now()
FROM assets
WHERE workspace_id IS NOT NULL
GROUP BY workspace_id
ON CONFLICT(workspace_id) DO UPDATE SET used_bytes = excluded.used_bytes, updated_at = excluded.updated_at;

CREATE OR REPLACE FUNCTION maintain_workspace_storage_usage() RETURNS trigger AS $$
DECLARE
  old_bytes bigint := 0;
  new_bytes bigint := 0;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.workspace_id IS NOT NULL THEN
    old_bytes := COALESCE(OLD.size_bytes, 0) + COALESCE(OLD.thumbnail_size_bytes, 0);
    INSERT INTO workspace_storage_usage (workspace_id, used_bytes, updated_at)
    VALUES (OLD.workspace_id, 0, now())
    ON CONFLICT(workspace_id) DO UPDATE
      SET used_bytes = GREATEST(0, workspace_storage_usage.used_bytes - old_bytes), updated_at = now();
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.workspace_id IS NOT NULL THEN
    new_bytes := COALESCE(NEW.size_bytes, 0) + COALESCE(NEW.thumbnail_size_bytes, 0);
    INSERT INTO workspace_storage_usage (workspace_id, used_bytes, updated_at)
    VALUES (NEW.workspace_id, new_bytes, now())
    ON CONFLICT(workspace_id) DO UPDATE
      SET used_bytes = workspace_storage_usage.used_bytes + new_bytes, updated_at = now();
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assets_workspace_storage_usage
AFTER INSERT OR DELETE OR UPDATE OF workspace_id, size_bytes, thumbnail_size_bytes ON assets
FOR EACH ROW EXECUTE FUNCTION maintain_workspace_storage_usage();

CREATE TABLE asset_upload_sessions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  storage_reference text NOT NULL,
  upload_id text NOT NULL,
  filename text NOT NULL,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  part_size integer NOT NULL,
  part_count integer NOT NULL CHECK (part_count > 0),
  status text NOT NULL DEFAULT 'prepared',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  locked_at timestamptz,
  worker_id text,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX asset_upload_sessions_cleanup_idx
  ON asset_upload_sessions (available_at, expires_at)
  WHERE status = 'prepared';

CREATE TABLE storage_deletion_jobs (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  storage_reference text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 12,
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  worker_id text,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE(storage_reference)
);

CREATE INDEX storage_deletion_jobs_ready_idx
  ON storage_deletion_jobs (available_at, created_at)
  WHERE status = 'queued';
