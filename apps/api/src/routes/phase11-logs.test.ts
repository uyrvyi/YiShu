import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@yishu/config";
import type { PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";

describe("Phase 11 sensitive log guards", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function createApp() {
    const output: string[] = [];
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      prisma: {
        user: { findUnique: vi.fn().mockRejectedValue(new Error("DRIVER_PASSWORD_SECRET")) },
      } as unknown as PrismaClient,
      loggerStream: {
        write: (line) => {
          output.push(line);
        },
      },
    });
    apps.push(app);
    return { app, output };
  }

  it("records route and response status without query, body, auth/cookie or database error content", async () => {
    const { app, output } = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login?accessToken=QUERY_TOKEN_SECRET",
      headers: { authorization: "Bearer AUTH_TOKEN_SECRET", cookie: "session=COOKIE_SECRET" },
      payload: { account: "sample_account", password: "BODY_PASSWORD_SECRET" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_error" });
    const logs = output.join("");
    expect(logs).toContain("/api/v1/auth/login");
    expect(logs).toContain('"statusCode":500');
    expect(logs).not.toMatch(
      /QUERY_TOKEN_SECRET|AUTH_TOKEN_SECRET|COOKIE_SECRET|BODY_PASSWORD_SECRET|DRIVER_PASSWORD_SECRET|sample_account/
    );
  });

  it("does not log arbitrary unmatched URL paths", async () => {
    const { app, output } = createApp();
    const response = await app.inject({
      url: "/PATH_TOKEN_SECRET?refreshToken=QUERY_TOKEN_SECRET",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
    expect(output.join("")).not.toMatch(/PATH_TOKEN_SECRET|QUERY_TOKEN_SECRET/);
  });

  it("redacts accidentally structured credentials and strips raw error messages/stacks", async () => {
    const { app, output } = createApp();
    await app.ready();
    app.log.error(
      {
        accessToken: "ACCESS_SECRET",
        refreshToken: "REFRESH_SECRET",
        password: "PASSWORD_SECRET",
        JWT_SECRET: "JWT_SECRET_VALUE",
        CONTENT_ENCRYPTION_KEY: "ENCRYPTION_SECRET",
        DATABASE_URL: "DATABASE_SECRET",
        REDIS_URL: "REDIS_SECRET",
        err: new Error("ERROR_SECRET"),
      },
      "privacy_probe"
    );
    expect(output.join("")).toContain("privacy_probe");
    expect(output.join("")).not.toMatch(
      /ACCESS_SECRET|REFRESH_SECRET|PASSWORD_SECRET|JWT_SECRET_VALUE|ENCRYPTION_SECRET|DATABASE_SECRET|REDIS_SECRET|ERROR_SECRET/
    );
  });
});
