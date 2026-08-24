import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

/**
 * Phase 2 认证集成测试。
 * 依赖真实 PostgreSQL（Docker compose up -d）与独立测试数据库（yishu_test）。
 * 破坏性清库仅允许在 *_test 数据库上进行（requireTestDatabaseUrl 强制保护）。
 */
describe("auth integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    // 强制使用测试数据库（未提供/非 _test 会抛错），禁止 fallback 到开发库。
    const testDbUrl = requireTestDatabaseUrl(process.env);
    const config = loadConfig({ NODE_ENV: "test" });
    prisma = createPrismaClient(testDbUrl);
    // 清理测试数据（仅发生在确认安全的 *_test 库）
    await prisma.recipientState.deleteMany();
    await prisma.senderState.deleteMany();
    await prisma.letter.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.block.deleteMany();
    await prisma.user.deleteMany();
    app = buildApp(config, { prisma });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  function register(body: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: body,
    });
  }

  /** 解码 JWT payload（不校验签名，仅读取 payload）。 */
  function decodeJwt(token: string): { sub?: string; id?: unknown } {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      throw new Error("invalid jwt");
    }
    const payloadB64 = parts[1];
    // base64url → base64（JWT 用 -_ 替代 +/）
    const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  }

  it("成功注册，account 自动小写，返回安全视图与 token", async () => {
    const res = await register({
      account: "XiangShen",
      password: "example-password",
      nickname: "香神",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.account).toBe("xiangshen"); // 自动小写
    expect(body.user.uid).toMatch(/^[1-9][0-9]{7}$/); // 8 位，首位非 0
    expect(body.user.nickname).toBe("香神");
    expect(body.user.region).toEqual({ province: "上海市", city: "上海市", district: "徐汇区" });
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.user.id).toBeUndefined();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it("Access Token 的 JWT sub 为对外 UID，不包含 internal id", async () => {
    const res = await register({
      account: "uidprobe",
      password: "uidprobe-pass",
      nickname: "UID探测",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const uid = body.user.uid as string;
    expect(uid).toMatch(/^[1-9][0-9]{7}$/);

    const payload = decodeJwt(body.accessToken);
    // sub 必须为 8 位 UID，且等于该用户对外 uid
    expect(payload.sub).toBe(uid);
    expect(payload.sub).toMatch(/^[1-9][0-9]{7}$/);
    // payload 不得包含 internal BIGINT id
    expect(payload.id).toBeUndefined();
  });

  it("禁止注册 8 位数字 account（避免与 UID 歧义）", async () => {
    const res = await register({
      account: "59093690",
      password: "numeric-pass-1",
      nickname: "数字账号",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    expect(res.statusCode).toBe(400); // validation_error
  });

  it("nickname 按 Unicode code point 限制 20 个字符", async () => {
    const allowed = await register({
      account: "emoji_nick_ok",
      password: "emoji-nick-pass",
      nickname: "😀".repeat(20),
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    expect(allowed.statusCode).toBe(201);

    const rejected = await register({
      account: "emoji_nick_over",
      password: "emoji-nick-pass",
      nickname: "😀".repeat(21),
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe("validation_error");
  });

  it("密码以非明文哈希保存", async () => {
    const user = await prisma.user.findUnique({ where: { account: "xiangshen" } });
    expect(user).not.toBeNull();
    const hash = user?.passwordHash ?? "";
    expect(hash).not.toBe("example-password");
    expect(hash.startsWith("$argon2")).toBe(true);
  });

  it("重复 account 注册返回明确错误", async () => {
    const res = await register({
      account: "xiangshen",
      password: "another-password-1",
      nickname: "香神2",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("account_already_exists");
  });

  it("正确密码登录成功，返回 token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { account: "xiangshen", password: "example-password" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.account).toBe("xiangshen");
  });

  it("错误密码登录失败", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { account: "xiangshen", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refresh 成功签发新 access token", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { account: "xiangshen", password: "example-password" },
    });
    const { refreshToken } = login.json();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
  });

  it("logout 后 refresh token 不可继续使用", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { account: "xiangshen", password: "example-password" },
    });
    const { refreshToken } = login.json();
    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refreshToken },
    });
    expect(logout.statusCode).toBe(200);

    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it("malformed JSON 返回 400 validation_error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { "content-type": "application/json" },
      payload: '{ "account": "broken', // 非法 JSON
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
  });
});
