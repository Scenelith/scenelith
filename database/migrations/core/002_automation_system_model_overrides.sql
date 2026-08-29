CREATE TABLE public.automation_system_model_overrides (
  workflow_id text NOT NULL REFERENCES public.automation_workflows(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  node_id text NOT NULL,
  model_id text NOT NULL,
  updated_by text REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workflow_id, node_id),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES public.automation_workflows(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX automation_system_model_overrides_workspace_idx
  ON public.automation_system_model_overrides(workspace_id, workflow_id);
