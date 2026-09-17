import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthExpiredError } from "../api/authenticatedFetch";
import { createPoller, DETAIL_POLL_MS, HOME_POLL_MS } from "./poller";

afterEach(() => vi.useRealTimers());

function setup(load = vi.fn(async () => "value"), intervalMs = DETAIL_POLL_MS) {
  vi.useFakeTimers();
  const value = vi.fn();
  const error = vi.fn();
  const poller = createPoller({ load, intervalMs, value, error });
  return { poller, load, value, error };
}

describe("Phase 9 foreground polling", () => {
  it.each(["Detail", "Map"])("%s refreshes immediately and every five seconds", async () => {
    const { poller, load } = setup();
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(4999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("Home uses thirty seconds", async () => {
    const { poller, load } = setup(undefined, HOME_POLL_MS);
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(29999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("background stops and foreground immediately resumes", async () => {
    const { poller, load } = setup();
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    poller.setActive(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(load).toHaveBeenCalledTimes(1);
    poller.setActive(true);
    expect(load).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("unmount clears timers and ignores in-flight results", async () => {
    let finish!: (value: string) => void;
    const { poller, value, load } = setup(
      vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          })
      )
    );
    poller.setActive(true);
    poller.dispose();
    finish("stale");
    await vi.advanceTimersByTimeAsync(60000);
    expect(value).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces pending requests and rejects responses from the previous focus", async () => {
    let finish!: (value: string) => void;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    const { poller, value } = setup(load);
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(load).toHaveBeenCalledTimes(1);
    poller.setActive(false);
    poller.setActive(true);
    finish("stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(value).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
    finish("fresh");
    await vi.advanceTimersByTimeAsync(0);
    expect(value).toHaveBeenCalledWith("fresh");
    poller.dispose();
  });

  it("expired authentication stops polling without a 401 storm", async () => {
    const { poller, load, error } = setup(
      vi.fn(async () => {
        throw new AuthExpiredError();
      })
    );
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(60000);
    poller.setActive(false);
    poller.setActive(true);
    await poller.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    poller.dispose();
  });

  it("transient failures allow the next scheduled refresh", async () => {
    const load = vi.fn(async () => "ok").mockRejectedValueOnce(new Error("offline"));
    const { poller, value, error } = setup(load);
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(error).toHaveBeenCalledTimes(1);
    expect(value).toHaveBeenCalledWith("ok");
    poller.dispose();
  });

  it("a stale epoch auth failure cannot stop the current polling", async () => {
    const resolvers: ((value: string) => void)[] = [];
    const rejecters: ((error: unknown) => void)[] = [];
    const load = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          resolvers.push(resolve);
          rejecters.push(reject);
        })
    );
    const { poller, value, error } = setup(load);
    poller.setActive(true);
    poller.setActive(false);
    poller.setActive(true);
    expect(load).toHaveBeenCalledTimes(1);
    // The previous focus keeps the auth failure that must not reach the running epoch.
    rejecters[0](new AuthExpiredError());
    await vi.advanceTimersByTimeAsync(0);
    expect(error).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    resolvers[1]("fresh");
    await vi.advanceTimersByTimeAsync(0);
    expect(value).toHaveBeenCalledWith("fresh");
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_MS);
    expect(load).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it("a stale epoch normal error cannot stop or notify the current epoch", async () => {
    const resolvers: ((value: string) => void)[] = [];
    const rejecters: ((error: unknown) => void)[] = [];
    const load = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          resolvers.push(resolve);
          rejecters.push(reject);
        })
    );
    const { poller, value, error } = setup(load);
    poller.setActive(true);
    poller.setActive(false);
    poller.setActive(true);
    rejecters[0](new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
    resolvers[1]("fresh");
    await vi.advanceTimersByTimeAsync(0);
    expect(value).toHaveBeenCalledWith("fresh");
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_MS);
    expect(load).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it("a stale auth failure while backgrounded cannot block the next foreground", async () => {
    const resolvers: ((value: string) => void)[] = [];
    const rejecters: ((error: unknown) => void)[] = [];
    const load = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          resolvers.push(resolve);
          rejecters.push(reject);
        })
    );
    const { poller } = setup(load);
    poller.setActive(true);
    poller.setActive(false);
    rejecters[0](new AuthExpiredError());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    // The next foreground must still start a fresh request and a fresh timer.
    poller.setActive(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    resolvers[1]("fresh");
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_MS);
    expect(load).toHaveBeenCalledTimes(3);
    poller.dispose();
  });
});
