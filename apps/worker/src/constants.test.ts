import { describe, expect, it } from "vitest";
import { WORKER_NAME } from "./constants.js";

describe("worker constants", () => {
  it("服务标识正确", () => {
    expect(WORKER_NAME).toBe("yishu-worker");
  });
});
