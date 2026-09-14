type GenerationResponse = { error?: string; code?: string; generationId?: string; retryAfterMs?: number; status?: string };

function waitForSlot(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Capacity checks are read-only. A full workspace must not repeatedly submit
 * media, reserve credits, or restart the card's generation animation. */
export async function submitGenerationWhenAvailable(
  request: { projectId: string; [key: string]: unknown },
  signal: AbortSignal,
  dependencies: { fetch?: typeof fetch; wait?: typeof waitForSlot } = {},
) {
  const requestFetch = dependencies.fetch || fetch;
  const wait = dependencies.wait || waitForSlot;
  while (true) {
    signal.throwIfAborted();
    const capacityResponse = await requestFetch(`/api/generate/capacity?projectId=${encodeURIComponent(request.projectId)}`, { cache: "no-store", signal });
    const capacity = await capacityResponse.json() as { available?: number; retryAfterMs?: number; error?: string };
    if (!capacityResponse.ok || typeof capacity.available !== "number") throw new Error(capacity.error || "Could not check generation availability");
    if (capacity.available < 1) {
      await wait(Math.max(1000, capacity.retryAfterMs || 3000), signal);
      continue;
    }
    signal.throwIfAborted();
    const response = await requestFetch("/api/generate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal,
    });
    const body = await response.json().catch(() => ({})) as GenerationResponse;
    // Another tab or workspace member can take the last slot between GET and
    // POST. Admission remains authoritative; return to read-only waiting.
    if (response.status === 429 && body.code === "GENERATION_CONCURRENCY_LIMIT") {
      await wait(Math.max(1000, body.retryAfterMs || 3000), signal);
      continue;
    }
    return { response, body };
  }
}
