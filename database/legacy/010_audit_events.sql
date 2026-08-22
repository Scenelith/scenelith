CREATE TABLE audit_events (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '400 days')
);

CREATE INDEX audit_events_workspace_created_idx ON audit_events (workspace_id, created_at DESC);
CREATE INDEX audit_events_actor_created_idx ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX audit_events_expiry_idx ON audit_events (expires_at);

CREATE OR REPLACE FUNCTION prevent_audit_event_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_update();
