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
}): string {
  return createHash("sha256")
    .update(input.recipientUid)
    .update("\u0000")
    .update(input.content)
    .update("\u0000")
    .update(input.transportType)
    .digest("hex");
}

/** 生成密码学安全随机 simulation seed（32 字节 hex）。 */
export function generateSimulationSeed(): string {
  return randomBytes(32).toString("hex");
}
