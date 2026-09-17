import { describe, expect, it } from "vitest";
import {
  JOB_ATTEMPTS,
  QUEUES,
  RECONCILE_INTERVAL_MS,
  WAKE_INTERVAL_MS,
  redisConnection,
} from "./queue.js";

describe("Phase 9 queue contract", () => {
  it("has separate stable queues and bounded retries", () => {
    expect(new Set(Object.values(QUEUES)).size).toBe(3);
    expect(JOB_ATTEMPTS).toBe(5);
    expect(WAKE_INTERVAL_MS).toBe(5000);
    expect(RECONCILE_INTERVAL_MS).toBe(30000);
  });
  it("parses an isolated Redis database and TLS without leaking config", () => {
    expect(redisConnection("rediss://localhost:6380/15")).toMatchObject({
      host: "localhost",
      port: 6380,
      db: 15,
      tls: {},
      maxRetriesPerRequest: null,
    });
    expect(() => redisConnection("http://localhost")).toThrow("invalid_redis_configuration");
  });
});
