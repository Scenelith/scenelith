ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'canvas';
CREATE UNIQUE INDEX IF NOT EXISTS projects_studio_workspace ON public.projects(workspace_id) WHERE purpose = 'studio';
ALTER TABLE public.personas ADD COLUMN IF NOT EXISTS profile_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.generations ADD COLUMN IF NOT EXISTS request_key text;
ALTER TABLE public.generations ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS generations_request_key ON public.generations(requested_by_user_id, project_id, request_key) WHERE request_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.generation_output_extras (
 generation_id text PRIMARY KEY REFERENCES public.generations(id) ON DELETE CASCADE,
 last_frame_url text,
 last_frame_asset_id text REFERENCES public.assets(id) ON DELETE SET NULL,
 soundtrack_asset_id text REFERENCES public.assets(id) ON DELETE SET NULL,
 processed_asset_id text REFERENCES public.assets(id) ON DELETE SET NULL,
 processing_error text
);
CREATE TABLE IF NOT EXISTS public.studio_drafts (
 workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('character','video')),
 settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at text NOT NULL,
 PRIMARY KEY(workspace_id,user_id,kind)
);
