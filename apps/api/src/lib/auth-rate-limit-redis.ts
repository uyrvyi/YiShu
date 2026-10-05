import { Redis } from "ioredis";

export function createAuthRateLimitRedis(url: string): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
    // Authentication must fail closed promptly, not wait in a reconnect queue.
    enableOfflineQueue: false,
  });
  redis.on("error", () => undefined);
  return redis;
}
