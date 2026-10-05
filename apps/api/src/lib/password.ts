import argon2 from "argon2";

// Non-secret placeholder using the same Argon2id cost as hashPassword.
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$Jar/9pNZ+WQDjDkzmZEgzQ$BI7QC5XrIw2s+B5nojMq7vmbQy5mhZyIbHYcpFzeu3Q";

/**
 * 密码哈希（Argon2id）。
 * 禁止明文保存密码。日志 / 错误响应不得包含密码或哈希。
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * 校验密码与哈希是否匹配。
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, password);
}
