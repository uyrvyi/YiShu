import { describe, expect, it } from "vitest";
import { C } from "./theme";

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return channel(1) * 0.2126 + channel(3) * 0.7152 + channel(5) * 0.0722;
}

describe("界面文字对比度", () => {
  it.each([
    ["ink", "surface"],
    ["muted", "surface"],
    ["muted", "canvas"],
    ["green", "greenSoft"],
    ["blue", "blueSoft"],
    ["orange", "orangeSoft"],
    ["error", "errorSoft"],
    ["surface", "green"],
  ] as const)("%s / %s 普通文字对比度至少 4.5:1", (foreground, background) => {
    const a = luminance(C[foreground]);
    const b = luminance(C[background]);
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
