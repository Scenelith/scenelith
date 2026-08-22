-- Self-hosted historical migration boundary.
-- The Cloud migration with this immutable filename also created commerce and
-- credit-ledger tables. A fresh self-hosted install needs only the shared job,
-- support, feature, and notification schema below.

CREATE TABLE generation_dispatch_jobs (
  generation_id text PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dispatching', 'dispatched', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE tiktok_planning_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_node_id text NOT NULL,
  input_hash text NOT NULL,
  analysis_json jsonb,
  observations_json jsonb,
  intent_json jsonb,
  binding_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (workspace_id, input_hash)
);

CREATE TABLE tiktok_automation_jobs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_node_id text NOT NULL,
  dedupe_key text NOT NULL,
  request_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  stage text NOT NULL DEFAULT 'queued',
  stage_label text NOT NULL DEFAULT 'Waiting for an available planning slot',
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  result_json jsonb,
  error text,
  error_code text,
  http_status integer,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 2,
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  worker_id text,
  reservation_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE support_tickets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  subject text NOT NULL,
  category text NOT NULL DEFAULT 'other' CHECK (category IN ('bug', 'billing', 'generation', 'account', 'other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE support_messages (
  id text PRIMARY KEY,
  ticket_id text NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE feature_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'planned', 'in_progress', 'shipped')),
  is_hidden boolean NOT NULL DEFAULT false,
  moderation_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE feature_votes (
  feature_request_id text NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (feature_request_id, user_id)
);

CREATE TABLE notifications (
  id text PRIMARY KEY,
  recipient_user_id text REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('ticket_reply', 'ticket_status', 'feature_status', 'feature_update', 'announcement', 'admin_queue')),
  title text NOT NULL,
  body text NOT NULL,
  action_type text CHECK (action_type IN ('support', 'features', 'admin')),
  action_id text,
  created_at timestamptz NOT NULL
);

CREATE TABLE notification_reads (
  notification_id text NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);

CREATE INDEX generation_dispatch_queue_idx ON generation_dispatch_jobs(status, available_at, created_at);
CREATE INDEX tiktok_planning_runs_expires_at_idx ON tiktok_planning_runs(expires_at);
CREATE INDEX tiktok_automation_jobs_queue_idx ON tiktok_automation_jobs(status, available_at, created_at);
CREATE INDEX tiktok_automation_jobs_user_status_idx ON tiktok_automation_jobs(user_id, status, created_at);
CREATE INDEX tiktok_automation_jobs_project_idx ON tiktok_automation_jobs(project_id, created_at DESC);
CREATE INDEX support_tickets_user_updated_idx ON support_tickets(user_id, updated_at DESC);
CREATE INDEX support_tickets_status_updated_idx ON support_tickets(status, updated_at DESC);
CREATE INDEX support_messages_ticket_created_idx ON support_messages(ticket_id, created_at);
CREATE INDEX feature_requests_status_updated_idx ON feature_requests(status, updated_at DESC);
CREATE INDEX feature_requests_hidden_status_updated_idx ON feature_requests(is_hidden, status, updated_at DESC);
CREATE INDEX feature_votes_feature_idx ON feature_votes(feature_request_id);
CREATE INDEX notifications_recipient_created_idx ON notifications(recipient_user_id, created_at DESC);
CREATE INDEX notification_reads_user_idx ON notification_reads(user_id, read_at DESC);
