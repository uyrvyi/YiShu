import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@yishu/config";
import type { PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";
import { createAuthRateLimitRedis } from "../lib/auth-rate-limit-redis.js";

describe("Phase 11 production configuration gate", () => {
  const apps: FastifyInstance[] = [];
  const clients: Redis[] = [];
  const keys = new Set<string>();
  const environment = loadConfig({ ...process.env, NODE_ENV: "test" });
  const config = loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: environment.DATABASE_URL,
    REDIS_URL: environment.REDIS_URL,
    JWT_SECRET: randomBytes(32).toString("hex"),
    CONTENT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  });

  afterEach(async () => {
    try {
      const ready = clients.find((client) => client.status === "ready");
      if (ready && keys.size) await ready.del(...keys);
    } finally {
      keys.clear();
      await Promise.all(apps.splice(0).map((app) => app.close()));
      clients.splice(0).forEach((client) => client.disconnect());
    }
  });

  it("refuses production API with absent shared Redis or disabled limits", () => {
    expect(() => buildApp(config, { prisma: {} as PrismaClient })).toThrow(
      "production_rate_limit_redis_required"
    );
    expect(() =>
      buildApp(config, {
        prisma: {} as PrismaClient,
        rateLimitRedis: {} as Redis,
        enableRateLimits: false,
      })
    ).toThrow("production_rate_limit_redis_required");
  });
  it("rejects old letter/image uploads before parsing and rejects spoofed plaintext protocol claims", async () => {
    const redis = createAuthRateLimitRedis(config.REDIS_URL);
    clients.push(redis);
    await redis.connect();
    const findUnique = vi.fn(async ({ where }: { where: { uid: string } }) => ({
      id: 1n,
      uid: where.uid,
    }));
    const app = buildApp(config, {
      prisma: {
        user: { findUnique },
        letter: { findUnique: async () => null },
      } as unknown as PrismaClient,
      rateLimitRedis: redis,
      rateLimitNamespace: `yishu-test-production-${randomUUID()}-`,
      loggerStream: { write: () => {} },
    });
    apps.push(app);
    await app.ready();
    const authorization = `Bearer ${app.jwt.sign({ sub: "12345678" })}`;
    const outdated = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization, "content-type": "application/json" },
      payload: "not JSON",
    });
    expect(outdated.statusCode).toBe(409);
    expect(outdated.json().error).toBe("e2ee_required");
    expect(findUnique).not.toHaveBeenCalled();
    const image = await app.inject({
      method: "POST",
      url: "/api/v1/media/images",
      headers: { authorization, "content-type": "multipart/form-data" },
      payload: "not multipart",
    });
    expect(image.statusCode).toBe(409);
    expect(image.json().error).toBe("e2ee_required");
    expect(findUnique).not.toHaveBeenCalled();
    const spoofed = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization, "x-yishu-content-protocol": "yishu-e2ee-v1" },
      payload: {
        recipient: "23456789",
        content: "plaintext",
        transportType: "HAND_CARRY",
        clientRequestId: randomUUID(),
      },
    });
    expect(spoofed.statusCode).toBe(409);
    expect(spoofed.json().error).toBe("e2ee_required");
  });

  it("starts a production-mode TCP server with safe health, auth and not-found responses", async () => {
    const redis = createAuthRateLimitRedis(config.REDIS_URL);
    clients.push(redis);
    await redis.connect();
    const output: string[] = [];
    const app = buildApp(config, {
      prisma: {} as PrismaClient,
      rateLimitRedis: redis,
      rateLimitNamespace: `yishu-test-production-${randomUUID()}-`,
      loggerStream: {
        write: (line) => {
          output.push(line);
        },
      },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const health = await fetch(`${address}/api/v1/health`);
    expect(health.status).toBe(200);
    const unauthorized = await fetch(`${address}/api/v1/users/me`, {
      headers: { authorization: "Bearer AUTH_SECRET" },
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    const missing = await fetch(`${address}/PATH_SECRET?token=QUERY_SECRET`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(output.join("")).not.toMatch(/AUTH_SECRET|PATH_SECRET|QUERY_SECRET/);
  });

  it("uses shared quotas in production, ignores forged client IPs and emits safe JSON logs", async () => {
    const namespace = `yishu-test-production-${randomUUID()}-`;
    const output: string[] = [];
    const findUnique = vi.fn();
    for (let i = 0; i < 2; i += 1) {
      const redis = createAuthRateLimitRedis(config.REDIS_URL);
      clients.push(redis);
      await redis.connect();
      apps.push(
        buildApp(config, {
          prisma: { user: { findUnique } } as unknown as PrismaClient,
          rateLimitRedis: redis,
          rateLimitNamespace: namespace,
          loggerStream: {
            write: (line) => {
              output.push(line);
            },
          },
        })
      );
    }
    keys.add(`${namespace}POST/api/v1/auth/login-127.0.0.1`);
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const app = apps[index % 2];
        if (!app) throw new Error("production_test_app_missing");
        return app.inject({
          method: "POST",
          url: `/api/v1/auth/login?token=QUERY_SECRET_${index}`,
          headers: {
            "x-forwarded-for": `203.0.113.${index + 1}`,
            forwarded: `for=203.0.113.${index + 1}`,
            authorization: "Bearer AUTH_SECRET",
            cookie: "session=COOKIE_SECRET",
          },
          payload: { password: "BODY_SECRET" },
        });
      })
    );
    expect(responses.filter((response) => response.statusCode === 400)).toHaveLength(10);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(2);
    expect(findUnique).not.toHaveBeenCalled();
    const first = apps[0];
    if (!first) throw new Error("production_test_app_missing");
    expect((await first.inject({ url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await first.inject({ url: "/PATH_SECRET?token=QUERY_SECRET" })).json()).toEqual({
      error: "not_found",
    });
    const logs = output.join("");
    expect(logs).not.toMatch(
      /QUERY_SECRET|PATH_SECRET|AUTH_SECRET|COOKIE_SECRET|BODY_SECRET|203\.0\.113/
    );
    expect(logs).toContain('"remoteAddress":"127.0.0.1"');
    expect(logs).toContain('"statusCode":429');
    expect(
      output.every((line) => {
        JSON.parse(line);
        return true;
      })
    ).toBe(true);
  });
});
