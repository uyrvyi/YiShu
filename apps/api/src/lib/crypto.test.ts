import { describe, expect, it } from "vitest";
import { encryptContent, decryptContent } from "./crypto.js";

const KEY = "0000000000000000000000000000000000000000000000000000000000000001";

describe("AES-256-GCM content encryption", () => {
  it("加密后不保存明文（ciphertext != 明文）", () => {
    const enc = encryptContent("今晚打游戏吗？", KEY);
    expect(enc.ciphertext).not.toBe("今晚打游戏吗？");
    expect(enc.iv).toBeTruthy();
    expect(enc.authTag).toBeTruthy();
  });

  it("解密还原明文", () => {
    const enc = encryptContent("测试正文内容", KEY);
    expect(decryptContent(enc, KEY)).toBe("测试正文内容");
  });

  it("每次加密 IV 不同（随机性）", () => {
    const a = encryptContent("same", KEY);
    const b = encryptContent("same", KEY);
    expect(a.iv).not.toBe(b.iv);
  });

  it("篡改 authTag 解密失败", () => {
    const enc = encryptContent("secret", KEY);
    const tampered = { ...enc, authTag: "00000000000000000000000000000000" };
    expect(() => decryptContent(tampered, KEY)).toThrow();
  });
});
