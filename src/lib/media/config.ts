function integer(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
export function mediaConfig() {
  return { lightConcurrency: integer('MEDIA_LIGHT_CONCURRENCY',1,1,16), transcodeConcurrency: integer('MEDIA_TRANSCODE_CONCURRENCY',1,1,16),
    threads: integer('MEDIA_FFMPEG_THREADS',2,1,32), maxAttempts: 3, heartbeatMs: 15_000, leaseSeconds: 90,
    processTimeoutMs: integer('MEDIA_PROCESS_TIMEOUT_MS',600_000,1_000,7_200_000),
    transferTimeoutMs: integer('MEDIA_TRANSFER_TIMEOUT_MS',300_000,1_000,7_200_000),
    maxFileBytes: integer('MEDIA_MAX_FILE_BYTES',2_000_000_000,1_000_000,5_000_000_000),
    maxTempBytes: integer('MEDIA_MAX_TEMP_BYTES',8_000_000_000,10_000_000,100_000_000_000),
    tempRoot: process.env.MEDIA_TEMP_ROOT || '/tmp/scenelith-media', maxProbeBytes: 32 * 1024 * 1024 };
}
