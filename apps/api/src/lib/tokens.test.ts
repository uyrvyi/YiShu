import { describe, expect, it } from "vitest";
import { generateRefreshToken, hashRefreshToken } from "./tokens.js";

describe("refresh token utilities", () => {
  it("生成随机 opaque token", () => {
    const token = generateRefreshToken();
    expect(token.length).toBeGreaterThan(0);
  });

  it("token 哈希为定长 SHA-256 hex", () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token); // 明文 token 不落库
  });

  it("相同 token 产生相同哈希", () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });
});
