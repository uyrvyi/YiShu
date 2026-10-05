import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startHeartbeat } from "./heartbeat.js";

describe("Worker heartbeat", () => {
  it("updates only while dependencies are healthy and removes on stop", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "yishu-heartbeat-"));
    const filename = path.join(directory, "heartbeat");
    const stop = startHeartbeat(async () => {}, filename);
    try {
      await vi.waitFor(async () =>
        expect(Number(await readFile(filename, "utf8"))).toBeGreaterThan(0)
      );
      await stop();
      await expect(readFile(filename)).rejects.toThrow();
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("failed dependency never creates a healthy heartbeat", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "yishu-heartbeat-"));
    const filename = path.join(directory, "heartbeat");
    const check = vi.fn(async () => {
      throw new Error("REDIS_SECRET");
    });
    const stop = startHeartbeat(check, filename);
    try {
      await stop();
      expect(check).toHaveBeenCalledOnce();
      await expect(readFile(filename)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
