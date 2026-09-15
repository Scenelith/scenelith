# Generation waiting and recovery

Image tasks have a 30-minute generation window; video tasks have 45 minutes. Automation workflow deadlines still bound the entire workflow. A provider task is polled by its existing task ID, and successful media is saved before the generation step completes.

A successful result received after a generation timeout is still saved. The timeout refund remains final: recovery does not charge the task again. Duplicate success notifications reuse the saved asset. Pending callbacks cannot reopen a timed-out task, and success callbacks cannot reopen a user-cancelled task or a provider-rejected task. A late result from an older Canvas attempt is kept in history without replacing the newer selected output.

Automation admission schedules background work only after its database transaction commits. Background queries do not retain the released admission connection. If a worker stops, the default recovery grace is two minutes after its last run update, and a live worker heartbeat prevents takeover. Recovery reuses completed steps and existing nonfailed generation tasks instead of submitting them again. The `AUTOMATION_WORKFLOW_STALE_MS` operator override can adjust the grace (minimum one minute).
