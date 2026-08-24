import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 正文 AES-256-GCM 应用层加密（对应开发规范 §48）。
 *
 * - 密钥来自环境 Secret（CONTENT_ENCRYPTION_KEY，32 字节 hex）。
 * - 每次加密生成随机 IV（12 字节）。
 * - 返回 ciphertext / iv / authTag，均以 hex 存储。
 * - 禁止将密钥写入日志。
 */

export interface EncryptedContent {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** 从 hex 密钥解析 AES-256 密钥缓冲（32 字节）。 */
export function keyFromHex(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("Invalid encryption key length");
  }
  return key;
}

/** 加密明文，返回 ciphertext / iv / authTag（hex）。 */
export function encryptContent(plain: string, keyHex: string): EncryptedContent {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/** 解密正文。认证失败（篡改）抛错。 */
export function decryptContent(data: EncryptedContent, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const iv = Buffer.from(data.iv, "hex");
  const authTag = Buffer.from(data.authTag, "hex");
  const encrypted = Buffer.from(data.ciphertext, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
