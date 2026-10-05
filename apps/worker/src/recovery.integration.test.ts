import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Worker, UnrecoverableError } from "bullmq";
import { loadConfig } from "@yishu/config";
import {
  RETRYABLE_FAILURE,
  createQueues,
  enqueueRecoverableJob,
  redisConnection,
  type Queues,
} from "./queue.js";

describe("Phase 11 atomic failed-job recovery", () => {
  const redisUrl = loadConfig({ ...process.env, NODE_ENV: "test" }).REDIS_URL;
  const resources: { queues: Queues; worker: Pick<Worker, "close"> }[] = [];

  afterEach(async () => {
    for (const { queues, worker } of resources.splice(0)) {
      await worker.close();
      try {
        await Promise.all(Object.values(queues).map((queue) => queue.obliterate({ force: true })));
      } finally {
        await Promise.all(Object.values(queues).map((queue) => queue.close()));
      }
    }
  });

  it.each([1, 2])(
    "does not retry a new domain failure from a stale transient snapshot, round %s",
    async () => {
      const prefix = `yishu-test-recovery-${randomUUID()}`;
      const queues = createQueues(redisConnection(redisUrl), prefix);
      const jobId = "reason-transition-race";
      const data = { journeyId: "1" };
      let calls = 0;
      const worker = new Worker(
        queues.journey.name,
        async () => {
          calls += 1;
          if (calls === 1) throw new Error(RETRYABLE_FAILURE);
          throw new UnrecoverableError("UnknownRulesVersionError");
        },
        { connection: redisConnection(redisUrl), prefix }
      );
      resources.push({ queues, worker });
      await worker.waitUntilReady();
      await queues.journey.add("advance", data, { jobId, attempts: 1 });
      await vi.waitFor(async () => {
        expect(await (await queues.journey.getJob(jobId))?.getState()).toBe("failed");
      });
      const stale = await queues.journey.getJob(jobId);
      if (!stale) throw new Error("missing_failed_job");
      expect(stale.failedReason).toBe(RETRYABLE_FAILURE);
      const delayedQueue = new Proxy(queues.journey, {
        get(target, property) {
          if (property === "getJob")
            return async () => {
              await enqueueRecoverableJob(queues.journey, "advance", data, { jobId });
              await vi.waitFor(async () => {
                const current = await queues.journey.getJob(jobId);
                expect(await current?.getState()).toBe("failed");
                expect(current?.failedReason).toBe("UnknownRulesVersionError");
                expect(calls).toBe(2);
              });
              return stale;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await enqueueRecoverableJob(delayedQueue, "advance", data, { jobId });
      const final = await queues.journey.getJob(jobId);
      expect(await final?.getState()).toBe("failed");
      expect(final?.failedReason).toBe("UnknownRulesVersionError");
      expect(final?.attemptsMade).toBe(1);
      expect(calls).toBe(2);
    }
  );
});
