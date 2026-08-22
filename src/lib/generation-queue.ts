export const MAX_GENERATION_BATCH = 8;

export async function settleWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency) || 1));
  const runners = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await worker(items[index], index);
        results[index] = { status: "fulfilled", value: undefined };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
