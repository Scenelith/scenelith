ALTER TABLE public.generations
  ADD COLUMN provider_credits numeric CHECK (provider_credits >= 0);

CREATE INDEX generations_pending_provider_usage ON public.generations(updated_at)
  WHERE provider_task_id IS NOT NULL AND output_asset_id IS NOT NULL
    AND provider_credits IS NULL
    AND model_id IN ('gpt-image-2-6-flare', 'gpt-image-2-6-sunburst')
    AND lower(status) IN ('completed', 'complete', 'succeeded', 'success');
