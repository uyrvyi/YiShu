import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createAuthenticatedFetch, AuthExpiredError } from "./authenticatedFetch";

// Use React Native's installed polyfill, not Node's newer AbortSignal implementation.
const require = createRequire(import.meta.url);
const nativeRequire = createRequire(realpathSync(require.resolve("react-native/package.json")));
const NativeAbortController = nativeRequire("abort-controller").AbortController as {
  new (): { signal: AbortSignal; abort(): void };
};

const native = vi.hoisted(() => ({ create: vi.fn(), upload: vi.fn(), cancel: vi.fn() }));
vi.mock("expo-file-system/legacy", () => ({
  createUploadTask: native.create,
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { FOREGROUND: 0 },
}));
import { imageUploadFetch, type ImageUploadRequestInit } from "./imageUploadFetch";

const image = { uri: "file:///cache/photo.jpg", name: "photo.jpg", mimeType: "image/jpeg" };
const url = "https://example.test/api/v1/media/images";
function options(progress = vi.fn()): ImageUploadRequestInit {
  return {
    method: "POST",
    headers: { authorization: "Bearer token" },
    imageUpload: { image, onProgress: progress },
  };
}
function event(sent: number, total: number) {
  native.create.mock.calls.at(-1)?.[3]({ totalBytesSent: sent, totalBytesExpectedToSend: total });
}
beforeEach(() => {
  vi.resetAllMocks();
  native.cancel.mockResolvedValue(undefined);
  native.upload.mockResolvedValue({
    status: 201,
    headers: { "content-type": "application/json" },
    body: '{"image":{"id":"created"}}',
  });
  native.create.mockReturnValue({ uploadAsync: native.upload, cancelAsync: native.cancel });
});
afterEach(() => vi.unstubAllGlobals());

describe("authenticated native image upload progress", () => {
  it("uploads with React Native's AbortSignal without throwIfAborted", async () => {
    const controller = new NativeAbortController();
    expect(controller.signal.throwIfAborted).toBeUndefined();
    const response = await imageUploadFetch(url, { ...options(), signal: controller.signal });
    expect(response.status).toBe(201);
    expect(native.upload).toHaveBeenCalledOnce();
  });
  it("rejects an already-aborted native signal without a reason", async () => {
    const controller = new NativeAbortController();
    controller.abort();
    expect(controller.signal.reason).toBeUndefined();
    await expect(
      imageUploadFetch(url, { ...options(), signal: controller.signal })
    ).rejects.toThrow("Upload aborted");
    expect(native.create).not.toHaveBeenCalled();
  });
  it("cancels an in-flight upload with React Native's AbortSignal", async () => {
    const controller = new NativeAbortController();
    native.upload.mockImplementation(() => new Promise(() => {}));
    const pending = imageUploadFetch(url, { ...options(), signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("Upload aborted");
    await vi.waitFor(() => expect(native.upload).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(native.cancel).toHaveBeenCalled();
  });
  it("leaves ordinary JSON fetch unchanged", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const init = { method: "GET" };
    await imageUploadFetch(url, init);
    expect(fetch).toHaveBeenCalledWith(url, init);
    expect(native.create).not.toHaveBeenCalled();
  });
  it("uses file multipart with real byte progress, auth and no manual content-type", async () => {
    const progress = vi.fn();
    native.upload.mockImplementation(async () => {
      event(250, 1000);
      event(1000, 1000);
      return { status: 201, headers: {}, body: '{"image":{"id":"created"}}' };
    });
    const response = await imageUploadFetch(url, options(progress));
    expect(native.create).toHaveBeenCalledWith(
      url,
      image.uri,
      {
        httpMethod: "POST",
        uploadType: 1,
        sessionType: 0,
        fieldName: "image",
        mimeType: "image/jpeg",
        headers: { authorization: "Bearer token" },
      },
      expect.any(Function)
    );
    expect(progress.mock.calls.map(([value]) => value)).toEqual([0, 0.25, 1]);
    expect(await response.json()).toEqual({ image: { id: "created" } });
    event(999, 1000);
    expect(progress).toHaveBeenCalledTimes(3);
    expect(native.cancel).not.toHaveBeenCalled();
  });
  it("never invents a percentage for missing or invalid total byte counts", async () => {
    const progress = vi.fn();
    native.upload.mockImplementation(async () => {
      event(100, -1);
      event(100, Infinity);
      event(-10, 100);
      event(110, 100);
      return { status: 201, headers: {}, body: "{}" };
    });
    await imageUploadFetch(url, options(progress));
    expect(progress.mock.calls.map(([value]) => value)).toEqual([0, null, null, 0, 1]);
  });
  it("aborts native transfer promptly and removes its listener", async () => {
    const abort = new AbortController();
    const progress = vi.fn();
    native.upload.mockImplementation(() => new Promise(() => {}));
    const pending = imageUploadFetch(url, { ...options(progress), signal: abort.signal });
    await vi.waitFor(() => expect(native.upload).toHaveBeenCalled());
    abort.abort(new Error("upload timeout"));
    await expect(pending).rejects.toThrow("upload timeout");
    expect(native.cancel).toHaveBeenCalled();
    const calls = progress.mock.calls.length;
    event(100, 100);
    expect(progress).toHaveBeenCalledTimes(calls);
  });
  it("does not start a transfer for an already-aborted request", async () => {
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(imageUploadFetch(url, { ...options(), signal })).rejects.toThrow("cancelled");
    expect(native.create).not.toHaveBeenCalled();
  });
  it("cleans progress subscription on native errors", async () => {
    native.upload.mockRejectedValue(new TypeError("Network unavailable"));
    await expect(imageUploadFetch(url, options())).rejects.toThrow("Network unavailable");
    expect(native.cancel).toHaveBeenCalledOnce();
  });
  it("does not wait for native cancellation after a successful response", async () => {
    native.cancel.mockImplementation(() => new Promise(() => {}));
    const response = await imageUploadFetch(url, options());
    expect(response.status).toBe(201);
    expect(native.cancel).not.toHaveBeenCalled();
  });
  it("detaches a failed task without blocking the error on native cancellation", async () => {
    native.upload.mockRejectedValue(new TypeError("Network unavailable"));
    native.cancel.mockImplementation(() => new Promise(() => {}));
    await expect(imageUploadFetch(url, options())).rejects.toThrow("Network unavailable");
    expect(native.cancel).toHaveBeenCalledOnce();
  });
  it("retains HTTP error status and JSON without falsely reporting success", async () => {
    native.upload.mockResolvedValue({
      status: 413,
      headers: {},
      body: '{"error":"image_too_large"}',
    });
    const response = await imageUploadFetch(url, options());
    expect(response.ok).toBe(false);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "image_too_large" });
  });
  it("keeps the existing authenticated one-refresh retry and restarts real progress", async () => {
    let token = "old";
    const refresh = vi.fn(async () => (token = "new"));
    native.upload
      .mockResolvedValueOnce({ status: 401, headers: {}, body: "{}" })
      .mockResolvedValueOnce({ status: 201, headers: {}, body: "{}" });
    const request = createAuthenticatedFetch({
      token: async () => token,
      refresh,
      invalidate: vi.fn(),
      version: () => 0,
      fetchImpl: imageUploadFetch,
    });
    const progress = vi.fn();
    expect((await request(url, options(progress))).status).toBe(201);
    expect(refresh).toHaveBeenCalledOnce();
    expect(native.create.mock.calls.map((call) => call[2].headers.authorization)).toEqual([
      "Bearer old",
      "Bearer new",
    ]);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([0, 0]);
  });
  it("cannot deliver a completed upload to a different account", async () => {
    let generation = 1;
    native.upload.mockImplementation(async () => {
      generation++;
      return { status: 201, headers: {}, body: "{}" };
    });
    const request = createAuthenticatedFetch({
      token: async () => "token",
      refresh: vi.fn(),
      invalidate: vi.fn(),
      version: () => generation,
      fetchImpl: imageUploadFetch,
    });
    await expect(request(url, options())).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
