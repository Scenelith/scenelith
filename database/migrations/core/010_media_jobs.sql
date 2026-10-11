-- Additive: existing generations/assets keep their original execution path.
CREATE TABLE media_jobs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  operation text NOT NULL,
  operation_version integer NOT NULL,
  fingerprint text NOT NULL,
  spec_json jsonb NOT NULL,
  inputs_json jsonb NOT NULL,
  resource_class text NOT NULL CHECK (resource_class IN ('light', 'transcode')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','completed','failed','cancelled')),
  stage text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  worker_id text,
  lease_until timestamptz,
  fence bigint NOT NULL DEFAULT 0,
  result_asset_id text REFERENCES assets(id) ON DELETE SET NULL,
  result_json jsonb,
  error_code text,
  metrics_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(user_id, workspace_id, fingerprint)
);
CREATE INDEX media_jobs_ready ON media_jobs(resource_class,available_at,created_at) WHERE status IN ('queued','retry_wait');
CREATE INDEX media_jobs_completed ON media_jobs(completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX media_jobs_expired ON media_jobs(lease_until) WHERE status='running';
CREATE TABLE media_job_requests (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  job_id text NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,scope_key,request_key)
);
CREATE TABLE media_workspace_turns (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_claimed_at timestamptz NOT NULL DEFAULT 'epoch'
);
CREATE TABLE media_asset_analysis (
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  content_identity text NOT NULL,
  analyzer_version integer NOT NULL,
  metadata_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(asset_id,content_identity,analyzer_version)
);
-- Reference index for retention. Explicit source deletion invalidates waiting jobs on their next access check.
CREATE TABLE media_job_inputs (
  job_id text NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY(job_id,asset_id)
);
CREATE TABLE media_job_objects (
  -- Keep staging records after order deletion so interrupted uploads remain collectible.
  job_id text NOT NULL,
  fence bigint NOT NULL,
  ordinal integer NOT NULL DEFAULT 0,
  storage_reference text NOT NULL,
  retained boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,fence,ordinal)
);
CREATE TABLE media_job_dependencies (
  job_id text NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
  dependency_id text NOT NULL REFERENCES media_jobs(id) ON DELETE RESTRICT,
  PRIMARY KEY(job_id,dependency_id),
  CHECK(job_id<>dependency_id)
);

-- Persist the execution version; rolling back admission must not move an accepted job.
ALTER TABLE generations ADD COLUMN media_execution_version integer NOT NULL DEFAULT 0;
ALTER TABLE generation_output_extras ADD COLUMN media_job_id text REFERENCES media_jobs(id);

-- A lost provider response must not become another paid submission.
ALTER TABLE generation_dispatch_jobs DROP CONSTRAINT generation_dispatch_jobs_status_check;
ALTER TABLE generation_dispatch_jobs ADD CONSTRAINT generation_dispatch_jobs_status_check
  CHECK(status IN ('queued','dispatching','dispatched','reconciling','failed'));
CREATE TABLE generation_provider_receipts (
  generation_id text PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
  callback_token text NOT NULL UNIQUE,
  submitted_at timestamptz,
  provider_task_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_storage_reservations (
  job_id text PRIMARY KEY REFERENCES media_jobs(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fence bigint NOT NULL,
  bytes bigint NOT NULL CHECK(bytes>=0)
);
CREATE FUNCTION media_storage_reservation_accounting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE usage_row workspace_storage_usage%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO usage_row FROM workspace_storage_usage WHERE workspace_id=NEW.workspace_id FOR UPDATE;
    IF NOT FOUND OR usage_row.used_bytes+usage_row.reserved_bytes+NEW.bytes>usage_row.quota_bytes THEN
      RAISE EXCEPTION 'MEDIA_STORAGE_QUOTA';
    END IF;
    UPDATE workspace_storage_usage SET reserved_bytes=reserved_bytes+NEW.bytes,updated_at=now() WHERE workspace_id=NEW.workspace_id;
    RETURN NEW;
  END IF;
  UPDATE workspace_storage_usage SET reserved_bytes=GREATEST(0,reserved_bytes-OLD.bytes),updated_at=now() WHERE workspace_id=OLD.workspace_id;
  RETURN OLD;
END $$;
CREATE TRIGGER media_storage_reservation_insert AFTER INSERT ON media_storage_reservations FOR EACH ROW EXECUTE FUNCTION media_storage_reservation_accounting();
CREATE TRIGGER media_storage_reservation_delete AFTER DELETE ON media_storage_reservations FOR EACH ROW EXECUTE FUNCTION media_storage_reservation_accounting();
