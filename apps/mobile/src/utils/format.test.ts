import { describe, expect, it } from "vitest";
import { pad2 } from "./format";

describe("pad2", () => {
  it("补零", () => {
    expect(pad2(5)).toBe("05");
    expect(pad2(12)).toBe("12");
  });
});
