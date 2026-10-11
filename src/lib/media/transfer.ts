/** SDKs may replace a deadline's TimeoutError with a generic AbortError. */
export async function mediaTransfer<T>(parent: AbortSignal, timeoutMs: number, transfer: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  try {
    return await transfer(signal);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}
