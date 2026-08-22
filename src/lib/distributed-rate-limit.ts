import Redis from "ioredis";

type RateLimitGlobal = typeof globalThis & {
  scenelithRequestRateRedis?: Redis;
  scenelithLocalRateWindows?: Map<string, { count: number; expiresAt: number }>;
};

const shared = globalThis as RateLimitGlobal;
const consumeScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

function safeKeyPart(value: string) {
  return value.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 180);
}

function redisClient() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!shared.scenelithRequestRateRedis) {
    shared.scenelithRequestRateRedis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3_000,
    });
    shared.scenelithRequestRateRedis.on("error", (error) => console.error("[request-rate-limit]", error.message));
  }
  return shared.scenelithRequestRateRedis;
}

async function consume(scope: string, identity: string, limit: number, windowSeconds: number) {
  const key = `scenelith:request-rate:${safeKeyPart(scope)}:${safeKeyPart(identity)}`;
  const redis = redisClient();
  if (redis) {
    if (redis.status === "wait") await redis.connect();
    const result = await redis.eval(consumeScript, 1, key, windowSeconds) as [number, number];
    return { count: Number(result[0]), retryAfter: Math.max(1, Number(result[1])) };
  }
  if (process.env.NODE_ENV === "production") throw new Error("REDIS_URL is required for distributed request rate limiting");
  const windows = shared.scenelithLocalRateWindows ||= new Map();
  const now = Date.now();
  const current = windows.get(key);
  const next = !current || current.expiresAt <= now
    ? { count: 1, expiresAt: now + windowSeconds * 1_000 }
    : { count: current.count + 1, expiresAt: current.expiresAt };
  windows.set(key, next);
  return { count: next.count, retryAfter: Math.max(1, Math.ceil((next.expiresAt - now) / 1_000)) };
}

export async function enforceDistributedRateLimit(input: {
  scope: string;
  identity: string;
  limit: number;
  windowSeconds: number;
}) {
  try {
    const result = await consume(input.scope, input.identity, input.limit, input.windowSeconds);
    if (result.count <= input.limit) return null;
    return Response.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(result.retryAfter), "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("Distributed request rate limiter is unavailable", { scope: input.scope, error });
    return Response.json({ error: "Service is temporarily unavailable" }, { status: 503, headers: { "retry-after": "5" } });
  }
}
