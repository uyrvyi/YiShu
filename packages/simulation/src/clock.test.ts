import { describe, expect, it } from "vitest";
import { SystemSimulationClock, TestSimulationClock } from "./clock.js";

describe("TestSimulationClock", () => {
  it("初始 now 等于 startMs；advanceBy 累加推进", () => {
    const clock = new TestSimulationClock(1_000_000);
    expect(clock.now()).toBe(1_000_000);
    clock.advanceBy(10 * 3600 * 1000);
    expect(clock.now()).toBe(1_000_000 + 10 * 3600 * 1000);
  });

  it("advanceTo 直接跳到绝对时刻（含倒退）", () => {
    const clock = new TestSimulationClock(1_000_000);
    clock.advanceBy(25 * 3600 * 1000);
    expect(clock.now()).toBe(1_000_000 + 25 * 3600 * 1000);
    clock.advanceTo(1_000_000 + 10 * 3600 * 1000);
    expect(clock.now()).toBe(1_000_000 + 10 * 3600 * 1000);
  });

  it("推进单调且不允许真实 sleep（纯内存推进）", () => {
    const clock = new TestSimulationClock(0);
    let last = clock.now();
    for (let i = 0; i < 100; i += 1) {
      clock.advanceBy(1000);
      expect(clock.now()).toBeGreaterThan(last);
      last = clock.now();
    }
  });
});

describe("SystemSimulationClock", () => {
  it("speed=1 时 now() 跟随真实时间（生产模式）", () => {
    const clock = new SystemSimulationClock(1);
    const before = Date.now();
    const now = clock.now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it("speed>1 时模拟时间加速快于真实时间", () => {
    const epochMs = Date.now() - 2000;
    const clock = new SystemSimulationClock(2, epochMs);
    // epoch 后经过 elapsed 毫秒：now = epoch + elapsed*2 = Date.now() + elapsed（elapsed≈2000+）
    const now = clock.now();
    expect(now).toBeGreaterThan(Date.now() + 1000);
    expect(now).toBeLessThan(Date.now() + 10000);
  });

  it("非正 / 非有限 speed 明确拒绝", () => {
    expect(() => new SystemSimulationClock(0)).toThrow(/positive finite/);
    expect(() => new SystemSimulationClock(-3)).toThrow(/positive finite/);
    expect(() => new SystemSimulationClock(Number.NaN)).toThrow(/positive finite/);
  });
});
