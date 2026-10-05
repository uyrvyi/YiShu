import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@yishu/config";
import type { PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";

describe("Phase 11 auth rate limits", () => {
  const app: FastifyInstance = buildApp(loadConfig({ NODE_ENV: "test" }), {
    prisma: {} as PrismaClient,
    enableRateLimits: true,
  });

  afterAll(async () => {
    await app.close();
  });

  it("caps login attempts before validation and ignores spoofed forwarding headers", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { "x-forwarded-for": `203.0.113.${attempt + 1}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-forwarded-for": "203.0.113.250" },
      payload: {},
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "rate_limited" });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("keeps register and login budgets separate; health remains accessible", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {},
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "rate_limited" });
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
  });

  it("caps public recipient lookup without allowing changing query strings to reset the quota", async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await app.inject({
        url: `/api/v1/users/search?q=${"x".repeat(25)}${attempt}`,
      });
      expect(response.statusCode).toBe(400);
    }
    const blocked = await app.inject({ url: "/api/v1/users/search?q=some_account" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "rate_limited" });
  });
});
