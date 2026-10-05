import { afterEach, describe, expect, it, vi } from "vitest";
import { startMediaCleanup } from "./media-cleanup.js";

afterEach(() => vi.useRealTimers());

describe("periodic media cleanup lifecycle", () => {
  it("starts immediately, never overlaps batches and waits for active cleanup on shutdown", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const stop = startMediaCleanup(run, vi.fn());
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledOnce();
    let stopped = false;
    const pending = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await pending;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledOnce();
  });
  it("reports a failed batch and retries after one minute", async () => {
    vi.useFakeTimers();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup failure"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startMediaCleanup(run, onError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
    await stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
