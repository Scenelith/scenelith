-- Short, connection-bound read receipts keep field CAS metadata out of agent context.
CREATE TABLE IF NOT EXISTS public.mcp_canvas_reads (
  id text PRIMARY KEY,
  connection_id text NOT NULL,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  read_set jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE(connection_id, user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS mcp_canvas_reads_expiry ON public.mcp_canvas_reads(expires_at);
CREATE INDEX IF NOT EXISTS mcp_canvas_reads_connection ON public.mcp_canvas_reads(connection_id, user_id, expires_at DESC);
