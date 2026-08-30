CREATE TABLE public.mcp_oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NOT NULL,
  client_uri text,
  redirect_uris_json jsonb NOT NULL,
  grant_types_json jsonb NOT NULL,
  response_types_json jsonb NOT NULL,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  CHECK (jsonb_typeof(redirect_uris_json) = 'array'),
  CHECK (jsonb_typeof(grant_types_json) = 'array'),
  CHECK (jsonb_typeof(response_types_json) = 'array'),
  CHECK (token_endpoint_auth_method = 'none')
);

CREATE TABLE public.mcp_oauth_authorizations (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  state text,
  code_challenge text NOT NULL,
  requested_scopes_json jsonb NOT NULL,
  granted_scopes_json jsonb,
  workspace_id text REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_ids_json jsonb,
  library_access boolean NOT NULL DEFAULT true,
  code_hash text UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  code_expires_at timestamptz,
  code_consumed_at timestamptz,
  CHECK (jsonb_typeof(requested_scopes_json) = 'array'),
  CHECK (granted_scopes_json IS NULL OR jsonb_typeof(granted_scopes_json) = 'array'),
  CHECK (project_ids_json IS NULL OR jsonb_typeof(project_ids_json) = 'array')
);

CREATE INDEX mcp_oauth_authorizations_expiry_idx
  ON public.mcp_oauth_authorizations(expires_at);

CREATE TABLE public.mcp_oauth_connections (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE,
  workspace_id text REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_ids_json jsonb,
  library_access boolean NOT NULL DEFAULT true,
  resource text NOT NULL,
  scopes_json jsonb NOT NULL,
  access_token_hash text NOT NULL UNIQUE,
  refresh_token_hash text NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(scopes_json) = 'array'),
  CHECK (project_ids_json IS NULL OR jsonb_typeof(project_ids_json) = 'array')
);

CREATE INDEX mcp_oauth_connections_user_created_idx
  ON public.mcp_oauth_connections(user_id, created_at DESC);

CREATE INDEX mcp_oauth_connections_active_access_idx
  ON public.mcp_oauth_connections(access_token_hash)
  WHERE revoked_at IS NULL;
