import { describe, expect, it } from "vitest";
import { generateUid } from "./uid.js";

describe("generateUid", () => {
  it("生成 8 位数字", () => {
    const uid = generateUid();
    expect(uid).toMatch(/^[0-9]{8}$/);
  });

  it("首位不为 0", () => {
    for (let i = 0; i < 50; i += 1) {
      const uid = generateUid();
      expect(uid[0]).not.toBe("0");
    }
  });

  it("生成值大概率不同（随机性）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      seen.add(generateUid());
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
