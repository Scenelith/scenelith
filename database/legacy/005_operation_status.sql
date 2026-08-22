CREATE TABLE operation_status (
  key text PRIMARY KEY,
  status text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operation_status_updated_idx ON operation_status (updated_at DESC);
