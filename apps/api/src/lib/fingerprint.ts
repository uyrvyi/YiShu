import { createHash, randomBytes } from "node:crypto";
import type { TransportType } from "@yishu/shared";

/**
 * 请求指纹（requestFingerprint）与确定性 Seed 生成。
 */

/** 计算请求指纹：规范化 recipient UID + content + transportType 的 SHA-256。 */
export function computeRequestFingerprint(input: {
  recipientUid: string;
  content: string;
  transportType: TransportType;
  writtenAt?: string;
  imageIds?: string[];
}): string {
  const hash = createHash("sha256")
    .update(input.recipientUid)
    .update("\u0000")
    .update(input.content)
    .update("\u0000")
    .update(input.transportType);
  // Keep old-client retries compatible with their stored pre-media fingerprint.
  if (input.writtenAt !== undefined || (input.imageIds?.length ?? 0) > 0) {
    hash.update("\u0000").update(
      JSON.stringify({
        writtenAt: input.writtenAt ? new Date(input.writtenAt).toISOString() : null,
        imageIds: input.imageIds ?? [],
      })
    );
  }
  return hash.digest("hex");
}

/** 生成密码学安全随机 simulation seed（32 字节 hex）。 */
export function generateSimulationSeed(): string {
  return randomBytes(32).toString("hex");
}
