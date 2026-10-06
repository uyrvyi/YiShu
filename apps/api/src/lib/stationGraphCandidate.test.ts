import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "@yishu/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultGraphVersion,
  getStationNode,
  resetStationGraphCache,
  resolveStationForRegion,
  NoStationMappingError,
} from "./stationGraph.js";

// Register the candidate in this test process only; never write the real registry.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = fs.readFileSync(...args);
      if (String(args[0]).endsWith(path.join("graphs", "registry.json"))) {
        const registry = JSON.parse(String(result));
        return JSON.stringify({ ...registry, versions: [...registry.versions, "china-v3"] });
      }
      return result;
    },
  };
});

describe("candidate city graph runtime compatibility", () => {
  beforeEach(() => resetStationGraphCache());
  afterEach(() => resetStationGraphCache());

  it("resolves all 370 canonical city identities to their own local hub", () => {
    const evidence = JSON.parse(
      readFileSync(
        path.join(
          resolveRepoRoot(),
          "data/maps/audit/endpoint-release-20261006/city-stations.json"
        ),
        "utf8"
      )
    );
    expect(evidence.records).toHaveLength(370);
    for (const record of evidence.records) {
      const id = resolveStationForRegion(
        { province: record.province, city: record.city, district: "" },
        "china-v3"
      );
      expect(id).toBe(record.nodeId);
      const node = getStationNode(id, "china-v3");
      expect(node.province).toBe(record.province);
    }
  });

  it("rejects unknown cities and incorrect province-city pairs instead of silently using a capital", () => {
    expect(() =>
      resolveStationForRegion({ province: "安徽省", city: "不存在市", district: "" }, "china-v3")
    ).toThrow(NoStationMappingError);
    expect(() =>
      resolveStationForRegion(
        { province: "安徽省", city: "上海市", district: "黄浦区" },
        "china-v3"
      )
    ).toThrow(NoStationMappingError);
    expect(
      resolveStationForRegion({ province: "上海", city: "上海", district: "黄浦区" }, "china-v3")
    ).toBe("shanghai");
    expect(
      resolveStationForRegion({ province: "内蒙古", city: "赤峰", district: "红山区" }, "china-v3")
    ).toBe("chifeng");
  });

  it("preserves legacy fallback and the production default", () => {
    expect(getDefaultGraphVersion()).toBe("china-v2");
    expect(
      resolveStationForRegion({ province: "安徽省", city: "不存在市", district: "" }, "china-v2")
    ).toBe("hefei");
    expect(
      resolveStationForRegion({ province: "山东省", city: "莱州市", district: "" }, "china-v2")
    ).toBe("laizhou");
    expect(
      resolveStationForRegion(
        { province: "山东省", city: "烟台市", district: "莱州市" },
        "china-v3"
      )
    ).toBe("yantai");
  });
});
