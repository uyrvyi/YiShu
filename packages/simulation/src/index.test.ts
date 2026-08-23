import { describe, expect, it } from "vitest";
import { SIMULATION_PACKAGE_NAME } from "./index.js";

describe("simulation package", () => {
  it("包名正确", () => {
    expect(SIMULATION_PACKAGE_NAME).toBe("@yishu/simulation");
  });
});
