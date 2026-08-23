import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@yishu/config";
import type { PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

describe("health route", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it("GET /api/v1/health 返回 ok", async () => {
    // health 路由不依赖数据库；此处传一个占位 prisma 以满足 buildApp 签名。
    const mockPrisma = {} as PrismaClient;
    app = buildApp({ ...loadConfig({ NODE_ENV: "test" }) }, { prisma: mockPrisma });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("yishu-api");
  });
});
