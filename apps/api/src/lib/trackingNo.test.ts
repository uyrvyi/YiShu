import { describe, expect, it, vi } from "vitest";
import { generateTrackingNo, isValidTrackingNo } from "./trackingNo.js";
import { createWithTrackingRetry, MAX_TRACKING_RETRY } from "./trackingNoRetry.js";

describe("generateTrackingNo", () => {
  it("格式为 YS-YYYYMMDD-XXXXX", () => {
    const t = generateTrackingNo();
    expect(t).toMatch(/^YS-\d{8}-[A-Z0-9]{5}$/);
  });

  it("isValidTrackingNo 校验格式", () => {
    expect(isValidTrackingNo("YS-20260821-K7P2M")).toBe(true);
    expect(isValidTrackingNo("K7P2M")).toBe(false);
    expect(isValidTrackingNo("YS-2026-K7P2M")).toBe(false);
  });

  it("随机段 5 位且非纯自增", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      seen.add(generateTrackingNo());
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("createWithTrackingRetry", () => {
  it("第一次碰撞、第二次可用 → 成功使用第二个 trackingNo", async () => {
    const candidates = ["YS-20260821-AAAAA", "YS-20260821-BBBBB"];
    const generator = vi.fn(() => candidates.shift() ?? "YS-20260821-CCCCC");
    const create = vi.fn(async (trackingNo: string) => {
      if (trackingNo.includes("AAAAA")) return { kind: "collision" as const };
      return { kind: "created" as const, value: { trackingNo } };
    });
    const result = await createWithTrackingRetry({ generator, maxRetries: 5, create });
    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      const trackingNo = result.value?.trackingNo;
      expect(trackingNo).toBe("YS-20260821-BBBBB");
    }
    expect(generator).toHaveBeenCalledTimes(2);
  });

  it("连续碰撞到最大重试次数 → 失败，不无限循环", async () => {
    const generator = vi.fn(() => "YS-20260821-AAAAA");
    const create = vi.fn(async () => ({ kind: "collision" as const }));
    const result = await createWithTrackingRetry({
      generator,
      maxRetries: MAX_TRACKING_RETRY,
      create,
    });
    expect(result.kind).toBe("collision");
    expect(generator).toHaveBeenCalledTimes(MAX_TRACKING_RETRY);
  });

  it("非碰撞错误立即返回 error", async () => {
    const generator = vi.fn(() => "YS-20260821-AAAAA");
    const create = vi.fn(async () => ({ kind: "error" as const }));
    const result = await createWithTrackingRetry({ generator, maxRetries: 5, create });
    expect(result.kind).toBe("error");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
