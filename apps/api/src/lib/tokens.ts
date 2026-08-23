import { createHash, randomBytes } from "node:crypto";

/**
 * Refresh Token 工具（对应开发规范 §5）。
 *
 * - Refresh Token 为随机 opaque token（30 天）。
 * - 数据库只保存 Token Hash（SHA-256），明文 token 永不落库、永不写入日志。
 */

/** 生成随机 opaque Refresh Token（256 位，hex 编码）。 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

/** 计算 Refresh Token 的 SHA-256 哈希（用于持久化）。 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
