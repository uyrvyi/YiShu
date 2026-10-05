import { loadConfig } from "@yishu/config";
import { createPrismaClient } from "@yishu/db";
import { buildApp } from "./app.js";
import { createAuthRateLimitRedis } from "./lib/auth-rate-limit-redis.js";
import { cleanupExpiredMedia, startMediaCleanup } from "./lib/media-cleanup.js";

const config = loadConfig();
// API 共享的 PostgreSQL Prisma Client（惰性连接，构造不触发连接）。
const prisma = createPrismaClient(config.DATABASE_URL);
const rateLimitRedis = createAuthRateLimitRedis(config.REDIS_URL);
const readinessCheck = async () => {
  await Promise.all([prisma.$queryRaw`SELECT 1`, rateLimitRedis.ping()]);
};
const app = buildApp(config, { prisma, rateLimitRedis, readinessCheck });
let stopCleanup: (() => Promise<void>) | undefined;
app.addHook("onClose", async () => {
  await stopCleanup?.();
});

async function main(): Promise<void> {
  try {
    await rateLimitRedis.connect();
    await readinessCheck();
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
    stopCleanup = startMediaCleanup(
      () => cleanupExpiredMedia(prisma, config.MEDIA_STORAGE_DIR),
      () => app.log.warn({ errorClass: "MediaCleanupError" }, "media_cleanup_failed")
    );
  } catch (err) {
    app.log.error(
      { errorClass: err instanceof Error ? err.name : "UnknownError" },
      "startup_failed"
    );
    await app.close();
    rateLimitRedis.disconnect();
    await prisma.$disconnect();
    process.exit(1);
  }
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  rateLimitRedis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void main();
