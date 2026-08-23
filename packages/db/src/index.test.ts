import { describe, expect, it } from "vitest";
import { createPrismaClient, pingDatabase, PrismaClient } from "./index.js";

describe("@yishu/db", () => {
  it("导出 PrismaClient 与工厂函数", () => {
    expect(typeof createPrismaClient).toBe("function");
    expect(typeof pingDatabase).toBe("function");
    expect(PrismaClient).toBeDefined();
  });

  it("可构造 PostgreSQL adapter + PrismaClient 并正常 disconnect（无需 DB 在线）", async () => {
    const client = createPrismaClient(
      "postgresql://yishu:yishu@localhost:5432/yishu?schema=public"
    );
    expect(client).toBeDefined();
    // 构造为惰性连接，不依赖 PostgreSQL 在线。
    await client.$disconnect();
  });
});
