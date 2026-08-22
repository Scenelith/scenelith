import Redis from "ioredis";

/**
 * Kie accepts at most 20 new generation requests per rolling 10 seconds for
 * the whole provider account. A 520ms interval deliberately stays just under
 * that ceiling (19.2 requests / 10s) and absorbs clock/network jitter.
 */
export const KIE_GENERATION_INTERVAL_MS = 520;

type RateGateGlobal = typeof globalThis & {
  scenelithKieRateTail?: Promise<void>;
  scenelithKieNextStartAt?: number;
  scenelithKieRedis?: Redis;
};

const shared = globalThis as RateGateGlobal;
const rateKey = "scenelith:provider:kie:generation-next-start";
const reservePermitScript = `
local redis_time = redis.call('TIME')
local now = redis_time[1] * 1000 + math.floor(redis_time[2] / 1000)
local previous = tonumber(redis.call('GET', KEYS[1]) or '0')
local start_at = math.max(now, previous)
local next_at = start_at + tonumber(ARGV[1])
redis.call('SET', KEYS[1], next_at, 'PX', 60000)
return start_at - now
`;

export function plannedKieStartAt(previousStartAt: number, now: number) {
  return Math.max(now, previousStartAt + KIE_GENERATION_INTERVAL_MS);
}

function redisClient() {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV === "production") throw new Error("REDIS_URL is required for distributed provider rate limiting");
    return null;
  }
  if (!shared.scenelithKieRedis) {
    shared.scenelithKieRedis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
      connectTimeout: 5_000,
    });
    shared.scenelithKieRedis.on("error", (error) => console.error("[kie:rate-limit-redis]", error.message));
  }
  return shared.scenelithKieRedis;
}

async function acquireLocalPermit() {
  const previous = shared.scenelithKieRateTail || Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const now = Date.now();
    const nextStartAt = shared.scenelithKieNextStartAt
      ? plannedKieStartAt(shared.scenelithKieNextStartAt, now)
      : now;
    const waitMs = Math.max(0, nextStartAt - now);
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    shared.scenelithKieNextStartAt = nextStartAt;
  });
  shared.scenelithKieRateTail = current;
  await current;
}

export async function acquireKieGenerationPermit() {
  const redis = redisClient();
  if (!redis) return acquireLocalPermit();
  if (redis.status === "wait") await redis.connect();
  const waitMs = Number(await redis.eval(reservePermitScript, 1, rateKey, KIE_GENERATION_INTERVAL_MS));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

export async function closeKieRateLimiter() {
  const redis = shared.scenelithKieRedis;
  shared.scenelithKieRedis = undefined;
  if (redis) await redis.quit().catch(() => redis.disconnect());
}
