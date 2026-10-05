import { describe, expect, it } from "vitest";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./password.js";

describe("password hashing (Argon2id)", () => {
  it("生成非明文哈希", async () => {
    const hash = await hashPassword("super-secret-pass");
    expect(hash).not.toBe("super-secret-pass");
    expect(hash.startsWith("$argon2")).toBe(true);
  });

  it("正确密码验证通过", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword("correct-password", hash)).toBe(true);
  });

  it("错误密码验证失败", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("missing-account placeholder is valid and has the current password cost", async () => {
    const hash = await hashPassword("current-cost-probe");
    expect(DUMMY_PASSWORD_HASH.split("$").slice(1, 4)).toEqual(hash.split("$").slice(1, 4));
    expect(await verifyPassword("wrong-password", DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
