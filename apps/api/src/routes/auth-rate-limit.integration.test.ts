import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@yishu/config";
import type { PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";
import { createAuthRateLimitRedis } from "../lib/auth-rate-limit-redis.js";

describe("Phase 11 shared Redis authentication limits", () => {
  const config = loadConfig({ ...process.env, NODE_ENV: "test" });
  const apps: FastifyInstance[] = [];
  const clients: Redis[] = [];
  const keys = new Set<string>();

  afterEach(async () => {
    try {
      const connected = clients.find((client) => client.status === "ready");
      if (connected && keys.size > 0) await connected.del(...keys);
    } finally {
      keys.clear();
      await Promise.all(apps.splice(0).map((app) => app.close()));
      clients.splice(0).forEach((client) => client.disconnect());
    }
  });

  async function createApp(namespace: string) {
    const redis = createAuthRateLimitRedis(config.REDIS_URL);
    clients.push(redis);
    await redis.connect();
    const findUnique = vi.fn().mockResolvedValue(null);
    const app = buildApp(config, {
      prisma: { user: { findUnique } } as unknown as PrismaClient,
      rateLimitRedis: redis,
      enableRateLimits: true,
      rateLimitNamespace: namespace,
    });
    apps.push(app);
    keys.add(`${namespace}POST/api/v1/auth/login-127.0.0.1`);
    return { app, redis, findUnique };
  }

  function attempt(app: FastifyInstance) {
    return app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {} });
  }

  it("shares an atomic quota across two API instances and retains it across restart", async () => {
    const namespace = `yishu-test-limit-${randomUUID()}-`;
    const first = await createApp(namespace);
    const second = await createApp(namespace);
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => attempt(i % 2 === 0 ? first.app : second.app))
    );
    expect(responses.filter((response) => response.statusCode === 400)).toHaveLength(10);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(2);
    expect(first.findUnique).not.toHaveBeenCalled();
    expect(second.findUnique).not.toHaveBeenCalled();

    await first.app.close();
    const restarted = await createApp(namespace);
    const blocked = await attempt(restarted.app);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "rate_limited" });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    const key = `${namespace}POST/api/v1/auth/login-127.0.0.1`;
    expect(await restarted.redis.pttl(key)).toBeGreaterThan(0);
    await restarted.redis.pexpire(key, 1);
    await delay(50);
    expect((await attempt(restarted.app)).statusCode).toBe(400);
    expect(await restarted.redis.get(key)).toBe("1");
  });

  it("fails closed without querying users when Redis disconnects, then recovers", async () => {
    const { app, redis, findUnique } = await createApp(`yishu-test-limit-${randomUUID()}-`);
    // Register RedisStore Lua commands while the connection is available.
    expect((await attempt(app)).statusCode).toBe(400);
    const disconnected = once(redis, "end");
    redis.disconnect();
    await disconnected;
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { account: "missing_account", password: "wrong-password" },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "internal_error" });
    expect(findUnique).not.toHaveBeenCalled();
    expect((await app.inject({ url: "/api/v1/health" })).statusCode).toBe(200);
    await redis.connect();
    const recovered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { account: "missing_account", password: "wrong-password" },
    });
    expect(recovered.statusCode).toBe(401);
    expect(findUnique).toHaveBeenCalledOnce();
  });
});
