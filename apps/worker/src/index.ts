import { loadConfig } from "@yishu/config";
import { WORKER_NAME } from "./constants.js";

/**
 * 驿书 V1 Simulation Worker。
 *
 * Phase 1 仅提供可启动骨架。BullMQ / Redis 消费者将在 Phase 6 实现。
 *
 * 日志安全：不得输出任何含用户名/密码/token 的完整连接串（如 REDIS_URL / DATABASE_URL）。
 */

function main(): void {
  const config = loadConfig();
  const hasRedis = config.REDIS_URL.length > 0;
  process.stdout.write(
    `[worker] ${WORKER_NAME} 已启动 (env=${config.NODE_ENV}, redis=${hasRedis ? "configured" : "missing"})\n`
  );
}

main();
