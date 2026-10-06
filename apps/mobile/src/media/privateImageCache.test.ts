import { describe, expect, it, vi } from "vitest";
import { createPrivateImageCache } from "./privateImageCache";

function deferred() {
  let resolve!: (data: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

describe("letter-scoped private image cache", () => {
  it("starts every image together, displays each completion independently, and deduplicates loads", async () => {
    const requests = Array.from({ length: 9 }, () => deferred());
    const ids = requests.map((_, index) => `image-${index}`);
    const loadImage = vi.fn((id: string) => requests[ids.indexOf(id)].promise);
    const cache = createPrivateImageCache({ ids, loadImage, sameSession: () => true });
    cache.preload();
    cache.preload();
    await Promise.resolve();
    expect(loadImage.mock.calls.map(([id]) => id)).toEqual(ids);
    requests[4].resolve("data:image/jpeg;base64,four");
    await vi.waitFor(() =>
      expect(cache.read(ids[4])).toEqual({ status: "ready", data: "data:image/jpeg;base64,four" })
    );
    expect(cache.read(ids[0])).toEqual({ status: "loading" });
    requests.forEach((request, index) => request.resolve(`pixels-${index}`));
    await vi.waitFor(() => expect(cache.read(ids[8])?.status).toBe("ready"));
    for (const id of [...ids, ...ids.slice().reverse()])
      expect(cache.read(id)?.status).toBe("ready");
    cache.preload();
    cache.retry(ids[4]);
    expect(loadImage).toHaveBeenCalledTimes(9);
    cache.dispose();
  });

  it("retries only the failed image, retaining successful neighbors", async () => {
    const loadImage = vi.fn(async (id: string) => {
      if (id === "bad" && loadImage.mock.calls.filter(([key]) => key === "bad").length === 1)
        throw new Error("network");
      return `pixels-${id}`;
    });
    const cache = createPrivateImageCache({
      ids: ["good", "bad"],
      loadImage,
      sameSession: () => true,
    });
    cache.preload();
    await vi.waitFor(() => expect(cache.read("bad")?.status).toBe("failed"));
    expect(cache.read("good")).toEqual({ status: "ready", data: "pixels-good" });
    cache.retry("bad");
    cache.retry("bad");
    await vi.waitFor(() =>
      expect(cache.read("bad")).toEqual({ status: "ready", data: "pixels-bad" })
    );
    expect(loadImage.mock.calls).toEqual([["good"], ["bad"], ["bad"]]);
    cache.dispose();
  });

  it("erases ready pixels and ignores in-flight results after leaving the letter", async () => {
    const request = deferred();
    const cache = createPrivateImageCache({
      ids: ["ready", "pending"],
      loadImage: (id) => (id === "ready" ? Promise.resolve("secret") : request.promise),
      sameSession: () => true,
    });
    cache.preload();
    await vi.waitFor(() => expect(cache.read("ready")?.status).toBe("ready"));
    cache.dispose();
    request.resolve("late-secret");
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.read("ready")).toBeUndefined();
    expect(cache.read("pending")).toBeUndefined();
    cache.retry("pending");
    expect(cache.read("pending")).toBeUndefined();
  });

  it("hides pixels immediately after account invalidation and does not publish old responses", async () => {
    let sameSession = true;
    const request = deferred();
    const cache = createPrivateImageCache({
      ids: ["ready", "pending"],
      loadImage: (id) => (id === "ready" ? Promise.resolve("secret") : request.promise),
      sameSession: () => sameSession,
    });
    cache.preload();
    await vi.waitFor(() => expect(cache.read("ready")?.status).toBe("ready"));
    const version = cache.getVersion();
    sameSession = false;
    request.resolve("other-account-secret");
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.read("ready")).toBeUndefined();
    expect(cache.read("pending")).toBeUndefined();
    expect(cache.getVersion()).toBe(version);
    cache.dispose();
  });

  it("supports development effect replay without accepting pre-cleanup responses", async () => {
    const old = deferred();
    const fresh = deferred();
    const loadImage = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const cache = createPrivateImageCache({ ids: ["one"], loadImage, sameSession: () => true });
    cache.preload();
    await Promise.resolve();
    cache.dispose();
    cache.preload();
    await Promise.resolve();
    old.resolve("stale");
    fresh.resolve("fresh");
    await vi.waitFor(() => expect(cache.read("one")).toEqual({ status: "ready", data: "fresh" }));
    expect(loadImage).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it("does not request pixels from a different letter and publishes cache changes to the mounted page", async () => {
    const loadImage = vi.fn(async () => "pixels");
    const cache = createPrivateImageCache({
      ids: ["one", "one"],
      loadImage,
      sameSession: () => true,
    });
    const notify = vi.fn();
    const unsubscribe = cache.subscribe(notify);
    cache.retry("another-letter");
    cache.preload();
    await vi.waitFor(() => expect(cache.read("one")?.status).toBe("ready"));
    expect(loadImage).toHaveBeenCalledOnce();
    expect(loadImage).toHaveBeenCalledWith("one");
    expect(cache.read("another-letter")).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
    cache.dispose();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
