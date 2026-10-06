import { describe, expect, it } from "vitest";
import {
  assertDistrictTransportRegion,
  InvalidTransportRegionError,
} from "./district-transport-validation.js";
import { UnknownGraphVersionError } from "./stationGraph.js";

describe("district transport validation", () => {
  it("accepts a canonical county only when its coordinate and local city station both exist", () => {
    expect(() =>
      assertDistrictTransportRegion(
        { province: "上海市", city: "上海市", district: "黄浦区" },
        "china-v2",
        "origin"
      )
    ).not.toThrow();
  });

  it("does not mistake a legacy province-capital fallback for the requested city's own station", () => {
    expect(() =>
      assertDistrictTransportRegion(
        { province: "安徽省", city: "滁州市", district: "琅琊区" },
        "china-v2",
        "origin"
      )
    ).toThrow("origin_region_unavailable");
  });

  it("does not treat a historical coordinate for a retired county as a selectable endpoint", () => {
    expect(() =>
      assertDistrictTransportRegion(
        { province: "重庆市", city: "重庆市", district: "江北区" },
        "china-v2",
        "destination"
      )
    ).toThrow(InvalidTransportRegionError);
  });

  it("retains unknown-version errors instead of implying the user's address is invalid", () => {
    expect(() =>
      assertDistrictTransportRegion(
        { province: "上海市", city: "上海市", district: "黄浦区" },
        "china-v99",
        "origin"
      )
    ).toThrow(UnknownGraphVersionError);
  });
});
