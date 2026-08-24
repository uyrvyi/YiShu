import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

/**
 * Phase 2 用户集成测试（me / 搜索 / 拉黑）。
 * 依赖真实 PostgreSQL 与独立测试数据库（yishu_test）。
 * 破坏性清库仅允许在 *_test 数据库上进行（requireTestDatabaseUrl 强制保护）。
 */
describe("users integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let userA: { account: string; uid: string; accessToken: string };
  let userB: { account: string; uid: string };

  async function registerUser(payload: Record<string, string>): Promise<{
    account: string;
    uid: string;
    accessToken: string;
  }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload,
    });
    const body = res.json();
    return { account: body.user.account, uid: body.user.uid, accessToken: body.accessToken };
  }

  beforeAll(async () => {
    // 强制使用测试数据库，禁止 fallback 到开发库。
    const testDbUrl = requireTestDatabaseUrl(process.env);
    const config = loadConfig({ NODE_ENV: "test" });
    prisma = createPrismaClient(testDbUrl);
    await prisma.recipientState.deleteMany();
    await prisma.senderState.deleteMany();
    await prisma.letter.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.block.deleteMany();
    await prisma.user.deleteMany();
    app = buildApp(config, { prisma });

    userA = await registerUser({
      account: "alice",
      password: "alice-pass-123",
      nickname: "爱丽丝",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    userB = await registerUser({
      account: "bobby",
      password: "bob-pass-123",
      nickname: "鲍勃",
      province: "北京市",
      city: "北京市",
      district: "海淀区",
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("/users/me 返回当前用户且不泄漏敏感字段", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.account).toBe("alice");
    expect(body.user.uid).toBe(userA.uid);
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.user.id).toBeUndefined();
  });

  it("/users/me 无 token 返回 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/users/me" });
    expect(res.statusCode).toBe(401);
  });

  it("按 account 精确认收件人搜索成功（返回单个对象）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/users/search?q=bobby" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // V1 契约：返回单个安全用户对象，而非 results 列表
    expect(body.results).toBeUndefined();
    expect(body.account).toBe("bobby");
    expect(body.uid).toBe(userB.uid);
    expect(body.region.province).toBe("北京市");
    expect(body.passwordHash).toBeUndefined();
    expect(body.id).toBeUndefined();
  });

  it("按 UID 精确认收件人搜索成功", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/users/search?q=${userA.uid}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uid).toBe(userA.uid);
  });

  it("不存在的用户搜索返回 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/users/search?q=nobody" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("user_not_found");
  });

  it("block 成功", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/users/${userB.uid}/block`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().blocked.uid).toBe(userB.uid);

    const exists = await prisma.block.findFirst({
      where: { blocked: { account: "bobby" }, blocker: { account: "alice" } },
    });
    expect(exists).not.toBeNull();
  });

  it("重复 block 行为正确（幂等，仍成功）", async () => {
    const res1 = await app.inject({
      method: "POST",
      url: `/api/v1/users/${userB.uid}/block`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    const res2 = await app.inject({
      method: "POST",
      url: `/api/v1/users/${userB.uid}/block`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    const count = await prisma.block.count({
      where: { blocker: { account: "alice" }, blocked: { account: "bobby" } },
    });
    expect(count).toBe(1);
  });

  it("block 不存在的用户返回 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/users/99999999/block",
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
