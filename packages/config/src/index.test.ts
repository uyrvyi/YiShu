import { describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "./index.js";

describe("loadConfig", () => {
  it("返回默认基础设施配置（development）", () => {
    const cfg = loadConfig({});
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.API_PORT).toBe(4000);
    expect(cfg.API_HOST).toBe("0.0.0.0");
    expect(cfg.DATABASE_URL).toContain("postgresql://");
    expect(cfg.REDIS_URL).toContain("redis://");
  });

  it("读取显式 API 端口与主机（production 显式提供连接串）", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      API_PORT: "8080",
      API_HOST: "127.0.0.1",
      DATABASE_URL: "postgresql://u:p@db:5432/app?schema=public",
      REDIS_URL: "redis://redis:6379",
      JWT_SECRET: "a-very-long-production-jwt-secret-123456",
      CONTENT_ENCRYPTION_KEY: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    });
    expect(cfg.API_PORT).toBe(8080);
    expect(cfg.API_HOST).toBe("127.0.0.1");
    expect(cfg.DATABASE_URL).toBe("postgresql://u:p@db:5432/app?schema=public");
  });

  it("production 未显式提供 DATABASE_URL 抛错", () => {
    expect(() => loadConfig({ NODE_ENV: "production", REDIS_URL: "redis://redis:6379" })).toThrow();
  });

  it("production 未显式提供 REDIS_URL 抛错", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://u:p@db:5432/app?schema=public",
      })
    ).toThrow();
  });

  it("production 未显式提供 JWT_SECRET 抛错", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://u:p@db:5432/app?schema=public",
        REDIS_URL: "redis://redis:6379",
        CONTENT_ENCRYPTION_KEY: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      })
    ).toThrow();
  });

  it("production 未显式提供 CONTENT_ENCRYPTION_KEY 抛错", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://u:p@db:5432/app?schema=public",
        REDIS_URL: "redis://redis:6379",
        JWT_SECRET: "a-very-long-production-jwt-secret-123456",
      })
    ).toThrow();
  });

  it("非法 NODE_ENV 抛错", () => {
    expect(() => loadConfig({ NODE_ENV: "unknown" as string })).toThrow();
  });

  it("非法 API_PORT（非数字）抛错", () => {
    expect(() => loadConfig({ API_PORT: "abc" })).toThrow();
  });

  it("非法 DATABASE_URL 格式抛错", () => {
    expect(() => loadConfig({ DATABASE_URL: "not-a-url" })).toThrow();
  });

  it("非法 REDIS_URL 格式抛错", () => {
    expect(() => loadConfig({ REDIS_URL: "not-a-url" })).toThrow();
  });

  it("DATABASE_URL 缺 hostname 抛错", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql:///app?schema=public" })).toThrow();
  });

  it("DATABASE_URL 缺 database 抛错", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql://localhost:5432" })).toThrow();
  });

  it("DATABASE_URL 错误 protocol 抛错", () => {
    expect(() => loadConfig({ DATABASE_URL: "mysql://localhost:3306/app" })).toThrow();
  });

  it("REDIS_URL 缺 hostname 抛错", () => {
    expect(() => loadConfig({ REDIS_URL: "redis://" })).toThrow();
  });

  it("REDIS_URL 错误 protocol 抛错", () => {
    expect(() => loadConfig({ REDIS_URL: "http://localhost:6379" })).toThrow();
  });

  it("合法连接串通过校验", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://user:pass@db.internal:5432/appdb",
      REDIS_URL: "rediss://redis.internal:6379",
    });
    expect(cfg.DATABASE_URL).toBe("postgres://user:pass@db.internal:5432/appdb");
    expect(cfg.REDIS_URL).toBe("rediss://redis.internal:6379");
  });
});

describe("requireTestDatabaseUrl", () => {
  it("TEST_DATABASE_URL 指向 *_test 库 → 允许", () => {
    const url = requireTestDatabaseUrl({
      TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/yishu_test?schema=public",
    });
    expect(url).toContain("yishu_test");
  });

  it("TEST_DATABASE_URL 指向开发库（无 _test）→ 拒绝", () => {
    expect(() =>
      requireTestDatabaseUrl({
        TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/yishu?schema=public",
      })
    ).toThrow(/must point to a \*_test database/);
  });

  it("缺少 TEST_DATABASE_URL → 拒绝（禁止 fallback 到 DATABASE_URL）", () => {
    expect(() =>
      requireTestDatabaseUrl({
        DATABASE_URL: "postgresql://u:p@localhost:5432/yishu?schema=public",
      })
    ).toThrow(/TEST_DATABASE_URL is required/);
  });
});
