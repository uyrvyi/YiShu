import { loadConfig } from "@yishu/config";
import { createPrismaClient } from "@yishu/db";
import { buildApp } from "./app.js";

const config = loadConfig();
// API 共享的 PostgreSQL Prisma Client（惰性连接，构造不触发连接）。
const prisma = createPrismaClient(config.DATABASE_URL);
const app = buildApp(config, { prisma });

async function main(): Promise<void> {
  try {
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
  } catch (err) {
    app.log.error(err);
    await prisma.$disconnect();
    process.exit(1);
  }
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void main();
