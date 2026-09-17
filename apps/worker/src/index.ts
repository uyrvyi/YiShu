import { loadConfig } from "@yishu/config";
import { createPrismaClient } from "@yishu/db";
import { SystemSimulationClock } from "@yishu/simulation";
import { pino } from "pino";
import { ExpoPushProvider } from "./push-provider.js";
import { startWorkerRuntime } from "./runtime.js";

const log = pino();
async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPrismaClient(config.DATABASE_URL);
  try {
    const runtime = await startWorkerRuntime({
      db,
      redisUrl: config.REDIS_URL,
      clock: new SystemSimulationClock(1),
      provider: new ExpoPushProvider(config.EXPO_PUSH_ACCESS_TOKEN),
      onError: (kind) => log.error({ kind }, "worker_failure"),
    });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await runtime.close();
      } finally {
        await db.$disconnect();
      }
      log.info("worker_stopped");
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    log.info("worker_ready");
  } catch {
    await db.$disconnect();
    log.error("worker_start_failed");
    process.exitCode = 1;
  }
}
void main().catch(() => {
  log.error("worker_configuration_failed");
  process.exitCode = 1;
});
