import type { UploadImageInput } from "./letterApi";

export type UploadProgressCallback = (fraction: number | null) => void;
export interface ImageUploadRequestInit extends RequestInit {
  imageUpload?: { image: UploadImageInput; onProgress: UploadProgressCallback };
}

function assertImageUploadNotAborted(signal: AbortSignal | null | undefined) {
  // React Native's AbortSignal polyfill does not implement throwIfAborted.
  if (signal?.aborted) throw signal.reason ?? new Error("Upload aborted");
}

// Route only progress-enabled uploads through the native file transfer API.
// Authentication, refresh and session fencing remain in createAuthenticatedFetch.
export const imageUploadFetch: typeof fetch = async (input, init) => {
  const upload = (init as ImageUploadRequestInit | undefined)?.imageUpload;
  if (!upload) return fetch(input, init);
  const signal = init?.signal;
  assertImageUploadNotAborted(signal);
  const { createUploadTask, FileSystemUploadType, FileSystemSessionType } =
    await import("expo-file-system/legacy");
  assertImageUploadNotAborted(signal);
  upload.onProgress(0);
  const url = typeof input === "string" ? input : "url" in input ? input.url : String(input);
  let settled = false;
  let completed = false;
  let cancelled = false;
  const task = createUploadTask(
    url,
    upload.image.uri,
    {
      httpMethod: "POST",
      uploadType: FileSystemUploadType.MULTIPART,
      sessionType: FileSystemSessionType.FOREGROUND,
      fieldName: "image",
      mimeType: upload.image.mimeType,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    },
    ({ totalBytesSent, totalBytesExpectedToSend }) => {
      if (settled || signal?.aborted) return;
      upload.onProgress(
        totalBytesExpectedToSend > 0 &&
          Number.isFinite(totalBytesExpectedToSend) &&
          Number.isFinite(totalBytesSent)
          ? Math.max(0, Math.min(1, totalBytesSent / totalBytesExpectedToSend))
          : null
      );
    }
  );
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void task.cancelAsync().catch(() => undefined);
  };
  let abort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      settled = true;
      cancel();
      reject(signal?.reason ?? new Error("Upload aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    if (signal?.aborted) abort();
    const result = await Promise.race([task.uploadAsync(), aborted]);
    if (!result) throw new TypeError("Network upload interrupted");
    completed = true;
    return new Response(result.body, { status: result.status, headers: result.headers });
  } finally {
    settled = true;
    signal?.removeEventListener("abort", abort);
    // uploadAsync already detaches on success; failed cleanup must not delay the result.
    if (!completed) cancel();
  }
};
