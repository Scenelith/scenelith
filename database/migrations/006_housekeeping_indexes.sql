CREATE INDEX generation_dispatch_terminal_updated_idx
  ON generation_dispatch_jobs (updated_at)
  WHERE status IN ('dispatched', 'failed');

CREATE INDEX tiktok_automation_terminal_completed_idx
  ON tiktok_automation_jobs (completed_at)
  WHERE status IN ('completed', 'failed', 'cancelled');
