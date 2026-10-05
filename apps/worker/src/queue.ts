import { Queue, type ConnectionOptions } from "bullmq";
import { createRequire } from "node:module";

export const QUEUES = {
  journey: "journey-progression",
  push: "push-delivery",
  reconcile: "reconcile",
} as const;
export const WAKE_INTERVAL_MS = 5000;
export const RECONCILE_INTERVAL_MS = 30000;
export const JOB_ATTEMPTS = 5;
export const PAGE_SIZE = 100;
export const TERMINAL = ["DELIVERED", "PERMANENTLY_LOST", "DESTROYED"] as const;
export const RETRYABLE_FAILURE = "worker_operation_failed";

// Reuse BullMQ's queue transition unchanged; pin its version because this script is internal.
const { reprocessJob } = createRequire(import.meta.url)(
  "bullmq/dist/cjs/scripts/reprocessJob-7.js"
) as { reprocessJob: { keys: number; content: string; name: string } };
if (reprocessJob.keys !== 7 || reprocessJob.name !== "reprocessJob")
  throw new Error("unsupported_bullmq_recovery_contract");
const recoverableRetryScript = `
if redis.call("HGET", KEYS[1], "failedReason") ~= ARGV[7] then return 0 end
${reprocessJob.content}`;
const recoveryCommand = "yishuRecoverFailedJob";
const recoveryClients = new WeakSet<object>();

/** Reconciliation renews exhausted transient retries; domain failures remain inspectable. */
export async function enqueueRecoverableJob<Data extends object>(
  queue: Queue<Data, unknown, string, Data, unknown, string>,
  name: string,
  data: Data,
  options: { jobId: string; delay?: number }
): Promise<void> {
  const existing = await queue.getJob(options.jobId);
  if (existing) {
    if (existing.failedReason === RETRYABLE_FAILURE) {
      const client = await queue.getBackend().client;
      if (!recoveryClients.has(client)) {
        client.defineCommand(recoveryCommand, {
          numberOfKeys: reprocessJob.keys,
          lua: recoverableRetryScript,
        });
        recoveryClients.add(client);
      }
      const result: unknown = await client.runCommand(recoveryCommand, [
        queue.toKey(options.jobId),
        queue.keys.events,
        queue.keys.failed,
        queue.keys.wait,
        queue.keys.meta,
        queue.keys.active,
        queue.keys.marker,
        options.jobId,
        existing.opts.lifo ? "RPUSH" : "LPUSH",
        "failedReason",
        "failed",
        "1",
        "1",
        RETRYABLE_FAILURE,
      ]);
      // The current reason and failed -> waiting transition execute in one Redis script.
      if (![0, 1, -1, -3].includes(Number(result))) throw new Error("job_recovery_failed");
    }
    return;
  }
  await queue.add(name, data, options);
}

/** Parse centrally-provided URL; BullMQ owns and closes its Redis clients. Never log options. */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  const db = u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0;
  if (!["redis:", "rediss:"].includes(u.protocol) || !Number.isInteger(db) || db < 0) {
    throw new Error("invalid_redis_configuration");
  }
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export function createQueues(connection: ConnectionOptions, prefix = "yishu") {
  const options = {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
      removeOnFail: false,
      // Only sanitized error messages reach BullMQ failure metadata.
      stackTraceLimit: 0,
    },
  };
  return {
    journey: new Queue<{ journeyId: string }>(QUEUES.journey, options),
    push: new Queue<{ dispatchId: string }>(QUEUES.push, options),
    reconcile: new Queue(QUEUES.reconcile, options),
  };
}
export type Queues = ReturnType<typeof createQueues>;
