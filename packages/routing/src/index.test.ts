import { describe, expect, it } from "vitest";
import { ROUTING_PACKAGE_NAME } from "./index.js";

describe("routing package", () => {
  it("包名正确", () => {
    expect(ROUTING_PACKAGE_NAME).toBe("@yishu/routing");
  });
});
