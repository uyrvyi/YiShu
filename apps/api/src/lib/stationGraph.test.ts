import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  planRoute,
  resolveStationForRegion,
  getStationNode,
  resetStationGraphCache,
  UnknownGraphVersionError,
  NoStationMappingError,
} from "./stationGraph.js";

/**
 * 静态路网访问层单元测试（Phase 4 Final Gate 复评）。
 * 覆盖：graphVersion 冻结语义（未知版本拒绝）、Region→Station 生产数据修复、映射失败类型。
 */
describe("stationGraph", () => {
  beforeEach(() => resetStationGraphCache());
  afterEach(() => resetStationGraphCache());

  it("已知版本 china-v1 可加载并寻路", () => {
    const r = planRoute({
      graphVersion: "china-v1",
      originNodeId: "shanghai",
      destinationNodeId: "beijing",
      transportType: "HORSE_RELAY",
    });
    expect(r.found).toBe(true);
    expect(r.totalDistanceKm).toBeGreaterThan(0);
  });

  it("未知 graphVersion 明确拒绝（BLOCKER-1）", () => {
    expect(() =>
      planRoute({
        graphVersion: "china-v999",
        originNodeId: "shanghai",
        destinationNodeId: "beijing",
        transportType: "HORSE_RELAY",
      })
    ).toThrow(UnknownGraphVersionError);
    expect(() => getStationNode("shanghai", "china-v999")).toThrow(UnknownGraphVersionError);
    expect(() =>
      resolveStationForRegion(
        { province: "上海市", city: "上海市", district: "徐汇区" },
        "china-v999"
      )
    ).toThrow(UnknownGraphVersionError);
  });

  it("重庆 / 赤峰 / 烟台 / 莱州 映射正确（HIGH-1 数据修复）", () => {
    expect(
      resolveStationForRegion(
        { province: "重庆市", city: "重庆市", district: "渝中区" },
        "china-v1"
      )
    ).toBe("chongqing");
    expect(
      resolveStationForRegion(
        { province: "内蒙古自治区", city: "赤峰市", district: "红山区" },
        "china-v1"
      )
    ).toBe("chifeng");
    expect(
      resolveStationForRegion(
        { province: "山东省", city: "烟台市", district: "芝罘区" },
        "china-v1"
      )
    ).toBe("yantai");
    expect(
      resolveStationForRegion({ province: "山东省", city: "莱州市", district: "" }, "china-v1")
    ).toBe("laizhou");
  });

  it("无映射区域抛 NoStationMappingError（类型化，路由映射为 422）", () => {
    expect(() =>
      resolveStationForRegion({ province: "不存在省", city: "不存在市", district: "" }, "china-v1")
    ).toThrow(NoStationMappingError);
  });
});
