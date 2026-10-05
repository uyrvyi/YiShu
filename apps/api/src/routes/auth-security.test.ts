import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@yishu/config";
import type { PrismaClient } from "@yishu/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import * as password from "../lib/password.js";

describe("Phase 11 authentication input and timing guards", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.restoreAllMocks();
  });

  function createApp(user: { passwordHash: string } | null = null) {
    const findUnique = vi.fn().mockResolvedValue(user);
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      prisma: { user: { findUnique } } as unknown as PrismaClient,
    });
    apps.push(app);
    return { app, findUnique };
  }

  it("verifies a password even when the account does not exist", async () => {
    const verify = vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    const { app } = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { account: "missing_account", password: "wrong-password" },
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith("wrong-password", password.DUMMY_PASSWORD_HASH);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("uses the stored hash and the same error for an existing account", async () => {
    const verify = vi.spyOn(password, "verifyPassword").mockResolvedValue(false);
    const { app } = createApp({ passwordHash: "stored-hash" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { account: "existing_account", password: "wrong-password" },
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith("wrong-password", "stored-hash");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials" });
  });

  it.each(["refresh", "logout"])(
    "bounds oversized %s tokens before database access",
    async (route) => {
      const { app } = createApp();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/auth/${route}`,
        payload: { refreshToken: "x".repeat(257) },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "validation_error" });
    }
  );

  it("rejects over-limit bodies with 413 without running the login query", async () => {
    const { app, findUnique } = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "payload_too_large" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects unsupported content types with 415", async () => {
    const { app, findUnique } = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/octet-stream" },
      payload: "not-json",
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: "unsupported_media_type" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("continues returning a safe 400 for malformed JSON", async () => {
    const { app, findUnique } = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "validation_error" });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
