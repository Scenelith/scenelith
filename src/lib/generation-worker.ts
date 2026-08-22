import { db } from "./postgres-db";
import { drainGenerationDispatchQueue } from "./generation-dispatch";
import { reconcileGeneration } from "./generation-state";

type WorkerGlobal = typeof globalThis & {
  scenelithGenerationWorkerTimer?: ReturnType<typeof setInterval>;
  scenelithGenerationWorkerBusy?: boolean;
};

const shared = globalThis as WorkerGlobal;
const terminal = "('completed','complete','succeeded','success','fail','failed','error','cancelled','canceled')";

export async function tickGenerationWorker() {
  if (shared.scenelithGenerationWorkerBusy) return;
  shared.scenelithGenerationWorkerBusy = true;
  try {
    await drainGenerationDispatchQueue();
    const pollBefore = new Date(Date.now() - 12_000).toISOString();
    const rows = await db.prepare(`SELECT id FROM generations
      WHERE provider_task_id IS NOT NULL
        AND output_asset_id IS NULL
        AND (lower(status) NOT IN ${terminal}
          OR (lower(status) IN ('completed','complete','succeeded','success') AND output_url IS NOT NULL))
        AND updated_at <= ?
      ORDER BY updated_at ASC
      LIMIT 16`).all(pollBefore) as Array<{ id: string }>;
    for (let offset = 0; offset < rows.length; offset += 4) {
      await Promise.allSettled(rows.slice(offset, offset + 4).map(async ({ id }) => {
        try { await reconcileGeneration(id); }
        catch (error) { console.error("[generation:background-reconcile-failed]", { id, error }); }
      }));
    }
  } finally {
    shared.scenelithGenerationWorkerBusy = false;
  }
}

export function startGenerationWorker() {
  if (shared.scenelithGenerationWorkerTimer) return;
  void tickGenerationWorker();
  shared.scenelithGenerationWorkerTimer = setInterval(() => void tickGenerationWorker(), 5_000);
  shared.scenelithGenerationWorkerTimer.unref?.();
}
