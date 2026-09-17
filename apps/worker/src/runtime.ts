import { Worker, UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";
import type { PrismaClient } from "@yishu/db";
import type { SimulationClock } from "@yishu/simulation";
import { QUEUES, RECONCILE_INTERVAL_MS, createQueues, redisConnection } from "./queue.js";
import { processJourney, reconcile } from "./scheduler.js";
import { checkPushReceipts, deliverPush } from "./push-processor.js";
import type { PushProvider } from "./push-provider.js";

const DOMAIN_ERRORS = new Set([
  "UnknownRulesVersionError",
  "UnknownGraphVersionError",
  "NoRouteError",
  "LetterNotFoundError",
  "JourneyNotFoundError",
]);
/** BullMQ stores thrown messages. Strip driver/provider details before crossing that boundary. */
async function safely(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    if (DOMAIN_ERRORS.has(name)) throw new UnrecoverableError(name);
    if (error instanceof Error && error.message.startsWith("unknown_node:"))
      throw new UnrecoverableError("InvalidGraphNode");
    throw new Error("worker_operation_failed");
  }
}

export async function startWorkerRuntime(options: {
  db: PrismaClient;
  redisUrl: string;
  clock: SimulationClock;
  provider: PushProvider;
  prefix?: string;
  onError?: (kind: string) => void;
}) {
  const { db, clock, provider } = options;
  const connection = redisConnection(options.redisUrl);
  // Fail startup promptly when Redis is unavailable, before creating long-lived resources.
  // BullMQ's own connections intentionally keep retrying after a successful startup.
  const probe = new Redis(options.redisUrl, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
    await db.$queryRaw`SELECT 1`;
  } catch {
    throw new Error("worker_dependency_unavailable");
  } finally {
    probe.disconnect();
  }
  const prefix = options.prefix ?? "yishu";
  const queues = createQueues(connection, prefix);
  const onError = () => options.onError?.("worker_resource_error");
  Object.values(queues).forEach((q) => q.on("error", onError));
  const workers = [
    new Worker<{ journeyId: string }>(
      QUEUES.journey,
      (job) => safely(() => processJourney(db, queues, clock, BigInt(job.data.journeyId))),
      { connection, prefix, concurrency: 4 }
    ),
    new Worker<{ dispatchId: string }>(
      QUEUES.push,
      (job) => safely(() => deliverPush(db, clock, provider, BigInt(job.data.dispatchId))),
      { connection, prefix, concurrency: 4 }
    ),
    new Worker(
      QUEUES.reconcile,
      () =>
        safely(async () => {
          await reconcile(db, queues, clock);
          await checkPushReceipts(db, provider);
        }),
      { connection, prefix, concurrency: 1 }
    ),
  ];
  workers.forEach((w) => {
    w.on("error", onError);
    w.on("failed", () => options.onError?.("job_failed"));
  });
  let closing: Promise<void> | null = null;
  const reconcileClient = queues.reconcile.getBackend();
  const repairScheduler = async () => {
    await queues.reconcile.upsertJobScheduler(
      "bootstrap",
      { every: RECONCILE_INTERVAL_MS },
      { name: "reconcile", data: {} }
    );
    await queues.reconcile.add("reconcile", {}, { jobId: "startup" });
  };
  const onReconnect = () => {
    if (!closing) void repairScheduler().catch(onError);
  };
  reconcileClient.on("ready", onReconnect);
  const close = () =>
    (closing ??= (async () => {
      reconcileClient.off("ready", onReconnect);
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(Object.values(queues).map((q) => q.close()));
      // The caller owns Prisma; index closes it after the runtime.
    })());
  try {
    await Promise.all(workers.map((w) => w.waitUntilReady()));
    await repairScheduler();
  } catch (error) {
    await close();
    throw error;
  }
  return { queues, workers, close };
}
