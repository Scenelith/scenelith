CREATE TABLE application_cutovers (
  id text PRIMARY KEY,
  source_kind text NOT NULL,
  source_fingerprint text NOT NULL,
  imported_counts jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  worker_role text NOT NULL,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_error text
);

CREATE INDEX worker_heartbeats_last_seen_idx ON worker_heartbeats (last_seen_at);
