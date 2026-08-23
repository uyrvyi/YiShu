import { describe, expect, it } from "vitest";
import { API_PREFIX } from "./index.js";

describe("shared", () => {
  it("API 前缀为 /api/v1", () => {
    expect(API_PREFIX).toBe("/api/v1");
  });
});
