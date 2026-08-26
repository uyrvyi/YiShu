import { describe, expect, it } from "vitest";
import { DeterministicRandom, deterministicDraw } from "./random.js";

describe("DeterministicRandom", () => {
  it("相同 seed + index → 相同结果（确定性）", () => {
    expect(deterministicDraw("seed-a", 0)).toBe(deterministicDraw("seed-a", 0));
    expect(deterministicDraw("seed-a", 7)).toBe(deterministicDraw("seed-a", 7));
  });

  it("可重复回放：两次构造 / 两次抽取结果一致", () => {
    const r1 = new DeterministicRandom("seed-replay");
    const r2 = new DeterministicRandom("seed-replay");
    for (let i = 0; i < 20; i += 1) {
      expect(r1.draw(i)).toBe(r2.draw(i));
    }
  });

  it("不同 drawIndex → 不同结果（同一 seed 序列不重复）", () => {
    const r = new DeterministicRandom("seed-seq");
    const seen = new Set<number>();
    for (let i = 0; i < 32; i += 1) {
      const value = r.draw(i);
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    }
  });

  it("不同 seed → 不同结果", () => {
    const pairs: Array<[string, string]> = [
      ["a", "b"],
      ["hello", "world"],
      [
        "0000000000000000000000000000000000000000000000000000000000000001",
        "0000000000000000000000000000000000000000000000000000000000000002",
      ],
    ];
    for (const [s1, s2] of pairs) {
      expect(deterministicDraw(s1, 0)).not.toBe(deterministicDraw(s2, 0));
    }
  });

  it("输出范围 [0, 1)（供 Phase 6 概率判定）", () => {
    const r = new DeterministicRandom("seed-range");
    for (let i = 0; i < 100; i += 1) {
      const value = r.draw(i);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
