import { describe, expect, it } from "vitest";
import { formatEstimatedDuration, TRANSPORT_DESCRIPTIONS } from "./transport";

describe("参考时长", () => {
  it.each([
    [1, "不到 1 分钟"],
    [60, "1 分钟"],
    [3601, "1 小时 1 分钟"],
    [21600, "6 小时"],
    [86400, "1 天"],
    [90000, "1 天 1 小时"],
    [NaN, "暂不可用"],
    [-1, "暂不可用"],
  ])("格式化 %s 秒", (value, expected) => {
    expect(formatEstimatedDuration(Number(value))).toBe(expected);
  });
  it("四种运输方式都有独立介绍", () => {
    expect(new Set(Object.values(TRANSPORT_DESCRIPTIONS)).size).toBe(4);
  });
});
