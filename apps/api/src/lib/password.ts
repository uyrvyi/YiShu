import argon2 from "argon2";

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
