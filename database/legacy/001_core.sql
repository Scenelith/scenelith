CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id text PRIMARY KEY,
  email citext NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  password_hash text,
  email_verified_at timestamptz,
  team_managed boolean NOT NULL DEFAULT false,
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE auth_accounts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (provider, provider_account_id)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);

CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  role_prompt text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE projects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_url text,
  status text NOT NULL DEFAULT 'draft',
  graph_json jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE workspace_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_email citext NOT NULL,
  invited_by_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role = 'member'),
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  accepted_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  last_sent_at timestamptz,
  provider_email_id text,
  send_count integer NOT NULL DEFAULT 0,
  last_send_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE team_memberships (
  anchor_workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (anchor_workspace_id, member_user_id)
);

CREATE TABLE team_canvas_grants (
  anchor_workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  granted_by_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (anchor_workspace_id, member_user_id, project_id)
);

CREATE TABLE workspace_invitation_grants (
  invitation_id text NOT NULL REFERENCES workspace_invitations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (invitation_id, project_id)
);

CREATE TABLE auth_rate_limits (
  identifier_hash text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL,
  blocked_until timestamptz
);

CREATE TABLE auth_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE project_snapshots (
  project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  graph_json jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  summary_json jsonb NOT NULL DEFAULT '{"scenes":0,"prompts":0,"outputs":0,"previews":[]}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE project_snapshot_versions (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  graph_json jsonb NOT NULL,
  summary_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE personas (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE assets (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  persona_id text REFERENCES personas(id) ON DELETE CASCADE,
  kind text NOT NULL,
  role text,
  sort_order integer NOT NULL DEFAULT 0,
  filename text NOT NULL,
  storage_path text NOT NULL,
  storage_provider text NOT NULL DEFAULT 'local',
  storage_bucket text,
  object_key text,
  size_bytes bigint,
  content_hash text,
  thumbnail_storage_path text,
  thumbnail_size_bytes bigint,
  thumbnail_content_hash text,
  thumbnail_mime_type text,
  mime_type text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE TABLE generations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  billing_workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  node_id text NOT NULL,
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  model_id text NOT NULL DEFAULT 'nano-banana-2',
  media_type text NOT NULL DEFAULT 'image',
  provider_path text,
  provider_task_id text,
  output_asset_id text REFERENCES assets(id) ON DELETE SET NULL,
  output_url text,
  error text,
  operation text NOT NULL DEFAULT 'generation',
  aspect_ratio text,
  resolution text,
  credit_cost integer NOT NULL DEFAULT 0,
  reference_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE hooks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE SET NULL,
  parent_hook_id text REFERENCES hooks(id) ON DELETE SET NULL,
  source_asset_id text REFERENCES assets(id) ON DELETE SET NULL,
  source_url text,
  kind text NOT NULL DEFAULT 'original',
  text text NOT NULL,
  angle text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT '',
  views_count integer NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);
CREATE INDEX workspace_invitations_workspace_status_idx ON workspace_invitations(workspace_id, status, created_at DESC);
CREATE INDEX workspace_invitations_email_status_idx ON workspace_invitations(invited_email, status);
CREATE UNIQUE INDEX workspace_invitations_pending_email_idx ON workspace_invitations(workspace_id, invited_email) WHERE status = 'pending';
CREATE INDEX team_memberships_member_idx ON team_memberships(member_user_id, owner_user_id);
CREATE INDEX team_canvas_grants_member_workspace_idx ON team_canvas_grants(member_user_id, workspace_id);
CREATE INDEX team_canvas_grants_project_idx ON team_canvas_grants(project_id, member_user_id);
CREATE INDEX workspace_invitation_grants_workspace_idx ON workspace_invitation_grants(workspace_id, invitation_id);
CREATE INDEX auth_accounts_user_idx ON auth_accounts(user_id);
CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens(user_id, purpose);
CREATE INDEX auth_tokens_expiry_idx ON auth_tokens(expires_at);
CREATE INDEX project_snapshots_updated_idx ON project_snapshots(updated_at DESC);
CREATE INDEX project_snapshot_versions_project_idx ON project_snapshot_versions(project_id, revision DESC);
CREATE INDEX assets_workspace_idx ON assets(workspace_id, created_at);
CREATE INDEX assets_project_idx ON assets(project_id);
CREATE INDEX assets_persona_order_idx ON assets(persona_id, role, sort_order);
CREATE INDEX generations_project_idx ON generations(project_id);
CREATE INDEX generations_billing_workspace_idx ON generations(billing_workspace_id, status);
CREATE INDEX hooks_workspace_idx ON hooks(workspace_id);
