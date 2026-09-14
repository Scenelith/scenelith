export const MAX_GENERATION_BATCH = 8;

/** One queue per Canvas, shared by individual launches, batches and edits. */
export class GenerationCapacityQueue {
  private active = 0;
  private limit = 1;
  private waiting: Array<() => void> = [];

  acquire(concurrency: number, signal: AbortSignal): Promise<() => void> {
    this.limit = Math.max(1, Math.floor(concurrency) || 1);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter((entry) => entry !== start);
        reject(signal.reason || new Error("Generation cancelled"));
      };
      const start = () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) { abort(); return; }
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.drain();
        });
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(start);
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.limit && this.waiting.length) this.waiting.shift()!();
  }
}

export function canRestoreForegroundTask(task: { nodeId: string; id: string }, attempts: ReadonlyMap<string, string | null>) {
  return !attempts.has(task.nodeId) || attempts.get(task.nodeId) === task.id;
}

export async function settleWithConcurrency<T, R = void>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency) || 1));
  const runners = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        const value = await worker(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
