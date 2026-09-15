import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAP_DATA_BOUNDS, MAP_VIEWBOX, projectLngLatToMapPoint } from "@yishu/shared";
import type { StationNode } from "@yishu/routing";
import { UnknownGraphVersionError, getDataDir, getStationNode } from "./stationGraph.js";
import {
  resetStationDisplayCorrections,
  resolveDisplayStationPoint,
  resolveMapStationPoint,
  setStationDisplayCorrectionsForTest,
} from "./map-station-point.js";

/**
 * Phase 8 Gate「Yangquan 修复」——display-only 修正层契约测试。
 *
 * 断言四件事（Gate 关注点）：
 * 1. 修正只改**渲染坐标**：`china-v1` 冻结图数据（lat/lng/mapX/mapY）逐字段保持原值；
 * 2. 修正范围封闭：只有 `china-v1/yangquan` 一个站点、一个版本受影响，其余 293×2 站点显示坐标 === 图坐标；
 * 3. 失败面明确：未知版本 / 未知节点抛错（不静默降级成错误地图）；
 * 4. 投影公式单一来源：shared 运行时镜像 ≡ 生成期 `data/map_projection.cjs`，且逐站点复算两个版本。
 */
const DATA_DIR = getDataDir();
const REPO_ROOT = path.dirname(DATA_DIR);

const GRAPH_VERSIONS = ["china-v1", "china-v2"] as const;

/** `china-v1` 冻结值（= Phase 4 基线；修正的**输入**，断言未被改写）。 */
const V1_YANGQUAN_FROZEN = { lat: 35.1975, lng: 113.5841, x: 815.5, y: 243.6 } as const;

/** 人工批准的真实坐标（来源 GeoNames；同时是 `china-v2` 的图坐标）。 */
const YANGQUAN_CORRECTED = { lat: 37.8575, lng: 113.563333, x: 815.5, y: 231.7 } as const;

interface CorrectionEntry {
  lat: number;
  lng: number;
  source: string;
  reason: string;
}

interface ProjectionModule {
  WORLD: { width: number; height: number };
  projectStation: (lng: number, lat: number) => [number, number];
}

function readJson<T>(absolutePath: string): T {
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

function stationNodes(graphVersion: string): StationNode[] {
  return readJson<StationNode[]>(path.join(DATA_DIR, "graphs", graphVersion, "station_nodes.json"));
}

function displayCorrections(): Record<string, Record<string, CorrectionEntry>> {
  return readJson<Record<string, Record<string, CorrectionEntry>>>(
    path.join(DATA_DIR, "maps", "station-display-corrections.json")
  );
}

function withinDataBounds(point: { x: number; y: number }): boolean {
  return (
    point.x >= MAP_DATA_BOUNDS.minX &&
    point.x <= MAP_DATA_BOUNDS.maxX &&
    point.y >= MAP_DATA_BOUNDS.minY &&
    point.y <= MAP_DATA_BOUNDS.maxY
  );
}

describe("站点显示坐标修正（display-only）", () => {
  it("yangquan：china-v1 显示坐标 = 修正坐标投影 = china-v2 图坐标（冻结图数据未被改写）", () => {
    const frozen = getStationNode("yangquan", "china-v1");
    expect([frozen.lat, frozen.lng, frozen.mapX, frozen.mapY]).toEqual([
      V1_YANGQUAN_FROZEN.lat,
      V1_YANGQUAN_FROZEN.lng,
      V1_YANGQUAN_FROZEN.x,
      V1_YANGQUAN_FROZEN.y,
    ]);

    const corrected = getStationNode("yangquan", "china-v2");
    expect([corrected.lat, corrected.lng]).toEqual([
      YANGQUAN_CORRECTED.lat,
      YANGQUAN_CORRECTED.lng,
    ]);

    const display = resolveDisplayStationPoint("yangquan", "china-v1");
    expect(display).toEqual({ x: YANGQUAN_CORRECTED.x, y: YANGQUAN_CORRECTED.y });
    expect(display).toEqual({ x: corrected.mapX, y: corrected.mapY });
    expect(display).toEqual(
      projectLngLatToMapPoint(YANGQUAN_CORRECTED.lng, YANGQUAN_CORRECTED.lat)
    );
    // 修正把渲染位置从河南一侧（lat 35.20）移回山西（lat 37.86）：Y 必然变小
    expect(display.y).toBeLessThan(frozen.mapY);
    expect(withinDataBounds(display)).toBe(true);
  });

  it("修正范围封闭：仅 china-v1/yangquan 受影响，其余全部站点显示坐标 === 图坐标", () => {
    for (const graphVersion of GRAPH_VERSIONS) {
      const nodes = stationNodes(graphVersion);
      expect(nodes).toHaveLength(294);
      let correctedCount = 0;
      for (const node of nodes) {
        const display = resolveDisplayStationPoint(node.id, graphVersion);
        const expectsCorrection = graphVersion === "china-v1" && node.id === "yangquan";
        if (expectsCorrection) {
          correctedCount += 1;
          expect(display).not.toEqual({ x: node.mapX, y: node.mapY });
          continue;
        }
        expect(display, `${graphVersion}/${node.id}`).toEqual({ x: node.mapX, y: node.mapY });
      }
      expect(correctedCount).toBe(graphVersion === "china-v1" ? 1 : 0);
    }
  });

  it("两个版本的全部站点（含修正后坐标）都落在冻结 MAP_DATA_BOUNDS 内", () => {
    for (const graphVersion of GRAPH_VERSIONS) {
      for (const node of stationNodes(graphVersion)) {
        const display = resolveDisplayStationPoint(node.id, graphVersion);
        expect(withinDataBounds(display), `${graphVersion}/${node.id}`).toBe(true);
      }
    }
  });

  it("Map DTO 站点视图：name/province/city 取冻结图数据，坐标为显示坐标，且不泄漏 internal id", () => {
    const station = resolveMapStationPoint({ graphVersion: "china-v1", nodeId: "yangquan" });
    expect(station).toEqual({
      name: "阳泉",
      province: "山西省",
      city: "阳泉市",
      x: YANGQUAN_CORRECTED.x,
      y: YANGQUAN_CORRECTED.y,
    });
    expect(station === null ? [] : Object.keys(station).sort()).toEqual([
      "city",
      "name",
      "province",
      "x",
      "y",
    ]);

    const v2Station = resolveMapStationPoint({ graphVersion: "china-v2", nodeId: "yangquan" });
    expect(v2Station).toEqual(station);
  });

  it("未知版本 / 未知节点：明确抛错或返回 null（不静默 fallback 到错误坐标）", () => {
    expect(() => resolveDisplayStationPoint("shanghai", "china-v99")).toThrow(
      UnknownGraphVersionError
    );
    expect(() => resolveDisplayStationPoint("no_such_node", "china-v1")).toThrow(/unknown_node/);
    expect(resolveMapStationPoint({ graphVersion: "china-v1", nodeId: "no_such_node" })).toBeNull();
    expect(resolveMapStationPoint({ graphVersion: "china-v99", nodeId: "shanghai" })).toBeNull();
  });

  it("显示修正表：只登记 china-v1/yangquan，坐标在 MAP_DATA_BOUNDS 内，且与 china-v2 图坐标一致", () => {
    const corrections = displayCorrections();
    expect(Object.keys(corrections)).toEqual(["china-v1"]);
    const byNode = corrections["china-v1"];
    if (byNode === undefined) throw new Error("缺少 china-v1 显示修正登记");
    expect(Object.keys(byNode)).toEqual(["yangquan"]);

    const entry = byNode["yangquan"];
    if (entry === undefined) throw new Error("缺少 china-v1/yangquan 显示修正");
    expect([entry.lat, entry.lng]).toEqual([YANGQUAN_CORRECTED.lat, YANGQUAN_CORRECTED.lng]);
    expect(entry.source.trim().length).toBeGreaterThan(0);
    expect(entry.reason.trim().length).toBeGreaterThan(0);

    const projected = projectLngLatToMapPoint(entry.lng, entry.lat);
    expect(projected).toEqual({ x: YANGQUAN_CORRECTED.x, y: YANGQUAN_CORRECTED.y });
    expect(withinDataBounds(projected)).toBe(true);

    const v2 = getStationNode("yangquan", "china-v2");
    expect(projected).toEqual({ x: v2.mapX, y: v2.mapY });
  });

  it("投影公式单一来源：shared 镜像 ≡ data/map_projection.cjs，并逐站点复算两个版本", () => {
    const projectionPath = path.join(REPO_ROOT, "data", "map_projection.cjs");
    const loaded: unknown = createRequire(import.meta.url)(projectionPath);
    const projection = loaded as ProjectionModule;
    expect(projection.WORLD).toEqual({ width: MAP_VIEWBOX.width, height: MAP_VIEWBOX.height });

    for (const graphVersion of GRAPH_VERSIONS) {
      for (const node of stationNodes(graphVersion)) {
        const [x, y] = projection.projectStation(node.lng, node.lat);
        expect([x, y], `${graphVersion}/${node.id}`).toEqual([node.mapX, node.mapY]);
        expect(projectLngLatToMapPoint(node.lng, node.lat), `${graphVersion}/${node.id}`).toEqual({
          x,
          y,
        });
      }
    }
  });

  it("生成器不得内联第二套投影公式（china-v1 冻结值必须由 canonical helper 复算）", () => {
    const generator = readFileSync(path.join(REPO_ROOT, "data", "gen_graph.cjs"), "utf8");
    expect(generator).toContain('require("./map_projection.cjs")');
    expect(generator).not.toMatch(/\(\s*\(?\s*lng\s*\+\s*180\s*\)/);
    expect(generator).not.toMatch(/\(\s*90\s*-\s*lat\s*\)/);
  });
});

/**
 * Phase 8 Gate 复核 MEDIUM-1：显示修正表必须**完整 fail-fast**。
 *
 * 故障注入方式：把配置对象直接注入内存（不写文件），验证任何非法内容都会抛错，
 * 而不是静默回退到冻结坐标（那会让跨省显示悄悄复现）。
 */
describe("显示修正表：fail-fast 校验（内存故障注入，不改文件）", () => {
  /** 合法基线（与仓库内真实配置同 schema）。 */
  const validTable = {
    "china-v1": {
      yangquan: {
        lat: YANGQUAN_CORRECTED.lat,
        lng: YANGQUAN_CORRECTED.lng,
        source: "GeoNames: Yangquan, Shanxi, China",
        reason: "冻结坐标偏差导致跨省显示，仅修正用户可见地图渲染坐标",
      },
    },
  };

  const entry = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    lat: YANGQUAN_CORRECTED.lat,
    lng: YANGQUAN_CORRECTED.lng,
    source: "GeoNames",
    reason: "跨省显示修正",
    ...overrides,
  });

  /** 全部必须抛错的非法配置。 */
  const invalidTables: Array<[string, unknown]> = [
    ["顶层为数组（[]）", []],
    ["顶层为 JSON null", null],
    ["顶层为字符串", "china-v1"],
    ["顶层为数字", 42],
    ["版本对象为数组", { "china-v1": [] }],
    ["版本对象为空对象（无效声明）", { "china-v1": {} }],
    ["未知图版本", { "china-v99": { yangquan: entry({}) } }],
    ["未知站点（yangquann 拼写错误）", { "china-v1": { yangquann: entry({}) } }],
    ["站点不属于该版本", { "china-v2": { no_such_node: entry({}) } }],
    ["缺少 source", { "china-v1": { yangquan: { lat: 37.8575, lng: 113.563333, reason: "x" } } }],
    ["source 为空串", { "china-v1": { yangquan: entry({ source: "   " }) } }],
    ["source 非字符串", { "china-v1": { yangquan: entry({ source: 123 }) } }],
    ["缺少 reason", { "china-v1": { yangquan: { lat: 37.8575, lng: 113.563333, source: "x" } } }],
    ["reason 非字符串", { "china-v1": { yangquan: entry({ reason: null }) } }],
    ["未知字段", { "china-v1": { yangquan: entry({ note: "多余字段" }) } }],
    ["lat 非有限数", { "china-v1": { yangquan: entry({ lat: "37.8575" }) } }],
    ["lat 超出范围", { "china-v1": { yangquan: entry({ lat: 137.8575 }) } }],
    ["lng 超出范围", { "china-v1": { yangquan: entry({ lng: 213.563333 }) } }],
    ["坐标投影超出 MAP_DATA_BOUNDS", { "china-v1": { yangquan: entry({ lat: 0, lng: 0 }) } }],
    ["修正条目本身不是对象", { "china-v1": { yangquan: "37.8575,113.563333" } }],
  ];

  afterEach(() => {
    resetStationDisplayCorrections();
  });

  it.each(invalidTables)("非法配置必须抛错：%s", (_name, table) => {
    setStationDisplayCorrectionsForTest(table);
    expect(() => resolveDisplayStationPoint("yangquan", "china-v1")).toThrow(
      /station_display_corrections_invalid|station_display_corrections_unreadable/
    );
    // 抛错后不得留下半成品缓存：换回合法配置必须能正常工作
    setStationDisplayCorrectionsForTest(validTable);
    expect(resolveDisplayStationPoint("yangquan", "china-v1")).toEqual({
      x: YANGQUAN_CORRECTED.x,
      y: YANGQUAN_CORRECTED.y,
    });
  });

  it("合法注入配置生效，且 reset 后回到磁盘上的真实配置（同一结果）", () => {
    setStationDisplayCorrectionsForTest(validTable);
    const injected = resolveDisplayStationPoint("yangquan", "china-v1");
    expect(injected).toEqual({ x: YANGQUAN_CORRECTED.x, y: YANGQUAN_CORRECTED.y });

    resetStationDisplayCorrections();
    expect(resolveDisplayStationPoint("yangquan", "china-v1")).toEqual(injected);

    // 磁盘配置未被测试改写（哈希之外的轻量校验：仍是唯一 china-v1/yangquan 条目）
    const onDisk = displayCorrections();
    expect(Object.keys(onDisk)).toEqual(["china-v1"]);
    expect(Object.keys(onDisk["china-v1"] ?? {})).toEqual(["yangquan"]);
  });

  it("未注入时磁盘配置本身合法（加载不抛错）", () => {
    resetStationDisplayCorrections();
    expect(() => resolveDisplayStationPoint("yangquan", "china-v1")).not.toThrow();
  });
});
