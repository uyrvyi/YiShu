import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "@yishu/config";
import { isRegionServiceUnavailable } from "@yishu/shared";
import { describe, expect, it, vi } from "vitest";
import { assertDistrictTransportRegion } from "./district-transport-validation.js";
import { districtPoint } from "./district-map.js";
import { getDefaultGraphVersion, getStationNode, resolveStationForRegion } from "./stationGraph.js";

// Substitute the complete candidate bundle only in this test process.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const file = String(args[0]);
      if (file.endsWith(path.join("maps", "district-anchors.json"))) {
        return fs.readFileSync(
          path.join(path.dirname(file), "district-anchors-1.1-candidate.json"),
          args[1]
        );
      }
      const result = fs.readFileSync(...args);
      if (file.endsWith(path.join("graphs", "registry.json"))) {
        const registry = JSON.parse(String(result));
        return JSON.stringify({ ...registry, versions: [...registry.versions, "china-v3"] });
      }
      return result;
    },
  };
});

type Region = { code: string; province: string; city: string; district: string };
const catalog = JSON.parse(
  readFileSync(path.join(resolveRepoRoot(), "data/regions/canonical-candidate.json"), "utf8")
) as { regions: Region[] };

describe("complete candidate transport assets through the runtime readers", () => {
  it("accepts both roles for every one of the 2849 serviceable endpoints", () => {
    const regions = catalog.regions.filter((region) => !isRegionServiceUnavailable(region));
    expect(regions).toHaveLength(2849);
    for (const region of regions) {
      expect(() => assertDistrictTransportRegion(region, "china-v3", "origin")).not.toThrow();
      expect(() => assertDistrictTransportRegion(region, "china-v3", "destination")).not.toThrow();
      const point = districtPoint(region, "china-v3");
      expect(point).not.toBeNull();
      const hub = getStationNode(resolveStationForRegion(region, "china-v3"), "china-v3");
      expect(hub.city).toBe(region.city);
      expect(hub.province).toBe(region.province);
      expect(
        Math.max(Math.abs(point!.x - hub.mapX), Math.abs(point!.y - hub.mapY))
      ).toBeGreaterThanOrEqual(0.000002);
    }
  });

  it("does not fabricate an endpoint for either unavailable county", () => {
    const regions = catalog.regions.filter(isRegionServiceUnavailable);
    expect(regions.map((region) => region.code)).toEqual(["350527", "460303"]);
    for (const region of regions) {
      expect(districtPoint(region, "china-v3")).toBeNull();
      expect(() => assertDistrictTransportRegion(region, "china-v3", "origin")).toThrow(
        "origin_region_unavailable"
      );
      expect(() => assertDistrictTransportRegion(region, "china-v3", "destination")).toThrow(
        "destination_region_unavailable"
      );
    }
  });

  it("does not change the runtime default graph", () => {
    expect(getDefaultGraphVersion()).toBe("china-v2");
  });
});
