-- Playback copies preserve uploads and participate in existing quota/deletion triggers.
ALTER TABLE public.assets ADD COLUMN playback_source_asset_id text REFERENCES public.assets(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX assets_playback_source ON public.assets(playback_source_asset_id) WHERE playback_source_asset_id IS NOT NULL;
