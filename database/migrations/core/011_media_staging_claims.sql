-- Publication and garbage collection must acquire mutually exclusive ownership.
ALTER TABLE media_job_objects ADD COLUMN cleanup_claimed_at timestamptz;
ALTER TABLE media_job_objects ADD COLUMN protected_until timestamptz NOT NULL DEFAULT now();
