import { Queue, type ConnectionOptions } from "bullmq";

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
