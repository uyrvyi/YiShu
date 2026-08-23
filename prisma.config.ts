import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * 驿书 V1 Prisma 7 配置文件。
 *
 * - schema 指向根目录 prisma/schema.prisma
 * - 数据库连接由 DATABASE_URL 提供
 * - Phase 1 不包含业务模型；后续 Phase 按规范补充
 * - datasource.url 使用带默认回退的 process.env，保证 `prisma generate` 不依赖
 *   真实私密 `.env`（干净 clone / CI 下也能生成 client）。
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://yishu:yishu@localhost:5432/yishu?schema=public",
  },
});
