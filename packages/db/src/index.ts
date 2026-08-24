import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../../generated/prisma/client.js";

/**
 * 驿书 V1 Prisma PostgreSQL Runtime 入口。
 *
 * - 使用 Prisma 7 driver adapter（@prisma/adapter-pg + pg）。
 * - 提供可复用的 Prisma Client 工厂，API / Worker 均可安全复用。
 * - 暴露 Prisma 命名空间（含错误类型，用于唯一约束等判断）。
 * - generated client 由 tsc 编译进本包 dist，Node 生产可直接运行（无需 tsx）。
 */

export { Prisma, PrismaClient };
export type {
  User,
  Block,
  RefreshToken,
  Letter,
  RecipientState,
  SenderState,
  Journey,
  JourneyStatus,
  TransportLeg,
  TransportLegStatus,
  TransportType,
} from "../../../generated/prisma/client.js";

/**
 * 创建 PostgreSQL Prisma Client 实例。
 * @param databaseUrl PostgreSQL 连接串（来自 @yishu/config 的 DATABASE_URL）。
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

/**
 * 对 PostgreSQL 执行一次连接健康检查。
 * @param databaseUrl PostgreSQL 连接串。
 * @returns 连接成功返回 true；否则抛出错误。
 */
export async function pingDatabase(databaseUrl: string): Promise<boolean> {
  const prisma = createPrismaClient(databaseUrl);
  try {
    // 不依赖业务表，执行 `SELECT 1` 验证连接。
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } finally {
    await prisma.$disconnect();
  }
}
